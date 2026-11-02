# Real-model end-to-end verification

For a disposable public npm installation of all four services, including Skills,
use [`npm run test:e2e:fresh`](fresh-npm-e2e.md). It supplies fresh credentials,
runs this suite with the published Memory SDK and removes the installation afterward.

Run `npm run test:e2e:model` against a running Hive stack and an OpenAI-compatible model provider.
The command verifies model discovery, ordinary inference, incremental streaming, and private
memory recall through the TypeScript SDK. It also checks IAM/Memory integration, successful
provider-bound traces, expired-key rejection, and post-test health.

The suite is opt-in: `npm test` runs its network-free regression tests, without contacting a model
or a live installation. The live command makes three bounded inference requests, sequentially.
Use a test installation where possible: it temporarily adds registry records and writes synthetic
memories. No service configuration, signing keys or existing memories are changed.

## Setup

Use the repository's supported Node version and install dependencies once:

```bash
npm run bootstrap
```

For an existing checkout whose dependencies are otherwise installed, install the SDK build tool once:

```bash
npm --prefix services/hive-mem/sdks/typescript ci
```

The command builds the checked-out Memory SDK before testing. It needs Router 1.0.3 or later
(including enforcement of client-key metadata expiry), a running IAM and HiveMem, and a provider
with OpenAI-compatible `/v1/models` and `/v1/chat/completions` endpoints, including SSE streaming.
The **Router host** must be able to reach the provider URL; the test client must reach the three
configured Hive endpoints.

Supply an existing Router operator login authorized to read stack status, IAM users, Memory,
providers, keys, routing and traces, and to create/delete providers, keys and model aliases. Supply
an existing Memory token whose identity can create a fresh workspace and create/read/delete its
private memories. The token needs `workspaces:read`, `workspaces:write`, `memories:read`,
`memories:write` and `context:read`; a token restricted to a fixed workspace list cannot create the
random test workspace. The command never mints or expands a Memory token.

## Configuration

Set the variables in the environment, or save them in a gitignored, owner-only file such as
`.env.model-e2e`. Example values below are placeholders; use your own endpoints and credentials.
Do not commit the populated file.

```dotenv
HIVE_E2E_ADMIN_URL=https://hive.example.com
HIVE_E2E_API_URL=https://hive.example.com:4020
HIVE_E2E_MEMORY_URL=https://memory.example.com:18443
HIVE_E2E_USERNAME=admin
HIVE_E2E_PASSWORD=replace-with-operator-password
HIVE_E2E_MEMORY_TOKEN=replace-with-existing-memory-token

HIVE_E2E_PROVIDER_KIND=LLAMACPP
HIVE_E2E_PROVIDER_URL=http://client.example.com:8000
HIVE_E2E_MODEL=your-model-id
```

Obtain the exact model ID from the provider's `/v1/models` response. Qwen served by llama.cpp uses
`LLAMACPP`; the suite allows its reasoning tokens before the final answer. No hostname, model ID,
external service or credential is selected automatically.

| Variable | Default / purpose |
| --- | --- |
| `HIVE_E2E_ADMIN_URL`, `HIVE_E2E_API_URL`, `HIVE_E2E_MEMORY_URL` | Required base URLs; no embedded credentials, query or fragment |
| `HIVE_E2E_USERNAME`, `HIVE_E2E_PASSWORD` | Required existing Router operator login |
| `HIVE_E2E_MEMORY_TOKEN` | Required existing Memory token |
| `HIVE_E2E_PROVIDER_URL`, `HIVE_E2E_MODEL` | Required provider base URL and exact upstream model ID |
| `HIVE_E2E_PROVIDER_KIND` | `LLAMACPP`; also supports `OPENAI_GENERIC`, `OPENAI`, `OPENROUTER`, `VLLM` |
| `HIVE_E2E_PROVIDER_AUTH_MODE` | `NONE`; use `BEARER`, `API_KEY` or `HEADER` for authenticated providers |
| `HIVE_E2E_PROVIDER_TOKEN` | Required when provider authentication is enabled; never logged |
| `HIVE_E2E_PROVIDER_AUTH_HEADER` | `Authorization`; used by `HEADER`/`BEARER` modes (`API_KEY` uses `x-api-key`) |
| `HIVE_E2E_TIMEOUT_MS` | `90000` per request, including streamed bodies; range 1000–300000 |
| `HIVE_E2E_MAX_TOKENS` | `512` per inference; range 64–4096, including model reasoning |
| `HIVE_E2E_REPORT_PATH` | New file under `output/model-e2e/` by default; existing files are never overwritten |

Credentialed Hive URLs must use HTTPS outside loopback. An unauthenticated local provider may use
HTTP. Authenticated provider URLs also require HTTPS outside loopback. TLS verification stays on.
For private certificates, set `NODE_EXTRA_CA_CERTS` **before launching npm** to a PEM bundle of the
required issuing CAs or trusted server certificates:

```bash
chmod 600 .env.model-e2e
NODE_EXTRA_CA_CERTS=/opt/hive/test-ca-bundle.pem \
  npm run test:e2e:model -- --env-file .env.model-e2e
```

With certificates already trusted, omit `NODE_EXTRA_CA_CERTS`. With all variables already exported,
run `npm run test:e2e:model` directly. Exported environment values override values in `--env-file`.
Run the command separately with each installation's own settings when verifying multiple stacks.

## Results and cleanup

The command prints `PASS`/`FAIL` checks and the private report location. Exit codes are:

- `0`: all checks and cleanup passed.
- `1`: verification, cleanup or report writing failed.
- `2`: invalid configuration/arguments, unreadable environment file, or an existing/unwritable report.
- `130` / `143`: interrupted by SIGINT / SIGTERM, after attempted cleanup.

Each run creates a unique workspace, provider registration, provider-bound model alias and scoped
inference key (one-hour expiry and request/token quotas), plus an already-expired probe key. The
alias prevents test requests from falling back to a different provider. The temporary provider has
low routing priority. Only a newly generated synthetic fact is sent to the model: it must answer
`UNKNOWN` without memory and return the exact stored random code after SDK retrieval, in both
ordinary and streamed responses. Context isolation is checked before recalled content is sent.

Cleanup runs on success, failure and handled interruption. It reconciles resources by the exact
unique run label, including a provider creation whose response was lost. It deletes temporary
keys, aliases and providers, soft-deletes synthetic memories/workspace, confirms their absence,
checks service health, and logs out. Existing resources and audit/trace history are retained.
Cleanup failure makes the command fail. Do not start concurrent runs with the same report path.

Reports are atomically checkpointed with mode `0600`; newly created output directories use `0700`.
They contain checks, timings, request/trace IDs and temporary resource IDs/labels, without passwords,
tokens, upstream response bodies or existing memories. Treat reports as private operational data.
If the process is forcibly killed or an endpoint remains unreachable, inspect the report's resource
IDs and unique label, restore connectivity, and remove only those resources through the console or
APIs. SIGKILL and machine failure cannot run cleanup.

A failed generation may indicate model behavior or an insufficient reasoning budget, while a
non-200 response may indicate provider reachability, permissions, certificate trust or service
configuration. The private report identifies the failing operation and HTTP status without echoing
sensitive response text. Correct the cause and rerun with a new report path; the suite never
silently changes providers or weakens authentication/TLS.
