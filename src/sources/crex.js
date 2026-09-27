/**
 * CREX adapter.
 *
 * CREX covers the long tail no free dataset reaches — Vijay Hazare, Syed Mushtaq Ali,
 * state T20 leagues — and it prints players under the names fans actually use
 * ("Dasun Shanaka", not the register's "MD Shanaka"). Both are things this project
 * needs and Cricsheet cannot give.
 *
 * What makes it scrapable, contrary to the usual assumption about the site: the match
 * and player pages are server-rendered, so the scores are in the HTML rather than
 * behind an authenticated XHR API. Players have stable slugs (`hardik-pandya-C3`), and
 * `/player/<slug>/matches` carries per-innings figures already split by format.
 *
 * What it does not give: a machine-readable player id space. The slug is the id, so
 * slugs are pinned to canonical Cricsheet identifiers in data/crex-players.json and
 * that mapping is the contract. No name matching happens at scrape time.
 *
 * Rules this adapter follows, because it is the fragile link in the chain:
 *   - it is never the only source for a player who exists in Cricsheet
 *   - every fetch is cached to disk; a run re-reads cache rather than re-fetching
 *   - failures are contained: a scrape error degrades one player, never the build
 *   - requests are serialised and rate-limited
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Source } from './source.js';

const CACHE_DIR = new URL('../../data/cache/crex', import.meta.url).pathname;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Formats CREX splits its match list by. */
export const FORMATS = ['T20', 'ODI', 'Test', 'T10', '100B'];

export class CrexSource extends Source {
  constructor({ delayMs = 2500 } = {}) {
    super({
      id: 'crex',
      label: 'CREX',
      priority: 3, // behind Cricsheet: used to extend coverage, not to override it
      competitions: ['*'],
      live: true,
    });
    this.delayMs = delayMs;
    this._browser = null;
  }

