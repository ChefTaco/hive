// Disposable acceptance against real product containers and protected SSO tokens.
// No live installation, external model service or existing account is selected.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
export async function rehearseEnrollment({ output, origin, tokens, certificate, disposable }) {
  assert.equal(disposable, true, 'Enrollment acceptance requires an explicitly disposable installation');
  const ca = readFileSync(certificate);
  async function request(path, { body, token = tokens.oathweave, method = body ? 'POST' : 'GET' } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = httpsRequest(new URL(origin + path), { ca, rejectUnauthorized: true, method, signal: AbortSignal.timeout(20_000), headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, incoming => {
        let raw = ''; incoming.on('data', chunk => { raw += chunk; if (raw.length > 1024 * 1024) incoming.destroy(Error('Bounded acceptance response exceeded')); });
        incoming.on('error', reject); incoming.on('end', () => { try { resolve({ status: incoming.statusCode, headers: incoming.headers, body: raw ? JSON.parse(raw) : null }); } catch { reject(Error('Product acceptance returned an invalid JSON contract')); } });
      });
      outgoing.on('error', reject); outgoing.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const client = await request('/api/oathweave/clients', { body: { name: 'synthetic-enrollment-client', clientType: 'confidential', secret: randomBytes(32).toString('base64url'), grantTypes: ['client_credentials'] } });
  assert.equal(client.status, 201, 'Disposable enrollment client creation failed');
  const policy = { agentId: 'synthetic-enrolled-agent', displayName: 'Synthetic Enrolled Agent', iamClientId: client.body.client.id, roleIds: [], scopes: ['memories:read', 'memories:write', 'sessions:read', 'sessions:write', 'context:read'], workspaceId: 'default', expiresHours: 1, description: 'Disposable coordinated acceptance' };
  assert.equal((await request('/api/oathweave/enrollments', { body: policy, token: tokens.emberpath })).status, 401, 'Foreign-audience resource token reached the coordinator');
  assert.equal((await request('/api/oathweave/enrollments', { body: { ...policy, scopes: ['admin:all'] } })).status, 400, 'Administrative agent scope was accepted');
  const created = await request('/api/oathweave/enrollments', { body: policy });
  assert.equal(created.status, 201, 'Durable multi-product enrollment failed; inspect product health and scoped permissions');
  assert.equal(created.body.ok, true);
  assert.equal(created.headers['cache-control'], 'no-store');
  for (const key of ['iamApiKey', 'routerApiKey', 'memoryToken']) assert.equal(typeof created.body.secrets[key], 'string');
  const first = created.body;
  const replay = await request('/api/oathweave/enrollments', { body: policy });
  assert.equal(replay.status, 201); assert.deepEqual(replay.body.secrets, first.secrets); assert.deepEqual(replay.body.identifiers, first.identifiers); assert.equal(replay.body.receiptExpiresAt, first.receiptExpiresAt);
  const inventory = await request('/api/oathweave/enrollments'); assert.equal(inventory.status, 200); assert.equal(inventory.body.data.filter(actor => actor.id === policy.agentId).length, 1); assert(!JSON.stringify(inventory.body).includes(first.secrets.routerApiKey));
  assert.equal((await request('/api/oathweave/enrollments', { body: { ...policy, expiresHours: 2 } })).status, 409, 'Changed enrollment policy was silently adopted');
  const claims = JSON.parse(Buffer.from(first.secrets.memoryToken.split('.')[1], 'base64url').toString());
  assert.equal(claims.sub, policy.agentId); assert.equal(claims.role, 'agent'); assert.deepEqual(claims.workspace_ids, ['default']); assert(!claims.scope.includes('*') && !claims.scope.includes('admin:'));
  const memory = await request('/memory/v1/memories', { token: first.secrets.memoryToken, body: { content: 'Synthetic coordinated identity memory acceptance', scope: 'private', type: 'semantic', workspace_id: 'default' } });
  assert.equal(memory.status, 201, 'Enrolled native Memory credential could not store its own memory');
  assert.equal(typeof memory.body.id, 'string');
  const memoryPath = '/memory/v1/memories/' + encodeURIComponent(memory.body.id);
  const model = { model: 'synthetic-external-alias', messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 8, stream: false };
  assert.equal((await request('/v1/chat/completions', { token: first.secrets.routerApiKey, body: model })).status, 200, 'Enrolled native model credential failed external inference');
  assert.equal((await request('/api/hivemem/agents/register', { token: first.secrets.memoryToken, body: { agent_id: 'forbidden-enrollment', display_name: 'Forbidden' } })).status, 403);
  assert.equal((await request('/api/emberpath/providers', { token: first.secrets.routerApiKey })).status, 401);
  const operationId = randomUUID();
  const rotated = await request(`/api/oathweave/enrollments/${policy.agentId}/rotate`, { body: { operationId } });
  assert.equal(rotated.status, 200, 'Durable credential rotation failed'); assert.equal(rotated.body.ok, true);
  for (const key of ['iamApiKey', 'routerApiKey', 'memoryToken']) assert.notEqual(rotated.body.secrets[key], first.secrets[key]);
  assert.deepEqual(rotated.body.identifiers, first.identifiers);
  const rotateReplay = await request(`/api/oathweave/enrollments/${policy.agentId}/rotate`, { body: { operationId } }); assert.deepEqual(rotateReplay.body.secrets, rotated.body.secrets);
  const rotatedClaims = JSON.parse(Buffer.from(rotated.body.secrets.memoryToken.split('.')[1], 'base64url').toString()); assert.equal(rotatedClaims.exp, claims.exp, 'Rotation extended the original credential deadline');
  assert([401, 403].includes((await request(memoryPath, { token: first.secrets.memoryToken })).status));
  assert.equal((await request('/v1/chat/completions', { token: first.secrets.routerApiKey, body: model })).status, 401);
  const retainedMemory = await request(memoryPath, { token: rotated.body.secrets.memoryToken });
  assert.equal(retainedMemory.status, 200);
  assert.equal(retainedMemory.body.content, memory.body.content);
  assert.equal(retainedMemory.body.agent_id, policy.agentId);
  assert.equal(retainedMemory.body.workspace_id, 'default');
  const acknowledgement = await request(`/api/oathweave/enrollments/${policy.agentId}/operations/${operationId}/receipt`, { method: 'DELETE' }); assert.equal(acknowledgement.status, 200);
  assert.equal((await request(`/api/oathweave/enrollments/${policy.agentId}/rotate`, { body: { operationId } })).status, 410, 'Acknowledged operation reissued credentials');
  const disabled = await request(`/api/oathweave/enrollments/${policy.agentId}/disable`, { body: { operationId: randomUUID() } }); assert.equal(disabled.status, 200); assert.equal(disabled.body.ok, true);
  assert([401, 403].includes((await request(memoryPath, { token: rotated.body.secrets.memoryToken })).status));
  assert.equal((await request('/v1/chat/completions', { token: rotated.body.secrets.routerApiKey, body: model })).status, 401);
  const finalInventory = await request('/api/oathweave/enrollments'); const actor = finalInventory.body.data.find(item => item.id === policy.agentId); assert.equal(actor.status, 'inactive'); assert.deepEqual(actor.identifiers, first.identifiers);
  const result = { schema: 1, result: 'passed', productionCutover: false, checks: ['owned Oathweave coordinator with foreign-audience rejection', 'explicit non-admin agent policy and immutable expiry', 'exact retry preserves all three product IDs and credentials', 'scoped native model and memory acceptance through separate endpoints', 'rotation revokes prior generations without changing original expiry', 'receipt acknowledgement prevents accidental reissuance', 'explicit containment disables all recorded resources without deleting identities'], limitations: ['disposable core on one physical host', 'developer external inference protocol fixture', 'legacy ownership and production authentication remain separate migration gates'] };
  const path = join(output, 'enrollment-result.json'); writeFileSync(path, JSON.stringify(result, null, 2), { mode: 0o600 }); chmodSync(path, 0o600);
}
