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
    catalog = json.loads((root / 'scripts/suite/suite-catalog.json').read_text())
    def with_catalog(document):
        for name, component in document['components'].items():
            component['catalog'] = catalog[name]
        document['components']['hive-registry']['storageFormat'] = 'hive-registry-v1'
        return document
    release = base / 'release.json'
    release.write_text(json.dumps(with_catalog(manifest)))
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

    distributed_output = base / 'inventory' / 'distributed.json'
    distributed_questions = [(label, 'distributed' if label == 'Configuration mode' else answer) for label, answer in questions[:-1]]
    distributed_questions += [('Product trust bundle file available on every host', '/opt/certificates/product-ca.pem')]
    for index, product in enumerate(['oathweave', 'emberpath', 'hivemem', 'hiveskills']):
        distributed_questions += [(f'Inventory host for {product}', 'identity' if product == 'oathweave' else 'control')]
        if product == 'oathweave':
            distributed_questions += [('SSH target for identity', 'deploy@identity.example.com'),
                                      ('Installation directory on identity', '/opt/hive-identity'),
                                      ('Architecture for identity', architecture),
                                      ('Protected SSH configuration for identity', '')]
        distributed_questions += [(f'Verified HTTPS origin for {product}', f'https://{product}.example.com:{65421+index}'),
                                  (f'HTTPS bind address for {product}', '127.0.0.1'),
                                  (f'Certificate file on the {product} host', f'/opt/certificates/{product}.crt'),
                                  (f'Protected private key file on the {product} host', f'/opt/certificates/{product}.key')]
        if product == 'emberpath':
            distributed_questions += [('Distinct native model API HTTPS origin for Emberpath', 'https://emberpath.example.com:65425')]
    distributed_questions += [('Write protected installation configuration to', str(distributed_output))]
    review = base / 'distributed-driver.json'
    review.write_text(json.dumps({'command': arguments, 'questions': distributed_questions,
                                 'transcriptFile': str(base / 'distributed-transcript.log'), 'timeoutSeconds': 30}))
    subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(review)], check=True, stdout=subprocess.DEVNULL)
    distributed = json.loads(distributed_output.read_text())
    assert distributed['components']['oathweave']['host'] == 'identity'
    assert distributed['components']['oathweave-redis']['host'] == 'identity'
    assert distributed['components']['oathweave']['envFile'] == '/opt/hive-identity/config/oathweave.env'
    assert distributed['components']['hivemem']['host'] == 'control'
    assert len(distributed['bootstrap']['productEndpoints']) == 4
    assert distributed['bootstrap']['trustBundleFile'] == '/opt/certificates/product-ca.pem'
    assert not (base / 'deployment').exists(), 'Distributed planning contacted a host'
    subprocess.run([*arguments[:2], '--config', str(distributed_output), *arguments[2:]], check=True, stdout=subprocess.DEVNULL)
    print('Passed: interactive distributed product placement, local datastore placement, explicit TLS references and identical unattended planning.')

    # Full setup writes the identical config consumed by unattended execution;
    # this terminal test plans only and never installs its synthetic images.
    for name in ['magnus', 'cindertrace', 'chattermost', 'emberfold', 'magnus-postgres', 'magnus-redis', 'cindertrace-postgres', 'cindertrace-redis', 'chattermost-postgres']:
        manifest['components'][name] = {'image': 'example.com/synthetic@sha256:' + '0' * 64,
                                        'kind': 'datastore' if name.endswith(('-postgres', '-redis')) else 'application',
                                        'service': {'user': f'{os.getuid()}:{os.getgid()}', 'healthcheck': {'test': ['CMD', 'true']}}}
    for name in ['magnus', 'cindertrace', 'chattermost']:
        manifest['components'][name]['initialization'] = {'image': 'example.com/migrator@sha256:' + '1' * 64,
                                                          'command': ['apply'], 'verificationCommand': ['verify-current']}
    manifest['profiles']['full'] = sorted(manifest['components'])
    release.write_text(json.dumps(with_catalog(manifest)))
    openssl('pkeyutl', '-sign', '-inkey', base / 'publisher.key', '-rawin', '-in', release, '-out', str(release) + '.sig')
    full_output = base / 'inventory' / 'full.json'
    full_questions = []
    for label, answer in questions:
        if label == 'Product profile': answer = 'full'
        if label == 'Write protected installation configuration to': answer = str(full_output)
        full_questions.append((label, answer))
    review.write_text(json.dumps({'command': arguments, 'questions': full_questions,
                                 'transcriptFile': str(base / 'full-transcript.log'), 'timeoutSeconds': 30}))
    subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(review)], check=True, stdout=subprocess.DEVNULL)
    full_config = json.loads(full_output.read_text())
    assert full_config['profile'] == 'full' and len(full_config['components']) == 18
    assert 'magnusConsoleOrigin' not in full_config['bootstrap']
    assert full_output.stat().st_mode & 0o077 == 0
    assert not (base / 'deployment').exists(), 'Full planning contacted a host'
    subprocess.run([*arguments[:2], '--config', str(full_output), *arguments[2:]], check=True, stdout=subprocess.DEVNULL)
    print('Passed: interactive full profile, protected config and identical unattended planning.')

    # A release can offer the web terminal, but it is off unless the operator asks for it.
    manifest['components']['magnus-gateway'] = {'image': 'example.com/synthetic@sha256:' + '2' * 64, 'kind': 'application', 'requiresLocal': ['magnus'],
                                                'service': {'user': f'{os.getuid()}:{os.getgid()}', 'healthcheck': {'test': ['CMD', 'true']}}}
    release.write_text(json.dumps(with_catalog(manifest)))
    openssl('pkeyutl', '-sign', '-inkey', base / 'publisher.key', '-rawin', '-in', release, '-out', str(release) + '.sig')
    def with_gateway_answers(name, answers):
        target = base / 'inventory' / (name + '.json')
        result = []
        for label, answer in full_questions:
            if label == 'Write protected installation configuration to': answer = str(target)
            result.append((label, answer))
            if label == 'Protected console private key file': result += answers
        review.write_text(json.dumps({'command': arguments, 'questions': result, 'transcriptFile': str(base / (name + '-transcript.log')), 'timeoutSeconds': 30}))
        subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(review)], check=True, stdout=subprocess.DEVNULL)
        return json.loads(target.read_text()), target
    declined, _ = with_gateway_answers('gateway-default', [('Deploy the Magnus web terminal gateway', '')])
    assert 'magnus-gateway' not in declined['components'] and 'magnusGateway' not in declined['bootstrap']
    selected, target = with_gateway_answers('gateway-selected', [('Deploy the Magnus web terminal gateway', 'yes'),
                                                                 ('Restricted SSH account on fleet nodes', 'deploy'),
                                                                 ('Protected SSH private key file on the Magnus host', '/opt/credentials/fleet-key'),
                                                                 ('Grant magnus:terminal to the initial operator', '')])
    assert selected['components']['magnus-gateway']['envFile'].endswith('/config/magnus-gateway.env')
    assert selected['bootstrap']['magnusGateway'] == {'sshUsername': 'deploy', 'sshPrivateKeyFile': '/opt/credentials/fleet-key', 'grantTerminalToInitialOperator': False}
    plan = json.loads(subprocess.run([*arguments[:2], '--config', str(target), *arguments[2:]], check=True, stdout=subprocess.PIPE).stdout)
    assert plan['magnusTerminal'] == {'gatewaySelected': True, 'grantedToInitialOperator': False}
    print('Passed: interactive terminal gateway is off by default, and selecting it does not grant the terminal.')

    custom_output = base / 'inventory' / 'custom.json'
    custom_questions = []
    for label, answer in questions[:13]:
        if label == 'Product profile': answer = 'custom'
        custom_questions.append((label, answer))
        if label == 'Product profile':
            custom_questions.append(('Selected component names', 'hiveskills'))
    custom_questions += [('Existing external inference HTTPS endpoint', ''),
                         ('Opt-in native agent runtime', ''),
                         ('Write protected installation configuration to', str(custom_output))]
    review.write_text(json.dumps({'command': arguments, 'questions': custom_questions,
                                 'transcriptFile': str(base / 'custom-transcript.log'), 'timeoutSeconds': 30}))
    subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(review)], check=True, stdout=subprocess.DEVNULL)
    custom_config = json.loads(custom_output.read_text())
    assert custom_config['profile'] == 'custom'
    assert set(custom_config['components']) == {'hive-registry', 'oathweave', 'oathweave-redis', 'hivexui', 'ingress', 'hiveskills'}
    assert custom_config['inference'] == [] and custom_config['agents'] == []
    assert custom_output.stat().st_mode & 0o077 == 0
    subprocess.run([*arguments[:2], '--config', str(custom_output), *arguments[2:]], check=True, stdout=subprocess.DEVNULL)
    print('Passed: interactive custom selection adds the identity/console foundation, omits unselected products and matches unattended planning.')
