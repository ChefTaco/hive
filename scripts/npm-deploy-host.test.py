import importlib.util
import io
import json
import os
import ssl
from pathlib import Path
import sqlite3
import shutil
import tempfile
import types
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('host', Path(__file__).parent / 'lib/npm-deploy-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def report():
    names = ['ordinary memory recall', 'SSE emits incremental content and terminates cleanly', 'streamed memory recall', 'successful provider-bound traces']
    return dict(success=True, model='example-model', checks=[dict(name=name, passed=True) for name in names], cleanup=[dict(name=name, passed=True) for name in ['synthetic memories removed', 'synthetic workspace removed', 'temporary keys removed', 'temporary alias removed', 'temporary provider removed', 'temporary resources confirmed absent', 'operator session logged out']], requests=[dict(stream=True, contentChunks=3, doneFrames=1)])


class HostTests(unittest.TestCase):
    def test_readonly_tls_inspection_uses_configured_issuing_ca_without_http_handlers(self):
        inv = {'services': {'hive-router': {'cwd': '/opt/hive-router/current', 'env': {
            'PUBLIC_ADMIN_URL': 'https://hive.example.com', 'TLS_CERT_PATH': '/opt/fixture/router.crt',
            'HIVE_IAM_INTERNAL_URL': 'https://hive.example.com:4200', 'HIVE_ROUTER_IAM_CA_CERT_PATH': '/opt/fixture/iam-ca.crt',
            'HIVEMEM_INTERNAL_URL': 'https://memory.example.com:18443', 'HIVEMEM_CA_CERT_PATH': '/opt/fixture/memory-ca.crt'}}}}
        context = MagicMock()
        with patch.object(host.ssl, 'create_default_context', return_value=context), patch.object(host.socket, 'create_connection'), patch.object(host.urllib.request, 'urlopen') as http:
            host.tls_inspection(inv)
            self.assertEqual(context.minimum_version, ssl.TLSVersion.TLSv1_2)
            http.assert_not_called()
            self.assertEqual([call.args[0] for call in context.load_verify_locations.call_args_list], ['/opt/fixture/router.crt', '/opt/fixture/iam-ca.crt', '/opt/fixture/memory-ca.crt'])

    def test_readiness_requires_tls12_and_verifies_certificates(self):
        context = MagicMock()
        response = MagicMock()
        response.status = 200
        response.read.return_value = b'{"status":"ready"}'
        response.__enter__.return_value = response
        with patch.object(host, 'endpoints', return_value=[('router', 'https://hive.example.com', '/health/ready', None)]), patch.object(host.ssl, 'create_default_context', return_value=context), patch.object(host.urllib.request, 'urlopen', return_value=response) as opened:
            host.readiness({})
            self.assertEqual(context.minimum_version, ssl.TLSVersion.TLSv1_2)
            self.assertIs(opened.call_args.kwargs['context'], context)

    def test_application_override_cannot_reenable_automation(self):
        host.validate_automation_override('HIVE_AUTO_MIGRATE=false\nexport HIVE_UPDATE_CHECK="false" # explicit\nOTHER_VALUE=fixture')
        for value in ['true', '"true"', 'false-but-not-false', '']:
            with self.assertRaises(RuntimeError):host.validate_automation_override('HIVE_UPDATE_CHECK=' + value)

    def test_sqlite_wal_snapshot_integrity_and_existing_row_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.db'
            db = sqlite3.connect(path)
            db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE revoked(id TEXT PRIMARY KEY); INSERT INTO revoked VALUES ("synthetic-revocation");')
            db.commit()
            before = host.sqlite_snapshot(path)
            self.assertEqual(len(before['revoked']), 1)
            db.execute('INSERT INTO revoked VALUES ("synthetic-new-revocation")')
            db.commit()
            self.assertNotEqual(before, host.sqlite_snapshot(path))
            db.close()

    def test_model_ack_requires_correct_model_stream_and_successful_cleanup(self):
        host.validate_report(report(), 'example-model')
        for mutate in [lambda r:r.update(model='other'), lambda r:r.update(success=False), lambda r:r.update(cleanup=[]), lambda r:r['requests'][0].update(contentChunks=1), lambda r:r['checks'].pop(), lambda r:r['cleanup'][0].update(passed=False)]:
            value = report()
            mutate(value)
            with self.assertRaises(RuntimeError):host.validate_report(value, 'example-model')

    def test_invalid_paths_and_stale_acceptance_are_rejected_without_commands(self):
        with patch.object(host, 'ROOT', Path('/opt/fixture')), patch.object(host.subprocess, 'run') as execute:
            with self.assertRaises(RuntimeError):host.rpc(dict(operation='status', id='../escape'))
            execute.assert_not_called()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tx = root / 'fixture-transaction'
            tx.mkdir()
            host.private_json(tx/'transaction.json',dict(phase='complete'))
            with patch.object(host, 'ROOT', root):
                with self.assertRaises(RuntimeError):host.rpc(dict(operation='model-ack', id=tx.name, report=report()))

    def test_durable_interruption_requires_recovery_and_records_private_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tx = root/'fixture-transaction'
            tx.mkdir()
            host.private_json(tx/'transaction.json',dict(phase='migrating'))
            with patch.object(host, 'ROOT', root), patch.object(host, 'property_value', return_value='failed'):
                self.assertEqual(host.rpc(dict(operation='status', id=tx.name))['phase'], 'recovery-required')
            self.assertEqual((tx/'transaction.json').stat().st_mode & 0o777, 0o600)

    def transaction_fixture(self, fail='', restrictive_umask=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transactions = root/'transactions'
            tx = transactions/'fixture-transaction'
            tx.mkdir(parents=True)
            (root/'units').mkdir()
            base = root/'npm'
            old = base/'releases/old/runtime'
            old.mkdir(parents=True)
            (base/'current').symlink_to('releases/old')
            database = root/'state.db'
            db = sqlite3.connect(database)
            db.executescript('CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ("synthetic-user");')
            db.close()
            protected = root/'signing-key'
            protected.write_text('synthetic signing material')
            service = dict(component='iam', package='hive-iam-server', entry='dist/cli.js', cwd=str(root), env={key:'false' for key in host.SWITCHES}, user='deploy', uid=1000, gid=1000, groups=[1000], database=str(database), protected=[str(protected)], base=str(base))
            inv = dict(host='example', machine='synthetic-machine', node='v24.22.3', services={'hive-iam':service}, projects=[dict(base=str(base), current='releases/old', versions={'@hivemagnus/hive':'1.2.1', '@hivemagnus/hive-iam-server':'1.2.1', '@hivemagnus/hivemem-server':'1.2.1'})])
            inv['services']['hivemem']={**service,'component':'memory','database':None,'env':{**service['env'],'HIVEMEM_STORAGE_PATH':str(root)}}
            request = dict(id=tx.name, version='1.2.2', model='example-model', nativePolicy={})
            host.private_json(tx/'request.json',request)
            host.private_json(tx/'inventory.json',inv)
            host.private_json(tx/'transaction.json',dict(phase='queued'))
            commands=[]
            def execute(args, **kwargs):
                commands.append(args)
                return types.SimpleNamespace(returncode=0)
            def backup(*args):
                if fail=='backup':raise RuntimeError('Synthetic backup failure')
                (tx/'state.tar.gz').write_bytes(b'synthetic verified archive')
            module=types.SimpleNamespace(backup=backup, restore_isolated=lambda *args:dict(status='staged-and-verified'), qdrant=lambda *args:io.StringIO('{"result":{"status":"disabled"}}'))
            def sleep(_):
                phase=json.loads((tx/'transaction.json').read_text())['phase']
                if phase=='awaiting-backup-copy':host.private_json(tx/'backup-ack.json',dict(sha256='wrong' if fail=='corrupt' else host.digest(tx/'state.tar.gz')))
                elif phase=='awaiting-model-checks':host.private_json(tx/'model-ack.json',report())
            def migrate(service, directory, args):
                if args[0]=='migrate' and '--plan' not in args and fail=='migration':
                    db=sqlite3.connect(database)
                    db.execute('DELETE FROM users')
                    db.commit()
                    db.close()
                    raise RuntimeError('Synthetic incompatible migration')
                return dict(pending=[],dataChanged=False)
            def flock(*args):
                if fail=='lock':raise BlockingIOError('Synthetic contention')
            with patch.multiple(host, ROOT=transactions, LOCK=root/'lock', SYSTEMD=root/'units', AUTOMATION=root/'automation.env'), patch.object(host,'inspect',return_value=inv), patch.object(host,'public_inventory',return_value={'machine':'fixture'}), patch.object(host,'engine',return_value=module), patch.object(host,'run_service',side_effect=migrate), patch.object(host.subprocess,'run',side_effect=execute), patch.object(host,'verify_static'), patch.object(host,'qdrant_inventory',return_value={'fixture-collection':1}), patch.object(host,'readiness',return_value={'iam':{'version':'1.2.2'}}), patch.object(host.time,'sleep',side_effect=sleep), patch.object(host.fcntl,'flock',side_effect=flock):
                previous_umask = os.umask(0o077) if restrictive_umask else None
                try:
                    if fail:
                        with self.assertRaises(Exception):host.transaction(tx)
                    else:host.transaction(tx)
                finally:
                    if previous_umask is not None:os.umask(previous_umask)
            if restrictive_umask:
                runtime = base/'releases'/tx.name/'runtime'
                self.assertEqual(runtime.stat().st_mode & 0o777, 0o755)
                self.assertEqual(runtime.parent.stat().st_mode & 0o777, 0o755)
                for name in ('request.json', 'inventory.json', 'transaction.json'):
                    self.assertEqual((tx/name).stat().st_mode & 0o777, 0o600)
            state=json.loads((tx/'transaction.json').read_text())
            return state,commands,str((base/'current').readlink())

    def test_backup_failure_or_corruption_never_switches_code_or_restores_data(self):
        for failure in ['backup','corrupt']:
            state,commands,pointer=self.transaction_fixture(failure)
            self.assertEqual(state['phase'],'code-reverted')
            self.assertEqual(pointer,'releases/old')
            self.assertFalse(any('migrate' in command for command in commands))

    def test_incompatible_migration_reverts_pointer_but_keeps_services_stopped(self):
        state,commands,pointer=self.transaction_fixture('migration')
        self.assertEqual(state['phase'],'recovery-required')
        self.assertEqual(pointer,'releases/old')
        self.assertFalse(any(command[:2]==['systemctl','start'] for command in commands))

    def test_transaction_requires_both_backup_and_live_model_receipts(self):
        state,commands,pointer=self.transaction_fixture()
        self.assertEqual(state['phase'],'complete')
        self.assertEqual(pointer,'releases/fixture-transaction')

    def test_service_accounts_can_traverse_staged_code_under_restrictive_worker_umask(self):
        state,_,_=self.transaction_fixture(restrictive_umask=True)
        self.assertEqual(state['phase'],'complete')

    def test_provider_health_telemetry_can_change_but_credentials_and_configuration_cannot(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            database=root/'state.db'
            with sqlite3.connect(database) as db:
                db.executescript('CREATE TABLE Provider(id TEXT PRIMARY KEY,baseUrl TEXT,encryptedAuthSecret TEXT,lastHealthAt TEXT,lastHealthStatus TEXT,lastHealthError TEXT,updatedAt TEXT);')
                db.execute('INSERT INTO Provider VALUES (?,?,?,?,?,?,?)', ('synthetic-provider','https://client.example.com','synthetic-secret','before','unknown',None,'before'))
            shutil.copyfile(database,root/'router-before.db')
            host.private_json(root/'protected.json',{})
            host.private_json(root/'qdrant-before.json',{})
            inventory={'services':{'hive-router':{'component':'router','database':str(database),'user':'deploy','env':{key:'false' for key in host.SWITCHES}}}}
            with patch.object(host,'qdrant_inventory',return_value={}), patch.object(host.subprocess,'run'), patch.object(host.subprocess,'check_output',return_value=''), patch.object(host,'inspect',return_value=inventory):
                with sqlite3.connect(database) as db:
                    db.execute("UPDATE Provider SET lastHealthAt='after',lastHealthStatus='healthy',lastHealthError='synthetic probe result',updatedAt='after'")
                host.verify_static(root,inventory)
                for field,value in [('baseUrl','https://unexpected.example.com'),('encryptedAuthSecret','synthetic-changed-secret')]:
                    with sqlite3.connect(database) as db:
                        db.execute(f'UPDATE Provider SET "{field}"=?',(value,))
                    with self.assertRaisesRegex(RuntimeError,'configuration changed'):
                        host.verify_static(root,inventory)
                    with sqlite3.connect(database) as db:
                        db.execute('UPDATE Provider SET baseUrl=?,encryptedAuthSecret=?',('https://client.example.com','synthetic-secret'))

    def test_lock_contention_does_not_stop_writers_or_leave_an_unfinished_transaction(self):
        state,commands,pointer=self.transaction_fixture('lock')
        self.assertEqual(state['phase'],'failed-before-maintenance')
        self.assertEqual(pointer,'releases/old')
        self.assertFalse(any(command[:2]==['systemctl','stop'] for command in commands))


if __name__=='__main__':unittest.main()
