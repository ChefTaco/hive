import { bodyLimit } from 'hono/body-limit';
import { existsSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { MiddlewareHandler } from 'hono';
import { config } from './config.js';
import { persistArchive, assertSkillId, removeArchive } from './archive.js';
import { authenticateOsUser, createSession, readAuth, removeSession, sessionCookie } from './auth.js';
import { store } from './db.js';
import { page } from './ui.js';
import type { AuthContext, Release } from './types.js';
import { compareVersions, parseVersion } from './compatibility.js';

type Variables = { auth: AuthContext };
type JsonObject = Record<string, unknown>;

const app = new Hono<{ Variables: Variables }>();
const loginAttempts = new Map<string, number>();
const channels = ['stable', 'canary'] as const;

const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

const text = (value: unknown, field: string, max = 10_000): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new HTTPException(400, { message: `${field} is invalid` });
  }
  return value.trim();
};

const optionalText = (value: unknown, field: string, max = 10_000): string | null =>
  value === undefined || value === null || value === '' ? null : text(value, field, max);

const slug = (value: unknown): string => {
  const result = text(value, 'slug', 63).toLowerCase();
  try {
    assertSkillId(result);
  } catch (error) {
    throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Invalid slug' });
  }
  return result;
};

const channelParam = (value: string | undefined): string => {
  const channel = value ?? 'stable';
  if (!(channels as readonly string[]).includes(channel)) throw new HTTPException(400, { message: 'Invalid channel' });
  return channel;
};

const bearer = (header: string | undefined): string => (header ?? '').replace(/^Bearer /, '');

const requireAuth = (admin = false): MiddlewareHandler<{ Variables: Variables }> => async (c, next): Promise<void> => {
  const auth = readAuth(c.req.header('cookie'));
  if (!auth) throw new HTTPException(401, { message: 'Sign in is required' });
  if (admin && !auth.isAdmin) throw new HTTPException(403, { message: 'Administrator access is required' });
  c.set('auth', auth);
  await next();
};

const requestJson = async (c: { req: { json: () => Promise<unknown> } }): Promise<JsonObject> => asObject(await c.req.json());

const archiveUrl = (skillSlug: string, release: Release, channel: string): string => {
  const base = `${config.publicUrl}/v1/skills/${skillSlug}/releases/${release.version}/archive`;
  return channel === 'stable' ? base : `${base}?channel=${channel}`;
};

app.use('*', bodyLimit({ maxSize: 70 * 1024 * 1024 }));

for (const target of config.targets) store.seedTarget(target);

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  await next();
});

app.get('/', (c) => c.html(page));
app.get('/health/live', (c) => c.json({ status: 'ok', service: 'hive-skills' }));
app.get('/healthz', (c) => {
  try {
    const health = store.readiness();
    return c.json({ status: health.ready ? 'ok' : 'degraded', service: 'hive-skills', ...health }, health.ready ? 200 : 503);
  } catch {
    return c.json({ status: 'degraded', service: 'hive-skills', reason: 'database_unavailable' }, 503);
  }
});

app.get('/v1/skills', (c) => c.json(store.listSkills()));

app.get('/v1/skills/:slug', (c) => {
  const skill = store.getSkill(c.req.param('slug'));
  if (!skill || !skill.enabled) throw new HTTPException(404, { message: 'Skill not found' });
  const release = store.channelRelease(channelParam(c.req.query('channel')), skill.slug);
  return c.json({
    ...skill,
    release: release && { version: release.version, sha256: release.sha256, notes: release.notes, createdAt: release.createdAt },
  });
});

app.get('/v1/agent/manifest', (c) => {
  const target = c.req.query('target');
  const hermesVersion = c.req.query('hermes_version');
  const policy = target ? store.authenticateTarget(target, bearer(c.req.header('authorization'))) : null;
  if (target && !policy) throw new HTTPException(401, { message: 'Target enrollment required' });
  if (hermesVersion) {
    try {
      parseVersion(hermesVersion);
    } catch (error) {
      throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Invalid Hermes version' });
    }
  }
  const channel = policy?.channel ?? 'stable';
  const entries = store.activeManifest(channel, policy?.skills, hermesVersion, Boolean(target || hermesVersion));
  return c.json({
    schemaVersion: 1,
    channel,
    hermesVersion: hermesVersion ?? null,
    generatedAt: new Date().toISOString(),
    skills: entries.map(({ release, ...skill }) => ({
      slug: skill.slug,
      name: skill.name,
      version: release.version,
      sha256: release.sha256,
      compatibility: { minHermesVersion: release.minHermesVersion ?? null, maxHermesVersion: release.maxHermesVersion ?? null },
      archiveUrl: archiveUrl(skill.slug, release, channel),
    })),
  });
});

