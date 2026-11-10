#!/usr/bin/env node
// Real compatibility checks for candidate runtime images. All state is disposable.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { node: { type: 'string' }, redis: { type: 'string' }, qdrant: { type: 'string' }, 'redis-from': { type: 'string' }, 'qdrant-from': { type: 'string' } } });
assert(values.node && values.redis && values.qdrant, '--node, --redis and --qdrant image references are required');
const prefix = 'hive-runtime-' + randomUUID();
const containers = new Set(), volumes = new Set();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const stop = name => { docker('rm', '-f', name); containers.delete(name); };
function start(suffix, args) { const name = prefix + '-' + suffix; containers.add(name); docker('run', '-d', '--name', name, ...args); return name; }
function volume(suffix) { const name = prefix + '-' + suffix; volumes.add(name); docker('volume', 'create', name); return name; }
async function ready(fn) {
  const end = Date.now() + 30000; let last;
  while (Date.now() < end) { try { return await fn(); } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 100)); } }
  throw last;
}
try {
  // This is the exact flock interface used for HiveMem single-writer protection.
  const script = `const {spawn,execFileSync}=require('node:child_process');
    const fs=require('node:fs');fs.writeFileSync('/tmp/state','fixture');
    execFileSync('flock',['--version']);
    const child=spawn('flock',['--exclusive','--nonblock','/tmp/writer.lock','sh','-c','printf ready; cat >/dev/null'],{stdio:['pipe','pipe','inherit']});
    child.stdout.once('data',()=>{try{execFileSync('flock',['--exclusive','--nonblock','/tmp/writer.lock','true']);process.exitCode=1;}catch{fs.writeFileSync('/tmp/locked','yes');}child.stdin.end();});
    child.once('exit',code=>{if(code!==0||!fs.existsSync('/tmp/locked'))process.exit(1);execFileSync('flock',['--exclusive','--nonblock','/tmp/writer.lock','true']);console.log('writer exclusion and release verified');});`;
  assert.match(docker('run', '--rm', '--read-only', '--tmpfs', '/tmp:uid=1000,gid=1000,mode=700', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '1000:1000', '--entrypoint', 'node', values.node, '-e', script), /writer exclusion and release verified/);
  assert.match(docker('run', '--rm', '--user', '1000:1000', '--entrypoint', 'openssl', values.node, 'version'), /OpenSSL/);
  console.log('PASS node: non-root read-only startup, OpenSSL and real flock exclusion/release');

  const redisVolume = volume('redis');
  docker('run', '--rm', '--user', '0', '--entrypoint', 'sh', '--mount', 'type=volume,source=' + redisVolume + ',target=/data,volume-nocopy', values.redis, '-c', 'chown 1000:1000 /data');
  const redisArgs = image => ['--read-only', '--tmpfs', '/tmp', '--user', '1000:1000', '--cap-drop', 'ALL', '--mount', 'type=volume,source=' + redisVolume + ',target=/data,volume-nocopy', image, 'redis-server', '--appendonly', 'yes'];
  let redis = start('redis', redisArgs(values['redis-from'] ?? values.redis));
  await ready(() => assert.equal(docker('exec', redis, 'redis-cli', 'PING'), 'PONG'));
  assert.equal(docker('exec', redis, 'redis-cli', 'SET', 'runtime-proof', 'synthetic-value'), 'OK');
  assert.equal(docker('exec', redis, 'redis-cli', 'SAVE'), 'OK');
  docker('stop', '--time', '10', redis); stop(redis);
  redis = start('redis-restored', redisArgs(values.redis));
  await ready(() => assert.equal(docker('exec', redis, 'redis-cli', 'GET', 'runtime-proof'), 'synthetic-value'));
  stop(redis);
  console.log('PASS redis: non-root AOF/RDB write, graceful stop and persisted restart');

  const qdrantVolume = volume('qdrant');
  docker('run', '--rm', '--user', '0', '--entrypoint', 'sh', '--mount', 'type=volume,source=' + qdrantVolume + ',target=/qdrant/storage,volume-nocopy', values.qdrant, '-c', 'chown 1000:1000 /qdrant/storage');
  const qdrantArgs = image => ['--read-only', '--tmpfs', '/tmp', '--user', '1000:1000', '--cap-drop', 'ALL', '--mount', 'type=volume,source=' + qdrantVolume + ',target=/qdrant/storage,volume-nocopy', '-e', 'QDRANT__STORAGE__SNAPSHOTS_PATH=/qdrant/storage/snapshots', '-p', '127.0.0.1::6333', image];
  let qdrant = start('qdrant', qdrantArgs(values['qdrant-from'] ?? values.qdrant));
  const endpoint = name => 'http://' + docker('port', name, '6333/tcp');
  async function request(name, path, body) { const response = await fetch(endpoint(name) + path, { ...(body === undefined ? {} : { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) }); assert(response.ok, `${path}: ${response.status}`); return response.json(); }
  await ready(() => request(qdrant, '/collections'));
  await request(qdrant, '/collections/runtime-proof', { vectors: { size: 2, distance: 'Cosine' } });
  await request(qdrant, '/collections/runtime-proof/points?wait=true', { points: [{ id: 1, vector: [1, 0], payload: { marker: 'synthetic-value' } }] });
  docker('stop', '--time', '10', qdrant); stop(qdrant);
  qdrant = start('qdrant-restored', qdrantArgs(values.qdrant));
  const result = await ready(() => request(qdrant, '/collections/runtime-proof/points/1'));
  assert.equal(result.result.payload.marker, 'synthetic-value');
  stop(qdrant);
  console.log('PASS qdrant: unchanged binary, non-root writes, graceful stop and persisted restart');
} catch (error) {
  for (const name of containers) { const logs = spawnSync('docker', ['logs', '--tail', '40', name], { encoding: 'utf8', timeout: 10000 }); console.error(name, logs.stdout, logs.stderr); }
  throw error;
} finally {
  for (const name of containers) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30000 });
  for (const name of volumes) spawnSync('docker', ['volume', 'rm', name], { stdio: 'ignore', timeout: 30000 });
}
