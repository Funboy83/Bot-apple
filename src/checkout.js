// Drives apple.com checkout for store pickup in a real browser window.
// Apple changes its pages often, so every step matches on visible text and labels
// rather than internal ids, and a screenshot is saved whenever a step fails.
import fs from 'node:fs';
import path from 'node:path';
import { CATALOG, DATA_DIR } from './settings.js';
import { newPage } from './browser.js';

const APPLE = 'https://www.apple.com';
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class CheckoutError extends Error {
  constructor(step, message, screenshot) {
    super(`${step}: ${message}`);
    this.step = step;
    this.screenshot = screenshot;
  }
}

async function firstVisible(locators, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const loc of locators) {
      const el = loc.filter({ visible: true }).first();
      if (await el.count().catch(() => 0)) return el;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// Clicks the first visible radio, button, link or label whose name matches.
async function choose(page, pattern, { timeout = 8000, roles = ['radio', 'button', 'link'] } = {}) {
  const locs = roles.map((role) => page.getByRole(role, { name: pattern }));
  locs.push(page.locator('label').filter({ hasText: pattern }));
  const el = await firstVisible(locs, timeout);
  if (!el) return false;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  if ((await el.getAttribute('aria-checked').catch(() => null)) === 'true') return true;
  if (await el.isChecked().catch(() => false)) return true;
  if (await el.evaluate((node) => node.matches('input[type="radio"]'))) {
    // Use the control's normal keyboard interaction, not its decorative overlay.
    const deadline = Date.now() + timeout;
    while (!await el.isEnabled()) {
      if (Date.now() >= deadline) throw new Error('Product option remains disabled');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await el.press('Space');
  } else {
    await el.click({ timeout: 10000 });
  }
  return true;
}

async function fill(page, pattern, value, { timeout = 4000 } = {}) {
  if (value === undefined || value === null || value === '') return false;
  const el = await firstVisible([page.getByLabel(pattern), page.getByPlaceholder(pattern)], timeout);
  if (!el) return false;
  const tag = await el.evaluate((n) => n.tagName.toLowerCase());
  if (tag === 'select') {
    await el.selectOption({ label: String(value) }).catch(() => el.selectOption(String(value)));
  } else {
    await el.fill(String(value));
    await el.press('Tab');
  }
  return true;
}

const prepared = new Map();
const targetKey = (target) => JSON.stringify([target.model, target.capacity, target.color, target.partNumber]);

async function configureProduct(page, target) {
  const model = CATALOG[target.model];
  if (!model) throw new Error('Select a known model before checkout');
  await page.goto(`${APPLE}/shop/buy-iphone/${model.page}`, { waitUntil: 'domcontentloaded' });
  const picks = [
    ...(target.model === 'iphone-duo' ? [] : [target.model.endsWith('pro-max') ? /iPhone\s+18\s+Pro\s+Max/i : /iPhone\s+18\s+Pro(?!\s+Max)/i]),
    new RegExp(`^\\s*${esc(target.color)}\\b`, 'i'),
    new RegExp(`^\\s*${esc(target.capacity).replace('GB', '\\s?GB').replace('TB', '\\s?TB')}`, 'i'),
    /No trade.?in/i, /^(Buy|Pay in full|One.?time payment|Full price)/i,
    /Connect.*(own|later)|^Unlocked|SIM.?free/i, /No AppleCare/i,
  ];
  for (const pattern of picks) {
    if (!(await choose(page, pattern, { timeout: 10000, roles: ['radio'] }))) throw new Error(`Product choice not found: ${pattern}`);
  }
  await page.getByRole('button', { name: /^Add to Bag$/i }).waitFor({ state: 'visible', timeout: 10000 });
  return page;
}

// Prepare selections before a stock event. This never adds an item or starts checkout.
export function prepareCheckout({ target, settings }) {
  const key = targetKey(target);
  if (!prepared.has(key)) {
    const promise = (async () => {
      const page = await newPage({ headless: settings.checkout.headless, browser: settings.checkout.browser });
      try { return await configureProduct(page, target); }
      catch (error) { await page.close().catch(() => {}); throw error; }
    })();
    prepared.set(key, { promise, createdAt: Date.now() });
    promise.catch(() => prepared.delete(key));
  }
  return prepared.get(key).promise;
}

export async function runCheckout({ target, store, settings, secrets, log = () => {}, onNeedsYou }) {
  const mode = settings.checkout.mode;
  const shotsDir = path.join(DATA_DIR, 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const startedAt = performance.now();
  const timings = [];
  let refuse;
  const accessRefused = new Promise((_, reject) => { refuse = reject; });
  accessRefused.catch(() => {});
  let page;
  let bagStartedAt;
  let step = 'prepare product';
  const must = async (name, fn) => {
    step = name;
    const begin = performance.now();
    log(`Checkout: ${name}`);
    const ok = await Promise.race([fn(), accessRefused]);
    if (ok === false) throw new Error('could not find it on the page');
    const durationMs = Math.round(performance.now() - begin);
    timings.push({ step: name, durationMs });
    log(`Checkout timing: ${name}: ${durationMs} ms`);
  };
  try {
    await must('prepare product', async () => {
      const key = targetKey(target);
      const entry = prepared.get(key);
      if (entry && Date.now() - entry.createdAt > 10 * 60000) {
        prepared.delete(key);
        entry.promise.then((p) => p.close()).catch(() => {});
      }
      page = await prepareCheckout({ target, settings });
      prepared.delete(key);
      if (page.isClosed()) page = await prepareCheckout({ target, settings });
      prepared.delete(key);
      page.setDefaultTimeout(10000);
      page.on('response', (response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          log(`Checkout page: ${new URL(response.url()).pathname} HTTP ${response.status()}`);
          if ([403, 429, 541].includes(response.status())) {
            const error = new Error(`Apple refused checkout with HTTP ${response.status()}; automation stopped`);
            error.statusCode = response.status();
            refuse(error);
          }
        }
      });
    });
    bagStartedAt = performance.now();
    await must('add to bag', () => choose(page, /^Add to Bag$/i, { timeout: 10000, roles: ['button'] }));
    await must('open the bag', async () => {
      const review = page.getByRole('button', { name: /^Review Bag$/i });
      await Promise.race([
        review.waitFor({ state: 'visible', timeout: 10000 }),
        page.getByRole('button', { name: /^Check ?Out$/i }).first().waitFor({ state: 'visible', timeout: 10000 }),
      ]);
      if (await review.isVisible()) await review.click();
    });
    await must('check out', () => choose(page, /^Check ?Out$/i, { roles: ['button', 'link'] }));
    if (settings.checkout.account === 'guest') {
      await must('continue as guest', () => choose(page, /Continue as Guest|Guest Checkout/i, { timeout: 20000, roles: ['button', 'link'] }));
    } else {
      await must('wait for signed-in checkout', async () => {
        const pickup = page.getByRole('radio', { name: /pick it up/i });
        await pickup.waitFor({ state: 'visible', timeout: 60000 });
      });
    }
    await must('choose store pickup', () => choose(page, /I.?ll pick it up/i, { timeout: 20000, roles: ['radio'] }));
    await must('choose pickup store', async () => {
      const storePattern = new RegExp(esc(store.storeName.replace(/^Apple\s+/i, '')), 'i');
      const storeRadio = page.getByRole('radio', { name: storePattern }).first();
      const zipInput = page.getByRole('textbox', { name: /ZIP|Zip Code|City|Location/i }).first();
      // Wait for either existing stores or a ZIP entry form, not an absent optional input.
      await Promise.race([
        storeRadio.waitFor({ state: 'visible', timeout: 10000 }),
        zipInput.waitFor({ state: 'visible', timeout: 10000 }),
        page.getByRole('button', { name: /Edit Zip Code or City/i }).waitFor({ state: 'visible', timeout: 10000 }),
      ]);
      if (!await storeRadio.isVisible()) {
        if (!await zipInput.isVisible()) await page.getByRole('button', { name: /Edit Zip Code or City/i }).click();
        await zipInput.fill(String(settings.pickup.zip));
        await zipInput.press('Enter');
      }
      return choose(page, storePattern, { timeout: 15000, roles: ['radio'] });
    });
    await must('choose pickup time', async () => {
      const time = page.getByRole('combobox', { name: /time|window/i }).first();
      await time.waitFor({ state: 'visible', timeout: 10000 });
      const values = await time.locator('option').evaluateAll((opts) => opts.filter((o) => o.value && !o.disabled).map((o) => o.value));
      if (!values.length) throw new Error('No pickup windows are available');
      await time.selectOption(values[0]);
    });
    await must('continue to pickup details', () => choose(page, /Continue to Pickup Details/i, { roles: ['button'] }));
    const c = secrets.contact || {};
    const p = settings.checkout.pickupBySomeoneElse ? secrets.pickupPerson || {} : c;
    await must('fill pickup details', async () => {
      if (settings.checkout.pickupBySomeoneElse) await choose(page, /someone else/i);
      for (const [pattern, value] of [[/First Name/i,p.firstName],[/Last Name/i,p.lastName],[/Email/i,c.email || p.email],[/Phone/i,p.phone || c.phone]]) {
        if (!await fill(page, pattern, value)) throw new Error(`Missing pickup field: ${pattern}`);
      }
    });
    await must('continue to payment', () => choose(page, /Continue to Payment/i, { roles: ['button'] }));
    await must('fill payment', async () => {
      if (!await choose(page, /Credit or Debit Card|Credit\/Debit/i)) throw new Error('Card payment option not found');
      const card = secrets.card || {}, bill = secrets.billing || {};
      const exp = `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`;
      for (const [pattern,value] of [[/Card Number/i,card.number],[/Expiration|MM\s*\/\s*YY/i,exp],[/CVV|Security Code|CVC/i,card.cvv],[/First Name/i,bill.firstName || c.firstName],[/Last Name/i,bill.lastName || c.lastName],[/Street Address|Address Line 1/i,bill.street],[/ZIP/i,bill.zip]]) {
        if (!await fill(page,pattern,value)) throw new Error(`Missing payment field: ${pattern}`);
      }
      // Optional fields: only touch those actually rendered. Apple may derive City/State from ZIP.
      for (const [pattern,value] of [[/Apt|Suite|Apartment|Address Line 2/i,bill.street2],[/^City$/i,bill.city],[/^State$/i,bill.state],[/Phone/i,bill.phone || c.phone]]) {
        if (!value) continue;
        const field = page.getByLabel(pattern).first();
        if (await field.isVisible()) await fill(page,pattern,value,{ timeout: 500 });
      }
    });
    await must('continue to review', () => choose(page, /Continue to Review|Review Order|^Continue$/i, { roles: ['button'] }));
    await must('verify final review', async () => {
      await page.getByRole('button', { name: /Place (Your )?Order/i }).waitFor({ state: 'visible', timeout: 20000 });
    });
    const readyMs = Math.round(performance.now() - bagStartedAt);
    const totalMs = Math.round(performance.now() - startedAt);
    log(`Checkout ready: ${readyMs} ms from Add to Bag`);
    if (mode !== 'full-auto') {
      onNeedsYou?.(`Everything is filled in for ${store.storeName}. Ready in ${readyMs} ms. Press Place Order in the bot window to buy.`);
      return { placed: false, page, readyMs, totalMs, timings };
    }
    await must('place order', async () => {
      await page.getByRole('button', { name: /Place (Your )?Order/i }).click();
      const done = await firstVisible([page.getByText(/Thank you|Your order number|order is placed/i)], 60000);
      return !!done;
    });
    const body = await page.textContent('body').catch(() => '');
    return { placed: true, orderNumber: body.match(/\bW\d{8,}\b/)?.[0] || null, page, readyMs, totalMs, timings };
  } catch (err) {
    const file = path.join(shotsDir, `failed-${Date.now()}.png`);
    if (page) await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    const error = new CheckoutError(step, err.message, file);
    error.retryable = false; // Checkout needs fresh stock and human review after a failed attempt.
    error.timings = timings;
    error.url = page?.url();
    error.statusCode = err.statusCode;
    throw error;
  }
}
