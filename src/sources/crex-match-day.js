/**
 * Which calendar day is a multi-day match on, and what had each player done by then?
 *
 * CREX prints every innings of a Test under the match's *start* date. A Test that
 * began on 23 August puts all four innings on the 23rd, so a daily tracker shows 55
 * innings on one day and nothing for the four days that follow — which is the opposite
 * of what a day-by-day page is for.
 *
 * There is no per-innings date anywhere on CREX to fix that with. The scorecard was
 * checked for day, session, stumps and fall-of-wicket markers: it carries none. What
 * the *match* page carries, while the match is being played, is this:
 *
 *   <div class="day-session"><span>Day 3</span><span>-</span><span>Session 3</span></div>
 *
 * plus a JSON-LD SportsEvent with the match's `startDate`, `endDate` and status. That
 * is enough to date a day exactly: `startDate + (day - 1)`, verified against a live
 * Irani Cup Test where the page said Day 3, startDate was 1 October and the day was
 * the 3rd. It also detects a washed-out or rest day, which plain arithmetic on the
 * start date cannot — if the page says Day 3 but four days have passed, a day was
 * lost, and only the label knows.
 *
 * The catch, and the reason this module records rather than parses: once a match is
 * over the `day-session` element is gone. A finished Test carries no day information
 * at all. So a day's cricket has to be captured while it is happening, and history
 * cannot be rebuilt afterwards. Everything here is therefore written to a store that
 * accumulates, one row per (player, match, innings), holding the figure observed on
 * each day of play.
 *
 * What the site then shows is each innings **once**, on the day it ended, with the
 * figure CREX prints:
 *
 *   day 2 observed:  51* (60)   -> the innings is still running
 *   day 3 observed: 126  (131)  -> 126 (131), dated day 3
 *
 * The day an innings ended is the last day its figure changed. That single rule covers
 * every case, because the job runs daily and a day is only recorded once its play is
 * over: each snapshot is a settled end-of-day figure, so a figure that has stopped
 * moving has stopped for good. It needs no dismissal to anchor it, which matters for a
 * batsman left not out by a declaration — there is no "out" to look for, and the
 * comparison finds the right day anyway.
 *
 * `crex-commentary.js` reinforces this where a match has a commentary feed, because
 * the feed states each innings' closing day outright and can be re-read long after the
 * match. That matters for two things the comparison cannot do on its own: dating the
 * 393 Test innings scraped before any of this existed, and surviving a missed run,
 * since a day never observed is a day the comparison cannot reason about.
 *
 * An earlier version split the innings across days by subtraction ("+75 on day 3").
 * It was arithmetically sound and nobody wanted it: a hundred is a hundred, and no
 * scorecard anywhere agrees with a figure that exists only in this project.
 *
 * Only the date is inferred. Every figure shown is CREX's own, unmodified.
 */

/** A Test is scheduled for five days; the store keeps a row open that long. */
export const MAX_TEST_DAYS = 5;

/**
 * Formats whose innings span more than one calendar day.
 *
 * CREX exposes exactly five format tabs on a player's page — T20, ODI, Test, T10 and
 * 100B — and `normaliseFormat` folds its multi-day labels onto "Test": a Duleep
 * Trophy or County Championship innings arrives here already labelled Test, not
 * "First Class" or "4-Day". The longer spellings are kept anyway because they are
 * what the tab would say if CREX ever stopped folding them, and an unmatched
 * multi-day format is the expensive direction to be wrong in — it dates a four-day
 * innings as if it were settled the evening it began.
 *
 * T10 and 100B are single-day by construction, so they stay out deliberately.
 */
export const MULTI_DAY = /^(test|first class|fc|unofficial test|youth test|test match|4[- ]day|multi[- ]day)$/i;

export const isMultiDay = (format) => MULTI_DAY.test(String(format ?? '').trim());

/**
 * Read the day state off a match page's HTML.
 *
 * Returns `{ day, session, startDate, endDate, status }` with whatever was present.
 * `day` is null for a finished match, which is expected rather than an error: the
 * element only exists while the match is live.
 */
