#!/usr/bin/env node --experimental-strip-types
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  HIVE_REQUIRED_PORTS,
  HIVE_SERVICES,
  HIVE_OPTIONAL_SERVICES,
  hiveHostCapabilities,
  hiveServicesForHost,
  getHiveServiceBySystemdName,
  parseHiveHostTarget,
  resolveHiveHosts,
  type HiveHostTarget,
  type HiveServiceKey,
  type HiveSystemdServiceName,
} from './lib/service-manifest.ts';

type Severity = 'info' | 'warn' | 'fail';
type ServiceName = HiveSystemdServiceName;

interface ServiceSnapshot {
  name: ServiceName;
  active: boolean;
  enabled?: boolean;
  envKeys: string[];
  systemd: Record<string, string>;
}

interface CertificateSnapshot {
  subject?: string;
  issuer?: string;
  notAfter?: string;
  sans: string[];
}

interface PortSnapshot {
  port: number;
  listener?: string;
}

interface HostSnapshot {
  host: string;
  fqdn: string;
  collectedAt?: string;
  services: ServiceSnapshot[];
  ports: PortSnapshot[];
  certificate?: CertificateSnapshot;
  hiveStatus?: Record<string, unknown>;
}

interface DriftFinding {
  severity: Severity;
  area: string;
  host: string;
  message: string;
  expected?: string;
  actual?: string;
  remediation?: string;
}

const REQUIRED_PORTS = [...HIVE_REQUIRED_PORTS];
const REQUIRED_ENV_KEYS = Object.fromEntries([...HIVE_SERVICES, ...HIVE_OPTIONAL_SERVICES].map((service) => [service.systemdService, [...service.requiredEnvKeys]])) as Record<ServiceName, string[]>;
const REQUIRED_SYSTEMD = Object.fromEntries([...HIVE_SERVICES, ...HIVE_OPTIONAL_SERVICES].map((service) => [service.systemdService, { ...service.requiredSystemd }])) as Record<ServiceName, Record<string, string>>;
const SERVICE_NAMES = HIVE_SERVICES.map((service) => service.systemdService);

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

function remediateService(host: string, serviceName: ServiceName): string {
  const service = getHiveServiceBySystemdName(serviceName);
  const envPrefix = serviceName === 'hive-router'
    ? 'HIVE_ROUTER_DEPLOY_HOST'
    : serviceName === 'hive-iam'
      ? 'HIVE_IAM_DEPLOY_HOST'
      : 'HIVEMEM_DEPLOY_HOST';
  return `Re-run ${envPrefix}=${host} ${service.deployScript} for ${service.displayName}, then audit again.`;
}

function serviceByName(snapshot: HostSnapshot, name: ServiceName): ServiceSnapshot | undefined {
  return snapshot.services.find((service) => service.name === name);
}

function sorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

// Env keys that are legitimately host- or deploy-specific and therefore should
// not be treated as cross-host drift: SSH/deploy orchestration endpoints,
// developer-only helpers, per-host FQDNs, and optional secondary ports. Real portable service config (e.g. HIVEMEM_RUNTIME) is not
// matched here and is still compared across hosts.
const NON_PORTABLE_ENV_PATTERNS: RegExp[] = [
  /^SSH_/,
  /^DEV_/,
  /^DEPLOY_/,
  /^HERMES_/,
  /_FQDN$/,
  /_PORT2$/,
];

function portableEnvKeys(keys: string[]): string[] {
  return keys.filter((key) => !NON_PORTABLE_ENV_PATTERNS.some((pattern) => pattern.test(key)));
}

function missingValues(actual: string[], required: string[]): string[] {
  const set = new Set(actual);
  return required.filter((value) => !set.has(value));
}

function appStatuses(snapshot: HostSnapshot): Record<string, string> {
  const apps = snapshot.hiveStatus?.['apps'];
  if (!Array.isArray(apps)) return {};
  const statuses: Record<string, string> = {};
  for (const app of apps) {
    if (!app || typeof app !== 'object') continue;
    const record = app as Record<string, unknown>;
    if (typeof record['key'] === 'string' && typeof record['status'] === 'string') {
      statuses[record['key']] = record['status'];
    }
  }
  return statuses;
}

