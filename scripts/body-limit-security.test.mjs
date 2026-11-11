import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// Exercise each installed copy: a passing lockfile alone does not prove the
// middleware handling requests has the tiny-chunk memory exhaustion fix.
for (const workspace of [
  'services/hive-router',
  'services/hive-iam/apps/iam-core',
  'services/hive-skills',
]) {
  test(`${workspace}: chunked bodies have bounded buffering and preserve the limit`, async () => {
    const require = createRequire(resolve(workspace, 'package.json'));
    const { Hono } = await import(pathToFileURL(require.resolve('hono')));
    const { bodyLimit } = await import(pathToFileURL(require.resolve('hono/body-limit')));
    const maxSize = 65536;
    const app = new Hono();
    app.use('*', bodyLimit({ maxSize }));
    let handled = 0;
    app.post('/', async (c) => {
      handled++;
      const reader = c.req.raw.body.getReader();
      let chunks = 0, bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks++;
        bytes += value.byteLength;
        assert(value.every((byte) => byte === 97), 'Request bytes survive aggregation');
      }
      return c.json({ chunks, bytes });
    });
    const request = (length, headers = {}) => {
      let sent = 0;
      return new Request('http://example.com/', {
        method: 'POST',
        headers: { 'transfer-encoding': 'chunked', ...headers },
        duplex: 'half',
        body: new ReadableStream({
          pull(controller) {
            if (sent++ === length) controller.close();
            else controller.enqueue(new Uint8Array([97]));
          },
        }),
      });
    };
    for (const length of [maxSize - 1, maxSize]) {
      const response = await app.request(request(length));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { chunks: 1, bytes: length });
    }
    assert.equal((await app.request(request(maxSize + 1))).status, 413);
    assert.equal((await app.request(request(maxSize + 1, { 'content-length': '1' }))).status, 413);
    assert.equal(handled, 2, 'Rejected bodies never reach the handler');
  });
}
