#!/usr/bin/env node
// The upgrade matrix of deployment/QUICKSTART.md section 8, generated from
// deployment/upgrade-matrix.json between its markers.
//   node scripts/release/upgrade-matrix.mjs --write   rewrites the section
//   node scripts/release/upgrade-matrix.mjs --check   fails when the section is stale, a row is
//                                                    invalid, or the newest release has no row
// HIVE_DOCS_ROOT points the check at another tree (for its test).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.HIVE_DOCS_ROOT ? resolve(process.env.HIVE_DOCS_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const start = '<!-- upgrade-matrix:start (generated from deployment/upgrade-matrix.json by scripts/release/upgrade-matrix.mjs --write) -->';
const end = '<!-- upgrade-matrix:end -->';
const version = /^\d+\.\d+\.\d+$/;
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

export function validate(matrix, releases) {
  const problems = [];
  if (!matrix || !Array.isArray(matrix.rows) || matrix.rows.length === 0) return ['upgrade-matrix.json needs a non-empty "rows" list'];
  matrix.rows.forEach((row, index) => {
    const at = `row ${index + 1} (${row?.to ?? '?'})`;
    if (!row || typeof row !== 'object') { problems.push(`${at}: not an object`); return; }
    const extra = Object.keys(row).filter((key) => !['to', 'from', 'flag', 'when', 'note', 'upgrading'].includes(key));
    if (extra.length) problems.push(`${at}: unknown fields ${extra.join(', ')}`);
    if (typeof row.to !== 'string' || !version.test(row.to)) problems.push(`${at}: "to" must be a release version`);
    else if (!releases.includes(row.to)) problems.push(`${at}: release ${row.to} is not in releases/`);
    if (typeof row.from !== 'string' || !row.from.trim() || row.from.includes('|')) problems.push(`${at}: "from" must name the releases it covers`);
    if (!['no', 'always', 'when'].includes(row.flag)) problems.push(`${at}: "flag" is no, always or when`);
    if ((row.flag === 'when') !== (typeof row.when === 'string' && row.when.trim() !== '')) problems.push(`${at}: "when" is required with flag "when", and only then`);
    for (const field of ['note', 'when']) if (row[field] !== undefined && (typeof row[field] !== 'string' || /[|\n]/.test(row[field]))) problems.push(`${at}: "${field}" is one line without |`);
    if (typeof row.upgrading !== 'string' || !/^[a-z0-9-]+$/.test(row.upgrading)) problems.push(`${at}: "upgrading" is an UPGRADING.md anchor`);
    if (index > 0 && version.test(row.to) && version.test(matrix.rows[index - 1].to ?? '') && compare(row.to, matrix.rows[index - 1].to) <= 0) problems.push(`${at}: rows are in release order, newest last`);
  });
  const newest = [...releases].sort(compare).at(-1);
  if (newest && !matrix.rows.some((row) => row.to === newest)) problems.push(`the newest release, ${newest}, has no row: add one saying whether it needs --allow-migrations`);
  return problems;
}

export function render(matrix) {
  const flag = (row) => (row.flag === 'no' ? 'No' : row.flag === 'always' ? 'Yes' : `Only when ${row.when}`);
  const lines = [
    '| To | From | `--allow-migrations` | Notes |',
    '| --- | --- | --- | --- |',
    ...matrix.rows.map((row) => `| [${row.to}](../UPGRADING.md#${row.upgrading}) | ${row.from} | ${flag(row)} | ${row.note ?? ''} |`),
  ];
  return `${start}\n${lines.join('\n')}\n${end}`;
}

function main() {
  const mode = process.argv[2];
  if (mode !== '--write' && mode !== '--check') { console.error('Usage: upgrade-matrix.mjs --write|--check'); process.exit(2); }
  const matrix = JSON.parse(readFileSync(join(root, 'deployment/upgrade-matrix.json'), 'utf8'));
  const releases = readdirSync(join(root, 'releases')).filter((file) => /^\d+\.\d+\.\d+\.json$/.test(file)).map((file) => file.slice(0, -5));
  const problems = validate(matrix, releases);
  const quickstart = join(root, 'deployment/QUICKSTART.md');
  const text = readFileSync(quickstart, 'utf8');
  const from = text.indexOf(start), to = text.indexOf(end);
  if (from < 0 || to < from || text.indexOf(start, from + 1) >= 0) problems.push('deployment/QUICKSTART.md needs exactly one upgrade-matrix section between its markers');
  if (problems.length) { for (const problem of problems) console.error(`upgrade-matrix: ${problem}`); process.exit(1); }
  const next = text.slice(0, from) + render(matrix) + text.slice(to + end.length);
  if (mode === '--write') { if (next !== text) writeFileSync(quickstart, next); return; }
  if (next !== text) { console.error('upgrade-matrix: deployment/QUICKSTART.md is stale; run node scripts/release/upgrade-matrix.mjs --write'); process.exit(1); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
