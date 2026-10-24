#!/usr/bin/env python3
"""Host-bound, quiesced Hive state archive. Invoked remotely by hive-backup.ts."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import socket
import ssl
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request


def env_file(path):
    result = {}
    for line in Path(path).read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            result[key.strip()] = value.strip().strip('\"\'')
    return result


def qdrant(env, method, route, data=None):
    url = env.get('HIVEMEM_QDRANT_URL', env.get('QDRANT_URL', 'http://' + env.get('HIVEMEM_QDRANT_HOST', '127.0.0.1') + ':' + env.get('HIVEMEM_QDRANT_PORT', '6333')))
    headers = {'api-key': env['QDRANT_API_KEY']} if env.get('QDRANT_API_KEY') else {}
    if data is not None:
        data = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    return urllib.request.urlopen(urllib.request.Request(url.rstrip('/') + route, data=data, headers=headers, method=method), timeout=120)


def qdrant_collection_names(payload):
    """Return every live Qdrant collection exactly once in stable order."""
    try:
        collections = payload['result']['collections']
    except (KeyError, TypeError):
        raise RuntimeError('Invalid Qdrant collection inventory')
    names = []
    for item in collections:
        name = item.get('name') if isinstance(item, dict) else None
        if not isinstance(name, str) or not name:
            raise RuntimeError('Invalid Qdrant collection name')
        names.append(name)
    if len(names) != len(set(names)):
        raise RuntimeError('Duplicate Qdrant collection name')
    return sorted(names)


class Redis:
    def __init__(self, url):
        parsed = urllib.parse.urlparse(url)
        self.socket = socket.create_connection((parsed.hostname or 'localhost', parsed.port or 6379), timeout=10)
        if parsed.scheme == 'rediss':
            self.socket = ssl.create_default_context().wrap_socket(self.socket, server_hostname=parsed.hostname)
        self.file = self.socket.makefile('rb')
        if parsed.password:
            credentials = [urllib.parse.unquote(parsed.password)]
            if parsed.username: credentials.insert(0, urllib.parse.unquote(parsed.username))
            self.command('AUTH', *credentials)
        self.command('SELECT', parsed.path.lstrip('/') or '0')

    def command(self, *parts):
        values = [part if isinstance(part, bytes) else str(part).encode() for part in parts]
        self.socket.sendall(b'*%d\r\n' % len(values) + b''.join(b'$%d\r\n' % len(v) + v + b'\r\n' for v in values))
        return self.read()

    def read(self):
        line = self.file.readline()
        kind, value = line[:1], line[1:-2]
        if kind == b'-': raise RuntimeError('Redis backup command failed')
        if kind == b'+': return value
        if kind == b':': return int(value)
        if kind == b'$':
            size = int(value)
            if size < 0: return None
            result = self.file.read(size)
            if len(result) != size or self.file.read(2) != b'\r\n': raise RuntimeError('Truncated Redis response')
            return result
        if kind == b'*': return [self.read() for _ in range(int(value))]
        raise RuntimeError('Invalid Redis response')

    def keys(self, prefix):
        cursor = b'0'
        while True:
            cursor, keys = self.command('SCAN', cursor, 'MATCH', prefix + '*', 'COUNT', 500)
            yield from keys
            if cursor == b'0': break


def checked(command):
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)


def inventory():
    iam = env_file('/opt/hive-iam/.env')
    memory = env_file('/opt/hivemem/.env')
    router = env_file('/opt/hive-router/shared/.env')
    paths = ['/opt/hive-router/shared',
             '/opt/hive-router/current/prisma/schema.prisma',
             '/opt/hive-router/current/src/storage/generated-sqlite-schema.ts',
             '/opt/hive-iam/.env', '/opt/hive-iam/certs',
             '/var/lib/hive-iam-pki', '/var/lib/hive-iam-keyring/current',
             str(Path('/var/lib/hive-iam-keyring/current').resolve()),
             '/opt/hivemem/.env', '/opt/hivemem/certs', memory.get('HIVEMEM_STORAGE_PATH', '/var/opt/hivemem')]
    for env, root in [(iam, '/opt/hive-iam'), (router, '/opt/hive-router/current')]:
        database = env.get('DATABASE_URL', '')
        if not database.startswith('file:'): raise RuntimeError('Backup requires an inventoried SQLite database')
        db_path = Path(database[5:].split('?')[0])
        if not db_path.is_absolute(): db_path = Path(root) / db_path
        paths.append(str(db_path.resolve().parent))
    audit = iam.get('AUDIT_LOG_DIR', '/opt/hive-iam/audit-logs')
    if Path(audit).exists(): paths.append(audit)
    units = ['hive-router', 'hive-iam', 'hivemem']
    if Path('/opt/hive-skills/shared/.env').exists():
        skills = env_file('/opt/hive-skills/shared/.env')
        paths.extend(['/opt/hive-skills/shared/.env', skills.get('HIVE_SKILLS_DATA_DIR', '/opt/hive-skills/shared/data')])
        units.insert(0, 'hive-skills')
    for unit in units: paths.append('/etc/systemd/system/' + unit + '.service')
    unique = []
    for path in sorted(set(paths), key=len):
        if path == '/' or not Path(path).exists(): raise RuntimeError('Required state path is missing: ' + path)
        if not any(path.startswith(parent.rstrip('/') + '/') for parent in unique): unique.append(path)
    return unique, units, iam, memory


def backup(host, archive):
    if socket.gethostname().split('.')[0].lower() != host.lower(): raise RuntimeError('Target hostname does not match requested installation')
    paths, units, iam, memory = inventory()
    active = [unit for unit in units if subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0]
    started = time.time()
    with tempfile.TemporaryDirectory(prefix='hive-state-') as temporary:
        stage = Path(temporary)
        os.chmod(stage, 0o700)
        try:
            for unit in active: checked(['systemctl', 'stop', unit])
            snapshots = []
            collections = qdrant_collection_names(json.load(qdrant(memory, 'GET', '/collections')))
            for index, name in enumerate(collections):
                route = '/collections/' + urllib.parse.quote(name, safe='') + '/snapshots'
                snapshot = json.load(qdrant(memory, 'POST', route))['result']
                file = 'qdrant-%d.snapshot' % index
                with qdrant(memory, 'GET', route + '/' + urllib.parse.quote(snapshot['name'], safe='')) as response, (stage / file).open('wb') as output:
                    shutil.copyfileobj(response, output, 1024 * 1024)
                digest = hashlib.file_digest((stage / file).open('rb'), 'sha256').hexdigest()
                if snapshot.get('checksum') and snapshot['checksum'] != digest: raise RuntimeError('Qdrant checksum mismatch')
                snapshots.append({'collection': name, 'file': file, 'sha256': digest})
                qdrant(memory, 'DELETE', route + '/' + urllib.parse.quote(snapshot['name'], safe='')).close()
            redis = Redis(iam['REDIS_URL'])
            prefix = iam.get('REDIS_PREFIX', 'hive-iam')
            if not prefix or any(c in prefix for c in '*?[]'): raise RuntimeError('Unsafe Redis namespace')
            records = []
            for key in redis.keys(prefix):
                payload = redis.command('DUMP', key)
                ttl = redis.command('PTTL', key)
                if payload is not None: records.append({'key': base64.b64encode(key).decode(), 'dump': base64.b64encode(payload).decode(), 'expiresAt': int(time.time()*1000) + ttl if ttl > 0 else None})
            (stage / 'redis.json').write_text(json.dumps({'prefix': prefix, 'records': records}))
            manifest = {'schemaVersion': 2, 'host': host, 'machineId': Path('/etc/machine-id').read_text().strip(), 'createdAt': time.time(), 'paths': paths, 'activeUnits': active, 'qdrant': snapshots, 'redisKeys': len(records)}
            (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2))
            with tarfile.open(archive, 'w:gz', dereference=False) as tar:
                for path in paths:
                    # Never archive obsolete keyring releases, runtime locks, or caches.
                    tar.add(path, arcname='state/' + path.lstrip('/'), filter=lambda member: None if Path(member.name).name in ('writer.lock', 'node_modules', 'backups') else member)
                manifest['files'] = {member.name: hashlib.file_digest(Path('/' + member.name[6:]).open('rb'), 'sha256').hexdigest() for member in tar.getmembers() if member.isfile()}
                manifest['files']['recovery/redis.json'] = hashlib.file_digest((stage / 'redis.json').open('rb'), 'sha256').hexdigest()
                (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2))
                tar.add(stage, arcname='recovery')
            os.chmod(archive, 0o600)
        finally:
            for unit in reversed(active): checked(['systemctl', 'start', unit])
    print(json.dumps({'host': host, 'seconds': round(time.time()-started, 2), 'archive': archive, 'qdrantCollections': len(snapshots), 'redisKeys': len(records)}))


def verify(archive, host):
    with tarfile.open(archive) as tar:
        manifest = json.load(tar.extractfile('recovery/manifest.json'))
        if manifest.get('schemaVersion') != 2 or manifest.get('host') != host: raise RuntimeError('Archive belongs to a different installation or unsupported format')
        seen = set()
        for member in tar.getmembers():
            if member.name in seen: raise RuntimeError('Duplicate archive entry')
            seen.add(member.name)
            if not (member.isfile() or member.isdir() or member.issym()): raise RuntimeError('Unsupported archive entry')
            if member.issym() and member.name != 'state/var/lib/hive-iam-keyring/current': raise RuntimeError('Unexpected state symlink')
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or path.parts[0] not in ('state', 'recovery'): raise RuntimeError('Unsafe archive path')
        for name, digest in manifest.get('files', {}).items():
            if hashlib.file_digest(tar.extractfile(name), 'sha256').hexdigest() != digest: raise RuntimeError('State checksum mismatch')
        if not manifest.get('files'): raise RuntimeError('Archive lacks state integrity manifest')
        for snapshot in manifest['qdrant']:
            file = tar.extractfile('recovery/' + snapshot['file'])
            if hashlib.file_digest(file, 'sha256').hexdigest() != snapshot['sha256']: raise RuntimeError('Snapshot checksum mismatch')
        return manifest


def restore_isolated(archive, host, root):
    """Materialize a host-specific recovery tree; never overwrite running state."""
    manifest = verify(archive, host)
    destination = Path(root).resolve()
    if destination == Path('/') or destination.exists(): raise RuntimeError('Recovery root must be a new isolated directory')
    destination.mkdir(parents=True, mode=0o700)
    started = time.time()
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            target = destination / member.name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if member.isdir(): target.mkdir(exist_ok=True, mode=0o700)
            elif member.issym():
                original = Path(member.linkname)
                if not original.is_absolute(): original = Path('/var/lib/hive-iam-keyring') / original
                if '..' in original.parts or not str(original).startswith('/var/lib/hive-iam-keyring/'): raise RuntimeError('Unsafe keyring link')
                target.symlink_to(os.path.relpath(destination / 'state' / str(original).lstrip('/'), target.parent))
            else:
                with target.open('xb') as output: shutil.copyfileobj(tar.extractfile(member), output, 1024 * 1024)
                target.chmod(0o600)
    databases = 0
    for path in (destination / 'state').rglob('*'):
        if not path.is_file() or path.is_symlink(): continue
        with path.open('rb') as file: header = file.read(16)
        if header != b'SQLite format 3\x00': continue
        connection = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
        try:
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise RuntimeError('Restored SQLite integrity failure')
            if connection.execute('PRAGMA foreign_key_check').fetchone(): raise RuntimeError('Restored SQLite foreign key failure')
        finally: connection.close()
        databases += 1
    result = {'host': host, 'root': str(destination), 'seconds': round(time.time() - started, 2), 'sqliteDatabases': databases, 'qdrantCollections': len(manifest['qdrant']), 'servicesStarted': False, 'status': 'staged-and-verified', 'snapshotAt': manifest['createdAt']}
    (destination / 'recovery/result.json').write_text(json.dumps(result, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['backup', 'verify', 'restore-isolated'])
    parser.add_argument('--host', required=True)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--root')
    args = parser.parse_args()
    if args.mode == 'backup': backup(args.host, args.archive)
    elif args.mode == 'verify': print(json.dumps(verify(args.archive, args.host)))
    else:
        if not args.root: parser.error('--root is required for isolated recovery')
        print(json.dumps(restore_isolated(args.archive, args.host, args.root)))


if __name__ == '__main__': main()
