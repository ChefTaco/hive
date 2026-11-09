import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { observeRecoveryClient } from './recovery-client.mjs';
const fixture = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), exitCode: null });

test('readiness requires a complete successful sample at or after the requested boundary', async () => {
  const child = fixture(), client = observeRecoveryClient(child, { timeoutMs: 100 });
  child.stdout.write('{"at":1,"ms":2,"ok":true}\n');
  await client.observed();
  let ready = false;
  const pending = client.observed(10).then(() => { ready = true; });
  child.stdout.write('{"at":11,"ms":2,"ok":false}\n{"at":12,');
  await Promise.resolve(); assert.equal(ready, false);
  child.stdout.write('"ms":2,"ok":true}\n'); await pending;
  assert.equal(client.samples.length, 3);
});

test('missing, invalid, exited and failed clients cannot produce vacuous passing evidence', async () => {
  for (const action of [child => child.emit('exit', 0), child => child.emit('error', Error('spawn failed')), child => child.stdout.write('{bad}\n'), child => child.stdout.write('{"at":"bad","ms":0,"ok":true}\n')]) {
    const child = fixture(), client = observeRecoveryClient(child, { timeoutMs: 20 });
    const pending = assert.rejects(client.observed()); action(child); await pending;
  }
  await assert.rejects(observeRecoveryClient(fixture(), { timeoutMs: 5 }).observed(), /timed out/);
});
