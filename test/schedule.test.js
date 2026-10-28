import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withinCheckingHours } from '../src/schedule.js';
import { DEFAULT_SETTINGS, validate } from '../src/settings.js';
const check = { scheduleEnabled: true, startTime: '08:00', endTime: '22:00', timeZone: 'America/Los_Angeles' };
test('daily window includes start and excludes end in chosen time zone', () => {
  assert.equal(withinCheckingHours(check, new Date('2026-10-27T14:59:00Z')), false);
  assert.equal(withinCheckingHours(check, new Date('2026-10-27T15:00:00Z')), true);
  assert.equal(withinCheckingHours(check, new Date('2026-10-28T05:00:00Z')), false);
  assert.equal(withinCheckingHours(check, new Date('2026-12-01T16:00:00Z')), true);
});
test('overnight and disabled schedules', () => {
  const overnight = { ...check, startTime: '22:00', endTime: '06:00' };
  assert.equal(withinCheckingHours(overnight, new Date('2026-10-28T06:00:00Z')), true);
  assert.equal(withinCheckingHours(overnight, new Date('2026-10-28T14:00:00Z')), false);
  assert.equal(withinCheckingHours({ scheduleEnabled: false }), true);
});
test('settings reject invalid schedule and unsafe interval', () => {
  assert.deepEqual(validate(structuredClone(DEFAULT_SETTINGS)), []);
  const s = structuredClone(DEFAULT_SETTINGS);
  s.check.timeZone = 'wrong'; s.check.intervalSec = 10; s.check.startTime = '30:00';
  assert.equal(validate(s).length, 3);
});
