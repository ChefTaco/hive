import assert from 'node:assert/strict';
import test from 'node:test';
import { mappedLoopbackPort } from './check-managed-install.mjs';

test('accepts the single loopback port assigned by Docker', () => {
  assert.equal(mappedLoopbackPort('127.0.0.1:49152\n'), 49152);
});
test('refuses missing, malformed, public and ambiguous Docker port mappings', () => {
  for (const value of [undefined, '', '0.0.0.0:49152', '192.0.2.1:49152', '127.0.0.1:0',
    '127.0.0.1:65536', '127.0.0.1:49152\n127.0.0.1:49153', '127.0.0.1:49152; command']) {
    assert.throws(() => mappedLoopbackPort(value), /Docker-assigned loopback port/);
  }
});