export function parseMatchDay(html) {
  const h = String(html ?? '');

  // The structured day marker, present only while the match is in progress.
  const ds = h.match(/class="day-session"[^>]*>([\s\S]{0,400}?)<\/div>/);
  const dayText = ds ? ds[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const day = dayText.match(/day\s*(\d+)/i)?.[1];
  const session = dayText.match(/session\s*(\d+)/i)?.[1];

  const event = sportsEvent(h);

  return {
    day: day ? +day : null,
    session: session ? +session : null,
    startDate: iso(event?.startDate),
    // The scheduled end, not the actual finish: a Test won by an innings inside
    // three days still reports a five-day window. Useful as a bound, never as a
    // result.
    endDate: iso(event?.endDate),
    status: event?.eventStatus ?? null,
    venue: event?.location?.name?.replace(/''/g, "'") ?? null,
  };
}

/** The SportsEvent JSON-LD block, which carries the match's real span. */
function sportsEvent(html) {
  for (const m of String(html).matchAll(
    /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g
  )) {
    if (!m[1].includes('"SportsEvent"')) continue;
    try {
      const d = JSON.parse(m[1]);
      if (d?.['@type'] === 'SportsEvent') return d;
    } catch {
      // A malformed block is skipped rather than failing the match: the day label
      // above is the primary signal and may still have parsed.
    }
  }
  return null;
}

/** "2026-08-27T15:30:00+05:30" -> "2026-08-27", keeping the date CREX intended. */
function iso(s) {
  const m = String(s ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Which calendar date is day N of a match that started on `startDate`?
 *
 * Days are consecutive unless play was lost, so this is the arithmetic answer and the
 * caller should prefer `dayFromLabel` when a label is available.
 */
export function dateOfDay(startDate, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate ?? '')) || !(day >= 1)) return null;
  return new Date(Date.parse(`${startDate}T00:00:00Z`) + (day - 1) * 864e5)
    .toISOString()
    .slice(0, 10);
}

/** How many days after the start is `date`? Day 1 is the start date itself. */
export function dayOfDate(startDate, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate ?? ''))) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return null;
  const n = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 864e5);
  return n >= 0 ? n + 1 : null;
}

/**
 * The day a snapshot taken on `observedOn` belongs to.
 *
 * The page's own label wins wherever it exists, because it is the only thing that
 * knows about a day washed out or a rest day: a Test starting on the 1st whose page
 * says "Day 3" on the 4th has lost a day, and the arithmetic answer (Day 4) would be
 * wrong. Without a label — a match that has finished since the last run — the
 * observation date is placed by arithmetic instead.
 *
 * `observedOn` is the date the scrape ran *in the match's own context*. The daily job
 * runs at 00:00 IST, which is mid-afternoon in England and pre-dawn in Australia, so
 * a run can land in the middle of a day's play or between two of them. That is why
 * the label is preferred and why nothing here assumes the run happened at stumps.
 */
export function resolveDay({ label, startDate, observedOn, status }) {
  if (label >= 1) {
    return { day: label, date: dateOfDay(startDate, label) ?? observedOn, from: 'label' };
  }

  // A finished match has no day marker, and the observation date is after the last
  // day of play rather than during it — so arithmetic on "today" would file the whole
  // innings on whatever day the scrape happened to run. Refuse instead.
  //
  // This is the one case that cannot be solved: a Test that ended before this project
  // ever looked at it has no recoverable day information anywhere on CREX. Those
  // innings keep the match's start date, exactly as before, and are marked so the
  // site can say the split is unavailable rather than imply a day.
  if (status && status !== 'Live') {
    return { day: null, date: observedOn, from: 'finished' };
  }

  const n = dayOfDate(startDate, observedOn);
  return n >= 1 && n <= MAX_TEST_DAYS
    ? { day: n, date: observedOn, from: 'arithmetic' }
    : { day: null, date: observedOn, from: 'unknown' };
}

/**
 * Can this match's days still be captured?
 *
 * Only while it is being played. Once CREX marks it finished the `day-session`
 * element is gone, and a match that finished before it was first observed can never
 * be split by day — there is no day information left on the site to read. The caller
 * uses this to decide whether a match is worth refetching and whether the innings
 * should be presented as a daily figure or as a whole-match one.
 */
export function stillCapturable(meta) {
  return Boolean(meta) && meta.status !== 'Finished' && !meta.error;
}

/* ── snapshots ──
   One row per (player, match, innings), holding the figure seen on each day. The
   sequence is what identifies the day the innings ended — the last day the figure
   advanced — and what distinguishes a corrected reading from a day's play. */

