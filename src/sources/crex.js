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
 * Everything is read from the player's own page. Match scorecards are not visited at
 * all: selecting each series card re-renders the innings table in place, which gives
 * the same figures in one page load per player instead of dozens.
 *
 * Rules this adapter follows, because it is the only source the site has:
 *   - every fetch is cached to disk; a run re-reads cache rather than re-fetching
 *   - failures are contained: a scrape error degrades one player, never the build
 *   - requests are rate-limited, and run at a small fixed concurrency
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Source } from './source.js';
import { parseMatchDay } from './crex-match-day.js';

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

  /**
   * Chromium occasionally declines to exit after a long run of page opens, which
   * leaves a finished scrape hanging with its data already written. The close is
   * given a few seconds and then abandoned; the caller's work is done either way.
   */
  async close() {
    const b = this._browser;
    this._browser = null;
    if (!b) return;

    // A graceful close is tried first, but it cannot be the last word: Chromium
    // sometimes declines to exit after a long run of page opens, and simply giving up
    // waiting leaves the process alive. Node then keeps running with an open child
    // handle, so the scrape prints its summary and hangs forever — harmless at a
    // terminal where it can be killed, fatal in CI where the step sits until the job
    // times out. If the close does not land, the process is killed outright.
    const closed = await Promise.race([
      b.close().then(() => true).catch(() => true),
      new Promise((r) => setTimeout(() => r(false), 8000)),
    ]);
    if (closed) return;

    try {
      // Playwright keeps the browser's own process handle; SIGKILL it directly.
      b.process()?.kill('SIGKILL');
    } catch {
      // Nothing further can be done, and the caller's work is already saved.
    }
  }

  cachePath(key) {
    mkdirSync(CACHE_DIR, { recursive: true });
    return join(CACHE_DIR, `${key.replace(/[^\w.-]/g, '_')}.json`);
  }

  /**
   * `maxAgeMs` of 0 means "do not use the cache at all", so it is compared as a
   * number rather than for truthiness. Treating 0 as falsy skipped the expiry check
   * and returned the stored copy unconditionally, which made every re-scrape and
   * every verification silently read cache: a player whose fetch had once failed
   * kept serving back the empty result that failure wrote.
   */
  readCache(key, maxAgeMs) {
    if (maxAgeMs === 0) return null;
    const f = this.cachePath(key);
    if (!existsSync(f)) return null;
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (maxAgeMs != null && Date.now() - raw.at > maxAgeMs) return null;
    return raw.data;
  }

  writeCache(key, data) {
    writeFileSync(this.cachePath(key), JSON.stringify({ at: Date.now(), data }));
  }

  /**
   * The day state of one match: which day of play it is on, and the match's span.
   *
   * This is the only CREX page that can date an innings of a Test. The player page
   * stamps all four innings with the match's start date, and the scorecard carries no
   * day, session or stumps marker at all — so a multi-day innings can only be placed
   * by reading the match page while the match is being played, where the day is
   * printed as `.day-session`.
   *
   * Fetched with plain HTTP rather than through Playwright: the markup needed is
   * server-rendered, so a browser context per match would cost seconds each for
   * nothing. Cached by match id, which is stable, and re-read while the match is live
   * because the whole point is the figure as it stands today.
   */
  async fetchMatchDay(matchId, { maxAgeMs = 3600e3 } = {}) {
    const key = `matchday_${matchId}`;
    const cached = this.readCache(key, maxAgeMs);
    // A finished match can never change again, so its cache never expires. A live one
    // is re-read every run.
    if (cached && cached.status === 'Finished') return cached;
    if (cached && maxAgeMs !== 0) return cached;

    try {
      const res = await fetch(
        `https://crex.com/scoreboard/${matchId}/match-scorecard`,
        { headers: { 'User-Agent': UA }, redirect: 'follow' }
      );
      if (!res.ok) return cached ?? { matchId, error: `http ${res.status}` };
      const data = { matchId, ...parseMatchDay(await res.text()) };
      this.writeCache(key, data);
      return data;
    } catch (err) {
      // A match whose day cannot be read keeps whatever the store already knows;
      // the innings still reaches the site under the match's start date.
      return cached ?? { matchId, error: String(err?.message ?? err).slice(0, 120) };
    }
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
   * The matches page opens on the most recent tournament only. The rest sit behind
   * the series cards in the left-hand list, and reaching them turns on two details
   * that cost a long time to find:
   *
   *   - Click the card's date line (`.seriesDesc`), never the series name. The name
   *     is a link to the series page, and following it abandons the table. The date
   *     line is the card's own handler and swaps the panel in place.
   *   - Select cards from the Batting view. The series list is per-discipline, so a
   *     player who has never bowled has no list at all under Bowling.
   *
   * With both right, Buttler goes from 5 innings to 23 and Tilak Varma's three Duleep
   * Trophy innings appear. Bowling figures and the format split come from the tab
   * sweep that runs first; the card walk fills in the tournaments it could not see.
   */
  async fetchMatches(slug, { maxAgeMs = 6 * 3600e3, since = null } = {}) {
    const key = `matches_${slug}_all`;
    const today = new Date().toISOString().slice(0, 10);
    const cached = this.readCache(key, maxAgeMs);
    // A cached read is reused unless it may hold a figure from a match that had not
    // finished when it was taken. Those are re-fetched every run until the figure can
    // no longer change: Mukesh Kumar was stored at "84 (102)" during an innings he
    // finished on 0 (0), and without this he would carry that score for the five days
    // of the match.
    //
    // The test is the row's own date, not its `provisional` flag. A flag is only
    // present if the code that wrote the cache knew to set one, so trusting it would
    // mean rows cached before this existed could never refresh themselves — exactly
    // what left Rishabh Pant and five others unmarked in the same Irani Cup match
    // that Mukesh Kumar was marked in. A date is written by every version.
    //
    // Multi-day cricket is the reason for the window rather than just "today": a Test
    // innings begun four days ago can still be in progress now.
    if (cached && !cached.some((r) => mayStillChange(r, today))) return cached;

    // The series list renders as a side panel only at desktop width.
    const page = await (await this.browser()).newPage({
      userAgent: UA,
      viewport: { width: 1600, height: 1000 },
    });
    const collected = new Map();

    try {
      await page.goto(`https://crex.com/player/${slug}/matches`, {
        waitUntil: 'networkidle',
        timeout: 45000,
      });
      await page.waitForTimeout(2400);

      // Everything comes off the player page. The innings table is split two ways —
      // Batting/Bowling, and a format tab (ALL / T20 / ODI / Test / T10 / 100B) —
      // and walking those six tabs in both disciplines yields every innings CREX
      // holds, bowling figures included.
      //
      // The table opens on one tournament, so the other series cards are selected
      // in turn afterwards to reach the rest.
      const cardWindows = new Map();

      for (const discipline of ['Batting', 'Bowling']) {
        const dTab = page.locator(`text="${discipline}"`).first();
        if (await dTab.count()) {
          await dTab.click({ timeout: 6000 }).catch(() => {});
          await page.waitForTimeout(1600);
        }

        // Card labels differ per discipline: a tournament a player only bowled in
        // has no card under Batting.
        for (const label of await page.$$eval('.sCard', (cs) =>
          cs.map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim())
        )) {
          const w = parseSeriesCard(label);
          if (w?.name && !cardWindows.has(w.name)) cardWindows.set(w.name, w);
        }

        const windows = [...cardWindows.values()].filter(
          (w) => !since || !seriesEndedBefore(w, since)
        );

        for (const format of ['ALL', 'T20', 'ODI', 'Test', 'T10', '100B']) {
          const fmtTab = page
            .locator('.statsType', { hasText: new RegExp(`^${format}$`) })
            .first();
          if (await fmtTab.count()) {
            await fmtTab.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(1300);
          } else if (format !== 'ALL') {
            continue;
          }

          for (const r of await readTable(page)) {
            const series = seriesForDate(windows, r.date);
            const row = parseMatchRow({ ...r, series });
            if (!row) continue;
            if (figureMayBeLive(row, today)) row.provisional = true;
            // Without a tournament the row cannot be placed or dated; drop it
            // rather than attribute it to whatever was selected.
            if (!row.competition) continue;
            const k = `${row.fixture}|${row.date}`;
            // Batting and bowling arrive as separate rows for one innings.
            collected.set(k, { ...(collected.get(k) ?? {}), ...row });
          }
        }
      }

      // The tab sweep above only shows whichever tournament the table opens on.
      // The rest are reached by selecting each series in the left-hand list.
      //
      // The click target matters: the series *name* is a link and navigates to the
      // series page, losing the table. The date line beneath it (.seriesDesc) is
      // part of the card's own handler and swaps the panel in place, which is what
      // a reader does by hand. Clicking the name is why The Hundred and the England
      // tour kept coming back empty.
      const windows = [...cardWindows.values()].filter(
        (w) => !since || !seriesEndedBefore(w, since)
      );

      for (const w of windows) {
        try {
          // The format tabs are left on whichever one the sweep above finished on,
          // which would filter the card's table down to that one format. Back to ALL.
          const allTab = page.locator('.statsType', { hasText: /^ALL$/ }).first();
          if (await allTab.count()) {
            await allTab.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(1100);
          }

          // Selecting a card is done from the Batting view. The sweep above ends on
          // Bowling, where a pure batsman has no series list at all — which is why
          // every card lookup was coming back missing.
          const batTab = page.locator('text="Batting"').first();
          if (await batTab.count()) {
            await batTab.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(1200);
          }

          const cards = page.locator('.seriesLeftCard');
          const labels = await cards.evaluateAll((els) =>
            els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
          );
          const idx = labels.findIndex((l) => l.startsWith(w.name));
          if (idx < 0) continue;

          const desc = cards.nth(idx).locator('.seriesDesc').first();
          if (!(await desc.count())) continue;

          const snapshot = async () =>
            (await page
              .$$eval('tr.tableClr', (trs) =>
                trs.map((tr) => (tr.textContent || '').replace(/\s+/g, ' ').trim()).join('|')
              )
              .catch(() => '')) ?? '';

          // Park on a different card first, so selecting the target is always a real
          // transition. Without this the wait below cannot tell "already showing this
          // tournament" from "click ignored, still showing the previous one" — and the
          // Sri Lanka card is the one Will Jacks's page opens on, so its rows sat in
          // the table while every later card claimed them in turn.
          if ((await cards.count()) > 1) {
            const other = cards.nth(idx === 0 ? 1 : 0).locator('.seriesDesc').first();
            if (await other.count()) {
              await other.click({ timeout: 8000 }).catch(() => {});
              await page.waitForTimeout(1600);
            }
          }

          // Captured after parking, so it is the *other* card's table we compare against.
          const before = await snapshot();

          await desc.click({ timeout: 8000 });
          await page.waitForTimeout(1900);

          // Wait for the *table* to change before believing it belongs to this card.
          //
          // Watching the card's own selected state is not enough: CREX moves .sSelect
          // the instant it is clicked while the innings table is still the previous
          // tournament's, so every card in turn appeared to settle and each one stamped
          // its name onto the same Sri Lanka rows. The last card processed won, which
          // is how Will Jacks's England ODIs ended up filed under "County Div-One 2026"
          // for Surrey. The county season runs Apr 3 - Sep 27 and overlaps the whole
          // tour, so nothing downstream could have caught it by date.
          //
          // The table's own fingerprint is the honest signal, so wait for it to differ
          // from the one before the click.
          let settled = false;
          for (let attempt = 0; attempt < 4; attempt++) {
            if ((await snapshot()) !== before) {
              settled = true;
              break;
            }
            await page.waitForTimeout(1200);
          }
          // "Unchanged" is ambiguous on its own — the card may already have been the
          // selected one, which is the normal case for whichever tournament the page
          // opened on. Confirm against the card CREX marks as selected before giving
          // up, so the opening tournament is not skipped.
          if (!settled) {
            const active =
              (await page.locator('.seriesLeftCard.sSelect').first().textContent().catch(() => '')) ??
              '';
            settled = active.replace(/\s+/g, ' ').trim().startsWith(w.name);
          }
          if (!settled) continue;

          // A stray navigation still means the panel is gone; go back and move on.
          if (!page.url().includes(`/player/${slug}`)) {
            await page.goto(`https://crex.com/player/${slug}/matches`, {
              waitUntil: 'domcontentloaded',
              timeout: 30000,
            });
            await page.waitForTimeout(1600);
            continue;
          }

          // Both disciplines are read, because a card's batting and bowling tables are
          // different lists and the sweep cannot place these rows: where two windows
          // overlap — a county season running Apr 3 - Sep 27 across an England tour —
          // it refuses to guess and drops them, so this walk is the only chance to see
          // Jacks's 5/22 against Sri Lanka.
          //
          // The discipline tab re-renders the table back to the default tournament, so
          // the card has to be selected again after switching. Skipping that is what
          // filed those Sri Lanka innings under "County Div-One 2026".
          for (const discipline of ['Batting', 'Bowling']) {
            const dTab = page.locator(`text="${discipline}"`).first();
            if (await dTab.count()) {
              await dTab.click({ timeout: 5000 }).catch(() => {});
              await page.waitForTimeout(1300);

              // Re-select, and only trust the table once CREX marks this card active.
              const again = page
                .locator('.seriesLeftCard')
                .filter({ hasText: w.name })
                .first()
                .locator('.seriesDesc')
                .first();
              if (!(await again.count())) continue;
              await again.click({ timeout: 8000 }).catch(() => {});
              await page.waitForTimeout(1600);

              const active =
                (await page
                  .locator('.seriesLeftCard.sSelect')
                  .first()
                  .textContent()
                  .catch(() => '')) ?? '';
              if (!active.replace(/\s+/g, ' ').trim().startsWith(w.name)) continue;
            }

            for (const r of await readTable(page)) {
              // The card that was just selected is what the panel is showing, so it
              // names the tournament outright — no date lookup is wanted here.
              //
              // Deferring to `seriesForDate` was wrong for exactly the case it looks
              // designed for: a county season runs Apr 3 - Sep 27 and therefore
              // contains every touring date inside it, so Will Jacks's England ODIs
              // against Sri Lanka came back as "County Div-One 2026", played for SUR.
              const row = parseMatchRow({ ...r, series: w });
              if (!row?.competition) continue;
              // A match still being played can print a figure that is not the
              // player's final one for the innings — the score on the board at the
              // moment the page was read. Mark it so the next run replaces it.
              if (figureMayBeLive(row, today)) row.provisional = true;
              const k = `${row.fixture}|${row.date}`;
              collected.set(k, { ...(collected.get(k) ?? {}), ...row });
            }
          }
        } catch {
          // one unreadable card must not lose the player's other tournaments
        }
      }

      const parsed = [...collected.values()];
      this.writeCache(key, parsed);
      await page.close();
      return parsed;
    } catch (err) {
      // A partial read is still worth keeping, but the reason must not vanish: a
      // swallowed error here once let a run report "259 players, 0 failed" while 71
      // of them — Riyan Parag, Archer, Rahane, Shreyas Iyer — came back empty.
      await page.close().catch(() => {});
      if (!collected.size) throw err;
      return [...collected.values()];
    }
  }

  /** Politeness delay between page loads. */
  async pause() {
    await new Promise((r) => setTimeout(r, this.delayMs));
  }
}

