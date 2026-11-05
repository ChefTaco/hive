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

Ardent has a separate native bundle exported with `--product ardent`. Its owned
acceptance checks the authenticated gateway, exact version/profile/backend and
dependency readiness. The protected environment reaches Node before startup,
including private CA references. A disposable core rehearsal additionally proves
model generation through Emberpath and storage/search through an independent,
workspace-scoped HiveMem identity. Model and memory credentials cannot administer
either backend. Profile credentials are preserved, and termination stops the
gateway child process. Skills, Emberfold and chat integrations need their own
acceptance before enabling their consumers.

Codex has a separate `--product codex` export from an exact npm version and
lockfile integrity. Its launcher requires an owned private profile and environment
file, rejects conflicting `CODEX_HOME` selection, and leaves existing configuration
and login credentials intact. Use the profile's custom provider with a protected
Emberpath key and verified CA reference; interactive provider authorization remains
an explicit operator step. A disposable core check runs the actual native Codex
Responses client through Emberpath with a scoped key, alias resolution and streaming.
It also rejects administration and cross-product use of that key. This proves the
selected CLI generation workflow, not a persistent app-server supervisor or an
existing account's provider authorization. Its bounded `--native-acceptance`
contract uses an isolated temporary configuration and a one-request verification
relay, refuses tools and redirects, and checks the expected streamed answer. Strict
`agents-accept` records that proof against the signed artifact; it does not infer
persistent supervision from a successful generation.

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

Add `--external-provider --ardent-artifact PATH_TO_PRIVATE_DESCRIPTOR` to the
`test:suite:core` driver for the native Ardent integration. It creates only a
disposable profile and developer-owned external HTTPS protocol fixture, followed
by the same core backup and isolated restore. It installs no inference service or
model. Existing services and agent profiles are never selected by this driver.

Add `--external-provider --codex-artifact PATH_TO_PRIVATE_DESCRIPTOR` to
`test:suite:core` for the pinned native Codex integration. Ardent and Codex can be
checked together. The driver verifies the actual Bash artifact adapter, preserves
private configuration bytes, completes strict product-owned acceptance, and uses
only a developer-owned external protocol fixture. The fixture is outside deployment
inventory and installs no inference service or model asset.

Hermes uses the separately reviewed public upstream snapshot, bundled Python,
locked dependencies and fixed SQLite from Magnus's `--product hermes` export.
It does not package an operator's fork, existing profile or login state. Its
read-only preflight runs before explicit profile initialization. Signed
`initializationArguments` and `verificationArguments` record the product's setup
contract; see [NATIVE_INITIALIZATION.md](NATIVE_INITIALIZATION.md). An interrupted
claim is checked by the exact verifier rather than replayed. Provider authorization
remains an operator step. Actual acceptance requires a streamed answer through
the configured verified HTTPS endpoint, without enabling tools.

The independent HiveMem Hermes plugin archive contains reviewed runtime files,
attribution and per-file hashes. It registers with Hermes's actual memory-provider
loader and uses a separate workspace-scoped memory identity. Its API URL supports
an explicit ingress base such as `https://console.example.com/memory`; the plugin
adds native `/v1` paths. Model and memory credentials remain distinct. The native
CLI write check creates, searches and soft-deletes a disposable memory; it does
not claim a full conversation capture or live-profile migration.

Add `--external-provider --enrollment --hermes-artifact PRIVATE_DESCRIPTOR
--hivemem-plugin-artifact PRIVATE_PLUGIN_DESCRIPTOR` to the core developer drill.
It stages and initializes a fresh private profile through the real Bash adapter,
checks exact retry, streams through Emberpath, and runs the native plugin's scoped
write/search/delete check before the core backup and isolated restore. Existing
profiles are never selected. These local AMD64 checks do not certify physical
ARM64 deployments or persistent production supervision.
