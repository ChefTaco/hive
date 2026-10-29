#!/usr/bin/env node --experimental-strip-types
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseHiveHostTarget, resolveHiveHosts, type HiveHostTarget } from './lib/service-manifest.ts';

type HardeningStatus = 'pass' | 'warn' | 'fail';

interface HardeningCheck {
  status: HardeningStatus;
  name: string;
  message: string;
}

interface HardeningOptions {
  host: string;
  fqdn: string;
  json: boolean;
}

const REQUIRED_SYSTEMD: Record<string, string> = {
  User: 'hive-iam',
  Group: 'hive-iam',
  ProtectSystem: 'strict',
  PrivateTmp: 'yes',
  PrivateDevices: 'yes',
  NoNewPrivileges: 'yes',
};

function parseArgs(argv: string[]): HardeningOptions {
  let target: HiveHostTarget | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') {
      target = parseHiveHostTarget(argv[++index] ?? '');
    } else if (arg.startsWith('--host=')) {
      target = parseHiveHostTarget(arg.slice('--host='.length));
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node --experimental-strip-types scripts/verify-iam-hardening.ts [--host host:fqdn] [--json]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  target ??= resolveHiveHosts({ HIVE_HOSTS: process.env['HIVE_HOSTS'] ?? readRootEnv().get('HIVE_HOSTS') })[0];
  if (!target) throw new Error('No Hive host configured; pass --host or set HIVE_HOSTS');
  return { host: target.host, fqdn: target.fqdn, json };
}

function sshTarget(host: string): string {
  const env = readRootEnv();
  const user = process.env['HIVE_IAM_VERIFY_SSH_USER'] ?? process.env['DEPLOY_USERNAME'] ?? process.env['DEPLOY_USER'] ?? env.get('DEPLOY_USERNAME') ?? env.get('DEPLOY_USER') ?? 'deploy';
  return host.includes('@') ? host : `${user}@${host}`;
}

