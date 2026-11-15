import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertUpgradeQuiet, backupRequest, coordinateNativeBackup, readUpgradeRuns } from './native-backup-coordinator.mjs';

const session = '11111111-1111-4111-8111-111111111111';
const barrier = '22222222-2222-4222-8222-222222222222';
const request = action => ({ action, nodeId: 'node-a', nodeFqdn: 'node.example.com', session });
const metadata = () => JSON.stringify({ agentSelfUpgrade: { protocol: 1, enabled: true, layout: 'versioned', upgrade: { state: 'idle' } } });

function fixture() {
  const events = [], calls = [];
  let tail = Promise.resolve();
  const state = { fence: null, counts: { commands: 0, participants: 0, cron: 0, shared: 0, operations: 0 },
    node: { id: 'node-a', hostname: 'node.example.com', status: 'ONLINE', lastHeartbeatAt: new Date('2026-01-01T00:00:00.000Z'), metadata: metadata() },
    enrollment: { state: 'enrolled', nodeFqdn: 'node.example.com', epoch: 1, barrierId: barrier },
    participants: ['agent', 'api', 'dashboard', 'scheduler'].map(participant => ({ participant, status: 'verified', epoch: 1,
      barrierId: barrier, evidenceSha256: 'a'.repeat(64), verifiedAt: new Date('2026-01-01T00:00:00.000Z') })),
    agent: { status: 'RUNNING' }, runs: [], extraFences: 0 };
  const locked = () => assert.deepEqual(events.slice(-2), ['shared-lock', 'node-lock']);
  const count = key => ({ count: async query => { calls.push([key, query]); return state.counts[key]; } });
  const tx = {
    admissionFence: { findUnique: async () => state.fence },
    commandResourceLease: count('commands'), resourceParticipantWork: count('participants'), managedCronOccurrence: count('cron'),
    sharedResourceLease: count('shared'), ardentAgentOperation: count('operations'),
    resourceDrainParticipant: { findMany: async () => state.participants }, agent: { findUnique: async () => state.agent },
  };
  const db = { admissionFence: { count: async () => Number(!!state.fence) + state.extraFences },
    $transaction: async callback => {
      const previous = tail; let unlock;
      tail = new Promise(resolve => { unlock = resolve; });
      await previous;
      try { return await callback(tx); } finally { unlock(); }
    } };
  const lockSharedAdmission = async () => { events.push('shared-lock'); };
  const lockResourceNode = async () => { events.push('node-lock'); };
  const inspectNodeAdmission = async () => ({ nodeId: state.node.id, nodeFqdn: state.node.hostname,
    closed: !!state.fence, releaseId: state.fence?.releaseId ?? null });
  const fence = {
    lockSharedAdmission, inspectNodeAdmission,
    closeNodeAdmission: async (nodeId, nodeFqdn, releaseId) => db.$transaction(async () => {
      await lockSharedAdmission(); await lockResourceNode(); events.push('close');
      if (state.node.id !== nodeId || state.node.hostname !== nodeFqdn || state.fence && state.fence.releaseId !== releaseId)
        throw new Error('fixture foreign owner');
      return state.fence ??= { nodeId, nodeFqdn, releaseId };
    }),
    releaseNodeAdmission: async (nodeId, nodeFqdn, releaseId) => db.$transaction(async () => {
      await lockSharedAdmission(); await lockResourceNode(); events.push('release');
      assert.deepEqual(state.fence, { nodeId, nodeFqdn, releaseId });
      if (Object.values(state.counts).some(count => count !== 0)) throw new Error('fixture late work');
      state.fence = null;
      return { nodeId, nodeFqdn, releaseId, closed: false };
    }),
  };
  const deps = { db, fence, lockResourceNode,
    hasFreshOnlineHealth: (node, now) => node.status === 'ONLINE' && now - node.lastHeartbeatAt.getTime() <= 120_000,
    resourceNodeIdentity: async () => { locked(); events.push('identity'); return { node: state.node, row: state.enrollment }; },
    assertEnrollmentComplete: async () => {
      events.push('enrollment');
      assert.equal(state.enrollment.state, 'enrolled'); assert.equal(state.enrollment.nodeFqdn, state.node.hostname);
    },
    readUpgradeRuns: async () => { events.push('upgrade-read'); return state.runs; },
    now: () => new Date('2026-01-01T00:00:00.000Z') };
  return { state, events, calls, deps,
    admit: async kind => db.$transaction(async () => {
      await lockSharedAdmission(); await lockResourceNode();
      if (state.fence) throw new Error('admission fenced');
      state.counts[kind]++; events.push('admit');
    }) };
}

