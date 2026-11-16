import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { planAdminAccess, validateIdentity, adminAccessDataCLI, EMBERMEND_ADMIN_PERMISSIONS } from './admin-access-data.mjs';

const issuer = 'https://identity.example.com/api/oathweave';
const identity = { issuer, subject: 'new-person-subject', username: 'alice', email: 'alice@example.com', displayName: 'Alice Example' };
const json = JSON.stringify;
const clone = value => structuredClone(value);
const link = (localKey, id, extras = {}) => ({ issuer, subject: 'existing-person', [localKey]: id, ...extras });
const nativeReceipt = (localId, extras = {}) => ({ issuer, subject: identity.subject, localId, owned: true, ...extras });
function fixture(components) {
  const localIds = Object.fromEntries(['magnus', 'emberpath', 'hivemem', 'hiveskills', 'cindertrace', 'chattermost', 'ardentstudio']
    .map((name, index) => [name, String(index + 1).repeat(26)]));
  const magnus = json([link('localUserId', 'existing-magnus', { role: 'ADMIN' }),
    { issuer, subject: 'ardentstudio-magnus', localUserId: 'ardentstudio', role: 'ARDENT_SERVICE' }]);
  const grants = json([{ subject: 'existing-person', kind: 'operator', permissions: ['read', 'policy'],
    scope: { installationId: 'example-installation', applicationIds: ['existing-app'], targetIds: [] } },
  { subject: 'embermend-coordinator', kind: 'coordinator', permissions: ['read'],
    scope: { installationId: 'example-installation', applicationIds: [], targetIds: [] } }]);
  const environments = {
    magnus: { OATHWEAVE_ISSUER: issuer, MAGNUS_OATHWEAVE_IDENTITIES_JSON: magnus, API_SECRET: 'fixture-only-unchanged-secret', TERMINAL_POLICY: 'unchanged' },
    'magnus-gateway': { OATHWEAVE_ISSUER: issuer, MAGNUS_OATHWEAVE_IDENTITIES_JSON: magnus, FLEET_GATEWAY_SSH_USERNAME: 'restricted-terminal' },
    emberpath: { OATHWEAVE_ISSUER: issuer, EMBERPATH_OATHWEAVE_IDENTITIES_JSON: json([link('localId', 'existing-model-account')]),
      HIVE_ROUTER_ADMIN_USERS: 'operator', EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON: json([{ username: 'operator', localId: 'existing-model-account' }]), ROUTER_SECRET: 'fixture-router-unchanged' },
    hivemem: { OATHWEAVE_ISSUER: issuer, HIVEMEM_OATHWEAVE_IDENTITIES_JSON: json([link('localId', 'existing-memory', { credentialGeneration: 3 })]),
      HIVEMEM_OATHWEAVE_SERVICES_JSON: ' [{"issuer":"native-fixture","clientId":"magnus-memory","localId":"magnus-memory","scopes":["workspaces:write"]}] ' },
    hiveskills: { OATHWEAVE_ISSUER: issuer, HIVESKILLS_OATHWEAVE_IDENTITIES_JSON: json([link('localId', 'operator')]), HIVE_SKILLS_ADMIN_USERS: 'operator' },
    cindertrace: { OATHWEAVE_ISSUER: issuer, CINDERTRACE_OATHWEAVE_IDENTITIES_JSON: json([link('localUserId', 'existing-security', { role: 'VIEWER' })]), DASHBOARD_ADMIN_ACCOUNT_ID: 'unchanged-breakglass' },
    chattermost: { OATHWEAVE_ISSUER: issuer, OATHWEAVE_CHAT_IDENTITIES_JSON: json([link('localUserId', 'existing-chat')]), ADMIN_INITIAL_ID: 'unchanged-seed-chat' },
    ardentstudio: { OATHWEAVE_ISSUER: issuer, ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON: json([link('localUserId', 'existing-studio', { permissions: ['ardentstudio:projects:read'] })]), ARDENT_STUDIO_MAGNUS_SCOPE: 'magnus:ardent' },
    embermend: { OATHWEAVE_ISSUER: issuer, EMBERMEND_IDENTITY_GRANTS: grants },
    'embermend-worker': { OATHWEAVE_ISSUER: issuer, EMBERMEND_IDENTITY_GRANTS: grants },
    oathweave: { IAM_MACHINE_CLIENT_POLICIES: '{"fixture-service":{"permissions":["limited:read"]}}' },
    hivexui: { CONSOLE_CONFIGURATION: 'unchanged' },
  };
  return { identity: clone(identity), installation: 'example-installation', localIds, environments,
    components: components ?? Object.keys(environments), nativeReceipts: {
      hivemem: nativeReceipt(localIds.hivemem, { active: true, credentialGeneration: 0 }),
      chattermost: nativeReceipt(localIds.chattermost),
    } };
}
function refusal(input, code) {
  assert.throws(() => planAdminAccess(input), error => error.code === code);
}

