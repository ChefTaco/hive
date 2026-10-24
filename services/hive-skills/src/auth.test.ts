import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChildProcess, spawn } from 'node:child_process';

process.env.HIVE_SKILLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'hive-skills-auth-test-'));
process.env.HIVE_SKILLS_SESSION_SECRET = 'auth-test-session-secret-0123456789abcdef';
const { createOsAuthenticator } = await import('./auth.js');
const { default: app } = await import('./app.js');

test('PAM authentication is asynchronous and rejects work beyond its concurrency bound', async () => {
  const children: EventEmitter[] = [];
  const fakeSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: (value: string) => void } };
    const input = new EventEmitter() as EventEmitter & { end: (value: string) => void };
    input.end = () => {};
    child.stdin = input;
    children.push(child);
    return child as unknown as ChildProcess;
  }) as typeof spawn;
  const authenticate = createOsAuthenticator(fakeSpawn, 4);
  const pending = ['one', 'two', 'three', 'four'].map((username) => authenticate(username, 'secret'));
  assert.equal(children.length, 4);
  assert.equal(await authenticate('five', 'secret'), false);
  let eventLoopAdvanced = false;
  await new Promise<void>((resolve) => setImmediate(() => { eventLoopAdvanced = true; resolve(); }));
  assert.equal(eventLoopAdvanced, true);
  assert.equal((await app.request('https://registry.test/healthz')).status, 200);
  assert.equal((await app.request('https://registry.test/v1/skills')).status, 200);
  children.forEach((child) => child.emit('exit', 0));
  assert.deepEqual(await Promise.all(pending), [true, true, true, true]);
  assert.equal(await authenticate('invalid user', 'secret'), false);
  assert.equal(await authenticate('valid', ''), false);
});
