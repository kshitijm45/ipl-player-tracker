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
   * Recent innings for a player, already split by format on the page.
   * Returns rows shaped like { format, competition, date, opponent, score, ... }.
   */
  async fetchMatches(slug, { format = 'ALL', maxAgeMs = 6 * 3600e3 } = {}) {
    const key = `matches_${slug}_${format}`;
    const cached = this.readCache(key, maxAgeMs);
    if (cached) return cached;

    const page = await (await this.browser()).newPage({ userAgent: UA });
    try {
      await page.goto(`https://crex.com/player/${slug}/matches`, {
        waitUntil: 'networkidle',
        timeout: 45000,
      });
      await page.waitForTimeout(2200);

      if (format !== 'ALL') {
        const tab = page.locator(`text="${format}"`).first();
        if (await tab.count()) {
          await tab.click().catch(() => {});
          await page.waitForTimeout(1800);
        }
      }

      const rows = await page.evaluate(() => {
        const out = [];
        for (const tr of document.querySelectorAll('tr.tableClr')) {
          const cells = [...tr.querySelectorAll('td')].map((td) =>
            td.textContent.replace(/\s+/g, ' ').trim()
          );
          if (cells.length < 3) continue;
          const [match, date, score] = cells;
          if (!match || !/\(\d+\)|\/|\d/.test(score ?? '')) continue;
          out.push({ match, date, score });
        }
        return out;
      });

      const parsed = rows.map((r) => parseMatchRow(r)).filter(Boolean);
      this.writeCache(key, parsed);
      await page.close();
      return parsed;
    } catch (err) {
      await page.close().catch(() => {});
      return [];
    }
  }

  /** Politeness delay between page loads. */
  async pause() {
    await new Promise((r) => setTimeout(r, this.delayMs));
  }
}

/**
 * Parse one match row.
 *
 * `match` looks like "69th T20 vs RR" or "1st ODI vs AUS"; `score` is a batting figure
 * "34 (15)" / "34* (15)" or a bowling figure "2/31".
 */
export function parseMatchRow({ match, date, score }) {
  if (!match || !score) return null;

  const vs = match.match(/\bvs\s+(.+)$/i);
  const fmt = match.match(/\b(T20|ODI|Test|T10|100B|First Class|List A)\b/i);

  const row = {
    fixture: match,
    opponent: vs?.[1]?.trim() ?? null,
    format: normaliseFormat(fmt?.[1]),
    date: date ?? null,
    source: 'crex',
  };

  const bat = score.match(/^(\d+)(\*?)\s*\((\d+)\)$/);
  if (bat) {
    row.batting = { runs: +bat[1], out: bat[2] !== '*', balls: +bat[3] };
    return row;
  }

  const bowl = score.match(/^(\d+)\/(\d+)$/);
  if (bowl) {
    row.bowling = { wickets: +bowl[1], runs: +bowl[2] };
    return row;
  }

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
