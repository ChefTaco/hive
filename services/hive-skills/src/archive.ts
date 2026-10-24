import { readArchive } from "../scripts/archive-utils.mjs";
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.js';

const safeVersion = (version: string): boolean => /^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version);
const safeSlug = (slug: string): boolean => /^[a-z0-9][a-z0-9-]{1,62}$/.test(slug);
export const assertSkillId = (slug: string, version?: string): void => {
  if (!safeSlug(slug)) throw new Error('Skill slug must be lowercase letters, numbers, and hyphens');
  if (version !== undefined && !safeVersion(version)) throw new Error('Version must be a semantic version');
};

export const validateArchive = (path: string): void => {
  readArchive(readFileSync(path));
};

export const persistArchive = (slug: string, version: string, bytes: Buffer): { path: string; sha256: string } => {
  assertSkillId(slug, version); if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024) throw new Error('Archive must be between 1 byte and 50 MiB');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const path = resolve(config.dataDir, 'archives', `${slug}-${version}-${sha256}.tgz`);
  readArchive(bytes);
  if (!existsSync(path)) { const temp = `${path}.partial`; try { writeFileSync(temp, bytes, { mode: 0o600 }); renameSync(temp, path); } finally { if (existsSync(temp)) unlinkSync(temp); } }
  return { path, sha256 };
};

export const persistArchiveFromFile = (slug: string, version: string, source: string): { path: string; sha256: string } => {
  if (!existsSync(source) || basename(source).length === 0) throw new Error('HiveMem archive does not exist');
  return persistArchive(slug, version, readFileSync(source));
};

export const removeArchive = (path: string): void => { if (path.startsWith(resolve(config.dataDir, 'archives')) && existsSync(path)) unlinkSync(path); };