function compareHost(snapshot: HostSnapshot, capabilities: Record<string, readonly HiveServiceKey[]>): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const expectedServices = hiveServicesForHost(snapshot.host, capabilities);
  for (const port of expectedServices.flatMap((service) => service.requiredPorts)) {
    if (!snapshot.ports.some((entry) => entry.port === port)) {
      findings.push({ severity: 'fail', area: 'ports', host: snapshot.host, message: `Port ${port} is not listening.`, expected: String(port), actual: 'missing', remediation: `Check the owning Hive service on ${snapshot.host}, then redeploy or restart the service that should bind port ${port}.` });
    }
  }

  for (const serviceName of expectedServices.map((service) => service.systemdService)) {
    const service = serviceByName(snapshot, serviceName);
    if (!service) {
      findings.push({ severity: 'fail', area: 'services', host: snapshot.host, message: `${serviceName} is missing from inventory.`, remediation: remediateService(snapshot.host, serviceName) });
      continue;
    }
    if (!service.active) {
      findings.push({ severity: 'fail', area: 'services', host: snapshot.host, message: `${serviceName} is not active.`, expected: 'active', actual: 'inactive', remediation: `Run systemctl status ${serviceName}.service on ${snapshot.host}; if the unit or release is stale, ${remediateService(snapshot.host, serviceName)}` });
    }
    const missingEnv = missingValues(service.envKeys, REQUIRED_ENV_KEYS[serviceName]);
    if (missingEnv.length > 0) {
      findings.push({ severity: 'fail', area: 'env', host: snapshot.host, message: `${serviceName} is missing required env keys: ${missingEnv.join(', ')}`, remediation: `Restore or regenerate the missing keys in ${getHiveServiceBySystemdName(serviceName).envPath}, then restart ${serviceName}.service.` });
    }
    const requiredSystemd = REQUIRED_SYSTEMD[serviceName];
    if (requiredSystemd) {
      for (const [key, expected] of Object.entries(requiredSystemd)) {
        const actual = service.systemd[key];
        if (actual !== expected) {
          findings.push({ severity: 'warn', area: 'systemd', host: snapshot.host, message: `${serviceName} systemd ${key} drifted.`, expected, actual: actual ?? 'missing', remediation: remediateService(snapshot.host, serviceName) });
        }
      }
    }
  }

  const cert = snapshot.certificate;
  if (!cert) {
    findings.push({ severity: 'fail', area: 'cert', host: snapshot.host, message: 'TLS certificate snapshot is missing.', remediation: `Re-run the router deploy for ${snapshot.host} so its TLS certificate material is refreshed, then audit again.` });
  } else {
    const matchesHost = cert.sans.includes(snapshot.fqdn) || cert.subject?.includes(snapshot.fqdn) === true;
    if (!matchesHost) {
      const actualCertificateNames = cert.sans.join(', ') || cert.subject || 'unknown';
      findings.push({ severity: 'fail', area: 'cert', host: snapshot.host, message: `Certificate does not cover ${snapshot.fqdn}.`, expected: snapshot.fqdn, actual: actualCertificateNames, remediation: `Deploy router with HIVE_ROUTER_CERT_DOMAIN=${snapshot.fqdn} and verify TLS_CERT_PATH points at the refreshed certificate.` });
    }
    if (cert.notAfter) {
      const days = Math.ceil((new Date(cert.notAfter).getTime() - Date.now()) / 86_400_000);
      if (days <= 0) findings.push({ severity: 'fail', area: 'cert', host: snapshot.host, message: 'Certificate is expired.', actual: cert.notAfter, remediation: `Refresh the TLS certificate on ${snapshot.host} through the router deploy, then restart hive-router.service.` });
      else if (days <= 30) findings.push({ severity: 'warn', area: 'cert', host: snapshot.host, message: `Certificate expires in ${days} days.`, actual: cert.notAfter, remediation: `Schedule a router deploy or certificate refresh for ${snapshot.host} before expiry.` });
    }
  }

  // /api/hive/status is an authenticated admin endpoint. When the audit cannot
  // authenticate (the common case), the probe returns no `apps` array. Treat
  // that as an audit-access limitation (info) rather than reporting every app
  // as drifted. Only compare per-app statuses when the status payload is
  // actually readable.
  if (!Array.isArray(snapshot.hiveStatus?.['apps'])) {
    findings.push({ severity: 'info', area: 'hive-status', host: snapshot.host, message: 'Authenticated /api/hive/status was not available to the audit; skipping per-app status comparison.', remediation: 'Provide audit credentials or rely on service-local health checks for this pass.' });
  } else {
    const statuses = appStatuses(snapshot);
    for (const app of ['iam', 'memory', 'router']) {
      if (!statuses[app]) findings.push({ severity: 'warn', area: 'hive-status', host: snapshot.host, message: `/api/hive/status did not report ${app}.`, remediation: `Inspect Router /api/hive/status assembly for the missing ${app} app and verify its internal URL env key.` });
      else if (statuses[app] !== 'online') findings.push({ severity: 'warn', area: 'hive-status', host: snapshot.host, message: `${app} status is ${statuses[app]}.`, expected: 'online', actual: statuses[app], remediation: `Open the ${app} status details in the Hive UI and inspect the failing dependency checks before redeploying.` });
    }
  }

  return findings;
}

