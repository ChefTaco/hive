import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFullNodeReview, managedInventoryRequest } from './node-enrollment.mjs';
const fresh = () => ({ freshInstallation: true, initializerSHA256: 'a'.repeat(64),
  owner: { uid: 1001, profileCount: 0, processes: ['systemd', '(sd-pam)', 'dbus-daemon'] },
  ardentScopeActive: false, history: [], unsettled: 0,
  scheduler: { activeCount: 0, unknownCount: 0, managedJobs: [], issues: [], sources: {},
    blockers: [{ identityVersion: 2, kind: 'SYSTEM_TIMER_DEFINITION', sourceSha256: 'b'.repeat(64), count: 1 }] },
  apiProcesses: [{ pid: 1, ppid: 0, name: 'docker-init' }, { pid: 6, ppid: 1, name: 'MainThread' }], gatewayProcesses: null });
test('reviews fresh full nodes with observed OS maintenance left outside Magnus', () => {
  assert.doesNotThrow(() => assertFullNodeReview(fresh()));
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
