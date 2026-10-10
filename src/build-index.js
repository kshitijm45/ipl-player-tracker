/**
 * Build step: flatten cached match files into the static payload the site reads.
 *
 * Scanning 5,000+ match JSONs takes ~3s, which is fine as a scheduled job and far
 * too slow per page load. So this runs ahead of time and writes two artefacts:
 *
 *   site/data/players.json — index of every player with a 2026 appearance.
 *   site/data/performances.json — every 2026 performance row.
 *
 * Restricting to the current season keeps the payload around 3.5MB, small enough to
 * ship whole to the browser. That is what lets the site be a static page with no
 * server and no database — which is also what keeps it free to host.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { careersByPlayer } from './core/career-stats.js';
import { impact } from './core/impact.js';
import { PlayerRegistry } from './core/registry.js';
import { loadSquadFile, resolveSquads, classifySquad } from './core/squads.js';
import { displayName, stripDisambiguator } from './core/display-name.js';
import { mergePerformances, mergeStats } from './core/merge.js';
import { loadStore, expand, inProgressMatches } from './core/match-days.js';
import { isMultiDay, MAX_TEST_DAYS } from './sources/crex-match-day.js';
import { existsSync, readFileSync } from 'node:fs';

const CREX_PATH = new URL('../data/crex-players.json', import.meta.url).pathname;
const crexFile = existsSync(CREX_PATH) ? JSON.parse(readFileSync(CREX_PATH, 'utf8')) : {};
const crexPins = crexFile.pins ?? {};
// Players with no register entry are keyed by name instead, with the
// CREX slug standing in as their identity. Without this they can never be tracked,
// because the pinning step has no id to hang them on.
const crexSlugPins = crexFile.slugPins ?? {};

const CREX_PERF_PATH = new URL('../data/crex-performances.json', import.meta.url).pathname;
const CHANGES_PATH = new URL('../data/squad-changes-2026.json', import.meta.url).pathname;
const squadChanges = existsSync(CHANGES_PATH) ? JSON.parse(readFileSync(CHANGES_PATH, 'utf8')) : { changes: [] };
// Verified CREX spellings the automatic name guard cannot confirm on its own.
const OVERRIDE_FILE = new URL('../data/player-overrides.json', import.meta.url).pathname;
const IPL_APPEARANCES_PATH = new URL('../data/ipl-appearances-2026.json', import.meta.url).pathname;
const trustedCrex = existsSync(OVERRIDE_FILE)
  ? JSON.parse(readFileSync(OVERRIDE_FILE, 'utf8')).trustedCrexNames ?? {}
  : {};

// The tracker follows what IPL players do *after* the IPL, so the season window
// opens the day the final was played.
const SEASON_START = process.env.SEASON_START ?? '2026-06-01';
/** The IPL season itself, used only to work out who is in a squad. */
const IPL_SEASON_START = '2026-01-01';
const OUT_DIR = new URL('../site/data', import.meta.url).pathname;

/** Competitions that are mostly associate/qualifier noise for an IPL-fan audience. */
const DEPRIORITISED = /Qualifier|Sub Regional|Continental Cup|European Cup|Asian Games/i;

/**
 * Is this a Test innings that will be continued tomorrow?
 *
 * Only multi-day cricket qualifies. A limited-overs innings either has not started or
 * is finished by the end of its own day, so a figure read during one is simply a
 * batsman mid-over: showing it as a result would be wrong, and badging it LIVE only
 * dresses up a number that is about to change. Those rows are dropped instead.
 *
 * A Test is different. A batsman 70 not out at stumps has a real figure for the day,
 * and the reader wants it — he resumes tomorrow. So a Test row is kept and marked
 * provisional while the match is still inside its five days.
 *
 * "Stumps" is approximated by the day being over, because CREX prints nothing to say
 * a session has ended: today's Test rows are therefore held back until tomorrow,
 * rather than captured mid-session.
 */
