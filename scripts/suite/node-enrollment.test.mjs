import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFullNodeReview, managedInventoryRequest, stableServiceProcesses } from './node-enrollment.mjs';
import { assertServiceProcesses as assertArdentServiceProcesses,
  stableServiceProcesses as stableArdentServiceProcesses } from './ardent-enrollment.mjs';
const fresh = () => ({ freshInstallation: true, initializerSHA256: 'a'.repeat(64),
  owner: { uid: 1001, profileCount: 0, processes: ['systemd', '(sd-pam)', 'dbus-daemon'] },
  ardentScopeActive: false, history: [], unsettled: 0,
  scheduler: { activeCount: 0, unknownCount: 0, managedJobs: [], issues: [], sources: {},
    blockers: [{ identityVersion: 2, kind: 'SYSTEM_TIMER_DEFINITION', sourceSha256: 'b'.repeat(64), count: 1 }] },
  apiProcesses: [{ pid: 1, ppid: 0, name: 'docker-init' }, { pid: 6, ppid: 1, name: 'MainThread' }], gatewayProcesses: null });
test('reviews fresh full nodes with observed OS maintenance left outside Magnus', () => {
  assert.doesNotThrow(() => assertFullNodeReview(fresh()));
});
test('leaves only the independently observed exact installer retention source outside Magnus', () => {
  const review = fresh();
  const source = { identityVersion: 2, kind: 'LEGACY_OR_UNSUPPORTED_CRONTAB', sourceSha256: 'c'.repeat(64), count: 1 };
  review.scheduler.blockers.push(source);
  assert.throws(() => assertFullNodeReview(review), /Foreign cron/);
  review.installerSchedulerSources = [{ ...source }];
  assert.doesNotThrow(() => assertFullNodeReview(review));
  for (const patch of [
    r => r.scheduler.blockers[1].count++,
    r => r.scheduler.blockers[1].identityVersion = 1,
    r => r.scheduler.blockers[1].sourceSha256 = 'd'.repeat(64),
    r => r.scheduler.blockers.push({ ...source, sourceSha256: 'e'.repeat(64) }),
    r => r.scheduler.blockers.push({ ...source }),
    r => r.scheduler.blockers.pop(),
    r => r.installerSchedulerSources[0].count++,
    r => r.installerSchedulerSources[0].kind = 'NATIVE_HERMES_SCHEDULES',
    r => r.installerSchedulerSources.push({ ...source }),
  ]) {
    const unsafe = structuredClone(review); patch(unsafe);
    assert.throws(() => assertFullNodeReview(unsafe));
  }
});
test('reviews both released Node main-thread names for the API and gateway without allowing other descendants', () => {
  for (const apiName of ['MainThread', 'node-MainThread']) {
    for (const gatewayName of ['MainThread', 'node-MainThread']) {
      const review = fresh();
      review.apiProcesses[1].name = apiName;
      review.gatewayProcesses = [{ pid: 201, ppid: 200, name: 'docker-init' },
        { pid: 206, ppid: 201, name: gatewayName }];
      assert.doesNotThrow(() => assertFullNodeReview(review));
      assert.doesNotThrow(() => assertArdentServiceProcesses(review.apiProcesses));
      assert.doesNotThrow(() => assertArdentServiceProcesses(review.gatewayProcesses));
      for (const participant of ['apiProcesses', 'gatewayProcesses']) {
        for (const patch of [
          rows => rows[1].name = 'node',
          rows => rows[1].name = 'node-MainThread-extra',
          rows => rows[0].name = 'MainThread',
          rows => rows[1].ppid++,
          rows => rows[1].pid = rows[0].pid,
          rows => rows[0].pid = 0,
          rows => rows[1].pid = '206',
          rows => rows.push({ pid: 207, ppid: rows[1].pid, name: 'sh' }),
        ]) {
          const unsafe = structuredClone(review); patch(unsafe[participant]);
          assert.throws(() => assertFullNodeReview(unsafe));
          assert.throws(() => assertArdentServiceProcesses(unsafe[participant]));
        }
      }
    }
  }
});
test('read-only process sampling waits for exited health checks and requires two matching strict inventories', async () => {
  for (const collect of [stableServiceProcesses, stableArdentServiceProcesses]) {
    const clean = fresh().apiProcesses;
    const busy = [...clean, { pid: 7, ppid: 0, name: 'node-MainThread' }];
    const samples = [busy, clean, busy, clean, clean];
    let reads = 0; let waits = 0;
    assert.deepEqual(await collect(async () => samples[reads++], async () => { waits++; }), clean);
    assert.equal(reads, 5); assert.equal(waits, 4);
    for (const sample of [busy, [{ ...clean[0] }, { ...clean[1], ppid: 0 }]]) {
      reads = 0; waits = 0;
      await assert.rejects(collect(async () => { reads++; return sample; }, async () => { waits++; }), /pause unrelated work and retry/);
      assert.equal(reads, 24); assert.equal(waits, 23);
    }
    reads = 0;
    await assert.rejects(collect(async () => [{ ...clean[0] }, { ...clean[1], pid: 100 + reads++ }], async () => {}), /keep changing/);
    assert.equal(reads, 24);
  }
});
test('permits reviewed Ardent continuation without removing its completed history or profiles', () => {
  const review = fresh(); review.ardentScopeActive = true; review.owner.profileCount = 1;
  review.history = [{ commandStatus: 'COMPLETED', state: 'released', completionClass: 'native-http',
    completionDescriptorId: 'ardent-action', settlement: 'signed-command-result' }];
  assert.doesNotThrow(() => assertFullNodeReview(review));
  review.ardentScopeActive = false; assert.throws(() => assertFullNodeReview(review), /prior reviewed/);
});
test('holds live, unknown, unowned or unrelated historical work for independent review', () => {
  for (const patch of [r => r.unsettled++, r => r.owner.processes.push('node'), r => r.owner.uid = 0,
    r => r.freshInstallation = false, r => r.initializerSHA256 = 'invalid', r => r.history.push({ state: 'unknown' }),
    r => r.apiProcesses.push({ pid: 7, ppid: 6, name: 'ssh' })]) {
    const review = fresh(); patch(review); assert.throws(() => assertFullNodeReview(review));
  }
});
test('never approves incomplete discovery, foreign cron, native schedulers or uncertain managed jobs', () => {
  for (const patch of [r => r.scheduler.issues.push('UNKNOWN_SOURCE'), r => r.scheduler.activeCount++,
    r => r.scheduler.unknownCount++, r => r.scheduler.managedJobs.push({ enabled: false }),
    r => r.scheduler.blockers[0].identityVersion = 1]) {
    const review = fresh(); patch(review); assert.throws(() => assertFullNodeReview(review));
  }
  for (const kind of ['LEGACY_OR_UNSUPPORTED_CRONTAB', 'NATIVE_HERMES_SCHEDULES', 'NATIVE_HERMES_UNSETTLED_CLAIMS', 'NATIVE_AT_QUEUE', 'UNRECOGNIZED']) {
    const review = fresh(); review.scheduler.blockers[0].kind = kind; assert.throws(() => assertFullNodeReview(review));
  }
});
test('reads the managed inventory with the shared node secret before Magnus 3, and signed for the node with node keys only', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push(['fetch', url, init.headers, init.redirect]); return 'plain'; };
  const agentFetch = async (target, url, init) => { calls.push(['signed', url, target, init.headers, init.redirect]); return 'signed'; };
  assert.equal(await managedInventoryRequest('https://node-1.example.com:4100', 'node-1', false, { agentFetch, nodeSecret: () => 'obviously-fake-node-token', fetch }), 'plain');
  assert.equal(await managedInventoryRequest('https://node-1.example.com:4100', 'node-1', true, { agentFetch, nodeSecret: () => assert.fail('the shared secret was read'), fetch }), 'signed');
  assert.deepEqual(calls, [
    ['fetch', 'https://node-1.example.com:4100/api/v1/cron/managed-inventory', { 'x-node-token': 'obviously-fake-node-token' }, 'error'],
    ['signed', 'https://node-1.example.com:4100/api/v1/cron/managed-inventory', { nodeId: 'node-1' }, undefined, 'error'],
  ]);
});
