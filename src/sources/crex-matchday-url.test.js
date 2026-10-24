/**
 * Which URL the match-day lookup asks for.
 *
 * `/scoreboard/<id>/match-scorecard` is a dead end: it redirects to an
 * `undefined-<id>` page that now answers 404. An unreadable page is read as a
 * finished match, so a Test being played right now was recorded as over, its innings
 * never dated, and a mid-innings figure published as a settled result — Devdutt
 * Padikkal's 25 off 56 while he was still batting.
 *
 * Every match checked 404s on the short URL and answers 200 on the canonical one.
 *
 * Run: node --test src/sources/crex-matchday-url.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrexSource } from './crex.js';

/** Records the URL asked for, and answers with a minimal live match page. */
function spy(status = 200) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return {
      ok: status === 200,
      status,
      text: async () =>
        '<div class="day-session"><span>Day 2</span><span>-</span><span>Session 1</span></div>',
    };
  };
  return asked;
}

const realFetch = globalThis.fetch;

test('the canonical url is used when the row carries one', async () => {
  const asked = spy();
  const src = new CrexSource();
  await src.fetchMatchDay('13QQ', {
    maxAgeMs: 0,
    matchUrl: '/cricket-live-score/ind-a-vs-nz-a-1st-first-class-x-2026-match-updates-13QQ',
  });
  globalThis.fetch = realFetch;
  assert.ok(asked[0].includes('/cricket-live-score/'), asked[0]);
  assert.ok(!asked[0].includes('/scoreboard/'), 'the dead end is not used');
});

test('an absolute url is not doubled up', async () => {
  const asked = spy();
  const src = new CrexSource();
  await src.fetchMatchDay('13QQ', {
    maxAgeMs: 0,
    matchUrl: 'https://crex.com/cricket-live-score/x-match-updates-13QQ',
  });
  globalThis.fetch = realFetch;
  assert.equal(asked[0], 'https://crex.com/cricket-live-score/x-match-updates-13QQ');
});

test('without a url it falls back to the id', async () => {
  // Rows scraped before the href was kept have nothing better to offer.
  const asked = spy();
  const src = new CrexSource();
  await src.fetchMatchDay('13QQ', { maxAgeMs: 0 });
  globalThis.fetch = realFetch;
  assert.ok(asked[0].includes('/scoreboard/13QQ/'), asked[0]);
});

test('an unreadable page reports an error rather than a status', async () => {
  // It must not come back as a finished match, which is how this whole class of bug
  // reaches the page.
  spy(404);
  const src = new CrexSource();
  const out = await src.fetchMatchDay('13QQ', { maxAgeMs: 0, matchUrl: '/x-match-updates-13QQ' });
  globalThis.fetch = realFetch;
  assert.equal(out.status, undefined);
  assert.match(out.error, /404/);
});
