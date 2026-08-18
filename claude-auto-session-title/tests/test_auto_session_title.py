from __future__ import annotations

import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("auto_session_title", ROOT / "auto_session_title.py")
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class AutoSessionTitleTests(unittest.TestCase):
    def test_uses_first_non_meta_prompt_for_resumed_session(self):
        with tempfile.TemporaryDirectory() as temp:
            transcript = Path(temp) / "session.jsonl"
            transcript.write_text(
                "\n".join(
                    [
                        json.dumps({"type": "user", "isMeta": True, "message": {"role": "user", "content": "hook context"}}),
                        json.dumps({"type": "user", "isMeta": False, "message": {"role": "user", "content": "请帮我修复登录页 token 刷新，并补充回归测试"}}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            has_name, first = mod.transcript_info(transcript)
            self.assertFalse(has_name)
            self.assertEqual(first, "请帮我修复登录页 token 刷新，并补充回归测试")
            self.assertEqual(mod.heuristic_title(first), "修复登录页 token 刷新，并补充回归测试")

    def test_explicit_name_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            transcript = Path(temp) / "session.jsonl"
            transcript.write_text(
                json.dumps({"type": "agent-name", "agentName": "manual", "sessionId": "s"}) + "\n",
                encoding="utf-8",
            )
            has_name, _ = mod.transcript_info(transcript)
            self.assertTrue(has_name)

    def test_hook_emits_official_session_title_json(self):
        payload = {
            "hook_event_name": "UserPromptSubmit",
            "prompt": "帮我排查支付接口超时问题",
            "session_id": "s",
        }
        stdin = io.StringIO(json.dumps(payload, ensure_ascii=False))
        stdout = io.StringIO()
        with mock.patch("sys.stdin", stdin), mock.patch("sys.stdout", stdout):
            self.assertEqual(mod.main(), 0)
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
        self.assertEqual(result["hookSpecificOutput"]["sessionTitle"], "排查支付接口超时问题")


if __name__ == "__main__":
    unittest.main()
