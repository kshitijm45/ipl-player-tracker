/**
 * Scorecard parsing: the two fields the player page cannot give.
 *
 * Every figure pinned here was read off a real CREX page and checked against the
 * site's own printed numbers. The markup fixtures below are trimmed from those pages
 * rather than invented, because each of the three traps they cover produced data that
 * looked plausible: a batting table parsed as bowling (three maidens, economy 94), a
 * fall-of-wickets block counted as an innings, and "11.3" overs read as 11.5.
 *
 * Run: node --test src/sources/crex-scorecard.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ballsFromOvers,
  readDismissal,
  parseScorecard,
  scorecardUrl,
  mergeInnings,
} from './crex-scorecard.js';

test('overs are overs-and-balls, not a decimal', () => {
  assert.equal(ballsFromOvers('10.0'), 60);
  // Eleven overs and three balls is 69, not 11.5 overs. Reading the fraction as a
  // decimal understates long spells and corrupts every economy derived from it.
  assert.equal(ballsFromOvers('11.3'), 69);
  assert.equal(ballsFromOvers('4'), 24);
  assert.equal(ballsFromOvers('0.1'), 1);
});

test('a figure that is not an over count reports nothing', () => {
  assert.equal(ballsFromOvers(''), null);
  assert.equal(ballsFromOvers(undefined), null);
  assert.equal(ballsFromOvers('-'), null);
  // A seventh ball in an over is not something a scorecard prints, so the figure is
  // not what this assumes it is.
  assert.equal(ballsFromOvers('3.7'), null);
});

test('a not-out is read as not out', () => {
  // The field the whole batting average turns on. Gill's 223* was stored as a
  // dismissal and his average read 70.00 instead of 86.15.
  assert.equal(readDismissal('NOT OUT'), false);
  assert.equal(readDismissal(' not out '), false);
});

test('a dismissal is read as out', () => {
  assert.equal(readDismissal('c Rutherford b Joseph'), true);
  assert.equal(readDismissal('lbw b Seales'), true);
  assert.equal(readDismissal('run out (Pooran)'), true);
  assert.equal(readDismissal('st Pooran b Chase'), true);
  assert.equal(readDismissal('b Shepherd'), true);
});

test('retirements are only a dismissal when they say so', () => {
  assert.equal(readDismissal('retired hurt'), false);
  assert.equal(readDismissal('retired not out'), false);
  assert.equal(readDismissal('retired out'), true);
  // Bare "retired" is genuinely ambiguous, and a wrong guess corrupts an average
  // with nothing downstream to reveal it.
  assert.equal(readDismissal('retired'), null);
});

test('an unreadable dismissal is unknown rather than assumed out', () => {
  assert.equal(readDismissal(''), null);
  assert.equal(readDismissal(null), null);
  assert.equal(readDismissal('—'), null);
});

/* ── markup fixtures ──
   Trimmed from the real pages. Note that both tables carry class="bowler-table":
   that is CREX's own markup, not a transcription slip, and it is the reason the
   parser keys on the header row instead. */

const battingTable = `
<table class="bowler-table"><thead><tr>
  <th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th>
</tr></thead><tbody>
  <tr>
    <td><div class="batsman-name"><a href="/player/rohit-sharma-2X">Rohit Sharma</a></div>
        <div class="decision"> lbw b Seales </div></td>
    <td><div class="run-highlight">101</div></td><td><div>75</div></td>
    <td><div>9</div></td><td><div>6</div></td><td><div>134.67</div></td>
  </tr>
  <tr>
    <td><div class="batsman-name"><a href="/player/shubman-gill-O5">Shubman Gill</a></div>
        <div class="decision"> NOT OUT </div></td>
    <td><div class="run-highlight">223</div></td><td><div>133</div></td>
    <td><div>18</div></td><td><div>14</div></td><td><div>167.67</div></td>
  </tr>
</tbody></table>`;

