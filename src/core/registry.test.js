/**
 * Identity resolution tests.
 *
 * These cases are not hypothetical — each one is a real collision found in the
 * Cricsheet register. The Sharma case in particular encodes a finding worth
 * preserving: cricinfo 34102 ("RG Sharma") is the India captain, while cricinfo
 * 924355 ("Rohit Sharma") is a different real player. Name text alone cannot
 * separate them, so the correct behaviour is to refuse rather than guess.
 *
 * Run: node --test src/core/registry.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlayerRegistry, nameSignature, normaliseName } from './registry.js';

const registry = PlayerRegistry.load();

const CRICINFO_ROHIT_CAPTAIN = '34102';
const CRICINFO_ROHIT_OTHER = '924355';
const CRICINFO_BUMRAH = '625383';

test('normalises punctuation and diacritics', () => {
  assert.equal(normaliseName('M.S. Dhoni'), 'm s dhoni');
  // Both collapse to the same signature, which is what lets a full name and an
  // initialled scorecard entry find each other.
  assert.equal(nameSignature('Hardik Pandya'), 'pandya|h');
  assert.equal(nameSignature('HH Pandya'), 'pandya|h');
});

test('source id resolution is exact and wins over name', () => {
  const res = registry.resolve({
    sourceKey: 'key_cricinfo',
    sourceId: CRICINFO_BUMRAH,
    name: 'Totally Wrong Name',
  });
  assert.equal(res.confidence, 'exact');
  assert.equal(res.player.unique_name, 'JJ Bumrah');
});

test('links the same player across scorecard name styles', () => {
  const forms = ['Hardik Pandya', 'HH Pandya', 'H Pandya'];
  const ids = forms.map((n) => registry.resolve({ name: n }).player?.identifier);
  assert.ok(ids[0], 'expected Hardik Pandya to resolve');
  assert.ok(ids.every((id) => id === ids[0]), 'all name forms must map to one player');
});

test('refuses to guess between two real players sharing a name', () => {
  // The failure this prevents: crediting the captain's runs to another player.
  const res = registry.resolve({ name: 'Rohit Sharma' });
  assert.equal(res.player, null);
  assert.equal(res.confidence, 'ambiguous');
});

test('squad context disambiguates what the name cannot', () => {
  const captain = registry.bySource('key_cricinfo', CRICINFO_ROHIT_CAPTAIN);
  const other = registry.bySource('key_cricinfo', CRICINFO_ROHIT_OTHER);
  assert.notEqual(captain.identifier, other.identifier);

  for (const name of ['Rohit Sharma', 'RG Sharma', 'R Sharma']) {
    const res = registry.resolve({ name, hint: { squad: [captain.identifier] } });
    assert.equal(res.confidence, 'exact', `${name} should resolve with squad hint`);
    assert.equal(res.player.identifier, captain.identifier);
  }

  // Same text, different squad, must resolve to the *other* player.
  const res = registry.resolve({
    name: 'Rohit Sharma',
    hint: { squad: [other.identifier] },
  });
  assert.equal(res.player.identifier, other.identifier);
});

test('unknown players are reported, not invented', () => {
  const res = registry.resolve({ name: 'Not A Real Cricketer' });
  assert.equal(res.player, null);
  assert.equal(res.confidence, 'unknown');
});

test('a CREX name only overrides when it can be the same player', async () => {
  const { displayName, sameSurname } = await import('./display-name.js');

  // The real bug: a mispinned slug put "Ankush Kumar" over Ashwani Kumar. Same
  // surname, different cricketer — the override must be refused.
  assert.equal(sameSurname('Ankush Kumar', 'Ashwani Kumar'), false);
  assert.equal(
    displayName({ registerName: 'Ashwani Kumar', crexName: 'Ankush Kumar' }),
    'Ashwani Kumar'
  );

  // Legitimate expansions of an initialled register name must still apply.
  for (const [reg, crex] of [
    ['MD Shanaka', 'Dasun Shanaka'],
    ['YBK Jaiswal', 'Yashasvi Jaiswal'],
    ['PVD Chameera', 'Dushmantha Chameera'],
    ['KK Ahmed', 'Khaleel Ahmed'],
  ]) {
    assert.equal(displayName({ registerName: reg, crexName: crex }), crex, `${reg} -> ${crex}`);
  }

  // Different surnames never merge.
  assert.equal(sameSurname('Mukesh Choudhary', 'Mukesh Kumar'), false);
});
