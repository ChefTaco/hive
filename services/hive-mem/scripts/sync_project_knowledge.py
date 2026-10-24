#!/usr/bin/env python3
"""Preview or apply deterministic Markdown/text project knowledge ingestion."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import ssl
import sys
from datetime import datetime, timezone
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener


ALLOWED_SUFFIXES = {".md", ".markdown", ".txt"}
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?im)^\s*(?:api[_-]?key|secret|password|private[_-]?key|access[_-]?token)\s*[:=]\s*[^\s$<{][^\r\n]{7,}"),
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,})\b"),
)
HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


class NoRedirect(HTTPRedirectHandler):
    def http_error_301(self, req, fp, code, msg, headers):  # type: ignore[no-untyped-def]
        return None

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301


def selected_files(root: Path, includes: list[str], excludes: list[str]) -> list[Path]:
    root = root.resolve(strict=True)
    found: dict[str, Path] = {}
    for pattern in includes:
        for candidate in root.glob(pattern):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            resolved = candidate.resolve(strict=True)
            if resolved != root and root not in resolved.parents:
                raise ValueError(f"selected path escapes root: {candidate}")
            relative = resolved.relative_to(root).as_posix()
            if any(fnmatch.fnmatch(relative, pattern) for pattern in excludes):
                continue
            if resolved.suffix.lower() not in ALLOWED_SUFFIXES:
                raise ValueError(f"unsupported source type: {relative}")
            found[relative] = resolved
    if not found:
        raise ValueError("no selected Markdown/text files")
    return [found[key] for key in sorted(found)]


def safe_text(path: Path) -> str:
    raw = path.read_bytes()
    if b"\0" in raw:
        raise ValueError(f"binary source rejected: {path}")
    text = raw.decode("utf-8")
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            raise ValueError(f"possible credential material rejected: {path}")
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


def split_sections(text: str) -> list[tuple[str | None, str]]:
    sections: list[tuple[str | None, list[str]]] = []
    heading: str | None = None
    lines: list[str] = []
    for line in text.splitlines():
        match = HEADING.match(line)
        if match and lines:
            sections.append((heading, lines))
            lines = []
        if match:
            heading = match.group(2).strip()
        lines.append(line)
    if lines:
        sections.append((heading, lines))
    return [(title, "\n".join(body).strip()) for title, body in sections if "\n".join(body).strip()]


def bounded_parts(text: str, maximum: int = 12000) -> list[str]:
    if len(text.encode()) <= maximum:
        return [text]
    parts: list[str] = []
    current: list[str] = []
    size = 0
    for paragraph in re.split(r"\n{2,}", text):
        encoded = len(paragraph.encode()) + (2 if current else 0)
        if current and size + encoded > maximum:
            parts.append("\n\n".join(current))
            current, size = [], 0
        if len(paragraph.encode()) > maximum:
            if current:
                parts.append("\n\n".join(current)); current, size = [], 0
            remainder = paragraph
            while remainder:
                low, high = 1, len(remainder)
                while low < high:
                    middle = (low + high + 1) // 2
                    if len(remainder[:middle].encode()) <= maximum:
                        low = middle
                    else:
                        high = middle - 1
                parts.append(remainder[:low]); remainder = remainder[low:]
        else:
            current.append(paragraph); size += encoded
    if current:
        parts.append("\n\n".join(current))
    return parts


def build_chunks(root: Path, paths: list[Path]) -> list[dict[str, object]]:
    root = root.resolve(strict=True)
    chunks: list[dict[str, object]] = []
    for path in paths:
        relative = path.resolve(strict=True).relative_to(root).as_posix()
        for section_index, (heading, section) in enumerate(split_sections(safe_text(path)), start=1):
            slug = re.sub(r"[^a-z0-9]+", "-", (heading or "document").lower()).strip("-") or "document"
            for part_index, content in enumerate(bounded_parts(section), start=1):
                chunks.append({
                    "chunk_key": f"{relative}#{slug}-{section_index}:{part_index}",
                    "content": content,
                    "content_hash": hashlib.sha256(content.encode()).hexdigest(),
                    "heading": heading,
                    "tags": ["repo-doc", "path-" + hashlib.sha256(relative.encode()).hexdigest()[:16]],
                    "entities": [],
                })
    return chunks


def api_request(url: str, token: str, payload: dict[str, object]) -> dict[str, object]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("api-url must be an absolute HTTP(S) URL")
    if parsed.scheme != "https" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("non-loopback HiveMem endpoints require HTTPS")
    opener = build_opener(HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
    request = Request(url.rstrip("/") + "/v1/knowledge/sources/sync", data=json.dumps(payload).encode(), method="POST",
                      headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with opener.open(request, timeout=30) as response:
        body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise ValueError("HiveMem response exceeds 1 MiB")
        return json.loads(body)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--include", action="append", required=True, help="Root-relative glob; repeat as needed")
    parser.add_argument("--exclude", action="append", default=[])
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--source-uri", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--api-url", default=os.environ.get("HERMES_HIVEMEM_API_URL", ""))
    parser.add_argument("--token-env", default="HERMES_HIVEMEM_TOKEN")
    parser.add_argument("--workspace-id", default="hermes:team:main")
    parser.add_argument("--observed-at", default=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
    parser.add_argument("--expires-at")
    parser.add_argument("--apply", action="store_true", help="Apply the sync; default is a server-side preview")
    parser.add_argument("--print-request", action="store_true", help="Print the credential-free request without contacting HiveMem")
    args = parser.parse_args()
    paths = selected_files(args.root, args.include, args.exclude)
    payload: dict[str, object] = {
        "mode": "apply" if args.apply else "preview",
        "workspace_id": args.workspace_id,
        "project_id": args.project_id,
        "source_id": args.source_id,
        "source_uri": args.source_uri,
        "revision": args.revision,
        "observed_at": args.observed_at,
        "scope": "shared",
        "chunks": build_chunks(args.root, paths),
    }
    if args.expires_at:
        payload["expires_at"] = args.expires_at
    if args.print_request:
        print(json.dumps(payload, indent=2, sort_keys=True)); return 0
    if not args.api_url:
        raise ValueError("--api-url or HERMES_HIVEMEM_API_URL is required")
    token = os.environ.get(args.token_env, "").strip()
    if not token:
        raise ValueError(f"{args.token_env} is not configured")
    print(json.dumps(api_request(args.api_url, token, payload), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
