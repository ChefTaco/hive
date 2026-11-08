# Hive Registry API

The Hive Registry is one installation's install catalog and lookup API. It is unrelated to
HiveSkills, the skills registry. The service listens on `http://hive-registry:8095` on the
installation's private Compose network; the ingress exposes reads as `/api/registry/*`.
See [the deployment overview](../deployment/README.md#hive-registry).

## Access levels

| Level | How | Reaches |
| --- | --- | --- |
| Public | No `Authorization` header | Public fields only |
| Read | `Authorization: Bearer` + `config/hive-registry/read-token` | Private fields and, on the private network, history |
| Write | `Authorization: Bearer` + `config/hive-registry/write-token` | Everything, plus writes on the private network |

A wrong or malformed credential gets `401`; it is never treated as public. Credentials are
long-lived shared secrets for operators and services. Do not put them in browser code.

## Field exposure

Public responses carry no more than the kind of information the console's `runtime.json`
already publishes: product names, same-origin paths and public links.

| Public | Needs a credential |
| --- | --- |
| Installation ID and installed product IDs | Origin, profile, release version and digests, revision, inventory hosts |
| Product ID, display name, description, repository, documentation and license links | Product version, image reference and digest, storage format, version history |
| Console section, required flag, dependencies, `installed` | Kind, source, status, install and update times, release |
| Console path, browser prefix, native API URLs on the console origin, documentation | Inventory host, internal endpoints |

Datastores and externally managed products without `"public": true` do not appear in the
public view at all. `installed` is true only after activation is recorded, not while a
product is `activating`. Secrets, tokens and private keys are never stored.

## Lookup

Every response is JSON with `Cache-Control: no-store`. Paths are native; add the
`/api/registry` prefix through the ingress.

| Request | Returns |
| --- | --- |
| `GET /health/ready` | `{"status":"ready","readOnly":false}` |
| `GET /v1/installation` | Installation summary |
| `GET /v1/products` | Catalog. `?installed=true` or `?installed=false` filters it |
| `GET /v1/products/{id}` | One product |
| `GET /v1/products/{id}/connection` | Console path, browser prefix, native API URLs and documentation; with a credential also the inventory host and internal endpoints |
| `GET /v1/history?after=N&limit=M` | Append-only change history. Credential required; not served by the ingress |

```json
{
  "id": "emberpath",
  "displayName": "Emberpath",
  "description": "Model gateway: external providers, routing, aliases, quotas and inference telemetry.",
  "links": { "repository": "https://github.com/ChefTaco/Emberpath", "documentation": "https://github.com/ChefTaco/Emberpath/blob/HEAD/README.md", "license": "https://github.com/ChefTaco/Emberpath/blob/HEAD/LICENSE", "licenseSpdx": "Apache-2.0" },
  "consoleSection": "models",
  "required": false,
  "installed": true,
  "dependencies": ["oathweave"]
}
```

```json
{ "id": "emberpath", "consolePath": null, "browserPrefix": "/api/emberpath", "nativeApis": { "model": "https://hive.example.com/v1" }, "documentation": "https://github.com/ChefTaco/Emberpath/blob/HEAD/README.md" }
```

## Ingress

Only `GET` passes, on `/health/ready`, `/v1/installation`, `/v1/products`,
`/v1/products/{id}` and `/v1/products/{id}/connection`. Any other method gets `405` at the
ingress, any other path `404`. Cookies are removed in both directions, and only a
well-formed bearer credential is forwarded.

## Writes

Private network only, with the write credential. `hive.sh` calls them over SSH through
`docker compose exec -T hive-registry node /app/dist/cli.js request METHOD PATH write`.

| Request | Effect |
| --- | --- |
| `POST /v1/sync` | Reconciles the release catalog and this installation's state in one transaction. Installer only |
| `PUT /v1/products/{id}` | Adds or updates an externally managed product |
| `DELETE /v1/products/{id}` | Removes an externally managed product |

A sync's `installed` entries are the products this installation runs, each with its inventory
host, version, image and `activating` or `installed`, and the release products it uses but does
not run, such as an [external Magnus](../deployment/FULL.md#external-magnus):
`{"id":"magnus","status":"external","connection":{...}}`, with no host, version or image. Only an
application can be external. It is `installed` at once and stays a release product; a sync that
no longer names it removes it on completion, like any release product.

Writes are idempotent: an unchanged write changes no rows and adds no history, and the
response reports `{"schema":1,"changes":0,"revision":N}`. Release-owned products cannot be
edited by hand (`409`), and a sync for another installation is refused (`409`).

A value that looks like a credential is refused with `422 secret_rejected`, by field name
or by shape, and the value is never echoed. Unknown fields are refused with
`422 invalid_request`. A rehearsal copy refuses all writes with `503 read_only`.

An externally managed entry, as sent by `hive.sh registry add ID --file ENTRY.json`:

```json
{
  "displayName": "External provider",
  "description": "Operator-managed model API",
  "links": { "documentation": "https://models.example.com/docs" },
  "public": false,
  "inventoryHost": null,
  "version": "2.1.0",
  "connection": { "nativeApis": { "model": "https://models.example.com/v1" }, "internalEndpoints": { "admin": "https://models.internal.example.com:9443" } }
}
```

## Storage

SQLite in WAL mode at `/data/registry.sqlite`, with strict tables and immutable, checksummed
migrations. An empty store gets its baseline on first start. Pending migrations on existing
data need an explicit, signed release migration (`node /app/dist/cli.js migrate`).
