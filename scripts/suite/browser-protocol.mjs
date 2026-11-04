// Isolated acceptance helper; input contains references and reviewed IDs, never passwords.
import https from 'node:https';
import fs from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
const p = JSON.parse(process.argv[1]),
  credential = JSON.parse(fs.readFileSync('/rehearsal/browser-credentials.json'));
async function request(host, port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: host,
        port,
        path,
        method: body ? 'POST' : 'GET',
        ca: fs.readFileSync('/rehearsal/transport.crt'),
        headers: { 'Content-Type': 'application/json', ...headers },
        timeout: 5000,
      },
      (r) => {
        let text = '';
        r.on('data', (b) => (text += b));
        r.on('end', () =>
          resolve({
            status: r.statusCode,
            headers: r.headers,
            body: text ? JSON.parse(text) : null,
          }),
        );
      },
    );
    r.on('error', reject);
    r.on('timeout', () => r.destroy(Error('Authentication request timeout')));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const check = (value, message) => {
  if (!value) throw Error(message);
};
const login = await request(p.identity, 4200, '/api/v1/auth/login', credential);
if (login.status === 403 && login.body?.passwordExpired === true) {
  console.log(
    JSON.stringify({
      status: 'blocked-password-expired',
      existingPasswordAccepted: true,
      passwordReset: false,
      authenticatedBrowserAcceptance: false,
    }),
  );
  process.exit(0);
}
check(
  login.status === 200 && typeof login.body.accessToken === 'string',
  'Existing identity credential was not accepted (status=' +
    login.status +
    ', code=' +
    (login.body?.error || 'none') +
    ', expired=' +
    Boolean(login.body?.passwordExpired) +
    ', mfa=' +
    Boolean(login.body?.mfaRequired) +
    ')',
);
const native = login.body.accessToken,
  registration = await request(
    p.identity,
    4200,
    '/api/v1/clients',
    {
      name: p.client,
      clientType: 'public',
      firstParty: true,
      grantTypes: ['authorization_code'],
      redirectUris: [p.origin + '/auth/callback'],
    },
    { Authorization: 'Bearer ' + native },
  );
check(
  registration.status === 201 && registration.body.client.id === p.client,
  'Public client API did not register the configured identifier',
);
const headers = { Origin: p.origin, 'X-Oathweave-Browser': 'true' },
  session = await request(p.identity, 4200, '/api/v1/auth/login', credential, headers);
check(
  session.status === 200 && !session.body.accessToken && !session.body.refreshToken,
  'Browser sign-in exposed native bearer credentials',
);
const cookie = session.headers['set-cookie']
  .find((value) => value.startsWith('__Host-oathweave_sso='))
  .split(';')[0];
headers.Cookie = cookie;
const verifier = randomBytes(32).toString('base64url'),
  state = randomBytes(32).toString('base64url'),
  nonce = randomBytes(32).toString('base64url');
const code = await request(
  p.identity,
  4200,
  '/api/v1/oauth/authorize',
  {
    clientId: p.client,
    redirectUri: p.origin + '/auth/callback',
    responseType: 'code',
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    codeChallengeMethod: 'S256',
    scope: 'openid profile',
    state,
    nonce,
  },
  headers,
);
check(
  code.status === 200 && code.body.state === state && code.body.iss === p.origin,
  'Browser authorization binding failed',
);
const body = {
    grant_type: 'authorization_code',
    client_id: p.client,
    code: code.body.code,
    code_verifier: verifier,
    redirect_uri: p.origin + '/auth/callback',
  },
  token = await request(p.identity, 4200, '/api/v1/oauth/token', body, headers);
check(
  token.status === 200 && typeof token.body.access_token === 'string',
  'PKCE token exchange failed',
);
const claims = JSON.parse(Buffer.from(token.body.access_token.split('.')[1], 'base64url'));
check(
  claims.sub === p.subject && claims.aud === 'emberpath' && claims.iss === p.origin,
  'Resource identity does not match reviewed ownership',
);
const auth = { Authorization: 'Bearer ' + token.body.access_token };
const me = await request(p.models, 4020, '/api/auth/me', null, auth);
check(
  me.status === 200 && me.body.user.id === p.localId,
  'Receiving product changed the existing local account',
);
const providers = await request(p.models, 4020, '/api/providers', null, auth);
check(providers.status === 200, 'Authorized provider inventory failed');
const denied = await request(
  p.models,
  4020,
  '/api/providers',
  {
    slug: 'must-not-create',
    name: 'Must not create',
    kind: 'OPENAI',
    baseUrl: 'https://provider.example.com',
    authMode: 'NONE',
  },
  auth,
);
check(denied.status === 403, 'Read-only resource credentials allowed a mutation');
const replay = await request(p.identity, 4200, '/api/v1/oauth/token', body, headers);
check(replay.status !== 200, 'Authorization code replay succeeded');
check(
  (await request(p.identity, 4200, '/api/v1/browser/logout', {}, headers)).status === 200,
  'Browser logout failed',
);
const revoked = await request(p.models, 4020, '/api/providers', null, auth);
check(revoked.status === 401, 'Receiving product accepted a revoked session');
console.log(
  JSON.stringify({
    existingPasswordAccepted: true,
    passwordReset: false,
    publicClientRegisteredViaApi: true,
    pkce: true,
    codeReplayDenied: true,
    reviewedLocalIdPreserved: true,
    providerRead: true,
    mutationDenied: true,
    revocation: true,
  }),
);
