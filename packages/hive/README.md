# @hivemagnus/hive

The Hive launcher. One command installs, configures and runs Hive Router, IAM, HiveMem and optional Hive Skills on your machine.

[Hive](https://github.com/ChefTaco/hive) is a self-hosted control plane for AI agents. It gives a
fleet of agents a shared identity provider (**Hive IAM**), long-term memory (**HiveMem**) and an
OpenAI-compatible model gateway (**Hive Router**), and you manage all three from one web console
that the Router serves.

## Requirements

- Linux or macOS
- Node.js 24 (24.22.1 or later) or Node.js 26 (26.13.0 or later), with npm
- `openssl`, to create the local TLS certificates (or use `--no-tls` for plain HTTP on 127.0.0.1)
- Docker (optional). `hive init` uses it to run Qdrant (for HiveMem) and Redis (for IAM) when they
  are not already running. Without Docker, install them yourself and `hive init` prints what to run.
- For HiveMem: the `flock` command. Linux has it in util-linux; on macOS run `brew install flock`.
- For the Router without IAM: Linux with `pamtester`, so you can sign in with your OS account.
  With IAM, sign-in goes through IAM and works on both Linux and macOS.

## Quick start

```bash
npx @hivemagnus/hive init     # choose services, install them, write the configuration
npx @hivemagnus/hive start    # run them in the foreground; Ctrl-C stops them
```

To get a `hive` command instead of `npx`, install the launcher globally:

```bash
npm install -g @hivemagnus/hive
hive init
hive start
```

The Router and IAM servers use native add-ons (`better-sqlite3`, `argon2`) whose install scripts
npm 12 blocks by default. `hive` installs the servers into `~/.hive/runtime` with those two
allowed in its `package.json`, and `hive doctor` checks that they load.

`hive init` explains each step and asks before it installs anything, starts a Docker container or
changes an existing file. Press Enter to take the default answer. In scripts, `hive init --yes`
takes every default without asking. Without `--yes`, `init` refuses to run when standard input is
not a terminal instead of waiting for an answer.

When `hive start` reports `Hive is running`, open the console URL it prints, by default
`https://localhost:9443/`.

## Include Hive Skills

The default setup remains Memory, Router and IAM. Include the optional HTTPS Skills registry with:

```bash
hive init --services all --yes
hive start
```

Use `hive init --services skills` for a new Skills-only installation. Choose the complete
service set at enrollment: an enrolled inventory is fixed, and `init` will not modify an
active release to add components. Use a separate `HIVE_HOME` for additional services.
`hive start skills`, `hive status` and `hive doctor` support configured Skills services.
`--port skills=4030` chooses its port. Skills requires TLS, so a new Skills setup rejects
`--no-tls` before installing packages or writing configuration.

Skills uses the launcher's local certificate, a generated session secret and
`$HIVE_HOME/skills` for SQLite and archives. The Router's Skills panel is wired automatically;
server processes trust the local CA, while preserving any explicitly supplied
`NODE_EXTRA_CA_CERTS`. With `--hostname`, Skills also binds on all interfaces and its public
URL uses that hostname. Otherwise it stays on loopback.

Skills administration uses your **local OS account and password through PAM**, independently
of IAM's generated `admin` account. Install `pamtester` on Linux (for example
`sudo apt install pamtester`). The launcher writes the current OS account to
`HIVE_SKILLS_ADMIN_USERS` and selects the standard `login` PAM policy. A container or OS
account without a password needs an appropriate PAM/login configuration before sign-in works.
Edit the private `config/skills.env` to change the admin allowlist or PAM policy. macOS does
not provide this Linux PAM administration flow.

The registry starts empty. Explicitly seed the bundled HiveMem skill only on a new registry:

```bash
~/.hive/runtime/node_modules/.bin/hive-skills seed --env-file ~/.hive/config/skills.env
```

The launcher does not seed, configure agent targets or change any Hermes profile automatically.
Existing Skills configuration and secrets are kept on reruns. Restart the configured stack
after explicitly changing its configuration.

## Signing in the first time

With IAM (the default), IAM creates the first administrator, `admin`, on its first start. It
generates the password and writes it to `~/.hive/iam/initial-credentials.env` (mode `0600`). It
never prints the password.

1. Run `hive start` and wait for `Hive is running`.
2. Read the password: `cat ~/.hive/iam/initial-credentials.env`.
3. Open the console and sign in as `admin` with that password.
4. Change the password, then delete `initial-credentials.env`.