export function compareDeployments(snapshots: HostSnapshot[], targets: readonly HiveHostTarget[] = resolveHiveHosts(process.env)): DriftFinding[] {
  const capabilities = hiveHostCapabilities(targets);
  const findings = snapshots.flatMap((snapshot) => compareHost(snapshot, capabilities));
  if (snapshots.length < 2) return findings;

  const [baseline, ...others] = snapshots;
  for (const other of others) {
    for (const serviceName of SERVICE_NAMES) {
      const baseService = serviceByName(baseline, serviceName);
      const otherService = serviceByName(other, serviceName);
      if (!baseService || !otherService) continue;
      const baseEnv = sorted(portableEnvKeys(baseService.envKeys)).join(',');
      const otherEnv = sorted(portableEnvKeys(otherService.envKeys)).join(',');
      if (baseEnv !== otherEnv) {
        findings.push({ severity: 'warn', area: 'drift/env', host: other.host, message: `${serviceName} env key inventory differs from ${baseline.host}.`, expected: baseEnv, actual: otherEnv, remediation: `Compare ${getHiveServiceBySystemdName(serviceName).envPath} on ${baseline.host} and ${other.host}; add intentional host-specific keys to the ignore list or reconcile portable config.` });
      }
      for (const key of ['User', 'Group', 'ProtectSystem', 'PrivateTmp', 'PrivateDevices', 'NoNewPrivileges', 'RestrictSUIDSGID', 'ReadWritePaths']) {
        const expected = baseService.systemd[key] ?? '';
        const actual = otherService.systemd[key] ?? '';
        if (expected !== actual) {
          findings.push({ severity: 'warn', area: 'drift/systemd', host: other.host, message: `${serviceName} systemd ${key} differs from ${baseline.host}.`, expected, actual, remediation: remediateService(other.host, serviceName) });
        }
      }
    }
  }

  return findings;
}

