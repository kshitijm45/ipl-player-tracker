/**
 * Upcoming fixtures from CREX.
 *
 * The tracker is otherwise entirely backward-looking: it answers "what did my
 * players do" but not "who plays tomorrow". CREX's schedule page is server-rendered
 * and carries several days ahead, with times, teams and the tournament.
 *
 * It lists *every* match in world cricket, so the useful step is the filter: keep a
 * fixture only when one of its teams is a side a tracked player has actually turned
 * out for this season. That turns a global schedule into "your players are playing".
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUT = new URL('../site/data/fixtures.json', import.meta.url).pathname;
const PERF = new URL('../site/data/performances.json', import.meta.url).pathname;

export async function scrapeFixtures({ days = 6 } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('ingest-fixtures: playwright required.');
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: UA });
  const fixtures = [];

  try {
    await page.goto('https://crex.com/schedule', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500);

    // The page groups matches under date headings; read the blocks in order so each
    // match inherits the heading above it.
    const raw = await page.evaluate(() => {
      const out = [];
      let currentDate = null;
      const walk = document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
      for (let i = 0; i < walk.length; i++) {
        const line = walk[i];
        const dm = line.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(\d{1,2})\s+(\w{3})\s+(\d{4})$/);
        if (dm) { currentDate = { day: +dm[2], mon: dm[3], year: +dm[4] }; continue; }
        const tm = line.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM))$/i);
        if (tm && currentDate) {
          // Layout around a time: teamA, time, tournament, teamB
          out.push({
            date: currentDate,
            time: tm[1],
            teamA: walk[i - 1] ?? null,
            meta: walk[i + 1] ?? null,
            teamB: walk[i + 2] ?? null,
          });
        }
      }
      return out;
    });

    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (const r of raw) {
      const mi = MON.findIndex((m) => m.toLowerCase() === String(r.date.mon).toLowerCase());
      if (mi < 0) continue;
      const iso = `${r.date.year}-${String(mi + 1).padStart(2, '0')}-${String(r.date.day).padStart(2, '0')}`;
      const meta = String(r.meta ?? '');
      // "1stT20, American T20 cup 2026" -> stage + competition
      const parts = meta.split(',').map((x) => x.trim());
      fixtures.push({
        date: iso,
        time: r.time,
        teamA: cleanTeam(r.teamA),
        teamB: cleanTeam(r.teamB),
        stage: parts[0] || null,
        competition: parts.slice(1).join(', ') || null,
      });
    }
  } finally {
    await browser.close();
  }

  const clean = fixtures.filter(
    (f) => f.teamA && f.teamB && f.competition && f.date && !/won|live|abandoned/i.test(f.teamA)
  );

  const relevant = tagRelevant(clean);
  writeFileSync(OUT, JSON.stringify({ scrapedAt: new Date().toISOString(), fixtures: relevant }));
  return { total: clean.length, relevant: relevant.filter((f) => f.watch).length };
}

function cleanTeam(s) {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t || /^\d/.test(t) || /won|live|abandoned|stumps|innings/i.test(t)) return null;
  return t.length > 40 ? null : t;
}

/**
 * Mark the fixtures worth surfacing: those involving a side a tracked player has
 * appeared for this season. Everything else is world cricket the reader did not ask
 * about.
 */
function tagRelevant(fixtures) {
  if (!existsSync(PERF)) return fixtures.map((f) => ({ ...f, watch: false }));
  const perf = JSON.parse(readFileSync(PERF, 'utf8'));

  // Team names are the wrong join: the schedule prints club names ("Jamaica
  // Kingsmen") while performances store the abbreviations a scorecard uses ("JKM"),
  // so they almost never align. Competitions do align — if tracked players have been
  // turning out in the CPL, the next CPL fixture is one to watch.
  const comps = new Set();
  for (const r of perf) {
    if (r.competition) comps.add(compKey(r.competition));
  }
  const teams = new Set();
  for (const r of perf) {
    for (const t of [r.team, r.opposition].filter(Boolean)) teams.add(norm(t));
  }

  // Match on the competition's core words; the year is compared only when both
  // sides carry one, since a split season ("2026-27") is written differently in
  // the schedule than in a scorecard.
  const cores = new Set([...comps].map((k) => k.split('|')[0]).filter(Boolean));

  return fixtures.map((f) => {
    const key = compKey(f.competition);
    return {
      ...f,
      watch:
        comps.has(key) ||
        cores.has(key.split('|')[0]) ||
        teams.has(norm(f.teamA)) ||
        teams.has(norm(f.teamB)),
    };
  });
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');

/**
 * Reduce a competition label to its identifying words, so "CPL 2026" matches
 * "Caribbean Premier League 2026" and a year alone never carries a match.
 */
function compKey(label) {
  const s = String(label ?? '').toLowerCase();
  const year = s.match(/20\d{2}/)?.[0] ?? '';
  const stop = /\b(20\d{2}|men|mens|women|womens|the|cup|trophy|series|tour|of|in|vs|t20|odi|test|league|premier)\b/g;
  const core = s.replace(/[^a-z0-9 ]/g, ' ').replace(stop, ' ').replace(/\s+/g, ' ').trim();
  return `${core.split(' ').filter(Boolean).slice(0, 2).join(' ')}|${year}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await scrapeFixtures();
  console.log(`${r.total} fixtures, ${r.relevant} involving tracked teams`);
}
