# Agent Instructions

These instructions apply to AI coding agents (Claude Code, Codex, Copilot and others) and to human
contributors. This is a **public repository**: everything committed, including commit messages, is
published.

## Local context

If an `AGENTS.local.md` exists in the repository root or in the directory you are working in, read it
too. It holds the maintainer's private operational context, such as hosts and deployment notes.
**Never commit it, quote it, or copy its contents into tracked files or commit messages.** The same
applies to `CLAUDE.local.md`.

## Privacy and secrets: hard rules

1. **Never commit secrets.** This includes `.env` and `.env.*` (except `.env.example`), `.npmrc`,
   private keys, certificates, `certs/`, databases (`*.db`, `*.sqlite`), backups, `.hive-dev/`,
   tokens, passwords, and API keys. Each of these is already covered by `.gitignore`. Never force-add
   them (`git add -f`).
2. **Never commit private infrastructure details.** This includes real hostnames, private network
   domains (for example Tailscale MagicDNS names), IP addresses of real machines, SSH users, home
   directory paths (`/home/<user>`), TLS fingerprints of real hosts, account IDs, and personal email
   addresses. Use placeholders instead:
   - hosts: `hive.example.com`, `memory.example.com`, `client.example.com`
   - IPs: the documentation ranges `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`, or RFC 1918
     addresses in tests
   - users: `admin` for application logins, `deploy` for SSH
   - paths: `/opt/<service>`, `~`, `$HOME`
3. **Configuration comes from the environment.** Scripts and code read hosts, users, and secrets
   from environment variables. They never ship personal defaults or fallback secret values. A
   required secret that is missing must fail fast. Generating a strong random secret on first
   install is fine.
4. **Keep commit messages and PR text generic.** Describe what changed in the code. Don't mention
   private machines, private projects, customers, or internal program names.
5. **Test fixtures use fake data only**, such as `example.com`, `alice@example.com`, and obviously fake
   tokens. Never use values copied from a real environment, even expired ones.
6. **When in doubt, leave it out** and ask the maintainer.

## Enforcement

Run `npm run hooks:install` once per clone (`npm run bootstrap` does it for you). The hooks in
`.githooks/` run on every commit and push:

| Hook | Checks |
|---|---|
| `pre-commit` | `scripts/check-private-data.sh --staged` (forbidden files and private terms) and `scripts/scan-secrets.sh` |
| `commit-msg` | private terms in the commit message |
| `pre-push` | all tracked files, plus the messages of every outgoing commit |

Private terms come from an optional, gitignored `.private-terms` file in the repository root. It
holds one case-insensitive extended regex per line, such as personal hostnames, private domains, or
usernames, so the denylist itself is never published. CI runs `npm run scan:secrets` and
`npm run check:private` on every push and pull request.

**Never bypass the hooks** (`--no-verify`) or edit them to make a commit pass. If a check fails,
remove or genericize the data. If the check itself is wrong, fix the check in a separate, reviewed
change.

## Repository layout

| Path | Contents |
|---|---|
| `services/hive-router` | OpenAI-compatible model gateway, admin API, and the unified console (React/Vite in `ui/`). `src/contracts` holds the Zod schemas the Router and console share with IAM and HiveMem |
| `services/hive-iam` | IAM Core (`apps/iam-core`) and `@hivemagnus/hive-iam-sdk` (`packages/iam-sdk`, published to npm) |
| `services/hive-mem` | HiveMem TypeScript core (`ts-core`), SDKs (`sdks/typescript` is `@hivemagnus/hivemem-sdk`), and the Python Hermes plugin |
| `services/hive-skills` | Skills registry for Hermes Agent |
| `packages/hive` | `@hivemagnus/hive`, the `hive` launcher CLI that installs, configures and runs the three servers (published to npm, no runtime dependencies) |
| `scripts/` | Deploy, backup, audit, and repository check tooling. `scripts/lib/service-manifest.ts` describes the deployed services |
| `docs/` | Architecture, runbooks, and OpenAPI snapshots |

Each workspace has its own `package-lock.json`. Install them all with `npm run bootstrap`.

## Engineering conventions

- TypeScript is strict everywhere. Match the style of the file you are editing.
- Use Zod 4 for runtime validation. Request and response shapes the Router and console share with
  IAM and HiveMem belong in `services/hive-router/src/contracts`.
- Add or update tests with every behaviour change. Security-relevant fixes need a regression test.
- After changing routes or schemas, run `npm run generate:openapi`. After changing IAM request
  schemas, run `npm --prefix services/hive-router run contracts:generate`.
- Published packages follow semver. Note user-facing changes in `CHANGELOG.md`.
- Use Conventional Commits (`feat:`, `fix(router):`, `docs:` and so on).

## Gates

Run these before every commit or pull request:

```bash
npm run typecheck
npm test
npm run check:openapi
npm run scan:secrets
npm run check:private
```
