#!/usr/bin/env python3
"""Set a Claude Code session title from the first real user prompt.

Designed for a UserPromptSubmit command hook. It reads hook JSON on stdin and emits
only the official hookSpecificOutput.sessionTitle JSON when a title should be set.
It never edits Claude Code transcript/state files.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

MAX_TITLE_CHARS = 64
MANUAL_TITLE_TYPES = {"custom-title", "agent-name"}


def text_from_content(content: Any) -> str | None:
    if isinstance(content, str):
        text = content.strip()
        return text or None
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            parts.append(part["text"])
    text = "\n".join(parts).strip()
    return text or None


def transcript_info(path: Path) -> tuple[bool, str | None]:
    """Return (has_explicit_name, first_non_meta_user_prompt)."""
    if not path.is_file():
        return False, None
    has_explicit_name = False
    first_prompt: str | None = None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(entry, dict):
                    continue
                entry_type = entry.get("type")
                if entry_type in MANUAL_TITLE_TYPES:
                    has_explicit_name = True
                if first_prompt is not None or entry_type != "user" or entry.get("isMeta") is True:
                    continue
                message = entry.get("message")
                if not isinstance(message, dict) or message.get("role") != "user":
                    continue
                first_prompt = text_from_content(message.get("content"))
    except OSError:
        return False, None
    return has_explicit_name, first_prompt


def sanitize_title(raw: str) -> str:
    title = raw.strip()
    if not title:
        return ""
    title = title.splitlines()[0].strip()
    title = re.sub(r"^(?:title|session\s*title|name|标题|名称)\s*[:：]\s*", "", title, flags=re.I)
    title = title.strip(" \t\r\n`*_#\"'“”‘’")
    title = re.sub(r"\s+", " ", title)
    title = re.sub(r"[.。!！?？,，;；:：-]+$", "", title).strip()
    if len(title) > MAX_TITLE_CHARS:
        title = title[:MAX_TITLE_CHARS].rstrip(" .。!！?？,，;；:：-/\\")
    return title


def heuristic_title(source: str) -> str:
    text = source.strip()
    text = re.sub(r"https?://\S+", " ", text, flags=re.I)
    text = re.sub(r"\b[A-Za-z]:[\\/][^\s\"'<>|]+", " ", text)
    text = re.sub(r"(?<!:)//[^\s]+", " ", text)
    text = re.sub(r"(?:^|\s)/[\w./~-]{4,}", " ", text)
    text = re.sub(
        r"^\s*(?:请帮我|可以帮我|能不能|麻烦|帮我|请|please\s+|can\s+you\s+|could\s+you\s+)",
        "",
        text,
        flags=re.I,
    )
    text = re.sub(r"[`*_#]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    for separator in ("。", "！", "？", ". ", "! ", "? ", "；", "; "):
        index = text.find(separator)
        if index > 0:
            text = text[:index]
            break
    return sanitize_title(text) or "Claude task"


def build_output(title: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "sessionTitle": title,
        }
    }


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict) or payload.get("hook_event_name") != "UserPromptSubmit":
            return 0

        transcript_raw = payload.get("transcript_path")
        has_explicit_name = False
        first_prompt: str | None = None
        if isinstance(transcript_raw, str) and transcript_raw:
            has_explicit_name, first_prompt = transcript_info(Path(transcript_raw))
        if has_explicit_name:
            return 0

        source = first_prompt
        if not source and isinstance(payload.get("prompt"), str):
            source = payload["prompt"]
        if not source:
            return 0

        title = heuristic_title(source)
        if not title:
            return 0
        sys.stdout.write(json.dumps(build_output(title), ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception:
        # Fail open: a title failure must never reject or delay the user prompt.
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
