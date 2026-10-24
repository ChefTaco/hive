"""Error types for the HiveMem Python SDK."""

from __future__ import annotations

from typing import Any


class HiveMemError(Exception):
    """Base SDK error."""


class HiveMemHTTPError(HiveMemError):
    """Raised when the HiveMem API returns a non-success status."""

    def __init__(self, status_code: int, message: str, *, details: Any | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.details = details

    def to_dict(self) -> dict[str, Any]:
        return {"status_code": self.status_code, "message": str(self), "details": self.details}
