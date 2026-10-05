/**
 * Career aggregates: batting and bowling, by tournament and totalled by format.
 *
 * Everything here is computed from the innings this project already scraped. CREX
 * publishes no career table to read instead — `/player/<slug>/stats` and `/career`
 * are both 404 — so the per-innings rows are the only aggregate-able source.
 *
 * Two rules the whole file turns on:
 *
 *   1. **Aggregate from summed totals, never by averaging per-match ratios.** The
 *      mean of each innings' strike rate is not the strike rate: it weights a 2-ball
 *      cameo the same as a 60-ball innings. So runs and balls are summed first and
 *      divided once, at the end.
 *
 *   2. **A figure that cannot be computed is absent, not zero.** An average of 0 and
 *      "has never been dismissed" are different facts, and a 0 economy reads as
 *      unplayably good rather than as missing. Every such field is left `null` and
 *      the page prints it as "–". This is the same discipline the rest of the project
 *      follows: nothing is inferred.
 */

/**
 * Was this innings a dismissal?
 *
 * This is the one field that cannot be trusted from the player page, and it decides
 * the batting average outright. The page's innings table does not print the not-out
 * asterisk — `td.textContent` simply has no `*` in it — so the scrape recorded every
 * one of 2,278 innings as a dismissal, which is statistically impossible. Shubman
 * Gill's 223* against the West Indies was stored as out; his average read 70.00
 * instead of 86.15.
 *
 * The scorecard states it outright ("NOT OUT" against the batter), so `out` is only
 * believed when it came from there — marked by `outFrom: 'scorecard'`. Anywhere else
 * it is unknown, and an unknown dismissal suppresses the average rather than
 * inflating it.
 */
export function dismissalKnown(inn) {
  return inn?.outFrom === 'scorecard';
}

/** Runs per over, except in The Hundred, where an over is not six balls. */
export function isBallBased(format) {
  return format === '100B';
}

const ratio = (num, den, digits = 2) =>
  den > 0 ? +(num / den).toFixed(digits) : null;

/**
 * Fold a batting innings into an accumulator.
 *
 * A row with no `batting` is not an innings — a player who did not bat has no
 * innings to his name, and counting a DNB would deflate every average on the page.
 */
function addBatting(acc, b) {
  acc.innings += 1;
  acc.runs += b.runs ?? 0;
  // Balls can legitimately be 0 — 15 innings in the current data face none — so the
  // count of innings that actually had balls is tracked separately from the sum.
  // Dividing by a 0 that came from real rows would be a strike rate of Infinity.
  acc.balls += b.balls ?? 0;
  if (b.runs != null) acc.best = Math.max(acc.best, b.runs);
  if (dismissalKnown(b)) {
    acc.dismissalsKnown += 1;
    if (b.out) acc.dismissals += 1;
    else acc.notOuts += 1;
  } else {
    acc.dismissalsUnknown += 1;
  }
}

/**
 * Fold a bowling innings into an accumulator.
 *
 * Balls bowled is the field the player page never carried; it comes from the
 * scorecard. Where it is missing there is no economy and no strike rate — and
 * crucially the runs conceded in that innings must be held back too, because a rate
 * built from all the runs but only some of the balls is worse than a missing one.
 * Summing 50 runs over the 36 balls that are known reports an economy of 8.33 for a
 * bowler who actually went at 5.
 *
 * So `runs`/`wickets` are the career figures, and `rateRuns`/`balls` are the subset
 * the rates are computed from.
 */
function addBowling(acc, b) {
  acc.innings += 1;
  acc.wickets += b.wickets ?? 0;
  acc.runs += b.runs ?? 0;
  if (b.balls != null) {
    acc.balls += b.balls;
    acc.rateRuns += b.runs ?? 0;
    acc.rateWickets += b.wickets ?? 0;
    acc.inningsWithBalls += 1;
  }
}

const emptyBatting = () => ({
  innings: 0, runs: 0, balls: 0, best: 0,
  dismissals: 0, notOuts: 0, dismissalsKnown: 0, dismissalsUnknown: 0,
});

const emptyBowling = () => ({
  innings: 0, wickets: 0, runs: 0,
  balls: 0, rateRuns: 0, rateWickets: 0, inningsWithBalls: 0,
});

/**
 * Close a batting accumulator into the figures the page shows.
 *
 * `average` is runs per **dismissal**, not per innings: a not-out contributes its
 * runs to the numerator and nothing to the denominator. It is reported only when
 * every innings' dismissal is known, because a single unknown makes the denominator
 * a guess — and the error runs one way, always flattering, since an unrecorded
 * not-out is counted as an out.
 */
