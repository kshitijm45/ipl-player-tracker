/**
 * Commentary-feed tests.
 *
 * The fixtures mirror the real feed's shape and the real answer: ENG v PAK's 2nd Test
 * started on 27 August, and a full 208-page walk of its commentary dates the first
 * innings to the 28th and the second and third to the 30th. That is the case the whole
 * module exists to produce, so it is pinned here with a stubbed fetch rather than by
 * hitting the network.
 *
 * Run: node --test src/sources/crex-commentary.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inningsDays, hasFeed, PAGE_SIZE } from './crex-commentary.js';

/** Epoch ms for a date at midday UTC, which is inside a day's play anywhere. */
const at = (iso, h = 12) => Date.parse(`${iso}T${String(h).padStart(2, '0')}:00:00Z`);

/**
 * A stub feed. `entries` are given oldest-first for readability and served
 * newest-first in pages of ten, exactly as CREX does.
 */
function stubFeed(entries, { failOnPage = null } = {}) {
  const newestFirst = [...entries].sort((a, b) => b.id - a.id);
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    if (failOnPage && calls === failOnPage) return { ok: false, status: 500 };
    const { lastDocId } = JSON.parse(init.body);
    const from = lastDocId
      ? newestFirst.findIndex((e) => e.id === lastDocId) + 1
      : 0;
    const slice = newestFirst.slice(from, from + PAGE_SIZE);
    return { ok: true, json: async () => slice };
  };
  return { fetchImpl, calls: () => calls };
}

/** Build `n` entries for one innings on one day. */
const inningsOn = (inning, iso, n, base = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: at(iso) + base + i * 1000,
    inning,
    c: `ball ${i}`,
  }));

test('dates each innings by the last day it was played', () => {
  // The real ENG v PAK 2nd Test shape: innings 1 on day 2, innings 2 spanning days
  // 2-4, innings 3 on day 4.
  const feed = [
    ...inningsOn(1, '2026-08-28', 12),
    ...inningsOn(2, '2026-08-28', 4, 60000),
    ...inningsOn(2, '2026-08-29', 10),
    ...inningsOn(2, '2026-08-30', 6),
    ...inningsOn(3, '2026-08-30', 11, 60000),
  ];
  const { fetchImpl } = stubFeed(feed);

  return inningsDays('VSO', { fetchImpl }).then((r) => {
    assert.deepEqual(r.endedOn, {
      1: '2026-08-28',
      2: '2026-08-30',
      3: '2026-08-30',
    });
    // And where each innings began, which is what makes "Days 2-4" sayable.
    assert.equal(r.startedOn[2], '2026-08-28');
    assert.deepEqual(r.days, ['2026-08-28', '2026-08-29', '2026-08-30']);
    assert.equal(r.complete, true);
  });
});

test('pre-match and toss entries are not treated as innings', async () => {
  const feed = [
    { id: at('2026-08-26'), inning: -1, c: 'preview' },
    { id: at('2026-08-27'), inning: 0, c: 'toss' },
    ...inningsOn(1, '2026-08-28', 3),
  ];
  const { fetchImpl } = stubFeed(feed);
  const r = await inningsDays('VSO', { fetchImpl });
  assert.deepEqual(Object.keys(r.endedOn), ['1']);
  assert.equal(r.endedOn[1], '2026-08-28');
  // The buildup days are still reported as days the feed covered.
  assert.ok(r.days.includes('2026-08-26'));
});

test('walks every page of a long feed', async () => {
  // ~2,000 entries over 200 pages is the real scale of a Test.
  const feed = Array.from({ length: 250 }, (_, i) => ({
    id: at('2026-08-30') + i * 1000,
    inning: 2,
    c: `ball ${i}`,
  }));
  const { fetchImpl, calls } = stubFeed(feed);
  const r = await inningsDays('X', { fetchImpl });
  assert.equal(r.entries, 250);
  assert.equal(r.pages, 25);
  // 25 pages of content plus the empty page that ends the walk.
  assert.equal(calls(), 26);
  assert.equal(r.complete, true);
});

test('an unreadable page stops the walk but keeps what was already dated', async () => {
  // The endpoint is third-party and undocumented, so a mid-walk failure is routine.
  // Days already seen came from real entries and stay valid; `complete` says the
  // walk did not finish, so the caller knows not to treat the oldest innings as
  // settled.
  const feed = [
    ...inningsOn(1, '2026-08-28', 15),
    ...inningsOn(2, '2026-08-30', 15),
  ];
  const { fetchImpl } = stubFeed(feed, { failOnPage: 3 });
  const r = await inningsDays('VSO', { fetchImpl });
  assert.equal(r.complete, false);
  // Innings 2 is newest, so it resolved before the failure.
  assert.equal(r.endedOn[2], '2026-08-30');
  assert.equal(r.pages, 2);
});

test('a match with no feed reports none', async () => {
  // BAN-A v SA-A: the endpoint answers, with nothing in it.
  const { fetchImpl } = stubFeed([]);
  assert.equal(await hasFeed('13SK', { fetchImpl }), false);
  const r = await inningsDays('13SK', { fetchImpl });
  assert.deepEqual(r.endedOn, {});
  assert.equal(r.entries, 0);
});

test('a probe is one request', async () => {
  const { fetchImpl, calls } = stubFeed(inningsOn(1, '2026-08-28', 3));
  assert.equal(await hasFeed('VSO', { fetchImpl }), true);
  assert.equal(calls(), 1);
});

test('a refusing endpoint is not mistaken for an empty feed', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 });
  assert.equal(await hasFeed('VSO', { fetchImpl }), false);
  const r = await inningsDays('VSO', { fetchImpl });
  // Nothing dated, and explicitly not a completed walk — so the caller leaves the
  // innings on the match start date rather than concluding the match had no play.
  assert.deepEqual(r.endedOn, {});
  assert.equal(r.complete, false);
});

test('a changed response shape stops the walk rather than being parsed', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [] }) });
  const r = await inningsDays('VSO', { fetchImpl });
  assert.equal(r.complete, false);
  assert.deepEqual(r.endedOn, {});
});

test('a cursor that does not advance cannot loop forever', async () => {
  // A page whose last id equals the cursor we sent would otherwise repeat.
  const stuck = { id: at('2026-08-30'), inning: 1, c: 'x' };
  const fetchImpl = async () => ({ ok: true, json: async () => [stuck] });
  const r = await inningsDays('VSO', { fetchImpl });
  assert.ok(r.pages <= 2);
  assert.equal(r.endedOn[1], '2026-08-30');
});

test('entries without a usable timestamp are ignored', async () => {
  const feed = [
    { id: 42, inning: 1, c: 'not a timestamp' },
    { id: null, inning: 1, c: 'missing' },
    ...inningsOn(1, '2026-08-28', 2),
  ];
  const { fetchImpl } = stubFeed(feed);
  const r = await inningsDays('VSO', { fetchImpl });
  assert.equal(r.endedOn[1], '2026-08-28');
  assert.deepEqual(r.days, ['2026-08-28']);
});
