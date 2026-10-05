/**
 * Folding a scorecard into the scraped innings.
 *
 * The rules pinned here are all about restraint: the scorecard fills two fields and
 * touches nothing else. It does not create rows, does not delete them, and does not
 * overwrite a figure the player page gave — because the innings table and the career
 * totals have to agree, and a silent correction in one of them would be invisible.
 *
 * Run: node --test src/core/scorecard-merge.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsScorecard,
  matchesToBackfill,
  pickInnings,
  enrich,
} from './scorecard-merge.js';

const slugs = new Map([['p1', 'shubman-gill-O5'], ['p2', 'saurabh-dubey-62M']]);

test('a bowling innings with no balls needs a scorecard', () => {
  assert.equal(needsScorecard({ bowling: { wickets: 1, runs: 48 } }), true);
  assert.equal(needsScorecard({ bowling: { wickets: 1, runs: 48, balls: 60 } }), false);
});

test('a batting innings needs one until its dismissal is from a scorecard', () => {
  // `out: true` straight off the player page is not knowledge — the page never
  // prints the asterisk, so every innings arrives looking like a dismissal.
  assert.equal(needsScorecard({ batting: { runs: 1, balls: 2, out: true } }), true);
  assert.equal(
    needsScorecard({ batting: { runs: 1, balls: 2, out: true, outFrom: 'scorecard' } }),
    false
  );
});

test('an enriched innings needs nothing', () => {
  assert.equal(
    needsScorecard({
      batting: { runs: 5, balls: 4, out: false, outFrom: 'scorecard' },
      bowling: { wickets: 0, runs: 12, balls: 12 },
    }),
    false
  );
  assert.equal(needsScorecard(null), false);
});

test('matches are listed newest first, deduplicated', () => {
  const byPlayer = {
    p1: [
      { matchId: 'A', date: '2026-09-01', batting: { runs: 1, balls: 2, out: true } },
      { matchId: 'B', date: '2026-10-02', batting: { runs: 3, balls: 4, out: true } },
    ],
    p2: [{ matchId: 'A', date: '2026-09-01', bowling: { wickets: 1, runs: 20 } }],
  };
  assert.deepEqual(matchesToBackfill(byPlayer).map((m) => m.matchId), ['B', 'A']);
});

test('a fully enriched match is not listed again', () => {
  // What makes the backfill resumable.
  const byPlayer = {
    p1: [
      {
        matchId: 'A', date: '2026-09-01',
        batting: { runs: 1, balls: 2, out: true, outFrom: 'scorecard' },
      },
    ],
  };
  assert.deepEqual(matchesToBackfill(byPlayer), []);
  assert.equal(matchesToBackfill(byPlayer, { force: true }).length, 1);
});

test('a row with no match id cannot be backfilled', () => {
  const byPlayer = { p1: [{ date: '2026-09-01', bowling: { wickets: 1, runs: 20 } }] };
  assert.deepEqual(matchesToBackfill(byPlayer), []);
});

test('the match url is carried where the scrape recorded it', () => {
  const byPlayer = {
    p1: [{
      matchId: 'A', date: '2026-09-01', matchUrl: '/cricket-live-score/x-match-updates-A',
      bowling: { wickets: 1, runs: 20 },
    }],
  };
  assert.equal(matchesToBackfill(byPlayer)[0].matchUrl, '/cricket-live-score/x-match-updates-A');
});

test('a Test innings is matched on its innings number', () => {
  // Taking the first row would file his second-innings figures against his first.
  const cardRows = [
    { slug: 's', innings: 1, balls: 60, runs: 30, wickets: 1 },
    { slug: 's', innings: 3, balls: 36, runs: 20, wickets: 2 },
  ];
  assert.equal(pickInnings(cardRows, { slug: 's', innings: 3 }).runs, 20);
  // An innings the scorecard does not have is not substituted with another.
  assert.equal(pickInnings(cardRows, { slug: 's', innings: 2 }), null);
});

test('a limited-overs innings needs no innings number', () => {
  const cardRows = [{ slug: 's', innings: 1, balls: 24, runs: 30, wickets: 1 }];
  assert.equal(pickInnings(cardRows, { slug: 's' }).balls, 24);
});

test('an ambiguous match is refused rather than guessed', () => {
  const cardRows = [
    { slug: 's', innings: 1, balls: 60 },
    { slug: 's', innings: 2, balls: 36 },
  ];
  assert.equal(pickInnings(cardRows, { slug: 's' }), null);
});

test('another player\'s rows are not mine', () => {
  assert.equal(pickInnings([{ slug: 'other', innings: 1, balls: 24 }], { slug: 's' }), null);
});

/* ── enrich ── */

