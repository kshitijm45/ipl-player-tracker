/**
 * What the tracked players are playing in the next two days.
 *
 * Everything here is read from CREX and joined on identifiers CREX itself assigns.
 * Nothing is inferred from the shape of a name.
 *
 * Two pages carry it all:
 *
 *   /schedule
 *     Every fixture in world cricket for today and tomorrow, as `.match-card-container`
 *     elements under a date heading. Each card links to its match page, and that link
 *     encodes the side codes, the stage, the competition and a stable match id:
 *
 *       /cricket-live-score/rno-vs-tus-14th-match-csa-pro-t20-cup-2026-match-updates-14IM
 *                           ^^^    ^^^  ^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^      ^^^^
 *
 *   the match page
 *     Lists both squads as `.playingxi-card-row` rows of `/player/<slug>` links —
 *     the same slugs this project pins its players by.
 *
 * That second page is what makes a new tournament work. A player picked for a
 * competition he has never appeared in has no history to match on, so an approach
 * built on past appearances could never find him; his slug is on the match page from
 * the moment the squad is announced.
 *
 * It also replaces the guesswork this file used to do. Fixtures were parsed out of
 * `body.innerText` by counting lines around a kick-off time, which left every team
 * name empty, and players were attached by asking whether "JKM" looked like a short
 * form of "Jamaica Kingsmen". Both are gone: the fields are read from the DOM, and a
 * player is attached only when CREX's own slug matches one this project pins.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUT = new URL('../site/data/fixtures.json', import.meta.url).pathname;
const PINS = new URL('../data/crex-players.json', import.meta.url).pathname;
const CACHE_DIR = new URL('../data/cache/crex', import.meta.url).pathname;

/** A card showing any of these is under way or over, so it is not a fixture. */
const NOT_UPCOMING = /\b(live|won by|won|tie|abandon|no result|stumps|innings break|yet to bat)\b/i;

/** Squads are not announced for a knockout whose teams are still to be decided. */
const TBC = /\bTBC\b|^Team \d/i;

export async function scrapeFixtures({ days = 2, squads = true, maxAgeMs = 3 * 3600e3 } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('ingest-fixtures: playwright required.');
  }

  const browser = await chromium.launch();
  // The schedule renders its cards at desktop width, as the player pages do.
  const page = await browser.newPage({ userAgent: UA, viewport: { width: 1600, height: 1000 } });

  try {
    await page.goto('https://crex.com/schedule', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2800);

    // Walk the document in order so each card takes the date heading above it. The
    // heading is a leaf element ("Fri, 2 Oct 2026"); the cards follow it.
    const raw = await page.evaluate(() => {
      const out = [];
      let heading = null;
      for (const el of document.querySelectorAll('*')) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (
          el.children.length === 0 &&
          /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+\w{3}\s+\d{4}$/.test(text)
        ) {
          heading = text;
          continue;
        }
        if (!el.classList.contains('match-card-container')) continue;
        out.push({
          heading,
          text,
          link:
            el.querySelector('a')?.getAttribute('href') ??
            el.closest('a')?.getAttribute('href') ??
            null,
          teams: [...el.querySelectorAll('.team-name')].map((t) =>
            (t.textContent || '').replace(/\s+/g, ' ').trim()
          ),
        });
      }
      return out;
    });

    // IST, not UTC. The job is scheduled for 00:07 IST but GitHub's cron queue is
    // best-effort and has started it as late as 03:23 IST, and for the whole of that
    // window the UTC date is still yesterday — so a UTC `today` published yesterday's
    // fixtures, finished matches included, as the ones coming up. `build-index` and
    // the ingest's `observedOn` were moved to IST for exactly this reason; this was
    // the one place left reading the clock in UTC.
    const today = istDate();
    const horizon = istDate((days - 1) * 864e5);

    const fixtures = [];
    for (const r of raw) {
      if (!r.link || r.teams.length < 2) continue;
      // A match in progress or finished is not something to look forward to.
      if (NOT_UPCOMING.test(r.text)) continue;

      const date = isoDate(r.heading);
      if (!date || date < today || date > horizon) continue;

      const parsed = parseMatchLink(r.link);
      if (!parsed) continue;

      fixtures.push({
        id: parsed.id,
        date,
        time: r.text.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i)?.[1] ?? null,
        teamA: r.teams[0],
        teamB: r.teams[1],
        // The side codes come out of CREX's own URL, so they are the same tokens the
        // scorecards use. Their order is not the display order, though: the URL lists
        // them alphabetically, so "Sharjah v Fujairah" arrives as "fuj-vs-sha". They
        // are therefore matched to the names rather than zipped by position, which had
        // Indian players appearing under "Pakistan".
        ...orderCodes(parsed.codes, r.teams[0], r.teams[1]),
        stage: parsed.stage,
        competition: r.text.match(/,\s*([^,]+?\s*20\d{2}[^,]*?)(?=\s*[A-Z]|$)/)?.[1]?.trim() ?? null,
        url: `https://crex.com${r.link}`,
        players: [],
        squadKnown: false,
      });
    }

    if (squads) {
      const pinned = pinnedSlugs();
      for (const f of fixtures) {
        if (TBC.test(f.teamA) || TBC.test(f.teamB)) continue;
        try {
          f.players = await readSquad(page, f, pinned, maxAgeMs);
          f.squadKnown = true;
        } catch {
          // A squad that cannot be read leaves the fixture listed without names,
          // which is honest; inventing a line-up would not be.
        }
      }
    }

    mkdirSync(new URL('../site/data', import.meta.url).pathname, { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify({ scrapedAt: new Date().toISOString(), fixtures })
    );
    return {
      fixtures: fixtures.length,
      withSquad: fixtures.filter((f) => f.squadKnown).length,
      withPlayers: fixtures.filter((f) => f.players.length).length,
      players: fixtures.reduce((n, f) => n + f.players.length, 0),
    };
  } finally {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  }
}

