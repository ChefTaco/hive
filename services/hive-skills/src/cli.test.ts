import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { packageRoot, bundledDeployScript, bundledSeedSource } from './paths.js';

const cli = resolve(packageRoot, 'dist/cli.js');
function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
}

test('installed CLI help, version and invalid arguments never initialize storage', () => {
  const cwd = mkdtempSync(resolve(tmpdir(), 'skills-cli-'));
  try {
    assert.equal(run(['--help'], cwd).status, 0);
    const version = run(['--version'], cwd);
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).version);
    for (const args of [['--unknown'], ['--env-file'], ['--env-file', 'missing.env'], ['start', 'seed']]) {
      const result = run(args, cwd);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /hive-skills:|env-file|missing.env/);
    }
    assert.equal(existsSync(resolve(cwd, 'data')), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('explicit seed finds bundled assets from outside the package and refuses reseeding', () => {
  const cwd = mkdtempSync(resolve(tmpdir(), 'skills-seed-'));
  try {
    const data = resolve(cwd, 'state');
    const env = resolve(cwd, 'registry.env');
    writeFileSync(env, `HIVE_SKILLS_DATA_DIR=${JSON.stringify(data)}\nHIVE_SKILLS_SESSION_SECRET=fixture-only-secret-01234567890123456789\nHIVE_SKILLS_ADMIN_USERS=admin\n`);
    const seeded = run(['seed', '--env-file', env], cwd);
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.match(seeded.stdout, /Seeded hivemem@1.0.0/);
    const db = new DatabaseSync(resolve(data, 'registry.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare("SELECT version FROM channel_releases WHERE channel='stable' AND skill_slug='hivemem'").get()?.version, '1.0.0'); } finally { db.close(); }
    const repeated = run(['seed', '--env-file', env], cwd);
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /releases are immutable/);
    assert.ok(existsSync(bundledDeployScript));
    assert.ok(existsSync(resolve(bundledSeedSource, 'SKILL.md')));
    assert.equal(existsSync(resolve(cwd, 'data')), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('env-schema is configuration-free and check never initializes missing storage or reveals secrets', () => {
  const cwd = mkdtempSync(resolve(tmpdir(), 'skills-preflight-'));
  try {
    const schema = run(['env-schema'], cwd);
    assert.equal(schema.status, 0, schema.stderr);
    const document = JSON.parse(schema.stdout);
    assert.equal(document.service, 'skills');
    assert.equal(document.healthPath, '/healthz');
    assert.equal(document.env.find((v: { name: string }) => v.name === 'HIVE_SKILLS_SESSION_SECRET').generate, 'hex32');
    assert.equal(existsSync(resolve(cwd, 'data')), false);
    const secret = 'fixture-private-value';
    const envFile = resolve(cwd, 'check.env');
    writeFileSync(envFile, `HIVE_SKILLS_SESSION_SECRET=${secret}\nHIVE_SKILLS_DATA_DIR=${JSON.stringify(resolve(cwd, 'state'))}\n`);
    const checked = run(['check', '--env-file', envFile], cwd);
    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /FAIL/);
    assert.ok(!checked.stdout.includes(secret) && !checked.stderr.includes(secret));
    assert.equal(existsSync(resolve(cwd, 'state')), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
