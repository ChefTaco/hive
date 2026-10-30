import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage' || entry === '.git' || entry === '.venv') continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, files);
    else if (SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) files.push(path);
  }
  return files;
}

function relativeFiles(dir: string): Array<{ path: string; text: string }> {
  return walk(join(ROOT, dir)).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));
}

describe('architecture boundaries', () => {
  it('keeps every Router database connection on the same SQLite library as Prisma', () => {
    const offenders = relativeFiles('services/hive-router/src')
      .filter((file) => /(?:from\s*|import\s*\()(['"])(?:node:)?sqlite\1/.test(file.text))
      .map((file) => file.path);
    assert.deepEqual(offenders, [], 'Mixing SQLite libraries can bypass same-process file locks');
  });
  it('keeps the UI behind API and contract boundaries', () => {
    const offenders = relativeFiles('services/hive-router/ui/src')
      .filter((file) => /from ['"](\.\.\/){3,}|from ['"].*services\/hive-|from ['"].*src\/storage|from ['"].*src\/admin|from ['"].*src\/api/.test(file.text))
      .map((file) => file.path);

    assert.deepEqual(offenders, []);
  });

  it('keeps Node-only health probes out of the UI bundle', () => {
    const offenders = relativeFiles('services/hive-router/ui/src')
      .filter((file) => /from ['"]@contracts\/service-health(?:\.js)?['"]/.test(file.text))
      .map((file) => file.path);

    assert.deepEqual(offenders, [], 'Import @contracts/service-health-schemas instead');
  });

  it('keeps active services from importing sibling service internals', () => {
    const serviceDirs = ['services/hive-router/src', 'services/hive-iam/apps/iam-core/src', 'services/hive-mem/ts-core/src'];
    const offenders = serviceDirs.flatMap((dir) => relativeFiles(dir)
      .filter((file) => /from ['"].*services\/hive-|from ['"].*\.\.\/\.\.\/\.\.\/hive-/.test(file.text))
      .map((file) => file.path));

    assert.deepEqual(offenders, []);
  });

  it('keeps removed legacy Python out of the active TypeScript memory core', () => {
    const offenders = relativeFiles('services/hive-mem/ts-core/src')
      .filter((file) => file.text.includes('legacy-python') || file.text.includes('hivemem/legacy'))
      .map((file) => file.path);

    assert.deepEqual(offenders, []);
  });
});
