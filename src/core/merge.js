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
 *   - where the same fixture arrives under different tournament names — a card that
 *     did not re-render cleanly — the name most players agree on wins
 */

/** Same innings? Same player, same day, same format. */
function key(r) {
  return `${r.playerId}|${r.date}|${r.format ?? ''}`;
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

  // A card click that does not re-render cleanly leaves the previous tournament's
  // innings on screen while the walk has moved on, so one match can arrive under
  // two or three competitions depending on whose page it came from. It is the same
  // event, so the name most players agree on wins.
  const votes = new Map();
  for (const r of merged.values()) {
    if (!r.date || !r.fixture || !r.competition) continue;
    const k = `${r.date}|${r.fixture}`;
    if (!votes.has(k)) votes.set(k, new Map());
    const tally = votes.get(k);
    tally.set(r.competition, (tally.get(r.competition) ?? 0) + 1);
  }
  for (const r of merged.values()) {
    if (!r.date || !r.fixture) continue;
    const tally = votes.get(`${r.date}|${r.fixture}`);
    if (!tally || tally.size < 2) continue;
    const winner = [...tally].sort((a, b) => b[1] - a[1])[0][0];
    if (winner !== r.competition) {
      r.competition = winner;
      r.competitionCorrected = true;
    }
  }

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

  // A multi-innings fixture ("2nd-Semi-Final Test, 1st Inn") names no opponent, so
  // the check above cannot see it is mislabelled. Those are resolved by date: if
  // another competition ran the same fixture on the same day and far more players
  // agree on it, the row belongs there. This is how a Duleep Trophy semi-final
  // filed under a Japan tour finds its way home.
  const byDayFixture = new Map();
  for (const r of merged.values()) {
    if (!r.date || !r.fixture || !r.competition) continue;
    const k = `${r.date}|${r.fixture}`;
    if (!byDayFixture.has(k)) byDayFixture.set(k, new Map());
    const t = byDayFixture.get(k);
    t.set(r.competition, (t.get(r.competition) ?? 0) + 1);
  }
  const dayTotals = new Map();
  for (const r of merged.values()) {
    if (!r.date || !r.competition) continue;
    const k = `${r.date}|${r.competition}`;
    dayTotals.set(k, (dayTotals.get(k) ?? 0) + 1);
  }
  for (const r of merged.values()) {
    if (!r.date || !r.fixture) continue;
    // Only fixtures with no opponent clause; the rest are handled above.
    if (/\bvs\b/i.test(r.fixture)) continue;
    const mine = dayTotals.get(`${r.date}|${r.competition}`) ?? 0;
    if (mine > 2) continue; // well attested, leave it alone

    let best = null;
    for (const [comp, count] of byDayFixture.get(`${r.date}|${r.fixture}`) ?? []) {
      if (comp === r.competition) continue;
      if (!best || count > best[1]) best = [comp, count];
    }
    if (best && best[1] > mine) {
      r.competition = best[0];
      r.competitionCorrected = true;
    }
  }

  const rows = [...merged.values()]
    .filter((r) => !contradicts(r))
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