/**
 * Both squads for a fixture, reduced to the players this project tracks.
 *
 * Only `.playingxi-card-row` is read — the named line-up. Everything else linking a
 * player on that page belongs to CREX's promotional rail, not to this match.
 */
async function readSquad(page, fixture, pinned, maxAgeMs) {
  const cached = readCache(`fixture_squad_${fixture.id}`, maxAgeMs);
  const slugs = cached ?? (await fetchSquad(page, fixture.url));
  if (!cached) writeCache(`fixture_squad_${fixture.id}`, slugs);

  const out = [];
  for (const { slug, side, label } of slugs) {
    if (!pinned.has(slug)) continue;

    // The toggle's own label ("IND", "WI") is matched against the side codes taken
    // from the match URL, so a player is placed by CREX's agreement with itself
    // rather than by the order the buttons happen to be in.
    const tag = String(label ?? '').toUpperCase();
    let which =
      tag && tag === String(fixture.codeA ?? '').toUpperCase() ? 0 :
      tag && tag === String(fixture.codeB ?? '').toUpperCase() ? 1 :
      side;

    if (which !== 0 && which !== 1) {
      // Neither the label nor the order placed him; name the team rather than guess.
      out.push({ slug, playerId: pinned.get(slug), side: null, code: null });
      continue;
    }

    out.push({
      slug,
      playerId: pinned.get(slug),
      side: which === 0 ? fixture.teamA : fixture.teamB,
      code: which === 0 ? fixture.codeA : fixture.codeB,
    });
  }
  return out;
}

async function fetchSquad(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(2500);

  // The squad section shows one team at a time, chosen by the buttons in
  // `.playingxi-teams` ("IND", "WI"). Every `.playingxi-card-row` on screen belongs
  // to whichever button is selected, laid out in two columns.
  //
  // Reading the rows' x-positions and splitting them down the middle therefore does
  // not separate the teams — it splits one team's own two columns, which is how the
  // India XI came back with Rohit, Gaikwad, Jaiswal and Siraj filed under West
  // Indies. Each button has to be selected in turn instead.
  const out = [];
  const buttons = page.locator('.playingxi-teams .playingxi-button');
  const count = await buttons.count();

  if (!count) {
    // No toggle: take whatever rows are present, side unknown.
    for (const slug of await rowSlugs(page)) out.push({ slug, side: null });
    return out;
  }

  for (let i = 0; i < Math.min(count, 2); i++) {
    const label = ((await buttons.nth(i).textContent()) ?? '').replace(/\s+/g, ' ').trim();
    const before = (await rowSlugs(page)).join('|');

    await buttons.nth(i).click({ timeout: 8000 }).catch(() => {});
    // Wait for the panel to actually swap before reading it, for the same reason the
    // player-page card walk does: a click that has not landed yet would hand back the
    // previous team's names under this team's label.
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = await rowSlugs(page);
      if (i === 0 || now.join('|') !== before) break;
      await page.waitForTimeout(900);
    }

    for (const slug of await rowSlugs(page)) out.push({ slug, side: i, label });
  }

  return out;
}

/** The player slugs currently listed in the line-up section. */
async function rowSlugs(page) {
  return page
    .$$eval('.playingxi-card-row a[href^="/player/"]', (as) => [
      ...new Set(as.map((a) => (a.getAttribute('href') || '').replace('/player/', '').split('/')[0])),
    ])
    .catch(() => []);
}

/**
 * Pull the pieces CREX encodes into a match URL.
 *
 *   /cricket-live-score/rno-vs-tus-14th-match-csa-pro-t20-cup-2026-match-updates-14IM
 *
 * gives the two side codes, the stage ("14th match") and the match id ("14IM"). The
 * id is stable, so it keys the squad cache and lets a fixture be recognised again
 * after it is played.
 */
