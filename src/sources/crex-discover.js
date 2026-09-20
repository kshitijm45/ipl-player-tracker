/**
 * CREX slug discovery.
 *
 * CREX has no public search (it 403s) and its team pages only carry a fixed
 * "popular players" rail, so slugs cannot be looked up directly. Scorecards can:
 * every player in a match is linked as `/player/<name>-<code>` with their full
 * display name as the link text. Walking IPL scorecards therefore yields both the
 * slug and the common name ("Dasun Shanaka") for everyone who played.
 *
 * The output is a name -> {slug, displayName} map that gets pinned to canonical
 * Cricsheet ids, so CREX never has to be name-matched at scrape time.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUT = new URL('../../data/crex-players.json', import.meta.url).pathname;

/**
 * Scorecard link text carries UI decoration around the name: role markers "(C)",
 * "(WK)", the "IMPACT" substitute badge, and trailing stat labels. Strip all of it
 * so what remains is the name a fan would recognise.
 */
export function cleanLinkName(raw) {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/Avg:.*$/i, '').replace(/SR:.*$/i, '');
  // The badge is glued straight onto the name in the markup ("Dasun ShanakaIMPACT"),
  // so it needs stripping without a word boundary — with one, it survives and every
  // later name comparison against it fails.
  s = s.replace(/IMPACT/gi, '');
  s = s.replace(/\((?:C|WK|C\s*&\s*WK|VC)\)/gi, '');
  // News/teaser links ("Hardik Pandya's IPL trade") are not scorecard entries.
  if (/['’]s\s/.test(s)) return '';
  return s.replace(/\s+/g, ' ').trim();
}

/** A slug is `some-name-CODE`; the code is the stable part. */
export function slugCode(slug) {
  const m = slug.match(/-([A-Z0-9]{2,4})$/);
  return m?.[1] ?? null;
}

export async function discoverFromSeries({
  seriesUrls,
  maxMatches = 40,
  delayMs = 2500,
  existing = loadCrexPlayers(),
} = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('crex-discover: playwright required. `npm i playwright && npx playwright install chromium`');
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: UA });
  const found = new Map(Object.entries(existing.bySlug ?? {}));
  let scanned = 0;

  try {
    for (const seriesUrl of seriesUrls) {
      const matchLinks = await collectMatchLinks(page, seriesUrl);

      for (const link of matchLinks.slice(0, maxMatches)) {
        if (scanned >= maxMatches) break;
        const url = `https://crex.com${link.replace(/\/$/, '')}/match-scorecard`;
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
          await page.waitForTimeout(2200);

          const players = await page.$$eval('a[href^="/player/"]', (as) =>
            as.map((a) => ({
              href: a.getAttribute('href'),
              text: (a.textContent || '').trim(),
            }))
          );

          for (const p of players) {
            const slug = p.href.replace(/^\/player\//, '').replace(/\/.*$/, '');
            if (!slug) continue;
            const name = cleanLinkName(p.text);
            // Prefer the longest name seen: scorecards abbreviate inconsistently,
            // and the fullest form is the one fans recognise.
            const prev = found.get(slug);
            if (!prev || (name.length > (prev.displayName ?? '').length && name.includes(' '))) {
              found.set(slug, { slug, code: slugCode(slug), displayName: name || prev?.displayName });
            }
          }
          scanned++;
        } catch {
          // A single unreadable scorecard must not end discovery.
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  } finally {
    await browser.close();
  }

  const bySlug = Object.fromEntries(found);
  saveCrexPlayers({ ...existing, bySlug, lastDiscovered: new Date().toISOString() });
  return { discovered: found.size, scanned };
}

async function collectMatchLinks(page, seriesUrl) {
  await page.goto(seriesUrl, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2000);
  return page.$$eval('a[href*="cricket-live-score"]', (as) =>
    [...new Set(as.map((a) => a.getAttribute('href')).filter(Boolean))]
  );
}

export function loadCrexPlayers(path = OUT) {
  if (!existsSync(path)) return { bySlug: {}, pins: {} };
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveCrexPlayers(data, path = OUT) {
  mkdirSync(new URL('.', `file://${path}`).pathname, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
