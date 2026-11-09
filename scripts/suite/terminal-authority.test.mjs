import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyTerminalAuthorityRoutes } from './terminal-authority.mjs';

test('terminal preflight uses the node credential and invalid bodies on both exact machine routes', async () => {
  const calls = [];
  await verifyTerminalAuthorityRoutes('https://hive.example.com:4100/', 'obviously-fake-node-token', async (url, options) => {
    calls.push(url);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-node-token'], 'obviously-fake-node-token');
    assert.equal(options.body, '{}'); assert(options.signal instanceof AbortSignal);
    return { status: calls.length === 1 ? 400 : 422 };
  });
  assert.deepEqual(calls, ['https://hive.example.com:4100/api/v1/resource-leases/enrollment/terminal-claim',
    'https://hive.example.com:4100/api/v1/resource-leases/enrollment/terminal-receipt']);
});
test('missing routes, credentials, unexpected success and transport failures refuse enrollment without leaking diagnostics', async () => {
  for (const status of [200, 401, 403, 404, 500]) {
    await assert.rejects(verifyTerminalAuthorityRoutes('https://hive.example.com:4100', 'obviously-fake-node-token', async () => ({ status })), /repair the native ingress/);
  }
  await assert.rejects(verifyTerminalAuthorityRoutes('https://hive.example.com:4100', 'obviously-fake-node-token', async () => { throw Error('private diagnostic must stay private'); }), error => !error.message.includes('private diagnostic') && /repair the native ingress/.test(error.message));
  let called = false;
  await assert.rejects(verifyTerminalAuthorityRoutes('http://hive.example.com:4100', 'obviously-fake-node-token', async () => { called = true; }));
  await assert.rejects(verifyTerminalAuthorityRoutes('https://hive.example.com:4100', '', async () => { called = true; }));
  assert.equal(called, false);
});
