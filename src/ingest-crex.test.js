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

/* ── short reads ──
   A player page is read through a sequence of tab clicks and card selections, each
   wrapped in a catch, so an incomplete read looks exactly like a player with fewer
   innings. It silently replaced good data with less: a genuinely cold scrape returned
   2,807 innings where the previous run held 2,832, and Kuldeep Yadav lost his three
   West Indies ODIs. */

test('a re-read with fewer rows keeps the fuller previous set', async () => {
  const { keepRicher } = await import('./ingest-crex.js');
  const previous = [{ date: '2026-10-03' }, { date: '2026-09-30' }, { date: '2026-09-27' }];
  const short = [{ date: '2026-09-27' }];
  assert.deepEqual(keepRicher(previous, short, 'kuldeep-yadav-75'), previous);
});

test('a re-read with the same or more rows wins', async () => {
  const { keepRicher } = await import('./ingest-crex.js');
  const previous = [{ date: '2026-09-27' }];
  const more = [{ date: '2026-10-03' }, { date: '2026-09-27' }];
  assert.deepEqual(keepRicher(previous, more, 'x'), more);
  // Equal counts take the fresh rows, so a corrected figure still lands.
  const same = [{ date: '2026-09-27', batting: { runs: 9 } }];
  assert.deepEqual(keepRicher(previous, same, 'x'), same);
});

test('a player with no previous rows takes whatever was read', async () => {
  const { keepRicher } = await import('./ingest-crex.js');
  assert.deepEqual(keepRicher(undefined, [{ date: '2026-10-03' }], 'x'), [{ date: '2026-10-03' }]);
  assert.deepEqual(keepRicher([], [], 'x'), []);
});
