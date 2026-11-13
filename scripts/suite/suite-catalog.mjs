// The one place a release manifest's product metadata comes from. Releases and developer
// fixtures apply it; the installer copies it from the signed manifest into the registry.
import { readFileSync } from 'node:fs';

export const suiteCatalog = JSON.parse(readFileSync(new URL('./suite-catalog.json', import.meta.url), 'utf8'));

// Optional product capabilities, such as {"events.v1": {"path": "/hive/events", "since": "2.8.0"}}.
// `path` is relative to the product's browserPrefix as the browser sees it, before the ingress maps
// the prefix to the product's native path (see suite-catalog.test.mjs). A capability reaches a manifest only when the
// pinned product version is at least `since`; `"since": null` declares the path for a product
// version that is not released yet, and is never emitted. Manifests carry only `path`.
const capabilityName = /^[a-z0-9.-]{1,64}$/;
const localPath = /^\/[A-Za-z0-9._~/-]*$/;
const versionPattern = /^\d+(\.\d+)*$/;

// Dotted numeric versions, compared part by part; a missing part counts as 0.
export function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function checkCapabilities(name, entry) {
  const capabilities = entry.capabilities;
  if (capabilities === undefined) return;
  const fail = (message) => { throw Error(`Suite catalog ${name}: ${message}`); };
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) fail('capabilities must be an object');
  if (!entry.connection?.browserPrefix) fail('capabilities need a browserPrefix');
  for (const [key, capability] of Object.entries(capabilities)) {
    if (!capabilityName.test(key)) fail(`invalid capability name ${key}`);
    if (!capability || typeof capability !== 'object' || Object.keys(capability).some((field) => !['path', 'since'].includes(field))) fail(`${key} has only path and since`);
    if (typeof capability.path !== 'string' || !localPath.test(capability.path) || capability.path.length > 256 || capability.path.split('/').includes('..')) fail(`${key} needs a local path`);
    if (capability.since !== null && !(typeof capability.since === 'string' && versionPattern.test(capability.since))) fail(`${key} since must be a version or null`);
  }
}
for (const [name, entry] of Object.entries(suiteCatalog)) checkCapabilities(name, entry);

// The catalog metadata of one product at one pinned version, as a manifest carries it.
export function catalogFor(name, version) {
  const source = suiteCatalog[name] ?? (() => { throw Error('No suite catalog metadata for ' + name); })();
  const { capabilities, ...entry } = source;
  if (!capabilities) return entry;
  const offered = Object.entries(capabilities).filter(([, capability]) => {
    if (capability.since === null) return false;
    if (typeof version !== 'string' || !versionPattern.test(version)) throw Error(`Suite catalog ${name}: version ${version} cannot be compared with since`);
    return compareVersions(version, capability.since) >= 0;
  });
  return offered.length ? { ...entry, capabilities: Object.fromEntries(offered.map(([key, { path }]) => [key, { path }])) } : entry;
}

// Non-root, read-only service definition for the release manifest.
export function hiveRegistryComponent(image, user, version = '1.0.0') {
  return {
    image,
    kind: 'application',
    version,
    storageFormat: 'hive-registry-v1',
    catalog: catalogFor('hive-registry', version),
    service: {
      user,
      networks: ['default'],
      healthcheck: { test: ['CMD', 'node', '/app/dist/cli.js', 'health'], interval: '2s', timeout: '4s', retries: 30, start_period: '2s' },
    },
  };
}

export function applySuiteCatalog(manifest) {
  for (const [name, component] of Object.entries(manifest.components)) {
    component.catalog = catalogFor(name, component.version ?? manifest.version);
    component.version ??= manifest.version;
  }
  return manifest;
}

// Developer probes are not suite products but still need well-formed catalog metadata.
export function fixtureCatalog(name) {
  return { displayName: name, description: 'Disposable developer fixture', repository: null, documentation: null, license: null, licenseSpdx: null, consoleSection: null, required: false, dependencies: [], connection: { browserPrefix: null, consolePath: null, nativeApis: {}, internalEndpoints: {} } };
}
