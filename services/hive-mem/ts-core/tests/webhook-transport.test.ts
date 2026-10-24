import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deliverWebhook, publicAddress } from '../src/webhook-transport.js';

test('real HTTPS delivery verifies certificate, HMAC and status without following redirects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hivemem-webhook-'));
  const cert = join(directory, 'cert.pem'); const key = join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const secret = randomBytes(32).toString('hex'); let received = 0; let status = 202;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const signature = 'sha256=' + createHmac('sha256', secret).update(`${request.headers['x-hivemem-timestamp']}.${request.headers['x-hivemem-nonce']}.${body}`).digest('hex');
    assert.equal(request.headers['x-hivemem-signature'], signature); received++;
    response.writeHead(status, { location: 'https://example.invalid' }); response.end('accepted');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  process.env.HIVEMEM_WEBHOOK_ALLOWED_PRIVATE_HOSTS = 'localhost'; process.env.HIVEMEM_WEBHOOK_CA_FILE = cert;
  try {
    const input = { url: `https://localhost:${address.port}/events`, headers: {}, payload: { id: 'fixture-event' }, secret };
    assert.equal(await deliverWebhook(input), 202);
    status = 302; await assert.rejects(deliverWebhook(input), /HTTP 302/);
    status = 503; await assert.rejects(deliverWebhook(input), /HTTP 503/);
    assert.equal(received, 3);
    delete process.env.HIVEMEM_WEBHOOK_CA_FILE;
    await assert.rejects(deliverWebhook(input), /connection/);
    assert.equal(received, 3, 'An untrusted certificate must prevent delivery');
    delete process.env.HIVEMEM_WEBHOOK_ALLOWED_PRIVATE_HOSTS;
    await assert.rejects(deliverWebhook(input), /not permitted/);
    assert.equal(received, 3);
  } finally { delete process.env.HIVEMEM_WEBHOOK_CA_FILE; delete process.env.HIVEMEM_WEBHOOK_ALLOWED_PRIVATE_HOSTS; await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(directory, { recursive: true }); }
});

test('rejects private, link-local, mapped IPv6 and reserved destinations', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(publicAddress(address), false);
});
