import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import ssl
import tarfile
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('hive-state-backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

class RecoveryTests(unittest.TestCase):
    def test_redis_tls_keeps_default_trust_and_requires_tls12(self):
        context = MagicMock()
        with patch.object(backup.socket, 'create_connection') as connect, patch.object(backup.ssl, 'create_default_context', return_value=context), patch.object(backup.Redis, 'command'):
            backup.Redis('rediss://redis.example.com/0')
            self.assertEqual(context.minimum_version, ssl.TLSVersion.TLSv1_2)
            context.wrap_socket.assert_called_once_with(connect.return_value, server_hostname='redis.example.com')

    def test_optional_skills_runtime_is_inventoried_separately(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = root / 'opt/hive-skills/npm/releases/fixture/runtime'
            release.mkdir(parents=True)
            for name in ('package.json', 'package-lock.json'): (release / name).write_text('{}')
            (root / 'opt/hive-skills/npm/current').symlink_to('releases/fixture')
            paths = backup.deployment_paths(['hive-skills'], root)
            self.assertIn(str(release / 'package.json'), paths)
            self.assertIn(str(release / 'package-lock.json'), paths)
            self.assertNotIn(str(release / 'package.json'), backup.deployment_paths(['hive-router'], root))

    def test_deployment_inventory_keeps_overrides_and_resolved_npm_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unit = root / 'etc/systemd/system/hive-router.service'
            unit.parent.mkdir(parents=True)
            unit.write_text('[Service]\n')
            overrides = unit.with_name(unit.name + '.d')
            overrides.mkdir()
            (overrides / '50-npm-runtime.conf').write_text('[Service]\nExecStart=/opt/example/server\n')
            release = root / 'opt/hive-npm/releases/fixture/runtime'
            release.mkdir(parents=True)
            for name in ('package.json', 'package-lock.json'): (release / name).write_text('{}')
            (release / '.npmrc').write_text('fixture-private-configuration')
            (root / 'opt/hive-npm/current').symlink_to('releases/fixture')
            self.assertEqual(set(backup.deployment_paths(['hive-router'], root)), {
                str(unit), str(overrides), str(release / 'package.json'), str(release / 'package-lock.json'),
            })
            (release / 'package-lock.json').unlink()
            with self.assertRaisesRegex(RuntimeError, 'missing package-lock.json'):
                backup.deployment_paths(['hive-router'], root)

    def test_online_capture_uses_a_consistent_database_copy_and_skips_models(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'state-root'
            root.mkdir()
            database = root / 'store.db'
            writer = sqlite3.connect(database)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE fixture (value TEXT)')
            writer.execute("INSERT INTO fixture VALUES ('committed')")
            writer.commit()
            self.assertTrue((root / 'store.db-wal').exists())
            (root / 'audit.jsonl').write_text('{}\n')
            (root / 'model.gguf').write_text('weights')
            (root / 'backups').mkdir()
            (root / 'backups/old.txt').write_text('old')
            stage = Path(directory) / 'stage'
            stage.mkdir()
            archive = Path(directory) / 'archive.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                files, changed, databases = backup.archive_online([str(root)], stage, tar)
            writer.close()
            self.assertEqual(databases, 1)
            self.assertEqual(changed, [])
            names = list(files)
            prefix = 'state/' + str(root).lstrip('/')
            self.assertIn(prefix + '/store.db', names)
            self.assertIn(prefix + '/audit.jsonl', names)
            self.assertFalse([name for name in names if name.endswith(('-wal', '-shm', '.gguf', 'old.txt'))])
            with tarfile.open(archive) as tar:
                content = tar.extractfile(prefix + '/store.db').read()
                self.assertEqual(hashlib.sha256(content).hexdigest(), files[prefix + '/store.db'])
            copy = Path(directory) / 'copy.db'
            copy.write_bytes(content)
            reader = sqlite3.connect(copy)
            self.assertEqual(reader.execute('SELECT value FROM fixture').fetchall(), [('committed',)])
            reader.close()

    def test_relative_audit_directory_resolves_from_the_service_directory(self):
        source = Path(__file__).with_name('hive-state-backup.py').read_text()
        self.assertIn("Path('/opt/hive-iam') / iam.get('AUDIT_LOG_DIR'", source)

    def fixture(self, directory):
        database = Path(directory) / 'fixture.db'
        connection = sqlite3.connect(database)
        connection.execute('CREATE TABLE revoked(token TEXT PRIMARY KEY)')
        connection.execute("INSERT INTO revoked VALUES ('fixture-revoked-id')")
        connection.commit(); connection.close()
        files = {'state/opt/fixture.db': database.read_bytes(), 'recovery/redis.json': b'{"prefix":"fixture:","records":[]}',
                 'state/etc/systemd/system/hive-router.service.d/50-npm-runtime.conf': b'[Service]\nExecStart=/opt/example/server\n',
                 'state/opt/hive-npm/releases/fixture/runtime/package-lock.json': b'{"lockfileVersion":3}'}
        manifest = {'schemaVersion': 2, 'host': 'hive', 'createdAt': 1, 'qdrant': [], 'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        files['recovery/manifest.json'] = json.dumps(manifest).encode()
        archive = Path(directory) / 'archive.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name, content in files.items():
                info = tarfile.TarInfo(name); info.size = len(content); tar.addfile(info, io.BytesIO(content))
        return archive

    def test_restore_preserves_database_and_refuses_host_mix_or_existing_state(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = self.fixture(directory)
            with self.assertRaisesRegex(RuntimeError, 'different installation'): backup.verify(archive, 'memory-host')
            root = Path(directory) / 'recovered'
            result = backup.restore_isolated(archive, 'hive', root)
            self.assertEqual(result['sqliteDatabases'], 1)
            self.assertFalse(result['servicesStarted'])
            connection = sqlite3.connect(root / 'state/opt/fixture.db')
            self.assertEqual(connection.execute('SELECT token FROM revoked').fetchone()[0], 'fixture-revoked-id')
            connection.close()
            self.assertEqual((root / 'state/etc/systemd/system/hive-router.service.d/50-npm-runtime.conf').read_bytes(), b'[Service]\nExecStart=/opt/example/server\n')
            self.assertEqual((root / 'state/opt/hive-npm/releases/fixture/runtime/package-lock.json').read_bytes(), b'{"lockfileVersion":3}')
            with self.assertRaisesRegex(RuntimeError, 'new isolated'): backup.restore_isolated(archive, 'hive', root)

    def test_corruption_fails_before_materialization(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = self.fixture(directory)
            corrupted = Path(directory) / 'corrupt.tar.gz'
            with tarfile.open(archive) as source, tarfile.open(corrupted, 'w:gz') as target:
                for member in source.getmembers():
                    data = source.extractfile(member).read()
                    if member.name.endswith('redis.json'): data = data.replace(b'fixture', b'corrupt')
                    target.addfile(member, io.BytesIO(data))
            with self.assertRaisesRegex(RuntimeError, 'checksum'): backup.restore_isolated(corrupted, 'hive', Path(directory) / 'recovered')
            self.assertFalse((Path(directory) / 'recovered').exists())

if __name__ == '__main__': unittest.main()
