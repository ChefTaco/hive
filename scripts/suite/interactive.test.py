#!/usr/bin/env python3
"""Developer-only PTY proof; Python is not used by the installer."""
import json
import os
import pathlib
import platform
import pty
import select
import signal
import subprocess
import tempfile
import time

root = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='hive-interactive-') as temporary:
    base = pathlib.Path(temporary)
    installation = json.loads((root / 'examples/installation.json').read_text())
    architecture = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine(), '')
    assert architecture
    manifest = {'schema': 1, 'version': '0.1.0', 'profiles': {'core': sorted(installation['components']), 'full': sorted(installation['components'])}, 'components': {name: {'image': 'example.com/synthetic@sha256:' + '0' * 64, 'service': {'user': f'{os.getuid()}:{os.getgid()}', 'healthcheck': {'test': ['CMD', 'true']}}} for name in installation['components']}}
    manifest['components']['hivexui']['kind'] = 'static-ui'
    manifest['components']['hivexui']['service']['user'] = '101:101'
    manifest['components']['ingress']['kind'] = 'ingress'
    for name in ['hivemem-qdrant', 'oathweave-redis']:
        manifest['components'][name]['kind'] = 'datastore'
    release = base / 'release.json'
    release.write_text(json.dumps(manifest))
    def openssl(*args):
        subprocess.run(['openssl', *map(str, args)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    openssl('genpkey', '-algorithm', 'ED25519', '-out', base / 'publisher.key')
    openssl('pkey', '-in', base / 'publisher.key', '-pubout', '-out', base / 'publisher.pub')
    openssl('pkeyutl', '-sign', '-inkey', base / 'publisher.key', '-rawin', '-in', release, '-out', str(release) + '.sig')
    output = base / 'inventory' / 'installation.json'
    questions = [
        ('Installation name', 'interactive-proof'),
        ('Installation directory on the selected host', str(base / 'deployment')),
        ('Host SSH target', 'local'), ('Host architecture', architecture),
        ('Console HTTPS origin', 'https://localhost:65427'), ('Product profile', 'core'),
        ('HTTPS bind address', '127.0.0.1'), ('HTTPS listener port', '65427'),
        ('Configuration mode', 'fresh'), ('Initial operator username', 'admin'),
        ('Initial operator email', 'alice@example.com'),
        ('Existing console certificate file', str(base / 'console.crt')),
        ('Protected console private key file', str(base / 'console.key')),
        ('Existing external inference HTTPS endpoint', 'https://inference.example.com/v1'),
        ('External provider engine', 'openai'), ('External API protocol', 'openai'),
        ('Existing model identifier', 'synthetic-existing-model'),
        ('Protected Authorization header file', '/opt/credentials/external.header'),
        ('Protected external endpoint CA file', ''),
        ('Emberpath enrollment HTTPS origin', 'https://localhost:65427'),
        ('Emberpath API prefix', '/api/emberpath'),
        ('Protected Emberpath enrollment Authorization header file', '/opt/credentials/enrollment.header'),
        ('Protected Emberpath CA file', ''), ('Provider slug in Emberpath', 'synthetic-provider'),
        ('Provider aliases', 'synthetic-fast, synthetic-default'), ('Opt-in native agent runtime', ''),
        ('Write protected installation configuration to', str(output)),
    ]
    arguments = [str(root / 'hive.sh'), 'plan', '--release', '0.1.0', '--manifest', str(release), '--trust-key', str(base / 'publisher.pub')]
    pid, descriptor = pty.fork()
    if pid == 0:
        environment = {key: value for key, value in os.environ.items() if key not in ['HOME', 'XDG_CONFIG_HOME']}
        os.execve(arguments[0], arguments, environment)
    transcript = ''
    pending = ''
    index = 0
    deadline = time.monotonic() + 30
    try:
        while time.monotonic() < deadline:
            if select.select([descriptor], [], [], 0.1)[0]:
                try:
                    chunk = os.read(descriptor, 65536).decode()
                except OSError:
                    break
                if not chunk:
                    break
                transcript += chunk
                pending += chunk
                if index < len(questions) and questions[index][0] in pending:
                    os.write(descriptor, (questions[index][1] + '\n').encode())
                    index += 1
                    pending = ''
            finished, status = os.waitpid(pid, os.WNOHANG)
            if finished:
                assert os.waitstatus_to_exitcode(status) == 0, transcript
                break
        else:
            os.kill(pid, signal.SIGKILL)
            raise AssertionError('Wizard timed out at question ' + str(index))
    finally:
        os.close(descriptor)
    try:
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0, transcript
    except ChildProcessError:
        pass
    assert index == len(questions), transcript
    config = json.loads(output.read_text())
    assert config['release'] == '0.1.0'
    assert set(config['components']) == set(manifest['components'])
    assert config['console']['httpsPort'] == 65427
    assert config['bootstrap']['adminEmail'] == 'alice@example.com'
    assert config['inference'][0]['registration']['apiPrefix'] == '/api/emberpath'
    assert config['inference'][0]['registration']['aliases'] == ['synthetic-fast', 'synthetic-default']
    assert output.stat().st_mode & 0o077 == 0
    assert not (base / 'deployment').exists(), 'Planning contacted or initialized a host'
    plan = json.loads(subprocess.check_output([*arguments[:2], '--config', str(output), *arguments[2:]], text=True))
    assert plan['installation'] == 'interactive-proof' and plan['manifestDigest']
    print('Passed: real terminal setup, complete core inventory, protected output, identical unattended planning and no host changes.')
