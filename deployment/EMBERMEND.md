# Embermend integration

Embermend is an optional product in a future signed release that explicitly
includes its runtime image. Existing release profiles do not select it. The
API and durable worker use the same exact image; PostgreSQL 18 is private.
Selecting it requires compatible Magnus 2.4+ and co-located Oathweave, HiveXUI,
worker and datastore components. The API is available through `/api/embermend`.

Fresh initialization creates the browser audience/client and distinct machine
clients for the coordinator and verifier. Their permission ceilings omit approval,
recovery, merge, publication and deployment authority. No target/application
grant or standing mutation policy is created. Readiness reports missing admitted
targets explicitly. Product setup must register exact application/target grants
on both sides of the constrained Magnus bridge before assessment can begin.

The product owns its schema migration and exact-history verifier. The suite
initialization/upgrade journal runs those signed image commands before activation;
its generic stopped-store backup and restore path covers the private datastore.
A retained combined restore rehearsal and full product acceptance are still
required before an Embermend release may be signed or installed for fleet use.

Ardent loads the Embermend-owned plugin with a scoped resource-token provider.
Its coordinator client can read evidence, request assessment and isolated
preparation, and propose/publish recommendations. Broadening service or operator
grants and enabling mutation require a separate explicit policy decision.
Cindertrace, messaging, memory and skills remain optional.

The source integration is a development preview. See Embermend's acceptance
ledger for unsupported capabilities; do not interpret a running container or a
synthetic UI fixture as completed remediation acceptance.
