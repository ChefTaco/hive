# Embermend integration

Embermend 0.3.0 is an optional product in the signed 3.6.0 combination.
Existing release profiles do not select it. The
API and durable worker use the same exact image; PostgreSQL 18 is private.
Selecting it requires a reviewed Magnus release declaring `embermendProtocol: 1`
in the signed manifest, version 2.5.0 or newer, and co-located Oathweave, HiveXUI,
worker and datastore components. The API is available through `/api/embermend`.

`./hive.sh --release latest` offers Embermend after selecting local Magnus or
explicitly configuring an existing external Magnus. Its versioned bridge must
be admitted; no second Magnus is installed for the external selection.
The default is no, including the full profile. Selecting yes adds the API,
worker and private PostgreSQL with their local dependencies. Unattended setup
selects the same components in a custom installation configuration. Selection
does not grant target access or enable mutation. A version number alone, including
existing Magnus 2.4 releases without the bridge, is insufficient. Published
signed manifests stay unchanged; release inputs must explicitly declare the
reviewed protocol after prerequisite capability acceptance.

Fresh initialization creates the browser audience/client and distinct machine
clients for the coordinator and verifier. Their permission ceilings omit approval,
recovery, merge, publication and deployment authority. No target/application
grant or standing mutation policy is created. Readiness reports missing admitted
targets explicitly. Product setup must register exact application/target grants
on both sides of the constrained Magnus bridge before assessment can begin.

The product owns its schema migration and exact-history verifier. The suite
initialization/upgrade journal runs those signed image commands before activation;
its generic stopped-store backup and restore path covers the private datastore.
The reference acceptance ledger retains the combined-store and signed-installation
restore demonstrations. Existing installations still require their own verified
backup and isolated rehearsal before upgrade. Embermend 0.3.0 adds the migration
`20261112000000_audit_export`, so the upgrade to suite 3.6.0 of an installation with
Embermend needs `--allow-migrations`.

Ardent loads the Embermend-owned plugin with a scoped resource-token provider.
Its coordinator client can read evidence, request assessment and isolated
preparation, and propose/publish recommendations. Broadening service or operator
grants and enabling mutation require a separate explicit policy decision.
Cindertrace, messaging, memory and skills remain optional.

See [Embermend's acceptance ledger](https://github.com/ChefTaco/Embermend/blob/main/docs/ACCEPTANCE.md)
for the AC-01–AC-24 reference journeys and explicit coverage limits. Production
starts with scoped inventory and assessment, with mutation policies disabled.
An empty findings list or a healthy container does not establish full assessment
coverage. After reviewed profile setup, remove temporary `policy` permission and
recreate API and worker through the owning installer; a restart does not reload
Compose environment files. Verify both effective grants.
