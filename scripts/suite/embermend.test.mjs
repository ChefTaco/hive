import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addFullComponents, coreRelease, CORE_PRODUCTS, FULL_PRODUCTS } from './release-contracts.mjs';
import { applySuiteCatalog } from './suite-catalog.mjs';
const image = name => `example.com/${name}@sha256:${'a'.repeat(64)}`;
function release(withProduct) {
  const images = Object.fromEntries([...CORE_PRODUCTS, ...FULL_PRODUCTS, ...(withProduct ? ['embermend'] : [])].map(name => [name, image(name)]));
  return applySuiteCatalog(addFullComponents(coreRelease({ version: '2.4.0', images, user: '1000:1000' }), { images, user: '1000:1000' }));
}
test('Embermend is offered only with an explicit runtime image and changes no existing profile', () => {
  assert.equal(release(false).components.embermend, undefined);
  const manifest = release(true);
  assert(!manifest.profiles.core.some(name => name.startsWith('embermend')));
  assert(!manifest.profiles.full.some(name => name.startsWith('embermend')));
  assert.deepEqual(manifest.components.embermend.requiresLocal, ['magnus', 'oathweave', 'hivexui', 'embermend-postgres', 'embermend-worker']);
  assert.equal(manifest.components.embermend.image, manifest.components['embermend-worker'].image);
  assert.deepEqual(manifest.components['embermend-worker'].service.command, ['worker']);
  assert.deepEqual(manifest.components.embermend.initialization.verificationCommand, ['verify-initialization']);
  assert.equal(manifest.networks['embermend-data'].internal, true);
});
test('the product catalog keeps optional security, memory and messaging services optional', () => {
  const catalog = release(true).components.embermend.catalog;
  assert.equal(catalog.connection.browserPrefix, '/api/embermend');
  for (const name of ['cindertrace', 'chattermost', 'hivemem', 'hiveskills']) assert(!catalog.dependencies.includes(name));
  assert(catalog.dependencies.includes('magnus'));
});
