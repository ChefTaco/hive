# @hivemagnus/hivemem-server

HiveMem is a self-hosted shared memory server for AI agents. Agents store and recall episodic,
semantic, and procedural memories over a REST API, with workspace and per-agent isolation, HS256
JWT auth, lexical and optional semantic search, citation-backed chat and context packages, a
reasoning queue, webhooks, and an operator dashboard at `/dashboard`. Data lives in
[Qdrant](https://qdrant.tech).

This package is the server. Clients use the REST API directly or the
[`@hivemagnus/hivemem-sdk`](https://www.npmjs.com/package/@hivemagnus/hivemem-sdk) TypeScript SDK.

> **Running the whole Hive stack?** The `@hivemagnus/hive` launcher installs, configures, and runs
> HiveMem together with the Hive Router and IAM, including generated secrets. Use this package
> directly when you only want the memory server.

## Requirements

- Node.js 24 (24.22.1 or later) or Node.js 26 (26.13.0 or later)
- Linux or macOS with the `flock` command (part of util-linux on Linux; on macOS install a `flock`
  package, for example with Homebrew). HiveMem uses it to guarantee a single writer per data
  directory.
- A Qdrant instance, by default at `http://127.0.0.1:6333`
- Optional: an OpenAI-compatible `/v1/embeddings` endpoint for a semantic search index. Without
  one, HiveMem uses deterministic lexical retrieval.

## Quick start

Start Qdrant (bound to localhost):

```bash
docker run -d --name hive-qdrant -p 127.0.0.1:6333:6333 \
  -v hive-qdrant:/qdrant/storage qdrant/qdrant:v1.18.1
```

Create an env file with a JWT signing secret and keep it private:

```bash
umask 077
printf 'HIVEMEM_JWT_SECRET=%s\n' "$(openssl rand -hex 32)" > hivemem.env
```

Check the configuration, then start the server:

```bash
npx @hivemagnus/hivemem-server check --env-file hivemem.env
npx @hivemagnus/hivemem-server --env-file hivemem.env
curl http://127.0.0.1:18790/v1/health/ready
```

To install it globally instead, run `npm install -g @hivemagnus/hivemem-server` and use the
`hivemem-server` command.

Agents authenticate with HS256 JWTs signed by `HIVEMEM_JWT_SECRET`. See the
[API reference](https://github.com/ChefTaco/hive/blob/main/services/hive-mem/HIVEMEM_API.md) for
token issuance, registration, and every endpoint.

## Commands

| Command | What it does |
| --- | --- |
| `hivemem-server` or `hivemem-server start` | Start the server |
| `hivemem-server check` | Validate the configuration and check that Qdrant is reachable. Prints a report and exits 0 when the server can start, 1 otherwise. It does not start the server or write data. |
| `hivemem-server env-schema` | Print every supported environment variable as JSON (name, default, whether it is required or secret, and a description). Tools such as the Hive launcher use it to generate env files. |
| `hivemem-server issue-token --subject <id>` | Sign an access token with `HIVEMEM_JWT_SECRET` and print only the token. See [Issuing tokens](#issuing-tokens). |
| `hivemem-server --help` / `--version` | Show usage or the version |

`--env-file <path>` loads a dotenv file before the configuration is read. It works with `start`,
`check` and `issue-token`, can be repeated, and never overrides variables that are already set in
the environment.

### Issuing tokens

`issue-token` mints a token locally from the signing secret, so you can create the first admin
token, or a server-side credential for another service, without calling the API:

```bash
# Admin token for the Hive Router's memory proxy (HIVE_ROUTER_MEMORY_PROXY_TOKEN)
npx @hivemagnus/hivemem-server issue-token --env-file hivemem.env --subject hive-router --role admin

# Agent token with two scopes, valid for 12 hours
npx @hivemagnus/hivemem-server issue-token --env-file hivemem.env --subject agent-1 \
  --scope memories:read --scope memories:write --ttl 12h
```

| Option | Default | Notes |
| --- | --- | --- |
| `--subject <id>` | required | The agent or service identity (`sub`). |
| `--role <role>` | `agent` | `agent` or `admin`. |
| `--scope <scopes>` | by role | Repeatable, or space or comma separated. Admin tokens default to `admin:all`; agent tokens default to the standard agent scopes and cannot carry `admin:*` or `*`. |
| `--ttl <duration>` | `30d` | `3600`, `90m`, `12h` or `30d`; between 60 seconds and 30 days, the same cap as `POST /v1/auth/tokens`. |

The token carries the same claims the server issues (`iss`, `aud`, `token_type`, `jti`, `iat`,
`exp`, `sub`, `role`, `scope`) and is checked with the server's own verifier before it is printed.
Only the token goes to stdout; nothing is written to disk. The secret is validated exactly as the
server validates it. Tokens stay valid until they expire, the secret is rotated, or they are
revoked with `POST /v1/auth/revoke`. Issue a new one before the old one expires. A token for an
agent whose credentials were rotated through the API is rejected; use `POST /v1/auth/tokens` for
those agents.

## Configuration

All configuration comes from environment variables. Only `HIVEMEM_JWT_SECRET` is required.

| Variable | Default | Notes |
| --- | --- | --- |
| `HIVEMEM_JWT_SECRET` | required | Signing secret for agent and admin tokens, at least 32 bytes. Generate one with `openssl rand -hex 32`. Rotating it invalidates every token. |
| `HIVEMEM_RENEWAL_SECRET` | unset | Separate secret that enables `POST /v1/auth/renew` renewal grants. Must differ from `HIVEMEM_JWT_SECRET`. |
| `HIVEMEM_TS_CORE_HOST` | `127.0.0.1` | Listen address. Use `0.0.0.0` only with TLS or behind a trusted proxy. |
| `HIVEMEM_WEB_PORT` | `18790` | Listen port (`HIVEMEM_TS_CORE_PORT` overrides it). |
| `HIVEMEM_STORAGE_PATH` | `${HIVE_HOME:-~/.hive}/memory` | Local state: writer lock, write-recovery journal, and token revocation list. Created with mode `0700`. Memories themselves live in Qdrant. |
| `HIVEMEM_TS_PERSISTENCE` | `qdrant` | `qdrant`, or `memory` for a throwaway server whose data is lost when it stops. |
| `HIVEMEM_QDRANT_URL` | `http://127.0.0.1:6333` | Qdrant REST URL. Keep Qdrant on localhost or a private network. |
| `QDRANT_API_KEY` | unset | Sent to Qdrant when set. |
| `HIVEMEM_TLS_CERT_FILE`, `HIVEMEM_TLS_KEY_FILE` | unset | PEM certificate and key. Set both to serve HTTPS; set neither for plain HTTP. |
| `HIVEMEM_METRICS_TOKEN` | unset | Static bearer token (32+ characters) for `GET /metrics`; admin JWTs always work. |
| `HIVEMEM_EMBEDDING_ENDPOINT` | unset | Optional OpenAI-compatible embeddings URL (HTTPS, or HTTP on loopback). Also set `HIVEMEM_EMBEDDING_MODEL`, `HIVEMEM_EMBEDDING_REVISION`, `HIVEMEM_EMBEDDING_DIMENSIONS`, `HIVEMEM_SEMANTIC_COLLECTION` (must start with `hivemem_shadow_`), and `HIVEMEM_EMBEDDING_API_KEY` if the endpoint needs a key. |

Run `hivemem-server env-schema` for the machine-readable list. The
[API reference](https://github.com/ChefTaco/hive/blob/main/services/hive-mem/HIVEMEM_API.md)
documents the remaining tuning variables.

### No silent data loss

HiveMem refuses to start when Qdrant is unreachable instead of quietly falling back to memory.
For tests and demos, opt in to a volatile server explicitly:

```bash
HIVEMEM_TS_PERSISTENCE=memory npx @hivemagnus/hivemem-server --env-file hivemem.env
```

### HTTPS

For anything beyond localhost, serve HTTPS with your own certificate, for example for
`memory.example.com`:

```bash
HIVEMEM_TS_CORE_HOST=0.0.0.0
HIVEMEM_WEB_PORT=18443
HIVEMEM_TLS_CERT_FILE=/opt/hivemem/certs/server.crt
HIVEMEM_TLS_KEY_FILE=/opt/hivemem/certs/server.key
```

Clients then use `https://memory.example.com:18443`.

## Health endpoints

`GET /v1/health/ready` returns `200` with `"status": "ok"` when storage and the worker are ready,
and `503` otherwise. `GET /v1/health/live` reports process liveness only. Neither needs auth.

## Library use

The package also exports the server pieces for embedding and tests:

```ts
import { createHiveMemServer, InMemoryHiveMemStore, signToken } from "@hivemagnus/hivemem-server";
```

## Links

- [REST API reference](https://github.com/ChefTaco/hive/blob/main/services/hive-mem/HIVEMEM_API.md)
- [Architecture](https://github.com/ChefTaco/hive/blob/main/services/hive-mem/APP_ARCHITECTURE.md)
- [Source and issues](https://github.com/ChefTaco/hive)

## Development

From a clone of the repository:

```bash
cd services/hive-mem/ts-core
npm ci
npm run typecheck
npm test        # builds, then runs the node:test suite
```

`HIVEMEM_DUALSTACK_TOKEN=<jwt> npm run test:dual-stack` runs the black-box REST compatibility
harness against a local server.

## License

Apache-2.0
