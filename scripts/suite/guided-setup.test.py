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
source "$HIVE_ROOT/scripts/suite/guided-setup.sh"
unset HIVE_SETUP_LOCAL
hive_die() { printf '%s\\n' "$*" >&2; exit 1; }
hive_setup_sudo() { printf '%s\\n' "$*" >> "$TEST_LOG"; touch "$TEST_READY"; }
bash() {
  case "$*" in
    *install-prerequisites.sh*--check*) [[ -f "$TEST_READY" ]];;
    *console-certificate.sh*check*) return 1;;
    *) printf 'reviewed helper: %s\\n' "$*";;
  esac
}
docker() { return 0; }
tailscale() { printf '{"CertDomains":["console.example.com"],"Self":{"DNSName":"console.example.com."}}'; }
hive_writable_directory() { return 1; }
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
  directory)
    HIVE_GUIDED_SETUP=true HIVE_SETUP_LOCAL=yes
    hive_setup_directory /opt/example-suite;;
  *) hive_setup_start "$@"; printf 'guided=%s\\n' "$HIVE_GUIDED_SETUP";;
esac
''')

    def run(name, arguments, questions=(), expected=0):
        log, ready = base / (name + '.calls'), base / (name + '.ready')
        transcript = base / (name + '.transcript')
        request = base / (name + '.json')
        request.write_text(json.dumps({
            'command': ['/usr/bin/env', f'TEST_LOG={log}', f'TEST_READY={ready}', '/bin/bash', str(fixture), str(root), *arguments],
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
    print('Passed: guided local and remote preparation, consent, TLS selection, terminal setup, and no changes for saved, planning or unattended commands.')
