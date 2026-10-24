import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const iamDeployPath = new URL('../services/hive-iam/scripts/deploy-iam-core.sh', import.meta.url).pathname;
const iamGatePath = new URL('../services/hive-iam/apps/iam-core/scripts/run-db-release-gate.sh', import.meta.url).pathname;
const retiredIamComposePath = new URL('../services/hive-iam/apps/iam-core/docker/docker-compose.yml', import.meta.url).pathname;
const iamSeedPath = new URL('../services/hive-iam/apps/iam-core/prisma/seed.ts', import.meta.url).pathname;
const iamClientsRoutePath = new URL('../services/hive-iam/apps/iam-core/src/routes/clients.ts', import.meta.url).pathname;
const routerComposePath = new URL('../services/hive-router/docker-compose.example.yml', import.meta.url).pathname;
const routerDeployPath = new URL('../services/hive-router/scripts/deploy-hive-router.sh', import.meta.url).pathname;
const routerEnvPath = new URL('../services/hive-router/src/config/env.ts', import.meta.url).pathname;

function runGate(migrationStatus: number, seedStatus: number) {
  const fixture = mkdtempSync(join(tmpdir(), 'hive-iam-db-gate-'));
  const bin = join(fixture, 'bin');
  const log = join(fixture, 'commands.log');
  const activated = join(fixture, 'activated');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash\necho migration >> "$HIVE_GATE_LOG"\nexit "\${HIVE_MIGRATION_STATUS}"\n`);
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\necho seed >> "$HIVE_GATE_LOG"\nexit "\${HIVE_SEED_STATUS}"\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  chmodSync(join(bin, 'npm'), 0o755);
  const result = spawnSync(
    'bash',
    ['-c', 'bash "$1" --seed && touch "$2"', 'gate-test', iamGatePath, activated],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HIVE_GATE_LOG: log,
        HIVE_MIGRATION_STATUS: String(migrationStatus),
        HIVE_SEED_STATUS: String(seedStatus),
      },
    },
  );
  return {
    result,
    activated: existsSync(activated),
    commands: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
  };
}

describe('release configuration hardening', () => {
  it('prevents activation when the IAM migration fails', () => {
    const outcome = runGate(1, 0);
    assert.notEqual(outcome.result.status, 0);
    assert.equal(outcome.activated, false);
    assert.deepEqual(outcome.commands, ['migration']);
  });

  it('prevents activation when a required idempotent seed fails', () => {
    const outcome = runGate(0, 1);
    assert.notEqual(outcome.result.status, 0);
    assert.equal(outcome.activated, false);
    assert.deepEqual(outcome.commands, ['migration', 'seed']);
  });

  it('allows activation only after migration and required seed both pass', () => {
    const outcome = runGate(0, 0);
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.equal(outcome.activated, true);
    assert.deepEqual(outcome.commands, ['migration', 'seed']);
  });

  it('keeps IAM deployment wired to the fatal database gate', () => {
    const deploy = readFileSync(iamDeployPath, 'utf8');
    assert.match(deploy, /run-db-release-gate\.sh --seed/);
    assert.match(deploy, /run-db-release-gate\.sh --no-seed/);
    assert.match(deploy, /Rebuilding on target[\s\S]*npm run clean\s+npm run build/);
    assert.doesNotMatch(deploy, /Migration skipped|Seed failed \(may already exist\)/);
  });

  it('retires the obsolete MySQL and unauthenticated Redis compose stack', () => {
    assert.equal(existsSync(retiredIamComposePath), false);
  });

  it('requires explicit strong administrator and client seed credentials', () => {
    const seed = readFileSync(iamSeedPath, 'utf8');
    const clientsRoute = readFileSync(iamClientsRoutePath, 'utf8');
    assert.doesNotMatch(seed, /Admin1234|rootpassword|iam_pass/);
    assert.doesNotMatch(seed, /nanoid|ephemeral (?:Hive|Router) client secret/);
    assert.match(seed, /SEED_ADMIN_PASSWORD is required and must contain at least 16 characters/);
    assert.match(seed, /SEED_EXAMPLE_PORTAL_CLIENT_SECRET must contain at least 32 characters/);
    assert.match(seed, /planSeedClientSecret/);
    assert.match(clientsRoute, /\/:id\/rotate-secret/);
    assert.match(clientsRoute, /client\.secret_rotated/);
  });

  it('keeps the Router example loopback-only and free of placeholder credentials', () => {
    const compose = readFileSync(routerComposePath, 'utf8');
    assert.match(compose, /127\.0\.0\.1:\$\{HIVE_ROUTER_API_PORT:-4020\}:4020/);
    assert.match(compose, /127\.0\.0\.1:\$\{HIVE_ROUTER_ADMIN_PORT:-9443\}:9443/);
    assert.match(compose, /HIVE_ROUTER_SECRET: \$\{HIVE_ROUTER_SECRET:\?/);
    assert.doesNotMatch(compose, /(?:^|\s)(?:443|9443):(?:443|9443)|replace-me|changeme/i);
  });

  it('removes the dead Router password schema and strips stale deployed keys', () => {
    const schema = readFileSync(routerEnvPath, 'utf8');
    const deploy = readFileSync(routerDeployPath, 'utf8');
    assert.doesNotMatch(schema, /ADMIN_PASSWORD|changeme-now/);
    assert.doesNotMatch(deploy, /ADMIN_PASSWORD=unused-with-os-auth/);
    assert.match(deploy, /\^ADMIN_USERNAME=\/d; \/\^ADMIN_PASSWORD=\/d/);
  });
});