The certificates come from a local CA that `hive init` creates, so your browser warns about the
certificate the first time. Accept the warning, or trust `~/.hive/tls/ca.crt` in your browser or
system keychain.

Without IAM, you sign in with your OS account and its password. The Router checks it through PAM,
which needs Linux and `pamtester` (for example `sudo apt install pamtester`).

Forgot the IAM admin password? Stop `hive start`, then run:

```bash
IAM_RESET_PASSWORD='a new long password' \
  ~/.hive/runtime/node_modules/.bin/hive-iam-server reset-admin --env-file ~/.hive/config/iam.env
```

## Commands

| Command | What it does |
| --- | --- |
| `hive init` | Choose services, install the server packages, write `config/<service>.env`, create TLS certificates, and find or start Qdrant and Redis. Running it again is safe. |
| `hive start [service...]` | Run the configured servers in the foreground: IAM, HiveMem, optional Skills, then the Router. Each must pass its health check before the next one starts. |
| `hive status [--json]` | Show the health of each configured service and of Qdrant and Redis. Works whether or not `hive start` runs in another terminal. Exits 1 if a service is down. |
| `hive doctor [--json]` | Check Node.js, npm, openssl, Docker, flock, pamtester and ports, then run each server's own `check` command and summarize. Exits 1 if something needs fixing. |
| `hive install [service...]` | Install or upgrade the server packages (asks first). |
| `hive <command> --help` | Options of a command. `hive --version` prints the version. |

### `hive init` options

| Option | Meaning |
| --- | --- |
| `--services <list>` | Any of `memory`, `router`, `iam`, `skills`, or `all`, comma-separated (default: the core three). The Router alone works. |
| `--hostname <name>` | Also serve the console under a DNS name such as `hive.example.com`, for a Router set up in this run. The name is added to the certificate, and the Router listens on all interfaces. IAM and HiveMem stay on 127.0.0.1; the Router reaches them server-side. To add a name later, edit `PUBLIC_API_URL`, `PUBLIC_ADMIN_URL` and `HOST` in `router.env` and run `hive init --hostname <name>` to reissue the certificate. |
| `--no-tls` | Plain HTTP on 127.0.0.1. No openssl needed. |
| `--port <name>=<port>` | Use a specific port. Names: `memory`, `iam`, `router`, `router-admin`, `skills`, `qdrant`, `redis`. Repeatable. Without it, `init` uses each server's default port, or the next free one. |
| `--qdrant-url <url>`, `--redis-url <url>` | Use an existing Qdrant or Redis. |
| `--docker-prefix <name>` | Name prefix of the Docker containers and volume (default `hive`, giving `hive-qdrant` and `hive-redis`). |
| `--from <dir>` | Install the servers from `npm pack` tarballs in a directory instead of the npm registry, for offline installs and testing. `HIVE_INSTALL_FROM` does the same. |
| `-y`, `--yes` | Take the default answer to every question. |

## What `hive init` sets up

The server packages are installed on demand into `$HIVE_HOME/runtime`, pinned to an exact tested release bundle (for example `@hivemagnus/hive-router@1.2.0`). Skills requires `^1.1.0`, which
adds the launcher configuration/preflight protocol; older Skills packages are upgraded or rejected. The launcher itself has no runtime
dependencies.

`init` reads each server's `env-schema` and writes one env file per service. It generates the
required secrets with 32 random bytes and wires the services together:

- **Router and IAM**: one generated secret is both the Router's `HIVE_ROUTER_IAM_CLIENT_SECRET`
  and IAM's `SEED_HIVE_ROUTER_CLIENT_SECRET`. The OIDC redirect URI, issuer, audience and public
  URLs match on both sides. The Router uses `HIVE_ROUTER_AUTH_MODE=iam-oidc`.
- **Router and HiveMem**: the Router authenticates to HiveMem with an admin token that `init`
  mints with `hivemem-server issue-token`, signed with HiveMem's `HIVEMEM_JWT_SECRET`. The token is
  valid for 30 days. `hive start` issues a new one when it has less than 7 days left, also while it
  runs (the Router then restarts on its own). If you run the servers without `hive start`, run
  `hive start` once a month, or re-issue the token yourself.
- **TLS**: a local CA signs one server certificate for `localhost`, `127.0.0.1`, `::1` and the
  optional `--hostname`. Selected servers use it, and the Router trusts the CA when it calls IAM,
  HiveMem and Skills.
- **Ports**: each service gets its default port, or the next free one. Ports of services that are
  already configured are kept.
