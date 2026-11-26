# Agent Instructions

This repository is the **Hive suite controller**: `hive.sh` installs and manages the Hive:Magnus
products (Oathweave, Emberpath, HiveMem, HiveSkills, HiveXUI, Magnus and the others) from signed
release manifests. It holds no product code; each product lives in its own repository and is
pinned here by image digest. See [docs/HIVE_ARCHITECTURE.md](docs/HIVE_ARCHITECTURE.md).

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
| `pre-commit` | `scripts/check-private-data.sh --staged` (forbidden files and private terms), `scripts/scan-secrets.sh` and `scripts/gitleaks.sh --staged` |
| `commit-msg` | private terms in the commit message |
| `pre-push` | private data in all tracked files, Gitleaks over every outgoing commit range, and private terms in their messages |

The Gitleaks hooks need the pinned CLI: `bash scripts/install-gitleaks.sh` (see
[CONTRIBUTING.md](CONTRIBUTING.md#secret-scanning)). A missing binary fails the hook.

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
| `hive.sh` | The suite controller's entry point |
| `scripts/suite` | The controller (`controller.sh`, `lifecycle.sh`, the host scripts it runs over SSH), the release contracts and catalog, and their tests and round trips |
| `scripts/release` | Suite manifest build, release checks and image scans |
| `scripts/` | Host preparation (`install-prerequisites.sh`, `console-certificate.sh`, `prepare-terminal.sh`) and repository checks (secret and private-data scans, CI helpers) |
| `releases/`, `trust/` | Signed suite release manifests, their signatures and inputs, and the publisher key |
| `deployment/` | The ingress and datastore images, the Caddyfile, `images.json`, and the deployment guides |
| `services/hive-registry` | Hive Registry: the mandatory install catalog and lookup API of one installation, written by `hive.sh`. Not the Skills registry |
| `examples/` | Installation JSON example and schemas |
| `docs/` | Architecture, release process, Registry API and runbooks; `docs/acceptance/` holds dated release evidence (JSON) |
| `.github/workflows/` | `hive-ci.yml` (gates on Node 24 and 26), `recovery.yml` (backup and restore acceptance, see [docs/ci-recovery.md](docs/ci-recovery.md)), `suite-release.yml` (suite images and tagged releases), `image-rescan.yml` (daily re-scan of the newest published release), `release-upgrade.yml` (real-image install-upgrade-rollback round trip into a release from the one before it; called by `suite-release.yml` after publishing, and weekly), `gitleaks.yml` |
| `README.md`, `UPGRADING.md`, `CHANGELOG.md` | Install overview, per-release upgrade notes (newest first) and the change log |

The products (Oathweave, Emberpath, HiveMem, HiveSkills, HiveXUI, Magnus and the others) live in
their own repositories. The retired npm 1.x packages remain at the `v1.2.2` tag. Install the
Registry's dependencies and the git hooks with `npm run bootstrap`.

## Engineering conventions

- Match the style of the file you are editing. Controller code is strict Bash (`set -Eeuo pipefail`)
  and the Hive Registry is strict TypeScript.
- Add or update tests with every behaviour change. Security-relevant fixes need a regression test.
- Changing a file listed in `hive_runtime_files` (`scripts/suite/controller.sh`) changes the
  controller digest that the next signed release pins.
- Note user-facing changes in `CHANGELOG.md`, and upgrade steps in a new `UPGRADING.md` section.
- Signed release files (`releases/X.Y.Z.json`, `.json.sig`, `.inputs.json`) are immutable once
  committed. Never edit or reformat them.
- Use Conventional Commits (`feat:`, `fix(suite):`, `docs:` and so on).

## Fresh-install end-to-end testing

- Test the user entry point on the fresh target host: run `./hive.sh --release latest` (or an
  explicitly selected signed release) in a real interactive terminal as the intended operator.
  An SSH session with a PTY is fine. Follow [the guided setup](deployment/QUICKSTART.md#guided-local-setup).
- Let the installer offer and perform prerequisite installation, Docker group activation,
  installation-directory creation, HTTPS certificate setup and renewal, optional terminal
  account/key preparation, and Magnus host-agent installation. When the agent needs Node.js,
  exercise the installer's Node.js installation path too. Do not install these beforehand or
  invoke the preparation helpers separately to make the end-to-end run pass.
- Start with only the access/bootstrap requirements needed to reach and launch the installer
  (such as SSH, a sudo-capable account and Git). Tailscale is optional and its installation/login
  is external to Hive; automatic certificate setup requires an existing eligible Tailscale
  connection. For other HTTPS sources, supply the certificate and key as documented. Record
  pre-existing dependencies so they are not mistaken for installer coverage.
- A saved `--config`, `--non-interactive`, or custom manifest/signature/trust-key arguments bypass
  guided preparation. Test those paths separately; they do not replace a fresh interactive run.
  If setup fails, retain its protected evidence, fix the installer, and repeat the affected path
  on a fresh lab baseline when authorized. Do not conceal a failure with manual preparation.
- Verify the resulting browser sign-in, selected products and Magnus node workflows, including
  the setup checklist. Keep credentials and private transcripts outside tracked files. Report
  which setup steps the installer actually performed and any steps that remain untested.

## Gates

Use Node.js from `.nvmrc` (`nvm use`; the engines allow `^24.22.3 || ^26.13.1`), Python 3, jq and
ripgrep. Run these before every commit or pull request:

```bash
npm run typecheck
npm test               # also runs check:release-docs (see below)
npm run scan:secrets
npm run check:private
```

CI also runs `npm run build`, `npm run scripts:check`, `npm run tls:check`,
`npm run audit:production` and the ingress round trips (`npm run test:suite:ingress`, which needs
Docker). The `test:suite:*` round trips are slower and need Docker; run the ones your change
touches.

## Releases and known gotchas

- A suite release is a signed manifest, built and checked as [docs/RELEASING.md](docs/RELEASING.md)
  describes. Signing happens offline with the maintainer's key: do not tag, publish images or
  create releases unless the maintainer asks.
- `npm run check:release-docs` requires the install examples in `README.md`,
  `deployment/README.md` and `deployment/QUICKSTART.md` to name the newest release in `releases/`.
  A release commit updates them.
- Changing any file in `hive_runtime_files` (including `hive.sh` and the `--help` text in
  `scripts/suite/controller.sh`) changes the controller digest; the published manifests stay
  verifiable only from their own tags.
- The recovery CI job uses the small corpus only for pull requests that change nothing but prose
  (root Markdown, `docs/**/*.md`, `deployment/*.md`); any other change runs the full corpus and
  takes longer.
- `npm run test:suite` runs the commands listed in `scripts/test-suite.json` in parallel
  (`HIVE_TEST_JOBS`, default 4) and lists every failure at the end. Add a new controller test
  there; `node scripts/run-tests.mjs suite NAME` runs the matching entries only.
