// Hive Registry browser contract: what an unauthenticated browser may read through the ingress
// at /api/registry. HiveXUI vendors this file unchanged as contracts/hive-registry/browser.ts, with
// its checksum and the Hive revision recorded beside it. It imports only zod, never the service.
//
// Objects are not strict: a field this contract does not name is dropped on parsing, so a version,
// digest, host or internal endpoint can never reach the browser, even if a future response
// carried one. Capability names the contract does not know are dropped the same way.
import { z } from 'zod';

export const registryBrowserContractVersion = 2;

const productId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const localPath = z
  .string()
  .regex(/^\/[A-Za-z0-9._~/-]*$/)
  .max(256)
  .refine((value) => !value.split('/').includes('..'));
const publicUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }, 'Expected a plain HTTPS URL without credentials or a query');

/** GET /health/ready */
export const registryHealthSchema = z.object({
  status: z.literal('ready'),
  readOnly: z.boolean(),
});

/** GET /v1/installation */
export const registryInstallationSchema = z.object({
  schema: z.literal(1),
  id: productId,
  products: z.array(productId).max(512),
});
export type RegistryInstallation = z.infer<typeof registryInstallationSchema>;

/**
 * A product's optional capabilities. Each `path` is relative to the product's `browserPrefix`
 * (GET /v1/products/{id}/connection) as the browser sees it: the browser fetches
 * `browserPrefix + path`, and the ingress maps that to the product's own route. A product
 * without any capability omits the field.
 *
 * `events.v1`: the product serves a HiveEvent v1 feed, `GET browserPrefix + path?after=&limit=`.
 */
export const registryCapabilitiesSchema = z.object({
  'events.v1': z.object({ path: localPath }).optional(),
});
export type RegistryCapabilities = z.infer<typeof registryCapabilitiesSchema>;

/** GET /v1/products/{id} */
export const registryProductSchema = z.object({
  id: productId,
  displayName: z.string().min(1).max(120),
  description: z.string().max(500),
  links: z.object({
    repository: publicUrl.nullable(),
    documentation: publicUrl.nullable(),
    license: publicUrl.nullable(),
    licenseSpdx: z.string().regex(/^[A-Za-z0-9.+-]{1,64}$/).nullable(),
  }),
  consoleSection: productId.nullable(),
  required: z.boolean(),
  installed: z.boolean(),
  dependencies: z.array(productId).max(32),
  capabilities: registryCapabilitiesSchema.optional(),
});
export type RegistryProduct = z.infer<typeof registryProductSchema>;

/** GET /v1/products and GET /v1/products?installed=true */
export const registryProductListSchema = z.object({
  schema: z.literal(1),
  products: z.array(registryProductSchema).max(512),
});

/** GET /v1/products/{id}/connection */
export const registryConnectionSchema = z.object({
  id: productId,
  consolePath: localPath.nullable(),
  browserPrefix: localPath.nullable(),
  nativeApis: z.record(productId, publicUrl),
  documentation: publicUrl.nullable(),
  capabilities: registryCapabilitiesSchema.optional(),
});
export type RegistryConnection = z.infer<typeof registryConnectionSchema>;