test('plans every selected console account with distinct IDs and leaves native provisioning to the owner', () => {
  const input = fixture(), before = clone(input), result = planAdminAccess(input);
  assert.deepEqual(input, before);
  for (const [product, key, field] of [
    ['magnus', 'MAGNUS_OATHWEAVE_IDENTITIES_JSON', 'localUserId'],
    ['emberpath', 'EMBERPATH_OATHWEAVE_IDENTITIES_JSON', 'localId'],
    ['hivemem', 'HIVEMEM_OATHWEAVE_IDENTITIES_JSON', 'localId'],
    ['hiveskills', 'HIVESKILLS_OATHWEAVE_IDENTITIES_JSON', 'localId'],
    ['cindertrace', 'CINDERTRACE_OATHWEAVE_IDENTITIES_JSON', 'localUserId'],
    ['chattermost', 'OATHWEAVE_CHAT_IDENTITIES_JSON', 'localUserId'],
    ['ardentstudio', 'ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON', 'localUserId'],
  ]) {
    const rows = JSON.parse(result.environments[product][key]);
    assert.equal(rows.at(-1)[field], input.localIds[product]);
    assert.equal(rows.at(-1).issuer, issuer); assert.equal(rows.at(-1).subject, identity.subject);
    assert.deepEqual(rows.slice(0, -1), JSON.parse(input.environments[product][key]));
  }
  assert.equal(JSON.parse(result.environments.hivemem.HIVEMEM_OATHWEAVE_IDENTITIES_JSON).at(-1).credentialGeneration, 0);
  assert.equal(JSON.parse(result.environments.cindertrace.CINDERTRACE_OATHWEAVE_IDENTITIES_JSON).at(-1).role, 'ADMIN');
  assert.equal(result.environments.emberpath.HIVE_ROUTER_ADMIN_USERS, 'operator,alice');
  assert.deepEqual(JSON.parse(result.environments.emberpath.EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON).at(-1), { username: 'alice', localId: input.localIds.emberpath });
  assert.equal(result.environments.hiveskills.HIVE_SKILLS_ADMIN_USERS, 'operator,' + input.localIds.hiveskills);
  assert.deepEqual(JSON.parse(result.environments.ardentstudio.ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON).at(-1), {
    issuer, subject: identity.subject, localUserId: input.localIds.ardentstudio, displayName: identity.displayName,
  });
  assert(result.changes.length > 0);
});

test('exact retry is a byte-preserving no-op, including changed JSON formatting', () => {
  const input = fixture();
  const raw = ' [\n  { "issuer" : ' + json(issuer) + ', "subject": "existing-person", "localId":"operator" }\n] \n';
  input.environments.hiveskills.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON = raw;
  const first = planAdminAccess(input);
  assert(first.environments.hiveskills.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON.startsWith(raw.slice(0, raw.lastIndexOf(']'))));
  const second = planAdminAccess({ ...input, environments: first.environments });
  assert.deepEqual(second.changes, []); assert.deepEqual(second.environments, first.environments);
});

test('service users, terminal policy, unrelated environments and native seed identities stay byte-exact', () => {
  const input = fixture(), output = planAdminAccess(input);
  const changed = new Set(output.changes.map(change => json([change.component, change.key])));
  for (const [component, env] of Object.entries(input.environments)) for (const [key, value] of Object.entries(env))
    if (!changed.has(json([component, key]))) assert.equal(output.environments[component][key], value);
  assert(!output.changes.some(change => /TOKEN|SECRET|PASSWORD|TERMINAL|SCOPE|MACHINE/.test(change.key)));
});

test('Magnus server and gateway receive identical person and service maps', () => {
  const input = fixture(), result = planAdminAccess(input);
  assert.equal(result.environments.magnus.MAGNUS_OATHWEAVE_IDENTITIES_JSON,
    result.environments['magnus-gateway'].MAGNUS_OATHWEAVE_IDENTITIES_JSON);
  input.environments['magnus-gateway'].MAGNUS_OATHWEAVE_IDENTITIES_JSON = '[]';
  refusal(input, 'ADMIN_ACCESS_PAIRED_POLICY_MISMATCH');
});