const bowlingTable = `
<table class="bowler-table"><thead><tr>
  <th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>ER</th>
</tr></thead><tbody>
  <tr>
    <td><div class="batsman-name"><a href="/player/saurabh-dubey-62M">Saurabh Dubey</a></div></td>
    <td><div>10.0</div></td><td><div>1</div></td>
    <td><div>48</div></td><td><div>4</div></td><td><div>4.80</div></td>
  </tr>
  <tr>
    <td><div class="batsman-name"><a href="/player/saransh-jain-5SB">Saransh Jain</a></div></td>
    <td><div>11.3</div></td><td><div>1</div></td>
    <td><div>45</div></td><td><div>1</div></td><td><div>3.91</div></td>
  </tr>
</tbody></table>`;

/** The fall-of-wickets block, which is not an innings. */
const fallOfWickets = `
<table class="bowler-table"><thead><tr>
  <th>Batter</th><th>Score</th><th>Balls</th>
</tr></thead><tbody>
  <tr><td><a href="/player/rohit-sharma-2X">Rohit Sharma</a></td>
      <td><div>101</div></td><td><div>75</div></td></tr>
</tbody></table>`;

test('a batting table yields batting rows, with the dismissal', () => {
  const r = parseScorecard(battingTable);
  assert.equal(r.bowling.length, 0);
  assert.deepEqual(r.batting[0], {
    slug: 'rohit-sharma-2X', innings: 1, runs: 101, balls: 75,
    fours: 9, sixes: 6, strikeRate: 134.67, out: true,
  });
  assert.equal(r.batting[1].out, false, 'Gill was not out');
});

test('a bowling table yields balls bowled', () => {
  const r = parseScorecard(bowlingTable);
  assert.equal(r.batting.length, 0);
  assert.deepEqual(r.bowling[0], {
    slug: 'saurabh-dubey-62M', innings: 1, balls: 60,
    maidens: 1, runs: 48, wickets: 4, econ: 4.8,
  });
  assert.equal(r.bowling[1].balls, 69, '11.3 overs is 69 balls');
});

test("CREX's own economy reconciles against the balls parsed", () => {
  // The independent check that the overs conversion is right: if balls were wrong,
  // runs/(balls/6) would not reproduce the figure CREX prints.
  for (const b of parseScorecard(bowlingTable).bowling) {
    assert.ok(
      Math.abs(b.runs / (b.balls / 6) - b.econ) < 0.06,
      `${b.slug}: ${b.runs}/(${b.balls}/6) should be ~${b.econ}`
    );
  }
});

test('a batting table is not parsed as a bowling one', () => {
  // Both tables carry class="bowler-table". Keying on the class gave Rohit three
  // maidens and an economy of 94 — nonsense that still looked like data.
  const r = parseScorecard(battingTable);
  assert.equal(r.bowling.length, 0);
  assert.equal(r.batting.length, 2);
});

test('the fall-of-wickets block is not an innings', () => {
  // It heads "Batter | Score | Balls" with no SR column, and counting it would
  // double every batsman's innings and halve his average.
  assert.equal(parseScorecard(fallOfWickets).batting.length, 0);
});

test('innings are numbered per discipline, in table order', () => {
  const r = parseScorecard(battingTable + bowlingTable + battingTable + bowlingTable);
  assert.deepEqual(r.batting.map((b) => b.innings), [1, 1, 2, 2]);
  assert.deepEqual(r.bowling.map((b) => b.innings), [1, 1, 2, 2]);
});

test('The Hundred heads its bowling column B, and it is balls', () => {
  // 100 balls a side, five-ball overs: CREX heads the column "B", the same letter
  // the batting table uses for balls faced.
  const hundred = `
    <table class="bowler-table"><thead><tr>
      <th>Bowler</th><th>B</th><th>M</th><th>R</th><th>W</th><th>ER</th>
    </tr></thead><tbody>
      <tr><td><a href="/player/trent-boult-9M">Trent Boult</a></td>
          <td><div>20</div></td><td><div>0</div></td>
          <td><div>42</div></td><td><div>1</div></td><td><div>10.50</div></td></tr>
    </tbody></table>`;
  const b = parseScorecard(hundred).bowling[0];
  assert.equal(b.balls, 20, 'twenty balls, not twenty overs');
  assert.equal(b.wickets, 1);
  assert.equal(b.runs, 42);
});

