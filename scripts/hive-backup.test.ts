import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { runBackupTool } from './hive-backup.ts';
import { runBackupRestoreDrill } from './hive-backup-drill.ts';

describe('hive backup and restore planner', () => {
  it('backs up every Qdrant collection in deterministic order', () => {
    const engine = new URL('./hive-state-backup.py', import.meta.url).pathname;
    const python = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('hive_state_backup', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = {'result': {'collections': [
  {'name': 'shared_semantic'},
  {'name': '_entities'},
  {'name': 'future_extension'},
  {'name': '_relations'},
]}}
print(json.dumps(module.qdrant_collection_names(payload)))
`;
    const result = spawnSync('python3', ['-c', python, engine], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['_entities', '_relations', 'future_extension', 'shared_semantic']);
  });

  it('renders a backup dry-run plan from the service manifest', () => {
    const result = runBackupTool('backup', ['--host', 'hive:hive.example.com:skills', '--stamp', 'teststamp', '--output-dir', '/tmp/hive-backups']);
    assert.equal(result.applied, false);
    assert.equal(result.plan.services.length, 4);
    assert.match(result.output, /hive-router/);
    assert.match(result.output, /\/opt\/hive-router\/shared/);
    assert.match(result.output, /\/opt\/hive-router\/current\/prisma\/schema.prisma/);
    assert.doesNotMatch(result.output, /\/opt\/hive-router\/releases/);
    assert.match(result.output, /hive-hive-teststamp\.tar\.gz/);
  });

  it('renders a restore dry-run plan and refuses to apply missing archives', () => {
    const result = runBackupTool('restore', ['--host=hive', '--stamp=teststamp', '--output-dir=/tmp/hive-backups']);
    assert.equal(result.applied, false);
    assert.match(result.output, /Restore Plan/);
    assert.match(result.output, /hive-hive-teststamp\.tar\.gz/);
    assert.throws(() => runBackupTool('restore', ['--host=hive', '--stamp=teststamp', '--output-dir=/tmp/hive-backups', '--apply']), /Restore backup file not found/);
  });

  it('runs an applied disposable backup and restore drill', () => {
    const result = runBackupRestoreDrill([]);
    assert.equal(result.hasFailures, false);
    assert.match(result.output, /Backup Restore Drill/);
    assert.match(result.output, /restore-integrity/);
    assert.equal(existsSync(result.archive), false);
  });
});
