import { z } from 'zod';
import { iamHealthPayloadSchema, memoryHealthPayloadSchema } from './service-health.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HiveClientOptions {
  baseUrl: string;
  bearerToken?: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
}

export const iamUserSummarySchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  username: z.string(),
  displayName: z.string().nullable().optional(),
  active: z.boolean().optional(),
  roles: z.array(z.unknown()).optional(),
}).passthrough();

export const iamRoleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string().optional(),
  permissions: z.array(z.string()).optional(),
}).passthrough();

export const iamServiceAccountSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean().optional(),
  roles: z.array(z.unknown()).optional(),
}).passthrough();

export const memorySearchResultSchema = z.object({
  memories: z.array(z.record(z.string(), z.unknown())).default([]),
}).passthrough();

export type IamUserSummary = z.infer<typeof iamUserSummarySchema>;
export type IamRoleSummary = z.infer<typeof iamRoleSummarySchema>;
export type IamServiceAccountSummary = z.infer<typeof iamServiceAccountSummarySchema>;
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function clientFetch(options: HiveClientOptions): FetchLike {
  return options.fetch ?? globalThis.fetch.bind(globalThis);
}

async function requestJson<T>(options: HiveClientOptions, path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
  if (options.bearerToken) headers.set('authorization', `Bearer ${options.bearerToken}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const response = await clientFetch(options)(joinUrl(options.baseUrl, path), { ...init, headers });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return schema.parse(await response.json());
}

export function createIamServiceClient(options: HiveClientOptions) {
  return {
    health() {
      return requestJson(options, '/api/v1/health/ready', iamHealthPayloadSchema);
    },
    users(limit = 100) {
      return requestJson(options, `/api/v1/users?limit=${limit}`, z.object({
        users: z.array(iamUserSummarySchema),
        total: z.number().int().nonnegative().optional(),
      }).passthrough());
    },
    roles() {
      return requestJson(options, '/api/v1/roles', z.object({ roles: z.array(iamRoleSummarySchema) }).passthrough());
    },
    serviceAccounts() {
      return requestJson(options, '/api/v1/service-accounts', z.object({ serviceAccounts: z.array(iamServiceAccountSummarySchema) }).passthrough());
    },
  };
}

export function createMemoryServiceClient(options: HiveClientOptions) {
  return {
    health() {
      return requestJson(options, '/v1/health/ready', memoryHealthPayloadSchema);
    },
    memories(limit = 50) {
      return requestJson(options, `/v1/memories?limit=${limit}`, z.object({
        memories: z.array(z.record(z.string(), z.unknown())).default([]),
      }).passthrough());
    },
    search(body: { query: string; limit?: number; workspace_id?: string }) {
      return requestJson(options, '/v1/memories/search', memorySearchResultSchema, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    queueJobs(limit = 50) {
      return requestJson(options, `/v1/queue/jobs?limit=${limit}`, z.object({
        jobs: z.array(z.record(z.string(), z.unknown())).default([]),
      }).passthrough());
    },
    agents() {
      return requestJson(options, '/v1/agents', z.object({
        agents: z.array(z.record(z.string(), z.unknown())).default([]),
      }).passthrough());
    },
  };
}
