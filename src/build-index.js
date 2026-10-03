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
import { PlayerRegistry } from './core/registry.js';
import { loadSquadFile, resolveSquads, classifySquad } from './core/squads.js';
import { displayName, stripDisambiguator } from './core/display-name.js';
import { mergePerformances, mergeStats } from './core/merge.js';
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
function unfinishedTest(row, today) {
  const d = String(row?.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  if (!/test|first class|fc/i.test(String(row?.format ?? ''))) return false;
  // Earlier than today (the day's play is over) but inside the match's five days.
  const earliest = new Date(Date.parse(today) - 4 * 864e5).toISOString().slice(0, 10);
  return d < today && d >= earliest;
}

/**
 * A figure that cannot be shown yet: a limited-overs innings from today, which may
 * still be being played, or a Test innings from today, whose day is not yet over.
 */
function tooEarlyToShow(row, today) {
  const d = String(row?.date ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today;
}

export async function buildIndex({ from = SEASON_START, slugs } = {}) {
  const today = new Date().toISOString().slice(0, 10);
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

  const crexRows = [];
  if (existsSync(CREX_PERF_PATH)) {
    const raw = JSON.parse(readFileSync(CREX_PERF_PATH, 'utf8')).byPlayer ?? {};
    // Rows for slug-pinned players arrive keyed by slug rather than by id.
    const slugOwner = new Map();
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
          provisional: unfinishedTest(r, today) || undefined,
        });
      }
    }
  }

  const performances = mergePerformances({ crexRows, cricsheetRows, from });
  const merge = mergeStats(performances);

  /** @type {Map<string, any>} */
  const players = new Map();

  // Seed from the tracked set so squad members with no appearances still appear.
  for (const t of tracked.values()) {
    const reg = t.id ? registry.get(t.id) : null;
    const registerName = reg?.unique_name ?? t.name;
    const crex = (t.id ? crexPins[t.id] : null) ?? crexSlugPins[t.name] ?? null;

    // A player with no register entry gets an id built from his name. It
    // has to be the *same* string the map is keyed by and that his rows carry, or
    // the join silently fails: his innings are scraped and built, and his page shows
    // nothing. That is what hid Macneil Noronha's ten Maharaja T20 innings and
    // Vishal Nishad's six in the UP T20 — the rows existed all along under
    // "unmapped:<name>" while the record's id was null.
    const playerKey = t.id ?? `unmapped:${t.name}`;

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

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/days.json`, JSON.stringify(days));
  writeFileSync(`${OUT_DIR}/players.json`, JSON.stringify(playerList));
  writeFileSync(`${OUT_DIR}/performances.json`, JSON.stringify(performances));
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
