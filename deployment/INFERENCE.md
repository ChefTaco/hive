# External inference boundary

Hive configures external inference APIs alongside hosted providers. Ollama,
llama.cpp and every other inference service are operated independently. Hive
never installs them, downloads models, allocates model storage, accepts model
licenses, provisions GPUs or certifies hardware. External services are excluded
from suite backups, restore rehearsals, upgrades and agent lifecycle actions.
Existing Emberpath provider configurations are preserved.

Each inference entry follows `examples/external-inference.schema.json`; the Bash
validator enforces the same restricted endpoint shape. An installation entry selects the host performing verification, the existing
model identifier and an HTTPS API base URL:

```json
{
  "id": "external-provider",
  "host": "control",
  "engine": "ollama",
  "protocol": "openai",
  "endpoint": "https://inference.example.com",
  "model": {"id": "existing-model"},
  "authHeaderFile": "/opt/credentials/inference.header",
  "caFile": "/opt/credentials/inference-ca.pem",
  "registration": {
    "endpoint": "https://models.example.com",
    "apiPrefix": "/api/emberpath",
    "credentialFile": "/opt/credentials/emberpath.header",
    "providerSlug": "external-provider"
  }
}
```

References are regular owner-readable files on the selected host, mode 0600 or
stricter. Omit authentication/CA references when no authentication/custom CA is
needed. Credential files contain one `Authorization: Bearer ...` header. The
registration credential is scoped to Emberpath provider enrollment. A retained
native Emberpath admin session header is also supported. Never put credential
values in configuration, browser runtime or command arguments. TLS verification
is mandatory; the controller follows no inference API redirects.

`registration.apiPrefix` defaults to `/api` for a standalone Emberpath admin
endpoint. Use the console origin with `/api/emberpath` for suite ingress. The
resource credential must permit provider writes and routing writes for aliases;
the receiving product checks it independently of the installer.
The interactive wizard asks for these references and desired aliases when an
enrollment origin is selected. Leaving that origin blank explicitly selects
endpoint verification only. Standalone recovery packages and existing provider
configurations remain available.

The Bash adapter currently accepts engines `openai`, `ollama`, and `llamacpp`
using `protocol: "openai"` for their OpenAI-compatible API (the default), or
`engine: "ollama", protocol: "ollama"` for native tags/chat/NDJSON APIs. An OpenAI
base URL may include its `/v1` suffix. Connectivity is verified through discovery,
then an ordinary and a streaming generation request for the configured model.
The media type, nonempty content and stream completion must pass. Failed checks
invalidate earlier successful receipts. Registration uses the verified protocol;
an Ollama OpenAI-compatible endpoint registers as `OPENAI`, while native Ollama
registers as `OLLAMA`.
No model pull/create/delete API is called. Other native hosted-provider protocols
remain configured and tested through Emberpath's own product APIs.

Only after all checks pass may Hive create a provider through Emberpath. An
existing provider requires its reviewed `existingProviderId`; mismatched URL/kind
fails without modification. Repeated execution preserves provider identity.
Unknown creation outcomes require audit reconciliation before retrying. Optional
explicit `registration.aliases` are submitted through Emberpath's owning API;
existing aliases are never replaced. Routing, quotas and telemetry stay entirely
in Emberpath.

## Migrating obsolete draft settings

Hive rejects `managed` (including `false`), `backend`, model URLs/digests/revisions,
download sizes, licenses, quantization, context/resource/device settings, model
storage and release `inferenceProfiles`. Remove these fields from a **copy** of
the installation configuration and retain endpoint, existing `model.id`, protected
references and optional registration. No inference container or model artifact may
be included in a Hive release manifest.

If a previous draft project contains `inference-*`, Ollama, llama.cpp or vLLM
services, or a draft `data/inference-*` directory, Hive holds lifecycle execution
before stopping, locking, archiving or changing that project. Preserve the original
configuration and all resources. Review a separate, operator-owned service definition
and a suite-only inventory before retrying. Hive does not automatically detach,
rename, move or delete existing models, containers or volumes. Keep the original
backup archives; an obsolete combined archive requires a reviewed suite-only
recovery export rather than restoring inference through Hive.

Rehearsals preserve provider database rows as application data, isolate restored
applications from outbound traffic and never start model services or restore model
files. External verification is a deliberate separate probe; fixture acceptance is
not evidence that an actual provider or agent works. No production cutover follows
from a passing rehearsal.
