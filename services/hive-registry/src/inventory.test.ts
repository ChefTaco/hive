import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { createOathweaveVerifier } from '@hivemagnus/hive-common/oathweave';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createApp } from './app.js';
import { registryCapabilitiesSchema } from './browser-contract.js';
import { loadConfig } from './config.js';
import { authorityFetch, INVENTORY_AUDIENCE, INVENTORY_PERMISSION, inventoryAuthorizer, loadIdentity } from './identity.js';
import { registryInventorySchema } from './inventory-contract.js';
import { openDatabase, RegistryStore } from './store.js';

const readToken = 'r'.repeat(40);
const writeToken = 'w'.repeat(40);
const issuer = 'https://hive.example.com/api/oathweave';
const digest = (fill: string): string => 'sha256:' + fill.repeat(64);
// A real manifest digest mixes digits and letters, as an opaque token does; one of a single
// repeated letter would not exercise the registry's credential guard.
const RECEIPT_DIGEST = '227d003449ae500d6dbf5e20c2b7139c6a1af92a0e642c3a84a01a0093bd9824';
const image = (id: string, fill: string): string => `registry.example.com/${id}@${digest(fill)}`;
const entry = (id: string, kind = 'application', version = '1.0.0', fill = 'a') => ({
  id, kind, displayName: id.toUpperCase(), description: `Fixture ${id}`,
  links: { repository: null, documentation: null, license: null, licenseSpdx: null },
  consoleSection: null, required: id === 'hive-registry', dependencies: [],
  version: { version, image: image(id, fill), imageDigest: digest(fill), storageFormat: `${id}-v1` },
});
const connection = { consolePath: null, browserPrefix: null, nativeApis: {}, internalEndpoints: { api: 'https://secret-internal.example.com:4000' } };
const syncBody = {
  schema: 1, phase: 'complete', operation: 'upgrade', actor: 'hive.sh',
  installation: { id: 'fixture', origin: 'https://hive.example.com', profile: 'full' },
  release: { version: '3.12.9', manifestDigest: 'c'.repeat(64), planDigest: 'd'.repeat(64) },
  catalog: [entry('hive-registry', 'application', '1.4.0', 'a'), entry('hivexui', 'static-ui', '0.10.3', 'b'), entry('magnus', 'application', '3.1.5', 'e'), entry('fixture-store', 'datastore', '17.12', 'f')],
  installed: [
    { id: 'hive-registry', inventoryHost: 'control', version: '1.4.0', image: image('hive-registry', 'a'), imageDigest: digest('a'), status: 'installed', connection },
    { id: 'hivexui', inventoryHost: 'control', version: '0.10.3', image: image('hivexui', 'b'), imageDigest: digest('b'), status: 'installed', connection },
    { id: 'magnus', status: 'external', connection },
  ],
};
const service = (name: string, fill: string, patch: Record<string, unknown> = {}) => ({
  service: name, image: image(name, fill), runningImage: image(name, fill), imageId: digest('9'), imageMatches: true, state: 'running', health: 'healthy', ...patch,
});
const observations = (patch: Record<string, unknown> = {}) => ({
  schema: 1,
  hosts: [{
    host: 'control', active: true, unreachable: false, receipt: { version: '3.12.9', digest: RECEIPT_DIGEST }, transactionPhase: 'complete',
    catalog: [{ id: 'hive-registry', version: '1.4.0', image: image('hive-registry', 'a') }, { id: 'magnus', version: '3.1.5', image: image('magnus', 'e') }],
    services: [service('hive-registry', 'a'), service('hivexui', 'b', { runningImage: image('hivexui', '7'), imageMatches: false })],
    ...patch,
  }],
});

