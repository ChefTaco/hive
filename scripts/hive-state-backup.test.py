import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('hive-state-backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

class RecoveryTests(unittest.TestCase):
    def fixture(self, directory):
        database = Path(directory) / 'fixture.db'
        connection = sqlite3.connect(database)
        connection.execute('CREATE TABLE revoked(token TEXT PRIMARY KEY)')
        connection.execute("INSERT INTO revoked VALUES ('fixture-revoked-id')")
        connection.commit(); connection.close()
        files = {'state/opt/fixture.db': database.read_bytes(), 'recovery/redis.json': b'{"prefix":"fixture:","records":[]}'}
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
