import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { installServers } from '../src/runtime.js';
import { recordingOutput, tempHome } from './helpers.js';

function reverseObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjects);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseObjects(child)]),
    );
  return value;
}

test('registry key ordering permits the exact bundle and rejects changed content before installation', async () => {
  const { paths, cleanup } = tempHome();
  const originalSpawn = childProcess.spawn;
  const originalFetch = globalThis.fetch;
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  let tampered = false;
  let installs = 0;
  globalThis.fetch = async (url) => {
    const name = String(url).includes('hive-router') ? '@hivemagnus/hive-router' : pkg.name;
    const metadata = reverseObjects({ ...pkg, name });
    const result = metadata as typeof pkg;
    if (tampered) result.hiveRelease.components['@hivemagnus/hive-router'] = '99.0.0';
    result.dist = { integrity: 'sha512-c3ludGhldGlj' };
    return new Response(
      JSON.stringify(
        String(url).endsWith('%2fhive') ? { versions: { [pkg.version]: result } } : result,
      ),
    );
  };
  childProcess.spawn = (() => {
    installs++;
    const child = new EventEmitter();
    process.nextTick(() => child.emit('close', 42));
    return child;
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  const output = recordingOutput();
  const prompter = { confirm: async () => true, ask: async () => '', close: () => {} };
  try {
    await assert.rejects(
      installServers(paths, ['router'], { output, prompter }),
      /npm install failed \(exit code 42\)/,
    );
    assert.equal(installs, 1, 'equivalent reordered metadata reached the installer');
    tampered = true;
    await assert.rejects(
      installServers(paths, ['router'], { output, prompter }),
      /not compatible with the complete release bundle/,
    );
    assert.equal(installs, 1, 'a changed component pin never reaches the installer');
  } finally {
    globalThis.fetch = originalFetch;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    cleanup();
  }
});
