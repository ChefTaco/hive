# Optional native Skills deployment

Skills reads and publication administration work without host deployment targets.
Deployment requires an explicit existing Magnus node and Hermes profile; selecting
the products does not enroll a node, create an account, mint a target credential,
install Hermes or guess a profile. The suite never runs the legacy SSH deployment
helper. Magnus remains the owner of approved host jobs.

Use protected installation configuration to opt in:

```json
{
  "skillsDeployment": {
    "registryId": "example-registry",
    "clientVersion": "1.2.2",
    "executor": {
      "origin": "https://magnus.example.com",
      "credentialFile": "/protected/skills-executor-token",
      "caFile": "/protected/authority.pem"
    },
    "targets": [{
      "target": "example-profile",
      "host": "agent-host",
      "nodeId": "explicit-existing-node-id",
      "agentTarget": "example-native-profile",
      "owner": "operator",
      "home": "/opt/operator",
      "hermesHome": "/opt/operator/hermes",
      "environmentFile": "/protected/example-skills.env",
      "clientDirectory": "/opt/hive-skills-client",
      "nodeBinary": "/usr/local/bin/node",
      "caFile": "/protected/authority.pem"
    }]
  }
}
```

After the suite is installed, use the explicit preparation command:

```bash
./hive.sh skills-prepare --config /protected/installation.json \
  --manifest /protected/release.json --signature /protected/release.json.sig \
  --trust-key /protected/publisher.pub --non-interactive --yes
```

It validates every selected host before staging, then writes owner-only proposals
under each installation's `config/skills-proposals/<plan SHA-256>.json`. They
contain protected file references, exact mappings and an executor token digest;
they contain no raw token. Existing different proposals fail without overwrite.
The command never changes active backend or agent configuration. An unavailable
owner readiness check returns exit status 2 with proposals retained for review.
Apply their approved values through the corresponding owning service's supported
operator workflow, then rerun preparation to check the exact active posture.
Root client preparation requires an explicitly root-owned operator session on that
host; the controller never inserts sudo or changes an existing SSH identity.

The executor credential file contains a single raw random token, without `Bearer`
or an environment assignment, with owner-only permissions. It is copied only to
the registry backend's protected configuration. Magnus receives its SHA-256 in
`MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON`, alongside the exact registry-target to node
and native-target bindings. It grants only the fixed Skills operation and read-only
posture API. Browser clients never receive this credential or native target tokens.

For a new deployment, complete the ordinary Magnus node enrollment/drain workflow
and identify the existing profile independently. Keep any old deployment operation
with unknown outcome held; do not create a replacement job to clear it. Configure
explicit server-owned mappings and the native agent's
`MAGNUS_AGENT_HIVESKILLS_TARGETS_JSON` through the protected owning configuration.
The native mapping contains registry ID, registry target, owner, home, Hermes home,
`envFile`, exact `syncScript`, `nodeBinary` and optional `caFile`. No application
container needs the Docker socket or a host password database.

A release maintainer exports the reviewed public client using HiveSkills's
`scripts/build-native-client.mjs`. Its signed release record is
`nativeClients.hiveskills` with exact `version`, HTTPS artifact `url`, archive
`sha256`, tested `nodeVersion`, and the SHA-256 of exactly `hermes-sync.mjs`,
`archive-utils.mjs`, `LICENSE` and `NOTICE`. A selected client version must match
that signed record. The installer verifies the bundled publisher signature before
using it. It neither downloads a Node runtime nor upgrades the host's Node.

An explicit root operator must prepare a missing client on the chosen host. Hive
never escalates privileges. Staging creates only a new immutable digest directory:
`<clientDirectory>/<archive SHA-256>/hermes-sync.mjs`. Existing client contents,
profiles and credentials are not overwritten, deleted, chowned or adopted. A
non-root run can verify an already prepared root-owned client; a missing client
returns a held state with an operator preparation instruction. Changed bytes or
untrusted paths fail. Client and executable paths, including all parent
directories, must be root-owned, canonical and unwritable by other accounts.

Use a dedicated owner-only native environment file, belonging to the explicit
unprivileged profile owner. Its allowed keys are `HIVE_SKILLS_URL`,
`HIVE_SKILLS_TARGET_TOKEN`, `HIVE_SKILLS_HERMES_VERSION`, `HIVE_SKILLS_TARGET`,
`HERMES_HOME`, `HERMES_BIN` and `NODE_EXTRA_CA_CERTS`. Infrastructure and node
manager variables are rejected. Registry access uses HTTPS; a private CA is an
explicit protected `caFile`. `NODE_EXTRA_CA_CERTS`, if present, must match that
file, which the agent supplies at Node startup.

Before enabling backend deployment configuration, read-only verification calls
Magnus's authenticated `GET /api/v1/hiveskills/targets/{target}` and compares exact
registry ID, node ID, native target, native configuration digest and signed client
digest. Magnus verifies current node enrollment, hostname, heartbeat and retained
ownership, then reads the authenticated native agent's posture. Missing or changed
state remains unavailable for operator review. This check never dispatches a job,
issues credentials or reseeds state. A fresh suite without existing enrolled
nodes therefore keeps deployment unavailable until this owner workflow finishes.

After configuration, HiveXUI prepares an exact publication preview. A recent
Oathweave-authenticated authorized operator approves its digest with an expiring
one-use approval. The Skills backend records the durable Magnus job ID before
execution. Retries and reconciliation inspect that original signed receipt;
unknown outcomes never trigger another dispatch or implicit credential rotation.

For developer verification, `scripts/suite/skills-client-roundtrip.mjs` stages the
real public client in a disposable root container with synthetic owner files,
then checks non-root verification, unchanged credentials, stable repeated staging
and refusal to overwrite tampered files. `skills-native-roundtrip.mjs` separately
runs real native admission, immutable publication synchronization and unknown
outcome containment against disposable Magnus, PostgreSQL and Redis. Neither
proof selects an existing host or authorizes production cutover.
