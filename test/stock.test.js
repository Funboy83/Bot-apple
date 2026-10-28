import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseProducts, findPart, parseAvailability, filterRows, fulfillmentUrl, resolveParts, checkStock, createInventoryGetter } from '../src/stock.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/fulfillment.json', import.meta.url)));
const PAGE = `<script>window.PRODUCT_SELECTION_BOOTSTRAP = {"products":[
  {"partNumber":"MAAA1LL/A","dimensionScreensize":"6_9inch","dimensionCapacity":"1tb","dimensionColor":"silver","carrierModel":"UNLOCKED/US"},
  {"partNumber":"MAAA3LL/A","dimensionScreensize":"6_9inch","dimensionCapacity":"1tb","dimensionColor":"silver","carrierModel":"ATT/US"},
  {"partNumber":"MAAA2LL/A","dimensionScreensize":"6_9inch","dimensionCapacity":"2tb","dimensionColor":"black","carrierModel":"UNLOCKED/US"},
  {"partNumber":"MBBB1LL/A","dimensionScreensize":"6_3inch","dimensionCapacity":"1tb","dimensionColor":"silver","carrierModel":"UNLOCKED/US"}
]}</script>`;

test('finds the unlocked Pro Max part for the chosen storage and color', () => {
  const products = parseProducts(PAGE);
  assert.equal(products.length, 4);
  assert.equal(findPart(products, { model: 'iphone-18-pro-max', capacity: '1TB', color: 'Silver' }), 'MAAA1LL/A');
  assert.equal(findPart(products, { model: 'iphone-18-pro-max', capacity: '2TB', color: 'Black' }), 'MAAA2LL/A');
  assert.equal(findPart(products, { model: 'iphone-18-pro', capacity: '1TB', color: 'Silver' }), 'MBBB1LL/A');
  assert.equal(findPart(products, { model: 'iphone-18-pro-max', capacity: '256GB', color: 'Silver' }), null);
});

test('resolveParts keeps manual part numbers and reports missing ones', async () => {
  const { resolved, problems } = await resolveParts(
    [
      { model: 'iphone-18-pro-max', capacity: '1TB', color: 'Silver', partNumber: '' },
      { model: 'iphone-18-pro-max', capacity: '512GB', color: 'Glacier', partNumber: 'MZZZ9LL/A' },
      { model: 'iphone-18-pro-max', capacity: '256GB', color: 'Burgundy', partNumber: '' },
    ],
    async () => PAGE,
  );
  assert.deepEqual(resolved.map((t) => t.partNumber), ['MAAA1LL/A', 'MZZZ9LL/A']);
  assert.equal(problems.length, 1);
});

test('reads pickup availability per store and part', () => {
  const rows = parseAvailability(fixture, ['MAAA1LL/A', 'MAAA2LL/A']);
  assert.equal(rows.length, 6);
  const vf = rows.find((r) => r.storeNumber === 'R075' && r.part === 'MAAA1LL/A');
  assert.equal(vf.available, true);
  assert.equal(vf.distance, 3.1);
  assert.equal(vf.quote, 'Available Today');
  assert.equal(rows.find((r) => r.storeNumber === 'R033' && r.part === 'MAAA1LL/A').quote, 'Currently unavailable');
});

test('filters by distance and chosen stores', () => {
  const rows = parseAvailability(fixture, ['MAAA1LL/A']);
  assert.deepEqual(filterRows(rows, { maxDistanceMiles: 25, storeNumbers: [] }).map((r) => r.storeNumber), ['R075', 'R033']);
  assert.deepEqual(filterRows(rows, { maxDistanceMiles: 100, storeNumbers: ['r033'] }).map((r) => r.storeNumber), ['R033']);
});

test('builds the fulfillment URL with every part', () => {
  const u = new URL(fulfillmentUrl(['A1LL/A', 'B2LL/A'], '95014'));
  assert.equal(u.searchParams.get('parts.0'), 'A1LL/A');
  assert.equal(u.searchParams.get('parts.1'), 'B2LL/A');
  assert.equal(u.searchParams.get('location'), '95014');
  assert.equal(u.pathname, '/shop/retail/pickup-message');
  assert.equal(u.searchParams.has('mts.1'), false);
});

test('explains a blocked (HTML) response', async () => {
  await assert.rejects(checkStock(['X'], { zip: '95014' }, async () => '<html>captcha</html>'), /bot check/);
});


test('missing and unrecognized availability stay unknown', () => {
  for (const pickupDisplay of [undefined, 'default', 'ineligible', 'new-value']) {
    const rows = parseAvailability({ body: { stores: [{ storeNumber: 'R1', partsAvailability: { X: { pickupDisplay } } }] } }, ['X', 'Y']);
    assert.ok(rows.every((r) => r.status === 'unknown' && r.available === null));
  }
  assert.throws(() => parseAvailability({ body: { stores: [] } }, ['X']));
});

test('541 blocks manual and scheduled requests for an hour, then recovers', async () => {
  let time = 0, calls = 0;
  const get = createInventoryGetter({ now: () => time, fetcher: async () => {
    calls++;
    return calls === 1 ? new Response('blocked', { status: 541 }) : new Response(JSON.stringify(fixture));
  } });
  const url = fulfillmentUrl(['MAAA1LL/A'], '95014');
  await assert.rejects(get(url), (e) => e.statusCode === 541 && e.retryAt === 3600000);
  time = 3599999;
  await assert.rejects(get(url), /cooling down/);
  assert.equal(calls, 1);
  time = 3600000;
  await get(url);
  await assert.rejects(get(url), /cooling down/);
  assert.equal(calls, 2);
});

test('429 honors Retry-After and malformed data backs off', async () => {
  let time = 0, calls = 0;
  const get = createInventoryGetter({ now: () => time, fetcher: async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '7200' } }) : new Response('<html>blocked</html>');
  } });
  const url = fulfillmentUrl(['X'], '95014');
  await assert.rejects(get(url), (e) => e.retryAt === 7200000);
  time = 7200000;
  await assert.rejects(get(url), (e) => e.retryAt > time && /unknown/.test(e.message));
  await assert.rejects(get(url), /cooling down/);
  assert.equal(calls, 2);
});


test('current nested metrics data resolves every Duo color and storage', () => {
  const data = fs.readFileSync(new URL('./fixtures/duo-products.json', import.meta.url), 'utf8');
  const products = parseProducts(`<script type="application/json" id="metrics">${data}</script>`);
  assert.equal(products.length, 8);
  assert.equal(findPart(products, { model: 'iphone-duo', capacity: '256GB', color: 'Night Sky' }), 'MK1F4LL/A');
  assert.equal(findPart(products, { model: 'iphone-duo', capacity: '2TB', color: 'Star White' }), 'MK1Q4LL/A');
  assert.equal(findPart(products, { model: 'iphone-18-pro', capacity: '256GB', color: 'Night Sky' }), null);
});
