/**
 * Player identity registry.
 *
 * The hard problem this project solves is not "fetch a scorecard" — it is knowing
 * that the "H Pandya" in an IPL scorecard, the "Hardik Pandya" in a T20I scorecard,
 * and whatever a domestic scorecard calls him are the same human being.
 *
 * Names cannot do this. The registry contains three different players matching
 * "Hardik" and several matching "Jadeja". Initials-only domestic scorecards make it
 * worse. So every source adapter must resolve to a canonical id before writing a
 * performance, and anything that cannot be resolved is quarantined rather than guessed.
 *
 * Cricsheet's register is the seed: key_cricinfo is present for 99.8% of players and
 * is the practical join key. key_bcci is only ~7% populated overall, but it is
 * populated precisely for players with BCCI domestic appearances, which is the tail
 * we most need help with. key_cricbuzz is ~0.3% populated and is deliberately unused.
 */

import { readFileSync, existsSync } from 'node:fs';
import { parse } from './csv.js';

const REGISTRY_PATH = new URL('../../data/raw/people.csv', import.meta.url).pathname;

/** Source keys we actually trust, best first. */
export const JOIN_KEYS = ['key_cricinfo', 'key_bcci', 'key_bigbash'];

/**
 * Normalise a name for *candidate lookup only* — never for final identity.
 * Strips punctuation, collapses whitespace, lowercases, and removes diacritics so
 * that "M.S. Dhoni", "MS Dhoni" and "Dhoni, MS" land in the same bucket.
 */
export function normaliseName(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,''`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive a surname + initials signature, e.g. "hardik pandya" -> "pandya|h".
 * Domestic scorecards frequently print only initials, so this is how an
 * initials-only line is matched against a full name.
 */
export function nameSignature(name) {
  const parts = normaliseName(name).split(' ').filter(Boolean);
  if (parts.length === 0) return null;
  const surname = parts[parts.length - 1];
  const initials = parts.slice(0, -1).map((p) => p[0]).join('');
  return `${surname}|${initials}`;
}

/**
 * Are the initials from a scorecard compatible with a registry player?
 *
 * Scorecards abbreviate unpredictably, so compatibility is directional: the
 * queried initials must be a subsequence of the player's known initials, or vice
 * versa. "R" and "RG" are compatible with "RG Sharma"; "RG" is not compatible with
 * "RA Sharma" (different second initial), which is what stops the 15-way collision.
 */
function initialsCompatible(queryInitials, player) {
  const known = new Set();
  for (const alias of [player.name, player.unique_name].filter(Boolean)) {
    const sig = nameSignature(alias);
    if (sig) known.add(sig.split('|')[1] ?? '');
  }

  for (const cand of known) {
    if (!cand) continue;
    const [short, long] =
      queryInitials.length <= cand.length ? [queryInitials, cand] : [cand, queryInitials];
    // Every initial in the shorter string must appear, in order, at the same
    // position in the longer one. This is a prefix check rather than a loose
    // subsequence check, because cricket initials are ordered given names.
    if (long.startsWith(short)) return true;
  }
  return false;
}

export class PlayerRegistry {
  constructor(players) {
    this.players = players;
    this.byId = new Map();
    this.bySourceKey = new Map(); // "key_cricinfo:1234" -> player
    this.bySignature = new Map(); // "pandya|h" -> [players]

    for (const p of players) {
      this.byId.set(p.identifier, p);

      for (const key of JOIN_KEYS) {
        const val = p[key];
        if (val) this.bySourceKey.set(`${key}:${val}`, p);
      }

      // Index every known alias of the player under its signature.
      for (const alias of new Set([p.name, p.unique_name].filter(Boolean))) {
        const sig = nameSignature(alias);
        if (!sig) continue;
        if (!this.bySignature.has(sig)) this.bySignature.set(sig, []);
        const bucket = this.bySignature.get(sig);
        if (!bucket.includes(p)) bucket.push(p);
      }
    }
  }

  static load(path = REGISTRY_PATH) {
    if (!existsSync(path)) {
      throw new Error(
        `Player registry missing at ${path}. Run \`npm run setup\` to download it.`
      );
    }
    return new PlayerRegistry(parse(readFileSync(path, 'utf8')));
  }

  get(identifier) {
    return this.byId.get(identifier) ?? null;
  }

  /** Exact resolution via a source's own player id. Always prefer this. */
  bySource(key, value) {
    if (!value) return null;
    return this.bySourceKey.get(`${key}:${value}`) ?? null;
  }

  /**
   * Resolve a player from a scorecard.
   *
   * Returns { player, confidence, reason }. Confidence is:
   *   'exact'     — matched on a source id; safe to write.
   *   'ambiguous' — name matched more than one player; caller must quarantine.
   *   'unknown'   — no match at all; caller must quarantine.
   *
   * `hint` narrows ambiguity using context the scorecard already gives us
   * (e.g. the team, or a squad list for the match).
   */
  resolve({ sourceKey, sourceId, name, hint }) {
    if (sourceKey && sourceId) {
      const exact = this.bySource(sourceKey, sourceId);
      if (exact) return { player: exact, confidence: 'exact', reason: sourceKey };
    }

    if (!name) return { player: null, confidence: 'unknown', reason: 'no name or id' };

    const sig = nameSignature(name);
    if (!sig) return { player: null, confidence: 'unknown', reason: 'unparseable name' };

    const [surname, initials] = sig.split('|');
    let candidates = this.bySignature.get(sig) ?? [];
    let matchReason = 'unique name match';

    // Scorecards vary in how much of the name they print: "Hardik Pandya",
    // "HH Pandya", "H Pandya" and bare "Pandya" all occur. Widen to the surname
    // and then keep only entries whose initials are a prefix-compatible match,
    // so "RG Sharma" does not collide with every R. Sharma in the register.
    if (candidates.length === 0) {
      const sameSurname = [...this.bySignature.entries()]
        .filter(([k]) => k.startsWith(`${surname}|`))
        .flatMap(([, v]) => v);

      candidates = initials
        ? sameSurname.filter((p) => initialsCompatible(initials, p))
        : sameSurname;

      matchReason = initials ? 'surname + initials' : 'surname only';
    }

    if (candidates.length === 0) {
      return { player: null, confidence: 'unknown', reason: `no match for "${name}"` };
    }

    if (candidates.length > 1 && hint?.squad?.length) {
      const narrowed = candidates.filter((c) => hint.squad.includes(c.identifier));
      if (narrowed.length === 1) {
        return { player: narrowed[0], confidence: 'exact', reason: 'name + squad' };
      }
      if (narrowed.length > 1) candidates = narrowed;
    }

    if (candidates.length === 1) {
      return { player: candidates[0], confidence: 'name', reason: matchReason };
    }

    return {
      player: null,
      confidence: 'ambiguous',
      reason: `"${name}" matches ${candidates.length} players`,
      candidates,
    };
  }
}
