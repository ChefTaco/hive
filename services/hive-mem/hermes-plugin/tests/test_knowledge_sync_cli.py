from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


SOURCE = Path(__file__).resolve().parents[2] / "scripts" / "sync_project_knowledge.py"
SPEC = importlib.util.spec_from_file_location("knowledge_sync_cli", SOURCE)
assert SPEC and SPEC.loader
CLI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLI)


def test_selected_files_and_chunks_are_deterministic(tmp_path: Path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "guide.md").write_text("# Alpha\n\nFirst fact.\n\n## Beta\n\nSecond fact.\n", encoding="utf-8")
    selected = CLI.selected_files(tmp_path, ["docs/**/*.md"], [])
    first = CLI.build_chunks(tmp_path, selected)
    second = CLI.build_chunks(tmp_path, selected)
    assert first == second
    assert [chunk["heading"] for chunk in first] == ["Alpha", "Beta"]
    assert all(len(chunk["content_hash"]) == 64 for chunk in first)


def test_source_selection_rejects_credentials_binary_symlinks_and_escape(tmp_path: Path):
    (tmp_path / "secret.md").write_text("api_key = definitely-not-a-fixture-secret-value", encoding="utf-8")
    with pytest.raises(ValueError, match="credential"):
        CLI.build_chunks(tmp_path, CLI.selected_files(tmp_path, ["secret.md"], []))
    (tmp_path / "binary.txt").write_bytes(b"text\0binary")
    with pytest.raises(ValueError, match="binary"):
        CLI.build_chunks(tmp_path, CLI.selected_files(tmp_path, ["binary.txt"], []))
    outside = tmp_path.parent / "outside-knowledge.md"
    outside.write_text("outside", encoding="utf-8")
    link = tmp_path / "linked.md"
    link.symlink_to(outside)
    with pytest.raises(ValueError, match="no selected"):
        CLI.selected_files(tmp_path, ["linked.md"], [])


def test_unicode_chunks_remain_valid_and_bounded():
    parts = CLI.bounded_parts("🙂" * 100, maximum=37)
    assert "".join(parts) == "🙂" * 100
    assert all(len(part.encode()) <= 37 for part in parts)
