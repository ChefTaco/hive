import { createHash } from 'node:crypto';
import type { MemoryRecord } from './types.js';
export interface SemanticConfig { endpoint: string; model: string; revision: string; dimensions: number; collection: string; qdrantUrl: string; apiKey?: string; embeddingKey?: string }
export function semanticConfig(env = process.env): SemanticConfig | null {
  if (!env.HIVEMEM_EMBEDDING_ENDPOINT) return null;
  const { HIVEMEM_EMBEDDING_MODEL: model, HIVEMEM_EMBEDDING_REVISION: revision, HIVEMEM_SEMANTIC_COLLECTION: collection } = env;
  const dimensions = Number(env.HIVEMEM_EMBEDDING_DIMENSIONS);
  if (!model || !revision || !collection?.startsWith('hivemem_shadow_') || !/^[a-zA-Z0-9_-]+$/.test(collection) || !Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 8192) throw new Error('Explicit model, revision, dimension, and shadow collection are required');
  const endpoint = new URL(env.HIVEMEM_EMBEDDING_ENDPOINT);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('Embedding endpoint requires HTTPS or loopback');
  return { endpoint: endpoint.href, model, revision, dimensions, collection, qdrantUrl: env.HIVEMEM_QDRANT_URL ?? env.QDRANT_URL ?? `http://${env.HIVEMEM_QDRANT_HOST ?? '127.0.0.1'}:${env.HIVEMEM_QDRANT_PORT ?? '6333'}`, ...(env.QDRANT_API_KEY ? { apiKey: env.QDRANT_API_KEY } : {}), ...(env.HIVEMEM_EMBEDDING_API_KEY ? { embeddingKey: env.HIVEMEM_EMBEDDING_API_KEY } : {}) };
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export class SemanticIndex {
  readonly identity: string;
  constructor(readonly config: SemanticConfig, private readonly transport: typeof fetch = fetch) { this.identity = digest(JSON.stringify([config.model, config.revision, config.dimensions])); }
  private async json(url: string, method: string, body?: unknown, headers?: Record<string, string>): Promise<Record<string, any>> {
    const response = await this.transport(url, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Semantic dependency returned HTTP ${response.status}`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Semantic dependency returned no body');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 8 * 1024 * 1024) throw new Error('Semantic response exceeds limit'); chunks.push(part.value); } }
    finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
  }
  private qdrant(method: string, suffix: string, body?: unknown) { return this.json(`${this.config.qdrantUrl.replace(/\/$/, '')}/collections/${this.config.collection}${suffix}`, method, body, this.config.apiKey ? { 'api-key': this.config.apiKey } : {}); }
  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.json(this.config.endpoint, 'POST', { model: this.config.model, input: texts }, this.config.embeddingKey ? { authorization: `Bearer ${this.config.embeddingKey}` } : {});
    if (response.model && response.model !== this.config.model) throw new Error('Embedding model identity mismatch');
    const vectors = (Array.isArray(response.data) ? response.data : []).map((item: { embedding?: unknown }) => item.embedding);
    if (vectors.length !== texts.length || vectors.some((vector: unknown) => !Array.isArray(vector) || vector.length !== this.config.dimensions || vector.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value)))) throw new Error('Embedding dimension or value mismatch');
    return vectors as number[][];
  }
  /** Build a NEW shadow collection. Selecting it for reads is a separate env change. */
  async build(records: MemoryRecord[]): Promise<{ indexed: number; identity: string }> {
    await this.qdrant('PUT', '', { vectors: { size: this.config.dimensions, distance: 'Cosine' } });
    for (let start = 0; start < records.length; start += 32) {
      const batch = records.slice(start, start + 32);
      const vectors = await this.embed(batch.map((memory) => memory.content));
      await this.qdrant('PUT', '/points?wait=true', { points: batch.map((memory, index) => { const hex = digest(memory.id).slice(0, 32); return { id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, vector: vectors[index], payload: { memory_id: memory.id, content_hash: digest(memory.content), identity: this.identity, workspace_id: memory.workspace_id, agent_id: memory.agent_id, scope: memory.scope } }; }) });
    }
    return { indexed: records.length, identity: this.identity };
  }
  async query(query: string, workspace: string, agent: string): Promise<Array<{ id: string; score: number; contentHash: string }>> {
    const [vector] = await this.embed([query]);
    const response = await this.qdrant('POST', '/points/query', { query: vector, limit: 1000, with_payload: true, filter: { must: [{ key: 'identity', match: { value: this.identity } }, ...(workspace !== '*' ? [{ key: 'workspace_id', match: { value: workspace } }] : [])], should: [{ key: 'scope', match: { value: 'shared' } }, { key: 'agent_id', match: { value: agent } }] } });
    return (response.result?.points ?? []).map((point: { payload: { memory_id: string; content_hash: string }; score: number }) => ({ id: point.payload.memory_id, contentHash: point.payload.content_hash, score: point.score }));
  }
  matches(memory: MemoryRecord, hash: string): boolean { return digest(memory.content) === hash; }
}
