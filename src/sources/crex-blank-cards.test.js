/**
 * Naming a series card CREX rendered without its title.
 *
 * The card keeps its dates and its "Played for" code and loses only the name, so the
 * innings under it are dropped — a row filed under a competition no one can recognise
 * is worse than one that is missing. Tilak Varma lost his England and Ireland tours
 * that way, seven innings.
 *
 * The recovery types into the card list's own search box, which re-renders the
 * matching cards with their titles. What matters here is that it can only ever *add*
 * a name: every window passed in comes back, and one that cannot be named is left
 * exactly as it arrived.
 *
 * Run: node --test src/sources/crex-blank-cards.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSeriesCard } from './crex.js';

/** The recovery is module-private, so it is lifted out of the source for testing. */
const nameBlankCards = new Function(
  'parseSeriesCard',
  'return ' + readFileSync(new URL('./crex.js', import.meta.url), 'utf8')
    .match(/async function nameBlankCards[\s\S]*?\n\}/)[0]
)(parseSeriesCard);

/** A page whose search box returns `labels`, recording what was typed. */
function fakePage(labels, typed = []) {
  const box = {
    count: async () => 1,
    click: async () => {},
    fill: async () => {},
    press: async () => {},
    pressSequentially: async (q) => typed.push(q),
  };
  return {
    typed,
    locator: () => ({ first: () => box }),
    waitForTimeout: async () => {},
    $$eval: async () => labels,
  };
}

const windows = () => [
  { name: 'IPL 2026', playedFor: 'MI', from: 'Mar 28', to: 'May 31' },
  { name: null, playedFor: 'IND', from: 'Jul 1', to: 'Jul 19' },
  { name: null, playedFor: 'SZ', from: 'Aug 23', to: 'Sep 10' },
  { name: 'VHT Elite 2025-26', playedFor: 'HYD', from: 'Dec 24', to: 'Jan 18' },
];

test('a blank card is named from the search', async () => {
  const page = fakePage([
    'IND vs ENG 2026Jul 1 - Jul 19Played for IND',
    'Duleep Trophy 2026Aug 23 - Sep 10Played for SZ',
  ]);
  const out = await nameBlankCards(page, windows());
  assert.equal(out.find((w) => w.from === 'Jul 1').name, 'IND vs ENG 2026');
  assert.equal(out.find((w) => w.from === 'Aug 23').name, 'Duleep Trophy 2026');
});

test('every window passed in comes back', async () => {
  // The search filters the list on screen; it must not filter the result.
  const page = fakePage(['IND vs ENG 2026Jul 1 - Jul 19Played for IND']);
  assert.equal((await nameBlankCards(page, windows())).length, 4);
});

test('a card already named is never touched', async () => {
  // Even if the search happens to return a different name for the same window.
  const page = fakePage(['Something Else 2026Mar 28 - May 31Played for MI']);
  const out = await nameBlankCards(page, windows());
  assert.equal(out.find((w) => w.from === 'Mar 28').name, 'IPL 2026');
});

test('a search that finds nothing changes nothing', async () => {
  const page = fakePage([]);
  const out = await nameBlankCards(page, windows());
  assert.equal(out.length, 4);
  assert.equal(out.filter((w) => w.name).length, 2, 'the two that already had names');
  assert.equal(out.find((w) => w.from === 'Jul 1').name, null, 'and the blanks stay blank');
});

test('the search is keyed on the blank card\'s own team', async () => {
  // Not on a season: "2026" misses a split season labelled 2025-26, so a blank card
  // from one would stay blank. The "Played for" code is on every blank by definition,
  // and a team the player has never turned out for before needs no change here.
  const typed = [];
  await nameBlankCards(fakePage([], typed), windows());
  assert.deepEqual(typed.sort(), ['IND', 'SZ']);
});

test('a team seen only on a named card is not searched for', async () => {
  // One search per distinct code the blanks carry, not per card on the page.
  const typed = [];
  await nameBlankCards(fakePage([], typed), windows());
  assert.ok(!typed.includes('MI'), 'MI was already named');
  assert.ok(!typed.includes('HYD'), 'HYD was already named');
});

test('nothing is searched when no card is blank', async () => {
  const typed = [];
  const named = windows().filter((w) => w.name);
  const out = await nameBlankCards(fakePage([], typed), named);
  assert.deepEqual(out, named);
  assert.equal(typed.length, 0, 'the page is not touched at all');
});

test('a page with no search box leaves the windows alone', async () => {
  const page = {
    locator: () => ({ first: () => ({ count: async () => 0 }) }),
    waitForTimeout: async () => {},
    $$eval: async () => [],
  };
  assert.equal((await nameBlankCards(page, windows())).length, 4);
});

test('a blank card with no team cannot be searched for, and survives', async () => {
  const w = [{ name: null, playedFor: null, from: 'Jun 1', to: 'Jun 9' }];
  const out = await nameBlankCards(fakePage([]), w);
  assert.deepEqual(out, w);
});

test('a page that throws mid-search still returns every window', async () => {
  const box = {
    count: async () => 1,
    click: async () => { throw new Error('detached'); },
    fill: async () => {},
    press: async () => {},
    pressSequentially: async () => {},
  };
  const page = {
    locator: () => ({ first: () => box }),
    waitForTimeout: async () => {},
    $$eval: async () => [],
  };
  assert.equal((await nameBlankCards(page, windows())).length, 4);
});
