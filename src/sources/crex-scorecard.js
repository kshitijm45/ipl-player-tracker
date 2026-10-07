/**
 * The match scorecard: balls bowled, and whether a batsman was out.
 *
 * The player page cannot give either. Its bowling view prints only "4-48" and an
 * economy figure that has to be discarded, because a bowler's "78 (114)" is
 * indistinguishable from a batting innings (the Mukesh Choudhary bug) — so balls
 * bowled was never stored at all, and without it there is no economy and no bowling
 * strike rate. Its batting view drops the not-out asterisk entirely, so every one of
 * 2,278 innings was recorded as a dismissal and every batting average was wrong.
 *
 * The scorecard states both outright, keyed by the same `/player/<slug>` this project
 * already pins, and it is plain server-rendered HTML — no browser needed, unlike the
 * player page whose tables are built client-side.
 *
 * Three things about the markup, each of which produced wrong figures before it was
 * understood:
 *
 *   - **The short URL does not work.** `/scoreboard/<id>/match-scorecard` redirects to
 *     `undefined-<id>` and renders no scorecard table — only a five-player "top
 *     performers" block, which looks enough like a scorecard to be mistaken for one.
 *     The full canonical URL is required; `canonicalUrl` recovers it for a bare id.
 *
 *   - **Every table on the page carries `class="bowler-table"`**, batting ones
 *     included. Only the header row distinguishes them. Keying on the class parses
 *     batting rows as bowling figures and yields nonsense that still looks like data:
 *     three maidens, an economy of 94.
 *
 *   - **The Hundred heads its bowling column `B` (balls), not `O` (overs)** — the same
 *     letter the batting table uses for balls faced. Both are normalised to balls.
 *
 * Every failure is soft, as with the commentary feed: an unreadable scorecard leaves
 * the innings exactly as the player page had it, and the build never fails on one.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const strip = (s) =>
  s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * "10.0" -> 60, "11.3" -> 69, "4" -> 24.
 *
 * CREX prints overs as `overs.balls` with six balls to an over, so the fractional part
 * is a ball count and not a decimal: "11.3" is eleven overs and three balls, which is
 * 69 — not 11.5 overs. Reading it as a decimal understates long spells and corrupts
 * every economy derived from it.
 *
 * Verified against CREX's own printed economy: for every bowling row scraped so far,
 * `runs / (balls / 6)` reproduces the site's `ER` figure exactly.
 */
export function ballsFromOvers(overs) {
  const m = String(overs ?? '').trim().match(/^(\d+)(?:\.(\d))?$/);
  if (!m) return null;
  const balls = +(m[2] ?? 0);
  // A seventh ball in an over is not something a scorecard prints; if one appears the
  // figure is not what this assumes, so report nothing rather than a wrong number.
  if (balls > 5) return null;
  return +m[1] * 6 + balls;
}

/**
 * Did this batter finish not out?
 *
 * The scorecard prints the dismissal in a `.decision` cell: "c Rutherford b Joseph"
 * for an out, "NOT OUT" for a not-out. Anything unrecognised returns null rather than
 * a guess, because a wrong `out` silently corrupts an average and nothing downstream
 * would reveal it.
 */
export function readDismissal(text) {
  const t = strip(String(text ?? '')).toLowerCase();
  if (!t) return null;
  if (/^not\s*out\b/.test(t)) return false;
  // "retired hurt"/"retired not out" end an innings without a dismissal; "retired out"
  // is a dismissal. The bare "retired" is ambiguous, so it is left unknown.
  if (/^retired\s+(hurt|not\s*out)\b/.test(t)) return false;
  if (/^retired\s+out\b/.test(t)) return true;
  // A real dismissal always names how: bowled, caught, lbw, run out, stumped...
  if (/\b(b|c|lbw|run out|st|hit wicket|obstruct|handled|timed out)\b/.test(t)) return true;
  return null;
}

/**
 * Parse a scorecard into per-innings batting and bowling rows, keyed by player slug.
 *
 * Innings are numbered by the order their tables appear, counted separately for each
 * discipline — so a Test's second bowling table is innings 2 regardless of how many
 * batting tables sit between them.
 */
