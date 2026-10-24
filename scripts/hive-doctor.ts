#!/usr/bin/env node --experimental-strip-types
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  HIVE_SERVICES,
  hiveServicesForHost,
  parseHiveHostTarget,
  renderHiveEndpoint,
  resolveHiveHosts,
  type HiveHostTarget,
} from '../packages/hive-contracts/src/service-manifest.ts';

type DoctorStatus = 'pass' | 'warn' | 'fail';

interface DoctorCheck {
  status: DoctorStatus;
  area: string;
  message: string;
  detail?: string;
}

interface DoctorOptions {
  rootDir: string;
  envFile?: string;
  target: HiveHostTarget;
  json: boolean;
}

interface ParsedEnv {
  keys: Set<string>;
  values: Map<string, string>;
}

const SECRET_KEY_PATTERN = /(SECRET|PASSWORD|TOKEN|KEY|PRIVATE|COOKIE)/i;

function parseEnvFile(path: string): ParsedEnv {
  const keys = new Set<string>();
  const values = new Map<string, string>();
  if (!existsSync(path)) return { keys, values };
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(line.indexOf('=') + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    keys.add(key);
    values.set(key, value);
  }
  return { keys, values };
}

function check(status: DoctorStatus, area: string, message: string, detail?: string): DoctorCheck {
  return { status, area, message, ...(detail ? { detail } : {}) };
}

function hasCommand(command: string): boolean {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
  return result.status === 0;
}

function parseNodeMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : 0;
}

function isExecutable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): DoctorOptions {
  let rootDir = process.cwd();
  let envFile: string | undefined;
  let target: HiveHostTarget | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      rootDir = resolve(argv[++index] ?? '');
    } else if (arg.startsWith('--root=')) {
      rootDir = resolve(arg.slice('--root='.length));
    } else if (arg === '--env-file') {
      envFile = resolve(rootDir, argv[++index] ?? '');
    } else if (arg.startsWith('--env-file=')) {
      envFile = resolve(rootDir, arg.slice('--env-file='.length));
    } else if (arg === '--target') {
      target = parseHiveHostTarget(argv[++index] ?? '');
    } else if (arg.startsWith('--target=')) {
      target = parseHiveHostTarget(arg.slice('--target='.length));
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node --experimental-strip-types scripts/hive-doctor.ts [--root DIR] [--env-file FILE] [--target host:fqdn] [--json]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!target) {
    const configured = process.env['HIVE_HOSTS'] ?? parseEnvFile(envFile ?? join(rootDir, '.env')).values.get('HIVE_HOSTS');
    target = resolveHiveHosts({ HIVE_HOSTS: configured })[0];
    if (!target) throw new Error('No Hive host configured; pass --target or set HIVE_HOSTS');
  }
  return { rootDir, ...(envFile ? { envFile } : {}), target, json };
}

function checkLocalFiles(rootDir: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const path of ['package.json', 'README.md', 'docs/HIVE_ARCHITECTURE.md']) {
    const fullPath = join(rootDir, path);
    checks.push(existsSync(fullPath)
      ? check('pass', 'files', `${path} exists`)
      : check('fail', 'files', `${path} is missing`));
  }
  for (const service of HIVE_SERVICES) {
    const scriptPath = join(rootDir, service.deployScript);
    checks.push(existsSync(scriptPath)
      ? check(isExecutable(scriptPath) ? 'pass' : 'warn', 'deploy', `${service.deployScript} exists`, isExecutable(scriptPath) ? undefined : 'Script is not executable; npm/bash invocation can still run it.')
      : check('fail', 'deploy', `${service.deployScript} is missing`));
    for (const example of service.localEnvExamples) {
      checks.push(existsSync(join(rootDir, example))
        ? check('pass', 'env', `${example} exists`)
        : check('warn', 'env', `${example} is missing`));
    }
  }
  return checks;
}

function checkTooling(): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const nodeMajor = parseNodeMajor(process.version);
  checks.push(nodeMajor >= 24
    ? check('pass', 'tools', `Node ${process.version} satisfies >=24`)
    : check('fail', 'tools', `Node ${process.version} is below required >=24`));
  for (const command of ['npm', 'bash', 'ssh', 'curl', 'openssl']) {
    checks.push(hasCommand(command)
      ? check('pass', 'tools', `${command} is available`)
      : check(command === 'ssh' ? 'warn' : 'fail', 'tools', `${command} is not available`));
  }
  return checks;
}

