# Native user services

Select `service: "user"` for an explicitly authorized native agent to use its
existing account's systemd user manager. Hive checks that manager before staging.
It does not create a user bus, enable lingering, modify a system service, replace
an existing unrelated unit, or authorize a provider login. Use `service: "none"`
when the operator supplies a different supervisor.

`hive.sh status` reports current `serviceState` independently of historical
`accepted` and `acceptedAt`. User-service states are `active`, `inactive`, `failed`
or `unavailable`. An inaccessible bus, absent unit or transitional state is
`unavailable`; manual supervision reports `manual`. Stopping a service preserves
its previous acceptance receipt, while its current state becomes `inactive`.
Run explicit product acceptance again after restarting or changing the runtime.
Status reads only the exact unit's load and active properties. It never reads the
manager environment or returns infrastructure credentials or private unit paths.

## Disposable acceptance

```bash
npm run test:suite:agents -- \
  --artifact PRIVATE_REVIEWED_NATIVE_DESCRIPTOR \
  --server-image EXACT_LOCAL_API_IMAGE_ID \
  --output NEW_PRIVATE_EVIDENCE_DIRECTORY \
  --user-service
```

This optional developer proof requires an available, existing ordinary account's
user manager. It rejects existing paths or units with its randomly generated name,
unsafe directory ownership, and an existing unit directory whose permissions would
need changing. It creates only a uniquely named synthetic unit, its enablement
link, a fresh private native profile and disposable API/database services. It
retains the exact reviewed native archive digest and preserves profile credentials.

The real Bash adapters stage the agent, reject an unavailable user bus before
staging, start and enable its own service, and verify authenticated health and a
recent accepted heartbeat. The proof stops the service, verifies current CLI state
without losing historical acceptance, restarts it through the Bash activation path
and repeats product acceptance. It checks the new systemd invocation, unchanged
native identity, a real authenticated read-only job and duplicate dispatch refusal.
The launcher keeps its private umask and excludes unrelated installer credentials.

Cleanup stops and disables only the exact synthetic unit, checks the recorded unit
content before removal, removes its own enablement and new empty directories, and
verifies existing unit files and enablement names remain unchanged. Protected
recovery evidence remains in the new output directory. A changed unit is held for
explicit ownership review rather than removed by guessing. No existing unit,
profile, account, manager environment or external inference service is selected.

This is one physical host and one already running user manager. It does not prove
machine boot, lingering, another account's service manager, ARM64 hardware or
persistent production gateway operation. Those require their own selected-host
acceptance and explicit host-maintenance decisions.
