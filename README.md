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

## Search

The box in the rail is a **player picker**, not a filter. It used to narrow `S.q`
across every view at once, which meant typing a name silently emptied the daily
tracker, Coming Up, Form and the leaderboards — a reader looking up Kohli got one
innings and a "Nothing. Try another filter." Scoping belongs to the club rail; search
offers people to open.

It matches on more than the display name, because the other spellings were in the data
and unreachable: the register's `registerName` ("MD Shanaka" for Dasun Shanaka), the
squad sheet's `listedAs`, the CREX slug, the player's teams and his competitions. So
"CSK", "Hundred" and "Duleep" are all routes to a player, and a hit explains itself
when the name alone does not ("also MD Shanaka").

Results are ranked rather than filtered. `includes` on its own buried the obvious
answer — "sam" returned Abdul Samad and Sameer Rizvi above Sam Curran, in whatever
order the squad list happened to be in. Exact name beats word-prefix beats substring
beats an alternate spelling beats a team or competition, and ties break on who played
most recently. Arrow keys walk the list, Enter opens the top hit, Escape clears.

## Dating a Test innings

CREX stamps every innings of a Test with the match's **start** date. All four innings
of a Test beginning on 23 August are printed under the 23rd, which for a daily tracker
is the wrong shape entirely: 55 of that day's 72 innings were Test innings really
spread across five days, and the four days behind it showed nothing.

There is no per-innings date anywhere on CREX to fix that with. The scorecard was
checked for day, session, stumps and fall-of-wicket markers and carries none. What the
*match* page carries, **while the match is being played**, is a structured day marker:

```html
<div class="day-session"><span>Day 3</span><span>-</span><span>Session 3</span></div>
```

plus a JSON-LD `SportsEvent` with `startDate`, `endDate` and status. Together those
date a day exactly — `startDate + (day - 1)` — and the label is preferred over that
arithmetic because it is the only thing that knows about a day lost to rain: if the
page says Day 3 but four days have passed, a day was washed out.

