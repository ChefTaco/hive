import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { z } from 'zod';
import { externalProduct, productId, setupItemId, setupItemUpdate, syncRequest } from './schema.js';
import { findSecret } from './secrets.js';
import { Conflict, Missing, type RegistryStore } from './store.js';
import { historyView, privateConnection, privateInstallation, privateProduct, publicConnection, publicInstallation, publicProduct, publicProductVisible } from './views.js';

export type AppOptions = { store: RegistryStore; installation: string; readToken: string; writeToken: string; readOnly: boolean; log?: (line: string) => void };
type Access = 'public' | 'read' | 'write' | 'invalid';
type Reply = { status: number; body: unknown; headers?: Record<string, string> };

const maximumBody = 1024 * 1024;
const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const matches = (value: string, expected: string): boolean => timingSafeEqual(hash(value), hash(expected));
const failure = (status: number, code: string, message: string, headers?: Record<string, string>): Reply => ({ status, body: { error: { code, message } }, ...(headers ? { headers } : {}) });
const notFound = (): Reply => failure(404, 'not_found', 'No such registry resource');

class HttpFailure extends Error {
  constructor(readonly reply: Reply) {
    super(reply.status.toString());
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maximumBody) throw new HttpFailure(failure(413, 'too_large', 'Request body is too large'));
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpFailure(failure(400, 'invalid_json', 'Request body must be JSON'));
  }
}

function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const secret = findSecret(value);
  // The path identifies the field for the operator. The value itself is never returned.
  if (secret) throw new HttpFailure(failure(422, 'secret_rejected', `The registry never stores credentials; refused field ${secret.slice(0, 200)}`));
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpFailure(failure(422, 'invalid_request', parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`).join('; ').slice(0, 800)));
  return parsed.data;
}

export function createApp(options: AppOptions): RequestListener {
  const { store } = options;

  function access(request: IncomingMessage): Access {
    const header = request.headers.authorization;
    if (!header) return 'public';
    const token = /^Bearer ([^ ,]+)$/.exec(header)?.[1];
    if (!token) return 'invalid';
    // Compare both so a request takes the same time whichever credential it holds.
    const read = matches(token, options.readToken);
    const write = matches(token, options.writeToken);
    return write ? 'write' : read ? 'read' : 'invalid';
  }

  function read(route: string[], url: URL, level: 'public' | 'read' | 'write'): Reply {
    const privileged = level !== 'public';
    if (route.length === 1 && route[0] === 'installation') {
      const installation = store.installation();
      return { status: 200, body: privileged ? privateInstallation(installation, options.installation, store) : publicInstallation(installation, options.installation, store) };
    }
    if (route.length === 1 && route[0] === 'history') {
      if (!privileged) return failure(401, 'credential_required', 'History requires a registry read credential');
      const after = z.coerce.number().int().min(0).catch(0).parse(url.searchParams.get('after') ?? 0);
      const limit = z.coerce.number().int().min(1).max(1000).catch(200).parse(url.searchParams.get('limit') ?? 200);
      return { status: 200, body: { schema: 1, entries: store.history(after, limit).map(historyView) } };
    }
    if (route[0] !== 'products') return notFound();
    if (route.length === 1) {
      const installedFilter = url.searchParams.get('installed');
      const items = store.products().filter((row) => privileged || publicProductVisible(row)).map((row) => {
        const installed = store.installedProduct(row.id);
        return privileged ? privateProduct(row, installed, store) : publicProduct(row, installed, store);
      }).filter((item) => (installedFilter === 'true' ? item.installed : installedFilter === 'false' ? !item.installed : true));
      return { status: 200, body: { schema: 1, products: items } };
    }
    const id = route[1];
    if (route.length > 3 || !id || !productId.safeParse(id).success) return notFound();
    const row = store.product(id);
    if (!row || (!privileged && !publicProductVisible(row))) return notFound();
    const installed = store.installedProduct(id);
    if (route.length === 2) return { status: 200, body: privileged ? privateProduct(row, installed, store) : publicProduct(row, installed, store) };
    if (route[2] !== 'connection') return notFound();
    return { status: 200, body: privileged ? privateConnection(row, installed) : publicConnection(row, installed) };
  }

  async function write(route: string[], method: string, request: IncomingMessage): Promise<Reply> {
    if (route.length === 1 && route[0] === 'sync' && method === 'POST') {
      const result = store.sync(validated(syncRequest, await readBody(request)));
      return { status: 200, body: { schema: 1, ...result } };
    }
    if (route.length === 3 && route[0] === 'setup' && route[1] === 'items' && method === 'PUT' && setupItemId.safeParse(route[2]).success) {
      const update = validated(setupItemUpdate, await readBody(request));
      return { status: 200, body: { schema: 1, ...store.updateSetupItem(route[2]!, update.status, 'hive.sh setup') } };
    }
    const id = route[1];
    if (route.length === 2 && route[0] === 'products' && id && productId.safeParse(id).success) {
      if (method === 'PUT') return { status: 200, body: { schema: 1, ...store.putExternal(id, validated(externalProduct, await readBody(request)), 'hive.sh registry') } };
      if (method === 'DELETE') return { status: 200, body: { schema: 1, ...store.deleteExternal(id, 'hive.sh registry') } };
    }
    return notFound();
  }

  async function dispatch(request: IncomingMessage): Promise<Reply> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://registry.invalid');
    if (url.pathname === '/health/live') return method === 'GET' ? { status: 200, body: { status: 'live' } } : failure(405, 'method_not_allowed', 'Use GET', { Allow: 'GET' });
    if (url.pathname === '/health/ready') {
      if (method !== 'GET') return failure(405, 'method_not_allowed', 'Use GET', { Allow: 'GET' });
      store.ready();
      return { status: 200, body: { status: 'ready', readOnly: options.readOnly } };
    }
    if (!url.pathname.startsWith('/v1/')) return notFound();
    const route = url.pathname.slice(4).split('/');
    const level = access(request);
    if (level === 'invalid') return failure(401, 'invalid_credential', 'Registry credential was not accepted');
    if (method === 'GET') return read(route, url, level);
    if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return failure(405, 'method_not_allowed', 'Method is not supported');
    if (level !== 'write') return failure(401, 'credential_required', 'Writes require the installer write credential');
    if (options.readOnly) return failure(503, 'read_only', 'This registry is a read-only rehearsal copy');
    return write(route, method, request);
  }

  return (request: IncomingMessage, response: ServerResponse): void => {
    void dispatch(request)
      .catch((error: unknown): Reply => {
        if (error instanceof HttpFailure) return error.reply;
        if (error instanceof Conflict) return failure(409, 'conflict', error.message);
        if (error instanceof Missing) return failure(404, 'not_found', error.message);
        options.log?.(JSON.stringify({ level: 'error', message: error instanceof Error ? error.message : 'unknown' }));
        return failure(500, 'internal', 'Registry request failed');
      })
      .then((reply) => {
        response.writeHead(reply.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...reply.headers });
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(reply.body));
        // Paths and status only: query strings and headers are never logged.
        options.log?.(JSON.stringify({ method: request.method, path: (request.url ?? '').split('?')[0], status: reply.status }));
      });
  };
}