  async healthCheck() {
    try {
      const res = await fetch('https://crex.com/schedule', { headers: { 'User-Agent': UA } });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** Playwright is an optional dependency: without it this source simply stays off. */
  async browser() {
    if (this._browser) return this._browser;
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error(
        'crex: playwright is not installed. Run `npm i playwright && npx playwright install chromium`, ' +
          'or build without this source — it only extends coverage.'
      );
    }
    this._browser = await chromium.launch();
    return this._browser;
  }

  async close() {
    await this._browser?.close();
    this._browser = null;
  }

  cachePath(key) {
    mkdirSync(CACHE_DIR, { recursive: true });
    return join(CACHE_DIR, `${key.replace(/[^\w.-]/g, '_')}.json`);
  }

  readCache(key, maxAgeMs) {
    const f = this.cachePath(key);
    if (!existsSync(f)) return null;
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (maxAgeMs && Date.now() - raw.at > maxAgeMs) return null;
    return raw.data;
  }

  writeCache(key, data) {
    writeFileSync(this.cachePath(key), JSON.stringify({ at: Date.now(), data }));
  }

  /**
   * Profile fields: the common name fans use, plus role and batting/bowling style.
   * This is what fixes "MD Shanaka" reading as a stranger on the page.
   */
  async fetchProfile(slug, { maxAgeMs = 30 * 24 * 3600e3 } = {}) {
    const cached = this.readCache(`profile_${slug}`, maxAgeMs);
    if (cached) return cached;

    const page = await (await this.browser()).newPage({ userAgent: UA });
    try {
      await page.goto(`https://crex.com/player/${slug}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await page.waitForTimeout(1800);

      const data = await page.evaluate(() => {
        // The profile is a label/value list; read it as pairs.
        const text = document.body.innerText;
        const pick = (label) => {
          const re = new RegExp(`^${label}\\n(.+)$`, 'm');
          return text.match(re)?.[1]?.trim() ?? null;
        };
        return {
          name: pick('Name'),
          role: pick('Role'),
          bats: pick('Bats'),
          bowls: pick('Bowls'),
          nationality: pick('Nationality'),
          birth: pick('Birth'),
          image:
            document.querySelector('img[src*="player"], img[alt*="Player"]')?.getAttribute('src') ??
            null,
        };
      });

      this.writeCache(`profile_${slug}`, data);
      await page.close();
      return data;
    } catch (err) {
      await page.close().catch(() => {});
      return { error: err.message };
    }
  }

  /**
   * Every innings CREX holds for a player, across every tournament.
   *
   * The player's matches page opens on the most recent tournament only — four rows
   * for a player who has actually had a full season. The rest sit behind the
   * tournament cards (`div.sCard`), which are clickable despite carrying no href:
   * clicking one re-renders the table with that tournament's full innings list
   * (Archer's IPL card yields all 10 innings, Qualifier and Eliminator included).
   *
   * So a full read walks the cards in turn. `batting` and `bowling` are separate
   * views of the same table, so each card is read twice and the two merged by fixture.
   */
  async fetchMatches(slug, { maxAgeMs = 6 * 3600e3, maxSeries = 12, since = null } = {}) {
    const key = `matches_${slug}_all`;
    const cached = this.readCache(key, maxAgeMs);
    if (cached) return cached;

    const page = await (await this.browser()).newPage({ userAgent: UA });
    const collected = new Map();

    try {
      await page.goto(`https://crex.com/player/${slug}/matches`, {
        waitUntil: 'networkidle',
        timeout: 45000,
      });
      await page.waitForTimeout(2200);

      // The Batting and Bowling tabs do not show the same tournaments. A bowler who
      // only bowled in a competition has no card for it under Batting — Mohsin
      // Khan's UP T20 2026 is absent there and present under Bowling — so the card
      // list has to be read again inside each discipline rather than once up front.
      const deferred = [];
      const seenCards = new Set();

      for (const discipline of ['Batting', 'Bowling']) {
        await page.goto(`https://crex.com/player/${slug}/matches`, {
          waitUntil: 'networkidle',
          timeout: 45000,
        });
        await page.waitForTimeout(2000);

        const dTab = page.locator(`text="${discipline}"`).first();
        if (await dTab.count()) {
          await dTab.click({ timeout: 6000 }).catch(() => {});
          await page.waitForTimeout(1800);
        }

      const labels = await page.$$eval('.sCard', (cards) =>
        cards.map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim())
      );
      const cardCount = Math.min(labels.length, maxSeries);
      // Every card's window, so a row can be attributed by its date. Reading the
      // format tabs surfaces innings from tournaments other than the selected card,
      // and tagging those with the active card's name is how a Duleep Trophy
      // semi-final ended up filed under a one-day tour of Japan.
      const windows = labels.slice(0, cardCount).map(parseSeriesCard).filter((w) => w?.name);

      for (let i = 0; i < cardCount; i++) {
        const series = parseSeriesCard(labels[i]);

        // Skip tournaments that finished before the window of interest. Each card
        // costs a page load, and a re-scrape aimed at recent cricket has no reason
        // to walk the IPL and everything before it again.
        if (since && seriesEndedBefore(series, since)) continue;
        // The two tabs overlap heavily; a card read once need not be walked again.
        const cardKey = `${discipline === 'Bowling' ? 'b' : 'a'}|${series?.name ?? labels[i]}`;
        const sharedKey = series?.name ?? labels[i];
        if (seenCards.has(sharedKey)) continue;
        seenCards.add(sharedKey);

        // Some cards re-render the table in place; others navigate to the series
        // page and abandon the player context. Returning to the player page before
        // each click makes the two behave the same, at the cost of a reload.
        if (i > 0) {
          try {
            await page.goto(`https://crex.com/player/${slug}/matches`, {
              waitUntil: 'networkidle',
              timeout: 40000,
            });
            await page.waitForTimeout(1800);
            // Re-select the discipline: a reload drops back to Batting, and the
            // card indices only mean anything within the tab they came from.
            const back = page.locator(`text="${discipline}"`).first();
            if (await back.count()) {
              await back.click({ timeout: 6000 }).catch(() => {});
              await page.waitForTimeout(1500);
            }
          } catch {
            break;
          }
        }

        try {
          await page.locator('.sCard').nth(i).click({ timeout: 8000 });
          // A navigating card needs longer than an in-place re-render before the
          // URL settles; checking too early reads the player page and the series
          // is silently dropped.
          await page.waitForTimeout(2600);
        } catch {
          continue;
        }

        // Most cards re-render the innings table in place. A few navigate to the
        // series page instead, and for those the player's innings are only
        // reachable through that series' scorecards — skipping them loses whole
        // tours (Buttler's England series, including a 131, went missing this way).
        // Those are noted and read after this loop: following a navigation here
        // leaves the card list re-rendered, so every later index would point at
        // the wrong tournament.
        if (!page.url().includes(`/player/${slug}`)) {
          const seriesUrl = page.url();
          if (/\/series\//.test(seriesUrl)) deferred.push({ seriesUrl, series });
          continue;
        }

        // The table is split two ways at once: Batting/Bowling, and a format tab
        // (ALL / T20 / ODI / Test / T10 / 100B). The default view shows only one
        // format, so a player's Test innings — three Duleep Trophy knocks, in the
        // case that exposed this — are invisible unless the Test tab is opened.
        for (const format of ['ALL', 'T20', 'ODI', 'Test', 'T10', '100B']) {
          // Target the tab itself (div.statsType). A bare text match hits the
          // series-card title "T20" first and silently never switches format.
          const fmtTab = page.locator('.statsType', { hasText: new RegExp(`^${format}$`) }).first();
          if (await fmtTab.count()) {
            await fmtTab.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(1300);
          } else if (format !== 'ALL') {
            continue;
          }

          for (const r of await readTable(page)) {
            const row = parseMatchRow({ ...r, series: seriesForDate(windows, r.date) ?? series });
            if (!row) continue;
            const k = `${row.fixture}|${row.date}`;
            // Batting and bowling arrive as separate rows for one innings; merge them.
            collected.set(k, { ...(collected.get(k) ?? {}), ...row });
          }
        }
      }
      }

      // Second pass: the series whose cards navigated away.
      for (const { seriesUrl, series } of deferred) {
        const side = await (await this.browser()).newPage({ userAgent: UA });
        try {
          for (const row of await readSeriesInnings(side, seriesUrl, slug, series)) {
            const k = `${row.fixture}|${row.date}`;
            collected.set(k, { ...(collected.get(k) ?? {}), ...row });
          }
        } catch {
          // a failed series must not lose the rest of the player's record
        } finally {
          await side.close().catch(() => {});
        }
      }

      const parsed = [...collected.values()];
      this.writeCache(key, parsed);
      await page.close();
      return parsed;
    } catch {
      await page.close().catch(() => {});
      return [...collected.values()];
    }
  }

