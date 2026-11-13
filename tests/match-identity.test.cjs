const test = require('node:test');
const assert = require('node:assert/strict');
const { allowsClip, latestScorer, scopedVisibilityID, validChange, publicVisibility } = require('../lib/admin-visibility.cjs');

const scorerA = '80c7442eb2ca4aeabfb6779128d91b8a';
const scorerB = '994bd24b405943c790d9b8b32d3e13e2';

function feed(source) {
  return { installation_id: source, synced_at: 1, tables: {
    matches: [{ id: 1, tournament_id: 9 }],
    teams: [{ id: 1, name: source === scorerA ? 'Alpha A' : 'Alpha B' }]
  } };
}

test('scorer snapshots keep identical numeric match IDs distinct', () => {
  const merged = latestScorer([feed(scorerA), feed(scorerB)]);
  const matches = merged.tables.matches;
  assert.deepEqual(Object.keys(matches).sort(), [`${scorerA}:1`, `${scorerB}:1`].sort());
  assert.equal(matches[`${scorerA}:1`].source_installation_id, scorerA);
  assert.equal(matches[`${scorerB}:1`].source_installation_id, scorerB);
});

test('visibility prefers source-qualified rules and falls back to legacy IDs', () => {
  const scopedMatch = scopedVisibilityID(scorerA, '1');
  const scopedTournament = scopedVisibilityID(scorerA, '9');
  const rules = { tournaments: { [scopedTournament]: { show: true }, [scopedVisibilityID(scorerB, '9')]: { show: true } },
    matches: { [scopedMatch]: { show: false } } };
  assert.equal(allowsClip('1', '9', rules, scorerA), false);
  assert.equal(allowsClip('1', '9', rules, scorerB), true);
  assert.equal(allowsClip('1', '9', { tournaments: { 9: { show: true } } }, scorerA), true);
});

test('visibility accepts safe text tournament IDs and source-qualified slugs', () => {
  assert.equal(validChange({ scope: 'tournaments', id: 'ggpl-2026', show: true }), true);
  assert.equal(validChange({ scope: 'tournaments', id: `${scorerA}:ggpl-2026`, show: false }), true);
  assert.equal(validChange({ scope: 'tournaments', id: 'ggpl/2026', show: true }), false);
  assert.equal(validChange({ scope: 'tournaments', id: '../all', show: true }), false);
  assert.equal(validChange({ scope: 'tournaments', id: `${scorerA}:ggpl/2026`, show: true }), false);
});

test('public visibility preserves safe text IDs while excluding unsafe keys', () => {
  const result = publicVisibility({
    tournaments: {
      'ggpl-2026': { show: true },
      [`${scorerA}:ggpl-2026`]: { show: false },
      'ggpl/2026': { show: true }
    }
  });
  assert.deepEqual(result.tournaments, {
    'ggpl-2026': { show: true },
    [`${scorerA}:ggpl-2026`]: { show: false }
  });
});
