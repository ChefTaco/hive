import { z } from 'zod';

// Everything the registry stores is described here. Objects are strict, so a field
// the API does not know about is refused rather than stored and later exposed.
export const productId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const label = z.string().min(1).max(120);
const description = z.string().max(500);
const version = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const image = z.string().regex(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/).max(512);
const localPath = z.string().regex(/^\/[A-Za-z0-9._~/-]*$/).max(256).refine((value) => !value.split('/').includes('..'));

function safeUrl(protocols: string[]) {
  return z.string().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return protocols.includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }, 'Expected a plain URL without credentials or a query');
}
const publicUrl = safeUrl(['https:']);
const internalUrl = safeUrl(['https:', 'http:']);

const links = z.strictObject({
  repository: publicUrl.nullable().default(null),
  documentation: publicUrl.nullable().default(null),
  license: publicUrl.nullable().default(null),
  licenseSpdx: z.string().regex(/^[A-Za-z0-9.+-]{1,64}$/).nullable().default(null),
});

export const connection = z.strictObject({
  consolePath: localPath.nullable().default(null),
  browserPrefix: localPath.nullable().default(null),
  nativeApis: z.record(productId, publicUrl).default({}),
  internalEndpoints: z.record(productId, internalUrl).default({}),
});
export type Connection = z.infer<typeof connection>;

export const releaseKinds = ['application', 'datastore', 'static-ui', 'ingress'] as const;

export const catalogEntry = z.strictObject({
  id: productId,
  kind: z.enum(releaseKinds),
  displayName: label,
  description,
  links,
  consoleSection: productId.nullable(),
  required: z.boolean(),
  dependencies: z.array(productId).max(32),
  version: z.strictObject({ version, image, imageDigest: digest, storageFormat: z.string().max(128).nullable() }),
});
export type CatalogEntry = z.infer<typeof catalogEntry>;

export const installedEntry = z.strictObject({
  id: productId,
  inventoryHost: productId,
  version,
  image,
  imageDigest: digest,
  status: z.enum(['activating', 'installed']),
  connection,
});
export type InstalledEntry = z.infer<typeof installedEntry>;

export const syncRequest = z.strictObject({
  schema: z.literal(1),
  phase: z.enum(['begin', 'complete']),
  operation: z.enum(['install', 'upgrade', 'rollback', 'adopt', 'restore', 'rehearse']),
  actor: label,
  installation: z.strictObject({ id: productId, origin: publicUrl, profile: z.enum(['core', 'full', 'custom']) }),
  release: z.strictObject({ version, manifestDigest: hex64, planDigest: hex64 }),
  catalog: z.array(catalogEntry).min(1).max(256),
  installed: z.array(installedEntry).max(256),
}).superRefine((value, context) => {
  const offered = new Set(value.catalog.map((entry) => entry.id));
  if (offered.size !== value.catalog.length) context.addIssue({ code: 'custom', message: 'Duplicate catalog product' });
  const names = value.installed.map((entry) => entry.id);
  if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', message: 'Duplicate installed product' });
  for (const name of names) if (!offered.has(name)) context.addIssue({ code: 'custom', message: 'Installed product is not in the catalog' });
});
export type SyncRequest = z.infer<typeof syncRequest>;

// An externally managed product: the operator adds it, the release does not own it.
// It stays out of the unauthenticated view unless `public` is set explicitly.
export const externalProduct = z.strictObject({
  displayName: label,
  description: description.default(''),
  links: links.default({ repository: null, documentation: null, license: null, licenseSpdx: null }),
  consoleSection: productId.nullable().default(null),
  dependencies: z.array(productId).max(32).default([]),
  public: z.boolean().default(false),
  inventoryHost: productId.nullable().default(null),
  version: version.nullable().default(null),
  imageDigest: digest.nullable().default(null),
  connection: connection.default({ consolePath: null, browserPrefix: null, nativeApis: {}, internalEndpoints: {} }),
});
export type ExternalProduct = z.infer<typeof externalProduct>;
