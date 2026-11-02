#!/usr/bin/env node
// npm publication can finish before all public registry views and tarballs converge.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function waitForPublishedRelease(release, options = {}) {
  const {
    timeoutMs = 600_000,
    intervalMs = 15_000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    report = console.log,
  } = options;
  const deadline = Date.now() + timeoutMs;
  const pending = new Map(Object.entries(release.components));
  let reason = 'registry has not exposed the complete bundle';
  async function request(url, accept) {
    if (Date.now() >= deadline) throw new Error('Registry readiness deadline reached');
    const response = await fetchImpl(url, {
      headers: { accept, 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
    });
    if ([404, 429].includes(response.status) || response.status >= 500) return undefined;
    assert.equal(response.status, 200, 'Public registry request was rejected');
    return response;
  }
  while (pending.size && Date.now() < deadline) {
    for (const [name, version] of pending) {
      const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
      let full, install;
      try {
        full = await request(url, 'application/json');
        install = await request(url, 'application/vnd.npm.install-v1+json');
      } catch (error) {
        if (error.name !== 'TimeoutError' && !(error instanceof TypeError)) throw error;
        reason = `${name}@${version}: registry temporarily unavailable`;
        continue;
      }
      const pkg = full && (await full.json()).versions?.[version];
      const installPkg = install && (await install.json()).versions?.[version];
      if (!pkg || !installPkg) {
        reason = `${name}@${version}: metadata still propagating`;
        continue;
      }
      assert.deepEqual(pkg.hiveRelease, release, `Published release manifest mismatch: ${name}`);
      assert.equal(
        pkg.dist?.integrity,
        installPkg.dist?.integrity,
        'Registry integrity disagreement',
      );
      assert.match(pkg.dist?.integrity || '', /^sha512-/);
      let tarball;
      try {
        tarball = await request(pkg.dist.tarball, 'application/octet-stream');
      } catch (error) {
        if (error.name !== 'TimeoutError' && !(error instanceof TypeError)) throw error;
        reason = `${name}@${version}: tarball temporarily unavailable`;
        continue;
      }
      if (!tarball) {
        reason = `${name}@${version}: tarball still propagating`;
        continue;
      }
      const integrity = `sha512-${createHash('sha512')
        .update(Buffer.from(await tarball.arrayBuffer()))
        .digest('base64')}`;
      assert.equal(integrity, pkg.dist.integrity, `Published tarball integrity mismatch: ${name}`);
      pending.delete(name);
    }
    if (pending.size) {
      report(`Waiting for public npm bundle: ${reason}`);
      await sleep(Math.max(0, Math.min(intervalMs, deadline - Date.now())));
    }
  }
  if (pending.size)
    throw new Error(
      `Public npm bundle did not become ready: ${[...pending].map(([name, version]) => `${name}@${version}`).join(', ')}; ${reason}`,
    );
  report(`Public npm bundle ${release.version} is available with verified integrity`);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const release = JSON.parse(
    readFileSync(new URL('../packages/hive/package.json', import.meta.url), 'utf8'),
  ).hiveRelease;
  await waitForPublishedRelease(release).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
