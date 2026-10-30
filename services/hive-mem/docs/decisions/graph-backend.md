# Graph Backend Decision

Date: 2026-05-28

## Decision

HiveMem keeps Qdrant as the local-first default for graph memory by storing `_entities` and `_relations` as payload-only Qdrant collections. This preserves the single-service development path, uses the existing backup/deploy story, and avoids requiring a second database for small and medium installations.

## External Backend Option

`HIVEMEM_GRAPH_BACKEND` is introduced as an architecture switch. The default is `qdrant`; future supported values can map to Kuzu for embedded local analytics or to Neo4j, FalkorDB, or Memgraph for production graph workloads. `HIVEMEM_GRAPH_EXTERNAL_URL` is reserved for the external backend connection endpoint.

## Scaling Path

Use the Qdrant collections while graph operations are neighborhood-oriented: entity pages, memory-local graph visualization, graph-assisted retrieval, and temporal edge filtering. Move relation traversal to an external graph backend when workloads need deep traversals, centrality/path algorithms, high-cardinality relation queries, or cross-workspace graph analytics. Qdrant remains the vector store in every path.