describe('Hive Registry inventory', async () => {
  const keys = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const verifier = createOathweaveVerifier({ issuer, audience: INVENTORY_AUDIENCE, keys: { keys: [jwk] } });
  const token = async (claims: Record<string, unknown> = {}, options: { audience?: string; key?: CryptoKey; kid?: string } = {}) =>
    new SignJWT({ actorType: 'USER', sessionId: 'session-1', clientId: 'hivexui-registry', permissions: [INVENTORY_PERMISSION], roles: ['SUITE_ADMIN'], ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'fixture' }).setIssuer(issuer).setAudience(options.audience ?? INVENTORY_AUDIENCE)
      .setSubject('user-1').setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime('5m').sign(options.key ?? keys.privateKey);

  const directories: string[] = [];
  let server: Server | undefined;
  let store: RegistryStore | undefined;
  let base = '';
  let clock = Date.parse('2026-11-20T10:00:00.000Z');
  async function start(withIdentity = true): Promise<void> {
    await stop();
    const data = mkdtempSync(join(tmpdir(), 'hive-registry-inventory-'));
    directories.push(data);
    store = new RegistryStore(openDatabase({ dataDirectory: data, autoMigrate: false, readOnly: false }), 'fixture', () => new Date(clock).toISOString());
    server = createServer(createApp({ store, installation: 'fixture', readToken, writeToken, readOnly: false, ...(withIdentity ? { inventoryAuthorizer: inventoryAuthorizer(verifier) } : {}) }));
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function stop(): Promise<void> {
    if (server) await new Promise((done) => server!.close(done));
    store?.close();
    server = undefined;
    store = undefined;
  }
  async function call(method: string, path: string, options: { bearer?: string; body?: unknown } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}), 'Content-Type': 'application/json' },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  }
  const prepare = async () => {
    assert.equal((await call('POST', '/v1/sync', { bearer: writeToken, body: syncBody })).status, 200);
    assert.equal((await call('PUT', '/v1/observations', { bearer: writeToken, body: observations() })).status, 200);
  };

  beforeEach(async () => { clock = Date.parse('2026-11-20T10:00:00.000Z'); await start(); });
  after(async () => {
    await stop();
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });

  describe('access', () => {
    it('serves an administrator with the inventory permission', async () => {
      await prepare();
      const response = await call('GET', '/v1/inventory', { bearer: await token() });
      assert.equal(response.status, 200);
      registryInventorySchema.parse(response.body);
    });
    it('refuses anonymous callers', async () => {
      const response = await call('GET', '/v1/inventory');
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'credential_required');
    });
    it('refuses a token for another audience, another key or another kind of caller', async () => {
      for (const [bearer, code] of [
        [await token({}, { audience: 'magnus' }), 'invalid_audience'],
        [await token({}, { key: other.privateKey }), 'invalid_signature'],
        [await token({}, { kid: 'unknown' }), 'unknown_key'],
        [await token({ actorType: 'SERVICE_ACCOUNT', clientId: 'user-1', token_type: 'access', sessionId: undefined }), 'wrong_principal_kind'],
      ] as const) {
        const response = await call('GET', '/v1/inventory', { bearer });
        assert.equal(response.status, 401, code);
        assert.equal(response.body.error.code, code);
      }
    });
    it('refuses a signed-in person without registry:inventory', async () => {
      const response = await call('GET', '/v1/inventory', { bearer: await token({ permissions: ['magnus:admin'] }) });
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'insufficient_permission');
    });
    it('still serves the shared read and write credentials', async () => {
      await prepare();
      for (const bearer of [readToken, writeToken]) assert.equal((await call('GET', '/v1/inventory', { bearer })).status, 200);
    });
    it('accepts an Oathweave token nowhere else', async () => {
      const bearer = await token();
      for (const path of ['/v1/installation', '/v1/products', '/v1/products/hivexui', '/v1/history']) {
        const response = await call('GET', path, { bearer });
        assert.equal(response.status, 401, path);
        assert.equal(response.body.error.code, 'invalid_credential', path);
      }
      for (const [method, path] of [['PUT', '/v1/observations'], ['POST', '/v1/sync']] as const)
        assert.equal((await call(method, path, { bearer, body: observations() })).status, 401, path);
    });
    it('without identity configuration, refuses people and keeps the shared credentials', async () => {
      await start(false);
      assert.equal((await call('GET', '/v1/inventory', { bearer: await token() })).status, 401);
      assert.equal((await call('GET', '/v1/inventory', { bearer: readToken })).status, 200);
    });
    it('records observations only with the write credential', async () => {
      for (const bearer of [undefined, readToken]) {
        const response = await call('PUT', '/v1/observations', { ...(bearer ? { bearer } : {}), body: observations() });
        assert.equal(response.status, 401);
      }
      assert.equal((await call('PUT', '/v1/observations', { bearer: writeToken, body: observations() })).status, 200);
    });
  });

  describe('view', () => {
    it('puts each signed pin beside what the host reports', async () => {
      await prepare();
      const inventory = registryInventorySchema.parse((await call('GET', '/v1/inventory', { bearer: readToken })).body);
      assert.deepEqual(inventory.release, { version: '3.12.9', manifestDigest: 'c'.repeat(64) });
      assert.equal(inventory.observedAt, '2026-11-20T10:00:00.000Z');
      const byId = Object.fromEntries(inventory.components.map((component) => [component.id, component]));
      assert.deepEqual(byId.hivexui, { id: 'hivexui', displayName: 'HIVEXUI', kind: 'static-ui', source: 'release', status: 'installed', inventoryHost: 'control', pinned: { version: '0.10.3', image: image('hivexui', 'b'), imageDigest: digest('b') }, recorded: null });
      // An external Magnus is pinned by the manifest the host keeps, with no host of its own.
      assert.deepEqual(byId.magnus?.pinned, { version: '3.1.5', image: image('magnus', 'e'), imageDigest: digest('e') });
      assert.equal(byId.magnus?.status, 'external');
      assert.equal(byId.magnus?.inventoryHost, null);
      assert.equal(byId['fixture-store']?.status, 'not-installed');
      const reported = inventory.hosts[0]!.services.find((item) => item.service === 'hivexui');
      assert.equal(reported?.imageMatches, false);
      assert.equal(reported?.runningImage, image('hivexui', '7'));
    });
    it('never carries internal endpoints, origins or plan digests', async () => {
      await prepare();
      const text = JSON.stringify((await call('GET', '/v1/inventory', { bearer: readToken })).body);
      for (const forbidden of ['secret-internal', 'internalEndpoints', 'https://hive.example.com', 'd'.repeat(64)]) assert.equal(text.includes(forbidden), false, forbidden);
    });
    it('lists an externally managed product with what its operator recorded', async () => {
      await prepare();
      assert.equal((await call('PUT', '/v1/products/shared-api', { bearer: writeToken, body: { displayName: 'Shared', version: '2.0.0', imageDigest: digest('3') } })).status, 200);
      const shared = (await call('GET', '/v1/inventory', { bearer: readToken })).body.components.find((item: any) => item.id === 'shared-api');
      assert.deepEqual([shared.source, shared.pinned, shared.recorded], ['external', null, { version: '2.0.0', imageDigest: digest('3') }]);
    });
    it('answers before any observation with no hosts', async () => {
      const inventory = registryInventorySchema.parse((await call('GET', '/v1/inventory', { bearer: readToken })).body);
      assert.deepEqual([inventory.release, inventory.observedAt, inventory.hosts], [null, null, []]);
    });
  });

  describe('observations', () => {
    const recorded = async () => (await call('GET', '/v1/history?limit=1000', { bearer: readToken })).body.entries.filter((item: any) => item.subject === 'observations');
    it('adds no history for the same observation within the hour, and records a change or an hour later', async () => {
      await prepare();
      assert.equal((await call('PUT', '/v1/observations', { bearer: writeToken, body: observations() })).body.changes, 0);
      clock += 10 * 60_000;
      assert.equal((await call('PUT', '/v1/observations', { bearer: writeToken, body: observations({ transactionPhase: 'activate' }) })).body.changes, 1);
      clock += 61 * 60_000;
      assert.equal((await call('PUT', '/v1/observations', { bearer: writeToken, body: observations({ transactionPhase: 'activate' }) })).body.changes, 1);
      assert.equal((await recorded()).length, 3);
      assert.equal((await call('GET', '/v1/inventory', { bearer: readToken })).body.observedAt, new Date(clock).toISOString());
    });
    it('replaces the whole set, so a removed host disappears', async () => {
      await prepare();
      await call('PUT', '/v1/observations', { bearer: writeToken, body: { schema: 1, hosts: [] } });
      assert.deepEqual((await call('GET', '/v1/inventory', { bearer: readToken })).body.hosts, []);
    });
    it('leaves the installation revision alone', async () => {
      await prepare();
      const revision = (await call('GET', '/v1/installation', { bearer: readToken })).body.revision;
      clock += 2 * 3_600_000;
      await call('PUT', '/v1/observations', { bearer: writeToken, body: observations() });
      assert.equal((await call('GET', '/v1/installation', { bearer: readToken })).body.revision, revision);
    });
    it('refuses malformed observations and unknown fields', async () => {
      for (const body of [
        observations({ host: 'Not A Host' }),
        observations({ services: [service('hivexui', 'b', { state: 'running; rm' })] }),
        observations({ services: [service('hivexui', 'b', { imageId: 'not-a-digest' })] }),
        observations({ extra: true }),
        { schema: 1, hosts: [observations().hosts[0], observations().hosts[0]] },
        { schema: 2, hosts: [] },
      ]) assert.equal((await call('PUT', '/v1/observations', { bearer: writeToken, body })).status, 422, JSON.stringify(body).slice(0, 120));
    });
  });

  describe('configuration', () => {
    it('reads the optional identity file and refuses an invalid one', () => {
      const directory = mkdtempSync(join(tmpdir(), 'hive-registry-identity-'));
      directories.push(directory);
      const file = (name: string, value: string) => { const path = join(directory, name); writeFileSync(path, value); return path; };
      const env = (identity: string) => ({ HIVE_REGISTRY_INSTALLATION: 'fixture', HIVE_REGISTRY_READ_TOKEN_FILE: file('r', readToken), HIVE_REGISTRY_WRITE_TOKEN_FILE: file('w', writeToken), HIVE_REGISTRY_IDENTITY_FILE: identity });
      assert.equal(loadConfig(env(join(directory, 'absent.json'))).identity, undefined);
      const valid = { schema: 1, issuer, jwksUrl: 'https://oathweave:4200/api/v1/oauth/jwks', userinfoUrl: 'https://oathweave:4200/api/v1/oauth/userinfo', audience: 'hive-registry', authorityFile: '/config/authority.pem' };
      assert.deepEqual(loadConfig(env(file('identity.json', JSON.stringify(valid)))).identity, valid);
      for (const invalid of [{ ...valid, audience: 'magnus' }, { ...valid, jwksUrl: 'http://oathweave:4200/jwks' }, { ...valid, secret: 'x' }, { ...valid, authorityFile: '/etc/passwd' }])
        assert.throws(() => loadIdentity(file('bad.json', JSON.stringify(invalid))), /not valid/);
    });
    it('fetches the keys over TLS with the internal authority only', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'hive-registry-authority-'));
      directories.push(directory);
      const at = (name: string) => join(directory, name);
      const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
      openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Fixture CA', '-keyout', at('ca.key'), '-out', at('ca.pem'), '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
      openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', at('server.key'), '-out', at('server.csr'));
      writeFileSync(at('ext'), 'subjectAltName=DNS:localhost\n');
      openssl('x509', '-req', '-in', at('server.csr'), '-CA', at('ca.pem'), '-CAkey', at('ca.key'), '-CAcreateserial', '-days', '1', '-extfile', at('ext'), '-out', at('server.pem'));
      const tls = createHttpsServer({ key: readFileSync(at('server.key')), cert: readFileSync(at('server.pem')) }, (request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ path: request.url, keys: [] }));
      });
      await new Promise<void>((done) => tls.listen(0, '127.0.0.1', done));
      const url = `https://localhost:${(tls.address() as AddressInfo).port}/api/v1/oauth/jwks`;
      try {
        const response = await authorityFetch(at('ca.pem'))(url, { headers: { accept: 'application/json' } });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { path: '/api/v1/oauth/jwks', keys: [] });
        await assert.rejects(authorityFetch(at('absent.pem'))(url), /self-signed|unable to verify|certificate/i);
        await assert.rejects(authorityFetch(at('ca.pem'))('http://localhost:1/x'), /Only https/);
      } finally {
        await new Promise((done) => tls.close(done));
      }
    });
    it('announces inventory.v1 in the public browser contract', () => {
      assert.deepEqual(registryCapabilitiesSchema.parse({ 'inventory.v1': { path: '/v1/inventory' } }), { 'inventory.v1': { path: '/v1/inventory' } });
    });
  });
});
