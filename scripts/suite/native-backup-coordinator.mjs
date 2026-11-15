// Runs inside the installed Magnus server. This fence covers managed admissions,
// never independent host writers; the host backup owns their separate quiescence.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const HELD = ['reserved', 'running', 'unknown'];
const PARTICIPANTS = ['agent', 'api', 'dashboard', 'scheduler'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const COVERAGE = 'control-api-node-reservations';

function fail(code) { const error = new Error(code); error.code = code; throw error; }
export function backupRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'action,nodeFqdn,nodeId,session'
    || !['reserve', 'verify', 'release'].includes(value.action)
    || typeof value.nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.nodeId)
    || typeof value.nodeFqdn !== 'string' || value.nodeFqdn.length > 253
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value.nodeFqdn)
    || typeof value.session !== 'string' || !UUID.test(value.session)) fail('NATIVE_BACKUP_REQUEST_INVALID');
  return value;
}

function ownFence(value, input) {
  if (!value || value.nodeId !== input.nodeId || value.nodeFqdn !== input.nodeFqdn
    || value.releaseId !== input.session || value.closed === false) fail('NATIVE_BACKUP_FENCE_CONFLICT');
}

export function assertUpgradeQuiet(node, agent, runs) {
  if (!agent || agent.status === 'UPDATING') fail('NATIVE_BACKUP_UPGRADE_UNSETTLED');
  let metadata;
  try { metadata = JSON.parse(node.metadata); } catch { fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
  const report = metadata.agentSelfUpgrade;
  if (!report || typeof report !== 'object' || Array.isArray(report) || !Number.isSafeInteger(report.protocol)
    || report.protocol < 0 || typeof report.enabled !== 'boolean' || !['versioned', 'legacy', 'container'].includes(report.layout))
    fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
  if (report.upgrade != null && !['idle', 'confirmed', 'reverted', 'failed'].includes(report.upgrade.state))
    fail('NATIVE_BACKUP_UPGRADE_UNSETTLED');
  if (!Array.isArray(runs)) fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
  for (const run of runs) {
    if (!run || !['running', 'succeeded', 'partial', 'failed', 'stopped', 'interrupted'].includes(run.status)
      || !Array.isArray(run.nodes)) fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
    for (const target of run.nodes) {
      if (!target || typeof target.nodeId !== 'string') fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
      if (target.nodeId === node.id && (run.status === 'running' || target.awaitingReport === true
        || !['confirmed', 'reverted', 'failed', 'refused', 'skipped'].includes(target.state)))
        fail('NATIVE_BACKUP_UPGRADE_UNSETTLED');
    }
  }
}

// Deliberately bypass the upgrade store's memory fallback and reconciling reads:
// absent Redis evidence is not proof that an upgrade has finished.
export async function readUpgradeRuns(redis) {
  const prefix = redis.options?.keyPrefix;
  if (typeof prefix !== 'string') fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
  if (await redis.get('agent-upgrade-run:lock') !== null) fail('NATIVE_BACKUP_UPGRADE_UNSETTLED');
  const runs = [], seen = new Set(); let cursor = '0', pages = 0;
  do {
    if (++pages > 100) fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
    const page = await redis.scan(cursor, 'MATCH', `${prefix}agent-upgrade-run:*`, 'COUNT', 100);
    if (!Array.isArray(page) || page.length !== 2 || typeof page[0] !== 'string' || !Array.isArray(page[1]))
      fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
    cursor = page[0];
    for (const rawKey of page[1]) {
      if (typeof rawKey !== 'string' || !rawKey.startsWith(prefix)) fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
      const key = rawKey.slice(prefix.length);
      if (key === 'agent-upgrade-run:latest' || key === 'agent-upgrade-run:lock' || /^agent-upgrade-run:[a-f0-9-]{36}:stop$/i.test(key)) continue;
      if (!/^agent-upgrade-run:[a-f0-9-]{36}$/i.test(key)) fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
      if (seen.has(key)) continue;
      seen.add(key); if (seen.size > 1000) fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
      const raw = await redis.get(key);
      // An expiry or concurrent rewrite during inventory needs another attempt.
      if (typeof raw !== 'string' || raw.length > 1_048_576) fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
      let run;
      try { run = JSON.parse(raw); } catch { fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED'); }
      if (run?.id !== key.slice('agent-upgrade-run:'.length)) fail('NATIVE_BACKUP_UPGRADE_UNVERIFIED');
      runs.push(run);
    }
  } while (cursor !== '0');
  if (await redis.get('agent-upgrade-run:lock') !== null) fail('NATIVE_BACKUP_UPGRADE_UNSETTLED');
  return runs;
}

async function verify(input, deps, requireEnrollment, requireFresh) {
  ownFence(await deps.fence.inspectNodeAdmission(input.nodeId), input);
  return deps.db.$transaction(async tx => {
    // Match the fence service's ordering. Admissions and fence release serialize
    // with this complete snapshot, including global shared work.
    await deps.fence.lockSharedAdmission(tx);
    await deps.lockResourceNode(tx, input.nodeId);
    const { node, row } = await deps.resourceNodeIdentity(tx, input.nodeId);
    if (node.id !== input.nodeId || node.hostname !== input.nodeFqdn || !['ONLINE', 'OFFLINE'].includes(node.status)
      || requireFresh && !deps.hasFreshOnlineHealth(node, deps.now?.().getTime() ?? Date.now()))
      fail('NATIVE_BACKUP_TARGET_INVALID');
    ownFence(await tx.admissionFence.findUnique({ where: { nodeId: input.nodeId } }), input);
    const counts = await Promise.all([
      tx.commandResourceLease.count({ where: { nodeId: input.nodeId, state: { in: HELD } } }),
      tx.resourceParticipantWork.count({ where: { nodeId: input.nodeId, state: { in: HELD } } }),
      tx.managedCronOccurrence.count({ where: { nodeId: input.nodeId, state: { not: 'completed' } } }),
      tx.sharedResourceLease.count({ where: { state: { in: HELD } } }),
      tx.ardentAgentOperation.count({ where: { nodeId: input.nodeId, status: { notIn: ['succeeded', 'failed'] } } }),
    ]);
    if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) fail('NATIVE_BACKUP_WORK_UNVERIFIED');
    if (counts.some(count => count !== 0)) fail('NATIVE_BACKUP_WORK_UNSETTLED');
    if (requireEnrollment) {
      await deps.assertEnrollmentComplete(tx, input.nodeId, input.nodeFqdn);
      if (!row || !Number.isSafeInteger(row.epoch) || row.epoch <= 0 || !UUID.test(row.barrierId ?? ''))
        fail('NATIVE_BACKUP_ENROLLMENT_UNVERIFIED');
      const participants = await tx.resourceDrainParticipant.findMany({ where: { nodeId: input.nodeId } });
      if (participants.length !== PARTICIPANTS.length || !PARTICIPANTS.every(name => participants.some(participant =>
        participant.participant === name && participant.status === 'verified' && participant.epoch === row.epoch
        && participant.barrierId === row.barrierId && /^[a-f0-9]{64}$/.test(participant.evidenceSha256 ?? '')
        && participant.verifiedAt instanceof Date && Number.isFinite(participant.verifiedAt.getTime()))))
        fail('NATIVE_BACKUP_ENROLLMENT_UNVERIFIED');
    }
    const agent = await tx.agent.findUnique({ where: { nodeId: input.nodeId }, select: { status: true } });
    assertUpgradeQuiet(node, agent, await deps.readUpgradeRuns());
  }, { timeout: 20_000, maxWait: 5000 });
}

export async function coordinateNativeBackup(value, deps) {
  const input = backupRequest(value);
  try {
    let requireFresh = input.action === 'reserve';
    if (input.action === 'reserve') {
      const prior = await deps.fence.inspectNodeAdmission(input.nodeId);
      if (prior.closed) { ownFence(prior, input); requireFresh = false; }
      ownFence(await deps.fence.closeNodeAdmission(input.nodeId, input.nodeFqdn, input.session), input);
    }
    await verify(input, deps, input.action !== 'release', requireFresh);
    if (input.action === 'release') {
      const released = await deps.fence.releaseNodeAdmission(input.nodeId, input.nodeFqdn, input.session);
      if (released.nodeId !== input.nodeId || released.nodeFqdn !== input.nodeFqdn || released.releaseId !== input.session || released.closed !== false)
        fail('NATIVE_BACKUP_RELEASE_UNVERIFIED');
      const state = await deps.fence.inspectNodeAdmission(input.nodeId);
      if (state.nodeId !== input.nodeId || state.nodeFqdn !== input.nodeFqdn || state.closed !== false || state.releaseId !== null)
        fail('NATIVE_BACKUP_RELEASE_UNVERIFIED');
    }
    const sharedAdmissionsClosed = input.action !== 'release' || await deps.db.admissionFence.count() !== 0;
    return { schema: 1, ...input, closed: input.action !== 'release', verified: true, coverage: COVERAGE,
      sharedAdmissionsClosed, independentWritersCovered: false, checkedAt: (deps.now?.() ?? new Date()).toISOString() };
  } catch (error) {
    // Never roll a reservation back on an uncertain outcome, including a lost
    // close acknowledgement. Nor can a prior inspect prove this call created it.
    let held = 'unknown';
    try {
      const state = await deps.fence.inspectNodeAdmission(input.nodeId);
      held = state.closed ? 'yes' : 'no';
    } catch { /* No claim about a fence whose authoritative state cannot be read. */ }
    const sanitized = new Error('Native backup admission requires review');
    sanitized.code = /^NATIVE_BACKUP_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'NATIVE_BACKUP_COORDINATION_FAILED';
    sanitized.held = held;
    throw sanitized;
  }
}

export async function installedDependencies() {
  const require = createRequire('/opt/magnus-server/package.json');
  const base = dirname(require.resolve('@hivemagnus/magnus-server/package.json')) + '/dist';
  const load = name => import(pathToFileURL(`${base}/${name}.js`).href);
  const [database, fence, locks, enrollment, queue, health] = await Promise.all([
    load('db/index'), load('services/admission-fence'), load('services/resource-node-lock'), load('services/resource-enrollment'), load('queue/redis'),
    load('services/resource-node-health'),
  ]);
  const redis = queue.getRedis();
  redis.on('error', () => {}); // Errors are returned as bounded coordinator codes, never connection details.
  return { db: database.getDb(), fence, lockResourceNode: locks.lockResourceNode, resourceNodeIdentity: locks.resourceNodeIdentity,
    assertEnrollmentComplete: enrollment.assertEnrollmentComplete, hasFreshOnlineHealth: health.hasFreshOnlineHealth,
    readUpgradeRuns: async () => {
      let timer;
      try { return await Promise.race([readUpgradeRuns(redis), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Upgrade evidence unavailable'), { code: 'NATIVE_BACKUP_UPGRADE_UNVERIFIED' })), 5000);
      })]); } finally { clearTimeout(timer); }
    },
    close: async () => { redis.disconnect(); await database.disconnectDb(); } };
}

if (process.argv.includes('--hive-native-backup') || process.env.HIVE_NATIVE_BACKUP_REQUEST
  || (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
  let input, deps;
  try {
    const raw = process.env.HIVE_NATIVE_BACKUP_REQUEST ?? readFileSync(0, 'utf8');
    if (Buffer.byteLength(raw) > 4096) fail('NATIVE_BACKUP_REQUEST_INVALID');
    input = backupRequest(JSON.parse(raw));
    deps = await installedDependencies();
    console.log(JSON.stringify(await coordinateNativeBackup(input, deps)));
  } catch (error) {
    console.log(JSON.stringify({ schema: 1, ...(input ?? {}), verified: false,
      error: { code: /^NATIVE_BACKUP_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'NATIVE_BACKUP_COORDINATION_FAILED', held: error?.held ?? 'unknown' } }));
    process.exitCode = 1;
  } finally {
    if (deps) try { await deps.close(); } catch { console.error('Native backup coordinator cleanup requires review'); process.exitCode = 1; }
  }
}
