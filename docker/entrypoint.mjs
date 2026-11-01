import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const name = process.env.HIVE_PACKAGE;
const components = {
  '@hivemagnus/hive-iam-server': 'iam',
  '@hivemagnus/hive-router': 'router',
  '@hivemagnus/hivemem-server': 'memory',
  '@hivemagnus/hive-skills': 'skills',
};
const service = components[name];
if (!service) throw new Error('Unknown Hive image component');
const root = resolve('/app/node_modules', name);
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const runtime = await import(
  pathToFileURL(
    resolve(
      root,
      service === 'iam' || service === 'skills'
        ? 'dist/release/runtime.js'
        : 'dist/src/release/runtime.js',
    ),
  )
);
const command = process.argv[2] || 'start';
if (command === 'start') {
  // PID 1 must explicitly handle termination while no server signal handlers
  // exist yet. A gated process has opened no datastore and can exit immediately.
  const stopGate = () => process.exit(0);
  process.once('SIGTERM', stopGate);
  process.once('SIGINT', stopGate);
  await runtime.composeAdmission(service, manifest.version);
  process.removeListener('SIGTERM', stopGate);
  process.removeListener('SIGINT', stopGate);
}
const bin = Object.values(manifest.bin)[0];
process.argv = [process.execPath, resolve(root, bin), ...process.argv.slice(2)];
await import(pathToFileURL(resolve(root, bin)));
