/**
 * Cricsheet adapter — the backbone source.
 *
 * Free, CC-BY licensed, and unusually well structured for this project: every match
 * file embeds `info.registry.people`, mapping the exact scorecard name strings used
 * in that match to canonical Cricsheet identifiers. So identity resolution here is
 * exact by construction — the ambiguity that plagues name-based matching (two real
 * players named Rohit Sharma) cannot occur on this path.
 *
 * Coverage (verified against cricsheet.org/matches): all internationals plus IPL,
 * BBL, PSL, CPL, T20 Blast, SA20, ILT20, The Hundred, MLC, BPL, LPL, Super Smash,
 * Syed Mushtaq Ali Trophy, County Championship and Sheffield Shield.
 *
 * Not covered: Ranji Trophy, Vijay Hazare, TNPL, KPL. Those need another adapter.
 *
 * Freshness: files appear within days of a match, not live. This source answers
 * "what did my players do recently", not "what is happening right now".
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Source } from './source.js';

const CACHE_DIR = new URL('../../data/cache/cricsheet', import.meta.url).pathname;

/** Cricsheet download slugs -> display names. */
export const COMPETITIONS = {
  ipl: 'Indian Premier League',
  bbl: 'Big Bash League',
  psl: 'Pakistan Super League',
  cpl: 'Caribbean Premier League',
  ntb: 'T20 Blast',
  sat: 'SA20',
  ilt: 'International League T20',
  hnd: 'The Hundred',
  mlc: 'Major League Cricket',
  bpl: 'Bangladesh Premier League',
  lpl: 'Lanka Premier League',
  ssm: 'Super Smash',
  msl: 'Mzansi Super League',
  tests: 'Test Matches',
  odis: 'One Day Internationals',
  t20s: "T20 Internationals",
};

export class CricsheetSource extends Source {
  constructor() {
    super({
      id: 'cricsheet',
      label: 'Cricsheet',
      priority: 1,
      competitions: Object.values(COMPETITIONS),
      live: false,
    });
  }

