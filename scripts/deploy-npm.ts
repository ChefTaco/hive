#!/usr/bin/env node --experimental-strip-types
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, createReadStream, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { z } from '../services/hive-router/node_modules/zod/index.js';
import { canonicalJson, NATIVE_POLICY, releaseSchema, satisfies } from '../packages/hive-release/src/manifest.ts';
import { readModelE2eConfig } from './model-e2e.ts';

const targetSchema = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/) }).strict();
export interface Target { name: string; host: string }
export interface Config { targets: Target[]; user: string; key: string; password?: string; env: NodeJS.ProcessEnv }
export interface Options { version: string; mode: 'dry-run' | 'apply' | 'verify-only'; envFile?: string }
export interface Inventory { host: string; machine: string; node: string; projects: Array<{ base: string; current: string; versions: Record<string, string> }>; services: Record<string, { component: string; switches: Record<string, string | null> }> }
export interface Status { phase: string; backup?: { sha256: string }; error?: string }
export interface ModelReport { success: boolean; checks: Array<{ passed: boolean }>; cleanup: Array<{ passed: boolean }>; [key: string]: unknown }
export interface Adapter {
  rpc(target: Target, payload: Record<string, unknown>): Promise<unknown>;
  backup(target: Target, id: string, sha256: string): Promise<void>;
  model(target: Target, id: string): Promise<ModelReport>;
  preflight(target: Target): Promise<void>;
  sleep(): Promise<void>;
  progress(target: Target, phase: string): void;
}
export function parseOptions(args: string[]): Options {
  let version = '', mode: Options['mode'] = 'dry-run', envFile: string | undefined;
  let selected = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--to') version = args[++i] || '';
    else if (arg === '--env-file') { envFile = args[++i]; if (!envFile || envFile.startsWith('--')) throw Error('--env-file requires a path'); }
    else if (arg === '--apply' || arg === '--verify-only' || arg === '--dry-run') {
      if (selected) throw Error('Select only one deployment mode'); selected = true;
      mode = arg === '--apply' ? 'apply' : arg === '--verify-only' ? 'verify-only' : 'dry-run';
    } else throw Error('Unknown option; use --help');
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('--to requires an exact stable X.Y.Z release');
  return { version, mode, ...(envFile ? {envFile} : {}) };
}
export function readConfig(env: NodeJS.ProcessEnv): Config {
  let targets: Target[];
  try { targets = z.array(targetSchema).min(1).max(20).parse(JSON.parse(env.HIVE_NPM_DEPLOY_TARGETS || '')); }
  catch { throw Error('HIVE_NPM_DEPLOY_TARGETS must be a JSON array of unique {name,host} targets'); }
  if (new Set(targets.map(t => t.name)).size !== targets.length || new Set(targets.map(t => t.host.toLowerCase())).size !== targets.length) throw Error('Duplicate deployment target');
  const user = env.DEPLOY_USERNAME || env.DEPLOY_USER || '', key = env.DEPLOY_SSH_KEY || '';
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || !key) throw Error('DEPLOY_USERNAME and DEPLOY_SSH_KEY are required');
  const password = env.DEPLOY_SUDO_PASSWORD || env.DEPLOY_PASSWORD;
  if (password?.includes('\n') || password?.includes('\r')) throw Error('Invalid sudo credential encoding');
  for (const name of ['HIVE_E2E_PROVIDER_URL', 'HIVE_E2E_MODEL', 'HIVE_E2E_USERNAME', 'HIVE_E2E_PASSWORD']) if (!env[name]) throw Error(`${name} is required`);
  // Validate provider policy without echoing rejected values or transmitting credentials.
  try { const url = new URL(env.HIVE_E2E_PROVIDER_URL!); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error(); }
  catch { throw Error('Invalid HIVE_E2E_PROVIDER_URL'); }
  if (env.HIVE_E2E_PROVIDER_AUTH_MODE && env.HIVE_E2E_PROVIDER_AUTH_MODE !== 'NONE') throw Error('This deployment command requires an unauthenticated operator-selected model provider');
  if (env.HIVE_E2E_PROVIDER_TOKEN) throw Error('Provider credentials are unsupported by this deployment command');
  return { targets, user, key: resolve(key.replace(/^~(?=$|\/)/, env.HOME || '')), env, ...(password ? {password} : {}) };
}
export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function sshArgs(config: Config, target: Target): string[] { return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', config.key, `${config.user}@${target.host}`]; }
function sudo(config: Config): string { return config.password ? "sudo -k -S -p '' " : 'sudo -n '; }
async function command(file: string, args: string[], input: string | undefined, options: {env?: NodeJS.ProcessEnv; output?: string; timeout?: number} = {}): Promise<string> {
  const fd = options.output ? openSync(options.output, 'wx', 0o600) : undefined;
  const child = spawn(file, args, { env: options.env || process.env, stdio: ['pipe', fd ?? 'pipe', 'pipe'] });
  if (fd !== undefined) closeSync(fd);
  const chunks: Buffer[] = []; let bytes = 0;
  child.stdout?.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 32 * 1024 * 1024) child.kill('SIGTERM'); else chunks.push(data); });
  // Exceptions from SSH, sudo, npm and upstreams may contain infrastructure or credentials.
  child.stderr?.resume();
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
  const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout || 120000);
  try { await new Promise<void>((accept, reject) => { child.on('error', () => reject(Error('Unable to launch deployment tool'))); child.on('close', code => code === 0 && bytes <= 32 * 1024 * 1024 ? accept() : reject(Error('Deployment operation failed; inspect its private receipt'))); }); }
  finally { clearTimeout(timer); }
  return Buffer.concat(chunks).toString('utf8');
}
const worker = readFileSync(new URL('./lib/npm-deploy-host.py', import.meta.url));
export function rpcCommand(config: Config): string { return sudo(config) + 'python3 -c ' + shellQuote(`import base64;exec(compile(base64.b64decode('${worker.toString('base64')}'),'<hive-npm-deploy>','exec'))`); }
async function rpc(config: Config, target: Target, payload: Record<string, unknown>): Promise<unknown> {
  const result = await command('ssh', [...sshArgs(config, target), rpcCommand(config)], (config.password ? config.password + '\n' : '') + JSON.stringify(payload));
  const data = JSON.parse(result) as {error?: string};
  if (data.error) throw Error('Host validation failed; inspect installation configuration');
  return data;
}
export async function deployTargets(config: Config, options: Options, adapter: Adapter, packages: Record<string, unknown>, sources: Record<string, string>, id: string): Promise<void> {
  // Inspect every target before mutating the first; never conflate independent stores.
  const inventories = new Map<Target, Inventory>();
  for (const target of config.targets) {
    const inventory = await adapter.rpc(target, {operation:'inspect'}) as Inventory;
    for (const project of inventory.projects) for (const installed of Object.values(project.versions)) {
      const a = installed.split('.').map(Number), b = options.version.split('.').map(Number);
      if (a[0] !== b[0] || a.some((v, i) => !Number.isSafeInteger(v) || !Number.isSafeInteger(b[i]))) throw Error('Major or malformed release transition refused');
      const difference = (b[0]! - a[0]!) || (b[1]! - a[1]!) || (b[2]! - a[2]!);
      if (difference < 0) throw Error('Downgrade refused; use the recorded recovery procedure');
    }
    const targetPackage = packages['@hivemagnus/hive'] as {hiveRelease?: unknown} | undefined;
    if (targetPackage) { const release = releaseSchema.parse(targetPackage.hiveRelease); if (!satisfies(inventory.node, release.engines.node)) throw Error('Target Node engine unsupported'); }
    await adapter.preflight(target);
    if ([...inventories.values()].some(previous => previous.machine === inventory.machine)) throw Error('Targets resolve to the same installation');
    inventories.set(target, inventory); adapter.progress(target, 'inspected');
  }
  for (const target of config.targets) {
    const inventory = inventories.get(target)!;
    if (options.mode === 'dry-run') { adapter.progress(target, 'dry-run: stage/check/rehearse → quiesce/verified backup/off-host copy → migrate/switch → health → model/cleanup acceptance'); continue; }
    const matched = inventory.projects.every(p => Object.values(p.versions).every(v => v === options.version));
    if (options.mode === 'verify-only' || matched) {
      await adapter.rpc(target, {operation:'verify', version:options.version});
      const report = await adapter.model(target, id);
      if (!report.success || !report.checks.every(c => c.passed) || !report.cleanup.length || !report.cleanup.every(c => c.passed)) throw Error('Live model verification or cleanup failed');
      await adapter.rpc(target, {operation:'verify', version:options.version}); adapter.progress(target, 'verified; no code switch required'); continue;
    }
    let started = false, finished = false;
    try {
      // The host may commit prepare before the SSH response is lost.
      started = true;
      await adapter.rpc(target, {operation:'prepare', id, version:options.version, model:config.env.HIVE_E2E_MODEL, inventory, packages, sources, nativePolicy:NATIVE_POLICY});
      let previous = '', backupAcknowledged = false, modelAcknowledged = false;
      const deadline = Date.now() + 3600_000;
      while (Date.now() < deadline) {
        const state = await adapter.rpc(target, {operation:'status', id}) as Status;
        if (state.phase !== previous) { adapter.progress(target, state.phase); previous = state.phase; }
        if (state.phase === 'awaiting-backup-copy' && !backupAcknowledged) {
          if (!state.backup?.sha256) throw Error('Missing verified backup receipt');
          await adapter.backup(target, id, state.backup.sha256);
          await adapter.rpc(target, {operation:'backup-ack', id, sha256:state.backup.sha256});
          backupAcknowledged = true;
        } else if (state.phase === 'awaiting-model-checks' && !modelAcknowledged) {
          const report = await adapter.model(target, id);
          if (!report.success || !report.checks.every(c => c.passed) || !report.cleanup.length || !report.cleanup.every(c => c.passed)) throw Error('Live model verification or cleanup failed');
          await adapter.rpc(target, {operation:'model-ack', id, report});
          modelAcknowledged = true;
        } else if (state.phase === 'complete') { finished = true; break; }
        else if (['not-started','code-reverted','recovery-required','failed-before-maintenance'].includes(state.phase)) throw Error(`Host transaction ${state.phase}; inspect the private receipt before retrying`);
        await adapter.sleep();
      }
      if (!finished) throw Error('Host transaction timed out');
    } catch (error) {
      if (started && !finished) {
        await adapter.rpc(target, {operation:'reject', id}).catch(() => {});
        // Do not start another installation until recovery has completed.
        for (let n = 0; n < 60; n++) {
          const state = await adapter.rpc(target, {operation:'status', id}).catch(() => null) as Status | null;
          if (state && ['not-started','code-reverted','recovery-required','failed-before-maintenance','complete'].includes(state.phase)) { adapter.progress(target, state.phase); break; }
          await adapter.sleep();
        }
      }
      throw error;
    }
  }
}
async function releasePackages(version: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const name of ['hive', 'hive-iam-server', 'hive-router', 'hivemem-server', 'hive-skills']) {
    const full = '@hivemagnus/' + name;
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(full)}/${version}`, {redirect:'error', signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw Error('Complete public npm bundle is unavailable');
    const pkg = await response.json() as {version:string; hiveRelease?: {version:string}; dist?: {integrity:string}};
    if (pkg.version !== version || pkg.hiveRelease?.version !== version || !pkg.dist?.integrity) throw Error('Invalid public release manifest');
    result[full] = pkg;
  }
  const manifests = Object.values(result).map(value => releaseSchema.parse((value as {hiveRelease:unknown}).hiveRelease));
  if (manifests.some(manifest => canonicalJson(manifest) !== canonicalJson(manifests[0]))) throw Error('Public bundle manifests differ');
  for (const [name, value] of Object.entries(result)) if ((value as {engines?:{node?:string}}).engines?.node !== manifests[0]!.engines.node || manifests[0]!.components[name] !== version) throw Error('Public bundle engines or pins differ');
  return result;
}
export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: npm run deploy:npm -- --to X.Y.Z [--env-file FILE] [--dry-run|--apply|--verify-only]\nDefault: read-only dry-run. See docs/npm-deployments.md.'); return 0;
  }
  let config: Config, options: Options;
  try {
    options = parseOptions(args);
    let env = process.env;
    if (options.envFile) {
      if ((statSync(options.envFile).mode & 0o077) !== 0) throw Error('Environment file must be owner-only');
      env = {...parseEnv(readFileSync(options.envFile, 'utf8')), ...process.env};
    }
    config = readConfig(env);
  } catch (error) { console.error(error instanceof Error ? error.message : 'Invalid configuration'); return 2; }
  const id = 'npm-' + options.version.replaceAll('.', '-') + '-' + randomUUID();
  const output = resolve('output/npm-deploy', id);
  try {
    const packages = await releasePackages(options.version);
    const models = await fetch(config.env.HIVE_E2E_PROVIDER_URL!.replace(/\/$/, '') + '/v1/models', {redirect:'error', signal:AbortSignal.timeout(15000)});
    if (!models.ok || !((await models.json()) as {data?:Array<{id:string}>}).data?.some(model => model.id === config.env.HIVE_E2E_MODEL)) throw Error('Configured model provider/model is unavailable');
    const sources = Object.fromEntries([['worker.py','./lib/npm-deploy-host.py'],['backup.py','./hive-state-backup.py'],['runtime.mjs','./lib/npm-deploy-runtime.mjs']].map(([name,path]) => [name!, readFileSync(new URL(path!, import.meta.url)).toString('base64')]));
    if (options.mode !== 'dry-run') mkdirSync(output, {recursive:true, mode:0o700});
    const adapter: Adapter = {
      rpc: async (target, payload) => {
        const result = await rpc(config, target, payload);
        if (options.mode !== 'dry-run' && payload.operation === 'status') writeFileSync(resolve(output, target.name + '-transaction.json'), JSON.stringify(result, null, 2), {mode:0o600});
        return result;
      },
      backup: async (target, transaction, expected) => {
        const file = resolve(output, target.name + '-state.tar.gz.partial');
        await command('ssh', [...sshArgs(config, target), sudo(config) + 'cat ' + shellQuote(`/var/backups/hive/npm-deploy/${transaction}/state.tar.gz`)], config.password ? config.password + '\n' : undefined, {output:file, timeout:600000});
        const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes);
        if (hash.digest('hex') !== expected) throw Error('Off-host backup checksum mismatch; migration refused');
        renameSync(file, resolve(output, target.name + '-state.tar.gz'));
      },
      model: async (target, transaction) => {
        const settings = await rpc(config, target, {operation:'model-config'}) as {admin:string; api:string; memory:string; token:string; ca:string};
        const ca = resolve(output, target.name + '-ca.crt'), report = resolve(output, target.name + '-model.json');
        if (!settings.token) throw Error('Existing Memory token is required; no token will be generated');
        writeFileSync(ca, settings.ca, {mode:0o600});
        await command('npm', ['run','test:e2e:model'], undefined, {env:{...config.env, NODE_EXTRA_CA_CERTS:ca, HIVE_E2E_ADMIN_URL:settings.admin, HIVE_E2E_API_URL:settings.api, HIVE_E2E_MEMORY_URL:settings.memory, HIVE_E2E_MEMORY_TOKEN:settings.token, HIVE_E2E_REPORT_PATH:report}, output:resolve(output, target.name + '-model.log'), timeout:900000});
        return JSON.parse(readFileSync(report, 'utf8')) as ModelReport;
      },
      preflight: async target => {
        const settings = await rpc(config, target, {operation:'model-config'}) as {admin:string; api:string; memory:string; token:string};
        readModelE2eConfig({...config.env, HIVE_E2E_ADMIN_URL:settings.admin, HIVE_E2E_API_URL:settings.api, HIVE_E2E_MEMORY_URL:settings.memory, HIVE_E2E_MEMORY_TOKEN:settings.token});
      },
      sleep: () => new Promise(accept => setTimeout(accept, 2000)),
      progress: (target, phase) => console.log(`${target.name}: ${phase}`),
    };
    await deployTargets(config, options, adapter, packages, sources, id);
    if (options.mode !== 'dry-run') writeFileSync(resolve(output, 'result.json'), JSON.stringify({id, version:options.version, success:true, targets:config.targets.map(t => t.name)}, null, 2), {mode:0o600});
    console.log(options.mode === 'dry-run' ? 'Inspection complete; no persistent changes made.' : `Deployment verification passed; private evidence: ${output}`); return 0;
  } catch { console.error(`Deployment stopped; later targets were not deployed. Private evidence: ${output}. Host receipt: /var/backups/hive/npm-deploy/${id}/transaction.json. Inspect systemctl status hive-npm-deploy-${id} before retrying.`); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
