#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';
import { chmod, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const envPath = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!envPath) {
  console.error('Usage: refresh_admin_token.mjs PATH_TO_PRIVATE_ENV');
  process.exit(2);
}

const source = await import('node:fs/promises').then(({ readFile }) => readFile(envPath, 'utf8'));
const lines = source.split(/\r?\n/);

function lastEnvValue(name) {
  let found = '';
  for (const line of lines) {
    if (line.trimStart().startsWith('#') || !line.includes('=')) continue;
    const separator = line.indexOf('=');
    if (line.slice(0, separator).trim() !== name) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    found = value;
  }
  return found;
}

const secret = lastEnvValue('HIVEMEM_JWT_SECRET');
if (Buffer.byteLength(secret) < 32 || /change[_-]?me|placeholder|example|development/i.test(secret)) {
  throw new Error('HIVEMEM_JWT_SECRET must be a non-placeholder secret of at least 32 bytes');
}
if (checkOnly) {
  console.log('HiveMem JWT signing secret passes deployment checks.');
  process.exit(0);
}

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = encode({ alg: 'HS256', typ: 'JWT' });
const payload = encode({
  iss: 'hivemem',
  aud: 'hivemem-api',
  token_type: 'access',
  jti: randomUUID(),
  sub: 'hive-router',
  role: 'admin',
  scope: 'admin:all',
  iat: now,
  exp: now + 30 * 24 * 60 * 60,
});
const unsigned = `${header}.${payload}`;
const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
const tokenLine = `HIVEMEM_ADMIN_TOKEN=${unsigned}.${signature}`;

const retained = lines.filter((line) => {
  if (line.trimStart().startsWith('#') || !line.includes('=')) return true;
  return line.slice(0, line.indexOf('=')).trim() !== 'HIVEMEM_ADMIN_TOKEN';
});
while (retained.at(-1) === '') retained.pop();
retained.push(tokenLine, '');

const tempPath = join(dirname(envPath), `.hivemem-env-${process.pid}-${randomUUID()}.tmp`);
await writeFile(tempPath, retained.join('\n'), { mode: 0o600 });
await chmod(tempPath, 0o600);
await rename(tempPath, envPath);
console.log('Refreshed private HiveMem admin credential.');
