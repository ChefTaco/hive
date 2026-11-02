// Runs in a child process so Node loads the disposable installation's CA at startup.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifySkills({ baseUrl, runtime, hermesHome }) {
  const get = (path) => fetch(new URL(path, baseUrl), {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/admin/skills')).status, 401);
  assert.equal((await get('/v1/agent/manifest?target=unregistered-agent')).status, 401);
  const catalogResponse = await get('/v1/skills');
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.ok(catalog.some((entry) => entry.slug === 'hivemem'));
  const manifestResponse = await get('/v1/agent/manifest');
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  const skill = manifest.skills.find((entry) => entry.slug === 'hivemem');
  assert.ok(skill);
  // Never follow an archive URL away from the isolated registry.
  assert.equal(new URL(skill.archiveUrl).origin, new URL(baseUrl).origin);
  const archive = await get(skill.archiveUrl);
  assert.equal(archive.status, 200);
  const digest = createHash('sha256').update(Buffer.from(await archive.arrayBuffer())).digest('hex');
  assert.equal(digest, skill.sha256);
  assert.equal(archive.headers.get('x-content-sha256'), digest);
  const { syncSkills } = await import(pathToFileURL(join(runtime, 'hive-skills/scripts/hermes-sync.mjs')).href);
  let restarts = 0;
  const options = { registry: baseUrl, hermesHome, hermesVersion: '3.0.0', restart: () => { restarts++; } };
  await syncSkills(options);
  const firstRestarts = restarts;
  assert.ok(firstRestarts <= 1);
  await syncSkills(options);
  assert.equal(restarts, firstRestarts, 'an unchanged second pull must not restart Hermes');
  assert.match(readFileSync(join(hermesHome, 'skills/registry/hivemem/SKILL.md'), 'utf8'), /HiveMem/);
  return { catalog, skills: manifest.skills, archiveDigest: digest, bridge: true, replay: true, authBoundaries: true };
}

async function main() {
  const context = JSON.parse(readFileSync(process.env.HIVE_FRESH_CONTEXT, 'utf8'));
  if (process.argv[2] === 'model') {
    const { readModelE2eConfig, runModelE2e } = await import('./model-e2e.ts');
    const { HiveMem } = await import(pathToFileURL(join(context.clients, 'node_modules/@hivemagnus/hivemem-sdk/dist/index.js')).href);
    const report = await runModelE2e(readModelE2eConfig(process.env), {
      memoryFactory: async (options) => new HiveMem(options),
      checkpoint: (value) => writeFileSync(context.modelReport, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }),
      onCheck: (check) => console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}`),
    });
    return report.success ? 0 : 1;
  }
  if (process.argv[2] === 'skills') {
    const result = await verifySkills(context);
    writeFileSync(context.skillsReport, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    return 0;
  }
  throw new Error('Unknown fresh-install probe');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Keep provider errors, response bodies and credentials out of persistent output.
  try { process.exitCode = await main(); }
  catch { console.error('Fresh-install probe failed; inspect the private report checks.'); process.exitCode = 1; }
}
