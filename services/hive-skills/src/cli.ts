#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packageRoot } from './paths.js';

const usage = `Hive Skills: HTTPS skill registry and Hermes distribution bridge.

Usage: hive-skills [start|seed|check|env-schema|migrate|upgrade|rollback] [--env-file FILE]
       hive-skills --help | --version

start         Start the registry (default); requires TLS key and certificate.
check         Validate configuration, TLS and existing storage without writing.
              --json prints a JSON report.
migrate       --plan [--json] inspects; otherwise back up and migrate (--backup-dir DIR).
upgrade       Delegate a complete managed bundle upgrade to the Hive launcher.
rollback      Delegate managed code rollback or explicitly confirmed data restore.
env-schema    Print configuration metadata as JSON without loading configuration.
seed          Explicitly seed the bundled HiveMem skill; never runs on start.
--env-file    Load a dotenv file; existing environment values win.

Configure HIVE_SKILLS_DATA_DIR, HIVE_SKILLS_SESSION_SECRET,
HIVE_SKILLS_ADMIN_USERS, HIVE_SKILLS_TLS_KEY_FILE and HIVE_SKILLS_TLS_CERT_FILE.
See the package README for the complete configuration and migration guide.`;

export async function main(args: readonly string[]): Promise<number> {
  try {
    const special = args.find(arg => ['upgrade', 'rollback', 'migrate'].includes(arg));
    if (special) {
      const rest = [...args]; rest.splice(rest.indexOf(special), 1);
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--env-file' || rest[i]?.startsWith('--env-file=')) {
          const inline = rest[i]!.startsWith('--env-file='); const file = inline ? rest[i]!.slice(11) : rest[i + 1];
          if (!file) throw new Error('--env-file requires a file'); process.loadEnvFile(resolve(file)); rest.splice(i, inline ? 1 : 2); i--;
        }
      }
      if (special === 'migrate') { await (await import('./upgrade.js')).skillsMigration(rest); return 0; }
      return (await import('./release/runtime.js')).delegate([special, ...rest]);
    }
    if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
    if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) {
      const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { version: string };
      console.log(manifest.version); return 0;
    }
    if (args.length === 1 && args[0] === 'env-schema') {
      const { envSchemaDocument } = await import('./env-schema.js');
      console.log(JSON.stringify(envSchemaDocument())); return 0;
    }
    let command: string | undefined;
    const files: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === '--env-file' || arg.startsWith('--env-file=')) {
        const file = arg === '--env-file' ? args[++index] : arg.slice('--env-file='.length);
        if (!file || file.startsWith('--')) throw new Error('--env-file requires a file path');
        files.push(file);
      } else if (!command && (arg === 'start' || arg === 'seed' || arg === 'check')) command = arg;
      else if (arg === '--json' && command === 'check') continue;
      else throw new Error('Invalid arguments. Run hive-skills --help.');
    }
    for (const file of files) process.loadEnvFile(resolve(file));
    if (command === 'check') {
      const { checkConfiguration } = await import('./check.js');
      // Preserve the historical cwd env lookup without importing the writable config module.
      if (files.length === 0) { const { existsSync } = await import('node:fs'); if (existsSync('.env')) process.loadEnvFile('.env'); }
      if (args.includes('--json')) return (await import('./release/runtime.js')).captureCheck(() => checkConfiguration(process.env));
      const code = checkConfiguration(process.env);
      await (await import('./release/runtime.js')).printUpdateNotice(JSON.parse(readFileSync(resolve(packageRoot,'package.json'),'utf8')).version);
      return code;
    }
    if (command === 'seed') { await (await import('./upgrade.js')).skillsMigration([]); await import('./seed.js'); }
    else await import('./server.js');
    return 0;
  } catch (error) {
    console.error(`hive-skills: ${error instanceof Error ? error.message : 'Command failed'}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
