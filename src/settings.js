// Non-secret settings, stored as plain JSON in data/settings.json.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.BOT_DATA_DIR || path.resolve('data');

// Models the settings page offers. Add a new model here when Apple releases one.
export const CATALOG = {
  'iphone-duo': {
    label: 'iPhone Duo', page: 'iphone-duo', screen: '',
    capacities: ['256GB', '512GB', '1TB', '2TB'],
    colors: ['Night Sky', 'Star White'],
  },
  'iphone-18-pro-max': {
    label: 'iPhone 18 Pro Max',
    page: 'iphone-18-pro',
    screen: '6.9-inch',
    capacities: ['256GB', '512GB', '1TB', '2TB'],
    colors: ['Silver', 'Black', 'Glacier', 'Burgundy'],
  },
  'iphone-18-pro': {
    label: 'iPhone 18 Pro',
    page: 'iphone-18-pro',
    screen: '6.3-inch',
    capacities: ['256GB', '512GB', '1TB'],
    colors: ['Silver', 'Black', 'Glacier', 'Burgundy'],
  },
};

export const DEFAULT_SETTINGS = {
  // Checked in order; the first one in stock is bought.
  targets: [{ model: 'iphone-duo', capacity: '256GB', color: 'Night Sky', partNumber: '' }],
  carrier: 'unlocked',
  pickup: {
    zip: '',
    maxDistanceMiles: 25,
    // Empty means any store near the ZIP. Otherwise only these store numbers (e.g. R033).
    storeNumbers: [],
  },
  check: {
    intervalSec: 300,
    jitterSec: 15,
    scheduleEnabled: false,
    startTime: '08:00',
    endTime: '22:00',
    timeZone: 'America/Los_Angeles',
  },
  alerts: {
    telegram: false,
    email: false,
    sms: false,
    smsMethod: 'twilio', // 'twilio' or 'gateway' (carrier email-to-text address)
    repeatMinutes: 10, // don't repeat the same in-stock alert more often than this
  },
  checkout: {
    // 'alert-only': only notify. 'stop-before-order': fill everything, wait for you to press Place Order.
    // 'full-auto': press Place Order automatically.
    mode: 'alert-only',
    account: 'guest', // 'guest' or 'apple-id' (sign in once in the bot's browser)
    headless: false,
    browser: 'chrome', // 'chrome' uses your installed Google Chrome, 'chromium' uses Playwright's
    maxOrders: 1, // stop buying after this many successful orders
    pickupBySomeoneElse: false,
  },
};

const FILE = () => path.join(DATA_DIR, 'settings.json');

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge `patch` onto `base`, keeping only keys `base` knows about. Arrays are replaced.
export function mergeKnown(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (!(key in patch)) continue;
    if (isObject(base[key])) out[key] = mergeKnown(base[key], patch[key]);
    else out[key] = patch[key];
  }
  return out;
}

export function validate(s) {
  const errors = [];
  if (!Array.isArray(s.targets) || s.targets.length === 0) errors.push('Add at least one iPhone to watch');
  for (const [i, t] of (s.targets || []).entries()) {
    const m = CATALOG[t.model];
    if (!m && !t.partNumber) errors.push(`Choice ${i + 1}: unknown model and no part number`);
    if (m && !m.capacities.includes(t.capacity)) errors.push(`Choice ${i + 1}: ${m.label} has no ${t.capacity}`);
    if (m && !m.colors.includes(t.color)) errors.push(`Choice ${i + 1}: ${m.label} has no ${t.color}`);
  }
  if (s.pickup.zip && !/^\d{5}$/.test(String(s.pickup.zip))) errors.push('ZIP code must be 5 digits');
  if ((s.pickup.storeNumbers || []).some((n) => !/^R\d{3}$/.test(String(n)))) errors.push('Store numbers must look like R033; enter your ZIP in the ZIP field instead');
  if (!(Number(s.check.intervalSec) >= 30)) errors.push('Check interval must be at least 30 seconds');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.check.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.check.endTime)) errors.push('Checking hours must use HH:MM');
  if (s.check.scheduleEnabled && s.check.startTime === s.check.endTime) errors.push('Choose different start and end times, or turn scheduled hours off');
  try { new Intl.DateTimeFormat('en-US', { timeZone: s.check.timeZone }); } catch { errors.push('Choose a valid time zone'); }
  if (!(Number(s.check.jitterSec) >= 0)) errors.push('Extra seconds cannot be negative');
  if (!['alert-only', 'stop-before-order', 'full-auto'].includes(s.checkout.mode)) errors.push('Unknown checkout mode');
  if (!['guest', 'apple-id'].includes(s.checkout.account)) errors.push('Unknown account type');
  return errors;
}

export function loadSettings() {
  try {
    return mergeKnown(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(FILE(), 'utf8')));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(patch) {
  const next = mergeKnown(loadSettings(), patch);
  next.targets = (next.targets || []).map((t) => ({
    model: String(t.model || ''),
    capacity: String(t.capacity || ''),
    color: String(t.color || ''),
    partNumber: String(t.partNumber || '').trim().toUpperCase(),
  }));
  next.pickup.storeNumbers = [].concat(next.pickup.storeNumbers || [])
    .flatMap((s) => String(s).split(/[,\s]+/))
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const errors = validate(next);
  if (errors.length) {
    const err = new Error(errors.join('. '));
    err.status = 400;
    throw err;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(next, null, 2));
  return next;
}

export function targetLabel(t) {
  const m = CATALOG[t.model];
  return m ? `${m.label} ${t.capacity} ${t.color}` : `Part ${t.partNumber}`;
}
