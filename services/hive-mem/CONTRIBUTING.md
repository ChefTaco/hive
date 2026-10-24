# Contributing to HiveMem

Thanks for your interest in improving HiveMem.

This project is a standalone shared memory service for agents and integrations. The best contributions are small, well-tested, and easy to review.

## Before you start

- Read [README.md](README.md) for the quick start.
- Read [APP_ARCHITECTURE.md](APP_ARCHITECTURE.md) if your change touches routing, storage, reasoning, or auth.
- Read [SECURITY.md](SECURITY.md) before reporting security-sensitive issues.

## Development setup

```bash
# Start Qdrant
docker compose -f docker/docker-compose.yml up -d qdrant

# Install TypeScript core dependencies
npm --prefix ts-core install

# Configure local env
cp .env.example .env
# Set HIVEMEM_JWT_SECRET before starting the app

# Run the production TypeScript core in dev mode
HIVEMEM_JWT_SECRET=<local-secret> HIVEMEM_TS_PERSISTENCE=qdrant npm --prefix ts-core run dev
```

## Test commands

Run the smallest relevant test set first, then expand if needed.

```bash
# TypeScript production core
npm --prefix ts-core run typecheck
npm --prefix ts-core test
npm run test:dual-stack

# Hermes plugin tests
python -m pytest hermes-plugin/tests -v

# TypeScript SDK
npm --prefix sdks/typescript install
npm --prefix sdks/typescript test

```

Notes for sandboxed agent environments:

- Integration tests talk to Qdrant on `localhost:6333`; start Qdrant first and run those tests with localhost network access.
- If pip reports an unwritable cache inside a sandbox, use `PIP_CACHE_DIR=/tmp/pip-cache` for install/show commands or ignore the warning when no install is being performed.
- Git staging/committing writes under `.git`; restrictive filesystem sandboxes may require explicit approval for `git add` and `git commit`.

## Coding guidelines

### TypeScript core

- Target Node 24+ and strict TypeScript.
- Keep REST/dashboard compatibility behavior covered in `ts-core/tests`.
- Prefer shared store/auth/persistence helpers over adding route-local special cases.
- Make focused changes; avoid unrelated refactors in the same patch.

### Python surfaces

- Python remains active for the Hermes plugin, SDK, and small REST helper scripts.
- Do not add a second HiveMem service runtime; production runtime changes belong in `ts-core/`.
- Preserve existing Python style unless there is a clear readability win.

### API and auth rules

- **Never** trust `agent_id` from request bodies for ownership decisions.
- Always derive caller identity from the validated JWT `sub` claim.
- Keep `/v1/memories/search` and `/v1/memories/browse` behavior distinct from `/v1/memories/{memory_id}`.
- Keep embeddings server-side. Clients should send plain text by default.

### Docs and examples

- Treat HiveMem as a public open-source project.
- Use generic examples such as `https://hivemem.example.com`, `agent-alpha`, and `admin`.
- Do not add internal hostnames, real tokens, private usernames, or deployment-specific secrets.

## Pull requests

A good pull request usually includes:

- A short explanation of the change and why it matters.
- Tests for behavior changes.
- Documentation updates when commands, env vars, or public behavior change.
- Clean diffs without unrelated formatting churn.

If your change affects users or operators, add an entry to [CHANGELOG.md](CHANGELOG.md).

## Security reports

Please do **not** file public issues for vulnerabilities. Follow the reporting guidance in [SECURITY.md](SECURITY.md).
