#!/usr/bin/env python3
"""Developer PTY adapter. The Bash controller never invokes Python."""
import json
import os
import pty
import select
import signal
import sys
import time

with open(sys.argv[1], encoding='utf-8') as source:
    request = json.load(source)
pid, descriptor = pty.fork()
if pid == 0:
    os.execv(request['command'][0], request['command'])
pending = ''
transcript = ''
index = 0
status = None
deadline = time.monotonic() + request.get('timeoutSeconds', 300)
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
            if index < len(request['questions']) and request['questions'][index][0] in pending:
                os.write(descriptor, (request['questions'][index][1] + '\n').encode())
                index += 1
                pending = ''
        finished, value = os.waitpid(pid, os.WNOHANG)
        if finished:
            status = value
            break
    else:
        os.kill(pid, signal.SIGKILL)
        raise RuntimeError('Interactive installer timed out')
finally:
    os.close(descriptor)
    if status is None:
        _, status = os.waitpid(pid, 0)
    descriptor = os.open(request['transcriptFile'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as target:
        target.write(transcript)
assert index == len(request['questions']), 'Interactive installer did not consume every reviewed response'
raise SystemExit(os.waitstatus_to_exitcode(status))
