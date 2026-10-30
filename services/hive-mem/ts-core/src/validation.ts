import type { JobStatus, JsonObject, JsonValue, MemoryScope, MemorySource, MemoryType, RedactionPolicy, Sensitivity, TaskType } from "./types.js";

export class ValidationError extends Error {
  readonly status = 422;

  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: unknown, name: string): JsonObject {
  if (!isJsonObject(value)) throw new ValidationError(`${name} must be an object`);
  return value;
}

export function optionalString(value: JsonValue | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${name} must be a string`);
  return value;
}

export function requiredString(value: JsonValue | undefined, name: string): string {
  const parsed = optionalString(value, name);
  if (!parsed || parsed.trim().length === 0) throw new ValidationError(`${name} is required`);
  return parsed;
}

export function optionalNullableString(value: JsonValue | undefined, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${name} must be a string or null`);
  return value;
}

export function optionalNumber(value: JsonValue | undefined, name: string, fallback: number): number;
export function optionalNumber(value: JsonValue | undefined, name: string): number | undefined;
export function optionalNumber(value: JsonValue | undefined, name: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`${name} must be a finite number`);
  return value;
}

export function optionalBoolean(value: JsonValue | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ValidationError(`${name} must be a boolean`);
  return value;
}

export function optionalStringArray(value: JsonValue | undefined, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ValidationError(`${name} must be an array of strings`);
  }
  return value as string[];
}

export function optionalJsonObject(value: JsonValue | undefined, name: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  return asJsonObject(value, name);
}

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  const rounded = Math.trunc(value ?? fallback);
  if (rounded < 1) return 1;
  if (rounded > max) return max;
  return rounded;
}

export function parseEnum<T extends string>(value: JsonValue | undefined, name: string, allowed: readonly T[], fallback: T): T;
export function parseEnum<T extends string>(value: JsonValue | undefined, name: string, allowed: readonly T[]): T | undefined;
export function parseEnum<T extends string>(value: JsonValue | undefined, name: string, allowed: readonly T[], fallback?: T): T | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export const memoryScopes = ["private", "shared"] as const satisfies readonly MemoryScope[];
export const memoryTypes = ["episodic", "semantic", "procedural"] as const satisfies readonly MemoryType[];
export const memorySources = ["conversation", "research", "observation", "consolidation", "user_feedback", "skill", "system"] as const satisfies readonly MemorySource[];
export const sensitivities = ["public", "internal", "sensitive", "restricted"] as const satisfies readonly Sensitivity[];
export const redactionPolicies = ["none", "redact", "exclude"] as const satisfies readonly RedactionPolicy[];

export const taskTypes = [
  "representation",
  "summary",
  "consolidation",
  "dream",
  "decay_recalc",
  "conflict_scan",
  "peer_card",
  "embedding_reconcile",
  "webhook_delivery",
  "message_extract",
  "sleep",
  "forgetting_review",
] as const satisfies readonly TaskType[];
export const jobStatuses = ["pending", "in_progress", "completed", "failed", "dead_letter", "cancelled"] as const satisfies readonly JobStatus[];
