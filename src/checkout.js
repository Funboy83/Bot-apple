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
    await new Promise((r) => setTimeout(r, 250));
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
  await el.click({ timeout: 5000 }).catch(async () => el.click({ force: true, timeout: 5000 }));
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
    await el.fill('');
    await el.pressSequentially(String(value), { delay: 20 });
  }
  return true;
}

export async function runCheckout({ target, store, settings, secrets, log, onNeedsYou }) {
  const model = CATALOG[target.model];
  const mode = settings.checkout.mode;
  const shotsDir = path.join(DATA_DIR, 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const page = await newPage({ headless: settings.checkout.headless, browser: settings.checkout.browser });
  page.setDefaultTimeout(15000);

  let step = 'start';
  const must = async (name, fn) => {
    step = name;
    log(`Checkout: ${name}`);
    const ok = await fn();
    if (ok === false) throw new Error('could not find it on the page');
  };

  try {
    await must('open the product page', async () => {
      await page.goto(`${APPLE}/shop/buy-iphone/${model?.page || 'iphone'}`, { waitUntil: 'domcontentloaded' });
    });

    if (model) {
      // Apple reveals these one at a time; loop until Add to Bag is clickable.
      const picks = [
        [target.model.endsWith('pro-max') ? /Pro Max/i : /iPhone \d+ Pro(?! Max)/i],
        [new RegExp(`^\\s*${esc(target.color)}\\b`, 'i'), new RegExp(`\\b${esc(target.color)}\\b`, 'i')],
        [new RegExp(`^\\s*${esc(target.capacity).replace('GB', '\\s?GB').replace('TB', '\\s?TB')}`, 'i')],
        [/No trade.?in/i],
        [/^(Buy|Pay in full|One.?time payment|Full price)/i],
        [/Connect.*(own|later)|^Unlocked|SIM.?free/i],
        [/No AppleCare/i],
      ];
      step = 'choose model, color and storage';
      log(`Checkout: ${step}`);
      for (let round = 0; round < 3; round++) {
        for (const patterns of picks) {
          for (const p of patterns) {
            if (await choose(page, p, { timeout: round === 0 ? 4000 : 1500, roles: ['radio'] })) break;
          }
        }
        const add = page.getByRole('button', { name: /Add to Bag/i }).filter({ visible: true }).first();
        if ((await add.count()) && (await add.isEnabled())) break;
      }
      await must('add to bag', () => choose(page, /Add to Bag/i, { timeout: 10000, roles: ['button'] }));
      await page.waitForLoadState('domcontentloaded');
    }

    await must('open the bag', async () => {
      await page.goto(`${APPLE}/shop/bag`, { waitUntil: 'domcontentloaded' });
    });
    await must('check out', () => choose(page, /^Check ?Out$/i, { roles: ['button', 'link'] }));

    step = 'sign in';
    if (settings.checkout.account === 'guest') {
      await must('continue as guest', () => choose(page, /Continue as Guest|Guest Checkout/i, { timeout: 20000, roles: ['button', 'link'] }));
    } else {
      log('Checkout: waiting for your Apple ID session (sign in once with "Open bot browser" if this stalls)');
      const signedIn = await firstVisible([page.getByRole('radio', { name: /pick it up/i }), page.getByText(/pick it up/i)], 60000);
      if (!signedIn) {
        onNeedsYou?.('Apple is asking you to sign in. Sign in in the bot window within 5 minutes.');
        const later = await firstVisible([page.getByText(/pick it up/i)], 5 * 60000);
        if (!later) throw new Error('not signed in to Apple ID');
      }
    }

    await must('choose store pickup', () => choose(page, /I.?ll pick it up|Pick( it)? ?up/i, { timeout: 20000 }));
    step = 'find the store';
    if (await fill(page, /ZIP|Zip Code|City|Location/i, settings.pickup.zip, { timeout: 5000 })) {
      await page.keyboard.press('Enter');
    }
    const storePattern = new RegExp(esc(store.storeName.replace(/^Apple\s+/i, '')), 'i');
    await must(`choose ${store.storeName}`, () => choose(page, storePattern, { timeout: 15000, roles: ['radio', 'button'] }));

    step = 'choose pickup time';
    const time = await firstVisible([page.getByRole('combobox', { name: /time|window/i }), page.locator('select')], 5000);
    if (time) {
      const values = await time.locator('option').evaluateAll((opts) => opts.filter((o) => o.value && !o.disabled).map((o) => o.value));
      if (values.length) await time.selectOption(values[0]);
    }
    await must('continue to pickup details', () => choose(page, /Continue to Pickup Details|^Continue/i, { roles: ['button'] }));

    const c = secrets.contact || {};
    const p = settings.checkout.pickupBySomeoneElse ? secrets.pickupPerson || {} : c;
    step = 'fill pickup details';
    log(`Checkout: ${step}`);
    if (settings.checkout.pickupBySomeoneElse) await choose(page, /someone else/i, { timeout: 4000 });
    await fill(page, /First Name/i, p.firstName);
    await fill(page, /Last Name/i, p.lastName);
    await fill(page, /Email/i, c.email || p.email);
    await fill(page, /Phone/i, p.phone || c.phone);
    await must('continue to payment', () => choose(page, /Continue to Payment|^Continue/i, { roles: ['button'] }));

    const card = secrets.card || {};
    const bill = secrets.billing || {};
    step = 'fill payment';
    log(`Checkout: ${step}`);
    await choose(page, /Credit or Debit Card|Credit\/Debit/i, { timeout: 8000 });
    if (!(await fill(page, /Card Number/i, card.number, { timeout: 10000 }))) throw new Error('card number field not found');
    const exp = `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`;
    await fill(page, /Expiration|MM\s*\/\s*YY/i, exp);
    await fill(page, /CVV|Security Code|CVC/i, card.cvv);
    await fill(page, /First Name/i, bill.firstName || c.firstName);
    await fill(page, /Last Name/i, bill.lastName || c.lastName);
    await fill(page, /Street Address|Address Line 1/i, bill.street);
    await fill(page, /Apt|Suite|Address Line 2/i, bill.street2);
    await fill(page, /ZIP/i, bill.zip);
    await fill(page, /City/i, bill.city);
    await fill(page, /State/i, bill.state);
    await fill(page, /Phone/i, bill.phone || c.phone);
    await must('continue to review', () => choose(page, /Continue to Review|Review Order|^Continue/i, { roles: ['button'] }));

    const place = await firstVisible([page.getByRole('button', { name: /Place (Your )?Order/i })], 20000);
    if (!place) throw new Error('Place Order button never appeared');

    if (mode !== 'full-auto') {
      step = 'waiting for you';
      onNeedsYou?.(`Everything is filled in for ${store.storeName}. Press Place Order in the bot window to buy.`);
      return { placed: false, page };
    }

    await must('place order', async () => {
      await place.click();
      const done = await firstVisible([page.getByText(/Thank you|Your order number|order is placed/i)], 60000);
      return !!done;
    });
    const body = await page.textContent('body').catch(() => '');
    const orderNumber = body.match(/\bW\d{8,}\b/)?.[0] || null;
    return { placed: true, orderNumber, page };
  } catch (err) {
    const file = path.join(shotsDir, `failed-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    throw new CheckoutError(step, err.message, file);
  }
}
