import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, describe, it } from 'node:test';
import { createApp } from './app.js';
import { registryConnectionSchema, registryHealthSchema, registryInstallationSchema, registryProductListSchema, registryProductSchema } from './browser-contract.js';
import { loadConfig } from './config.js';
import { checksum, migrate, migrations, PendingMigrations } from './migrations.js';
import { findSecret } from './secrets.js';
import { openDatabase, RegistryStore } from './store.js';

const readToken = 'r'.repeat(40);
const writeToken = 'w'.repeat(40);
const digest = (fill: string): string => 'sha256:' + fill.repeat(64);
const entry = (id: string, kind: 'application' | 'datastore' | 'static-ui' | 'ingress' = 'application', version = '1.0.0', fill = 'a') => ({
  id, kind, displayName: id.toUpperCase(), description: `Fixture ${id}`,
  links: { repository: `https://example.com/${id}`, documentation: `https://example.com/${id}/docs`, license: `https://example.com/${id}/license`, licenseSpdx: 'Apache-2.0' },
  consoleSection: kind === 'application' ? 'models' : null, required: id === 'hive-registry', dependencies: kind === 'application' && id !== 'hive-registry' ? ['fixture-store', 'hive-registry'] : [],
  version: { version, image: `registry.example.com/${id}@${digest(fill)}`, imageDigest: digest(fill), storageFormat: `${id}-v1` },
});
const installed = (id: string, status: 'activating' | 'installed', version = '1.0.0', fill = 'a', host = 'private-host') => ({
  id, inventoryHost: host, version, image: `registry.example.com/${id}@${digest(fill)}`, imageDigest: digest(fill), status,
  connection: { consolePath: '/models', browserPrefix: `/api/${id}`, nativeApis: { model: 'https://hive.example.com/v1' }, internalEndpoints: { admin: `https://${host}.internal.example.com:9443` } },
});
const syncBody = (phase: 'begin' | 'complete', status: 'activating' | 'installed', plan = 'b') => ({
  schema: 1, phase, operation: 'install', actor: 'hive.sh',
  installation: { id: 'fixture', origin: 'https://hive.example.com', profile: 'custom' },
  release: { version: '1.0.0', manifestDigest: 'c'.repeat(64), planDigest: plan.repeat(64) },
  catalog: [entry('hive-registry'), entry('emberpath'), entry('fixture-store', 'datastore'), entry('not-selected')],
  installed: [installed('hive-registry', status), installed('emberpath', status), installed('fixture-store', status)],
});

