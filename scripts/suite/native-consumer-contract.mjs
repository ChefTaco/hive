import assert from 'node:assert/strict';

export function validateConsumerArtifact(descriptor, architecture) {
  assert.equal(descriptor.product, '@hivemagnus/ardent');
  assert.equal(
    descriptor.published,
    false,
    'Only reviewed local developer artifacts are supported',
  );
  assert.equal(descriptor.architecture, architecture, 'Use the physical host architecture');
  assert(/^[a-f0-9]{64}$/.test(descriptor.sha256));
  assert(/^[A-Za-z0-9._-]+\.tar\.gz$/.test(descriptor.archive));
  assert.equal(descriptor.executable, 'bin/ardent');
  return descriptor;
}

export function consumerModelReply(body, skillText) {
  assert.equal(body.model, 'synthetic-consumer-model');
  assert(Array.isArray(body.messages) && body.messages.length <= 100);
  const result = [...body.messages].reverse().find((message) => message.role === 'tool');
  if (result) {
    assert(
      String(result.content).includes(skillText),
      'Final answer requires exact immutable skill content',
    );
    return { content: 'CONSUMER-SKILL-VERIFIED', tool_calls: [] };
  }
  assert(
    body.tools?.some((tool) => tool.function?.name === 'skill_view'),
    'Native consumer did not advertise the skill tool',
  );
  return {
    content: '',
    tool_calls: [
      {
        id: 'synthetic-consumer-tool',
        type: 'function',
        function: { name: 'skill_view', arguments: JSON.stringify({ name: 'consumer-fixture' }) },
      },
    ],
  };
}

export function validateHermesConsumerArtifact(descriptor, architecture) {
  assert.equal(descriptor.product, 'hermes-agent');
  assert.equal(
    descriptor.published,
    false,
    'Only reviewed local developer artifacts are supported',
  );
  assert.equal(descriptor.architecture, architecture);
  assert(/^[a-f0-9]{64}$/.test(descriptor.sha256));
  assert(/^[A-Za-z0-9._-]+\.tar\.gz$/.test(descriptor.archive));
  assert.equal(descriptor.executable, 'bin/hermes');
  assert.equal(descriptor.provenance?.source, 'https://github.com/NousResearch/hermes-agent');
  assert(/^[a-f0-9]{40}$/.test(descriptor.provenance?.revision));
  assert.equal(descriptor.provenance?.installMode, 'frozen-public-source-no-install-project');
  assert.equal(descriptor.provenance?.inference, 'external-only');
  return descriptor;
}

export function requireHermesMessaging(descriptor) {
  assert.deepEqual(
    descriptor.provenance?.extras,
    ['messaging'],
    'Native Hermes Chat requires a reviewed artifact built with --extras messaging; the headless archive is preserved and runtime dependency installs are forbidden',
  );
}
