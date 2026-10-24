import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { InMemoryHiveMemStore, createHiveMemServer, signToken } from '../src/index.js';
import type { MemoryRecord } from '../src/types.js';

test('historical GET retains superseded and retired evidence with scoped ownership; DELETE cleans up historical originals', async () => {
  const secret = 'historical-test-secret-at-least-32-characters';
  const server = createHiveMemServer({ jwtSecret: secret, store: new InMemoryHiveMemStore() });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (owner:string,method:string,path:string,body?:unknown):Promise<Response> => fetch(base+path, {
    method, headers:{authorization:`Bearer ${signToken(secret,{sub:owner,scope:'memories:read memories:write',exp:Math.floor(Date.now()/1000)+3600})}`,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  try {
    const old=await (await request('alpha','POST','/v1/memories',{content:'original private belief',type:'episodic',scope:'private'})).json() as MemoryRecord;
    const replacement=await (await request('alpha','POST','/v1/memories',{content:'corrected private belief',type:'episodic',scope:'private',supersedes:old.id})).json() as MemoryRecord;
    assert.equal((await request('alpha','GET',`/v1/memories/${old.id}`)).status,404);
    const historical=await request('alpha','GET',`/v1/memories/${old.id}?include_history=true`);
    assert.equal(historical.status,200);
    assert.equal((await historical.json() as MemoryRecord).superseded_by,replacement.id);
    assert.equal((await request('beta','GET',`/v1/memories/${old.id}?include_history=true`)).status,404);
    assert.equal((await request('beta','DELETE',`/v1/memories/${old.id}`)).status,404);
    assert.equal((await request('alpha','DELETE',`/v1/memories/${old.id}`)).status,204);
    assert.equal((await request('alpha','GET',`/v1/memories/${old.id}?include_history=true`)).status,404);
    const shared=await (await request('alpha','POST','/v1/memories',{content:'retired shared lesson',type:'semantic',scope:'shared'})).json() as MemoryRecord;
    assert.equal((await request('alpha','PUT',`/v1/memories/${shared.id}`,{valid_to:'2020-01-01T00:00:00.000Z'})).status,200);
    assert.equal((await request('alpha','GET',`/v1/memories/${shared.id}`)).status,404);
    assert.equal((await request('beta','GET',`/v1/memories/${shared.id}?include_history=true`)).status,200);
    assert.equal((await request('beta','DELETE',`/v1/memories/${shared.id}`)).status,403);
    assert.equal((await request('alpha','DELETE',`/v1/memories/${shared.id}`)).status,204);
    assert.equal((await request('beta','GET',`/v1/memories/${shared.id}?include_history=true`)).status,404);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
