import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { MemoryRecord } from '../services/hive-mem/sdks/typescript/src/types.ts';
import { readCompletionStream, readModelE2eConfig, runModelE2e } from './model-e2e.ts';

const env = {
  HIVE_E2E_ADMIN_URL: 'http://127.0.0.1:1443', HIVE_E2E_API_URL: 'http://127.0.0.1:1444',
  HIVE_E2E_MEMORY_URL: 'http://127.0.0.1:1445', HIVE_E2E_PROVIDER_URL: 'http://127.0.0.1:1446',
  HIVE_E2E_USERNAME: 'admin', HIVE_E2E_PASSWORD: 'dummy-login-password', HIVE_E2E_MEMORY_TOKEN: 'dummy-memory-token', HIVE_E2E_MODEL: 'example-model',
};
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
function sse(text: string, bytewise = false): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('configuration fails before network access and does not echo rejected values', () => {
  assert.throws(() => readModelE2eConfig({ ...env, HIVE_E2E_ADMIN_URL: 'https://dummy-password@example.com/?token=dummy-secret' }), (error: Error) => {
    assert.match(error.message, /HIVE_E2E_ADMIN_URL/); assert.doesNotMatch(error.message, /dummy-password|dummy-secret|example.com/); return true;
  });
  assert.throws(() => readModelE2eConfig({ ...env, HIVE_E2E_PASSWORD: undefined }), /HIVE_E2E_PASSWORD/);
  assert.throws(() => readModelE2eConfig({ ...env, HIVE_E2E_PROVIDER_URL: 'dummy-secret-not-a-url' }), /HIVE_E2E_PROVIDER_URL/);
  assert.throws(() => readModelE2eConfig({ ...env, HIVE_E2E_TIMEOUT_MS: 'Infinity' }), /HIVE_E2E_TIMEOUT_MS/);
  assert.throws(() => readModelE2eConfig({ ...env, HIVE_E2E_ADMIN_URL: 'http://hive.example.com' }), /HTTPS/);
  assert.throws(() => readModelE2eConfig({ ...env, HIVE_E2E_PROVIDER_AUTH_MODE: 'BEARER' }), /HIVE_E2E_PROVIDER_TOKEN/);
  assert.throws(() => readModelE2eConfig({ ...env, HIVE_E2E_PROVIDER_TOKEN: 'dummy-token' }), /HIVE_E2E_PROVIDER_AUTH_MODE/);
  assert.equal(readModelE2eConfig(env).providerKind, 'LLAMACPP');
  assert.equal(readModelE2eConfig({ ...env, HIVE_E2E_PROVIDER_KIND: 'OPENAI_GENERIC' }).providerKind, 'OPENAI_GENERIC');
});

test('SSE handles split UTF-8, CRLF, comments, multiline data, reasoning and terminal usage', async () => {
  const text = ': keepalive\r\ndata: {"choices":[{"delta":{"reasoning_content":"private thought"}}]}\r\n\r\n'
    + 'data: {"choices":[\r\ndata: {"delta":{"content":"café "}}]}\r\n\r\n'
    + 'data: {"choices":[{"delta":{"content":"雪"}}]}\r\n\r\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n'
    + 'data: {"choices":[],"usage":{"total_tokens":10}}\r\n\r\ndata: [DONE]\r\n\r\n';
  const result = await readCompletionStream(sse(text, true));
  assert.equal(result.content, 'café 雪'); assert.equal(result.contentChunks, 2); assert.equal(result.doneFrames, 1);
});

test('SSE rejects missing or duplicated DONE, upstream errors and generation truncated by budget', async () => {
  const prefix = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}\n\n';
  await assert.rejects(readCompletionStream(sse(prefix)));
  await assert.rejects(readCompletionStream(sse(prefix + 'data: [DONE]\n\ndata: [DONE]\n\n')));
  await assert.rejects(readCompletionStream(sse('data: {"error":{"message":"dummy-sensitive-text"}}\n\n')));
  await assert.rejects(readCompletionStream(sse(prefix.replace('stop', 'length') + 'data: [DONE]\n\n')));
});

