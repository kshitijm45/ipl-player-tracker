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
  // Enriched before the award was ever read, so the match was never asked who won it.
  //
  // Without this the gap is permanent rather than temporary: 706 matches were marked
  // complete by runs that predate player-of-the-match, and a complete row never
  // re-enters the queue. Shreyas Iyer's 102 off 43 won him the match and would have
  // stayed unbadged for good, on the same page as David Miller's badged 142 — and an
  // absent badge would mean "never checked" for some matches and "did not win" for
  // others, with nothing to tell them apart.
  if (row.scorecardAt && !row.awardChecked) return true;
  // Read while the match was still being played, so every figure in it can still
  // change. A batsman shown "Batting" is genuinely not out *at that moment*, and
  // recording it is right — but he may be dismissed tomorrow, and marking the row
  // complete would freeze Pat Cummins at 33* for good. The flag is cleared once the
  // match is read again after it has finished.
  if (row.scorecardLive) return true;
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
export function matchesToBackfill(byPlayer, { force = false, repair = false } = {}) {
  const byMatch = new Map();
  // Matches where one player has more than one innings. These were enriched by
  // matching on the innings number, which the two sources count differently, so a
  // Test innings could be paired with the wrong scorecard row — and `needsScorecard`
  // sees them as done, so they would never be re-read without this.
  const multi = repair ? multiInningsMatches(byPlayer) : null;
  for (const rows of Object.values(byPlayer ?? {})) {
    for (const r of rows ?? []) {
      if (!r?.matchId) continue;
      const mustRepair = repair && multi.has(r.matchId);
      if (!force && !mustRepair && !needsScorecard(r)) continue;
      const m = byMatch.get(r.matchId) ?? { matchId: r.matchId, matchUrl: null, date: null };
      m.matchUrl ??= r.matchUrl ?? null;
      if (!m.date || (r.date && r.date > m.date)) m.date = r.date;
      byMatch.set(r.matchId, m);
    }
  }
  return [...byMatch.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}


/** Matches where some player has more than one innings — Tests, and nothing else. */
function multiInningsMatches(byPlayer) {
  const out = new Set();
  for (const rows of Object.values(byPlayer ?? {})) {
    const seen = new Map();
    for (const r of rows ?? []) {
      if (!r?.matchId || r.innings == null) continue;
      const n = (seen.get(r.matchId) ?? 0) + 1;
      seen.set(r.matchId, n);
      if (n > 1) out.add(r.matchId);
    }
  }
  return out;
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
export function pickInnings(cardRows, row, kind = 'batting') {
  const mine = cardRows.filter((c) => c.slug === row.slug);
  if (!mine.length) return null;
  if (mine.length === 1) return mine[0];

  // Several innings for one player in one match, so they have to be told apart —
  // and the innings number cannot do it, because the two sources count differently.
  // The scorecard numbers by *match* innings, interleaving both sides (1,2,3,4),
  // while the player page numbers by the batsman's own (his 1st, his 2nd). Ishan
  // Kishan's 16 is match innings 3 but his 1st; his 39 is match innings 1 but his
  // 2nd. Matching on the number paired each with the other's figures and wrote the
  // wrong dismissal onto both — 124 of 192 multi-innings matches had the signature.
  //
  // The figures identify the innings unambiguously: runs off balls is what a
  // scorecard and a player page agree on, being the same innings printed twice.
  const stored = row[kind] ?? {};
  const exact = mine.filter(
    (c) => c.runs === stored.runs && (c.balls == null || stored.balls == null || c.balls === stored.balls)
  );
  if (exact.length === 1) return exact[0];

  // Runs alone, where balls differ or are absent — a bowling row has no balls faced
  // to compare, and its wickets are the distinguishing figure instead.
  const byFigure = mine.filter((c) =>
    kind === 'bowling'
      ? c.runs === stored.runs && c.wickets === stored.wickets
      : c.runs === stored.runs
  );
  if (byFigure.length === 1) return byFigure[0];

  // Two innings with identical figures: whichever it is, the fields taken from it
  // are the same, so the ambiguity does not matter. Anything else is unresolved and
  // is left alone rather than guessed at.
  if (byFigure.length > 1) {
    const [first] = byFigure;
    const same = byFigure.every(
      (c) => c.out === first.out && c.balls === first.balls && c.wickets === first.wickets
    );
    return same ? first : null;
  }
  return null;
}

/**
 * Apply a scorecard to every stored innings of that match.
 *
 * Returns what changed, so the caller can report it: the point of the run is the
 * not-outs and the balls recovered, and a count of "innings touched" alone would not
 * say whether it worked.
 */
export function enrich(
  byPlayer,
  card,
  { matchId, slugs = new Map(), potm, awardLookedFor, live = false } = {}
) {
  // Whether the award was looked up at all, as opposed to looked up and not found.
  // A caller that passes `potm: null` tried and the match named nobody; one that
  // omits it did not try, and claiming otherwise would bury the award for good.
  const checked = awardLookedFor ?? potm !== undefined;
  const id = matchId ?? card?.matchId;
  let rows = 0;
  let notOuts = 0;
  let ballsAdded = 0;
  let conflicts = 0;
  let corrected = 0;
  let awards = 0;

  for (const [playerId, playerRows] of Object.entries(byPlayer ?? {})) {
    const slug = slugs.get?.(playerId) ?? slugs[playerId];
    if (!slug) continue;

    for (const row of playerRows ?? []) {
      if (row.matchId !== id) continue;
      let touched = false;

      if (row.bowling) {
        const b = pickInnings(card.bowling ?? [], { ...row, slug }, 'bowling');
        if (b && b.balls != null) {
          if (row.bowling.balls == null) {
            row.bowling.balls = b.balls;
            ballsAdded++;
          } else if (row.bowling.balls !== b.balls) {
            // Same cause as a wrong dismissal: the figures now identify the innings,
            // so a disagreement means the earlier pairing was wrong.
            row.bowling.balls = b.balls;
            corrected++;
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
        const b = pickInnings(card.batting ?? [], { ...row, slug }, 'batting');
        // Only a dismissal the scorecard actually stated counts. An unreadable
        // `.decision` cell leaves the innings unknown, which suppresses the average
        // rather than flattering it.
        if (b && b.out != null) {
          // Overwritten rather than filled in: an earlier run may have matched this
          // innings to the wrong scorecard row and written a confident, wrong `out`.
          if (row.batting.outFrom === 'scorecard' && row.batting.out !== b.out) corrected++;
          row.batting.out = b.out;
          row.batting.outFrom = 'scorecard';
          if (b.out === false) notOuts++;
          if (b.fours != null) row.batting.fours ??= b.fours;
          if (b.sixes != null) row.batting.sixes ??= b.sixes;
          if (b.runs != null && b.runs !== row.batting.runs) conflicts++;
          touched = true;
        }
      }

      // The award belongs to the match, so it is stamped on every innings that player
      // had in it — a Test gives him two, and either may be the one a reader opens.
      if (potm && slug === potm) {
        if (!row.playerOfMatch) awards++;
        row.playerOfMatch = true;
        touched = true;
      }
      // Recorded whether or not an award was found, because "checked and nobody was
      // named" and "never checked" have to be distinguishable — otherwise every match
      // without an award is re-read on every run, for ever.
      if (checked) {
        if (!row.awardChecked) touched = true;
        row.awardChecked = true;
      }

      if (touched) {
        rows++;
        row.scorecardAt = new Date().toISOString().slice(0, 10);
        // Whether what was just read can still change. A finished match never can, so
        // the row is done; an unfinished one is re-read until it settles.
        if (live) row.scorecardLive = true;
        else delete row.scorecardLive;
      }
    }
  }

  return { rows, notOuts, ballsAdded, conflicts, corrected, awards };
}
