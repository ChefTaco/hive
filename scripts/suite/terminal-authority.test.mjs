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
test('with node keys only, the preflight sends no shared secret and needs Magnus node authentication on both routes', async () => {
  const calls = [];
  const magnus = { status: 401, headers: new Headers({ 'x-magnus-server-time': '1700000000000' }) };
  await verifyTerminalAuthorityRoutes('https://hive.example.com:4100/', '', async (url, options) => {
    calls.push(url);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-node-token'], undefined);
    assert.equal(options.body, '{}');
    return magnus;
  }, { nodeKeysOnly: true });
  assert.deepEqual(calls, ['https://hive.example.com:4100/api/v1/resource-leases/enrollment/terminal-claim',
    'https://hive.example.com:4100/api/v1/resource-leases/enrollment/terminal-receipt']);
  // The ingress's own 404, a refusal without Magnus's server time, or anything else is not Magnus's route.
  for (const response of [{ status: 404, headers: new Headers() }, { status: 401, headers: new Headers() }, { status: 400, headers: magnus.headers }, { status: 200, headers: magnus.headers }]) {
    await assert.rejects(verifyTerminalAuthorityRoutes('https://hive.example.com:4100', '', async () => response, { nodeKeysOnly: true }), /repair the native ingress/);
  }
});