function remoteScript(fqdn: string, readSudoPassword: boolean): string {
  return `
set -euo pipefail
AUDIT_SUDO_PASS=''
if [[ '${readSudoPassword ? 'true' : 'false'}' == 'true' ]]; then
  IFS= read -r AUDIT_SUDO_PASS || true
fi
do_sudo() {
  if sudo -n "$@" 2>/dev/null; then return 0; fi
  if [[ -n "$AUDIT_SUDO_PASS" ]]; then
    printf '%s\\n' "$AUDIT_SUDO_PASS" | sudo -S -p '' "$@" 2>/dev/null
    return $?
  fi
  return 1
}
json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'; }
env_keys() { local file="$1"; if [[ -r "$file" ]]; then sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.\\+$/\\1/p' "$file"; elif do_sudo test -f "$file"; then do_sudo sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.\\+$/\\1/p' "$file"; else true; fi | sort -u | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))'; }
systemd_json() { local svc="$1"; systemctl show "$svc" -p User -p Group -p UMask -p ProtectSystem -p PrivateTmp -p PrivateDevices -p NoNewPrivileges -p RestrictSUIDSGID -p ReadWritePaths 2>/dev/null | python3 -c 'import json,sys; d={}; [d.setdefault(k,v) for line in sys.stdin if "=" in line for k,v in [line.strip().split("=",1)]]; print(json.dumps(d))'; }
service_json() { local name="$1" envfile="$2"; local active=false enabled=false; systemctl is-active --quiet "$name" && active=true || true; systemctl is-enabled --quiet "$name" && enabled=true || true; printf '{"name":"%s","active":%s,"enabled":%s,"envKeys":%s,"systemd":%s}' "$name" "$active" "$enabled" "$(env_keys "$envfile")" "$(systemd_json "$name")"; }
ports_json() { ss -ltnH 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\\1/' | sort -n -u | python3 -c 'import json,sys; print(json.dumps([{"port": int(l.strip())} for l in sys.stdin if l.strip().isdigit()]))'; }
cert_json() {
  local cert="/opt/hive-router/shared/certs/server.crt"
  [[ -f "$cert" ]] || cert="/opt/hive-router/certs/server.crt"
  if [[ ! -f "$cert" ]]; then printf 'null'; return; fi
  local temp=""
  if [[ ! -r "$cert" ]]; then
    temp=$(mktemp)
    do_sudo cat "$cert" > "$temp" || { rm -f "$temp"; printf 'null'; return; }
    cert="$temp"
  fi
  local subject issuer not_after san_text
  subject=$(openssl x509 -in "$cert" -noout -subject 2>/dev/null | sed 's/^subject=//') || { [[ -n "$temp" ]] && rm -f "$temp"; printf 'null'; return; }
  issuer=$(openssl x509 -in "$cert" -noout -issuer 2>/dev/null | sed 's/^issuer=//') || { [[ -n "$temp" ]] && rm -f "$temp"; printf 'null'; return; }
  not_after=$(openssl x509 -in "$cert" -noout -enddate 2>/dev/null | sed 's/^notAfter=//') || { [[ -n "$temp" ]] && rm -f "$temp"; printf 'null'; return; }
  san_text=$(openssl x509 -in "$cert" -noout -ext subjectAltName 2>/dev/null || true)
  SUBJECT="$subject" ISSUER="$issuer" NOT_AFTER="$not_after" SAN_TEXT="$san_text" python3 -c 'import json, os; sans=[]; [sans.append(p.strip()[4:]) for p in os.environ.get("SAN_TEXT", "").replace("X509v3 Subject Alternative Name:", "").replace("\\n", ",").split(",") if p.strip().startswith("DNS:")]; print(json.dumps({"subject": os.environ.get("SUBJECT", ""), "issuer": os.environ.get("ISSUER", ""), "notAfter": os.environ.get("NOT_AFTER", ""), "sans": sans}))'
  [[ -n "$temp" ]] && rm -f "$temp"
}
hive_status() { curl --fail --silent --show-error --max-time 5 --resolve '${fqdn}:443:127.0.0.1' 'https://${fqdn}/api/hive/status' 2>/dev/null || printf 'null'; }
printf '{"host":%s,"fqdn":%s,"collectedAt":%s,"services":[%s,%s,%s,%s],"ports":%s,"certificate":%s,"hiveStatus":%s}\n' \
  "$(hostname | json_escape)" "$(printf '%s' '${fqdn}' | json_escape)" "$(date -u +%Y-%m-%dT%H:%M:%SZ | json_escape)" \
  "$(service_json hive-router /opt/hive-router/shared/.env)" "$(service_json hive-iam /opt/hive-iam/.env)" "$(service_json hivemem /opt/hivemem/.env)" "$(service_json hive-skills /opt/hive-skills/shared/.env)" \
  "$(ports_json)" "$(cert_json)" "$(hive_status)"
`;
}

