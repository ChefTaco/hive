---
name: hivemem
description: Use HiveMem as Hermes' durable semantic memory provider, including status checks, safe retrieval, and write-check diagnosis.
---

# HiveMem

HiveMem is the durable memory capability for this Hermes Agent. Prefer it when a task needs retained context across sessions, agents, or hosts.

## Confirm the provider before relying on it

Run `hermes hivemem status` to see the configured endpoint and provider. For a full live check, run:

```bash
hermes hivemem test --write-check
```

The write-check uses a disposable record and verifies write, search, and delete. Treat a status-only result as configuration evidence, not a proof that the agent can write memory.

## Use the plugin tools

When the HiveMem plugin is enabled, use its installed memory tools for store, retrieval, and maintenance. Keep memory scoped to the current agent/workspace and do not put credentials or raw secrets into a memory record.

If the provider is unavailable, report the failing command and endpoint. Do not silently replace HiveMem with an unrelated memory store.

## Common repair signal

If `hermes hivemem test --write-check` reports `memories:write scope is required`, the plugin is installed but its token is read-only or too narrowly scoped. Preserve the agent identity and update only the scoped HiveMem token through the normal Hive IAM flow.
