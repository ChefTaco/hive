import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConsumerArtifact, consumerModelReply } from './native-consumer-contract.mjs';
const artifact = {
  product: '@hivemagnus/ardent',
  published: false,
  architecture: 'amd64',
  sha256: 'a'.repeat(64),
  archive: 'ardent-1.0.0-linux-amd64.tar.gz',
  executable: 'bin/ardent',
};
test('native consumer fixture rejects foreign, published, traversal and wrong-architecture artifacts', () => {
  assert.equal(validateConsumerArtifact(artifact, 'amd64'), artifact);
  for (const patch of [
    { product: 'other' },
    { published: true },
    { archive: '../archive.tar.gz' },
    { executable: '../../bin/ardent' },
    { sha256: 'incomplete' },
    { architecture: 'arm64' },
  ])
    assert.throws(() => validateConsumerArtifact({ ...artifact, ...patch }, 'amd64'));
});
test('synthetic model requires a real advertised tool then exact skill content before answering', () => {
  const base = {
    model: 'synthetic-consumer-model',
    messages: [{ role: 'user', content: 'Read skill' }],
    tools: [{ function: { name: 'skill_view' } }],
  };
  assert.equal(
    consumerModelReply(base, 'immutable-marker').tool_calls[0].function.name,
    'skill_view',
  );
  assert.throws(() => consumerModelReply({ ...base, tools: [] }, 'immutable-marker'));
  assert.throws(() =>
    consumerModelReply(
      { ...base, messages: [{ role: 'tool', content: 'invented' }] },
      'immutable-marker',
    ),
  );
  assert.equal(
    consumerModelReply(
      { ...base, messages: [{ role: 'tool', content: '{"content":"immutable-marker"}' }] },
      'immutable-marker',
    ).content,
    'CONSUMER-SKILL-VERIFIED',
  );
});
