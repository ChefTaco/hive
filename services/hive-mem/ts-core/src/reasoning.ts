import { createHash } from "node:crypto";
import type { ConclusionKind, JsonObject, MemoryRecord } from "./types.js";

/**
 * Deterministic, local-only reasoning primitives. These functions never make
 * network calls and produce stable output for identical input so the TypeScript
 * queue worker can keep consolidation/reasoning behavior reproducible.
 */

export interface ReasonedConclusion {
  content: string;
  kind: ConclusionKind;
  confidence: number;
  source_memory_ids: string[];
  metadata: JsonObject;
}

export interface ReasoningBatchResult {
  conclusions: ReasonedConclusion[];
  summary?: string | null;
  peer_card?: ReasonedConclusion[];
}

export interface ReasoningSettings {
  reasoning_enabled: boolean;
  reasoning_provider: string;
  reasoning_batch_tokens: number;
  reasoning_max_batch_memories: number;
  reasoning_max_conclusions_per_batch: number;
  reasoning_summary_short_every: number;
  reasoning_summary_long_every: number;
  reasoning_min_new_conclusions: number;
  reasoning_peer_card_limit: number;
  reasoning_representation_min_tokens: number;
  reasoning_representation_max_wait_seconds: number;
}

export const DEFAULT_REASONING_SETTINGS: ReasoningSettings = {
  reasoning_enabled: true,
  reasoning_provider: "local",
  reasoning_batch_tokens: 1000,
  reasoning_max_batch_memories: 50,
  reasoning_max_conclusions_per_batch: 20,
  reasoning_summary_short_every: 5,
  reasoning_summary_long_every: 25,
  reasoning_min_new_conclusions: 3,
  reasoning_peer_card_limit: 10,
  reasoning_representation_min_tokens: 400,
  reasoning_representation_max_wait_seconds: 300,
};

export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor((text.length + 3) / 4));
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function firstSentence(text: string, maxLen = 360): string {
  const clean = text.trim().split(/\s+/u).join(" ");
  if (!clean) return "";
  const match = /[.!?]\s+/u.exec(clean);
  let sentence = match ? clean.slice(0, match.index + 1) : clean;
  if (sentence.length > maxLen) sentence = sentence.slice(0, maxLen - 3).trimEnd() + "...";
  return sentence;
}

export function kindFromText(text: string): ConclusionKind {
  const lowered = text.toLowerCase();
  if (["probably", "may ", "might", "seems", "suggests"].some((word) => lowered.includes(word))) return "abductive";
  if (["always", "never", "therefore", "because"].some((word) => lowered.includes(word))) return "deductive";
  if (["often", "usually", "pattern", "recurring"].some((word) => lowered.includes(word))) return "inductive";
  return "explicit";
}

const PEER_CARD_MARKERS = ["prefer", "likes", "needs", "works on", "uses", "goal", "recurring", "stable", "communication"] as const;

export function looksLikePeerCard(content: string): boolean {
  const lowered = content.toLowerCase();
  return PEER_CARD_MARKERS.some((marker) => lowered.includes(marker));
}

const INTEREST_MARKERS = [
  "prefer",
  "likes",
  "uses",
  "needs",
  "wants",
  "works on",
  "is working",
  "decided",
  "blocked",
  "learned",
  "remember",
] as const;