export function parseMatchLink(href) {
  const m = String(href ?? '').match(/\/cricket-live-score\/(.+?)-match-updates-([A-Za-z0-9]+)\/?$/);
  if (!m) return null;
  const [, body, id] = m;

  const vs = body.match(/^([a-z0-9]+)-vs-([a-z0-9]+)-(.*)$/i);
  if (!vs) return { id, codes: [], stage: null };

  return {
    id,
    codes: [vs[1].toUpperCase(), vs[2].toUpperCase()],
    // "14th-match-csa-..." -> "14th", "1st-semi-final-emirates-..." -> "1st semi final".
    // A numbered match carries "-match" after the number; a knockout names itself
    // instead ("final", "2nd-semi-final", "qualifier-1"), so both shapes are read.
    // The tournament half is taken from the card text, where CREX prints it as a
    // label rather than a slug.
    stage:
      vs[3]
        .match(
          /^(\d+(?:st|nd|rd|th)-match|(?:\d+(?:st|nd|rd|th)-)?(?:semi-final|final|qualifier|eliminator|playoff)(?:-\d+)?|only-match|tour-match)/i
        )?.[1]
        ?.replace(/-/g, ' ')
        .replace(/\s*\bmatch\b\s*$/i, '')
        .trim() || null,
  };
}

/**
 * Decide which of the two URL codes belongs to which named team.
 *
 * A code is CREX's abbreviation of the team name, so the letters appear in the name
 * in order ("SHA" in "Sharjah", "NWD" in "North West Dragons"). Where exactly one
 * assignment fits, it is used; where the test cannot separate them — two teams whose
 * names share an abbreviation shape — the codes are left off rather than guessed,
 * because a wrong code puts a player on the wrong side.
 */
export function orderCodes(codes, teamA, teamB) {
  const [x, y] = codes ?? [];
  if (!x || !y) return { codeA: x ?? null, codeB: y ?? null };

  const straight = abbreviates(x, teamA) && abbreviates(y, teamB);
  const swapped = abbreviates(y, teamA) && abbreviates(x, teamB);

  if (straight && !swapped) return { codeA: x, codeB: y };
  if (swapped && !straight) return { codeA: y, codeB: x };
  return { codeA: null, codeB: null };
}

/** Are `code`'s letters present in `name`, in order? ("NWD" / "North West Dragons") */
function abbreviates(code, name) {
  const c = String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!c || !n) return false;
  let i = 0;
  for (const ch of c) {
    i = n.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

/**
 * Today's date in IST, optionally offset by `ms`.
 *
 * IST is UTC+5:30 year-round; India does not observe DST. This is the same shift
 * `build-index`'s `istToday` applies, kept local rather than shared because the two
 * files have no other reason to depend on each other.
 */
export function istDate(ms = 0) {
  return new Date(Date.now() + 5.5 * 3600e3 + ms).toISOString().slice(0, 10);
}

/** "Fri, 2 Oct 2026" -> "2026-10-02". */
export function isoDate(heading) {
  const m = String(heading ?? '').match(/^\w{3},\s+(\d{1,2})\s+(\w{3})\s+(\d{4})$/);
  if (!m) return null;
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mi = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
}

/** Every slug this project pins, mapped to the id the site keys a player by. */
function pinnedSlugs() {
  const file = JSON.parse(readFileSync(PINS, 'utf8'));
  const out = new Map();
  for (const [id, pin] of Object.entries(file.pins ?? {})) {
    if (pin?.slug) out.set(pin.slug, id);
  }
  // Players with no Cricsheet id are keyed by name, exactly as the build does it.
  for (const [name, pin] of Object.entries(file.slugPins ?? {})) {
    if (pin?.slug) out.set(pin.slug, `unmapped:${name}`);
  }
  return out;
}

function cachePath(key) {
  mkdirSync(CACHE_DIR, { recursive: true });
  return join(CACHE_DIR, `${key.replace(/[^\w.-]/g, '_')}.json`);
}

function readCache(key, maxAgeMs) {
  if (maxAgeMs === 0) return null;
  const f = cachePath(key);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (maxAgeMs != null && Date.now() - raw.at > maxAgeMs) return null;
    return raw.data;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  writeFileSync(cachePath(key), JSON.stringify({ at: Date.now(), data }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await scrapeFixtures();
  console.log(
    `${r.fixtures} fixtures in the next 2 days — ${r.withSquad} with squads read, ` +
      `${r.withPlayers} featuring tracked players (${r.players} appearances)`
  );

  // Exit explicitly, for the same reason the player scrape does: this opens a browser
  // and visits a page per fixture, and one stray handle would leave the process
  // running long after the file is written.
  if (process.stdout.writableLength) process.stdout.once('drain', () => process.exit(0));
  else process.exit(0);
}
