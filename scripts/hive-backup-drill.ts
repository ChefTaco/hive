#!/usr/bin/env node --experimental-strip-types
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HIVE_SERVICES } from '../packages/hive-contracts/src/service-manifest.ts';

interface DrillOptions {
  keep: boolean;
  json: boolean;
}

interface DrillCheck {
  status: 'pass' | 'fail';
  name: string;
  message: string;
}

interface DrillResult {
  sourceRoot: string;
  restoreRoot: string;
  archive: string;
  checks: DrillCheck[];
  output: string;
  hasFailures: boolean;
}

function parseArgs(argv: string[]): DrillOptions {
  let keep = false;
  let json = false;
  for (const arg of argv) {
    if (arg === '--keep') keep = true;
    else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node --experimental-strip-types scripts/hive-backup-drill.ts [--keep] [--json]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { keep, json };
}

function localPath(root: string, absolutePath: string): string {
  return resolve(root, absolutePath.replace(/^\/+/, ''));
}

function writeFixtureFile(root: string, absolutePath: string, content: string): void {
  const target = localPath(root, absolutePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function createFixture(root: string): void {
  for (const service of HIVE_SERVICES) {
    for (const path of service.backupPaths) {
      if (path === '/opt/hive-router/releases') {
        writeFixtureFile(root, '/opt/hive-router/releases/release-a/app.txt', 'router release payload\n');
        continue;
      }
      if (path === '/opt/hive-router/current') {
        const link = localPath(root, path);
        mkdirSync(dirname(link), { recursive: true });
        if (!existsSync(link)) symlinkSync('releases/release-a', link);
        continue;
      }
      if (path.endsWith('.env') || path.endsWith('.service')) {
        writeFixtureFile(root, path, `${service.systemdService} fixture ${path}\nSECRET_VALUE=redacted-fixture\n`);
        continue;
      }
      writeFixtureFile(root, `${path}/state.txt`, `${service.systemdService} fixture state for ${path}\n`);
      writeFixtureFile(root, `${path}/nested/marker.json`, JSON.stringify({ service: service.systemdService, path }, null, 2));
    }
  }
}

function manifestRelativePaths(): string[] {
  return [...new Set(HIVE_SERVICES.flatMap((service) => service.backupPaths.map((path) => path.replace(/^\/+/, ''))))];
}

function hashTree(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  function visit(path: string): void {
    const stat = lstatSync(path);
    const key = relative(root, path);
    if (stat.isSymbolicLink()) {
      hashes.set(key, `symlink:${readlinkSync(path)}`);
      return;
    }
    if (stat.isDirectory()) {
      hashes.set(key, 'dir');
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    if (stat.isFile()) {
      hashes.set(key, `file:${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  }
  visit(root);
  hashes.delete('');
  return hashes;
}

function compareTrees(sourceRoot: string, restoreRoot: string): DrillCheck {
  const source = hashTree(sourceRoot);
  const restored = hashTree(restoreRoot);
  const keys = [...new Set([...source.keys(), ...restored.keys()])].sort();
  const mismatches = keys.filter((key) => source.get(key) !== restored.get(key));
  return {
    status: mismatches.length === 0 ? 'pass' : 'fail',
    name: 'restore-integrity',
    message: mismatches.length === 0 ? `${keys.length} restored filesystem entries match` : `Mismatched entries: ${mismatches.slice(0, 8).join(', ')}`,
  };
}

function runTar(args: string[]): void {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `tar ${args.join(' ')} failed`);
  }
}

function render(result: Omit<DrillResult, 'output'>): string {
  const lines = [
    '# Hive Backup Restore Drill',
    '',
    `Source root: ${result.sourceRoot}`,
    `Restore root: ${result.restoreRoot}`,
    `Archive: ${result.archive}`,
    '',
    '## Checks',
  ];
  for (const check of result.checks) lines.push(`- [${check.status.toUpperCase()}] ${check.name}: ${check.message}`);
  return lines.join('\n');
}

export function runBackupRestoreDrill(argv: string[]): DrillResult {
  const options = parseArgs(argv);
  const base = mkdtempSync(join(tmpdir(), 'hive-backup-drill-'));
  const sourceRoot = join(base, 'source');
  const restoreRoot = join(base, 'restore');
  const archive = join(base, 'hive-disposable-drill.tar.gz');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(restoreRoot, { recursive: true });

  try {
    createFixture(sourceRoot);
    const paths = manifestRelativePaths();
    runTar(['-czf', archive, '-C', sourceRoot, ...paths]);
    runTar(['-xzf', archive, '-C', restoreRoot]);
    const checks: DrillCheck[] = [
      { status: existsSync(archive) ? 'pass' : 'fail', name: 'archive-created', message: archive },
      compareTrees(sourceRoot, restoreRoot),
    ];
    const hasFailures = checks.some((check) => check.status === 'fail');
    const result = { sourceRoot, restoreRoot, archive, checks, hasFailures };
    const output = options.json ? JSON.stringify(result, null, 2) : render(result);
    if (!options.keep) rmSync(base, { recursive: true, force: true });
    return { ...result, output };
  } catch (error) {
    if (!options.keep) rmSync(base, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const result = runBackupRestoreDrill(process.argv.slice(2));
  console.log(result.output);
  if (result.hasFailures) process.exitCode = 1;
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