test('reserves exact node/session before reading authoritative work, then verifies and releases', async () => {
  const f = fixture();
  const reserved = await coordinateNativeBackup(request('reserve'), f.deps);
  assert.deepEqual(reserved, { schema: 1, ...request('reserve'), closed: true, verified: true,
    coverage: 'control-api-node-reservations', sharedAdmissionsClosed: true, independentWritersCovered: false, checkedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(f.events.slice(0, 6), ['shared-lock', 'node-lock', 'close', 'shared-lock', 'node-lock', 'identity']);
  assert.equal((await coordinateNativeBackup(request('verify'), f.deps)).closed, true);
  assert.equal((await coordinateNativeBackup(request('release'), f.deps)).closed, false);
  assert.equal(f.state.fence, null);
  assert.deepEqual(f.calls.slice(0, 5), [
    ['commands', { where: { nodeId: 'node-a', state: { in: ['reserved', 'running', 'unknown'] } } }],
    ['participants', { where: { nodeId: 'node-a', state: { in: ['reserved', 'running', 'unknown'] } } }],
    ['cron', { where: { nodeId: 'node-a', state: { not: 'completed' } } }],
    ['shared', { where: { state: { in: ['reserved', 'running', 'unknown'] } } }],
    ['operations', { where: { nodeId: 'node-a', status: { notIn: ['succeeded', 'failed'] } } }],
  ]);
});

test('a reservation serialized behind an admitted writer sees it; future admissions cannot race past the fence', async () => {
  for (const kind of ['commands', 'participants', 'cron', 'shared']) {
    const f = fixture();
    const admitted = f.admit(kind);
    const reserve = coordinateNativeBackup(request('reserve'), f.deps);
    await admitted;
    await assert.rejects(reserve, { code: 'NATIVE_BACKUP_WORK_UNSETTLED', held: 'yes' });
    await assert.rejects(f.admit(kind), /admission fenced/);
    assert.equal(f.events.includes('release'), false);
    f.state.counts[kind] = 0;
    assert.equal((await coordinateNativeBackup(request('release'), f.deps)).closed, false);
  }
});

test('all held work and unknown deployment rows keep the exact reservation held', async () => {
  for (const kind of ['commands', 'participants', 'cron', 'shared', 'operations']) {
    const f = fixture(); await coordinateNativeBackup(request('reserve'), f.deps);
    f.state.counts[kind] = 1;
    for (const action of ['verify', 'release']) await assert.rejects(coordinateNativeBackup(request(action), f.deps), { code: 'NATIVE_BACKUP_WORK_UNSETTLED', held: 'yes' });
    assert.equal(f.events.includes('release'), false);
  }
});

test('a late writer after verification is rechecked by the owning release, without clearing its evidence', async () => {
  const f = fixture(); await coordinateNativeBackup(request('reserve'), f.deps);
  f.deps.readUpgradeRuns = async () => { f.state.counts.commands = 1; return []; };
  await assert.rejects(coordinateNativeBackup(request('release'), f.deps), { code: 'NATIVE_BACKUP_COORDINATION_FAILED', held: 'yes' });
  assert.equal(f.state.fence.releaseId, session);
  assert.equal(f.state.counts.commands, 1);
});

test('never releases another session and does not adopt a missing or changed target', async () => {
  const f = fixture(); await coordinateNativeBackup(request('reserve'), f.deps);
  for (const action of ['reserve', 'verify', 'release'])
    await assert.rejects(coordinateNativeBackup({ ...request(action), session: barrier }, f.deps));
  assert.equal(f.state.fence.releaseId, session); assert.equal(f.events.includes('release'), false);
  f.state.node.hostname = 'changed.example.com';
  await assert.rejects(coordinateNativeBackup(request('verify'), f.deps));
  assert.equal(f.state.fence.releaseId, session);
  const absent = fixture();
  await assert.rejects(coordinateNativeBackup(request('verify'), absent.deps), { code: 'NATIVE_BACKUP_FENCE_CONFLICT', held: 'no' });
});

test('requires complete authoritative enrollment and all current verified participant evidence', async () => {
  for (const edit of [f => { f.state.enrollment.state = 'draining'; }, f => { f.state.participants.pop(); },
    f => { f.state.participants[0].epoch++; }, f => { f.state.participants[0].barrierId = session; },
    f => { f.state.participants[0].evidenceSha256 = ''; }, f => { f.state.participants[0].verifiedAt = null; },
    f => { f.state.participants[0].status = 'pending'; }]) {
    const f = fixture(); edit(f);
    await assert.rejects(coordinateNativeBackup(request('reserve'), f.deps));
    assert.equal(f.state.fence.releaseId, session);
    // Explicit cleanup can reopen a zero-work fence after enrollment refusal.
    assert.equal((await coordinateNativeBackup(request('release'), f.deps)).closed, false);
  }
});

test('uncertain reads and lost close acknowledgements are sanitized and retain the reservation', async () => {
  const f = fixture(), close = f.deps.fence.closeNodeAdmission;
  f.deps.fence.closeNodeAdmission = async (...args) => { await close(...args); throw new Error('obviously-fake-secret-connection-detail'); };
  await assert.rejects(coordinateNativeBackup(request('reserve'), f.deps), error => {
    assert.equal(error.held, 'yes'); assert.doesNotMatch(error.message, /fake-secret/); return true;
  });
  f.deps.readUpgradeRuns = async () => { throw new Error('obviously-fake-secret-connection-detail'); };
  await assert.rejects(coordinateNativeBackup(request('release'), f.deps), { code: 'NATIVE_BACKUP_COORDINATION_FAILED', held: 'yes' });
  assert.equal(f.events.includes('release'), false);
});

test('release does not claim global shared admission reopened while another node remains fenced', async () => {
  const f = fixture(); await coordinateNativeBackup(request('reserve'), f.deps);
  f.state.extraFences = 1;
  const receipt = await coordinateNativeBackup(request('release'), f.deps);
  assert.equal(receipt.closed, false); assert.equal(receipt.sharedAdmissionsClosed, true);
});

test('freshness is required for a new reservation; exact held-session recovery survives intentional offline quiescence', async () => {
  for (const edit of [f => { f.state.node.status = 'OFFLINE'; }, f => { f.state.node.lastHeartbeatAt = new Date(0); }]) {
    const f = fixture(); edit(f);
    await assert.rejects(coordinateNativeBackup(request('reserve'), f.deps), { code: 'NATIVE_BACKUP_TARGET_INVALID', held: 'yes' });
    assert.equal((await coordinateNativeBackup(request('release'), f.deps)).closed, false);
  }
  const f = fixture(); await coordinateNativeBackup(request('reserve'), f.deps);
  f.state.node.status = 'OFFLINE'; f.state.node.lastHeartbeatAt = new Date(0);
  assert.equal((await coordinateNativeBackup(request('verify'), f.deps)).verified, true);
  assert.equal((await coordinateNativeBackup(request('reserve'), f.deps)).verified, true);
  await assert.rejects(coordinateNativeBackup({ ...request('reserve'), session: barrier }, f.deps));
  assert.equal((await coordinateNativeBackup(request('release'), f.deps)).closed, false);
  for (const status of ['DECOMMISSIONED', 'PROVISIONING', 'ERROR']) {
    const value = fixture(); await coordinateNativeBackup(request('reserve'), value.deps); value.state.node.status = status;
    for (const action of ['reserve', 'verify', 'release']) await assert.rejects(coordinateNativeBackup(request(action), value.deps));
    assert.equal(value.state.fence.releaseId, session);
  }
});

test('upgrade status is strict; running, ambiguous and awaiting-report outcomes cannot become quiet', () => {
  const node = { id: 'node-a', metadata: metadata() };
  assert.doesNotThrow(() => assertUpgradeQuiet(node, { status: 'RUNNING' }, []));
  for (const state of ['staged', 'trial', 'unknown', 'future-state']) {
    const value = JSON.parse(metadata()); value.agentSelfUpgrade.upgrade.state = state;
    assert.throws(() => assertUpgradeQuiet({ ...node, metadata: JSON.stringify(value) }, { status: 'RUNNING' }, []));
  }
  for (const raw of ['{', '{}', '{"agentSelfUpgrade":{}}']) assert.throws(() => assertUpgradeQuiet({ ...node, metadata: raw }, { status: 'RUNNING' }, []));
  assert.throws(() => assertUpgradeQuiet(node, { status: 'UPDATING' }, []));
  for (const change of [run => { run.status = 'running'; }, run => { run.nodes[0].state = 'ambiguous'; }, run => { run.nodes[0].awaitingReport = true; }]) {
    const run = { status: 'interrupted', nodes: [{ nodeId: 'node-a', state: 'failed' }] }; change(run);
    assert.throws(() => assertUpgradeQuiet(node, { status: 'RUNNING' }, [run]));
  }
});

function redisFixture() {
  const id = '33333333-3333-4333-8333-333333333333', calls = [];
  const run = { id, status: 'succeeded', nodes: [{ nodeId: 'node-a', state: 'confirmed' }] };
  const redis = { options: { keyPrefix: 'fixture:' },
    get: async key => { calls.push(key); return key === 'agent-upgrade-run:lock' ? null : JSON.stringify(run); },
    scan: async () => ['0', [`fixture:agent-upgrade-run:${id}`, 'fixture:agent-upgrade-run:latest', `fixture:agent-upgrade-run:${id}:stop`]] };
  return { redis, id, run, calls };
}

test('reads bounded owning Redis upgrade evidence with the configured prefix, without memory fallback or mutation', async () => {
  const f = redisFixture();
  assert.deepEqual(await readUpgradeRuns(f.redis), [f.run]);
  assert.deepEqual(f.calls, ['agent-upgrade-run:lock', `agent-upgrade-run:${f.id}`, 'agent-upgrade-run:lock']);
  for (const edit of [f => { f.redis.get = async () => 'held'; }, f => { f.redis.scan = async () => { throw new Error('unavailable'); }; },
    f => { f.redis.scan = async () => ['0', ['foreign:agent-upgrade-run:' + f.id]]; },
    f => { f.redis.get = async key => key.endsWith(':lock') ? null : null; },
    f => { f.run.id = session; }, f => { f.redis.scan = async () => ['1', []]; }]) {
    const value = redisFixture(); edit(value); await assert.rejects(readUpgradeRuns(value.redis));
  }
  const late = redisFixture(); let locks = 0;
  late.redis.get = async key => key.endsWith(':lock') ? ++locks === 1 ? null : 'new-run' : JSON.stringify(late.run);
  await assert.rejects(readUpgradeRuns(late.redis), { code: 'NATIVE_BACKUP_UPGRADE_UNSETTLED' });
});

test('strict input and eval/stdin entry refuse unsafe requests without exposing request bytes or stack traces', () => {
  assert.deepEqual(backupRequest(request('reserve')), request('reserve'));
  for (const value of [{ ...request('reserve'), extra: true }, { ...request('reserve'), session: 'bad' },
    { ...request('reserve'), nodeId: '../node-a' }, { ...request('reserve'), nodeFqdn: 'node.example.com/evil' }]) assert.throws(() => backupRequest(value));
  const code = readFileSync(new URL('./native-backup-coordinator.mjs', import.meta.url), 'utf8');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, '--', '--hive-native-backup'], {
    encoding: 'utf8', input: JSON.stringify({ ...request('reserve'), secret: 'obviously-fake-private-request' }), env: {},
  });
  assert.equal(result.status, 1); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { schema: 1, verified: false, error: { code: 'NATIVE_BACKUP_REQUEST_INVALID', held: 'unknown' } });
  assert.doesNotMatch(result.stdout, /fake-private-request|at file:/);
});
