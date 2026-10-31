import type { ContextResponse, MemoryRecord } from "./types.js";

export class ContextPackage {
  readonly data: ContextResponse;

  constructor(data: ContextResponse) {
    this.data = data;
  }

  toOpenAI(options: { assistantPeerId?: string } = {}): Array<{ role: string; content: string }> {
    const formatted = this.data.formatted_context as unknown;
    if (Array.isArray(formatted)) return formatted as Array<{ role: string; content: string }>;
    if (formatted && typeof formatted === "object" && Array.isArray((formatted as { messages?: unknown }).messages)) {
      return (formatted as { messages: Array<{ role: string; content: string }> }).messages;
    }
    if (formatted && typeof formatted === "object"
      && (formatted as { format?: unknown }).format === "markdown"
      && typeof (formatted as { content?: unknown }).content === "string") {
      // Use the server's selected context verbatim, preserving citations and its token budget.
      const content = (formatted as { content: string }).content;
      const messages: Array<{ role: string; content: string }> = [];
      if (options.assistantPeerId) messages.push({ role: "system", content: `Assistant peer id: ${options.assistantPeerId}` });
      if (content) messages.push({ role: "system", content });
      return messages;
    }
    const messages: Array<{ role: string; content: string }> = [];
    if (options.assistantPeerId) {
      messages.push({ role: "system", content: `Assistant peer id: ${options.assistantPeerId}` });
    }
    const summary = this.data.summary as { content?: string } | string | undefined;
    if (summary) {
      messages.push({ role: "system", content: `HiveMem summary:\n${typeof summary === "string" ? summary : summary.content ?? ""}` });
    }
    const representation = this.data.representation as { context?: string } | string | undefined;
    if (representation) {
      const content = typeof representation === "string" ? representation : representation.context;
      if (content) messages.push({ role: "system", content: `HiveMem peer context:\n${content}` });
    }
    for (const entry of this.data.memories ?? []) {
      const memory = "memory" in entry && entry.memory && typeof entry.memory === "object"
        ? entry.memory as MemoryRecord
        : entry as MemoryRecord;
      if (typeof memory.content === "string") messages.push({ role: "system", content: `Memory: ${memory.content}` });
    }
    return messages;
  }

  toAnthropic(options: { assistantPeerId?: string } = {}): Array<{ role: string; content: string }> {
    const formatted = this.data.formatted_context as unknown;
    if (Array.isArray(formatted)) return formatted as Array<{ role: string; content: string }>;
    const content = this.toOpenAI(options).map((message) => message.content).join("\n\n");
    return content ? [{ role: "user", content }] : [];
  }

  raw(): ContextResponse {
    return this.data;
  }
}
