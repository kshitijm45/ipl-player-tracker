/**
 * The series list is lazy-loaded, and reading it unscrolled loses tournaments.
 *
 * CREX renders about seven series cards and loads the rest only as `.scrollSeriesEle`
 * is scrolled — its own container, not the window. The walk read whatever was on
 * screen, so Ishan Kishan's June ODIs against Afghanistan were missing: he has 43
 * cards, the seven most recent were all it ever saw, and those two innings sat in the
 * 36 it never reached.
 *
 * Nothing about that looked like a failure. He had rows, his page was populated, and
 * the only symptom was a tournament quietly absent from a career that otherwise added
 * up — for every player with more than seven series.
 *
 * These drive the loader against a fake page rather than CREX, so they pin the
 * stopping rule without a network call.
 *
 * Run: node --test src/sources/crex-series-cards.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The loader is module-private, so it is lifted out of the source for testing. */
const load = new Function(
  'return ' +
    readFileSync(new URL('./crex.js', import.meta.url), 'utf8')
      .match(/async function loadAllSeriesCards[\s\S]*?\n\}/)[0]
)();

/**
 * A page whose card count grows by `step` per scroll until it reaches `total`.
 * `waitForTimeout` resolves immediately so the tests do not actually wait.
 */
function fakePage(total, { step = 6, start = 7 } = {}) {
  let count = Math.min(start, total);
  let scrolls = 0;
  return {
    scrolls: () => scrolls,
    async evaluate() {
      scrolls++;
      count = Math.min(count + step, total);
      return count;
    },
    async waitForTimeout() {},
  };
}

test('it keeps scrolling until every card is loaded', () => {
  // The case that caused the bug: 43 cards behind an initial 7.
  const page = fakePage(43);
  return load(page, { settleMs: 0 }).then((n) => {
    assert.equal(n, 43);
  });
});

test('a short list settles without scrolling forever', async () => {
  const page = fakePage(7);
  const n = await load(page, { settleMs: 0 });
  assert.equal(n, 7);
  // Two quiet rounds to confirm, not forty.
  assert.ok(page.scrolls() <= 4, `settled in ${page.scrolls()} scrolls`);
});

test('a list that never settles cannot hang the scrape', async () => {
  // Infinite growth: the cap is the only thing that stops it.
  const page = {
    n: 0,
    async evaluate() { return (this.n += 5); },
    async waitForTimeout() {},
  };
  const n = await load(page, { maxRounds: 6, settleMs: 0 });
  assert.equal(n, 30, 'stopped at the round cap');
});

test('a page that throws on scroll does not abort the walk', async () => {
  // A detached container or a navigation mid-scroll must degrade, not throw: the
  // cards already loaded are still worth reading.
  const page = {
    async evaluate() { throw new Error('detached'); },
    async waitForTimeout() {},
  };
  const n = await load(page, { maxRounds: 3, settleMs: 0 });
  assert.equal(n, 0);
});

test('one flat round is not mistaken for the end', async () => {
  // A scroll can land between a render and its next batch, so a single unchanged
  // count means nothing. Stopping on it would reintroduce the bug at a later card.
  let round = 0;
  const counts = [7, 7, 13, 19, 19, 19];
  const page = {
    async evaluate() { return counts[Math.min(round++, counts.length - 1)]; },
    async waitForTimeout() {},
  };
  const n = await load(page, { settleMs: 0 });
  assert.equal(n, 19, 'kept going past the flat round and found the rest');
});
