import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyEvent, parseRawDiff, recoveryScope } from './ci-recovery-scope.mjs';
const change = (path, extra = {}) => ({ path, status: 'M', oldMode: '100644', newMode: '100644', ...extra });

test('only presentation-only PR changes select the small corpus', () => {
  assert.equal(recoveryScope([change('services/hive-router/ui/src/App.tsx'), change('README.md')]).full, false);
  for (const path of ['hive.sh', 'scripts/suite/snapshot-data.mjs', 'deployment/Caddyfile', 'releases/2.4.0.json', '.github/workflows/hive-ci.yml', 'package.json', 'services/hive-router/ui/package-lock.json', 'services/hive-router/src/contracts/iam.ts', 'services/hive-router/prisma/schema.prisma', 'services/hive-mem/ts-core/src/index.ts', 'unknown/file', 'services/hive-router/ui/src/../src/App.tsx']) {
    assert.equal(recoveryScope([change(path)]).full, true, path);
    assert.equal(recoveryScope([change('README.md'), change(path)]).full, true, path);
  }
  assert.equal(recoveryScope([]).full, true);
  for (const extra of [{ status: 'D' }, { status: 'R' }, { newMode: '120000' }, { oldMode: '100755' }]) assert.equal(recoveryScope([change('README.md', extra)]).full, true);
});

test('raw parsing preserves special modes and refuses malformed or renamed records', () => {
  const raw = ':100644 100644 aaaa bbbb M\0README.md\0';
  assert.deepEqual(parseRawDiff(raw), [change('README.md')]);
  for (const input of [raw.slice(0, -1), ':100644 100644 a b R100\0a\0b\0', ':100644 100644 a b M\0']) assert.throws(() => parseRawDiff(input));
});

test('main, releases, manual events and uncertain history always use full recovery', () => {
  const event = { pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } } };
  for (const name of ['push', 'workflow_dispatch', 'workflow_call', undefined]) assert.equal(classifyEvent(name, event).full, true);
  assert.equal(classifyEvent('pull_request', {}).full, true);
  assert.equal(classifyEvent('pull_request', event, () => { throw Error('No history'); }).full, true);
  assert.equal(classifyEvent('pull_request', event, (...args) => args[0] === 'diff' ? ':100644 100644 a b M\0README.md\0' : '').full, false);
  assert.equal(classifyEvent('pull_request', event, (...args) => args[0] === 'diff' ? 'truncated' : '').full, true);
});