  /** Politeness delay between page loads. */
  async pause() {
    await new Promise((r) => setTimeout(r, this.delayMs));
  }
}

/**
 * A player's innings in a series whose card navigates rather than expanding.
 *
 * The series page lists its matches; each scorecard carries every player's figures,
 * so the player's own rows are picked out by his slug. Cells are read as direct TD
 * children only — querying `td, div` picks up nested wrappers and returns duplicated
 * names and partnership scores ("70-2") rather than innings figures.
 */
async function readSeriesInnings(page, seriesUrl, slug, series, { maxMatches = 14 } = {}) {
  const out = [];
  let links = [];
  try {
    // The URL handed in is already the series' matches page, so appending
    // "/matches" again yields ".../matches/matches", which 404s silently.
    const base = seriesUrl.replace(/\/$/, '').replace(/\/matches$/, '');
    await page.goto(`${base}/matches`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(1600);
    links = await page.$$eval('a[href*="cricket-live-score"]', (as) =>
      [...new Set(as.map((a) => a.getAttribute('href')).filter(Boolean))]
    );
  } catch {
    return out;
  }

  const window = links.slice(0, maxMatches);
  for (let matchIndex = 0; matchIndex < window.length; matchIndex++) {
    const link = window[matchIndex];
    try {
      await page.goto(`https://crex.com${link.replace(/\/$/, '')}/match-scorecard`, {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      });
      await page.waitForTimeout(1300);

      const hit = await page.evaluate((want) => {
        // A match still in progress has no settled scorecard, and its rows carry
        // the wrong tournament context, so the whole page is skipped.
        const state = document.body.innerText.slice(0, 400);
        if (/\b(Live|Yet to bat|Innings Break|Match yet to begin|Starts in)\b/i.test(state)) {
          return { rows: [], date: null, title: document.title, live: true };
        }

        const rows = [];
        for (const tr of document.querySelectorAll('tr')) {
          const a = tr.querySelector(`a[href^="/player/${want}"]`);
          if (!a) continue;
          const cells = [...tr.children]
            .filter((c) => c.tagName === 'TD')
            .map((c) => c.textContent.replace(/\s+/g, ' ').trim());
          if (cells.length >= 4) rows.push(cells);
        }
        // The page carries the match date and the sides in plain text.
        const text = document.body.innerText;
        return {
          rows,
          date: text.match(/(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})/)?.[1] ?? null,
          title: document.title,
        };
      }, slug);

      if (!hit.rows.length) continue;

      // The title reads "England won by 4 wickets, England vs India 2nd-T20 Live
      // match Score" — the result comes first, so the fixture is the later clause.
      const fixture =
        hit.title.match(/([A-Za-z ]+ vs [A-Za-z ]+ \d+(?:st|nd|rd|th)-\w+)/)?.[1]?.trim() ||
        hit.title.split(/[,|]/).slice(1).join(',').trim().slice(0, 60) ||
        'match';
      const stage = hit.title.match(/(\d+(?:st|nd|rd|th))-(T20|ODI|Test)/i);
      // CREX prints no date on these scorecards and /match-info is forbidden, so a
      // row would otherwise be dropped for want of one. The series card does carry
      // the window ("Aug 23 - Sep 10") and matches are listed in order, so the date
      // is placed within it and flagged as approximate — losing a Duleep Trophy
      // semi-final entirely is worse than dating it to the right week.
      const printed = normaliseSeriesDate(hit.date);
      const date = printed ?? spreadOverWindow(series, matchIndex, window.length);
      const dateApprox = !printed;

      for (const cells of hit.rows) {
        const parsed = parseScorecardCells(cells);
        if (!parsed) continue;
        out.push({
          fixture,
          dateApprox,
          date,
          format: stage ? normaliseFormat(stage[2]) : 'Unknown',
          competition: series?.name ?? null,
          team: series?.playedFor ?? null,
          opponent: null,
          ...parsed,
          source: 'crex',
        });
      }
    } catch {
      // one unreadable scorecard should not end the series
    }
  }
  return out;
}