- **Qdrant and Redis**: `init` uses a server that already answers on the port, after asking.
  Otherwise, if Docker is available, it offers to start a container published on 127.0.0.1 only,
  using the command each server documents. `hive start` restarts those containers if they are
  stopped, for example after a reboot.

Running `init` again keeps existing values and secrets and preserves the enrolled service
selection. Configuration reconciliation shows each proposed change with secrets masked
and asks first. Existing unmanaged installations require explicit adoption before package
replacement and retain their current release path until then.

## Files

```
~/.hive/                     $HIVE_HOME; every directory is mode 0700
├── config/
│   ├── memory.env           one env file per service (mode 0600)
│   ├── router.env
│   ├── skills.env          when Skills is selected
│   ├── iam.env
│   └── launcher.json        Docker containers the launcher started
├── runtime/                 the installed server packages (npm --prefix)
├── tls/                     ca.crt, ca.key, server.crt, server.key
├── memory/                  HiveMem state (the memories are in Qdrant)
├── router/                  Router database and traces
├── skills/                  optional Skills SQLite registry and archives
├── iam/                     IAM database, signing keys, audit logs, initial-credentials.env
└── run/hive.pid             while `hive start` runs
```

Set `HIVE_HOME` to keep everything somewhere else. The env files are the whole configuration.
Edit them and restart `hive start`. Each file ends with the settings it leaves at their defaults,
as comments. `hive start` passes only `PATH`, `HOME`, the locale, proxy and certificate variables
from your shell to the servers, so a stray `PORT` or `NODE_ENV` in your shell cannot change them.

## Running the servers yourself

Each server is its own npm package with its own command and README. Point it at the env file
`init` wrote:

```bash
~/.hive/runtime/node_modules/.bin/hive-router --env-file ~/.hive/config/router.env
```

- [`@hivemagnus/hivemem-server`](https://github.com/ChefTaco/hive/tree/main/services/hive-mem/ts-core#readme)
- [`@hivemagnus/hive-router`](https://github.com/ChefTaco/hive/tree/main/services/hive-router#readme)
- [`@hivemagnus/hive-skills`](https://github.com/ChefTaco/hive/tree/main/services/hive-skills#readme)
- [`@hivemagnus/hive-iam-server`](https://github.com/ChefTaco/hive/tree/main/services/hive-iam/apps/iam-core#readme)

`hive start` runs in the foreground. To keep Hive running after you log out, run it under your
service manager (for example a systemd user unit with `ExecStart=hive start`), or in `tmux`.

## Upgrading

```bash
npx @hivemagnus/hive@latest upgrade --dry-run
npx @hivemagnus/hive@latest upgrade
hive rollback
```

Managed installations use exact release bundles and immutable versioned runtimes. Existing
launcher installations first use `hive adopt --dry-run`, stop the old launcher, then
`hive adopt --apply`. Backups must succeed before migration. Existing secrets, data and keys
stay in place; incompatible data changes require an explicitly reviewed restore.
Use the explicit `@latest` bootstrap for a pre-1.2 launcher; already published older launchers
cannot delegate to the managed upgrade engine and must not run `install` after adoption.

`hive init --manager systemd` registers user units; `--manager compose` generates a managed
Linux Compose project. `hive coordinator` runs the owner-only UI/update coordinator.
Automation switches default off outside managed installs; unattended upgrades remain off.
See [UPGRADING.md](https://github.com/ChefTaco/hive/blob/main/UPGRADING.md) for all controls,
backup/restore, compatibility and image recovery.

## Uninstalling

1. Stop `hive start` with Ctrl-C.
2. Remove the containers and the Qdrant volume that `hive init` started (`config/launcher.json`
   lists them; the names below are the defaults):

   ```bash
   docker rm -f hive-qdrant hive-redis
   docker volume rm hive-qdrant
   ```

3. Delete `~/.hive`. This deletes every memory, user and setting, so back up first if you need them.
4. Run `npm uninstall -g @hivemagnus/hive` if you installed the launcher globally.

## Troubleshooting

- **`hive doctor`** is the first thing to run. It names the setting or tool to fix.
- **A port is in use**: change it in the service's env file, or set up the service again with
  `--port`.
- **`openssl was not found`**: install openssl, or run `hive init --no-tls` for plain HTTP on
  127.0.0.1.
- **Qdrant or Redis is not running and Docker is missing**: install them natively, then point
  `HIVEMEM_QDRANT_URL` in `memory.env` or `REDIS_URL` in `iam.env` at them.
- **A service does not become healthy**: its own log lines in the `hive start` output say why.
  `hive start --timeout 300` gives slow machines more time.

## License

Apache-2.0
