/**
 * Cache-window parsing.
 *
 * One falsy zero cost four full rescrapes. `CACHE_HOURS=0` means "ignore the cache",
 * and `(Number('0') || 24)` turned it into twenty-four hours — so every run launched
 * with `full_rescrape=true` was served from cache, reproduced the same stale rows, and
 * made fixes that worked locally look broken in CI.
 *
 * Run: node --test src/ingest-crex.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheMs } from './ingest-crex.js';

const H = 3600e3;

test('zero means do not use the cache', () => {
  // The case the old expression got wrong, and the only one that matters for
  // `full_rescrape`. `readCache` already honours 0; it simply never received it.
  assert.equal(cacheMs('0'), 0);
  assert.equal(cacheMs(0), 0);
});

test('a real window is taken as given', () => {
  assert.equal(cacheMs('20'), 20 * H);
  assert.equal(cacheMs('24'), 24 * H);
  assert.equal(cacheMs('1'), 1 * H);
});

test('an absent or unparseable value falls back to a day', () => {
  assert.equal(cacheMs(undefined), 24 * H);
  assert.equal(cacheMs(''), 24 * H);
  assert.equal(cacheMs('   '), 24 * H);
  assert.equal(cacheMs('abc'), 24 * H);
});
