import assert from 'node:assert/strict';
import test from 'node:test';
import { administratorIdentity, adminAccessIdentity } from './admin-access-identity.mjs';
import { createHash } from 'node:crypto';
import { nativeAdminRequest, validateNativeAdminReceipt } from './admin-access-native.mjs';
const operationId = '11111111-2222-4333-8444-555555555555';
const issuer = 'https://hive.example.com/api/oathweave';
const person = () => ({ id: 'human-123', username: 'alice', email: 'alice@example.com', displayName: "Alice O'Neill $HOME", active: true, lockedUntil: null, roles: [{ role: { name: 'IAM_ADMIN' } }] });
function store(user = person()) {
  const changes = [], audits = [];
  const db = { user: { findUnique: async ({ where }) => where.username === user?.username ? user : null, findMany: async () => [user].filter(Boolean) },
    auditEvent: { create: async ({ data }) => { audits.push(data); return data; } },
    role: { findUnique: async () => ({ id: 'suite-role', name: 'SUITE_ADMIN', permissions: '[]' }) },
    userRoleAssignment: { findUnique: async () => changes.at(-1) || null, create: async ({ data }) => { changes.push(data); return data; } } };
  db.$transaction = operation => operation(db);
  return { db, changes, audits };
}
test('exact active human resolution omits credentials and keeps ordinary display names', async () => {
  const { db, changes } = store(); const result = await adminAccessIdentity({ mode: 'resolve', username: 'alice' }, db, issuer);
  assert.deepEqual(result.identity, { issuer, subject: 'human-123', username: 'alice', email: 'alice@example.com', displayName: "Alice O'Neill $HOME" });
  assert.equal((await adminAccessIdentity({ mode: 'list' }, db, issuer)).administrators.length, 1); assert.deepEqual(changes, []);
  await assert.rejects(adminAccessIdentity({ mode: 'resolve', username: 'Alice' }, db, issuer), /ACCOUNT_UNAVAILABLE/);
});
test('inactive, locked, deleted and ordinary accounts cannot receive administrator grants', async () => {
  for (const user of [null, { ...person(), active: false }, { ...person(), lockedUntil: new Date(Date.now() + 60000).toISOString() }, { ...person(), roles: [{ role: { name: 'VIEWER' } }] }]) {
    const { db, changes } = store(user); await assert.rejects(adminAccessIdentity({ mode: 'grant', operationId, username: 'alice', identity: {} }, db, issuer), /ACCOUNT_UNAVAILABLE/); assert.deepEqual(changes, []);
  }
});
test('one exact Suite Administrator assignment is idempotent; identity changes hold before writing', async () => {
  const user = person(), { db, changes } = store(user), identity = administratorIdentity(user, issuer);
  assert.equal((await adminAccessIdentity({ mode: 'grant', operationId, username: 'alice', identity }, db, issuer)).assignmentAdded, true);
  assert.equal((await adminAccessIdentity({ mode: 'grant', operationId, username: 'alice', identity }, db, issuer)).assignmentAdded, false);
  assert.deepEqual(changes, [{ userId: identity.subject, roleId: 'suite-role', grantedBy: 'hive-admin-access:' + operationId }]);
  user.email = 'other@example.com'; await assert.rejects(adminAccessIdentity({ mode: 'grant', operationId, username: 'alice', identity }, db, issuer), /ACCOUNT_CHANGED/); assert.equal(changes.length, 1);
});
test('missing Suite role and malformed issuer refuse without broadening any role policy', async () => {
  const { db, changes } = store(); const identity = administratorIdentity(person(), issuer); db.role.findUnique = async () => null;
  await assert.rejects(adminAccessIdentity({ mode: 'grant', operationId, username: 'alice', identity }, db, issuer), /ROLE_MISSING/);
  assert.throws(() => administratorIdentity(person(), 'http://hive.example.com/api/oathweave'), /ISSUER_INVALID/); assert.deepEqual(changes, []);
});
test('native maintenance transport is TLS-verified loopback with an independent purpose credential', () => {
  const input = { component: 'hivemem', method: 'POST', operationId: '11111111-2222-4333-8444-555555555555', serverName: 'hivemem' };
  const environment = { HIVEMEM_TS_CORE_PORT: '18790', HIVE_ADMIN_PROVISIONING_SECRET: 'a'.repeat(64) };
  const request = nativeAdminRequest(input, environment, path => { assert.equal(path, '/config/authority.pem'); return 'fake-test-ca'; });
  assert.equal(request.hostname, '127.0.0.1'); assert.equal(request.servername, 'hivemem'); assert.equal(request.rejectUnauthorized, true); assert.equal(request.agent, false);
  assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
  assert.equal(request.headers['x-hive-admin-provisioning-secret'], environment.HIVE_ADMIN_PROVISIONING_SECRET);
  for (const bad of [{ ...input, component: 'magnus' }, { ...input, method: 'DELETE' }, { ...input, operationId: '../other' }, { ...input, serverName: 'evil.example.com/path' }]) assert.throws(() => nativeAdminRequest(bad, environment, () => 'fake-test-ca'));
  assert.throws(() => nativeAdminRequest(input, { ...environment, HIVE_ADMIN_PROVISIONING_SECRET: '' }, () => 'fake-test-ca'));
});

