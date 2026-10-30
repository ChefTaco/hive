import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createHiveMemServer } from '../src/server.js';
import { signToken } from '../src/auth.js';
import { InMemoryHiveMemStore } from '../src/store.js';

test('scoped renewal grants mint bounded access tokens without admin scope', async () => {
  const jwtSecret = randomBytes(32).toString('hex');
  const renewalSecret = randomBytes(32).toString('hex');
  const store = new InMemoryHiveMemStore();
  const admin = signToken(jwtSecret, { sub: 'operator', role: 'admin', scope: 'admin:all', exp: Math.floor(Date.now() / 1000) + 600 });
  const server = createHiveMemServer({ jwtSecret, renewalSecret, store });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const issue = (body: unknown) => fetch(url + '/v1/auth/renewal-grants', {
      method: 'POST', headers: { authorization: 'Bearer ' + admin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await issue({ agent_id: 'actor' })).status, 422);
    assert.equal((await issue({ agent_id: 'actor', scopes: ['admin:all'] })).status, 422);
    const issued = await issue({ agent_id: 'actor', scopes: ['memories:read'], workspace_ids: ['actor:private'] });
    assert.equal(issued.status, 201);
    const { grant } = await issued.json() as { grant: string };
    const redeem = (token: string) => fetch(url + '/v1/auth/renew', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    assert.equal((await redeem(admin)).status, 401);
    const renewed = await redeem(grant);
    assert.equal(renewed.status, 200);
    const { token } = await renewed.json() as { token: string };
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    assert.equal(claims.sub, 'actor');
    assert.equal(claims.scope, 'memories:read');
    assert.deepEqual(claims.workspace_ids, ['actor:private']);
    assert.ok(claims.exp - Math.floor(Date.now() / 1000) <= 30 * 86400);
    assert.equal((await fetch(url + '/v1/auth/me', { headers: { authorization: 'Bearer ' + token } })).status, 200);
    store.rotateAgentCredentials({ agentId: 'operator', scopes: ['*'], rawClaims: { role: 'admin' } }, 'actor');
    assert.equal((await redeem(grant)).status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
