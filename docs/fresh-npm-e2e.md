# Fresh public npm full-stack verification

`npm run test:e2e:fresh` installs a public Hive release in a new temporary home,
starts IAM, HiveMem, Router and Skills, and tests a real OpenAI-compatible model
provider. It does not reuse an existing Hive installation, deployment credentials,
signing keys, Redis namespace, Qdrant collection or Hermes profile.

## Prerequisites

- Node `^24.22.3 || ^26.13.1`, npm, OpenSSL and a POSIX host.
- A running Docker daemon whose published loopback ports are reachable locally.
  The command starts dedicated `qdrant/qdrant:v1.18.1` and `redis:7.4.7-alpine`
  containers; Docker may download these images if they are absent.
- Repository test dependencies installed with `npm run bootstrap`.
- Access to public npm and a reachable OpenAI-compatible model provider.

The server processes run locally and must be able to reach the provider. For Qwen
served through llama.cpp, use `LLAMACPP` and the exact ID advertised by the
provider's `/v1/models` endpoint. No model or private host is selected implicitly.
Inference sends only newly generated synthetic facts to that provider.

## Run

```bash
export HIVE_E2E_PROVIDER_URL=http://client.example.com:8000
export HIVE_E2E_MODEL=your-model-id
export HIVE_E2E_PROVIDER_KIND=LLAMACPP
export HIVE_FRESH_VERSION=1.2.2
npm run test:e2e:fresh
```

Alternatively, save those settings in an ignored, owner-only file:

```bash
chmod 600 .env.fresh-e2e
npm run test:e2e:fresh -- --env-file .env.fresh-e2e
```

Exported values override values in the explicitly selected file. The command
never discovers or loads repository `.env` or deployment files automatically.
Existing `HIVE_HOME`, server URLs, operator passwords, Memory tokens and
`HIVE_INSTALL_FROM` values are ignored. Fresh credentials and a one-hour Memory
test token are created inside the temporary installation.

| Variable | Purpose |
| --- | --- |
| `HIVE_E2E_PROVIDER_URL`, `HIVE_E2E_MODEL` | Required provider URL and exact model ID |
| `HIVE_E2E_PROVIDER_KIND` | `LLAMACPP` by default; also `OPENAI_GENERIC`, `OPENAI`, `OPENROUTER`, `VLLM` |
| `HIVE_E2E_PROVIDER_AUTH_MODE` | `NONE` by default; also `BEARER`, `API_KEY`, `HEADER` |
| `HIVE_E2E_PROVIDER_TOKEN` | Required for authenticated providers; never written to the report |
| `HIVE_E2E_PROVIDER_AUTH_HEADER` | `Authorization` by default; `API_KEY` uses `x-api-key` |
| `HIVE_E2E_TIMEOUT_MS` | Per model-suite request timeout, default `90000`, range `1000`–`300000` |
| `HIVE_E2E_MAX_TOKENS` | Per inference reasoning/output budget, default `512`, range `64`–`4096` |
| `HIVE_FRESH_VERSION` | Exact stable public launcher release; defaults to the repository's version |
| `HIVE_FRESH_REPORT_PATH` | New private report file; defaults to `output/fresh-npm-e2e/<random-id>.json` |
| `NODE_EXTRA_CA_CERTS` | Optional provider CA bundle, combined with the disposable installation's generated CA |

The selected launcher release manifest supplies exact server and tested Memory SDK
pins. All application servers and the Memory SDK come from public npm; no packed
working-tree server artifacts are used. The checked-out test harness supplies the
assertions. A repository version that has not been published must be overridden
with an existing public `HIVE_FRESH_VERSION`. Exact pins remain subject to npm's
normal package integrity checks and the launcher's managed-install validation.

TLS verification stays enabled. Credentialed provider URLs require HTTPS outside
loopback. Use the CA setting above for private certificates.

## Checks and cleanup

The command verifies all four services' readiness and running versions, then uses
the [real-model suite](model-e2e.md) with the published Memory SDK. It checks IAM
authentication/proxies, model discovery, a fact unavailable without memory,
isolated retrieval and citations, ordinary recall, incremental SSE recall, clean
stream completion, provider-bound traces, expired-key rejection and test-resource
cleanup. It creates a temporary provider registration and alias in the disposable
Router; it does not alter the upstream model server's configuration.

Skills checks cover HTTPS discovery, catalog and manifest, archive SHA-256,
unauthenticated admin/unenrolled-target denial, and the packaged bridge installing
into a disposable Hermes profile. A restart callback verifies replay behavior;
the test does not restart any real Hermes installation or authenticate a real OS
account through PAM. After restarting the entire stack it checks readiness and
Skills catalog/archive persistence again.

Background upgrades, update notices, UI upgrades and the Compose supervisor are
disabled. Auto-migration remains enabled only for the disposable managed install's
first-start initialization and restart checks; it uses the release's normal
backup and migration behavior. No systemd units or timers are registered.

Cleanup runs after success, failure, SIGINT and SIGTERM. It stops the launcher and
its service process group, removes only this run's containers and their anonymous
volumes, verifies that its allocated ports have closed, and deletes the temporary
home, npm cache, databases, keys, logs and Hermes profile. Existing Docker images
are retained. Every resource gets a cleanup attempt even if another removal
fails. Cleanup failure makes the command fail. SIGKILL, machine failure or a lost
Docker daemon cannot guarantee immediate cleanup; inspect the private receipt
for owned resources and failed cleanup steps before removing them manually.

Only a credential-free private JSON receipt remains (`0600`, new report directory
`0700`), including checks, streaming counts, package versions and cleanup results.
Existing report files are never overwritten. Reports contain operational resource
IDs and should remain ignored. Exit codes are `0` for a complete pass, `1` for a
test or cleanup failure, `2` for invalid configuration/preflight setup, and
`130`/`143` after handled SIGINT/SIGTERM cleanup.

The command is opt-in and is not part of `npm test`. Network-free regression tests
for configuration isolation, bounded subprocesses and cleanup run in `test:audit`.