test('Embermend API and worker receive initializer permissions and no application, target or execution grant', () => {
  const input = fixture(), result = planAdminAccess(input);
  const api = result.environments.embermend.EMBERMEND_IDENTITY_GRANTS;
  assert.equal(api, result.environments['embermend-worker'].EMBERMEND_IDENTITY_GRANTS);
  assert.deepEqual(JSON.parse(api).at(-1), { subject: identity.subject, kind: 'operator',
    permissions: [...EMBERMEND_ADMIN_PERMISSIONS], scope: { installationId: input.installation, applicationIds: [], targetIds: [] } });
  assert(!EMBERMEND_ADMIN_PERMISSIONS.some(permission => /execute|approve|dispatch|remediat/.test(permission)));
  input.environments['embermend-worker'].EMBERMEND_IDENTITY_GRANTS = '[]';
  refusal(input, 'ADMIN_ACCESS_PAIRED_POLICY_MISMATCH');
});

test('a selected paired worker or gateway cannot be updated without its owning API', () => {
  for (const product of ['magnus-gateway', 'embermend-worker']) refusal(fixture([product]), 'ADMIN_ACCESS_PAIRED_COMPONENT_REQUIRED');
});

test('refuses duplicate issuer/subject entries and does not merge by display name or email', () => {
  const input = fixture(['hiveskills']);
  const entry = link('localId', 'operator');
  input.environments.hiveskills.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON = json([entry, entry]);
  refusal(input, 'ADMIN_ACCESS_IDENTITY_DUPLICATE');
  const distinct = fixture(['hiveskills']); distinct.identity.displayName = 'existing-person';
  const result = planAdminAccess(distinct);
  assert.equal(JSON.parse(result.environments.hiveskills.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON).length, 2);
});

test('same subject from another issuer cannot reuse a native product account', () => {
  const input = fixture(['hiveskills']);
  input.environments.hiveskills.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON = json([
    { issuer: 'https://other.example.com', subject: identity.subject, localId: input.localIds.hiveskills },
  ]);
  refusal(input, 'ADMIN_ACCESS_LOCAL_ID_REUSED');
});

test('refuses cross-subject local ID reuse and duplicate native IDs', () => {
  const input = fixture(['hiveskills']);
  input.environments.hiveskills.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON = json([link('localId', input.localIds.hiveskills)]);
  refusal(input, 'ADMIN_ACCESS_LOCAL_ID_REUSED');
  const duplicate = fixture(['hiveskills']); duplicate.localIds.hiveskills = duplicate.localIds.magnus;
  refusal(duplicate, 'ADMIN_ACCESS_LOCAL_ID_REUSED');
  const existing = fixture(['hiveskills']); existing.environments.hiveskills.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON = json([
    link('localId', 'operator'), { issuer, subject: 'another-person', localId: 'operator' },
  ]); refusal(existing, 'ADMIN_ACCESS_LOCAL_ID_REUSED');
});

test('refuses overwriting an existing lower role, permission ceiling, native ID or generation', () => {
  for (const [product, key, extra] of [
    ['magnus', 'MAGNUS_OATHWEAVE_IDENTITIES_JSON', { role: 'VIEWER' }],
    ['ardentstudio', 'ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON', { displayName: identity.displayName, permissions: ['ardentstudio:projects:read'] }],
    ['hivemem', 'HIVEMEM_OATHWEAVE_IDENTITIES_JSON', { credentialGeneration: 1 }],
  ]) {
    const input = fixture([product]), localKey = product === 'hivemem' ? 'localId' : 'localUserId';
    input.environments[product][key] = json([{ issuer, subject: identity.subject, [localKey]: input.localIds[product], ...extra }]);
    refusal(input, 'ADMIN_ACCESS_EXISTING_POLICY_CONFLICT');
  }
  const foreign = fixture(['hiveskills']); foreign.environments.hiveskills.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON = json([
    { issuer, subject: identity.subject, localId: 'different-existing-id' },
  ]); refusal(foreign, 'ADMIN_ACCESS_EXISTING_POLICY_CONFLICT');
});

