# Selectable fresh installations

Choose `custom` in interactive setup, or set `profile` to `custom` in the same
versioned installation JSON used for unattended execution. Fresh suite setup
requires Oathweave and its private Redis, HiveXUI and Caddy ingress. The wizard
adds that foundation when the operator selects individual products. A prepared
standalone product deployment can still use its independent owning setup tools.

Emberpath, HiveMem and HiveSkills are optional. HiveMem requires its own co-located
Qdrant instance. Optional full-profile products keep their documented independent
PostgreSQL/Redis stores and signed migration contracts. Orphaned datastores,
missing foundation components, unknown products and unsupported placements fail
before initialization writes configuration.

Only selected products receive configuration, account IDs, public browser client
grants or ingress endpoint references. HiveXUI's public runtime lists those
products only; disabled modules show their unconfigured state. Unselected product
API paths cannot receive a shared credential from ingress. The model client API
and memory API remain separate even when only one is selected.

Oathweave's coordinated actor enrollment currently requires both Emberpath and
HiveMem. When either is absent, fresh setup omits the coordinator configuration
and browser installation namespace rather than inventing an unavailable endpoint.
Individual IAM service-account operations remain product-owned. Existing native
Oathweave machine-client bootstrap behavior is preserved.

For multiple host inventories, configure a verified HTTPS endpoint for every
selected API product and a trust bundle on each host. Do not add endpoint entries
for products that are not selected. Emberpath alone requires its additional,
distinct model-client HTTPS origin. Datastores remain private to their product's
host; ingress and static HiveXUI stay together.

Repeating initialization checks its original immutable inputs and preserves every
credential, account ID and protected artifact. Changing the product selection of
an existing installation is a lifecycle change, not permission to overwrite its
initialization receipt or reseed products. Retain the installation's backups and
prepare a separately reviewed adoption or migration workflow.

Inference services, hosted providers, containers, model files and storage remain
external dependencies for all selections. A custom profile never installs them.
