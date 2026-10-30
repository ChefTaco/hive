#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { boundedResponse, extractArchive, MAX_ARCHIVE_BYTES } from './archive-utils.mjs';

const safeSlug = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,62}$/.test(value);
const versionParts = (value) => { const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(value)); return match ? match.slice(1).map(Number) : null; };
const compareVersions = (left, right) => { const a = versionParts(left); const b = versionParts(right); if (!a || !b) throw new Error('Invalid Hermes compatibility version'); for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index]; return 0; };
const compatibleVersion = (version, range = {}) => (!range.minHermesVersion && !range.maxHermesVersion) || Boolean(version && (!range.minHermesVersion || compareVersions(version, range.minHermesVersion) >= 0) && (!range.maxHermesVersion || compareVersions(version, range.maxHermesVersion) <= 0));
function detectHermesVersion() {
  if (process.env.HIVE_SKILLS_HERMES_VERSION) return process.env.HIVE_SKILLS_HERMES_VERSION;
  const command = process.env.HERMES_BIN ?? 'hermes';
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? (String(result.stdout).match(/v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? undefined) : undefined;
}
function atomicJson(path, value) {
  const fd = openSync(path + '.tmp', 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(path + '.tmp', path);
  const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}

export async function syncSkills({ registry, hermesHome = resolve(homedir(), '.hermes'), fetchImpl = fetch, target, token, hermesVersion = detectHermesVersion(), checkpoint = () => {}, restart = () => {
  const result = spawnSync('/usr/bin/systemctl', ['--user', 'try-restart', 'hermes-gateway.service'], { timeout: 30_000 });
  if (result.status !== 0) throw new Error('Hermes gateway restart failed');
} }) {
  const origin = new URL(registry);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw new Error('Registry requires a plain HTTPS URL');
  const root = resolve(hermesHome, 'skills', 'registry');
  const control = resolve(hermesHome, '.hive-skills-sync');
  const statePath = resolve(root, '.hive-skills-state.json');
  const transactionPath = resolve(control, 'transaction.json');
  const lockPath = resolve(control, 'lock');
  mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(control, { recursive: true, mode: 0o700 });
  try { mkdirSync(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pidPath = resolve(lockPath, 'pid');
    if (!existsSync(pidPath) && Date.now() - statSync(lockPath).mtimeMs < 60_000) throw new Error('Skills sync lock is being initialized');
    const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8')) : 2147483647;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid sync lock');
    try { process.kill(pid, 0); throw new Error('Skills sync already running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    rmSync(lockPath, { recursive: true }); mkdirSync(lockPath, { mode: 0o700 });
  }
  writeFileSync(resolve(lockPath, 'pid'), String(process.pid), { mode: 0o600 });
  try {
    // Resume a rename interrupted before state publication. No remote content
    // is needed to restore the previous complete directory.
    if (existsSync(transactionPath)) {
      const transaction = JSON.parse(readFileSync(transactionPath, 'utf8'));
      if (!safeSlug(transaction.slug)) throw new Error('Invalid sync transaction');
      const destination = resolve(root, transaction.slug);
      const backup = resolve(control, transaction.slug + '.previous');
      const staging = resolve(control, transaction.slug + '.incoming');
      if (!existsSync(staging) && existsSync(destination) && transaction.nextState) atomicJson(statePath, transaction.nextState);
      else if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
      rmSync(transactionPath);
    }
    const prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { skills: {} };
    if (prior.registry && prior.registry !== origin.href) throw new Error('This profile belongs to a different registry; migrate explicitly');
    const manifestUrl = new URL(origin.href.replace(/\/$/, '') + '/v1/agent/manifest');
    if (target) { if (!token) throw new Error('Target token required'); manifestUrl.searchParams.set('target', target); }
    if (hermesVersion) { if (!versionParts(hermesVersion)) throw new Error('Invalid local Hermes version'); manifestUrl.searchParams.set('hermes_version', hermesVersion); }
    const manifest = JSON.parse((await boundedResponse(await fetchImpl(manifestUrl, { ...(target ? { headers: { authorization: `Bearer ${token}` } } : {}), redirect: 'error', signal: AbortSignal.timeout(20_000) }), 1024 * 1024)).toString('utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.skills) || manifest.skills.length > 1000) throw new Error('Unsupported manifest');
    const channel = manifest.channel ?? 'stable';
    if (channel !== 'stable' && channel !== 'canary') throw new Error('Unsupported manifest channel');
    const desired = new Set();
    for (const skill of manifest.skills) {
      if (!safeSlug(skill.slug) || desired.has(skill.slug) || !/^[a-f0-9]{64}$/.test(skill.sha256) || !/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(skill.version)) throw new Error('Unsafe manifest entry');
      if (!compatibleVersion(hermesVersion, skill.compatibility)) throw new Error(`Skill ${skill.slug} is incompatible with this Hermes runtime`);
      const archiveUrl = new URL(skill.archiveUrl);
      const expected = new URL(origin.href.replace(/\/$/, '') + `/v1/skills/${skill.slug}/releases/${skill.version}/archive`);
      if (channel !== 'stable') expected.searchParams.set('channel', channel);
      if (archiveUrl.href !== expected.href) throw new Error('Unexpected archive origin or path');
      desired.add(skill.slug);
    }
    const next = { registry: origin.href, skills: { ...prior.skills }, restartPending: prior.restartPending === true };
    let changed = false;
    for (const skill of manifest.skills) {
      const destination = resolve(root, skill.slug);
      next.skills[skill.slug] = { version: skill.version, sha256: skill.sha256 };
      if (prior.skills?.[skill.slug]?.sha256 === skill.sha256 && existsSync(resolve(destination, 'SKILL.md'))) continue;
      if (existsSync(destination) && !prior.skills?.[skill.slug]) throw new Error("Refusing to replace an unmanaged skill");
      const bytes = await boundedResponse(await fetchImpl(skill.archiveUrl, { redirect: 'error', signal: AbortSignal.timeout(60_000) }), MAX_ARCHIVE_BYTES);
      if (createHash('sha256').update(bytes).digest('hex') !== skill.sha256) throw new Error('Archive checksum mismatch');
      const staging = resolve(control, skill.slug + '.incoming');
      const backup = resolve(control, skill.slug + '.previous');
      rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { mode: 0o700 });
      try { extractArchive(bytes, staging); } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
      atomicJson(transactionPath, { slug: skill.slug, nextState: { ...next, restartPending: true } });
      checkpoint('prepared');
      rmSync(backup, { recursive: true, force: true });
      if (existsSync(destination)) renameSync(destination, backup);
      checkpoint('backed-up');
      renameSync(staging, destination);
      checkpoint('activated');
      next.restartPending = true; atomicJson(statePath, next);
      checkpoint('published');
      rmSync(transactionPath);
      changed = true;
    }
    for (const slug of Object.keys(prior.skills ?? {})) {
      if (!safeSlug(slug)) throw new Error('Invalid managed skill state');
      if (!desired.has(slug) && existsSync(resolve(root, slug))) {
        const backup = resolve(control, slug + '.withdrawn');
        rmSync(backup, { recursive: true, force: true }); renameSync(resolve(root, slug), backup); changed = true;
      }
    }
    for (const slug of Object.keys(next.skills)) if (!desired.has(slug)) delete next.skills[slug];
    next.restartPending ||= changed;
    atomicJson(statePath, next);
    if (next.restartPending) { await restart(); next.restartPending = false; atomicJson(statePath, next); }
    atomicJson(resolve(control, 'receipt.json'), { registry: origin.href, completedAt: new Date().toISOString(), skills: next.skills, status: 'activated' });
    if (target) {
      const receipt = await fetchImpl(new URL(origin.href.replace(/\/$/, '') + '/v1/agent/receipts/' + encodeURIComponent(target)), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ skills: next.skills, status: 'activated' }) });
      if (!receipt.ok) throw new Error('Fleet receipt upload failed');
    }
    return next;
  } finally { rmSync(lockPath, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await syncSkills({ registry: process.env.HIVE_SKILLS_URL, hermesHome: process.env.HERMES_HOME, target: process.env.HIVE_SKILLS_TARGET, token: process.env.HIVE_SKILLS_TARGET_TOKEN });
}