/** The key a snapshot row is stored under. */
export const snapKey = (playerId, matchId, innings) =>
  `${playerId}|${matchId}|${innings ?? 1}`;

/**
 * Fold an observation into a snapshot row, returning the updated row.
 *
 * Re-observing the same day overwrites that day rather than appending: the daily job
 * may run twice, and a Test's figure grows through the day, so the last read of a day
 * is the one closest to stumps and the one to keep.
 */
export function recordSnapshot(row, { day, date, batting, bowling, provisional }) {
  const next = { ...(row ?? {}), days: { ...(row?.days ?? {}) } };
  if (!(day >= 1)) return next;
  next.days[day] = {
    date,
    batting: batting ?? null,
    bowling: bowling ?? null,
    provisional: provisional || undefined,
  };
  return next;
}

/**
 * Place a snapshot row on the day its innings belongs to.
 *
 * An innings is one performance and reads as one: a hundred is a hundred, not two
 * half-rows on consecutive dates. So it appears **once**, on the day it ended, with
 * the whole figure CREX prints. A batsman 51* overnight who finishes on 126 shows 126
 * on the day he was dismissed, and nothing on the day before — the alternative,
 * crediting him with "+75", is arithmetic no scorecard agrees with.
 *
 * The exception is an innings still in progress, which has no end day yet. That shows
 * the running figure on the latest day observed, marked unfinished, so a reader
 * following a Test live sees "51*" at stumps rather than an empty page. The next run
 * supersedes it, and when the innings ends the row moves to the day it ended on.
 *
 * What this fixes is the pile-up: CREX stamps all four innings of a Test with the
 * match's start date, so a five-day Test lands entirely on day one. Dating each
 * innings by its own conclusion spreads a Test across the days it was actually
 * played, which is what a daily tracker is for.
 */
/**
 * Is `next` a re-reading of the same innings rather than more of it?
 *
 * A correction never advances the innings: the runs or balls go down, or they change
 * at all after the batsman was already out. Growth is play, and a growing figure read
 * mid-session is a running score that has no business being published as a day's work.
 */
function isCorrectionOf(placed, next) {
  if (!placed || !next) return false;
  const pb = placed.batting;
  const nb = next.batting;
  if (pb && nb) {
    if (pb.out && (nb.runs !== pb.runs || nb.balls !== pb.balls)) return true;
    if ((nb.runs ?? 0) < (pb.runs ?? 0) || (nb.balls ?? 0) < (pb.balls ?? 0)) return true;
  }
  const pw = placed.bowling;
  const nw = next.bowling;
  if (pw && nw) {
    if ((nw.wickets ?? 0) < (pw.wickets ?? 0) || (nw.runs ?? 0) < (pw.runs ?? 0)) return true;
  }
  return false;
}