function fixture(mode = '', controller?: AbortController) {
  const providers: Array<Record<string, unknown>> = [{ id: 'unrelated-provider', slug: 'unrelated' }];
  const aliases: Array<Record<string, unknown>> = [{ id: 'unrelated-alias', alias: 'unrelated' }];
  const keys: Array<Record<string, unknown>> = [{ id: 'unrelated-key', name: 'unrelated' }];
  const traces: Array<Record<string, unknown>> = [];
  let workspace: Record<string, unknown> | undefined, memory: MemoryRecord | undefined, workspaceId = '', chatCalls = 0, loggedOut = false;
  const deleted: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, 'error');
    if (init.signal?.aborted) throw new Error('dummy-login-password should never be reported');
    const url = new URL(String(input)), path = url.pathname, method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path === '/health/ready') return json({ status: 'ready' });
    if (path === '/api/auth/login') return json({ ok: true }, 200, { 'set-cookie': 'hive_router_admin=dummy-cookie; Secure; HttpOnly' });
    if (path === '/api/auth/logout') { loggedOut = true; return json({ ok: true }); }
    if (path.startsWith('/api/')) assert.match(new Headers(init.headers).get('cookie') ?? '', /hive_router_admin=/);
    if (path === '/api/hive/status') return json({ apps: ['iam', 'memory', 'router'].map((key) => ({ key, status: 'online' })) });
    if (path === '/api/iam/users') return json({ data: [] });
    if (path === '/api/memory/dashboard-data') return json({ configured: true, stats: {} });
    for (const [base, list, field] of [['/api/providers', providers, 'slug'], ['/api/model-aliases', aliases, 'alias'], ['/api/client-keys', keys, 'name']] as const) {
      if (path === base && method === 'GET') return json({ data: list });
      if (path === base && method === 'POST') {
        const id = base === '/api/providers' ? 'provider-1' : base === '/api/model-aliases' ? 'alias-1' : `key-${keys.length}`;
        const row = { ...body, id, [field]: body[field], apiKey: `dummy-${id}` }; list.push(row);
        if (base === '/api/providers' && mode === 'lost-provider-response') throw new Error('dummy-login-password dummy-provider-secret');
        return json({ data: row }, 201);
      }
      if (path.startsWith(base + '/') && method === 'DELETE') {
        if (mode === 'cleanup-key-failure' && base === '/api/client-keys') return json({ detail: 'dummy-login-password' }, 500);
        const index = list.findIndex((row) => row.id === path.slice(base.length + 1));
        assert.ok(index >= 0); deleted.push(path); list.splice(index, 1); return json({ ok: true });
      }
    }
    if (path.endsWith('/discover')) return json({ data: { discovered: [{ model: 'example-model' }] } });
    if (path === '/v1/models') {
      const token = new Headers(init.headers).get('authorization'); const key = keys.find((row) => `Bearer ${row.apiKey}` === token);
      const expired = (key?.metadata as { expiresAt?: string } | undefined)?.expiresAt?.startsWith('2020');
      return key && !expired ? json({ data: [{ id: 'example-model' }] }) : json({ error: 'invalid' }, 401);
    }
    if (path === '/v1/chat/completions') {
      chatCalls++; if (mode === 'interrupt') { controller!.abort(); throw new Error('dummy-login-password'); }
      assert.ok(aliases.some((row) => row.alias === body.model && row.providerId === 'provider-1'));
      if (mode === 'provider-failure') return json({ error: 'dummy-login-password dummy-provider-secret' }, 502);
      const messages = body.messages as Array<{ content: string }>;
      const recalled = messages.length > 2 ? /code is (\w+)\./.exec(memory!.content)![1]! : 'UNKNOWN';
      traces.push({ id: `trace-${chatCalls}`, requestId: new Headers(init.headers).get('x-request-id'), providerId: 'provider-1', statusCode: 200, outcome: 'SUCCEEDED' });
      if (!body.stream) return json({ choices: [{ message: { content: recalled }, finish_reason: 'stop' }] });
      return sse(`data: ${JSON.stringify({ choices: [{ delta: { content: recalled.slice(0, 10) } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: recalled.slice(10) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    }
    if (path === '/api/traces') return json({ data: traces });
    if (path === '/v1/workspaces' && method === 'POST') { workspace = body; return json(body, 201); }
    if (path.startsWith('/v1/workspaces/')) {
      if (method === 'DELETE') { workspace = undefined; return new Response(null, { status: 204 }); }
      return workspace ? json(workspace) : json({ detail: 'not found' }, 404);
    }
    if (path.startsWith('/v1/memories/')) {
      if (method === 'DELETE') { memory = undefined; return new Response(null, { status: 204 }); }
      return memory ? json(memory) : json({ detail: 'not found' }, 404);
    }
    throw new Error('Unexpected fixture path');
  };
  const memoryFactory = async (settings: { workspaceId: string }) => {
    workspaceId = settings.workspaceId;
    return {
      async createMemory(body: Record<string, unknown>): Promise<MemoryRecord> {
        if (mode === 'memory-failure') throw { statusCode: 403, message: 'dummy-memory-token should never be reported' };
        memory = { ...body, content: String(body.content), metadata: body.metadata as Record<string, unknown>, id: 'memory-1', agent_id: 'fixture', type: 'semantic', scope: 'private', workspace_id: workspaceId };
        return memory;
      },
      async searchMemories() { return { results: memory ? [{ memory }] : [] }; },
      async context() {
        const formatted = `- [memory:${memory!.id}] ${memory!.content}`;
        return { raw: () => ({ memories: [{ memory: { ...memory!, workspace_id: mode === 'wrong-workspace' ? 'unrelated' : workspaceId }, collection: 'private_semantic', score: 1, tokens_used: 20 }], formatted_context: { content: formatted } }),
          toOpenAI: () => [{ role: 'system', content: formatted }] };
      },
    };
  };
  return { fetchImpl, memoryFactory, providers, aliases, keys, deleted, get chatCalls() { return chatCalls; }, get cleaned() { return !memory && !workspace && loggedOut; } };
}

test('full scenario binds routing, verifies recall and removes only its own resources', async () => {
  const server = fixture(); const checkpoints: string[] = [];
  const report = await runModelE2e(readModelE2eConfig(env), { ...server, checkpoint: (report) => checkpoints.push(JSON.stringify(report)) });
  assert.equal(report.success, true); assert.equal(server.chatCalls, 3); assert.equal(server.cleaned, true);
  assert.equal(report.requests.length, 3); assert.equal(report.traceIds.length, 3);
  assert.deepEqual(server.providers.map((row) => row.id), ['unrelated-provider']);
  assert.deepEqual(server.keys.map((row) => row.id), ['unrelated-key']);
  assert.deepEqual(server.aliases.map((row) => row.id), ['unrelated-alias']);
  assert.ok(checkpoints.length > 10); assert.doesNotMatch(checkpoints.join('\n'), /dummy-login-password|dummy-memory-token|dummy-cookie/);
});

for (const mode of ['provider-failure', 'lost-provider-response', 'wrong-workspace', 'memory-failure', 'interrupt']) {
  test(`failure cleanup and private diagnostics: ${mode}`, async () => {
    const controller = new AbortController(), server = fixture(mode, controller);
    const report = await runModelE2e(readModelE2eConfig(env), { ...server, signal: controller.signal });
    assert.equal(report.success, false); assert.equal(server.cleaned, true);
    assert.deepEqual(server.providers.map((row) => row.id), ['unrelated-provider']);
    assert.deepEqual(server.keys.map((row) => row.id), ['unrelated-key']);
    assert.deepEqual(server.aliases.map((row) => row.id), ['unrelated-alias']);
    assert.doesNotMatch(JSON.stringify(report), /dummy-login-password|dummy-provider-secret|dummy-memory-token/);
    if (mode === 'wrong-workspace') assert.equal(server.chatCalls, 1, 'must not send an unauthorized context to the model');
    if (mode === 'memory-failure') assert.ok(report.checks.some((check) => !check.passed && check.status === 403));
  });
}

test('cleanup failure is a failed run and does not prevent other cleanup', async () => {
  const server = fixture('cleanup-key-failure'); const report = await runModelE2e(readModelE2eConfig(env), server);
  assert.equal(report.success, false); assert.ok(report.cleanup.some((check) => !check.passed));
  assert.equal(server.cleaned, true); assert.equal(server.providers.length, 1); assert.equal(server.aliases.length, 1);
});

test('a failing report writer cannot interrupt resource cleanup', async () => {
  const server = fixture();
  await assert.rejects(runModelE2e(readModelE2eConfig(env), { ...server, checkpoint: (report) => {
    if (report.resources.providerId) throw new Error('disk full');
  } }));
  assert.equal(server.cleaned, true); assert.equal(server.providers.length, 1);
});

test('failure to save the final successful report still fails the run', async () => {
  const server = fixture();
  const report = await runModelE2e(readModelE2eConfig(env), { ...server, checkpoint: (report) => {
    if (report.success) throw new Error('disk full');
  } });
  assert.equal(report.success, false); assert.equal(server.cleaned, true);
  assert.ok(report.checks.some((check) => check.name === 'private report writing' && !check.passed));
});

test('CLI reports are exclusive, owner-only and failures return nonzero without echoing secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'model-e2e-cli-'));
  try {
    const configPath = join(directory, '.env.example'), reportPath = join(directory, 'report.json');
    writeFileSync(configPath, Object.entries({ ...env, HIVE_E2E_ADMIN_URL: 'http://127.0.0.1:1', HIVE_E2E_TIMEOUT_MS: '1000', HIVE_E2E_REPORT_PATH: reportPath }).map(([k, v]) => `${k}=${v}`).join('\n'));
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/model-e2e.ts', '--env-file', configPath], {
      cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000,
    });
    assert.equal(result.status, 1); assert.equal(statSync(reportPath).mode & 0o777, 0o600);
    assert.doesNotMatch(result.stdout + result.stderr + readFileSync(reportPath, 'utf8'), /dummy-login-password|dummy-memory-token/);
    const repeat = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/model-e2e.ts', '--env-file', configPath], {
      cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000,
    });
    assert.equal(repeat.status, 2); assert.match(repeat.stderr, /new private report/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
