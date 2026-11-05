# Native optional product consumers

Ardent already consumes the released Emberfold SDK inside its context engine, reads
explicitly enabled skills from profile-relative directories, and implements the
Mattermost REST and WebSocket client protocol used by ChatterMost. These are native
product capabilities. Hive supplies explicit endpoint and protected credential
references; it does not proxy administrator credentials into an agent.

An operator may select `skills/registry` in Ardent's `skills.directories`, alongside
other existing skill directories. The native HiveSkills client publishes immutable,
digest-verified files into this directory, then the operator explicitly enables
reviewed skill names. A skill supplies instructions and never grants new tools or
permissions. Preserve existing profile configuration and credentials when applying
these additive choices. Use the Magnus-managed Skills job path for enrolled host
updates; see [Skills deployment](SKILLS_DEPLOYMENT.md).

Configure Ardent's Mattermost channel with the ChatterMost HTTPS origin, its own
native bot token environment reference, and explicit allowed user IDs and channel
IDs. The bot token belongs to ChatterMost and is separate from model, memory and
Skills credentials. Direct messages still require an allowed user. Native bot and
channel permissions remain enforced by ChatterMost. Do not run a second gateway
against an existing profile or reuse an operator's browser token.

The optional Emberfold HTTP service is a separate interface from the SDK embedded
in Ardent. Enabling the HTTP container does not make agents use it automatically.
Keep the selected SDK or HTTP contract explicit; a checkpoint carries source
attribution and historical, unverified state rather than application authority.

## Disposable acceptance

Build the separately selected Skills and Chat source trees, then run:

```bash
npm run test:suite:consumers -- \
  --ardent-artifact PRIVATE_REVIEWED_DESCRIPTOR \
  --skills-root BUILT_SKILLS_SOURCE \
  --chat-root BUILT_CHAT_SOURCE \
  --output NEW_PRIVATE_EVIDENCE_DIRECTORY
```

The developer driver requires an exact reviewed local Ardent archive digest and
matching host architecture. It creates a new private profile, new loopback HTTPS
services, synthetic accounts and a dedicated certificate. It selects no existing
installation, profile, database or external provider credential. Product server
processes run as the current ordinary user and are stopped on completion; evidence
remains private. There is no Docker socket, privileged host provisioning, external
dispatch, model download, inference container or model asset.

The actual Skills registry issues a target-scoped token, publishes an immutable
archive and verifies the native sync client's repeat behavior. The packaged Ardent
then receives a real ChatterMost native WebSocket event, calls `skill_view`, consumes
the exact synced skill bytes and posts its answer through the native Chat REST API.
The scoped tokens cannot administer their services, and a disallowed synthetic Chat
account produces no Ardent task. The profile environment remains byte-identical.

A separate fresh database exercises Ardent's packaged Emberfold checkpoint manager:
source-bound publication, attributed continuation, same-version reader reconstruction,
corruption detection and rebuild from unchanged source rows. The summarizer and
streaming model endpoint are explicitly synthetic HTTPS protocol fixtures outside
Hive's deployment inventory. This is integration and recovery proof; it does not
measure a real model's answer quality, validate Codex compaction, prove cross-version
checkpoint rollback, or certify the optional HTTP service.

The generic skill fixture declares no Hermes version compatibility bounds. Its sync
client explicitly skips Hermes detection and uses a no-op restart only because the
fresh Ardent profile has not started. This does not certify Hermes Skills activation
or modify a real Hermes service. Native Hermes model and HiveMem plugin acceptance
have their own [agent rehearsal](NATIVE_AGENTS.md) contract. ARM64 and existing-profile
adoption require their own selected artifacts and isolated acceptance.
