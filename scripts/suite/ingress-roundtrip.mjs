#!/usr/bin/env node
// Disposable transport acceptance; not an application authorization/parity test.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import https from 'node:https';
const caddyImage = process.env.HIVE_INGRESS_TEST_IMAGE || 'hive-ingress:candidate';
const nodeImage =
  'node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205';
const root = new URL('../..', import.meta.url).pathname;
const temporary = mkdtempSync(join(tmpdir(), 'hive-ingress-acceptance-'));
const network = 'hive-ingress-test-' + randomBytes(5).toString('hex');
const containers = [];
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = false;
try {
  mkdirSync(join(temporary, 'state'), { mode: 0o700 });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(temporary, 'console.key'),
      '-out',
      join(temporary, 'console.crt'),
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-days',
      '1',
    ],
    { stdio: 'ignore' },
  );
  writeFileSync(join(temporary, 'backend-ca.pem'), readFileSync(join(temporary, 'console.crt')), {
    mode: 0o600,
  });
  writeFileSync(join(temporary, 'Caddyfile'), readFileSync(join(root, 'deployment/Caddyfile')), {
    mode: 0o600,
  });
  writeFileSync(
    join(temporary, 'backend.cjs'),
    `
const https=require('https'),http=require('http'),fs=require('fs'),crypto=require('crypto');
const names=['__Host-oathweave_sso','iam_refresh','hive_router_admin','hivemem_dash','hive_skills_session','cindertrace_session','MMSID','MMUSERID','MMCSRF'];
const server=https.createServer({key:fs.readFileSync('/config/console.key'),cert:fs.readFileSync('/config/console.crt')},(req,res)=>{
 if(req.url==='/v1/stream'||req.url==='/api/v1/events/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: first\\n\\n');setTimeout(()=>res.end('data: last\\n\\n'),350);return;}
 res.setHeader('Set-Cookie',names.map(name=>name+'=obviously-fake-native; Path=/; Secure; HttpOnly'));
 res.setHeader('Content-Type','application/json');const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>res.end(JSON.stringify({path:req.url,method:req.method,authorization:req.headers.authorization,cookie:req.headers.cookie,origin:req.headers.origin,headers:req.headers,body:Buffer.concat(chunks).toString()})));
});
server.on('upgrade',(req,socket)=>{const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\nX-Fixture-Cookie: '+req.headers.cookie+'\\r\\n\\r\\n');socket.write(Buffer.from([129,2,111,107]));setTimeout(()=>socket.destroy(),2000);});
server.listen(9443,'0.0.0.0');
const plain=http.createServer((req,res)=>{res.setHeader('Set-Cookie','MMSID=obviously-fake-forged');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({path:req.url,authorization:req.headers.authorization,cookie:req.headers.cookie,origin:req.headers.origin}));});
plain.listen(8096,'0.0.0.0');
const registry=http.createServer((req,res)=>{res.setHeader('Set-Cookie','hive_registry_forged=obviously-fake; Path=/');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({path:req.url,method:req.method,authorization:req.headers.authorization,cookie:req.headers.cookie,origin:req.headers.origin}));});
registry.listen(8095,'0.0.0.0');
`,
    { mode: 0o600 },
  );
  docker('network', 'create', network);
  const user = `${process.getuid()}:${process.getgid()}`;
  const restrictions = [
    '--user',
    user,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp',
  ];
  const backend = network + '-backend';
  containers.push(backend);
  docker(
    'run',
    '-d',
    '--name',
    backend,
    '--network',
    network,
    '--network-alias',
    'backend',
    '--network-alias',
    'emberfold',
    '--network-alias',
    'hive-registry',
    ...restrictions,
    '-v',
    `${temporary}:/config:ro`,
    nodeImage,
    'node',
    '/config/backend.cjs',
  );
  const ui = network + '-ui';
  containers.push(ui);
  docker(
    'run',
    '-d',
    '--name',
    ui,
    '--network',
    network,
    '--network-alias',
    'hivexui',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/var/cache/nginx',
    '--tmpfs',
    '/var/run',
    process.env.HIVEXUI_TEST_IMAGE || 'hivexui:candidate',
  );
  const ingress = network + '-edge';
  containers.push(ingress);
  const env = [
    '-e',
    'HIVE_CONSOLE_HOST=localhost',
    '-e',
    'XDG_CONFIG_HOME=/data/config',
    '-e',
    'XDG_DATA_HOME=/data',
  ];
  for (const product of [
    'EMBERPATH',
    'EMBERPATH_API',
    'OATHWEAVE',
    'HIVEMEM',
    'HIVESKILLS',
    'CINDERTRACE',
    'CHATTERMOST',
    'MAGNUS',
  ])
    env.push(
      '-e',
      product + '_ENDPOINT=https://backend:9443',
      '-e',
      product + '_TLS_NAME=' + (product === 'HIVESKILLS' ? 'wrong.invalid' : 'localhost'),
    );
  docker(
    'run',
    '-d',
    '--name',
    ingress,
    '--network',
    network,
    ...restrictions,
    ...env,
    '-v',
    `${temporary}:/config:ro`,
    '-v',
    `${temporary}/state:/data`,
    '-p',
    '127.0.0.1::8443',
    caddyImage,
    'caddy',
    'run',
    '--config',
    '/config/Caddyfile',
    '--adapter',
    'caddyfile',
  );
  let inspect;
  for (let attempt = 0; attempt < 50; attempt++) {
    inspect = JSON.parse(docker('inspect', ingress))[0];
    if (inspect.NetworkSettings.Ports['8443/tcp']?.length) break;
    if (inspect.State.Status === 'exited') break;
    await delay(100);
  }
  writeFileSync(join(temporary, 'ingress-inspect.json'), JSON.stringify(inspect, null, 2), {
    mode: 0o600,
  });
  const port = inspect.NetworkSettings.Ports['8443/tcp']?.[0]?.HostPort;
  assert(port, 'Ingress did not publish its test listener');
  const options = {
    hostname: 'localhost',
    port,
    ca: readFileSync(join(temporary, 'console.crt')),
    timeout: 5000,
  };
  async function request(path, headers = {}, method = 'GET', body) {
    return new Promise((resolve, reject) => {
      const req = https.request({ ...options, path, headers, method }, (res) => {
        const chunks = [];
        let first;
        res.on('data', (chunk) => {
          first ??= Date.now();
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            cookies: res.headers['set-cookie'],
            body: Buffer.concat(chunks).toString(),
            streamMilliseconds: Date.now() - first,
          }),
        );
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });
  }
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await request('/_hive/ready')).status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert(ready, 'Ingress did not become ready');
  assert.match((await request('/')).body, /HiveXUI/);
  const cookieNames = ['__Host-oathweave_sso', 'iam_refresh', 'hive_router_admin', 'hivemem_dash', 'hive_skills_session', 'cindertrace_session', 'MMSID', 'MMUSERID', 'MMCSRF'];
  const headers = {
    Authorization: 'Bearer obviously-fake-transport-fixture',
    Cookie: cookieNames.map(name => `${name}=obviously-fake-cookie`).join('; '),
    Origin: 'https://console.example.com',
  };
  const cookieKeys = value => (value || '').split(';').map(part => part.trim().split('=')[0]).filter(Boolean).sort();
  const chatCookies = ['MMSID', 'MMUSERID', 'MMCSRF'].sort();
  for (const [input, expected, allowed] of [
    ['/api/emberpath/providers?limit=1', '/api/providers?limit=1', ['hive_router_admin']],
    ['/api/emberpath/health/ready', '/health/ready', []],
    ['/api/cindertrace/health/ready', '/ready', []],
    ['/api/oathweave/users', '/api/v1/users', ['__Host-oathweave_sso', 'iam_refresh']],
    ['/api/hivemem/memories', '/v1/memories', ['hivemem_dash']],
    ['/api/cindertrace/security-fusion/cases', '/api/v1/security-fusion/cases', ['cindertrace_session']],
    ['/api/chattermost/api/v4/users/me', '/api/v4/users/me', chatCookies],
    ['/api/emberfold/v1/health', '/v1/health', []],
    ['/v1/models', '/v1/models', []],
    ['/memory/v1/memories', '/v1/memories', ['hivemem_dash']],
    ['/api/v4/users/me', '/api/v4/users/me', chatCookies],
    ['/api/v1/security-fusion/events', '/api/v1/security-fusion/events', ['cindertrace_session']],
  ]) {
    const result = await request(input, headers);
    assert.equal(result.status, 200, input);
    const body = JSON.parse(result.body);
    assert.equal(body.path, expected);
    assert.equal(body.authorization, headers.Authorization);
    assert.equal(body.origin, headers.Origin);
    assert.deepEqual(cookieKeys(body.cookie), [...allowed].sort(), input + ' forwarded another product session');
    const cookies = (result.cookies || []).filter(Boolean);
    assert.deepEqual(cookies.map(cookie => cookie.split('=')[0]).sort(), [...allowed].sort(), input + ' accepted another product Set-Cookie');
    const withoutCookies = JSON.parse((await request(input, { Authorization: headers.Authorization })).body);
    assert.equal(withoutCookies.cookie, undefined, 'Ingress introduced a cookie for a native bearer client');
  }
  assert.equal(
    (await request('/api/hiveskills/admin/skills', headers)).status,
    503,
    'Mismatched upstream certificate name was accepted',
  );
  assert.equal(
    (await request('/api/unknown/path')).status,
    404,
    'Unknown API fell through to static HTML',
  );
  const stream = await request('/v1/stream', headers);
  assert.match(stream.body, /first[\s\S]*last/);
  assert(stream.streamMilliseconds > 150, 'Streaming response was buffered until completion');
  // Magnus: only browser-facing routes, only the headers its API reads.
  const refused = 'API unavailable';
  const magnusHeaders = {
    ...headers,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Idempotency-Key': 'obviously-fake-key',
    'X-Trace-Id': 'obviously-fake-trace',
    'X-Api-Secret': 'obviously-fake-secret',
    'x-node-token': 'obviously-fake-node-token',
    'X-Log-Token': 'obviously-fake-log-token',
    'X-Forwarded-For': '192.0.2.1',
  };
  for (const [input, expected, method, payload] of [
    ['/api/magnus/health/ready', '/api/v1/health'],
    ['/api/magnus/health', '/api/v1/health'],
    ['/api/magnus/console/session', '/api/v1/console/session'],
    ['/api/magnus/nodes/node-1/gpu', '/api/v1/nodes/node-1/gpu'],
    ['/api/magnus/files/read?path=%2Fetc%2Fhosts', '/api/v1/files/read?path=%2Fetc%2Fhosts'],
    ['/api/magnus/ardent/installations/node-1/profiles/main/sessions/one', '/api/v1/ardent/installations/node-1/profiles/main/sessions/one'],
    ['/api/magnus/commands', '/api/v1/commands', 'POST', '{"synthetic":true}'],
    ['/api/magnus/notifications/preferences', '/api/v1/notifications/preferences', 'PUT', '{"synthetic":true}'],
    ['/api/magnus/nodes/node-1', '/api/v1/nodes/node-1', 'PATCH', '{"synthetic":true}'],
    ['/api/magnus/nodes/node-1', '/api/v1/nodes/node-1', 'DELETE'],
  ]) {
    const result = await request(input, magnusHeaders, method, payload);
    assert.equal(result.status, 200, input);
    const body = JSON.parse(result.body);
    assert.equal(body.path, expected);
    assert.equal(body.method, method ?? 'GET');
    assert.equal(body.body, payload ?? '', input + ' changed the request body');
    assert.equal(body.authorization, headers.Authorization);
    assert.equal(body.headers['x-idempotency-key'], 'obviously-fake-key');
    assert.equal(body.headers['x-trace-id'], 'obviously-fake-trace');
    assert.equal(body.headers.accept, 'application/json');
    assert.equal(body.headers['content-type'], 'application/json');
    for (const name of ['x-api-secret', 'x-node-token', 'x-log-token', 'cookie', 'origin'])
      assert.equal(body.headers[name], undefined, input + ' forwarded ' + name);
    assert.notEqual(body.headers['x-forwarded-for'], '192.0.2.1', 'Ingress trusted a browser forwarding header');
    assert.deepEqual((result.cookies || []).filter(Boolean), [], input + ' let Magnus set a cookie');
  }
  assert.equal((await request('/api/magnus/console/session', { Authorization: 'Basic b2JfdmlvdXNseQ==' })).status, 401, 'Non-bearer Authorization reached Magnus');
  for (const [input, method] of [
    ['/api/magnus/heartbeat', 'POST'],
    ['/api/magnus/heartbeat/stream/stats'],
    ['/api/magnus/discovery/scan', 'POST'],
    ['/api/magnus/terminal/ticket', 'POST'],
    ['/api/magnus/health/ready', 'POST'],
    ['/api/magnus/nodes/scan-users'],
    ['/api/magnus/nodes/SCAN-USERS'],
    ['/api/magnus/nodes/compare'],
    ['/api/magnus/nodes/tags'],
    ['/api/magnus/agents/upgrade/runs/latest'],
    ['/api/magnus/ardent/installations/node-1/profiles/main/context-release'],
    ['/api/magnus/ardent/installations/node-1/profiles/main/context-adoptions/release-1'],
    ['/api/magnus/nodes', 'DELETE'],
    ['/api/magnus/nodes', 'OPTIONS'],
    ['/api/magnus/nodes/node-1/unknown'],
    ['/api/magnus/nodes/'],
    ['/api/magnus'],
    ['/API/MAGNUS/nodes'],
    ['/api/magnus/Nodes'],
    ['/api/magnus//nodes'],
    ['/api/magnus/nodes//node-1'],
    ['/api/magnus/nodes/%2Fnode-1'],
    ['/api/magnus/nodes%2Fnode-1'],
    ['/api/magnus/nodes/scan%2Dusers'],
    ['/api/magnus/nodes/../heartbeat'],
    ['/api/magnus/nodes/./node-1'],
    ['/api/magnus/nodes/%2e%2e/heartbeat'],
    ['/api/magnus/nodes/node-1%00'],
    ['/api/magnus/nodes/node-1%0a'],
    ['/api/magnus/nodes/node%252F1'],
    ['/api/magnus/nodes/node%5c1'],
  ]) {
    const result = await request(input, magnusHeaders, method);
    assert.equal(result.status, 404, (method ?? 'GET') + ' ' + input + ' was not refused');
    assert.equal(result.body, refused, input + ' reached a backend');
  }
  const magnusStream = await request('/api/magnus/events/stream', { ...magnusHeaders, Accept: 'text/event-stream' });
  assert.equal(magnusStream.status, 200);
  assert.match(magnusStream.body, /first[\s\S]*last/);
  assert(magnusStream.streamMilliseconds > 150, 'Magnus event stream was buffered until completion');
  // Optional: the whole of Magnus's own route inventory, when a checkout supplies it.
  if (process.env.HIVE_MAGNUS_ROUTE_INVENTORY) {
    const counts = { browser: 0, refused: 0 };
    let section = '';
    for (const line of readFileSync(process.env.HIVE_MAGNUS_ROUTE_INVENTORY, 'utf8').split('\n')) {
      if (line.startsWith('## ')) section = line.slice(3);
      const row = line.match(/^\| (GET|POST|PUT|PATCH|DELETE|ALL) \| `(\/api\/v1\/[^`]*)` \|/);
      if (!row || section === 'Explicit denies') continue;
      const allowed = section === 'Browser-facing';
      const path = '/api/magnus' + row[2].slice('/api/v1'.length).replace(/:[A-Za-z]+/g, 'probe').replace(/\/\*$/, '/probe/deep');
      if (allowed) assert(!/\*/.test(path), 'Browser inventory row is not a concrete path: ' + row[2]);
      const concrete = path.replace(/\*/g, 'probe');
      const method = row[1] === 'ALL' ? 'GET' : row[1];
      const result = await request(concrete, { Authorization: headers.Authorization }, method);
      if (allowed) {
        assert.equal(result.status, 200, method + ' ' + concrete + ' was refused');
        if (!result.body.startsWith('data:')) assert.equal(JSON.parse(result.body).path, '/api/v1' + concrete.slice('/api/magnus'.length));
        counts.browser++;
      } else {
        assert.equal(result.status, 404, method + ' ' + concrete + ' (' + section + ') was allowed');
        counts.refused++;
      }
    }
    console.log('Magnus route inventory: ' + counts.browser + ' browser rows allowed, ' + counts.refused + ' other rows refused.');
  }
  await new Promise((resolve, reject) => {
    const req = https.get({
      ...options,
      path: '/api/chattermost/api/v4/websocket',
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    req.on('upgrade', (res, socket, head) => {
      assert.equal(res.statusCode, 101);
      assert.deepEqual(cookieKeys(res.headers['x-fixture-cookie']), chatCookies);
      const done = (buffer) => {
        try {
          assert.equal(buffer.subarray(0, 4).toString('hex'), '81026f6b');
          socket.destroy();
          resolve();
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      };
      if (head.length) done(head);
      else socket.once('data', done);
      socket.on('error', reject);
    });
    req.on('response', () => reject(new Error('WebSocket upgrade was not proxied')));
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
  // Hive Registry lookups: explicit GET routes only, no cookies either way, and a
  // bearer credential or nothing. Writes stop at the ingress, whatever they carry.
  for (const [input, expected] of [
    ['/api/registry/health/ready', '/health/ready'],
    ['/api/registry/v1/installation', '/v1/installation'],
    ['/api/registry/v1/products', '/v1/products'],
    ['/api/registry/v1/products?installed=true', '/v1/products?installed=true'],
    ['/api/registry/v1/products/emberpath', '/v1/products/emberpath'],
    ['/api/registry/v1/products/hive-registry/connection', '/v1/products/hive-registry/connection'],
  ]) {
    const result = await request(input, headers);
    assert.equal(result.status, 200, input);
    const body = JSON.parse(result.body);
    assert.equal(body.path, expected, input);
    assert.equal(body.method, 'GET');
    assert.equal(body.cookie, undefined, input + ' forwarded a cookie to the registry');
    assert.equal(body.origin, undefined, input + ' forwarded a browser origin to the registry');
    assert.deepEqual((result.cookies || []).filter(Boolean), [], input + ' let the registry set a cookie');
    assert.equal(body.authorization, input.endsWith('/health/ready') ? undefined : headers.Authorization, input);
    const unsigned = JSON.parse((await request(input, { Cookie: headers.Cookie })).body);
    assert(!unsigned.authorization, input + ' invented a credential');
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    for (const path of ['/api/registry/v1/sync', '/api/registry/v1/products', '/api/registry/v1/products/emberpath', '/api/registry/health/ready', '/api/registry/anything']) {
      const result = await request(path, { Authorization: headers.Authorization, 'Content-Type': 'application/json' }, method, ['POST', 'PUT', 'PATCH'].includes(method) ? '{}' : undefined);
      assert.equal(result.status, 405, method + ' ' + path + ' reached past the ingress');
    }
  for (const path of ['/api/registry/v1/sync', '/api/registry/v1/history', '/api/registry/v1/unknown', '/api/registry/v2/products', '/api/registry/v1/products/Bad', '/api/registry/v1/products/emberpath/other', '/api/registry/health/live', '/api/registry/', '/api/registry/v1/products/%2e%2e/sync', '/api/registry/v1//products', '/api/registry/v1/products%2femberpath'])
    assert.equal((await request(path, headers)).status, 404, path + ' passed the registry allowlist');
  for (const authorization of ['Basic b2J2aW91c2x5OmZha2U=', 'Bearer two words', 'Bearer ', 'Bearer a,b'])
    assert.equal((await request('/api/registry/v1/products', { Authorization: authorization })).status, 401, authorization);
  passed = true;
  console.log(
    'PASS: non-root static UI/Caddy, verified upstream TLS rejection, explicit mappings, product cookie isolation, native sessions, streaming, WebSocket transport, and the Magnus route allowlist with machine credentials stripped.',
  );
} catch (error) {
  for (const container of containers) {
    try {
      const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
      writeFileSync(join(temporary, container + '.log'), logs.stdout + logs.stderr, {
        mode: 0o600,
      });
    } catch {}
  }
  console.error('Disposable ingress evidence retained at ' + temporary);
  throw error;
} finally {
  for (const container of containers.reverse()) {
    try {
      docker('rm', '-f', container);
    } catch {}
  }
  try {
    docker('network', 'rm', network);
  } catch {}
  if (passed) rmSync(temporary, { recursive: true, force: true });
}
