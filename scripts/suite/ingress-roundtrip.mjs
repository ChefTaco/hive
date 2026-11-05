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
 if(req.url==='/v1/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: first\\n\\n');setTimeout(()=>res.end('data: last\\n\\n'),350);return;}
 res.setHeader('Set-Cookie',names.map(name=>name+'=obviously-fake-native; Path=/; Secure; HttpOnly'));
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({path:req.url,authorization:req.headers.authorization,cookie:req.headers.cookie,origin:req.headers.origin}));
});
server.on('upgrade',(req,socket)=>{const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\nX-Fixture-Cookie: '+req.headers.cookie+'\\r\\n\\r\\n');socket.write(Buffer.from([129,2,111,107]));setTimeout(()=>socket.destroy(),2000);});
server.listen(9443,'0.0.0.0');
http.createServer((req,res)=>{res.setHeader('Set-Cookie','MMSID=obviously-fake-forged');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({path:req.url,authorization:req.headers.authorization,cookie:req.headers.cookie,origin:req.headers.origin}));}).listen(8096,'0.0.0.0');
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
  async function request(path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = https.get({ ...options, path, headers }, (res) => {
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
  passed = true;
  console.log(
    'PASS: non-root static UI/Caddy, verified upstream TLS rejection, explicit mappings, product cookie isolation, native sessions, streaming and WebSocket transport.',
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
