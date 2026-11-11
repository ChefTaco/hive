import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollCoordinatorStatus } from './coordinator-poll.mjs';
const options = { attempts: 3, intervalMs: 0, delay: async () => {} };
test('observes a committed outcome after a lost status reply without dispatching work again', async () => {
  let reads = 0, dispatches = 0;
  const effect = () => { dispatches++; };
  effect();
  const result = await pollCoordinatorStatus(async () => {
    if (++reads === 1) throw Object.assign(new Error('lost read'), { code: 'ECONNRESET' });
    return reads === 2 ? { busy: true, state: 'upgrading' } : { busy: false, state: 'completed' };
  }, state => !state.busy && state.state === 'completed', options);
  assert.equal(result.state, 'completed'); assert.equal(reads, 3); assert.equal(dispatches, 1);
});
test('retains a finite failure when the coordinator stays unavailable', async () => {
  let reads = 0;
  await assert.rejects(pollCoordinatorStatus(async () => {
    reads++; throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
  }, () => true, options), /last read: ECONNREFUSED/);
  assert.equal(reads, 3);
});
test('does not turn a busy or earlier failed outcome into successful completion', async () => {
  await assert.rejects(pollCoordinatorStatus(async () => ({ busy: false, state: 'failed' }),
    state => state.state === 'completed', options), /"state":"failed"/);
});
test('propagates semantic assertions and non-transport errors immediately', async () => {
  let reads = 0;
  await assert.rejects(pollCoordinatorStatus(async () => { reads++; return { state: 'failed' }; },
    state => { assert.equal(state.state, 'completed'); return true; }, options), { code: 'ERR_ASSERTION' });
  assert.equal(reads, 1);
  for (const code of ['EACCES', 'EPERM', 'ERR_INVALID_RESPONSE']) {
    reads = 0;
    await assert.rejects(pollCoordinatorStatus(async () => {
      reads++; throw Object.assign(new Error('invalid status'), { code });
    }, () => true, options), { code });
    assert.equal(reads, 1);
  }
});
