# Install Hive on one host

This guide takes a freshly installed Ubuntu or Debian server to a running Hive suite with every
product, signed in through the console. Each step is safe to repeat. The examples use the release
`2.0.3`, the console name `hive.example.com` and the installation directory `/opt/hive`; use your
own values.

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

## 1. Get the release

```bash
sudo apt-get update && sudo apt-get install -y git    # only if git is missing
git clone --branch v2.0.3 https://github.com/ChefTaco/hive.git
cd hive
```

Run every later command from this checkout. The signed release pins the exact controller source,
so `hive.sh` refuses a checkout of a different version.

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

**Log out and back in** so your shell picks up the `docker` group, then confirm:

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
./hive.sh --release 2.0.3
```

`hive.sh` checks the release signature first, then asks these questions. Press Enter to accept
the default shown in brackets.

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
| Opt-in native agent runtime | blank. Release 2.0.3 pins no native agent artifacts, so none can be installed here; a Magnus host agent is installed as in [Magnus host agents](FULL.md#magnus-host-agents) |
| Write protected installation configuration to | the default, `~/.config/hive/hive/installation.json` |

`hive.sh` then prints the plan: every product, image digest and host path. Answer `y` to apply
it. The first install pulls the images and takes a few minutes; later commands take seconds.

If it stops after writing the configuration file, fix the cause and run `./hive.sh --release
2.0.3` again: after the installation name it offers to continue with the saved file instead of
asking everything again. Unattended, the same step is:

```bash
./hive.sh install --config ~/.config/hive/hive/installation.json --release 2.0.3
```

## 5. Check the installation

```bash
./hive.sh status --config ~/.config/hive/hive/installation.json    # every container, as JSON
./hive.sh doctor --config ~/.config/hive/hive/installation.json    # host preflight and registry
```

`status` lists each container with its state and health, and `doctor` ends with
`Hive Registry: in sync with this installation`.

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

## 7. Back up

```bash
./hive.sh backup --config ~/.config/hive/hive/installation.json --archive first-backup --yes
```

The archive is written to `/opt/hive/backups/first-backup` and verified. From 2.0.2 a backup keeps
the suite serving; `--stopped` stops every service while it runs instead, which is what 2.0.0 and
2.0.1 always do. Copy archives off the host. See [backups](BACKUPS.md) for what is captured,
restores and rehearsals.

## 8. Upgrade

Each release is its own checkout. Clone the new tag next to the old one and upgrade from it:

```bash
git clone --branch vX.Y.Z https://github.com/ChefTaco/hive.git hive-X.Y.Z && cd hive-X.Y.Z
./hive.sh upgrade --config ~/.config/hive/hive/installation.json --release X.Y.Z
```

The upgrade shows its plan and takes a backup with the suite stopped first, so the console is
unavailable for about a minute. `./hive.sh rollback` from the same checkout returns to the
previous release. Read the release notes and [UPGRADING](../UPGRADING.md) first.

The installation file keeps the release it was installed with, and an upgrade does not rewrite
it. From 2.0.3, a checkout uses its own signed release when the file names one this controller
cannot run, and says so (`Hive: using release X.Y.Z, which this checkout's controller installs`),
so `backup`, `upgrade` and `rollback` work from the new checkout without options. `--release`
chooses another release, and `--manifest` uses that manifest's version. Earlier controllers need
`--release X.Y.Z`, or `"release"` set in the file, or they refuse with `Signed release requires
different controller source`. Run `schedule` again from the new checkout
(step 9).

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
client's deploy hook. Run these on the console host. After an upgrade, run `schedule` again from
the new release's checkout, so the timer uses its `hive.sh`.

## 10. Optional: add this host to the Magnus fleet

With the full profile and a port for Magnus host agents, one command installs the Magnus agent on
this host, waits for Magnus to accept its first heartbeat and, with the web terminal, approves
the host's SSH key so a terminal opens at once:

```bash
./hive.sh magnus-agent install --config ~/.config/hive/hive/installation.json
```

It asks before installing Node.js 24 from NodeSource when the host has no suitable Node.js, and
asks for your sudo password, as the agent runs as a root service. See
[installing the agent](FULL.md#installing-the-agent).

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
| `permission denied while trying to connect to the docker API` | Log out and back in after joining the `docker` group, then run `./scripts/install-prerequisites.sh --check` |
| `Required tool missing on this host: ...` | Run `sudo ./scripts/install-prerequisites.sh` on that host, then `./scripts/install-prerequisites.sh --check` |
| `incomplete-transaction` from `doctor`, or `A different transaction requires recovery` | A command stopped part-way. Repeat exactly the same command; see [when a command stops](README.md#when-a-command-stops-transactions-and-recovery) |
| `Requested HTTPS port is already occupied` | Something else listens on the port: `sudo ss -lntp 'sport = :443'`. Stop it or choose another port |
| `Console certificate and private key do not match`, or `... is not valid for NAME` | Check the files with `./scripts/console-certificate.sh check --cert FILE --key FILE --name NAME` |
| `Permission denied (publickey,password)`, or `Host control is not ready` | The controller's SSH key or host key is not accepted; see [Managing the host from another machine](#managing-the-host-from-another-machine) |
