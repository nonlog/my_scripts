#!/usr/bin/env python3
"""Install the Claude Code UserPromptSubmit auto-title hook while preserving other settings."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

SCRIPT_NAME = "auto_session_title.py"
EVENT_NAME = "UserPromptSubmit"


def default_claude_home() -> Path:
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    if configured:
        return Path(configured).expanduser()
    profile = os.environ.get("USERPROFILE")
    if profile:
        return Path(profile) / ".claude"
    return Path.home() / ".claude"


def load_settings(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    parsed = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise RuntimeError("Claude settings root must be a JSON object")
    return parsed


def backup(path: Path) -> Path | None:
    if not path.exists():
        return None
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    target = path.with_name(f"{path.name}.bak-auto-session-title-{stamp}")
    shutil.copy2(path, target)
    return target


def is_our_handler(handler: Any) -> bool:
    if not isinstance(handler, dict) or handler.get("type") != "command":
        return False
    command = handler.get("command")
    return isinstance(command, str) and SCRIPT_NAME in command


def clean_groups(groups: Any) -> tuple[list[Any], int]:
    if groups is None:
        return [], 0
    if not isinstance(groups, list):
        raise RuntimeError(f"hooks.{EVENT_NAME} must be an array")
    cleaned: list[Any] = []
    removed = 0
    for group in groups:
        if not isinstance(group, dict):
            cleaned.append(group)
            continue
        handlers = group.get("hooks")
        if not isinstance(handlers, list):
            cleaned.append(group)
            continue
        kept = [handler for handler in handlers if not is_our_handler(handler)]
        removed += len(handlers) - len(kept)
        if kept:
            copy = dict(group)
            copy["hooks"] = kept
            cleaned.append(copy)
    return cleaned, removed


def atomic_write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def install(claude_home: Path, python_exe: Path) -> int:
    source = Path(__file__).resolve().parent / SCRIPT_NAME
    if not source.is_file():
        raise RuntimeError(f"missing source hook: {source}")
    if not python_exe.is_file():
        raise RuntimeError(f"Python executable does not exist: {python_exe}")

    hooks_dir = claude_home / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    installed = hooks_dir / SCRIPT_NAME
    shutil.copy2(source, installed)

    settings_path = claude_home / "settings.json"
    settings = load_settings(settings_path)
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise RuntimeError("Claude settings 'hooks' must be a JSON object")

    groups, _ = clean_groups(hooks.get(EVENT_NAME))
    command = f'"{python_exe.resolve()}" "{installed.resolve()}"'
    groups.append(
        {
            "hooks": [
                {
                    "type": "command",
                    "command": command,
                    "timeout": 5,
                }
            ]
        }
    )
    hooks[EVENT_NAME] = groups

    saved = backup(settings_path)
    atomic_write(settings_path, settings)
    print(f"Installed hook script: {installed}")
    print(f"Updated settings:      {settings_path}")
    if saved:
        print(f"Backup:                {saved}")
    return 0


def uninstall(claude_home: Path) -> int:
    settings_path = claude_home / "settings.json"
    if settings_path.exists():
        settings = load_settings(settings_path)
        hooks = settings.get("hooks")
        if isinstance(hooks, dict):
            groups, removed = clean_groups(hooks.get(EVENT_NAME))
            if groups:
                hooks[EVENT_NAME] = groups
            else:
                hooks.pop(EVENT_NAME, None)
            saved = backup(settings_path)
            atomic_write(settings_path, settings)
            print(f"Removed {removed} hook handler(s)")
            if saved:
                print(f"Backup: {saved}")
    installed = claude_home / "hooks" / SCRIPT_NAME
    if installed.exists():
        installed.unlink()
        print(f"Removed hook script: {installed}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude-home", type=Path, default=None)
    parser.add_argument("--python", dest="python_exe", type=Path, default=Path(sys.executable))
    parser.add_argument("--uninstall", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    claude_home = (args.claude_home or default_claude_home()).expanduser().resolve()
    try:
        if args.uninstall:
            return uninstall(claude_home)
        return install(claude_home, args.python_exe.expanduser())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
