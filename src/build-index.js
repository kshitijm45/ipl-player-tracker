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
import { CricsheetSource, COMPETITIONS } from './sources/cricsheet.js';
import { PlayerRegistry } from './core/registry.js';
import { loadSquadFile, resolveSquads } from './core/squads.js';

const SEASON_START = process.env.SEASON_START ?? '2026-01-01';
const OUT_DIR = new URL('../site/data', import.meta.url).pathname;

/** Competitions that are mostly associate/qualifier noise for an IPL-fan audience. */
const DEPRIORITISED = /Qualifier|Sub Regional|Continental Cup|European Cup|Asian Games/i;

export async function buildIndex({ from = SEASON_START, slugs } = {}) {
  const registry = PlayerRegistry.load();
  const source = new CricsheetSource();

  // Who actually turned out in the IPL this season? Used both to scope the tracked
  // set and as a disambiguation prior when resolving squad-list names.
  const { performances: iplPerfs } = await source.fetchPerformances({ from, slugs: ['ipl'] });
  const appearedIds = new Set(iplPerfs.map((p) => p.playerId));

  const { members: squadMembers, unresolved } = resolveSquads({
    registry,
    squadFile: loadSquadFile(),
    appearedIds,
  });

  // The tracked set is the union of squad membership and actual IPL appearances:
  // squad files miss mid-season replacements, and appearances miss the bench.
  const tracked = new Map();
  for (const [key, m] of squadMembers) {
    tracked.set(m.id ?? key, { ...m, inSquad: true });
  }
  for (const id of appearedIds) {
    if (tracked.has(id)) tracked.get(id).playedIPL = true;
    else tracked.set(id, { id, inSquad: false, playedIPL: true, teams: [] });
  }

  const trackedIds = new Set([...tracked.values()].map((t) => t.id).filter(Boolean));

  // Now pull everything those players did anywhere else this year.
  const { performances: allPerfs, quarantined } = await source.fetchPerformances({
    from,
    slugs: slugs ?? Object.keys(COMPETITIONS),
  });
  const performances = allPerfs.filter((p) => trackedIds.has(p.playerId));

  /** @type {Map<string, any>} */
  const players = new Map();

  // Seed from the tracked set so squad members with no appearances still appear.
  for (const t of tracked.values()) {
    const reg = t.id ? registry.get(t.id) : null;
    players.set(t.id ?? `unmapped:${t.name}`, {
      id: t.id ?? null,
      name: reg?.unique_name ?? t.name,
      listedAs: t.listedAs ?? null,
      cricinfo: reg?.key_cricinfo ?? null,
      iplTeams: t.teams ?? [],
      inSquad: t.inSquad ?? false,
      playedIPL: t.playedIPL ?? false,
      unmapped: Boolean(t.unmapped),
      teams: new Set(),
      competitions: new Set(),
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
    }))
    .sort(
      (a, b) =>
        Number(b.playedIPL) - Number(a.playedIPL) ||
        (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? '') ||
        b.runs - a.runs
    );

  mkdirSync(OUT_DIR, { recursive: true });
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
      squadNamesUnresolved: unresolved.length,
      benched: playerList.filter((p) => !p.playedIPL).length,
    })
  );

  return {
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
