#!/usr/bin/env node
// Builds the suite release manifest releases/VERSION.json from releases/VERSION.inputs.json
// (the product image tags and versions of one suite release) and the reviewed service
// contracts in scripts/suite/release-contracts.mjs. Developer tool: the installer
// (hive.sh) needs no Node.
//
//   node scripts/release/build-suite-manifest.mjs --version X.Y.Z
//       Resolves every published image tag to its multi-architecture index digest and
//       writes releases/X.Y.Z.json. Private images need `docker login ghcr.io` first.
//   node scripts/release/build-suite-manifest.mjs --version X.Y.Z --check
//       Offline: rebuilds from the digests already pinned in releases/X.Y.Z.json and
//       fails unless the file is byte-identical, so no hand edit can hide in it.
//   --inputs FILE, --output FILE and --pinned FILE (a {component: image@digest} map used
//   instead of resolving tags) exist for tests.
//
// Signing is a separate, offline step (see docs/RELEASING.md).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { addFullComponents, coreRelease, CORE_PRODUCTS, DATASTORE_IMAGES, DATASTORE_VERSIONS, FULL_PRODUCTS, OPTIONAL_PRODUCTS, datastoreProfileReferences, datastoreProfileComponent, applyDatastoreProfile } from '../suite/release-contracts.mjs';
import { applySuiteCatalog } from '../suite/suite-catalog.mjs';

const root = resolve(import.meta.dirname, '../..');
const { values: args } = parseArgs({ options: { version: { type: 'string' }, check: { type: 'boolean', default: false }, 'resolve-tags': { type: 'boolean', default: false }, inputs: { type: 'string' }, output: { type: 'string' }, pinned: { type: 'string' } } });
assert(/^\d+\.\d+\.\d+$/.test(args.version ?? ''), '--version X.Y.Z is required');
const version = args.version;
const inputsFile = args.inputs ? resolve(args.inputs) : join(root, 'releases', version + '.inputs.json');
const manifestFile = args.output ? resolve(args.output) : join(root, 'releases', version + '.json');
const inputs = JSON.parse(readFileSync(inputsFile, 'utf8'));
assert.equal(inputs.schema, 1, 'Unsupported inputs schema');
assert.equal(inputs.version, version, 'Inputs describe a different suite version');
assert.match(inputs.user, /^[1-9][0-9]*:[1-9][0-9]*$/, 'Inputs need a non-root service owner uid:gid');
const products = inputs.products;
assert.deepEqual(Object.keys(products).filter((name) => !OPTIONAL_PRODUCTS.includes(name)).sort(), [...CORE_PRODUCTS, ...FULL_PRODUCTS].sort(), 'Inputs must name exactly the suite product images, and optionally ' + OPTIONAL_PRODUCTS.join(', '));
for (const [name, product] of Object.entries(products)) {
  assert.match(product.image, /^ghcr\.io\/[a-z0-9-]+\/[a-z0-9-]+:\d+\.\d+\.\d+$/, name + ': image must be an exact version tag');
  assert(product.version === undefined || /^\d+\.\d+\.\d+$/.test(product.version), name + ': invalid product version');
  assert(Array.isArray(product.platforms) && product.platforms.includes('linux/amd64'), name + ': platforms must include linux/amd64');
}
const datastoreReferences = datastoreProfileReferences(inputs.datastoreProfile);
const references = { ...products, ...datastoreReferences };
const repository = (reference) => reference.replace(/[:@].*$/, '');
if (products.embermend) {
  const parts = (products.magnus.version ?? '').split('.').map(Number);
  assert(parts.length === 3 && (parts[0] > 2 || parts[0] === 2 && parts[1] >= 5), 'Embermend requires the Magnus 2.5 managed remediation bridge or newer');
  assert.equal(products.magnus.embermendProtocol, 1, 'Embermend requires an explicitly reviewed Magnus embermendProtocol 1 release');
}
// The Magnus agent package hive.sh magnus-agent installs: Magnus's own version, with the npm
// tarball integrity reviewed into the inputs. Publishing checks it against the registry.
const magnusAgent = inputs.magnusAgent;
if (magnusAgent !== undefined) {
  assert.deepEqual(Object.keys(magnusAgent).sort(), ['integrity', 'name', 'version'], 'magnusAgent has name, version and integrity');
  assert.equal(magnusAgent.name, '@hivemagnus/magnus-agent', 'magnusAgent.name must be @hivemagnus/magnus-agent');
  assert.equal(magnusAgent.version, products.magnus.version, 'magnusAgent.version must be the Magnus version');
  assert.match(magnusAgent.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, 'magnusAgent.integrity must be an npm sha512 integrity');
}

