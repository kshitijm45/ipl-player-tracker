/**
 * Which players the backfill can see.
 *
 * The scorecard keys players by slug and the performance store keys them by canonical
 * id, so the pin file is the bridge. A player with no Cricsheet id has no canonical
 * id either: he is pinned by name, and his innings are stored under his slug.
 *
 * Reading only `pins` left all 23 of those players invisible — the lookup came back
 * undefined and every row was skipped, so Wanindu Hasaranga's 23 bowling innings never
 * received their balls bowled and he had no economy or strike rate at all. The run
 * reported success either way: 848 of 848 scorecards read, 20 innings given balls.
 *
 * Run: node --test src/backfill-scorecards.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugsById } from './backfill-scorecards.js';

const file = {
  pins: {
    '11061889': { slug: 'saurabh-dubey-62M' },
    b4b99816: { slug: 'shubman-gill-O5' },
  },
  slugPins: {
    'Wanindu Hasaranga': { slug: 'wanindu-hasaranga-10N' },
    'Richard Gleeson': { slug: 'richard-gleeson-1JM' },
  },
};

test('a pinned player is found by his canonical id', () => {
  assert.equal(slugsById(file).get('11061889'), 'saurabh-dubey-62M');
});

test('a slug-pinned player is found by his slug', () => {
  // His rows are stored under the slug, so the slug is both key and value.
  assert.equal(slugsById(file).get('wanindu-hasaranga-10N'), 'wanindu-hasaranga-10N');
  assert.equal(slugsById(file).get('richard-gleeson-1JM'), 'richard-gleeson-1JM');
});

test('both kinds are mapped, not one or the other', () => {
  assert.equal(slugsById(file).size, 4);
});

test('a file with no slug pins still works', () => {
  assert.equal(slugsById({ pins: file.pins }).size, 2);
});

test('an empty or missing file yields nothing rather than throwing', () => {
  assert.equal(slugsById({}).size, 0);
  assert.equal(slugsById(null).size, 0);
});

test('a pin with no slug is skipped', () => {
  const m = slugsById({ pins: { x: {} }, slugPins: { Y: {} } });
  assert.equal(m.size, 0);
});
