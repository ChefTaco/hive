import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readArchive, boundedResponse } from './archive-utils.mjs';
import { syncSkills } from './hermes-sync.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hive-skills-fixture-'));
  const source = join(root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), '# Fixture\n');
  const archive = join(root, 'skill.tgz');
  const pack = () => { assert.equal(spawnSync('tar', ['-czf', archive, '-C', source, '.']).status, 0); return readFileSync(archive); };
  return { root, source, pack };
}

test('rejects symlinks and validates skill root before extraction', () => {
  const f = fixture();
  try {
    assert.ok(readArchive(f.pack()).some((entry) => entry.name === 'SKILL.md'));
    symlinkSync('/etc/passwd', join(f.source, 'link'));
    assert.throws(() => readArchive(f.pack()), /regular files/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('size enforcement counts streamed bytes without trusting Content-Length', async () => {
  await assert.rejects(boundedResponse(new Response(new Uint8Array(1025)), 1024), /size limit/);
});

test('bridge declares its Hermes version and rejects incompatible server entries', async () => {
  const f = fixture();
  try {
    let requested;
    const entry = { slug: 'fixture', version: '1.0.0', sha256: 'a'.repeat(64), compatibility: { minHermesVersion: '3.0.0', maxHermesVersion: null }, archiveUrl: 'https://registry.test/v1/skills/fixture/releases/1.0.0/archive' };
    await assert.rejects(syncSkills({
      registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), hermesVersion: '2.4.0', restart: () => {},
      fetchImpl: async (url) => { requested = new URL(url); return Response.json({ schemaVersion: 1, skills: [entry] }); },
    }), /incompatible/);
    assert.equal(requested.searchParams.get('hermes_version'), '2.4.0');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('sync installs, withdraws only managed content and retries failed gateway restart', async () => {
  const f = fixture();
  try {
    const bytes = f.pack();
    const entry = { slug: 'fixture', version: '1.0.0', sha256: createHash('sha256').update(bytes).digest('hex'), archiveUrl: 'https://registry.test/v1/skills/fixture/releases/1.0.0/archive' };
    let skills = [entry]; let restarts = 0;
    const fetchImpl = async (url) => String(url).endsWith('/manifest') ? Response.json({ schemaVersion: 1, skills }) : new Response(bytes);
    const options = { registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), fetchImpl, restart: () => { restarts++; } };
    await syncSkills(options);
    assert.ok(existsSync(join(options.hermesHome, 'skills/registry/fixture/SKILL.md')));
    await syncSkills(options); assert.equal(restarts, 1);
    const local = join(options.hermesHome, 'skills/local'); mkdirSync(local); writeFileSync(join(local, 'SKILL.md'), 'local');
    skills = [];
    await assert.rejects(syncSkills({ ...options, restart: () => { throw new Error('restart failure'); } }), /restart failure/);
    assert.equal(existsSync(join(options.hermesHome, 'skills/registry/fixture')), false);
    assert.ok(existsSync(join(local, 'SKILL.md')));
    await syncSkills(options); assert.equal(restarts, 2);
    skills = [{ ...entry, archiveUrl: 'https://registry.test.evil.invalid/v1/skills/fixture/releases/1.0.0/archive' }];
    await assert.rejects(syncSkills(options), /origin/);
    await assert.rejects(syncSkills({ ...options, registry: 'https://other-install.test' }), /different registry/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const boundary of ['prepared', 'backed-up', 'activated', 'published']) test(`recovers activation interrupted at ${boundary}`, async () => {
  const f = fixture();
  try {
    let bytes = f.pack();
    const entry = () => ({ slug: 'fixture', version: '1.0.0', sha256: createHash('sha256').update(bytes).digest('hex'), archiveUrl: 'https://registry.test/v1/skills/fixture/releases/1.0.0/archive' });
    const options = { registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), fetchImpl: async (url) => String(url).endsWith('/manifest') ? Response.json({ schemaVersion: 1, skills: [entry()] }) : new Response(bytes), restart: () => {} };
    await syncSkills(options);
    writeFileSync(join(f.source, 'SKILL.md'), '# Updated fixture'); bytes = f.pack();
    await assert.rejects(syncSkills({ ...options, checkpoint: (step) => { if (step === boundary) throw new Error('interrupted'); } }), /interrupted/);
    await syncSkills(options);
    assert.equal(readFileSync(join(options.hermesHome, 'skills/registry/fixture/SKILL.md'), 'utf8'), '# Updated fixture');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('canary manifests download from the channel-scoped archive URL', async () => {
  const f = fixture();
  try {
    const bytes = f.pack();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const base = 'https://registry.test/v1/skills/fixture/releases/1.1.0/archive';
    const fetched = [];
    let archiveUrl = base + '?channel=canary';
    const fetchImpl = async (url) => {
      if (new URL(url).pathname.endsWith('/manifest')) {
        return Response.json({ schemaVersion: 1, channel: 'canary', skills: [{ slug: 'fixture', version: '1.1.0', sha256, archiveUrl }] });
      }
      if (new URL(url).pathname.startsWith('/v1/agent/receipts/')) return Response.json({ ok: true });
      fetched.push(String(url));
      return new Response(bytes);
    };
    const options = { registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), fetchImpl, target: 'agent-1', token: 'tok', restart: () => {} };
    await syncSkills(options);
    assert.deepEqual(fetched, [base + '?channel=canary']);
    archiveUrl = base;
    await assert.rejects(syncSkills({ ...options, hermesHome: join(f.root, 'other') }), /Unexpected archive origin or path/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
