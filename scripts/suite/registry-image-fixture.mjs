// Serves hive-registry:candidate from a disposable loopback registry, so developer probe
// fixtures can pin the exact digest a release manifest needs. Nothing is published.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const registryImage = 'registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373';

export async function startRegistryImage(id) {
  const listener = createServer().listen(0, '127.0.0.1');
  await new Promise((done) => listener.once('listening', done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const name = id + '-image-registry', tag = `127.0.0.1:${port}/${id}/hive-registry:candidate`;
  const user = `${process.getuid()}:${process.getgid()}`;
  docker('run', '-d', '--name', name, '--user', user, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', `/var/lib/registry:uid=${process.getuid()},gid=${process.getgid()},mode=700`, '-p', `127.0.0.1:${port}:5000`, registryImage);
  docker('tag', 'hive-registry:candidate', tag);
  docker('push', tag);
  const image = JSON.parse(docker('image', 'inspect', tag, '--format', '{{json .RepoDigests}}')).find((value) => value.startsWith(`127.0.0.1:${port}/`));
  assert(image, 'Pushed registry candidate has no digest');
  return { image, stop() { for (const args of [['rm', '-f', name], ['image', 'rm', tag]]) try { docker(...args); } catch {} } };
}