test('refuses widening an existing Embermend policy or adopting its coordinator subject', () => {
  for (const kind of ['operator', 'coordinator']) {
    const input = fixture(['embermend']);
    input.environments.embermend.EMBERMEND_IDENTITY_GRANTS = json([{ subject: identity.subject, kind,
      permissions: ['read'], scope: { installationId: input.installation, applicationIds: ['reviewed-app'], targetIds: [] } }]);
    refusal(input, 'ADMIN_ACCESS_EXISTING_POLICY_CONFLICT');
  }
});

test('native receipt is mandatory, owned and bound to the exact human identity and local ID', () => {
  for (const product of ['hivemem', 'chattermost']) {
    for (const change of [{ owned: false }, { issuer: 'https://other.example.com' }, { subject: 'foreign-user' }, { localId: 'foreign-account' }]) {
      const input = fixture([product]); Object.assign(input.nativeReceipts[product], change);
      refusal(input, 'ADMIN_ACCESS_NATIVE_RECEIPT_REQUIRED');
    }
    const missing = fixture([product]); delete missing.nativeReceipts[product];
    refusal(missing, 'ADMIN_ACCESS_NATIVE_RECEIPT_REQUIRED');
  }
});

test('disabled or rotated memory principals cannot be reactivated by setup', () => {
  for (const extra of [{ active: false }, { credentialGeneration: 1 }, { credentialGeneration: '0' }]) {
    const input = fixture(['hivemem']); Object.assign(input.nativeReceipts.hivemem, extra);
    refusal(input, 'ADMIN_ACCESS_NATIVE_RECEIPT_REQUIRED');
  }
});

test('unselected native products need no receipt and no environment or grant changes', () => {
  const input = fixture(['hiveskills']); input.nativeReceipts = {};
  const result = planAdminAccess(input);
  assert.deepEqual(result.environments.hivemem, input.environments.hivemem);
  assert.deepEqual(result.environments.chattermost, input.environments.chattermost);
  assert(result.changes.every(change => change.component === 'hiveskills'));
});

test('refuses Emberpath username/ID conflicts and preserves existing native accounts', () => {
  for (const entry of [{ username: 'alice', localId: 'foreign-model-account' }, { username: 'operator', localId: '22222222222222222222222222' }]) {
    const input = fixture(['emberpath']); input.environments.emberpath.EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON = json([entry]);
    assert.throws(() => planAdminAccess(input), error => ['ADMIN_ACCESS_EXISTING_POLICY_CONFLICT', 'ADMIN_ACCESS_LOCAL_ID_REUSED'].includes(error.code));
  }
});

test('rejects ambiguous allowlists, duplicate initial accounts and unknown identity keys', () => {
  const input = fixture(['hiveskills']); input.environments.hiveskills.HIVE_SKILLS_ADMIN_USERS = 'operator,operator';
  refusal(input, 'ADMIN_ACCESS_POLICY_INVALID');
  const unknown = fixture(['hiveskills']); unknown.environments.hiveskills.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON = json([
    { ...link('localId', 'operator'), grantAll: true },
  ]); refusal(unknown, 'ADMIN_ACCESS_POLICY_INVALID');
  const duplicate = fixture(['emberpath']); const raw = duplicate.environments.emberpath.EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON;
  duplicate.environments.emberpath.EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON = json([...JSON.parse(raw), ...JSON.parse(raw)]);
  refusal(duplicate, 'ADMIN_ACCESS_IDENTITY_DUPLICATE');
});

test('refuses repeated JSON object keys, including escaped spellings and nested scopes', () => {
  const input = fixture(['hiveskills']); input.environments.hiveskills.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON =
    '[{"issuer":' + json(issuer) + ',"subject":"existing-person","\\u0073ubject":"new-person","localId":"operator"}]';
  refusal(input, 'ADMIN_ACCESS_POLICY_DUPLICATE');
  const nested = fixture(['embermend']); nested.environments.embermend.EMBERMEND_IDENTITY_GRANTS =
    '[{"subject":"existing-person","kind":"operator","permissions":["read"],"scope":{"installationId":"one","installationId":"two","applicationIds":[],"targetIds":[]}}]';
  refusal(nested, 'ADMIN_ACCESS_POLICY_DUPLICATE');
});

test('requires exact configured issuer and refuses missing policy inputs rather than assuming empty maps', () => {
  const issuerDrift = fixture(['hiveskills']); issuerDrift.environments.hiveskills.OATHWEAVE_ISSUER += '/';
  refusal(issuerDrift, 'ADMIN_ACCESS_ISSUER_MISMATCH');
  const missing = fixture(['hiveskills']); delete missing.environments.hiveskills.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON;
  refusal(missing, 'ADMIN_ACCESS_POLICY_INVALID');
});

