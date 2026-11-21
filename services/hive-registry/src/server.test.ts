import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

const work = mkdtempSync(join(tmpdir(), 'hive-registry-server-'));
after(() => rmSync(work, { recursive: true, force: true }));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ready) => probe.listen(0, '127.0.0.1', ready));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

it('logs only the bound port and two flags at startup, never configuration or credentials', async () => {
  const config = join(work, 'config');
  const data = join(work, 'data');
  mkdirSync(config, { mode: 0o700 });
  mkdirSync(data, { mode: 0o700 });
  const readToken = 'r'.repeat(40);
  const writeToken = 'w'.repeat(40);
  writeFileSync(join(config, 'read-token'), readToken, { mode: 0o600 });
  writeFileSync(join(config, 'write-token'), writeToken, { mode: 0o600 });
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('./server.js', import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? '', HIVE_REGISTRY_INSTALLATION: 'fixture', HIVE_REGISTRY_DATA_DIR: data, HIVE_REGISTRY_HOST: '127.0.0.1',
      HIVE_REGISTRY_PORT: String(port), HIVE_REGISTRY_READ_TOKEN_FILE: join(config, 'read-token'),
      HIVE_REGISTRY_WRITE_TOKEN_FILE: join(config, 'write-token'), HIVE_REGISTRY_IDENTITY_FILE: join(config, 'identity.json'), HIVE_AUTO_MIGRATE: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (bytes: Buffer) => { output += bytes.toString(); });
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no startup line: ${output}`)), 15_000);
    child.stdout.on('data', (bytes: Buffer) => {
      output += bytes.toString();
      const first = output.split('\n').find((candidate) => candidate.includes('hive-registry listening'));
      if (first) { clearTimeout(timer); resolve(first); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${output}`)); });
  });
  const exited = new Promise<number | null>((done) => child.once('exit', done));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.deepEqual(JSON.parse(line), { message: 'hive-registry listening', port, readOnly: false, inventorySignIn: false });
  for (const secret of [readToken, writeToken, config, data]) assert.equal(output.includes(secret), false);
});
