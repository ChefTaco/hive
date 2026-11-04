// Disposable-account browser acceptance. Never selects an operator installation.
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
export async function identityBrowserReview({
  review,
  temporary,
  origin,
  identityPort,
  adminPort,
  network,
  docker,
  containers,
  request,
  nativeToken,
  password,
  cert,
  key,
}) {
  for (const [name, firstParty] of [
    ['hivexui-browser-oathweave', true],
    ['hivexui-browser-emberpath', false],
  ]) {
    const response = await request(origin + '/api/v1/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + nativeToken },
      body: JSON.stringify({
        name,
        clientType: 'public',
        firstParty,
        grantTypes: ['authorization_code'],
        redirectUris: [review.origin + '/auth/callback'],
      }),
    });
    assert.equal(response.status, 201, 'Could not register browser workflow client');
    assert.equal((await response.json()).client.id, name);
  }
  const runtime = join(temporary, 'runtime.json');
  writeFileSync(
    runtime,
    JSON.stringify({
      schema: 1,
      products: { emberpath: '/api/emberpath', oathweave: '/api/oathweave' },
      identity: {
        issuer: origin,
        apiPrefix: '/api/oathweave',
        clients: { emberpath: 'hivexui-browser-emberpath', oathweave: 'hivexui-browser-oathweave' },
      },
    }),
    { mode: 0o644 },
  );
  chmodSync(runtime, 0o644);
  const ui = network + '-browser-ui',
    edge = network + '-browser-edge';
  const common = [
    '--init',
    '--network',
    network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/tmp:mode=1777',
  ];
  const create = (name, args) => {
    containers.push(name);
    docker('create', '--name', name, ...common, ...args);
    docker('start', name);
  };
  create(ui, [
    '--network-alias',
    'hivexui',
    '--user',
    '101:101',
    '--tmpfs',
    '/var/cache/nginx:uid=101,gid=101,mode=700',
    '--tmpfs',
    '/var/run:uid=101,gid=101,mode=700',
    '--mount',
    `type=bind,source=${runtime},target=/usr/share/nginx/html/runtime.json,readonly`,
    'hivexui:candidate',
  ]);
  const caddy = join(temporary, 'Caddyfile');
  writeFileSync(caddy, readFileSync(new URL('../../deployment/Caddyfile', import.meta.url)), {
    mode: 0o600,
  });
  create(edge, [
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--env',
    'XDG_DATA_HOME=/tmp/data',
    '--env',
    'XDG_CONFIG_HOME=/tmp/config',
    '--env',
    'HIVE_CONSOLE_HOST=localhost',
    '--env',
    `OATHWEAVE_ENDPOINT=https://${network}-identity:${identityPort}`,
    '--env',
    'OATHWEAVE_TLS_NAME=localhost',
    '--env',
    `EMBERPATH_ENDPOINT=https://${network}-router:${adminPort}`,
    '--env',
    'EMBERPATH_TLS_NAME=localhost',
    '--publish',
    `127.0.0.1:${review.port}:8443`,
    '--mount',
    `type=bind,source=${caddy},target=/config/Caddyfile,readonly`,
    '--mount',
    `type=bind,source=${cert},target=/config/console.crt,readonly`,
    '--mount',
    `type=bind,source=${cert},target=/config/backend-ca.pem,readonly`,
    '--mount',
    `type=bind,source=${key},target=/config/console.key,readonly`,
    'hive-ingress:candidate',
    'caddy',
    'run',
    '--config',
    '/config/Caddyfile',
    '--adapter',
    'caddyfile',
  ]);
  writeFileSync(
    join(temporary, 'browser-builds.json'),
    JSON.stringify(
      {
        containers: containers.map((name) => ({
          name,
          image: docker('inspect', name, '--format', '{{.Image}}').trim(),
        })),
        productionCutover: false,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    join(temporary, 'browser-credentials.json'),
    JSON.stringify({ username: 'admin', password, email: 'alice@example.com' }),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      browserReviewOrigin: review.origin,
      evidenceDirectory: temporary,
      reviewSeconds: review.seconds,
      productionCutover: false,
    }),
  );
  const completion = join(temporary, 'browser-completion.json'),
    deadline = Date.now() + review.seconds * 1000;
  while (!existsSync(completion) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 1000));
  assert(existsSync(completion), 'Browser review did not provide a completion receipt');
  const result = JSON.parse(readFileSync(completion, 'utf8'));
  assert.equal(result.status, 'passed', 'Browser workflows did not pass');
  assert(Array.isArray(result.checks) && result.checks.length > 0, 'Browser checks are missing');
  writeFileSync(
    join(temporary, 'browser-result.json'),
    JSON.stringify({ ...result, productionCutover: false }, null, 2),
    { mode: 0o600 },
  );
  console.log('PASS: disposable identity browser workflow receipt recorded.');
}
