#!/usr/bin/env node --experimental-strip-types
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { z } from '../services/hive-router/node_modules/zod/index.js';
import type { ContextResponse, MemoryRecord } from '../services/hive-mem/sdks/typescript/src/types.ts';

const baseUrl = z.string().url().refine((raw) => {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
const configSchema = z.object({
  adminUrl: baseUrl, apiUrl: baseUrl, memoryUrl: baseUrl,
  username: z.string().min(1), password: z.string().min(1), memoryToken: z.string().min(1),
  providerUrl: baseUrl, model: z.string().trim().min(1),
  providerKind: z.enum(['LLAMACPP', 'OPENAI_GENERIC', 'OPENAI', 'OPENROUTER', 'VLLM']).default('LLAMACPP'),
  authMode: z.enum(['NONE', 'BEARER', 'API_KEY', 'HEADER']).default('NONE'),
  providerToken: z.string().optional(), authHeader: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).default('Authorization'),
  timeoutMs: z.coerce.number().int().min(1000).max(300000).default(90000),
  maxTokens: z.coerce.number().int().min(64).max(4096).default(512),
});
export type ModelE2eConfig = z.infer<typeof configSchema>;
const fields = {
  adminUrl: 'HIVE_E2E_ADMIN_URL', apiUrl: 'HIVE_E2E_API_URL', memoryUrl: 'HIVE_E2E_MEMORY_URL',
  username: 'HIVE_E2E_USERNAME', password: 'HIVE_E2E_PASSWORD', memoryToken: 'HIVE_E2E_MEMORY_TOKEN',
  providerUrl: 'HIVE_E2E_PROVIDER_URL', model: 'HIVE_E2E_MODEL', providerKind: 'HIVE_E2E_PROVIDER_KIND',
  authMode: 'HIVE_E2E_PROVIDER_AUTH_MODE', providerToken: 'HIVE_E2E_PROVIDER_TOKEN', authHeader: 'HIVE_E2E_PROVIDER_AUTH_HEADER',
  timeoutMs: 'HIVE_E2E_TIMEOUT_MS', maxTokens: 'HIVE_E2E_MAX_TOKENS',
} as const;

export function readModelE2eConfig(env: NodeJS.ProcessEnv): ModelE2eConfig {
  const parsed = configSchema.safeParse(Object.fromEntries(Object.entries(fields).map(([key, variable]) => [key, env[variable]])));
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => fields[issue.path[0] as keyof typeof fields]))];
    throw new Error(`Missing or invalid configuration: ${names.join(', ')}`);
  }
  const config = parsed.data;
  if (config.authMode !== 'NONE' && !config.providerToken) throw new Error('HIVE_E2E_PROVIDER_TOKEN is required for provider authentication');
  if (config.authMode === 'NONE' && config.providerToken) throw new Error('Set HIVE_E2E_PROVIDER_AUTH_MODE when supplying HIVE_E2E_PROVIDER_TOKEN');
  for (const field of ['adminUrl', 'apiUrl', 'memoryUrl', ...(config.authMode !== 'NONE' ? ['providerUrl'] as const : [])] as const) {
    const url = new URL(config[field]);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error(`${fields[field]} must use HTTPS for credentialed requests outside loopback`);
    }
  }
  return config;
}

class CheckError extends Error {
  readonly status: number | undefined;
  constructor(status?: number) { super('Verification operation failed'); this.status = status; }
}
const record = z.record(z.string(), z.unknown());
const rowsSchema = z.object({ data: z.array(record) });
const createdSchema = z.object({ data: z.object({ id: z.string().min(1) }).passthrough() });
const completionSchema = z.object({ choices: z.array(z.object({
  message: z.object({ content: z.string() }), finish_reason: z.string().nullable(),
})).min(1) });
const packetSchema = z.object({
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional() }).optional(), finish_reason: z.string().nullable().optional() })).optional(),
  error: z.unknown().optional(),
});

