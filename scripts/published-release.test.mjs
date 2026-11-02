import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { waitForPublishedRelease } from './wait-published-release.mjs';

const bytes = Buffer.from('synthetic public npm artifact');
const release = { version: '1.2.0', components: { '@hivemagnus/hive': '1.2.0' } };
const pkg = {
  hiveRelease: release,
  dist: {
    tarball: 'https://registry.npmjs.org/synthetic.tgz',
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  },
};
const response = (status, body) => ({
  status,
  json: async () => body,
  arrayBuffer: async () => body,
});
const options = (fetchImpl) => ({ fetchImpl, intervalMs: 0, report: () => {} });

test('publication waits for the npm install view and the public tarball', async () => {
  let attempt = 0;
  let reads = 0;
  await waitForPublishedRelease(release, {
    ...options(async (url, init) => {
      if (url.endsWith('.tgz')) {
        reads++;
        return response(attempt === 1 ? 404 : 200, bytes);
      }
      const visible = !init.headers.accept.includes('install-v1') || attempt > 0;
      return response(200, { versions: visible ? { '1.2.0': pkg } : {} });
    }),
    sleep: async () => {
      attempt++;
    },
  });
  assert.equal(attempt, 2);
  assert.equal(reads, 2);
});

test('publication fails closed on inconsistent manifests or corrupt tarballs', async () => {
  await assert.rejects(
    waitForPublishedRelease(
      release,
      options(async () =>
        response(200, {
          versions: { '1.2.0': { ...pkg, hiveRelease: { ...release, version: '1.3.0' } } },
        }),
      ),
    ),
    /manifest mismatch/,
  );
  await assert.rejects(
    waitForPublishedRelease(
      release,
      options(async (url) =>
        url.endsWith('.tgz')
          ? response(200, Buffer.from('corrupt'))
          : response(200, { versions: { '1.2.0': pkg } }),
      ),
    ),
    /tarball integrity mismatch/,
  );
});

test('unavailable publication is bounded and names every missing artifact', async () => {
  await assert.rejects(
    waitForPublishedRelease(release, {
      ...options(async () => response(404)),
      timeoutMs: 0,
    }),
    /did not become ready: @hivemagnus\/hive@1\.2\.0/,
  );
});
