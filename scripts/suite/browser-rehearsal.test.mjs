import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserSettings, readCredential } from './browser-rehearsal.mjs';

test('browser rehearsal uses only the explicitly reviewed local account and audience', () => {
  const result = browserSettings(
    { port: 5443, subject: 'fake-reviewed-subject', localId: 'fake-existing-local-id' },
    { identity: 'isolated-identity' },
  );
  const links = JSON.parse(result.models.EMBERPATH_OATHWEAVE_IDENTITIES_JSON);
  assert.deepEqual(links, [
    {
      issuer: 'https://localhost:5443',
      subject: 'fake-reviewed-subject',
      localId: 'fake-existing-local-id',
    },
  ]);
  const policies = JSON.parse(result.identity.IAM_BROWSER_CLIENT_POLICIES);
  assert.equal(policies[result.client].audience, 'emberpath');
  assert.ok(policies[result.client].permissions.every((value) => value.endsWith(':read')));
  assert.throws(() => browserSettings({ port: 443, subject: 'fake', localId: 'fake' }, {}));
  assert.throws(() => browserSettings({ port: 5443, subject: '', localId: 'fake' }, {}));
});

test('credential references reject readable-by-others files and symbolic links', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-browser-credentials-'));
  try {
    const file = join(directory, 'credentials.env');
    writeFileSync(file, 'TEST_PASSWORD=obviously-fake-password\n', { mode: 0o600 });
    const reference = { file, passwordKey: 'TEST_PASSWORD' };
    assert.equal(readCredential(reference), 'obviously-fake-password');
    chmodSync(file, 0o640);
    assert.throws(() => readCredential(reference), /mode 0600/);
    chmodSync(file, 0o600);
    const link = join(directory, 'credentials-link.env');
    symlinkSync(file, link);
    assert.throws(() => readCredential({ ...reference, file: link }), /regular file/);
    assert.throws(() => readCredential({ ...reference, passwordKey: 'MISSING_PASSWORD' }), /empty/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
