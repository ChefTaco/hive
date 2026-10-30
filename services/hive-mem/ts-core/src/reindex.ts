import { existsSync } from 'node:fs';
import { qdrantPersistenceFromEnv } from './persistence.js';
import { semanticConfig, SemanticIndex } from './semantic-index.js';
import { acquireWriterLock } from './writer-lock.js';
const config = semanticConfig();
if (!config) throw new Error('Configure this installation’s embedding model and shadow collection first');
const release = await acquireWriterLock(`${process.env.HIVEMEM_STORAGE_PATH ?? '/var/opt/hivemem'}/writer.lock`);
try {
  const persistence = qdrantPersistenceFromEnv();
  if (!persistence) throw new Error('Qdrant is required');
  if (!process.argv.includes("--apply") && existsSync(`${process.env.HIVEMEM_STORAGE_PATH ?? "/var/opt/hivemem"}/pending-write.json`)) throw new Error("Pending recovery journal: restart Memory to recover before a read-only preview");
  const snapshot = await persistence.load();
  const records = snapshot.memories.filter((memory) => !memory.deleted_at && (!memory.expires_at || Date.parse(memory.expires_at) > Date.now()));
  const index = new SemanticIndex(config);
  console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'preview', collection: config.collection, identity: index.identity, records: records.length }));
  if (process.argv.includes('--apply')) console.log(JSON.stringify(await index.build(records)));
} finally { release(); }
