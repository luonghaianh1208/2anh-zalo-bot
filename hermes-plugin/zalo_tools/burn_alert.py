"""Cảnh báo bot đang đốt tiền model → gửi về bot của người vận hành (dashboard, ``/api/hooks/burn-alert``).

Chỉ báo hai chuyện tốn tiền thật, không báo lỗi vặt:
1. Một công cụ lỗi liên tiếp ``STREAK_LIMIT`` lần. Đếm cả lệnh Hermes chặn trước guardrail (``status="blocked"``),
   vì vòng lặp kiểu đó guardrail không thấy: sự cố 31/10/2026 lặp 381 lần chỉ vì thiếu tham số.
2. Tổng token trong một giờ vượt ``TOKEN_LIMIT``. Tính cả token cache nên ngưỡng phải cao: giờ bận thường tới 23 triệu.

Chỉ gửi tên công cụ, số đếm và model — không gửi nội dung trò chuyện. Không đặt ZALO_BURN_ALERT_URL và
ZALO_BURN_ALERT_TOKEN trong .env của Hermes thì mô-đun không làm gì."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.request
from collections import deque
from typing import Any, Dict

logger = logging.getLogger(__name__)

STREAK_LIMIT = 10
TOKEN_LIMIT = 30_000_000
WINDOW_S = 3600
COOLDOWN_S = 1800
SEND_TIMEOUT_S = 10
# Công cụ mà "lỗi" là kết quả công việc bình thường (test đỏ, trang timeout) — cùng danh sách với guardrail của Hermes.
FAILURE_TOLERANT = frozenset({"terminal", "execute_code", "process_manage", "process", "browser_navigate", "web_extract"})

_lock = threading.Lock()
_streaks: Dict[tuple, int] = {}
_tokens: deque = deque()
_token_sum = 0
_last_sent: Dict[tuple, float] = {}
_last_model = ""


def _configured() -> bool:
    return bool(os.getenv("ZALO_BURN_ALERT_URL") and os.getenv("ZALO_BURN_ALERT_TOKEN"))


def _post(payload: Dict[str, Any]) -> None:
    request = urllib.request.Request(
        os.environ["ZALO_BURN_ALERT_URL"], data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {os.environ['ZALO_BURN_ALERT_TOKEN']}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=SEND_TIMEOUT_S):
            pass
        logger.warning("[zalo] đã gửi cảnh báo đốt tiền: %s", payload)
    except Exception as exc:  # cố hết sức — không gửi được thì để lại dấu trong log của máy này
        logger.warning("[zalo] KHÔNG gửi được cảnh báo đốt tiền %s: %s", payload, type(exc).__name__)


def _alert(key: tuple, payload: Dict[str, Any]) -> None:
    """Gọi trong _lock. Gửi ở luồng riêng để hook không làm chậm lượt của bot."""
    now = time.monotonic()
    last = _last_sent.get(key)
    if last is not None and now - last < COOLDOWN_S:
        return
    _last_sent[key] = now
    threading.Thread(target=_post, args=(payload,), name="zalo-burn-alert", daemon=True).start()


def _underlying_tool(tool_name: str, args: Any) -> str:
    """Lệnh bị chặn ở cầu ``tool_call`` vẫn mang tên cầu: lấy tên công cụ thật cho dễ đọc."""
    if tool_name == "tool_call" and isinstance(args, dict):
        calls = args.get("calls")
        if isinstance(calls, list) and calls and isinstance(calls[0], dict):
            return str(calls[0].get("name") or tool_name)
    return tool_name


def _failed(status: Any, result: Any) -> bool:
    if status == "blocked":
        return True
    try:
        data = json.loads(result) if isinstance(result, str) else result
    except ValueError:
        return False
    return isinstance(data, dict) and (bool(data.get("error")) or data.get("success") is False)


def post_tool_call(tool_name: str = "", args: Any = None, result: Any = None, session_id: str = "",
                   status: Any = None, **_kw) -> None:
    """Hook Hermes: đếm lỗi liên tiếp theo từng phiên và công cụ."""
    try:
        if not _configured():
            return None
        tool = _underlying_tool(tool_name, args)
        if tool in FAILURE_TOLERANT:
            return None
        key = (session_id, tool)
        with _lock:
            if not _failed(status, result):
                _streaks.pop(key, None)
                return None
            count = _streaks[key] = _streaks.get(key, 0) + 1
            if count >= STREAK_LIMIT:
                _alert(("tool_loop", tool), {"kind": "tool_loop", "tool": tool, "count": count,
                                             "model": _last_model or "unknown"})
    except Exception:  # cố hết sức — hook không được làm hỏng lượt của bot
        logger.debug("[zalo] burn_alert.post_tool_call lỗi", exc_info=True)
    return None


def post_api_request(usage: Any = None, model: str = "", **_kw) -> None:
    """Hook Hermes: cộng token của mỗi lần gọi model vào cửa sổ một giờ."""
    global _token_sum, _last_model
    try:
        if not _configured():
            return None
        used = int((usage or {}).get("total_tokens") or 0)
        now = time.monotonic()
        with _lock:
            _last_model = str(model or _last_model)
            _tokens.append((now, used))
            _token_sum += used
            while _tokens and now - _tokens[0][0] > WINDOW_S:
                _token_sum -= _tokens.popleft()[1]
            if _token_sum >= TOKEN_LIMIT:
                _alert(("token_burn",), {"kind": "token_burn", "count": _token_sum, "model": _last_model or "unknown"})
    except Exception:  # cố hết sức — hook không được làm hỏng lượt của bot
        logger.debug("[zalo] burn_alert.post_api_request lỗi", exc_info=True)
    return None
