import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createOathweaveVerifier, OathweaveError, type OathweaveVerifier } from '@hivemagnus/hive-common/oathweave';
import { z } from 'zod';

/**
 * Oathweave sign-in for the inventory view. hive.sh writes `identity.json` beside the registry
 * credentials (config/hive-registry, mounted at /config); a registry without one accepts only
 * its shared credentials there. The file holds URLs and the audience, never a secret, so the
 * environment file the registry started with stays unchanged.
 */
export const INVENTORY_AUDIENCE = 'hive-registry';
export const INVENTORY_PERMISSION = 'registry:inventory';

const httpsUrl = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'Expected a plain https URL');
export const identityFile = z.strictObject({
  schema: z.literal(1),
  issuer: httpsUrl,
  jwksUrl: httpsUrl,
  userinfoUrl: httpsUrl,
  audience: z.literal(INVENTORY_AUDIENCE),
  // The installation's internal authority, which signs Oathweave's internal certificate.
  authorityFile: z.string().regex(/^\/config\/[A-Za-z0-9._-]+\.pem$/).optional(),
});
export type IdentityFile = z.infer<typeof identityFile>;

export function loadIdentity(path: string): IdentityFile | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = identityFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`Hive Registry identity file ${path} is not valid: ${parsed.error.issues.map((issue) => issue.path.join('.') || '$').join(', ')}`);
  return parsed.data;
}

/**
 * fetch over node:https with the internal authority. Node's global fetch takes no CA, and the
 * registry's environment (and so NODE_EXTRA_CA_CERTS) is fixed when it was first provisioned.
 * The authority is read per request, so one published after the registry started is used.
 */
export function authorityFetch(authorityFile: string | undefined): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.protocol !== 'https:') throw new TypeError('Only https is supported');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const ca = authorityFile && existsSync(authorityFile) ? readFileSync(authorityFile, 'utf8') : undefined;
    return await new Promise<Response>((resolve, reject) => {
      const outgoing = httpsRequest(url, { method: init?.method ?? 'GET', headers: Object.fromEntries(headers), ...(ca ? { ca } : {}), signal: init?.signal ?? undefined }, (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            incoming.destroy();
            reject(new Error('Identity response is too large'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') responseHeaders.set(name, value);
          resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 502, headers: responseHeaders }));
        });
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  }) as typeof fetch;
}

export type InventoryAuthorizer = (header: string) => Promise<{ ok: true } | { ok: false; status: number; code: string; message: string }>;

/** Checks a person's Oathweave token: audience hive-registry and the inventory permission. */
export function inventoryAuthorizer(verifier: OathweaveVerifier): InventoryAuthorizer {
  return async (header) => {
    try {
      const principal = await verifier.verifyAuthorization(header, { accept: 'user' });
      if (!principal.permissions.includes(INVENTORY_PERMISSION)) return { ok: false, status: 403, code: 'insufficient_permission', message: `The inventory needs ${INVENTORY_PERMISSION}` };
      return { ok: true };
    } catch (error) {
      if (error instanceof OathweaveError) return { ok: false, status: error.status, code: error.reason, message: error.message };
      return { ok: false, status: 503, code: 'identity_unavailable', message: 'Oathweave could not be reached' };
    }
  };
}

export function createInventoryAuthorizer(identity: IdentityFile): InventoryAuthorizer {
  return inventoryAuthorizer(createOathweaveVerifier({
    issuer: identity.issuer,
    audience: identity.audience,
    jwksUrl: identity.jwksUrl,
    userinfoUrl: identity.userinfoUrl,
    fetch: authorityFetch(identity.authorityFile),
  }));
}
