# Code-scanning review

Review CodeQL alerts against their data-flow traces and add regression coverage for confirmed
issues. Do not suppress a query or exclude a service to clear the dashboard. Local SARIF and
operational evidence belong in ignored `output/`, never in a public commit.

The initial review covers these alert numbers in `ChefTaco/hive`:

| Alerts | Resolution |
| --- | --- |
| 1–3 | Explicit TLS 1.2 minimum for backup/deployment connections and the test HTTPS receiver; retain certificate and hostname verification. |
| 4 | Assert the complete expected deployment-output line, rather than a URL substring. |
| 5 | False positive requiring individual review: SHA-1 is the Pwned Passwords lookup protocol, not a password-storage hash. See below. |
| 6–8 | Store dynamic test values as JSON data read by constant JavaScript fixtures. |
| 9–11 | Omit SSH identities, raw remote errors, account identifiers and credential-bearing database errors from tool output. |
| 12–13 | Remove certificate-verification bypasses from both Router HTTPS clients, including loopback development. Use a trusted CA file instead. |
| 14 | Parse registry request paths, reject foreign origins and malformed encodings, and construct redirect destinations with a fixed public npm origin. |
| 15–16 | Use fixed public queue-failure messages and a fixed fake-server error; redact historical queue errors when reading individual jobs and summaries. |
| 17–18 | Remove the redundant ambiguous config-path regex and normalize trailing URL slashes with a linear scan. |

## Pwned Passwords protocol exception

Alert 5 (`js/insufficient-password-hash`) points at
`services/hive-iam/apps/iam-core/src/services/breach-check-service.ts`. This function performs a
breach lookup; it does not persist or authenticate credentials. The
[Pwned Passwords range API](https://haveibeenpwned.com/API/v3#SearchingPwnedPasswordsByRange)
requires the first five hexadecimal characters of the password's SHA-1 digest. The remaining
suffix is compared locally and neither the password nor the full digest is transmitted.
Replacing SHA-1 with a password-storage hash would break this API contract.

`breach-check-service.test.ts` verifies that exact synthetic protocol vector and checks that the
request contains neither the password nor its complete digest. Password storage continues to
use Argon2id in `password-service.ts`, with independent hash/verification tests.

Dismiss only this specific alert as a false positive after reviewing the trace and the tests.
Do not suppress `js/insufficient-password-hash` across the repository, change stored password
hashes or remove the breach check to silence the finding. A new alert in actual password-storage
code needs a separate security review.

## Compatibility

No datastore migration or key rotation is needed. Queue status, retry counts and response
schemas are unchanged; exception text is replaced with a fixed public message. Legacy Router
TLS bypass variables should remain false. For private HTTPS certificates, configure
`HIVE_ROUTER_IAM_CA_CERT_PATH` and `HIVEMEM_CA_CERT_PATH`; development no longer bypasses
certificate validation.
