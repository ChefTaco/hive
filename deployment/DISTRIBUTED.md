# Distributed fresh core setup

The core initializer supports one installation spread across host inventories.
Each host has its own Compose project, deployment ownership UUID, transaction
journal, backup and restore rehearsal. Independent installations need separate
inventories; never share their databases, accounts, credentials or recovery files.

Use `./hive.sh` and select configuration mode `distributed`, or supply the same
versioned JSON configuration with `bootstrap.productEndpoints`. Select the host
for each core product. The wizard keeps Oathweave's Redis and HiveMem's Qdrant on
their product's host. Ingress and static HiveXUI remain together on the console
host. Every inventory host must have a selected component.

The endpoint object must contain `oathweave`, `emberpath`, `hivemem` and
`hiveskills`. Each entry contains:

```json
{
  "origin": "https://identity.example.com:4200",
  "bindAddress": "192.0.2.10",
  "certificateFile": "/opt/certificates/product.crt",
  "privateKeyFile": "/opt/certificates/product.key"
}
```

Emberpath additionally requires `inferenceOrigin`, using a distinct HTTPS port
and the same certificate hostname as its administration origin. This preserves
the separate native model client plane. The target ports inside the containers
remain the products' owned ports; Hive publishes only these explicitly selected
TLS listeners. Database listeners are never published.

`bootstrap.trustBundleFile` names a PEM trust bundle available at the configured
absolute path on **every** inventory host. Product certificate/key references
refer to files on the product's owning host. The existing console certificate/key
references refer to files on the console host. Prepare certificate renewal,
firewall rules and verified SSH trust before installation. Configuration does not
install an overlay network, replace certificates or turn off TLS verification.

`init` preflights every host before creating configuration. The identity host
creates a protected initialization receipt and fresh account IDs; other hosts
receive only the account IDs needed for explicit product links. Each host creates
its products' independent credentials locally. Identity passwords, session keys
and database credentials are not copied to the console or another product host.
Repeated initialization verifies the exact plan, certificate bytes and generated
configuration, preserving credentials and account IDs. Changed files require
reviewed recovery; they are never overwritten to force a retry.

Caddy uses the explicit HTTPS origins for backend requests. Product resource
verifiers use the configured Oathweave HTTPS origin for JWKS and online session
checks. Compose DNS names are used only for co-located private datastores. All
browser API paths remain on the console origin. No shared administrator credential
is supplied by ingress.

The original `fresh` mode remains available for a co-located core installation,
with private product certificates generated for its local Compose network.
Full-profile fresh configuration and additional product setup have separate
product migration and enrollment contracts; selecting `full` does not imply that
all those acceptance gates have passed.

## Developer evidence

`npm run test:suite:distributed-core -- --output NEW_PRIVATE_DIRECTORY
--template-release REVIEWED_CORE_FIXTURE_MANIFEST` uses the reviewed core image
contracts and local candidate images. It creates an ephemeral local registry and
publisher key, two strictly pinned SSH targets, and separate actual product
Compose projects on one developer machine. It verifies fresh configuration,
interrupted activation and held writers, exact retry and repeated execution,
four-product Authorization Code with PKCE access, wrong-audience rejection,
online revocation, and independent host-bound backup/restore rehearsals.

This proof has passed on one physical AMD64 machine. It exercises real SSH,
separate bridge networks and verified HTTPS between the inventories; it does not
certify physical multi-machine routing, an ARM64 host, or a production migration.
The fixture never selects an existing deployment or inference service. All model
runtimes and model storage remain external to Hive.