export function finishBatting(acc, { format } = {}) {
  const complete = acc.dismissalsUnknown === 0;
  return {
    innings: acc.innings,
    runs: acc.runs,
    balls: acc.balls,
    notOuts: complete ? acc.notOuts : null,
    highScore: acc.innings ? acc.best : null,
    strikeRate: ratio(acc.runs * 100, acc.balls),
    // Never been dismissed is not an average of zero; it has no average at all.
    average: complete && acc.dismissals > 0 ? ratio(acc.runs, acc.dismissals) : null,
    // Why the average is missing, so the page can say so rather than show a bare dash.
    averagePending: complete ? false : true,
    format,
  };
}

/**
 * Close a bowling accumulator.
 *
 * Economy is runs per over everywhere except The Hundred, which is 100 balls a side
 * with a five-ball over — "per over" is not a unit there, and CREX's own printed
 * figure is per five balls. Recomputing it per six would silently disagree with the
 * source, so the ball-based competitions report runs per ball.
 *
 * Strike rate is balls per wicket and needs no special case: it is already ball-based.
 */
export function finishBowling(acc, { format } = {}) {
  const perBall = isBallBased(format);
  return {
    innings: acc.innings,
    wickets: acc.wickets,
    runs: acc.runs,
    balls: acc.balls,
    economy: perBall ? ratio(acc.rateRuns, acc.balls) : ratio(acc.rateRuns * 6, acc.balls),
    economyUnit: perBall ? 'ball' : 'over',
    // Balls per wicket, over the innings whose balls are known. A wicketless spell
    // has no strike rate, however long it was.
    strikeRate: acc.rateWickets > 0 ? ratio(acc.balls, acc.rateWickets) : null,
    // The rates cover only the innings whose balls are known, which is worth saying
    // when a backfill is still outstanding.
    ratesFrom: acc.inningsWithBalls,
    ratesPending: acc.inningsWithBalls < acc.innings,
    format,
  };
}

/**
 * Batting and bowling for one set of innings.
 *
 * `format` only affects the economy unit; it is passed in rather than read off the
 * rows because a total spanning several formats has no single unit.
 */
export function summarise(rows, { format } = {}) {
  const bat = emptyBatting();
  const bowl = emptyBowling();
  for (const r of rows) {
    if (r.batting) addBatting(bat, r.batting);
    if (r.bowling) addBowling(bowl, r.bowling);
  }
  return {
    batting: finishBatting(bat, { format }),
    bowling: finishBowling(bowl, { format }),
  };
}

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

/**
 * One player's career: a total per format, and within each format one row per
 * tournament.
 *
 * Nested this way round because a tournament belongs to exactly one format, while a
 * format spans many tournaments — and because "his T20 numbers" is the question a
 * reader asks first, with the tournament breakdown as the detail behind it.
 *
 * A combined all-formats total is deliberately not produced. Adding a Test innings
 * to a Hundred innings gives a number no scorecard agrees with, and an economy
 * mixing five-ball and six-ball overs is not a rate at all.
 */
export function careerFor(rows) {
  const byFormat = [];
  for (const [format, fmtRows] of groupBy(rows, (r) => r.format)) {
    const tournaments = [...groupBy(fmtRows, (r) => r.competition)]
      .map(([competition, compRows]) => ({
        competition,
        // Spans are what let the page order tournaments as a season reads.
        from: compRows.reduce((a, r) => (!a || r.date < a ? r.date : a), null),
        to: compRows.reduce((a, r) => (!a || r.date > a ? r.date : a), null),
        teams: [...new Set(compRows.map((r) => r.team).filter(Boolean))],
        ...summarise(compRows, { format }),
      }))
      .sort((a, b) => (b.to ?? '').localeCompare(a.to ?? ''));

    byFormat.push({
      format,
      tournaments,
      total: summarise(fmtRows, { format }),
      lastPlayed: tournaments[0]?.to ?? null,
    });
  }

  // Most recently played format first: what a reader wants is this week's cricket.
  return byFormat.sort((a, b) => (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? ''));
}

/** `careerFor` across every player, keyed by player id. */
export function careersByPlayer(performances) {
  const out = {};
  for (const [playerId, rows] of groupBy(performances, (r) => r.playerId)) {
    out[playerId] = careerFor(rows);
  }
  return out;
}
