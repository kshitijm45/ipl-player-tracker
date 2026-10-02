# Beyond the IPL

Tracks every player on an IPL 2026 roster across every competition they appear in
worldwide — internationals, the Big Bash, bilateral tours, qualifiers — so a fan can
follow one player without following twenty tournaments.

**Live page:** https://claude.ai/artifact/9HKRwVDbnBahcwECPocBii

Current data: 256 players, 2,363 innings, 58 competitions, 1 Jun - 28 Sep 2026.
All of it scraped from CREX, which is the single source.

## The actual problem

Fetching a scorecard is easy. Knowing that the `H Pandya` in an IPL scorecard, the
`Hardik Pandya` in a T20I scorecard and the `HH Pandya` in a domestic one are the same
person is not. Names cannot do it:

- Three different players in the register match "Hardik".
- `RG Sharma` (cricinfo 34102) is the India captain. `Rohit Sharma` (cricinfo 924355)
  is a *different real player*. Text alone cannot separate them.
- Press squad lists say "Axar Patel"; the register says `AR Patel`. "Dushmantha
  Chameera" is filed as `PVD Chameera` — no shared token at all.

So identity is the spine of this project, and every performance is attached to a
canonical id, never to a name. Where identity is uncertain, the row is **quarantined
rather than guessed** — silently crediting one player's century to another is the worst
failure this thing can have.

## How it resolves identity

1. **Cricsheet's register** (`data/raw/people.csv`, ~18.5k players) is the id space.
   `key_cricinfo` is populated for 99.8% of players and is the practical join key.
   (`key_cricbuzz` is 0.3% populated and deliberately unused.)
2. **Match files carry their own registry.** Each Cricsheet match embeds
   `info.registry.people`, mapping that match's exact name strings to canonical ids, so
   performance extraction is *exact by construction* — no fuzzy matching on this path.
3. **Squad lists need help.** Squad names come from public listings and rarely match
   register spellings. Resolution runs in three stages:
   - appearance-pool prior (players who actually played IPL 2026) — cuts failures from 37% to 15%
   - name variants (punctuation, reordering, transliteration drift)
   - `data/player-overrides.json` — 34 hand-verified pins for the irreducible cases

   Result: **251/251 squad names resolved**, 245 to canonical ids. The other 22 are
   uncapped players with no Cricsheet record yet; they are carried explicitly as squad
   members with no history rather than dropped.

## Why squads are a separate source

Cricsheet records playing XIs, never full squads. A player who sat on the bench all
season is invisible to it — and for a tracker that is backwards, since a benched IPL
player is often exactly the one whose BBL or county form you want.

The tracked set is therefore the **union** of squad membership and actual appearances.
57 tracked players never played an IPL match in 2026; 12 of them have been active
elsewhere (Kamindu Mendis played 13 innings for Sri Lanka as recently as 17 Sep).

## Layout

```
src/
  core/registry.js      identity resolution + quarantine  (tests: registry.test.js)
  core/squads.js        squad membership, overrides, tracked-set union
  core/csv.js           RFC4180 parser (player names contain commas)
  sources/source.js     adapter contract every source implements
  sources/cricsheet.js  the backbone source: download, cache, extract
  build-index.js        flattens matches into the site payload
site/
  index.html            the page (reads data/*.json)
  beyond-the-ipl.html   generated: same page with data inlined, for publishing
data/
  raw/people.csv        Cricsheet register
  squads-2026.json      IPL squads, transcribed (changes at auction/trade windows)
  player-overrides.json hand-verified name -> canonical id pins
  cache/cricsheet/      downloaded match archives
```

## Running it

```bash
npm install
npx playwright install chromium

npm run scrape     # read every pinned player's CREX page   (~90 min cold, seconds warm)
npm run fixtures   # the next two days, with squads         (~2 min)
npm run build      # site/data/*.json, then offseason-live.html
npm run refresh    # all three, in order
```

`npm run scrape` is incremental. A player page read within `CACHE_HOURS` (default 24)
is taken from `data/cache/crex` rather than fetched again, so a cold run costs about
ninety minutes and a same-day re-run costs seconds. Delete the cache to force a full
re-read.

Environment:

| variable | default | meaning |
| --- | --- | --- |
| `SEASON_START` | `2026-06-01` | first day the tracker covers; everything earlier is dropped |
| `CACHE_HOURS` | `24` | how long a scraped player page stays usable |
| `SCRAPE_CONCURRENCY` | `2` | player pages read at once |

Concurrency is deliberately low. At four, pages timed out often enough that seventy
players silently lost every innings in one run — and because a failed fetch returned
an empty list instead of throwing, the run still reported `0 failed`. Both halves of
that are fixed, but two remains the setting that finishes intact.

To serve the built page locally: `cd site && python3 -m http.server 8777`.

## Deploying

`.github/workflows/refresh.yml` runs the whole pipeline daily at 03:30 UTC (09:00 IST)
and publishes to GitHub Pages. It is free: public repositories get unlimited Actions
minutes, and the job finishes well inside the six-hour cap.

One-time setup, after pushing the repository to GitHub:

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Actions → General → Workflow permissions: Read and write**, so the
   job can commit the refreshed data back.
3. Optionally **Settings → Variables → Actions** → `SEASON_START`, to move the cutoff
   without editing the workflow.

Then **Actions → refresh → Run workflow** to confirm it works rather than waiting a day.

The scrape cache is carried between runs by `actions/cache`, keyed by run id with a
`crex-cache-` prefix fallback, so each day restores the previous day's cache and only
refetches what has gone stale. The cache is ignored by git — it is 1.4 GB locally and
never belongs in the repository.

## Data sources, and what was rejected

**Cricsheet** (CC BY 4.0) is the backbone: free, permissively licensed, and it ships
ball-by-ball data with embedded player ids. It covers internationals plus IPL, BBL, PSL,
CPL, T20 Blast, SA20, ILT20, The Hundred, MLC, BPL, LPL, Super Smash, Syed Mushtaq Ali
Trophy, County Championship and Sheffield Shield. It does **not** cover Ranji Trophy,
Vijay Hazare, TNPL or KPL, and it is not live — files land within days of a match, so
this answers "what did my players do recently", not "what is happening right now".

**CREX was considered and rejected as a primary source.** It has no public API, its data
is licensed from upstream feed providers, its site is a JS shell with no stable player
ids to scrape, and it would break mid-match. The adapter contract in
`src/sources/source.js` exists so a source like it — or a paid feed — can be added later
as one isolated module that is allowed to fail without taking the page down.

**Squad listings** are transcribed once from public sources rather than scraped live.
iplt20.com renders squads client-side ("Loading team details, please wait…"), so live
scraping would need a headless browser — a lot of fragile machinery for data that
changes twice a year.

## Known limits

- Not live. Same-day scores need a paid feed; that is the one thing money actually buys.
- Deep Indian domestic cricket (Ranji, Vijay Hazare, TNPL) is not covered.
- Squad files need a manual refresh after the auction and trade windows.
- 22 uncapped squad players have no performance history until their first tracked match.
