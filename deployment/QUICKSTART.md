# Install Hive on one host

This guide takes a freshly installed Ubuntu or Debian server to a running Hive suite with every
product, signed in through the console. Each step is safe to repeat. The launcher selects the
latest published suite release; you can also select an exact version. The examples use the
console name `hive.example.com` and the installation directory `/opt/hive`; use your own values.

## What you need

- **A host** running Ubuntu 22.04 or 24.04, or Debian 12 or 13, on amd64 or arm64, with at least
  2 CPUs, 4 GB of memory and 20 GB of free disk. The `full` profile uses about 1 GB of memory
  when idle and about 6 GB of container images. On another Linux distribution, install Docker
  Engine with the Compose plugin and the tools that `./scripts/install-prerequisites.sh --check`
  lists yourself.
- **An account with sudo** that will own and run the installation. Use the account with UID 1000
  (on Ubuntu and Debian, the first account created on the machine): the suite's services run as
  UID/GID 1000. With any other account, run the setup with `sudo`.
- **A DNS name for the console**, and a certificate for it (step 3). The browser reaches the
  console at `https://NAME`.
- **No model runtime.** Inference stays external. You can connect an OpenAI-compatible,
  Ollama or llama.cpp endpoint during setup or later; Hive downloads no model.

## 1. Get the launcher

```bash
sudo apt-get update && sudo apt-get install -y git    # only if git is missing
git clone https://github.com/ChefTaco/hive.git
cd hive
```

Run the preparation commands from this checkout. `--release latest` resolves the published
release once and runs its matching tagged controller; an exact `--release 3.8.1` selects that
version instead. The launcher prints the version and retained checkout path, under
`${XDG_DATA_HOME:-$HOME/.local/share}/hive/releases/`. The signed release still pins the exact
controller source. After setup, switch to the retained release checkout printed by the launcher
for later commands and certificate renewal timers. Keep that directory.

## Guided local setup

With Hive 2.4.0 or later, run `./hive.sh --release latest` from the checkout for a fresh local installation. Interactive
setup offers to prepare this machine with Docker and the required tools, using sudo only after
showing its changes and asking for consent. A new Docker group membership takes effect in a
child shell, so no logout is needed. Setup then offers to create the installation directory.

If Tailscale is already logged in with HTTPS certificates enabled, setup suggests this host's
HTTPS name and can obtain its certificate. Tailscale remains optional: bring your own DNS name
and certificate on other networks. Selecting the optional local web terminal offers to prepare
its dedicated account and key. After installation, setup offers the certificate renewal timer
and, when its listener was selected, the Magnus host agent. Full-node review then enables
commands, managed cron and a selected web terminal gateway, while retaining the option to decline
enrollment or deliberately choose the separate Ardent-only path.

Every offer can be declined. Existing configuration files and non-interactive commands retain
explicit prerequisite and certificate management. The following steps describe that manual path
and remote-host preparation.

## 2. Install the prerequisites

```bash
sudo ./scripts/install-prerequisites.sh --directory /opt/hive
```

The script shows what it will change and asks before it changes anything. It:

- adds Docker's own apt repository, after checking its signing key fingerprint, and installs
  Docker Engine with the Compose plugin (`docker-ce`, `docker-ce-cli`, `containerd.io`,
  `docker-compose-plugin`), then enables the service;
- installs the tools `hive.sh` and its host scripts use: `jq`, OpenSSL, curl, git, `ss`
  (iproute2), `flock` (util-linux), coreutils and the rest;
- adds you to the `docker` group, so `hive.sh` can run without sudo. Members of that group
  control Docker, which is equivalent to root on the host;
- creates the empty installation directory `/opt/hive`, owned by you.

**Log out and back in** so your shell picks up the `docker` group (guided setup does this for you
in a child shell), then confirm:

```bash
./scripts/install-prerequisites.sh --check     # prints "Ready" when everything is in place
```

`--dry-run` only shows the plan, and `--yes` applies it without asking. The script refuses an
unsupported distribution or architecture, and Docker installed as a snap: the snap can only reach
files under `/home`. If the distribution's `docker.io` package is installed and has the Compose
plugin, it is kept; otherwise `--replace-conflicting` replaces it with Docker's packages.
Rootless Docker is not supported, because the services need host files owned by UID 1000.

## 3. Get a console certificate

