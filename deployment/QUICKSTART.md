# Install Hive on one host

This guide takes a freshly installed Ubuntu or Debian server to a running Hive suite with every
product, signed in through the console. Each step is safe to repeat. The examples use the release
`2.0.2`, the console name `hive.example.com` and the installation directory `/opt/hive`; use your
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
git clone --branch v2.0.2 https://github.com/ChefTaco/hive.git
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
./hive.sh --release 2.0.2
```

`hive.sh` checks the release signature first, then asks these questions. Press Enter to accept
the default shown in brackets.

| Question | Answer |
|---|---|
| Installation name | `hive`: lowercase letters, digits and hyphens |
| Installation directory on the selected host | `/opt/hive` |
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
| Deploy the Magnus web terminal gateway | `no` (see [the web terminal](FULL.md#magnus-web-terminal)) |
| Existing external inference HTTPS endpoint | blank to skip; see [external inference](INFERENCE.md) |
| Opt-in native agent runtime | blank to skip; see [native agents](NATIVE_AGENTS.md) |
| Write protected installation configuration to | the default, `~/.config/hive/hive/installation.json` |

`hive.sh` then prints the plan: every product, image digest and host path. Answer `y` to apply
it. The first install pulls the images and takes a few minutes; later commands take seconds.

If it stops after writing the configuration file, fix the cause and continue with that file.
Running the questions again refuses to overwrite it:

```bash
./hive.sh install --config ~/.config/hive/hive/installation.json --release 2.0.2
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

The upgrade shows its plan, takes a stopped backup first, and `./hive.sh rollback` from the same
checkout returns to the previous release. Read the release notes and [UPGRADING](../UPGRADING.md)
first.

## 9. Keep the certificate current

The installer copies the certificate into the ingress, so a renewed file needs installing.
`renew` refreshes a Tailscale certificate, checks it, copies it into the ingress and restarts only
the ingress, and does nothing while the certificate is unchanged. `schedule` runs it weekly from a
systemd timer:

```bash
sudo ./scripts/console-certificate.sh schedule --config ~/.config/hive/hive/installation.json
```

Tailscale certificates last 90 days, and `tailscale cert` returns a new one as expiry nears. For a certificate you
renew another way, add `--no-tailscale`: the timer then installs whatever is at the configured
paths. Run `renew` and `schedule` on the console host. The previous files are kept as
`console.crt.previous` and `console.key.previous`. Once a certificate has been renewed, do not
re-run `hive.sh install` for this installation: it checks that the setup inputs, the certificate
among them, are unchanged. Use `upgrade`, `status`, `doctor` and `backup` as usual.

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

Answer `deploy@hive.example.com` to *Host SSH target*. The certificate, key and installation
directory are paths on the host. When the key is not one SSH uses by default, or the account needs
sudo on the host (it is not UID 1000 in the `docker` group), add these to
`hosts.control` in the installation file and continue with `./hive.sh install --config FILE`:

```json
"sshConfig": "/path/to/ssh-config",
"sudoPasswordFile": "/path/to/sudo-password"
```

Both are absolute paths to owner-only files (mode 0600) on the controller. The SSH configuration is an ordinary
`ssh_config` with a `Host` block naming `IdentityFile`. With `sudoPasswordFile`, commands on the
host run as root and the installation directory is owned by root.

## When something goes wrong

| Message | What to do |
|---|---|
| `Installation parent is not writable` | Create the directory for your account: `sudo ./scripts/install-prerequisites.sh --directory /opt/hive` |
| `Configuration already exists; it will not be overwritten` | Continue with `./hive.sh install --config FILE --release VERSION` instead of answering the questions again |
| `permission denied while trying to connect to the docker API` | Log out and back in after joining the `docker` group, then run `./scripts/install-prerequisites.sh --check` |
| `Host preflight failed` with no other detail | A tool is missing on the host: run `./scripts/install-prerequisites.sh --check` there |
| `Requested HTTPS port is already occupied` | Something else listens on the port: `sudo ss -lntp 'sport = :443'`. Stop it or choose another port |
| `Console certificate and private key do not match`, or the browser rejects the name | Check the files with `./scripts/console-certificate.sh check --cert FILE --key FILE --name NAME` |
| `Permission denied (publickey,password)` | The controller's SSH key is not accepted; see [Managing the host from another machine](#managing-the-host-from-another-machine) |
