import { config } from './config.js';
import { persistArchiveFromFile } from './archive.js';
import { store } from './db.js';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let archive = process.env.HIVEMEM_ARCHIVE;
let generatedArchive: string | undefined;
if (!archive) {
  const source = resolve(process.cwd(), 'registry-sources/hivemem');
  if (!existsSync(resolve(source, 'SKILL.md'))) throw new Error('Set HIVEMEM_ARCHIVE to a HiveMem Hermes skill tar.gz');
  generatedArchive = resolve(config.dataDir, 'hivemem-bundled.tgz');
  const pack = spawnSync('/usr/bin/tar', ['-czf', generatedArchive, '-C', source, '.'], { encoding: 'utf8', timeout: 10_000 });
  if (pack.status !== 0) throw new Error('Could not package the bundled HiveMem skill');
  archive = generatedArchive;
}
if (!store.getSkill('hivemem')) store.createSkill({ slug: 'hivemem', name: 'HiveMem', description: 'Persistent semantic memory tools and provider integration for Hermes Agents.', homepage: 'https://github.com/ChefTaco/hive/tree/main/services/hive-mem', enabled: true });
if (store.getRelease('hivemem', '1.0.0')) throw new Error('hivemem@1.0.0 already exists; releases are immutable');
const persisted = persistArchiveFromFile('hivemem', '1.0.0', archive);
if (generatedArchive) unlinkSync(generatedArchive);
store.addRelease({ skillSlug: 'hivemem', version: '1.0.0', sha256: persisted.sha256, archivePath: persisted.path, notes: 'Initial HiveMem registry release.', createdAt: new Date().toISOString() });
store.audit('system', 'seed', 'hivemem@1.0.0', { source: 'HIVEMEM_ARCHIVE' });
console.log(`Seeded hivemem@1.0.0 (${persisted.sha256}) into ${config.dataDir}`);
