/**
 * Which day did each innings of a multi-day match end on?
 *
 * The problem this answers: CREX stamps every innings of a Test with the match's
 * *start* date, so a five-day Test lands entirely on day one — on 23 August, 55 of
 * that day's 72 innings were Test innings really spread across five days.
 *
 * The player page cannot fix it (one date per match) and neither can the scorecard,
 * which carries no day, session or stumps marker. The live match page carries a
 * `.day-session` label, but that says which day the *match* is on, not which day an
 * innings closed — and it is deleted the moment the match ends.
 *
 * The commentary feed does carry it. CREX's own front-end calls this endpoint, and
 * every entry has a millisecond timestamp and an `inning` number. Walking the feed
 * and taking the latest timestamp per innings gives each innings' closing day
 * outright, for a match five weeks finished as readily as one being played now:
 *
 *   ENG v PAK 2nd Test, started 27 Aug
 *     innings 1: 28 Aug            -> ended 28 Aug
 *     innings 2: 28, 29, 30 Aug    -> ended 30 Aug
 *     innings 3: 30 Aug            -> ended 30 Aug
 *
 * Why this is used in preference to differencing daily snapshots, which was the first
 * design: a snapshot pair only reveals a closing day if both runs land. A Test that
 * starts and finishes between two scheduled runs, or one CI failure, leaves an innings
 * frozen at its overnight figure with no way to ever correct it — the same class of
 * bug as Mukesh Kumar stuck at "84 (102)". The feed is authoritative and re-readable,
 * so it does not depend on the scraper having been watching.
 *
 * The caveats, both handled by the caller rather than hidden here:
 *
 *   - This is a third-party host (`content.crickapi.com`), reached by replaying the
 *     headers CREX's front-end sends, including a static build-time JWT that is not
 *     tied to any account. It is the same data CREX serves itself, but it is not a
 *     documented public API: it may change shape or refuse traffic without notice.
 *     Every failure here is therefore soft, and an innings that cannot be dated keeps
 *     the match start date exactly as before.
 *   - Coverage is per match, not per tier. The Irani Cup (domestic) has a feed;
 *     BAN-A v SA-A does not. A single-page probe says which, cheaply.
 */

/**
 * The authorization CREX's front-end sends. A build-time constant embedded in its JS
 * — payload `{"time":1660046620000}`, no user, no session, no expiry in practice.
 * Captured rather than issued, which is the reason every caller treats a failure as
 * routine rather than exceptional.
 */
const AUTH =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImV4cGlyZXNJbiI6IjM2NWQifQ' +
  '.eyJ0aW1lIjoxNjYwMDQ2NjIwMDAwfQ.bTEmMWlR7hLRUHxPPq6-1TP7cuuW7m6sZ9jcdbYzLRA';

const ENDPOINT = 'https://content.crickapi.com/commentary/v1/getBallFeeds';

/** The feed pages ten entries at a time, oldest-last. */
export const PAGE_SIZE = 10;

/**
 * A Test generates ~2,000 commentary entries, so ~200 pages. The cap is well clear of
 * that and exists only so a feed that never terminates cannot hang a run.
 */
export const MAX_PAGES = 400;

/** Entries that are not part of an innings: pre-match buildup and toss talk. */
const NOT_AN_INNINGS = new Set([0, -1, null, undefined]);

/** One page of the feed, or null if it could not be read. */
async function page(matchKey, lastDocId, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const ctl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: AUTH,
        cc: 'IN',
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        version: '96.0.0',
      },
      body: JSON.stringify({ matchKey, lastDocId: lastDocId ?? null, filters: {}, lang: 'en' }),
      signal: ctl,
    });
    if (!res.ok) return null;
    const json = await res.json();
    // The response is a bare array. Anything else means the shape has changed, which
    // is a reason to stop rather than to guess.
    return Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

/**
 * Does this match have a commentary feed at all?
 *
 * One request. Worth spending before a full walk, because coverage is per match and a
 * match with no feed would otherwise cost a wasted page read to discover.
 */
export async function hasFeed(matchKey, opts = {}) {
  const first = await page(matchKey, null, opts);
  return Array.isArray(first) && first.length > 0;
}

/**
 * Walk a match's commentary and report the last day each innings was played on.
 *
 * Returns `{ matchKey, endedOn: { 1: '2026-08-28', ... }, days, entries, pages,
 * complete }`. `endedOn` is keyed by innings number, and because the feed is ordered
 * newest-first, the first timestamp seen for an innings is its closing day.
 *
 * `complete` is false when the walk stopped on an unreadable page rather than on the
 * end of the feed; the days gathered so far are still returned and are still correct,
 * since each one came from a real entry.
 */
export async function inningsDays(matchKey, { maxPages = MAX_PAGES, onPage, ...opts } = {}) {
  const endedOn = {};
  const startedOn = {};
  const days = new Set();
  let lastDocId = null;
  let pages = 0;
  let entries = 0;
  let complete = false;

  while (pages < maxPages) {
    const batch = await page(matchKey, lastDocId, opts);
    if (batch === null) break;
    if (!batch.length) { complete = true; break; }

    pages++;
    entries += batch.length;

    for (const e of batch) {
      const day = dayOf(e);
      if (!day) continue;
      days.add(day);
      const inn = e?.inning;
      if (NOT_AN_INNINGS.has(inn)) continue;
      // Newest first, so the first sighting is the closing day and the last sighting
      // (overwritten each time) ends up as the opening day.
      if (!endedOn[inn]) endedOn[inn] = day;
      startedOn[inn] = day;
    }

    onPage?.({ pages, entries, endedOn });

    const next = batch[batch.length - 1]?.id;
    // A page that does not advance the cursor would loop forever.
    if (!next || next === lastDocId) { complete = true; break; }
    lastDocId = next;
  }

  return {
    matchKey,
    endedOn,
    startedOn,
    days: [...days].sort(),
    entries,
    pages,
    complete,
  };
}

/** The calendar day an entry belongs to, from its millisecond id. */
function dayOf(entry) {
  const id = Number(entry?.id);
  // Ids are epoch milliseconds; anything smaller is not a timestamp.
  if (!Number.isFinite(id) || id < 1e12) return null;
  return new Date(id).toISOString().slice(0, 10);
}
