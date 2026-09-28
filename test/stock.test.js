import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseProducts, findPart, parseAvailability, filterRows, fulfillmentUrl, resolveParts, checkStock } from '../src/stock.js';

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
  assert.equal(rows.length, 5);
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
});

test('explains a blocked (HTML) response', async () => {
  await assert.rejects(checkStock(['X'], { zip: '95014' }, async () => '<html>captcha</html>'), /bot check/);
});
