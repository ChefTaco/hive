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
| Inventory | `Authorization: Bearer` + an Oathweave access token for the `hive-registry` audience with `registry:inventory` (Registry 1.4.0) | [`GET /v1/inventory`](#inventory) only |

A wrong or malformed credential gets `401`; it is never treated as public. Credentials are
long-lived shared secrets for operators and services. Do not put them in browser code. An
Oathweave token opens the inventory and nothing else: any other route answers it `401` like any
unknown credential.

## Field exposure

Public responses carry no more than the kind of information HiveXUI's `runtime.json`
already publishes: product names, same-origin paths and public links.

| Public | Needs a credential |
| --- | --- |
| Installation ID, installed product IDs and the [setup checklist](#setup-checklist) | Origin, profile, release version and digests, revision, inventory hosts |
| Product ID, display name, description, repository, documentation and license links | Product version, image reference and digest, storage format, version history |
| Console section, required flag, dependencies, `installed`, capabilities | Kind, source, status, install and update times, release |
| Console path, browser prefix, native API URLs on the console origin, documentation, capabilities | Inventory host, internal endpoints, [service capabilities](#service-capabilities) |

The setup checklist's `updatedAt` is the one timestamp the public view carries.

Datastores and externally managed products without `"public": true` do not appear in the
public view at all. `installed` is true only after activation is recorded, not while a
product is `activating`. Secrets, tokens and private keys are never stored.

## Lookup

Every response is JSON with `Cache-Control: no-store`. Paths are native; add the
`/api/registry` prefix through the ingress.

| Request | Returns |
| --- | --- |
| `GET /health/live` | `{"status":"live"}`. Not served by the ingress |
| `GET /health/ready` | `{"status":"ready","readOnly":false}` |
| `GET /v1/installation` | Installation summary, with the [setup checklist](#setup-checklist) once one is recorded |
| `GET /v1/products` | Catalog. `?installed=true` or `?installed=false` filters it; with a credential, `?capability=NAME` keeps the products offering that [service capability](#service-capabilities) |
| `GET /v1/products/{id}` | One product |
| `GET /v1/products/{id}/connection` | Console path, browser prefix, native API URLs, documentation and [capabilities](#capabilities); with a credential also the inventory host, internal endpoints and [service capabilities](#service-capabilities), which `?capability=NAME` narrows to one |
| `GET /v1/inventory` | The signed release's pins beside what each host reports. Read or write credential, or an administrator's Oathweave token; see [Inventory](#inventory) |
| `GET /v1/history?after=N&limit=M` | Append-only change history entries after sequence `N` (default 0), at most `M` entries (1 to 1000, default 200). Credential required; not served by the ingress |

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

## Capabilities

A product, and its connection, may carry an optional `capabilities` object that announces what
the installed product version serves to the browser. A product that offers none omits the field.

```json
{ "id": "magnus", "consolePath": "/fleet", "browserPrefix": "/api/magnus", "nativeApis": {}, "documentation": "https://github.com/ChefTaco/magnus/blob/HEAD/README.md", "capabilities": { "events.v1": { "path": "/hive/events" } } }
```

- `path` is relative to `browserPrefix` as the browser sees it, after the ingress mapping. It is
  not the product's native path. The browser fetches `browserPrefix + path`, here
  `/api/magnus/hive/events`, and the ingress maps that to the product's own route, here Magnus's
  `/api/v1/hive/events`. Each product's ingress mapping differs:

  | Product | `browserPrefix` | `events.v1` path | Browser URL | Ingress mapping | Native route |
  | --- | --- | --- | --- | --- | --- |
  | Magnus | `/api/magnus` | `/hive/events` | `/api/magnus/hive/events` | prefix replaced by `/api/v1` | `/api/v1/hive/events` |
  | Cindertrace | `/api/cindertrace` | `/hive/events` | `/api/cindertrace/hive/events` | prefix replaced by `/api/v1` | `/api/v1/hive/events` |
  | HiveSkills | `/api/hiveskills` | `/v1/hive/events` | `/api/hiveskills/v1/hive/events` | prefix stripped | `/v1/hive/events` |
  | Embermend | `/api/embermend` | `/api/v1/hive/events` | `/api/embermend/api/v1/hive/events` | prefix stripped | `/api/v1/hive/events` |
  | HiveMem (from 1.11.0) | `/api/hivemem` | `/hive/events` | `/api/hivemem/hive/events` | prefix replaced by `/v1` | `/v1/hive/events` |

- A capability needs a `browserPrefix`.
- Names match `[a-z0-9.-]{1,64}`, with at most 32 per product. Each value holds only `path`.
  Readers ignore names they do not know.
- `events.v1`: the product serves a HiveEvent v1 feed,
  `GET browserPrefix + path?after=CURSOR&limit=N`, with its normal user authentication.
- `inventory.v1` (the Hive Registry only, from 1.4.0): the registry serves its
  [inventory](#inventory) at `GET browserPrefix + path`, here `/api/registry/v1/inventory`.
- `audit.v1` (browser contract 5; Cindertrace from 0.10.0): the product serves its own audit as
  HiveAuditRecord v1 pages, `GET browserPrefix + path?after=CURSOR&limit=N`, with its normal user
  authentication. Cindertrace's path is `/audit/export`: `/api/cindertrace/audit/export` in the
  browser, `/api/v1/audit/export` natively.

The suite catalog (`scripts/suite/suite-catalog.json`) declares a capability per product with the
first product version that serves it, as `{"path": "...", "since": "X.Y.Z"}`; `"since": null`
declares a path whose product version is not released yet. `scripts/suite/suite-catalog.test.mjs`
checks every declared path against the ingress mappings in `deployment/Caddyfile`. A release
manifest carries `catalog.capabilities` (paths only) only for a component pinned at `since` or
newer, and `hive.sh`
records it with that product's connection, including an [external Magnus](../deployment/FULL.md#external-magnus).
An externally managed product may declare its own in `connection.capabilities`, beside its
`browserPrefix`.

The registry keeps capabilities in the stored connection, so no migration is involved: a
connection recorded before they existed reads back without the field and is not rewritten, and a
registry image from before them ignores a stored capability.

## Service capabilities

From Registry 1.5.0, a connection read with a credential may carry `serviceCapabilities` beside
`internalEndpoints`: what the product offers other products over those endpoints, such as Magnus
finding which Emberpath, HiveMem and HiveSkills it can use for Ardent. A product that offers none
omits the field. They are private like the internal endpoints, because `since` and `confirmed`
tell the product version apart; the public connection never carries them.

```json
{
  "id": "emberpath",
  "consolePath": null,
  "browserPrefix": "/api/emberpath",
  "nativeApis": { "model": "https://hive.example.com/v1" },
  "documentation": "https://github.com/ChefTaco/Emberpath/blob/HEAD/README.md",
  "inventoryHost": "control",
  "internalEndpoints": { "admin": "https://emberpath:9443", "model": "https://emberpath:4020" },
  "serviceCapabilities": [
    { "name": "emberpath.execution-trace.v1", "since": "2.6.0", "confirmed": true },
    { "name": "retry-signal.v1", "since": "2.6.0", "confirmed": true }
  ]
}
```

- `name` matches `[a-z0-9.-]{1,64}`; readers ignore names they do not know. `since` is the first
  product version that offers it.
- With a numeric recorded version (`X.Y.Z`), entries whose `since` is newer than it are left out.
- `confirmed: true`: the product is recorded as running that version, and it is `since` or newer.
  For a product this installation runs, that is once its status is `installed`: the sync that
  completes an install, upgrade, rollback or adoption, which `hive.sh` sends only after it observed
  the signed image running and healthy. An externally managed product with a `version` is
  confirmed as recorded.
- `confirmed: false` while the product is `activating`: `hive.sh` records the new version before
  it starts the products, so until the completion sync the product may still run its previous
  version, or none. A failed or held activation stays unconfirmed until a repeated command or a
  rollback completes; a completed rollback confirms the entries its version offers. Entries are
  listed as for the recorded version.
- `confirmed: false` also when the registry cannot tell the version, as for an
  [external Magnus](../deployment/FULL.md#external-magnus), an externally managed product without
  a `version` or a version such as `3.3.0-rc.1`. Every declared entry is listed.
- Unconfirmed, the reader compares `since` with the version the product itself reports (such as
  its health or version endpoint) before relying on it.
- An offered capability makes an endpoint available, nothing more. It never grants a permission or
  enables an integration: the existing credentials and enrollment steps still apply.

| Name | Product | Since | Meaning |
| --- | --- | --- | --- |
| `emberpath.execution-trace.v1` | Emberpath | 2.6.0 | Traces and attempts filtered by execution |
| `retry-signal.v1` | Emberpath | 2.6.0 | Emits the `x-hive-retry` header |
| `memory.v1` | HiveMem | 1.9.1 | The memory API |
| `skills.pinned-release.v1` | HiveSkills | 1.9.0 | The pinned skill archive route |
| `ardent.recovery.v1` | Magnus | 3.3.0 | The Ardent recovery API and execution checkpoints |
| `ardent.lineage.v1` | Magnus | 3.3.0 | The Ardent lineage API; accepts an execution context |
| `artifact-transfer.v2` | Magnus | 3.3.0 | Artifact transfer with renditions (descriptor v2) |

`?capability=NAME` needs a read or write credential (`401 credential_required` without one, `422
invalid_request` for a malformed name):

- `GET /v1/products/{id}/connection?capability=NAME` answers the connection with only that entry
  in `serviceCapabilities`, or `404` with code `capability_not_offered` when the product does not
  offer it (including a recorded version older than its `since`).
- `GET /v1/products?capability=NAME` lists only the products whose connection offers it, combined
  with `?installed=` when both are given. The list entries themselves do not carry
  `serviceCapabilities`; read each product's connection for them.
- An unconfirmed entry, such as one of an `activating` product, still counts as offered by both
  filters. Check its `confirmed` before relying on it.

The suite catalog (`scripts/suite/suite-catalog.json`) declares them per product as
`"serviceCapabilities": [{"name": "...", "since": "X.Y.Z"}]`, where `"since": null` declares one
whose product version is not released yet and is never emitted. Unlike browser capabilities, a
release manifest carries every released entry with its `since`, whatever version it pins, and
`hive.sh` records them with the product's connection, an external Magnus included. A release that
pins a registry before 1.5.0, which refuses the field, records none. An externally managed product
may declare its own in `connection.serviceCapabilities`, compared with its recorded `version`. They
are kept in the stored connection like capabilities, so no migration is involved.

## Setup checklist

The installation summary carries an optional `setup` object: the steps after an install or
upgrade that still need a person, such as installing the Magnus host agent or scheduling the
certificate renewal. HiveXUI shows it to administrators. A registry that never received a
checklist (from a controller or registry before 1.3.0) omits the field.

```json
{
  "schema": 1,
  "id": "example-suite",
  "products": ["hive-registry", "hivexui", "magnus", "oathweave"],
  "setup": {
    "items": [
      {
        "id": "magnus-agent-enrolled",
        "title": "Install the Magnus agent on the Magnus host",
        "status": "pending",
        "command": "./hive.sh magnus-agent install",
        "docs": "deployment/FULL.md#installing-the-agent",
        "product": "magnus",
        "check": "magnus.agent"
      }
    ],
    "updatedAt": "2026-11-12T18:00:00.000Z"
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | From the controller's fixed list (see [the setup checklist](../deployment/FULL.md#setup-checklist)), `[a-z][a-z0-9-]{0,63}`. Readers show an id they do not know generically |
| `title` | One line, at most 160 characters |
| `status` | `pending`, `done` or `skipped` |
| `command` | A `./hive.sh` line, or one of its scripts, to show and copy: plain words and options only, so no hostname, path, username or secret fits |
| `docs` | A repository-relative Markdown file with an optional anchor |
| `product` | Optional. The product the step belongs to |
| `check` | Optional. A readiness probe the browser can run itself: `magnus.agent`, `oathweave.console-client` or `iam.first-admin`. Readers ignore one they do not know |
| `updatedAt` | When the list last changed, RFC 3339 UTC. Set by the registry |

`hive.sh` sends the whole list with the install and upgrade sync (`"setup": {"items": [...]}`; the
registry sets `updatedAt`). A sync without `setup` keeps the recorded list, so every other
operation, and every controller from before the checklist, leaves it unchanged. `hive.sh` sends it
only to a registry from 1.3.0, which the release manifest pins; an earlier registry refuses
unknown fields. An operator, or `hive.sh post-upgrade`, settles one recorded item with
`PUT /v1/setup/items/{id}` and `{"status": "done"}` (or `skipped`, or `pending` again); an id that
is not recorded gets `404`. The browser never writes the checklist.

The registry keeps the checklist in its append-only history: each change records the whole list
as `{"before": [...], "after": {"items": [...]}}` under the subject `setup`, and the latest such
entry is the current list, its time the `updatedAt`. No table or column holds it, so the storage
format (`hive-registry-v1`) and the migrations are unchanged, an older registry image ignores it
after a rollback, and an installation recorded before it reads back unchanged.

## Inventory

From Registry 1.4.0, `GET /v1/inventory` puts what the signed release pins beside what the hosts
report they run, for HiveXUI's Installed software view. The registry announces it with the
`inventory.v1` [capability](#capabilities) (`{"path": "/v1/inventory"}`, declared in the suite
catalog from 1.4.0), so a console asks only a registry that serves it.

A person reads it with an Oathweave access token for the `hive-registry` audience that carries
`registry:inventory`: the console's `hivexui-registry` browser client, whose permission
`SUITE_ADMIN` holds. The registry verifies the token with `@hivemagnus/hive-common` against the
issuer, JWKS and userinfo URLs in `config/hive-registry/identity.json`, which `hive.sh` writes
beside the credentials on every install, upgrade, rollback, adoption and rehearsal, with the
installation's internal authority as `authority.pem` (the ingress's `backend-ca.pem`). Neither
file is a secret. Without `identity.json` (no Oathweave, or a registry provisioned before 1.4.0
that has not been upgraded) only the shared credentials read the inventory. A wrong audience,
signature or key gets `401`, a person without the permission `403`, and an unreachable Oathweave
`503`.

```json
{
  "schema": 1,
  "installationId": "example-suite",
  "release": { "version": "3.12.9", "manifestDigest": "<64 hex>" },
  "phase": "complete",
  "observedAt": "2026-11-20T10:00:00.000Z",
  "components": [
    { "id": "hivexui", "displayName": "HiveXUI", "kind": "static-ui", "source": "release", "status": "installed", "inventoryHost": "control",
      "pinned": { "version": "0.10.3", "image": "ghcr.io/example/hivexui@sha256:<64 hex>", "imageDigest": "sha256:<64 hex>" }, "recorded": null },
    { "id": "magnus", "displayName": "Magnus", "kind": "application", "source": "release", "status": "external", "inventoryHost": null,
      "pinned": { "version": "3.1.5", "image": "ghcr.io/example/magnus-server@sha256:<64 hex>", "imageDigest": "sha256:<64 hex>" }, "recorded": null }
  ],
  "hosts": [
    { "host": "control", "active": true, "unreachable": false, "receipt": { "version": "3.12.9", "digest": "<64 hex>" }, "transactionPhase": "complete",
      "catalog": [{ "id": "magnus", "version": "3.1.5", "image": "ghcr.io/example/magnus-server@sha256:<64 hex>" }],
      "services": [{ "service": "hivexui", "image": "ghcr.io/example/hivexui@sha256:<64 hex>", "runningImage": "ghcr.io/example/hivexui@sha256:<64 hex>",
        "imageId": "sha256:<64 hex>", "imageMatches": true, "state": "running", "health": "healthy" }] }
  ]
}
```

- `components`: every product of the release catalog, and every externally managed one.
  `status` is `installed`, `activating`, `external` (a release product used but run elsewhere,
  such as an external Magnus) or `not-installed`. `pinned` is the signed pin: what activation
  recorded for a product the installation runs, otherwise the pin in the active release's
  manifest as a host keeps it, or null. An externally managed product (`source: external`) has
  no pin; `recorded` is what its operator recorded.
- `hosts`: what `hive.sh` last observed on each host (`observedAt`): the activated release
  (`receipt`), the pins in the manifest that host keeps (`catalog`), and per service the
  deployed reference (`image`), the container's configured image (`runningImage`), the local
  image it runs (`imageId`) and `imageMatches`, true only when the container runs the deployed
  reference and its local image is that reference's image.
- It carries no origin, internal endpoint, plan digest or credential.

`hive.sh status`, `doctor`, and the completion of `install`, `upgrade`, `rollback` and `adopt`
send what they observe with `PUT /v1/observations` (write credential), to a registry that
announces `inventory.v1`. The body is `{"schema": 1, "hosts": [...]}` in the shape above and
replaces the whole set, so a host removed from the configuration disappears. The registry keeps
it in its append-only history under the subject `observations`, like the setup checklist, so the
storage format is unchanged and an older image ignores it after a rollback. An identical set
within an hour of the last one adds no history. A failed write, such as to a read-only rehearsal
copy, never fails the command; it prints a notice.

[`services/hive-registry/src/inventory-contract.ts`](../services/hive-registry/src/inventory-contract.ts)
describes the response with zod and nothing else, for HiveXUI to vendor like the browser
contract (`registryInventoryContractVersion`, now 1). It is separate because the browser
contract is the public view and must never carry versions or digests.

## Browser contract

[`services/hive-registry/src/browser-contract.ts`](../services/hive-registry/src/browser-contract.ts)
describes, with zod and nothing else, what an unauthenticated browser may read through
`/api/registry`. HiveXUI vendors it unchanged with its checksum; `registryBrowserContractVersion`
changes whenever its shape does. Its objects are not strict, so a field it does not name never
reaches the browser. The service's own tests parse every public response with it.

| Version | Registry | Adds |
| --- | --- | --- |
| 5 | 1.6.0 | The `audit.v1` capability, a product's own HiveAuditRecord v1 export |
| 4 | 1.4.0 | The `inventory.v1` capability, announcing the [inventory](#inventory) |
| 3 | 1.3.0 | The optional [setup checklist](#setup-checklist) on `GET /v1/installation` |
| 2 | 1.2.0 | Product [capabilities](#capabilities) |

## Ingress

Only `GET` passes, on `/health/ready`, `/v1/installation`, `/v1/inventory`, `/v1/products`,
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
| `PUT /v1/setup/items/{id}` | Records one [setup checklist](#setup-checklist) item's status: `{"status":"done"}`, `"skipped"` or `"pending"` |
| `PUT /v1/observations` | Replaces what the hosts were observed to run, for the [inventory](#inventory). Does not change the installation revision |

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