export function dailyRows(row) {
  const days = Object.keys(row?.days ?? {})
    .map(Number)
    .filter((n) => n >= 1)
    .sort((a, b) => a - b);
  if (!days.length) return [];

  // The day the innings concluded is the last day its figure changed.
  //
  // That one rule covers every case, because the job runs daily and only records days
  // whose play is over: each snapshot is a settled end-of-day figure, so a figure that
  // stops moving has stopped for good. A batsman dismissed on day 2 and one left 112*
  // when the innings was declared both last changed on day 2, and both belong there —
  // the dismissal adds nothing the comparison does not already know.
  // Days whose play had finished when they were read. An innings is only ever placed
  // on one of these, because a day still in progress has no figure to state.
  const settledDays = days.filter((d) => !row.days[d]?.provisional);
  // While the current day is still being played, the innings belongs to the last day
  // that finished — and moves forward as each day closes, so it is published once, on
  // the most recent day it can be stated completely.
  const placeable = settledDays.length ? settledDays : days;

  const endDay = lastDayThatMoved(row, placeable);

  const snap = row.days[endDay];
  if (!snap) return [];

  // The figure comes from the most recent *settled* reading.
  //
  // A later run can correct an earlier day's snapshot — Manav Suthar's first Irani Cup
  // innings was recorded as a buggy "32 (54)" and later read correctly as "2 (13)" —
  // so the newest reading is normally the one to trust, and the day still comes from
  // when play actually stopped, letting a correction fix the figure without moving the
  // innings.
  //
  // A reading taken mid-session is the exception: it is a batsman's running score, not
  // a day's play. Preferring it published a figure that was still moving and, worse,
  // buried the completed day behind it — a batsman 80* at stumps on day one showed as
  // the 120* he happened to be on when the scrape ran during day two, and day one's
  // settled 80* was never published at all.
  //
  // So an unsettled snapshot is passed over in favour of the last settled one. The
  // innings then appears on the last day whose play is finished, with that day's
  // figure, and moves forward a day at a time as the match goes on — present once,
  // on the most recent day it can be stated completely.
  // Normally the figure is the one read on the day the innings is placed. But a later
  // run can correct an earlier day's snapshot — Manav Suthar's first Irani Cup innings
  // was stored as a buggy "32 (54)" and later read correctly as "2 (13)" — and that
  // correction is worth taking even though it arrived on a day still in progress.
  //
  // A correction is distinguishable from a running score: it does not advance the
  // innings. A figure that has gone *down*, or changed while the batsman was already
  // out, is a re-reading of the same innings; one that has grown is more of it, and
  // mid-session growth is exactly what must not be published.
  const newest = row.days[days[days.length - 1]];
  const placed = row.days[placeable[placeable.length - 1]] ?? snap;
  const latest = newest && isCorrectionOf(placed, newest) ? newest : placed;
  const figures = {
    batting: latest.batting ?? snap.batting ?? null,
    bowling: latest.bowling ?? snap.bowling ?? null,
  };

  const batted = figures.batting && (figures.batting.balls || figures.batting.runs);
  const bowled = figures.bowling && (figures.bowling.wickets || figures.bowling.runs);
  if (!batted && !bowled) return [];

  // A figure is still running only while the match it belongs to is. A later day
  // observed without the figure moving is itself the evidence that it has settled —
  // including for a batsman left not out, whose innings ended by a declaration or by
  // the match finishing rather than by a dismissal.
  const settled = endDay < placeable[placeable.length - 1] || !snap.provisional;

  return [{
    day: endDay,
    date: snap.date,
    batting: figures.batting,
    bowling: figures.bowling,
    // Which days the innings actually spanned, so the page can say "over days 2-3"
    // rather than implying it all happened at once.
    spanned: placeable.filter((d) => d <= endDay),
    // An innings still being played: the figure is the running one, not a result.
    provisional: settled ? undefined : (snap.provisional || undefined),
    multiDay: true,
  }];
}

/**
 * The last day on which either figure genuinely advanced.
 *
 * "Changed" is not enough, because a snapshot can change for a second reason: the
 * scrape that wrote it was wrong, and a later run corrected it. A corrected figure
 * looks exactly like a day's progress to a plain comparison, and it moved Manav
 * Suthar's first Irani Cup innings onto the wrong day — a buggy `32 (54)` recorded on
 * day 2 was replaced by the real `2 (13)` on day 3, so the innings appeared to have
 * been added to overnight and was dated to the 3rd. He was dismissed on the 2nd.
 *
 * Cricket only goes forwards: runs, balls, wickets and conceded runs never decrease
 * within an innings, and a batsman who is out cannot bat again in it. So a figure that
 * goes *down*, or one that grows after the batsman was already dismissed, is a
 * correction of an earlier reading rather than new play, and the day it arrived on is
 * not the day the innings ended.
 */
function lastDayThatMoved(row, days) {
  let last = days[0];
  let prev = null;
  for (const day of days) {
    const s = row.days[day];
    if (!prev) { prev = s; continue; }

    const advanced =
      gained(s.batting?.runs, prev.batting?.runs) ||
      gained(s.batting?.balls, prev.batting?.balls) ||
      gained(s.bowling?.wickets, prev.bowling?.wickets) ||
      gained(s.bowling?.runs, prev.bowling?.runs);

    // Nothing in an innings continues after the dismissal, so a figure that grows
    // once the batsman is out is another reading of the same innings, not more of it.
    const wasOut = Boolean(prev.batting?.out);
    const batOnly =
      advanced &&
      !gained(s.bowling?.wickets, prev.bowling?.wickets) &&
      !gained(s.bowling?.runs, prev.bowling?.runs);

    if (advanced && !(wasOut && batOnly)) last = day;
    prev = s;
  }
  return last;
}

/** Did this figure move forward? A fall is a correction, not play. */
function gained(now, before) {
  return (now ?? 0) > (before ?? 0);
}
