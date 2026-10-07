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

test("a Test innings is matched on its figures, not its innings number", () => {
  // The two sources count innings differently. The scorecard numbers by *match*
  // innings, interleaving both sides (1,2,3,4); the player page numbers by the
  // batsman's own. Ishan Kishan's 16 is match innings 3 but his 1st, and his 39 is
  // match innings 1 but his 2nd — so matching on the number paired each with the
  // other's figures and wrote the wrong dismissal onto both.
  const cardRows = [
    { slug: 's', innings: 1, runs: 39, balls: 41, out: false },
    { slug: 's', innings: 3, runs: 16, balls: 27, out: true },
  ];
  assert.equal(pickInnings(cardRows, { slug: 's', innings: 1, batting: { runs: 16, balls: 27 } }).out, true);
  assert.equal(pickInnings(cardRows, { slug: 's', innings: 2, batting: { runs: 39, balls: 41 } }).out, false);
});

test('an innings the scorecard does not have is not substituted', () => {
  const cardRows = [
    { slug: 's', innings: 1, runs: 39, balls: 41, out: false },
    { slug: 's', innings: 3, runs: 16, balls: 27, out: true },
  ];
  assert.equal(pickInnings(cardRows, { slug: 's', innings: 2, batting: { runs: 70, balls: 50 } }), null);
});

test('a bowling spell is matched on wickets as well as runs', () => {
  // Two spells can concede the same runs; the wickets separate them, and balls
  // faced is not a figure a bowling row has.
  const cardRows = [
    { slug: 's', innings: 2, runs: 45, wickets: 1, balls: 69 },
    { slug: 's', innings: 4, runs: 45, wickets: 3, balls: 54 },
  ];
  assert.equal(pickInnings(cardRows, { slug: 's', innings: 1, bowling: { runs: 45, wickets: 3 } }, 'bowling').balls, 54);
});

test('two innings with identical figures are not a problem', () => {
  // Whichever it is, the fields taken from it are the same.
  const cardRows = [
    { slug: 's', innings: 1, runs: 0, balls: 3, out: true },
    { slug: 's', innings: 3, runs: 0, balls: 3, out: true },
  ];
  assert.equal(pickInnings(cardRows, { slug: 's', innings: 2, batting: { runs: 0, balls: 3 } }).out, true);
});

test('genuinely ambiguous rows are left alone', () => {
  // Same runs, different dismissals: taking either would be a guess, and a wrong
  // `out` corrupts an average with nothing downstream to reveal it.
  const cardRows = [
    { slug: 's', innings: 1, runs: 20, balls: 15, out: true },
    { slug: 's', innings: 3, runs: 20, balls: 18, out: false },
  ];
  assert.equal(pickInnings(cardRows, { slug: 's', innings: 1, batting: { runs: 20 } }), null);
});

test('a limited-overs innings needs no innings number', () => {
  const cardRows = [{ slug: 's', innings: 1, balls: 24, runs: 30, wickets: 1 }];
  assert.equal(pickInnings(cardRows, { slug: 's', batting: { runs: 30, balls: 24 } }).balls, 24);
});

test('an ambiguous match is refused rather than guessed', () => {
  const cardRows = [
    { slug: 's', innings: 1, runs: 40, balls: 60 },
    { slug: 's', innings: 2, runs: 25, balls: 36 },
  ];
  // Nothing in the stored row identifies which spell this is.
  assert.equal(pickInnings(cardRows, { slug: 's', bowling: {} }, 'bowling'), null);
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

test('the player of the match is recorded on his innings', () => {
  const byPlayer = { p1: [{ matchId: '11AJ', batting: { runs: 223, balls: 133, out: true } }] };
  const r = enrich(byPlayer, card, { slugs, potm: 'shubman-gill-O5' });
  assert.equal(r.awards, 1);
  assert.equal(byPlayer.p1[0].playerOfMatch, true);
});

test('nobody else gets the award', () => {
  const byPlayer = { p2: [{ matchId: '11AJ', bowling: { wickets: 4, runs: 48 } }] };
  enrich(byPlayer, card, { slugs, potm: 'shubman-gill-O5' });
  assert.equal(byPlayer.p2[0].playerOfMatch, undefined);
});

test('a match with no award named leaves every innings unmarked', () => {
  // Routine: a match still being played, a washout, most domestic fixtures.
  const byPlayer = { p1: [{ matchId: '11AJ', batting: { runs: 223, balls: 133, out: true } }] };
  const r = enrich(byPlayer, card, { slugs, potm: null });
  assert.equal(r.awards, 0);
  assert.equal(byPlayer.p1[0].playerOfMatch, undefined);
});

test('both innings of a Test carry the award', () => {
  // Either is the one a reader opens, so the match-level fact is stamped on both.
  const byPlayer = {
    p1: [
      { matchId: '11AJ', innings: 1, batting: { runs: 223, balls: 133, out: true } },
      { matchId: '11AJ', innings: 3, batting: { runs: 10, balls: 8, out: true } },
    ],
  };
  enrich(byPlayer, card, { slugs, potm: 'shubman-gill-O5' });
  assert.ok(byPlayer.p1.every((r) => r.playerOfMatch));
});

test('re-running does not double-count an award', () => {
  const byPlayer = { p1: [{ matchId: '11AJ', batting: { runs: 223, balls: 133, out: true } }] };
  enrich(byPlayer, card, { slugs, potm: 'shubman-gill-O5' });
  assert.equal(enrich(byPlayer, card, { slugs, potm: 'shubman-gill-O5' }).awards, 0);
});
