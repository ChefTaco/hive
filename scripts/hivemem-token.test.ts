import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { makeTempRoot } from './test-fixtures.ts';

const helper = new URL('../services/hive-mem/scripts/refresh_admin_token.mjs', import.meta.url).pathname;
const memoryJwtKey = ['HIVEMEM', 'JWT', 'SECRET'].join('_');

function values(path: string, name: string): string[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.startsWith(`${name}=`)).map((line) => line.slice(name.length + 1));
}

describe('HiveMem deployment credential helper', () => {
  it('rejects weak secrets and writes one bounded, fully claimed admin token', () => {
    const root = makeTempRoot('hivemem-token-');
    const envPath = join(root, '.env');
    writeFileSync(envPath, `${memoryJwtKey}=short\n`);
    assert.notEqual(spawnSync(process.execPath, [helper, envPath, '--check']).status, 0);

    writeFileSync(envPath, [
      `${memoryJwtKey}=first-secret-value-is-deliberately-not-used`,
      'HIVEMEM_ADMIN_TOKEN=stale',
      `${memoryJwtKey}=second-secret-value-with-at-least-32-bytes`,
      'HIVEMEM_ADMIN_TOKEN=also-stale',
      '',
    ].join('\n'));
    assert.equal(spawnSync(process.execPath, [helper, envPath]).status, 0);
    const tokens = values(envPath, 'HIVEMEM_ADMIN_TOKEN');
    assert.equal(tokens.length, 1);
    const claims = JSON.parse(Buffer.from(tokens[0]!.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    assert.equal(claims['iss'], 'hivemem');
    assert.equal(claims['aud'], 'hivemem-api');
    assert.equal(claims['token_type'], 'access');
    assert.equal(claims['role'], 'admin');
    assert.equal(claims['scope'], 'admin:all');
    assert.equal(typeof claims['jti'], 'string');
    assert.ok((claims['exp'] as number) - (claims['iat'] as number) <= 30 * 24 * 60 * 60);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
  });
});