function collectSnapshot(host: string, fqdn: string): HostSnapshot {
  const env = readRootEnv();
  const sshUser = process.env['HIVE_AUDIT_SSH_USER'] ?? process.env['DEPLOY_USERNAME'] ?? process.env['DEPLOY_USER'] ?? env.get('HIVE_AUDIT_SSH_USER') ?? env.get('DEPLOY_USERNAME') ?? env.get('DEPLOY_USER');
  const sshKey = process.env['HIVE_AUDIT_SSH_KEY'] ?? process.env['DEPLOY_SSH_KEY'] ?? env.get('HIVE_AUDIT_SSH_KEY') ?? env.get('DEPLOY_SSH_KEY');
  const sudoPassword = process.env['HIVE_AUDIT_SUDO_PASSWORD'] ?? process.env['DEPLOY_SUDO_PASSWORD'] ?? env.get('HIVE_AUDIT_SUDO_PASSWORD') ?? env.get('DEPLOY_SUDO_PASSWORD') ?? env.get('DEPLOY_PASSWORD');
  const target = sshUser && !host.includes('@') ? `${sshUser}@${host}` : host;
  const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (sshKey) sshArgs.push('-i', sshKey);
  sshArgs.push(target, 'bash', '-lc', remoteScript(fqdn, Boolean(sudoPassword)));
  const result = spawnSync('ssh', sshArgs, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, input: sudoPassword ? `${sudoPassword}\n` : undefined });
  if (result.status !== 0) {
    throw new Error(`SSH inventory failed for ${target}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return JSON.parse(result.stdout) as HostSnapshot;
}

function parseArgs(argv: string[]): { snapshotFile?: string; hosts: HiveHostTarget[]; json: boolean } {
  const hosts: HiveHostTarget[] = [];
  let snapshotFile: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--snapshots') snapshotFile = argv[++index];
    else if (arg === '--json') json = true;
    else if (arg === '--host') hosts.push(parseHiveHostTarget(argv[++index] ?? ''));
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node --experimental-strip-types scripts/audit-deployments.ts [--snapshots file.json] [--json] [--host host:fqdn[:services]]\nHosts default to HIVE_HOSTS (comma-separated host:fqdn[:services] entries).');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const env = readRootEnv();
  const configured = hosts.length > 0 ? hosts : resolveHiveHosts({ HIVE_HOSTS: process.env['HIVE_HOSTS'] ?? env.get('HIVE_HOSTS') });
  return { ...(snapshotFile ? { snapshotFile } : {}), hosts: configured, json };
}

function renderMarkdown(snapshots: HostSnapshot[], findings: DriftFinding[]): string {
  const lines = ['# Hive Deployment Audit', '', `Hosts: ${snapshots.map((snapshot) => `${snapshot.host} (${snapshot.fqdn})`).join(', ')}`, ''];
  if (findings.length === 0) {
    lines.push('No deployment drift detected.');
    return lines.join('\n');
  }
  for (const finding of findings) {
    lines.push(`- [${finding.severity.toUpperCase()}] ${finding.host} ${finding.area}: ${finding.message}${finding.expected ? ` Expected: ${finding.expected}.` : ''}${finding.actual ? ` Actual: ${finding.actual}.` : ''}`);
    if (finding.remediation) lines.push(`  Suggested action: ${finding.remediation}`);
  }
  return lines.join('\n');
}

export function loadSnapshots(path: string): HostSnapshot[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Snapshot file must contain an array of host snapshots.');
  return parsed as HostSnapshot[];
}

export function runAudit(argv: string[]): { output: string; hasFailures: boolean } {
  const args = parseArgs(argv);
  const snapshots = args.snapshotFile
    ? loadSnapshots(args.snapshotFile)
    : args.hosts.map((host) => collectSnapshot(host.host, host.fqdn));
  const findings = compareDeployments(snapshots, args.hosts);
  return {
    output: args.json ? JSON.stringify({ snapshots, findings }, null, 2) : renderMarkdown(snapshots, findings),
    hasFailures: findings.some((finding) => finding.severity === 'fail'),
  };
}

async function main(): Promise<void> {
  const result = runAudit(process.argv.slice(2));
  console.log(result.output);
  if (result.hasFailures) process.exitCode = 1;
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
