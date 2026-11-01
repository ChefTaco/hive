import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** After publication CI must still exercise an upgrade. Use a synthetic patch
 * version of the exact working-tree bytes; never edit tracked manifests. */
export async function candidateArtifacts(work, packs, candidate, published, run) {
  const a = candidate.version.split('.').map(Number),
    b = published.split('.').map(Number);
  if (a[0] !== b[0])
    throw new Error('The npm release and working tree must belong to the same supported major');
  if (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])) return candidate;
  const version = `${b[0]}.${b[1]}.${b[2] + 1}`;
  let result;
  const staging = join(work, 'synthetic-candidate');
  mkdirSync(staging);
  for (const file of readdirSync(packs).filter((f) => f.endsWith('.tgz'))) {
    const dir = join(staging, file);
    mkdirSync(dir);
    await run('tar', ['-xf', join(packs, file), '-C', dir]);
    const path = join(dir, 'package/package.json'),
      pkg = JSON.parse(readFileSync(path, 'utf8'));
    if (!pkg.hiveRelease) continue;
    pkg.version = version;
    pkg.hiveRelease.version = version;
    pkg.hiveRelease.notesUrl = `https://github.com/ChefTaco/hive/releases/tag/v${version}`;
    for (const name of Object.keys(pkg.hiveRelease.components))
      pkg.hiveRelease.components[name] = version;
    writeFileSync(path, JSON.stringify(pkg, null, 2));
    await run('tar', [
      '-czf',
      join(packs, `${pkg.name.replace('@', '').replace('/', '-')}-${version}.tgz`),
      '-C',
      dir,
      'package',
    ]);
    rmSync(join(packs, file));
    if (pkg.name === candidate.name) result = pkg;
  }
  if (!result) throw new Error('Synthetic candidate omits the launcher');
  return result;
}
