# @hivemem/contracts

Typed contracts for the [Hive](https://github.com/ChefTaco/hive) services: Zod schemas, TypeScript
types, and small fetch-based clients for Hive IAM, HiveMem, and the Hive Router.

- ESM only, ships TypeScript declarations
- One runtime dependency: [`zod`](https://zod.dev)
- Works in Node.js 24+ and any runtime with a global `fetch`

## Install

```sh
npm install @hivemem/contracts
```

## Usage

### Service clients

```ts
import { createIamServiceClient, createMemoryServiceClient } from '@hivemem/contracts';

const iam = createIamServiceClient({
  baseUrl: 'https://hive.example.com:4200',
  bearerToken: process.env.HIVE_IAM_TOKEN,
});
const { users } = await iam.users(25);

const memory = createMemoryServiceClient({
  baseUrl: 'https://memory.example.com:18443',
  bearerToken: process.env.HIVEMEM_TOKEN,
});
const results = await memory.search({ query: 'deployment checklist', limit: 5 });
```

Every response is validated with Zod; a schema mismatch or non-2xx response throws. Pass a custom
`fetch` (for example one configured with a private CA) through the `fetch` option.

### Health and status payloads

```ts
import { parseHiveStatusResponse, parseIamHealthPayload, normalizeIamHealthPayload } from '@hivemem/contracts';

const status = parseHiveStatusResponse(await (await fetch('https://hive.example.com/api/hive/status')).json());
```

### Service manifest

`@hivemem/contracts/service-manifest` describes the deployed services (systemd units, ports, required
env keys, health endpoints, backup paths). Host targets are resolved from configuration:

```ts
import { resolveHiveHosts, hiveServicesForHost, renderHiveEndpoint } from '@hivemem/contracts/service-manifest';

// HIVE_HOSTS="hive:hive.example.com:skills,memory-host:memory.example.com"
for (const target of resolveHiveHosts(process.env)) {
  for (const service of hiveServicesForHost(target)) {
    for (const endpoint of service.healthEndpoints) console.log(renderHiveEndpoint(endpoint.urlTemplate, target));
  }
}
```

Without `HIVE_HOSTS`, the example topology (`hive.example.com`, `memory.example.com`) is returned.

## Entry points

| Import path | Contents |
|---|---|
| `@hivemem/contracts` | Everything below except the Node-only health probes. Safe to use in browsers. |
| `@hivemem/contracts/service-health` | Hive status and IAM/HiveMem health schemas, plus the Node-only `requestServiceHealth`, `requestIamHealth` and `requestMemoryHealth` probes |
| `@hivemem/contracts/service-clients` | `createIamServiceClient`, `createMemoryServiceClient` |
| `@hivemem/contracts/service-manifest` | Service manifest and host resolution helpers |
| `@hivemem/contracts/memory-operations` | HiveMem write/operation schemas |
| `@hivemem/contracts/ui-api` | Request/response types generated from the Hive IAM OpenAPI spec |

## Development

This package lives in the Hive monorepo under `packages/hive-contracts`.

```sh
npm install
npm test        # verifies generated types, builds, and runs the tests
```

`src/ui-api.generated.ts` is generated from the Hive IAM OpenAPI spec in the monorepo; regenerate it
with `npm run generate:ui`.

## License

Apache-2.0
