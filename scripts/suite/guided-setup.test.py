#!/usr/bin/env python3
"""PTY regression coverage for guided host preparation. No host is changed."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='hive-guided-') as temporary:
    base = Path(temporary)
    fixture = base / 'fixture.sh'
    fixture.write_text('''#!/usr/bin/env bash
set -Eeuo pipefail
HIVE_ROOT=$1; shift
source "$HIVE_ROOT/scripts/suite/controller.sh"
source "$HIVE_ROOT/scripts/suite/guided-setup.sh"
unset HIVE_SETUP_LOCAL
hive_die() { printf '%s\\n' "$*" >&2; exit 1; }
hive_setup_sudo() {
  printf '%s\\n' "$*" >> "$TEST_LOG"; touch "$TEST_READY"
  [[ ${TEST_FAIL_HELPER:-} != certificate ]]
}
bash() {
  case "$*" in
    *install-prerequisites.sh*--check*) [[ -f "$TEST_READY" ]];;
    *console-certificate.sh*check*) return 1;;
    *)
      printf 'reviewed helper: %s\\n' "$*"
      if [[ "$*" == *hive.sh* ]]; then printf '%s\\n' "$*" >> "$TEST_LOG"; fi
      if [[ "$*" == *'magnus-agent install'* && ${TEST_FAIL_HELPER:-} == agent ]]; then return 42; fi
      if [[ "$*" == *'magnus-agent enroll'* && ${TEST_FAIL_HELPER:-} == enroll ]]; then return 42; fi
      if [[ "$*" == *'ardent setup'* && ${TEST_FAIL_HELPER:-} == ardent ]]; then return 42; fi;;
  esac
}
docker() { return 0; }
tailscale() {
  if [[ "$*" == 'ip -4' ]]; then printf '100.64.0.10\\n'
  else printf '{"CertDomains":["console.example.com"],"Self":{"DNSName":"console.example.com."}}'; fi
}
hive_writable_directory() { [[ ${TEST_GUIDED_CONFIGURE:-false} == true ]]; }
hive_checklist_supported() { [[ ${TEST_OLD_REGISTRY:-false} != true ]]; }
hive_checklist_recorded() {
  [[ ${TEST_REGISTRY_READ_FAIL:-false} != true ]] || return 1
  cat "$TEST_CHECKLIST"
}
hive_checklist_settle() {
  [[ ${TEST_REGISTRY_WRITE_FAIL:-false} != true ]] || return 1
  printf 'recorded %s %s\\n' "$2" "$3" >> "$TEST_LOG"
  jq --arg id "$2" --arg status "$3" 'map(if .id==$id then .status=$status else . end)' "$TEST_CHECKLIST" > "$TEST_CHECKLIST.next"
  mv "$TEST_CHECKLIST.next" "$TEST_CHECKLIST"
}
hive_checklist_print_pending() {
  jq -r '.[] | select(.status=="pending") | "still pending: " + .id' <<< "$1"
}
case "$1" in
  configure)
    HIVE_GUIDED_SETUP=true HIVE_SETUP_LOCAL=yes
    HIVE_VERSION=3.12.3 HIVE_MANIFEST="$HIVE_ROOT/releases/3.12.3.json"
    HIVE_SIGNATURE="$HIVE_MANIFEST.sig" HIVE_TRUST_KEY="$HIVE_ROOT/trust/publisher.pub"
    # The fixture verifies the published manifest signature. Skip the runtime
    # digest check so the unreleased setup code can read that immutable fixture.
    hive_manifest() { :; }
    hive_configure;;
  resume)
    HIVE_GUIDED_SETUP=${TEST_GUIDED:-true} HIVE_SETUP_LOCAL=yes
    hive_setup_resume "$2"
    printf 'managed-certificate=%s\\n' "$HIVE_SETUP_TAILSCALE";;
  certificate)
    HIVE_GUIDED_SETUP=true HIVE_SETUP_LOCAL=yes
    hive_setup_origin
    hive_setup_certificate "$2"
    printf 'certificate=%s key=%s\\n' "$HIVE_SETUP_CERTIFICATE" "$HIVE_SETUP_PRIVATE_KEY";;
  terminal)
    HIVE_GUIDED_SETUP=true HIVE_SETUP_LOCAL=yes
    hive_setup_terminal
    printf 'account=%s key=%s\\n' "$HIVE_SETUP_TERMINAL_USER" "$HIVE_SETUP_TERMINAL_KEY";;
  finish)
    HIVE_GUIDED_SETUP=${TEST_GUIDED:-true} HIVE_SETUP_LOCAL=${TEST_LOCAL_SETUP:-yes} HIVE_SETUP_TAILSCALE=${TEST_TAILSCALE:-false}
    HIVE_CONFIG=$2
    HIVE_VERSION=0.1.0 HIVE_MANIFEST=/opt/reviewed/release.json HIVE_SIGNATURE=/opt/reviewed/release.json.sig HIVE_TRUST_KEY=/opt/reviewed/publisher.pub
    hive_setup_finish;;
  directory)
    HIVE_GUIDED_SETUP=true HIVE_SETUP_LOCAL=yes
    hive_setup_directory /opt/example-suite;;
  *) hive_setup_start "$@"; printf 'guided=%s\\n' "$HIVE_GUIDED_SETUP";;
esac
''')

    def run(name, arguments, questions=(), expected=0, environment=None):
        log, ready = base / (name + '.calls'), base / (name + '.ready')
        transcript = base / (name + '.transcript')
        request = base / (name + '.json')
        checklist = base / (name + '.checklist.json')
        checklist.write_text(json.dumps([{'id': item, 'status': 'pending'} for item in
                                        ['certificate-renewal', 'magnus-agent-enrolled', 'first-admin']]))
        request.write_text(json.dumps({
            'command': ['/usr/bin/env', f'TEST_LOG={log}', f'TEST_READY={ready}', f'TEST_CHECKLIST={checklist}',
                        *[f'{key}={value}' for key, value in (environment or {}).items()],
                        '/bin/bash', str(fixture), str(root), *arguments],
            'questions': questions, 'transcriptFile': str(transcript), 'timeoutSeconds': 10,
        }))
        result = subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(request)], capture_output=True, text=True)
        assert result.returncode == expected, result.stderr + transcript.read_text()
        return transcript.read_text(), log.read_text() if log.exists() else ''

    for name, args in [('plan', ['plan']), ('saved', ['install', '--config', '/opt/example.json']),
                       ('unattended', ['install', '--non-interactive']), ('help', ['--help']),
                       ('explicit-manifest', ['install', '--manifest', '/opt/release.json'])]:
        transcript, calls = run(name, args)
        assert 'guided=false' in transcript and not calls
    questions = [('Install Hive on this machine', 'yes'), ('Apply these prerequisite changes', 'yes')]
    transcript, calls = run('local', ['install', '--release', 'latest'], questions)
    assert 'guided=true' in transcript and '--controller' not in calls and '--yes' in calls
    transcript, calls = run('remote', ['install'], [('Install Hive on this machine', 'no'), ('Apply these prerequisite changes', 'yes')])
    assert '--controller' in calls
    transcript, calls = run('declined', ['install'], [('Install Hive on this machine', 'yes'), ('Apply these prerequisite changes', 'no')], expected=1)
    assert not calls and 'Prerequisites were not changed' in transcript
    transcript, calls = run('certificate', ['certificate', 'https://console.example.com'], [('Obtain the console certificate', 'yes')])
    assert 'certificate=/etc/hive/tls/console.crt key=/etc/hive/tls/console.key' in transcript and 'tailscale' in calls
    transcript, calls = run('other-origin', ['certificate', 'https://other.example.com'])
    assert not calls and 'certificate= key=' in transcript
    transcript, calls = run('certificate-port', ['certificate', 'https://console.example.com:8443'],
                            [('Obtain the console certificate', 'yes')])
    assert 'certificate=/etc/hive/tls/console.crt' in transcript and '--name console.example.com\n' in calls
    transcript, calls = run('certificate-origin-prefix', ['certificate', 'https://console.example.com.other.example.com'])
    assert not calls and 'certificate= key=' in transcript
    transcript, calls = run('certificate-declined', ['certificate', 'https://console.example.com'], [('Obtain the console certificate', 'no')])
    assert not calls and 'certificate= key=' in transcript
    transcript, calls = run('terminal', ['terminal'], [('Prepare that account and key', 'yes')])
    assert 'prepare-terminal.sh' in calls and 'account=hive-terminal key=/etc/hive/fleet/gateway-key' in transcript
    transcript, calls = run('terminal-declined', ['terminal'], [('Prepare that account and key', 'no')])
    assert not calls and 'account= key=' in transcript
    transcript, calls = run('directory', ['directory'], [('Create /opt/example-suite', 'yes')])
    assert '--directory /opt/example-suite' in calls
    guided_config = base / 'guided-installation.json'
    questions = [
        ('Installation name [hive]', ''), ('Installation directory on the selected host', ''),
        ('Console HTTPS origin', 'https://console.example.com:8443'), ('Product profile', 'full'),
        ('HTTPS bind address', 'tailscale'), ('HTTPS listener port [8443]', ''), ('Configuration mode', ''),
        ('Initial operator username', ''), ('Initial operator email', 'alice@example.com'),
        ('Obtain the console certificate', 'yes'), ('Deploy the Magnus web terminal gateway', 'yes'),
        ('Prepare that account and key', 'yes'), ('Grant magnus:terminal', 'no'),
        ('Deploy Ardent Project Studio', ''), ('Deploy Embermend', 'no'),
        ('Port for Magnus host agents', '4000'), ('Existing external inference HTTPS endpoint', ''),
        ('Prune old backups and rehearsals daily', ''), ('Write protected installation configuration to', str(guided_config)),
    ]
    transcript, _ = run('configure', ['configure'], questions,
                        environment={'TEST_GUIDED_CONFIGURE': 'true', 'XDG_CONFIG_HOME': str(base / 'config')})
    assert 'Enter "tailscale" to bind to the tailnet address' in transcript
    assert all(prompt not in transcript for prompt in ['Host SSH target', 'Host architecture',
        'Existing console certificate file', 'Protected console private key file',
        'Restricted SSH account on fleet nodes', 'Protected SSH private key file on the Magnus host'])
    selected = json.loads(guided_config.read_text())
    assert selected['hosts']['control']['target'] == 'local'
    assert selected['console']['httpsPort'] == 8443 and selected['console']['bindAddress'] == '100.64.0.10'
    assert selected['bootstrap']['certificateFile'] == '/etc/hive/tls/console.crt'
    assert selected['bootstrap']['privateKeyFile'] == '/etc/hive/tls/console.key'
    assert selected['bootstrap']['magnusGateway'] == {'sshUsername': 'hive-terminal',
        'sshPrivateKeyFile': '/etc/hive/fleet/gateway-key', 'grantTerminalToInitialOperator': False}
    transcript, calls = run('resume', ['resume', str(guided_config)])
    assert 'managed-certificate=true' in transcript and not calls
    selected['bootstrap']['privateKeyFile'] = '/opt/supplied/key.pem'
    guided_config.write_text(json.dumps(selected))
    transcript, calls = run('resume-supplied-certificate', ['resume', str(guided_config)])
    assert 'managed-certificate=false' in transcript and not calls
    config = base / 'finish-config.json'
    config.write_text(json.dumps({'components': {'magnus': {'host': 'control'}}, 'console': {'nativeListeners': [{'component': 'magnus'}]}}))
    transcript, calls = run('finish', ['finish', str(config)], [('Install the Magnus host agent', 'yes'), ('Review this host for full Magnus capabilities', 'yes')])
    assert 'magnus-agent enroll' in transcript and 'prepare-ardent' not in transcript
    assert 'recorded magnus-agent-enrolled done' in calls
    assert calls.index('recorded magnus-agent-enrolled done') < calls.index('magnus-agent enroll')
    for line in calls.splitlines():
        if 'magnus-agent install' in line or 'magnus-agent enroll' in line:
            assert '--release 0.1.0 --manifest /opt/reviewed/release.json --signature /opt/reviewed/release.json.sig --trust-key /opt/reviewed/publisher.pub' in line
    assert 'still pending: first-admin' in transcript and 'still pending: magnus-agent-enrolled' not in transcript
    finish_questions = [('Keep the HTTPS certificate current', 'yes'), ('Install the Magnus host agent', 'yes'),
                        ('Review this host for full Magnus capabilities', 'no')]
    transcript, calls = run('finish-all', ['finish', str(config)], finish_questions,
                            environment={'TEST_TAILSCALE': 'true'})
    assert 'recorded certificate-renewal done' in calls and 'recorded magnus-agent-enrolled done' in calls
    assert 'still pending: first-admin' in transcript
    assert 'still pending: certificate-renewal' not in transcript and 'still pending: magnus-agent-enrolled' not in transcript
    transcript, calls = run('finish-declined', ['finish', str(config)],
                            [('Keep the HTTPS certificate current', 'no'), ('Install the Magnus host agent', 'no')],
                            environment={'TEST_TAILSCALE': 'true'})
    assert 'recorded ' not in calls and 'still pending: magnus-agent-enrolled' in transcript and 'still pending: certificate-renewal' in transcript
    for helper, questions, expected in [
        ('certificate', finish_questions[:1], 1),
        ('agent', finish_questions[:2], 42),
        ('enroll', [*finish_questions[:2], ('Review this host for full Magnus capabilities', 'yes')], 42),
    ]:
        transcript, calls = run('finish-failed-' + helper, ['finish', str(config)], questions, expected=expected,
                                environment={'TEST_TAILSCALE': 'true', 'TEST_FAIL_HELPER': helper})
        assert ('recorded certificate-renewal done' in calls) == (helper != 'certificate')
        assert ('recorded magnus-agent-enrolled done' in calls) == (helper == 'enroll')
    for failure in ['TEST_REGISTRY_READ_FAIL', 'TEST_REGISTRY_WRITE_FAIL']:
        transcript, calls = run('finish-' + failure, ['finish', str(config)], finish_questions,
                                environment={'TEST_TAILSCALE': 'true', failure: 'true'})
        assert 'its checklist could not be updated' in transcript and 'recorded ' not in calls
        assert 'magnus-agent install' in calls
    transcript, calls = run('finish-old-registry', ['finish', str(config)], finish_questions,
                            environment={'TEST_TAILSCALE': 'true', 'TEST_OLD_REGISTRY': 'true'})
    assert 'recorded ' not in calls and 'its checklist could not be updated' not in transcript
    # Default Ardent provisioning follows successful native enrollment and keeps
    # the exact signed release context. The API lifecycle has separate shell/Node
    # regressions; these PTY cases exercise the actual guided offer and consent.
    ardent_config = base / 'finish-ardent-config.json'
    ardent_config.write_text(json.dumps({
        'components': {'magnus': {'host': 'control'}, 'hivemem': {'host': 'control'},
                       'oathweave': {'host': 'control'}},
        'console': {'nativeListeners': [{'component': 'magnus'}]},
    }))
    enroll_questions = [('Install the Magnus host agent', 'yes'),
                        ('Review this host for full Magnus capabilities', 'yes')]
    ardent_question = 'Set up Ardent and create its default assistant profile?'
    transcript, calls = run('finish-ardent-accepted', ['finish', str(ardent_config)],
                            [*enroll_questions, (ardent_question, 'yes')])
    child_calls = [line for line in calls.splitlines() if 'hive.sh' in line]
    assert len(child_calls) == 3 and 'ardent setup' in child_calls[-1]
    assert calls.index('magnus-agent enroll') < calls.index('ardent setup')
    assert '--config ' + str(ardent_config) in child_calls[-1]
    assert '--release 0.1.0 --manifest /opt/reviewed/release.json --signature /opt/reviewed/release.json.sig --trust-key /opt/reviewed/publisher.pub' in child_calls[-1]
    assert '--yes' not in child_calls[-1] and '--non-interactive' not in child_calls[-1]
    transcript, calls = run('finish-ardent-declined', ['finish', str(ardent_config)],
                            [*enroll_questions, (ardent_question, 'no')])
    assert 'ardent setup' not in calls
    for name, questions in [
        ('no-agent', [('Install the Magnus host agent', 'no')]),
        ('no-enrollment', [('Install the Magnus host agent', 'yes'),
                           ('Review this host for full Magnus capabilities', 'no')]),
    ]:
        transcript, calls = run('finish-ardent-' + name, ['finish', str(ardent_config)], questions)
        assert ardent_question not in transcript and 'ardent setup' not in calls
    transcript, calls = run('finish-ardent-without-memory', ['finish', str(config)], enroll_questions)
    assert ardent_question not in transcript and 'ardent setup' not in calls
    for name, environment in [('saved-mode', {'TEST_GUIDED': 'false'}),
                              ('remote-mode', {'TEST_LOCAL_SETUP': 'no'})]:
        transcript, calls = run('finish-ardent-' + name, ['finish', str(ardent_config)],
                                environment=environment)
        assert ardent_question not in transcript and not calls
    for helper, questions in [('enroll', enroll_questions),
                               ('ardent', [*enroll_questions, (ardent_question, 'yes')])]:
        transcript, calls = run('finish-ardent-failed-' + helper,
                                ['finish', str(ardent_config)], questions, expected=42,
                                environment={'TEST_FAIL_HELPER': helper})
        assert ('ardent setup' in calls) == (helper == 'ardent')
        if helper == 'enroll':
            assert ardent_question not in transcript
    print('Passed: guided Ardent setup follows successful enrollment and forwards signed release arguments, respects skips/consent, and propagates failures.')
    print('Passed: guided local and remote preparation, consent, TLS selection, terminal setup, and no changes for saved, planning or unattended commands.')
    print('Passed: guided completion records only successful preparation steps, retains personal setup and failures, and tolerates unavailable or older registries.')