const card = {
  matchId: '11AJ',
  batting: [
    { slug: 'shubman-gill-O5', innings: 1, runs: 223, balls: 133, fours: 18, sixes: 14, out: false },
  ],
  bowling: [
    { slug: 'saurabh-dubey-62M', innings: 1, balls: 60, maidens: 1, runs: 48, wickets: 4, econ: 4.8 },
  ],
};

test('a not-out is recovered and marked as the scorecard\'s', () => {
  const byPlayer = {
    p1: [{ matchId: '11AJ', batting: { runs: 223, balls: 133, out: true } }],
  };
  const r = enrich(byPlayer, card, { slugs });
  assert.equal(r.notOuts, 1);
  assert.equal(byPlayer.p1[0].batting.out, false);
  // The provenance is what lets the average be computed at all.
  assert.equal(byPlayer.p1[0].batting.outFrom, 'scorecard');
  assert.equal(byPlayer.p1[0].batting.fours, 18);
});

test('balls bowled are recovered', () => {
  const byPlayer = { p2: [{ matchId: '11AJ', bowling: { wickets: 4, runs: 48 } }] };
  const r = enrich(byPlayer, card, { slugs });
  assert.equal(r.ballsAdded, 1);
  assert.equal(byPlayer.p2[0].bowling.balls, 60);
  assert.equal(byPlayer.p2[0].bowling.maidens, 1);
  assert.equal(byPlayer.p2[0].bowling.econ, 4.8);
});

test('a scorecard never creates an innings', () => {
  // The player page decides which innings exist: it is the only thing that knows the
  // tournament and the closing day. A row dropped as self-inconsistent must not
  // reappear here.
  const byPlayer = {};
  const r = enrich(byPlayer, card, { slugs });
  assert.deepEqual(byPlayer, {});
  assert.equal(r.rows, 0);
});

test('an innings from another match is untouched', () => {
  const byPlayer = { p1: [{ matchId: 'OTHER', batting: { runs: 10, balls: 8, out: true } }] };
  enrich(byPlayer, card, { slugs });
  assert.equal(byPlayer.p1[0].batting.outFrom, undefined);
  assert.equal(byPlayer.p1[0].batting.out, true);
});

test('a player with no pinned slug is skipped', () => {
  // Identity stays the pin file's contract; nothing is name-matched here.
  const byPlayer = { unknown: [{ matchId: '11AJ', batting: { runs: 223, balls: 133, out: true } }] };
  const r = enrich(byPlayer, card, { slugs });
  assert.equal(r.rows, 0);
  assert.equal(byPlayer.unknown[0].batting.outFrom, undefined);
});

test('the page\'s runs are never overwritten, and a disagreement is counted', () => {
  // The site shows the page's figure. Correcting it here would make the innings
  // table and the career totals disagree with nothing to explain why.
  const byPlayer = { p1: [{ matchId: '11AJ', batting: { runs: 220, balls: 133, out: true } }] };
  const r = enrich(byPlayer, card, { slugs });
  assert.equal(byPlayer.p1[0].batting.runs, 220);
  assert.equal(r.conflicts, 1);
});

test('an unreadable dismissal leaves the innings unknown', () => {
  // Suppressing the average is the right outcome; assuming "out" would flatter it.
  const vague = { matchId: 'M', batting: [{ slug: 'shubman-gill-O5', innings: 1, runs: 5, balls: 4, out: null }] };
  const byPlayer = { p1: [{ matchId: 'M', batting: { runs: 5, balls: 4, out: true } }] };
  const r = enrich(byPlayer, vague, { slugs });
  assert.equal(r.notOuts, 0);
  assert.equal(byPlayer.p1[0].batting.outFrom, undefined);
  assert.equal(needsScorecard(byPlayer.p1[0]), true);
});

test('re-running changes nothing', () => {
  const byPlayer = {
    p1: [{ matchId: '11AJ', batting: { runs: 223, balls: 133, out: true } }],
    p2: [{ matchId: '11AJ', bowling: { wickets: 4, runs: 48 } }],
  };
  enrich(byPlayer, card, { slugs });
  const after = JSON.parse(JSON.stringify(byPlayer));
  const second = enrich(byPlayer, card, { slugs });
  assert.equal(second.ballsAdded, 0, 'balls are not added twice');
  assert.deepEqual(byPlayer, after);
});
