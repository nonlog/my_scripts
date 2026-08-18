from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


auto = load_module("auto_thread_title", ROOT / "auto_thread_title.py")
installer = load_module("auto_thread_title_installer", ROOT / "install.py")


class FakeClient:
    threads: list[dict] = []
    names: list[tuple[str, str]] = []

    def __init__(self, *_args, **_kwargs):
        self._reads = iter(self.threads)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read_thread(self, _thread_id: str) -> dict:
        return next(self._reads)

    def set_thread_name(self, thread_id: str, name: str) -> None:
        self.names.append((thread_id, name))


class AutoTitleTests(unittest.TestCase):
    def setUp(self):
        FakeClient.threads = []
        FakeClient.names = []

    def test_sanitize_title_accepts_json_and_strips_label(self):
        self.assertEqual(auto.sanitize_title('{"title":"修复 Codex 会话命名。"}', 64), "修复 Codex 会话命名")
        self.assertEqual(auto.sanitize_title("Title: Fix thread naming!", 64), "Fix thread naming")

    def test_heuristic_removes_absolute_path_and_url(self):
        title = auto.heuristic_title("修复 D:\\Workspace\\secret\\app.py 的问题 https://example.com/x", 64)
        self.assertNotIn("D:\\", title)
        self.assertNotIn("https://", title)
        self.assertTrue(title)

    def test_launcher_spawns_detached_worker_with_reduced_payload(self):
        with tempfile.TemporaryDirectory() as state:
            with (
                mock.patch.dict("os.environ", {"CODEX_AUTO_TITLE_STATE_DIR": state}, clear=False),
                mock.patch.object(auto.subprocess, "Popen") as popen,
            ):
                auto.spawn_background_worker(
                    {
                        "hook_event_name": "UserPromptSubmit",
                        "session_id": "s-launch",
                        "model": "gpt-test",
                        "last_assistant_message": "must not be forwarded",
                    }
                )
                self.assertEqual(popen.call_count, 1)
                args, kwargs = popen.call_args
                self.assertIn(auto.WORKER_FLAG, args[0])
                worker_payload = json.loads(kwargs["env"][auto.WORKER_PAYLOAD_ENV])
                self.assertEqual(
                    worker_payload,
                    {"hook_event_name": "UserPromptSubmit", "session_id": "s-launch", "model": "gpt-test"},
                )
                self.assertNotIn("last_assistant_message", worker_payload)

    def test_non_cli_thread_is_never_named(self):
        with tempfile.TemporaryDirectory() as state:
            FakeClient.threads = [{"source": "appServer", "name": None, "preview": "hello"}]
            with (
                mock.patch.dict("os.environ", {"CODEX_AUTO_TITLE_STATE_DIR": state}, clear=False),
                mock.patch.object(auto, "AppServerClient", FakeClient),
                mock.patch.object(auto, "find_codex", return_value="codex"),
            ):
                rc = auto.handle_hook({"hook_event_name": "UserPromptSubmit", "session_id": "s1"})
                self.assertEqual(rc, 0)
                self.assertEqual(FakeClient.names, [])
                marker = json.loads((Path(state) / "processed" / "s1.json").read_text(encoding="utf-8"))
                self.assertEqual(marker["reason"], "source:appServer")

    def test_existing_name_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as state:
            FakeClient.threads = [{"source": "cli", "name": "Manual title", "preview": "hello"}]
            with (
                mock.patch.dict("os.environ", {"CODEX_AUTO_TITLE_STATE_DIR": state}, clear=False),
                mock.patch.object(auto, "AppServerClient", FakeClient),
                mock.patch.object(auto, "find_codex", return_value="codex"),
            ):
                auto.handle_hook({"hook_event_name": "UserPromptSubmit", "session_id": "s2"})
                self.assertEqual(FakeClient.names, [])

    def test_manual_rename_race_wins(self):
        with tempfile.TemporaryDirectory() as state:
            FakeClient.threads = [
                {"source": "cli", "name": None, "preview": "fix the login bug", "modelProvider": "openai"},
                {"source": "cli", "name": "My manual title", "preview": "fix the login bug", "modelProvider": "openai"},
            ]
            with (
                mock.patch.dict("os.environ", {"CODEX_AUTO_TITLE_STATE_DIR": state}, clear=False),
                mock.patch.object(auto, "AppServerClient", FakeClient),
                mock.patch.object(auto, "find_codex", return_value="codex"),
                mock.patch.object(auto, "generate_title", return_value="Fix login bug"),
            ):
                auto.handle_hook({"hook_event_name": "UserPromptSubmit", "session_id": "s3", "model": "gpt-test"})
                self.assertEqual(FakeClient.names, [])
                marker = json.loads((Path(state) / "processed" / "s3.json").read_text(encoding="utf-8"))
                self.assertEqual(marker["reason"], "named_during_generation")

    def test_cli_thread_gets_named_once(self):
        with tempfile.TemporaryDirectory() as state:
            FakeClient.threads = [
                {"source": "cli", "name": None, "preview": "fix the login bug", "modelProvider": "openai"},
                {"source": "cli", "name": None, "preview": "fix the login bug", "modelProvider": "openai"},
            ]
            with (
                mock.patch.dict("os.environ", {"CODEX_AUTO_TITLE_STATE_DIR": state}, clear=False),
                mock.patch.object(auto, "AppServerClient", FakeClient),
                mock.patch.object(auto, "find_codex", return_value="codex"),
                mock.patch.object(auto, "generate_title", return_value="Fix login bug"),
            ):
                auto.handle_hook({"hook_event_name": "UserPromptSubmit", "session_id": "s4", "model": "gpt-test"})
                self.assertEqual(FakeClient.names, [("s4", "Fix login bug")])
                auto.handle_hook({"hook_event_name": "UserPromptSubmit", "session_id": "s4", "model": "gpt-test"})
                self.assertEqual(FakeClient.names, [("s4", "Fix login bug")])


