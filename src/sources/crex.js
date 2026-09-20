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
  async fetchMatches(slug, { maxAgeMs = 6 * 3600e3, maxSeries = 12 } = {}) {
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

      // Read every card's label up front. Clicking one re-renders the list, which
      // detaches the remaining handles — so labels must be captured before the
      // first click, not lazily as each card is visited.
      const labels = await page.$$eval('.sCard', (cards) =>
        cards.map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim())
      );
      const cardCount = Math.min(labels.length, maxSeries);

      for (let i = 0; i < cardCount; i++) {
        const series = parseSeriesCard(labels[i]);

        // Some cards re-render the table in place; others navigate to the series
        // page and abandon the player context. Returning to the player page before
        // each click makes the two behave the same, at the cost of a reload.
        if (i > 0) {
          try {
            await page.goto(`https://crex.com/player/${slug}/matches`, {
              waitUntil: 'domcontentloaded',
              timeout: 40000,
            });
            await page.waitForTimeout(1600);
          } catch {
            break;
          }
        }

        try {
          await page.locator('.sCard').nth(i).click({ timeout: 8000 });
          await page.waitForTimeout(1800);
        } catch {
          continue;
        }

        // A click that left the player page cannot yield player innings.
        if (!page.url().includes(`/player/${slug}`)) continue;

        for (const view of ['Batting', 'Bowling']) {
          const tab = page.locator(`text="${view}"`).first();
          if (await tab.count()) {
            await tab.click({ timeout: 6000 }).catch(() => {});
            await page.waitForTimeout(1400);
          }
          for (const r of await readTable(page)) {
            const row = parseMatchRow({ ...r, series });
            if (!row) continue;
            const k = `${row.fixture}|${row.date}`;
            // Merge the batting and bowling views of the same innings.
            collected.set(k, { ...(collected.get(k) ?? {}), ...row });
          }
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

/** Read the innings table as it currently stands. */
async function readTable(page) {
  return page.evaluate(() => {
    const out = [];
    for (const tr of document.querySelectorAll('tr.tableClr')) {
      const cells = [...tr.querySelectorAll('td')].map((td) =>
        td.textContent.replace(/\s+/g, ' ').trim()
      );
      if (cells.length < 3) continue;
      const [match, date, score] = cells;
      if (!match || !score) continue;
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
  const name = label.match(/^(.+?)(?=[A-Z][a-z]{2}\s\d)/)?.[1]?.trim() ?? label.slice(0, 40).trim();
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
