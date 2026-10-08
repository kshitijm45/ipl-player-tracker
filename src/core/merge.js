/**
 * Assemble the innings CREX gives us.
 *
 * CREX is the single source, and what it prints is what the site shows. Nothing
 * here renames a competition, expands a team code, or works out an opponent the
 * scorecard did not state.
 *
 * That rule exists because every transformation tried here was wrong in a way that
 * was hard to see: "IND vs ENG 2026" was rewritten as "England in India" when India
 * were the tourists, a fixture with no "vs" clause had an opponent invented for it
 * from the tournament name, and a team code expanded into a club that was not
 * playing. Passing the source through unchanged is both simpler and correct.
 *
 * Two things are still done, because they concern which rows exist rather than what
 * they say:
 *   - a match still in progress is dropped; its figures are partial
 *   - a row whose fixture names an opponent its own competition never mentions is
 *     dropped as self-inconsistent, rather than being relabelled into something the
 *     page did not say
 */

/**
 * Same innings?
 *
 * The fixture has to be part of this. A Test gives a player two innings on the same
 * day, in the same format, printed as "70th Test, 1st Inn" and "70th Test, 2nd Inn";
 * keying on player, date and format alone made them collide, and the second silently
 * replaced the first. Mahipal Lomror lost three of his seven County Championship
 * innings that way, and every multi-innings match in the data was halved.
 */
function key(r) {
  return `${r.playerId}|${r.date}|${r.format ?? ''}|${r.fixture ?? ''}`;
}

export function mergePerformances({ crexRows = [], cricsheetRows = [], today, from } = {}) {
  const merged = new Map();
  const cutoff = today ?? new Date().toISOString().slice(0, 10);

  // A tournament labelled "2026" whose month has not happened yet is really the
  // late-2025 edition carrying the season's closing year ("Punjab T20 2026" playing
  // in December). Shift those back a year rather than letting a future date sort to
  // the top of every "most recent" list.
  crexRows = crexRows.map((r) => {
    if (!r.date || r.date <= cutoff) return r;
    const shifted = `${+r.date.slice(0, 4) - 1}${r.date.slice(4)}`;
    return { ...r, date: shifted, dateInferred: true };
  });

  // Kept so the merge still works if a second source is ever added back.
  for (const r of cricsheetRows) merged.set(key(r), { ...r, sources: ['cricsheet'] });

  for (const c of crexRows) {
    const k = key(c);
    const existing = merged.get(k);

    if (!existing) {
      // The opponent is read from the fixture CREX printed ("3rd T20 vs SL") and
      // nowhere else. A fixture that names no opponent — "54th Test, 1st Inn" — has
      // none recorded, and the page says so rather than guessing one.
      const opponent =
        c.opponent ?? c.fixture?.match(/\bvs\s+([A-Za-z0-9 .'-]+)$/i)?.[1]?.trim() ?? null;

      merged.set(k, { ...c, opposition: c.opposition ?? opponent, sources: ['crex'] });
      continue;
    }

    merged.set(k, {
      ...existing,
      batting: existing.batting ?? c.batting,
      bowling: existing.bowling ?? c.bowling,
      // A source may contribute the same innings twice (batting and bowling are
      // separate views of one row), so keep the list distinct.
      sources: [...new Set([...existing.sources, 'crex'])],
    });
  }

  // Nothing here second-guesses which tournament a row belongs to.
  //
  // Earlier versions did: a majority vote across players rewrote a competition when
  // the same date and fixture string turned up under two names, and a companion rule
  // moved multi-innings rows by date. Both were repairs for the old scrape, which read
  // a stale panel after a card click and stamped the wrong label onto real rows.
  //
  // The card walk reads each row under the series card it belongs to, so the label is
  // CREX's own. The vote is now actively harmful, because fixture strings are generic:
  // "1st Test, 2nd Inn" on 25 June belongs to IND-A vs SL-A for one player and SL vs
  // WI for another, and whichever name had more players would have swallowed the other,
  // crediting a player with an appearance in a tournament he never played.
  //
  // `contradicts` below stays: it only drops a row whose own fixture names an opponent
  // its competition never mentions, which is a self-inconsistent row rather than a guess.

  // A card click that has not re-rendered yet leaves the previous tournament's
  // innings on screen, and the walk stamps the new card's label onto them. Where
  // the fixture names an opponent the competition does not mention at all, the
  // label is provably not this match's — "IND vs JPN" carrying "1st T20 vs AFG",
  // or a Duleep Trophy semi-final filed under a Japan tour.
  const contradicts = (r) => {
    const comp = r.competition ?? '';
    const opponent = (r.fixture ?? '').match(/\bvs\s+([A-Za-z-]{2,4})$/i)?.[1];
    if (!opponent) return false;
    const codes = comp.match(/\b[A-Z]{2,4}(?:-[AB])?\b/g) ?? [];
    if (codes.length < 2) return false;
    return !codes.some((c) => c.toUpperCase() === opponent.toUpperCase());
  };

  // The same check, for a fixture that names no opponent.
  //
  // `contradicts` can only speak when the fixture carries a "vs XX" clause, and a
  // multi-day one does not — "2nd Test, 1st Inn" names nobody. That is exactly where
  // the mislabel lands, because the window guess has least to go on: Jack Edwards's
  // Sheffield Shield innings for New South Wales was filed under "AUS vs SA 2026",
  // whose card happened to span the date, and the page showed a domestic match as an
  // international one.
  //
  // The match URL settles it. CREX builds it from the sides and the competition
  // ("nsw-vs-tas-2nd-match-sheffield-shield-2026-27"), so a bilateral series whose
  // own two codes appear nowhere in the fixture's URL is not the series this match
  // belongs to. Only bilateral labels are checked, since they are the only ones that
  // name their sides; a tournament ("CSA T20 2026") says nothing about who played and
  // cannot be contradicted this way.
  const urlContradicts = (r) => {
    const m = String(r.competition ?? '').match(/^([A-Z]{2,4}(?:-[AB])?)\s+vs\s+([A-Z]{2,4}(?:-[AB])?)/);
    if (!m) return false;
    const slug = String(r.matchUrl ?? '').match(/\/cricket-live-score\/(.+?)-match-updates-/)?.[1];
    if (!slug) return false;
    const sides = slug.split('-match-')[0].split('-vs-').map((x) => x.toLowerCase());
    if (sides.length < 2) return false;
    const codes = [m[1], m[2]].map((c) => c.toLowerCase());
    return !codes.some((c) => sides.some((s) => s === c || s.startsWith(c)));
  };

  const rows = [...merged.values()]
    .filter((r) => !contradicts(r) && !urlContradicts(r))
    .filter((r) => !from || !r.date || r.date >= from);
  return rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

/** Summary for the build log and the site footer. */
export function mergeStats(rows) {
  const s = { total: rows.length, crexOnly: 0, cricsheetOnly: 0, both: 0 };
  for (const r of rows) {
    const n = r.sources?.length ?? 0;
    if (n > 1) s.both++;
    else if (r.sources?.[0] === 'crex') s.crexOnly++;
    else s.cricsheetOnly++;
  }
  return s;
}