export function parseScorecard(html) {
  const out = { batting: [], bowling: [] };
  let nBat = 0;
  let nBowl = 0;

  for (const [, table] of String(html ?? '').matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const head = [
      ...(table.match(/<thead[\s\S]*?<\/thead>/)?.[0] ?? '').matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g),
    ].map(([, c]) => strip(c).toLowerCase());
    if (!head.length) continue;

    const isBowling = head[0] === 'bowler';
    // A third table heads "Batter | Score | Balls" — that is the fall-of-wickets
    // block, not an innings, and counting it would double every batsman's innings.
    // Requiring the strike-rate column is what tells the two apart.
    const isBatting = (head[0] === 'batter' || head[0] === 'batsman') && head.includes('sr');
    if (!isBowling && !isBatting) continue;

    const innings = isBowling ? ++nBowl : ++nBat;
    const body = table.match(/<tbody[\s\S]*?<\/tbody>/)?.[0] ?? table;

    for (const [, tr] of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const slug = tr.match(/\/player\/([A-Za-z0-9-]+)/)?.[1];
      if (!slug) continue;
      const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, c]) => strip(c));
      if (cells.length < head.length) continue;

      const at = (name) => {
        const i = head.indexOf(name);
        return i < 0 ? null : cells[i];
      };
      const num = (name) => {
        const v = at(name);
        return v != null && v !== '' && Number.isFinite(+v) ? +v : null;
      };

      if (isBowling) {
        // Overs everywhere except the ball-based competitions, which head it "B".
        const balls = head.includes('o') ? ballsFromOvers(at('o')) : num('b');
        out.bowling.push({
          slug, innings, balls,
          maidens: num('m'), runs: num('r'), wickets: num('w'), econ: num('er'),
        });
      } else {
        out.batting.push({
          slug, innings,
          runs: num('r'), balls: num('b'),
          fours: num('4s'), sixes: num('6s'), strikeRate: num('sr'),
          out: readDismissal(tr.match(/class="decision"[^>]*>([\s\S]*?)<\/div>/)?.[1]),
        });
      }
    }
  }
  return out;
}

/**
 * Who was named player of the match.
 *
 * Not on the scorecard tab — it sits on the match page itself, in a
 * `.player-of-match-card` block whose only `/player/` link is the winner. That is the
 * same slug this project pins, so no name matching is needed.
 *
 * Returns null where the award is not shown, which covers a match still being played,
 * a washout, and the many domestic fixtures that never name one. A missing award is
 * not an error and must never be rendered as "nobody won it".
 */
export function parsePlayerOfMatch(html) {
  const block = String(html ?? '').match(
    /class="player-of-match-card"[\s\S]{0,4000}?<\/app-|class="player-of-match-card"[\s\S]{0,4000}$/
  )?.[0];
  if (!block) return null;
  const slug = block.match(/\/player\/([A-Za-z0-9-]+)/)?.[1];
  return slug ?? null;
}

/**
 * Fetch the match page and read its award.
 *
 * A separate request from the scorecard, because the two live on different tabs. It is
 * only worth making once per match and only for a finished one, so the caller decides
 * when; this just reads it.
 */
export async function fetchPlayerOfMatch(
  { matchUrl } = {},
  { fetchImpl = fetch, timeoutMs = 25000 } = {}
) {
  if (!matchUrl) return null;
  // The award is on the match page, not its scorecard tab.
  const url = (matchUrl.startsWith('http') ? matchUrl : `https://crex.com${matchUrl}`)
    .replace(/\/$/, '')
    .replace(/\/match-scorecard$/, '');
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout?.(timeoutMs),
    });
    if (!res.ok) return null;
    return parsePlayerOfMatch(await res.text());
  } catch {
    return null;
  }
}

/**
 * The canonical match URL for a bare match id.
 *
 * Needed only for innings scraped before the scrape began keeping the full href: the
 * short URL will not render a scorecard, but its HTML does carry a `<link rel=
 * "canonical">` pointing at the real one. One extra request, and only for the backlog.
 */
export async function canonicalUrl(
  matchId,
  { fetchImpl = fetch, timeoutMs = 20000, attempts = 3 } = {}
) {
  // The page intermittently serves its own redirect target as the canonical — a
  // literal "undefined-<id>", which is the dead end this function exists to avoid.
  // It is transient rather than permanent: the same id answers correctly moments
  // later, so a bare failure here would skip a readable match for good.
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
    try {
      const res = await fetchImpl(`https://crex.com/scoreboard/${matchId}/match-scorecard`, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout?.(timeoutMs),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const href =
        html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ??
        html.match(/property="og:url" content="([^"]+)"/)?.[1] ??
        null;
      if (!href || href.includes('undefined-')) continue;
      return href.replace(/\/$/, '');
    } catch {
      // Try again; a run must not lose a match to one timeout.
    }
  }
  return null;
}

/**
 * The scorecard URL for a match page.
 *
 * Accepts either the full URL or the site-relative href the player page carries, with
 * or without a trailing `/match-scorecard` already on it. Returns null when there is
 * no match URL to build from — that is the case `canonicalUrl` exists for.
 */
export function scorecardUrl({ url, matchUrl } = {}) {
  const base = url ?? matchUrl;
  if (!base) return null;
  const abs = base.startsWith('http') ? base : `https://crex.com${base}`;
  return abs.replace(/\/$/, '').replace(/\/match-scorecard$/, '') + '/match-scorecard';
}

