"""Zalo platform adapter (Hermes plugin).

Zalo has no official bot API for personal accounts, and neither Python
library for it is usable: ``zlapi`` is marked *stop_updating* and lost its
login server, ``zca-py`` is alpha. The actively maintained option is
``zca-js`` — JavaScript. So this adapter keeps zca-js as the Zalo layer and
talks to it over a loopback WebSocket.

    Zalo  ⇄  zca-js sidecar (Node, ws://127.0.0.1:3873)  ⇄  this adapter  ⇄  Hermes

Division of labour:

* the sidecar owns the Zalo session — QR login, cookie persistence, the
  reconnect loop, and the raw send/react/typing calls;
* this adapter owns the Hermes side — allowlists, group mention gating,
  ``MessageEvent`` construction and agent dispatch.

The result is that Zalo behaves like every other Hermes platform: the full
tool set, memory, skills and cron all work, because the message travels the
same path a Telegram message does.

Start the sidecar first, from wherever the 2anh-zalo-bot repo lives::

    npm start

Configuration in config.yaml::

    platforms:
      zalo:
        enabled: true
        extra:
          bridge_url: "ws://127.0.0.1:3873"
          reply_only_tagged: true      # groups: only answer when mentioned

Environment variables (env wins over config.yaml ``extra``):

    ZALO_BRIDGE_URL                WebSocket URL of the sidecar
    ZALO_ALLOWED_USERS             Comma-separated Zalo user IDs
    ZALO_ALLOW_ALL_USERS           Allow anyone — dev only
    ZALO_GROUP_REPLY_ONLY_TAGGED   Groups: only reply when tagged (default true)
    ZALO_HOME_CHANNEL              Default thread for cron delivery
    ZALO_HOME_CHANNEL_NAME         Display name for that thread

Identity model: Zalo user IDs are long numeric strings (17-21 digits) and
never start with ``0`` — phone numbers do. The allowlist rejects
phone-number-shaped entries rather than silently treating them as a user,
which is the failure that let every sender look like the owner in an
earlier iteration of this integration.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, List, Optional

try:
    import websockets
    WEBSOCKETS_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only on a broken install
    WEBSOCKETS_AVAILABLE = False
    websockets = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
    cache_image_from_url,
)

from agent.secret_scope import UnscopedSecretError as _UnscopedSecretError
from agent.secret_scope import get_secret as _scoped_get_secret

# Công cụ nằm ở plugin standalone `zalo_tools`, không phải ở đây — xem
# ghi chú trong plugins/zalo_tools/__init__.py về việc Hermes nạp platform
# plugin theo kiểu lười.
from plugins.zalo_tools.tools import TOOLSET_OWNER, TOOLSET_PUBLIC

from .flood import JUST_MUTED as FLOOD_JUST_MUTED
from .flood import MUTED as FLOOD_MUTED
from .flood import FloodGuard


def _transcode_to_aac(audio_path: str) -> Optional[str]:
    """Return a temporary AAC file suitable for Zalo voice messages."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    fd, output_path = tempfile.mkstemp(prefix="zalo_voice_", suffix=".aac")
    os.close(fd)
    try:
        result = subprocess.run(
            [
                ffmpeg, "-v", "error", "-y", "-i", audio_path,
                "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "96k",
                output_path,
            ],
            capture_output=True,
            timeout=60,
            stdin=subprocess.DEVNULL,
        )
        if result.returncode == 0 and os.path.getsize(output_path) > 0:
            return output_path
    except Exception:
        logger.debug("Zalo AAC conversion failed for %s", audio_path, exc_info=True)
    try:
        os.unlink(output_path)
    except OSError:
        pass
    return None


def _zalo_tools():
    """Trả về đúng bản module công cụ mà Hermes đã nạp.

    Hermes nạp plugin dưới namespace riêng ``hermes_plugins.<slug>``. Nếu
    adapter cứ ``from plugins.zalo_tools.tools import ...`` thì Python dựng ra
    một đối tượng module THỨ HAI, mang ``_ACTIVE_ADAPTER`` riêng của nó. Hậu
    quả rất khó lần: adapter gắn cầu nối vào bản của mình, còn công cụ agent
    gọi lại đọc bản Hermes nạp và thấy ``None``, nên bot trả lời "Zalo chưa
    kết nối" trong khi cầu vẫn thông và log vẫn báo đã nối.

    Hằng số toolset ở trên là chuỗi nên trùng lặp không sao; chỉ phần **trạng
    thái** mới bắt buộc phải dùng chung một bản.
    """
    mod = sys.modules.get("hermes_plugins.zalo_tools.tools")
    if mod is not None:
        return mod
    # Tên slug do Hermes đặt, không cam kết cố định — dò theo đặc điểm module
    # thay vì đoán tên.
    for name, candidate in list(sys.modules.items()):
        if (name.startswith("hermes_plugins.")
                and name.endswith(".tools")
                and hasattr(candidate, "set_active_adapter")
                and hasattr(candidate, "TOOLSET_OWNER")):
            return candidate
    from plugins.zalo_tools import tools as fallback
    return fallback


def _get_scoped_secret(name, default=None):
    """Scope-aware credential read with the default-profile startup fallback.

    Mirrors the pattern used by the ntfy and Slack adapters: a secondary
    profile's scope is authoritative, while the DEFAULT profile constructs
    unscoped and must fall back to ``os.environ`` instead of raising.
    """
    try:
        val = _scoped_get_secret(name, default)
    except _UnscopedSecretError:
        val = os.getenv(name)
    return val if val is not None else default


logger = logging.getLogger(__name__)

