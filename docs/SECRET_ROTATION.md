# Hive Secret Rotation Runbook

Hive keeps deploy credentials in ignored local env files and runtime secrets in service-local `.env` files on each host. Rotate secrets after suspected exposure, operator changes, or scheduled maintenance.

## Safety Rules

- Never print secret values in deploy logs, terminal transcripts, docs, or commits.
- Run `npm run scan:secrets` before committing.
- Prefer dry-run first: `scripts/rotate-secrets.sh --host hive.example.com --kind all`.
- `--host` defaults to `HIVE_DEPLOY_HOST`; when it is a short host name, `HIVE_PUBLIC_FQDN` must also be set.
- Use `--apply` only during a maintenance window.
- Keep the backup path printed by the script until the service is verified.

## Scripted Runtime Rotation

Dry-run all supported runtime secrets:

```bash
scripts/rotate-secrets.sh --host hive.example.com --kind all
```

Apply rotation for one host:

```bash
scripts/rotate-secrets.sh --host hive.example.com --kind router --apply
scripts/rotate-secrets.sh --host hive.example.com --kind iam --apply
scripts/rotate-secrets.sh --host hive.example.com --kind memory --apply
```

With more than one installation, rotate one host at a time and repeat for the next host only after the first is healthy:

```bash
scripts/rotate-secrets.sh --host memory.example.com --kind all --apply
```

The script rotates generated values on the target host and does not print them. It restarts the relevant service and probes health endpoints when verification is enabled.

## Deploy Password

`DEPLOY_PASSWORD` is an OS/deploy account password, not only an app env value. Rotate it manually through the host account/password manager, then update ignored local env files. After rotation:

```bash
npm run scan:secrets
HIVE_DEPLOY_SKIP_VERIFY=false npm run deploy
```

Normal deploy scripts now prefer key or agent auth when `DEPLOY_SSH_KEY` or a service-specific key variable is set. Use password bootstrap mode only for first install or key repair, keep `DEPLOY_PASSWORD` in ignored env files, and run `npm run deploy -- --dry-run` to confirm which SSH and sudo auth modes each service will use before a rollout.

## Covered Secrets

- Router: `HIVE_ROUTER_SECRET`
- IAM: `COOKIE_SECRET`, `IAM_AGENT_SECRET`
- Memory: `HIVEMEM_JWT_SECRET`
- Manual: `DEPLOY_PASSWORD` (`scripts/rotate-secrets.sh --kind deploy` prints guidance)

## Manual Or Lifecycle-Specific Rotation

Some secrets need an application-aware migration rather than a blind env-file edit:

- Password escrow has been retired. IAM migrations clear legacy `encryptedPassword` values, deployments remove `PASSWORD_ENCRYPTION_KEY`, and only Argon2 password hashes remain.
- IAM OAuth client secrets: routine seed preserves existing hashes. Submit a strong replacement to authenticated `POST /api/v1/clients/:id/rotate-secret`, update the consumer in the same maintenance window, and verify the `client.secret_rotated` audit event.
- Router client API keys: create replacement keys in Router/IAM, deploy consumers with the new key, confirm use via `lastUsedAt`, then revoke the old key.
- IAM service-account keys: rotate from the IAM service-account UI/API, store the shown-once replacement securely, update consumers, then revoke/delete the old key.
- HiveMem agent tokens: mint a scoped replacement token, update the agent/Hermes host, verify `hermes hivemem status` and a write-check, then revoke the old token.

### IAM JWT signing keys

The active JWT `kid` is derived from the RSA key using an RFC 7638 SHA-256 thumbprint. Rotation retains the old public key in JWKS while IAM immediately signs with the new key:

```bash
ssh deploy@hive.example.com
sudo /usr/local/libexec/hive-iam/rotate-jwt-signing-key.sh
# Wait at least the JWT_ACCESS_TTL reported by the script, verify consumers,
# then remove public keys whose overlap has elapsed:
sudo /usr/local/libexec/hive-iam/rotate-jwt-signing-key.sh --prune-expired
```

The privileged helper and its validator live under the root-owned
`/usr/local/libexec/hive-iam` tree, outside the service-owned application path.
It stages the complete keyring and environment fragment as a root-only release
under `/var/lib/hive-iam-keyring`, validates the private/public pair and proposed
JWKS, atomically changes the `current` symlink, restarts IAM, and checks both
readiness and the live JWKS. These loopback HTTPS checks trust only
`/opt/hive-iam/certs/ca-bundle.crt`; they reject insecure TLS, recompute every RFC 7638
thumbprint, compare the active RSA modulus and exponent with the staged public
key, and verify a short-lived test signature made by the staged private key.

Every operation appends and fsyncs root-only `prepared`, `activated`,
`verified`, and `finalized` records to
`/var/lib/hive-iam-keyring/rotation-journal.jsonl`. A subsequent invocation
reconciles an incomplete record before starting another operation. A failed
activation changes the link back, restarts IAM, rechecks readiness, and proves
the prior key's exact live JWKS material before it records `rolled_back` or says
rollback was successful. If restart or proof fails, both releases are retained,
a durable `recovery_failed` record is written, and the helper emits a critical
operator-attention error instead of claiming restoration.

Retired private-key retention is **disabled**. The prior release exists only
during the health-gated cutover. The helper first deletes that release, confirms
the path is absent, and fsyncs the releases directory. Only then does it append
and fsync a root-only, SHA-256 hash-chained deletion receipt containing the
operation ID, public key ID, destroyed release, timestamp, reason, and
`retention=none` to `/var/log/hive-iam-key-destruction.log`. A deletion or
receipt failure leaves the journal incomplete and returns an operator-attention
error; it is never reported as finalized. Public verification keys remain in
the active release for `JWT_ACCESS_TTL` and are removed by `--prune-expired`.

Do not copy retired private keys into an ad-hoc archive. If a future legal or
forensic requirement mandates retention, define the owner, purpose, inventory,
and expiration first, then implement a separate envelope-encrypted archive
using a key that is not stored on the IAM host. That workflow must emit an
inventory record at retention time and a deletion receipt at expiration before
retention can be enabled.

Verify JWKS contains old and new IDs during overlap, new tokens advertise the
active ID, Router accepts both, and the old ID disappears only after pruning.

### IAM TLS leaf

The deploy path maintains a ten-year root-only private CA under
`/var/lib/hive-iam-pki` and issues a new 30-day IAM server leaf. Router trusts
`/opt/hive-iam/certs/ca-bundle.crt`, not the leaf. A normal IAM deploy renews
the leaf; Router does not need redeployment solely for leaf renewal.

For a CA rollover, stage the next public CA as root-owned
`/var/lib/hive-iam-pki/next-ca.crt` (mode `0644`; keep its private key root-only
and outside the service tree), then deploy IAM and Router. IAM validates that
the staged certificate is a distinct CA and publishes current plus next in the
bundle while the live leaf remains signed by current. Verify every consumer has
the two-certificate bundle before promoting the next CA and issuing its first
leaf. Retain the old CA in the bundle through the maximum leaf/session overlap;
remove it only after consumers and live probes succeed with the new issuer.
Never place either CA private key in the consumer bundle.

As the Hive Actor model lands, these manual rotations should move behind one lifecycle page that can stage replacement credentials, verify consumer cutover, and revoke old credentials automatically.