test('Emberpath startup definitions must remain within the allowlist and native parser capacity', () => {
  const input = fixture(['emberpath']); input.environments.emberpath.HIVE_ROUTER_ADMIN_USERS = '';
  refusal(input, 'ADMIN_ACCESS_POLICY_INVALID');
  const full = fixture(['emberpath']);
  full.environments.emberpath.EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON = json(Array.from({ length: 100 }, (_, i) => ({ username: 'user' + i, localId: 'account-' + String(i).padStart(16, '0') })));
  full.environments.emberpath.HIVE_ROUTER_ADMIN_USERS = Array.from({ length: 100 }, (_, i) => 'user' + i).join(',');
  refusal(full, 'ADMIN_ACCESS_POLICY_INVALID');
});

test('validates exact request fields, HTTPS issuer, bounded input and product-specific IDs', () => {
  for (const change of [{ issuer: 'http://identity.example.com' }, { issuer: 'https://user:pass@identity.example.com' },
    { issuer: issuer + '?' }, { username: 'alice\nADMIN=true' }, { displayName: 'x'.repeat(121) },
    { email: 'not-an-email' }, { subject: '' }, { unknown: true }]) assert.throws(() => validateIdentity({ ...identity, ...change }));
  for (const mutate of [x => { x.unknown = true; }, x => { x.components.push('not-a-product'); },
    x => { x.localIds.hivemem = 'TOO-LONG-OR-UPPERCASE-IDENTITY'; },
    x => { x.localIds.magnus = 'service:forbidden'; }, x => { x.environments.magnus.EXTRA = 'x'.repeat(1024 * 1024 + 1); }]) {
    const input = fixture(); mutate(input); assert.throws(() => planAdminAccess(input));
  }
});

test('stdin transport reports bounded generic codes without input secrets on refusal', async () => {
  let output = ''; const code = await adminAccessDataCLI(Readable.from(['{"secret":"fixture-never-echo-this"}']), { write: value => { output += value; } });
  assert.equal(code, 1); assert(!output.includes('fixture-never-echo-this'));
  assert.match(JSON.parse(output).error.code, /^ADMIN_ACCESS_[A-Z_]+$/);
});

test('eval stdin entry point executes the same plan while normal imports stay pure', () => {
  const source = readFileSync(new URL('./admin-access-data.mjs', import.meta.url), 'utf8');
  const input = fixture(['hiveskills']);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, '--', '--stdin'], { input: json(input), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), planAdminAccess(input));
});

test('direct stdin entry point and split Unicode input preserve identity labels', async () => {
  const input = fixture(['ardentstudio']); input.identity.displayName = 'Alice \u00c9xample';
  const raw = Buffer.from(json(input)), boundary = raw.indexOf(Buffer.from('\u00c9')) + 1;
  let output = '';
  const code = await adminAccessDataCLI(Readable.from([raw.subarray(0, boundary), raw.subarray(boundary)]), { write: value => { output += value; } });
  assert.equal(code, 0); assert.deepEqual(JSON.parse(output), planAdminAccess(input));
  const result = spawnSync(process.execPath, [new URL('./admin-access-data.mjs', import.meta.url).pathname, '--stdin'], { input: json(input), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), planAdminAccess(input));
});

// Preview validates existing policies before any account is created, and cannot be mistaken for publication proof.
test('preview checks all existing grants without claiming native ownership', () => {
  const input = fixture(); delete input.nativeReceipts;
  assert.throws(() => planAdminAccess(input));
  assert.equal(planAdminAccess(input, { preview: true }).nativeProvisioningVerified, false);
  input.environments.magnus.MAGNUS_OATHWEAVE_IDENTITIES_JSON = 'not-json';
  assert.throws(() => planAdminAccess(input, { preview: true }));
});

test('valid IAM names that differ from native username rules get a separate stable model account name', () => {
  for (const username of ['-alice', '2alice']) {
    const input = fixture(); input.identity.username = username;
    const planned = planAdminAccess(input);
    const nativeName = 'hive_admin_' + input.localIds.emberpath;
    assert.equal(JSON.parse(planned.environments.emberpath.EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON).at(-1).username, nativeName);
    assert(planned.environments.emberpath.HIVE_ROUTER_ADMIN_USERS.split(',').includes(nativeName));
    assert.deepEqual(planAdminAccess({ ...input, environments: planned.environments }).changes, []);
  }
});