The console needs a certificate and an unencrypted private key, as files on the host, for the
exact name in the console origin. Choose one:

**Tailscale.** On a host in a tailnet with MagicDNS and HTTPS Certificates turned on (DNS page
of the Tailscale admin console):

```bash
sudo ./scripts/console-certificate.sh tailscale
```

It runs `tailscale cert` for the host's MagicDNS name and writes `/etc/hive/tls/console.crt`
(mode 0644) and `/etc/hive/tls/console.key` (mode 0600), both owned by you, then prints the
origin to use: `https://` and the MagicDNS name. Certificates from public authorities, including
these, are published in Certificate Transparency logs, so the name becomes public.

**Your own certificate.** Copy the certificate chain (PEM, leaf first) and its key anywhere
outside the installation directory, make yourself the owner and the key owner-only, and check
them the way the installer will:

```bash
sudo install -d -m 0750 -o "$USER" -g "$USER" /etc/hive/tls
sudo install -m 0644 -o "$USER" -g "$USER" fullchain.pem /etc/hive/tls/console.crt
sudo install -m 0600 -o "$USER" -g "$USER" privkey.pem /etc/hive/tls/console.key
./scripts/console-certificate.sh check --cert /etc/hive/tls/console.crt \
  --key /etc/hive/tls/console.key --name hive.example.com
```

