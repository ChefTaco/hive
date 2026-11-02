import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { candidateRegistry } from './candidate-registry.mjs';

test('candidate registry serves local packages and confines fallback redirects to public npm', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-registry-test-'));
  writeFileSync(join(directory, 'fixture.tgz'), 'synthetic archive');
  const registry = await candidateRegistry(directory, async () => JSON.stringify({ name: '@hivemagnus/fixture', version: '1.2.1' }));
  const get = (path) => new Promise((resolve, reject) => {
    const req = request(registry.registry, { path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const metadata = await get('/@hivemagnus%2Ffixture');
    assert.equal(metadata.status, 200);
    assert.equal(JSON.parse(metadata.body).versions['1.2.1'].dist.tarball, registry.registry + '/artifacts/fixture.tgz');
    assert.equal((await get('/artifacts/fixture.tgz')).body, 'synthetic archive');
    for (const path of ['/zod', '/@types%2Fnode', '/zod/-/zod-4.0.0.tgz?fixture=true', '/%2F%2Fattacker.invalid', '/%0d%0aLocation%3a%20https%3a%2f%2fattacker.invalid']) {
      const response = await get(path);
      assert.equal(response.status, 307, path);
      assert.equal(new URL(response.location).origin, 'https://registry.npmjs.org', path);
    }
    for (const path of ['//attacker.invalid', '/\\attacker.invalid', 'https://attacker.invalid/package', '/%ZZ']) {
      const response = await get(path);
      assert.equal(response.status, 400, path);
      assert.equal(response.location, undefined);
    }
  } finally {
    await registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
