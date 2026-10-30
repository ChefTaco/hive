# Framework Adapters

Use HiveMem through REST, the Python/TypeScript SDKs, or the Hermes memory-provider plugin depending on the runtime. The old in-repo MCP server was removed with the Python service.

## LangGraph

Create a graph node that calls the TypeScript SDK's `searchMemories()` before model invocation and `createMemory()` after important turns. Store `thread_id` as `session_id`.

## LlamaIndex

Wrap `searchMemories()` as a retriever and map results to `NodeWithScore`. Use `/v1/context` when a prompt-ready memory package is preferred over individual nodes.

## CrewAI

Use a lightweight tool wrapper around `/v1/memories/search`, `/v1/context`, and `/v1/memories`. Keep the agent's HiveMem JWT in the crew runtime secret store and send plain text to the API; no local embedding model is required.

## AutoGen

Add a pre-reply hook that calls `/v1/context` with the conversation task and a post-reply hook that stores durable decisions or preferences with `source="observation"`.

## OpenAI Agents SDK

Register function tools that call the REST API directly. Prefer a bounded context tool backed by `/v1/context`, plus a create-memory tool backed by `/v1/memories`.

## Claude And Codex

Use REST wrappers or the TypeScript/Python SDKs from the host project. For self-editing memory workflows, expose small commands around memory search, create, update, and soft-delete routes rather than reviving the removed MCP bridge.