test('a row with no player link is skipped', () => {
  // Extras and totals sit in the same tbody and carry no /player/ link.
  const withTotal = bowlingTable.replace(
    '</tbody>',
    '<tr><td><div>Extras</div></td><td><div>5</div></td><td><div>0</div></td>' +
      '<td><div>0</div></td><td><div>0</div></td><td><div>0</div></td></tr></tbody>'
  );
  assert.equal(parseScorecard(withTotal).bowling.length, 2);
});

test('html with no scorecard tables yields nothing', () => {
  // What the short /scoreboard/<id>/ URL actually returns: a five-player "top
  // performers" block and no scorecard table at all.
  assert.deepEqual(parseScorecard('<div>no tables here</div>'), { batting: [], bowling: [] });
  assert.deepEqual(parseScorecard(''), { batting: [], bowling: [] });
});

test('the scorecard url is built from a relative href', () => {
  assert.equal(
    scorecardUrl({ matchUrl: '/cricket-live-score/a-vs-b-match-updates-12WJ' }),
    'https://crex.com/cricket-live-score/a-vs-b-match-updates-12WJ/match-scorecard'
  );
});

test('a url already ending in match-scorecard is not doubled', () => {
  assert.equal(
    scorecardUrl({ matchUrl: 'https://crex.com/cricket-live-score/x-12WJ/match-scorecard' }),
    'https://crex.com/cricket-live-score/x-12WJ/match-scorecard'
  );
});

test('no match url means there is nothing to build from', () => {
  assert.equal(scorecardUrl({}), null);
});

/* ── merging innings across toggle clicks ──
   The scorecard renders one innings at a time and each click re-renders the tables
   numbered from 1, so the innings numbers collide between views. These pin the two
   things that can go wrong: innings silently dropped, and a view that had not
   re-rendered yet being stored as a real second innings. */

test('two views become two innings, renumbered in the order seen', () => {
  const wi = { batting: [{ slug: 'shai-hope-FL', innings: 1, runs: 162, balls: 143, out: false }] };
  const ind = { batting: [{ slug: 'kl-rahul-AK', innings: 1, runs: 129, balls: 87, out: false }] };
  const m = mergeInnings([wi, ind]);
  assert.equal(m.batting.length, 2);
  assert.deepEqual(m.batting.map((b) => b.innings), [1, 2]);
  assert.equal(m.batting[1].slug, 'kl-rahul-AK');
});

test('a view that has not re-rendered is not stored twice', () => {
  // The same trap as the player page's series cards: a click that lands before the
  // panel swaps leaves the previous innings on screen.
  const view = { batting: [{ slug: 'shai-hope-FL', innings: 1, runs: 162, balls: 143, out: false }] };
  const m = mergeInnings([view, { ...view }]);
  assert.equal(m.batting.length, 1);
  assert.equal(m.batting[0].innings, 1);
});

test('several innings within one view keep their order', () => {
  // A Test renders more than one innings per side.
  const view = {
    bowling: [
      { slug: 'a', innings: 2, runs: 20, wickets: 1, balls: 36 },
      { slug: 'a', innings: 1, runs: 45, wickets: 2, balls: 60 },
    ],
  };
  const m = mergeInnings([view]);
  assert.deepEqual(m.bowling.map((b) => b.runs), [45, 20]);
  assert.deepEqual(m.bowling.map((b) => b.innings), [1, 2]);
});

test('batting and bowling are numbered independently', () => {
  const a = {
    batting: [{ slug: 'x', innings: 1, runs: 10, balls: 8, out: true }],
    bowling: [{ slug: 'y', innings: 1, runs: 30, wickets: 1, balls: 24 }],
  };
  const b = {
    batting: [{ slug: 'y', innings: 1, runs: 40, balls: 30, out: false }],
    bowling: [{ slug: 'x', innings: 1, runs: 20, wickets: 2, balls: 24 }],
  };
  const m = mergeInnings([a, b]);
  assert.deepEqual(m.batting.map((r) => r.innings), [1, 2]);
  assert.deepEqual(m.bowling.map((r) => r.innings), [1, 2]);
});

test('an empty view contributes nothing', () => {
  const m = mergeInnings([{ batting: [], bowling: [] }, null, undefined]);
  assert.deepEqual(m, { batting: [], bowling: [] });
});
