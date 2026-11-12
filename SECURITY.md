# Security Policy

## Supported versions

Security fixes are released as new suite releases on the latest `3.x` line. The npm 1.x packages
are retired and receive no more fixes; move to the suite (see [UPGRADING.md](UPGRADING.md)).
Products released from their own repositories, such as Oathweave, Emberpath or HiveMem, take
their fixes there, and a suite release pins the fixed images.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Report them privately through
[GitHub private vulnerability reporting](https://github.com/ChefTaco/hive/security/advisories/new).
Please include:

- the affected part (`hive.sh` and its scripts, the Hive Registry, the ingress, a suite image, or
  a release manifest) and the release version or commit
- steps to reproduce, or a proof of concept
- the impact you expect

You should get an acknowledgement within a few days. Once a fix is available, a GitHub security
advisory will credit you unless you ask not to be named.

## Hardening notes for operators

- Install only signed releases, and check the publisher key fingerprint against the release notes
  before using separately downloaded manifests.
- Keep the installation file, the generated product secrets and the TLS private key readable only
  by the installing account, and keep backup archives private.
- Expose only the ingress; the suite's datastores stay on private Compose networks.