app.post('/v1/agent/receipts/:target', async (c) => {
  const target = c.req.param('target');
  if (!store.authenticateTarget(target, bearer(c.req.header('authorization')))) {
    throw new HTTPException(401, { message: 'Target enrollment required' });
  }
  const body = await requestJson(c);
  const status = text(body.status, 'status', 40);
  if (!['downloaded', 'activated', 'restart_failed', 'discovered'].includes(status)) {
    throw new HTTPException(400, { message: 'Invalid receipt status' });
  }
  const skills = asObject(body.skills);
  if (Object.keys(skills).length > 1000) throw new HTTPException(400, { message: 'Too many receipt entries' });
  const clean: Record<string, { version: string; sha256: string }> = {};
  for (const [key, value] of Object.entries(skills)) {
    const item = asObject(value);
    clean[slug(key)] = { version: text(item.version, 'version', 64), sha256: text(item.sha256, 'sha256', 64) };
  }
  store.recordReceipt(target, { status, skills: clean, receivedAt: new Date().toISOString(), attestation: 'agent-reported' });
  return c.json({ ok: true });
});

// Only the release currently promoted on the requested channel is downloadable;
// unpromoted, superseded and withdrawn releases are reported as missing.
app.get('/v1/skills/:slug/releases/:version/archive', (c) => {
  const skillSlug = c.req.param('slug');
  const version = c.req.param('version');
  const skill = store.getSkill(skillSlug);
  const promoted = store.channelRelease(channelParam(c.req.query('channel')), skillSlug);
  if (!skill?.enabled || !promoted || promoted.version !== version || !existsSync(promoted.archivePath)) {
    throw new HTTPException(404, { message: 'Release archive not found' });
  }
  c.header('Content-Type', 'application/gzip');
  c.header('Content-Disposition', `attachment; filename="${skillSlug}-${version}.tgz"`);
  c.header('X-Content-SHA256', promoted.sha256);
  return c.body(readFileSync(promoted.archivePath));
});

app.post('/auth/login', async (c) => {
  const body = await requestJson(c);
  const username = text(body.username, 'username', 32);
  const password = text(body.password, 'password', 1024);
  for (const [key, expires] of loginAttempts) if (expires <= Date.now()) loginAttempts.delete(key);
  if (loginAttempts.size >= 1000 && !loginAttempts.has(username)) throw new HTTPException(429, { message: 'Try again shortly' });
  const previous = loginAttempts.get(username) ?? 0;
  if (previous > Date.now()) throw new HTTPException(429, { message: 'Try again shortly' });
  if (!await authenticateOsUser(username, password)) {
    loginAttempts.set(username, Date.now() + 15_000);
    throw new HTTPException(401, { message: 'OS authentication failed' });
  }
  loginAttempts.delete(username);
  const token = createSession(username);
  c.header('Set-Cookie', sessionCookie(token));
  store.audit(username, 'login', 'session', {});
  return c.json({ username, isAdmin: config.adminUsers.has(username) });
});

app.post('/auth/logout', (c) => {
  const id = removeSession(c.req.header('cookie'));
  c.header('Set-Cookie', sessionCookie('', 0));
  if (id) store.audit('unknown', 'logout', id, {});
  return c.body(null, 204);
});

app.get('/auth/me', requireAuth(), (c) => c.json(c.get('auth')));

app.get('/admin/skills', requireAuth(true), (c) => c.json(store.listAllSkills()));

app.post('/admin/skills', requireAuth(true), async (c) => {
  const body = await requestJson(c);
  const skill = store.createSkill({
    slug: slug(body.slug),
    name: text(body.name, 'name', 120),
    description: text(body.description, 'description', 5_000),
    homepage: optionalText(body.homepage, 'homepage', 2_000),
    enabled: body.enabled === undefined ? true : body.enabled === true,
  });
  store.audit(c.get('auth').username, 'skill.create', skill.slug, {});
  return c.json(skill, 201);
});

app.patch('/admin/skills/:slug', requireAuth(true), async (c) => {
  const body = await requestJson(c);
  const skill = store.updateSkill(c.req.param('slug'), {
    name: body.name === undefined ? undefined : text(body.name, 'name', 120),
    description: body.description === undefined ? undefined : text(body.description, 'description', 5_000),
    homepage: body.homepage === undefined ? undefined : optionalText(body.homepage, 'homepage', 2_000),
    enabled: body.enabled === undefined ? undefined : body.enabled === true,
  });
  if (!skill) throw new HTTPException(404, { message: 'Skill not found' });
  store.audit(c.get('auth').username, 'skill.update', skill.slug, {});
  return c.json(skill);
});

app.delete('/admin/skills/:slug', requireAuth(true), (c) => {
  const existing = store.getSkill(c.req.param('slug'));
  if (!existing || !store.deleteSkill(existing.slug)) throw new HTTPException(404, { message: 'Skill not found' });
  store.audit(c.get('auth').username, 'skill.delete', existing.slug, {});
  return c.body(null, 204);
});

