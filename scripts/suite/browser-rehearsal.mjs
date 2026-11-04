// Developer acceptance on restored copies; no production configuration is selected.
import assert from 'node:assert/strict';
import { readFileSync, lstatSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { join } from 'node:path';
export const browserPermissions = [
  'router:providers:read',
  'router:routing:read',
  'router:keys:read',
  'router:admin:read',
  'router:settings:read',
];
export function browserSettings(browser, names) {
  assert(
    Number.isInteger(browser.port) && browser.port > 1024 && browser.port <= 65535,
    'Review a loopback HTTPS port above 1024',
  );
  assert(
    typeof browser.subject === 'string' &&
      browser.subject &&
      typeof browser.localId === 'string' &&
      browser.localId,
    'An explicitly reviewed subject/local-account link is required',
  );
  const origin = 'https://localhost:' + browser.port;
  const client = 'hivexui-rehearsal-emberpath';
  return {
    origin,
    client,
    identity: {
      IAM_BROWSER_ISSUER: origin,
      CORS_ORIGIN: origin,
      IAM_BROWSER_CLIENT_POLICIES: JSON.stringify({
        [client]: { audience: 'emberpath', permissions: browserPermissions },
      }),
    },
    models: {
      OATHWEAVE_ISSUER: origin,
      OATHWEAVE_JWKS_URL: 'https://' + names.identity + ':4200/api/v1/oauth/jwks',
      OATHWEAVE_USERINFO_URL: 'https://' + names.identity + ':4200/api/v1/oauth/userinfo',
      EMBERPATH_OATHWEAVE_IDENTITIES_JSON: JSON.stringify([
        { issuer: origin, subject: browser.subject, localId: browser.localId },
      ]),
    },
  };
}
export function readCredential(reference) {
  const state = lstatSync(reference.file);
  assert(
    state.isFile() && state.uid === process.getuid() && (state.mode & 0o077) === 0,
    'Credential reference must be an operator-owned regular file, mode 0600',
  );
  assert(/^[A-Z][A-Z0-9_]+$/.test(reference.passwordKey), 'Invalid credential variable reference');
  const password = parseEnv(readFileSync(reference.file, 'utf8'))[reference.passwordKey];
  assert(password, 'Credential reference is empty');
  return password;
}
export async function browserRehearsal({
  browser,
  settings,
  names,
  output,
  network,
  images,
  start,
  helper,
  docker,
  put,
  networks,
  username,
}) {
  const credentialFile = join(output, 'browser-credentials.json');
  assert(
    !existsSync(credentialFile),
    'Preserve existing credential files; select a new rehearsal output',
  );
  put(credentialFile, {
    username,
    password: readCredential(browser.credentialReference),
  });
  try {
    const protocol = helper(
      network,
      readFileSync(new URL('./browser-protocol.mjs', import.meta.url), 'utf8'),
      {
        ...names,
        origin: settings.origin,
        client: settings.client,
        subject: browser.subject,
        localId: browser.localId,
      },
    );
    put(join(output, 'browser-protocol.json'), protocol);
    const front = network + '-front';
    docker('network', 'create', front);
    networks.push(front);
    const runtime = join(output, 'runtime.json');
    put(runtime, {
      schema: 1,
      products: { emberpath: '/api/emberpath' },
      identity: {
        issuer: settings.origin,
        apiPrefix: '/api/oathweave',
        clients: { emberpath: settings.client },
      },
    });
    chmodSync(runtime, 0o644);
    start(
      names.ui,
      network,
      images.hivexui,
      {},
      [[runtime, '/usr/share/nginx/html/runtime.json', true]],
      ['nginx', '-g', 'daemon off;'],
      [
        '--user',
        '101:101',
        '--tmpfs',
        '/var/cache/nginx:uid=101,gid=101,mode=700',
        '--tmpfs',
        '/var/run:uid=101,gid=101,mode=700',
      ],
    );
    const routes = (prefix, target, port, rewrite) =>
      `handle_path ${prefix}/* {\n rewrite * ${rewrite}{uri}\n reverse_proxy https://${target}:${port} {\n transport http {\n tls_trusted_ca_certs /config/transport.crt\n tls_server_name ${target}\n }\n }\n }`;
    const caddy = join(output, 'Caddyfile');
    put(
      caddy,
      `{\n admin off\n auto_https disable_redirects\n}\n:8443 {\n tls /config/transport.crt /config/transport.key\n ${routes('/api/oathweave', names.identity, 4200, '/api/v1')}\n ${routes('/api/emberpath', names.models, 4020, '/api')}\n handle {\n reverse_proxy http://${names.ui}:8080\n }\n}\n`,
    );
    start(
      names.ingress,
      front,
      images.ingress,
      { XDG_DATA_HOME: '/tmp/data', XDG_CONFIG_HOME: '/tmp/config' },
      [
        [caddy, '/config/Caddyfile', true],
        [join(output, 'transport.crt'), '/config/transport.crt', true],
        [join(output, 'transport.key'), '/config/transport.key', true],
      ],
      ['caddy', 'run', '--config', '/config/Caddyfile', '--adapter', 'caddyfile'],
      ['--publish', '127.0.0.1:' + browser.port + ':8443'],
    );
    docker('network', 'connect', network, names.ingress);
    put(join(output, 'browser-review.json'), {
      origin: settings.origin,
      credentialFile: join(output, 'browser-credentials.json'),
      status:
        protocol.status === 'blocked-password-expired'
          ? 'password-expiry-browser-review-only'
          : 'ready-for-authenticated-browser-review',
      productionCutover: false,
    });
    const seconds = browser.reviewSeconds || 0;
    assert(
      Number.isInteger(seconds) && seconds >= 0 && seconds <= 300,
      'Browser review pause must be 0..300 seconds',
    );
    if (seconds) {
      console.log(
        JSON.stringify({
          installation: browser.installation,
          reviewOrigin: settings.origin,
          reviewSeconds: seconds,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
    return {
      protocol,
      renderAcceptance: 'separate-browser-review-required',
      origin: settings.origin,
    };
  } finally {
    unlinkSync(credentialFile);
  }
}
