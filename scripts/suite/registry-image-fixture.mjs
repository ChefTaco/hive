// Serves hive-registry:candidate from a disposable loopback registry, so developer probe
// fixtures can pin the exact digest a release manifest needs. Nothing is published.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const registryImage = 'registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373';

export async function waitForRegistry(origin, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin + '/v2/', { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))) });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch {
      // A starting registry can reset connections before its HTTP listener is ready.
    }
    await delay(Math.max(1, Math.min(intervalMs, deadline - Date.now())));
  }
  throw new Error('Disposable registry did not become ready before the deadline');
}

export async function startRegistryImage(id, { run = docker, ready = waitForRegistry } = {}) {
  const listener = createServer().listen(0, '127.0.0.1');
  await new Promise((done) => listener.once('listening', done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const name = id + '-image-registry', tag = `127.0.0.1:${port}/${id}/hive-registry:candidate`;
  const user = `${process.getuid()}:${process.getgid()}`;
  let created = false, tagged = false;
  function stop() {
    const failures = [];
    for (const [active, args] of [[created, ['rm', '-f', name]], [tagged, ['image', 'rm', tag]]]) {
      if (!active) continue;
      try { run(...args); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Disposable registry cleanup failed');
    created = tagged = false;
  }
  try {
    run('run', '-d', '--name', name, '--user', user, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', `/var/lib/registry:uid=${process.getuid()},gid=${process.getgid()},mode=700`, '-p', `127.0.0.1:${port}:5000`, registryImage);
    created = true;
    await ready(`http://127.0.0.1:${port}`);
    run('tag', 'hive-registry:candidate', tag);
    tagged = true;
    run('push', tag);
    const image = JSON.parse(run('image', 'inspect', tag, '--format', '{{json .RepoDigests}}')).find((value) => value.startsWith(`127.0.0.1:${port}/`));
    assert(image, 'Pushed registry candidate has no digest');
    return { image, stop };
  } catch (error) {
    try { stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Disposable registry setup and cleanup failed'); }
    throw error;
  }
}
