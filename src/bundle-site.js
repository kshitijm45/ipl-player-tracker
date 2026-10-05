/**
 * Inline the built index into a single self-contained page.
 *
 * The site is one static file with its data baked in as `window.__DATA__`, so it can
 * be published anywhere without a server or a fetch that could fail. `site/offseason.html`
 * is the source and is edited by hand; `site/offseason-live.html` is generated and
 * should never be edited, because the next build overwrites it.
 *
 * This used to be done by hand, which meant the published page could silently lag the
 * data in site/data. It is a script so that "rebuild, then republish" is two commands
 * with nothing to remember in between.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const SRC = new URL('../site/offseason.html', import.meta.url).pathname;
const OUT = new URL('../site/offseason-live.html', import.meta.url).pathname;
const DATA = new URL('../site/data', import.meta.url).pathname;

const read = (name, fallback) => {
  try {
    return JSON.parse(readFileSync(`${DATA}/${name}`, 'utf8'));
  } catch {
    return fallback;
  }
};

export function bundle() {
  const players = read('players.json', []);
  const perfs = read('performances.json', []);
  const days = read('days.json', []);
  const meta = read('meta.json', {});
  const fixtures = read('fixtures.json', []);
  // Career aggregates, keyed by player id. Computed in build-index so the arithmetic
  // is tested rather than repeated in the page.
  const careers = read('careers.json', {});

  const payload = {
    players: players.players ?? players,
    perfs: perfs.rows ?? perfs,
    days: days.days ?? days,
    meta,
    fixtures: fixtures.fixtures ?? fixtures.rows ?? fixtures,
    careers,
  };

  const html = readFileSync(SRC, 'utf8');

  // The placeholder is whatever assignment the source already carries, so the source
  // page stays runnable on its own with a stub while the built one gets real data.
  const marker = /window\.__DATA__\s*=\s*(\{[\s\S]*?\}|null|undefined)\s*;/;
  if (!marker.test(html)) {
    throw new Error(
      'bundle-site: no `window.__DATA__ = ...;` assignment found in site/offseason.html. ' +
        'The page must declare one for the data to be injected into.'
    );
  }

  // JSON is embedded in a <script>, so a literal "</script>" inside a string would end
  // the block early. Escaping the slash is enough and keeps the JSON valid.
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/');
  const out = html.replace(marker, `window.__DATA__ = ${json};`);

  writeFileSync(OUT, out);
  return {
    players: payload.players.length,
    perfs: payload.perfs.length,
    days: payload.days.length,
    fixtures: payload.fixtures.length,
    careers: Object.keys(payload.careers).length,
    bytes: out.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = bundle();
  console.log(
    `bundled ${s.players} players / ${s.perfs} performances / ${s.days} days / ` +
      `${s.fixtures} fixtures / ${s.careers} careers -> site/offseason-live.html ` +
      `(${(s.bytes / 1024).toFixed(0)} KB)`
  );
}
