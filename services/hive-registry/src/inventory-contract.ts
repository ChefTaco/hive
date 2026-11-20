// Hive Registry inventory contract: GET /v1/inventory, what an installation's administrator may
// read through the ingress at /api/registry with an Oathweave token for the hive-registry
// audience that carries registry:inventory. HiveXUI vendors this file unchanged, with its
// checksum and the Hive revision recorded beside it. It imports only zod, never the service.
//
// Unlike the public browser contract, this one carries versions, image digests and inventory
// host names: the signed release's pins beside what each host reports it runs. It carries no
// internal endpoint, credential or path. Objects are not strict, so a field a newer registry
// adds is dropped on parsing rather than refused.
import { z } from 'zod';

export const registryInventoryContractVersion = 1;

const name = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const version = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const image = z.string().regex(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/).max(512);
const runningImage = z.string().regex(/^[a-zA-Z0-9./:_@-]+$/).max(512);
const timestamp = z.iso.datetime();

/** A version and image the signed release pins. */
export const registryInventoryPinSchema = z.object({
  version: version.nullable(),
  image,
  imageDigest: digest,
});
export type RegistryInventoryPin = z.infer<typeof registryInventoryPinSchema>;

/**
 * One product of the release catalog, or one an operator recorded by hand (`source: external`).
 * `status` is what the registry recorded: `installed` and `activating` run on `inventoryHost`;
 * `external` is a release product this installation uses but does not run (an external Magnus);
 * `not-installed` is offered by the release and not selected.
 *
 * `pinned` is the signed release's pin. For a product the installation runs it is the version and
 * image recorded at activation; otherwise the pin from the active release's manifest a host
 * keeps, or null when neither is known. `recorded` is what an operator recorded for an externally
 * managed product (`source: external`), which no signed release pins.
 */
export const registryInventoryComponentSchema = z.object({
  id: name,
  displayName: z.string().min(1).max(120),
  kind: z.string().max(32),
  source: z.enum(['release', 'external']),
  status: z.enum(['installed', 'activating', 'external', 'not-installed']),
  inventoryHost: name.nullable(),
  pinned: registryInventoryPinSchema.nullable(),
  recorded: z.object({ version: version.nullable(), imageDigest: digest.nullable() }).nullable(),
});
export type RegistryInventoryComponent = z.infer<typeof registryInventoryComponentSchema>;

/**
 * One service as Docker on its host reports it. `image` is the reference the deployment names
 * (the signed pin); `runningImage` is the container's configured image and `imageId` the local
 * image it actually runs. `imageMatches` is true only when the container runs the deployed
 * reference and its local image is that reference's image.
 */
export const registryInventoryServiceSchema = z.object({
  service: name,
  image: image.nullable(),
  runningImage: runningImage.nullable(),
  imageId: digest.nullable(),
  imageMatches: z.boolean(),
  state: z.string().max(32),
  health: z.string().max(32),
});
export type RegistryInventoryService = z.infer<typeof registryInventoryServiceSchema>;

/**
 * One host, as hive.sh last observed it. `receipt` is the signed release that host activated
 * (version and manifest digest); `catalog` the pins in that release's manifest, as the host keeps
 * it. `unreachable` means hive.sh could not reach it.
 */
export const registryInventoryHostSchema = z.object({
  host: name,
  active: z.boolean(),
  unreachable: z.boolean(),
  receipt: z.object({ version, digest: hex64 }).nullable(),
  transactionPhase: z.string().max(48).nullable(),
  catalog: z.array(z.object({ id: name, version: version.nullable(), image })).max(256).nullable(),
  services: z.array(registryInventoryServiceSchema).max(256),
});
export type RegistryInventoryHost = z.infer<typeof registryInventoryHostSchema>;

/** GET /v1/inventory. `observedAt` is null until hive.sh records its first observation. */
export const registryInventorySchema = z.object({
  schema: z.literal(1),
  installationId: name,
  release: z.object({ version, manifestDigest: hex64 }).nullable(),
  phase: z.enum(['activating', 'complete']).nullable(),
  observedAt: timestamp.nullable(),
  components: z.array(registryInventoryComponentSchema).max(512),
  hosts: z.array(registryInventoryHostSchema).max(64),
});
export type RegistryInventory = z.infer<typeof registryInventorySchema>;