DEFAULT_BRIDGE_URL = "ws://127.0.0.1:3873"
# Zalo từ chối tin dài quá 3000 ký tự với lỗi "Nội dung quá dài". Đo bằng phép
# chia đôi trên tài khoản thật: ASCII, tiếng Việt có dấu và emoji đều dừng ở
# đúng 3000 — là số ĐƠN VỊ MÃ UTF-16, không phải byte.
#
# Trước đây hằng số này để 4000, nên mọi câu trả lời dài đều rơi vào khoảng
# chết: bot đọc xong, soạn xong, rồi im lặng vì không gửi đi được. Người trong
# nhóm chỉ thấy bot bị tag mà không nói gì.
#
# Để 2800 lấy chỗ thở: cầu nối dịch Markdown sang style Zalo sau khi cắt, và
# tuy phép dịch thường làm chuỗi NGẮN đi (bỏ dấu ** ` #) thì cũng không nên
# tính sát ngưỡng.
ZALO_HARD_LIMIT = 3000
MAX_MESSAGE_LENGTH = 2800
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]
ACK_TIMEOUT_SECONDS = 30

# Vài lệnh phải đọc tệp trước khi gửi, và kho tài liệu thường nằm trên ổ mạng
# (RaiDrive gắn Google Drive). Khi ổ đang nguội, chỉ riêng việc kéo tệp về đã
# mất khoảng 30 giây — đo được hai lần liên tiếp 30,02s và 30,03s, tức là sát
# ngưỡng chờ đến mức chỉ cần chậm thêm chút là hỏng. Nới riêng cho nhóm lệnh
# này thay vì nới tất cả: một lệnh gửi chữ mà treo 2 phút thì nên báo hỏng sớm.
SLOW_ACK_TIMEOUT_SECONDS = 150
SLOW_METHODS = frozenset({"uploadAttachment", "sendMessage", "sendVoice", "sendVideo"})
DEDUP_WINDOW_SECONDS = 300
DEDUP_MAX_SIZE = 1000
GROUP_CONTEXT_LIMIT = 5
_IMAGE_CONTEXT_RE = re.compile(
    r"\b(đây|này|kia|ảnh|hình|xe này|như thế|cái này|cái đó|trong ảnh)\b",
    re.IGNORECASE,
)

THREAD_TYPE_USER = 0
THREAD_TYPE_GROUP = 1

# Zalo IDs: long numeric, never leading zero. Phone numbers are the opposite.
_ZALO_ID_RE = re.compile(r"^[1-9]\d{14,21}$")


def _is_zalo_id(value: Any) -> bool:
    return bool(_ZALO_ID_RE.match(str(value or "").strip()))


def _split_ids(raw: str) -> List[str]:
    """Split a comma-separated allowlist, dropping phone-number-shaped junk."""
    out: List[str] = []
    rejected: List[str] = []
    for part in (raw or "").split(","):
        item = part.strip()
        if not item:
            continue
        (out if _is_zalo_id(item) else rejected).append(item)
    if rejected:
        logger.warning(
            "[zalo] ignoring %d allowlist entr%s that are not Zalo user IDs: %s "
            "(Zalo IDs are long numbers, not phone numbers)",
            len(rejected), "y" if len(rejected) == 1 else "ies", ", ".join(rejected),
        )
    return out


