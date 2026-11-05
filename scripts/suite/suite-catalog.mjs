// The one place a release manifest's product metadata comes from. Releases and developer
// fixtures apply it; the installer copies it from the signed manifest into the registry.
import { readFileSync } from 'node:fs';

export const suiteCatalog = JSON.parse(readFileSync(new URL('./suite-catalog.json', import.meta.url), 'utf8'));

// Non-root, read-only service definition for the release manifest.
export function hiveRegistryComponent(image, user, version = '1.0.0') {
  return {
    image,
    kind: 'application',
    version,
    storageFormat: 'hive-registry-v1',
    catalog: suiteCatalog['hive-registry'],
    service: {
      user,
      networks: ['default'],
      healthcheck: { test: ['CMD', 'node', '/app/dist/cli.js', 'health'], interval: '2s', timeout: '4s', retries: 30, start_period: '2s' },
    },
  };
}

export function applySuiteCatalog(manifest) {
  for (const [name, component] of Object.entries(manifest.components)) {
    component.catalog = suiteCatalog[name] ?? (() => { throw Error('No suite catalog metadata for ' + name); })();
    component.version ??= manifest.version;
  }
  return manifest;
}

// Developer probes are not suite products but still need well-formed catalog metadata.
export function fixtureCatalog(name) {
  return { displayName: name, description: 'Disposable developer fixture', repository: null, documentation: null, license: null, licenseSpdx: null, consoleSection: null, required: false, dependencies: [], connection: { browserPrefix: null, consolePath: null, nativeApis: {}, internalEndpoints: {} } };
}
