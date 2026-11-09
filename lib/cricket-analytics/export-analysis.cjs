'use strict';
// Offline analysis only. Reads a previously authorized JSON export, never connects to Firebase.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { analyzeArchives } = require('./index.cjs');
function exportAnalysis(inputPath, outputDirectory, options = {}) {
  const input = fs.readFileSync(inputPath);
  const payload = JSON.parse(input);
  const result = analyzeArchives(Array.isArray(payload) ? payload : payload.archives, options);
  const report = {
    source: 'Read-only authenticated /api/scoring-archives response; no additional database reads',
    inputSHA256: crypto.createHash('sha256').update(input).digest('hex'),
    coverage: result.coverage,
    inningsReconciliation: result.reconciliation,
    warnings: result.warnings,
    limitations: [
      'Match selection is confirmed by lineup or batting/bowling participation; unproven roster appearances remain unknown.',
      'Player identity is installation_id + player_id. Different IDs are not merged by name or phone.',
      'Boundary attribution uses explicit boundary, or bat_runs 4/6 with completed_runs 0; mixed overthrow/running attribution is rejected.',
      'Derived per-player figures reconcile to archived innings totals, not an independently stored player scorecard.',
      'Aggregate statistics cover supplied archives only; not a claim of full lifetime coverage.',
      'No UI, endpoint, deployment, live-scoring or authentication changes.'
    ]
  };
  fs.mkdirSync(outputDirectory, { recursive: true });
  // Fail rather than overwrite previous audit artifacts.
  fs.writeFileSync(path.join(outputDirectory, 'four-match-player-analytics.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(outputDirectory, 'reconciliation-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}
if (require.main === module) {
  const [inputPath, outputDirectory] = process.argv.slice(2);
  if (!inputPath || !outputDirectory) {
    console.error('Usage: node export-analysis.cjs <authorized-export.json> <new-output-directory>');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(exportAnalysis(inputPath, outputDirectory).coverage)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
module.exports = { exportAnalysis };