**ACME (for example Let's Encrypt).** Hive does not run an ACME client: the ingress has ACME
turned off. Use one such as certbot or acme.sh, with a DNS-01 challenge or an HTTP-01 challenge
on port 80 (the suite does not use port 80), and have its deploy hook copy the files into place
as above. Step 9 installs a renewed certificate.

## 4. Run the setup

```bash
./hive.sh --release latest
```

`latest` excludes draft and prerelease releases and requires GitHub access; if lookup fails,
setup stops. It never silently uses a cached older release. To choose a version, replace
`latest` with that exact version. `hive.sh` checks the release signature first, then asks these
questions. Press Enter to accept the default shown in brackets.

| Question | Answer |
|---|---|
| Installation name | `hive`: lowercase letters, digits and hyphens |
| Installation directory on the selected host | the default, `/opt/hive`. A local directory you cannot create is asked for again, with the command that creates it |
| Host SSH target | `local` |
| Host architecture | the default |
| Console HTTPS origin | `https://hive.example.com`, the name on the certificate. Add `:PORT` if the listener port is not 443 |
| Product profile | `full` for every product, or `core` (see the [README](../README.md)) |
| HTTPS bind address | The default `127.0.0.1` accepts connections from this host only. Use `0.0.0.0` to serve every network the host is on, or one of the host's addresses. `0.0.0.0` also works when a Tailscale address appears only after Docker starts at boot |
| HTTPS listener port | `443` |
| Configuration mode | `fresh` |
| Initial operator username | `admin` |
| Initial operator email | your address, for identity recovery |
| Existing console certificate file | `/etc/hive/tls/console.crt` |
| Protected console private key file | `/etc/hive/tls/console.key` |
| Deploy the Magnus web terminal gateway | `no`. For `yes`, first create the restricted account and key in [preparing nodes](FULL.md#preparing-nodes-and-the-gateway-key) |
| Port for Magnus host agents | blank for none. Give a port, such as `4000`, to let hosts join the Magnus fleet; see [Magnus host agents](FULL.md#magnus-host-agents) |
| Existing external inference HTTPS endpoint | blank to skip; see [external inference](INFERENCE.md) |
| Native agent runtime | Release 3.8.1 skips this question because it pins no native runtime artifacts; the guided local setup offers a Magnus host agent after installation, as in [Magnus host agents](FULL.md#magnus-host-agents) |
| Write protected installation configuration to | the default, `~/.config/hive/hive/installation.json` |

`hive.sh` then prints the plan: every product, image digest and host path. Answer `y` to apply
it. The first install pulls the images and takes a few minutes; later commands take seconds.

If it stops after writing the configuration file, fix the cause and run `./hive.sh --release
X.Y.Z` again, replacing `X.Y.Z` with the exact version it reported: after the installation name
it offers to continue with the saved file instead of asking everything again. Use that exact version for retries and for planning then applying,
so a new release cannot change the plan between commands. Unattended, for example with 3.8.1:

```bash
./hive.sh install --config ~/.config/hive/hive/installation.json --release 3.8.1
```

After setup, change to the retained release checkout path printed by the launcher before
following steps 5–10. Keep that directory: certificate renewal timers refer to it.

## 5. Check the installation

```bash
./hive.sh status --config ~/.config/hive/hive/installation.json    # every container, as JSON
./hive.sh doctor --config ~/.config/hive/hive/installation.json    # host preflight and registry
```

`status` lists each container with its state and health, and `doctor` ends with
`Hive Registry: in sync with this installation`. After its JSON, `status` lists the
[setup checklist](FULL.md#setup-checklist) items still pending, such as the certificate renewal
below; `install` and `upgrade` end with the same list, and HiveXUI shows it to administrators.
`./hive.sh setup done ID` or `./hive.sh setup skip ID` settles one by hand.

`--config` is optional for every command except `install`, `init` and `plan`, which set up or
preview an installation. When `~/.config/hive` holds
a single installation, the controller uses it and says so (`Hive: using ...`). With several
installations it asks which one in a terminal, and refuses unattended. `HIVE_INSTALLATION=FILE`
chooses one without passing `--config` each time.

## 6. Sign in

The initial operator's password is generated once, into a file only you can read:

```bash
cat /opt/hive/config/initial-credentials.env    # SEED_ADMIN_USERNAME and SEED_ADMIN_PASSWORD
```

Open `https://hive.example.com/` and sign in with that username and password. The console shows
a section for each installed product. Add a second factor, a passkey or an authenticator app,
under **Oathweave > Account security**. Keep the file owner-only and leave it where it is: never
edit or remove files under `/opt/hive/config`, because the installer checks their digests when a
command is repeated.

Then create your own administrator account and use it from then on, keeping the initial operator
for recovery. HiveXUI's setup checklist confirms this item once such an account exists; record it
with `./hive.sh setup done first-admin`.

## 7. Back up

```bash
./hive.sh backup --config ~/.config/hive/hive/installation.json --archive first-backup --yes
```

The archive is written to `/opt/hive/backups/first-backup` and verified. From 2.0.2 a backup keeps
the suite serving; `--stopped` stops every service while it runs instead, which is what 2.0.0 and
2.0.1 always do. Copy archives off the host. See [backups](BACKUPS.md) for what is captured,
restores and rehearsals.

## 8. Upgrade

Return to the original launcher checkout (from step 1). It can select and retain the new release
controller for you; older tagged controllers may not support `latest`:

```bash
./hive.sh upgrade --config ~/.config/hive/hive/installation.json --release latest
```

Use an exact version instead of `latest` to review and apply a specific release. Existing
PostgreSQL stores need explicit migration approval when moving from 2.x to 3.6.0, and so do
existing Emberpath and HiveSkills stores when moving from a release before 3.4.0 (see
[UPGRADING](../UPGRADING.md#suite-34-emberpath-and-hiveskills-data-formats)) and an existing
Embermend store when moving from a release before 3.6.0 (see
[UPGRADING](../UPGRADING.md#suite-36-the-setup-checklist-and-an-embermend-migration)), and an
installation that runs Magnus when moving from a release before 3.8.0 (see
[UPGRADING](../UPGRADING.md#suite-380-magnus-node-credentials-and-product-security-updates)):

```bash
./hive.sh plan --config ~/.config/hive/hive/installation.json --release 3.8.1 --allow-migrations
./hive.sh upgrade --config ~/.config/hive/hive/installation.json --release 3.8.1 --allow-migrations
```

The upgrade prints its plan, takes a verified pre-change backup and rehearses data changes on a
copy. The console is unavailable while its services and stores are stopped or migrated; duration
depends on the data and index rebuilds. After upgrading, switch to the retained checkout the
launcher printed. `./hive.sh rollback` can return to a compatible storage format. The PostgreSQL collation
transition introduced in 3.0.0 refuses code-only rollback: recovery requires the verified
original-state backup and write reconciliation. Read the release notes,
[advisory remediation](../docs/ADVISORY_REMEDIATION.md#postgresql-needs-a-separate-migration-proof)
and [UPGRADING](../UPGRADING.md) first.

The installation file keeps the release it was installed with, and an upgrade does not rewrite
it. From 2.0.3, a checkout uses its own signed release when the file names one this controller
cannot run, and says so (`Hive: using release X.Y.Z, which this checkout's controller installs`),
so `backup`, `upgrade` and `rollback` work from the new checkout without options. `--release`
chooses another release, and `--manifest` uses that manifest's version. Earlier controllers need
`--release X.Y.Z`, or `"release"` set in the file, or they refuse with `Signed release requires
different controller source`. Starting with 2.4.2, a successful upgrade refreshes an
existing local Hive certificate-renewal service to its verified controller checkout.

When two releases share the same controller source, the checkout retains the compatible release
named in the installation file. Pass the new exact version to later commands to keep using its
product pins, for example `./hive.sh doctor --config FILE --release 3.8.1`. Certificate renewal
uses a unique matching release tag in this case, so its receipt follows that checkout.

Then finish maintenance from the retained release checkout with the individual commands:

```bash
./hive.sh magnus-agent status --config ~/.config/hive/hive/installation.json --release 3.8.1
./hive.sh magnus-agent install --config ~/.config/hive/hive/installation.json --release 3.8.1
./hive.sh console-clients add --config ~/.config/hive/hive/installation.json --release 3.8.1
./hive.sh doctor --config ~/.config/hive/hive/installation.json --release 3.8.1
```

Run the Magnus commands only when this installation hosts Magnus and has a host agent to update;
run `console-clients add` when it hosts Oathweave and needs missing HiveXUI browser clients.
`magnus-agent install` updates the package while preserving the node's existing enrollment scope.
Full-node enrollment is a separate authorization through `magnus-agent enroll`; a package update
must not enable commands, cron or web terminals on an intentionally limited node. See
[Magnus host agents](FULL.md#magnus-host-agents) for enrollment review and other hosts.
An updated agent is not re-enrolled for its node key either: with a Magnus that has per-node
credentials it binds its own key automatically; see [node keys](FULL.md#node-keys). From a
release that pins Magnus 3.0.0 or later, which accepts node keys only, an agent that already has a
key keeps it, an agent without one is enrolled with a one-time token, and no fleet-wide node secret
is copied to agents; `./hive.sh post-upgrade` then lists any blockers from Magnus's fleet summary
(see [Upgrading](../UPGRADING.md#magnus-300-node-keys-only)).

Update Ardent packages in HiveXUI under Magnus > Ardent > Installations: stop running profiles,
choose Update package, then start them again, and record it with
`./hive.sh setup done ardent-packages-updated`. Update agents on other fleet hosts separately,
and check certificate renewal when nothing renews the certificate.

From the Hive Registry 1.3.0, the upgrade records these steps in the
[setup checklist](FULL.md#setup-checklist), and `./hive.sh post-upgrade` marks each one it
completes as done; `./hive.sh status` lists what is still pending.

**Published controller compatibility:** releases 3.2.0 and 3.2.1 include `post-upgrade`, but on a
single-host installation that command can request full-node enrollment. Use the individual
commands above when maintaining a limited or Ardent-only node. The scope-preserving
`post-upgrade` fix in 3.2.2 and later uses `magnus-agent install` for all
package updates and `console-clients add` for missing clients. Each change asks for confirmation;
`--yes` confirms these maintenance steps and does not authorize full-node enrollment.

## 9. Keep the certificate current

The installer copies the certificate into the ingress, so a renewed certificate needs installing.
`./hive.sh tls-refresh` does that: it checks the files at the paths you gave during setup,
copies them into the ingress, records them for later runs and restarts only the ingress. When
nothing changed it does nothing. The previous files are kept as `console.crt.previous` and
`console.key.previous` in `/opt/hive/config/.initializer`.

```bash
./hive.sh tls-refresh --config ~/.config/hive/hive/installation.json
```

For a Tailscale certificate, `schedule` does it all weekly from a systemd timer: it refreshes the
certificate with `tailscale cert`, then runs `tls-refresh` from this checkout as the account that
owns the configuration.

```bash
sudo ./scripts/console-certificate.sh schedule --config ~/.config/hive/hive/installation.json
```

Tailscale certificates last 90 days, and `tailscale cert` returns a new one as expiry nears.
`sudo ./scripts/console-certificate.sh renew --config FILE` runs the same step once. For a
certificate you renew another way, add `--no-tailscale`, or run `tls-refresh` from your ACME
client's deploy hook. Run these on the console host. Successful upgrades refresh an
existing matching Hive service automatically, preserving its renewal options and timer state. They
do not create or enable a timer. Customized or unsafe service files remain unchanged and produce a
review message; manage those through your existing service configuration.
For unattended upgrades, this refresh uses the console host's configured owner-only
`sudoPasswordFile`; otherwise it uses the account's normal sudo authorization.

## 10. Optional: add this host to the Magnus fleet

With the full profile and a port for Magnus host agents, one command installs the Magnus agent on
this host, waits for Magnus to accept its first heartbeat and, with the web terminal, approves
the host's SSH key so a terminal opens at once:

```bash
./hive.sh magnus-agent install --config ~/.config/hive/hive/installation.json
```

It asks before installing Node.js 24 from NodeSource when the host has no suitable Node.js, and
asks for your sudo password, as the agent runs as a root service. With a Magnus that has per-node
credentials, the new agent also gets its own node key with a one-time enrollment token, and the
command ends by printing the key's fingerprint. With Magnus 3.0.0 or later the token is the only
way in: the agent gets no fleet-wide node secret, and the command stops before changing anything
when no token can be issued. See [installing the agent](FULL.md#installing-the-agent).

## Firewall and ports

The suite publishes only the console listener. Docker inserts its own firewall rules, so a port
it publishes is reachable on the bind address even when ufw would block it: ufw does not protect
it. Choose the bind address on purpose. To check what is listening:

```bash
sudo ss -lntp 'sport = :443'
```

## Managing the host from another machine

`hive.sh` can also run on a controller, such as a laptop, that reaches the host over SSH. The
controller needs only the tools, not Docker:

```bash
sudo ./scripts/install-prerequisites.sh --controller     # on the controller
sudo ./scripts/install-prerequisites.sh --directory /opt/hive    # on the host, as above
```

`hive.sh` runs SSH with `BatchMode=yes` and `StrictHostKeyChecking=yes`, so first make sure this
works without a prompt, with a key and a known host key:

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes deploy@hive.example.com true
```

Answer `deploy@hive.example.com` to *Host SSH target*. The next question asks for an SSH
configuration file: leave it blank when that `ssh` command works as it is, or give an owner-only
`ssh_config` (mode 0600) with a `Host` block naming the `IdentityFile`. The certificate, key and
installation directory are paths on the host. Before the plan, `hive.sh` connects to the host and
checks that it can create the installation directory there.

When the account needs sudo on the host (it is not UID 1000 in the `docker` group), add an
owner-only file holding its sudo password to `hosts.control` in the installation file, then
continue with `./hive.sh install --config FILE`. Commands on the host then run as root, and the
installation directory is owned by root:

```json
"sudoPasswordFile": "/path/to/sudo-password"
```

## When something goes wrong

| Message | What to do |
|---|---|
| `... must be a canonical absolute path that ... can create or write` | Create the directory for your account, as the message shows, or with `sudo ./scripts/install-prerequisites.sh --directory /opt/hive` |
| `Installation ... already has a configuration` | Answer `yes` to continue with it, or choose another installation name |
| `permission denied while trying to connect to the docker API` | After manual preparation, your shell does not have the new `docker` group yet: log out and back in, then run `./scripts/install-prerequisites.sh --check`. Guided setup continues in a shell with the new membership by itself |
| `Required tool missing on this host: ...` | Run `sudo ./scripts/install-prerequisites.sh` on that host, then `./scripts/install-prerequisites.sh --check` |
| `incomplete-transaction` from `doctor`, or `A different transaction requires recovery` | A command stopped part-way. Repeat exactly the same command; see [when a command stops](README.md#when-a-command-stops-transactions-and-recovery) |
| `Requested HTTPS port is already occupied` | Something else listens on the port: `sudo ss -lntp 'sport = :443'`. Stop it or choose another port |
| `Console certificate and private key do not match`, or `... is not valid for NAME` | Check the files with `./scripts/console-certificate.sh check --cert FILE --key FILE --name NAME` |
| `Permission denied (publickey,password)`, or `Host control is not ready` | The controller's SSH key or host key is not accepted; see [Managing the host from another machine](#managing-the-host-from-another-machine) |

For later upgrades, database schemas are checked separately from storage-format compatibility.
If a check reports pending product migrations, review and apply with `--allow-migrations`;
verification and migration run on restored copies before the live stores. See
[Upgrading product schemas](FULL.md#upgrading-product-schemas).
