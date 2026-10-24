import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const deployScript = readFileSync(new URL('./deploy-hive.sh', import.meta.url), 'utf8');
const routerDeployScript = readFileSync(new URL('../services/hive-router/scripts/deploy-hive-router.sh', import.meta.url), 'utf8');
const iamDeployScript = readFileSync(new URL('../services/hive-iam/scripts/deploy-iam-core.sh', import.meta.url), 'utf8');
const memoryDeployScript = readFileSync(new URL('../services/hive-mem/scripts/deploy_server.sh', import.meta.url), 'utf8');
const iamKeyRotationPath = new URL(
  '../services/hive-iam/apps/iam-core/scripts/rotate-jwt-signing-key.sh',
  import.meta.url,
).pathname;
const iamKeyValidatorPath = new URL(
  '../services/hive-iam/apps/iam-core/scripts/validate-jwt-keyring.mjs',
  import.meta.url,
).pathname;
const iamKeyRotationScript = readFileSync(iamKeyRotationPath, 'utf8');

function rotationFixture(options: { spoofActivatedJwks?: boolean; failRestartNumber?: number; destructionLogIsDirectory?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hive-iam-rotation-'));
  const iamRoot = join(root, 'iam');
  const keyringRoot = join(root, 'keyring');
  const releases = join(keyringRoot, 'releases');
  const initial = join(releases, 'initial');
  const helper = join(root, 'libexec');
  const destructionLog = join(root, 'destruction.log');
  mkdirSync(join(initial, 'previous'), { recursive: true });
  mkdirSync(iamRoot, { recursive: true });
  mkdirSync(helper, { recursive: true });
  if (options.destructionLogIsDirectory) mkdirSync(destructionLog);
  execFileSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', join(initial, 'active-private.pem')], { stdio: 'ignore' });
  execFileSync('openssl', ['pkey', '-in', join(initial, 'active-private.pem'), '-pubout', '-out', join(initial, 'active-public.pem')], { stdio: 'ignore' });
  writeFileSync(join(initial, 'keyring.env'), [
    `JWT_PRIVATE_KEY_PATH=${join(keyringRoot, 'current/active-private.pem')}`,
    `JWT_PUBLIC_KEY_PATH=${join(keyringRoot, 'current/active-public.pem')}`,
    'JWT_PREVIOUS_PUBLIC_KEY_PATHS=',
    '',
  ].join('\n'));
  symlinkSync('releases/initial', join(keyringRoot, 'current'));
  writeFileSync(join(iamRoot, '.env'), 'JWT_ACCESS_TTL=900\n');
  mkdirSync(join(iamRoot, 'certs'));
  writeFileSync(join(iamRoot, 'certs/ca.crt'), 'fixture CA used by the curl test double\n');
  cpSync(iamKeyValidatorPath, join(helper, 'validate-jwt-keyring.mjs'));

  const systemctl = join(root, 'systemctl');
  const systemctlLog = join(root, 'systemctl.log');
  writeFileSync(systemctl, `#!/usr/bin/env bash
count=0
[[ ! -f "$HIVE_TEST_SYSTEMCTL_LOG" ]] || count=$(wc -l < "$HIVE_TEST_SYSTEMCTL_LOG")
printf '%s\n' "$*" >> "$HIVE_TEST_SYSTEMCTL_LOG"
if [[ "\${HIVE_TEST_FAIL_RESTART_NUMBER:-0}" -eq "$((count + 1))" ]]; then exit 1; fi
exit 0
`);
  chmodSync(systemctl, 0o755);
  const curl = join(root, 'curl');
  writeFileSync(curl, `#!/usr/bin/env bash
url="\${!#}"
if [[ "$url" == *"/health/ready" ]]; then printf '{}'; exit 0; fi
kid=$(node "$HIVE_IAM_HELPER_DIR/validate-jwt-keyring.mjs" "$HIVE_IAM_KEYRING_ROOT/current")
if [[ "\${HIVE_TEST_SPOOF_ACTIVATED_JWKS:-false}" == "true" && "$(basename "$(readlink -f "$HIVE_IAM_KEYRING_ROOT/current")")" != "initial" ]]; then
  printf '{"keys":[{"kty":"RSA","use":"sig","alg":"RS256","kid":"%s","n":"AQAB","e":"AQAB"}]}' "$kid"
  exit 0
fi
node --input-type=module - "$HIVE_IAM_KEYRING_ROOT/current" <<'NODE'
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const release = process.argv[2];
const paths = [join(release, 'active-public.pem'), ...readdirSync(join(release, 'previous')).sort().map((name) => join(release, 'previous', name))];
const keys = paths.map((path) => {
  const jwk = createPublicKey(readFileSync(path, 'utf8')).export({ format: 'jwk' });
  const kid = createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest('base64url');
  return { ...jwk, use: 'sig', alg: 'RS256', kid };
});
process.stdout.write(JSON.stringify({ keys }));
NODE
`);
  chmodSync(curl, 0o755);

  return {
    keyringRoot,
    initial,
    destructionLog,
    journal: join(keyringRoot, 'rotation-journal.jsonl'),
    systemctlLog,
    env: {
      ...process.env,
      HIVE_IAM_ALLOW_NON_ROOT_TEST: 'true',
      HIVE_IAM_ROOT: iamRoot,
      HIVE_IAM_KEYRING_ROOT: keyringRoot,
      HIVE_IAM_HELPER_DIR: helper,
      HIVE_IAM_KEY_DESTRUCTION_LOG: destructionLog,
      HIVE_IAM_SYSTEMCTL: systemctl,
      HIVE_IAM_CURL: curl,
      HIVE_IAM_SERVICE_GROUP: process.getgid().toString(),
      HIVE_TEST_SYSTEMCTL_LOG: systemctlLog,
      HIVE_TEST_FAIL_RESTART_NUMBER: String(options.failRestartNumber ?? 0),
      HIVE_TEST_SPOOF_ACTIVATED_JWKS: options.spoofActivatedJwks ? 'true' : 'false',
    },
  };
}

describe('hive deploy verification', () => {
  it('keeps an explicit secondary-host dry-run isolated from primary-host .env defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-secondary-deploy-'));
    const scripts = join(root, 'scripts');
    const memoryScripts = join(root, 'services/hive-mem/scripts');
    const iamScripts = join(root, 'services/hive-iam/scripts');
    const routerScripts = join(root, 'services/hive-router/scripts');
    const skillsScripts = join(root, 'services/hive-skills/scripts');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(memoryScripts, { recursive: true });
    mkdirSync(iamScripts, { recursive: true });
    mkdirSync(routerScripts, { recursive: true });
    mkdirSync(skillsScripts, { recursive: true });
    writeFileSync(join(scripts, 'deploy-hive.sh'), deployScript);
    chmodSync(join(scripts, 'deploy-hive.sh'), 0o755);
    writeFileSync(join(root, '.env'), [
      'HIVE_DEPLOY_HOST=hive',
      'HIVE_PUBLIC_FQDN=hive.example.com',
      'HIVE_PUBLIC_URL=https://hive.example.com',
      'HIVEMEM_ENV_FILE=services/hive-mem/.env',
      'HIVE_DEPLOY_SKILLS=true',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'services/hive-mem/.env.server2'), '# memory-host fixture\n');
    writeFileSync(join(memoryScripts, 'deploy_server.sh'), `#!/usr/bin/env bash
printf 'MEMORY env=%s port=%s api=%s cors=%s preserve=%s refresh=%s args=%s\\n' "$2" "$HIVEMEM_DEPLOY_WEB_PORT" "$HIVEMEM_DEPLOY_API_URL" "$HIVEMEM_DEPLOY_CORS_ORIGINS" "$HIVEMEM_PRESERVE_REMOTE_ENV" "\${HIVEMEM_REFRESH_ADMIN_TOKEN:-default}" "$*"
`);
    writeFileSync(join(iamScripts, 'deploy-iam-core.sh'), `#!/usr/bin/env bash
printf 'IAM host=%s fqdn=%s args=%s\\n' "$HIVE_IAM_DEPLOY_HOST" "$HIVE_IAM_PUBLIC_FQDN" "$*"
`);
    writeFileSync(join(routerScripts, 'deploy-hive-router.sh'), `#!/usr/bin/env bash
printf 'ROUTER host=%s domain=%s public=%s memory=%s args=%s\\n' "$HIVE_ROUTER_DEPLOY_HOST" "$HIVE_ROUTER_CERT_DOMAIN" "$HIVE_ROUTER_PUBLIC_ADMIN_URL" "$HIVEMEM_INTERNAL_URL" "$*"
`);
    writeFileSync(join(skillsScripts, 'deploy-hive-skills.sh'), '#!/usr/bin/env bash\nprintf "SKILLS_UNEXPECTED\\n"\n');
    for (const path of [
      join(memoryScripts, 'deploy_server.sh'),
      join(iamScripts, 'deploy-iam-core.sh'),
      join(routerScripts, 'deploy-hive-router.sh'),
      join(skillsScripts, 'deploy-hive-skills.sh'),
    ]) chmodSync(path, 0o755);

    const result = spawnSync('bash', [join(scripts, 'deploy-hive.sh'), '--dry-run'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HIVE_DEPLOY_HOST: 'memory-host',
        HIVE_PUBLIC_FQDN: 'memory.example.com',
        HIVE_PUBLIC_URL: 'https://memory.example.com',
        HIVEMEM_ENV_FILE: 'services/hive-mem/.env.server2',
        HIVEMEM_DEPLOY_WEB_PORT: '18443',
        HIVEMEM_PRESERVE_REMOTE_ENV: 'true',
        HIVEMEM_REFRESH_ADMIN_TOKEN: 'false',
        HIVE_DEPLOY_SKILLS: 'false',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MEMORY env=.*\.env\.server2 port=18443 api=https:\/\/memory\.example\.com cors=https:\/\/memory\.example\.com preserve=true refresh=false/);
    assert.match(result.stdout, /IAM host=memory-host fqdn=memory\.example\.com/);
    assert.match(result.stdout, /ROUTER host=memory-host domain=memory\.example\.com public=https:\/\/memory\.example\.com memory=https:\/\/memory-host:18443/);
    assert.doesNotMatch(result.stdout, /SKILLS_UNEXPECTED|host=hive\b|domain=hive\.example\.com/);
  });

  it('requires an explicit deploy host and public FQDN', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-deploy-required-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts/deploy-hive.sh'), deployScript);
    const env = { ...process.env };
    delete env['HIVE_DEPLOY_HOST'];
    delete env['HIVE_PUBLIC_FQDN'];
    const missingHost = spawnSync('bash', [join(root, 'scripts/deploy-hive.sh'), '--dry-run'], { cwd: root, encoding: 'utf8', env });
    assert.notEqual(missingHost.status, 0);
    assert.match(missingHost.stderr, /HIVE_DEPLOY_HOST is required/);
    const missingFqdn = spawnSync('bash', [join(root, 'scripts/deploy-hive.sh'), '--dry-run'], { cwd: root, encoding: 'utf8', env: { ...env, HIVE_DEPLOY_HOST: 'hive' } });
    assert.notEqual(missingFqdn.status, 0);
    assert.match(missingFqdn.stderr, /HIVE_PUBLIC_FQDN is required/);
  });

  it('retains a preserved remote HiveMem admin bearer unless refresh is explicit', () => {
    assert.match(memoryDeployScript, /REFRESH_ADMIN_TOKEN="\$\{HIVEMEM_REFRESH_ADMIN_TOKEN:-\}"/);
    assert.match(memoryDeployScript, /PRESERVE_REMOTE_ENV" == "true"[\s\S]*REFRESH_ADMIN_TOKEN=false/);
    assert.match(memoryDeployScript, /if \[\[ "\$REFRESH_ADMIN_TOKEN" == "true" \]\]; then\s+remote_cmd "node '\$\{REMOTE_DIR\}\/scripts\/refresh_admin_token\.mjs'/);
    assert.match(memoryDeployScript, /AdminTokenRefresh:\$\{REFRESH_ADMIN_TOKEN\}/);
  });

  it('smokes the authenticated page proxy endpoints during deploy verification', () => {
    assert.match(deployScript, /api\/iam\/users\?limit=1/);
    assert.match(deployScript, /api\/memory\/dashboard-data/);
    assert.match(deployScript, /IAM proxy token unavailable/);
    assert.match(deployScript, /HIVE_ROUTER_MEMORY_PROXY_TOKEN is not configured/);
  });

  it('preserves or recovers the server-side proxy secrets during router deploy', () => {
    assert.match(routerDeployScript, /read_env\(\) \{ grep "\^\\\$2="/);
    assert.match(routerDeployScript, /HIVE_ROUTER_IAM_CLIENT_SECRET/);
    assert.match(routerDeployScript, /SEED_HIVE_ROUTER_CLIENT_SECRET/);
    assert.match(routerDeployScript, /HIVE_ROUTER_MEMORY_PROXY_TOKEN/);
    assert.match(routerDeployScript, /HIVEMEM_ADMIN_TOKEN/);
    assert.match(routerDeployScript, /HERMES_HIVEMEM_TOKEN/);
    assert.match(routerDeployScript, /HIVEMEM_MCP_TOKEN/);
    assert.match(routerDeployScript, /sudo -S -p ''/);
    assert.match(routerDeployScript, /do_sudo test -f \/opt\/hive-iam\/.env/);
    assert.match(routerDeployScript, /do_sudo test -f \/opt\/hivemem\/.env/);
    assert.match(routerDeployScript, /Router IAM proxy requires HIVE_ROUTER_IAM_CLIENT_SECRET/);
    assert.match(routerDeployScript, /Router Memory proxy requires HIVE_ROUTER_MEMORY_PROXY_TOKEN/);
  });

  it('bootstraps the Router IAM client secret only on first install', () => {
    assert.match(iamDeployScript, /BOOTSTRAPPED_ROUTER_CLIENT_SECRET=false/);
    assert.match(iamDeployScript, /BOOTSTRAPPED_ROUTER_CLIENT_SECRET=true/);
    assert.match(iamDeployScript, /SEED_HIVE_ROUTER_CLIENT_SECRET/);
    assert.match(iamDeployScript, /refusing silent credential replacement/);
    assert.match(iamDeployScript, /Routine IAM seed applied; no credential handoff file was created/);
    assert.match(
      iamDeployScript,
      /FIRST_INSTALL" == "true" \|\| "\\\$FORCE_SEED" == "true" \|\| "\\\$BOOTSTRAPPED_ROUTER_CLIENT_SECRET" == "true"/,
    );
  });

  it('keeps IAM TLS trust stable across leaf renewal', () => {
    assert.match(iamDeployScript, /PKI_DIR=\/var\/lib\/hive-iam-pki/);
    assert.match(iamDeployScript, /-days 30 -extfile/);
    assert.match(iamDeployScript, /private CA is incomplete; refusing to replace the trust anchor/);
    assert.match(iamDeployScript, /next-ca\.crt/);
    assert.match(iamDeployScript, /ca-bundle\.crt/);
    assert.match(routerDeployScript, /\/opt\/hive-iam\/certs\/ca-bundle\.crt/);
    assert.doesNotMatch(routerDeployScript, /cp \/opt\/hive-iam\/certs\/server\.crt "\\\$SHARED\/certs\/iam-ca\.crt"/);
  });

  it('pins internal service trust and rejects production TLS bypasses', () => {
    assert.match(routerDeployScript, /HIVEMEM_CA_CERT_PATH/);
    assert.match(routerDeployScript, /\/opt\/hivemem\/certs\/server\.crt/);
    assert.match(routerDeployScript, /HIVE_STATUS_ALLOW_INSECURE_TLS cannot be enabled/);
    assert.match(routerDeployScript, /npm audit --omit=dev --audit-level=high/);
    assert.doesNotMatch(routerDeployScript, /curl\s+-[^\n]*k/);
    assert.doesNotMatch(routerDeployScript, /npm uninstall --no-save/);
  });

  it('installs an atomic root-owned keyring with precise helper permissions', () => {
    assert.match(iamDeployScript, /Preserving host-managed JWT signing keyring/);
    assert.match(iamDeployScript, /sudo -S -p ''/);
    assert.match(iamKeyRotationScript, /JWT_PREVIOUS_PUBLIC_KEY_PATHS/);
    assert.match(iamKeyRotationScript, /now - modified >= ACCESS_TTL/);
    assert.match(iamKeyRotationScript, /activate_release/);
    assert.match(iamKeyRotationScript, /verify_live_release/);
    assert.match(iamKeyRotationScript, /--cacert "\$CA_CERT"/);
    assert.doesNotMatch(iamKeyRotationScript, /-fsSk|--insecure/);
    assert.match(iamKeyRotationScript, /rotation-journal\.jsonl/);
    assert.match(iamKeyRotationScript, /write_journal verified/);
    assert.match(iamKeyRotationScript, /write_journal finalized/);
    assert.match(iamKeyRotationScript, /127\.0\.0\.1:4200\/api\/v1\/oauth\/jwks/);
    assert.match(iamKeyRotationScript, /prior release was cryptographically verified after rollback/);
    assert.match(iamDeployScript, /\/usr\/local\/libexec\/hive-iam/);
    assert.match(iamDeployScript, /helper source contains a symlink or unexpected file type/);
    assert.match(iamDeployScript, /ReadWritePaths=.*\/prisma .*\/audit-logs/);
    assert.doesNotMatch(iamDeployScript, /find .*scripts -type f -exec chmod 755/);
  });

  it('atomically rotates, verifies, and destroys the retired private release', { timeout: 60_000 }, () => {
    const fixture = rotationFixture();
    const priorPrivate = readFileSync(join(fixture.initial, 'active-private.pem'), 'utf8');
    const result = spawnSync('bash', [iamKeyRotationPath], { env: fixture.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lstatSync(join(fixture.keyringRoot, 'current')).isSymbolicLink(), true);
    assert.notEqual(readFileSync(join(fixture.keyringRoot, 'current/active-private.pem'), 'utf8'), priorPrivate);
    assert.equal(readdirSync(join(fixture.keyringRoot, 'current/previous')).length, 1);
    assert.equal(readdirSync(join(fixture.keyringRoot, 'releases')).length, 1);
    const receipt = JSON.parse(readFileSync(fixture.destructionLog, 'utf8').trim());
    assert.equal(receipt.reason, 'retired-after-verified-cutover');
    assert.equal(receipt.retention, 'none');
    assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
    const journal = readFileSync(fixture.journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(journal.map(({ state }) => state), ['prepared', 'activated', 'verified', 'finalized']);
  });

  it('rejects spoofed key IDs and proves the prior keyring before reporting rollback', { timeout: 60_000 }, () => {
    const fixture = rotationFixture({ spoofActivatedJwks: true });
    const priorPrivate = readFileSync(join(fixture.initial, 'active-private.pem'), 'utf8');
    const result = spawnSync('bash', [iamKeyRotationPath], { env: fixture.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /prior release was cryptographically verified after rollback/);
    assert.equal(readFileSync(join(fixture.keyringRoot, 'current/active-private.pem'), 'utf8'), priorPrivate);
    assert.equal(readdirSync(join(fixture.keyringRoot, 'releases')).length, 1);
    assert.equal(readFileSync(fixture.systemctlLog, 'utf8').trim().split('\n').length, 2);
    const receipt = JSON.parse(readFileSync(fixture.destructionLog, 'utf8').trim());
    assert.equal(receipt.reason, 'failed-activation-rollback');
    assert.equal(JSON.parse(readFileSync(fixture.journal, 'utf8').trim().split('\n').at(-1)!).state, 'rolled_back');
  });

  it('retains both releases and records a critical recovery failure when rollback restart fails', { timeout: 60_000 }, () => {
    const fixture = rotationFixture({ spoofActivatedJwks: true, failRestartNumber: 2 });
    const result = spawnSync('bash', [iamKeyRotationPath], { env: fixture.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CRITICAL: IAM restart failed during rollback/);
    assert.doesNotMatch(result.stderr, /prior release was cryptographically verified after rollback/);
    assert.equal(readdirSync(join(fixture.keyringRoot, 'releases')).length, 2);
    assert.equal(existsSync(fixture.destructionLog), false);
    assert.equal(JSON.parse(readFileSync(fixture.journal, 'utf8').trim().split('\n').at(-1)!).state, 'recovery_failed');
  });

  it('does not finalize or claim a receipt when destruction receipt persistence fails', { timeout: 60_000 }, () => {
    const fixture = rotationFixture({ destructionLogIsDirectory: true });
    const priorRelease = fixture.initial;
    const result = spawnSync('bash', [iamKeyRotationPath], { env: fixture.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(priorRelease), false);
    assert.equal(readdirSync(join(fixture.keyringRoot, 'releases')).length, 1);
    assert.match(result.stderr, /finalization is incomplete/);
    assert.equal(JSON.parse(readFileSync(fixture.journal, 'utf8').trim().split('\n').at(-1)!).state, 'verified');
  });

  it('reconciles a durable recovery-failed journal before allowing the next rotation', { timeout: 60_000 }, () => {
    const fixture = rotationFixture({ spoofActivatedJwks: true, failRestartNumber: 2 });
    const failed = spawnSync('bash', [iamKeyRotationPath], { env: fixture.env, encoding: 'utf8' });
    assert.notEqual(failed.status, 0);

    const recovered = spawnSync('bash', [iamKeyRotationPath], {
      env: {
        ...fixture.env,
        HIVE_TEST_FAIL_RESTART_NUMBER: '0',
        HIVE_TEST_SPOOF_ACTIVATED_JWKS: 'false',
      },
      encoding: 'utf8',
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readdirSync(join(fixture.keyringRoot, 'releases')).length, 1);
    const states = readFileSync(fixture.journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line).state);
    assert.deepEqual(states.slice(0, 4), ['prepared', 'activated', 'recovery_failed', 'rolled_back']);
    assert.deepEqual(states.slice(-4), ['prepared', 'activated', 'verified', 'finalized']);
    const receipts = readFileSync(fixture.destructionLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(receipts.length, 2);
    assert.equal(receipts[1].previousReceiptSha256, receipts[0].receiptSha256);
  });
});
