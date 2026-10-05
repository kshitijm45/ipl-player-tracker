/**
 * Fold a scorecard into the innings the player page already gave us.
 *
 * The player page is the source for everything the site already shows. Two fields it
 * cannot carry are the reason this exists:
 *
 *   - `bowling.balls` — balls bowled, which the page never prints
 *   - `batting.out`   — the dismissal, which the page drops the asterisk for
 *
 * The scorecard also carries maidens, its own economy figure, and fours and sixes, and
 * those are kept where the page had nothing — they cost no extra request and they are
 * the detail a player page simply does not break out. They are only ever filled in,
 * never used to replace a figure the page gave.
 *
 * Runs, wickets, the tournament, the format and the date all stay the page's.
 *
 * So this adds fields and never creates or deletes rows. A scorecard naming a player
 * with no stored innings is not a reason to invent one — he may have played before
 * the tracked window, or the row may have been dropped as self-inconsistent, and
 * adding it here would bypass every rule that kept it out.
 *
 * It also never overwrites a figure the player page gave. Where the two disagree on
 * runs or wickets, the disagreement is recorded rather than resolved: the page's
 * figure is what the rest of the site shows, and a silent correction here would make
 * the innings table and the career totals say different things with nothing to
 * explain why.
 */

/** Does this innings still need something only a scorecard can give? */
export function needsScorecard(row) {
  if (!row) return false;
  // A bowling innings with no balls has no economy and no strike rate.
  if (row.bowling && row.bowling.balls == null) return true;
  // A batting innings whose dismissal did not come from a scorecard has no average.
  if (row.batting && row.batting.outFrom !== 'scorecard') return true;
  return false;
}

/**
 * Which matches to read, newest first.
 *
 * Newest first because that is where a reader looks, so an interrupted run has
 * already covered what matters most. A match is skipped once every one of its stored
 * innings is enriched, which is what makes the backfill resumable.
 *
 * `matchUrl` is carried where the scrape recorded it: it saves the extra request that
 * resolving a bare id costs, and the innings scraped before the href was kept are
 * exactly the ones that still need it.
 */
export function matchesToBackfill(byPlayer, { force = false } = {}) {
  const byMatch = new Map();
  for (const rows of Object.values(byPlayer ?? {})) {
    for (const r of rows ?? []) {
      if (!r?.matchId) continue;
      if (!force && !needsScorecard(r)) continue;
      const m = byMatch.get(r.matchId) ?? { matchId: r.matchId, matchUrl: null, date: null };
      m.matchUrl ??= r.matchUrl ?? null;
      if (!m.date || (r.date && r.date > m.date)) m.date = r.date;
      byMatch.set(r.matchId, m);
    }
  }
  return [...byMatch.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

/**
 * Pick the scorecard row for one stored innings.
 *
 * Keyed on innings number where the stored row has one, because a Test gives a player
 * two innings in the same match and taking the first would file his second-innings
 * figures against his first. Where the stored row has no innings number — every
 * limited-overs match — there is only one innings per player per discipline, so the
 * single row for that slug is unambiguous.
 *
 * Returns null when the match has several candidates and nothing distinguishes them,
 * rather than guessing at one.
 */
export function pickInnings(cardRows, row) {
  const mine = cardRows.filter((c) => c.slug === row.slug);
  if (!mine.length) return null;
  if (row.innings != null) {
    return mine.find((c) => c.innings === row.innings) ?? null;
  }
  return mine.length === 1 ? mine[0] : null;
}

/**
 * Apply a scorecard to every stored innings of that match.
 *
 * Returns what changed, so the caller can report it: the point of the run is the
 * not-outs and the balls recovered, and a count of "innings touched" alone would not
 * say whether it worked.
 */
export function enrich(byPlayer, card, { matchId, slugs = new Map() } = {}) {
  const id = matchId ?? card?.matchId;
  let rows = 0;
  let notOuts = 0;
  let ballsAdded = 0;
  let conflicts = 0;

  for (const [playerId, playerRows] of Object.entries(byPlayer ?? {})) {
    const slug = slugs.get?.(playerId) ?? slugs[playerId];
    if (!slug) continue;

    for (const row of playerRows ?? []) {
      if (row.matchId !== id) continue;
      let touched = false;

      if (row.bowling) {
        const b = pickInnings(card.bowling ?? [], { ...row, slug });
        if (b && b.balls != null) {
          if (row.bowling.balls == null) {
            row.bowling.balls = b.balls;
            ballsAdded++;
          }
          if (b.maidens != null) row.bowling.maidens ??= b.maidens;
          // CREX's own printed economy. The site computes its own from summed balls;
          // this is what would reconcile the two if they ever diverged.
          if (b.econ != null) row.bowling.econ ??= b.econ;
          // Runs and wickets stay the player page's. Where the two disagree the
          // disagreement is counted, not resolved: the page's figure is what the
          // innings table shows, and silently correcting it here would make that
          // table and the career totals differ with nothing to explain why.
          if (b.runs != null && b.runs !== row.bowling.runs) conflicts++;
          row.bowling.from ??= 'scorecard';
          touched = true;
        }
      }

      if (row.batting) {
        const b = pickInnings(card.batting ?? [], { ...row, slug });
        // Only a dismissal the scorecard actually stated counts. An unreadable
        // `.decision` cell leaves the innings unknown, which suppresses the average
        // rather than flattering it.
        if (b && b.out != null) {
          row.batting.out = b.out;
          row.batting.outFrom = 'scorecard';
          if (b.out === false) notOuts++;
          if (b.fours != null) row.batting.fours ??= b.fours;
          if (b.sixes != null) row.batting.sixes ??= b.sixes;
          if (b.runs != null && b.runs !== row.batting.runs) conflicts++;
          touched = true;
        }
      }

      if (touched) {
        rows++;
        row.scorecardAt = new Date().toISOString().slice(0, 10);
      }
    }
  }

  return { rows, notOuts, ballsAdded, conflicts };
}
