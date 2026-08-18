#!/usr/bin/env python3
"""Install or uninstall the Codex auto-thread-title Stop hook without clobbering other hooks."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

HOOK_SCRIPT_NAME = "auto_thread_title.py"
STATUS_MESSAGE = "Starting CLI auto-title worker..."


def default_codex_home() -> Path:
    configured = os.environ.get("CODEX_HOME")
    if configured:
        return Path(configured).expanduser()
    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        return Path(user_profile) / ".codex"
    return Path.home() / ".codex"


def load_hooks(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"hooks": {}}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"refusing to overwrite invalid hooks file {path}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"refusing to overwrite hooks file with non-object root: {path}")
    hooks = parsed.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise RuntimeError(f"refusing to overwrite hooks file whose 'hooks' field is not an object: {path}")
    return parsed


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def backup_file(path: Path) -> Path | None:
    if not path.exists():
        return None
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.bak-auto-thread-title-{stamp}")
    shutil.copy2(path, backup)
    return backup


def is_our_handler(handler: Any) -> bool:
    if not isinstance(handler, dict):
        return False
    if handler.get("type") != "command":
        return False
    for key in ("command", "commandWindows", "command_windows"):
        value = handler.get(key)
        if isinstance(value, str) and HOOK_SCRIPT_NAME in value:
            return True
    return False


def remove_existing(groups: Any) -> tuple[list[Any], int]:
    if not isinstance(groups, list):
        raise RuntimeError("hooks.Stop must be an array")
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


def build_handler(python_exe: Path, installed_script: Path) -> dict[str, Any]:
    posix_command = shlex.join([str(python_exe), str(installed_script)])
    windows_command = subprocess.list2cmdline([str(python_exe), str(installed_script)])
    return {
        "hooks": [
            {
                "type": "command",
                "command": posix_command,
                "commandWindows": windows_command,
                "timeout": 10,
                "statusMessage": STATUS_MESSAGE,
            }
        ]
    }


def install(codex_home: Path, python_exe: Path) -> int:
    package_root = Path(__file__).resolve().parent
    source_script = package_root / HOOK_SCRIPT_NAME
    if not source_script.is_file():
        raise RuntimeError(f"missing hook script beside installer: {source_script}")
    if not python_exe.is_file():
        raise RuntimeError(f"Python executable does not exist: {python_exe}")

    install_root = codex_home / "hooks" / "auto-thread-title"
    installed_script = install_root / HOOK_SCRIPT_NAME
    install_root.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_script, installed_script)

    hooks_path = codex_home / "hooks.json"
    config = load_hooks(hooks_path)
    hooks = config["hooks"]
    stop_groups, _ = remove_existing(hooks.get("Stop", []))
    stop_groups.append(build_handler(python_exe.resolve(), installed_script.resolve()))
    hooks["Stop"] = stop_groups

    backup = backup_file(hooks_path)
    atomic_write_json(hooks_path, config)

    print(f"Installed hook script: {installed_script}")
    print(f"Updated hooks config:  {hooks_path}")
    if backup:
        print(f"Backup:               {backup}")
    print("Restart Codex, then open /hooks if Codex asks you to review or trust the new hook.")
    return 0


def uninstall(codex_home: Path) -> int:
    hooks_path = codex_home / "hooks.json"
    if hooks_path.exists():
        config = load_hooks(hooks_path)
        hooks = config["hooks"]
        stop_groups, removed = remove_existing(hooks.get("Stop", []))
        if stop_groups:
            hooks["Stop"] = stop_groups
        else:
            hooks.pop("Stop", None)
        backup = backup_file(hooks_path)
        atomic_write_json(hooks_path, config)
        print(f"Removed {removed} auto-thread-title hook handler(s) from {hooks_path}")
        if backup:
            print(f"Backup: {backup}")
    else:
        print(f"No hooks config found at {hooks_path}")

    install_root = codex_home / "hooks" / "auto-thread-title"
    installed_script = install_root / HOOK_SCRIPT_NAME
    if installed_script.exists():
        installed_script.unlink()
        print(f"Removed hook script: {installed_script}")
    try:
        install_root.rmdir()
    except OSError:
        pass
    print(f"State/logs under {codex_home / 'auto-thread-title'} were preserved.")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--codex-home",
        type=Path,
        default=None,
        help="Codex home directory (default: CODEX_HOME, USERPROFILE/.codex, or ~/.codex)",
    )
    parser.add_argument(
        "--python",
        dest="python_exe",
        type=Path,
        default=Path(sys.executable),
        help="Python executable embedded into the hook command (default: this interpreter)",
    )
    parser.add_argument("--uninstall", action="store_true", help="Remove only this hook and its installed script")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    codex_home = (args.codex_home or default_codex_home()).expanduser().resolve()
    try:
        if args.uninstall:
            return uninstall(codex_home)
        return install(codex_home, args.python_exe.expanduser())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