/**
 * Did this tournament finish before the cutoff?
 *
 * A card carries its window as "Jul 21 - Aug 16" with no year, so the year comes
 * from the tournament label. A card whose window cannot be read is never skipped:
 * losing a series costs more than re-reading one.
 */
export function seriesEndedBefore(series, cutoff) {
  if (!series?.to) return false;
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = String(series.to).match(/^([A-Z][a-z]{2})\s+(\d{1,2})$/);
  if (!m) return false;
  const mi = MON.indexOf(m[1]);
  if (mi < 0) return false;

  const year = String(series.name ?? '').match(/(20\d{2})/)?.[1];
  if (!year) return false;

  const end = `${year}-${String(mi + 1).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
  return end < cutoff;
}

/**
 * Place match `i` of `n` inside a series window. Used only when CREX publishes no
 * date for a scorecard; the row is flagged `dateApprox` so nothing downstream
 * treats it as exact.
 */
function spreadOverWindow(series, i, n) {
  if (!series?.from || !series?.to || !n) return null;
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parse = (x) => {
    const m = String(x).match(/^([A-Z][a-z]{2})\s+(\d{1,2})$/);
    if (!m) return null;
    const mi = MON.indexOf(m[1]);
    return mi < 0 ? null : { mi, d: +m[2] };
  };
  const a = parse(series.from);
  const b = parse(series.to);
  const year = String(series.name ?? '').match(/(20\d{2})/)?.[1];
  if (!a || !b || !year) return null;

  const start = Date.UTC(+year, a.mi, a.d);
  const end = Date.UTC(+year, b.mi, b.d);
  if (end < start) return null;
  const at = start + ((end - start) * (n === 1 ? 0 : i / (n - 1)));
  const d = new Date(at);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/**
 * Which tournament was running on this date? Cards carry a window ("Aug 23 - Sep
 * 10"), so a row read under one card but belonging to another is attributed by the
 * date it actually happened.
 */
function seriesForDate(windows, dayMonth) {
  if (!dayMonth) return null;
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parse = (x) => {
    const m = String(x ?? '').match(/^(\d{1,2})\s+([A-Z][a-z]{2})$|^([A-Z][a-z]{2})\s+(\d{1,2})$/);
    if (!m) return null;
    const day = m[1] ? +m[1] : +m[4];
    const mon = m[2] ?? m[3];
    const mi = MON.indexOf(mon);
    return mi < 0 ? null : mi * 31 + day;
  };
  const at = parse(dayMonth);
  if (at == null) return null;

  const hits = windows.filter((w) => {
    const a = parse(w.from);
    const b = parse(w.to);
    return a != null && b != null && at >= a && at <= b;
  });
  // Only when exactly one tournament was running; overlapping windows stay with
  // the card that produced the row.
  return hits.length === 1 ? hits[0] : null;
}

/** "11 Jul 2026" -> "11 Jul", matching the shape the player table returns. */
function normaliseSeriesDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})\s+([A-Z][a-z]{2})/);
  return m ? `${+m[1]} ${m[2]}` : null;
}

/**
 * Batting: [name + how out, runs, balls, 4s, 6s, SR]
 * Bowling: [name, overs, maidens, runs, wickets, econ]
 * The second cell tells them apart: an overs figure carries a decimal.
 */
export function parseScorecardCells(cells) {
  if (!Array.isArray(cells) || cells.length < 5) return null;
  const [who, a, b, c, d] = cells.map((x) => String(x ?? '').trim());

  if (/^\d+\.\d$/.test(a)) {
    if (!/^\d+$/.test(c) || !/^\d+$/.test(d)) return null;
    const [o, rem] = a.split('.');
    return { bowling: { overs: a, balls: +o * 6 + +rem, runs: +c, wickets: +d } };
  }

  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
  return { batting: { runs: +a, balls: +b, out: !/NOT OUT/i.test(who) } };
}

/**
 * Read the innings table as it currently stands.
 *
 * A match still being played is skipped. CREX shows those with the score cell
 * reading "Live", "Yet to bat" or similar, and an unfinished row cannot be trusted
 * anyway: its figures are partial and, worse, the tournament label attached to it
 * does not reliably belong to it — a live India–West Indies ODI came through
 * labelled "Punjab T20 2026".
 */
async function readTable(page) {
  return page.evaluate(() => {
    const UNFINISHED = /\b(live|yet to bat|innings break|stumps|rain|delay|abandon|no result|upcoming|starts|vs\s*$)\b/i;
    const out = [];
    for (const tr of document.querySelectorAll('tr.tableClr')) {
      const cells = [...tr.querySelectorAll('td')].map((td) =>
        td.textContent.replace(/\s+/g, ' ').trim()
      );
      if (cells.length < 3) continue;
      const [match, date, score] = cells;
      if (!match || !score) continue;
      if (UNFINISHED.test(score) || UNFINISHED.test(match)) continue;
      // A completed innings always reports a figure: "34 (15)", "2-23" or "dnb".
      if (!/^\d+\*?\s*\(\d+\)$|^\d+\s*[-/]\s*\d+$|^(dnb|did not bat|-)$/i.test(score)) continue;
      out.push({ match, date, score });
    }
    return out;
  });
}

/**
 * A tournament card reads "IPL 2026Mar 28 - May 31Played for RR".
 * The competition name and the side the player turned out for both matter: the
 * latter is how a franchise is attached to an innings.
 */
export function parseSeriesCard(label) {
  // Anchor on the date *window* ("Apr 3 - Sep 27"), not on the first month-like
  // word: a tournament called "County Div-Two 2026" contains "Two 2026", which
  // looks like a month and a day, and truncates the name to "County Div-".
  const name =
    label.match(/^(.+?)(?=[A-Z][a-z]{2}\s+\d{1,2}\s*-\s*[A-Z][a-z]{2}\s+\d{1,2})/)?.[1]?.trim() ??
    label.match(/^(.+?)(?=[A-Z][a-z]{2}\s\d)/)?.[1]?.trim() ??
    label.slice(0, 40).trim();
  const played = label.match(/Played for\s+([A-Z]{2,4})/)?.[1] ?? null;
  const span = label.match(/([A-Z][a-z]{2}\s\d{1,2})\s*-\s*([A-Z][a-z]{2}\s\d{1,2})/);
  return { name, playedFor: played, from: span?.[1] ?? null, to: span?.[2] ?? null };
}

/**
 * Parse one innings row.
 *
 * `match` looks like "69th T20 vs RR", "1st ODI vs AUS" or "3rd Test, 1st Inn".
 * `score` is a batting figure "34 (15)" / "34* (15)", or a bowling figure "2-23".
 * The bowling view uses a hyphen, not the slash used elsewhere on the site.
 */
export function parseMatchRow({ match, date, score, series }) {
  if (!match || !score) return null;

  const vs = match.match(/\bvs\s+(.+)$/i);
  const fmt = match.match(/\b(T20|ODI|Test|T10|100B|First Class|List A)\b/i);

  const row = {
    fixture: match,
    opponent: vs?.[1]?.trim() ?? null,
    format: normaliseFormat(fmt?.[1]),
    date: date ?? null,
    competition: series?.name ?? null,
    team: series?.playedFor ?? null,
    source: 'crex',
  };

  const bat = score.match(/^(\d+)(\*?)\s*\((\d+)\)$/);
  if (bat) {
    row.batting = { runs: +bat[1], out: bat[2] !== '*', balls: +bat[3] };
    return row;
  }

  // "2-23" (bowling view) and "2/23" both occur.
  const bowl = score.match(/^(\d+)\s*[-/]\s*(\d+)$/);
  if (bowl) {
    row.bowling = { wickets: +bowl[1], runs: +bowl[2] };
    return row;
  }

  if (/^(dnb|did not bat|-)$/i.test(score)) return row;

  row.note = score;
  return row;
}

function normaliseFormat(f) {
  if (!f) return 'Unknown';
  const t = f.toUpperCase();
  if (t === 'T20' || t === 'IT20') return 'T20';
  if (t === 'ODI' || t === 'LIST A') return 'ODI';
  if (t === 'TEST' || t === 'FIRST CLASS') return 'Test';
  return f;
}