/**
 * Should a cached read be thrown away and fetched again?
 *
 * Yes while the row is marked provisional, and yes for a figure recent enough to
 * still be an innings in progress — the second half matters because a row cached
 * before the flag existed carries no flag, and would otherwise never refresh.
 */
function mayStillChange(row, today) {
  return Boolean(row?.provisional) || figureMayBeLive(row, today);
}

/**
 * Might this figure still change?
 *
 * Only the match's own date decides it. Keying off the tournament's window instead
 * marked every innings in a competition that happened to still be running, so a
 * three-week tour flagged all forty-one of its rows — including matches played a
 * fortnight earlier and long since finished — and the page showed LIVE against
 * almost everything.
 *
 * A Test can run five days, so a figure dated within that span may still be an
 * innings in progress; anything older has been played out. One day either side of
 * the comparison is cheap, and the cost of being wrong is one extra page load
 * against a score frozen half-finished for days.
 */
export function figureMayBeLive(row, today) {
  const d = isoFromRow(row.date, row.competition, today);
  if (!d || d > today) return false;

  // How long the figure can still move depends on the format. A limited-overs match
  // is settled the day it is played, so only today's rows are uncertain. A Test runs
  // to five days, and an innings begun on day one is still being added to on day
  // four, so those stay open for the length of the match.
  //
  // Treating every format as multi-day flagged 95 rows, T20s from a fortnight
  // earlier among them, and the page showed LIVE against almost everything.
  const multiDay = /test|first class|fc|unofficial test/i.test(String(row.format ?? ''));
  const span = multiDay ? 5 : 1;
  const earliest = new Date(Date.parse(today) - (span - 1) * 864e5).toISOString().slice(0, 10);
  return d >= earliest;
}

