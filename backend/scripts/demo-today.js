// Brings every demo business up to this moment, in one go: the realistic
// businesses of every type (and their branches), then the demo restaurant's
// trading days, then the restaurant's today tidied (old days closed, today
// open with live orders).
//
//   npm run demo:today -- --user-id <owner id>
//
// The owner id may also come from DEMO_OWNER_ID in backend/.env. Run it
// before a demo: each run adds trade up to the current time and nothing twice.
require('dotenv').config({ quiet: true });
const { spawnSync } = require('child_process');
const path = require('path');

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const userId = arg('--user-id') || process.env.DEMO_OWNER_ID;
if (!/^\d+$/.test(String(userId || ''))) {
  console.error('Usage: npm run demo:today -- --user-id <owner id>   (or set DEMO_OWNER_ID in backend/.env)');
  process.exit(1);
}

const steps = [
  ['Realistic businesses', 'seed-realistic-demos.js', ['--user-id', userId]],
  ['Restaurant trading days', 'topup-demo.js', []],
  ["Restaurant's today", 'tidy-restaurant-demo.js', ['--user-id', userId]],
];
for (const [label, file, args] of steps) {
  console.log(`\n== ${label}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file), ...args], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  if (result.status !== 0) {
    console.error(`${label} stopped (exit ${result.status}). Fix the message above and run again: nothing is posted twice.`);
    process.exit(result.status || 1);
  }
}
console.log('\nEvery demo business is up to date.');