// Index digest of a published tag, checked against the platforms the inputs promise.
function buildx(...command) {
  for (const program of [['docker', 'buildx'], [process.env.DOCKER_BUILDX ?? '/usr/libexec/docker/cli-plugins/docker-buildx']]) {
    try { return execFileSync(program[0], [...program.slice(1), ...command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { if (program.length === 1) throw error; }
  }
}
function resolveTag(name, { image, platforms }) {
  const index = JSON.parse(buildx('imagetools', 'inspect', image, '--format', '{{json .Manifest}}'));
  assert(/^sha256:[a-f0-9]{64}$/.test(index.digest), name + ': no index digest');
  const published = (index.manifests ?? []).filter((entry) => entry.platform?.os === 'linux').map((entry) => 'linux/' + entry.platform.architecture).sort();
  for (const platform of platforms) assert(published.includes(platform), `${name}: ${image} has no ${platform} image`);
  return repository(image) + '@' + index.digest;
}

let pinned;
if (args.check) {
  assert(existsSync(manifestFile), 'Nothing to check: ' + manifestFile);
  const current = JSON.parse(readFileSync(manifestFile, 'utf8'));
  pinned = Object.fromEntries(Object.entries(references).map(([name, product]) => {
    const component = name === 'chat-migrator' ? current.components.chattermost?.initialization : current.components[name.startsWith('datastore:') ? datastoreProfileComponent(name) : name];
    assert(component?.image, name + ': missing from the manifest');
    assert.equal(repository(component.image), repository(product.image), name + ': image repository differs from the inputs');
    return [name, component.image];
  }));
} else if (args.pinned) {
  pinned = JSON.parse(readFileSync(resolve(args.pinned), 'utf8'));
  for (const [name, product] of Object.entries(references)) assert.equal(repository(pinned[name] ?? ''), repository(product.image), name + ': pinned image differs from the inputs');
} else {
  pinned = Object.fromEntries(Object.entries(references).map(([name, product]) => [name, resolveTag(name, product)]));
}
for (const [name, image] of Object.entries(pinned)) assert.match(image, /^[a-z0-9./-]+@sha256:[a-f0-9]{64}$/, name + ': not pinned by digest');

if (args['resolve-tags']) {
  for (const [name, reference] of Object.entries(references)) assert.equal(pinned[name], resolveTag(name, reference), name + ': published tag differs from the signed digest');
}

// The controller that installs this release. A different controller cannot use it.
const runtimeFiles = execFileSync('bash', ['-c', 'source scripts/suite/controller.sh; hive_runtime_files'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...runtimeFiles], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(dirty, '', 'Commit the controller runtime before pinning its digest:\n' + dirty);
const controllerSHA256 = execFileSync('bash', ['-c', 'source scripts/suite/controller.sh; hive_controller_digest'], { cwd: root, encoding: 'utf8', env: { ...process.env, HIVE_ROOT: root } }).trim();
assert.match(controllerSHA256, /^[a-f0-9]{64}$/);

const manifest = coreRelease({ version, images: pinned, user: inputs.user, registryVersion: products['hive-registry'].version });
addFullComponents(manifest, { images: pinned, user: inputs.user });
applyDatastoreProfile(manifest, inputs.datastoreProfile, pinned);
manifest.controllerSHA256 = controllerSHA256;
// Each component records the version of what it runs; applySuiteCatalog falls back to the suite version.
for (const [name, product] of Object.entries(products)) if (product.version && manifest.components[name]) manifest.components[name].version = product.version;
if (products.embermend?.version) manifest.components['embermend-worker'].version = products.embermend.version;
if (products.embermend) manifest.components.magnus.embermendProtocol = products.magnus.embermendProtocol;
const datastoreVersion = { [DATASTORE_IMAGES.redis]: DATASTORE_VERSIONS.redis, [DATASTORE_IMAGES.qdrant]: DATASTORE_VERSIONS.qdrant, [DATASTORE_IMAGES.postgres17]: DATASTORE_VERSIONS.postgres17, [DATASTORE_IMAGES.postgres18]: DATASTORE_VERSIONS.postgres18 };
for (const [name, spec] of Object.entries(datastoreReferences)) datastoreVersion[pinned[name]] = spec.version;
for (const component of Object.values(manifest.components)) if (component.kind === 'datastore') component.version = datastoreVersion[component.image] ?? assert.fail('Unreviewed datastore image ' + component.image);
if (magnusAgent) {
  if (!args.check && !args.pinned) {
    const published = execFileSync('npm', ['view', `${magnusAgent.name}@${magnusAgent.version}`, 'dist.integrity'], { encoding: 'utf8' }).trim();
    assert.equal(published, magnusAgent.integrity, `${magnusAgent.name}@${magnusAgent.version}: the registry integrity differs from the inputs`);
  }
  manifest.components.magnus.agentPackage = { ...magnusAgent };
}
applySuiteCatalog(manifest);
const document = JSON.stringify(manifest, null, 2) + '\n';

if (args.check) {
  assert.equal(readFileSync(manifestFile, 'utf8'), document, manifestFile + ' differs from the reviewed contracts and its pinned digests');
  console.log(`releases/${version}.json matches the reviewed contracts (controller ${controllerSHA256})`);
} else {
  writeFileSync(manifestFile, document);
  console.log(`Wrote ${manifestFile} (controller ${controllerSHA256})`);
  for (const [name, image] of Object.entries(pinned)) console.log(`  ${name.padEnd(15)} ${image}`);
}
