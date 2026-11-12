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
  'node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const root = new URL('../..', import.meta.url).pathname;
const temporary = mkdtempSync(join(tmpdir(), 'hive-ingress-acceptance-'));
const network = 'hive-ingress-test-' + randomBytes(5).toString('hex');
const containers = [];
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = false;
try {
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
const studio=http.createServer((req,res)=>{
 res.setHeader('Set-Cookie','hive_studio_forged=obviously-fake; Path=/');
 if(req.url.endsWith('/stream')){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: first\\n\\n');setTimeout(()=>res.end('data: last\\n\\n'),350);return;}
 res.setHeader('Content-Type','application/json');const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>res.end(JSON.stringify({path:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString()})));
});
studio.listen(8097,'0.0.0.0');
const registry=http.createServer((req,res)=>{res.setHeader('Set-Cookie','hive_registry_forged=obviously-fake; Path=/');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({path:req.url,method:req.method,authorization:req.headers.authorization,cookie:req.headers.cookie,origin:req.headers.origin}));});
registry.listen(8095,'0.0.0.0');
const gateway=https.createServer({key:fs.readFileSync('/config/console.key'),cert:fs.readFileSync('/config/console.crt')},(req,res)=>{
 res.setHeader('Set-Cookie','hive_gateway_forged=obviously-fake; Path=/');
 if(req.url.startsWith('/terminal/stream')){res.writeHead(200,{'Content-Type':'application/octet-stream'});res.write('first output');setTimeout(()=>res.end(' last output'),350);return;}
 res.setHeader('Content-Type','application/json');const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>res.end(JSON.stringify({gateway:true,path:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString()})));
});
gateway.listen(4310,'0.0.0.0');
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
    'ardentstudio',
    '--network-alias',
    'hive-registry',
    '--network-alias',
    'magnus-gateway',
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
  // A fresh installation's Magnus host agent port, as initialize-host.sh writes it.
  writeFileSync(join(temporary, 'native-listeners-magnus-agents.caddy'), ':4000 {\n\ttls /config/console.crt /config/console.key\n\timport magnus_agent_listener\n}\n', { mode: 0o600 });
  // The gateway is optional: this ingress has it, and a second one below does not.
  let agentPort;
  async function startIngress(name, environment, state, extraPorts = [], mounts = []) {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    docker(
      'run',
      '-d',
      '--name',
      name,
      '--network',
      network,
      ...restrictions,
      ...environment,
      ...mounts.flatMap((mount) => ['-v', mount]),
      '-v',
      `${temporary}:/config:ro`,
      '-v',
      `${state}:/data`,
      '-p',
      '127.0.0.1::8443',
      ...extraPorts.flatMap((port) => ['-p', '127.0.0.1::' + port]),
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
      inspect = JSON.parse(docker('inspect', name))[0];
      if (inspect.NetworkSettings.Ports['8443/tcp']?.length) break;
      if (inspect.State.Status === 'exited') break;
      await delay(100);
    }
    writeFileSync(join(temporary, name + '-inspect.json'), JSON.stringify(inspect, null, 2), {
      mode: 0o600,
    });
    const port = inspect.NetworkSettings.Ports['8443/tcp']?.[0]?.HostPort;
    assert(port, 'Ingress did not publish its test listener');
    if (extraPorts.includes(4000)) agentPort = inspect.NetworkSettings.Ports['4000/tcp']?.[0]?.HostPort;
    return port;
  }
  const options = {
    hostname: 'localhost',
    port: await startIngress(
      ingress,
      [...env, '-e', 'MAGNUS_GATEWAY_ENDPOINT=https://magnus-gateway:4310', '-e', 'MAGNUS_GATEWAY_TLS_NAME=localhost', '-e', 'ARDENTSTUDIO_ENDPOINT=http://ardentstudio:8097'],
      join(temporary, 'state'),
      [4000],
    ),
    ca: readFileSync(join(temporary, 'console.crt')),
    timeout: 5000,
  };
  async function request(path, headers = {}, method = 'GET', body, target = options) {
    return new Promise((resolve, reject) => {
      const req = https.request({ ...target, path, headers, method }, (res) => {
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
  async function waitReady(target) {
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        if ((await request('/_hive/ready', {}, 'GET', undefined, target)).status === 200) return;
      } catch {}
      await delay(100);
    }
    assert.fail('Ingress did not become ready');
  }
  await waitReady(options);
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
    // An external Magnus reads Oathweave's key set and userinfo through the console origin.
    ['/api/oathweave/oauth/jwks', '/api/v1/oauth/jwks', ['__Host-oathweave_sso', 'iam_refresh']],
    ['/api/oathweave/oauth/userinfo', '/api/v1/oauth/userinfo', ['__Host-oathweave_sso', 'iam_refresh']],
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
    'X-Acting-Subject': 'obviously-fake-subject',
    'Last-Event-ID': '42',
  };
  for (const [input, expected, method, payload] of [
    ['/api/magnus/health/ready', '/api/v1/health'],
    ['/api/magnus/health', '/api/v1/health'],
    ['/api/magnus/console/session', '/api/v1/console/session'],
    ['/api/magnus/nodes/node-1/gpu', '/api/v1/nodes/node-1/gpu'],
    ['/api/magnus/agents/identity?actorId=actor-1', '/api/v1/agents/identity?actorId=actor-1'],
    ['/api/magnus/agents/node-1~main/identity', '/api/v1/agents/node-1~main/identity'],
    ['/api/magnus/hive/events?after=cursor-1&limit=50', '/api/v1/hive/events?after=cursor-1&limit=50'],
    ['/api/magnus/ardent/installations/node-1/profiles/main/tasks/task-1/stream', '/api/v1/ardent/installations/node-1/profiles/main/tasks/task-1/stream'],
    ['/api/magnus/files/read?path=%2Fetc%2Fhosts', '/api/v1/files/read?path=%2Fetc%2Fhosts'],
    ['/api/magnus/ardent/installations/node-1/profiles/main/sessions/one', '/api/v1/ardent/installations/node-1/profiles/main/sessions/one'],
    ['/api/magnus/ardent/agents/operations/op-1', '/api/v1/ardent/agents/operations/op-1'],
    ['/api/magnus/ardent/agents/operations/op-1/stream', '/api/v1/ardent/agents/operations/op-1/stream'],
    ['/api/magnus/ardent/installations/node-1/profiles/main/tasks/task-1/artifacts', '/api/v1/ardent/installations/node-1/profiles/main/tasks/task-1/artifacts'],
    ['/api/magnus/ardent/agents', '/api/v1/ardent/agents', 'POST', '{"synthetic":true}'],
    ['/api/magnus/ardent/agents/operations/op-1/resume', '/api/v1/ardent/agents/operations/op-1/resume', 'POST', '{"synthetic":true}'],
    ['/api/magnus/ardent/installations/node-1/profiles/main/hivemem', '/api/v1/ardent/installations/node-1/profiles/main/hivemem', 'POST', '{"synthetic":true}'],
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
    assert.equal(body.headers['last-event-id'], '42', input + ' dropped Last-Event-ID');
    for (const name of ['x-api-secret', 'x-node-token', 'x-log-token', 'x-acting-subject', 'cookie', 'origin'])
      assert.equal(body.headers[name], undefined, input + ' forwarded ' + name);
    assert.notEqual(body.headers['x-forwarded-for'], '192.0.2.1', 'Ingress trusted a browser forwarding header');
    assert.deepEqual((result.cookies || []).filter(Boolean), [], input + ' let Magnus set a cookie');
  }
  assert.equal((await request('/api/magnus/console/session', { Authorization: 'Basic b2JfdmlvdXNseQ==' })).status, 401, 'Non-bearer Authorization reached Magnus');
  for (const [input, method] of [
    ['/api/magnus/heartbeat', 'POST'],
    ['/api/magnus/ardent/agents'],
    ['/api/magnus/ardent/agents/operations'],
    ['/api/magnus/ardent/agents/operations/op-1', 'POST'],
    ['/api/magnus/ardent/agents/operations/op-1/resume'],
    ['/api/magnus/ardent/installations/node-1/profiles/main/hivemem/extra', 'POST'],
    ['/api/magnus/heartbeat/stream/stats'],
    ['/api/magnus/discovery/scan', 'POST'],
    ['/api/magnus/terminal/ticket', 'POST'],
    ['/api/magnus/health/ready', 'POST'],
    ['/api/magnus/nodes/scan-users'],
    ['/api/magnus/nodes/SCAN-USERS'],
    ['/api/magnus/nodes/compare'],
    ['/api/magnus/nodes/tags'],
    ['/api/magnus/agents/upgrade/runs/latest'],
    ['/api/magnus/agents/identity', 'POST'],
    ['/api/magnus/agents/node-1~main/identity/extra'],
    ['/api/magnus/hive/events', 'POST'],
    ['/api/magnus/hive/events/extra'],
    ['/api/magnus/hive'],
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
    ['/api/magnus/docs/openapi.json', 'POST'],
    ['/api/magnus/docs/openapi'],
    ['/api/magnus/docs/other.json'],
    ['/api/magnus/docs'],
    ['/api/magnus/internal/resource-enrollment/drain', 'POST'],
    ['/api/magnus/terminal/internal/resource-enrollment/drain', 'POST'],
    ['/api/magnus/terminal/../internal/resource-enrollment/drain', 'POST'],
    ['/api/magnus/terminal/%2e%2e/internal/resource-enrollment/drain', 'POST'],
    ['/api/magnus/terminal/..%2finternal', 'POST'],
    ['/api/magnus/terminal/health'],
    ['/api/magnus/health/internal'],
    ['/api/magnus/terminal/open'],
    ['/api/magnus/terminal/input'],
    ['/api/magnus/terminal/resize'],
    ['/api/magnus/terminal/renew'],
    ['/api/magnus/terminal/close'],
    ['/api/magnus/terminal/stream', 'POST'],
    ['/api/magnus/terminal/status', 'POST'],
    ['/api/magnus/terminal/open', 'PUT'],
    ['/api/magnus/terminal/open', 'DELETE'],
    ['/api/magnus/terminal/open', 'OPTIONS'],
    ['/api/magnus/terminal/open/extra', 'POST'],
    ['/api/magnus/terminal/open/', 'POST'],
    ['/api/magnus/terminal/OPEN', 'POST'],
    ['/api/magnus/terminal//open', 'POST'],
    ['/api/magnus/terminal/unknown', 'POST'],
    ['/api/magnus/terminal/'],
    ['/api/magnus/terminal'],
  ]) {
    const result = await request(input, magnusHeaders, method);
    assert.equal(result.status, 404, (method ?? 'GET') + ' ' + input + ' was not refused');
    assert.equal(result.body, refused, input + ' reached a backend');
  }
  // The API docs route is the one Magnus browser route outside /api/v1.
  const magnusDocs = JSON.parse((await request('/api/magnus/docs/openapi.json', magnusHeaders)).body);
  assert.equal(magnusDocs.path, '/api/docs/openapi.json');
  assert.equal(magnusDocs.method, 'GET');
  assert.equal(magnusDocs.headers['x-api-secret'], undefined, 'The docs route forwarded a machine secret');
  // The terminal goes to the gateway, not to Magnus, with its browser headers intact and
  // every credential a browser could use against the gateway's machine routes removed.
  const terminalHeaders = {
    ...magnusHeaders,
    'Sec-Fetch-Site': 'same-origin',
    'x-fleet-gateway-token': 'obviously-fake-gateway-token',
    'x-resource-drain-key': 'obviously-fake-drain-key',
  };
  for (const [verb, method, query, payload] of [
    ['open', 'POST', '', '{"nodeId":"node-1"}'],
    ['input', 'POST', '', '{"sessionId":"ts_fake","data":"x"}'],
    ['resize', 'POST', '', '{"sessionId":"ts_fake","cols":80,"rows":24}'],
    ['renew', 'POST', '', '{"sessionId":"ts_fake"}'],
    ['close', 'POST', '', '{"sessionId":"ts_fake"}'],
    ['status', 'GET', '?sessionId=ts_fake'],
  ]) {
    const result = await request('/api/magnus/terminal/' + verb + query, terminalHeaders, method, payload);
    assert.equal(result.status, 200, verb);
    const body = JSON.parse(result.body);
    assert.equal(body.gateway, true, verb + ' did not reach the gateway');
    assert.equal(body.path, '/terminal/' + verb + query);
    assert.equal(body.method, method);
    assert.equal(body.body, payload ?? '', verb + ' changed the request body');
    assert.equal(body.headers.origin, headers.Origin, verb + ' dropped Origin');
    assert.equal(body.headers['sec-fetch-site'], 'same-origin', verb + ' dropped Sec-Fetch-Site');
    assert.equal(body.headers.authorization, headers.Authorization);
    assert.equal(body.headers['content-type'], 'application/json');
    for (const name of ['x-api-secret', 'x-node-token', 'x-log-token', 'x-fleet-gateway-token', 'x-resource-drain-key', 'x-idempotency-key', 'cookie'])
      assert.equal(body.headers[name], undefined, verb + ' forwarded ' + name);
    assert.notEqual(body.headers['x-forwarded-for'], '192.0.2.1', 'Ingress trusted a browser forwarding header');
    assert(!body.headers['x-forwarded-for'].includes(','), 'X-Forwarded-For must hold exactly one address');
    assert.deepEqual((result.cookies || []).filter(Boolean), [], verb + ' let the gateway set a cookie');
  }
  // A same-origin browser GET has no Origin. A header the request did not have must stay
  // absent, because the gateway refuses an empty one and would refuse every stream.
  for (const [sent, origin, site] of [
    [{ 'Sec-Fetch-Site': 'same-origin' }, undefined, 'same-origin'],
    [{ Origin: headers.Origin }, headers.Origin, undefined],
    [{}, undefined, undefined],
    [{ Origin: 'https://attacker.example.com', 'Sec-Fetch-Site': 'cross-site' }, 'https://attacker.example.com', 'cross-site'],
  ]) {
    const body = JSON.parse((await request('/api/magnus/terminal/status?sessionId=ts_fake', { Authorization: headers.Authorization, ...sent })).body);
    assert.equal(body.headers.origin, origin, 'Origin was changed on the way to the gateway');
    assert.equal(body.headers['sec-fetch-site'], site, 'Sec-Fetch-Site was changed on the way to the gateway');
  }
  const terminalStream = await request('/api/magnus/terminal/stream?sessionId=ts_fake', { Authorization: headers.Authorization, 'Sec-Fetch-Site': 'same-origin', 'Accept-Encoding': 'gzip' });
  assert.equal(terminalStream.status, 200);
  assert.equal(terminalStream.body, 'first output last output', 'Terminal stream was compressed or altered');
  assert(terminalStream.streamMilliseconds > 150, 'Terminal stream was buffered until completion');
  for (const authorization of ['Basic b2JfdmlvdXNseQ==', 'Bearer two words', 'Bearer a,b'])
    assert.equal((await request('/api/magnus/terminal/open', { Authorization: authorization }, 'POST', '{}')).status, 401, 'Non-bearer Authorization reached the gateway');
  // The Magnus API itself keeps stripping a machine secret on the routes beside the terminal.
  const besideTerminal = JSON.parse((await request('/api/magnus/console/session', terminalHeaders)).body);
  assert.equal(besideTerminal.headers['x-api-secret'], undefined);
  assert.equal(besideTerminal.gateway, undefined, 'A Magnus route reached the gateway');
  // Ardent Project Studio keeps its own prefix, gets the bearer token and no cookie either way,
  // and streams its project events unbuffered.
  for (const method of ['GET', 'POST']) {
    const studio = await request('/api/ardentstudio/v1/projects?limit=1', { ...headers, 'X-Idempotency-Key': 'obviously-fake-key', 'Last-Event-ID': '7' }, method, method === 'POST' ? '{"synthetic":true}' : undefined);
    assert.equal(studio.status, 200, 'Studio ' + method);
    const body = JSON.parse(studio.body);
    assert.equal(body.path, '/api/ardentstudio/v1/projects?limit=1', 'Studio lost its prefix');
    assert.equal(body.method, method);
    assert.equal(body.headers.authorization, headers.Authorization);
    assert.equal(body.headers['x-idempotency-key'], 'obviously-fake-key');
    assert.equal(body.headers['last-event-id'], '7');
    assert.equal(body.headers.cookie, undefined, 'A product session cookie reached Studio');
    assert.deepEqual((studio.cookies || []).filter(Boolean), [], 'Studio set a cookie');
  }
  const studioStream = await request('/api/ardentstudio/v1/projects/project-1/stream', { Authorization: headers.Authorization, Accept: 'text/event-stream' });
  assert.equal(studioStream.status, 200);
  assert.match(studioStream.body, /first[\s\S]*last/);
  assert(studioStream.streamMilliseconds > 150, 'Studio event stream was buffered until completion');
  // Off by default: without a selected gateway the terminal routes do not exist at all.
  const withoutGatewayName = network + '-edge-no-gateway';
  containers.push(withoutGatewayName);
  const withoutGateway = { ...options, port: await startIngress(withoutGatewayName, env, join(temporary, 'state-no-gateway')) };
  await waitReady(withoutGateway);
  for (const [path, method] of [['/api/magnus/terminal/open', 'POST'], ['/api/magnus/terminal/stream?sessionId=ts_fake', 'GET'], ['/api/magnus/terminal/status?sessionId=ts_fake', 'GET'], ['/api/magnus/terminal/close', 'POST']]) {
    const result = await request(path, { Authorization: headers.Authorization }, method, method === 'POST' ? '{}' : undefined, withoutGateway);
    assert.equal(result.status, 404, path + ' exists without a selected gateway');
    assert.equal(result.body, refused);
  }
  assert.equal(JSON.parse((await request('/api/magnus/console/session', { Authorization: headers.Authorization }, 'GET', undefined, withoutGateway)).body).path, '/api/v1/console/session');
  // Without Studio its prefix is an unknown API, as before.
  const withoutStudio = await request('/api/ardentstudio/v1/projects', { Authorization: headers.Authorization }, 'GET', undefined, withoutGateway);
  assert.equal(withoutStudio.status, 404, 'Studio route exists without Studio');
  assert.equal(withoutStudio.body, refused);
  const magnusStream = await request('/api/magnus/events/stream', { ...magnusHeaders, Accept: 'text/event-stream' });
  assert.equal(magnusStream.status, 200);
  assert.match(magnusStream.body, /first[\s\S]*last/);
  assert(magnusStream.streamMilliseconds > 150, 'Magnus event stream was buffered until completion');
  // An external Magnus: another host whose certificate a public authority issued. Here a test
  // authority stands in for one, added to a copy of the ingress image's own system trust store.
  // The ingress verifies the external Magnus against that store and on its own name, never
  // against the suite authority, and every other product keeps the suite authority only.
  const external = join(temporary, 'external');
  mkdirSync(external, { mode: 0o700 });
  const openssl = (...args) => execFileSync('openssl', args, { stdio: 'ignore' });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(external, 'public-ca.key'), '-out', join(external, 'public-ca.crt'), '-subj', '/CN=Synthetic public root',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-days', '1');
  writeFileSync(join(external, 'leaf.ext'), 'subjectAltName=DNS:magnus.example.com\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n', { mode: 0o600 });
  openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(external, 'console.key'), '-out', join(external, 'leaf.csr'), '-subj', '/CN=magnus.example.com');
  openssl('x509', '-req', '-in', join(external, 'leaf.csr'), '-CA', join(external, 'public-ca.crt'), '-CAkey', join(external, 'public-ca.key'), '-set_serial', '0x' + randomBytes(16).toString('hex'),
    '-days', '1', '-extfile', join(external, 'leaf.ext'), '-out', join(external, 'console.crt'));
  writeFileSync(join(external, 'backend.cjs'), readFileSync(join(temporary, 'backend.cjs')), { mode: 0o600 });
  const systemTrust = join(temporary, 'system-trust.pem');
  writeFileSync(systemTrust, docker('run', '--rm', '--entrypoint', 'cat', caddyImage, '/etc/ssl/certs/ca-certificates.crt') + '\n' + readFileSync(join(external, 'public-ca.crt')), { mode: 0o600 });
  const externalServer = network + '-external-magnus';
  containers.push(externalServer);
  docker('run', '-d', '--name', externalServer, '--network', network, '--network-alias', 'magnus.example.com', ...restrictions, '-v', `${external}:/config:ro`, nodeImage, 'node', '/config/backend.cjs');
  // As initialize-host.sh writes ingress.env for an external Magnus.
  const externalEnvironment = (endpoint, name) => [
    ...env.filter((_, index, all) => !/^MAGNUS_(ENDPOINT|TLS_NAME)=/.test(all[index]) && !/^MAGNUS_(ENDPOINT|TLS_NAME)=/.test(all[index + 1] ?? '')),
    '-e', 'MAGNUS_ENDPOINT=' + endpoint, '-e', 'MAGNUS_TLS_NAME=' + name, '-e', 'MAGNUS_TRUST_FILE=/etc/ssl/certs/ca-certificates.crt',
  ];
  const trustMount = [`${systemTrust}:/etc/ssl/certs/ca-certificates.crt:ro`];
  async function externalIngress(suffix, endpoint, name, extra = []) {
    const container = network + '-edge-' + suffix;
    containers.push(container);
    const target = { ...options, port: await startIngress(container, [...externalEnvironment(endpoint, name), ...extra], join(temporary, 'state-' + suffix), [], trustMount) };
    await waitReady(target);
    return target;
  }
  // Oathweave is pointed at the external host too: the public authority must not verify it.
  const viaExternal = await externalIngress('external', 'https://magnus.example.com:9443', 'magnus.example.com', ['-e', 'OATHWEAVE_ENDPOINT=https://magnus.example.com:9443', '-e', 'OATHWEAVE_TLS_NAME=magnus.example.com']);
  for (const [input, expected, method, payload] of [
    ['/api/magnus/health/ready', '/api/v1/health'],
    ['/api/magnus/console/session', '/api/v1/console/session'],
    ['/api/magnus/nodes/node-1', '/api/v1/nodes/node-1', 'PATCH', '{"synthetic":true}'],
    ['/api/magnus/ardent/agents', '/api/v1/ardent/agents', 'POST', '{"synthetic":true}'],
    ['/api/magnus/ardent/installations/node-1/profiles/main/tasks/task-1/artifacts', '/api/v1/ardent/installations/node-1/profiles/main/tasks/task-1/artifacts'],
    ['/api/magnus/docs/openapi.json', '/api/docs/openapi.json'],
  ]) {
    const result = await request(input, magnusHeaders, method, payload, viaExternal);
    assert.equal(result.status, 200, input + ' did not reach the external Magnus: ' + result.body.slice(0, 200));
    const body = JSON.parse(result.body);
    assert.equal(body.path, expected);
    assert.equal(body.method, method ?? 'GET');
    assert.equal(body.body, payload ?? '', input + ' changed the request body on the way to the external Magnus');
    assert.equal(body.headers.authorization, headers.Authorization, input + ' dropped the bearer token');
    // Its own name, as a proxy in front of it would route by, never the console's.
    assert.equal(body.headers.host, 'magnus.example.com:9443', input + ' reached the external Magnus under another host name');
    for (const name of ['x-api-secret', 'x-node-token', 'x-log-token', 'x-acting-subject', 'cookie', 'origin'])
      assert.equal(body.headers[name], undefined, input + ' forwarded ' + name + ' to the external Magnus');
    assert.notEqual(body.headers['x-forwarded-for'], '192.0.2.1', 'Ingress trusted a browser forwarding header for the external Magnus');
    assert.deepEqual((result.cookies || []).filter(Boolean), [], input + ' let the external Magnus set a cookie');
  }
  const externalStream = await request('/api/magnus/events/stream', { ...magnusHeaders, Accept: 'text/event-stream' }, 'GET', undefined, viaExternal);
  assert.equal(externalStream.status, 200);
  assert(externalStream.streamMilliseconds > 150, 'The external Magnus event stream was buffered until completion');
  for (const [path, method] of [['/api/magnus/heartbeat', 'POST'], ['/api/magnus/nodes/scan-users', 'GET'], ['/api/magnus/terminal/open', 'POST'], ['/api/magnus//nodes', 'GET']]) {
    const result = await request(path, magnusHeaders, method, method === 'POST' ? '{}' : undefined, viaExternal);
    assert.equal(result.status, 404, path + ' passed the allowlist to the external Magnus');
    assert.equal(result.body, refused);
  }
  assert.equal((await request('/api/magnus/console/session', { Authorization: 'Basic b2JfdmlvdXNseQ==' }, 'GET', undefined, viaExternal)).status, 401, 'Non-bearer Authorization reached the external Magnus');
  assert.equal((await request('/api/oathweave/users', headers, 'GET', undefined, viaExternal)).status, 503, 'A product inside the installation was verified with the public trust store');
  assert.equal(JSON.parse((await request('/api/hivemem/memories', headers, 'GET', undefined, viaExternal)).body).path, '/v1/memories', 'The suite authority stopped verifying the other products');
  // The suite authority does not verify an external Magnus, and neither does a certificate for another name.
  const suiteSigned = await externalIngress('external-suite-ca', 'https://backend:9443', 'localhost');
  assert.equal((await request('/api/magnus/console/session', { Authorization: headers.Authorization }, 'GET', undefined, suiteSigned)).status, 503, 'The suite authority verified an external Magnus');
  const wrongName = await externalIngress('external-wrong-name', 'https://magnus.example.com:9443', 'fleet.example.com');
  assert.equal((await request('/api/magnus/console/session', { Authorization: headers.Authorization }, 'GET', undefined, wrongName)).status, 503, 'An external Magnus certificate for another name was accepted');
  // Without MAGNUS_TRUST_FILE, as in every installation without an external Magnus, the public
  // authority does not verify Magnus either.
  const internalOnly = network + '-edge-internal-trust';
  containers.push(internalOnly);
  const internalTarget = { ...options, port: await startIngress(internalOnly, externalEnvironment('https://magnus.example.com:9443', 'magnus.example.com').filter((value, index, all) => value !== 'MAGNUS_TRUST_FILE=/etc/ssl/certs/ca-certificates.crt' && all[index + 1] !== 'MAGNUS_TRUST_FILE=/etc/ssl/certs/ca-certificates.crt'), join(temporary, 'state-internal-trust'), [], trustMount) };
  await waitReady(internalTarget);
  assert.equal((await request('/api/magnus/console/session', { Authorization: headers.Authorization }, 'GET', undefined, internalTarget)).status, 503, 'Magnus left the suite authority without MAGNUS_TRUST_FILE');
  // Optional: the whole of Magnus's own route inventory, when a checkout supplies it.
  if (process.env.HIVE_MAGNUS_ROUTE_INVENTORY) {
    const counts = { browser: 0, refused: 0 };
    let section = '';
    for (const line of readFileSync(process.env.HIVE_MAGNUS_ROUTE_INVENTORY, 'utf8').split('\n')) {
      if (line.startsWith('## ')) section = line.slice(3);
      if (section === 'Browser-facing' && line.startsWith('| GET | `/api/docs/openapi.json` |')) {
        assert.equal(JSON.parse((await request('/api/magnus/docs/openapi.json')).body).path, '/api/docs/openapi.json');
        counts.browser++;
      }
      const row = line.match(/^\| (GET|POST|PUT|PATCH|DELETE|ALL) \| `(\/api\/v1\/[^`]*)` \| ([^|]*?) \|/);
      if (!row || section === 'Explicit denies') continue;
      // The class column decides, wherever a row is listed: a machine row may sit beside the browser table.
      const allowed = section === 'Browser-facing' && row[3] === 'browser';
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
  // The Magnus host agent port of a fresh installation: its own route allowlist, agent credentials
  // only, and no header a client sends can claim an identity or an address.
  const agents = { ...options, port: agentPort };
  const forged = {
    'Content-Type': 'application/json',
    'X-Node-Token': 'obviously-fake-node-token',
    'X-Log-Token': 'obviously-fake-log-token',
    'X-Hermes-Registry-Token': 'obviously-fake-registry-token',
    Authorization: 'Bearer obviously-fake-operator-token',
    'X-Api-Secret': 'obviously-fake-system-secret',
    'X-Fleet-Gateway-Token': 'obviously-fake-gateway-token',
    'X-Resource-Drain-Key': 'obviously-fake-drain-key',
    Cookie: '__Host-oathweave_sso=obviously-fake; MMAUTHTOKEN=obviously-fake',
    'X-Forwarded-For': '203.0.113.9',
    'X-Real-Ip': '203.0.113.9',
    'X-Forwarded-User': 'admin',
    'X-Forwarded-Proto': 'http',
    'X-Hive-User': 'admin',
    'X-Hive-Roles': 'ADMIN',
    'X-Magnus-Work-Id': 'obviously-fake-work',
    Origin: 'https://evil.example.com',
  };
  const agentRoutes = [
    ['GET', '/'],
    ['POST', '/api/v1/heartbeat'],
    ['POST', '/api/v1/logs/ingest'],
    ['POST', '/api/v1/resource-leases/claim'],
    ['POST', '/api/v1/resource-leases/recovery-claim'],
    ['POST', '/api/v1/resource-leases/legacy-admission'],
    ['POST', '/api/v1/resource-leases/enrollment/node-status'],
    ['POST', '/api/v1/resource-leases/enrollment/scheduler-status'],
    ['POST', '/api/v1/resource-leases/enrollment/terminal-claim'],
    ['POST', '/api/v1/resource-leases/enrollment/terminal-receipt'],
    ['POST', '/api/v1/resource-leases/enrollment/work/work-1/node-receipt'],
    ['POST', '/api/v1/cron/managed-occurrences/admit'],
    ['POST', '/api/v1/cron/managed-occurrences/settle'],
    ['GET', '/api/v1/hermes-registry/manifest'],
    ['GET', '/api/v1/hermes-registry/profiles'],
    ['GET', '/api/v1/hermes-registry/policy'],
    ['GET', '/api/v1/hermes-registry/artifacts/skill/example/3'],
    ['POST', '/api/v1/hermes-registry/core/slot'],
    ['POST', '/api/v1/hermes-registry/core/receipts'],
    ['POST', '/api/v1/hermes-registry/tool-surface'],
    ['POST', '/api/v1/hermes-registry/policy/receipts'],
    ['POST', '/api/v1/hermes-registry/capture'],
    ['POST', '/api/v1/hermes-registry/receipts'],
    ['POST', '/api/v1/hermes-registry/inventory'],
  ];
  for (const [method, path] of agentRoutes) {
    const payload = method === 'POST' ? '{"synthetic":true}' : undefined;
    const result = await request(path, forged, method, payload, agents);
    assert.equal(result.status, 200, method + ' ' + path + ' did not reach Magnus on the agent port');
    const body = JSON.parse(result.body);
    assert.equal(body.path, path, path + ' was rewritten on the agent port');
    assert.equal(body.method, method);
    assert.equal(body.body, payload ?? '', path + ' changed the request body');
    assert.equal(body.headers['x-node-token'], 'obviously-fake-node-token');
    assert.equal(body.headers['x-log-token'], 'obviously-fake-log-token');
    assert.equal(body.headers['x-hermes-registry-token'], 'obviously-fake-registry-token');
    for (const name of ['authorization', 'x-api-secret', 'x-fleet-gateway-token', 'x-resource-drain-key', 'cookie', 'x-real-ip', 'x-forwarded-user', 'x-hive-user', 'x-hive-roles', 'x-magnus-work-id', 'origin'])
      assert.equal(body.headers[name], undefined, path + ' forwarded ' + name + ' from an agent port client');
    assert.notEqual(body.headers['x-forwarded-for'], '203.0.113.9', 'The agent port trusted a client X-Forwarded-For');
    assert.match(body.headers['x-forwarded-for'] ?? '', /^[0-9a-f.:]+$/, 'The agent port did not record the client address');
    assert.notEqual(body.headers['x-forwarded-proto'], 'http', 'The agent port trusted a client X-Forwarded-Proto');
    assert.deepEqual((result.cookies || []).filter(Boolean), [], path + ' let Magnus set a cookie on the agent port');
  }
  for (const action of ['terminal-claim', 'terminal-receipt']) {
    const result = await request('/api/magnus/resource-leases/enrollment/' + action, forged, 'POST', '{}');
    assert.equal(result.status, 404, 'The browser listener exposed a machine terminal route');
  }
  // Operator, admin, browser and system routes, a wrong method on an agent route and any path that
  // could read differently upstream never reach Magnus on the agent port.
  for (const [method, path] of [
    ['GET', '/api/v1/nodes'],
    ['GET', '/api/v1/console/session'],
    ['POST', '/api/v1/commands/execute'],
    ['POST', '/api/v1/quick-command'],
    ['GET', '/api/v1/users'],
    ['POST', '/api/v1/auth/login'],
    ['POST', '/api/v1/terminal/ticket'],
    ['POST', '/api/v1/fleet-gateway/sessions'],
    ['GET', '/api/v1/resource-leases/admission/node-1'],
    ['POST', '/api/v1/resource-leases/admission/node-1/close'],
    ['POST', '/api/v1/resource-leases/enrollment/node-1/begin'],
    ['POST', '/api/v1/resource-leases/enrollment/dashboard/status'],
    ['POST', '/api/v1/resource-leases/transfer/authority-snapshot'],
    ['POST', '/api/v1/hermes-registry/clients'],
    ['POST', '/api/v1/hermes-registry/revisions'],
    ['GET', '/api/v1/hermes-registry/status'],
    ['POST', '/api/v1/cron/sync'],
    ['GET', '/api/v1/heartbeat'],
    ['GET', '/api/v1/resource-leases/enrollment/terminal-claim'],
    ['GET', '/api/v1/resource-leases/enrollment/terminal-receipt'],
    ['POST', '/api/v1/resource-leases/enrollment/terminal-claim/extra'],
    ['POST', '/api/v1/resource-leases/enrollment/terminal-receipt/extra'],
    ['DELETE', '/api/v1/heartbeat'],
    ['GET', '/api/docs/openapi.json'],
    ['GET', '/metrics'],
    ['GET', '/api/magnus/console/session'],
    ['GET', '/'.repeat(2) + 'api/v1/heartbeat'],
    ['POST', '/api/v1/heartbeat/../users'],
    ['POST', '/api/v1/%2e%2e/users'],
    ['POST', '/api/v1/heartbeat%2f..%2fusers'],
    ['POST', '/api/v1/resource-leases/enrollment/work/a/b/node-receipt'],
  ]) {
    const result = await request(path, forged, method, method === 'POST' ? '{}' : undefined, agents);
    assert.equal(result.status, 404, method + ' ' + path + ' passed the agent port allowlist: ' + result.body.slice(0, 200));
    assert.doesNotMatch(result.body, /"path"/, method + ' ' + path + ' reached Magnus from the agent port');
  }
  // The console port keeps refusing agent credentials and agent routes.
  const consoleHeartbeat = await request('/api/magnus/heartbeat', { Authorization: headers.Authorization, 'X-Node-Token': 'obviously-fake-node-token', 'Content-Type': 'application/json' }, 'POST', '{}');
  assert.equal(consoleHeartbeat.status, 404, 'The console port served an agent route');
  const consoleSession = JSON.parse((await request('/api/magnus/console/session', { Authorization: headers.Authorization, 'X-Node-Token': 'obviously-fake-node-token' })).body);
  assert.equal(consoleSession.headers['x-node-token'], undefined, 'The console port forwarded x-node-token');
  passed = true;
  console.log(
    'PASS: non-root static UI/Caddy, verified upstream TLS rejection, explicit mappings, product cookie isolation, native sessions, streaming, WebSocket transport, the Magnus route allowlist with machine credentials and acting subjects stripped, the optional Ardent Project Studio route with its prefix kept, no cookies and unbuffered streams, the exact fleet gateway browser routes with Origin and Sec-Fetch-Site intact, an external Magnus verified against the system trust store on its own name while every other product keeps the suite authority, and the Magnus host agent port with its own allowlist and no client-asserted identity.',
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
