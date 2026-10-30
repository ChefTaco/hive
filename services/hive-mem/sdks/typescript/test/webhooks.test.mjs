import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { signHiveMemWebhookBody, verifyHiveMemWebhook } from '../dist/index.js';

test('webhook verifier rejects forgery, expiry and concurrent nonce replay', async () => {
  const secret = randomBytes(32).toString('hex');
  const body = JSON.stringify({ event_id: 'sdk-fixture', data: 'private fixture' });
  const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = 'fixture-nonce';
  const signature = await signHiveMemWebhookBody(secret, body, timestamp, nonce);
  const options = { secret, body, timestamp, nonce, signature, seenNonces: new Set() };
  assert.equal(await verifyHiveMemWebhook({ ...options, body: body + ' ' }), false);
  assert.equal(options.seenNonces.size, 0, 'Forgery must not consume a valid nonce');
  const accepted = await Promise.all(Array.from({ length: 16 }, () => verifyHiveMemWebhook(options)));
  assert.equal(accepted.filter(Boolean).length, 1);
  assert.equal(await verifyHiveMemWebhook(options), false);
  for (const timestamp of ['0', 'NaN', options.timestamp + 'junk', '-1', '1e3']) {
    assert.equal(await verifyHiveMemWebhook({ ...options, seenNonces: new Set(), timestamp }), false);
  }
  for (const toleranceSeconds of [NaN, Infinity, -1]) assert.equal(await verifyHiveMemWebhook({ ...options, seenNonces: new Set(), toleranceSeconds }), false);
});