def _truthy(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def check_requirements() -> bool:
    """The adapter needs the ``websockets`` package; the sidecar is checked later."""
    return WEBSOCKETS_AVAILABLE


def validate_config(config) -> bool:
    return WEBSOCKETS_AVAILABLE


def is_connected(config) -> bool:
    """Zalo is considered configured whenever a bridge URL resolves."""
    extra = getattr(config, "extra", {}) or {}
    return bool(extra.get("bridge_url") or _get_scoped_secret("ZALO_BRIDGE_URL") or DEFAULT_BRIDGE_URL)


class ZaloAdapter(BasePlatformAdapter):
    """Bridges the zca-js sidecar into the Hermes gateway."""

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform("zalo"))

        extra = config.extra or {}
        self._bridge_url: str = (
            extra.get("bridge_url")
            or _get_scoped_secret("ZALO_BRIDGE_URL", DEFAULT_BRIDGE_URL)
        )
        self._reply_only_tagged: bool = _truthy(
            extra.get("reply_only_tagged",
                      _get_scoped_secret("ZALO_GROUP_REPLY_ONLY_TAGGED", "true")),
            default=True,
        )
        # Ai được nhắn riêng với bot.
        #   owner-only  chỉ người trong ZALO_ALLOWED_USERS  (mặc định)
        #   open        bất kỳ ai
        # Trong nhóm thì luôn mở: ai tag bot cũng được trả lời, nhưng chỉ với
        # bộ công cụ công khai (xem toolsets_for_source).
        self._dm_policy: str = str(
            extra.get("dm_policy", _get_scoped_secret("ZALO_DM_POLICY", "owner-only"))
        ).strip().lower()

        # Báo đã xem + thả cảm xúc khi nhận tin. Tắt được cho ai muốn bot
        # hoạt động kín tiếng.
        self._ack_gestures: bool = _truthy(
            extra.get("ack_gestures", _get_scoped_secret("ZALO_ACK_GESTURES", "true")),
            default=True,
        )
        self._auto_react: bool = _truthy(
            extra.get("auto_react", _get_scoped_secret("ZALO_AUTO_REACT", "true")),
            default=True,
        )

        # Ngưỡng đặt rộng tay có chủ đích: sáu tin trong mười lăm giây nhanh
        # hơn nhịp hỏi của người thật khá nhiều, nên người dùng bình thường
        # gần như không bao giờ chạm tới.
        self._flood = FloodGuard(
            threshold=int(_get_scoped_secret("ZALO_FLOOD_THRESHOLD", "6") or 6),
            window_s=float(_get_scoped_secret("ZALO_FLOOD_WINDOW_S", "15") or 15),
            mute_s=float(_get_scoped_secret("ZALO_FLOOD_MUTE_S", "90") or 90),
        )

        self._ws = None
        self._reader_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._heartbeat_interval_s = 15.0
        self._closing = False
        self._self_profile: Dict[str, Any] = {}

        # reqId -> Future, resolved when the sidecar acks a command
        self._pending: Dict[str, asyncio.Future] = {}

        # msgId -> seen-at, to survive sidecar reconnect replays
        self._seen: Dict[str, float] = {}

        # Zalo user IDs and group IDs can both be 19 digits, so length is not
        # enough to classify a reply target.  Remember the authoritative type
        # supplied by each inbound event and reuse it for outbound replies.
        self._known_thread_types: Dict[str, int] = {}

        # threadId -> 5 tin gần nhất trong nhóm. Chỉ RAM, không ghi transcript,
        # để câu hỏi kiểu "đây là gì" có thể nhìn lại ảnh vừa gửi không tag bot.
        self._recent_group_messages: Dict[str, Deque[Dict[str, Any]]] = {}

    # -- Connection lifecycle -------------------------------------------------

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not WEBSOCKETS_AVAILABLE:
            logger.warning("[zalo] websockets not installed. Run: uv pip install websockets")
            return False

        self._closing = False
        try:
            self._ws = await asyncio.wait_for(
                websockets.connect(self._bridge_url, ping_interval=20, ping_timeout=20),
                timeout=10,
            )
        except Exception as exc:
            logger.warning(
                "[zalo] cannot reach the zca-js sidecar at %s (%s). "
                "Start it with `npm start` in the 2anh-zalo-bot folder.",
                self._bridge_url, exc,
            )
            return False

        self._reader_task = asyncio.create_task(self._read_loop())
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        # Gắn cầu nối vào ĐÚNG bản module công cụ mà Hermes đã nạp — xem
        # _zalo_tools(). Ghi luôn tên module vào log: nếu sau này nó lại trỏ
        # nhầm bản, đây là dòng duy nhất cho biết, vì triệu chứng bên ngoài
        # chỉ là bot bảo "Zalo chưa kết nối".
        _tools_mod = _zalo_tools()
        _tools_mod.set_active_adapter(self)
        logger.info("[zalo] connected to sidecar at %s (công cụ: %s)",
                    self._bridge_url, _tools_mod.__name__)
        self._log_permission_selfcheck()
        return True

    async def invoke(self, method: str, args: list, *, confirmed: bool = False) -> Optional[Dict[str, Any]]:
        """Gọi một hàm zca-js qua cầu nối. Dùng bởi các tool trong tools.py."""
        return await self._command(
            {"type": "invoke", "method": method, "args": args, "_confirmed": confirmed},
            expect_ack=True,
        )

    async def disconnect(self) -> None:
        self._closing = True
        _zalo_tools().clear_active_adapter(self)

        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
            self._reader_task = None

        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except (asyncio.CancelledError, Exception):
                pass
            self._heartbeat_task = None

        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

        for fut in self._pending.values():
            if not fut.done():
                fut.cancel()
        self._pending.clear()

        logger.info("[zalo] disconnected from sidecar")

    # -- Inbound --------------------------------------------------------------

    async def _read_loop(self) -> None:
        """Read frames until the socket closes, then back off and reconnect."""
        backoff_idx = 0
        while not self._closing:
            try:
                if self._ws is None:
                    raise ConnectionError("socket is gone")

                async for raw in self._ws:
                    backoff_idx = 0  # a delivered frame proves the link is healthy
                    try:
                        frame = json.loads(raw)
                    except (json.JSONDecodeError, TypeError):
                        logger.debug("[zalo] dropping non-JSON frame")
                        continue
                    await self._dispatch(frame)

                if self._closing:
                    return
                raise ConnectionError("sidecar closed the connection")

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if self._closing:
                    return
                delay = RECONNECT_BACKOFF[min(backoff_idx, len(RECONNECT_BACKOFF) - 1)]
                backoff_idx += 1
                logger.warning("[zalo] sidecar link lost (%s) — retrying in %ss", exc, delay)
                await asyncio.sleep(delay)
                try:
                    self._ws = await asyncio.wait_for(
                        websockets.connect(self._bridge_url, ping_interval=20, ping_timeout=20),
                        timeout=10,
                    )
                    logger.info("[zalo] reconnected to sidecar")
                except Exception:
                    continue  # stay in the loop and back off again

    async def _heartbeat_loop(self) -> None:
        """Keep the application bridge observable, beyond WebSocket TCP pings."""
        while not self._closing:
            await self._command({"type": "ping"}, expect_ack=False)
            await asyncio.sleep(self._heartbeat_interval_s)

    async def _dispatch(self, frame: Dict[str, Any]) -> None:
        kind = frame.get("type")

        if kind == "hello":
            self._self_profile = frame.get("self") or {}
            logger.info(
                "[zalo] sidecar ready — logged in as %s (%s)",
                self._self_profile.get("display_name", "?"),
                self._self_profile.get("user_id", "?"),
            )
            return

        if kind == "ack":
            fut = self._pending.pop(frame.get("reqId", ""), None)
            if fut and not fut.done():
                fut.set_result(frame)
            return

        if kind == "pong":
            return

        if kind == "message":
            await self._on_message(frame)
            return

        logger.debug("[zalo] unhandled frame type: %s", kind)

    async def _on_message(self, frame: Dict[str, Any]) -> None:
        text = (frame.get("text") or "").strip()
        media_urls = self._extract_media_urls(frame)
        quote = frame.get("quote") if isinstance(frame.get("quote"), dict) else None
        quote_media_urls = self._extract_media_urls(quote or {})

        msg_id = str(frame.get("id") or "")
        if msg_id and self._is_duplicate(msg_id):
            return

        thread_id = str(frame.get("threadId") or "")
        if not thread_id:
            logger.debug("[zalo] dropping message with no threadId")
            return

        is_group = frame.get("threadType") == THREAD_TYPE_GROUP
        self._known_thread_types[thread_id] = (
            THREAD_TYPE_GROUP if is_group else THREAD_TYPE_USER
        )
        sender_uid = str(frame.get("senderUid") or "")
        sender_name = frame.get("senderName") or "Zalo user"

        if not text and not media_urls and not quote_media_urls:
            return

        recent_entry = {
            "id": msg_id,
            "sender_uid": sender_uid,
            "sender_name": sender_name,
            "text": text,
            "media_urls": list(media_urls),
            "quote_media_urls": list(quote_media_urls),
            "msg_type": str(frame.get("msgType") or ""),
            "ts": frame.get("ts"),
        }
        if is_group:
            self._remember_group_message(thread_id, recent_entry)

        mentioned = self._is_mentioned(frame, text)
        # Trong nhóm: không trả lời khi chưa được gọi, nhưng vẫn giữ tin đó trong
        # rolling memory ở trên để câu tag ngay sau có ảnh/ngữ cảnh gần nhất.
        if is_group and self._reply_only_tagged and not mentioned:
            logger.debug("[zalo] group message not addressed to the bot — saved as context only")
            return

        # Nhắn riêng: mặc định chỉ chủ nhân. Cửa vào nhóm mở cho tất cả, nhưng
        # cửa nhắn riêng thì không — một tin nhắn riêng là hội thoại kín, không
        # có ai khác trong nhóm nhìn thấy để mà kiểm chứng.
        if not is_group and self._dm_policy != "open" and not self._is_owner(sender_uid):
            logger.info("[zalo] bỏ qua tin nhắn riêng từ %s (%s) — không phải chủ nhân",
                        sender_name, sender_uid)
            return

        # Chốt danh tính trước mọi side effect của lượt này, kể cả thông báo
        # chống flood và cử chỉ đã xem/thả cảm xúc. Task xử lý agent được tạo
        # phía dưới sẽ kế thừa ContextVar này.
        _zalo_tools().set_turn_context(
            text=text,
            sender_uid=sender_uid,
            thread_id=thread_id,
            is_group=is_group,
            is_owner=self._is_owner(sender_uid),
        )

        # Chặn nhắn dồn dập. Đặt sau cổng kiểm quyền (chỉ đếm tin thật sự
        # dành cho bot) nhưng TRƯỚC cả thả cảm xúc lẫn gọi mô hình — người
        # đang spam không đáng được phản hồi gì, kể cả một trái tim.
        #
        # Chủ nhân miễn trừ: anh ấy có thể cần bắn liên tiếp mấy việc một lúc,
        # và cũng chính là người trả tiền cho các lượt gọi mô hình.
        if not self._is_owner(sender_uid):
            verdict = self._flood.check(sender_uid)
            if verdict == FLOOD_MUTED:
                logger.debug("[zalo] %s đang trong thời gian nghỉ — bỏ qua", sender_uid)
                return
            if verdict == FLOOD_JUST_MUTED:
                secs = self._flood.remaining(sender_uid)
                logger.info("[zalo] tạm nghỉ %s (%s) trong %ss vì nhắn dồn",
                            sender_name, sender_uid, secs)
                # Nói đúng một câu rồi im. Im lặng đột ngột trông như bot hỏng
                # và người ta sẽ tag thêm nữa — đúng thứ ta đang muốn tránh.
                await self.send(
                    thread_id,
                    f"Mình nhận nhiều tin quá nên xử lý chưa kịp 😅 "
                    f"Bạn chờ mình khoảng {secs} giây rồi nhắn lại nhé!",
                    metadata={"chat_type": "group" if is_group else "dm"},
                )
                return

        source = self.build_source(
            chat_id=thread_id,
            chat_name=thread_id if is_group else sender_name,
            chat_type="group" if is_group else "dm",
            user_id=sender_uid,
            user_name=sender_name,
            message_id=msg_id or None,
        )

        try:
            ts = float(frame.get("ts") or 0) / 1000.0
            timestamp = datetime.fromtimestamp(ts, tz=timezone.utc) if ts else datetime.now(tz=timezone.utc)
        except (ValueError, OSError, TypeError):
            timestamp = datetime.now(tz=timezone.utc)

        context_entries = self._recent_context_for_question(thread_id, recent_entry) if is_group else []
        inbound_urls = self._dedupe_urls([*media_urls, *quote_media_urls, *self._media_urls_from_entries(context_entries)])
        cached_media, media_types = await self._cache_image_urls(inbound_urls)
        channel_context = self._build_channel_context(context_entries, inbound_urls) if is_group else None
        reply_to_text = None
        if quote:
            reply_to_text = str(quote.get("text") or "").strip() or None
            if not reply_to_text and quote_media_urls:
                reply_to_text = "[Tin được reply có ảnh]"

        # Kẹp hồ sơ người quen vào đầu tin. Nhờ đó bot xưng hô đúng và nhớ
        # bối cảnh của họ ngay từ câu đầu, không phải hỏi lại mỗi lần.
        prompt_text = self._strip_mention(text) if text else ""
        if not prompt_text and cached_media:
            prompt_text = "[Người dùng gửi ảnh]"
        try:
            from .people import describe_person
            known = describe_person(sender_uid)
        except Exception:
            known = ""
        if known:
            prompt_text = f"[Người nhắn — {sender_name}: {known}]\n{prompt_text}"

        event = MessageEvent(
            text=prompt_text,
            message_type=MessageType.PHOTO if cached_media and not text else MessageType.TEXT,
            user_id=sender_uid,
            user_name=sender_name,
            source=source,
            message_id=msg_id or None,
            raw_message=frame.get("raw"),
            timestamp=timestamp,
            media_urls=cached_media,
            media_types=media_types,
            reply_to_message_id=(str(quote.get("id") or "") or None) if quote else None,
            reply_to_text=reply_to_text,
            reply_to_author_id=(str(quote.get("authorId") or "") or None) if quote else None,
            reply_to_author_name=(quote.get("authorName") or None) if quote else None,
            reply_to_is_own_message=bool(quote and str(quote.get("authorId") or "") == str(self._self_profile.get("user_id") or "")),
            channel_context=channel_context,
        )

        logger.info(
            "[zalo] %s from %s (%s): %s%s",
            "group" if is_group else "dm", sender_name, sender_uid,
            text[:80] if text else "[media]",
            f" +{len(cached_media)} ảnh" if cached_media else "",
        )

        # Cử chỉ lịch sự của Zalo: báo đã xem + thả cảm xúc hợp ngữ cảnh.
        #
        # Chỉ làm với người thật sự được phép sai bảo bot. Gateway sẽ chặn
        # người lạ ở bước sau, nhưng nếu thả cảm xúc trước đó thì họ thấy bot
        # thả tim rồi im bặt — vừa kỳ quặc vừa để lộ là có bot đang nghe.
        #
        # Cố tình chặt hơn gateway một chút: gateway còn cho qua bằng DM
        # pairing hay GATEWAY_ALLOW_ALL_USERS, những đường adapter không nhìn
        # thấy. Người hợp lệ qua các đường đó chỉ mất cử chỉ chào hỏi, vẫn
        # được trả lời đầy đủ — đánh đổi đáng giá so với việc rò rỉ.
        if msg_id and self._ack_gestures and self._may_greet(sender_uid):
            await self._command(
                {
                    "type": "ack_message",
                    "threadId": thread_id,
                    "threadType": THREAD_TYPE_GROUP if is_group else THREAD_TYPE_USER,
                    "msgId": msg_id,
                    "cliMsgId": str(frame.get("cliMsgId") or ""),
                    "text": text,
                    "seen": True,
                    "react": self._auto_react,
                    "raw": frame.get("raw"),
                },
                expect_ack=False,
            )

        await self.handle_message(event)

    def _is_mentioned(self, frame: Dict[str, Any], text: str) -> bool:
        """True only when *this bot* is addressed.

        A Zalo mention carries the ``uid`` of the person being tagged, so a
        message that @-mentions somebody else is not for us. Treating any
        mention as "mentions me" makes the bot answer every tagged message in
        a group — the same shape of bug as an allowlist check that always
        passes.
        """
        self_uid = str(self._self_profile.get("user_id") or "")
        mentions = frame.get("mentions")
        if isinstance(mentions, list) and mentions:
            for m in mentions:
                if isinstance(m, dict) and str(m.get("uid") or "") == self_uid and self_uid:
                    return True

        low = text.lower()
        if low.startswith("bot ") or low == "bot" or "@bot" in low:
            return True

        name = (self._self_profile.get("display_name") or "").strip().lower()
        return bool(name) and f"@{name}" in low

    def _strip_mention(self, text: str) -> str:
        """Drop the bot's own @name so the agent sees a clean prompt."""
        cleaned = re.sub(r"@bot\b", "", text, flags=re.IGNORECASE)
        name = (self._self_profile.get("display_name") or "").strip()
        if name:
            cleaned = re.sub(rf"@{re.escape(name)}", "", cleaned, flags=re.IGNORECASE)
        return cleaned.strip() or text

    @staticmethod
    def _dedupe_urls(urls: List[str]) -> List[str]:
        out: List[str] = []
        seen = set()
        for url in urls:
            item = str(url or "").strip()
            if re.match(r"^https?://", item, re.IGNORECASE) and item not in seen:
                seen.add(item)
                out.append(item)
        return out

    def _extract_media_urls(self, value: Any) -> List[str]:
        """Extract image-like URLs from bridge frame/raw Zalo payloads."""
        urls: List[str] = []
        raw = value.get("raw") if isinstance(value, dict) else None
        roots = [value]
        if raw is not None:
            roots.append(raw)
        if isinstance(value, dict):
            for field in ("mediaUrls", "media_urls"):
                direct = value.get(field)
                if isinstance(direct, list):
                    urls.extend(str(item or "").strip() for item in direct)
                elif direct:
                    urls.append(str(direct).strip())

        def push(candidate: Any) -> None:
            item = str(candidate or "").strip()
            if re.match(r"^https?://", item, re.IGNORECASE):
                urls.append(item)

        def walk(node: Any, key: str = "") -> None:
            if node is None:
                return
            if isinstance(node, str):
                if re.match(r"^(href|oriUrl|hdUrl|normalUrl|thumb|thumbUrl|previewThumb|rawUrl|url)$", key, re.IGNORECASE):
                    push(node)
                return
            if isinstance(node, list):
                for item in node:
                    walk(item, key)
                return
            if not isinstance(node, dict):
                return
            for k, v in node.items():
                if re.match(r"^(href|oriUrl|hdUrl|normalUrl|thumb|thumbUrl|previewThumb|rawUrl|url)$", str(k), re.IGNORECASE):
                    push(v)
                elif isinstance(v, (dict, list)):
                    walk(v, str(k))

        for root in roots:
            walk(root)
        return self._dedupe_urls(urls)

    def _remember_group_message(self, thread_id: str, entry: Dict[str, Any]) -> None:
        bucket = self._recent_group_messages.get(thread_id)
        if bucket is None:
            bucket = deque(maxlen=GROUP_CONTEXT_LIMIT)
            self._recent_group_messages[thread_id] = bucket
        bucket.append(entry)

    def _recent_context_for_question(self, thread_id: str, current: Dict[str, Any]) -> List[Dict[str, Any]]:
        bucket = list(self._recent_group_messages.get(thread_id) or [])
        if current.get("media_urls") or current.get("quote_media_urls"):
            return []
        text = str(current.get("text") or "")
        if not _IMAGE_CONTEXT_RE.search(text):
            return []
        # Bỏ chính tin đang hỏi, lấy tối đa 3 tin gần nhất phía trước — đủ cho ảnh
        # + một câu caption, không làm phình prompt nhóm.
        prior = [item for item in bucket if item.get("id") != current.get("id")]
        return prior[-3:]

    @staticmethod
    def _media_urls_from_entries(entries: List[Dict[str, Any]]) -> List[str]:
        urls: List[str] = []
        for item in entries:
            urls.extend(item.get("media_urls") or [])
            urls.extend(item.get("quote_media_urls") or [])
        return urls

    async def _cache_image_urls(self, urls: List[str]) -> tuple[List[str], List[str]]:
        cached: List[str] = []
        media_types: List[str] = []
        for url in urls[:4]:
            try:
                cached.append(await cache_image_from_url(url))
                media_types.append("image/jpeg")
            except Exception as exc:
                logger.warning("[zalo] không cache được ảnh %s: %s", url[:80], exc)
        return cached, media_types

    def _build_channel_context(self, entries: List[Dict[str, Any]], urls: List[str]) -> Optional[str]:
        if not entries and not urls:
            return None
        lines = ["[Ngữ cảnh gần nhất trong nhóm Zalo]"]
        for item in entries:
            who = item.get("sender_name") or "Zalo user"
            msg = str(item.get("text") or "").strip()
            media_count = len(item.get("media_urls") or []) + len(item.get("quote_media_urls") or [])
            if msg:
                lines.append(f"- {who}: {msg[:300]}")
            elif media_count:
                lines.append(f"- {who}: [đã gửi {media_count} ảnh]")
        if urls:
            lines.append(f"Ảnh liên quan đã được đính kèm cho Vision ({len(urls)} ảnh).")
        return "\n".join(lines)

    def _log_permission_selfcheck(self) -> None:
        """Ghi một lần lúc khởi động: người trong nhóm thật sự cầm được gì.

        Vì sao phải đo ở đây chứ không đo bằng script riêng: log lúc đăng ký
        plugin không bao giờ tới được tệp (plugin nạp trước khi handler ghi
        log gắn vào), còn script chạy ngoài thì dựng lại môi trường theo cách
        của mình chứ không phải môi trường gateway đang chạy. Đây là chỗ duy
        nhất đo được đúng tiến trình thật, và nó chạy đúng một lần mỗi lần
        khởi động nên không tốn gì.
        """
        try:
            import yaml
            from hermes_cli.tools_config import _get_platform_tools
            from toolsets import resolve_toolset

            cfg_path = os.path.join(os.getenv("HERMES_HOME", ""), "config.yaml")
            with open(cfg_path, encoding="utf-8") as fh:
                cfg = yaml.safe_load(fh) or {}

            platform_key = str(self.platform.value)
            for label, override in (
                ("chủ nhân", [f"hermes-{platform_key}", "kanban",
                              TOOLSET_OWNER, TOOLSET_PUBLIC]),
                ("người trong nhóm", [TOOLSET_PUBLIC]),
            ):
                probe = dict(cfg)
                pts = dict(probe.get("platform_toolsets") or {})
                pts[platform_key] = override
                probe["platform_toolsets"] = pts
                toolsets = sorted(_get_platform_tools(probe, platform_key))
                tools = {t for ts in toolsets for t in resolve_toolset(ts)}
                leaks = sorted(t for t in ("terminal", "read_file", "write_file",
                                           "kanban_create", "zalo_forward")
                               if t in tools)
                logger.info(
                    "[zalo] tự kiểm quyền — %s: %d công cụ (%d Zalo)%s",
                    label, len(tools),
                    len([t for t in tools if t.startswith("zalo_")]),
                    f", nhạy cảm: {leaks}" if leaks else ", không có công cụ nhạy cảm",
                )
        except Exception as exc:
            logger.warning("[zalo] không tự kiểm được quyền: %s", exc)

    def toolsets_for_source(self, source) -> Optional[List[str]]:
        """Quyết định người này được dùng bộ công cụ nào.

        Gateway hỏi hàm này trước mỗi lượt agent chạy. Trả về ``None`` nghĩa là
        dùng cấu hình mặc định của nền tảng.

        Điểm cốt lõi: ``hermes-zalo`` kéo theo cả bộ công cụ lõi của Hermes —
        ``terminal``, ``read_file``, ``write_file``, ``browser_*``. Ai được
        dùng nó là chạy được lệnh shell và đọc được mọi tệp trên máy chủ, kể cả
        tệp chứa khoá API. Nên người ngoài chỉ nhận ``zalo_public``: mười công
        cụ tác động trong đúng cuộc trò chuyện của họ, không hơn.
        """
        uid = str(getattr(source, "user_id", "") or "")

        # Dùng khoá nền tảng, KHÔNG dùng ``self.name``: thuộc tính đó trả về
        # ``platform.value.title()`` — "Zalo" chứ không phải "zalo" — nên
        # ``hermes-Zalo`` không khớp toolset nào và agent lặng lẽ mất sạch
        # công cụ. Đúng loại lỗi chỉ lộ ra khi đo ở nơi người dùng thật chạm
        # tới, chứ không lộ khi tự gọi resolve_toolset trong bài kiểm thử.
        platform_key = str(self.platform.value)
        # ``kanban`` được liệt kê thẳng cho chủ nhân, không nằm trong
        # ``hermes-zalo``: bảng công việc đã bị loại khỏi composite ở
        # define_platform_composite() để người trong nhóm không với tới. Liệt
        # kê tường minh là đường duy nhất còn lại để chủ nhân vẫn dùng được.
        chosen = ([f"hermes-{platform_key}", "kanban", TOOLSET_OWNER, TOOLSET_PUBLIC]
                  if self._is_owner(uid) else [TOOLSET_PUBLIC])

        logger.debug("[zalo] %s (%s) → %s",
                     "chủ nhân" if self._is_owner(uid) else "người trong nhóm",
                     uid, chosen)
        return chosen

    def _is_owner(self, sender_uid: str) -> bool:
        """Người này có nằm trong ZALO_ALLOWED_USERS không.

        Cố tình KHÔNG xét ``ZALO_ALLOW_ALL_USERS``. Cờ đó chỉ nói với gateway
        rằng "đừng chặn ai ở cổng vào" — để người trong nhóm nhắn được mà không
        phải khai báo từng UID. Nó không nói ai là chủ. Trộn hai khái niệm lại
        thì bật cờ đó lên là cả nhóm thành chủ nhân, và toàn bộ lớp phân quyền
        toolset thành vô nghĩa.
        """
        allowed = _split_ids(_get_scoped_secret("ZALO_ALLOWED_USERS", "") or "")
        return bool(allowed) and str(sender_uid) in allowed

    def _may_greet(self, sender_uid: str) -> bool:
        """Có nên báo đã xem và thả cảm xúc cho tin nhắn này không.

        Điều kiện là "người này sẽ được bot trả lời", không phải "người này là
        chủ". Khi ``ZALO_ALLOW_ALL_USERS`` bật, cả nhóm dùng được bot — mà thả
        cảm xúc cho người này rồi im lặng với người kia thì bot trông thiên vị
        một cách khó hiểu.

        Vẫn giữ nguyên mục đích ban đầu: người bị gateway chặn thì không được
        chào hỏi, để bot không thả tim xong im bặt.
        """
        if _truthy(_get_scoped_secret("ZALO_ALLOW_ALL_USERS", "false")):
            return True
        return self._is_owner(sender_uid)

    def _is_duplicate(self, msg_id: str) -> bool:
        now = time.time()
        if len(self._seen) > DEDUP_MAX_SIZE:
            cutoff = now - DEDUP_WINDOW_SECONDS
            self._seen = {k: v for k, v in self._seen.items() if v > cutoff}
        if msg_id in self._seen:
            return True
        self._seen[msg_id] = now
        return False

    # -- Outbound -------------------------------------------------------------

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        metadata = metadata or {}
        thread_type = (
            THREAD_TYPE_GROUP
            if str(metadata.get("chat_type") or "").lower() == "group"
            else self._guess_thread_type(chat_id, metadata)
        )

        last: Optional[Dict[str, Any]] = None
        for chunk in self._chunk(content):
            last = await self._command(
                {"type": "send", "threadId": str(chat_id), "threadType": thread_type, "text": chunk},
                expect_ack=True,
            )
            if not last or not last.get("ok"):
                return SendResult(
                    success=False,
                    error=(last or {}).get("error", "sidecar did not confirm the send"),
                )

        return SendResult(success=True, message_id=(last or {}).get("msgId"), raw_response=last)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        metadata = metadata or {}
        await self._command(
            {
                "type": "typing",
                "threadId": str(chat_id),
                "threadType": self._guess_thread_type(chat_id, metadata),
            },
            expect_ack=False,
        )

    async def send_voice(
        self,
        chat_id: str,
        audio_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        """Upload local audio to Zalo's CDN, then send it as a voice bubble."""
        if not os.path.isfile(audio_path):
            return SendResult(success=False, error="audio file was not found")

        metadata = metadata or {}
        thread_type = self._guess_thread_type(chat_id, metadata)
        upload_path = audio_path
        temporary_path: Optional[str] = None
        if os.path.splitext(audio_path)[1].lower() != ".aac":
            temporary_path = await asyncio.to_thread(_transcode_to_aac, audio_path)
            if not temporary_path:
                return SendResult(success=False, error="could not convert audio to AAC")
            upload_path = temporary_path

        try:
            uploaded = await self.invoke(
                "uploadAttachment", [[upload_path], str(chat_id), thread_type]
            )
            if not uploaded or not uploaded.get("ok"):
                return SendResult(
                    success=False,
                    error=(uploaded or {}).get("error", "Zalo audio upload failed"),
                )
            items = uploaded.get("result") or []
            voice_url = items[0].get("fileUrl") if items and isinstance(items[0], dict) else None
            if not voice_url:
                return SendResult(success=False, error="Zalo audio upload returned no file URL")

            sent = await self.invoke(
                "sendVoice",
                [{"voiceUrl": voice_url, "ttl": 0}, str(chat_id), thread_type],
            )
            if not sent or not sent.get("ok"):
                return SendResult(
                    success=False,
                    error=(sent or {}).get("error", "Zalo voice send failed"),
                )
            payload = sent.get("result") or {}
            message = payload.get("message") if isinstance(payload, dict) else {}
            message_id = (
                (payload.get("msgId") or payload.get("msgID"))
                if isinstance(payload, dict)
                else None
            ) or (message or {}).get("msgId") or (message or {}).get("msgID")
            return SendResult(success=True, message_id=message_id, raw_response=sent)
        finally:
            if temporary_path:
                try:
                    os.unlink(temporary_path)
                except OSError:
                    pass

    async def read_history(
        self,
        chat_id: str,
        count: int = 30,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        metadata = metadata or {}
        return await self._command(
            {
                "type": "history",
                "threadId": str(chat_id),
                "threadType": self._guess_thread_type(chat_id, metadata),
                "count": min(max(int(count), 1), 100),
            },
            expect_ack=True,
        )

    async def undo_message(
        self,
        chat_id: str,
        msg_id: Optional[str] = None,
        cli_msg_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        *,
        confirmed: bool = False,
    ) -> Optional[Dict[str, Any]]:
        metadata = metadata or {}
        return await self._command(
            {
                "type": "undo",
                "threadId": str(chat_id),
                "threadType": self._guess_thread_type(chat_id, metadata),
                "msgId": str(msg_id) if msg_id else None,
                "cliMsgId": str(cli_msg_id) if cli_msg_id else None,
                "_confirmed": confirmed,
            },
            expect_ack=True,
        )

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {
            "id": str(chat_id),
            "platform": "zalo",
            "type": "group" if self._looks_like_group(chat_id) else "dm",
        }

    # -- Helpers --------------------------------------------------------------

    def _guess_thread_type(self, chat_id: str, metadata: Dict[str, Any]) -> int:
        chat_type = str(metadata.get("chat_type") or "").lower()
        if chat_type == "group":
            return THREAD_TYPE_GROUP
        if chat_type == "dm":
            return THREAD_TYPE_USER
        known_type = self._known_thread_types.get(str(chat_id))
        if known_type is not None:
            return known_type
        return THREAD_TYPE_GROUP if self._looks_like_group(chat_id) else THREAD_TYPE_USER

    def _looks_like_group(self, chat_id: str) -> bool:
        """Group IDs run longer than user IDs; used only when nothing else says."""
        return len(str(chat_id).strip()) >= 19

    @staticmethod
    def _u16len(text: str) -> int:
        """Độ dài theo cách Zalo đếm — đơn vị mã UTF-16.

        Python đếm điểm mã, JavaScript và Zalo đếm đơn vị UTF-16. Với chữ
        thường thì bằng nhau, nhưng mỗi emoji là 1 trong Python và 2 bên kia.
        Một câu trả lời rắc emoji mà đếm theo Python sẽ tưởng vừa, gửi đi mới
        biết quá.
        """
        return len(text.encode("utf-16-le")) // 2

    def _chunk(self, content: str) -> List[str]:
        """Cắt câu trả lời dài thành nhiều tin, cắt ở chỗ đọc được.

        Ưu tiên cắt giữa hai đoạn, rồi mới tới cuối câu, cuối cùng mới cắt
        cứng. Cắt cứng giữa từ làm câu trả lời trông như bị lỗi, mà lỗi thật
        thì không có — chỉ là dài.
        """
        text = content or ""
        if self._u16len(text) <= MAX_MESSAGE_LENGTH:
            return [text]

        chunks: List[str] = []
        rest = text
        while self._u16len(rest) > MAX_MESSAGE_LENGTH:
            # Tìm điểm cắt xa nhất còn nằm trong hạn mức.
            cut = MAX_MESSAGE_LENGTH
            while self._u16len(rest[:cut]) > MAX_MESSAGE_LENGTH:
                cut -= 50                      # lùi dần khi có nhiều emoji
            window = rest[:cut]

            # Chỗ cắt đẹp nhất: hết một đoạn văn, rồi tới hết một câu.
            for sep in ("\n\n", "\n", ". ", "! ", "? ", " "):
                idx = window.rfind(sep)
                if idx > cut * 0.5:            # đừng cắt quá non nửa đoạn
                    cut = idx + len(sep)
                    break

            chunks.append(rest[:cut].rstrip())
            rest = rest[cut:].lstrip()
        if rest:
            chunks.append(rest)
        return chunks

    async def _command(self, payload: Dict[str, Any], *, expect_ack: bool) -> Optional[Dict[str, Any]]:
        if self._ws is None:
            logger.warning("[zalo] no sidecar link — dropping %s", payload.get("type"))
            return None

        payload = dict(payload)
        confirmed = bool(payload.pop("_confirmed", False))
        if payload.get("type") != "ping" and "auth" not in payload:
            payload["auth"] = _zalo_tools().current_authorization(confirmed=confirmed)

        fut: Optional[asyncio.Future] = None
        if expect_ack:
            req_id = uuid.uuid4().hex[:12]
            payload["reqId"] = req_id
            fut = asyncio.get_running_loop().create_future()
            self._pending[req_id] = fut

        try:
            await self._ws.send(json.dumps(payload))
        except Exception as exc:
            logger.warning("[zalo] send over bridge failed: %s", exc)
            if fut:
                self._pending.pop(payload.get("reqId", ""), None)
            return None

        if not fut:
            return None

        timeout = ACK_TIMEOUT_SECONDS
        if payload.get("type") == "send":
            timeout = SLOW_ACK_TIMEOUT_SECONDS
        elif payload.get("type") == "invoke" and payload.get("method") in SLOW_METHODS:
            timeout = SLOW_ACK_TIMEOUT_SECONDS

        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(payload.get("reqId", ""), None)
            logger.warning("[zalo] sidecar did not ack %s (%s) in %ss",
                           payload.get("type"), payload.get("method") or "-", timeout)
            return None


def _env_enablement() -> Optional[dict]:
    """Seed ``PlatformConfig.extra`` from env so Zalo shows up in gateway status."""
    if not WEBSOCKETS_AVAILABLE:
        return None

    extra: Dict[str, Any] = {
        "bridge_url": _get_scoped_secret("ZALO_BRIDGE_URL", DEFAULT_BRIDGE_URL),
        "reply_only_tagged": _truthy(_get_scoped_secret("ZALO_GROUP_REPLY_ONLY_TAGGED", "true"), True),
    }

    home = (_get_scoped_secret("ZALO_HOME_CHANNEL", "") or "").strip()
    if home:
        extra["home_channel"] = {
            "chat_id": home,
            "name": _get_scoped_secret("ZALO_HOME_CHANNEL_NAME", "Zalo") or "Zalo",
        }
    return extra


def register(ctx) -> None:
    """Plugin entry point — called by the Hermes plugin loader at startup."""
    # Công cụ do plugin `zalo-tools` đăng ký, không phải ở đây: platform
    # plugin nạp lười nên công cụ đăng ký từ đây sẽ tới muộn và bị Hermes bỏ
    # qua khi lập danh sách toolset.
    ctx.register_platform(
        name="zalo",
        label="Zalo",
        adapter_factory=lambda cfg: ZaloAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=[],
        install_hint="uv pip install websockets   # then `npm start` in the 2anh-zalo-bot folder",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="ZALO_HOME_CHANNEL",
        allowed_users_env="ZALO_ALLOWED_USERS",
        allow_all_env="ZALO_ALLOW_ALL_USERS",
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="💬",
        allow_update_command=True,
        platform_hint=(
            "You are talking to someone on Zalo, a Vietnamese messaging app. "
            "Write normal Markdown — the bridge converts it to Zalo's native "
            "text styles before sending, so formatting renders properly:\n"
            "  # or ## heading  → bold red (use for the main heading)\n"
            "  ### heading      → bold orange (sub-heading)\n"
            "  **text**         → bold (key terms, numbers, names)\n"
            "  *text*           → italic\n"
            "  `text`           → bold\n"
            "  ~~text~~         → strikethrough\n"
            "  > quote          → italic\n"
            "  - item           → bullet\n"
            "  [label](url)     → label followed by the URL\n"
            "For a colour Markdown has no syntax for, wrap it in tags: "
            "[green]done[/green], [red]warning[/red], [yellow]note[/yellow], "
            "[orange]caution[/orange]. Zalo has no code-block styling, so keep "
            "code short. Use emoji freely — they render natively. Keep replies "
            "under 4000 characters."
        ),
    )
