# Decision 0001: Workspace Isolation Strategy

Date: 2026-05-28
Status: Accepted

## Decision

HiveMem will keep the current Option A workspace model for Phase 4: memory, session, conclusion, queue, webhook, and workspace records stay in global Qdrant collections and use indexed `workspace_id` payload filters for isolation. Workspace membership and policy checks are enforced in the API layer.

This is not treated as a permanent ceiling. The workspace export/import format added in Phase 4 is the migration bridge if a future deployment needs per-workspace collections or Qdrant tenant keys.

## Options Considered

| Option | Isolation | Operational Cost | Query Cost | Migration Risk | Notes |
| --- | --- | --- | --- | --- | --- |
| Option A: indexed `workspace_id` | API-enforced, indexed payload filter | Low: collection count remains `2 shared + 2 per agent + metadata` | One indexed filter added to existing queries | Low | Current model; simplest for small/medium standalone deployments. |
| Per-workspace collections | Stronger physical separation | High: collection count grows by `workspace * agent * type` | Fewer payload filters, more collection fanout | Medium | Better hard isolation, but expensive for many workspaces/agents. |
| Qdrant tenant keys/shards | Stronger logical tenancy | Medium/High: requires tenant-aware collection/index design | Potentially efficient with tenant indexes | High | Promising future path, but needs benchmark work against target Qdrant version. |

## Benchmark Data

The Phase 4 implementation keeps workspace filtering on payload indexes already created for `workspace_id` across memory, session, conclusion, queue, webhook, and archive collections. The existing CI-friendly eval remains deterministic and does not require Qdrant, so this decision uses operational growth and deployed metrics as the benchmark inputs available in this repository:

| Scenario | Option A Collections | Per-Workspace Collections | Expected Impact |
| --- | ---: | ---: | --- |
| 10 agents, 5 workspaces | 22 live memory collections | 100 live memory collections | Option A avoids 78 collections and their payload/vector indexes. |
| 50 agents, 20 workspaces | 102 live memory collections | 2,000 live memory collections | Option A avoids collection-management overhead that dominates standalone deployments. |
| Deployed health/metrics smoke | Qdrant `list_collections` p95 observed in low milliseconds during deploy smoke | Not measured | Current collection shape is operationally cheap on the target host. |

Before moving to per-workspace collections or Qdrant tenant keys, run a dedicated benchmark with representative workspace count, agent count, memory count, search fanout, and prune/export workloads. The migration should preserve this Phase 4 export bundle as the neutral transfer format.

## Migration Path

1. Keep writing `workspace_id` on every workspace-scoped record.
2. Use `GET /v1/admin/workspaces/{workspace_id}/export` to create portable workspace bundles without webhook secrets.
3. Add a new importer that maps each bundle to the target physical layout, either per-workspace collections or tenant-keyed collections.
4. Dual-write new records to Option A and the target layout during a validation window.
5. Compare search/context/chat results, queue behavior, audit history, and dashboard counts.
6. Switch reads per workspace once parity is proven, then retire Option A records after backup retention.

## Consequences

- Workspace membership and policy are first-class API records, but Qdrant remains a shared backend.
- Access checks must stay close to every workspace-aware route.
- Export/import is the safety valve for stronger isolation, staging hydration, and future data residency work.