function unfinishedTest(row, today, ends = null) {
  const d = String(row?.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  // The shared predicate, so "which formats run past midnight" is answered in one
  // place. This copy was a substring match and the store's was anchored, so the two
  // could disagree about the same innings.
  if (!isMultiDay(row?.format)) return false;

  // A match whose last day has passed is over, whatever the date arithmetic says.
  //
  // The five-day window is a guess standing in for knowledge: it marks an innings
  // live because a Test *could* still be running, not because this one is. The Irani
  // Cup final ended on 5 October and its innings still read TEST IN PROGRESS on the
  // 7th, because the row was dated the 3rd and the 3rd is inside five days of the
  // 7th. CREX states the end date on the match page and the store keeps it, so where
  // it is known it settles the question outright.
  //
  // `status` is not used for this. It is written when the match page is read and is
  // never revisited, so a match observed while live stays "Live" in the store for
  // good — which is the same staleness in a different field.
  const endDate = ends?.get?.(row?.matchId);
  if (endDate && endDate < today) return false;

  // Earlier than today (the day's play is over) but inside the match's five days.
  const earliest = new Date(Date.parse(today) - (MAX_TEST_DAYS - 1) * 864e5)
    .toISOString()
    .slice(0, 10);
  return d < today && d >= earliest;
}

/**
 * Last day of play per match, as the snapshot store recorded it.
 *
 * Only a date that has already passed is useful here, and only to rule a match out;
 * a match with no end date recorded falls back to the five-day window as before.
 */
function matchEndDates(store) {
  const ends = new Map();
  for (const row of Object.values(store?.rows ?? {})) {
    if (row?.matchId && row?.endDate) ends.set(row.matchId, row.endDate);
  }
  return ends;
}

/**
 * A figure that cannot be shown yet: a limited-overs innings from today, which may
 * still be being played, or a Test innings from today, whose day is not yet over.
 *
 * A row the snapshot store has dated is exempt, and that exemption is the whole
 * reason the store is worth keeping. The blanket "nothing from today" rule exists
 * because CREX gives no signal that a session has ended, so a figure read now might
 * be a batsman mid-over. A stored row does have that signal: it was placed by the
 * match page's own `Day N` label, and the day it names has to have been reached for
 * the label to say so.
 *
 * It matters because of when the job runs. 00:00 IST is mid-afternoon in England and
 * pre-dawn in Australia, so a day of Test cricket that finished hours ago is dated
 * "today" in UTC and would be withheld for another 24 hours — the reader would see an
 * empty page for a Test that is three days old. Live rows still carry `provisional`,
 * so nothing is presented as final before it is.
 */
/**
 * Today's date in IST, which is the clock this project runs on.
 *
 * UTC was wrong here, and the cost was a day of cricket. The job fires at 00:00 IST,
 * which is 18:30 UTC the *previous* day, so for the first five and a half hours of
 * every IST day the UTC date is still yesterday. The build therefore treated
 * yesterday as "today" and withheld all of it as possibly still in progress: on 4
 * October it published 7 of the 16 innings it had scraped for the 3rd, dropping a
 * 129 (87) in the India–West Indies ODI among them.
 *
 * IST is the right reference because it is when the job runs and the audience this is
 * built for reads it. A match can still be in progress somewhere at 00:00 IST — a day
 * of Test cricket in the Caribbean, say — and that is what `provisional` is for,
 * rather than suppressing the whole date.
 */
function istToday() {
  // IST is UTC+5:30 year-round; India does not observe DST.
  return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
}

function tooEarlyToShow(row, today) {
  const d = String(row?.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  if (row?.multiDay) {
    // A stored row is exempt from the blanket "nothing from today" rule because the
    // match page's `Day N` label proves the day was reached. Reached is not finished,
    // though, and the exemption was reading it as if it were: a figure snapshotted
    // mid-session on day one was published the same day, so Jack Edwards led a day
    // with 0/20 off a spell that was still being bowled.
    //
    // Today's play is therefore withheld while it is still marked provisional, which
    // is exactly the signal that it has not settled. A day already behind us is shown
    // whatever its flag says — that is the case the exemption exists for, since a day
    // of Test cricket in Australia finishes long before the next IST midnight.
    if (d === today && row.provisional) return true;
    return d > today;
  }
  return d >= today;
}

export async function buildIndex({ from = SEASON_START, slugs } = {}) {
  const today = istToday();
  const registry = PlayerRegistry.load();

  // Who is on a franchise's books, and which franchise.
  //
  // This used to be answered by reading the Cricsheet IPL season out of a 1.4 GB
  // ball-by-ball cache. That cache is not committed, so the daily CI job had no IPL
  // season to read and silently lost every player who reached the roster through an
  // appearance rather than through the published squad list — the deployed page showed
  // seventeen Chennai players instead of twenty-nine.
  //
  // The franchise now lives on the pin itself, in data/crex-players.json, which is
  // CREX-keyed and committed. Twenty-eight tracked players are not in the squad file
  // at all — Suryakumar Yadav, Tilak Varma, Mohammed Shami, Philip Salt among them —
  // so the pin is the only place that knows where they play, and CREX is once again
  // the single source the rest of the project already treats it as.
  const iplPerfs = [];
  for (const [id, pin] of Object.entries(crexPins)) {
    if (pin?.franchise) iplPerfs.push({ playerId: id, team: pin.franchise });
  }
  const appearedIds = new Set(iplPerfs.map((p) => p.playerId));

  const { members: squadMembers, unresolved } = resolveSquads({
    registry,
    squadFile: loadSquadFile(),
    appearedIds,
    slugPins: crexSlugPins,
  });

  // The tracked set is the union of squad membership and actual IPL appearances:
  // squad files miss mid-season replacements, and appearances miss the bench.
  const tracked = new Map();
  for (const [key, m] of squadMembers) {
    tracked.set(m.id ?? key, { ...m, inSquad: true });
  }
  // Which franchise did each player actually turn out for? This is how a player who
  // has dropped off the published roster — replaced through injury — keeps his
  // franchise, and how a mid-season replacement gains one.
  const iplTeamOf = new Map();
  for (const p of iplPerfs) {
    if (p.team && !iplTeamOf.has(p.playerId)) iplTeamOf.set(p.playerId, p.team);
  }

  for (const id of appearedIds) {
    if (tracked.has(id)) {
      const rec = tracked.get(id);
      rec.playedIPL = true;
      if (!rec.teams?.length && iplTeamOf.has(id)) rec.teams = [iplTeamOf.get(id)];
    } else {
      tracked.set(id, {
        id,
        inSquad: false,
        playedIPL: true,
        teams: iplTeamOf.has(id) ? [iplTeamOf.get(id)] : [],
      });
    }
  }

  // Classify squad status now that both sources have been merged.
  const changesByName = new Map(
    (squadChanges.changes ?? []).map((c) => [c.player.toLowerCase(), c])
  );
  for (const t of tracked.values()) {
    const listedTeam = t.inSquad ? t.teams?.[0] ?? null : null;
    const played = t.id ? iplTeamOf.get(t.id) ?? null : null;
    const reg = t.id ? registry.get(t.id) : null;
    // A replaced player is by definition absent from the current squad file, so he
    // has no `listedAs`. Match on every name we hold for him — including the CREX
    // common name, which is the spelling reporting uses ("Khaleel Ahmed", not
    // "KK Ahmed") and therefore the one the changes file is keyed by.
    const crexName = t.id ? crexPins[t.id]?.displayName : null;
    const change =
      [t.listedAs, reg?.unique_name, crexName, t.name]
        .filter(Boolean)
        .map((n) => changesByName.get(String(n).toLowerCase()))
        .find(Boolean) ?? null;

    const { status, reason, team } = classifySquad({
      id: t.id,
      listedTeam,
      iplTeamPlayedFor: played,
      changeEntry: change,
    });
    // Status is derived but not surfaced: every player on a franchise's books is
    // shown as part of that squad, whatever the reason they came or went.
    t.squadStatus = status;
    t.squadReason = reason;
    if (team && !t.teams?.length) t.teams = [team];
    if (change?.lastAppearance) t.lastIplAppearance = change.lastAppearance;
  }

  // A name carried as "unmapped" may already be present as a resolved player: he
  // reached the tracked set through his IPL appearances while the squad listing
  // failed to resolve. Same name, same franchise means the same person, so drop the
  // empty copy rather than showing him twice with 0 innings.
  const resolvedByName = new Map();
  // The CREX slug is the stronger signal, and the one that catches the cases the
  // name comparison cannot: the register knows "SR Dubey" while the squad sheet and
  // CREX both say "Saurabh Dubey", so the name key never matches and the same man is
  // listed twice — once with his innings and once empty.
  const resolvedBySlug = new Map();
  for (const t of tracked.values()) {
    if (!t.id) continue;
    const reg = registry.get(t.id);
    for (const n of [reg?.unique_name, t.listedAs].filter(Boolean)) {
      resolvedByName.set(`${String(n).toLowerCase()}|${t.teams?.[0] ?? ''}`, t);
    }
    const slug = crexPins[t.id]?.slug;
    if (slug) resolvedBySlug.set(slug, t);
  }
  // Dropping the duplicate record is only half the job: his innings were scraped
  // under the name key, so they have to follow him to the record that survives or
  // they become orphans that no player page can reach.
  const mergedInto = new Map();
  for (const [key, t] of [...tracked]) {
    if (t.id || !t.unmapped) continue;
    const bySlug = crexSlugPins[t.name]?.slug;
    const match =
      (bySlug && resolvedBySlug.get(bySlug)) ||
      resolvedByName.get(`${String(t.name).toLowerCase()}|${t.teams?.[0] ?? ''}`);
    if (match) {
      mergedInto.set(`unmapped:${t.name}`, match.id);
      tracked.delete(key);
    }
  }

  const trackedIds = new Set([...tracked.values()].map((t) => t.id).filter(Boolean));

  // CREX is the only source of match data, and now of the roster too. The register
  // read at the top is a static name list, not a data feed: it turns "MD Shanaka"
  // into the spelling a reader recognises. No innings and no squad come from it.
  const quarantined = [];
  const cricsheetRows = [];

  // The snapshot store, loaded once: it supplies the day each Test innings ended on
  // further down, and the match end dates that settle whether one is still in play.
  const dayStore = loadStore();
  // Slug -> the name its owner's record is keyed under. Filled when the scraped rows
  // are read and used again for the store's rows, which need the same rewrite.
  const slugOwner = new Map();
  const matchEnds = matchEndDates(dayStore);

  const crexRows = [];
  if (existsSync(CREX_PERF_PATH)) {
    const raw = JSON.parse(readFileSync(CREX_PERF_PATH, 'utf8')).byPlayer ?? {};
    // Rows for slug-pinned players arrive keyed by slug rather than by id.
    for (const [name, pin] of Object.entries(crexSlugPins)) slugOwner.set(pin.slug, name);

    for (const [playerId, rows] of Object.entries(raw)) {
      const asName = slugOwner.has(playerId) ? `unmapped:${slugOwner.get(playerId)}` : playerId;
      if (!trackedIds.has(playerId) && !slugOwner.has(playerId) && !mergedInto.has(asName)) continue;
      for (const r of rows) {
        // Only rows whose date resolved to a real day are usable.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '')) continue;
        if (r.date < from) continue;
        // A slug-pinned player has no register id, so his rows arrive keyed by
        // slug while his record is keyed "unmapped:<name>". Rewrite the key so the
        // two actually join — otherwise the innings are scraped and then dropped.
        const owner = slugOwner.get(playerId);
        const named = owner ? `unmapped:${owner}` : playerId;
        // And if that name-keyed record was folded into a resolved one just above,
        // send the rows to the id that survived.
        //
        // Whether a figure is still live is decided here rather than trusted from the
        // scrape. The scraper writes the flag at the moment it reads the page, and a
        // player who is not refetched keeps whatever it wrote: a Test from 22
        // September and ODIs from the 24th were still showing LIVE on 3 October,
        // because nothing ever went back to clear them. Recomputing it every build
        // means the badge expires on its own.
        // A match being played right now is not reported at all: the figure in the
        // table is a batsman mid-over, and would be replaced within minutes. Only a
        // Test carries over, and only once the day it belongs to is finished.
        if (tooEarlyToShow(r, today)) continue;
        crexRows.push({
          ...r,
          playerId: mergedInto.get(named) ?? named,
          provisional: unfinishedTest(r, today, matchEnds) || undefined,
        });
      }
    }
  }

  // Multi-day cricket: re-date each innings to the day it actually ended.
  //
  // CREX stamps every innings of a Test with the match's *start* date, so without
  // this a Test week reads as one enormous day followed by four empty ones — on 23
  // August, 55 of the day's 72 innings were Test innings really spread across five
  // days. Where the snapshot store saw the match being played, it knows which day
  // each innings concluded on, and that row replaces the collapsed one.
  //
  // The figures are untouched: an innings is shown whole, exactly as CREX prints it.
  // Only its date changes, and only when this project watched the match itself.
  // An innings from a Test that finished before the store existed keeps the start
  // date, because nothing on CREX can place it any better.
  // Rows out of the snapshot store need the same slug-to-id rewrite the scraped rows
  // get. A slug-pinned player has no register id, so his innings are stored under his
  // slug while his record is keyed "unmapped:<name>" — and the two only join if the
  // key is rewritten. Without it the row survives, loses its player, and the page
  // renders a nameless card: Jack Edwards led 8 October as "— · AUS vs SA 2026".
  //
  // It was only ever applied on the scraped path, which hid it until a slug-pinned
  // player had a multi-day innings, since every Test innings goes through the store.
  const dayRows = expand(dayStore)
    .filter((r) => r.date >= from && !tooEarlyToShow(r, today))
    .map((r) => {
      const owner = slugOwner.get(r.playerId);
      const named = owner ? `unmapped:${owner}` : r.playerId;
      const id = mergedInto.get(named) ?? named;
      return id === r.playerId ? r : { ...r, playerId: id };
    });
  const replaced = new Set();
  for (const r of dayRows) {
    // The collapsed row this innings came from, keyed as the scrape wrote it.
    replaced.add(`${r.playerId}|${r.matchId}|${r.inningsNo}`);
  }
  const keptCrex = crexRows.filter(
    (r) => !r.matchId || !replaced.has(`${r.playerId}|${r.matchId}|${r.innings ?? 1}`)
  );

  // Carry the scorecard's fields onto the re-dated row.
  //
  // A replaced row brings its figures from the day snapshots, which were taken before
  // the scorecard was ever read — so the dismissal, the balls bowled and the award are
  // all absent from it, and replacing the scraped row silently drops them. Ishan
  // Kishan's five Duleep innings were fully enriched in `data/` and still published
  // with no average, because every one of them is a Test innings and every Test
  // innings takes this path.
  //
  // Only the fields the scorecard owns are copied. The figures and the date stay the
  // store's, which is the whole reason the row was replaced.
  const enrichedByKey = new Map();
  for (const r of crexRows) {
    if (!r.matchId) continue;
    enrichedByKey.set(`${r.playerId}|${r.matchId}|${r.innings ?? 1}`, r);
  }
  for (const r of dayRows) {
    const src = enrichedByKey.get(`${r.playerId}|${r.matchId}|${r.inningsNo ?? 1}`);
    if (!src) continue;
    if (src.batting?.outFrom === 'scorecard' && r.batting) {
      r.batting = { ...r.batting, out: src.batting.out, outFrom: 'scorecard' };
    }
    if (src.bowling?.balls != null && r.bowling) {
      r.bowling = { ...r.bowling, balls: src.bowling.balls };
    }
    if (src.playerOfMatch) r.playerOfMatch = true;
    // The match URL too, which the store only began recording later. It is what lets
    // the merge drop a row filed under a series it cannot belong to, and without it
    // every innings stored before that change is unverifiable.
    if (!r.matchUrl && src.matchUrl) r.matchUrl = src.matchUrl;
  }

  const performances = mergePerformances({
    crexRows: keptCrex.concat(dayRows),
    cricsheetRows,
    from,
  });
  const merge = mergeStats(performances);

  /** @type {Map<string, any>} */
  const players = new Map();

  // Seed from the tracked set so squad members with no appearances still appear.
  for (const [trackedKey, t] of tracked) {
    const reg = t.id ? registry.get(t.id) : null;
    const registerName = reg?.unique_name ?? t.name;
    const crex =
      (t.id ? crexPins[t.id] : null) ??
      crexSlugPins[t.name] ??
      crexSlugPins[String(trackedKey).replace(/^unmapped:/, '')] ??
      null;

    // A player with no register entry gets an id built from his name. It
    // has to be the *same* string the map is keyed by and that his rows carry, or
    // the join silently fails: his innings are scraped and built, and his page shows
    // nothing. That is what hid Macneil Noronha's ten Maharaja T20 innings and
    // Vishal Nishad's six in the UP T20 — the rows existed all along under
    // "unmapped:<name>" while the record's id was null.
    // Use the key the tracked set already chose, rather than rebuilding one from the
    // display name. Those differ whenever a squad sheet and a CREX pin spell a player
    // differently — "Ravichandran Smaran" against "Smaran-R" — and rebuilding it left
    // the record under one id while his innings sat under the other. On the page that
    // read as the same innings twice, once against a blank name.
    const playerKey = t.id ?? trackedKey;

    players.set(playerKey, {
      id: playerKey,
      // What the page shows: the common name, falling back to the register name.
      name: stripDisambiguator(
        trustedCrex[registerName] ??
          displayName({ registerName, listedAs: t.listedAs, crexName: crex?.displayName })
      ),
      registerName,
      crexSlug: crex?.slug ?? null,
      listedAs: t.listedAs ?? null,
      cricinfo: reg?.key_cricinfo ?? null,
      iplTeams: t.teams ?? [],
      inSquad: t.inSquad ?? false,
      playedIPL: t.playedIPL ?? false,
      lastIplAppearance: t.lastIplAppearance ?? null,
      unmapped: Boolean(t.unmapped),
      teams: new Set(),
      competitions: new Set(),
      formats: new Set(),
      innings: 0,
      runs: 0,
      wickets: 0,
      lastPlayed: null,
    });
  }

  for (const p of performances) {
    const rec = players.get(p.playerId);
    if (!rec) continue;
    if (p.team) rec.teams.add(p.team);
    rec.competitions.add(p.competition);
    if (p.format) rec.formats.add(p.format);
    rec.innings += 1;
    rec.runs += p.batting?.runs ?? 0;
    rec.wickets += p.bowling?.wickets ?? 0;
    if (!rec.lastPlayed || p.date > rec.lastPlayed) rec.lastPlayed = p.date;
  }

  const playerList = [...players.values()]
    .map((p) => ({
      ...p,
      teams: [...p.teams],
      competitions: [...p.competitions],
      formats: [...p.formats],
    }))
    .sort(
      (a, b) =>
        Number(b.playedIPL) - Number(a.playedIPL) ||
        (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? '') ||
        b.runs - a.runs
    );

  // Daily index: what every tracked player did on each date, newest first. This is
  // what the daily tracker reads, so it does not have to scan all performances.
  const byDate = new Map();
  for (const p of performances) {
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p.playerId);
  }
  const days = [...byDate.entries()]
    .map(([date, ids]) => ({ date, players: [...new Set(ids)].length, innings: ids.length }))
    .sort((a, b) => b.date.localeCompare(a.date));

  // Batting and bowling per tournament, totalled per format. Computed here rather
  // than in the page so the arithmetic is tested and the payload is ready to render.
  const careers = careersByPlayer(performances);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/careers.json`, JSON.stringify(careers));

  // Multi-day matches still being played. CREX's schedule carries only upcoming
  // limited-overs cards, so a Test is absent from the fixtures for its whole
  // duration — this is the only place the site can learn one is on.
  const inProgress = inProgressMatches(dayStore, { asOf: today })
    .map((m) => ({
      ...m,
      players: m.players
        .map((pl) => ({ ...pl, playerId: mergedInto.get(pl.playerId) ?? pl.playerId }))
        .filter((pl) => players.has(pl.playerId)),
    }))
    .filter((m) => m.players.length);
  writeFileSync(`${OUT_DIR}/in-progress.json`, JSON.stringify(inProgress));
  writeFileSync(`${OUT_DIR}/days.json`, JSON.stringify(days));
  writeFileSync(`${OUT_DIR}/players.json`, JSON.stringify(playerList));
  // The ranking score, computed here so the page sorts on a tested number rather
  // than recomputing the model inline.
  writeFileSync(
    `${OUT_DIR}/performances.json`,
    JSON.stringify(performances.map((p) => ({ ...p, impact: impact(p) })))
  );
  writeFileSync(
    `${OUT_DIR}/meta.json`,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      seasonStart: from,
      players: playerList.length,
      performances: performances.length,
      latestMatch: performances[0]?.date ?? null,
      competitions: [...new Set(performances.map((p) => p.competition))].sort(),
      quarantined: quarantined.length,
      sources: merge,
      squadNamesUnresolved: unresolved.length,
      benched: playerList.filter((p) => !p.playedIPL).length,
    })
  );

  return {
    merge,
    players: playerList.length,
    performances: performances.length,
    quarantined,
    unresolved,
    benched: playerList.filter((p) => !p.playedIPL).length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const result = await buildIndex();
  console.log(
    `built ${result.players} players / ${result.performances} performances ` +
      `in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (result.quarantined.length ? ` (${result.quarantined.length} quarantined)` : '')
  );
}
