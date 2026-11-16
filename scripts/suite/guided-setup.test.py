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
      if [[ "$*" == *'magnus-agent enroll'* && ${TEST_FAIL_HELPER:-} == enroll ]]; then return 42; fi;;
  esac
}
docker() { return 0; }
tailscale() { printf '{"CertDomains":["console.example.com"],"Self":{"DNSName":"console.example.com."}}'; }
hive_writable_directory() { return 1; }
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
    HIVE_GUIDED_SETUP=true HIVE_SETUP_LOCAL=yes HIVE_SETUP_TAILSCALE=${TEST_TAILSCALE:-false}
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
    questions = [('Prepare this machine', 'yes'), ('Apply these prerequisite changes', 'yes')]
    transcript, calls = run('local', ['install', '--release', 'latest'], questions)
    assert 'guided=true' in transcript and '--controller' not in calls and '--yes' in calls
    transcript, calls = run('remote', ['install'], [('Prepare this machine', 'no'), ('Apply these prerequisite changes', 'yes')])
    assert '--controller' in calls
    transcript, calls = run('declined', ['install'], [('Prepare this machine', 'yes'), ('Apply these prerequisite changes', 'no')], expected=1)
    assert not calls and 'Prerequisites were not changed' in transcript
    transcript, calls = run('certificate', ['certificate', 'https://console.example.com'], [('Obtain the console certificate', 'yes')])
    assert 'certificate=/etc/hive/tls/console.crt key=/etc/hive/tls/console.key' in transcript and 'tailscale' in calls
    transcript, calls = run('other-origin', ['certificate', 'https://other.example.com'])
    assert not calls and 'certificate= key=' in transcript
    transcript, calls = run('certificate-declined', ['certificate', 'https://console.example.com'], [('Obtain the console certificate', 'no')])
    assert not calls and 'certificate= key=' in transcript
    transcript, calls = run('terminal', ['terminal'], [('Prepare that account and key', 'yes')])
    assert 'prepare-terminal.sh' in calls and 'account=hive-terminal key=/etc/hive/fleet/gateway-key' in transcript
    transcript, calls = run('terminal-declined', ['terminal'], [('Prepare that account and key', 'no')])
    assert not calls and 'account= key=' in transcript
    transcript, calls = run('directory', ['directory'], [('Create /opt/example-suite', 'yes')])
    assert '--directory /opt/example-suite' in calls
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
    print('Passed: guided local and remote preparation, consent, TLS selection, terminal setup, and no changes for saved, planning or unattended commands.')
    print('Passed: guided completion records only successful preparation steps, retains personal setup and failures, and tolerates unavailable or older registries.')
