// Runs the checkout steps against a practice store page (no real apple.com, no real purchase).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-apple-'));
const { runCheckout } = await import('../src/checkout.js');
const { getBrowser, closeBrowser } = await import('../src/browser.js');
const { PAGES } = await import('./fixtures/mock-store.js');
const { DEFAULT_SETTINGS } = await import('../src/settings.js');

const hasBrowser = fs.existsSync(chromium.executablePath());
after(closeBrowser);

const secrets = {
  contact: { firstName: 'Tri', lastName: 'Nguyen', email: 'tri@example.com', phone: '5551234567' },
  card: { number: '4111111111111111', expMonth: '7', expYear: '2029', cvv: '123' },
  billing: { street: '1 Infinite Loop', zip: '95014', city: 'Cupertino', state: 'CA' },
};

async function run(mode) {
  const ctx = await getBrowser({ headless: true, browser: 'chromium' });
  await ctx.route('https://www.apple.com/**', (route) => {
    const html = PAGES[new URL(route.request().url()).pathname];
    return html ? route.fulfill({ contentType: 'text/html', body: html }) : route.fulfill({ status: 404, body: 'nope' });
  });
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.pickup.zip = '95014';
  settings.checkout = { ...settings.checkout, mode, headless: true, browser: 'chromium' };
  const needs = [];
  const result = await runCheckout({
    target: { model: 'iphone-18-pro-max', capacity: '1TB', color: 'Glacier', partNumber: 'MAAA1LL/A' },
    store: { storeName: 'Valley Fair', storeNumber: 'R075' },
    settings,
    secrets,
    log: () => {},
    onNeedsYou: (m) => needs.push(m),
  });
  return { result, needs };
}

test('full-auto checkout picks the right phone, store and details, and places the order', { skip: !hasBrowser && 'Chromium not installed' }, async () => {
  const { result } = await run('full-auto');
  assert.equal(result.placed, true);
  assert.equal(result.orderNumber, 'W123456789');
  const order = JSON.parse(await result.page.textContent('#order'));
  await result.page.close();
  assert.deepEqual(
    [order.model, order.color, order.cap, order.trade, order.pay, order.carrier, order.care],
    ['iPhone 18 Pro Max 6.9-inch display', 'Glacier', '1TB', 'No trade-in', 'Buy', 'Connect on your own later', 'No AppleCare coverage'],
  );
  assert.equal(order.store, 'Apple Valley Fair');
  assert.equal(order.time, 't1');
  assert.deepEqual([order.fn, order.ln, order.em, order.ph], ['Tri', 'Nguyen', 'tri@example.com', '5551234567']);
  assert.equal(order.method, 'Credit or Debit Card');
  assert.deepEqual([order.cc, order.exp, order.cvv], ['4111111111111111', '07/29', '123']);
  assert.deepEqual([order.bfn, order.st, order.bzip, order.city, order.state], ['Tri', '1 Infinite Loop', '95014', 'Cupertino', 'CA']);
});

test('stop-before-order fills everything but leaves Place Order for you', { skip: !hasBrowser && 'Chromium not installed' }, async () => {
  const { result, needs } = await run('stop-before-order');
  assert.equal(result.placed, false);
  assert.match(result.page.url(), /review$/);
  assert.equal(needs.length, 1);
  await result.page.close();
});