So each innings is shown **once, on the day it ended, with the whole figure CREX
prints**. A batsman 51\* overnight who is dismissed for 126 appears as `126 (131)` on
the day he was out, noted `Days 2–3`. While the innings is still in progress it shows
the running figure badged `TEST IN PROGRESS`, and moves to its closing day once it
ends. An earlier version split the innings across days by subtraction ("+75 on day
3"); it was arithmetically sound and read as nonsense, because a hundred is a hundred
and no scorecard agrees with a figure that exists only here. **Only the date is
inferred. Every figure is CREX's own.**

### Which day did an innings end on

**The last day its figure changed.** The job runs daily and a day is only recorded once
its play is finished, so every snapshot is a settled end-of-day figure: one that has
stopped moving has stopped for good. No dismissal is needed to anchor it, which is what
makes a declaration work — a batsman left 112\* has no "out" to look for, and comparing
days finds the right one anyway.

Two things that rule cannot do on its own, both covered by `src/sources/crex-commentary.js`:

- **Date the 393 Test innings scraped before any of this existed.** There are no
  snapshots for them and the day marker is long gone.
- **Survive a missed run.** A day never observed is a day the comparison cannot reason
  about, so one CI failure — or a Test that starts and finishes between two runs —
  would leave an innings a day out, with nothing marking it as suspect.

CREX's own front-end fetches a commentary feed whose every entry carries a millisecond
timestamp and an `inning` number, so the latest timestamp per innings *is* its closing
day — stated outright, and re-readable long after the match:

```
ENG v PAK 2nd Test, started 27 Aug
  innings 1: 28 Aug           -> ended 28 Aug
  innings 2: 28, 29, 30 Aug   -> ended 30 Aug
  innings 3: 30 Aug           -> ended 30 Aug
```

That is a Test five weeks finished, fully resolved: 208 pages, ~2,000 entries, 18
seconds. `npm run backfill` walks every Test already in the data, probing one page
first because coverage is per match rather than per tier — the Irani Cup has a feed,
BAN-A v SA-A does not. It is re-runnable: a settled match is skipped, so an interrupted
backfill resumes.

The feed is a third-party host (`content.crickapi.com`) reached by replaying the headers
CREX's front-end sends, including a static build-time JWT tied to no account. It is the
same data CREX serves itself, but it is not a documented API, so every failure is soft:
an innings that cannot be dated keeps the match start date, and the build never fails
on it.

`data/crex-match-days.json` is committed because it holds the dated result. With the
commentary feed it can mostly be rebuilt; without it, a day never recorded is gone.

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
  sources/crex-match-day.js  dating a Test innings  (tests: crex-match-day.test.js)
  sources/crex-scorecard.js  balls bowled and not-outs (tests: crex-scorecard.test.js)
  ingest-crex.js        drives it across every pinned player, caches to disk
  ingest-fixtures.js    the next two days, with squads
  build-index.js        flattens everything into the site payload
  bundle-site.js        inlines that payload into one publishable file
  core/registry.js      identity resolution      (tests: registry.test.js)
  core/squads.js        squad membership and the tracked set
  core/merge.js         assembles rows; deliberately does not second-guess them
  core/career-stats.js  the aggregates       (tests: career-stats.test.js)
  core/scorecard-merge.js  folding a scorecard in (tests: scorecard-merge.test.js)
  core/match-days.js    the multi-day snapshot store
  core/display-name.js  "MD Shanaka" -> "Dasun Shanaka"
site/
  offseason.html        the page, with an empty data stub
  offseason-live.html   generated: the same page with the data inlined
data/
  crex-players.json     slug + franchise per player — the identity contract
  crex-performances.json  every scraped innings
  crex-match-days.json  which day each Test innings ended on; cannot be rebuilt
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

npm test           # identity resolution and Test day attribution
npm run backfill   # one-time: date every Test innings already scraped (~20 min)
```

`npm run backfill` is run by hand, once, after a scrape — it needs the `matchId` the
scrape now records against each innings. `--dry` reports what it would date without
writing, and `--limit=5` tries a few first.

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

## Career stats

Batting (innings, runs, strike rate, average) and bowling (innings, wickets, economy,
strike rate), broken down by tournament and totalled by format. Computed here, not read
from CREX: it publishes no career table at all — `/player/<slug>/stats` and `/career`
are both 404 — so the per-innings rows are the only aggregate-able source.

Two rules decide every figure:

- **Aggregated from summed totals, never by averaging per-match ratios.** The mean of
  each innings' strike rate is not the strike rate; it weights a 2-ball cameo the same
  as a 60-ball innings.
- **A figure that cannot be computed is absent, not zero.** An average of 0 and "never
  been dismissed" are different facts, and a 0 economy reads as unplayably good rather
  than as missing.

| stat | formula |
| --- | --- |
| Batting SR | runs / balls faced x 100 |
| Batting average | runs / **dismissals** — not innings |
| Economy | runs / overs, i.e. runs x 6 / balls bowled |
| Bowling SR | balls bowled / wickets |

The Hundred is the one exception: economy there is runs per **ball**. A five-ball over
makes "per over" meaningless, and CREX's own printed `ER` is per five balls — computing
it per six would silently contradict the source. Bowling strike rate needs no special
case, being already ball-based.

No combined all-format total is produced. Adding a Test innings to a Hundred innings
gives a number no scorecard agrees with.

### What the player page cannot give

Two fields are missing from it entirely, and between them they block three of the eight
figures above:

- **Balls bowled.** The bowling view prints "4-48" plus an economy figure that has to be
  discarded, because a bowler's "78 (114)" is indistinguishable from a batting innings
  (the Mukesh Choudhary bug). No balls bowled means no economy and no bowling strike
  rate.
- **Not out.** The innings table drops the asterisk — `td.textContent` simply has no `*`
  in it — so the scrape recorded **2,278 of 2,278 innings as dismissals**, which is
  impossible. Shubman Gill's 223\* against the West Indies was stored as out, and that
  one player's average read 70.00 instead of 86.15.

Neither was visible as an error. Both produced figures that looked like data.

### Reading a scorecard

`src/sources/crex-scorecard.js` reads both off the match scorecard, keyed by the same
`/player/<slug>` this project already pins. Every economy figure it parses reconciles
against `runs / (balls / 6)`, which is the independent check that the overs conversion
is right — "11.3" is eleven overs and three balls, 69, not 11.5 overs.

Four traps, each of which produced plausible wrong data first:

- **The short URL is a dead end.** `/scoreboard/<id>/match-scorecard` redirects to
  `undefined-<id>` and renders no scorecard table, only a five-player "top performers"
  block that looks enough like one to be mistaken for it. The full canonical URL is
  required, so the scrape now keeps each row's `matchUrl`; older rows resolve it from
  the short URL's `<link rel="canonical">`, which intermittently serves the dead end
  itself and so is retried.
- **Every table carries `class="bowler-table"`**, batting ones included. Only the header
  row distinguishes them. Keying on the class gave a batsman three maidens and an
  economy of 94.
- **One innings renders at a time.** The rest sits behind a team-code toggle with no URL
  of its own — `?innings=2` and friends are all ignored. 473 of the 750 matches here
  need players from both innings, and on IND v WI eleven of the twelve tracked players
  are in the innings that does not render, so a fetch-only pass enriched one of them and
  reported success. Hence a browser, clicking through the sides. Each click re-renders
  numbered from 1, so innings are deduplicated on their figures rather than that number.
- **The Hundred heads its bowling column `B`, not `O`** — the same letter the batting
  table uses for balls faced.

The scorecard contributes balls bowled and the dismissal, plus maidens, its own economy,
fours and sixes where the page had nothing. It never creates or deletes an innings, and
never overwrites a figure the page gave: where the two disagree on runs or wickets the
disagreement is counted, not resolved, because the page's figure is what the innings
table shows and a silent correction would make the two halves of the site disagree.

An average is shown only once **every** innings' dismissal is known. A single unknown
suppresses it, because the error runs one way — an unrecorded not-out is counted as an
out — so the figure would always flatter, with nothing on the page to reveal it.

### Running the backfill

```bash
node src/backfill-scorecards.js            # every match in the data (~75 min)
node src/backfill-scorecards.js --dry      # report without writing
node src/backfill-scorecards.js --limit=5  # try a few first
```

It runs **once**, not daily. The enriched rows are committed with the rest of `data/`,
and a match whose innings are already enriched is skipped — a finished scorecard can
never change, so there is nothing to re-read. Interrupting it is safe: it writes every
25 matches and resumes where it stopped.

In CI it is the `scorecards` input on the refresh workflow, with `scorecard_limit` to
split the backlog across a few runs. The daily job reads only new matches, capped at 60.

One thing this depends on: `keepRicher` carries the scorecard's fields across a
re-scrape. Without that the nightly run would undo the backfill every evening — the
player page cannot produce either field, so a fresh read returns rows with no balls
bowled and everyone out — and the only symptom would be averages quietly turning back
into dashes.

## Known limits

- A live figure is only as good as what CREX displays mid-innings. The LIVE badge is
  there so a reader knows not to treat it as final.
- A Test innings is dated by day only where the match has a commentary feed or the
  scrape watched it being played. Where neither holds — several domestic fixtures have
  no feed — the innings keeps the match's start date, as it did before.
- The commentary endpoint is undocumented and third-party. If it changes shape or
  refuses traffic, day attribution degrades to comparing daily snapshots, and the
  backfill stops working.
- Squad files need a manual refresh after the auction and trade windows.
- Forty players have no post-IPL cricket yet, so their pages stay empty until they play.
- A surname collision can still mispin a player to the wrong CREX page. Two have been
  found; both were caught by hand, and nothing in the build would stop a third.
- A batting average is missing until every one of that player's innings has been read
  from a scorecard, so averages appear gradually as the backfill proceeds rather than
  all at once. Economy and bowling strike rate are computed from whichever innings have
  balls bowled, and say how many that was.
- A scorecard that cannot be read leaves its innings exactly as the player page had
  them. The match is retried on the next run, since it never stops needing one.
