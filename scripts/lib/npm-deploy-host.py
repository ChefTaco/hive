"""Privileged worker for the documented systemd/npm layout; no private topology defaults."""
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import signal
import socket
import sqlite3
import ssl
import subprocess
import sys
import time
import urllib.request

ROOT = Path('/var/backups/hive/npm-deploy')
LOCK = Path('/run/lock/hive-npm-deploy.lock')
SYSTEMD = Path('/etc/systemd/system')
SWITCHES = ('HIVE_AUTO_UPGRADE', 'HIVE_AUTO_MIGRATE', 'HIVE_UPDATE_CHECK', 'HIVE_UI_UPGRADE', 'HIVE_COMPOSE_UPGRADE_SUPERVISOR')
AUTOMATION = Path('/etc/hive/automation-off.env')
DROP_IN = '60-hive-automation-off.conf'
PACKAGES = {'hive-iam': ('iam', 'hive-iam-server', 'dist/cli.js', '/opt/hive-iam'),
            'hivemem': ('memory', 'hivemem-server', 'dist/src/cli.js', '/opt/hivemem/ts-core'),
            'hive-skills': ('skills', 'hive-skills', 'dist/cli.js', '/opt/hive-skills/current'),
            'hive-router': ('router', 'hive-router', 'dist/src/index.js', '/opt/hive-router/current')}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def private_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def property_value(unit, name):
    return subprocess.check_output(['systemctl', 'show', unit, '-p', name, '--value'], text=True).strip()


def environment(pid):
    return dict(item.split('=', 1) for item in Path('/proc', str(pid), 'environ').read_bytes().decode().split('\0') if '=' in item)


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def resolve_env_path(value, cwd):
    path = Path(value)
    return str(path if path.is_absolute() else Path(cwd) / path)


def validate_automation_override(text):
    for line in text.splitlines():
        match = re.match(r'^\s*(?:export\s+)?(HIVE_AUTO_UPGRADE|HIVE_AUTO_MIGRATE|HIVE_UPDATE_CHECK|HIVE_UI_UPGRADE|HIVE_COMPOSE_UPGRADE_SUPERVISOR)\s*=\s*(.*)$', line)
        if match:
            require(re.fullmatch(r'''(?:false|"false"|'false')\s*(?:#.*)?''', match[2]), 'Application override could enable automation; reconcile it explicitly')


