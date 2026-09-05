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
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

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
)

from agent.secret_scope import UnscopedSecretError as _UnscopedSecretError
from agent.secret_scope import get_secret as _scoped_get_secret

# Công cụ nằm ở plugin standalone `zalo_tools`, không phải ở đây — xem
# ghi chú trong plugins/zalo_tools/__init__.py về việc Hermes nạp platform
# plugin theo kiểu lười.
from plugins.zalo_tools.tools import (
    TOOLSET_OWNER,
    set_active_adapter,
    clear_active_adapter,
    set_turn_context,
    TOOLSET_PUBLIC,
)


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
MAX_MESSAGE_LENGTH = 4000          # Zalo caps around 4k characters per message
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]
ACK_TIMEOUT_SECONDS = 30
DEDUP_WINDOW_SECONDS = 300
DEDUP_MAX_SIZE = 1000

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

        self._ws = None
        self._reader_task: Optional[asyncio.Task] = None
        self._closing = False
        self._self_profile: Dict[str, Any] = {}

        # reqId -> Future, resolved when the sidecar acks a command
        self._pending: Dict[str, asyncio.Future] = {}

        # msgId -> seen-at, to survive sidecar reconnect replays
        self._seen: Dict[str, float] = {}

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
        set_active_adapter(self)   # để các tool zalo_* tìm được đường ra cầu nối
        logger.info("[zalo] connected to sidecar at %s", self._bridge_url)
        return True

    async def invoke(self, method: str, args: list) -> Optional[Dict[str, Any]]:
        """Gọi một hàm zca-js qua cầu nối. Dùng bởi các tool trong tools.py."""
        return await self._command({"type": "invoke", "method": method, "args": args}, expect_ack=True)

    async def disconnect(self) -> None:
        self._closing = True
        clear_active_adapter(self)

        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
            self._reader_task = None

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
        if not text:
            return

        msg_id = str(frame.get("id") or "")
        if msg_id and self._is_duplicate(msg_id):
            return

        thread_id = str(frame.get("threadId") or "")
        if not thread_id:
            logger.debug("[zalo] dropping message with no threadId")
            return

        is_group = frame.get("threadType") == THREAD_TYPE_GROUP
        sender_uid = str(frame.get("senderUid") or "")
        sender_name = frame.get("senderName") or "Zalo user"

        # Trong nhóm: chỉ trả lời khi được gọi đúng tên.
        if is_group and self._reply_only_tagged and not self._is_mentioned(frame, text):
            logger.debug("[zalo] group message not addressed to the bot — skipping")
            return

        # Nhắn riêng: mặc định chỉ chủ nhân. Cửa vào nhóm mở cho tất cả, nhưng
        # cửa nhắn riêng thì không — một tin nhắn riêng là hội thoại kín, không
        # có ai khác trong nhóm nhìn thấy để mà kiểm chứng.
        if not is_group and self._dm_policy != "open" and not self._is_owner(sender_uid):
            logger.info("[zalo] bỏ qua tin nhắn riêng từ %s (%s) — không phải chủ nhân",
                        sender_name, sender_uid)
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

        # Kẹp hồ sơ người quen vào đầu tin. Nhờ đó bot xưng hô đúng và nhớ
        # bối cảnh của họ ngay từ câu đầu, không phải hỏi lại mỗi lần.
        prompt_text = self._strip_mention(text)
        try:
            from .people import describe_person
            known = describe_person(sender_uid)
        except Exception:
            known = ""
        if known:
            prompt_text = f"[Người nhắn — {sender_name}: {known}]\n{prompt_text}"

        event = MessageEvent(
            text=prompt_text,
            message_type=MessageType.TEXT,
            user_id=sender_uid,
            user_name=sender_name,
            source=source,
            message_id=msg_id or None,
            raw_message=frame.get("raw"),
            timestamp=timestamp,
        )

        logger.info(
            "[zalo] %s from %s (%s): %s",
            "group" if is_group else "dm", sender_name, sender_uid, text[:80],
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

        # Ghi lại ai đang hỏi và ở đâu, để các công cụ công khai biết đường
        # khoá phạm vi. Đặt ngay trước handle_message: gateway spawn task con
        # từ đây, và task con kế thừa context của cha.
        set_turn_context(
            sender_uid=sender_uid,
            thread_id=thread_id,
            is_group=is_group,
            is_owner=self._is_owner(sender_uid),
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
        chosen = ([f"hermes-{platform_key}", TOOLSET_OWNER, TOOLSET_PUBLIC]
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
        return THREAD_TYPE_GROUP if self._looks_like_group(chat_id) else THREAD_TYPE_USER

    def _looks_like_group(self, chat_id: str) -> bool:
        """Group IDs run longer than user IDs; used only when nothing else says."""
        return len(str(chat_id).strip()) >= 19

    def _chunk(self, content: str) -> List[str]:
        text = content or ""
        if len(text) <= MAX_MESSAGE_LENGTH:
            return [text]
        return [text[i:i + MAX_MESSAGE_LENGTH] for i in range(0, len(text), MAX_MESSAGE_LENGTH)]

    async def _command(self, payload: Dict[str, Any], *, expect_ack: bool) -> Optional[Dict[str, Any]]:
        if self._ws is None:
            logger.warning("[zalo] no sidecar link — dropping %s", payload.get("type"))
            return None

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

        try:
            return await asyncio.wait_for(fut, timeout=ACK_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            self._pending.pop(payload.get("reqId", ""), None)
            logger.warning("[zalo] sidecar did not ack %s in %ss", payload.get("type"), ACK_TIMEOUT_SECONDS)
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