/** CREX prints "1 Oct" with no year; pick the year that lands nearest to today. */
function isoFromRow(dayMonth, competition, today) {
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = String(dayMonth ?? '').match(/^(\d{1,2})\s+([A-Z][a-z]{2})$/);
  if (!m) return /^\d{4}-\d{2}-\d{2}$/.test(String(dayMonth)) ? String(dayMonth) : null;
  const mi = MON.indexOf(m[2]);
  if (mi < 0) return null;
  const day = String(+m[1]).padStart(2, '0');
  const mon = String(mi + 1).padStart(2, '0');
  const y = +today.slice(0, 4);
  return [y - 1, y, y + 1]
    .map((yy) => `${yy}-${mon}-${day}`)
    .sort((a, b) => Math.abs(Date.parse(a) - Date.parse(today)) - Math.abs(Date.parse(b) - Date.parse(today)))[0];
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
      // The last cell is a "View >" link to the match itself, carrying CREX's stable
      // match id. It is the only thing on this page that identifies the *match*
      // rather than the innings, which is what makes a Test's calendar days
      // reachable — every innings of a Test is printed under the match's start date,
      // so the match page is the only place the day can be read.
      const href = tr.querySelector('a[href*="match-updates-"]')?.getAttribute('href') ?? '';
      out.push({ match, date, score, href });
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
  const raw =
    label.match(/^(.+?)(?=[A-Z][a-z]{2}\s+\d{1,2}\s*-\s*[A-Z][a-z]{2}\s+\d{1,2})/)?.[1]?.trim() ??
    label.match(/^(.+?)(?=[A-Z][a-z]{2}\s\d)/)?.[1]?.trim() ??
    label.slice(0, 40).trim();

  // A card that renders its dates but not its title leaves the window itself as the
  // "name" — "Mar 22 -". That is not a tournament, and a row carrying it would be
  // filed under a competition no one can recognise, so report no name and let the
  // caller drop the row instead.
  const name = /^[A-Z][a-z]{2}\s+\d{1,2}\s*-?\s*$/.test(raw) || !raw ? null : raw;
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
export function parseMatchRow({ match, date, score, series, href }) {
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

  // The match id, where the row carried a link. Multi-day formats need it to find
  // which calendar day an innings belongs to; for everything else it is simply a
  // stable key for the match.
  const mid = String(href ?? '').match(/match-updates-([A-Za-z0-9]+)/);
  if (mid) row.matchId = mid[1];
  // "1st Inn" / "2nd Inn" distinguishes the two innings of one Test for one player,
  // and is the only part of the fixture string that varies between them.
  const inn = match.match(/,\s*(\d)(?:st|nd|rd|th)\s*Inn/i);
  if (inn) row.innings = +inn[1];

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
