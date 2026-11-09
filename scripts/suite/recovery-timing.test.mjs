import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoveryTiming } from './recovery-timing.mjs';

test('timing retains completed, failed and cleanup phases without recording error output', () => {
  let clock = 100;
  const emitted = [], timing = recoveryTiming({ now: () => clock, emit: (row) => emitted.push(row) });
  timing.begin('setup'); clock += 1500; timing.begin('restore'); clock += 2500;
  timing.end('failed'); timing.begin('cleanup'); clock += 500; timing.end(); timing.end();
  assert.deepEqual(emitted, [
    { name: 'setup', seconds: 1.5, result: 'passed' },
    { name: 'restore', seconds: 2.5, result: 'failed' },
    { name: 'cleanup', seconds: 0.5, result: 'passed' },
  ]);
  assert.equal(timing.elapsed(), 4.5);
  assert.deepEqual(timing.phases, emitted);
});