def inspect():
    services, projects = {}, []
    for unit, (component, package, entry, cwd) in PACKAGES.items():
        if unit == 'hive-skills' and not Path('/opt/hive-skills/shared/.env').exists():
            continue
        require(property_value(unit, 'ActiveState') == 'active', 'Existing service is not active')
        require(property_value(unit, 'UnitFileState') == 'enabled', 'Existing service must be enabled for boot')
        require(property_value(unit, 'WorkingDirectory') == cwd, 'Unsupported working directory')
        user = property_value(unit, 'User')
        account = pwd.getpwnam(user)
        env = environment(property_value(unit, 'MainPID'))
        require(not env.get('HIVE_MANAGED_PROJECT'), 'Use the managed launcher for an enrolled installation')
        base = '/opt/hive-skills/npm' if component == 'skills' else '/opt/hive-npm'
        production = 'dist/index.js' if component == 'iam' else 'dist/server.js' if component == 'skills' else entry
        executable = f'{base}/current/runtime/node_modules/@hivemagnus/{package}/{production}'
        actual = Path('/proc', property_value(unit, 'MainPID'), 'cmdline').read_bytes().decode().split('\0')
        # Skills retains its documented compatibility link as its entrypoint.
        require(executable in actual or (component == 'skills' and '/opt/hive-skills/current/dist/server.js' in actual), 'Process is outside the supported npm layout')
        database = None
        if component in ('iam', 'router'):
            require(env.get('DATABASE_URL', '').startswith('file:'), 'Only SQLite is supported')
            database = resolve_env_path(env['DATABASE_URL'][5:].split('?')[0], cwd)
        elif component == 'skills':
            database = str(Path(env['HIVE_SKILLS_DATA_DIR']) / 'registry.sqlite')
        files = [property_value(unit, 'FragmentPath'), *shlex.split(property_value(unit, 'DropInPaths'))]
        files.extend(re.findall(r'(\S+) \(ignore_errors=(?:yes|no)\)', property_value(unit, 'EnvironmentFiles')))
        for name in ('.env', '.env.apikeys'):
            local = Path(cwd, name)
            if local.is_file():
                files.append(str(local.resolve()))
                if name == '.env.apikeys':
                    validate_automation_override(local.read_text())
        require(files and all(Path(p).is_file() for p in files), 'Unsupported or missing effective unit configuration')
        for key in ('JWT_PRIVATE_KEY_PATH', 'JWT_PUBLIC_KEY_PATH', 'TLS_KEY_PATH', 'TLS_CERT_PATH',
                    'HIVE_SKILLS_TLS_KEY_FILE', 'HIVE_SKILLS_TLS_CERT_FILE', 'HIVEMEM_TLS_KEY_FILE',
                    'HIVEMEM_TLS_CERT_FILE', 'HIVEMEM_TS_TLS_KEY_FILE', 'HIVEMEM_TS_TLS_CERT_FILE',
                    'HIVE_ROUTER_IAM_CA_CERT_PATH', 'HIVEMEM_CA_CERT_PATH'):
            if env.get(key):
                files.append(resolve_env_path(env[key], cwd))
        for path in files:
            require(Path(path).is_file(), 'A protected file is missing')
        if component == 'iam':
            env['IAM_DATA_DIR'] = cwd
        services[unit] = dict(component=component, package=package, entry=entry, cwd=cwd, env=env, user=user,
                              uid=account.pw_uid, gid=account.pw_gid, groups=os.getgrouplist(user, account.pw_gid),
                              database=database, protected=files, base=base)
    for base in ('/opt/hive-npm', '/opt/hive-skills/npm'):
        selected = [s for s in services.values() if s['base'] == base]
        if not selected:
            continue
        current = Path(base, 'current')
        require(current.is_symlink() and current.resolve().is_relative_to(Path(base, 'releases')), 'Unsupported current pointer')
        runtime = current / 'runtime'
        manifest = json.loads((runtime / 'package.json').read_text())
        names = ['@hivemagnus/' + s['package'] for s in selected]
        if base == '/opt/hive-npm':
            names.append('@hivemagnus/hive')
        require(set(manifest['dependencies']) == set(names), 'Unexpected runtime components')
        versions = {name: json.loads((runtime / 'node_modules' / name / 'package.json').read_text())['version'] for name in names}
        require(manifest['dependencies'] == versions, 'Runtime is not exactly pinned')
        projects.append(dict(base=base, current=os.readlink(current), versions=versions))
    return dict(host=socket.gethostname().split('.')[0], machine=digest('/etc/machine-id'),
                node=subprocess.check_output(['node', '--version'], text=True).strip(), services=services, projects=projects)


def public_inventory(value):
    return {**{k: value[k] for k in ('host', 'machine', 'node', 'projects')},
            'protectedFingerprint': hashlib.sha256(json.dumps(protected(value), sort_keys=True).encode()).hexdigest(),
            'services': {name: {'component': s['component'], 'switches': {k: s['env'].get(k) for k in SWITCHES}} for name, s in value['services'].items()}}


def engine(directory):
    spec = importlib.util.spec_from_file_location('hive_backup', directory / 'backup.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    original = module.inventory
    def inventory():
        paths, units, iam, memory = original()
        state = json.loads((directory / 'inventory.json').read_text())
        paths.extend(p for s in state['services'].values() for p in s['protected'])
        if 'hive-skills' in units:
            paths.append('/opt/hive-skills/shared')
            pam = state['services']['hive-skills']['env'].get('HIVE_SKILLS_PAM_SERVICE', 'hive-skills')
            require(re.fullmatch(r'[\w-]+', pam), 'Invalid PAM service')
            paths.append('/etc/pam.d/' + pam)
        unique = []
        for path in sorted(set(paths), key=len):
            if not any(path.startswith(parent.rstrip('/') + '/') for parent in unique):
                unique.append(path)
        return unique, units, iam, memory
    module.inventory = inventory
    return module


def protected(inventory):
    files = set(p for s in inventory['services'].values() for p in s['protected'])
    for base in ('/var/lib/hive-iam-keyring/current', '/var/lib/hive-iam-pki', '/opt/hive-skills/shared/data/archives'):
        files.update(str(p) for p in Path(base).rglob('*') if p.is_file())
    return {path: digest(path) for path in sorted(files)}


def sqlite_snapshot(path):
    db = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
    try:
        require(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'SQLite integrity failure')
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'SQLite foreign key failure')
        result = {}
        for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            rows = []
            for row in db.execute('SELECT * FROM "' + table.replace('"', '""') + '"'):
                encoded = json.dumps([{'bytes': v.hex()} if isinstance(v, bytes) else v for v in row], separators=(',', ':'))
                rows.append(hashlib.sha256(encoded.encode()).hexdigest())
            result[table] = sorted(rows)
        return result
    finally:
        db.close()