/**
 * Fetch and parse one match's scorecard, one innings only.
 *
 * **This returns a single innings**, which for most matches is half the scorecard.
 * The page server-renders whichever innings it opens on and keeps the rest behind an
 * `IND`/`WI`-style toggle that only a browser can work — there is no URL that selects
 * one, and `?innings=2` and friends are all ignored. Use `fetchFullScorecard` where
 * both sides are needed, which is 473 of the 750 matches in the data.
 *
 * Kept separate because it is the cheap path and genuinely sufficient for the 277
 * matches where every player tracked batted or bowled in the rendered innings.
 *
 * Returns null on any failure, which the caller treats as "this match keeps the
 * figures it already has".
 */
export async function fetchScorecard(
  { matchId, matchUrl } = {},
  { fetchImpl = fetch, timeoutMs = 25000 } = {}
) {
  let url = scorecardUrl({ matchUrl });
  if (!url) {
    const canon = await canonicalUrl(matchId, { fetchImpl, timeoutMs });
    if (!canon) return null;
    url = `${canon}/match-scorecard`;
  }

  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout?.(timeoutMs),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const parsed = parseScorecard(html);
    if (!parsed.batting.length && !parsed.bowling.length) return null;
    return { matchId, url, partial: true, ...parsed };
  } catch {
    return null;
  }
}

/**
 * Merge innings read from separate renders of the same scorecard.
 *
 * Each toggle click re-renders the tables from innings 1, so every view numbers its
 * own innings from 1 and the numbers collide across views. Dedupe is therefore on
 * slug plus figures rather than on the innings number, and the number is rewritten
 * to the order the innings were actually seen — which is the order the toggle lists
 * the sides, and so the order the match was played.
 */
export function mergeInnings(views) {
  const out = { batting: [], bowling: [] };
  for (const kind of ['batting', 'bowling']) {
    const seen = new Set();
    let innings = 0;
    for (const view of views) {
      const rows = view?.[kind] ?? [];
      if (!rows.length) continue;
      // One view can hold several innings of a Test; keep their relative order.
      for (const group of [...new Set(rows.map((r) => r.innings))].sort((a, b) => a - b)) {
        const batch = rows.filter((r) => r.innings === group);
        // A view identical to one already taken is the toggle not having re-rendered
        // yet, not a real second innings — the same trap as the player page's cards.
        const sig = batch.map((r) => `${r.slug}:${r.runs}:${r.balls}:${r.wickets ?? ''}`).sort().join('|');
        if (seen.has(sig)) continue;
        seen.add(sig);
        innings += 1;
        for (const r of batch) out[kind].push({ ...r, innings });
      }
    }
  }
  return out;
}

/**
 * Every innings of one match, by walking the innings toggle in a browser.
 *
 * Needed because the scorecard renders one innings server-side and hides the rest
 * behind a toggle with no URL of its own. Without this, a match's second innings is
 * simply absent: on IND v WI, eleven of the twelve players this project tracks are in
 * the innings that does not render, so a `fetch`-only backfill enriched one of them.
 *
 * `page` is supplied by the caller so one browser context serves a whole run; this
 * never launches or closes one itself.
 */
export async function fetchFullScorecard(
  page,
  { matchId, matchUrl } = {},
  { timeoutMs = 45000, fetchImpl = fetch } = {}
) {
  if (!page) return null;
  // Innings scraped before the href was retained carry only the id, and the id alone
  // cannot reach a scorecard — so the canonical URL is resolved first for those.
  let url = scorecardUrl({ matchUrl });
  if (!url && matchId) {
    const canon = await canonicalUrl(matchId, { fetchImpl });
    url = canon ? `${canon}/match-scorecard` : null;
  }
  if (!url) return null;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(2200);

    const views = [parseScorecard(await page.content())];

    // The toggle labels the two sides by team code. They are read rather than
    // assumed, because the order differs per match and the codes are the match's own.
    const sides = await page
      .$$eval('.team-name', (es) => [...new Set(es.map((e) => e.textContent.trim()).filter(Boolean))])
      .catch(() => []);

    for (const side of sides) {
      const tab = page.locator('.team-name', { hasText: new RegExp(`^${side}$`) }).first();
      if (!(await tab.count().catch(() => 0))) continue;
      // A click that does not land leaves the previous innings on screen, which
      // `mergeInnings` discards as a duplicate rather than storing twice.
      await tab.click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(1600);
      views.push(parseScorecard(await page.content()));
    }

    const merged = mergeInnings(views);
    if (!merged.batting.length && !merged.bowling.length) return null;
    return { matchId, url, ...merged };
  } catch {
    return null;
  }
}
