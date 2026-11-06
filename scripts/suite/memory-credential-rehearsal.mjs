// Rehearsal proof of Emberpath's self-renewing HiveMem credential on a migrated suite, used by
// native-migration-rehearsal.mjs. Runs only against the local Docker rehearsal copy.
//
// It shows, through the console port the native clients use:
//   - the Router memory pages, the actors list with memory agents, and actor onboarding and
//     rotation work with no static token at all: the copied native token is replaced by one
//     that has already expired
//   - without the service credential, the same expired token fails (the negative control)
//   - over several service-token lifetimes, Emberpath renews its own credential: requests keep
//     succeeding, Oathweave records new client_credentials grants, and nothing is restarted
//
// Session cookies, tokens and secrets stay in owner-only files and are never printed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT = 'emberpath-hivemem';

export function envValue(file, key) {
  let value = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith(key + '=')) continue;
    value = line.slice(key.length + 1);
    if (value.length > 1 && ((value[0] === "'" && value.at(-1) === "'") || (value[0] === '"' && value.at(-1) === '"'))) value = value.slice(1, -1);
  }
  return value;
}
function setEnvValue(file, key, value) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line && !line.startsWith(key + '='));
  if (value !== null) lines.push(`${key}='${value}'`);
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
}
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const claims = (token) => { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { return null; } };

/** A HiveMem admin token like the native one, but already expired. */
function expiredToken(secret, subject) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iss: 'hivemem', aud: 'hivemem-api', token_type: 'access', sub: subject, role: 'admin', scope: 'admin:all', iat: now - 7200, exp: now - 3600, jti: randomUUID() });
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

