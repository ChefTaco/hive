// Developer acceptance of the Hive Registry on a real installation. It compares what the
// registry records with what the hosts actually run, and proves the ingress boundary.
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';

const privateFields = /inventoryHost|internalEndpoints|imageDigest|storageFormat|manifestDigest|planDigest|installedAt|"version"|"versions"|sha256:|-postgres|-redis|-qdrant/;

export function registryCall({ port, ca }) {
  return (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const request = https.request({ hostname: 'localhost', port, path, method, ca, headers, timeout: 8000 }, (response) => {
      let text = '';
      response.on('data', (chunk) => (text += chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(Error('Registry request timeout')));
    request.end(body);
  });
}

export const hostStatuses = (text) => text.split(/(?<=^\})\n(?=^\{)/m).map((document) => JSON.parse(document));
const registryStatus = (text) => hostStatuses(text).find((document) => document.registry).registry;

function credentials(directory) {
  const read = (name) => readFileSync(join(directory, 'config/hive-registry', name), 'utf8').trim();
  return { read: read('read-token'), write: read('write-token') };
}

// The registry's installed state must equal the running containers on every host.
export function assertRecordedState({ list, summary, addresses, config, manifest, docker }) {
  const products = Object.fromEntries(list.products.map((product) => [product.id, product]));
  const placed = Object.entries(config.components);
  assert.deepEqual(list.products.filter((product) => product.installation?.status === 'installed' && product.source === 'release').map((product) => product.id).sort(), placed.map(([name]) => name).sort(), 'Registry installed set differs from the configuration');
  for (const [name, placement] of placed) {
    const product = products[name], compose = join(addresses[placement.host], 'compose.json');
    const definition = JSON.parse(readFileSync(compose, 'utf8')).services[name];
    assert(definition, 'Recorded product has no deployed service: ' + name);
    const container = JSON.parse(docker('inspect', docker('compose', '-f', compose, 'ps', '-q', name)))[0];
    assert.equal(container.State.Status, 'running', name);
    assert.equal(product.installation.inventoryHost, placement.host, name);
    assert.equal(product.installation.image, container.Config.Image, name + ' digest differs from the running container');
    assert.equal(product.installation.imageDigest, container.Config.Image.split('@')[1], name);
    assert.equal(product.installation.image, manifest.components[name].image, name + ' digest differs from the signed release');
    assert.equal(product.installation.version, manifest.components[name].version ?? manifest.version, name);
    assert.equal(product.installation.release, manifest.version, name);
    assert(product.installation.installedAt, name);
  }
  for (const [name, component] of Object.entries(manifest.components)) {
    const product = products[name];
    assert(product, 'Catalog is missing an offered product: ' + name);
    assert.equal(product.offered, true);
    assert.equal(product.displayName, component.catalog.displayName);
    assert.equal(product.links.documentation, component.catalog.documentation);
    assert.equal(product.required, component.catalog.required);
    assert(product.versions.some((version) => version.image === component.image && version.storageFormat === (component.storageFormat ?? null)), 'Catalog version differs: ' + name);
  }
  assert.equal(summary.release.version, manifest.version);
  assert.equal(summary.phase, 'complete');
  assert.deepEqual(summary.hosts, [...new Set(placed.map(([, placement]) => placement.host))].sort());
}

async function assertIngressBoundary({ call, directory, config, product }) {
  const { read, write } = credentials(directory);
  const ready = await call('GET', '/api/registry/health/ready');
  assert.equal(ready.status, 200);
  const summary = await call('GET', '/api/registry/v1/installation', { Cookie: 'hive_router_admin=obviously-fake' });
  assert.equal(summary.status, 200);
  assert.deepEqual(Object.keys(summary.json()).sort(), ['id', 'products', 'schema']);
  assert.equal(summary.json().id, config.installation);
  assert.equal(summary.headers['set-cookie'], undefined);
  const list = await call('GET', '/api/registry/v1/products?installed=true');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json().products.map((item) => item.id).sort(), summary.json().products.toSorted());
  const connection = await call('GET', `/api/registry/v1/products/${product}/connection`);
  assert.equal(connection.status, 200);
  for (const response of [summary, list, connection, await call('GET', `/api/registry/v1/products/${product}`)]) assert.doesNotMatch(response.text, privateFields);
  for (const host of Object.keys(config.hosts)) assert(!list.text.includes('"' + host + '"') || Object.keys(config.components).includes(host), 'Inventory host name reached the public view');
  assert.equal((await call('GET', '/api/registry/v1/products/oathweave-redis')).status, 404, 'A datastore reached the public view');
  // A read credential reaches private fields; history and health internals stay private.
  const detail = await call('GET', `/api/registry/v1/products/${product}`, { Authorization: 'Bearer ' + read });
  assert.equal(detail.status, 200);
  assert.equal(detail.json().installation.status, 'installed');
  assert.equal((await call('GET', '/api/registry/v1/products', { Authorization: 'Bearer wrong-credential' })).status, 401);
  assert.equal((await call('GET', '/api/registry/v1/products', { Authorization: 'Basic d3Jvbmc6d3Jvbmc=' })).status, 401);
  assert.equal((await call('GET', '/api/registry/v1/history', { Authorization: 'Bearer ' + read })).status, 404, 'History passed the ingress');
  // Writes never pass the ingress, even with the real write credential.
  const before = (await call('GET', '/api/registry/v1/installation', { Authorization: 'Bearer ' + read })).json().revision;
  for (const [method, path] of [['POST', '/api/registry/v1/sync'], ['PUT', '/api/registry/v1/products/forbidden'], ['DELETE', '/api/registry/v1/products/' + product], ['PATCH', '/api/registry/v1/products/' + product], ['HEAD', '/api/registry/v1/products'], ['OPTIONS', '/api/registry/v1/products']]) {
    const response = await call(method, path, { Authorization: 'Bearer ' + write, 'Content-Type': 'application/json' }, ['POST', 'PUT', 'PATCH'].includes(method) ? JSON.stringify({ displayName: 'Forbidden' }) : undefined);
    assert.equal(response.status, 405, method + ' ' + path);
  }
  for (const path of ['/api/registry/v1/sync', '/api/registry/v1/unknown', '/api/registry/v2/products', '/api/registry/health/live', '/api/registry/v1/products/%2e%2e/sync', '/api/registry/v1//products', '/api/registry/']) assert.equal((await call('GET', path)).status, 404, path);
  assert.equal((await call('GET', '/api/registry/v1/installation', { Authorization: 'Bearer ' + read })).json().revision, before, 'A refused request changed the registry');
}

// Everything that needs the registry to agree with reality, on the live installation.
export async function proveRegistry({ hive, output, addresses, config, manifest, docker, call, product = 'emberpath' }) {
  const parse = async (...args) => JSON.parse(await hive('registry', ...args));
  const consoleDirectory = addresses[config.components['hive-registry'].host];
  assertRecordedState({ list: await parse('list'), summary: await parse('summary'), addresses, config, manifest, docker });
  await assertIngressBoundary({ call, directory: consoleDirectory, config, product });
  assert.equal(registryStatus(await hive('status')).state, 'in-sync');
  assert.match(await hive('doctor'), /Hive Registry: in sync/);

  // The installer's credential file is protected and the write API is idempotent.
  for (const name of ['read-token', 'write-token']) assert.equal(statSync(join(consoleDirectory, 'config/hive-registry', name)).mode & 0o077, 0);
  const historyBefore = (await parse('history')).entries.length;
  const entry = join(output, 'registry-external.json');
  writeFileSync(entry, JSON.stringify({ displayName: 'External provider', description: 'Externally managed fixture', links: { documentation: 'https://models.example.com/docs' }, connection: { nativeApis: { model: 'https://models.example.com/v1' }, internalEndpoints: { admin: 'https://models.internal.example.com:9443' } } }));
  chmodSync(entry, 0o600);
  assert((JSON.parse(await hive('registry', 'add', 'external-provider', '--file', entry))).changes > 0);
  assert.equal(JSON.parse(await hive('registry', 'add', 'external-provider', '--file', entry)).changes, 0, 'Repeated registry add changed the registry');
  assert.equal((await parse('history')).entries.length, historyBefore + 2);
  assert.equal((await parse('connection', 'external-provider')).internalEndpoints.admin, 'https://models.internal.example.com:9443');
  assert.equal((await call('GET', '/api/registry/v1/products/external-provider')).status, 404, 'A private external product reached the public view');
  const external = registryStatus(await hive('status'));
  assert.equal(external.state, 'in-sync');
  assert.deepEqual(external.externallyManaged, ['external-provider']);
  writeFileSync(entry, JSON.stringify({ displayName: 'External provider', connection: { nativeApis: { model: 'https://models.example.com/v1' } }, apiKey: 'obviously-fake' }));
  await assert.rejects(hive('registry', 'update', 'external-provider', '--file', entry), 'The write API accepted a credential');
  await hive('registry', 'remove', 'external-provider');

  // Real drift is reported by status and refused by doctor, then clears.
  const host = config.components[product].host, compose = join(addresses[host], 'compose.json');
  docker('compose', '-f', compose, 'stop', '--timeout', '20', product);
  const drift = registryStatus(await hive('status'));
  assert.equal(drift.state, 'drift');
  assert(drift.drift.some((item) => item.code === 'not-running' && item.detail.includes(product)), 'A stopped product was not reported as drift');
  await assert.rejects(hive('doctor'), 'Doctor passed with a stopped product');
  docker('compose', '-f', compose, 'up', '-d', '--wait', '--wait-timeout', '120', product);
  assert.equal(registryStatus(await hive('status')).state, 'in-sync');
}

// After hive.sh rehearse: the restored copy holds the same records and stays read-only.
export function proveRestoredRegistry({ directory, archive, live, docker }) {
  const isolated = join(directory, 'rehearsals', archive, 'isolated.json');
  const definition = JSON.parse(readFileSync(isolated, 'utf8'));
  assert.equal(definition.services['hive-registry'].volumes.find((mount) => mount.target === '/data').read_only, true);
  assert.equal(definition.services['hive-registry'].environment.HIVE_REHEARSAL, 'true');
  const database = join(directory, 'rehearsals', archive, 'data/hive-registry/registry.sqlite');
  const sealed = () => { const info = statSync(database); return [info.size, info.mtimeMs]; };
  const before = sealed();
  docker('compose', '-f', isolated, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'hive-registry');
  try {
    const client = (...args) => docker('compose', '-f', isolated, 'exec', '-T', 'hive-registry', 'node', '/app/dist/cli.js', 'request', ...args);
    const restored = JSON.parse(client('GET', '/v1/products', 'read'));
    const installed = (list) => list.products.filter((item) => item.installation).map((item) => [item.id, item.installation.imageDigest, item.installation.inventoryHost]);
    assert.deepEqual(installed(restored), installed(live), 'Restored registry differs from the backed-up records');
    assert.throws(() => client('DELETE', '/v1/products/any-product', 'write'), 'A restored registry accepted a write');
  } finally {
    docker('compose', '-f', isolated, 'stop', '--timeout', '20', 'hive-registry');
  }
  assert.deepEqual(sealed(), before, 'A rehearsal changed restored registry data');
}
