# Offseason

Tracks every player on an IPL 2026 roster across every competition they appear in
afterwards — internationals, the Hundred, county cricket, the CPL, Indian domestic —
so a fan can follow one player without following twenty tournaments.

**Live page:** https://kshitijm45.github.io/ipl-player-tracker/

Current data: 255 players, 2,398 innings, 61 competitions, 1 Jun – 2 Oct 2026.
Every figure is scraped from CREX, which is the single source.

## What it does

The IPL lasts two months. Its players then scatter across the world, and no single
page follows them. This one does: pick a franchise, see what its squad has been doing
since the final, filtered by format, with the next two days' fixtures and who is named
in each squad.

## Where the data comes from

**CREX only.** It covers the long tail no free dataset reaches — Ranji, Vijay Hazare,
TNPL, state T20 leagues — and prints players under the names fans actually use
("Dasun Shanaka", not the register's "MD Shanaka").

Contrary to the usual assumption, it is scrapable: the player and match pages are
server-rendered, so the figures are in the HTML rather than behind an authenticated
API. Players have stable slugs (`hardik-pandya-C3`), and `/player/<slug>/matches`
carries per-innings figures split by format.

Nothing is inferred. A competition is whatever CREX called it, an opponent is recorded
only when the fixture names one, and a team code is never expanded into a club. Every
transformation tried here was wrong in a way that was hard to see — "IND vs ENG 2026"
rewritten as "England in India" when India were the tourists, opponents invented from
tournament names — so the source is passed through unchanged.

Cricsheet's register (`data/raw/people.csv`) is still read, but only as a name list:
it turns "MD Shanaka" into the spelling a reader recognises. No innings and no squad
membership come from it.

## Reading a player's page

The matches page opens on one tournament; the rest sit behind the series cards. Two
details make that work, and both cost a long time to find:

- **Click the card's date line (`.seriesDesc`), never the series name.** The name is a
  link to the series page, and following it abandons the table.
- **Select cards from the Batting view, and re-select after switching discipline.**
  The series list is per-discipline, and the discipline tab re-renders the table back
  to the default tournament — which is how Will Jacks's England ODIs against Sri Lanka
  ended up filed under "County Div-One 2026" for Surrey.

With both right, Jos Buttler goes from 5 innings to 23 and Tilak Varma's three Duleep
Trophy innings appear.

## Identity

The CREX slug is the id. `data/crex-players.json` pins every tracked player to one,
along with the franchise he plays for, and that mapping is the contract — no name
matching happens at scrape time.

258 pin entries resolve to 255 distinct CREX pages: three players are pinned both by
register id and by name, and the build folds each pair into one record.

Two mispins are worth knowing about, because both produced plausible-looking wrong
data rather than an error:

- Rahul Chahar was pinned to his cousin Deepak's page, so his card showed Deepak's
  innings.
- The squad file said "Auqib Nabi Dar", which resolved to Aleem Dar the umpire on the
  shared surname, giving Delhi Capitals a phantom 26th player.

Both were caught by a count that did not add up, not by a check in the code.

## Live matches

A figure from a match still being played is the score on the board when the page was
read, not the player's final one for the innings. Mukesh Kumar was stored at 84 (102)
during an innings he finished on 0 (0) — and led Performance of the Day on it.

Nothing in the row says it is live: the cell reads "84 (102)", indistinguishable from
a completed innings. So the match's own date decides it, with a span that depends on
format — a Test stays open five days, because an innings begun on day one is still
being added to on day four; everything else closes at the end of its own day. Those
rows carry a LIVE badge and are refetched every run, ignoring the cache, until the
figure can no longer move.

## Fixtures

`/schedule` carries exactly two days of fixtures as `.match-card-container` elements.
Each card's link encodes the side codes, the stage and a stable match id:

```
/cricket-live-score/rno-vs-tus-14th-match-csa-pro-t20-cup-2026-match-updates-14IM
```

Squads come from the match page, where both line-ups are listed as `/player/<slug>`
links — the same slugs this project pins. That is what makes a new tournament work: a
player picked for a competition he has never appeared in has no history to match on,
but his slug is there from the moment the squad is announced.

Two traps: the page's promotional rail links players too (reading every `/player/`
link put Kohli and Rohit into all eighteen fixtures), and `.playingxi-teams` is a
toggle showing one squad at a time, so the two columns on screen are one team's
line-up rather than two.

## Layout

```
src/
  sources/crex.js       the scraper: card walk, format tabs, live detection
  ingest-crex.js        drives it across every pinned player, caches to disk
  ingest-fixtures.js    the next two days, with squads
  build-index.js        flattens everything into the site payload
  bundle-site.js        inlines that payload into one publishable file
  core/registry.js      identity resolution      (tests: registry.test.js)
  core/squads.js        squad membership and the tracked set
  core/merge.js         assembles rows; deliberately does not second-guess them
  core/display-name.js  "MD Shanaka" -> "Dasun Shanaka"
site/
  offseason.html        the page, with an empty data stub
  offseason-live.html   generated: the same page with the data inlined
data/
  crex-players.json     slug + franchise per player — the identity contract
  crex-performances.json  every scraped innings
  squads-2026.json      IPL squads, transcribed
  raw/people.csv        name register
  cache/crex/           scraped pages (gitignored, ~1.4 GB)
```

## Running it

```bash
npm install
npx playwright install chromium

npm run scrape     # every pinned player's CREX page   (~90 min cold, seconds warm)
npm run fixtures   # the next two days, with squads    (~2 min)
npm run build      # site/data/*.json, then offseason-live.html
npm run refresh    # all three, in order
```

The scrape is incremental. A player page read within `CACHE_HOURS` is taken from
`data/cache/crex` rather than fetched again, so a cold run costs about ninety minutes
and a same-day re-run costs seconds — except for players with a live innings, who are
always refetched. Delete the cache to force a full re-read.

| variable | default | meaning |
| --- | --- | --- |
| `SEASON_START` | `2026-06-01` | first day covered; everything earlier is dropped |
| `CACHE_HOURS` | `24` | how long a scraped page stays usable |
| `SCRAPE_CONCURRENCY` | `2` | player pages read at once |

Concurrency is deliberately low. At four, pages timed out often enough that seventy
players silently lost every innings in one run — and because a failed fetch returned
an empty list instead of throwing, the run still reported `0 failed`. Both halves of
that are fixed, but two is the setting that finishes intact.

To serve the built page locally: `cd site && python3 -m http.server 8777`.

## Deploying

`.github/workflows/refresh.yml` runs the pipeline daily at 03:30 UTC (09:00 IST) and
publishes to GitHub Pages. It is free: public repositories get unlimited Actions
minutes, and the job finishes well inside the six-hour cap.

One-time setup after pushing to GitHub:

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Actions → General → Workflow permissions: Read and write**, so the job
   can commit refreshed data back.
3. Optionally **Settings → Variables → Actions** → `SEASON_START`.

Then **Actions → refresh → Run workflow** to confirm it works rather than waiting a day.

The scrape cache is carried between runs by `actions/cache`, keyed by run id with a
`crex-cache-` prefix fallback, so each day restores the previous day's cache and only
refetches what has gone stale. It is gitignored — 1.4 GB never belongs in a repo.

## Known limits

- A live figure is only as good as what CREX displays mid-innings. The LIVE badge is
  there so a reader knows not to treat it as final.
- Squad files need a manual refresh after the auction and trade windows.
- Forty players have no post-IPL cricket yet, so their pages stay empty until they play.
- A surname collision can still mispin a player to the wrong CREX page. Two have been
  found; both were caught by hand, and nothing in the build would stop a third.