app.post('/admin/skills/:slug/releases', requireAuth(true), async (c) => {
  const skillId = c.req.param('slug');
  if (!store.getSkill(skillId)) throw new HTTPException(404, { message: 'Skill not found' });
  const body = await requestJson(c);
  const version = text(body.version, 'version', 64);
  try {
    assertSkillId(skillId, version);
  } catch (error) {
    throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Invalid version' });
  }
  if (store.getRelease(skillId, version)) throw new HTTPException(409, { message: 'Releases are immutable; this version already exists' });
  const minHermesVersion = optionalText(body.minHermesVersion, 'minHermesVersion', 64);
  const maxHermesVersion = optionalText(body.maxHermesVersion, 'maxHermesVersion', 64);
  try {
    if (minHermesVersion) parseVersion(minHermesVersion);
    if (maxHermesVersion) parseVersion(maxHermesVersion);
    if (minHermesVersion && maxHermesVersion && compareVersions(minHermesVersion, maxHermesVersion) > 0) {
      throw new Error('Minimum Hermes version exceeds maximum');
    }
  } catch (error) {
    throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Invalid compatibility range' });
  }
  const archive = text(body.archiveBase64, 'archiveBase64', 70 * 1024 * 1024);
  let persisted: { path: string; sha256: string };
  try {
    persisted = persistArchive(skillId, version, Buffer.from(archive, 'base64'));
  } catch (error) {
    throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Invalid archive' });
  }
  const release = {
    skillSlug: skillId,
    version,
    sha256: persisted.sha256,
    archivePath: persisted.path,
    notes: optionalText(body.notes, 'notes', 5_000),
    minHermesVersion,
    maxHermesVersion,
    createdAt: new Date().toISOString(),
  };
  try {
    store.addRelease(release);
  } catch (error) {
    removeArchive(persisted.path);
    throw error;
  }
  store.audit(c.get('auth').username, 'release.create', `${skillId}@${version}`, { sha256: persisted.sha256, minHermesVersion, maxHermesVersion });
  return c.json(release, 201);
});

app.get('/admin/channels', requireAuth(true), (c) => c.json(store.listChannels()));
app.get('/admin/receipts', requireAuth(true), (c) => c.json(store.listReceipts()));

app.put('/admin/channels/:channel/:slug', requireAuth(true), async (c) => {
  const channel = channelParam(c.req.param('channel'));
  const body = await requestJson(c);
  const version = text(body.version, 'version', 64);
  const skill = c.req.param('slug');
  if (!store.getRelease(skill, version)) throw new HTTPException(404, { message: 'Release not found' });
  store.promoteRelease(skill, version, channel);
  store.audit(c.get('auth').username, 'release.promote', skill, { channel, version });
  return c.json({ ok: true });
});

app.delete('/admin/channels/:channel/:slug', requireAuth(true), (c) => {
  const channel = channelParam(c.req.param('channel'));
  store.withdrawRelease(c.req.param('slug'), channel);
  store.audit(c.get('auth').username, 'release.withdraw', c.req.param('slug'), { channel });
  return c.body(null, 204);
});

app.get('/admin/targets', requireAuth(true), (c) => c.json(store.listTargets()));

app.put('/admin/targets/:target', requireAuth(true), async (c) => {
  const body = await requestJson(c);
  const name = slug(c.req.param('target'));
  const host = text(body.host, 'host', 253);
  const username = text(body.username, 'username', 32);
  const validHost = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host);
  const validUser = /^[a-z_][a-z0-9_-]*$/i.test(username);
  if (!validHost || !validUser || (body.enabled !== undefined && typeof body.enabled !== 'boolean')) {
    throw new HTTPException(400, { message: 'Invalid target' });
  }
  store.saveTarget({ name, host, username, enabled: body.enabled !== false });
  store.audit(c.get('auth').username, 'target.update', name, { host, username, enabled: body.enabled !== false });
  return c.json({ ok: true });
});

app.post('/admin/targets/:target/enroll', requireAuth(true), async (c) => {
  const target = c.req.param('target');
  if (!store.getTarget(target)) throw new HTTPException(404, { message: 'Target not found' });
  const body = await requestJson(c);
  const channel = channelParam(text(body.channel, 'channel', 20));
  const skills = body.skills === undefined ? null : Array.isArray(body.skills) ? body.skills.map(slug) : null;
  if (body.skills !== undefined && skills === null) throw new HTTPException(400, { message: 'skills must be an array' });
  const token = store.enrollTarget(target, channel, skills);
  store.audit(c.get('auth').username, 'target.enroll', target, { channel });
  return c.json({ target, token, oneTime: true }, 201);
});

app.get('/admin/deployments', requireAuth(true), (c) => c.json(store.listDeployments()));

app.post('/admin/deployments/:target', requireAuth(true), (c) => {
  const target = store.getTarget(c.req.param('target'));
  if (!target) throw new HTTPException(404, { message: 'Deployment target not found or disabled' });
  const id = store.createDeployment(target.name, c.get('auth').username);
  store.audit(c.get('auth').username, 'deployment.queued', target.name, { id });
  return c.json({ id, status: 'queued', target: target.name }, 202);
});

app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500;
  if (status === 500) console.error(error);
  return c.json({ error: status >= 500 ? 'Internal server error' : error.message }, status);
});

export default app;