/** Parse SSE across arbitrary byte boundaries without mixing reasoning into visible output. */
export async function readCompletionStream(response: Response): Promise<{
  content: string; contentChunks: number; doneFrames: number; firstContentMs?: number; finishReason?: string;
}> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new CheckError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const started = performance.now();
  let line = '', data: string[] = [], skipLf = false, content = '', contentChunks = 0, doneFrames = 0, bytes = 0;
  let firstContentMs: number | undefined, finishReason: string | undefined;
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join('\n'); data = [];
    if (doneFrames) throw new CheckError();
    if (payload === '[DONE]') { doneFrames++; return; }
    const packet = packetSchema.parse(JSON.parse(payload));
    if (packet.error !== undefined) throw new CheckError();
    const choice = packet.choices?.[0];
    if (choice?.delta?.content) {
      firstContentMs ??= Math.round(performance.now() - started);
      content += choice.delta.content; contentChunks++;
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  };
  const acceptLine = () => {
    if (!line) dispatch();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    line = '';
  };
  const accept = (text: string) => {
    for (const char of text) {
      if (char === '\r') { acceptLine(); skipLf = true; }
      else if (char === '\n') { if (!skipLf) acceptLine(); skipLf = false; }
      else { skipLf = false; line += char; }
    }
    if (line.length + data.reduce((n, item) => n + item.length, 0) > 1024 * 1024) throw new CheckError();
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new CheckError();
      accept(decoder.decode(chunk.value, { stream: true }));
    }
    accept(decoder.decode()); if (line) acceptLine(); dispatch();
    if (doneFrames !== 1 || contentChunks < 2 || finishReason !== 'stop') throw new CheckError();
    return { content, contentChunks, doneFrames, ...(firstContentMs === undefined ? {} : { firstContentMs }), ...(finishReason ? { finishReason } : {}) };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

interface MemoryClient {
  createMemory(body: Record<string, unknown>): Promise<MemoryRecord>;
  searchMemories(query: string, body?: Record<string, unknown>): Promise<unknown>;
  context(body: Record<string, unknown>): Promise<{ raw(): ContextResponse; toOpenAI(): Array<{ role: string; content: string }> }>;
}
interface Check { name: string; passed: boolean; status?: number }
export interface ModelE2eReport {
  runId: string; model: string; providerKind: string; startedAt: string; success: boolean;
  checks: Check[]; cleanup: Check[];
  resources: { label: string; providerId?: string; aliasId?: string; keyId?: string; expiredKeyId?: string; memoryIds: string[] };
  requests: Array<{ requestId: string; stream: boolean; elapsedMs: number; contentChunks?: number; doneFrames?: number; firstVisibleTokenMs?: number }>;
  traceIds: string[];
}
interface Options {
  fetchImpl?: typeof fetch;
  memoryFactory?: (options: { baseUrl: string; token: string; workspaceId: string; fetchImpl: typeof fetch; timeoutMs: number; maxRetries: number }) => Promise<MemoryClient>;
  signal?: AbortSignal;
  checkpoint?: (report: ModelE2eReport) => void;
  onCheck?: (check: Check) => void;
}