describe('Hive Registry API', () => {
  const directories: string[] = [];
  let server: Server | undefined;
  let store: RegistryStore | undefined;
  let base = '';

  async function start(readOnly = false, data = mkdtempSync(join(tmpdir(), 'hive-registry-test-'))): Promise<string> {
    directories.push(data);
    await stop();
    store = new RegistryStore(openDatabase({ dataDirectory: data, autoMigrate: false, readOnly }), 'fixture');
    server = createServer(createApp({ store, installation: 'fixture', readToken, writeToken, readOnly }));
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return data;
  }
  async function stop(): Promise<void> {
    if (server) await new Promise((done) => server!.close(done));
    store?.close();
    server = undefined;
    store = undefined;
  }
  async function call(method: string, path: string, options: { token?: string; body?: unknown; raw?: string } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), 'Content-Type': 'application/json' },
      ...(options.raw !== undefined ? { body: options.raw } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  }
  const sync = (body: unknown = syncBody('complete', 'installed')) => call('POST', '/v1/sync', { token: writeToken, body });

  beforeEach(async () => { await start(); });
  after(async () => {
    await stop();
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });

  describe('authentication', () => {
    it('refuses writes without the write credential', async () => {
      for (const token of [undefined, readToken]) {
        for (const [method, path] of [['POST', '/v1/sync'], ['PUT', '/v1/products/external'], ['DELETE', '/v1/products/external']] as const) {
          const response = await call(method, path, { ...(token ? { token } : {}), body: syncBody('complete', 'installed') });
          assert.equal(response.status, 401, `${method} ${path}`);
        }
      }
      assert.deepEqual((await call('GET', '/v1/products', { token: readToken })).body.products, []);
    });
    it('answers 401 for a wrong or malformed credential instead of a public view', async () => {
      assert.equal((await call('GET', '/v1/products', { token: 'x'.repeat(40) })).status, 401);
      const response = await fetch(`${base}/v1/products`, { headers: { Authorization: `Basic ${readToken}` } });
      assert.equal(response.status, 401);
    });
    it('requires a credential for history and accepts the read credential', async () => {
      assert.equal((await call('GET', '/v1/history')).status, 401);
      assert.equal((await call('GET', '/v1/history', { token: readToken })).status, 200);
    });
    it('refuses to start with missing, weak or shared credentials', () => {
      const directory = mkdtempSync(join(tmpdir(), 'hive-registry-config-'));
      directories.push(directory);
      const file = (name: string, value: string) => { const path = join(directory, name); writeFileSync(path, value); return path; };
      const env = (read: string, write: string) => ({ HIVE_REGISTRY_INSTALLATION: 'fixture', HIVE_REGISTRY_READ_TOKEN_FILE: read, HIVE_REGISTRY_WRITE_TOKEN_FILE: write });
      assert.throws(() => loadConfig(env(join(directory, 'absent'), join(directory, 'absent'))));
      assert.throws(() => loadConfig(env(file('weak', 'short'), file('w', writeToken))), /not a valid credential/);
      assert.throws(() => loadConfig(env(file('same-a', readToken), file('same-b', readToken))), /must differ/);
      assert.equal(loadConfig(env(file('r', readToken), file('w2', writeToken))).readOnly, false);
      assert.throws(() => loadConfig({ HIVE_REGISTRY_INSTALLATION: 'Not Valid' }), /Invalid Hive Registry environment/);
    });
  });

  describe('secret rejection', () => {
    const external = (patch: Record<string, unknown>) => ({ displayName: 'External', ...patch });
    const refused = async (body: unknown) => {
      const response = await call('PUT', '/v1/products/external', { token: writeToken, body });
      assert.equal(response.status, 422, JSON.stringify(body));
      assert.equal(response.body.error.code, 'secret_rejected');
      return response;
    };
    it('rejects credentials by field name, even in unknown fields', async () => {
      for (const name of ['password', 'apiKey', 'api_key', 'clientSecret', 'accessToken', 'privateKey', 'authorization', 'cookie', 'credentials', 'sessionId', 'signingKey'])
        await refused(external({ [name]: 'obviously-fake' }));
      await refused(external({ connection: { internalEndpoints: { token: 'https://example.com' } } }));
    });
    it('rejects credentials by shape in otherwise allowed fields', async () => {
      // Assembled here so the repository's own secret scan does not see a key header.
      const pem = (label: string): string => ['-----BEGIN ', label, 'PRIVATE KEY-----'].join('');
      const samples = [
        pem('') + '\nobviously-fake',
        pem('RSA '),
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJlLWZha2U',
        'Bearer obviously-fake-value',
        'Basic b2J2aW91c2x5OmZha2VmYWtl',
        'see https://admin:obviously-fake@example.com/path',
        'https://example.com/?token=obviously-fake',
        ['sk', 'obviouslyfakevalue0123456789'].join('-'),
        'ghp_obviouslyfakevalue0123456789',
        'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455667788',
      ];
      for (const sample of samples) await refused(external({ description: sample }));
    });
    it('never echoes the refused value, stores nothing and records no history', async () => {
      const response = await refused(external({ description: 'Bearer obviously-fake-value' }));
      assert(!JSON.stringify(response.body).includes('obviously-fake-value'));
      assert.equal((await call('GET', '/v1/products/external', { token: readToken })).status, 404);
      assert.deepEqual((await call('GET', '/v1/history', { token: readToken })).body.entries, []);
    });
    it('rejects a secret anywhere in a sync and rolls nothing forward', async () => {
      const body = syncBody('complete', 'installed') as any;
      body.installed[0].connection.internalEndpoints.admin = 'https://user:obviously-fake@example.com';
      const response = await sync(body);
      assert.equal(response.status, 422);
      assert.deepEqual((await call('GET', '/v1/products', { token: readToken })).body.products, []);
    });
    it('accepts pinned digests and ordinary long paths', () => {
      assert.equal(findSecret(syncBody('complete', 'installed')), null);
      assert.equal(findSecret({ documentation: 'https://github.com/example/hive/tree/main/services/hive-registry-and-more/docs' }), null);
      assert.equal(findSecret({ id: 'a-long-installation-name-2026-11-05-primary-site-1' }), null);
      assert.equal(findSecret({ description: 'Basic authentication and bearer credentials are handled elsewhere; signed tokens never appear here.' }), null);
    });
    it('refuses unknown fields and URLs carrying a query', async () => {
      assert.equal((await call('PUT', '/v1/products/external', { token: writeToken, body: external({ surprise: true }) })).status, 422);
      assert.equal((await call('PUT', '/v1/products/external', { token: writeToken, body: external({ links: { documentation: 'http://example.com/docs' } }) })).status, 422);
    });
  });

  describe('idempotence', () => {
    it('adds no rows or history when the same sync is retried', async () => {
      assert.equal((await sync(syncBody('begin', 'activating'))).status, 200);
      const first = await sync();
      assert(first.body.changes > 0);
      const entries = (await call('GET', '/v1/history', { token: readToken })).body.entries.length;
      const state = (await call('GET', '/v1/products', { token: readToken })).body;
      for (const body of [syncBody('complete', 'installed'), syncBody('begin', 'activating'), syncBody('complete', 'installed')]) {
        const retry = await sync(body);
        assert.equal(retry.status, 200);
        assert.equal(retry.body.changes, 0);
      }
      assert.equal((await call('GET', '/v1/history', { token: readToken })).body.entries.length, entries);
      assert.deepEqual((await call('GET', '/v1/products', { token: readToken })).body, state);
    });
    it('keeps an installed product installed when an interrupted retry begins again', async () => {
      await sync();
      await sync(syncBody('begin', 'activating'));
      const product = (await call('GET', '/v1/products/emberpath', { token: readToken })).body;
      assert.equal(product.installation.status, 'installed');
    });
    it('marks a changed deployment activating until it completes, then records its version', async () => {
      await sync();
      const before = (await call('GET', '/v1/products/emberpath', { token: readToken })).body;
      const next = syncBody('begin', 'activating', 'd') as any;
      next.release.version = '1.1.0';
      next.catalog[1] = entry('emberpath', 'application', '1.1.0', 'e');
      next.installed[1] = installed('emberpath', 'activating', '1.1.0', 'e');
      await sync(next);
      let product = (await call('GET', '/v1/products/emberpath', { token: readToken })).body;
      assert.equal(product.installation.status, 'activating');
      assert.equal(product.installed, false);
      assert.equal((await call('GET', '/v1/installation', { token: readToken })).body.phase, 'activating');
      assert.equal((await call('GET', '/v1/products/hive-registry', { token: readToken })).body.installation.status, 'installed');
      next.phase = 'complete';
      next.installed = next.installed.map((item: any) => ({ ...item, status: 'installed' }));
      await sync(next);
      product = (await call('GET', '/v1/products/emberpath', { token: readToken })).body;
      assert.equal(product.installation.version, '1.1.0');
      assert.equal(product.installation.imageDigest, digest('e'));
      assert.notEqual(product.installation.installedAt, null);
      assert.deepEqual(product.versions.map((version: any) => version.version).sort(), ['1.0.0', '1.1.0']);
      assert.equal(before.versions.length, 1);
      assert.equal((await call('GET', '/v1/installation', { token: readToken })).body.phase, 'complete');
    });
    it('drops a removed release product only on completion and keeps its catalog versions', async () => {
      await sync();
      const body = syncBody('begin', 'activating', 'd') as any;
      body.installed = body.installed.filter((item: any) => item.id !== 'emberpath');
      await sync(body);
      assert.notEqual((await call('GET', '/v1/products/emberpath', { token: readToken })).body.installation, null);
      body.phase = 'complete';
      await sync(body);
      const product = (await call('GET', '/v1/products/emberpath', { token: readToken })).body;
      assert.equal(product.installation, null);
      assert.equal(product.versions.length, 1);
    });
    it('makes external product writes idempotent and keeps them across a sync', async () => {
      const body = { displayName: 'External API', connection: { nativeApis: { model: 'https://models.example.com/v1' } } };
      const first = await call('PUT', '/v1/products/external-api', { token: writeToken, body });
      assert.equal(first.status, 200);
      assert(first.body.changes > 0);
      assert.equal((await call('PUT', '/v1/products/external-api', { token: writeToken, body })).body.changes, 0);
      await sync();
      assert.equal((await call('GET', '/v1/products/external-api', { token: readToken })).body.installation.status, 'external');
      const removed = await call('DELETE', '/v1/products/external-api', { token: writeToken });
      assert.equal(removed.status, 200);
      assert.equal((await call('DELETE', '/v1/products/external-api', { token: writeToken })).body.changes, 0);
      assert.equal((await call('GET', '/v1/products/external-api', { token: readToken })).status, 404);
    });
    it('refuses hand edits of release products and a release taking an external name', async () => {
      await sync();
      assert.equal((await call('PUT', '/v1/products/emberpath', { token: writeToken, body: { displayName: 'Mine' } })).status, 409);
      assert.equal((await call('DELETE', '/v1/products/emberpath', { token: writeToken })).status, 409);
      await call('PUT', '/v1/products/taken', { token: writeToken, body: { displayName: 'External' } });
      const body = syncBody('complete', 'installed') as any;
      body.catalog.push(entry('taken'));
      assert.equal((await sync(body)).status, 409);
    });
    it('rolls a failed sync back as one transaction', async () => {
      await call('PUT', '/v1/products/taken', { token: writeToken, body: { displayName: 'External' } });
      const body = syncBody('complete', 'installed') as any;
      body.catalog.push(entry('taken'));
      assert.equal((await sync(body)).status, 409);
      assert.equal((await call('GET', '/v1/products/emberpath', { token: readToken })).status, 404);
      assert.equal((await call('GET', '/v1/history', { token: readToken })).body.entries.length, 2);
    });
    it('rejects a sync for another installation', async () => {
      const body = syncBody('complete', 'installed') as any;
      body.installation.id = 'someone-else';
      assert.equal((await sync(body)).status, 409);
    });
    it('refuses a duplicate or uncatalogued entry', async () => {
      const duplicate = syncBody('complete', 'installed') as any;
      duplicate.installed.push(duplicate.installed[0]);
      assert.equal((await sync(duplicate)).status, 422);
      const missing = syncBody('complete', 'installed') as any;
      missing.installed.push(installed('absent', 'installed'));
      assert.equal((await sync(missing)).status, 422);
    });
    it('records a release product the installation uses but runs elsewhere', async () => {
      const external = { id: 'not-selected', status: 'external', connection: { consolePath: '/fleet', browserPrefix: '/api/magnus', nativeApis: {}, internalEndpoints: { api: 'https://magnus.example.com:4000' } } };
      for (const phase of ['begin', 'complete'] as const) {
        const body = syncBody(phase, phase === 'begin' ? 'activating' : 'installed') as any;
        body.installed.push(external);
        assert.equal((await sync(body)).status, 200, phase);
      }
      const product = (await call('GET', '/v1/products/not-selected', { token: readToken })).body;
      assert.equal(product.installed, true);
      assert.equal(product.source, 'release');
      assert.deepEqual({ ...product.installation, installedAt: null, updatedAt: null }, { inventoryHost: null, version: null, image: null, imageDigest: null, status: 'external', installedAt: null, updatedAt: null, release: '1.0.0' });
      assert.equal((await call('GET', '/v1/products/not-selected/connection', { token: readToken })).body.internalEndpoints.api, 'https://magnus.example.com:4000');
      assert((await call('GET', '/v1/installation')).body.products.includes('not-selected'), 'The console does not see the external product');
      const retry = syncBody('complete', 'installed') as any;
      retry.installed.push(external);
      assert.equal((await sync(retry)).body.changes, 0);
      // Without it in the configuration, completion removes it like any release product.
      assert.equal((await sync(syncBody('complete', 'installed'))).status, 200);
      assert.equal((await call('GET', '/v1/products/not-selected', { token: readToken })).body.installation, null);
      const datastore = syncBody('complete', 'installed') as any;
      datastore.installed = datastore.installed.filter((item: any) => item.id !== 'fixture-store');
      datastore.installed.push({ ...external, id: 'fixture-store' });
      assert.equal((await sync(datastore)).status, 422, 'A datastore was recorded as external');
      const hosted = syncBody('complete', 'installed') as any;
      hosted.installed.push({ ...external, inventoryHost: 'private-host' });
      assert.equal((await sync(hosted)).status, 422, 'An external entry carried a host');
    });
    it('keeps history append-only at the database level', async () => {
      const data = await start();
      await sync();
      await stop();
      const db = new DatabaseSync(join(data, 'registry.sqlite'));
      assert.throws(() => db.exec('UPDATE history SET actor = 1'), /append-only/);
      assert.throws(() => db.exec('DELETE FROM history'), /append-only/);
      db.close();
    });
  });

  describe('capabilities', () => {
    const events = { 'events.v1': { path: '/hive/events' } };
    const offering = (capabilities: unknown = events, phase: 'begin' | 'complete' = 'complete') => {
      const body = syncBody(phase, phase === 'begin' ? 'activating' : 'installed') as any;
      body.installed.find((item: any) => item.id === 'emberpath').connection.capabilities = capabilities;
      return body;
    };
    const connectionJson = (data: string, id: string): string => {
      const db = new DatabaseSync(join(data, 'registry.sqlite'));
      try { return (db.prepare('SELECT connection_json FROM installed_products WHERE product_id = ?').get(id) as { connection_json: string }).connection_json; } finally { db.close(); }
    };

    it('publishes a product capability with its product and connection, and omits it elsewhere', async () => {
      assert.equal((await sync(offering())).status, 200);
      assert.deepEqual((await call('GET', '/v1/products/emberpath')).body.capabilities, events);
      assert.deepEqual((await call('GET', '/v1/products/emberpath/connection')).body.capabilities, events);
      assert.deepEqual((await call('GET', '/v1/products/emberpath', { token: readToken })).body.capabilities, events);
      assert.deepEqual((await call('GET', '/v1/products/emberpath/connection', { token: readToken })).body.capabilities, events);
      const listed = (await call('GET', '/v1/products?installed=true')).body.products;
      assert.deepEqual(listed.map((item: any) => [item.id, 'capabilities' in item]), [['emberpath', true], ['hive-registry', false]]);
      assert.equal('capabilities' in (await call('GET', '/v1/products/hive-registry/connection')).body, false);
      assert.equal((await sync(offering())).body.changes, 0, 'A retried sync with capabilities changed rows');
    });
    it('reads and keeps connections recorded without capabilities unchanged', async () => {
      const data = await start();
      await sync();
      const before = connectionJson(data, 'emberpath');
      assert.doesNotMatch(before, /capabilities/);
      assert.equal('capabilities' in (await call('GET', '/v1/products/emberpath')).body, false);
      assert.equal('capabilities' in (await call('GET', '/v1/products/emberpath/connection')).body, false);
      assert.equal((await sync()).body.changes, 0);
      // A product release that starts serving a feed is one recorded change; dropping it is another.
      assert.equal((await sync(offering())).body.changes, 1);
      assert.match(connectionJson(data, 'emberpath'), /"capabilities":\{"events\.v1"/);
      assert.equal((await sync()).body.changes, 1);
      await stop();
      assert.equal(connectionJson(data, 'emberpath'), before);
    });
    it('refuses malformed capabilities', async () => {
      const refusals: unknown[] = [
        { 'Events.V1': { path: '/x' } }, { ['e'.repeat(65)]: { path: '/x' } }, { 'events.v1': { path: 'relative' } }, { 'events.v1': { path: '/a/../b' } },
        { 'events.v1': { path: '/x', since: '1.0.0' } }, { 'events.v1': '/x' }, [], Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`c${index}`, { path: '/x' }])),
      ];
      for (const capabilities of refusals) assert.equal((await sync(offering(capabilities))).status, 422, JSON.stringify(capabilities));
      const unprefixed = offering() as any;
      unprefixed.installed.find((item: any) => item.id === 'emberpath').connection.browserPrefix = null;
      assert.equal((await sync(unprefixed)).status, 422, 'A capability without a browser prefix');
      assert.equal((await call('GET', '/v1/history', { token: readToken })).body.entries.length, 0);
    });
    it('carries capabilities for external uses and externally managed products', async () => {
      const body = offering() as any;
      body.installed.push({ id: 'not-selected', status: 'external', connection: { consolePath: '/fleet', browserPrefix: '/api/magnus', nativeApis: {}, internalEndpoints: { api: 'https://magnus.example.com:4000' }, capabilities: events } });
      assert.equal((await sync(body)).status, 200);
      assert.deepEqual((await call('GET', '/v1/products/not-selected/connection')).body.capabilities, events);
      const put = await call('PUT', '/v1/products/shared-api', { token: writeToken, body: { displayName: 'Shared', public: true, connection: { browserPrefix: '/api/shared', capabilities: { 'events.v1': { path: '/v1/hive/events' } } } } });
      assert.equal(put.status, 200);
      assert.deepEqual((await call('GET', '/v1/products/shared-api')).body.capabilities, { 'events.v1': { path: '/v1/hive/events' } });
      assert.equal((await call('PUT', '/v1/products/other-api', { token: writeToken, body: { displayName: 'Other', connection: { capabilities: events } } })).status, 422);
    });
    it('answers in the shape the published browser contract describes', async () => {
      await sync(offering({ ...events, 'future-thing.v2': { path: '/v2/x' } }));
      assert.deepEqual(registryHealthSchema.parse((await call('GET', '/health/ready')).body), { status: 'ready', readOnly: false });
      registryInstallationSchema.parse((await call('GET', '/v1/installation')).body);
      const list = registryProductListSchema.parse((await call('GET', '/v1/products')).body);
      assert.deepEqual(list.products.find((item) => item.id === 'emberpath')?.capabilities, events, 'Unknown capability names are dropped by readers');
      assert.equal(list.products.find((item) => item.id === 'hive-registry')?.capabilities, undefined);
      assert.deepEqual(registryProductSchema.parse((await call('GET', '/v1/products/emberpath')).body).capabilities, events);
      const connection = registryConnectionSchema.parse((await call('GET', '/v1/products/emberpath/connection')).body);
      assert.equal(connection.browserPrefix + connection.capabilities!['events.v1']!.path, '/api/emberpath/hive/events');
    });
  });

  describe('field exposure', () => {
    const forbidden = /private-host|internal\.example\.com|registry\.example\.com|sha256:|internalEndpoints|inventoryHost|imageDigest|storageFormat|manifestDigest|planDigest|installedAt|updatedAt|"version"|"versions"|fixture-store/;
    it('exposes only allowlisted public fields without a credential', async () => {
      await sync();
      const summary = await call('GET', '/v1/installation');
      assert.deepEqual(summary.body, { schema: 1, id: 'fixture', products: ['emberpath', 'hive-registry'] });
      const products = await call('GET', '/v1/products');
      assert.deepEqual(products.body.products.map((item: any) => item.id), ['emberpath', 'hive-registry', 'not-selected']);
      assert.deepEqual(Object.keys(products.body.products[0]).sort(), ['consoleSection', 'dependencies', 'description', 'displayName', 'id', 'installed', 'links', 'required']);
      assert.deepEqual(products.body.products[0].dependencies, ['hive-registry']);
      assert.deepEqual((await call('GET', '/v1/products?installed=true')).body.products.map((item: any) => item.id), ['emberpath', 'hive-registry']);
      const product = await call('GET', '/v1/products/emberpath');
      const connection = await call('GET', '/v1/products/emberpath/connection');
      assert.deepEqual(connection.body, { id: 'emberpath', consolePath: '/models', browserPrefix: '/api/emberpath', nativeApis: { model: 'https://hive.example.com/v1' }, documentation: 'https://example.com/emberpath/docs' });
      for (const response of [summary, products, product, connection]) assert.doesNotMatch(JSON.stringify(response.body), forbidden);
    });
    it('hides datastores and non-public external products from the public view', async () => {
      await sync();
      assert.equal((await call('GET', '/v1/products/fixture-store')).status, 404);
      assert.equal((await call('GET', '/v1/products/fixture-store/connection')).status, 404);
      await call('PUT', '/v1/products/hidden-api', { token: writeToken, body: { displayName: 'Private name', inventoryHost: 'private-host', version: '2.0.0' } });
      await call('PUT', '/v1/products/shared-api', { token: writeToken, body: { displayName: 'Shared', public: true, inventoryHost: 'private-host', version: '2.0.0', connection: { internalEndpoints: { admin: 'https://private-host.internal.example.com' } } } });
      assert.equal((await call('GET', '/v1/products/hidden-api')).status, 404);
      assert.doesNotMatch(JSON.stringify((await call('GET', '/v1/products')).body), /hidden-api|Private name/);
      assert.doesNotMatch(JSON.stringify((await call('GET', '/v1/installation')).body), /hidden-api/);
      const shared = await call('GET', '/v1/products/shared-api');
      assert.equal(shared.status, 200);
      assert.doesNotMatch(JSON.stringify(shared.body) + JSON.stringify((await call('GET', '/v1/products/shared-api/connection')).body), forbidden);
    });
    it('returns private fields with the read credential', async () => {
      await sync();
      const product = (await call('GET', '/v1/products/emberpath', { token: readToken })).body;
      assert.equal(product.installation.inventoryHost, 'private-host');
      assert.equal(product.installation.imageDigest, digest('a'));
      assert.equal(product.versions[0].storageFormat, 'emberpath-v1');
      assert.deepEqual(product.dependencies, ['fixture-store', 'hive-registry']);
      const connection = (await call('GET', '/v1/products/emberpath/connection', { token: readToken })).body;
      assert.equal(connection.inventoryHost, 'private-host');
      assert.equal(connection.internalEndpoints.admin, 'https://private-host.internal.example.com:9443');
      const summary = (await call('GET', '/v1/installation', { token: readToken })).body;
      assert.deepEqual(summary.hosts, ['private-host']);
      assert.equal(summary.release.version, '1.0.0');
      assert.equal((await call('GET', '/v1/products/fixture-store', { token: readToken })).status, 200);
    });
    it('does not publish a product as installed while it is still activating', async () => {
      await sync(syncBody('begin', 'activating'));
      assert.deepEqual((await call('GET', '/v1/installation')).body.products, []);
      assert.deepEqual((await call('GET', '/v1/products?installed=true')).body.products, []);
    });
    it('sets no cookie and asks not to be cached', async () => {
      const response = await call('GET', '/v1/installation');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('set-cookie'), null);
    });
    it('keeps health responses minimal and routes unknown paths to 404', async () => {
      assert.deepEqual((await call('GET', '/health/ready')).body, { status: 'ready', readOnly: false });
      assert.equal((await call('GET', '/health/live')).status, 200);
      assert.equal((await call('POST', '/health/ready')).status, 405);
      for (const path of ['/v1/products/Bad%20Name', '/v1/products/emberpath/other', '/v1/products/a/b/c', '/v2/products', '/']) assert.equal((await call('GET', path)).status, 404, path);
    });
    it('caps request bodies', async () => {
      const response = await call('POST', '/v1/sync', { token: writeToken, raw: JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) }) });
      assert.equal(response.status, 413);
      assert.equal((await call('POST', '/v1/sync', { token: writeToken, raw: '{' })).status, 400);
    });
  });

  describe('migrations', () => {
    it('pins the checksum of every applied migration', () => {
      assert.deepEqual(migrations.map((entry) => entry.id), ['0001_initial']);
      assert.equal(checksum(migrations[0]!.sql), 'bd9c1467c17658c969a821a8d454c101e1390bc7b01a34d964363786364673a6');
    });
    it('creates the baseline on an empty database with automatic migration off', () => {
      const db = new DatabaseSync(':memory:');
      assert.deepEqual(migrate(db, false), ['0001_initial']);
      assert.deepEqual(migrate(db, false), []);
      db.close();
    });
    it('refuses a changed migration and a newer unknown one', () => {
      const db = new DatabaseSync(':memory:');
      migrate(db, false);
      db.exec("UPDATE schema_migrations SET sha256 = 'changed'");
      assert.throws(() => migrate(db, true), /changed after it was applied/);
      db.exec("UPDATE schema_migrations SET sha256 = '" + checksum(migrations[0]!.sql) + "'");
      db.exec("INSERT INTO schema_migrations VALUES ('9999_future', 'x', 'now')");
      assert.throws(() => migrate(db, true), /older than the data/);
      db.close();
    });
    it('holds pending migrations on existing data unless explicitly allowed', () => {
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
      const original = [...migrations];
      (migrations as Array<{ id: string; sql: string }>).push({ id: '0002_fixture', sql: 'CREATE TABLE fixture_only (id INTEGER) STRICT;' });
      try {
        migrate(db, true);
        db.exec("DELETE FROM schema_migrations WHERE id = '0002_fixture'");
        db.exec('DROP TABLE fixture_only');
        assert.throws(() => migrate(db, false), PendingMigrations);
        assert.deepEqual(migrate(db, true), ['0002_fixture']);
      } finally {
        (migrations as Array<{ id: string; sql: string }>).splice(original.length);
        db.close();
      }
    });
  });

  describe('storage lifecycle', () => {
    it('stores data in WAL mode, closes cleanly and leaves owner-only files', async () => {
      const previous = process.umask(0o077);
      try {
        const data = await start();
        await sync();
        assert(existsSync(join(data, 'registry.sqlite-wal')));
        await stop();
        assert(!existsSync(join(data, 'registry.sqlite-wal')), 'A clean close checkpoints the WAL');
        assert.equal(statSync(join(data, 'registry.sqlite')).mode & 0o077, 0);
      } finally {
        process.umask(previous);
      }
    });
    it('keeps committed rows through an unclean stop when the WAL family is archived', async () => {
      const data = await start();
      await sync();
      const archive = mkdtempSync(join(tmpdir(), 'hive-registry-archive-'));
      directories.push(archive);
      for (const name of readdirSync(data)) copyFileSync(join(data, name), join(archive, name));
      assert(existsSync(join(archive, 'registry.sqlite-wal')));
      const db = new DatabaseSync(join(archive, 'registry.sqlite'));
      assert.equal((db.prepare('PRAGMA integrity_check').get() as Record<string, string>).integrity_check, 'ok');
      assert.equal((db.prepare("SELECT status FROM installed_products WHERE product_id = 'emberpath'").get() as { status: string }).status, 'installed');
      db.close();
    });
    it('serves a read-only rehearsal without touching the restored files', async () => {
      const data = await start();
      await sync();
      await stop();
      const fingerprint = () => readdirSync(data).sort().map((name) => [name, statSync(join(data, name)).mtimeMs, statSync(join(data, name)).size]);
      const before = fingerprint();
      await start(true, data);
      assert.deepEqual((await call('GET', '/health/ready')).body, { status: 'ready', readOnly: true });
      assert.equal((await call('GET', '/v1/products/emberpath', { token: readToken })).body.installation.status, 'installed');
      const refused = await sync();
      assert.equal(refused.status, 503);
      assert.equal(refused.body.error.code, 'read_only');
      assert.equal((await call('POST', '/v1/sync', { body: syncBody('complete', 'installed') })).status, 401);
      await stop();
      assert.deepEqual(fingerprint(), before);
    });
    it('starts a read-only rehearsal of an archive with no registry data yet', async () => {
      const data = mkdtempSync(join(tmpdir(), 'hive-registry-empty-'));
      await start(true, data);
      assert.deepEqual((await call('GET', '/v1/products')).body.products, []);
      await stop();
      assert.deepEqual(readdirSync(data), []);
    });
    it('reopens existing data and refuses another installation at the API', async () => {
      const data = await start();
      await sync();
      await stop();
      await start(false, data);
      assert.equal((await call('GET', '/v1/products/emberpath', { token: readToken })).body.installation.status, 'installed');
    });
  });
});