/** UUID v5 (SHA-1) so conclusion identity is stable/idempotent for equal seeds. */
export function uuid5(name: string, namespace = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf8")).digest();
  const bytes = Uint8Array.prototype.slice.call(hash, 0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function tagCounts(memories: readonly MemoryRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    for (const tag of memory.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

function mostCommon(counts: Map<string, number>, limit: number): Array<[string, number]> {
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, limit);
}

export function extractConclusions(
  memories: readonly MemoryRecord[],
  options: { peerId: string; sessionId: string | null; settings?: ReasoningSettings },
): ReasoningBatchResult {
  const settings = options.settings ?? DEFAULT_REASONING_SETTINGS;
  const maxItems = settings.reasoning_max_conclusions_per_batch;
  const conclusions: ReasonedConclusion[] = [];

  for (const memory of memories) {
    const sentence = firstSentence(memory.content);
    if (!sentence) continue;
    const lowered = sentence.toLowerCase();
    const interesting = INTEREST_MARKERS.some((marker) => lowered.includes(marker));
    if (interesting || memory.importance >= 0.55 || memory.confidence >= 0.85) {
      conclusions.push({
        content: sentence,
        kind: kindFromText(sentence),
        confidence: Math.min(0.95, Math.max(0.55, memory.confidence)),
        source_memory_ids: [memory.id],
        metadata: {
          provider: "local",
          reasoning: "explicit_memory_observation",
          session_id: options.sessionId,
          memory_tags: memory.tags,
        },
      });
    }
    if (conclusions.length >= maxItems) break;
  }

  for (const [tag, count] of mostCommon(tagCounts(memories), 5)) {
    if (count < 2 || conclusions.length >= maxItems) continue;
    const sourceIds = memories.filter((memory) => memory.tags.includes(tag)).map((memory) => memory.id).slice(0, 20);
    conclusions.push({
      content: `Recurring theme for ${options.peerId}: ${tag} appears across ${count} memories.`,
      kind: "inductive",
      confidence: Math.min(0.9, 0.55 + count * 0.08),
      source_memory_ids: sourceIds,
      metadata: { provider: "local", reasoning: "tag_frequency", tag, count },
    });
  }

  const summary = memories.length ? summarizeSession(memories, { previousSummaries: [], summaryType: "short", sessionId: options.sessionId ?? "" }) : null;
  return { conclusions, summary };
}

export function summarizeSession(
  memories: readonly MemoryRecord[],
  options: { previousSummaries: readonly string[]; summaryType: "short" | "long"; sessionId: string },
): string {
  if (!memories.length) return "No memories are available for this session yet.";
  const ranked = [...memories].sort((left, right) => {
    if (right.importance !== left.importance) return right.importance - left.importance;
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return right.created_at.localeCompare(left.created_at);
  });
  const cap = options.summaryType === "short" ? 8 : 20;
  const bullets: string[] = [];
  for (const memory of ranked.slice(0, cap)) {
    const sentence = firstSentence(memory.content, 220);
    if (sentence) bullets.push(`- ${sentence}`);
  }
  const title = options.summaryType.charAt(0).toUpperCase() + options.summaryType.slice(1);
  const prefix = `${title} summary for session ${options.sessionId}:`;
  if (options.previousSummaries.length) {
    const previous = options.previousSummaries.slice(-2).join(" ");
    return `${prefix}\nPrevious context: ${previous}\nCurrent highlights:\n${bullets.join("\n")}`;
  }
  return `${prefix}\n${bullets.join("\n")}`;
}

interface ConclusionLike {
  id?: string;
  content: string;
  confidence: number;
  source_memory_ids: string[];
  deleted_at: string | null;
  superseded_by: string | null;
  updated_at?: string;
  created_at?: string;
}

export function dream(
  conclusions: readonly ConclusionLike[],
  options: { peerId: string; sessionId: string | null; settings?: ReasoningSettings },
): ReasoningBatchResult {
  const settings = options.settings ?? DEFAULT_REASONING_SETTINGS;
  const active = conclusions.filter((item) => !item.deleted_at && !item.superseded_by);
  const textCounts = new Map<string, number>();
  const sourceByNorm = new Map<string, string[]>();
  for (const item of active) {
    const norm = normalizeText(item.content);
    if (!norm) continue;
    textCounts.set(norm, (textCounts.get(norm) ?? 0) + 1);
    const existing = sourceByNorm.get(norm) ?? [];
    existing.push(...(item.source_memory_ids ?? []));
    sourceByNorm.set(norm, existing);
  }

  const inferred: ReasonedConclusion[] = [];
  for (const [norm, count] of mostCommon(textCounts, 10)) {
    if (count < 2) continue;
    inferred.push({
      content: `Stable repeated conclusion for ${options.peerId}: ${norm}.`,
      kind: "inductive",
      confidence: Math.min(0.92, 0.6 + count * 0.08),
      source_memory_ids: [...new Set(sourceByNorm.get(norm) ?? [])].slice(0, 50),
      metadata: { provider: "local", reasoning: "dream_duplicate_pattern", count },
    });
  }

  const preferenceLines = active.filter((item) => item.content.toLowerCase().includes("prefer"));
  if (preferenceLines.length >= settings.reasoning_min_new_conclusions) {
    inferred.push({
      content: `${options.peerId} has recurring preference evidence across ${preferenceLines.length} conclusions.`,
      kind: "inductive",
      confidence: 0.82,
      source_memory_ids: [...new Set(preferenceLines.flatMap(item => item.id ? [item.id] : item.source_memory_ids))],
      metadata: { provider: "local", reasoning: "dream_preference_pattern", session_id: options.sessionId },
    });
  }

  const conflictTerms = ["not ", "no longer", "instead", "changed", "contradict"];
  if (active.some((item) => conflictTerms.some((term) => item.content.toLowerCase().includes(term)))) {
    inferred.push({
      content: `Possible changed or conflicting state exists for ${options.peerId}; review recent conclusions before acting.`,
      kind: "abductive",
      confidence: 0.65,
      source_memory_ids: [...new Set(active.filter(item => conflictTerms.some(term => item.content.toLowerCase().includes(term))).flatMap(item => item.id ? [item.id] : item.source_memory_ids))],
      metadata: { provider: "local", reasoning: "dream_conflict_hint", session_id: options.sessionId },
    });
  }

  return { conclusions: inferred, peer_card: buildPeerCard(active, options) };
}

export function buildPeerCard(
  conclusions: readonly ConclusionLike[],
  options: { peerId: string; settings?: ReasoningSettings },
): ReasonedConclusion[] {
  const settings = options.settings ?? DEFAULT_REASONING_SETTINGS;
  const ranked = conclusions
    .filter((item) => !item.deleted_at && !item.superseded_by)
    .sort((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return (right.updated_at ?? right.created_at ?? "").localeCompare(left.updated_at ?? left.created_at ?? "");
    });
  const cards: ReasonedConclusion[] = [];
  const seen = new Set<string>();
  for (const item of ranked) {
    const content = firstSentence(String(item.content), 260);
    const norm = normalizeText(content);
    if (!content || seen.has(norm) || !looksLikePeerCard(content)) continue;
    seen.add(norm);
    cards.push({
      content,
      kind: "peer_card",
      confidence: Math.min(0.95, item.confidence || 0.75),
      source_memory_ids: item.source_memory_ids ?? [],
      metadata: { provider: "local", reasoning: "peer_card_from_conclusion", peer_id: options.peerId },
    });
    if (cards.length >= settings.reasoning_peer_card_limit) break;
  }
  return cards;
}