export async function runModelE2e(config: ModelE2eConfig, options: Options = {}): Promise<ModelE2eReport> {
  const runId = randomUUID(), label = `model-e2e-${runId}`, expiredName = `${label}-expired`;
  const canary = randomBytes(16).toString('hex').toUpperCase();
  const report: ModelE2eReport = { runId, model: config.model, providerKind: config.providerKind, startedAt: new Date().toISOString(), success: false,
    checks: [], cleanup: [], resources: { label, memoryIds: [] }, requests: [], traceIds: [] };
  const fetchImpl = options.fetchImpl ?? fetch;
  const cookies = new Map<string, string>();
  let stage = 'initialize SDK', cleanup = false, key = '', workspaceAttempted = false, memory: MemoryClient | undefined;
  const save = () => {
    try { options.checkpoint?.(report); }
    catch {
      report.success = false;
      if (!report.checks.some((check) => check.name === 'private report writing')) report.checks.push({ name: 'private report writing', passed: false });
      if (!cleanup) throw new CheckError();
    }
  };
  const mark = (name: string, passed: boolean, error?: unknown) => {
    const sdkError = z.object({ statusCode: z.number().int().min(100).max(599) }).safeParse(error);
    const status = error instanceof CheckError ? error.status : sdkError.success ? sdkError.data.statusCode : undefined;
    const check = { name, passed, ...(status === undefined ? {} : { status }) };
    (cleanup ? report.cleanup : report.checks).push(check); save(); options.onCheck?.(check);
  };
  const verify = (name: string, passed: boolean, required = false) => {
    mark(name, passed); if (required && !passed) throw new CheckError();
  };
  const signal = () => cleanup || !options.signal ? AbortSignal.timeout(config.timeoutMs)
    : AbortSignal.any([options.signal, AbortSignal.timeout(config.timeoutMs)]);
  const guardedFetch: typeof fetch = (input, init) => fetchImpl(input, { ...init, redirect: 'error',
    signal: init?.signal ? AbortSignal.any([init.signal, signal()]) : signal() });
  async function request(base: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', expected = 200, admin = false, token = ''): Promise<unknown> {
    const response = await guardedFetch(`${base.replace(/\/$/, '')}${path}`, { method,
      headers: { ...(admin ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), origin: new URL(config.adminUrl).origin } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (admin) for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] ?? ''; const separator = pair.indexOf('=');
      if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    if (response.status !== expected) { await response.body?.cancel(); throw new CheckError(response.status); }
    if (response.status === 204) return null;
    return response.json();
  }
  const admin = (path: string, body?: unknown, method?: string, expected = 200) => request(config.adminUrl, path, body, method, expected, true);
  const memoryRequest = (path: string, body?: unknown, method?: string, expected = 200) => request(config.memoryUrl, path, body, method, expected, false, config.memoryToken);
  const rows = async (path: string) => rowsSchema.parse(await admin(path)).data;
  const ownRows = async (path: string, field: string, names: string[]) => (await rows(path)).filter((row) => names.includes(String(row[field])));
  const removeRows = async (path: string, field: string, names: string[]) => {
    for (const row of await ownRows(path, field, names)) await admin(`${path}/${encodeURIComponent(z.string().parse(row.id))}`, undefined, 'DELETE');
  };
  const question = `What is the launch code for ${label}? Reply with only the exact code, or UNKNOWN if the supplied context does not contain it.`;
  const system = { role: 'system', content: 'Answer only from supplied memory. Never invent a launch code. If no memory provides it, reply UNKNOWN.' };
  async function complete(messages: Array<{ role: string; content: string }>, stream: boolean): Promise<string> {
    const requestId = `model-e2e-${randomUUID()}`, start = performance.now();
    const response = await guardedFetch(`${config.apiUrl.replace(/\/$/, '')}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-request-id': requestId },
      body: JSON.stringify({ model: label, messages, temperature: 0, max_tokens: config.maxTokens, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }) });
    if (!response.ok) { await response.body?.cancel(); throw new CheckError(response.status); }
    if (stream) {
      const headersElapsed = performance.now() - start;
      const result = await readCompletionStream(response);
      report.requests.push({ requestId, stream, elapsedMs: Math.round(performance.now() - start), contentChunks: result.contentChunks, doneFrames: result.doneFrames,
        ...(result.firstContentMs === undefined ? {} : { firstVisibleTokenMs: Math.round(headersElapsed + result.firstContentMs) }) });
      mark('SSE emits incremental content and terminates cleanly', true); return result.content;
    }
    const result = completionSchema.parse(await response.json()).choices[0]!;
    if (result.finish_reason !== 'stop') throw new CheckError();
    report.requests.push({ requestId, stream, elapsedMs: Math.round(performance.now() - start) }); save(); return result.message.content;
  }
  async function health() {
    await request(config.adminUrl, '/health/ready'); mark('Router admin readiness', true);
    await request(config.apiUrl, '/health/ready'); mark('Router API readiness', true);
    const status = z.object({ apps: z.array(z.object({ key: z.string(), status: z.string() })) }).parse(await admin('/api/hive/status'));
    verify('IAM, Memory and Router online', ['iam', 'memory', 'router'].every((key) => status.apps.some((app) => app.key === key && app.status === 'online')));
    await admin('/api/iam/users?limit=1'); mark('authenticated IAM proxy', true);
    const dashboard = z.object({ configured: z.literal(true), stats: record }).parse(await admin('/api/memory/dashboard-data'));
    verify('authenticated Memory dashboard', dashboard.configured);
  }
  try {
    memory = await (options.memoryFactory ?? (async (settings) => {
      const { HiveMem } = await import(new URL('../services/hive-mem/sdks/typescript/dist/index.js', import.meta.url).href);
      return new HiveMem(settings) as MemoryClient;
    }))({ baseUrl: config.memoryUrl, token: config.memoryToken, workspaceId: label, fetchImpl: guardedFetch, timeoutMs: config.timeoutMs, maxRetries: 0 });
    stage = 'operator authentication'; await admin('/api/auth/login', { username: config.username, password: config.password }); mark(stage, true);
    stage = 'initial service health'; await health();
    stage = 'temporary provider creation';
    report.resources.providerId = createdSchema.parse(await admin('/api/providers', { slug: label, name: label, kind: config.providerKind, baseUrl: config.providerUrl,
      authMode: config.authMode, ...(config.providerToken ? { authSecret: config.providerToken } : {}), authHeaderName: config.authHeader,
      priority: 1000000000, timeoutMs: config.timeoutMs, maxRetries: 0, concurrency: 1,
      capabilities: { streaming: true, supportedRoutes: ['v1.models', 'v1.chat.completions'] }, models: [{ model: config.model, enabled: true }] }, 'POST', 201)).data.id; save();
    stage = 'upstream model discovery';
    const discovered = z.object({ data: z.object({ discovered: z.array(z.object({ model: z.string() })) }) }).parse(await admin(`/api/providers/${report.resources.providerId}/discover`, {}));
    verify(stage, discovered.data.discovered.some((item) => item.model === config.model), true);
    stage = 'provider-bound model alias';
    report.resources.aliasId = createdSchema.parse(await admin('/api/model-aliases', { alias: label, providerId: report.resources.providerId, upstreamModel: config.model }, 'POST', 201)).data.id; save();
    stage = 'scoped inference key';
    const created = createdSchema.parse(await admin('/api/client-keys', { name: label, metadata: { environment: 'test', scopes: ['models:read', 'inference:write'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(), quota: { dailyRequests: 12, dailyTokens: Math.max(12000, config.maxTokens * 6) } } }, 'POST', 201)).data;
    report.resources.keyId = created.id; key = z.string().min(1).parse(created.apiKey); save();
    stage = 'Router model discovery';
    const models = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await request(config.apiUrl, '/v1/models', undefined, 'GET', 200, false, key));
    verify(stage, models.data.some((item) => item.id === config.model));
    stage = 'no-memory inference';
    verify('unknown fact is unavailable without memory', (await complete([system, { role: 'user', content: question }], false)).trim() === 'UNKNOWN');
    stage = 'synthetic workspace creation'; workspaceAttempted = true;
    await memoryRequest('/v1/workspaces', { workspace_id: label, title: label, metadata: { test_run: runId } }, 'POST', 201); save();
    stage = 'synthetic private memory creation';
    const stored = await memory.createMemory({ content: `For ${label}, the launch code is ${canary}.`, type: 'semantic', scope: 'private', source: 'observation', metadata: { test_run: runId } });
    report.resources.memoryIds.push(stored.id); save(); mark(stage, true);
    stage = 'memory search';
    const search = z.object({ results: z.array(z.object({ memory: z.object({ id: z.string() }) })) }).parse(await memory.searchMemories(label, { limit: 3 }));
    verify(stage, search.results.some((item) => item.memory.id === stored.id));
    stage = 'isolated SDK context';
    const context = await memory.context({ search_query: label, max_memories: 3, token_budget: 1000 });
    const raw = z.object({ memories: z.array(z.object({ memory: z.object({ id: z.string(), content: z.string(), workspace_id: z.string() }) })),
      formatted_context: z.object({ content: z.string() }) }).parse(context.raw());
    verify('context contains only the synthetic memory', raw.memories.length === 1 && raw.memories.every((item) => item.memory.id === stored.id && item.memory.workspace_id === label && item.memory.content === stored.content), true);
    const messages = context.toOpenAI();
    verify('SDK retains only the exact fact and citation', raw.formatted_context.content === `- [memory:${stored.id}] ${stored.content}`
      && messages.length === 1 && messages[0]?.role === 'system' && messages[0].content === raw.formatted_context.content, true);
    stage = 'ordinary memory recall'; verify(stage, (await complete([system, ...messages, { role: 'user', content: question }], false)).trim() === canary);
    stage = 'streamed memory recall'; verify(stage, (await complete([system, ...messages, { role: 'user', content: question }], true)).trim() === canary);
    stage = 'successful provider-bound traces';
    const traces = (await rows('/api/traces')).filter((trace) => report.requests.some((request) => request.requestId === trace.requestId));
    report.traceIds = traces.map((trace) => z.string().parse(trace.id));
    verify(stage, traces.length === 3 && traces.every((trace) => trace.providerId === report.resources.providerId && trace.statusCode === 200 && trace.outcome === 'SUCCEEDED'));
    stage = 'expired key rejection';
    const expired = createdSchema.parse(await admin('/api/client-keys', { name: expiredName, metadata: { expiresAt: '2020-01-01T00:00:00Z', scopes: ['models:read'] } }, 'POST', 201)).data;
    report.resources.expiredKeyId = expired.id; save();
    await request(config.apiUrl, '/v1/models', undefined, 'GET', 401, false, z.string().parse(expired.apiKey)); mark(stage, true);
  } catch (error) { mark(stage, false, error); }
  finally {
    cleanup = true;
    const actions: Array<[string, () => Promise<void>]> = [
      ['synthetic memories removed', async () => {
        if (!workspaceAttempted) return;
        const response = await guardedFetch(`${config.memoryUrl.replace(/\/$/, '')}/v1/workspaces/${label}`, { headers: { authorization: `Bearer ${config.memoryToken}` } });
        if (response.status === 404) { await response.body?.cancel(); return; }
        if (!response.ok) { await response.body?.cancel(); throw new CheckError(response.status); }
        const workspace = z.object({ metadata: z.object({ test_run: z.literal(runId) }) }).parse(await response.json());
        if (workspace.metadata.test_run !== runId || !memory) throw new CheckError();
        const matches = z.object({ results: z.array(z.object({ memory: z.object({ id: z.string(), workspace_id: z.string(), metadata: record }) })) }).parse(await memory.searchMemories(label, { limit: 50 }));
        for (const item of matches.results) if (item.memory.workspace_id === label && item.memory.metadata.test_run === runId
          && !report.resources.memoryIds.includes(item.memory.id)) report.resources.memoryIds.push(item.memory.id);
        for (const id of report.resources.memoryIds) {
          const item = z.object({ workspace_id: z.literal(label), metadata: z.object({ test_run: z.literal(runId) }) })
            .parse(await memoryRequest(`/v1/memories/${encodeURIComponent(id)}`));
          if (item.workspace_id !== label) throw new CheckError();
          await memoryRequest(`/v1/memories/${encodeURIComponent(id)}`, undefined, 'DELETE', 204);
        }
      }],
      ['synthetic workspace removed', async () => {
        if (!workspaceAttempted) return;
        const response = await guardedFetch(`${config.memoryUrl.replace(/\/$/, '')}/v1/workspaces/${label}`, { headers: { authorization: `Bearer ${config.memoryToken}` } });
        if (response.status === 404) { await response.body?.cancel(); return; }
        if (!response.ok) { await response.body?.cancel(); throw new CheckError(response.status); }
        z.object({ metadata: z.object({ test_run: z.literal(runId) }) }).parse(await response.json());
        await memoryRequest(`/v1/workspaces/${label}`, undefined, 'DELETE', 204);
      }],
      ['temporary keys removed', async () => { if (cookies.size) await removeRows('/api/client-keys', 'name', [label, expiredName]); }],
      ['temporary alias removed', async () => { if (cookies.size) await removeRows('/api/model-aliases', 'alias', [label]); }],
      ['temporary provider removed', async () => { if (cookies.size) await removeRows('/api/providers', 'slug', [label]); }],
      ['temporary resources confirmed absent', async () => {
        if (workspaceAttempted) {
          for (const id of report.resources.memoryIds) await memoryRequest(`/v1/memories/${encodeURIComponent(id)}`, undefined, 'GET', 404);
          await memoryRequest(`/v1/workspaces/${label}`, undefined, 'GET', 404);
        }
        if (key) await request(config.apiUrl, '/v1/models', undefined, 'GET', 401, false, key);
        if (cookies.size && ((await ownRows('/api/providers', 'slug', [label])).length || (await ownRows('/api/model-aliases', 'alias', [label])).length
          || (await ownRows('/api/client-keys', 'name', [label, expiredName])).length)) throw new CheckError();
      }],
      ['post-test service health', async () => { if (cookies.size) await health(); }],
      ['operator session logged out', async () => { if (cookies.size) await admin('/api/auth/logout', {}); }],
    ];
    for (const [name, action] of actions) { try { await action(); mark(name, true); } catch (error) { mark(name, false, error); } }
  }
  report.success = !options.signal?.aborted && report.checks.every((check) => check.passed) && report.cleanup.every((check) => check.passed);
  save(); return report;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0]!)) {
    console.log('Usage: npm run test:e2e:model -- [--env-file FILE]\nSee docs/model-e2e.md for required HIVE_E2E_* variables and cleanup behavior.'); return 0;
  }
  let env = process.env;
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--env-file') { console.error('Invalid arguments. Use --help.'); return 2; }
    try { env = { ...parseEnv(readFileSync(argv[1]!, 'utf8')), ...process.env }; }
    catch { console.error('Unable to read the environment file.'); return 2; }
  }
  let config: ModelE2eConfig;
  try { config = readModelE2eConfig(env); } catch (error) { console.error((error as Error).message); return 2; }
  const path = resolve(env.HIVE_E2E_REPORT_PATH || `output/model-e2e/${randomUUID()}.json`);
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); closeSync(openSync(path, 'wx', 0o600)); }
  catch { console.error('Unable to create a new private report file.'); return 2; }
  const controller = new AbortController(); let exit = 1;
  const interrupt = () => { controller.abort(); exit = 130; };
  const terminate = () => { controller.abort(); exit = 143; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const report = await runModelE2e(config, { signal: controller.signal,
      checkpoint: (value) => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          const fd = openSync(temporary, 'wx', 0o600);
          try { writeSync(fd, JSON.stringify(value, null, 2) + '\n', 0); fsyncSync(fd); } finally { closeSync(fd); }
          renameSync(temporary, path);
        } finally { try { unlinkSync(temporary); } catch { /* Already renamed, or could not be created. */ } }
      },
      onCheck: (check) => console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}${check.status ? ` (HTTP ${check.status})` : ''}`) });
    if (!controller.signal.aborted) exit = report.success ? 0 : 1;
    console.log(`${report.success ? 'Passed' : 'Failed'}; private report: ${path}`);
  } catch { console.error('Verification or report writing failed. Inspect the private report for run identifiers and cleanup status.'); }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  return exit;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