  async healthCheck() {
    try {
      const res = await fetch('https://cricsheet.org/matches/', { method: 'HEAD' });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** Download and unzip one competition's JSON archive, cached on disk. */
  async sync(slug, { force = false } = {}) {
    const dir = join(CACHE_DIR, slug);
    if (existsSync(dir) && !force && readdirSync(dir).length > 0) {
      return { slug, cached: true, matches: readdirSync(dir).filter(isMatchFile).length };
    }

    mkdirSync(dir, { recursive: true });
    const url = `https://cricsheet.org/downloads/${slug}_json.zip`;
    const zipPath = join(dir, 'archive.zip');

    const res = await fetch(url);
    if (!res.ok) throw new Error(`${slug}: download failed (HTTP ${res.status})`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));

    // unzip is present on macOS and most Linux images; avoids a dependency.
    execFileSync('unzip', ['-oq', zipPath, '-d', dir]);

    return { slug, cached: false, matches: readdirSync(dir).filter(isMatchFile).length };
  }

  /**
   * Read cached matches and emit per-player performances.
   * Because identity comes from the match's own registry, every row is exact.
   */
  async fetchPerformances({ from, to, slugs = Object.keys(COMPETITIONS) }) {
    const performances = [];
    const quarantined = [];

    for (const slug of slugs) {
      const dir = join(CACHE_DIR, slug);
      if (!existsSync(dir)) continue;

      for (const file of readdirSync(dir).filter(isMatchFile)) {
        let match;
        try {
          match = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        } catch {
          quarantined.push({ file, reason: 'unparseable match json' });
          continue;
        }

        const date = match.info?.dates?.[0];
        if (!date) continue;
        if (from && date < from) continue;
        if (to && date > to) continue;

        performances.push(...extractPerformances(match, file.replace(/\.json$/, ''), slug));
      }
    }

    performances.sort((a, b) => b.date.localeCompare(a.date));
    return { performances, quarantined };
  }
}

function isMatchFile(f) {
  return f.endsWith('.json') && f !== 'README.json';
}

/**
 * Turn one match into per-player performance rows.
 *
 * Cricsheet gives ball-by-ball data rather than a scorecard, so batting, bowling
 * and fielding figures are aggregated here. Dismissals are read from each
 * delivery's `wickets` array, which is also where catches and stumpings come from.
 */
export function extractPerformances(match, matchId, slug) {
  const info = match.info ?? {};
  const people = info.registry?.people ?? {};
  const date = info.dates?.[0];
  const competition = info.event?.name ?? COMPETITIONS[slug] ?? slug;
  const format = normaliseFormat(info.match_type);
  const teams = info.teams ?? [];

  // name -> team, so a performance can be labelled with its side.
  const teamOf = new Map();
  for (const [team, players] of Object.entries(info.players ?? {})) {
    for (const p of players) teamOf.set(p, team);
  }

  /** @type {Map<string, any>} keyed by canonical player id. */
  const acc = new Map();

  const row = (name) => {
    const id = people[name];
    if (!id) return null; // Unknown to the match registry; skip rather than guess.
    if (!acc.has(id)) {
      const team = teamOf.get(name) ?? null;
      acc.set(id, {
        playerId: id,
        name,
        matchId,
        date,
        competition,
        format,
        team,
        opposition: teams.find((t) => t !== team) ?? null,
        source: 'cricsheet',
      });
    }
    return acc.get(id);
  };

  for (const innings of match.innings ?? []) {
    for (const over of innings.overs ?? []) {
      for (const d of over.deliveries ?? []) {
        const batter = row(d.batter);
        if (batter) {
          const b = (batter.batting ??= { runs: 0, balls: 0, fours: 0, sixes: 0, out: false });
          b.runs += d.runs?.batter ?? 0;
          // Wides do not count as balls faced; everything else does.
          if (!d.extras?.wides) b.balls += 1;
          if (d.runs?.batter === 4) b.fours += 1;
          if (d.runs?.batter === 6) b.sixes += 1;
        }

        const bowler = row(d.bowler);
        if (bowler) {
          const bw = (bowler.bowling ??= { balls: 0, runs: 0, wickets: 0 });
          if (!d.extras?.wides && !d.extras?.noballs) bw.balls += 1;
          // Byes and leg byes are not charged to the bowler.
          bw.runs +=
            (d.runs?.batter ?? 0) +
            (d.extras?.wides ?? 0) +
            (d.extras?.noballs ?? 0);
        }

        for (const w of d.wickets ?? []) {
          const out = row(w.player_out);
          if (out) (out.batting ??= { runs: 0, balls: 0, fours: 0, sixes: 0, out: false }).out = true;

          // Run outs are not credited to the bowler.
          if (bowler && w.kind !== 'run out' && w.kind !== 'retired hurt') {
            bowler.bowling.wickets += 1;
          }

          for (const f of w.fielders ?? []) {
            if (!f.name) continue;
            const fielder = row(f.name);
            if (!fielder) continue;
            const fd = (fielder.fielding ??= { catches: 0, stumpings: 0, runOuts: 0 });
            if (w.kind === 'caught') fd.catches += 1;
            else if (w.kind === 'stumped') fd.stumpings += 1;
            else if (w.kind === 'run out') fd.runOuts += 1;
          }
        }
      }
    }
  }

  // Convert bowling balls into the overs figure people expect (e.g. 3.4).
  for (const p of acc.values()) {
    if (p.bowling) {
      const { balls } = p.bowling;
      p.bowling.overs = `${Math.floor(balls / 6)}.${balls % 6}`;
    }
  }

  return [...acc.values()];
}

function normaliseFormat(matchType) {
  const t = (matchType ?? '').toUpperCase();
  if (t === 'T20' || t === 'IT20') return 'T20';
  if (t === 'ODI' || t === 'ODM') return 'ODI';
  if (t === 'TEST' || t === 'MDM') return 'Test';
  return matchType ?? 'Unknown';
}
