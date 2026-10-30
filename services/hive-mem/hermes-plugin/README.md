# HiveMem Hermes Memory Provider

This directory contains a Hermes Agent memory-provider plugin that connects Hermes to the TypeScript HiveMem REST API. Agents send plain text; HiveMem handles private/shared scoping, temporal validity, provenance, graph links, deterministic retrieval, duplicate suppression, and lifecycle invalidation. Embeddings remain an optional shadow benchmark and are not required by this provider.

## Layout

```text
hermes-plugin/
  plugins/memory/hivemem/
    __init__.py      MemoryProvider implementation + register(ctx)
    cli.py           hermes hivemem status/config/test commands
    plugin.yaml      Hermes provider metadata
  scripts/
    deploy_hermes_plugin.sh
  tests/
    test_hivemem_provider.py
```

Current Hermes profiles discover user-installed memory providers under `$HERMES_HOME/plugins/<name>/`; this provider's name is `hivemem`, the deploy script installs it as `$HERMES_HOME/plugins/hivemem`, and Hermes should be configured with `memory.provider: hivemem`.

## Configure HiveMem Access

Register a Hermes agent token on the HiveMem server:

```bash
python scripts/register_agent.py --agent-id hermes --display-name "Hermes Agent" --api-url "$HIVEMEM_API_URL"
```

Save the returned token in the Hermes profile's `.env`:

```bash
HERMES_HIVEMEM_API_URL=https://hivemem.example.com
HERMES_HIVEMEM_TOKEN=<agent-jwt-from-hivemem>
# HERMES_HIVEMEM_CA_FILE=/path/to/hermes-home/plugins/hivemem/hivemem-ca.pem
```

The default destination is `http://localhost:18790`. Bare host names such as `hivemem.example.com` are normalized to `https://hivemem.example.com`; plain HTTP is accepted only for exact loopback development. HTTPS always verifies the peer hostname using the system CA store or the PEM trust anchor in `HERMES_HIVEMEM_CA_FILE`. Credentialed redirects are rejected before a second request is made.

Non-secret provider options live in `$HERMES_HOME/hivemem.json`:

```json
{
  "api_url": "https://hivemem.example.com",
  "workspace_id": "default",
  "default_scope": "private",
  "recall_mode": "hybrid",
  "capture_turns": true,
  "max_recall_results": 5,
  "context_tokens": 1200
}
```

## Deploy Locally

```bash
HERMES_HIVEMEM_TOKEN="$HERMES_HIVEMEM_TOKEN" bash hermes-plugin/scripts/deploy_hermes_plugin.sh \
  --hermes-home "$HOME/.hermes" \
  --api-url "$HIVEMEM_API_URL" \
  --set-active
```

Restart active Hermes sessions or the gateway after deployment:

```bash
hermes gateway restart
```

## Deploy Over SSH

```bash
HERMES_HIVEMEM_TOKEN="$HERMES_HIVEMEM_TOKEN" bash hermes-plugin/scripts/deploy_hermes_plugin.sh \
  --ssh-host hermes.example.com \
  --ssh-user deploy \
  --ssh-identity-file /secure/hermes_ed25519 \
  --ssh-known-hosts-file /secure/hermes_known_hosts \
  --remote-hermes-home '~/.hermes' \
  --api-url "$HIVEMEM_API_URL" \
  --ca-file /secure/hivemem-ca.pem \
  --set-active \
  --restart-gateway
```

Use `--dry-run` first to preview copy/config/activation steps.

## Hermes Commands

When `memory.provider` is `hivemem`, Hermes discovers provider-specific CLI commands:

```bash
hermes hivemem status
hermes hivemem config
hermes hivemem test
hermes hivemem test --write-check
```

`--write-check` creates, searches, and soft-deletes a disposable private memory.

## Exposed Tools

The provider exposes these Hermes tool schemas in `hybrid` and `tools` modes:

- `hivemem_store` — create a memory with optional provenance, validity, sensitivity, entities, relationships, and supersession.
- `hivemem_search` — deterministic lexical/graph/RRF search with citation-rich results and optional historical `as_of` lookup.
- `hivemem_get` — fetch by UUID.
- `hivemem_update` — update owned memory fields.
- `hivemem_delete` — soft delete an owned memory.
- `hivemem_browse` — browse recent memories.

Automatic hooks:

- `queue_prefetch()` searches HiveMem in the background for upcoming turns using bounded graph expansion and token-Jaccard MMR.
- `prefetch()` injects citation-marked `<hivemem-context>` as untrusted evidence when cached recall is available; recall failures stay silent.
- `sync_turn()` stores completed conversation turns asynchronously.
- `on_memory_write()` mirrors explicit Hermes memory writes as semantic memories.

## Test

From the HiveMem repo root:

```bash
pytest hermes-plugin/tests -v
```

Most tests use a local fake HiveMem HTTP server. The TypeScript migration compatibility test builds `ts-core`, launches it on an ephemeral localhost port, mints a short-lived test JWT, and runs the real Python plugin tool flow against it:

```bash
npm run test:memory-hermes-dual-stack
```

Tests marked `hermes` also import real Hermes classes when Hermes Agent is installed or `HERMES_AGENT_ROOT`/`PYTHONPATH` points to a checkout:

```bash
PYTHONPATH=/path/to/hermes-agent pytest hermes-plugin/tests -m hermes -v
```

Optional full manual verification against a real HiveMem server:

```bash
hermes hivemem test --write-check
```

Repository documentation can be synchronized separately with the preview-first `../scripts/sync_project_knowledge.py` operator CLI. It does not change automatic conversation capture, and it writes only to the workspace (`--workspace-id`) and token you select.

## Security Notes

- Store the HiveMem JWT only in the Hermes profile `.env` or secret store.
- Supply deploy-time JWTs only through the environment or a protected `--env-file`; the helper does not accept secret command-line flags.
- Remote deployment requires a mode-`0400`/`0600` identity and pre-provisioned known-hosts pin. Password SSH and trust-on-first-use are unsupported.
- Use `--ca-file` for private PKI. There is no TLS verification bypass.
- Do not commit real tokens; `.env` is ignored.
- The plugin never sends `agent_id` in memory create/update requests. HiveMem derives identity from the JWT `sub` claim.
- `DELETE` is a HiveMem soft delete. Server-side prune/archive policy remains controlled by HiveMem.
