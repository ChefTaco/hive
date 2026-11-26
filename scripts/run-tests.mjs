#!/usr/bin/env node
// Runs a named test list from scripts/test-suite.json with bounded parallelism, prints each
// test's output when it finishes, and ends with a pass/fail summary of every test, so one
// failure never hides the others. Entries marked "serial" run alone after the parallel ones.
//   node scripts/run-tests.mjs LIST [--jobs N] [FILTER...]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const name = argv.shift();
let jobs = Number(process.env.HIVE_TEST_JOBS || Math.min(4, availableParallelism()));
const filters = [];
while (argv.length) {
  const value = argv.shift();
  if (value === '--jobs') jobs = Number(argv.shift());
  else filters.push(value);
}
const lists = JSON.parse(readFileSync(resolve(root, 'scripts/test-suite.json'), 'utf8'));
if (!name || !Array.isArray(lists[name])) {
  console.error(`Usage: run-tests.mjs LIST [--jobs N] [FILTER...]; lists: ${Object.keys(lists).filter((key) => Array.isArray(lists[key])).join(', ')}`);
  process.exit(2);
}
if (!Number.isInteger(jobs) || jobs < 1) { console.error('--jobs must be a positive integer'); process.exit(2); }
const entries = lists[name]
  .map((entry) => ({ ...entry, label: entry.run.join(' ') }))
  .filter((entry) => !filters.length || filters.some((filter) => entry.label.includes(filter)));
if (!entries.length) { console.error('No test matches'); process.exit(2); }

function run(entry) {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(entry.run[0], entry.run.slice(1), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    child.on('error', (error) => output.push(Buffer.from(`${error.message}\n`)));
    child.on('close', (code, signal) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const passed = code === 0;
      process.stdout.write(`\n${passed ? 'PASS' : 'FAIL'} ${entry.label} (${seconds}s${signal ? `, ${signal}` : ''})\n`);
      if (!passed || process.env.HIVE_TEST_VERBOSE) process.stdout.write(Buffer.concat(output));
      done({ entry, passed, seconds });
    });
  });
}

async function pool(items, limit) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) results.push(await run(items[next++]));
  }));
  return results;
}

const started = Date.now();
const results = [
  ...await pool(entries.filter((entry) => !entry.serial), jobs),
  ...await pool(entries.filter((entry) => entry.serial), 1),
];
const failed = results.filter((result) => !result.passed);
console.log(`\n${name}: ${results.length - failed.length} passed, ${failed.length} failed in ${((Date.now() - started) / 1000).toFixed(0)}s with ${jobs} jobs`);
for (const result of failed) console.log(`  FAIL ${result.entry.label}`);
process.exit(failed.length ? 1 : 0);
