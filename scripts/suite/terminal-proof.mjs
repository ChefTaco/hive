// Developer acceptance of the optional Magnus web terminal on a real installation: a real
// Oathweave token, through the real ingress, to the real gateway and a disposable sshd node.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const claims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
const STEP_UP_WINDOW_SECONDS = 300;

function requester({ port, ca }) {
  return (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request({ hostname: 'localhost', port, path, method, ca, timeout: 15_000, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* the refusals from the ingress are plain text */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(Error('Terminal request timeout')));
    request.end(data);
  });
}

// The way a browser reads output: fetch with a bearer token and no Origin on a same-origin GET.
function openStream({ port, ca }, path, token) {
  let text = '', closed = false, failure = null, response = null;
  const request = https.request({ hostname: 'localhost', port, path, method: 'GET', ca, headers: { Authorization: 'Bearer ' + token, 'Sec-Fetch-Site': 'same-origin' } }, (incoming) => {
    response = incoming;
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { text += chunk; });
    incoming.on('close', () => { closed = true; });
    incoming.on('error', (error) => { failure = error; });
  });
  request.on('error', (error) => { failure = error; });
  request.end();
  return {
    get text() { return text; },
    get closed() { return closed; },
    get status() { return response?.statusCode; },
    get headers() { return response?.headers; },
    async until(pattern, label) {
      for (let attempt = 0; attempt < 150; attempt += 1) {
        if (pattern.test(text)) return;
        if (failure) throw failure;
        await delay(100);
      }
      assert.fail('Terminal output never showed ' + label);
    },
    stop() { request.destroy(); },
  };
}

// Asks the real Magnus API, as the operator's machine credential, for a console drain answer.
async function drainConsoleParticipant({ docker, consoleDirectory, call, token, name }) {
  const registered = await call('POST', '/api/magnus/nodes/register', { Authorization: 'Bearer ' + token }, { name, hostname: name, ipAddress: '192.0.2.10', port: 4100 });
  assert.equal(registered.status, 201, 'Node registration failed');
  const api = (path, body) => {
    const script = `fetch('https://localhost:4000/api/v1/resource-leases/enrollment/${registered.json.data.nodeId}/'+process.argv[1],{method:'POST',headers:{'x-api-secret':process.env.API_SECRET,'content-type':'application/json'},body:process.argv[2]}).then(r=>r.text()).then(text=>console.log(text))`;
    return JSON.parse(docker('compose', '-f', join(consoleDirectory, 'compose.json'), 'exec', '-T', 'magnus', 'node', '-e', script, path, JSON.stringify(body)));
  };
  assert.equal(api('begin', {}).success, true, 'Could not begin a drain');
  const refreshed = api('refresh', { participant: 'dashboard' });
  assert.equal(refreshed.success, true, 'The console drain refresh failed: ' + JSON.stringify(refreshed));
  return refreshed.data;
}

// Without the opt-in, nothing about the terminal exists: no token carries it and no route answers.
export async function proveTerminalOff({ hive, docker, session, token, port, ca, consoleDirectory }) {
  const call = requester({ port, ca }), bearer = { Authorization: 'Bearer ' + token };
  assert(!claims(token).permissions.includes('magnus:terminal'), 'A fresh operator holds the terminal by default');
  assert(claims(token).permissions.includes('magnus:admin'));
  assert.equal(session.capabilities.terminal, false, 'The console was told to offer a terminal');
  for (const [method, path, body] of [['POST', '/api/magnus/terminal/open', { nodeId: 'node-1' }], ['GET', '/api/magnus/terminal/status?sessionId=ts_fake']])
    assert.equal((await call(method, path, bearer, body)).status, 404, path + ' exists without a selected gateway');
  const environment = parseEnv(readFileSync(join(consoleDirectory, 'config/magnus.env'), 'utf8'));
  assert.equal(environment.RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT, 'absent');
  assert.equal(environment.FLEET_GATEWAY_URL, undefined);
  // Declared absent, a node with no console work really can pass its drain.
  const drain = await drainConsoleParticipant({ docker, consoleDirectory, call, token, name: 'drain-absent-' + randomBytes(4).toString('hex') });
  assert.equal(drain.status, 'verified', 'Absent console participant blocked a drain: ' + JSON.stringify(drain));
  assert.equal(drain.reason, 'declared-absent-no-work');
  const offered = JSON.parse(await hive('registry', 'get', 'magnus-gateway'));
  assert.equal(offered.offered, true, 'The registry does not offer the gateway');
  assert.equal(offered.installation ?? null, null, 'The registry recorded a gateway nobody selected');
}

