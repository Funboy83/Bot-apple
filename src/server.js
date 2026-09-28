// Local settings web app. Only listens on this computer (127.0.0.1).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CATALOG, DATA_DIR, loadSettings, saveSettings, mergeKnown } from './settings.js';
import { Vault } from './vault.js';
import { Bot } from './bot.js';
import { notifyAll } from './notify.js';
import { resolveParts, checkStock, httpGet } from './stock.js';
import { browserGetter, newPage, closeBrowser } from './browser.js';
import fs from 'node:fs';

const PORT = Number(process.env.PORT) || 3777;
const HERE = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(DATA_DIR, { recursive: true });
const vault = new Vault(path.join(DATA_DIR, 'secrets.enc'));
const bot = new Bot();

// Shape of the private details kept in the encrypted vault.
const SECRET_SHAPE = {
  contact: { firstName: '', lastName: '', email: '', phone: '' },
  pickupPerson: { firstName: '', lastName: '', email: '', phone: '' },
  card: { number: '', expMonth: '', expYear: '', cvv: '', nameOnCard: '' },
  billing: { firstName: '', lastName: '', street: '', street2: '', city: '', state: '', zip: '', phone: '' },
  alerts: {
    telegramToken: '', telegramChatId: '',
    smtpHost: '', smtpPort: '465', smtpUser: '', smtpPass: '', emailFrom: '', emailTo: '',
    twilioSid: '', twilioToken: '', twilioFrom: '', smsTo: '', smsGatewayEmail: '',
  },
};
const HIDDEN = [['card', 'number'], ['card', 'cvv'], ['alerts', 'smtpPass'], ['alerts', 'twilioToken'], ['alerts', 'telegramToken']];
const MASK = '••••';

function fullSecrets() {
  return mergeKnown(structuredClone(SECRET_SHAPE), vault.secrets || {});
}

function maskedSecrets() {
  const s = fullSecrets();
  for (const [a, b] of HIDDEN) {
    const v = String(s[a][b] || '');
    if (v) s[a][b] = b === 'number' ? `${MASK}${v.slice(-4)}` : MASK;
  }
  return s;
}

const app = express();
app.use(express.json({ limit: '100kb' }));

// Block other websites from talking to this app through the browser.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1'].includes(host)) return res.status(403).send('Forbidden');
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
  next();
});

app.use(express.static(path.join(HERE, '..', 'public')));

const wrap = (fn) => async (req, res) => {
  try {
    res.json((await fn(req, res)) ?? { ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};

const needUnlocked = () => {
  if (!vault.unlocked) throw Object.assign(new Error('Unlock your private details first'), { status: 401 });
};

app.get('/api/state', wrap(() => ({
  settings: loadSettings(),
  catalog: CATALOG,
  vault: { exists: vault.exists(), unlocked: vault.unlocked },
  secrets: vault.unlocked ? maskedSecrets() : null,
  status: bot.status(),
  logs: bot.logs.slice(-200),
})));

app.post('/api/settings', wrap((req) => {
  if (bot.running) throw Object.assign(new Error('Stop the bot before changing settings'), { status: 409 });
  return { settings: saveSettings(req.body) };
}));

app.post('/api/vault/unlock', wrap((req) => {
  vault.unlock(String(req.body.passphrase || ''));
  return { secrets: maskedSecrets() };
}));

app.post('/api/vault/lock', wrap(() => {
  if (bot.running) bot.stop('Stopped because private details were locked');
  vault.lock();
}));

app.post('/api/vault/reset', wrap(() => {
  if (bot.running) bot.stop('Stopped because private details were erased');
  vault.reset();
}));

app.post('/api/secrets', wrap((req) => {
  needUnlocked();
  const next = mergeKnown(fullSecrets(), req.body);
  const old = fullSecrets();
  for (const [a, b] of HIDDEN) {
    if (String(next[a][b] || '').startsWith(MASK)) next[a][b] = old[a][b];
  }
  if (next.card.number) next.card.number = String(next.card.number).replace(/[\s-]/g, '');
  vault.save(next);
  return { secrets: maskedSecrets() };
}));

app.post('/api/alerts/test', wrap(async (req) => {
  needUnlocked();
  const channel = String(req.body.channel);
  const results = await notifyAll(loadSettings().alerts, fullSecrets().alerts, 'Bot Apple test', 'Alerts are working.', channel);
  if (!(channel in results)) throw Object.assign(new Error('Unknown channel'), { status: 400 });
  return { result: results[channel] };
}));

app.post('/api/check-now', wrap(async () => {
  const s = loadSettings();
  if (!s.pickup.zip) throw Object.assign(new Error('Enter a pickup ZIP code first'), { status: 400 });
  const get = s.check.useBrowser ? browserGetter({ headless: s.checkout.headless, browser: s.checkout.browser }) : httpGet;
  const { resolved, problems } = await resolveParts(s.targets, get);
  const rows = resolved.length ? await checkStock(resolved.map((t) => t.partNumber), s.pickup, get) : [];
  return { parts: resolved, problems, rows };
}));

app.post('/api/bot/start', wrap(() => {
  const s = loadSettings();
  if (s.checkout.mode !== 'alert-only' || s.alerts.telegram || s.alerts.email || s.alerts.sms) needUnlocked();
  bot.start(s, fullSecrets());
  return { status: bot.status() };
}));

app.post('/api/bot/stop', wrap(() => {
  bot.stop();
  return { status: bot.status() };
}));

app.post('/api/bot/resume', wrap(() => {
  bot.resumeCheckout();
  return { status: bot.status() };
}));

app.post('/api/browser/open', wrap(async () => {
  const s = loadSettings();
  const page = await newPage({ headless: false, browser: s.checkout.browser });
  await page.goto('https://www.apple.com/shop/account/home', { waitUntil: 'domcontentloaded' });
}));

app.post('/api/browser/close', wrap(() => closeBrowser()));

// Live log and status stream for the page.
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const onLog = (e) => res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
  const onStatus = () => res.write(`event: status\ndata: ${JSON.stringify(bot.status())}\n\n`);
  bot.on('log', onLog);
  bot.on('status', onStatus);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    bot.off('log', onLog);
    bot.off('status', onStatus);
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Bot Apple is running. Open http://localhost:${PORT} in your browser.`);
});
