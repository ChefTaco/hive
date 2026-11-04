// Developer-owned HTTPS protocol fixture outside the suite inventory. No inference
// runtime or model is installed. Exercise the real adapter against real Emberpath.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function rehearseExternalProvider({
  root,
  output,
  owned,
  origin,
  token,
  request,
  execute,
  environment,
  docker,
}) {
  const put = (name, value) => {
    const path = join(output, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    chmodSync(path, 0o600);
    return path;
  };
  const compose = join(owned, 'compose.json');
  const container = docker('compose', '-f', compose, 'ps', '-q', 'emberpath');
  const networks = JSON.parse(
    docker('inspect', container, '--format', '{{json .NetworkSettings.Networks}}'),
  );
  const gateway = Object.values(networks)
    .map((network) => network.Gateway)
    .find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
  assert(gateway, 'A developer bridge gateway is required');
  const key = join(output, 'external-fixture.key'),
    cert = join(output, 'external-fixture.crt'),
    csr = join(output, 'external-fixture.csr');
  const authority = join(owned, 'config/.initializer/certificates/authority.pem');
  const extensions = put(
    'external-fixture.extensions',
    `subjectAltName=IP:${gateway}\nextendedKeyUsage=serverAuth\n`,
  );
  execute('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    csr,
    '-subj',
    '/CN=synthetic-external-fixture',
  ]);
  execute('openssl', [
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    authority,
    '-CAkey',
    join(owned, 'config/.initializer/keys/authority.pem'),
    '-set_serial',
    '0x' + randomBytes(16).toString('hex'),
    '-out',
    cert,
    '-days',
    '1',
    '-extfile',
    extensions,
  ]);
  chmodSync(key, 0o600);
  chmodSync(cert, 0o600);
  chmodSync(csr, 0o600);
  let failGeneration = true;
  const calls = { discovery: 0, generation: 0, streaming: 0, unexpected: 0 };
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (req, res) => {
      try {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET' && req.url === '/v1/models') {
          calls.discovery++;
          res.end(JSON.stringify({ data: [{ id: 'synthetic-external-model', object: 'model' }] }));
          return;
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          assert.equal(body.model, 'synthetic-external-model');
          if (body.stream) {
            calls.streaming++;
            res.setHeader('Content-Type', 'text/event-stream');
            res.write(
              'data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }) + '\n\n',
            );
            res.end('data: [DONE]\n\n');
          } else {
            calls.generation++;
            res.end(
              JSON.stringify({
                id: 'synthetic-completion',
                object: 'chat.completion',
                model: body.model,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: failGeneration ? '' : 'OK' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
              }),
            );
          }
          return;
        }
        calls.unexpected++;
        res.statusCode = 404;
        res.end('{}');
      } catch {
        calls.unexpected++;
        res.statusCode = 400;
        res.end('{}');
      }
    },
  );
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, gateway, done);
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  };
  try {
    const endpoint = `https://${gateway}:${server.address().port}/v1`;
    const credentials = put('external-enrollment.header', 'Authorization: Bearer ' + token + '\n');
    const transaction = JSON.parse(readFileSync(join(owned, 'transaction.json'), 'utf8'));
    const installation = JSON.parse(readFileSync(join(owned, 'installation.json'), 'utf8'));
    const input = {
      directory: owned,
      installation: installation.installation,
      host: installation.host,
      plan: transaction.plan,
      version: transaction.version,
      operation: transaction.operation,
      action: 'adapters-accept',
      agents: [],
      inference: [
        {
          id: 'external-proof',
          host: installation.host,
          engine: 'openai',
          endpoint,
          caFile: authority,
          model: { id: 'synthetic-external-model' },
          registration: {
            endpoint: origin,
            apiPrefix: '/api/emberpath',
            caFile: join(output, 'console.crt'),
            credentialFile: credentials,
            providerSlug: 'synthetic-external',
            aliases: ['synthetic-external-alias'],
          },
        },
      ],
    };
    const code = ['adapters-host.sh', 'inference-registration.sh', 'host-runtime.sh']
      .map((file) => readFileSync(join(root, 'scripts/suite', file), 'utf8'))
      .join('\n');
    async function action(expected) {
      const child = spawn('bash', ['-c', code], {
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let log = '';
      child.stdout.on('data', (chunk) => (log += chunk));
      child.stderr.on('data', (chunk) => (log += chunk));
      const result = new Promise((done, reject) => {
        child.once('error', reject);
        child.once('close', done);
      });
      child.stdin.end(JSON.stringify(input) + '\n');
      const status = await result;
      put('external-adapter-last.log', log);
      assert.equal(
        status === 0,
        expected,
        'External provider adapter outcome differed; inspect its private log',
      );
    }
    const headers = { Authorization: 'Bearer ' + token };
    await action(false);
    assert.equal(
      (await request('/api/emberpath/providers', null, headers)).body.data.length,
      0,
      'Failed generation must precede registration',
    );
    failGeneration = false;
    await action(true);
    await action(true);
    const providers = (await request('/api/emberpath/providers', null, headers)).body.data;
    assert.equal(providers.length, 1);
    assert.equal(providers[0].baseUrl, endpoint);
    const aliases = (await request('/api/emberpath/model-aliases', null, headers)).body.data;
    assert.equal(aliases.filter((alias) => alias.alias === 'synthetic-external-alias').length, 1);
    const run = await request(
      '/api/emberpath/testing/run',
      { modelAlias: 'synthetic-external-alias', prompt: 'Reply with OK.' },
      headers,
    );
    put('external-product-testing.json', run.body);
    assert.equal(run.status, 200);
    assert.equal(
      run.body.data.success,
      true,
      'Emberpath must reach the registered endpoint with certificate verification',
    );
    assert.equal(calls.unexpected, 0);
    put('external-provider-result.json', {
      schema: 1,
      result: 'passed',
      productionCutover: false,
      fixtureOwnedBy: 'developer-test',
      suiteManagedInference: false,
      checks: [
        'failed generation does not register',
        'verified HTTPS discovery/generation/streaming',
        'real Emberpath ingress API enrollment',
        'repeat preserves provider and alias identities',
        'Emberpath inference request reaches external endpoint with verified TLS',
      ],
      calls,
    });
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