function readRootEnv(): Map<string, string> {
  const env = new Map<string, string>();
  if (!existsSync('.env')) return env;
  for (const rawLine of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    let value = line.slice(line.indexOf('=') + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env.set(key, value);
  }
  return env;
}

function sudoPassword(): string | undefined {
  const env = readRootEnv();
  return process.env['HIVE_IAM_VERIFY_SUDO_PASSWORD']
    ?? process.env['DEPLOY_SUDO_PASSWORD']
    ?? env.get('HIVE_IAM_VERIFY_SUDO_PASSWORD')
    ?? env.get('DEPLOY_SUDO_PASSWORD')
    ?? env.get('DEPLOY_PASSWORD');
}

function sshKey(): string | undefined {
  const env = readRootEnv();
  return process.env['HIVE_IAM_VERIFY_SSH_KEY'] ?? process.env['DEPLOY_SSH_KEY'] ?? env.get('HIVE_IAM_VERIFY_SSH_KEY') ?? env.get('DEPLOY_SSH_KEY');
}

function remoteScript(fqdn: string, sudoPassword?: string): string {
  const encodedSudoPassword = sudoPassword ? Buffer.from(sudoPassword, 'utf8').toString('base64') : '';
  return `
set -euo pipefail
IAM_VERIFY_SUDO_PASS=$(printf '%s' '${encodedSudoPassword}' | base64 -d)
do_sudo() {
  if sudo -n "$@" 2>/dev/null; then return 0; fi
  if [[ -n "$IAM_VERIFY_SUDO_PASS" ]]; then
    printf '%s\\n' "$IAM_VERIFY_SUDO_PASS" | sudo -S -p '' "$@" 2>/dev/null
    return $?
  fi
  return 1
}
json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'; }
emit() { printf '{"status":%s,"name":%s,"message":%s}\\n' "$(printf '%s' "$1" | json_escape)" "$(printf '%s' "$2" | json_escape)" "$(printf '%s' "$3" | json_escape)"; }
props=$(systemctl show hive-iam.service -p User -p Group -p ProtectSystem -p PrivateTmp -p PrivateDevices -p NoNewPrivileges -p ReadWritePaths 2>/dev/null || true)
if [[ -z "$props" ]]; then
  emit fail unit "hive-iam.service was not found"
  exit 0
fi
PROPS="$props" python3 - <<'PY'
import json, os
required = {
  "User": "hive-iam",
  "Group": "hive-iam",
  "ProtectSystem": "strict",
  "PrivateTmp": "yes",
  "PrivateDevices": "yes",
  "NoNewPrivileges": "yes",
}
props = {}
for line in os.environ.get("PROPS", "").splitlines():
  if "=" in line:
    k, v = line.split("=", 1)
    props[k] = v
for key, expected in required.items():
  actual = props.get(key, "")
  print(json.dumps({
    "status": "pass" if actual == expected else "fail",
    "name": f"systemd:{key}",
    "message": f"{key}={actual or 'missing'} expected {expected}",
  }))
rw = props.get("ReadWritePaths", "")
paths = rw.split()
required_paths = {"/opt/hive-iam/prisma", "/opt/hive-iam/audit-logs"}
print(json.dumps({
  "status": "pass" if required_paths.issubset(paths) and "/opt/hive-iam" not in paths else "fail",
  "name": "systemd:ReadWritePaths",
  "message": f"ReadWritePaths={rw or 'missing'}",
}))
PY
if do_sudo -u hive-iam test -w /opt/hive-iam; then emit fail denied-app-tree "hive-iam can replace the application tree"; else emit pass denied-app-tree "hive-iam cannot write /opt/hive-iam"; fi
for state_dir in /opt/hive-iam/prisma /opt/hive-iam/audit-logs; do
  if do_sudo -u hive-iam test -w "$state_dir"; then
    emit pass writable-state "hive-iam can write explicit state directory $state_dir"
  else
    emit fail writable-state "hive-iam cannot write required state directory $state_dir"
  fi
done
helper=/usr/local/libexec/hive-iam/rotate-jwt-signing-key.sh
validator=/usr/local/libexec/hive-iam/validate-jwt-keyring.mjs
if [[ ! -L "$helper" && -f "$helper" && "$(stat -c '%U:%G:%a' "$helper")" == "root:root:755" &&
      ! -L "$validator" && -f "$validator" && "$(stat -c '%U:%G:%a' "$validator")" == "root:root:644" ]]; then
  emit pass helper-files "rotation helper and validator have precise root-owned modes"
else
  emit fail helper-files "rotation helper or validator ownership/type/mode is unsafe"
fi
unsafe_ancestor=false
for ancestor in /usr /usr/local /usr/local/libexec /usr/local/libexec/hive-iam; do
  owner=$(stat -c %U "$ancestor" 2>/dev/null || true)
  mode=$(stat -c %a "$ancestor" 2>/dev/null || true)
  if [[ "$owner" != "root" || ! "$mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$mode & 0022) != 0 )); then
    unsafe_ancestor=true
  fi
done
if [[ "$unsafe_ancestor" == "false" ]]; then emit pass helper-ancestors "all helper ancestors are root-owned and not group/world writable"; else emit fail helper-ancestors "a helper ancestor is not root-controlled"; fi
current=$(do_sudo readlink -f /var/lib/hive-iam-keyring/current 2>/dev/null || true)
private_count=$(do_sudo find /var/lib/hive-iam-keyring/releases -type f -name active-private.pem 2>/dev/null | wc -l || true)
legacy_private_count=$(do_sudo find /var/lib/hive-iam-key-archive -type f -name '*.pem' 2>/dev/null | wc -l || true)
if [[ "$current" == /var/lib/hive-iam-keyring/releases/* && "$private_count" == "1" && "$legacy_private_count" == "0" ]]; then
  emit pass key-retention "one active private signing key exists; no retired or legacy private-key archive remains"
else
  emit fail key-retention "keyring current link is unsafe or retired/legacy private-key files remain"
fi
probe="/etc/hive-iam-hardening-probe-$$"
if do_sudo -u hive-iam sh -c "touch '$probe'" 2>/dev/null; then
  rm -f "$probe" 2>/dev/null || do_sudo rm -f "$probe" 2>/dev/null || true
  emit fail denied-etc "hive-iam could write to /etc"
else
  emit pass denied-etc "hive-iam cannot write to /etc"
fi
ca_file=$(mktemp)
do_sudo cat /opt/hive-iam/certs/ca-bundle.crt > "$ca_file"
chmod 600 "$ca_file"
if curl --fail --silent --show-error --cacert "$ca_file" --resolve '${fqdn}:4200:127.0.0.1' --max-time 10 "https://${fqdn}:4200/api/v1/health/ready" >/dev/null 2>&1; then
  emit pass health "IAM readiness endpoint is healthy"
else
  emit fail health "IAM readiness endpoint failed"
fi
rm -f "$ca_file"
`;
}

function parseRemoteChecks(stdout: string): HardeningCheck[] {
  const checks: HardeningCheck[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as HardeningCheck;
    checks.push(parsed);
  }
  return checks;
}

export function runIamHardeningVerification(argv: string[]): { checks: HardeningCheck[]; output: string; hasFailures: boolean } {
  const options = parseArgs(argv);
  const password = sudoPassword();
  const sshArgs = [sshTarget(options.host), 'bash', '-s'];
  const key = sshKey();
  if (key) sshArgs.unshift('-i', key);
  const result = spawnSync('ssh', sshArgs, { input: remoteScript(options.fqdn, password), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`IAM hardening verification failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const checks = parseRemoteChecks(result.stdout);
  const hasFailures = checks.some((check) => check.status === 'fail');
  const output = options.json ? JSON.stringify({ host: options.host, fqdn: options.fqdn, checks }, null, 2) : render(options, checks);
  return { checks, output, hasFailures };
}

function render(options: HardeningOptions, checks: HardeningCheck[]): string {
  const lines = ['# Hive IAM Hardening Verification', '', `Host: ${options.host} (${options.fqdn})`, ''];
  for (const check of checks) lines.push(`- [${check.status.toUpperCase()}] ${check.name}: ${check.message}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const result = runIamHardeningVerification(process.argv.slice(2));
  console.log(result.output);
  if (result.hasFailures) process.exitCode = 1;
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
