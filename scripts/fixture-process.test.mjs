import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { stopFixtureProcess } from './fixture-process.mjs';

async function fixture(stubborn) {
  const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{${stubborn ? '' : 'process.exit(0)'}}); console.log('ready'); setInterval(()=>{},1000)`], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data');
  return child;
}

test('a graceful fixture can stop and be stopped again without an exit-event race', async () => {
  const child = await fixture(false);
  try {
    await stopFixtureProcess(child, { timeoutMs: 1000, group: process.platform !== 'win32' });
    assert.equal(child.exitCode, 0);
    await stopFixtureProcess(child);
  } finally { child.kill('SIGKILL'); }
});

test('a stubborn fixture is killed within a bound and fails rather than passing absence', async () => {
  const child = await fixture(true);
  try {
    await assert.rejects(stopFixtureProcess(child, { timeoutMs: 100, group: process.platform !== 'win32' }), /did not stop gracefully/);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally { child.kill('SIGKILL'); }
});
