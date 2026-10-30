# @hivemagnus/hivemem-sdk

TypeScript client for [HiveMem](https://github.com/ChefTaco/hive/tree/main/services/hive-mem), the shared long-term memory service for AI agents. It wraps the HiveMem REST API with typed helpers for memories, search, sessions, prompt context, peer cards, conclusions, queue operations, and webhooks.

- Zero runtime dependencies; uses the platform `fetch` (Node.js 18.17+, Deno, Bun, browsers, edge runtimes).
- ESM-only, with bundled type declarations.
- Retries 5xx responses, supports request timeouts, request IDs, and token refresh hooks.

## Install

```bash
npm install @hivemagnus/hivemem-sdk
```

You need a running HiveMem server and an agent token. See the [HiveMem README](https://github.com/ChefTaco/hive/tree/main/services/hive-mem#readme) for how to run the server and register an agent.

## Quick start

```ts
import { HiveMem } from "@hivemagnus/hivemem-sdk";

const hivemem = new HiveMem({
  baseUrl: "https://memory.example.com", // or set HIVEMEM_API_URL
  token: process.env.HIVEMEM_TOKEN,
  workspaceId: "default",
});

// Store a memory. HiveMem embeds the text server-side.
await hivemem.createMemory({
  content: "The user prefers direct status summaries.",
  type: "semantic",
  scope: "private",
  tags: ["preference"],
});

// Search with score explanations.
const results = await hivemem.searchMemories("status summary preferences", { limit: 5 }, { explain: true });

// Build a token-budgeted, source-cited prompt context and hand it to your model.
const context = await hivemem.context({ tokens: 2000, search_query: "current project" });
const messages = context.toOpenAI(); // or context.toAnthropic()
```

## Configuration

| Option | Environment fallback | Default |
| --- | --- | --- |
| `baseUrl` | `HIVEMEM_API_URL` | `http://localhost:18790` |
| `token` | `HIVEMEM_TOKEN`, then `HIVEMEM_MCP_TOKEN` | none |
| `workspaceId` | `HIVEMEM_WORKSPACE_ID` | `default` |
| `timeoutMs` | | `30000` |
| `maxRetries` | | `2` (5xx responses only) |
| `fetchImpl` | | global `fetch` |
| `requestIdProvider` | | sends `X-Request-ID` when set |
| `authRefresh` | | called before each attempt; a returned token replaces the current one |
| `onRequest` / `onResponse` | | observability hooks |

Explicit constructor options win over environment variables. Environment variables are only read where `process.env` exists.

## Common operations

```ts
// Memories
const memory = await hivemem.getMemory(id);
const original = await hivemem.getMemory(oldId, { includeHistory: true }); // superseded/retired versions
await hivemem.browseMemories({ limit: 20 });

// Sessions and session-scoped context
const session = await hivemem.createSession({ session_id: "chat-42" });
const sessionContext = await hivemem.sessionContext("chat-42", { search_query: "open questions" });

// Peer cards and conclusions
const card = await hivemem.getPeerCard("user");
const page = await hivemem.listConclusionsPage("user", { limit: 50 });
const next = page.next_cursor ? await hivemem.listConclusionsPage("user", { limit: 50, cursor: page.next_cursor }) : null;
const conclusion = await hivemem.getConclusion(conclusionId, { includeHistory: true });

// Idempotent background operations
const job = await hivemem.getQueueOperation("nightly-2026-01-01", "consolidation");

// Knowledge sources
await hivemem.syncKnowledgeSource({ mode: "preview", project_id: "docs", source_id: "repo:docs", source_uri: "repo://docs", revision: "abc123", observed_at: new Date().toISOString(), chunks: [] });
```

## Errors

Non-2xx responses throw `HiveMemHTTPError` with `statusCode`, the server's `detail` as `message`, and the parsed body as `details`. All SDK errors extend `HiveMemError`.

```ts
import { HiveMemHTTPError } from "@hivemagnus/hivemem-sdk";

try {
  await hivemem.getMemory("missing");
} catch (error) {
  if (error instanceof HiveMemHTTPError && error.statusCode === 404) {
    // not found or not visible to this agent
  }
}
```

## Verifying webhooks

HiveMem signs webhook deliveries with HMAC-SHA256. Verify them before trusting the payload:

```ts
import { verifyHiveMemWebhook } from "@hivemagnus/hivemem-sdk";

const ok = await verifyHiveMemWebhook({
  secret: process.env.HIVEMEM_WEBHOOK_SECRET!,
  body: rawBody, // the exact bytes received
  signature: headers["x-hivemem-signature"],
  timestamp: headers["x-hivemem-timestamp"],
  nonce: headers["x-hivemem-nonce"],
  seenNonces, // optional Set<string> for replay protection
});
```

## License

Apache-2.0. See [LICENSE](LICENSE).
