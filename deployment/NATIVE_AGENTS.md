# Native agent artifacts and acceptance

Hive stages selected native agents through their existing unprivileged account.
Agent versions are independent of the suite version. The signed release matrix
selects an exact HTTPS archive URL, SHA-256, architecture, launcher and literal
arguments. Product maintainers own those launchers and any bundled runtimes.
Hive needs no host Node or Python installation beyond a selected agent's own
declared runtime. Existing profiles and credentials are retained.

The Magnus product's `build:native-agent` tooling exports a reviewed immutable
image into a native bundle with its exact Node binary, public runtime files and
licenses. Its `artifact.json` provides `executable`, `arguments`, `preflight` and
`acceptanceArguments` for the release publisher to review, publish and pin.
Building a local artifact does not publish or certify a release.

Before activation, an optional signed `preflight` command must emit its exact
expected version. Extracted contents and the selected environment file receive
protected fingerprints. Retry or acceptance refuses altered artifacts, changed
environment bytes, changed profile selection or loosened credential permissions.
Restore the original inputs, or explicitly review a new `configurationRevision`.
No credential is regenerated to recover from a failed check.

Launchers start with a private umask and a small base environment: PATH, HOME,
locale and the user runtime directory. Product launchers load their own protected
environment file. Unrelated installer credentials are not inherited. Arguments
use `@PROFILE@`, `@ENV_FILE@` or `@ARTIFACT@/relative-path` substitutions and are
passed literally, without shell evaluation.

`service: "user"` starts an installer-owned user service only after explicit
operator/provider authorization. `service: "none"` leaves startup to the selected
supervisor or operator. Start its prepared `agents/ID/run.PLAN` launcher separately,
then run:

```bash
./hive.sh agents-accept --config installation.json --non-interactive --yes
./hive.sh status --config installation.json
```

Acceptance uses the active signed release and the product's own bounded JSON
contract. It does not restart suite containers. The Magnus agent verifies its
authenticated HTTPS health endpoint, expected version and a recent explicitly
accepted heartbeat. Set its `MAGNUS_AGENT_SELF_URL` and optional private
`MAGNUS_AGENT_SELF_CA_PATH` in the protected environment file before staging.
Certificate verification remains mandatory. A reachable listener alone does not
pass. Other runtimes without a completed product acceptance contract remain
explicitly pending; provider authorization is an operator step.

Status emits one versioned object per host, with container state and native agent
installation, preflight and acceptance state. Healthy containers do not imply
that a native agent is accepted. Raw credentials, fingerprints and diagnostic
bodies are excluded from this summary.

Native artifacts and profile backups may not take ownership of inference models.
Common model files or external runtime caches hold profile handling before they
are archived. Preserve those resources in place and review a suite-only profile
backup contract. No model service, model download, GPU setup or hardware
certification is part of agent installation.

`test:suite:agents` accepts a reviewed product artifact descriptor, a pinned local
Magnus API image and a new private evidence directory. It stages the real native
bundle through the Bash adapter, runs it against disposable PostgreSQL/Redis/API
services, verifies a heartbeat and executes a harmless authenticated `printf` job.
It preserves profile credential bytes and retains recovery evidence. This is one
physical Linux host, separate from full-profile, multi-host and model-agent
identity acceptance. Native privileged host changes still require the owning
Magnus approval and agent policies.
