import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DeploymentTarget } from './types.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.HIVE_SKILLS_PORT ?? '4030');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('HIVE_SKILLS_PORT is invalid');

const host = process.env.HIVE_SKILLS_HOST ?? '127.0.0.1';
const dataDir = resolve(process.env.HIVE_SKILLS_DATA_DIR ?? './data');
mkdirSync(resolve(dataDir, 'archives'), { recursive: true, mode: 0o750 });

export const isLoopbackHost = (value: string): boolean =>
  value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value);

export function resolveSessionSecret(env: NodeJS.ProcessEnv, bindHost: string): string {
  const configured = env.HIVE_SKILLS_SESSION_SECRET?.trim();
  if (configured) {
    if (configured.length < 32) throw new Error('HIVE_SKILLS_SESSION_SECRET must be at least 32 characters');
    return configured;
  }
  if (env.NODE_ENV !== 'production' && isLoopbackHost(bindHost)) {
    console.warn('HIVE_SKILLS_SESSION_SECRET is not set; using an ephemeral secret (sessions end on restart).');
    return randomBytes(32).toString('base64url');
  }
  throw new Error('HIVE_SKILLS_SESSION_SECRET must be configured');
}

/**
 * Parses `HIVE_SKILLS_TARGETS`, a comma-separated list of `name=user@host`
 * deployment targets, for example `agent-1=deploy@agent-host.example.com`.
 */
export function parseTargets(value: string | undefined): DeploymentTarget[] {
  if (!value?.trim()) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const match = /^([a-z0-9][a-z0-9-]{1,62})=([a-z_][a-z0-9_-]{0,31})@([a-zA-Z0-9][a-zA-Z0-9.-]{0,252})$/i.exec(entry);
    if (!match) throw new Error(`HIVE_SKILLS_TARGETS entry "${entry}" must look like name=user@host`);
    return { name: match[1]!.toLowerCase(), username: match[2]!, host: match[3]!, enabled: true };
  });
}

const adminUsers = new Set((process.env.HIVE_SKILLS_ADMIN_USERS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
if (adminUsers.size === 0) console.warn('HIVE_SKILLS_ADMIN_USERS is empty; no account can administer the registry.');

export const config = {
  host,
  port,
  publicUrl: process.env.HIVE_SKILLS_PUBLIC_URL ?? `https://localhost:${port}`,
  dataDir,
  databasePath: resolve(dataDir, 'registry.sqlite'),
  sessionSecret: resolveSessionSecret(process.env, host),
  adminUsers,
  pamService: process.env.HIVE_SKILLS_PAM_SERVICE ?? 'hive-skills',
  tlsKeyFile: process.env.HIVE_SKILLS_TLS_KEY_FILE,
  tlsCertFile: process.env.HIVE_SKILLS_TLS_CERT_FILE,
  deployScript: process.env.HIVE_SKILLS_DEPLOY_SCRIPT ?? resolve(process.cwd(), 'scripts/deploy-hermes-agent.sh'),
  targets: parseTargets(process.env.HIVE_SKILLS_TARGETS),
} as const;

export const requireProductionSecrets = (): void => {
  if (process.env.NODE_ENV === 'production' && (!config.tlsKeyFile || !config.tlsCertFile)) {
    throw new Error('TLS key and certificate file paths are required in production');
  }
};
