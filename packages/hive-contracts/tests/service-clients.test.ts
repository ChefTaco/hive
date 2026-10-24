import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createIamServiceClient, createMemoryServiceClient } from '../src/service-clients.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('typed service clients', () => {
  it('requests IAM users with bearer auth and parses the response', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createIamServiceClient({
      baseUrl: 'https://iam.example.test',
      bearerToken: 'token-1',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ users: [{ id: 'user-1', username: 'admin', email: 'admin@example.test' }], total: 1 });
      },
    });

    const result = await client.users(25);

    assert.equal(calls[0]?.url, 'https://iam.example.test/api/v1/users?limit=25');
    assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Bearer token-1');
    assert.equal(result.users[0]?.username, 'admin');
  });

  it('posts Memory search requests and validates the envelope', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createMemoryServiceClient({
      baseUrl: 'http://memory.example.test/',
      bearerToken: 'memory-token',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ memories: [{ id: 'mem-1', content: 'hello' }] });
      },
    });

    const result = await client.search({ query: 'hello', limit: 3 });

    assert.equal(calls[0]?.url, 'http://memory.example.test/v1/memories/search');
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Bearer memory-token');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { query: 'hello', limit: 3 });
    assert.equal(result.memories?.[0]?.id, 'mem-1');
  });
});
