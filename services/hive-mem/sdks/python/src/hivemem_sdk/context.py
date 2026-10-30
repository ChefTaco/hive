"""Context package helpers for LLM provider formats."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class ContextPackage:
    """Wrapper around HiveMem context responses with format helpers."""

    data: dict[str, Any]

    def to_openai(self, *, assistant_peer_id: str | None = None) -> list[dict[str, str]]:
        formatted = self.data.get("formatted_context")
        if isinstance(formatted, list):
            return formatted
        if isinstance(formatted, dict) and isinstance(formatted.get("messages"), list):
            return formatted["messages"]
        messages: list[dict[str, str]] = []
        summary = self.data.get("summary")
        if summary:
            content = summary.get("content") if isinstance(summary, dict) else str(summary)
            messages.append({"role": "system", "content": f"HiveMem summary:\n{content}"})
        representation = self.data.get("representation")
        if representation:
            context = representation.get("context") if isinstance(representation, dict) else str(representation)
            if context:
                messages.append({"role": "system", "content": f"HiveMem peer context:\n{context}"})
        for memory in self.data.get("memories", []) or []:
            content = memory.get("content", "") if isinstance(memory, dict) else str(memory)
            messages.append({"role": "system", "content": f"Memory: {content}"})
        if assistant_peer_id:
            messages.insert(0, {"role": "system", "content": f"Assistant peer id: {assistant_peer_id}"})
        return messages

    def to_anthropic(self, *, assistant_peer_id: str | None = None) -> list[dict[str, str]]:
        formatted = self.data.get("formatted_context")
        if isinstance(formatted, list):
            return formatted
        if isinstance(formatted, dict) and isinstance(formatted.get("messages"), list):
            return formatted["messages"]
        chunks = [message["content"] for message in self.to_openai(assistant_peer_id=assistant_peer_id)]
        return [{"role": "user", "content": "\n\n".join(chunks)}] if chunks else []

    def raw(self) -> dict[str, Any]:
        return self.data
