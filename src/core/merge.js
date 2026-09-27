/**
 * Merging CREX and Cricsheet innings.
 *
 * CREX leads: it is fresher (it carried the 19 Sep England–Sri Lanka T20 while
 * Cricsheet stopped at 17 Sep), it covers domestic tournaments no free dataset has
 * (UP T20, MP T20, Mumbai T20, Duleep Trophy, MLC, CPL), and it names players the way
 * fans do. Cricsheet fills in behind it: ball-by-ball precision, full fielding
 * figures, and every player CREX has no slug for.
 *
 * The two describe the same innings differently, so a match is keyed on
 * (playerId, date, format) rather than on competition or opponent names, which
 * disagree between sources ("IPL 2026" vs "Indian Premier League", "RR" vs
 * "Rajasthan Royals"). Where both have an innings, CREX's identity fields win and
 * Cricsheet's richer figures are kept.
 */

/** Same innings? Same player, same day, same format. */
function key(r) {
  return `${r.playerId}|${r.date}|${r.format ?? ''}`;
}

/**
 * Expand a short team code against the full names Cricsheet uses, so a merged row
 * does not show "RR" where the rest of the site says "Rajasthan Royals".
 */
const CODE_TO_TEAM = {
  CSK: 'Chennai Super Kings', DC: 'Delhi Capitals', GT: 'Gujarat Titans',
  KKR: 'Kolkata Knight Riders', LSG: 'Lucknow Super Giants', MI: 'Mumbai Indians',
  PBKS: 'Punjab Kings', RR: 'Rajasthan Royals', RCB: 'Royal Challengers Bengaluru',
  SRH: 'Sunrisers Hyderabad',
};

/** CREX competition labels are abbreviated; prefer Cricsheet's full name when both exist. */
function preferName(crexName, cricsheetName) {
  return cricsheetName ?? crexName ?? null;
}

/** Country codes CREX uses in fixture strings and tournament labels. */
const NATION = {
  IND: 'India', AUS: 'Australia', ENG: 'England', SA: 'South Africa', NZ: 'New Zealand',
  PAK: 'Pakistan', SL: 'Sri Lanka', WI: 'West Indies', BAN: 'Bangladesh', AFG: 'Afghanistan',
  ZIM: 'Zimbabwe', IRE: 'Ireland', SCO: 'Scotland', NED: 'Netherlands', NAM: 'Namibia',
  UAE: 'United Arab Emirates', NEP: 'Nepal', OMA: 'Oman', USA: 'United States', CAN: 'Canada',
};

/**
 * "AUS vs ZIM 2026" is how CREX labels a bilateral series, which reads as a code
 * rather than a fixture once it reaches the page. Expand the countries and turn the
 * label into the tour phrasing the rest of the site uses.
 */
export function expandCompetition(label) {
  if (!label) return label;
  const m = String(label).match(/^([A-Z]{2,4})\s+vs\s+([A-Z]{2,4})\s*(\d{4}(?:-\d{2})?)?$/);
  if (!m) return label;
  const [, a, b, year] = m;
  const A = NATION[a] ?? a;
  const B = NATION[b] ?? b;
  return `${B} in ${A}${year ? ` ${year}` : ''}`;
}

/** Expand a team code, leaving anything already spelled out untouched. */
export function expandTeam(code) {
  if (!code) return code;
  return CODE_TO_TEAM[code] ?? NATION[code] ?? code;
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

  // Cricsheet no longer supplies innings; the parameter stays so the merge keeps
  // working if a second source is ever added back.
  for (const r of cricsheetRows) merged.set(key(r), { ...r, sources: ['cricsheet'] });

  for (const c of crexRows) {
    const k = key(c);
    const existing = merged.get(k);

    if (!existing) {
      // CREX carries the opponent inside the fixture string ("3rd T20 vs SL") rather
      // than as its own field, so recover it there before the row reaches the page —
      // otherwise every CREX-only row reads "AUS v —".
      const opp = c.opponent ?? c.fixture?.match(/\bvs\s+([A-Za-z ]+)$/i)?.[1]?.trim() ?? null;

      merged.set(k, {
        ...c,
        team: expandTeam(c.team),
        opposition: expandTeam(c.opposition ?? opp),
        competition: expandCompetition(c.competition),
        sources: ['crex'],
        // A CREX-only row has no ball-by-ball backing, so mark it: the UI can then
        // avoid implying a precision the row does not have.
        approximate: true,
      });
      continue;
    }

    merged.set(k, {
      ...existing,
      // Cricsheet's aggregation is derived from deliveries, so it is kept where present.
      batting: existing.batting ?? c.batting,
      bowling: existing.bowling ?? c.bowling,
      competition: preferName(c.competition, existing.competition),
      sources: [...existing.sources, 'crex'],
    });
  }

  // CREX player pages reach back over past seasons. This is a current-season
  // tracker, so anything before the season start is dropped rather than shown
  // alongside this year's form.
  const rows = from
    ? [...merged.values()].filter((r) => !r.date || r.date >= from)
    : [...merged.values()];

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