class InstallerTests(unittest.TestCase):
    def test_install_merge_and_uninstall_preserve_other_hooks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            hooks_path = root / "hooks.json"
            hooks_path.write_text(
                json.dumps(
                    {
                        "description": "keep me",
                        "hooks": {
                            "SessionStart": [{"hooks": [{"type": "command", "command": "other-start"}]}],
                            "Stop": [{"hooks": [{"type": "command", "command": "other-stop"}]}],
                        },
                    }
                ),
                encoding="utf-8",
            )
            package_script = ROOT / "auto_thread_title.py"
            install_root = root / "hooks" / "auto-thread-title"
            install_root.mkdir(parents=True)
            installed = install_root / "auto_thread_title.py"
            installed.write_text(package_script.read_text(encoding="utf-8"), encoding="utf-8")

            config = installer.load_hooks(hooks_path)
            hooks = config["hooks"]
            for event_name in (installer.LEGACY_EVENT_NAME, installer.EVENT_NAME):
                groups, removed = installer.remove_existing(hooks.get(event_name, []))
                self.assertEqual(removed, 0)
                if groups:
                    hooks[event_name] = groups
                else:
                    hooks.pop(event_name, None)
            hooks[installer.EVENT_NAME] = [
                installer.build_handler(Path(__import__("sys").executable), installed)
            ]
            installer.atomic_write_json(hooks_path, config)

            merged = json.loads(hooks_path.read_text(encoding="utf-8"))
            self.assertEqual(merged["description"], "keep me")
            self.assertEqual(len(merged["hooks"]["SessionStart"]), 1)
            self.assertEqual(len(merged["hooks"]["Stop"]), 1)
            self.assertEqual(len(merged["hooks"]["UserPromptSubmit"]), 1)
            auto_handler = merged["hooks"]["UserPromptSubmit"][0]["hooks"][0]
            self.assertNotIn("async", auto_handler)
            self.assertEqual(auto_handler["timeout"], 10)

            cleaned, removed = installer.remove_existing(merged["hooks"]["UserPromptSubmit"])
            self.assertEqual(removed, 1)
            self.assertEqual(cleaned, [])
            self.assertEqual(merged["hooks"]["Stop"], [{"hooks": [{"type": "command", "command": "other-stop"}]}])


if __name__ == "__main__":
    unittest.main()