export function memoryCredentialRehearsal({ out, suite, fqdn, address, trust, say }) {
  const composeFile = join(suite, 'compose.json');
  const dc = (...argv) => execFileSync('docker', ['compose', '-f', composeFile, ...argv], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const emberEnv = join(suite, 'config/emberpath.env');
  const cookieFile = join(out, 'memory-credential.cookie');
  const started = () => execFileSync('docker', ['inspect', dc('ps', '-q', 'emberpath').trim(), '--format', '{{.State.StartedAt}}'], { encoding: 'utf8' }).trim();
  const recreate = () => { dc('up', '-d', '--wait', '--wait-timeout', '180', '--no-deps', '--force-recreate', 'emberpath'); };

  // A temporary admin session on this copy, created by Emberpath's own code, as a native
  // client that signed in to the Router would hold. It expires within the rehearsal.
  function session() {
    const code = `import {prisma} from '/app/dist/src/storage/client.js';import {SignJWT} from 'jose';import {randomUUID} from 'node:crypto';
const user=await prisma.adminUser.findFirst({orderBy:{createdAt:'asc'}});if(!user)throw new Error('No Router administrator');
const sid=randomUUID();await prisma.adminSession.create({data:{sessionId:sid,userId:user.id,expiresAt:new Date(Date.now()+3600_000),userAgent:'memory-credential-rehearsal'}});
const token=await new SignJWT({sid,username:user.username,roles:[],permissions:['memory:read','memory:write','hive:actors:read','hive:actors:write'],authMode:'iam-oidc'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('3600s').sign(new TextEncoder().encode(process.env.HIVE_ROUTER_SECRET));
console.log(JSON.stringify({cookie:'hive_router_admin='+token}));await prisma.$disconnect();process.exit(0);`;
    const output = dc('exec', '-T', 'emberpath', 'node', '--input-type=module', '-e', code);
    const cookie = JSON.parse(output.trim().split('\n').reverse().find((line) => line.startsWith('{'))).cookie;
    writeFileSync(cookieFile, 'Cookie: ' + cookie + '\n', { mode: 0o600 });
  }
  function call(method, path, body) {
    const reply = spawnSync('curl', ['-sS', '-w', '\n%{http_code}', '--max-time', '60', '-X', method, '--resolve', `${fqdn}:443:${address}`, '--cacert', trust, '-H', '@' + cookieFile, ...(body ? ['-H', 'Content-Type: application/json', '--data-binary', '@-'] : []), `https://${fqdn}:443${path}`], { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8' });
    const lines = reply.stdout.trim().split('\n');
    const status = Number(lines.pop());
    let parsed = null; try { parsed = JSON.parse(lines.join('\n')); } catch { /* not JSON */ }
    return { status, body: parsed };
  }
  // The HiveMem-backed features of the Router: memory pages, actors list, onboarding, rotation.
  function features(label, { lifecycle = false } = {}) {
    const dashboard = call('GET', '/api/memory/dashboard-data');
    const queue = call('GET', '/api/memory/queue?limit=3');
    const actors = call('GET', '/api/hive/actors');
    const memoryActors = Array.isArray(actors.body?.data) ? actors.body.data.filter((actor) => actor?.identifiers?.memoryAgentId).length : 0;
    const result = {
      label,
      dashboard: { status: dashboard.status, configured: dashboard.body?.configured ?? null, statsAvailable: Boolean(dashboard.body?.stats), memoryAgents: Array.isArray(dashboard.body?.agents) ? dashboard.body.agents.length : null, error: dashboard.body?.error ?? null },
      queue: { status: queue.status, error: queue.body?.error ?? null },
      actors: { status: actors.status, total: Array.isArray(actors.body?.data) ? actors.body.data.length : null, withMemoryAgent: memoryActors },
    };
    if (lifecycle) {
      const agentId = 'rehearsal-' + randomBytes(3).toString('hex');
      const created = call('POST', '/api/hive/actors', { agentId, displayName: 'Temporary rehearsal actor', iamClientId: envValue(emberEnv, 'HIVE_ROUTER_IAM_CLIENT_ID') || 'hive-router', expiresHours: 1, scopes: ['memories:read', 'sessions:read'] });
      const steps = Array.isArray(created.body?.steps) ? created.body.steps.map((step) => `${step.service}:${step.action}:${step.status}`) : [];
      const rotated = created.status < 300 ? call('POST', `/api/hive/actors/${encodeURIComponent(agentId)}/rotate`, { operationId: randomUUID() }) : null;
      result.onboarding = { status: created.status, memorySteps: steps.filter((step) => step.startsWith('memory')), error: created.body?.error ?? created.body?.message ?? null };
      result.rotation = rotated ? { status: rotated.status, error: rotated.body?.error ?? rotated.body?.message ?? null } : null;
    }
    return result;
  }
  const working = (result) => result.dashboard.status === 200 && result.dashboard.configured === true && result.dashboard.statsAvailable && result.queue.status === 200 && result.actors.status === 200 && result.actors.withMemoryAgent > 0;
  // Oathweave's own audit trail of client_credentials grants to this client.
  function grants() {
    const directory = join(suite, 'data/oathweave/iam/audit-logs');
    const times = [];
    for (const name of existsSync(directory) ? readdirSync(directory) : []) {
      for (const line of readFileSync(join(directory, name), 'utf8').split('\n')) {
        if (!line.includes('oauth.client_credentials') || !line.includes(CLIENT)) continue;
        try { const event = JSON.parse(line); if (event.actorId === CLIENT || event.detail?.clientId === CLIENT) times.push(event.timestamp ?? event.createdAt ?? event.occurredAt); } catch { /* not an event */ }
      }
    }
    return times.filter(Boolean).sort();
  }
  const sleep = (seconds) => execFileSync('sleep', [String(seconds)]);

  return {
    configuration() {
      const ember = { clientId: envValue(emberEnv, 'EMBERPATH_HIVEMEM_CLIENT_ID'), tokenUrl: envValue(emberEnv, 'EMBERPATH_HIVEMEM_TOKEN_URL'), secretConfigured: Boolean(envValue(emberEnv, 'EMBERPATH_HIVEMEM_CLIENT_SECRET')), staticToken: Boolean(envValue(emberEnv, 'HIVE_ROUTER_MEMORY_PROXY_TOKEN')) };
      const policies = JSON.parse(envValue(join(suite, 'config/oathweave.env'), 'IAM_MACHINE_CLIENT_POLICIES') || '{}');
      const services = JSON.parse(envValue(join(suite, 'config/hivemem.env'), 'HIVEMEM_OATHWEAVE_SERVICES_JSON') || '[]');
      return { emberpath: ember, oathweavePolicy: policies[CLIENT] ?? null, hivememLink: services.find((link) => link.clientId === CLIENT) ?? null };
    },
    /** Before an upgrade: the problem. The 2.0.1 Router stops serving memory once its copied token expires. */
    staticOnly() {
      session();
      const bytes = readFileSync(emberEnv);
      const original = envValue(emberEnv, 'HIVE_ROUTER_MEMORY_PROXY_TOKEN');
      assert(original, 'The migrated Router has a static memory token');
      const before = features('static token, valid');
      setEnvValue(emberEnv, 'HIVE_ROUTER_MEMORY_PROXY_TOKEN', expiredToken(envValue(join(suite, 'config/hivemem.env'), 'HIVEMEM_JWT_SECRET'), claims(original)?.sub ?? 'hive-router'));
      recreate(); session();
      const expired = features('static token, expired');
      writeFileSync(emberEnv, bytes); recreate();
      rmSync(cookieFile, { force: true });
      return { staticTokenExpiresAt: new Date((claims(original)?.exp ?? 0) * 1000).toISOString(), before, expired, failsOnceExpired: working(before) && !working(expired) };
    },
    /** With the self-renewing credential, from the first request through several renewals. */
    proof({ renewalSeconds = 660, intervalSeconds = 30 } = {}) {
      const report = { configuration: this.configuration() };
      assert.equal(report.configuration.emberpath.clientId, CLIENT, 'Emberpath has the self-renewing credential');
      assert(report.configuration.oathweavePolicy && report.configuration.hivememLink, 'Oathweave and HiveMem know the client');
      // The file is restored byte for byte, so the pinned deployment inputs stay valid.
      const bytes = readFileSync(emberEnv);
      const original = envValue(emberEnv, 'HIVE_ROUTER_MEMORY_PROXY_TOKEN');
      const secret = envValue(emberEnv, 'EMBERPATH_HIVEMEM_CLIENT_SECRET');
      const grantsBefore = grants().length;
      try {
        say('memory credential: Router memory features with the self-renewing credential');
        session();
        report.initial = features('service credential', { lifecycle: true });
        assert(working(report.initial), 'Memory features work: ' + JSON.stringify(report.initial));
        assert.equal(report.initial.onboarding.status, 201, 'Onboarding works: ' + JSON.stringify(report.initial.onboarding));
        assert(report.initial.rotation?.status < 300, 'Rotation works: ' + JSON.stringify(report.initial.rotation));

        say('memory credential: the native token is replaced by one that expired an hour ago');
        const expired = expiredToken(envValue(join(suite, 'config/hivemem.env'), 'HIVEMEM_JWT_SECRET'), claims(original ?? '')?.sub ?? report.configuration.hivememLink.localId);
        setEnvValue(emberEnv, 'HIVE_ROUTER_MEMORY_PROXY_TOKEN', expired);
        say('memory credential: negative control, the expired token alone');
        setEnvValue(emberEnv, 'EMBERPATH_HIVEMEM_CLIENT_ID', null); setEnvValue(emberEnv, 'EMBERPATH_HIVEMEM_CLIENT_SECRET', null);
        recreate(); session();
        report.expiredTokenOnly = features('expired static token, no service credential');
        assert(!working(report.expiredTokenOnly), 'The expired token alone must fail: ' + JSON.stringify(report.expiredTokenOnly));
        setEnvValue(emberEnv, 'EMBERPATH_HIVEMEM_CLIENT_ID', CLIENT); setEnvValue(emberEnv, 'EMBERPATH_HIVEMEM_CLIENT_SECRET', secret);
        recreate(); session();
        report.afterExpiry = features('expired static token, service credential', { lifecycle: true });
        assert(working(report.afterExpiry), 'Memory features work after the native token expired: ' + JSON.stringify(report.afterExpiry));
        assert.equal(report.afterExpiry.onboarding.status, 201);
        assert(report.afterExpiry.rotation?.status < 300);

        say(`memory credential: ${renewalSeconds}s of use with no operator action`);
        const startedAt = started(), from = new Date().toISOString(), statuses = {};
        const grantsAtStart = grants().length;
        for (let elapsed = 0; elapsed < renewalSeconds; elapsed += intervalSeconds) {
          const reply = call('GET', '/api/memory/queue?limit=1');
          statuses[reply.status] = (statuses[reply.status] ?? 0) + 1;
          sleep(intervalSeconds);
        }
        sleep(8); // Oathweave flushes audit events every few seconds
        const window = grants().filter((time) => time >= from);
        report.renewal = {
          seconds: renewalSeconds, requests: statuses, allSucceeded: Object.keys(statuses).every((status) => status === '200'),
          oathweaveGrantsDuringWindow: grants().length - grantsAtStart, grantTimes: window,
          emberpathRestarted: started() !== startedAt,
          refreshFailuresLogged: (dc('logs', '--no-color', '--since', from, 'emberpath').match(/HiveMem service credential refresh failed/g) ?? []).length,
        };
        assert(report.renewal.allSucceeded, 'Every request during renewal succeeds: ' + JSON.stringify(statuses));
        assert(report.renewal.oathweaveGrantsDuringWindow >= 2, 'Emberpath renewed its token on its own: ' + JSON.stringify(report.renewal));
        assert.equal(report.renewal.emberpathRestarted, false);
        report.oathweaveGrantsTotal = grants().length - grantsBefore;
        const logs = dc('logs', '--no-color');
        report.secretInLogs = logs.includes(secret) || readdirSync(out).filter((name) => name.endsWith('.log')).some((name) => readFileSync(join(out, name), 'utf8').includes(secret));
        assert.equal(report.secretInLogs, false, 'The client secret never appears in logs');
      } finally {
        writeFileSync(emberEnv, bytes);
        recreate();
        rmSync(cookieFile, { force: true });
      }
      report.passed = true;
      return report;
    },
  };
}
