import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DateTime } from 'luxon';
import { bookingRetentionCutoff } from '../src/retention.js';

test('retention uses one calendar year in Madrid across summer time', () => {
  const now=DateTime.fromISO('2026-09-29T03:15:00',{zone:'Europe/Madrid'});
  assert.equal(bookingRetentionCutoff(now),'2025-09-29T01:15:00.000Z');
  const afterWinter=DateTime.fromISO('2027-01-15T03:15:00',{zone:'Europe/Madrid'});
  assert.equal(bookingRetentionCutoff(afterWinter),'2026-01-15T02:15:00.000Z');
});

test('retention handles leap day without expiring a future booking', () => {
  const now=DateTime.fromISO('2025-02-28T03:15:00',{zone:'Europe/Madrid'});
  assert.equal(bookingRetentionCutoff(now),'2024-02-28T02:15:00.000Z');
  assert.ok(DateTime.fromISO('2025-03-01T12:00:00Z').toMillis() > DateTime.fromISO(bookingRetentionCutoff(now)).toMillis());
});
