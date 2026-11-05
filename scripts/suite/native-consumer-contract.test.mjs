import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateConsumerArtifact,
  validateHermesConsumerArtifact,
  requireHermesMessaging,
  consumerModelReply,
} from './native-consumer-contract.mjs';
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

test('optional Hermes consumer requires immutable reviewed public-source provenance', () => {
  const hermes = {
    ...artifact,
    product: 'hermes-agent',
    executable: 'bin/hermes',
    provenance: {
      source: 'https://github.com/NousResearch/hermes-agent',
      revision: 'b'.repeat(40),
      installMode: 'frozen-public-source-no-install-project',
      inference: 'external-only',
    },
  };
  assert.equal(validateHermesConsumerArtifact(hermes, 'amd64'), hermes);
  for (const patch of [
    { source: 'https://example.com/private' },
    { revision: 'floating' },
    { installMode: 'editable' },
    { inference: 'managed' },
  ])
    assert.throws(() =>
      validateHermesConsumerArtifact(
        { ...hermes, provenance: { ...hermes.provenance, ...patch } },
        'amd64',
      ),
    );
});

test('native Chat capability refuses headless Hermes without adding runtime dependencies', () => {
  assert.throws(() => requireHermesMessaging({ provenance: {} }), /--extras messaging/);
  assert.throws(
    () => requireHermesMessaging({ provenance: { extras: ['all'] } }),
    /runtime dependency installs are forbidden/,
  );
  assert.doesNotThrow(() => requireHermesMessaging({ provenance: { extras: ['messaging'] } }));
});
