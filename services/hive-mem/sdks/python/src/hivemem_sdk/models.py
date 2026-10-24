"""Lightweight type aliases for SDK consumers.

HiveMem's server is the source of truth for full Pydantic schemas. The SDK keeps
runtime dependencies small and exposes JSON-compatible dictionaries for forward
compatibility.
"""

from __future__ import annotations

from typing import Any, TypeAlias

JSONDict: TypeAlias = dict[str, Any]
Memory: TypeAlias = JSONDict
Session: TypeAlias = JSONDict
SearchResponse: TypeAlias = JSONDict
QueueStatus: TypeAlias = JSONDict
WebhookEndpoint: TypeAlias = JSONDict
WebhookDelivery: TypeAlias = JSONDict