function checkEnvironment(options: DoctorOptions): DoctorCheck[] {
  const rootEnv = options.envFile ?? join(options.rootDir, '.env');
  const env = parseEnvFile(rootEnv);
  const checks: DoctorCheck[] = [];
  checks.push(existsSync(rootEnv)
    ? check('pass', 'env', `Loaded root env keys from ${rootEnv}`)
    : check('warn', 'env', `Root env file not found at ${rootEnv}`, 'Deploys may still work with exported environment variables.'));

  const deployUser = env.values.get('DEPLOY_USERNAME') ?? env.values.get('DEPLOY_USER');
  checks.push(deployUser
    ? check('pass', 'env', 'Deploy username is configured')
    : check('warn', 'env', 'Deploy username is not configured', 'Set DEPLOY_USERNAME for remote operations.'));

  const rawSshKey = env.values.get('DEPLOY_SSH_KEY');
  const sshKey = rawSshKey?.replace('$HOME', process.env['HOME'] ?? '');
  const password = env.values.get('DEPLOY_PASSWORD') ?? env.values.get('SSH_PASSWORD');
  const allowPassword = env.values.get('DEPLOY_ALLOW_PASSWORD') === 'true';
  if (sshKey) {
    checks.push(existsSync(sshKey)
      ? check('pass', 'env', 'Key-based deploy auth is configured')
      : check('warn', 'env', 'DEPLOY_SSH_KEY is set but the key file was not found'));
  } else if (password && allowPassword) {
    checks.push(check('warn', 'env', 'Password SSH is explicitly enabled', 'Key-based deploy auth is preferred for routine deploys.'));
  } else if (password) {
    checks.push(check('warn', 'env', 'Password value exists but DEPLOY_ALLOW_PASSWORD is not true', 'Deploy scripts will refuse password SSH unless explicitly allowed.'));
  } else {
    checks.push(check('warn', 'env', 'No deploy auth found', 'Set DEPLOY_SSH_KEY or bootstrap password auth intentionally.'));
  }

  const memoryEnv = env.values.get('HIVEMEM_ENV_FILE') ?? 'services/hive-mem/.env';
  const memoryEnvPath = resolve(options.rootDir, memoryEnv);
  checks.push(existsSync(memoryEnvPath)
    ? check('pass', 'env', `HiveMem deploy env exists at ${memoryEnv}`)
    : check('fail', 'env', `HiveMem deploy env is missing at ${memoryEnv}`, 'Set HIVEMEM_ENV_FILE for full deploys.'));
  if (existsSync(memoryEnvPath)) {
    const memoryConfig = parseEnvFile(memoryEnvPath);
    const jwtSecret = memoryConfig.values.get('HIVEMEM_JWT_SECRET') ?? '';
    const secure = Buffer.byteLength(jwtSecret) >= 32 && !/change[_-]?me|placeholder|example|development/i.test(jwtSecret);
    checks.push(secure
      ? check('pass', 'env', 'HiveMem JWT signing secret passes minimum strength checks')
      : check('fail', 'env', 'HiveMem JWT signing secret is missing, short, or a placeholder', 'Set at least 32 random bytes in the private HiveMem env before deployment.'));
  }

  for (const key of ['HIVE_DEPLOY_HOST', 'HIVE_PUBLIC_FQDN', 'HIVE_ROUTER_AUTH_MODE']) {
    checks.push(env.keys.has(key)
      ? check('pass', 'env', `${key} is present`)
      : check('warn', 'env', `${key} is not set`, `Default will be used for ${options.target.host}.`));
  }

  const staticFallback = env.values.get('HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED');
  checks.push(staticFallback === 'true'
    ? check('fail', 'security', 'Static security exporter credential fallback is enabled', 'Disable it and issue per-client exporter credentials instead.')
    : check('pass', 'security', staticFallback === undefined
      ? 'Static security exporter credential fallback defaults disabled'
      : 'Static security exporter credential fallback is disabled'));

  for (const key of ['HIVE_STATUS_ALLOW_INSECURE_TLS', 'HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS']) {
    const enabled = env.values.get(key) === 'true';
    checks.push(enabled
      ? check('fail', 'security', `${key} is enabled`, 'Production service-to-service TLS must verify certificates and hostnames.')
      : check('pass', 'security', `${key} is disabled`));
  }

  const secretLikeKeys = [...env.keys].filter((key) => SECRET_KEY_PATTERN.test(key));
  if (secretLikeKeys.length > 0) {
    checks.push(check('pass', 'env', `Root env contains ${secretLikeKeys.length} secret-like keys`, 'Values were not printed.'));
  }
  return checks;
}

function checkEndpoints(target: HiveHostTarget): DoctorCheck[] {
  return hiveServicesForHost(target).flatMap((service) => service.healthEndpoints.map((endpoint) => check(
    endpoint.requiresAuth ? 'warn' : 'pass',
    'endpoints',
    `${service.displayName} ${endpoint.name}: ${renderHiveEndpoint(endpoint.urlTemplate, target)}`,
    endpoint.requiresAuth ? 'Authenticated endpoint; doctor lists it but does not call it.' : undefined,
  )));
}

export function runDoctor(argv: string[]): { checks: DoctorCheck[]; output: string; hasFailures: boolean } {
  const options = parseArgs(argv);
  const checks = [
    ...checkLocalFiles(options.rootDir),
    ...checkTooling(),
    ...checkEnvironment(options),
    ...checkEndpoints(options.target),
  ];
  const hasFailures = checks.some((entry) => entry.status === 'fail');
  const output = options.json ? JSON.stringify({ target: options.target, checks }, null, 2) : renderDoctor(options, checks);
  return { checks, output, hasFailures };
}

function renderDoctor(options: DoctorOptions, checks: DoctorCheck[]): string {
  const lines = [
    '# Hive Doctor',
    '',
    `Root: ${options.rootDir}`,
    `Target: ${options.target.host} (${options.target.fqdn})`,
    '',
  ];
  for (const entry of checks) {
    lines.push(`- [${entry.status.toUpperCase()}] ${entry.area}: ${entry.message}${entry.detail ? ` ${entry.detail}` : ''}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const result = runDoctor(process.argv.slice(2));
  console.log(result.output);
  if (result.hasFailures) process.exitCode = 1;
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
