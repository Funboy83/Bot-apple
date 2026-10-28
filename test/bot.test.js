import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

function botWith(data) {
  const bot = new Bot();
  bot.settings = structuredClone(DEFAULT_SETTINGS);
  bot.settings.pickup.zip = '95014';
  bot.parts = [{ model: 'iphone-duo', capacity: '256GB', color: 'Night Sky', partNumber: 'MK1F4LL/A' }];
  bot.running = true;
  bot.get = async () => JSON.stringify(data);
  bot.schedule = () => {};
  bot.log = () => {};
  return bot;
}
const response = (pickupDisplay) => ({ body: { stores: [{ storeNumber: 'R1', storeName: 'Test Store', partsAvailability: { 'MK1F4LL/A': { pickupDisplay } } }] } });
test('watch loop alerts once for confirmed stock without checkout in alert-only mode', async () => {
  const bot = botWith(response('available'));
  const alerts = [];
  bot.alert = async (...args) => alerts.push(args);
  await bot.tick(); await bot.tick();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][0], /iPhone Duo/);
  assert.match(alerts[0][1], /Test Store/);
  assert.equal(bot.ordersPlaced, 0);
  assert.equal(bot.checkoutBusy, false);
});
test('blocked checks invalidate prior stock and do not alert', async () => {
  const bot = botWith(response('available'));
  bot.lastRows = [{ available: true, part: 'MK1F4LL/A' }];
  bot.get = async () => { throw Object.assign(new Error('HTTP 541'), { retryAt: Date.now() + 3600000 }); };
  bot.alert = async () => assert.fail('must not send stock alert');
  await bot.tick();
  assert.equal(bot.lastRows[0].available, null);
  assert.equal(bot.lastRows[0].status, 'unknown');
  assert.ok(bot.retryAt > Date.now());
});
test('unknown availability does not produce stock alerts', async () => {
  const bot = botWith(response('default'));
  bot.alert = async () => assert.fail('must not send stock alert');
  await bot.tick();
  assert.match(bot.lastError, /unknown/);
  assert.equal(bot.lastRows[0].available, null);
});
test('outside configured hours the watch loop makes no request', async () => {
  const bot = botWith(response('available'));
  const local = new Date().toISOString().slice(11, 16);
  const hour = (Number(local.slice(0, 2)) + 2) % 24;
  bot.settings.check = { scheduleEnabled: true, timeZone: 'UTC', startTime: `${String(hour).padStart(2, '0')}:00`, endTime: `${String((hour + 1) % 24).padStart(2, '0')}:00` };
  bot.get = async () => assert.fail('must not query outside hours');
  try { await bot.tick(); assert.equal(bot.waitingForHours, true); } finally { clearTimeout(bot.timer); }
});
