#!/usr/bin/env python3
"""Developer-only PTY proof; Python is not used by the installer."""
import json
import os
import pathlib
import platform
import pty
import re
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
        ('Provider aliases', 'synthetic-fast, synthetic-default'),
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
        # Selecting Magnus offers its host agent port, off unless a port is given.
        if label == 'Protected console private key file': full_questions.append(('Port for Magnus host agents', ''))
    review.write_text(json.dumps({'command': arguments, 'questions': full_questions,
                                 'transcriptFile': str(base / 'full-transcript.log'), 'timeoutSeconds': 30}))
    subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(review)], check=True, stdout=subprocess.DEVNULL)
    full_config = json.loads(full_output.read_text())
    assert full_config['profile'] == 'full' and len(full_config['components']) == 18
    assert 'magnusConsoleOrigin' not in full_config['bootstrap']
    assert 'nativeListeners' not in full_config['console'], 'The Magnus agent port was published without being asked for'
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
        completed = subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(review)], stdout=subprocess.DEVNULL)
        assert completed.returncode == 0, (base / (name + '-transcript.log')).read_text()
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

    # A Magnus agent port is published on the console bind address only when one is given.
    agent_output = base / 'inventory' / 'agent-port.json'
    agent_questions = [(label, '4000' if label == 'Port for Magnus host agents' else str(agent_output) if label == 'Write protected installation configuration to' else answer) for label, answer in full_questions]
    agent_questions.insert([label for label, _ in agent_questions].index('Port for Magnus host agents'), ('Deploy the Magnus web terminal gateway', 'no'))
    review.write_text(json.dumps({'command': arguments, 'questions': agent_questions, 'transcriptFile': str(base / 'agent-port-transcript.log'), 'timeoutSeconds': 30}))
    subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(review)], check=True, stdout=subprocess.DEVNULL)
    agent_config = json.loads(agent_output.read_text())
    assert agent_config['console']['nativeListeners'] == [{'port': 4000, 'component': 'magnus'}]
    assert 'only the agent routes and credentials pass' in (base / 'agent-port-transcript.log').read_text()
    subprocess.run([*arguments[:2], '--config', str(agent_output), *arguments[2:]], check=True, stdout=subprocess.DEVNULL)
    print('Passed: interactive Magnus host agent port, off by default and published only when given.')

    # Ardent Project Studio is offered with Magnus and HiveMem; the full profile suggests it.
    manifest['components']['ardentstudio'] = {'image': 'example.com/synthetic@sha256:' + '3' * 64, 'kind': 'application', 'storageFormat': 'ardentstudio-v1',
                                              'service': {'user': f'{os.getuid()}:{os.getgid()}', 'healthcheck': {'test': ['CMD', 'true']}}}
    release.write_text(json.dumps(with_catalog(manifest)))
    openssl('pkeyutl', '-sign', '-inkey', base / 'publisher.key', '-rawin', '-in', release, '-out', str(release) + '.sig')
    studio, target = with_gateway_answers('studio-default', [('Deploy the Magnus web terminal gateway', 'no'), ('Deploy Ardent Project Studio', '')])
    assert studio['components']['ardentstudio'] == {'host': 'control', 'envFile': str(base / 'deployment/config/ardentstudio.env'), 'configDirectory': str(base / 'deployment/config/ardentstudio')}
    assert len(studio['components']) == 19
    subprocess.run([*arguments[:2], '--config', str(target), *arguments[2:]], check=True, stdout=subprocess.DEVNULL)
    declined, _ = with_gateway_answers('studio-declined', [('Deploy the Magnus web terminal gateway', 'no'), ('Deploy Ardent Project Studio', 'no')])
    assert 'ardentstudio' not in declined['components'] and len(declined['components']) == 18
    del manifest['components']['ardentstudio']
    release.write_text(json.dumps(with_catalog(manifest)))
    openssl('pkeyutl', '-sign', '-inkey', base / 'publisher.key', '-rawin', '-in', release, '-out', str(release) + '.sig')
    print('Passed: interactive Ardent Project Studio, suggested by the full profile and left out when declined.')

    # Optional Embermend is offered by hive.sh only with a declared local bridge.
    manifest['components']['magnus']['version'] = '2.4.2'
    manifest['components']['magnus']['embermendProtocol'] = 1
    for name in ['embermend', 'embermend-worker', 'embermend-postgres']:
        manifest['components'][name] = {'image': 'example.com/synthetic@sha256:' + '4' * 64,
                                       'service': {'user': f'{os.getuid()}:{os.getgid()}', 'healthcheck': {'test': ['CMD', 'true']}}}
    manifest['components']['embermend']['requiresLocal'] = ['magnus', 'oathweave', 'hivexui', 'embermend-worker', 'embermend-postgres']
    manifest['components']['embermend']['initialization'] = {'image': manifest['components']['embermend']['image'], 'command': ['migrate'], 'verificationCommand': ['verify-initialization']}
    manifest['components']['embermend-postgres']['kind'] = 'datastore'
    release.write_text(json.dumps(with_catalog(manifest)))
    openssl('pkeyutl', '-sign', '-inkey', base / 'publisher.key', '-rawin', '-in', release, '-out', str(release) + '.sig')
    selected, target = with_gateway_answers('embermend-selected', [('Deploy the Magnus web terminal gateway', 'no'), ('Deploy Embermend security assessment and remediation', 'yes')])
    assert all(name in selected['components'] for name in ['embermend', 'embermend-worker', 'embermend-postgres'])
    assert selected['components']['embermend']['envFile'].endswith('/config/embermend.env')
    subprocess.run([*arguments[:2], '--config', str(target), *arguments[2:]], check=True, stdout=subprocess.DEVNULL)
    declined, _ = with_gateway_answers('embermend-default', [('Deploy the Magnus web terminal gateway', 'no'), ('Deploy Embermend security assessment and remediation', '')])
    assert not any(name.startswith('embermend') for name in declined['components'])
    del manifest['components']['magnus']['embermendProtocol']
    release.write_text(json.dumps(with_catalog(manifest)))
    openssl('pkeyutl', '-sign', '-inkey', base / 'publisher.key', '-rawin', '-in', release, '-out', str(release) + '.sig')
    undeclared, _ = with_gateway_answers('embermend-undeclared', [('Deploy the Magnus web terminal gateway', 'no')])
    assert not any(name.startswith('embermend') for name in undeclared['components'])
    for name in ['embermend', 'embermend-worker', 'embermend-postgres']:
        del manifest['components'][name]
    del manifest['components']['magnus']['version']
    release.write_text(json.dumps(with_catalog(manifest)))
    openssl('pkeyutl', '-sign', '-inkey', base / 'publisher.key', '-rawin', '-in', release, '-out', str(release) + '.sig')
    print('Passed: hive.sh offers Embermend only with declared local Magnus, defaults off, and preserves unattended planning.')

    custom_output = base / 'inventory' / 'custom.json'
    custom_questions = []
    for label, answer in questions[:13]:
        if label == 'Product profile': answer = 'custom'
        custom_questions.append((label, answer))
        if label == 'Product profile':
            custom_questions.append(('Selected component names', 'hiveskills'))
    # Without the magnus component, setup offers a Magnus that runs outside the installation.
    custom_questions += [('External Magnus HTTPS URL', ''),
                         ('Existing external inference HTTPS endpoint', ''),
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

    # An external Magnus takes the place of the magnus component, and Studio is offered with it.
    manifest['components']['ardentstudio'] = {'image': 'example.com/synthetic@sha256:' + '3' * 64, 'kind': 'application', 'storageFormat': 'ardentstudio-v1',
                                              'service': {'user': f'{os.getuid()}:{os.getgid()}', 'healthcheck': {'test': ['CMD', 'true']}}}
    release.write_text(json.dumps(with_catalog(manifest)))
    openssl('pkeyutl', '-sign', '-inkey', base / 'publisher.key', '-rawin', '-in', release, '-out', str(release) + '.sig')
    external_output = base / 'inventory' / 'external-magnus.json'
    external_questions = []
    for label, answer in custom_questions:
        if label == 'Selected component names': answer = 'hivemem'
        if label == 'External Magnus HTTPS URL': answer = 'https://magnus.example.com:4000'
        if label == 'Write protected installation configuration to': answer = str(external_output)
        external_questions.append((label, answer))
        if label == 'External Magnus HTTPS URL':
            external_questions.append(('Deploy Ardent Project Studio', 'yes'))
    review.write_text(json.dumps({'command': arguments, 'questions': external_questions,
                                 'transcriptFile': str(base / 'external-magnus-transcript.log'), 'timeoutSeconds': 30}))
    subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(review)], check=True, stdout=subprocess.DEVNULL)
    external_config = json.loads(external_output.read_text())
    assert external_config['external'] == {'magnus': {'url': 'https://magnus.example.com:4000'}}
    assert 'magnus' not in external_config['components'] and 'ardentstudio' in external_config['components']
    assert 'nativeListeners' not in external_config['console'], 'An agent port was offered for a Magnus this installation does not run'
    plan = json.loads(subprocess.run([*arguments[:2], '--config', str(external_output), *arguments[2:]], check=True, stdout=subprocess.PIPE).stdout)
    assert plan['external'] == {'magnus': {'url': 'https://magnus.example.com:4000'}} and 'magnus' not in plan['components']
    del manifest['components']['ardentstudio']
    release.write_text(json.dumps(with_catalog(manifest)))
    openssl('pkeyutl', '-sign', '-inkey', base / 'publisher.key', '-rawin', '-in', release, '-out', str(release) + '.sig')
    print('Passed: interactive external Magnus in place of the magnus component, with Ardent Project Studio offered beside it.')

    # New-user guidance: an unwritable directory is asked for again before anything else, an SSH
    # target asks for its SSH configuration, and a repeated setup continues with its saved file.
    guided_home = base / 'guided-home'
    guided_output = guided_home / '.config' / 'hive' / 'guided-proof' / 'installation.json'
    unwritable = base / 'read-only'
    unwritable.mkdir(mode=0o500)
    guided_questions = [('Installation name', 'guided-proof'),
                        ('Installation directory on the selected host', str(unwritable / 'hive')),
                        ('Host SSH target', 'local'),
                        ('must be a canonical absolute path', ''),
                        ('Installation directory on the selected host', str(base / 'guided'))]
    guided_questions += [item for item in custom_questions[3:] if item[0] != 'Write protected installation configuration to']
    guided_questions += [('Write protected installation configuration to', '')]
    review.write_text(json.dumps({'command': ['/usr/bin/env', f'HOME={guided_home}', f'XDG_CONFIG_HOME={guided_home}/.config', *arguments], 'questions': guided_questions,
                                 'transcriptFile': str(base / 'guided-transcript.log'), 'timeoutSeconds': 30}))
    subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(review)], check=True, stdout=subprocess.DEVNULL)
    guided = json.loads(guided_output.read_text())
    assert guided['hosts']['control']['directory'] == str(base / 'guided')
    transcript = (base / 'guided-transcript.log').read_text()
    assert f'[/opt/guided-proof]' in transcript, 'The directory has no default'
    assert 'sudo install -d -m 0750' in transcript, 'An unwritable directory gave no guidance'
    resumed = [('Installation name', 'guided-proof'), ('Continue with it instead of answering', '')]
    review.write_text(json.dumps({'command': ['/usr/bin/env', f'HOME={guided_home}', f'XDG_CONFIG_HOME={guided_home}/.config', *arguments], 'questions': resumed,
                                 'transcriptFile': str(base / 'resumed-transcript.log'), 'timeoutSeconds': 30}))
    subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(review)], check=True, stdout=subprocess.DEVNULL)
    transcript = re.sub(r'\x1b\[[0-9;]*m', '', (base / 'resumed-transcript.log').read_text())
    assert f'./hive.sh install --config {guided_output} --release 0.1.0' in transcript, 'A repeated setup did not offer to continue'
    assert '"installation": "guided-proof"' in transcript, 'A continued setup did not plan the saved configuration'
    remote_output = base / 'inventory' / 'remote.json'
    remote_questions = [('Installation name', 'remote-proof'), ('Installation directory on the selected host', '/opt/remote-proof'),
                        ('Host SSH target', 'deploy@hive.example.com'),
                        ('Protected SSH configuration for the selected host', '/opt/credentials/ssh-config')]
    remote_questions += [item for item in custom_questions[3:] if item[0] != 'Write protected installation configuration to']
    remote_questions += [('Write protected installation configuration to', str(remote_output))]
    review.write_text(json.dumps({'command': arguments, 'questions': remote_questions,
                                 'transcriptFile': str(base / 'remote-transcript.log'), 'timeoutSeconds': 30}))
    subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(review)], check=True, stdout=subprocess.DEVNULL)
    remote = json.loads(remote_output.read_text())
    assert remote['hosts']['control'] == {'target': 'deploy@hive.example.com', 'directory': '/opt/remote-proof', 'architecture': architecture, 'sshConfig': '/opt/credentials/ssh-config'}
    print('Passed: interactive directory default and writability guidance, SSH configuration for an SSH target, and continuing a saved setup.')
