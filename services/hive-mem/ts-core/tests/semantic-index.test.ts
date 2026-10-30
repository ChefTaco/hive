import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticConfig, SemanticIndex } from '../src/semantic-index.js';
test('requires explicit model identity and refuses malformed embedding vectors', async () => {
  assert.equal(semanticConfig({}), null);
  assert.throws(() => semanticConfig({ HIVEMEM_EMBEDDING_ENDPOINT: 'http://localhost:1' }), /Explicit/);
  const config = { endpoint: 'http://localhost/embeddings', model: 'fixture', revision: '1', dimensions: 2, collection: 'hivemem_shadow_fixture', qdrantUrl: 'http://localhost:6333' };
  const wrong = new SemanticIndex(config, async () => Response.json({ model: 'fixture', data: [{ embedding: [1] }] }));
  await assert.rejects(wrong.embed(['fixture']), /dimension/);
  const index = new SemanticIndex(config, async () => Response.json({ model: 'fixture', data: [{ embedding: [0, 1] }] }));
  assert.deepEqual(await index.embed(['fixture']), [[0, 1]]);
  assert.notEqual(index.identity, new SemanticIndex({ ...config, revision: '2' }).identity);
});