test('review reports existing terminal permissions without widening a role policy', async () => {
  const { db, changes } = store();
  db.role.findUnique = async () => ({ id: 'suite-role', name: 'SUITE_ADMIN', permissions: '["magnus:admin","magnus:terminal"]' });
  const result = await adminAccessIdentity({ mode: 'resolve', username: 'alice' }, db, issuer);
  assert.equal(result.terminalPermissionAfterSetup, true); assert.deepEqual(changes, []);
});

test('native ownership proof binds the complete canonical request and product timestamp format', () => {
  const operationId = '11111111-2222-4333-8444-555555555555';
  const body = { version: 1, issuer, subject: 'human-123', local_id: 'a'.repeat(26), username: '_alice', display_name: "Alice O'Neill" };
  const memory = { schema: 1, operation_id: operationId, issuer, subject: body.subject, local_id: body.local_id, username: body.username,
    display_name: body.display_name, active: true, credential_generation: 0, status: 'committed', created_at: '2026-01-01T00:00:00.000Z',
    request_sha256: createHash('sha256').update(JSON.stringify({ ...body, operation_id: operationId })).digest('hex') };
  const input = { component: 'hivemem', operationId, body };
  assert.equal(validateNativeAdminReceipt(input, memory).owned, true);
  for (const change of [{ display_name: 'Someone else' }, { credential_generation: 1 }, { active: false }, { request_sha256: 'f'.repeat(64) }, { subject: 'other-human' }])
    assert.throws(() => validateNativeAdminReceipt(input, { ...memory, ...change }), /RECEIPT_INVALID/);
  const chatBody = { version: 1, issuer, subject: body.subject, user_id: 'b'.repeat(26), username: '_alice', email: 'Alice@Example.com' };
  const canonical = { domain: 'chattermost.hive-admin-account.v1', ...chatBody, email: 'alice@example.com', role: 'system_admin system_user' };
  const chat = { schema: 1, operation_id: operationId, issuer, subject: body.subject, user_id: chatBody.user_id, username: chatBody.username, email: 'alice@example.com',
    role: 'system_admin system_user', status: 'committed', created_at: 1767225600000, request_sha256: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
  assert.equal(validateNativeAdminReceipt({ component: 'chattermost', operationId, body: chatBody }, chat).owned, true);
  assert.throws(() => validateNativeAdminReceipt({ component: 'chattermost', operationId, body: chatBody }, { ...chat, role: 'system_user' }), /RECEIPT_INVALID/);
});

test('new assignment and one installer audit commit together; exact retry adds no audit', async () => {
  const { db, audits } = store(), identity = administratorIdentity(person(), issuer);
  await adminAccessIdentity({ mode: 'grant', operationId, username: 'alice', identity }, db, issuer);
  await adminAccessIdentity({ mode: 'grant', operationId, username: 'alice', identity }, db, issuer);
  assert.equal(audits.length, 1); assert.equal(audits[0].actorType, 'SYSTEM');
  assert.equal(JSON.parse(audits[0].detail).operationId, operationId);
});

test('status can inspect a disabled former administrator without authorizing writes', async () => {
  const { db, changes } = store({ ...person(), active: false });
  const result = await adminAccessIdentity({ mode: 'status', username: 'alice' }, db, issuer);
  assert.equal(result.identity.subject, 'human-123'); assert.equal(result.eligible, false); assert.deepEqual(changes, []);
  await assert.rejects(adminAccessIdentity({ mode: 'grant', operationId, username: 'alice', identity: result.identity }, db, issuer), /ACCOUNT_UNAVAILABLE/);
});
