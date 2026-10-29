#!/usr/bin/env node --experimental-strip-types
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HIVE_SERVICES, hiveServicesForHost, parseHiveHostTarget, resolveHiveHosts, type HiveHostTarget } from './lib/service-manifest.ts';

type BackupMode = 'backup' | 'restore';

interface BackupOptions {
  mode: BackupMode;
  host: HiveHostTarget;
  stamp: string;
  outputDir: string;
  backupFile?: string;
  apply: boolean;
  json: boolean;
}

interface BackupPlan {
  mode: BackupMode;
  host: HiveHostTarget;
  stamp: string;
  outputFile?: string;
  backupFile?: string;
  services: Array<{ service: string; paths: string[] }>;
  commands: string[];
  warnings: string[];
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function parseHost(value: string): HiveHostTarget {
  try {
    return parseHiveHostTarget(value);
  } catch {
    throw new Error('--host requires a safe host[:fqdn]');
  }
}

function defaultHost(): HiveHostTarget {
  const configured = process.env['HIVE_HOSTS'] ?? readRootEnv().get('HIVE_HOSTS');
  const [primary] = resolveHiveHosts({ HIVE_HOSTS: configured });
  if (!primary) throw new Error('No Hive host configured; pass --host or set HIVE_HOSTS');
  return primary;
}

function parseArgs(argv: string[], mode: BackupMode): BackupOptions {
  let host: HiveHostTarget | undefined;
  let stamp = timestamp();
  let outputDir = 'backups';
  let backupFile: string | undefined;
  let apply = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') host = parseHost(argv[++index] ?? '');
    else if (arg.startsWith('--host=')) host = parseHost(arg.slice('--host='.length));
    else if (arg === '--stamp') stamp = argv[++index] ?? '';
    else if (arg.startsWith('--stamp=')) stamp = arg.slice('--stamp='.length);
    else if (arg === '--output-dir') outputDir = argv[++index] ?? '';
    else if (arg.startsWith('--output-dir=')) outputDir = arg.slice('--output-dir='.length);
    else if (arg === '--backup-file') backupFile = argv[++index];
    else if (arg.startsWith('--backup-file=')) backupFile = arg.slice('--backup-file='.length);
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      const script = mode === 'backup' ? 'scripts/backup-hive.sh' : 'scripts/restore-hive.sh';
      console.log(`Usage: ${script} [--host host:fqdn] [--stamp id] [--output-dir dir] [--backup-file file] [--apply] [--json]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  host ??= defaultHost();
  if (!/^[a-zA-Z0-9_-]+$/.test(stamp)) throw new Error('--stamp must be a safe archive identifier');
  if (mode === 'restore' && !backupFile) backupFile = resolve(outputDir, `hive-${host.host}-${stamp}.tar.gz`);
  return { mode, host, stamp, outputDir, ...(backupFile ? { backupFile } : {}), apply, json };
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

function sshTarget(host: string): string {
  const env = readRootEnv();
  const user = process.env['HIVE_BACKUP_SSH_USER'] ?? process.env['DEPLOY_USERNAME'] ?? process.env['DEPLOY_USER'] ?? env.get('DEPLOY_USERNAME') ?? env.get('DEPLOY_USER') ?? 'deploy';
  return host.includes('@') ? host : `${user}@${host}`;
}

function sshOptions(): string[] {
  const env = readRootEnv();
  const key = process.env['HIVE_BACKUP_SSH_KEY'] ?? process.env['DEPLOY_SSH_KEY'] ?? env.get('HIVE_BACKUP_SSH_KEY') ?? env.get('DEPLOY_SSH_KEY');
  return key ? ['-i', key] : [];
}

function sudoPassword(): string | undefined {
  const env = readRootEnv();
  return process.env['HIVE_BACKUP_SUDO_PASSWORD']
    ?? process.env['DEPLOY_SUDO_PASSWORD']
    ?? env.get('HIVE_BACKUP_SUDO_PASSWORD')
    ?? env.get('DEPLOY_SUDO_PASSWORD')
    ?? env.get('DEPLOY_PASSWORD');
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runRemoteScript(target: string, options: string[], script: string) {
  return spawnSync('ssh', [...options, target, 'bash', '-s'], {
    input: script,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function shellAssignment(name: string, value?: string): string {
  return `${name}=${value ? quoteShell(value) : "''"}`;
}

function buildPlan(options: BackupOptions): BackupPlan {
  const outputFile = resolve(options.outputDir, `hive-${options.host.host}-${options.stamp}.tar.gz`);
  const services = hiveServicesForHost(options.host).map((service) => ({ service: service.systemdService,
    // The full-state engine retains Router configuration and installed schema
    // evidence; Router release bytes remain owned by the atomic release path.
    paths: service.systemdService === 'hive-router'
      ? ['/opt/hive-router/shared', '/opt/hive-router/current/prisma/schema.prisma',
         '/opt/hive-router/current/src/storage/generated-sqlite-schema.ts',
         '/etc/systemd/system/hive-router.service']
      : [...service.backupPaths] }));
  const allPaths = services.flatMap((service) => service.paths);
  const quotedPaths = allPaths.map(quoteShell).join(' ');
  const target = sshTarget(options.host.host);
  const commands = options.mode === 'backup'
    ? [`ssh ${target} sudo python3 hive-state-backup.py backup --host ${options.host.host} --archive <protected-remote-archive> > ${quoteShell(outputFile)}`]
    : [
      `python3 scripts/hive-state-backup.py restore-isolated --host ${options.host.host} --archive ${quoteShell(options.backupFile ?? outputFile)} --root ${quoteShell(resolve(options.outputDir, 'recovery-' + options.host.host + '-' + options.stamp))}`,
    ];
  return {
    mode: options.mode,
    host: options.host,
    stamp: options.stamp,
    ...(options.mode === 'backup' ? { outputFile } : {}),
    ...(options.mode === 'restore' ? { backupFile: options.backupFile ?? outputFile, outputFile: resolve(options.outputDir, 'recovery-' + options.host.host + '-' + options.stamp) } : {}),
    services,
    commands,
    warnings: [
      'Backup archives contain secrets and service state. Store them outside git and restrict permissions.',
      'Restore is intentionally opt-in with --apply and should be run during a maintenance window.',
    ],
  };
}

function renderPlan(plan: BackupPlan, apply: boolean): string {
  const lines = [
    `# Hive ${plan.mode === 'backup' ? 'Backup' : 'Restore'} Plan`,
    '',
    `Host: ${plan.host.host} (${plan.host.fqdn})`,
    `Stamp: ${plan.stamp}`,
    `Mode: ${apply ? 'apply' : 'dry-run'}`,
    ...(plan.outputFile ? [`Output: ${plan.outputFile}`] : []),
    ...(plan.backupFile ? [`Backup file: ${plan.backupFile}`] : []),
    '',
    '## Services And Paths',
  ];
  for (const service of plan.services) lines.push(`- ${service.service}: ${service.paths.join(', ')}`);
  lines.push('', '## Commands');
  for (const command of plan.commands) lines.push(`- ${command}`);
  lines.push('', '## Warnings');
  for (const warning of plan.warnings) lines.push(`- ${warning}`);
  return lines.join('\n');
}

function runApply(plan: BackupPlan): void {
  const target = sshTarget(plan.host.host);
  const options = sshOptions();
  const password = sudoPassword();
  if (plan.mode === 'backup') {
    if (!plan.outputFile) throw new Error('Backup output file is missing.');
    mkdirSync(dirname(plan.outputFile), { recursive: true, mode: 0o700 });
    const remoteDirectory = `/tmp/hive-backup-${plan.host.host}-${plan.stamp}`;
    const prepare = runRemoteScript(target, options, `umask 077; mkdir ${quoteShell(remoteDirectory)}`);
    if (prepare.status !== 0) throw new Error('Unable to create protected remote staging directory');
    try {
      const upload = spawnSync('scp', [...options, 'scripts/hive-state-backup.py', `${target}:${remoteDirectory}/engine.py`], { encoding: 'utf8' });
      if (upload.status !== 0) throw new Error('Unable to stage backup engine');
      const backupCommand = `python3 ${quoteShell(remoteDirectory + '/engine.py')} backup --host ${quoteShell(plan.host.host)} --archive ${quoteShell(remoteDirectory + '/state.tar.gz')}`;
      const command = `bash -c ${quoteShell(backupCommand + '; result=$?; chown ' + sshTarget(plan.host.host).split('@')[0] + ' ' + quoteShell(remoteDirectory + '/state.tar.gz') + '; exit $result')}`;
      const remote = runRemoteScript(target, options, `${shellAssignment('BACKUP_SUDO_SECRET', password)}
set -euo pipefail
if [[ -n "$BACKUP_SUDO_SECRET" ]]; then printf '%s\\n' "$BACKUP_SUDO_SECRET" | sudo -S -p '' ${command}; else sudo -n ${command}; fi
`);
      if (remote.status !== 0) throw new Error(`Quiesced backup failed: ${remote.stderr.trim()}`);
      const fd = openSync(plan.outputFile, 'wx', 0o600);
      try {
        const download = spawnSync('ssh', [...options, target, 'cat', remoteDirectory + '/state.tar.gz'], { stdio: ['ignore', fd, 'pipe'] });
        if (download.status !== 0) throw new Error('Backup download failed');
      } finally { closeSync(fd); }
      const verify = spawnSync('python3', ['scripts/hive-state-backup.py', 'verify', '--host', plan.host.host, '--archive', plan.outputFile], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      if (verify.status !== 0) { unlinkSync(plan.outputFile); throw new Error('Downloaded backup validation failed'); }
    } finally {
      runRemoteScript(target, options, `${shellAssignment('BACKUP_SUDO_SECRET', password)}
if [[ -n "$BACKUP_SUDO_SECRET" ]]; then printf '%s\\n' "$BACKUP_SUDO_SECRET" | sudo -S -p '' rm -rf ${quoteShell(remoteDirectory)}; else sudo -n rm -rf ${quoteShell(remoteDirectory)}; fi
`);
    }
    return;
  }

  if (!plan.backupFile) throw new Error('Restore backup file is missing.');
  if (!existsSync(plan.backupFile)) throw new Error(`Restore backup file not found: ${plan.backupFile}`);
  const validation = spawnSync('python3', ['scripts/hive-state-backup.py', 'verify', '--host', plan.host.host, '--archive', plan.backupFile], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (validation.status !== 0) throw new Error('Restore refused: archive validation or installation identity mismatch');
  const restored = spawnSync('python3', ['scripts/hive-state-backup.py', 'restore-isolated', '--host', plan.host.host, '--archive', plan.backupFile, '--root', plan.outputFile!], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (restored.status !== 0) throw new Error('Isolated restore failed: ' + restored.stderr.trim());
  console.log(restored.stdout.trim());

}

export function runBackupTool(mode: BackupMode, argv: string[]): { plan: BackupPlan; output: string; applied: boolean } {
  const options = parseArgs(argv, mode);
  const plan = buildPlan(options);
  if (options.apply) runApply(plan);
  const output = options.json ? JSON.stringify({ applied: options.apply, plan }, null, 2) : renderPlan(plan, options.apply);
  return { plan, output, applied: options.apply };
}

async function main(): Promise<void> {
  const invoked = process.argv[1] ?? '';
  const envMode = process.env['HIVE_BACKUP_MODE'];
  const mode: BackupMode = envMode === 'restore' ? 'restore' : invoked.includes('restore') ? 'restore' : 'backup';
  const result = runBackupTool(mode, process.argv.slice(2));
  console.log(result.output);
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
