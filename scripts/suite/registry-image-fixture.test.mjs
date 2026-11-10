import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { waitForRegistry, startRegistryImage } from './registry-image-fixture.mjs';

async function fixture(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
test('registry admission waits for a successful API response after connection resets and startup failures', async t => {
  let calls = 0;
  const origin = await fixture(t, (request, response) => {
    assert.equal(request.url, '/v2/');
    calls++;
    if (calls === 1) request.socket.destroy();
    else response.writeHead(calls < 3 ? 503 : 200).end('{}');
  });
  await waitForRegistry(origin, { timeoutMs: 2000, intervalMs: 5 });
  assert(calls >= 3);
});
test('an unhealthy registry reaches a bounded failure instead of admitting an image push', async t => {
  const origin = await fixture(t, (_, response) => response.writeHead(503).end());
  await assert.rejects(waitForRegistry(origin, { timeoutMs: 50, intervalMs: 5 }), /before the deadline/);
});

test('failed setup removes its created registry and never pushes an image', async () => {
  const commands = [];
  await assert.rejects(startRegistryImage('fixture-registry-failure', {
    run: (...args) => { commands.push(args); return 'fixture-container'; },
    ready: async () => { throw new Error('fixture admission failure'); },
  }), /fixture admission failure/);
  assert.deepEqual(commands.map(args => args[0]), ['run', 'rm']);
  assert.deepEqual(commands[1], ['rm', '-f', 'fixture-registry-failure-image-registry']);
});
test('failure to create a registry never removes an existing container', async () => {
  const commands = [];
  await assert.rejects(startRegistryImage('fixture-existing-registry', {
    run: (...args) => { commands.push(args); throw new Error('fixture creation refused'); },
  }), /fixture creation refused/);
  assert.deepEqual(commands.map(args => args[0]), ['run']);
});
