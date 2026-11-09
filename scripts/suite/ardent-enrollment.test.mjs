import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFreshArdentReview } from './ardent-enrollment.mjs';

const fresh = () => ({ freshInstallation: true, initializerSHA256: 'a'.repeat(64),
  owner: { username: 'operator', uid: 1001, profileCount: 0, processes: ['systemd', '(sd-pam)', 'dbus-daemon'] },
  counts: { commands: 0, leases: 0, participantWork: 0, schedulerDefinitions: 0 },
  apiProcesses: [{ pid: 1, ppid: 0, name: 'docker-init' }, { pid: 6, ppid: 1, name: 'MainThread' }],
  gatewayProcesses: null });

test('permits only the empty, freshly initialized node and its idle native owner', () => {
  assert.doesNotThrow(() => assertFreshArdentReview(fresh()));
  const review = fresh(); review.gatewayProcesses = review.apiProcesses;
  assert.doesNotThrow(() => assertFreshArdentReview(review));
});
test('refuses every kind of existing command and participant history', () => {
  for (const key of Object.keys(fresh().counts)) {
    const review = fresh(); review.counts[key] = 1;
    assert.throws(() => assertFreshArdentReview(review), /independent review/);
  }
  const review = fresh(); review.counts = {};
  assert.throws(() => assertFreshArdentReview(review), /independent review/);
});
test('refuses old profiles, root ownership, running native work and missing initializer evidence', () => {
  for (const change of [r => r.owner.profileCount++, r => r.owner.uid = 0,
    r => r.owner.processes.push('node'), r => r.freshInstallation = false, r => r.initializerSHA256 = '']) {
    const review = fresh(); change(review);
    assert.throws(() => assertFreshArdentReview(review));
  }
});
test('refuses API or gateway descendants, unknown processes and inconsistent process trees', () => {
  for (const key of ['apiProcesses', 'gatewayProcesses']) {
    const review = fresh(); review[key] = [...review.apiProcesses, { pid: 7, ppid: 6, name: 'ssh' }];
    assert.throws(() => assertFreshArdentReview(review), /independent review/);
    review[key] = [{ pid: 1, ppid: 0, name: 'docker-init' }, { pid: 6, ppid: 9, name: 'MainThread' }];
    assert.throws(() => assertFreshArdentReview(review));
  }
});