export async function proveTerminal({ hive, docker, put, output, network, origin, port, ca, password, cookieHeaders, consoleDirectory }) {
  const call = requester({ port, ca }), evidence = {}, node = 'terminal-node-' + randomBytes(4).toString('hex');
  const browser = { Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const bearer = (token, extra = browser) => ({ Authorization: 'Bearer ' + token, ...extra });
  async function mint(clientId) {
    const redirectUri = origin + '/auth/callback', verifier = randomBytes(32).toString('base64url');
    const code = await call('POST', '/api/oathweave/oauth/authorize', cookieHeaders, { clientId, redirectUri, responseType: 'code', codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256', scope: 'openid profile', state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url') });
    assert.equal(code.status, 200);
    const token = await call('POST', '/api/oathweave/oauth/token', cookieHeaders, { grant_type: 'authorization_code', client_id: clientId, code: code.json.code, code_verifier: verifier, redirect_uri: redirectUri });
    assert.equal(token.status, 200);
    return token.json.access_token;
  }
  const open = (token, nodeId, headers = browser) => call('POST', '/api/magnus/terminal/open', bearer(token, headers), { nodeId, cols: 80, rows: 24 });
  const close = async (token, sessionId) => assert.equal((await call('POST', '/api/magnus/terminal/close', bearer(token), { sessionId })).status, 200);

  // Selecting the gateway and setting the grant is what made this token carry the permission.
  let token = await mint('hivexui-magnus');
  assert(claims(token).permissions.includes('magnus:terminal'), 'The explicit opt-in did not reach the token');
  const session = await call('GET', '/api/magnus/console/session', bearer(token, {}));
  assert.equal(session.status, 200);
  assert.equal(session.json.data.capabilities.terminal, true, 'The console was not told to offer the terminal');
  // The gateway is recorded, and its machine routes have no way in from a browser.
  const recorded = JSON.parse(await hive('registry', 'get', 'magnus-gateway'));
  assert.equal(recorded.installation?.status, 'installed', 'The registry did not record the selected gateway');
  assert.equal(JSON.parse(await hive('registry', 'connection', 'magnus-gateway')).browserPrefix, '/api/magnus/terminal');
  for (const path of ['/api/magnus/internal/resource-enrollment/drain', '/api/magnus/terminal/internal/resource-enrollment/drain', '/api/magnus/terminal/%2e%2e/internal/resource-enrollment/drain', '/api/magnus/health/internal'])
    assert.equal((await call('POST', path, bearer(token), {})).status, 404, path + ' reached past the ingress');
  // Outside /api this is the static console, which has no gateway behind it and answers no JSON.
  assert.equal((await call('POST', '/internal/resource-enrollment/drain', bearer(token), {})).json, null, 'The gateway answered outside the terminal routes');

  // A disposable node. Its identity comes from Magnus's inventory, never from the request.
  const image = 'hive-terminal-node:' + randomBytes(4).toString('hex'), container = network.replace(/_default$/, '') + '-' + node;
  const fleetPublic = readFileSync(join(output, 'fleet-key.pub'), 'utf8').trim();
  execFileSync('docker', ['build', '-q', '-t', image, '-'], { input: `FROM alpine:3.21
RUN apk add --no-cache openssh-server && adduser -D -s /bin/sh deploy && passwd -u deploy && mkdir -p /home/deploy/.ssh && ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
RUN printf 'HostKey /etc/ssh/ssh_host_ed25519_key\\nPasswordAuthentication no\\nPermitRootLogin no\\nAllowTcpForwarding no\\nX11Forwarding no\\n' > /etc/ssh/sshd_config
RUN printf '%s\\n' '${fleetPublic}' > /home/deploy/.ssh/authorized_keys && chown -R deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
CMD ["/usr/sbin/sshd", "-D", "-e"]
`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    docker('run', '-d', '--name', container, '--network', network, '--network-alias', node, image);
    const address = JSON.parse(docker('inspect', container))[0].NetworkSettings.Networks[network].IPAddress;
    const registered = await call('POST', '/api/magnus/nodes/register', bearer(token, {}), { name: node, hostname: node, ipAddress: address, port: 4100 });
    assert.equal(registered.status, 201, 'Node registration failed');
    const nodeId = registered.json.data.nodeId;

    // No approval means no terminal, and nothing here teaches the gateway a key.
    const unapproved = await open(token, nodeId);
    assert.equal(unapproved.json?.error, 'HOST_KEY_UNTRUSTED', 'An unapproved node opened: ' + unapproved.text);
    assert.match(await hive('magnus-trust', 'scan', '--node-id', nodeId, '--host', node), /SHA256:/);
    assert.equal((await open(token, nodeId)).json?.error, 'HOST_KEY_UNTRUSTED', 'A scan approved a host key');
    assert.equal(await hive('magnus-trust', 'list'), '', 'The server wrote the approved store');
    const onNode = docker('exec', container, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub').split(/\s+/)[1];
    const wrong = 'SHA256:' + 'A'.repeat(43);
    await assert.rejects(hive('magnus-trust', 'add', '--node-id', nodeId, '--host', node, '--fingerprint', wrong, '--approved-by', 'admin', '--approval-ref', 'rehearsal-1'), 'A fingerprint the node did not present was approved');
    await hive('magnus-trust', 'add', '--node-id', nodeId, '--host', node, '--fingerprint', onNode, '--approved-by', 'admin', '--approval-ref', 'rehearsal-1');
    assert.equal(JSON.parse((await hive('magnus-trust', 'list')).split('\n').find((line) => line.startsWith('{'))).fingerprints[0], onNode);

    // The browser checks reach the gateway through the ingress, so they really refuse.
    for (const headers of [{ Origin: 'https://attacker.example.com' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: origin, 'Sec-Fetch-Site': 'same-site' }]) {
      const refused = await open(token, nodeId, headers);
      assert.equal(refused.status, 403);
      assert.equal(refused.json?.error, 'CROSS_ORIGIN_REJECTED', 'The ingress dropped a browser header');
    }

    // Open, stream, input, resize, renew, status, close.
    const opened = await open(token, nodeId);
    assert.equal(opened.status, 201, 'Terminal open failed: ' + opened.text);
    const sessionId = opened.json.sessionId;
    const stream = openStream({ port, ca }, '/api/magnus/terminal/stream?sessionId=' + sessionId, token);
    await delay(1000);
    assert.equal(stream.status, 200, 'A same-origin GET without Origin was refused');
    const input = (data) => call('POST', '/api/magnus/terminal/input', bearer(token), { sessionId, data });
    assert.equal((await input('echo proof-$((6*7)) from $(id -un)\n')).status, 200);
    await stream.until(/proof-42 from deploy/, 'the command output');
    assert.equal((await call('POST', '/api/magnus/terminal/resize', bearer(token), { sessionId, cols: 100, rows: 30 })).status, 200);
    assert.equal((await input('stty size | tr " " x\n')).status, 200);
    await stream.until(/30x100/, 'the new terminal size');
    assert.equal((await call('POST', '/api/magnus/terminal/renew', bearer(token), { sessionId })).status, 200);
    assert.equal((await call('GET', '/api/magnus/terminal/status?sessionId=' + sessionId, bearer(token, { 'Sec-Fetch-Site': 'same-origin' }))).json?.state, 'open');
    await close(token, sessionId);
    for (let attempt = 0; attempt < 50 && !stream.closed; attempt += 1) await delay(100);
    assert(stream.closed, 'Closing did not end the stream');
    const ended = await call('GET', '/api/magnus/terminal/status?sessionId=' + sessionId, bearer(token, { 'Sec-Fetch-Site': 'same-origin' }));
    assert.equal(ended.json?.state, 'ended');
    assert.equal(ended.json?.reason, 'client-closed');
    evidence.shell = 'open, streamed output, input, resize, renew, status, close';

    // The audit log holds metadata, and the real client address rather than the ingress.
    const audit = await call('GET', '/api/magnus/audit?limit=100', bearer(token, {}));
    assert.equal(audit.status, 200);
    assert(audit.text.includes('terminal.session.open'), 'Magnus has no audit record of the terminal');
    assert(!audit.text.includes('proof-42'), 'Terminal content reached the audit log');

    // Step-up: the same session, stale now, is refused until the person verifies again.
    const waited = claims(token).auth_time + STEP_UP_WINDOW_SECONDS + 5 - Date.now() / 1000;
    if (waited > 0) await delay(waited * 1000);
    token = await mint('hivexui-magnus');
    assert(Date.now() / 1000 - claims(token).auth_time > STEP_UP_WINDOW_SECONDS, 'The token should have stale verification');
    const stale = await open(token, nodeId);
    assert.equal(stale.status, 403);
    assert.equal(stale.json?.error, 'STEP_UP_REQUIRED', 'A stale auth_time opened a terminal: ' + stale.text);
    assert.equal((await call('POST', '/api/oathweave/auth/step-up', cookieHeaders, { password })).status, 200, 'Step-up failed');
    token = await mint('hivexui-magnus');
    const fresh = await open(token, nodeId);
    assert.equal(fresh.status, 201, 'Fresh verification did not open a terminal: ' + fresh.text);
    await close(token, fresh.json.sessionId);
    evidence.stepUp = 'stale auth_time refused with STEP_UP_REQUIRED, fresh after real step-up';

    // A token without the permission is refused, for an ADMIN link with a fresh verification.
    const identityToken = await mint('hivexui-oathweave');
    const roles = await call('GET', '/api/oathweave/roles', bearer(identityToken, { Origin: origin }));
    assert.equal(roles.status, 200);
    const suiteRole = roles.json.roles.find((role) => role.name === 'SUITE_ADMIN');
    assert(suiteRole.permissions.includes('magnus:terminal'), 'The initial grant is not the suite role');
    const change = (permissions) => call('PATCH', '/api/oathweave/roles/' + suiteRole.id, bearer(identityToken, { Origin: origin }), { permissions });
    assert.equal((await change(suiteRole.permissions.filter((name) => name !== 'magnus:terminal'))).status, 200, 'Could not remove the terminal grant');
    try {
      const withoutPermission = await mint('hivexui-magnus');
      assert(!claims(withoutPermission).permissions.includes('magnus:terminal'), 'Removing the grant did not change the token');
      assert(claims(withoutPermission).permissions.includes('magnus:admin'));
      assert(Date.now() / 1000 - claims(withoutPermission).auth_time < STEP_UP_WINDOW_SECONDS, 'The refusal must not be a step-up refusal');
      const refused = await open(withoutPermission, nodeId);
      assert.equal(refused.status, 403);
      assert.equal(refused.json?.error, 'FORBIDDEN', 'A token without magnus:terminal was not refused: ' + refused.text);
      const offered = await call('GET', '/api/magnus/console/session', bearer(withoutPermission, {}));
      assert.equal(offered.json.data.capabilities.terminal, false);
    } finally {
      assert.equal((await change(suiteRole.permissions)).status, 200, 'Could not restore the terminal grant');
    }
    evidence.withoutPermission = 'ADMIN link, fresh verification, no magnus:terminal: 403 FORBIDDEN';

    // The Magnus API reaches the real gateway for a drain challenge, over verified TLS.
    const environment = parseEnv(readFileSync(join(consoleDirectory, 'config/magnus.env'), 'utf8'));
    assert.equal(environment.RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT, undefined);
    const gatewayUrl = environment.FLEET_GATEWAY_URL;
    assert.equal(docker('compose', '-f', join(consoleDirectory, 'compose.json'), 'exec', '-T', 'magnus', 'node', '-e', `fetch(${JSON.stringify(gatewayUrl + '/health')}).then(r=>r.json()).then(body=>console.log(body.status))`), 'ok', 'Magnus does not trust the gateway');
    // A real signed challenge to the gateway's /internal route, proving the shared key too.
    const drain = await drainConsoleParticipant({ docker, consoleDirectory, call, token, name: 'drain-gateway-' + randomBytes(4).toString('hex') });
    assert.equal(drain.status, 'verified', 'The gateway did not answer the drain: ' + JSON.stringify(drain));
    assert.equal(drain.reason, 'signed-current-drain');
    evidence.drain = 'Magnus API to gateway over verified TLS with a signed receipt';
    const gatewayEnvironment = parseEnv(readFileSync(join(consoleDirectory, 'config/magnus-gateway.env'), 'utf8'));
    assert.equal(gatewayEnvironment.FLEET_GATEWAY_TRUST_FORWARDED_FOR, 'true');
    // Hardening as the compose definition really ran it.
    const gatewayContainer = docker('compose', '-f', join(consoleDirectory, 'compose.json'), 'ps', '-q', 'magnus-gateway');
    const inspected = JSON.parse(docker('inspect', gatewayContainer))[0];
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']);
    assert.notEqual(inspected.Config.User.split(':')[0], '0');
    assert(inspected.Mounts.some((mount) => mount.Destination === '/config' && mount.RW === false), 'The SSH key mount is writable');
    assert.equal(docker('exec', gatewayContainer, 'stat', '-c', '%a', '/config/ssh-key'), '600');
    assert.equal(docker('exec', gatewayContainer, 'stat', '-c', '%a', '/data/known-hosts'), '700');
    evidence.deployment = 'read-only root, capabilities dropped, non-root, read-only key mount, private store';
  } finally {
    try { docker('rm', '-f', container); } catch { /* retained evidence is more useful than a failed cleanup */ }
    try { docker('image', 'rm', image); } catch { /* the fixture image holds nothing */ }
  }
  put(join(output, 'terminal-proof.json'), { schema: 1, result: 'passed', ...evidence });
}
