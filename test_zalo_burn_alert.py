"""Cảnh báo đốt tiền model: đếm lỗi lặp, cửa sổ token, chống gửi trùng, không lộ nội dung."""

import json
import os
import sys
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(__file__)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from gateway.config import PlatformConfig  # noqa: E402,F401
import zalo_test_env  # noqa: E402,F401
import plugins  # noqa: E402

plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
from plugins.zalo_tools import burn_alert  # noqa: E402

ERROR = json.dumps({"error": "cần `path` hoặc `paths`"})
ENV = {"ZALO_BURN_ALERT_URL": "https://x.test/api/hooks/burn-alert", "ZALO_BURN_ALERT_TOKEN": "t" * 20}


class BurnAlertTests(unittest.TestCase):
    def setUp(self):
        burn_alert._streaks.clear()
        burn_alert._tokens.clear()
        burn_alert._last_sent.clear()
        burn_alert._token_sum = 0
        burn_alert._last_model = ""
        self.sent = []
        self.enterContext(patch.dict(os.environ, ENV))
        self.enterContext(patch.object(burn_alert, "_alert", side_effect=self.record))
        self.clock = 1000.0
        self.enterContext(patch.object(burn_alert.time, "monotonic", lambda: self.clock))

    def record(self, key, payload):
        self.sent.append(payload)

    def fail_tool(self, tool="zalo_send_file", times=1, **kw):
        for _ in range(times):
            burn_alert.post_tool_call(tool_name=tool, result=ERROR, session_id="s1", **kw)

    def test_tenth_failure_alerts_not_ninth(self):
        self.fail_tool(times=9)
        self.assertEqual(self.sent, [])
        burn_alert.post_api_request(usage={"total_tokens": 5}, model="gpt-5.6-sol")
        self.fail_tool()
        self.assertEqual(self.sent, [{"kind": "tool_loop", "tool": "zalo_send_file", "count": 10, "model": "gpt-5.6-sol"}])

    def test_blocked_bridge_call_counts_under_the_real_tool_name(self):
        args = {"calls": [{"name": "zalo_send_file", "arguments": {}}]}
        for _ in range(10):
            burn_alert.post_tool_call(tool_name="tool_call", args=args, result="không phải JSON",
                                      session_id="s1", status="blocked")
        self.assertEqual(self.sent[0]["tool"], "zalo_send_file")

    def test_success_resets_the_streak(self):
        self.fail_tool(times=9)
        burn_alert.post_tool_call(tool_name="zalo_send_file", result='{"success": true}', session_id="s1")
        self.fail_tool(times=9)
        self.assertEqual(self.sent, [])

    def test_streaks_are_per_session_and_tool(self):
        self.fail_tool(times=5)
        self.fail_tool(tool="zalo_undo", times=5)
        burn_alert.post_tool_call(tool_name="zalo_send_file", result=ERROR, session_id="s2")
        self.assertEqual(self.sent, [])

    def test_failure_tolerant_tools_are_petty_errors(self):
        self.fail_tool(tool="terminal", times=30)
        self.assertEqual(self.sent, [])

    def test_tokens_alert_at_limit_and_window_slides(self):
        burn_alert.post_api_request(usage={"total_tokens": burn_alert.TOKEN_LIMIT - 1}, model="m")
        self.assertEqual(self.sent, [])
        self.clock += burn_alert.WINDOW_S + 1
        burn_alert.post_api_request(usage={"total_tokens": 2}, model="m")
        self.assertEqual(self.sent, [])
        burn_alert.post_api_request(usage={"total_tokens": burn_alert.TOKEN_LIMIT}, model="m")
        self.assertEqual(self.sent, [{"kind": "token_burn", "count": burn_alert.TOKEN_LIMIT + 2, "model": "m"}])

    def test_missing_usage_is_harmless(self):
        burn_alert.post_api_request(usage=None, model="m")
        self.assertEqual(self.sent, [])

    def test_not_configured_does_nothing(self):
        with patch.dict(os.environ, {"ZALO_BURN_ALERT_URL": ""}):
            self.fail_tool(times=20)
            burn_alert.post_api_request(usage={"total_tokens": burn_alert.TOKEN_LIMIT}, model="m")
        self.assertEqual(self.sent, [])
        self.assertEqual(burn_alert._streaks, {})


class CooldownTests(unittest.TestCase):
    def setUp(self):
        burn_alert._last_sent.clear()
        self.enterContext(patch.dict(os.environ, ENV))
        self.posted = []
        self.enterContext(patch.object(burn_alert.threading, "Thread", side_effect=self.thread))
        self.clock = 1000.0
        self.enterContext(patch.object(burn_alert.time, "monotonic", lambda: self.clock))

    def thread(self, target, args, **_kw):
        self.posted.append(args[0])
        return unittest.mock.Mock()

    def test_same_incident_alerts_once_per_cooldown(self):
        key = ("tool_loop", "zalo_send_file")
        burn_alert._alert(key, {"count": 10})
        burn_alert._alert(key, {"count": 11})
        burn_alert._alert(("tool_loop", "zalo_undo"), {"count": 10})
        self.assertEqual(self.posted, [{"count": 10}, {"count": 10}])
        self.clock += burn_alert.COOLDOWN_S
        burn_alert._alert(key, {"count": 300})
        self.assertEqual(self.posted[-1], {"count": 300})

    def test_post_sends_bearer_token_and_only_given_fields(self):
        captured = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

        def fake_urlopen(request, timeout):
            captured.update(url=request.full_url, auth=request.get_header("Authorization"),
                            body=json.loads(request.data), timeout=timeout)
            return Response()

        with patch.object(burn_alert.urllib.request, "urlopen", fake_urlopen):
            burn_alert._post({"kind": "tool_loop", "tool": "t", "count": 10, "model": "m"})
        self.assertEqual(captured["url"], ENV["ZALO_BURN_ALERT_URL"])
        self.assertEqual(captured["auth"], "Bearer " + "t" * 20)
        self.assertEqual(sorted(captured["body"]), ["count", "kind", "model", "tool"])

    def test_post_failure_does_not_raise_or_log_the_token(self):
        def boom(request, timeout):
            raise OSError("mất mạng " + request.get_header("Authorization"))

        with patch.object(burn_alert.urllib.request, "urlopen", boom), self.assertLogs(burn_alert.logger, "WARNING") as logs:
            burn_alert._post({"kind": "token_burn", "count": 1, "model": "m"})
        self.assertNotIn("t" * 20, "".join(logs.output))


if __name__ == "__main__":
    unittest.main()
