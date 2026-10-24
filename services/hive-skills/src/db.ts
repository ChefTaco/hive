import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { compatibleVersion } from './compatibility.js';
import type { DeploymentTarget, Release, Session, Skill } from './types.js';

const db = new DatabaseSync(config.databasePath, { enableForeignKeyConstraints: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS skills (
    slug TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, homepage TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS releases (
    skill_slug TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE, version TEXT NOT NULL,
    sha256 TEXT NOT NULL, archive_path TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL,
    min_hermes_version TEXT, max_hermes_version TEXT,
    PRIMARY KEY(skill_slug, version)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS deployment_targets (
    name TEXT PRIMARY KEY, host TEXT NOT NULL, username TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS channel_releases (
    channel TEXT NOT NULL CHECK(channel IN ('stable','canary')), skill_slug TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
    version TEXT NOT NULL, PRIMARY KEY(channel,skill_slug), FOREIGN KEY(skill_slug,version) REFERENCES releases(skill_slug,version)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS target_policies (
    target TEXT PRIMARY KEY REFERENCES deployment_targets(name), channel TEXT NOT NULL CHECK(channel IN ('stable','canary')),
    token_hash TEXT NOT NULL, skills_json TEXT, receipt_json TEXT, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS registry_migrations (id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE IF NOT EXISTS deployment_jobs (
    id TEXT PRIMARY KEY, target TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL,
    result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
  ) STRICT;
`);

const releaseColumns = new Set((db.prepare('PRAGMA table_info(releases)').all() as Array<{ name: string }>).map((column) => column.name));
if (!releaseColumns.has('min_hermes_version')) db.exec('ALTER TABLE releases ADD COLUMN min_hermes_version TEXT');
if (!releaseColumns.has('max_hermes_version')) db.exec('ALTER TABLE releases ADD COLUMN max_hermes_version TEXT');

// Preserve the currently published version during the first channel migration.
if (!db.prepare("SELECT id FROM registry_migrations WHERE id='release-channels'").get()) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("INSERT OR IGNORE INTO channel_releases SELECT 'stable', skill_slug, version FROM releases r WHERE created_at=(SELECT MAX(created_at) FROM releases WHERE skill_slug=r.skill_slug)");
    db.exec("INSERT INTO registry_migrations VALUES ('release-channels'); COMMIT");
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

type SkillRow = { slug: string; name: string; description: string; homepage: string | null; enabled: number; created_at: string; updated_at: string };
type ReleaseRow = { skill_slug: string; version: string; sha256: string; archive_path: string; notes: string | null; min_hermes_version: string | null; max_hermes_version: string | null; created_at: string };
type SessionRow = { id: string; username: string; expires_at: string };
type TargetRow = { name: string; host: string; username: string; enabled: number };
const now = (): string => new Date().toISOString();
const mapSkill = (row: SkillRow): Skill => ({ slug: row.slug, name: row.name, description: row.description, homepage: row.homepage, enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at });
const mapRelease = (row: ReleaseRow): Release => ({ skillSlug: row.skill_slug, version: row.version, sha256: row.sha256, archivePath: row.archive_path, notes: row.notes, minHermesVersion: row.min_hermes_version, maxHermesVersion: row.max_hermes_version, createdAt: row.created_at });

export const store = {
  readiness: (): { ready: boolean; missingArchives: number } => {
    db.prepare('SELECT 1').get();
    const missingArchives = [...store.activeManifest('stable'), ...store.activeManifest('canary')].filter(({ release }) => !existsSync(release.archivePath)).length;
    return { ready: missingArchives === 0, missingArchives };
  },
  createDeployment: (target: string, actor: string) => {
    const existing = db.prepare("SELECT id FROM deployment_jobs WHERE target=? AND status IN ('queued','running')").get(target) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID(); db.prepare("INSERT INTO deployment_jobs VALUES (?,?,?,'queued',NULL,?,?)").run(id, target, actor, now(), now()); return id;
  },
  listDeployments: () => db.prepare('SELECT * FROM deployment_jobs ORDER BY created_at DESC LIMIT 100').all(),
  recoverDeployments: () => db.prepare("UPDATE deployment_jobs SET status='queued',result='recovered',updated_at=? WHERE status='running'").run(now()),
  claimDeployment: (): { id: string; target: string } | undefined => {
    return db.prepare("UPDATE deployment_jobs SET status='running',updated_at=? WHERE id=(SELECT id FROM deployment_jobs WHERE status='queued' ORDER BY created_at LIMIT 1) RETURNING id,target").get(now()) as { id: string; target: string } | undefined;
  },
  finishDeployment: (id: string, ok: boolean, code: string) => db.prepare('UPDATE deployment_jobs SET status=?,result=?,updated_at=? WHERE id=?').run(ok ? 'completed' : 'failed', code, now(), id),
  listSkills: (): Skill[] => (db.prepare('SELECT * FROM skills WHERE enabled = 1 ORDER BY name').all() as SkillRow[]).map(mapSkill),
  listAllSkills: (): Skill[] => (db.prepare('SELECT * FROM skills ORDER BY name').all() as SkillRow[]).map(mapSkill),
  getSkill: (slug: string): Skill | undefined => { const row = db.prepare('SELECT * FROM skills WHERE slug = ?').get(slug) as SkillRow | undefined; return row && mapSkill(row); },
  createSkill: (skill: Pick<Skill, 'slug' | 'name' | 'description' | 'homepage' | 'enabled'>): Skill => {
    const timestamp = now(); db.prepare('INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?, ?)').run(skill.slug, skill.name, skill.description, skill.homepage, Number(skill.enabled), timestamp, timestamp); return store.getSkill(skill.slug)!;
  },
  updateSkill: (slug: string, patch: { name?: string | undefined; description?: string | undefined; homepage?: string | null | undefined; enabled?: boolean | undefined }): Skill | undefined => {
    const current = store.getSkill(slug); if (!current) return undefined;
    db.prepare('UPDATE skills SET name=?, description=?, homepage=?, enabled=?, updated_at=? WHERE slug=?').run(patch.name ?? current.name, patch.description ?? current.description, patch.homepage === undefined ? current.homepage : patch.homepage, Number(patch.enabled ?? current.enabled), now(), slug); return store.getSkill(slug);
  },
  deleteSkill: (slug: string): boolean => db.prepare('DELETE FROM skills WHERE slug = ?').run(slug).changes === 1,
  addRelease: (release: Release): void => { db.prepare('INSERT INTO releases(skill_slug,version,sha256,archive_path,notes,created_at,min_hermes_version,max_hermes_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(release.skillSlug, release.version, release.sha256, release.archivePath, release.notes, release.createdAt, release.minHermesVersion ?? null, release.maxHermesVersion ?? null); },
  getRelease: (slug: string, version: string): Release | undefined => { const row = db.prepare('SELECT * FROM releases WHERE skill_slug=? AND version=?').get(slug, version) as ReleaseRow | undefined; return row && mapRelease(row); },
  channelRelease: (channel: string, slug: string): Release | undefined => {
    const pin = db.prepare('SELECT version FROM channel_releases WHERE channel=? AND skill_slug=?').get(channel, slug) as { version: string } | undefined;
    return pin && store.getRelease(slug, pin.version);
  },
  activeManifest: (channel = 'stable', allowedSkills?: string[], hermesVersion?: string, enforceCompatibility = false): Array<Skill & { release: Release }> =>
    store.listSkills()
      .filter((skill) => !allowedSkills || allowedSkills.includes(skill.slug))
      .flatMap((skill) => {
        const release = store.channelRelease(channel, skill.slug);
        if (!release) return [];
        if (enforceCompatibility && !compatibleVersion(hermesVersion, release.minHermesVersion, release.maxHermesVersion)) return [];
        return [{ ...skill, release }];
      }),
  promoteRelease: (slug: string, version: string, channel: string): void => { db.prepare('INSERT INTO channel_releases VALUES (?,?,?) ON CONFLICT(channel,skill_slug) DO UPDATE SET version=excluded.version').run(channel, slug, version); },
  withdrawRelease: (slug: string, channel: string) => db.prepare('DELETE FROM channel_releases WHERE channel=? AND skill_slug=?').run(channel, slug),
  listChannels: () => db.prepare('SELECT * FROM channel_releases ORDER BY channel,skill_slug').all(),
  enrollTarget: (target: string, channel: string, skills: string[] | null): string => {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO target_policies VALUES (?,?,?,?,NULL,?) ON CONFLICT(target) DO UPDATE SET channel=excluded.channel,token_hash=excluded.token_hash,skills_json=excluded.skills_json,updated_at=excluded.updated_at').run(target, channel, tokenHash(token), skills ? JSON.stringify(skills) : null, now());
    return token;
  },
  authenticateTarget: (target: string, token: string) => {
    if (!store.getTarget(target)) return null;
    const policy = db.prepare('SELECT channel,skills_json FROM target_policies WHERE target=? AND token_hash=?').get(target, tokenHash(token)) as { channel: string; skills_json: string | null } | undefined;
    return policy ? { channel: policy.channel, skills: policy.skills_json ? JSON.parse(policy.skills_json) as string[] : undefined } : null;
  },
  recordReceipt: (target: string, receipt: unknown) => db.prepare('UPDATE target_policies SET receipt_json=?,updated_at=? WHERE target=?').run(JSON.stringify(receipt), now(), target),
  listReceipts: () => db.prepare('SELECT target,channel,skills_json,receipt_json,updated_at FROM target_policies').all(),
  createSession: (session: Session): void => { db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(session.id, session.username, session.expiresAt, now()); },
  getSession: (id: string): Session | undefined => { db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()); const row = db.prepare('SELECT id, username, expires_at FROM sessions WHERE id=?').get(id) as SessionRow | undefined; return row && { id: row.id, username: row.username, expiresAt: row.expires_at }; },
  deleteSession: (id: string): void => { db.prepare('DELETE FROM sessions WHERE id=?').run(id); },
  listTargets: (): DeploymentTarget[] => (db.prepare('SELECT * FROM deployment_targets ORDER BY name').all() as TargetRow[]).map((row) => ({ ...row, enabled: Boolean(row.enabled) })),
  saveTarget: (target: DeploymentTarget): void => {
    const prior = db.prepare('SELECT * FROM deployment_targets WHERE name=?').get(target.name) as TargetRow | undefined;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (prior && (prior.host !== target.host || prior.username !== target.username || !target.enabled)) db.prepare('DELETE FROM target_policies WHERE target=?').run(target.name);
      db.prepare('INSERT INTO deployment_targets VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET host=excluded.host,username=excluded.username,enabled=excluded.enabled').run(target.name, target.host, target.username, Number(target.enabled));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
  seedTarget: (target: DeploymentTarget): void => { db.prepare('INSERT OR IGNORE INTO deployment_targets VALUES (?, ?, ?, ?)').run(target.name, target.host, target.username, Number(target.enabled)); },
  getTarget: (name: string): DeploymentTarget | undefined => { const row = db.prepare('SELECT * FROM deployment_targets WHERE name=? AND enabled=1').get(name) as TargetRow | undefined; return row && { name: row.name, host: row.host, username: row.username, enabled: row.enabled === 1 }; },
  audit: (actor: string, action: string, subject: string, details: Record<string, unknown>): void => { db.prepare('INSERT INTO audit_log (actor, action, subject, details, created_at) VALUES (?, ?, ?, ?, ?)').run(actor, action, subject, JSON.stringify(details), now()); }
};
