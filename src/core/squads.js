/**
 * IPL squad membership.
 *
 * Cricsheet records playing XIs, never full squads, so a player who sat on the bench
 * all season is invisible to it. For a tracker that is the wrong default: a benched
 * IPL player is often exactly the one whose county or BBL form a fan wants to follow.
 *
 * No free API publishes squad lists, so `data/squads-2026.json` is maintained by hand.
 * It changes at the auction and trade windows, not daily, so the upkeep is small.
 *
 * Squad names come from press reports and rarely match the register's spelling
 * ("Dewald Brevis" vs "D Brevis", "R Sai Kishore" vs "Sai Kishore"), so every name is
 * resolved through the registry and failures are reported loudly. A name that cannot
 * be resolved is surfaced for a human to fix, never quietly dropped.
 */

import { readFileSync, existsSync } from 'node:fs';

const SQUAD_PATH = new URL('../../data/squads-2026.json', import.meta.url).pathname;
const OVERRIDE_PATH = new URL('../../data/player-overrides.json', import.meta.url).pathname;

export function loadSquadFile(path = SQUAD_PATH) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Manual squad-name -> canonical id pins, for names the matcher cannot resolve
 * (register spellings like "PVD Chameera" that share no token with the squad
 * listing, and real players whose namesakes make the name ambiguous).
 */
export function loadOverrides(path = OVERRIDE_PATH) {
  if (!existsSync(path)) return { overrides: {}, unmapped: { names: [] } };
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Resolve every squad name to a canonical player id.
 *
 * @returns {{ members: Map<string, {teams: string[], playedIPL: boolean}>,
 *             unresolved: Array<{name: string, team: string, reason: string}> }}
 */
export function resolveSquads({
  registry,
  squadFile,
  appearedIds = new Set(),
  overrideFile = loadOverrides(),
}) {
  const members = new Map();
  const unresolved = [];
  const overrides = overrideFile?.overrides ?? {};
  const knownUnmapped = new Set(overrideFile?.unmapped?.names ?? []);

  if (!squadFile?.teams) return { members, unresolved };

  // Players who actually appeared in the IPL this season are a strong prior: a squad
  // name is far more likely to mean an IPL regular than any of the 38 other people
  // in the register called "Aman Khan". Resolving against that pool first turns most
  // ambiguous names into a single candidate.
  const appearedPool = [...appearedIds];

  for (const [team, names] of Object.entries(squadFile.teams)) {
    for (const name of names) {
      // A manual pin always wins: it was verified by hand and is exact.
      const pin = overrides[name];
      let player = pin ? registry.get(pin.id) : null;

      if (!player) {
        let res = registry.resolve({ name, hint: { squad: appearedPool } });

        // Fall back to the open register for genuine non-players (bench, new
        // signings), who by definition are absent from the appearance pool.
        if (!res.player) res = registry.resolve({ name });

        if (!res.player) {
          // Known-unmappable names are expected, not errors: carry them as squad
          // members with no performance history rather than reporting them daily.
          if (knownUnmapped.has(name)) {
            members.set(`unmapped:${name}`, {
              id: null,
              name,
              listedAs: name,
              teams: [team],
              playedIPL: false,
              unmapped: true,
            });
            continue;
          }
          unresolved.push({ name, team, reason: res.reason, confidence: res.confidence });
          continue;
        }
        player = res.player;
      }

      const id = player.identifier;
      if (!members.has(id)) {
        members.set(id, {
          id,
          name: player.unique_name,
          listedAs: name,
          teams: [],
          playedIPL: appearedIds.has(id),
        });
      }
      const rec = members.get(id);

      // A player is on one franchise's books. If a second squad listed a *different*
      // name that happened to resolve here, the resolution is wrong, not the player
      // ambidextrous: "Mangesh Yadav" at Bengaluru and "Mayank Yadav" at Lucknow both
      // landed on MP Yadav, who then appeared for both while the real Mangesh had no
      // entry at all. Keep the first claim and report the second, rather than quietly
      // inventing a transfer.
      if (rec.teams.length && !rec.teams.includes(team)) {
        if (String(rec.listedAs).toLowerCase() !== String(name).toLowerCase()) {
          unresolved.push({
            name,
            team,
            reason: `resolved to ${player.unique_name}, already listed by ${rec.teams[0]} as "${rec.listedAs}"`,
            confidence: 'ambiguous',
          });
          continue;
        }
      }
      if (!rec.teams.includes(team)) rec.teams.push(team);
    }
  }

  return { members, unresolved };
}

/**
 * Squad status for a player.
 *
 * Membership is not a boolean. Published squad listings show only the *current*
 * roster, so a player ruled out through injury vanishes from them even though he was
 * contracted, played part of the season, and is still someone fans follow — often the
 * player they most want to follow, because they are waiting on his return.
 *
 * Three states, derived rather than hand-maintained wherever possible:
 *   active      — on the current published roster
 *   replaced    — played IPL matches for a franchise but is no longer listed by it
 *   replacement — appeared for a franchise and is listed, but was not in the original
 *                 squad transcription
 *
 * `data/squad-changes-2026.json` overrides the derivation where the reason is known
 * (injury vs withdrawal vs trade), since that cannot be inferred from scorecards.
 */
export function classifySquad({ id, listedTeam, iplTeamPlayedFor, changeEntry }) {
  if (changeEntry?.status) {
    return { status: changeEntry.status, reason: changeEntry.reason ?? null, team: changeEntry.team ?? listedTeam ?? iplTeamPlayedFor };
  }
  if (listedTeam) return { status: 'active', reason: null, team: listedTeam };
  if (iplTeamPlayedFor) {
    // Played for a franchise but that franchise no longer lists him.
    return { status: 'replaced', reason: 'not in current squad listing', team: iplTeamPlayedFor };
  }
  return { status: 'active', reason: null, team: null };
}

/**
 * The tracked player set: everyone in a listed squad, plus everyone who actually
 * turned out in an IPL match. The union matters because each source covers a gap in
 * the other — squad files miss mid-season replacements, and appearances miss the bench.
 */
export function trackedPlayers({ squadMembers, appearances }) {
  const tracked = new Map();

  for (const [id, rec] of squadMembers) {
    tracked.set(id, { ...rec, inSquad: true });
  }

  for (const [id, rec] of appearances) {
    if (tracked.has(id)) {
      tracked.get(id).playedIPL = true;
      continue;
    }
    // Played an IPL match but is not in the squad file — usually a replacement
    // signing, or a squad list we have not filled in yet.
    tracked.set(id, { ...rec, inSquad: false, playedIPL: true });
  }

  return tracked;
}