def run_service(service, directory, args):
    env = {**service['env'], **{key: 'false' for key in SWITCHES}}
    command = ['node', str(Path(service['base'], 'releases', directory.name, 'runtime/node_modules/@hivemagnus', service['package'], service['entry'])), *args]
    result = subprocess.run(command, env=env, cwd=service['cwd'], user=service['uid'], group=service['gid'], extra_groups=service['groups'], capture_output=True, timeout=600)
    log = directory / (service['component'] + '-' + args[0] + '.log')
    log.write_bytes(result.stdout + result.stderr)
    require(result.returncode == 0, 'Server command failed; inspect protected service log')
    return json.loads(result.stdout) if '--json' in args else None


def endpoints(inventory):
    router = inventory['services']['hive-router']
    env = router['env']
    items = [('router', env['PUBLIC_ADMIN_URL'], '/health/ready', resolve_env_path(env['TLS_CERT_PATH'], router['cwd'])),
             ('iam', env['HIVE_IAM_INTERNAL_URL'], '/api/v1/health/ready', env.get('HIVE_ROUTER_IAM_CA_CERT_PATH')),
             ('memory', env['HIVEMEM_INTERNAL_URL'], '/v1/health/ready', env.get('HIVEMEM_CA_CERT_PATH'))]
    if 'hive-skills' in inventory['services']:
        skills = inventory['services']['hive-skills']['env']
        items.append(('skills', skills['HIVE_SKILLS_PUBLIC_URL'], '/healthz', resolve_env_path(skills['HIVE_SKILLS_TLS_CERT_FILE'], inventory['services']['hive-skills']['cwd'])))
    return [(component, base, path, resolve_env_path(ca, router['cwd']) if ca else None) for component, base, path, ca in items]


def tls_inspection(inventory):
    # Avoid readiness handlers that may update provider-health telemetry in dry-run.
    from urllib.parse import urlsplit
    for _, base, _, ca in endpoints(inventory):
        url = urlsplit(base)
        require(url.scheme == 'https' and url.hostname and not url.username and not url.password, 'Production endpoints require credential-free HTTPS URLs')
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        if ca:
            context.load_verify_locations(ca)
        with socket.create_connection((url.hostname, url.port or 443), timeout=15) as connection:
            with context.wrap_socket(connection, server_hostname=url.hostname):
                pass


def readiness(inventory, versions=None):
    results = {}
    for component, base, path, ca in endpoints(inventory):
        require(base.startswith('https://'), 'Production readiness must use HTTPS')
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        if ca:
            context.load_verify_locations(ca)
        with urllib.request.urlopen(base.rstrip('/') + path, context=context, timeout=15) as response:
            value = json.load(response)
            require(response.status == 200, 'Service is not ready')
            if versions:
                require(value.get('version') == versions[component] and value.get('release') == versions[component], 'Unexpected running version')
            results[component] = {key: value.get(key) for key in ('version', 'release', 'status')}
    return results


