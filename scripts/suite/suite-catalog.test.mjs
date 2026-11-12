import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applySuiteCatalog, catalogFor, checkCapabilities, suiteCatalog } from './suite-catalog.mjs';

const withSince = (name, since, run) => {
  const capability = suiteCatalog[name].capabilities['events.v1'];
  const previous = capability.since;
  capability.since = since;
  try { return run(); } finally { capability.since = previous; }
};

test('declares the events feed path per product, relative to its browser prefix', () => {
  assert.equal(suiteCatalog.magnus.capabilities['events.v1'].path, '/hive/events');
  assert.equal(suiteCatalog.cindertrace.capabilities['events.v1'].path, '/hive/events');
  assert.equal(suiteCatalog.hiveskills.capabilities['events.v1'].path, '/v1/hive/events');
  assert.equal(suiteCatalog.embermend.capabilities['events.v1'].path, '/api/v1/hive/events');
  for (const name of ['magnus', 'cindertrace', 'hiveskills', 'embermend']) assert.equal(suiteCatalog[name].capabilities['events.v1'].since, null, name + ' has no released feed yet');
  for (const [name, entry] of Object.entries(suiteCatalog)) if (entry.capabilities) assert.ok(entry.connection.browserPrefix, name);
});

test('emits a capability only from its since version, and only its path', () => {
  assert.equal(catalogFor('magnus', '99.0.0').capabilities, undefined, 'since null is never emitted');
  withSince('magnus', '2.8.0', () => {
    assert.equal(catalogFor('magnus', '2.7.9').capabilities, undefined);
    assert.equal('capabilities' in catalogFor('magnus', '2.7.9'), false);
    assert.deepEqual(catalogFor('magnus', '2.8.0').capabilities, { 'events.v1': { path: '/hive/events' } });
    assert.deepEqual(catalogFor('magnus', '2.10.0').capabilities, { 'events.v1': { path: '/hive/events' } });
    assert.deepEqual(Object.keys(catalogFor('magnus', '3.0.0')).slice(-2), ['connection', 'capabilities']);
    const manifest = applySuiteCatalog({ version: '9.9.9', components: { magnus: { version: '2.8.1' }, cindertrace: {}, emberpath: {} } });
    assert.deepEqual(manifest.components.magnus.catalog.capabilities, { 'events.v1': { path: '/hive/events' } });
    assert.equal(manifest.components.cindertrace.catalog.capabilities, undefined);
    assert.equal(manifest.components.emberpath.catalog.capabilities, undefined);
    assert.equal(manifest.components.cindertrace.version, '9.9.9');
  });
  assert.equal(suiteCatalog.magnus.capabilities['events.v1'].since, null, 'the source catalog is not changed');
});

test('refuses malformed capability declarations', () => {
  const entry = (capabilities, browserPrefix = '/api/example') => ({ connection: { browserPrefix }, capabilities });
  for (const bad of [
    entry([]),
    entry({ 'Events.V1': { path: '/x', since: null } }),
    entry({ 'events.v1': { path: 'relative', since: null } }),
    entry({ 'events.v1': { path: '/a/../b', since: null } }),
    entry({ 'events.v1': { path: '/x', since: 'latest' } }),
    entry({ 'events.v1': { path: '/x', since: null, token: 'fake' } }),
    entry({ 'events.v1': { path: '/x', since: null } }, null),
  ]) assert.throws(() => checkCapabilities('example', bad), /Suite catalog example/, JSON.stringify(bad));
  checkCapabilities('example', entry({ 'events.v1': { path: '/v1/hive/events', since: '1.6.0' } }));
});

// The ingress mapping of each browser prefix, read from the Caddyfile: a handle_path block that
// strips the prefix and may rewrite it to another root, or a handle that strips it explicitly.
const caddyfile = readFileSync(new URL('../../deployment/Caddyfile', import.meta.url), 'utf8');
function ingressMapping(prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const block = new RegExp(`\\n\\thandle_path ${escaped}/\\* \\{\\n((?:\\t\\t.*\\n)+)\\t\\}`).exec(caddyfile);
  if (block) {
    const rewrite = /^\t\trewrite \* (\S*)\{uri\}$/m.exec(block[1]);
    return (rest) => (rewrite ? rewrite[1] : '') + rest;
  }
  assert.match(caddyfile, new RegExp(`\\n\\t\\tpath ${escaped}/\\*\\n`), `${prefix} has no ingress route`);
  assert.match(caddyfile, new RegExp(`\\n\\t\\turi strip_prefix ${escaped}\\n`), `${prefix} is routed but not stripped`);
  return (rest) => rest;
}
// Where each product serves its feed natively.
const nativeFeeds = { magnus: '/api/v1/hive/events', cindertrace: '/api/v1/hive/events', hiveskills: '/v1/hive/events', embermend: '/api/v1/hive/events' };

test('every declared capability reaches the product feed through the ingress', () => {
  const declared = Object.entries(suiteCatalog).filter(([, entry]) => entry.capabilities?.['events.v1']).map(([name]) => name).sort();
  assert.deepEqual(declared, Object.keys(nativeFeeds).sort());
  for (const [name, entry] of Object.entries(suiteCatalog)) {
    for (const [capability, { path }] of Object.entries(entry.capabilities ?? {})) {
      const prefix = entry.connection.browserPrefix;
      assert.equal(ingressMapping(prefix)(path), nativeFeeds[name], `${name} ${capability}: ${prefix}${path}`);
    }
  }
  // Magnus is default deny behind the prefix: its feed must be on the browser allowlist.
  const allowlist = caddyfile.slice(caddyfile.indexOf('@magnus_browser expression'), caddyfile.indexOf('handle @magnus_browser'));
  assert.match(allowlist, /\{path\} == "\/api\/v1\/hive\/events"/);
});

test('reads the ingress mappings it relies on', () => {
  assert.equal(ingressMapping('/api/magnus')('/nodes'), '/api/v1/nodes');
  assert.equal(ingressMapping('/api/hiveskills')('/v1/skills'), '/v1/skills');
  assert.equal(ingressMapping('/api/embermend')('/api/v1/plans'), '/api/v1/plans');
  assert.equal(ingressMapping('/api/hivemem')('/x'), '/v1/x');
  assert.throws(() => ingressMapping('/api/nowhere'), /no ingress route/);
});
