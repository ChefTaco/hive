#!/usr/bin/env node
// Bundle the private runtime into each package; public packages have no dependency on this workspace.
import { createRequire } from 'node:module';
import { mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'packages/hive-release/package.json'));
const { build } = require('esbuild');
const workspace = join(root, 'packages/hive-release');
const targets = [
  'packages/hive',
  'services/hive-router',
  'services/hive-iam/apps/iam-core',
  'services/hive-mem/ts-core',
  'services/hive-skills',
];
const selected = process.argv[2] ? [process.argv[2]] : targets;
if (selected.some((p) => !targets.includes(p))) throw new Error('Unknown release runtime target');
if (process.argv.includes('--copy')) {
  for (const target of selected) {
    const out = join(
      root,
      target,
      target.includes('iam-core') || target.includes('hive-skills')
        ? 'dist/release'
        : 'dist/src/release',
    );
    mkdirSync(out, { recursive: true });
    copyFileSync(join(root, target, 'src/release/runtime.js'), join(out, 'runtime.js'));
    copyFileSync(join(workspace, 'node_modules/zod/LICENSE'), join(out, 'ZOD_LICENSE'));
  }
} else {
  const result = spawnSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '-p',
      join(workspace, 'tsconfig.json'),
      '--emitDeclarationOnly',
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status || 1);
  for (const target of selected) {
    const out = join(root, target, 'src/release');
    mkdirSync(out, { recursive: true });
    await build({
      entryPoints: [join(workspace, 'src/index.ts')],
      outfile: join(out, 'runtime.js'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      sourcemap: false,
      ...(/hive-router|iam-core/.test(target)
        ? { alias: { 'node:sqlite': join(workspace, 'src/sqlite-native.ts') } }
        : {}),
    });
    for (const file of readdirSync(join(workspace, 'dist')).filter((f) => f.endsWith('.d.ts')))
      copyFileSync(
        join(workspace, 'dist', file),
        join(out, file === 'index.d.ts' ? 'runtime.d.ts' : file),
      );
  }
}