def verify_static(directory, inventory):
    before = json.loads((directory / 'protected.json').read_text())
    require(all(digest(path) == value for path, value in before.items()), 'Protected config, key, certificate or archive changed')
    for service in inventory['services'].values():
        if not service['database']:
            continue
        old = sqlite3.connect(directory / (service['component'] + '-before.db'))
        now = sqlite3.connect('file:' + service['database'] + '?mode=ro', uri=True)
        old.row_factory = now.row_factory = sqlite3.Row
        tables = {r[0] for r in old.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        if service['component'] == 'iam':
            tables -= {'audit_logs', 'audit_events', 'sessions', 'refresh_tokens', 'authorization_codes'}
        elif service['component'] == 'router':
            tables &= {'AdminUser', 'ApiDocEntry', 'RouteRule', 'RuntimeSetting', 'Provider', 'ProviderModel', 'ClientApiKey', 'ModelAlias'}
        else:
            tables -= {'sessions', 'audit_log'}
        for table in tables:
            pk = [r[1] for r in old.execute('PRAGMA table_info("' + table + '")') if r[5]]
            rows = old.execute('SELECT * FROM "' + table + '"').fetchall()
            require(pk or not rows, 'Cannot compare table without primary key')
            for row in rows:
                match = now.execute('SELECT * FROM "' + table + '" WHERE ' + ' AND '.join('"' + key + '"=?' for key in pk), [row[key] for key in pk]).fetchone()
                require(match, 'An existing row is missing')
                allowed = {'updatedAt', 'lastUsedAt'}
                if service['component'] == 'router' and table == 'RuntimeSetting' and row['key'] == 'openapi.document':
                    allowed.add('valueJson')  # Exact generated content is checked by the runtime helper.
                require({key for key in row.keys() if row[key] != match[key]} <= allowed, 'Existing application configuration changed')
        old.close()
        now.close()
    points = qdrant_inventory(directory, inventory)
    require(all(name in points and points[name] >= count for name, count in json.loads((directory / 'qdrant-before.json').read_text()).items()), 'Owned Qdrant collection or points lost')
    subprocess.run(['node', str(directory / 'runtime.mjs'), 'documentation', str(directory)], check=True, stdout=subprocess.DEVNULL)
    current = inspect()
    for name, service in current['services'].items():
        require(service['user'] == inventory['services'][name]['user'], 'Service owner changed')
        require(all(service['env'].get(key) == 'false' for key in SWITCHES), 'Automation is not disabled')
    require(not re.search(r'hive\S*(?:upgrade|coordinator|supervisor).*\.timer', subprocess.check_output(['systemctl', 'list-timers', '--all', '--no-pager'], text=True), re.I), 'Automatic upgrade timer enabled')


def qdrant_inventory(directory, inventory):
    module = engine(directory)
    env = inventory['services']['hivemem']['env']
    from urllib.parse import quote
    names = module.qdrant_collection_names(json.load(module.qdrant(env, 'GET', '/collections')))
    return {name: json.load(module.qdrant(env, 'GET', '/collections/' + quote(name, safe='')))['result']['points_count'] for name in names}


def same_version(inventory, version):
    return all(v == version for project in inventory['projects'] for v in project['versions'].values())


def validate_report(report, model):
    required = {'ordinary memory recall', 'SSE emits incremental content and terminates cleanly', 'streamed memory recall', 'successful provider-bound traces'}
    require(report.get('success') is True and report.get('model') == model, 'Live model verification failed')
    require(required <= {item['name'] for item in report['checks'] if item.get('passed') is True}, 'Incomplete live model checks')
    cleanup = {'synthetic memories removed', 'synthetic workspace removed', 'temporary keys removed', 'temporary alias removed', 'temporary provider removed', 'temporary resources confirmed absent', 'operator session logged out'}
    require(cleanup <= {item['name'] for item in report['cleanup'] if item.get('passed') is True}, 'Model cleanup incomplete')
    require(all(item.get('passed') is True for item in report['checks'] + report['cleanup']), 'Model cleanup failed')
    require(any(r.get('stream') and r.get('contentChunks', 0) >= 2 and r.get('doneFrames') == 1 for r in report['requests']), 'Incremental streaming was not verified')


def atomic_pointer(base, target):
    current = Path(base, 'current')
    require((Path(base) / target).resolve().is_relative_to(Path(base, 'releases')), 'Unsafe release pointer')
    temporary = current.with_name('current.npm-deploy-' + str(os.getpid()))
    temporary.symlink_to(target)
    os.replace(temporary, current)


def transaction(directory):
    request = json.loads((directory / 'request.json').read_text())
    inventory = json.loads((directory / 'inventory.json').read_text())
    state = dict(id=directory.name, version=request['version'], phase='started', machine=inventory['machine'], restoreInspectionCommand=f"python3 {directory}/backup.py restore-isolated --host {inventory['host']} --archive {directory}/state.tar.gz --root {directory}/additional-recovery")
    def save(phase):
        state['phase'] = phase
        private_json(directory / 'transaction.json', state)
    def wait_for(file, phase, timeout=900):
        save(phase)
        deadline = time.monotonic() + timeout
        while not file.exists():
            require(time.monotonic() < deadline, 'Controller acknowledgement timed out')
            time.sleep(1)
        return json.loads(file.read_text())
    lock = LOCK.open('w')
    stopped, data_safe = False, True
    order = list(inventory['services'])
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for sibling in ROOT.glob('*/transaction.json'):
            if sibling.parent != directory:
                require(json.loads(sibling.read_text())['phase'] in ('complete', 'code-reverted', 'failed-before-maintenance'), 'An unfinished transaction needs recovery')
        current = inspect()
        require(public_inventory(current) == public_inventory(inventory), 'Stale installation plan')
        readiness(current)
        require(not same_version(inventory, request['version']), 'Target already installed; use verify-only')
        state['previous'] = inventory['projects']
        private_json(directory / 'protected.json', protected(inventory))
        save('staging')
        for project in inventory['projects']:
            target = Path(project['base'], 'releases', directory.name, 'runtime')
            target.mkdir(parents=True, mode=0o755)
            manifest = dict(name='hive-installed-runtime', private=True, type='module', dependencies={name: request['version'] for name in project['versions']}, allowScripts=request['nativePolicy'])
            (target / 'package.json').write_text(json.dumps(manifest, indent=2))
            os.chmod(target / 'package.json', 0o644)
            # Releases must remain traversable by original service accounts.
            os.chmod(target.parent, 0o755)
            with (directory / ('install-' + target.parents[2].name + '.log')).open('wb') as log:
                subprocess.run(['npm', '--prefix', str(target), 'install', '--ignore-scripts', '--omit=dev', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'], check=True, stdout=log, stderr=log, timeout=600, umask=0o022)
                if project['base'] == '/opt/hive-npm':
                    subprocess.run(['npm', '--prefix', str(target), 'rebuild', 'better-sqlite3', 'argon2'], check=True, stdout=log, stderr=log, timeout=600, umask=0o022)
                subprocess.run(['npm', '--prefix', str(target), 'audit', '--omit=dev', '--audit-level=high', '--registry=https://registry.npmjs.org'], check=True, stdout=log, stderr=log, timeout=120)
        subprocess.run(['node', str(directory / 'runtime.mjs'), 'validate', str(directory)], check=True)
        for service in inventory['services'].values():
            run_service(service, directory, ['check', '--json'])
            plan = run_service(service, directory, ['migrate', '--plan', '--json'])
            require(not plan.get('dataChanged') and not plan.get('warnings'), 'Data-changing migration needs a reviewed procedure')
            if service['component'] == 'iam':
                require(not plan['pending'], 'IAM migrations need a reviewed procedure')
        subprocess.run(['node', str(directory / 'runtime.mjs'), 'rehearse', str(directory)], check=True)
        module = engine(directory)
        require(json.load(module.qdrant(inventory['services']['hivemem']['env'], 'GET', '/cluster'))['result']['status'] == 'disabled', 'Only single-node Qdrant is supported')
        # No service outage occurs until all package and migration gates above pass.
        save('stopping')
        stopped = True
        for unit in reversed(order):
            subprocess.run(['systemctl', 'stop', unit], check=True)
        module = engine(directory)
        # backup() sees inactive services and therefore leaves them quiesced.
        save('backing-up')
        archive = directory / 'state.tar.gz'
        module.backup(inventory['host'], str(archive))
        restore = module.restore_isolated(str(archive), inventory['host'], str(directory / 'recovery-proof'))
        state['backup'] = dict(sha256=digest(archive), bytes=archive.stat().st_size, restore=restore)
        ack = wait_for(directory / 'backup-ack.json', 'awaiting-backup-copy')
        require(ack.get('sha256') == state['backup']['sha256'], 'Off-host backup checksum mismatch')
        baseline = {s['component']: sqlite_snapshot(s['database']) for s in inventory['services'].values() if s['database']}
        for service in inventory['services'].values():
            if service['database']:
                source = sqlite3.connect('file:' + service['database'] + '?mode=ro', uri=True)
                dest = sqlite3.connect(directory / (service['component'] + '-before.db'))
                source.backup(dest)
                source.close()
                dest.close()
        # Enforce the independently owned Qdrant and Redis inventory before migration.
        require(json.load(module.qdrant(inventory['services']['hivemem']['env'], 'GET', '/cluster'))['result']['status'] == 'disabled', 'Only single-node Qdrant is supported')
        private_json(directory / 'qdrant-before.json', qdrant_inventory(directory, inventory))
        save('migrating')
        data_safe = False
        for service in inventory['services'].values():
            data = str(Path(service['database']).parent) if service['database'] else service['env']['HIVEMEM_STORAGE_PATH']
            run_service(service, directory, ['migrate', '--backup-dir', data + '/backups'])
        require(baseline == {s['component']: sqlite_snapshot(s['database']) for s in inventory['services'].values() if s['database']}, 'Migration changed database contents')
        data_safe = True
        require(all(digest(path) == value for path, value in json.loads((directory / 'protected.json').read_text()).items()), 'Protected files changed')
        save('configuring-opt-outs')
        expected = ''.join(key + '=false\n' for key in SWITCHES)
        require(not AUTOMATION.exists() or AUTOMATION.read_text() == expected, 'Existing automation configuration differs; reconcile explicitly')
        AUTOMATION.parent.mkdir(mode=0o755, exist_ok=True)
        AUTOMATION.write_text(expected)
        AUTOMATION.chmod(0o600)
        for unit in order:
            drop = SYSTEMD / (unit + '.service.d') / DROP_IN
            expected_drop = '[Service]\nEnvironmentFile=/etc/hive/automation-off.env\n'
            require(not drop.exists() or drop.read_text() == expected_drop, 'Existing automation drop-in differs')
            drop.parent.mkdir(mode=0o755, exist_ok=True)
            drop.write_text(expected_drop)
            drop.chmod(0o644)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        save('switching')
        for project in inventory['projects']:
            atomic_pointer(project['base'], 'releases/' + directory.name)
        save('restarting')
        for unit in order:
            subprocess.run(['systemctl', 'start', unit], check=True)
        expected_versions = {s['component']: request['version'] for s in inventory['services'].values()}
        for attempt in range(30):
            try:
                state['health'] = readiness(inventory, expected_versions)
                break
            except Exception:
                if attempt == 29:
                    raise
                time.sleep(2)
        data_safe = False
        verify_static(directory, inventory)
        data_safe = True
        acknowledgement = wait_for(directory / 'model-ack.json', 'awaiting-model-checks')
        validate_report(acknowledgement, request['model'])
        verify_static(directory, inventory)
        state['health'] = readiness(inventory, expected_versions)
        state['completedAt'] = time.time()
        save('complete')
    except BaseException as error:
        state['error'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        if stopped:
            for unit in reversed(order):
                subprocess.run(['systemctl', 'stop', unit], check=False)
            for project in inventory['projects']:
                atomic_pointer(project['base'], project['current'])
            if data_safe:
                recovered = all(subprocess.run(['systemctl', 'start', unit], check=False).returncode == 0 for unit in order)
                try:
                    previous = {s['component']: project['versions']['@hivemagnus/' + s['package']] for project in inventory['projects'] for s in inventory['services'].values() if s['base'] == project['base']}
                    readiness(inventory, previous)
                except Exception:
                    recovered = False
                save('code-reverted' if recovered else 'recovery-required')
            else:
                save('recovery-required')
        else:
            save('failed-before-maintenance')
        raise
    finally:
        lock.close()


def rpc(payload):
    operation = payload['operation']
    if operation in ('inspect', 'model-config', 'verify'):
        value = inspect()
        if operation == 'inspect':
            tls_inspection(value)
            return public_inventory(value)
        if operation == 'verify':
            require(same_version(value, payload['version']), 'Installed versions differ')
            require(all(s['env'].get(key) == 'false' for s in value['services'].values() for key in SWITCHES), 'Automation is not disabled')
            return dict(health=readiness(value, {s['component']: payload['version'] for s in value['services'].values()}), automationOff=True)
        router, memory = value['services']['hive-router'], value['services']['hivemem']
        from urllib.parse import urlsplit, urlunsplit
        base = urlsplit(router['env']['PUBLIC_ADMIN_URL'])
        api = urlunsplit((base.scheme, base.hostname + ':' + router['env'].get('API_PORT', '4020'), '', '', ''))
        certificates = []
        for path in (resolve_env_path(router['env']['TLS_CERT_PATH'], router['cwd']), router['env'].get('HIVEMEM_CA_CERT_PATH')):
            if path:
                certificates.append(Path(path).read_text())
        return dict(admin=router['env']['PUBLIC_ADMIN_URL'], api=api, memory=router['env']['HIVEMEM_INTERNAL_URL'],
                    token=memory['env'].get('HIVEMEM_ADMIN_TOKEN', ''), ca='\n'.join(certificates))
    identity = payload['id']
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]{5,80}', identity), 'Invalid transaction identifier')
    directory = ROOT / identity
    if operation == 'prepare':
        require(re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', payload['version']), 'Invalid release version')
        value = inspect()
        require(payload['inventory'] == public_inventory(value), 'Stale inspection')
        require(not directory.exists(), 'Transaction already exists')
        ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
        directory.mkdir(mode=0o700)
        private_json(directory / 'request.json', payload)
        private_json(directory / 'inventory.json', value)
        for name in ('worker.py', 'backup.py', 'runtime.mjs'):
            (directory / name).write_bytes(base64.b64decode(payload['sources'][name], validate=True))
        private_json(directory / 'transaction.json', dict(id=identity, version=payload['version'], phase='queued'))
        subprocess.run(['systemd-run', '--no-block', '--unit=hive-npm-deploy-' + identity, '--property=Type=oneshot', '--property=UMask=0077', '--property=TimeoutStartSec=3600', '--property=StandardOutput=append:' + str(directory / 'worker.log'), '--property=StandardError=append:' + str(directory / 'worker.log'), '/usr/bin/python3', str(directory / 'worker.py'), str(directory)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return dict(id=identity, phase='queued')
    if operation == 'status' and not (directory / 'transaction.json').exists():
        return dict(phase='not-started')
    state = json.loads((directory / 'transaction.json').read_text())
    if operation == 'status':
        if state['phase'] not in ('complete', 'code-reverted', 'failed-before-maintenance', 'recovery-required') and property_value('hive-npm-deploy-' + identity, 'ActiveState') in ('inactive', 'failed'):
            state['phase'] = 'recovery-required'
            state['error'] = 'Host transaction interrupted; inspect its receipt before another deployment'
            private_json(directory / 'transaction.json', state)
        return state
    if operation == 'backup-ack':
        require(state['phase'] == 'awaiting-backup-copy' and payload['sha256'] == state['backup']['sha256'], 'Stale or invalid backup acknowledgement')
        private_json(directory / 'backup-ack.json', dict(sha256=payload['sha256']))
    elif operation == 'model-ack':
        require(state['phase'] == 'awaiting-model-checks', 'Stale model acknowledgement')
        request = json.loads((directory / 'request.json').read_text())
        validate_report(payload['report'], request['model'])
        private_json(directory / 'model-ack.json', payload['report'])
    elif operation == 'reject':
        # Stop the host transaction conservatively; its handler performs compatible code recovery.
        subprocess.run(['systemctl', 'kill', '--kill-whom=main', '--signal=SIGTERM', 'hive-npm-deploy-' + identity], check=True)
    else:
        raise RuntimeError('Unsupported operation')
    return dict(accepted=True)


def main():
    os.umask(0o077)
    if len(sys.argv) == 2:
        def interrupt(signum, frame):
            raise InterruptedError('Transaction interrupted')
        signal.signal(signal.SIGTERM, interrupt)
        signal.signal(signal.SIGINT, interrupt)
        transaction(Path(sys.argv[1]))
    else:
        try:
            result = rpc(json.load(sys.stdin))
            print(json.dumps(result))
        except Exception as error:
            # Raw provider output, environments and credential-bearing exceptions stay off the console.
            print(json.dumps({'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__}))
            sys.exit(1)


if __name__ == '__main__':
    main()
