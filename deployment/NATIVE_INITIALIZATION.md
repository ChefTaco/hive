# Product-owned native profile initialization

Native agents remain opt-in and run under the selected existing unprivileged
account. Hive requires an existing profile directory, a protected environment-file
reference, a pinned artifact, and explicit operator authorization. It does not
perform provider login, replace credentials, create host users or install an
inference service.

A signed native artifact may supply `initializationArguments` and
`verificationArguments` together. Both are nonempty argument arrays executed by
the verified artifact's launcher. `@PROFILE@`, `@ENV_FILE@` and artifact-relative
placeholders use the existing literal argument transport; they are never shell
expressions. Missing verification, invalid argument types, newlines and NUL bytes
fail release validation.

The current initialization boundary permits an owning product to create its
missing private runtime directories while preserving every existing profile file,
credential, configuration file and artifact byte. Hermes supplies
`--native-init-profile` and a separate read-only `--native-verify-profile` contract.
Other native products keep their standalone setup until they provide an explicit
compatible owner contract. Initialization cannot silently seed or rewrite files.

Hive records a protected preparation receipt containing the exact artifact,
profile, argument specification and pre-initialization file fingerprints. It first
tries the read-only verifier so an already initialized profile is not mutated.
When initialization is needed, Hive durably records a mutation claim before
invoking the owner command. Successful completion still requires the exact
read-only verifier and unchanged existing files before launch or acceptance.

A prepared receipt proves no mutation was attempted and can proceed with its
original inputs. A claimed receipt has an unknown outcome: retry runs only the
verifier. Hive never reruns the initializer to guess whether a failed command
committed. Changed uncertain inputs, incomplete state or failed verification hold
that agent for product-owned recovery. Preserve receipts and profiles; do not
remove the journal to force a retry or reset credentials.

Verified receipts are tied to their exact artifact/profile specification. Later
normal runtime files do not cause initialization to replay. Repeated staging runs
the owner verifier again and checks that verification itself changes no profile,
credential or artifact bytes. Each staged launch and acceptance requires its
matching verified initialization specification. Operator/provider authorization
remains a separate requirement.

Native commands receive no controller stdin and run with bounded timeouts and
protected diagnostics. Failed commands retain their evidence outside Git. Agent
backups remain installation-bound; profile scans refuse external model assets
rather than copying or deleting them.
