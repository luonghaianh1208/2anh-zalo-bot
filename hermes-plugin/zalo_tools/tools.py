"""Công cụ Zalo cho Hermes Agent.

Mỗi công cụ ở đây là một lệnh gửi qua cầu WebSocket sang sidecar zca-js. Nhờ
lệnh ``invoke`` tổng quát bên cầu nối, thêm công cụ mới chỉ là thêm một mục
trong file này — không phải sửa cả hai phía.

Vì sao dùng công cụ thay cho trang quản trị: mọi thứ ở đây trước kia phải bấm
tay trong dashboard. Nói với agent "ghim tin nhắn đó lại" nhanh hơn mở trình
duyệt, tìm đúng hội thoại rồi gạt công tắc — và agent còn tự làm được cả chuỗi
việc mà giao diện không có nút nào tương ứng.

An toàn: cầu nối chỉ chấp nhận các hàm zca-js nằm trong danh sách trắng. Những
hàm dễ làm khoá tài khoản (gửi lời mời kết bạn hàng loạt, chặn người, giải tán
nhóm) hoặc chạm tới tiền bạc cố tình bị bỏ ra ngoài.
"""

import contextvars
import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import threading
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import group_permissions
from . import ai_events  # noqa: F401  (nạp sẵn: adapter ghi lượt đọc ảnh qua _zalo_tools_module("ai_events"))

logger = logging.getLogger(__name__)

# Hai toolset, hai mức quyền.
#
# TOOLSET_PUBLIC gom những việc chỉ tác động trong chính cuộc trò chuyện đang
# diễn ra. TOOLSET_OWNER gom những việc vươn ra ngoài nó — sang nhóm khác, sang
# hồ sơ tài khoản, hoặc phơi ra thông tin riêng của chủ.
#
# Toolset công khai KHÔNG kèm bộ công cụ lõi của Hermes (terminal, read_file,
# write_file, browser…). Đó mới là điểm mấu chốt: nếu người ngoài được dùng
# `hermes-zalo` thì họ chạy được lệnh shell và đọc được mọi tệp trên máy chủ,
# kể cả tệp chứa khoá API.
TOOLSET_PUBLIC = "zalo_public"
# Cố tình KHÔNG đặt tên trùng khoá nền tảng ("zalo"): Hermes tự bật toolset
# cùng tên với nền tảng cho mọi phiên, nên đặt trùng thì người ngoài cũng nhận
# luôn bộ công cụ dành riêng cho chủ.
TOOLSET_OWNER = "zalo_owner"
# Công cụ chỉ có nghĩa trong lượt chạy cron. Không nằm trong bộ nào
# toolsets_for_source trả về, nên chat thường không bao giờ thấy.
TOOLSET_CRON = "zalo_cron"
# Toolset ghép cho việc hẹn giờ do thành viên nhóm tạo: tra cứu và đọc lịch sử
# chính nhóm đó, không có gì khác. Xem define_cron_member_toolset().
TOOLSET_CRON_MEMBER = "zalo_cron_member"
CRON_MEMBER_TOOLS = (
    "zalo_web_search", "zalo_web_read", "zalo_kb_list", "zalo_kb_read", "zalo_group_history",
)

# Ngữ cảnh của lượt tin đang xử lý. Dùng ContextVar chứ không phải biến thường:
# gateway xử lý nhiều lượt song song, biến thường sẽ lẫn người này sang người
# kia — đúng loại lỗi khiến ai cũng thành chủ nhân.
_TURN: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar(
    "zalo_turn", default=None
)
_CONFIRMED: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "zalo_confirmed", default=False
)
_PENDING_CONFIRMATIONS: Dict[tuple, Dict[str, Any]] = {}
_CONFIRMATION_TTL_SECONDS = 300


def set_turn_context(*, sender_uid: str, thread_id: str, is_group: bool,
                     is_owner: bool, text: str = "", reply_msg_id: str = "",
                     reply_cli_msg_id: str = "", reply_is_own: bool = False,
                     msg_id: str = "", sender_name: str = "") -> None:
    """Adapter gọi trước khi đẩy tin vào agent.

    ``text`` là NGUYÊN VĂN tin nhắn người dùng vừa gõ, chưa qua tay mô hình.
    Đây là thứ duy nhất trong cả lượt mà mô hình không tự sinh ra được, nên
    những hành động cần người thật gật đầu (đăng bài lên Fanpage) đem mã duyệt
    ra đối chiếu với chính chuỗi này. Một tài liệu bị cài chữ có dụ được mô
    hình đến mấy cũng không đặt được chữ vào tin nhắn của chủ nhân.
    """
    _TURN.set({
        "sender_uid": str(sender_uid),
        "thread_id": str(thread_id),
        "is_group": bool(is_group),
        "is_owner": bool(is_owner),
        "text": str(text or ""),
        "reply_msg_id": str(reply_msg_id or ""),
        "reply_cli_msg_id": str(reply_cli_msg_id or ""),
        "reply_is_own": bool(reply_is_own),
        "msg_id": str(msg_id or ""),
        "sender_name": str(sender_name or ""),
    })


def bind_turn(turn: Optional[Dict[str, Any]]) -> None:
    """Gắn lại danh tính cho lượt agent sắp chạy.

    Hermes xử lý tin xếp hàng trong task tạo ra từ task của lượt trước, nên
    ContextVar kế thừa danh tính người gửi trước. Adapter gọi hàm này mỗi lượt
    để lượt nào cũng mang đúng người gửi của nó. Rỗng nghĩa là không ai.
    """
    _TURN.set(dict(turn) if turn else {})


def _turn() -> Dict[str, Any]:
    return _TURN.get() or {}


def current_authorization(*, confirmed: bool = False) -> Dict[str, Any]:
    """Return the non-model authority envelope attached to a bridge frame."""
    turn = _turn()
    if not turn:
        # Ngoài lượt chat (cron, thông báo của gateway) không có người gửi nào.
        # Sidecar cho vai trò này gửi văn bản / báo đang gõ tới BẤT KỲ hội
        # thoại nào, không được làm gì khác.
        return {
            "actorUid": "",
            "actorRole": "system",
            "sourceThreadId": "",
            "sourceThreadType": THREAD_USER,
            "confirmed": False,
        }
    auth = {
        "actorUid": str(turn.get("sender_uid") or ""),
        "actorRole": "owner" if turn.get("is_owner") else "public",
        "sourceThreadId": str(turn.get("thread_id") or ""),
        "sourceThreadType": THREAD_GROUP if turn.get("is_group") else THREAD_USER,
        "confirmed": bool(confirmed),
    }
    if turn.get("cron_job_id"):
        auth["cronJobId"] = str(turn["cron_job_id"])
    if turn.get("sethome"):
        # Câu trả lời /sethome cho người lạ: kết nối Zalo vẫn cho gửi dù người này
        # chưa được nhắn riêng (dm-rules.js / zalo-policy.js).
        auth["notice"] = "sethome"
    return auth


def _current_thread() -> Optional[str]:
    return _turn().get("thread_id")


def _current_thread_kind() -> str:
    return "group" if _turn().get("is_group") else "dm"

# Adapter đang sống tự ghi tên mình vào đây khi kết nối, để các công cụ tìm
# được đường ra cầu nối. Công cụ được đăng ký lúc nạp plugin, còn adapter thì
# mãi sau mới dựng — nên không truyền thẳng tham chiếu được.
_ACTIVE_ADAPTER = None

THREAD_USER = 0
THREAD_GROUP = 1


def set_active_adapter(adapter) -> None:
    global _ACTIVE_ADAPTER
    _ACTIVE_ADAPTER = adapter


def clear_active_adapter(adapter=None) -> None:
    global _ACTIVE_ADAPTER
    if adapter is None or _ACTIVE_ADAPTER is adapter:
        _ACTIVE_ADAPTER = None


# =====================================================================
#  Lượt chạy cron — gắn danh tính khi không có tin nhắn nào
# =====================================================================
#
# Cron chạy không kèm tin nhắn nên _TURN rỗng và mọi công cụ Zalo tự chặn.
# Hermes truyền `task_id = "cron:<job_id>:<lần chạy>"` vào từng lời gọi công
# cụ (cron/scheduler.py), nên đọc lại job là biết cron này gửi về đâu, do ai tạo.
#
# Job tạo bằng công cụ cron gốc của Hermes — chỉ chủ nhân cầm công cụ đó — chạy
# với quyền chủ nhân. Job do zalo_group_cron tạo mang `origin.zalo_scope =
# "group"` và chạy với quyền công khai của người tạo, khoá trong đúng nhóm.
# KHÔNG dựa vào origin.user_id: trong nhóm dùng chung phiên, Hermes có thể ghi
# vào đó UID của một thành viên khác.

GROUP_CRON_SCOPE = "group"


def _cron_jobs():
    """Module quản lý job cron của Hermes — tách thành hàm để test thay được."""
    from cron import jobs
    return jobs


def _cron_job_id(kw: Dict[str, Any]) -> str:
    parts = str(kw.get("task_id") or "").split(":")
    return parts[1] if len(parts) >= 2 and parts[0] == "cron" and parts[1] else ""


def _cron_target(job: Dict[str, Any]) -> str:
    """Hội thoại Zalo mà job gửi kết quả về; rỗng nếu job không gửi về Zalo."""
    for part in str(job.get("deliver") or "").split(","):
        part = part.strip()
        if part.startswith("zalo:"):
            return part[len("zalo:"):].split(":", 1)[0]
    origin = job.get("origin")
    if isinstance(origin, dict) and str(origin.get("platform") or "") == "zalo":
        return str(origin.get("chat_id") or "")
    return ""


def _is_group_cron(job: Dict[str, Any]) -> bool:
    origin = job.get("origin")
    return isinstance(origin, dict) and origin.get("zalo_scope") == GROUP_CRON_SCOPE


def _allowed_owner_uids() -> List[str]:
    from agent.secret_scope import UnscopedSecretError, get_secret
    try:
        raw = get_secret("ZALO_ALLOWED_USERS", "")
    except UnscopedSecretError:
        # Đang multiplex mà không có scope: os.environ có thể là chủ của hồ sơ
        # khác — coi như không có chủ nhân nào thay vì đọc nhầm sang họ.
        return []
    return [uid.strip() for uid in str(raw or "").split(",") if uid.strip()]


def _cron_is_group(target: str, origin: Dict[str, Any], owners: List[str]) -> bool:
    known = getattr(_ACTIVE_ADAPTER, "_known_thread_types", None) or {}
    if target in known:
        return known[target] == THREAD_GROUP
    chat_type = str(origin.get("chat_type") or "").lower()
    if chat_type in {"group", "dm"}:
        return chat_type == "group"
    if target in owners:
        return False
    return len(target) >= 19


def _cron_turn(kw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Dựng turn cho lời gọi công cụ đến từ cron; None nghĩa là không gắn gì."""
    job_id = _cron_job_id(kw)
    if not job_id:
        return None
    try:
        job = _cron_jobs().get_job(job_id)
    except Exception as exc:
        logger.warning("[zalo] không đọc được job cron %s: %s", job_id, exc)
        return None
    if not job:
        return None
    target = _cron_target(job)
    if not target:
        return None
    origin = job.get("origin") if isinstance(job.get("origin"), dict) else {}

    if _is_group_cron(job):
        creator = str(origin.get("zalo_creator_uid") or "")
        if not creator:
            return None
        return {
            "sender_uid": creator,
            "sender_name": str(origin.get("zalo_creator_name") or ""),
            "thread_id": target,
            "is_group": True,
            "is_owner": False,
            "text": "",
            "cron_job_id": job_id,
        }

    if "zalo_scope" in origin or "zalo_creator_uid" in origin:
        # Mang dấu vết cron nhóm mà không hợp lệ (sai giá trị, thiếu dấu) thì
        # không gắn gì — tuyệt đối không rơi xuống thành cron của chủ nhân.
        return None

    owners = _allowed_owner_uids()
    if not owners:
        return None
    return {
        "sender_uid": owners[0],
        "sender_name": "",
        "thread_id": target,
        "is_group": _cron_is_group(target, origin, owners),
        "is_owner": True,
        # Không có tin người thật gõ: mã duyệt đăng Fanpage không bao giờ khớp.
        "text": "",
        "cron_job_id": job_id,
    }


def group_cron_creator(job_id: str) -> Optional[str]:
    """UID người tạo nếu ``job_id`` là việc hẹn giờ nhóm (``zalo_scope = "group"``).

    None: không phải việc hẹn giờ nhóm (job cron gốc của chủ nhân, job không còn,
    không đọc được job). Chuỗi rỗng: mang dấu cron nhóm nhưng thiếu người tạo.
    Adapter dùng để không gửi kết quả vào nhóm đang tắt "Hoạt động".
    """
    job_id = str(job_id or "").strip()
    if not job_id:
        return None
    try:
        job = _cron_jobs().get_job(job_id)
    except Exception as exc:
        logger.warning("[zalo] không đọc được job cron %s: %s", job_id, exc)
        return None
    if not job or not _is_group_cron(job):
        return None
    return str(job["origin"].get("zalo_creator_uid") or "")


def _with_cron_turn(handler, tool_name: str):
    """Lớp bọc ngoài cùng: gắn danh tính cho lời gọi công cụ từ một lượt cron.

    Lượt chat đang có thì giữ nguyên — không bao giờ ghi đè người gửi thật.
    """
    async def guarded(args: Dict[str, Any], **kw) -> str:
        if _turn():
            return await handler(args, **kw)
        turn = _cron_turn(kw)
        if turn is None:
            return await handler(args, **kw)
        token = _TURN.set(turn)
        try:
            return await handler(args, **kw)
        finally:
            _TURN.reset(token)

    guarded.__name__ = getattr(handler, "__name__", tool_name)
    guarded.__doc__ = getattr(handler, "__doc__", None)
    return guarded


def _err(message: str) -> str:
    return json.dumps({"success": False, "error": message}, ensure_ascii=False)


def _ok(payload: Any) -> str:
    return json.dumps({"success": True, "result": payload}, ensure_ascii=False, default=str)


def _thread_type(kind: Optional[str]) -> int:
    return THREAD_GROUP if str(kind or "").lower() == "group" else THREAD_USER


def _scoped_thread(args: Dict[str, Any], key: str = "thread_id") -> tuple:
    """Chốt hội thoại đích cho một công cụ công khai.

    Người ngoài chỉ được tác động lên đúng cuộc trò chuyện họ đang tham gia.
    Nếu không ràng buộc, một tham số ``thread_id`` tuỳ ý là đủ để họ nhờ bot
    gửi tin hay tạo bình chọn trong nhóm khác mà họ không có mặt.

    Trả về ``(thread_id, kind, error)``; ``error`` khác None nghĩa là chặn.
    """
    turn = _turn()
    asked = str(args.get(key) or "").strip()
    current = _current_thread()

    if turn.get("is_owner"):
        # Chủ nhân được nhắm tới hội thoại bất kỳ.
        target = asked or current
        if not target:
            return None, None, _err(f"cần `{key}`")
        kind = args.get("thread_kind") or (_current_thread_kind() if target == current else "dm")
        return target, kind, None

    if not current:
        return None, None, _err("không xác định được cuộc trò chuyện hiện tại")
    if asked and asked != current:
        return None, None, _err(
            "chỉ dùng được trong chính cuộc trò chuyện này — không nhắm tới hội thoại khác"
        )
    return current, _current_thread_kind(), None


def _self_uid() -> str:
    """UID của chính tài khoản bot, rỗng nếu chưa nối được cầu."""
    adapter = _ACTIVE_ADAPTER
    profile = getattr(adapter, "_self_profile", None) or {}
    return str(profile.get("user_id") or "")


async def _invoke(method: str, args: List[Any]) -> str:
    """Gọi một hàm zca-js qua cầu nối và gói kết quả lại thành JSON."""
    adapter = _ACTIVE_ADAPTER
    if adapter is None:
        return _err(
            "Zalo chưa kết nối. Chạy `npm start` trong thư mục 2anh-zalo-bot, "
            "rồi khởi động lại gateway."
        )
    if _CONFIRMED.get():
        ack = await adapter.invoke(method, args, confirmed=True)
    else:
        ack = await adapter.invoke(method, args)
    if ack is None:
        return _err(f"Sidecar không phản hồi lệnh {method} (quá hạn chờ)")
    if not ack.get("ok"):
        return _err(ack.get("error") or f"{method} thất bại")
    return _ok(ack.get("result"))


# =====================================================================
#  Vẽ ảnh AI / tạo video AI cho mọi người (Phân quyền › Xưởng: "Vẽ ảnh AI", "Tạo video AI")
# =====================================================================

_MEDIA_LOCK = threading.Lock()


def _media_usage_path() -> Path:
    return group_permissions.permissions_path().parent / "media-usage.json"


def _vn_today() -> str:
    return datetime.now(timezone(timedelta(hours=7))).strftime("%Y-%m-%d")


def _media_used(uid: str, kind: str) -> int:
    try:
        data = json.loads(_media_usage_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    if not isinstance(data, dict) or data.get("day") != _vn_today():
        return 0
    return int(((data.get("people") or {}).get(uid) or {}).get(kind) or 0)


def _media_take(uid: str, kind: str, limit: int) -> bool:
    """Trừ một lượt nếu còn (dưới khoá). Ngày mới (giờ Việt Nam) thì đếm lại từ 0."""
    path = _media_usage_path()
    with _MEDIA_LOCK:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict) or data.get("day") != _vn_today():
            data = {"day": _vn_today(), "people": {}}
        person = data.setdefault("people", {}).setdefault(uid, {})
        if int(person.get(kind) or 0) >= limit:
            return False
        person[kind] = int(person.get(kind) or 0) + 1
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
        return True


def _media_give_back(uid: str, kind: str) -> None:
    path = _media_usage_path()
    with _MEDIA_LOCK:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            person = data["people"][uid]
            person[kind] = max(0, int(person.get(kind) or 0) - 1)
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except (OSError, ValueError, KeyError, TypeError):
            pass


def _media_ref_ok(ref: str, is_owner: bool) -> bool:
    """Ảnh mẫu người ngoài được dùng: link https, hoặc ảnh trong bộ nhớ đệm ảnh của Hermes (ảnh họ vừa gửi) —
    không cho trỏ tới tệp bất kỳ trên máy chủ."""
    ref = str(ref or "").strip()
    if is_owner or ref.lower().startswith("https://"):
        return True
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home()).resolve()
        target = Path(ref).resolve()
    except Exception:
        return False
    return any(target.is_relative_to(home / sub) for sub in ("image_cache", "cache/images", "cache"))


async def zalo_media(args: Dict[str, Any], **_kw) -> str:
    """Vẽ ảnh AI (gửi ngay vào cuộc trò chuyện) hoặc tạo video AI (chạy nền, xong tự gửi)."""
    from . import media_engines

    turn = _turn() or {}
    kind = str(args.get("kind") or "").strip()
    prompt = " ".join(str(args.get("prompt") or "").split())[:2000]
    if kind not in ("image", "video"):
        return _err("kind phải là image hoặc video")
    if not prompt:
        return _err("cần mô tả (prompt)")
    style = " ".join(str(args.get("style") or "").split())[:200]
    if kind == "video" and (not style or not args.get("confirmed")):
        return _err("video AI cần người dùng chốt trước: HỎI phong cách (điện ảnh, hoạt hình 3D, anime, phim tài liệu, "
                    "quảng cáo…), rồi viết kịch bản ngắn (cảnh, góc máy, chuyển động, thời lượng, khổ) gửi họ xác nhận; "
                    "họ đồng ý rồi gọi lại với style=<phong cách> và confirmed=true")
    if style:
        prompt = f"{prompt} Style: {style}."[:2000]
    thread_id, thread_kind, err = _scoped_thread({})
    if err:
        return err
    is_owner = bool(turn.get("is_owner"))
    uid = str(turn.get("sender_uid") or "")
    refs = [r for r in (args.get("images") or []) if isinstance(r, str) and r.strip()][:4]
    if any(not _media_ref_ok(r, is_owner) for r in refs):
        return _err("ảnh mẫu phải là link https hoặc ảnh vừa gửi trong cuộc trò chuyện")
    if not is_owner:
        limit = group_permissions.media_quotas(uid, str(turn.get("thread_id") or ""), bool(turn.get("is_group")))[kind]
        if not _media_take(uid, kind, limit):
            what = "ảnh" if kind == "image" else "video"
            return _err(f"hôm nay người này đã dùng hết {limit} {what} AI — mai thử lại, hoặc nhờ chủ bot nâng hạn mức")
    if kind == "image":
        await _send_wait(turn, f"🎨 {_bot_name()} đang vẽ ảnh, bạn chờ khoảng 1 phút nhé.")
        try:
            got = await asyncio.to_thread(media_engines.draw, prompt, aspect=str(args.get("aspect") or "square"), refs=refs)
        except media_engines.EngineError as exc:
            if not is_owner:
                _media_give_back(uid, kind)
            return _err(f"chưa vẽ được ảnh: {exc}")
        from agent.image_gen_provider import save_b64_image
        import base64 as _b64
        path = save_b64_image(_b64.b64encode(got["data"]).decode("ascii"), prefix=f"2anh_{got['engine']}",
                              extension=media_engines.sniff(got["data"]) or "png")
        sent = json.loads(await _invoke("sendMessage", [{"msg": "", "attachments": [str(path)]}, thread_id,
                                                         _thread_type(thread_kind)]))
        try:
            os.remove(path)
        except OSError:
            pass
        if not sent.get("success"):
            return _err(f"vẽ xong nhưng chưa gửi được ảnh: {sent.get('error')}")
        note = f" (nguồn ưu tiên lỗi nên đã dùng {media_engines.ENGINE_LABELS[got['engine']]})" if got["fallbacks"] else ""
        return _ok(f"Đã vẽ và gửi ảnh vào cuộc trò chuyện{note} (đã tự nhắn báo chờ trước khi vẽ). Đừng gửi lại "
                   "ảnh; chỉ nói một câu ngắn nếu cần.")
    try:
        job = await asyncio.to_thread(media_engines.submit_video, prompt, seconds=args.get("seconds"),
                                      aspect=str(args.get("aspect") or "9:16"), refs=refs)
    except media_engines.EngineError as exc:
        if not is_owner:
            _media_give_back(uid, kind)
        return _err(f"chưa tạo được video: {exc}")
    from agent.video_gen_provider import save_bytes_video
    media_engines.start_background(dict(turn), job, prompt, save_bytes_video)
    name = _bot_name()
    await _send_wait(turn, f"🎬 {name} đang tạo video AI {job['seconds']} giây, bạn chờ khoảng 3–15 phút nhé — xong "
                           f"{name} tự gửi video vào đây.")
    return _ok(f"Đã gửi yêu cầu tạo video {job['seconds']} giây; ĐÃ tự nhắn người dùng chờ 3–15 phút. Xong hệ thống "
               "TỰ GỬI vào cuộc trò chuyện này. Đừng nhắn lại lời chờ; đừng gọi lại công cụ này.")


# =====================================================================
#  Nhóm 1 — Gửi nội dung phong phú
# =====================================================================

async def zalo_send_file(args: Dict[str, Any], **_kw) -> str:
    paths = args.get("paths") or ([args["path"]] if args.get("path") else [])
    if not paths:
        return _err("cần `path` hoặc `paths`")
    thread_id, kind, err = _scoped_thread(args)
    if err:
        return err

    # Đây là công cụ công khai và nó nhận đường dẫn tệp trên máy chủ. Nếu để
    # nguyên thì bất kỳ ai trong nhóm cũng chỉ cần nhờ "gửi giúp mình tệp
    # E:\\Hermes\\.env" là bot ngoan ngoãn tải khoá API lên nhóm. Việc lọc bí
    # mật của Hermes không cứu được: nó soát văn bản, còn đây là tệp nhị phân
    # đi thẳng lên máy chủ Zalo.
    #
    # Nên người ngoài chỉ gửi được tệp NẰM TRONG kho tài liệu — đúng phạm vi
    # mà zalo_kb_read đã mở, không rộng thêm một tấc nào. Chủ nhân giữ nguyên
    # quyền gửi tệp bất kỳ.
    turn = _turn()
    if turn and not turn.get("is_owner"):
        root = _kb_root()
        if root is None:
            return _err("chưa cấu hình kho tài liệu nên chưa gửi tệp được")
        safe = []
        for p in paths:
            target = _kb_resolve(root, p)
            if target is None or not target.is_file():
                return _err(f"chỉ gửi được tệp trong kho tài liệu, không gửi được '{p}'")
            rel = target.relative_to(root).as_posix()
            if not _kb_allowed(rel):
                return _err(f"tệp '{rel}' nằm ngoài phạm vi được phép chia sẻ")
            safe.append(str(target))
        paths = safe

    # Gửi qua sendMessage chứ KHÔNG qua uploadAttachment.
    #
    # `uploadAttachment` chỉ đẩy tệp lên CDN của Zalo rồi trả về fileUrl —
    # nó không đăng tệp thành tin nhắn. API báo thành công, agent tin là đã
    # gửi và nói với người dùng như vậy, nhưng trong nhóm chẳng có gì. Không
    # có dấu hiệu nào để lần ra, vì mọi thứ đều "thành công".
    #
    # Dấu hiệu phân biệt: uploadAttachment trả về fileUrl/fileId, còn
    # sendMessage trả về `attachment: [{msgId}]` — có msgId mới là tin thật.
    caption = str(args.get("caption") or "").strip()
    return await _invoke("sendMessage", [
        {"msg": caption, "attachments": paths},
        thread_id, _thread_type(kind),
    ])


# Mỗi người trong nhóm tạo tối đa bấy nhiêu tệp trong một giờ (chủ nhân không giới hạn):
# nhóm vài trăm người mà ai cũng nhờ dựng tệp dài thì bot nghẽn và tốn token.
FILE_QUOTA_PER_HOUR = 5
_FILE_QUOTA: Dict[str, List[float]] = {}


async def zalo_make_file(args: Dict[str, Any], **_kw) -> str:
    """Dựng tệp Word/PowerPoint/Excel/PDF từ nội dung bot soạn rồi gửi vào nhóm đang chat.

    Người trong nhóm không có công cụ ghi tệp hay chạy lệnh, nên công cụ này chỉ nhận nội
    dung (xem file_maker) và dựng trong thư mục tạm, gửi xong là xoá.
    """
    from . import file_maker

    turn = _turn() or {}
    is_owner = bool(turn.get("is_owner"))
    if not is_owner and not turn.get("is_group"):
        return _err("chỉ tạo tệp cho thầy cô trong nhóm; nhắn riêng thì chưa hỗ trợ")
    thread_id, kind, err = _scoped_thread(args)
    if err:
        return err

    uid = str(turn.get("sender_uid") or "")
    now = time.time()
    if not is_owner:
        recent = [ts for ts in _FILE_QUOTA.get(uid, []) if now - ts < 3600]
        _FILE_QUOTA[uid] = recent
        if len(recent) >= FILE_QUOTA_PER_HOUR:
            wait = int((3600 - (now - recent[0])) // 60) + 1
            return _err(f"mỗi người tạo tối đa {FILE_QUOTA_PER_HOUR} tệp mỗi giờ — thử lại sau khoảng {wait} phút")

    import shutil
    import tempfile

    directory = tempfile.mkdtemp(prefix="zalo-file-")
    try:
        try:
            path = await asyncio.to_thread(
                file_maker.make_file,
                args.get("format"),
                args.get("title") or "",
                directory=directory,
                filename=args.get("filename"),
                content=args.get("content"),
                slides=args.get("slides"),
                sheets=args.get("sheets"),
            )
        except file_maker.FileSpecError as exc:
            return _err(str(exc))
        except ImportError:
            return _err("máy chủ chưa cài thư viện tạo tệp (python-docx, python-pptx, openpyxl, fpdf2)")
        caption = str(args.get("caption") or "").strip()
        sent = await _invoke("sendMessage", [
            {"msg": caption, "attachments": [str(path)]},
            thread_id, _thread_type(kind),
        ])
        result = json.loads(sent)
        if not is_owner and result.get("success"):
            _FILE_QUOTA.setdefault(uid, []).append(now)
        if result.get("success") and args.get("format") == "pptx":
            # Bot từng báo khách "đúng 100% style mẫu" với tệp này — nói thẳng nó là gì.
            result["note"] = ("Đây là slide chữ theo mẫu cố định của bot (không ảnh, không theo template người dùng "
                              "gửi). Báo đúng như vậy; đừng nói là giống mẫu hay do Xưởng/2Anh Studio làm.")
            return json.dumps(result, ensure_ascii=False)
        return sent
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# Mỗi người trong nhóm xử lý tối đa bấy nhiêu lần PDF một giờ (chủ nhân không giới hạn).
PDF_QUOTA_PER_HOUR = 5
_PDF_QUOTA: Dict[str, List[float]] = {}


async def zalo_pdf(args: Dict[str, Any], **_kw) -> str:
    """Chuyển PDF sang Word, gộp hoặc tách trang PDF người dùng gửi; gửi kết quả rồi xoá.

    Chỉ chọn trong tệp đính kèm adapter ghi vào turn (xem pdf_tools) — không nhận
    đường dẫn nào từ mô hình.
    """
    import shutil
    import tempfile

    from . import pdf_tools

    turn = _turn() or {}
    as_owner = _acting_as_owner(turn)
    if not as_owner and not turn.get("is_group"):
        return _err("chỉ xử lý PDF trong nhóm; nhắn riêng thì chưa hỗ trợ")
    action = str(args.get("action") or "")
    if action not in ("to_word", "merge", "split"):
        return _err("action phải là to_word, merge hoặc split")
    thread_id, kind, err = _scoped_thread({})
    if err:
        return err
    try:
        items = pdf_tools.pick_pdfs(list(turn.get("attachments") or []), list(args.get("files") or []))
    except pdf_tools.PdfError as exc:
        return _err(str(exc))
    if action != "merge" and len(items) != 1:
        names = "; ".join(f"{i}) {item.get('name')}" for i, item in enumerate(items, 1))
        return _err(f"có {len(items)} tệp PDF: {names} — chọn một tệp bằng `files`")
    pages = str(args.get("pages") or "")
    if action == "split":
        # Soát cú pháp trước khi trừ lượt: mô hình ghi sai không làm người dùng mất lượt.
        try:
            pdf_tools.parse_pages(pages, pdf_tools.MAX_PAGES_TOTAL)
        except pdf_tools.PdfError as exc:
            return _err(str(exc))

    if not pdf_tools.LOCK.acquire(blocking=False):
        return _err("bot đang xử lý một tệp PDF khác, thử lại sau ít phút")
    directory = None
    keep = False
    try:
        if not as_owner:
            denied = _take_quota(_PDF_QUOTA, str(turn.get("sender_uid") or ""), PDF_QUOTA_PER_HOUR, "xử lý PDF")
            if denied:
                return denied
        directory = tempfile.mkdtemp(prefix="zalo-pdf-")
        try:
            path = await pdf_tools.run(action, items, directory, pages)
        except pdf_tools.PdfError as exc:
            return _err(str(exc))
        caption = str(args.get("caption") or "").strip()
        sent = await _invoke("sendMessage", [
            {"msg": caption, "attachments": [path]},
            thread_id, _thread_type(kind),
        ])
        if str(json.loads(sent).get("error", "")).startswith("Sidecar không phản hồi"):
            # Như zalo_video_download: sidecar có thể vẫn đang tải tệp lên Zalo.
            keep = True
            return _ok({"status": "unconfirmed",
                        "note": "Zalo chưa xác nhận sau 150 giây — tệp có thể vẫn đang gửi. "
                                "Báo người dùng chờ thêm, ĐỪNG làm lại."})
        return sent
    finally:
        if directory:
            if keep:
                from . import media
                media.schedule_cleanup(directory)
            else:
                shutil.rmtree(directory, ignore_errors=True)
        pdf_tools.LOCK.release()


# =====================================================================
#  Xưởng tạo sản phẩm (spec §17) — slide, văn bản, đề, video cho người không phải chủ nhân
# =====================================================================
#
# Công cụ chỉ NHẬN việc: kiểm nút + hạn mức, chụp danh tính lượt này, xếp hàng, trả lời ngay.
# Việc thật chạy ở studio/jobs.py trên luồng riêng; xong thì gửi tệp vào đúng hội thoại đã chụp.

_STUDIO_CTX = None   # PluginContext — lấy ctx.llm lúc cần (Hermes cũ không có thuộc tính này)
_STUDIO = None
_STUDIO_LOCK = threading.Lock()


def set_studio_context(ctx) -> None:
    global _STUDIO_CTX
    _STUDIO_CTX = ctx


def _studio_llm():
    try:
        return getattr(_STUDIO_CTX, "llm", None)
    except Exception as exc:
        logger.warning("[zalo] không lấy được ctx.llm cho xưởng: %s", exc)
        return None


def _studio_rules(turn: Dict[str, Any]) -> Dict[str, Any]:
    """Quyền xưởng của lượt (không phải chủ nhân). Đọc lỗi → mọi nút tắt: xưởng không bao giờ mở vì lỗi."""
    try:
        return group_permissions.studio_settings(str(turn.get("sender_uid") or ""),
                                                 str(turn.get("thread_id") or ""), bool(turn.get("is_group")))
    except Exception as exc:
        logger.warning("[zalo] không đọc được quyền xưởng — coi như tắt: %s", exc)
        return {"features": {f: False for f in group_permissions.STUDIO_FEATURES}, "quota": 0}


def _studio_ledger():
    from .studio.ledger import Ledger
    return Ledger()


def _studio_quota_left(job) -> Optional[int]:
    if job.turn.get("is_owner"):
        return None
    quota = _studio_rules(job.turn)["quota"]
    return max(0, quota - _studio_ledger().used_today(job.uid))


def _studio_still_allowed(job) -> bool:
    """Ngay trước khi gửi: nút còn bật, nhóm còn hoạt động, người này còn được nhắn riêng."""
    turn = job.turn
    if turn.get("is_owner"):
        return True
    if not _studio_rules(turn)["features"].get(job.recipe.switch):
        return False
    try:
        if turn.get("is_group"):
            return bool(group_permissions.group_settings(str(turn.get("thread_id") or ""))["active"])
        return group_permissions.dm_allows(str(turn.get("sender_uid") or "")) is not False
    except Exception:
        return False


async def _studio_send(job, payload: Dict[str, Any]) -> str:
    """Gửi bằng danh tính đã chụp lúc nhận việc — kết nối Zalo vẫn kiểm cùng hội thoại + quyền nhắn riêng."""
    token = _TURN.set(dict(job.turn))
    try:
        return await _invoke("sendMessage", [payload, str(job.turn.get("thread_id") or ""),
                                             THREAD_GROUP if job.turn.get("is_group") else THREAD_USER])
    finally:
        _TURN.reset(token)


async def _studio_deliver(job, files, caption: str) -> Optional[bool]:
    sent = json.loads(await _studio_send(job, {"msg": caption, "attachments": [str(p) for p in files]}))
    if sent.get("success"):
        return True
    if str(sent.get("error", "")).startswith("Sidecar không phản hồi"):
        return None
    logger.warning("[zalo] xưởng %s: gửi tệp lỗi: %s", job.id, sent.get("error"))
    return False


async def _studio_notify(job, text: str) -> None:
    await _studio_send(job, {"msg": text})


def _studio():
    global _STUDIO
    from .studio import jobs
    with _STUDIO_LOCK:
        if _STUDIO is None:
            _STUDIO = jobs.Studio(ledger=_studio_ledger(), llm=_studio_llm, deliver=_studio_deliver,
                                  notify=_studio_notify, still_allowed=_studio_still_allowed,
                                  quota_left=_studio_quota_left)
        return _STUDIO


def studio_turn_note(sender_uid: str, thread_id: str, is_group: bool) -> Optional[str]:
    """Dòng ngữ cảnh cho lượt không phải chủ nhân: xưởng làm được gì cho người này, còn bao nhiêu lượt."""
    from .studio import recipes

    rules = _studio_rules({"sender_uid": sender_uid, "thread_id": thread_id, "is_group": is_group})
    on = [f for f in group_permissions.STUDIO_FEATURES if rules["features"].get(f)]
    if not on:
        return None
    notes = []
    kinds = ", ".join(f"{kind} ({recipes.RECIPES[kind].label})" for f in on for kind in recipes.kinds_for(f))
    if kinds:
        left = max(0, rules["quota"] - _studio_ledger().used_today(sender_uid))
        notes.append(f"[Xưởng tạo sản phẩm: người này nhờ được bằng công cụ zalo_studio — {kinds}. Hôm nay còn {left} "
                     f"lượt. Gom đủ yêu cầu vào `brief` rồi gọi một lần; không tự làm bằng cách khác.]")
    media = [label for f, label in (("studioImage", "vẽ ảnh AI (kind=image)"), ("studioAIVideo", "tạo video AI (kind=video)"))
             if rules["features"].get(f)]
    if media:
        notes.append(f"[Người này nhờ được {', '.join(media)} bằng công cụ zalo_media — có hạn mức mỗi ngày.]")
    return " ".join(notes)


VIDEO_STYLE_CHOICES = ("viết tay trên bảng (viet-tay); cắt dán giấy (cat-dan); Vox có ảnh minh hoạ AI (vox); "
                       "video ngắn TikTok/Reels khổ dọc, hình đổi theo từng câu, có nhân vật minh hoạ hoặc số liệu (ngan)")


def _bot_name() -> str:
    """Tên hiển thị Zalo của chính tài khoản bot (Lăng Tiêu, Uyển Nhi…) cho tin nhắn gửi người dùng; chưa biết → "Mình"."""
    profile = getattr(_ACTIVE_ADAPTER, "_self_profile", None)
    name = str((profile or {}).get("display_name") or "").strip() if isinstance(profile, dict) else ""
    return name[:40] or "Mình"


async def _send_wait(turn: Dict[str, Any], text: str) -> None:
    """Tin báo chờ gửi NGAY (không đợi mô hình nói), để người dùng biết bot vẫn đang làm. Lỗi gửi thì bỏ qua."""
    try:
        await _invoke("sendMessage", [{"msg": text}, str(turn.get("thread_id") or ""),
                                      THREAD_GROUP if turn.get("is_group") else THREAD_USER])
    except Exception as exc:
        logger.info("[zalo] không gửi được tin báo chờ: %s", exc)


async def zalo_studio(args: Dict[str, Any], **_kw) -> str:
    """Nhận một việc cho xưởng; tệp làm xong bot tự gửi vào đúng cuộc trò chuyện này.

    Video (``kind=video``) đi hai bước: ``action=plan`` viết kịch bản và gửi người dùng duyệt (phải có
    ``options.kieu`` — phong cách đã hỏi người dùng), ``action=make`` kèm ``plan_id`` mới dựng đúng kịch bản đã duyệt.
    ``video_bai_giang`` cần ``confirmed=true`` (đã hỏi kiểu bài và chốt dàn ý với người dùng)."""
    from .studio import drafts as drafts_module
    from .studio import jobs, recipes, script_view

    turn = _turn() or {}
    if not turn.get("thread_id") or not turn.get("sender_uid"):
        return _err("chỉ dùng được trong một cuộc trò chuyện Zalo")
    kind = str(args.get("kind") or "")
    recipe = recipes.RECIPES.get(kind)
    if recipe is None:
        return _err(f"`kind` phải là một trong: {', '.join(recipes.RECIPES)}")
    action = str(args.get("action") or "make")
    if action not in ("plan", "make"):
        return _err("`action` là plan (viết kịch bản video để duyệt) hoặc make (làm sản phẩm)")
    if action == "plan" and kind != "video":
        return _err("chỉ video giải thích (kind=video) có bước lên kịch bản; loại khác gọi action=make")
    raw_options = args.get("options")
    if raw_options is None:
        raw_options = {}
    if not isinstance(raw_options, dict):
        return _err("`options` phải là một object, ví dụ {\"loai\": \"bai-giang\"}")
    as_owner = _acting_as_owner(turn)
    quota: Optional[int] = None
    if not as_owner:
        rules = _studio_rules(turn)
        if not rules["features"].get(recipe.switch):
            label = group_permissions.STUDIO_LABELS[recipe.switch]
            return _err(f"chủ bot chưa bật tính năng {label} cho {'nhóm này' if turn.get('is_group') else 'người này'} — "
                        "nói ngắn gọn với người hỏi, đừng thử cách khác")
        quota = rules["quota"]
    store = drafts_module.Drafts()
    uid, thread = str(turn.get("sender_uid")), str(turn.get("thread_id"))
    captured = {key: turn.get(key) for key in ("sender_uid", "sender_name", "thread_id", "is_group")}
    captured["is_owner"] = as_owner
    studio = _studio()
    script = ""

    if kind == "video" and action == "plan":
        previous = None
        if args.get("plan_id"):
            previous = store.get(str(args["plan_id"]), uid=uid, thread_id=thread)
            if previous is None:
                return _err("không thấy kịch bản này (hết hạn 48 giờ hoặc của người khác) — viết kịch bản mới")
        kieu = str(raw_options.get("kieu") or (previous or {}).get("options", {}).get("kieu") or "")
        if kieu not in recipe.options["kieu"]:
            return _err("chưa biết phong cách video — HỎI người dùng muốn phong cách nào trong: " + VIDEO_STYLE_CHOICES +
                        "; kèm khổ (dọc/ngang) nếu chưa rõ (video ngắn luôn dọc). Không hỏi giọng — kịch bản tự chọn. Có câu trả lời rồi gọi lại action=plan với "
                        "options.kieu.")
        brief = str(args.get("brief") or (previous or {}).get("brief") or "").strip()
        if len(brief) < 10:
            return _err("cần `brief`: chép đủ yêu cầu của người dùng (chủ đề, môn, lớp, khổ, giọng, ý muốn có)")
        if quota is not None and max(0, quota - studio.ledger.used_today(uid)) <= 0:
            return _err(f"hôm nay người này đã dùng hết {quota} lượt xưởng — hẹn mai nhé")
        if not store.take_slot(uid, owner=as_owner):
            return _err(f"hôm nay người này đã nhờ viết {drafts_module.MAX_DRAFTS_PER_DAY} kịch bản — chốt một bản hoặc mai thử lại")
        feedback = str(args.get("feedback") or "").strip()[:2000]
        job = jobs.Job(id=jobs.new_job_id(), kind=kind, brief=brief[:8000], options={"kieu": kieu}, turn=captured)
        draft_id = drafts_module.new_draft_id()
        minutes = jobs.estimate_minutes(kind, job.options)

        async def done(job_: jobs.Job, text: str) -> None:
            store.save(draft_id, {"uid": uid, "thread_id": thread, "kind": kind, "options": job_.options,
                                  "brief": job_.brief, "text": text})
            await _studio_notify(job_, script_view.render(text, draft_id, minutes, name=_bot_name()))

        name = _bot_name()
        await _send_wait(turn, f"✍️ {name} đang {'sửa' if previous else 'viết'} kịch bản video, bạn chờ khoảng 1–2 phút nhé. "
                               f"Xong {name} gửi kịch bản để bạn duyệt trước khi tạo video.")
        studio.submit_draft(job, feedback=feedback, previous=(previous or {}).get("text", ""), done=done)
        return _ok({"status": "drafting", "plan_id": draft_id,
                    "note": ("ĐÃ tự nhắn người dùng chờ 1–2 phút; kịch bản sẽ tự gửi kèm mã "
                             f"{draft_id}. Đừng nhắn lại lời chờ, đừng tự viết kịch bản. Khi người dùng đồng ý → gọi "
                             f"zalo_studio action=make kind=video plan_id={draft_id}. Muốn sửa → action=plan, "
                             f"plan_id={draft_id}, feedback=<điều cần sửa>.")})

    if kind == "video":
        draft = store.get(str(args.get("plan_id") or ""), uid=uid, thread_id=thread) if args.get("plan_id") else None
        if draft is None:
            return _err("video phải qua bước duyệt kịch bản: hỏi phong cách → zalo_studio action=plan → gửi kịch bản → "
                        "người dùng đồng ý → action=make kèm plan_id. Thiếu hoặc sai plan_id.")
        options, brief, script = dict(draft["options"]), draft["brief"], draft["text"]
    else:
        if kind == "video_bai_giang" and not args.get("confirmed"):
            return _err("video bài giảng cần người dùng chốt trước: hỏi kiểu bài (options.loai) và gửi dàn ý (các trang, ý "
                        "giảng chính, thời lượng) để họ đồng ý; có đồng ý rồi gọi lại với confirmed=true")
        brief = str(args.get("brief") or "").strip()
        if len(brief) < 10:
            return _err("cần `brief`: chép đủ yêu cầu của người dùng (chủ đề, môn, lớp, số lượng, yêu cầu riêng)")
        options = {}
        for key, allowed in recipe.options.items():
            value = str(raw_options.get(key) or allowed[0])
            if value not in allowed:
                return _err(f"`options.{key}` phải là một trong: {', '.join(allowed)}")
            options[key] = value
    job = jobs.Job(id=jobs.new_job_id(), kind=kind, brief=brief[:8000], options=options, turn=captured, script=script)
    if studio.pending_for(job.uid):
        return _err("người này đang có một việc ở xưởng chưa xong — chờ việc đó gửi xong rồi nhờ tiếp")
    left = studio.ledger.take(job_id=job.id, uid=job.uid, name=str(turn.get("sender_name") or ""), kind=kind,
                              thread_id=thread, is_group=bool(turn.get("is_group")), quota=quota)
    if left == -1:
        return _err(f"hôm nay người này đã dùng hết {quota} lượt xưởng — hẹn mai nhé")
    try:
        position = studio.submit(job)
    except jobs.Busy as exc:
        # Việc chưa chạy (hàng đầy ngay lúc nhận): trả lượt, không tính vào trần trả lượt trong ngày.
        studio.ledger.finish(job.id, "refunded", error=str(exc), capped=False)
        return _err(str(exc))
    if kind == "video":
        store.drop(str(args.get("plan_id")))
    minutes = jobs.estimate_minutes(kind, options)
    queue = f" (đang xếp thứ {position}, có thể lâu hơn)" if position > 1 else ""
    name = _bot_name()
    verb = "đang tạo" if kind in ("video", "video_bai_giang") else "đang làm"
    await _send_wait(turn, f"⏳ {name} {verb} {recipe.label}, bạn chờ khoảng {minutes} phút{queue} nhé — xong {name} tự gửi "
                           "tệp vào đây.")
    return _ok({"status": "queued", "job_id": job.id, "position": position, "quota_left": left,
                "note": (f"Đã nhận việc {recipe.label}; ĐÃ tự nhắn người dùng chờ khoảng {minutes} phút. "
                         "Đừng nhắn lại lời chờ; xong sẽ tự gửi tệp. Không gọi lại cho cùng yêu cầu.")})


async def zalo_send_voice(args: Dict[str, Any], **_kw) -> str:
    url = str(args.get("url") or "").strip()
    if not url:
        return _err("cần `url`")
    thread_id, kind, err = _scoped_thread(args)
    if err:
        return err
    if os.path.isfile(url):
        turn = _turn()
        if not turn.get("is_owner"):
            root = _kb_root()
            target = _kb_resolve(root, url) if root is not None else None
            if target is None or not target.is_file():
                return _err("chỉ gửi được voice cục bộ nằm trong kho tài liệu")
            rel = target.relative_to(root).as_posix()
            if not _kb_allowed(rel):
                return _err(f"tệp '{rel}' nằm ngoài phạm vi được phép chia sẻ")
            url = str(target)
        adapter = _ACTIVE_ADAPTER
        if adapter is None:
            return _err("Zalo chưa kết nối")
        result = await adapter.send_voice(
            str(thread_id), url, metadata={"chat_type": kind}
        )
        if not result.success:
            return _err(result.error or "gửi voice thất bại")
        return _ok({"message_id": result.message_id})
    # Với URL, sidecar tự gửi yêu cầu HEAD tới địa chỉ đó từ máy chủ. Người
    # ngoài mà truyền địa chỉ nội bộ là dò được mạng LAN/localhost.
    if not _turn().get("is_owner") and not _is_public_url(url):
        return _err("chỉ gửi được voice từ địa chỉ web công cộng (http/https)")
    return await _invoke("sendVoice", [
        {"voiceUrl": url, "ttl": args.get("ttl", 0)}, thread_id, _thread_type(kind),
    ])


async def zalo_send_sticker(args: Dict[str, Any], **_kw) -> str:
    keyword = (args.get("keyword") or "").strip()
    if not keyword:
        return _err("cần `keyword`")
    thread_id, kind, err = _scoped_thread(args)
    if err:
        return err

    found = await _invoke("searchSticker", [keyword])
    payload = json.loads(found)
    if not payload.get("success"):
        return found
    stickers = payload.get("result") or []
    if isinstance(stickers, dict):
        stickers = stickers.get("items") or []
    if not stickers:
        return _err(f"không tìm thấy sticker nào cho '{keyword}'")

    # searchSticker trả về StickerBasic {type, cate_id, sticker_id} còn
    # sendSticker đòi {id, cateId, type}. Tên trường khác hẳn nhau, nên truyền
    # thẳng object sang thì id/cateId thành undefined và Zalo lặng lẽ không gửi.
    top = stickers[0]
    if not isinstance(top, dict):
        return _err(f"sticker trả về không đúng định dạng: {top!r}")
    sticker_id = top.get("sticker_id", top.get("id"))
    cate_id = top.get("cate_id", top.get("cateId"))
    if sticker_id is None or cate_id is None:
        return _err(f"sticker thiếu id/cateId: {sorted(top)}")
    payload_out = {
        "id": int(sticker_id),
        "cateId": int(cate_id),
        "type": int(top.get("type", 0)),
    }

    return await _invoke("sendSticker", [payload_out, thread_id, _thread_type(kind)])


async def zalo_send_link(args: Dict[str, Any], **_kw) -> str:
    url = args.get("url")
    if not url:
        return _err("cần `url`")
    thread_id, kind, err = _scoped_thread(args)
    if err:
        return err
    return await _invoke("sendLink", [
        {"link": url, "msg": args.get("message", "")}, thread_id, _thread_type(kind),
    ])


async def zalo_forward(args: Dict[str, Any], **_kw) -> str:
    message = args.get("message")
    targets = args.get("thread_ids") or []
    if not message or not targets:
        return _err("cần `message` và `thread_ids`")
    return await _invoke("forwardMessage", [
        {"message": message}, [str(target) for target in targets],
        _thread_type(args.get("thread_kind")),
    ])


# =====================================================================
#  Nhóm 2 — Đọc ngữ cảnh
# =====================================================================

HISTORY_RANGE_CHAR_BUDGET = 60_000
HISTORY_RANGE_MAX_HOURS = 24 * 7
HISTORY_RANGE_PAGE = 300
_VN_TZ = timezone(timedelta(hours=7))


def _history_line(msg: Dict[str, Any]) -> str:
    """Một tin thành một dòng gọn "[13/09 17:02] Tên: nội dung" để tiết kiệm token."""
    try:
        when = datetime.fromtimestamp(int(msg.get("ts") or 0) / 1000, tz=_VN_TZ).strftime("%d/%m %H:%M")
    except (TypeError, ValueError, OSError):
        when = "--/-- --:--"
    who = "Bot" if msg.get("isSelf") else (msg.get("senderName") or msg.get("senderUid") or "?")
    text = " / ".join(part.strip() for part in str(msg.get("text") or "").splitlines() if part.strip())
    if not text:
        text = f"[{msg.get('msgType') or 'tin không có chữ'}]"
    return f"[{when}] {who}: {text[:1000]}"


async def _read_history_range(adapter: Any, thread_id: str, kind: Any, args: Dict[str, Any]) -> str:
    """Đọc hết tin trong N giờ qua, lật trang tới khi hết hoặc chạm ngân sách chữ.

    Dành cho việc tổng hợp thảo luận khi chủ nhân yêu cầu: 100 tin gần nhất
    không đủ cho một nhóm cộng đồng. Chỉ dừng ở ranh giới trang, nên con trỏ trả
    về luôn đọc tiếp đúng chỗ, không mất tin nào.
    """
    try:
        hours = float(args.get("since_hours") or 24)
    except (TypeError, ValueError):
        return _err("since_hours phải là số giờ, ví dụ 24")
    hours = min(max(hours, 0.1), HISTORY_RANGE_MAX_HOURS)
    now_ms = int(time.time() * 1000)
    since_ms = now_ms - int(hours * 3600 * 1000)
    cursor = str(args.get("cursor") or "").strip() or None

    lines: List[str] = []
    size = 0
    next_cursor = None
    while True:
        ack = await adapter.read_history_range(
            thread_id, since_ms, now_ms, cursor=cursor, limit=HISTORY_RANGE_PAGE,
            metadata={"chat_type": kind},
        )
        if not ack or not ack.get("ok"):
            return _err((ack or {}).get("error", "không đọc được lịch sử Zalo"))
        result = ack.get("result") or {}
        for msg in result.get("messages") or []:
            line = _history_line(msg)
            lines.append(line)
            size += len(line) + 1
        cursor = result.get("nextCursor")
        if not cursor:
            break
        if size >= HISTORY_RANGE_CHAR_BUDGET:
            next_cursor = cursor
            break

    return _ok({
        "thread_id": thread_id,
        "since_hours": hours,
        "count": len(lines),
        "con_nua": bool(next_cursor),
        "next_cursor": next_cursor,
        "huong_dan": (
            "Còn tin chưa đọc: gọi lại zalo_read_history với cùng since_hours và cursor = next_cursor "
            "cho tới khi con_nua = false, rồi mới tổng hợp."
            if next_cursor else "Đã đọc hết tin trong khoảng thời gian này."
        ),
        "text": "\n".join(lines),
    })


async def zalo_read_history(args: Dict[str, Any], **_kw) -> str:
    thread_id, kind, err = _scoped_thread(args)
    if err:
        return err
    adapter = _ACTIVE_ADAPTER
    if adapter is None:
        return _err("Zalo chưa kết nối")
    if args.get("since_hours") is not None or args.get("cursor"):
        return await _read_history_range(adapter, str(thread_id), kind, args)
    count = min(int(args.get("count", 30)), 100)
    ack = await adapter.read_history(
        str(thread_id), count, metadata={"chat_type": kind}
    )
    if not ack or not ack.get("ok"):
        return _err((ack or {}).get("error", "không đọc được lịch sử Zalo"))
    return _ok(ack.get("result"))


async def zalo_group_history(args: Dict[str, Any], **_kw) -> str:
    """Đọc lịch sử của đúng hội thoại mà lượt cron này gửi kết quả về.

    Không nhận `thread_id` từ mô hình: hội thoại lấy từ turn do _with_cron_turn
    dựng từ job, nên prompt của thành viên có viết gì cũng không đọc được nhóm khác.
    """
    turn = _turn()
    if not turn.get("cron_job_id"):
        return _err("công cụ này chỉ dùng trong việc hẹn giờ của nhóm")
    thread_id = str(turn.get("thread_id") or "")
    if not thread_id:
        return _err("không xác định được nhóm của việc hẹn giờ")
    adapter = _ACTIVE_ADAPTER
    if adapter is None:
        return _err("Zalo chưa kết nối")
    count = max(1, min(int(args.get("count", 30) or 30), 100))
    ack = await adapter.read_history(
        thread_id, count, metadata={"chat_type": "group" if turn.get("is_group") else "dm"}
    )
    if not ack or not ack.get("ok"):
        return _err((ack or {}).get("error", "không đọc được lịch sử Zalo"))
    return _ok(ack.get("result"))


THREAD_HISTORY_MAX_DAYS = 30
THREAD_HISTORY_MAX_LIMIT = 40
THREAD_HISTORY_CHAR_BUDGET = 6000
THREAD_HISTORY_PER_HOUR = 20
_THREAD_HISTORY_QUOTA: Dict[str, List[float]] = {}
_URL_LINE = re.compile(r"^\s*https?://\S+\s*$")


def _bounded_int(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _thread_history_line(msg: Dict[str, Any]) -> str:
    """Một tin thành một dòng cho thành viên: bỏ dòng chỉ là đường dẫn (ảnh/tệp), gắn nhãn loại tin, không kèm UID."""
    try:
        when = datetime.fromtimestamp(int(msg.get("ts") or 0) / 1000, tz=_VN_TZ).strftime("%d/%m %H:%M")
    except (TypeError, ValueError, OSError):
        when = "--/-- --:--"
    who = "Bot" if msg.get("isSelf") else (str(msg.get("senderName") or "").strip() or "Ai đó")
    kept = [part.strip() for part in str(msg.get("text") or "").splitlines()
            if part.strip() and not _URL_LINE.match(part)]
    text = " / ".join(kept)[:300]
    kind = str(msg.get("msgType") or "")
    label = {"share.file": "[tệp] ", "chat.photo": "[ảnh] ", "chat.video.msg": "[video] ",
             "chat.voice": "[ghi âm] ", "chat.sticker": "[nhãn dán] "}.get(kind, "")
    return f"[{when}] {who}: {label}{text}".rstrip() if (label or text) else f"[{when}] {who}: [{kind or 'tin không có chữ'}]"


async def zalo_thread_history(args: Dict[str, Any], **_kw) -> str:
    """Tra lịch sử của ĐÚNG cuộc trò chuyện đang diễn ra (spec §19.5).

    Không nhận `thread_id` từ mô hình: hội thoại lấy từ turn, sidecar còn ép lại lần nữa
    (zalo-policy.js sameThread). Chỉ đọc kho SQLite, không gọi Zalo, tối đa 40 tin/6000 ký tự.
    """
    turn = _turn()
    thread_id = str(turn.get("thread_id") or "")
    if not thread_id:
        return _err("không xác định được cuộc trò chuyện hiện tại")
    adapter = _ACTIVE_ADAPTER
    if adapter is None:
        return _err("Zalo chưa kết nối")
    if not _acting_as_owner(turn):
        problem = _take_quota(_THREAD_HISTORY_QUOTA, str(turn.get("sender_uid") or ""), THREAD_HISTORY_PER_HOUR, "tra lịch sử")
        if problem:
            return problem
    days = _bounded_int(args.get("days"), 7, 1, THREAD_HISTORY_MAX_DAYS)
    limit = _bounded_int(args.get("limit"), 20, 1, THREAD_HISTORY_MAX_LIMIT)
    query = str(args.get("query") or "").strip()[:100]
    sender = str(args.get("sender") or "").strip()[:60]
    since_ms = int(time.time() * 1000) - days * 86_400_000
    ack = await adapter.search_history(
        thread_id, query=query, sender=sender, since_ms=since_ms, limit=limit,
        metadata={"chat_type": "group" if turn.get("is_group") else "dm"},
    )
    if not ack or not ack.get("ok"):
        return _err((ack or {}).get("error", "không đọc được lịch sử Zalo"))
    lines: List[str] = []
    size = 0
    # Mới nhất được giữ khi chạm ngân sách chữ: đi ngược từ cuối rồi đảo lại.
    for msg in reversed((ack.get("result") or {}).get("messages") or []):
        line = _thread_history_line(msg)
        if size + len(line) + 1 > THREAD_HISTORY_CHAR_BUDGET:
            break
        lines.append(line)
        size += len(line) + 1
    lines.reverse()
    return _ok({
        "days": days,
        "query": query,
        "sender": sender,
        "count": len(lines),
        "text": "\n".join(lines) if lines else "",
        "huong_dan": ("Trả lời đúng theo các dòng trên, nêu ngày giờ. Không có dòng nào khớp thì nói là không thấy "
                      "trong lịch sử, đừng đoán." if lines else
                      "Không thấy tin nào khớp trong khoảng này. Nói rõ là không thấy; có thể thử từ khoá khác hoặc tăng `days`."),
    })


def _memory_scope_or_error(turn: Dict[str, Any]):
    """Phạm vi trí nhớ của lượt này (spec §19.5.2) — từ turn, không từ tham số. Cron không có cuộc trò chuyện để nhớ."""
    from . import memory_store

    if turn.get("cron_job_id"):
        return None, _err("việc hẹn giờ không ghi/xoá trí nhớ — chủ nhân dặn trực tiếp trong cuộc trò chuyện")
    scope = memory_store.scope_of_turn(turn)
    if not scope:
        return None, _err("không xác định được cuộc trò chuyện hiện tại")
    return scope, None


async def zalo_reply_style(args: Dict[str, Any], **_kw) -> str:
    """Chủ nhân dặn cách trả lời (xưng hô, độ dài, màu, tên tệp…): đổi CÀI ĐẶT, không ghi vào trí nhớ."""
    from . import reply_style

    changes = {k: v for k, v in (args or {}).items() if k in reply_style.DEFAULTS}
    if not changes:
        return _ok(reply_style.load())
    try:
        return _ok({"saved": reply_style.save(changes)})
    except reply_style.StyleError as exc:
        return _err(str(exc))
    except OSError as exc:
        return _err(f"không ghi được cài đặt: {exc}")


async def zalo_memory_remember(args: Dict[str, Any], **_kw) -> str:
    """Chủ nhân dặn "nhớ giúp…": ghi vào trí nhớ dài hạn của CHÍNH cuộc trò chuyện này."""
    from . import memory_store

    scope, err = _memory_scope_or_error(_turn())
    if err:
        return err
    try:
        uri = await asyncio.to_thread(memory_store.remember, scope, str(args.get("text") or ""))
    except (ValueError, memory_store.MemoryUnavailable) as exc:
        return _err(str(exc))
    return _ok({"da_nho": True, "uri": uri,
                "huong_dan": "Báo ngắn gọn là đã nhớ cho cuộc trò chuyện này (nhóm/người khác không thấy)."})


async def zalo_memory_forget(args: Dict[str, Any], **_kw) -> str:
    """Chủ nhân dặn "quên chuyện X": lần 1 gọi với `query` để xem mục khớp, lần 2 gọi với `uris` để xoá."""
    from . import memory_store

    scope, err = _memory_scope_or_error(_turn())
    if err:
        return err
    try:
        if args.get("uris"):
            uris = args.get("uris") if isinstance(args.get("uris"), list) else [args.get("uris")]
            gone = await asyncio.to_thread(memory_store.forget, scope, uris)
            return _ok({"da_quen": len(gone), "uris": gone})
        hits = await asyncio.to_thread(memory_store.find, scope, str(args.get("query") or ""))
    except (ValueError, memory_store.MemoryUnavailable) as exc:
        return _err(str(exc))
    return _ok({"ung_vien": hits, "huong_dan": (
        "Chọn đúng những mục nói về chuyện chủ nhân muốn quên rồi gọi lại zalo_memory_forget với `uris`. "
        "Không có mục nào khớp thì báo là trong trí nhớ của cuộc trò chuyện này không có chuyện đó."
        if hits else "Không thấy mục nào khớp trong trí nhớ của cuộc trò chuyện này.")})


async def zalo_list_groups(args: Dict[str, Any], **_kw) -> str:
    """Liệt kê nhóm kèm TÊN, không phải chỉ dãy ID.

    ``getAllGroups`` một mình chỉ trả về ``{groupId: version}`` — agent nhận
    được một nắm số và không nói nổi cho người dùng biết đó là nhóm nào. Phải
    hỏi thêm ``getGroupInfo`` mới ra tên, sĩ số và vai trò của bot trong nhóm.
    """
    listed = await _invoke("getAllGroups", [])
    payload = json.loads(listed)
    if not payload.get("success"):
        return listed

    grid = (payload.get("result") or {}).get("gridVerMap") or {}
    group_ids = list(grid.keys())
    if not group_ids:
        return _ok({"count": 0, "groups": []})

    detail = await _invoke("getGroupInfo", [group_ids])
    dpayload = json.loads(detail)
    if not dpayload.get("success"):
        # Vẫn còn hơn không: trả ID để agent có cái mà tra tiếp.
        return _ok({"count": len(group_ids), "groups": [{"id": g} for g in group_ids],
                    "note": "không lấy được tên nhóm"})

    info = (dpayload.get("result") or {}).get("gridInfoMap") or {}
    self_uid = str(_self_uid() or "")
    groups = []
    for gid in group_ids:
        d = info.get(gid) or {}
        deputies = [str(x) for x in (d.get("adminIds") or [])]
        groups.append({
            "id": gid,
            "name": d.get("name") or "",
            "members": d.get("totalMember"),
            "my_role": ("trưởng nhóm" if str(d.get("creatorId")) == self_uid
                        else "phó nhóm" if self_uid and self_uid in deputies
                        else "thành viên"),
        })
    return _ok({"count": len(groups), "groups": groups})


async def zalo_group_welcome(args: Dict[str, Any], **_kw) -> str:
    """Bật/tắt/sửa lời chào thành viên mới của một nhóm, hoặc xem cấu hình.

    Sidecar tự gom người mới theo đợt và gửi một tin tag tất cả — xem
    zalo-welcome.js. Ở đây chỉ chuyển cấu hình xuống.
    """
    adapter = _ACTIVE_ADAPTER
    if adapter is None:
        return _err("Zalo chưa kết nối")
    group_id = str(args.get("group_id") or "").strip()
    if not group_id:
        ack = await adapter.welcome_config("get")
    else:
        fields = {"enabled": "enabled", "message": "message", "group_name": "name",
                  "batch_size": "batchSize", "max_wait_minutes": "maxWaitMinutes"}
        patch = {dst: args[src] for src, dst in fields.items() if args.get(src) is not None}
        if not patch:
            return _err("cần ít nhất một thay đổi (enabled, message, batch_size, max_wait_minutes)")
        ack = await adapter.welcome_config("set", group_id, patch)
    if not ack or not ack.get("ok"):
        return _err((ack or {}).get("error", "sidecar không nhận cấu hình chào"))
    return _ok(ack.get("result"))


async def zalo_friend_group(args: Dict[str, Any], **_kw) -> str:
    """Kết bạn rồi tạo nhóm: lập, xem hoặc huỷ kế hoạch.

    Sidecar gửi lời mời, chờ người được mời đồng ý rồi tự tạo nhóm / thêm
    người và báo lại đúng cuộc trò chuyện đã ra lệnh — xem zalo-friends.js.
    """
    adapter = _ACTIVE_ADAPTER
    if adapter is None:
        return _err("Zalo chưa kết nối")
    action = str(args.get("action") or "list").lower()
    if action == "create":
        # Ghép tên với UID trước khi lọc phần tử rỗng, để tên không lệch sang người khác.
        ids = list(args.get("member_ids") or [])
        names = list(args.get("member_names") or [])
        pairs = [(str(m).strip(), str(names[i]) if i < len(names) else "")
                 for i, m in enumerate(ids) if str(m).strip()]
        if not pairs:
            return _err("cần `member_ids` — ít nhất một người để kết bạn")
        fields: Dict[str, Any] = {
            "memberIds": [uid for uid, _name in pairs],
            "memberNames": [name for _uid, name in pairs],
            "name": str(args.get("group_name") or "").strip(),
            "message": str(args.get("message") or "").strip(),
        }
    elif action == "cancel":
        plan_id = str(args.get("plan_id") or "").strip()
        if not plan_id:
            return _err("cần `plan_id` (xem bằng action=list)")
        fields = {"planId": plan_id}
    elif action == "list":
        fields = {"includeClosed": True} if args.get("include_closed") else {}
    else:
        return _err("action phải là create, list hoặc cancel")
    # Sidecar kiểm lại xác nhận cho action=create như với createGroup.
    ack = await adapter.friend_group(action, confirmed=bool(_CONFIRMED.get()), **fields)
    if not ack or not ack.get("ok"):
        return _err((ack or {}).get("error", "sidecar không nhận lệnh kết bạn rồi tạo nhóm"))
    return _ok(ack.get("result"))


async def zalo_group_members(args: Dict[str, Any], **_kw) -> str:
    # getGroupMembersInfo của zca-js nhận ID THÀNH VIÊN, không nhận ID nhóm —
    # truyền ID nhóm vào là luôn ra rỗng. Sidecar lo cả hai bước qua lệnh
    # group_members: hỏi getGroupInfo lấy danh sách ID rồi mới tra hồ sơ.
    thread_id, _kind, err = _scoped_thread(args)
    if err:
        return err
    adapter = _ACTIVE_ADAPTER
    if adapter is None:
        return _err("Zalo chưa kết nối")
    ack = await adapter.group_members(str(thread_id))
    if not ack or not ack.get("ok"):
        return _err((ack or {}).get("error", "không lấy được danh sách thành viên"))
    return _ok(ack.get("result"))


async def zalo_find_user(args: Dict[str, Any], **_kw) -> str:
    phone = (args.get("phone") or "").strip()
    username = (args.get("username") or "").strip()
    if phone:
        return await _invoke("findUser", [phone])
    if username:
        return await _invoke("findUserByUsername", [username])
    return _err("cần `phone` hoặc `username`")


async def zalo_user_info(args: Dict[str, Any], **_kw) -> str:
    uid = str(args.get("user_id") or "")
    if not uid:
        return _err("cần `user_id`")
    return await _invoke("getUserInfo", [uid])


async def zalo_list_friends(args: Dict[str, Any], **_kw) -> str:
    return await _invoke("getAllFriends", [])


async def zalo_send_friend_request(args: Dict[str, Any], **_kw) -> str:
    user_id = str(args.get("user_id") or "").strip()
    if not user_id:
        return _err("cần `user_id`")
    msg = str(args.get("msg") or "Xin chào, mình kết bạn nhé!").strip()
    # zca-js: sendFriendRequest(msg, userId) — lời nhắn đứng trước.
    return await _invoke("sendFriendRequest", [msg, user_id])


async def zalo_accept_friend_request(args: Dict[str, Any], **_kw) -> str:
    user_id = str(args.get("user_id") or "").strip()
    if not user_id:
        return _err("cần `user_id`")
    return await _invoke("acceptFriendRequest", [user_id])


# =====================================================================
#  Nhóm 3 — Tính năng riêng của Zalo
# =====================================================================

async def zalo_create_poll(args: Dict[str, Any], **_kw) -> str:
    question = (args.get("question") or "").strip()
    options = args.get("options") or []
    if not question or len(options) < 2:
        return _err("cần `question` và ít nhất 2 `options`")
    group_id, _kind, err = _scoped_thread(args, "group_id")
    if err:
        return err
    return await _invoke("createPoll", [{
        "question": question,
        "options": options,
        "allowMultiChoices": bool(args.get("multi_choice", False)),
        "allowAddNewOption": bool(args.get("allow_add_option", False)),
        "hideVotePreview": bool(args.get("hide_preview", False)),
        "isAnonymous": bool(args.get("anonymous", False)),
    }, group_id])


async def zalo_poll_detail(args: Dict[str, Any], **_kw) -> str:
    poll_id = str(args.get("poll_id") or "")
    if not poll_id:
        return _err("cần `poll_id`")
    return await _invoke("getPollDetail", [poll_id])


async def zalo_lock_poll(args: Dict[str, Any], **_kw) -> str:
    poll_id = str(args.get("poll_id") or "")
    if not poll_id:
        return _err("cần `poll_id`")
    return await _invoke("lockPoll", [poll_id])


def _poll_ids(values: Any) -> Optional[List[int]]:
    """Mã bình chọn/phương án của Zalo là số nhỏ (dưới 2^53); nhận chuỗi hoặc số."""
    if not isinstance(values, list):
        return None
    ids = []
    for value in values:
        text = str(value).strip()
        if not text.isdigit():
            return None
        ids.append(int(text))
    return ids


async def zalo_vote_poll(args: Dict[str, Any], **_kw) -> str:
    poll_id = str(args.get("poll_id") or "").strip()
    if not poll_id.isdigit():
        return _err("cần `poll_id` dạng số (lấy từ zalo_poll_detail)")
    option_ids = _poll_ids(args.get("option_ids"))
    if option_ids is None:
        return _err("`option_ids` phải là danh sách mã phương án (lấy từ zalo_poll_detail); danh sách rỗng là rút phiếu")
    return await _invoke("votePoll", [int(poll_id), option_ids])


async def zalo_add_poll_options(args: Dict[str, Any], **_kw) -> str:
    poll_id = str(args.get("poll_id") or "").strip()
    if not poll_id.isdigit():
        return _err("cần `poll_id` dạng số (lấy từ zalo_poll_detail)")
    options = [str(option).strip() for option in (args.get("options") or []) if str(option).strip()]
    if not options:
        return _err("cần ít nhất một phương án mới trong `options`")
    keep = _poll_ids(args.get("keep_voted_option_ids") or [])
    if keep is None:
        return _err("`keep_voted_option_ids` phải là danh sách mã phương án")
    vote_new = bool(args.get("vote", False))
    return await _invoke("addPollOptions", [{
        "pollId": int(poll_id),
        "options": [{"voted": vote_new, "content": option} for option in options],
        "votedOptionIds": keep,
    }])


async def zalo_create_note(args: Dict[str, Any], **_kw) -> str:
    title = (args.get("title") or "").strip()
    if not title:
        return _err("cần `title`")
    group_id, _kind, err = _scoped_thread(args, "group_id")
    if err:
        return err
    return await _invoke("createNote", [{
        "title": title,
        "pinAct": bool(args.get("pin", True)),
    }, group_id])


async def zalo_create_reminder(args: Dict[str, Any], **_kw) -> str:
    title = (args.get("title") or "").strip()
    start_time = args.get("start_time")
    if not title or start_time is None:
        return _err("cần `title` và `start_time` (mốc thời gian tính bằng mili giây)")
    thread_id, kind, err = _scoped_thread(args)
    if err:
        return err
    return await _invoke("createReminder", [{
        "title": title,
        "startTime": int(start_time),
        "repeat": int(args.get("repeat", 0)),
    }, thread_id, _thread_type(kind)])


async def zalo_list_reminders(args: Dict[str, Any], **_kw) -> str:
    thread_id, kind, err = _scoped_thread(args)
    if err:
        return err
    return await _invoke("getListReminder", [
        {"page": 1, "count": 20}, thread_id, _thread_type(kind),
    ])


async def zalo_remove_reminder(args: Dict[str, Any], **_kw) -> str:
    """Xoá một lời nhắc.

    Có mặt vì trước đây tạo được mà không xoá được: đặt nhầm giờ là lời nhắc
    nằm lại trong nhóm vĩnh viễn, phải nhờ người vào Zalo xoá tay.
    """
    reminder_id = str(args.get("reminder_id") or "")
    if not reminder_id:
        return _err("cần `reminder_id` (lấy từ zalo_list_reminders)")
    thread_id, kind, err = _scoped_thread(args)
    if err:
        return err
    return await _invoke("removeReminder", [reminder_id, thread_id, _thread_type(kind)])


async def zalo_pin_conversation(args: Dict[str, Any], **_kw) -> str:
    thread_id = str(args.get("thread_id") or "")
    if not thread_id:
        return _err("cần `thread_id`")
    return await _invoke("setPinnedConversations", [
        bool(args.get("pinned", True)), thread_id, _thread_type(args.get("thread_kind")),
    ])


async def zalo_mute(args: Dict[str, Any], **_kw) -> str:
    thread_id = str(args.get("thread_id") or "")
    if not thread_id:
        return _err("cần `thread_id`")
    duration = int(args.get("duration", -1))  # -1 = vĩnh viễn
    action = 1 if bool(args.get("muted", True)) else 3
    return await _invoke("setMute", [
        {"duration": duration, "action": action},
        thread_id, _thread_type(args.get("thread_kind")),
    ])


# =====================================================================
#  Nhóm 4 — Sửa sai & quản trị nhóm
# =====================================================================

def _with_quoted_undo_target(args: Dict[str, Any]) -> Dict[str, Any]:
    """Use the replied-to bot message when undo IDs were omitted."""
    resolved = dict(args)
    if resolved.get("msg_id") or resolved.get("cli_msg_id"):
        return resolved
    turn = _turn()
    if turn.get("reply_is_own") and turn.get("reply_msg_id") and turn.get("reply_cli_msg_id"):
        resolved["msg_id"] = str(turn["reply_msg_id"])
        resolved["cli_msg_id"] = str(turn["reply_cli_msg_id"])
    return resolved


async def zalo_undo(args: Dict[str, Any], **_kw) -> str:
    args = _with_quoted_undo_target(args)
    thread_id, kind, err = _scoped_thread(args)
    if err:
        return err
    msg_id = str(args.get("msg_id") or "") or None
    cli_msg_id = str(args.get("cli_msg_id") or "") or None
    adapter = _ACTIVE_ADAPTER
    if adapter is None:
        return _err("Zalo chưa kết nối")
    ack = await adapter.undo_message(
        str(thread_id), msg_id, cli_msg_id, metadata={"chat_type": kind},
        confirmed=_CONFIRMED.get(),
    )
    if not ack or not ack.get("ok"):
        return _err((ack or {}).get("error", "không thu hồi được tin Zalo"))
    return _ok(ack.get("result"))


async def zalo_rename_group(args: Dict[str, Any], **_kw) -> str:
    name = (args.get("name") or "").strip()
    group_id = str(args.get("group_id") or "")
    if not name or not group_id:
        return _err("cần `name` và `group_id`")
    return await _invoke("changeGroupName", [name, group_id])


async def zalo_group_member_change(args: Dict[str, Any], **_kw) -> str:
    group_id = str(args.get("group_id") or "")
    uids = args.get("user_ids") or []
    action = str(args.get("action") or "").lower()
    if not group_id or not uids or action not in {"add", "remove"}:
        return _err("cần `group_id`, `user_ids`, và `action` là 'add' hoặc 'remove'")
    method = "addUserToGroup" if action == "add" else "removeUserFromGroup"
    return await _invoke(method, [[str(uid) for uid in uids], group_id])


async def zalo_group_deputy(args: Dict[str, Any], **_kw) -> str:
    group_id = str(args.get("group_id") or "")
    uid = str(args.get("user_id") or "")
    action = str(args.get("action") or "").lower()
    if not group_id or not uid or action not in {"add", "remove"}:
        return _err("cần `group_id`, `user_id`, và `action` là 'add' hoặc 'remove'")
    method = "addGroupDeputy" if action == "add" else "removeGroupDeputy"
    return await _invoke(method, [uid, group_id])


async def zalo_pending_members(args: Dict[str, Any], **_kw) -> str:
    group_id = str(args.get("group_id") or "")
    if not group_id:
        return _err("cần `group_id`")
    return await _invoke("getPendingGroupMembers", [group_id])


async def zalo_review_member(args: Dict[str, Any], **_kw) -> str:
    group_id = str(args.get("group_id") or "")
    uids = args.get("user_ids") or []
    approve = bool(args.get("approve", True))
    if not group_id or not uids:
        return _err("cần `group_id` và `user_ids`")
    return await _invoke("reviewPendingMemberRequest", [{
        "members": [str(uid) for uid in uids],
        "isApprove": approve,
    }, group_id])


# =====================================================================
#  Nhóm 5 — Lập nhóm & lời mời
# =====================================================================

async def zalo_create_group(args: Dict[str, Any], **_kw) -> str:
    members = args.get("member_ids") or []
    if not members:
        return _err("cần `member_ids` — Zalo không cho lập nhóm rỗng")
    options: Dict[str, Any] = {"members": [str(m) for m in members]}
    if args.get("name"):
        options["name"] = str(args["name"])
    if args.get("avatar_path"):
        options["avatarSource"] = str(args["avatar_path"])
    return await _invoke("createGroup", [options])


async def zalo_invite_to_groups(args: Dict[str, Any], **_kw) -> str:
    user_id = str(args.get("user_id") or "")
    group_ids = args.get("group_ids") or []
    if not user_id or not group_ids:
        return _err("cần `user_id` và `group_ids`")
    return await _invoke("inviteUserToGroups", [user_id, [str(g) for g in group_ids]])


async def zalo_group_link(args: Dict[str, Any], **_kw) -> str:
    group_id = str(args.get("group_id") or "")
    if not group_id:
        return _err("cần `group_id`")
    action = str(args.get("action") or "detail").lower()
    if action == "enable":
        return await _invoke("enableGroupLink", [group_id])
    if action == "disable":
        return await _invoke("disableGroupLink", [group_id])
    return await _invoke("getGroupLinkDetail", [group_id])


async def zalo_join_group_link(args: Dict[str, Any], **_kw) -> str:
    link = (args.get("link") or "").strip()
    if not link:
        return _err("cần `link`")
    return await _invoke("joinGroupLink", [link])


# =====================================================================
#  Nhóm 6 — Hồ sơ của chính tài khoản bot
# =====================================================================

async def zalo_set_bio(args: Dict[str, Any], **_kw) -> str:
    bio = args.get("bio")
    if bio is None:
        return _err("cần `bio` (chuỗi rỗng để xoá dòng mô tả)")
    return await _invoke("updateProfileBio", [str(bio)])


async def zalo_set_active_status(args: Dict[str, Any], **_kw) -> str:
    if "active" not in args:
        return _err("cần `active` (true để hiện đang hoạt động, false để ẩn)")
    return await _invoke("updateActiveStatus", [bool(args["active"])])


# =====================================================================
#  Nhóm 7 — Kho tài liệu tư vấn (chỉ đọc, giới hạn trong một thư mục)
# =====================================================================
#
# Người trong nhóm không có `read_file` — nếu có thì họ đọc được mọi tệp
# trên máy chủ, kể cả tệp chứa khoá API. Nhưng để tư vấn sản phẩm thì bot
# vẫn cần đọc tài liệu. Hai công cụ dưới đây mở đúng một cánh cửa hẹp:
# chỉ đọc, chỉ trong thư mục ZALO_KB_DIR, và mọi đường dẫn đều được ép về
# đường dẫn thật rồi kiểm tra lại — nên `../` hay symlink không thoát ra
# ngoài được.

KB_MAX_BYTES = 60_000
KB_TEXT_SUFFIXES = {
    ".md", ".txt", ".html", ".htm", ".json", ".yaml", ".yml",
    ".csv", ".xml", ".rst", ".ini", ".toml",
}

# Tài liệu nhị phân đọc được nhờ bộ trích văn bản sẵn có của Hermes
# (``tools/read_extract.py``). Kho tài liệu thực tế của một đơn vị phần lớn là
# .docx và .pdf chứ không phải Markdown, nên chỉ nhận tệp văn bản thuần thì
# danh sách sẽ rỗng.
KB_DOC_SUFFIXES = {".docx", ".xlsx", ".pdf", ".doc", ".pptx", ".ppt", ".rtf", ".epub", ".odt"}

# Lối tắt tới tài liệu trên mây. Khi kho tài liệu là một ổ Google Drive gắn qua
# RaiDrive/Drive for desktop, mọi tài liệu Google gốc (Docs, Sheets, Slides)
# KHÔNG hiện thành .docx mà thành một tệp `.gdoc.URL` bé xíu chứa đúng một
# dòng địa chỉ. Bỏ qua nhóm này là mù với một phần lớn kho: đo trên kho Đoàn
# thật thì 553/5388 tệp (10%) thuộc dạng đó, trong đó có đúng tài liệu người
# dùng đang hỏi.
KB_LINK_SUFFIXES = {".url"}


def _kb_readable(suffix: str) -> bool:
    low = suffix.lower()
    return low in KB_TEXT_SUFFIXES or low in KB_DOC_SUFFIXES or low in KB_LINK_SUFFIXES


def _kb_extract(path) -> Optional[str]:
    """Rút văn bản từ tài liệu nhị phân. None nghĩa là không rút được."""
    try:
        from tools.read_extract import extract_document_text, is_extractable_document
    except Exception:
        return None
    try:
        if not is_extractable_document(str(path)):
            return None
        return extract_document_text(str(path))
    except Exception as exc:
        logger.debug("[zalo] không rút được văn bản từ %s: %s", path, exc)
        return None

# Thư mục không bao giờ đọc tới, kể cả khi nằm trong kho.
#
# Kho tài liệu thường trỏ vào một thư mục dự án chứ không phải một thư mục
# tài liệu thuần — và thư mục dự án thì lẫn cả mã nguồn, bản sao lưu đơn
# hàng, biến môi trường. Chặn theo tên thư mục là lớp phòng thủ thứ hai, sau
# lớp ép đường dẫn về trong kho.
KB_SKIP_DIRS = {
    "node_modules", "dist", "build", "out", "coverage", "__pycache__",
    "venv", ".venv", "vendor", "tmp", "temp", "cache",
}

# Tên gợi ý dữ liệu riêng tư — bỏ qua dù nằm ở đâu.
KB_SKIP_PATTERNS = (
    "backup", "order", "customer", "khach", "don-hang", "donhang",
    "secret", "credential", "password", "token", "private",
)


def _kb_public_dirs() -> tuple:
    """Các thư mục cấp 1 được phép lộ ra trong kho. Rỗng nghĩa là cả kho.

    Kho tài liệu thật thường là cả một ổ đĩa nhiều năm dồn lại, trong khi người
    trong nhóm chỉ cần vài thư mục của năm hiện hành. Khai báo
    ``ZALO_KB_PUBLIC_DIRS`` (các tên cách nhau bằng dấu phẩy) để đóng phần còn
    lại. Giới hạn áp cho mọi người, kể cả chủ nhân: danh sách tệp được đệm dùng
    chung giữa các lượt, nên phạm vi phụ thuộc người hỏi sẽ khiến lượt này thấy
    kết quả đệm của lượt kia. Chủ nhân cần đọc chỗ khác thì đã có read_file.
    """
    try:
        from agent.secret_scope import UnscopedSecretError, get_secret
        try:
            raw = get_secret("ZALO_KB_PUBLIC_DIRS", "")
        except UnscopedSecretError:
            raw = os.getenv("ZALO_KB_PUBLIC_DIRS", "")
    except Exception:
        raw = os.getenv("ZALO_KB_PUBLIC_DIRS", "")
    return tuple(part.strip().strip("/").lower() for part in str(raw or "").split(",") if part.strip())


def _kb_allowed(rel_posix: str) -> bool:
    """Đường dẫn tương đối này có nên lộ ra cho người hỏi không."""
    parts = rel_posix.split("/")
    scope = _kb_public_dirs()
    if scope and (len(parts) < 2 or parts[0].strip().lower() not in scope):
        return False       # ngoài phạm vi khai báo, kể cả tệp nằm ngay gốc kho
    for part in parts:
        if part.startswith("."):          # .git, .env, .backup, .astro…
            return False
        if part.lower() in KB_SKIP_DIRS:
            return False
    low = rel_posix.lower()
    return not any(p in low for p in KB_SKIP_PATTERNS)


def _kb_root() -> Optional["Path"]:
    from pathlib import Path
    raw = (_kb_dir_setting() or "").strip()
    if not raw:
        return None
    try:
        root = Path(raw).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    return root if root.is_dir() else None


def _kb_dir_setting() -> str:
    import os
    from agent.secret_scope import UnscopedSecretError, get_secret
    try:
        val = get_secret("ZALO_KB_DIR", "")
    except UnscopedSecretError:
        val = os.getenv("ZALO_KB_DIR", "")
    return val or ""


def _kb_resolve(root, relative: str):
    """Ép một đường dẫn tương đối về trong ``root``. Trả None nếu thoát ra ngoài."""
    from pathlib import Path
    try:
        target = (root / str(relative).lstrip("/\\")).resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    try:
        target.relative_to(root)
    except ValueError:
        return None       # `../` hoặc symlink trỏ ra ngoài
    return target


# Đệm danh sách tệp của kho tài liệu.
#
# Kho thường nằm trên ổ mạng (RaiDrive gắn Google Drive chẳng hạn). Khi ổ đang
# nguội, duyệt hết cây thư mục có thể mất tới bốn phút — đo được 239,98s trên
# một kho 1180 thư mục, trong khi lần duyệt ngay sau đó chỉ 0,7s. Người trong
# nhóm hỏi một câu rồi ngồi chờ bốn phút thì coi như bot hỏng.
#
# Danh sách tệp thay đổi hiếm, nên đệm lại là đủ. Đệm theo cây đầy đủ rồi lọc
# trong bộ nhớ, để câu hỏi với từ khoá khác cũng không phải duyệt lại.
_KB_CACHE: Dict[str, Any] = {"root": None, "at": 0.0, "files": None, "skipped": 0}
_KB_CACHE_TTL = 300.0


def _kb_listing(root, query: str):
    """Danh sách tệp trong kho, lấy từ đệm nếu còn hạn."""
    import time as _t
    now = _t.monotonic()
    fresh = (
        _KB_CACHE["files"] is not None
        and _KB_CACHE["root"] == str(root)
        and now - _KB_CACHE["at"] < _KB_CACHE_TTL
    )
    if not fresh:
        t0 = _t.monotonic()
        # Duyệt KHÔNG lọc và nới hạn mức: đệm phải chứa cả cây thì lọc theo từ
        # khoá trong bộ nhớ mới không sót tệp nằm sâu. Hạn mức 200 của lần
        # duyệt thường là để giới hạn thứ trả về cho agent, không phải để giới
        # hạn thứ ta biết.
        files, skipped = _kb_walk(root, "", limit=20000)
        took = _t.monotonic() - t0
        _KB_CACHE.update(root=str(root), at=now, files=files, skipped=skipped)
        if took > 5:
            logger.warning("[zalo] duyệt kho tài liệu mất %.1fs — ổ mạng đang nguội", took)

    files = _KB_CACHE["files"]
    if query:
        files = [f for f in files if query in str(f.get("path", "")).lower()]
    return files, _KB_CACHE["skipped"], fresh


async def zalo_kb_list(args: Dict[str, Any], **_kw) -> str:
    root = _kb_root()
    if root is None:
        return _err("chưa cấu hình kho tài liệu (ZALO_KB_DIR)")

    query = (args.get("query") or "").strip().lower()
    files, skipped, _ = _kb_listing(root, query)

    # Đệm giữ cả cây, nhưng chỉ đưa cho agent một nắm vừa phải — nhồi vài nghìn
    # đường dẫn vào ngữ cảnh vừa tốn token vừa làm nó khó chọn.
    total = len(files)
    shown = files[:200]
    payload = {"root": root.name or str(root), "files": shown, "count": total}
    if total > len(shown):
        # Kho lớn thì 200 tệp đầu thường rơi hết vào một thư mục, khiến agent
        # tưởng kho chỉ có chừng đó. Kèm bảng thư mục cấp 1 để nó biết còn
        # những nhánh nào mà thu hẹp `query` cho đúng.
        folders: Dict[str, int] = {}
        for item in files:
            head = str(item.get("path", "")).split("/")[0]
            if head:
                folders[head] = folders.get(head, 0) + 1
        payload["folders"] = dict(sorted(folders.items(), key=lambda kv: -kv[1])[:30])
        payload["note"] = (f"chỉ hiện {len(shown)}/{total} tệp — xem `folders` rồi thu hẹp bằng "
                           f"tham số `query` (tên thư mục hoặc tên tệp) để tìm đúng thứ cần")
    if skipped:
        payload["skipped"] = skipped
    return _ok(payload)


def _kb_walk(root, query: str, limit: int = 200):
    """Duyệt kho tài liệu, bỏ qua những nhánh không đọc được.

    Dùng ``os.walk`` chứ không phải ``Path.rglob``: kho tài liệu hay nằm trên
    ổ mạng (RaiDrive, OneDrive, SMB) nơi một đường dẫn quá dài hoặc một thư
    mục mất kết nối làm cả phép duyệt ném lỗi giữa chừng. Ở đây một nhánh
    hỏng chỉ bị bỏ qua, phần còn lại vẫn liệt kê được.
    """
    import os

    files = []
    skipped = 0
    root_str = str(root)

    def on_error(_exc):
        nonlocal skipped
        skipped += 1

    for dirpath, dirnames, filenames in os.walk(root_str, onerror=on_error):
        # Cắt sớm những thư mục không bao giờ đọc tới — đỡ phải lội vào
        # node_modules hay .git trên ổ mạng chậm.
        dirnames[:] = [
            d for d in dirnames
            if not d.startswith(".") and d.lower() not in KB_SKIP_DIRS
        ]
        for name in sorted(filenames):
            suffix = os.path.splitext(name)[1]
            if not _kb_readable(suffix):
                continue
            full = os.path.join(dirpath, name)
            try:
                rel = os.path.relpath(full, root_str).replace("\\", "/")
                if not _kb_allowed(rel):
                    continue
                if query and query not in rel.lower():
                    continue
                files.append({"path": rel, "size": os.path.getsize(full)})
            except OSError:
                skipped += 1
                continue
            if len(files) >= limit:
                return files, skipped
    return files, skipped


async def _kb_read_shortcut(target, rel_out: str) -> str:
    """Đọc một lối tắt `.url` bằng cách tải chính tài liệu nó trỏ tới."""
    try:
        raw = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return _err(f"không đọc được lối tắt: {exc}")

    url = ""
    for line in raw.splitlines():
        if line.strip().lower().startswith("url="):
            url = line.split("=", 1)[1].strip()
            break
    if not url:
        return _err(f"lối tắt '{rel_out}' không chứa địa chỉ nào")

    # Bắt buộc kiểm tra: một tệp .url là nội dung do người khác đặt vào kho.
    # Nếu ai đó thả vào một lối tắt trỏ tới http://127.0.0.1/... thì đây thành
    # đường vòng đọc dữ liệu nội bộ, đi qua lưng cả bộ chặn của zalo_web_read.
    if not _is_public_url(url):
        return _err(f"lối tắt '{rel_out}' trỏ tới địa chỉ không công khai — bỏ qua")

    fetched = await _core("web_extract", {"urls": [_google_export_url(url)]}, attempts=2)
    try:
        results = (json.loads(fetched).get("results") or [{}])[0]
    except (ValueError, TypeError, AttributeError):
        results = {}
    content = (results.get("content") or "").strip()
    if not content:
        return _err(
            f"'{rel_out}' là lối tắt tới {url} nhưng chưa tải được nội dung"
            f"{' — ' + str(results.get('error'))[:80] if results.get('error') else ''}"
        )
    truncated = len(content) > KB_MAX_BYTES
    return _ok({"path": rel_out, "source_url": url, "kind": "lối tắt tài liệu Google",
                "content": content[:KB_MAX_BYTES], "truncated": truncated})


async def zalo_kb_read(args: Dict[str, Any], **_kw) -> str:
    root = _kb_root()
    if root is None:
        return _err("chưa cấu hình kho tài liệu (ZALO_KB_DIR)")

    rel = (args.get("path") or "").strip()
    if not rel:
        return _err("cần `path` — dùng zalo_kb_list để xem có những tệp nào")

    target = _kb_resolve(root, rel)
    if target is None or not target.is_file():
        return _err(f"không có tệp '{rel}' trong kho tài liệu")

    # Áp cùng bộ lọc như khi liệt kê. Nếu chỉ lọc lúc liệt kê thì đoán đúng
    # tên tệp là đọc được — che khỏi danh sách không phải là chặn.
    if not _kb_allowed(target.relative_to(root).as_posix()):
        return _err(f"không có tệp '{rel}' trong kho tài liệu")

    if not _kb_readable(target.suffix):
        return _err(f"không đọc được định dạng '{target.suffix}'")

    rel_out = target.relative_to(root).as_posix()

    # Lối tắt tới tài liệu trên mây: đọc địa chỉ trong tệp rồi tải nội dung
    # thật về. Không làm vậy thì agent chỉ nhận được ba dòng INI vô nghĩa.
    if target.suffix.lower() in KB_LINK_SUFFIXES:
        return await _kb_read_shortcut(target, rel_out)

    # Tài liệu nhị phân (.docx, .pdf…) đi qua bộ trích văn bản của Hermes.
    if target.suffix.lower() in KB_DOC_SUFFIXES:
        text = _kb_extract(target)
        if text is None:
            return _err(
                f"không rút được nội dung từ '{rel_out}'. Tệp có thể là bản quét "
                "ảnh không có lớp chữ, hoặc thiếu thư viện đọc định dạng này."
            )
        truncated = len(text) > KB_MAX_BYTES
        return _ok({"path": rel_out, "content": text[:KB_MAX_BYTES], "truncated": truncated})

    try:
        raw = target.read_bytes()[: KB_MAX_BYTES + 1]
    except OSError as exc:
        return _err(f"không đọc được tệp: {exc}")

    truncated = len(raw) > KB_MAX_BYTES
    return _ok({
        "path": rel_out,
        "content": raw[:KB_MAX_BYTES].decode("utf-8", errors="replace"),
        "truncated": truncated,
    })


# =====================================================================
#  Nhóm 8 — Tra cứu Internet (bản bọc, chỉ đọc ra ngoài)
# =====================================================================
#
# Người trong nhóm không được cấp thẳng ``web_search``/``web_extract`` của
# Hermes. Lý do không phải vì hai công cụ đó nguy hiểm, mà vì mọi toolset sẵn
# có chứa chúng (``debugging``, ``coding``) đều kèm luôn ``terminal`` và
# ``read_file`` — cấp một cái là cấp cả cụm.
#
# Bọc lại còn được thêm một việc quan trọng: chặn tra cứu quay ngược vào máy
# chủ. ``web_extract`` nhận URL tuỳ ý, nên nếu để nguyên thì một địa chỉ như
# ``http://127.0.0.1:20128/v1/models`` hay ``file:///…/.env`` là đủ để đọc
# nội bộ qua đường Internet.

_BLOCKED_HOST_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa")


def _google_export_url(raw: str) -> str:
    """Đổi link Google Docs/Sheets/Slides sang đường xuất bản văn bản.

    Link `/edit` của Google trả về khung ứng dụng JavaScript chứ không phải nội
    dung — bộ đọc trang web nhận về một trang trống kèm nút đăng nhập, và rất
    dễ kết luận nhầm là "tài liệu không được chia sẻ". Thực ra tài liệu công
    khai vẫn đọc được bình thường qua đường `/export`.

    Chỉ đổi đường dẫn, không đổi quyền: tài liệu riêng tư vẫn trả về trang đăng
    nhập như trước.
    """
    import re
    from urllib.parse import urlparse

    try:
        u = urlparse(str(raw).strip())
    except ValueError:
        return raw
    if (u.hostname or "").lower() not in ("docs.google.com", "drive.google.com"):
        return raw

    m = re.search(r"/(document|spreadsheets|presentation|file)/d/([A-Za-z0-9_-]+)", u.path)
    if not m:
        return raw
    kind, doc_id = m.group(1), m.group(2)

    if kind == "document":
        return f"https://docs.google.com/document/d/{doc_id}/export?format=txt"
    if kind == "spreadsheets":
        return f"https://docs.google.com/spreadsheets/d/{doc_id}/export?format=csv"
    if kind == "presentation":
        return f"https://docs.google.com/presentation/d/{doc_id}/export/txt"
    return f"https://drive.google.com/uc?export=download&id={doc_id}"


def _is_public_url(raw: str) -> bool:
    """Chỉ cho phép http/https trỏ ra địa chỉ công cộng."""
    import ipaddress
    from urllib.parse import urlparse

    try:
        u = urlparse(str(raw).strip())
    except ValueError:
        return False

    if u.scheme not in ("http", "https"):
        return False                      # chặn file://, ftp://, gopher://…

    host = (u.hostname or "").strip().lower()
    if not host:
        return False
    if host == "localhost" or host.endswith(_BLOCKED_HOST_SUFFIXES):
        return False

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return True                       # tên miền — để tầng mạng lo tiếp
    return not (
        ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_reserved or ip.is_multicast or ip.is_unspecified
    )


async def _core(tool_name: str, args: Dict[str, Any], *, attempts: int = 1) -> str:
    """Gọi lại một công cụ lõi của Hermes qua registry.

    ``attempts`` > 1 dành cho công cụ web. Chưa cấu hình khoá backend thì Hermes
    xoay vòng qua các dịch vụ không khoá (Firecrawl, Keenable, Exa) và mỗi cái
    hỏng vào lúc khác nhau — đo được 3/6 lần thất bại trên cùng một URL.

    Có khoá rồi thì tỉ lệ hỏng gần như biến mất (đo 4/4 tìm kiếm, 5/6 đọc trang
    — lần trượt duy nhất là do trang đích không cho thu thập chứ không phải do
    backend). Nên giữ số lần thử ở mức thấp: một trang thật sự không đọc được
    thì thử lại chỉ tổ bắt người trong nhóm chờ thêm mà kết quả vẫn thế.
    """
    from tools.registry import registry

    last = ""
    for i in range(max(1, attempts)):
        try:
            result = registry.dispatch(tool_name, args)
            if hasattr(result, "__await__"):
                result = await result
            text = (result if isinstance(result, str)
                    else json.dumps(result, ensure_ascii=False, default=str))
        except Exception as exc:
            last = _err(f"{tool_name} lỗi: {exc}")
            continue

        if not _core_result_empty(text):
            return text
        last = text
        if i + 1 < attempts:
            await asyncio.sleep(0.6)
    return last


def _core_result_empty(text: str) -> bool:
    """Kết quả có thật sự rỗng không — để biết còn đáng thử lại nữa hay thôi."""
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return False
    if isinstance(data, dict):
        if data.get("success") is False:
            return True
        results = data.get("results")
        if isinstance(results, list) and results:
            return all(not (r or {}).get("content") for r in results if isinstance(r, dict))
    return False


async def zalo_web_search(args: Dict[str, Any], **_kw) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return _err("cần `query`")
    limit = max(1, min(int(args.get("limit", 5) or 5), 10))
    return await _core("web_search", {"query": query, "limit": limit}, attempts=2)


async def zalo_web_read(args: Dict[str, Any], **_kw) -> str:
    raw = args.get("urls") or ([args["url"]] if args.get("url") else [])
    if isinstance(raw, str):
        raw = [raw]
    urls = [str(u).strip() for u in raw if str(u).strip()]
    if not urls:
        return _err("cần `url` hoặc `urls`")

    blocked = [u for u in urls if not _is_public_url(u)]
    if blocked:
        return _err(
            "chỉ đọc được địa chỉ web công cộng (http/https), không đọc địa chỉ "
            f"nội bộ: {', '.join(blocked[:3])}"
        )
    from . import media

    urls = urls[:5]
    # Tài liệu Google tự tải thẳng: web_extract trả "Content was inaccessible"
    # cho đường /export dù tài liệu công khai (đo trên sheet thật của nhóm).
    # Đổi sang /export sau khi kiểm tra an toàn — phép kiểm nhìn đúng địa chỉ gốc.
    # Chỉ Docs/Sheets/Slides: tệp Drive (/file/d/, PDF, DOCX…) vẫn đi đường cũ.
    google = [u for u in urls if _google_export_url(u).startswith("https://docs.google.com/")]
    others = [u for u in urls if u not in google]
    pages: List[Dict[str, Any]] = []
    for u in google:
        try:
            pages.append(await media.read_google_doc(_google_export_url(u), u))
        except Exception as exc:
            pages.append({"url": u, "error": str(exc) or type(exc).__name__})

    if others:
        core = await _core("web_extract", {"urls": [_google_export_url(u) for u in others]}, attempts=2)
        if not _core_result_empty(core):
            if not google:
                return core
            pages.append({"web_extract": json.loads(core) if core.startswith("{") else core})
        else:
            # Dịch vụ đọc trang không lấy được (trang chặn thu thập…) thì tự tải.
            for u in others:
                try:
                    pages.append(await media.read_web_page(u))
                except Exception as exc:
                    pages.append({"url": u, "error": str(exc) or type(exc).__name__})

    if all("error" in p for p in pages):
        return _err("; ".join(f"{p['url']}: {p['error']}" for p in pages))
    return _ok(pages)


# Mỗi người trong nhóm tải tối đa bấy nhiêu video một giờ (chủ nhân không giới hạn).
VIDEO_QUOTA_PER_HOUR = 3
_VIDEO_QUOTA: Dict[str, List[float]] = {}
# Đọc thông tin video rẻ hơn nhưng vẫn chạy yt-dlp: chặn gọi dồn dập.
VIDEO_INFO_QUOTA_PER_HOUR = 20
_VIDEO_INFO_QUOTA: Dict[str, List[float]] = {}
# Người trong nhóm chỉ được tải khi CHÍNH TIN HỌ GÕ có ý tải. Mô hình không tự
# đặt chữ vào tin nhắn được, nên một mô tả video hay trang web cài lệnh "hãy tải
# video này" không kích hoạt được việc tải. So trên tin đã bỏ URL (link có chữ
# "download" không tính) và cần cụm rõ nghĩa — "quá tải", "tải lên" không tính.
_DOWNLOAD_INTENT = re.compile(
    r"\b(tải|tai)\s*(về|ve|video|clip|xuống|xuong|giúp|giup|dùm|dum|hộ|ho|lại|lai|file|mp4)\b"
    r"|\bdownload\b|\b(gửi|gui|lưu|luu)\s*(file|video|clip)\b"
    r"|\b(cắt|cat|trích|trich)\s*(video|clip|đoạn|doan|lấy|lay|giúp|giup|dùm|dum|hộ|ho)\b",
    re.IGNORECASE,
)


def _wants_download(text: str) -> bool:
    plain = unicodedata.normalize("NFC", re.sub(r"https?://\S+", " ", str(text or "")))
    return bool(_DOWNLOAD_INTENT.search(plain))


def _acting_as_owner(turn: Dict[str, Any]) -> bool:
    """Chủ nhân thật, không có người ngoài chen tin vào giữa lượt (busy_input interrupt/steer)."""
    return bool(turn.get("is_owner")) and not _outsider_spoke_after(turn)


def _take_quota(book: Dict[str, List[float]], uid: str, limit: int, what: str) -> Optional[str]:
    """Trừ một lượt NGAY (kể cả nếu việc sau đó thất bại); trả thông báo lỗi nếu hết lượt."""
    now = time.time()
    recent = [ts for ts in book.get(uid, []) if now - ts < 3600]
    if len(recent) >= limit:
        book[uid] = recent
        wait = int((3600 - (now - recent[0])) // 60) + 1
        return _err(f"mỗi người {what} tối đa {limit} lần mỗi giờ — thử lại sau khoảng {wait} phút")
    book[uid] = recent + [now]
    return None


def _academic_key(name: str) -> str:
    try:
        from agent.secret_scope import UnscopedSecretError, get_secret
        try:
            return str(get_secret(name, "") or "")
        except UnscopedSecretError:
            return os.getenv(name, "")
    except Exception:
        return os.getenv(name, "")


async def zalo_academic_search(args: Dict[str, Any], **_kw) -> str:
    """Tìm bài báo khoa học, tìm PDF mở, đọc toàn văn PMC, tra tạp chí DOAJ, tạo trích dẫn. Chỉ đọc."""
    from . import academic

    action = str(args.get("action") or "search")
    core_key, openalex_key = _academic_key("CORE_API_KEY"), _academic_key("OPENALEX_API_KEY")
    try:
        if action == "cite":
            return _ok({"citation": await asyncio.to_thread(
                academic.cite, args.get("doi") or "", args.get("style") or "apa")})
        if action == "find_pdf":
            return _ok(await asyncio.to_thread(academic.find_pdf, args.get("doi") or "", core_key, openalex_key))
        if action == "fulltext":
            return _ok(await asyncio.to_thread(academic.pmc_fulltext, args.get("doi") or args.get("query") or ""))
        if action == "journal":
            return _ok(await asyncio.to_thread(academic.journal, args.get("query") or ""))
        query = str(args.get("query") or "").strip()
        if not query:
            return _err("cần `query` (từ khoá tiếng Anh cho kết quả tốt nhất)")
        source = str(args.get("source") or "pubmed")
        limit = args.get("limit") or 5
        abstracts = args.get("abstracts") is not False
        if source == "crossref":
            results = await asyncio.to_thread(academic.crossref, query, limit)
        elif source == "openalex":
            results = await asyncio.to_thread(academic.openalex, query, limit, openalex_key, abstracts)
        elif source == "core":
            results = await asyncio.to_thread(academic.core, query, limit, core_key, abstracts)
        elif source == "arxiv":
            results = await asyncio.to_thread(academic.arxiv, query, limit, abstracts, openalex_key)
        elif source == "europepmc":
            results = await asyncio.to_thread(academic.europepmc, query, limit, abstracts)
        else:
            results = await asyncio.to_thread(academic.pubmed, query, limit, abstracts)
    except academic.AcademicError as exc:
        return _err(str(exc))
    if not results:
        return _ok({"results": [], "note": "không có bài nào — thử từ khoá tiếng Anh khác, ngắn hơn"})
    return _ok({"source": source, "results": results})


async def _open_data(fn, *args) -> str:
    from . import open_data
    try:
        return _ok(await asyncio.to_thread(fn, *args))
    except open_data.OpenDataError as exc:
        return _err(str(exc))


async def zalo_weather(args: Dict[str, Any], **_kw) -> str:
    """Thời tiết hiện tại và dự báo (Open-Meteo, không khoá). Chỉ đọc."""
    from . import open_data
    return await _open_data(open_data.weather, args.get("place") or "", args.get("days") or 3)


async def zalo_exchange_rate(args: Dict[str, Any], **_kw) -> str:
    """Quy đổi tiền tệ (Frankfurter, Currency-api; không khoá). Chỉ đọc."""
    from . import open_data
    return await _open_data(open_data.exchange_rate, args.get("base") or "", args.get("target") or "",
                            args.get("amount") if args.get("amount") is not None else 1)


async def zalo_dictionary(args: Dict[str, Any], **_kw) -> str:
    """Tra từ điển (Free Dictionary, Wiktionary; không khoá). Chỉ đọc."""
    from . import open_data
    return await _open_data(open_data.dictionary, args.get("word") or "", args.get("lang") or "en")


async def zalo_species(args: Dict[str, Any], **_kw) -> str:
    """Tra loài sinh vật (iNaturalist, GBIF; không khoá). Chỉ đọc."""
    from . import open_data
    return await _open_data(open_data.species, args.get("name") or "")


async def zalo_video_info(args: Dict[str, Any], **_kw) -> str:
    from . import media

    url = str(args.get("url") or "").strip()
    if not media.is_video_url(url):
        return _err("chỉ đọc được link video YouTube, TikTok, Facebook, Instagram, X, Vimeo, Dailymotion")
    turn = _turn() or {}
    if turn and not _acting_as_owner(turn):
        denied = _take_quota(_VIDEO_INFO_QUOTA, str(turn.get("sender_uid") or ""),
                             VIDEO_INFO_QUOTA_PER_HOUR, "đọc video")
        if denied:
            return denied
    try:
        info = await media.video_info(
            url, with_transcript=args.get("transcript") is not False,
            stt_max_minutes=(media.STT_MAX_MINUTES_OWNER if turn and _acting_as_owner(turn)
                             else media.STT_MAX_MINUTES_MEMBER))
    except media.MediaError as exc:
        return _err(str(exc))
    return _ok(info)


async def zalo_video_download(args: Dict[str, Any], **_kw) -> str:
    """Tải video Full HD rồi gửi vào cuộc trò chuyện đang diễn ra; gửi xong xoá tệp."""
    import shutil

    from . import media

    turn = _turn() or {}
    as_owner = _acting_as_owner(turn)
    if not as_owner and not turn.get("is_group"):
        return _err("chỉ tải video trong nhóm; nhắn riêng thì chưa hỗ trợ")
    if not as_owner and not _wants_download(turn.get("text") or ""):
        return _err("người dùng chưa yêu cầu tải — chỉ đọc nội dung bằng zalo_video_info, đừng tải")
    url = str(args.get("url") or "").strip()
    if not media.is_video_url(url):
        return _err("chỉ tải được video YouTube, TikTok, Facebook, Instagram, X, Vimeo, Dailymotion")
    # Luôn gửi vào đúng cuộc trò chuyện đang diễn ra, kể cả với chủ nhân.
    thread_id, kind, err = _scoped_thread({})
    if err:
        return err

    if not media.DOWNLOAD_LOCK.acquire(blocking=False):
        return _err("bot đang tải một video khác, thử lại sau ít phút")
    workdir = None
    keep = False
    try:
        if not as_owner:
            # Trừ lượt ngay khi thử: tải hỏng cũng tốn lượt, nên không spam được.
            denied = _take_quota(_VIDEO_QUOTA, str(turn.get("sender_uid") or ""),
                                 VIDEO_QUOTA_PER_HOUR, "tải video")
            if denied:
                return denied
        workdir = media.new_download_dir()
        try:
            start, end = media.doc_moc(args.get("start")), media.doc_moc(args.get("end"))
            cat = {k: v for k, v in (("start", start), ("end", end)) if v is not None}
            path = await media.download_video(
                url, workdir, max_minutes=None if as_owner else media.VIDEO_MAX_MINUTES, **cat)
        except media.MediaError as exc:
            return _err(str(exc))
        caption = str(args.get("caption") or "").strip()
        sent = await _invoke("sendMessage", [
            {"msg": caption, "attachments": [path]},
            thread_id, _thread_type(kind),
        ])
        if str(json.loads(sent).get("error", "")).startswith("Sidecar không phản hồi"):
            # Hết giờ chờ nhưng sidecar có thể vẫn đang tải tệp lên Zalo: xoá
            # ngay là cắt ngang lần gửi, báo lỗi thì mô hình tải lại gửi trùng.
            keep = True
            return _ok({"status": "unconfirmed",
                        "note": "Zalo chưa xác nhận sau 150 giây — tệp lớn có thể vẫn đang gửi. "
                                "Báo người dùng chờ thêm, ĐỪNG tải lại."})
        return sent
    finally:
        if workdir:
            if keep:
                media.schedule_cleanup(workdir)
            else:
                shutil.rmtree(workdir, ignore_errors=True)
        media.DOWNLOAD_LOCK.release()


# ---- Cắt ghép / sửa video (video_edit.py): chạy nền, xong tự gửi tệp vào đúng cuộc trò chuyện ----
# Người trong nhóm chỉ được nhờ khi CHÍNH TIN HỌ GÕ có ý cắt/ghép/sửa video (như _wants_download).
_VIDEO_EDIT_INTENT = re.compile(
    r"\b(ghép|ghep|nối|noi|cắt|cat|trích|trich|chèn|chen|gộp|gop|edit|dựng|dung|sửa|sua|làm)\s*"
    r"(video|clip|đoạn|doan|lại|lai|phụ đề|phu de|sub|nhạc|nhac|logo|hiệu ứng|hieu ung|chuyển cảnh|chuyen canh)\b"
    r"|\b(ghép|ghep|nối|noi|gộp|gop)\b",
    re.IGNORECASE,
)
VIDEO_EDIT_LOCK = threading.Lock()


def _wants_video_edit(text: str) -> bool:
    plain = unicodedata.normalize("NFC", re.sub(r"https?://\S+", " ", str(text or "")))
    return bool(_VIDEO_EDIT_INTENT.search(plain)) or _wants_download(plain)


def _video_edit_check(args: Dict[str, Any], turn: Dict[str, Any], as_owner: bool) -> Tuple[List[Dict[str, Any]], str]:
    """Kiểm nguồn các đoạn TRƯỚC khi nhận việc (lỗi báo ngay trong lượt). Trả (đoạn đã kiểm, lỗi)."""
    from . import media, video_edit

    raw = args.get("doan")
    toi_da = video_edit.MAX_DOAN_CHU if as_owner else video_edit.MAX_DOAN_THANH_VIEN
    if not isinstance(raw, list) or not raw:
        return [], _err("`doan` là danh sách các đoạn theo thứ tự, mỗi đoạn có `url` (link video) hoặc `tep` "
                        "(số thứ tự video người dùng gửi, đếm từ 1), kèm `start`/`end` nếu chỉ lấy một phần")
    if len(raw) > toi_da:
        return [], _err(f"tối đa {toi_da} đoạn mỗi lần")
    ds = []
    try:
        for k, d in enumerate(raw, 1):
            if not isinstance(d, dict) or bool(d.get("url")) == bool(d.get("tep")):
                return [], _err(f"đoạn {k} cần đúng một trong hai: `url` hoặc `tep`")
            tu, den = media.doc_moc(d.get("start")), media.doc_moc(d.get("end"))
            if tu is not None and den is not None and den - tu < 1:
                return [], _err(f"đoạn {k}: mốc kết thúc phải sau mốc bắt đầu ít nhất 1 giây")
            if d.get("url"):
                url = str(d["url"]).strip()
                if not media.is_video_url(url):
                    return [], _err(f"đoạn {k}: chỉ lấy được video YouTube, TikTok, Facebook, Instagram, X, Vimeo, "
                                    "Dailymotion")
                ds.append({"url": url, "tu": tu, "den": den})
            else:
                ds.append({"path": video_edit.chon_tep(turn.get("attachments") or [], "video", int(d["tep"])),
                           "tu": tu, "den": den})
    except (media.MediaError, ValueError, TypeError) as exc:
        return [], _err(str(exc))
    return ds, ""


def _video_edit_run(turn: Dict[str, Any], doan: List[Dict[str, Any]], opts: Dict[str, Any], as_owner: bool,
                    caption: str) -> None:
    """Luồng nền: lấy từng đoạn, chuẩn hoá, ghép (kèm hiệu ứng nếu là bản sửa), gửi, dọn."""
    import asyncio

    from . import media, media_engines, video_edit

    workdir = None
    try:
        workdir = video_edit.thu_muc_tam()
        nguon = []
        for k, d in enumerate(doan):
            if d.get("url"):
                sub = Path(workdir, f"tai{k}")
                sub.mkdir()
                cat = {x: d[y] for x, y in (("start", "tu"), ("end", "den")) if d.get(y) is not None}
                path = asyncio.run(media.download_video(
                    d["url"], str(sub), max_minutes=None if as_owner else media.VIDEO_MAX_MINUTES, **cat))
                nguon.append({"path": path, "tu": None, "den": None})
            else:
                nguon.append(d)
        cac_do = [video_edit.do(n["path"]) for n in nguon]
        dai = sum(min(n["den"] if n["den"] is not None else do_["giay"], do_["giay"]) - (n["tu"] or 0)
                  for n, do_ in zip(nguon, cac_do))
        if not as_owner and dai > video_edit.MAX_PHUT_THANH_VIEN * 60:
            raise media.MediaError(f"tổng các đoạn dài quá {video_edit.MAX_PHUT_THANH_VIEN} phút")
        kho = video_edit.kho_chung(cac_do)
        cac_tep, cac_giay = [], []
        for k, (n, do_) in enumerate(zip(nguon, cac_do)):
            ten = f"d{k}.mp4"
            video_edit.chuan_hoa(n["path"], ten, kho, do_["co_tieng"], workdir, n.get("tu"), n.get("den"))
            cac_tep.append(ten)
            cac_giay.append(video_edit.do(str(Path(workdir, ten)))["giay"])
        if opts:
            for khoa in ("logo", "nhac"):
                if opts.get(khoa + "_url"):
                    sub = Path(workdir, khoa)
                    sub.mkdir()
                    opts[khoa] = asyncio.run(media.download_video(opts[khoa + "_url"], str(sub), max_minutes=None))
            tong = video_edit.sua(cac_tep, cac_giay, "ket-qua.mp4", workdir, kho,
                                  chuyen=opts.get("chuyen"), logo=opts.get("logo"),
                                  vi_tri_logo=opts.get("vi_tri_logo") or "tren-phai", nhac=opts.get("nhac"),
                                  am_luong_nhac=opts.get("am_luong_nhac", 25),
                                  tat_tieng_goc=bool(opts.get("tat_tieng_goc")),
                                  cues=video_edit.cues_hop_le(opts.get("phu_de"), None))
        else:
            video_edit.noi(cac_tep, "ket-qua.mp4", workdir)
            tong = sum(cac_giay)
        ket = str(Path(workdir, "ket-qua.mp4"))
        video_edit.kiem_ra(ket)
        msg = caption or f"🎬 Video {'đã sửa' if opts else 'đã ghép'} ({len(doan)} đoạn, {round(tong)} giây)"
        if not media_engines._send_to_turn(turn, {"msg": msg, "attachments": [ket]}):
            media_engines._send_to_turn(turn, {"msg": "Video đã xong nhưng chưa gửi được vào đây — thử lại giúp em nhé."})
    except media.MediaError as exc:
        media_engines._send_to_turn(turn, {"msg": f"Chưa làm được video: {exc}."})
    except Exception:
        logger.warning("[zalo] cắt ghép video lỗi", exc_info=True)
        media_engines._send_to_turn(turn, {"msg": "Chưa làm được video do lỗi khi xử lý."})
    finally:
        video_edit.don(workdir)
        VIDEO_EDIT_LOCK.release()


async def _video_edit_start(args: Dict[str, Any], opts: Dict[str, Any]) -> str:
    turn = _turn() or {}
    as_owner = _acting_as_owner(turn)
    if not as_owner and not _wants_video_edit(turn.get("text") or ""):
        return _err("người dùng chưa nhờ cắt/ghép/sửa video — đừng tự làm")
    thread_id, kind, err = _scoped_thread({})
    if err:
        return err
    doan, err = _video_edit_check(args, turn, as_owner)
    if err:
        return err
    if not VIDEO_EDIT_LOCK.acquire(blocking=False):
        return _err("đang xử lý một video khác, thử lại sau ít phút")
    try:
        if not as_owner:
            denied = _take_quota(_VIDEO_QUOTA, str(turn.get("sender_uid") or ""), VIDEO_QUOTA_PER_HOUR, "xử lý video")
            if denied:
                VIDEO_EDIT_LOCK.release()
                return denied
        captured = {k: turn.get(k) for k in ("sender_uid", "sender_name", "thread_id", "is_group", "is_owner")}
        captured["thread_id"] = thread_id
        name = _bot_name()
        phut = "3–8" if opts or len(doan) > 2 else "2–5"
        await _send_wait(turn, f"🎬 {name} đang {'sửa' if opts else 'ghép'} video ({len(doan)} đoạn), bạn chờ khoảng "
                               f"{phut} phút nhé — xong {name} tự gửi vào đây.")
        threading.Thread(target=_video_edit_run, args=(captured, doan, opts, as_owner, str(args.get("caption") or "")),
                         daemon=True, name="zalo-video-edit").start()
    except BaseException:
        VIDEO_EDIT_LOCK.release()
        raise
    return _ok({"status": "queued", "note": f"ĐÃ nhắn người dùng chờ {phut} phút; video sẽ tự gửi vào đây khi xong. "
                                            "Trả lời ngắn, đừng gọi lại công cụ này."})


async def zalo_video_ghep(args: Dict[str, Any], **_kw) -> str:
    """Cắt rồi ghép các đoạn video (link hoặc video người dùng gửi) thành một video, không hiệu ứng."""
    return await _video_edit_start(args, {})


async def zalo_video_edit(args: Dict[str, Any], **_kw) -> str:
    """Cắt ghép kèm chuyển cảnh, logo, nhạc nền, phụ đề."""
    from . import media, video_edit

    turn = _turn() or {}
    opts: Dict[str, Any] = {}
    try:
        chuyen = str(args.get("chuyen_canh") or "khong")
        if chuyen != "khong":
            if chuyen not in video_edit.CHUYEN_CANH:
                return _err(f"`chuyen_canh` là một trong: khong, {', '.join(video_edit.CHUYEN_CANH)}")
            opts["chuyen"] = chuyen
        if args.get("logo_tep"):
            opts["logo"] = video_edit.chon_tep(turn.get("attachments") or [], "image", int(args["logo_tep"]))
            opts["vi_tri_logo"] = str(args.get("logo_vi_tri") or "tren-phai")
            if opts["vi_tri_logo"] not in video_edit.VI_TRI_LOGO:
                return _err(f"`logo_vi_tri` là một trong: {', '.join(video_edit.VI_TRI_LOGO)}")
        if args.get("nhac_tep"):
            opts["nhac"] = video_edit.chon_tep(turn.get("attachments") or [], "audio", int(args["nhac_tep"]))
        elif args.get("nhac_url"):
            if not media.is_video_url(str(args["nhac_url"])):
                return _err("`nhac_url` phải là link YouTube/TikTok/… có tiếng")
            opts["nhac_url"] = str(args["nhac_url"]).strip()
        if args.get("am_luong_nhac") is not None:
            opts["am_luong_nhac"] = int(args["am_luong_nhac"])
        if args.get("tat_tieng_goc"):
            opts["tat_tieng_goc"] = True
        if args.get("phu_de"):
            video_edit.cues_hop_le(args["phu_de"])
            opts["phu_de"] = args["phu_de"]
    except (media.MediaError, ValueError, TypeError) as exc:
        return _err(str(exc))
    if not opts:
        return _err("không có hiệu ứng, logo, nhạc hay phụ đề nào — ghép đơn thuần thì dùng zalo_video_ghep")
    return await _video_edit_start(args, opts)


# =====================================================================
#  Nhóm 9 — Sổ hồ sơ người quen
# =====================================================================
#
# ``memories/USER.md`` của Hermes chỉ có một hồ sơ — của chủ nhân. Trong nhóm
# Zalo thì mỗi người một khác, nên cần cuốn sổ tra theo UID.
#
# Ranh giới: hồ sơ ở đây là lời tự khai, không phải danh tính đã xác thực. Nó
# chỉ dùng để xưng hô và hiểu ngữ cảnh, không bao giờ dùng để cấp quyền —
# quyền vẫn chỉ dựa vào ZALO_ALLOWED_USERS.

def _people_scope(turn: Dict[str, Any]) -> str:
    from .people import turn_scope
    return turn_scope(bool(turn.get("is_group")), turn.get("thread_id"))


def _people_full(turn: Dict[str, Any]) -> bool:
    """Xem đủ cả sổ: chỉ khi chủ nhân đang nhắn riêng với bot — không phải nhóm, không phải
    việc hẹn giờ của chủ nhân gửi vào tin nhắn riêng của người khác."""
    sender = str(turn.get("sender_uid") or "")
    return (bool(turn.get("is_owner")) and not turn.get("is_group") and bool(sender)
            and str(turn.get("thread_id") or "") == sender)


async def zalo_remember_person(args: Dict[str, Any], **_kw) -> str:
    from .people import remember_person

    turn = _turn()
    sender = turn.get("sender_uid") or ""
    if not sender:
        return _err("không xác định được người đang trò chuyện")

    # Chủ nhân ghi hộ được cho người khác; người thường chỉ ghi cho chính mình.
    # Nếu ai cũng ghi hộ được thì một người có thể gán nhãn sai cho người khác,
    # rồi bot mang nhãn đó ra dùng ở lượt sau.
    target = str(args.get("user_id") or "").strip() or sender
    if target != sender and not turn.get("is_owner"):
        return _err("chỉ ghi được hồ sơ của chính mình")

    fields = args.get("fields")
    if fields is not None and not isinstance(fields, dict):
        return _err("`fields` phải là một đối tượng, ví dụ {\"lĩnh vực\": \"kỹ thuật\"}")

    if not any([args.get("name"), args.get("note"), fields]):
        return _err("cần ít nhất một trong `name`, `note`, `fields`")

    try:
        entry = remember_person(
            target,
            name=args.get("name", ""),
            note=args.get("note", ""),
            fields=fields,
            updated_by=sender,
            scope=_people_scope(turn),
        )
    except ValueError as exc:
        return _err(str(exc))
    # Chỉ trả phần dùng được ở đây — hồ sơ đầy đủ có cả điều nói ở cuộc trò chuyện khác.
    from .people import visible_profile
    return _ok({"user_id": target, "profile": visible_profile(target, entry, _people_scope(turn), full=_people_full(turn))})


async def zalo_recall_person(args: Dict[str, Any], **_kw) -> str:
    from .people import get_person, visible_profile

    turn = _turn()
    sender = turn.get("sender_uid") or ""
    target = str(args.get("user_id") or "").strip() or sender
    if target != sender and not turn.get("is_owner"):
        return _err("chỉ xem được hồ sơ của chính mình")

    person = get_person(target)
    if not person:
        return _ok({"user_id": target, "profile": None, "note": "chưa có hồ sơ"})
    # Chỉ phần được nói ở chính cuộc trò chuyện này; chủ nhân nhắn riêng với bot thì xem đủ.
    return _ok({"user_id": target, "profile": visible_profile(target, person, _people_scope(turn), full=_people_full(turn))})


async def zalo_list_people(args: Dict[str, Any], **_kw) -> str:
    from .people import list_people
    turn = _turn()
    # Trong nhóm chỉ liệt kê phần đã nói ở nhóm đó — câu trả lời ai trong nhóm cũng đọc được.
    return _ok(list_people(limit=max(1, min(int(args.get("limit", 50) or 50), 200)),
                           scope=_people_scope(turn), full=_people_full(turn)))


async def zalo_forget_person(args: Dict[str, Any], **_kw) -> str:
    from .people import forget_person

    uid = str(args.get("user_id") or "").strip()
    if not uid:
        return _err("cần `user_id`")
    return _ok({"user_id": uid, "removed": forget_person(uid)})


# =====================================================================
#  Nhóm 11 — Việc hẹn giờ do thành viên nhóm tạo
# =====================================================================
#
# Công cụ cron gốc của Hermes nhận script, thư mục làm việc, bộ công cụ tuỳ ý —
# đưa cho người ngoài là cho chạy lệnh trên máy. Công cụ này chỉ mở đúng một
# việc: hẹn giờ để bot soạn nội dung rồi gửi vào chính nhóm đang trò chuyện.
# Mọi trường nguy hiểm của job bị khoá cứng ở đây, không nhận từ mô hình.

GROUP_CRON_PROMPT_MAX = 1000
GROUP_CRON_NAME_MAX = 80
GROUP_CRON_MIN_GAP_MINUTES = 1440
GROUP_CRON_PER_CREATOR = 3
GROUP_CRON_PER_GROUP = 10
GROUP_CRON_LOOKAHEAD = 20
_GROUP_CRON_PROMPT_SEPARATOR = "\n---\n"
_GROUP_CRON_TOO_OFTEN = "việc hẹn giờ của nhóm chỉ được lặp tối đa 1 lần mỗi ngày"

# Chỉ nhận cron 5 trường gồm số, * , - / và tên tháng/thứ tiếng Anh. croniter còn
# hiểu các ký hiệu lạ như R (ngẫu nhiên — bốc lại mỗi lần chạy, lách được giới
# hạn 1 lần/ngày), H, L, W, # — thành viên không được dùng.
_GROUP_CRON_FIELD_RE = re.compile(
    r"^(?:[0-9*,/\-]|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|MON|TUE|WED|THU|FRI|SAT|SUN)+$",
    re.IGNORECASE,
)
_GROUP_CRON_BAD_EXPR = (
    "lịch lặp chỉ nhận biểu thức cron 5 trường gồm số, *, dấu phẩy, gạch ngang, "
    "gạch chéo và tên tháng/thứ"
)


def _sanitize_cron_creator_name(name: str) -> str:
    """Làm sạch tên hiển thị Zalo của người tạo trước khi đưa vào prompt cron.

    Tên này do thành viên trong nhóm tự đặt, không qua tay mô hình — bỏ ký tự
    Unicode dạng định dạng (zero-width, bidi, BOM: category "Cf") để không cài
    được ký tự ẩn vào phần đầu prompt, rồi gộp khoảng trắng và cắt bớt.
    """
    cleaned = "".join(ch for ch in name if unicodedata.category(ch) != "Cf")
    return " ".join(cleaned.split())[:60]


def _group_cron_prompt(prompt: str, creator_name: str) -> str:
    who = creator_name or "một thành viên"
    header = (
        f"Việc hẹn giờ do {who} tạo trong nhóm Zalo này. Chỉ viết đúng nội dung "
        "sẽ gửi vào nhóm, không chào hỏi thừa, không nhắc tới việc hẹn giờ."
    )
    return f"{header}{_GROUP_CRON_PROMPT_SEPARATOR}{prompt}"


def _cron_min_gap_minutes(expr: str) -> Optional[float]:
    """Khoảng cách ngắn nhất (phút) giữa hai lần chạy liền nhau của biểu thức cron.

    Đo nhiều lần chứ không chỉ hai lần đầu: `0 9,10 * * *` có lần cách 23 giờ
    nhưng cũng có lần cách 1 giờ.
    """
    from datetime import datetime

    jobs = _cron_jobs()
    if not jobs._ensure_croniter():
        return None
    try:
        it = jobs.croniter(expr, datetime.now())
        times = [it.get_next(datetime) for _ in range(GROUP_CRON_LOOKAHEAD)]
    except Exception:
        return None
    gaps = [(later - earlier).total_seconds() / 60 for earlier, later in zip(times, times[1:])]
    return min(gaps) if gaps else None


def _group_cron_schedule_problem(schedule: Dict[str, Any]) -> str:
    """Lịch này có vượt giới hạn của việc hẹn giờ nhóm không. Rỗng là hợp lệ."""
    from datetime import datetime

    kind = schedule.get("kind")
    if kind == "once":
        try:
            run_at = datetime.fromisoformat(str(schedule.get("run_at")))
        except ValueError:
            return "không đọc được thời điểm hẹn"
        now = datetime.now(run_at.tzinfo) if run_at.tzinfo else datetime.now()
        return "" if run_at > now else "thời điểm hẹn đã qua — chọn một giờ trong tương lai"
    if kind == "interval":
        minutes = float(schedule.get("minutes") or 0)
        return "" if minutes >= GROUP_CRON_MIN_GAP_MINUTES else _GROUP_CRON_TOO_OFTEN
    if kind == "cron":
        expr = str(schedule.get("expr") or "")
        fields = expr.split()
        if len(fields) != 5 or not all(_GROUP_CRON_FIELD_RE.match(field) for field in fields):
            return _GROUP_CRON_BAD_EXPR
        gap = _cron_min_gap_minutes(expr)
        if gap is None:
            return "không đọc được lịch lặp này"
        return "" if gap >= GROUP_CRON_MIN_GAP_MINUTES else _GROUP_CRON_TOO_OFTEN
    return "không hỗ trợ kiểu lịch này"


def _group_cron_create(args: Dict[str, Any], turn: Dict[str, Any]) -> str:
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return _err("cần `prompt` — việc bot sẽ làm khi đến giờ")
    if len(prompt) > GROUP_CRON_PROMPT_MAX:
        return _err(f"`prompt` dài quá {GROUP_CRON_PROMPT_MAX} ký tự")
    raw_schedule = str(args.get("schedule") or "").strip()
    if not raw_schedule:
        return _err("cần `schedule`, ví dụ 'every day at 7am' hoặc '2026-09-18T07:30'")
    creator = str(turn.get("sender_uid") or "")
    if not creator:
        return _err("không xác định được người tạo")

    jobs = _cron_jobs()
    try:
        schedule = jobs.parse_schedule(raw_schedule)
    except ValueError as exc:
        return _err(str(exc))
    problem = _group_cron_schedule_problem(schedule)
    if problem:
        return _err(problem)

    creator_name = _sanitize_cron_creator_name(str(turn.get("sender_name") or ""))

    # Cùng bộ quét công cụ cron gốc dùng. Không import được thì từ chối, không
    # bỏ qua: đây là lớp chặn prompt cài lệnh ẩn.
    #
    # Quét trên PROMPT ĐÃ GHÉP (phần đầu kèm tên người tạo + prompt của người
    # dùng), không chỉ mỗi phần người dùng gõ: Hermes quét lại đúng chuỗi đã
    # ghép này ở mọi lần chạy, nên tên hiển thị Zalo (thành viên tự đặt, có
    # thể cài ký tự ẩn hay từ khoá đe doạ) mà không bị soát ở đây thì job vẫn
    # được tạo rồi bị chặn ở mọi lần chạy sau, giữ nguyên hạn mức mà không
    # bao giờ gửi được.
    try:
        from tools.cronjob_tools import _scan_cron_prompt
    except ImportError:
        return _err("bản Hermes này không kiểm được nội dung việc hẹn giờ nên chưa tạo")
    blocked = _scan_cron_prompt(_group_cron_prompt(prompt, creator_name))
    if blocked:
        return _err(blocked)

    group = str(turn.get("thread_id") or "")
    if not turn.get("is_owner"):
        active = [
            job for job in jobs.list_jobs(include_disabled=False)
            if _is_group_cron(job) and not jobs.is_terminal_job(job)
        ]
        mine = sum(1 for job in active if str(job["origin"].get("zalo_creator_uid") or "") == creator)
        if mine >= GROUP_CRON_PER_CREATOR:
            return _err(f"bạn đã có {mine} việc hẹn giờ đang bật — tối đa {GROUP_CRON_PER_CREATOR}. Xoá bớt rồi tạo lại")
        here = sum(1 for job in active if _cron_target(job) == group)
        if here >= GROUP_CRON_PER_GROUP:
            return _err(f"nhóm này đã có {here} việc hẹn giờ đang bật — tối đa {GROUP_CRON_PER_GROUP}")

    name = (
        " ".join(str(args.get("name") or "").split())[:GROUP_CRON_NAME_MAX]
        or " ".join(prompt.split())[:40]
    )
    job = jobs.create_job(
        prompt=_group_cron_prompt(prompt, creator_name),
        schedule=raw_schedule,
        name=name,
        repeat=1 if schedule.get("kind") == "once" else None,
        deliver=f"zalo:{group}",
        origin={
            "platform": "zalo",
            "chat_id": group,
            "chat_name": group,
            "chat_type": "group",
            "thread_id": None,
            "user_id": creator,
            "zalo_scope": GROUP_CRON_SCOPE,
            "zalo_creator_uid": creator,
            "zalo_creator_name": creator_name,
        },
        enabled_toolsets=[TOOLSET_CRON_MEMBER, "no_mcp"],
    )
    return _ok({
        "job_id": job.get("id"),
        "ten": job.get("name"),
        "lich": job.get("schedule_display") or schedule.get("display"),
        "lan_toi": job.get("next_run_at"),
    })


def _group_cron_list(turn: Dict[str, Any]) -> str:
    group = str(turn.get("thread_id") or "")
    jobs = _cron_jobs()
    items = []
    for job in jobs.list_jobs(include_disabled=True):
        if _cron_target(job) != group:
            continue
        item = {
            "job_id": job.get("id"),
            "ten": job.get("name"),
            "lich": job.get("schedule_display"),
            "lan_toi": job.get("next_run_at"),
            "trang_thai": jobs.effective_job_state(job),
        }
        if _is_group_cron(job):
            origin = job["origin"]
            item["nguoi_tao"] = origin.get("zalo_creator_name") or origin.get("zalo_creator_uid")
            item["noi_dung"] = str(job.get("prompt") or "").split(_GROUP_CRON_PROMPT_SEPARATOR, 1)[-1]
        else:
            # Việc của chủ nhân: cho biết là có, không lộ nội dung giao việc.
            item["nguoi_tao"] = "chủ nhân"
        items.append(item)
    return _ok({"count": len(items), "jobs": items})


def _group_cron_remove(args: Dict[str, Any], turn: Dict[str, Any]) -> str:
    job_id = str(args.get("job_id") or "").strip()
    if not job_id:
        return _err("cần `job_id` — lấy từ action 'list'")
    group = str(turn.get("thread_id") or "")
    jobs = _cron_jobs()
    job = jobs.get_job(job_id)
    if not job or _cron_target(job) != group:
        return _err("nhóm này không có việc hẹn giờ đó")
    if _is_group_cron(job):
        creator = str(job["origin"].get("zalo_creator_uid") or "")
        if not (turn.get("is_owner") or creator == str(turn.get("sender_uid") or "")):
            return _err("chỉ người tạo hoặc chủ nhân được xoá việc hẹn giờ này")
    elif not turn.get("is_owner"):
        return _err("việc hẹn giờ của chủ nhân chỉ chủ nhân xoá được")
    return _ok({"job_id": job["id"], "da_xoa": bool(jobs.remove_job(job["id"]))})


async def zalo_group_cron(args: Dict[str, Any], **_kw) -> str:
    turn = _turn()
    if turn.get("cron_job_id"):
        return _err("việc hẹn giờ không được tự tạo, xem hay xoá việc hẹn giờ khác")
    if not turn.get("is_group") or not turn.get("thread_id"):
        return _err("chỉ dùng được trong nhóm Zalo")
    action = str(args.get("action") or "").strip().lower()
    if action == "create":
        return _group_cron_create(args, turn)
    if action == "list":
        return _group_cron_list(turn)
    if action == "remove":
        return _group_cron_remove(args, turn)
    return _err("`action` phải là create, list hoặc remove")


# =====================================================================
#  Khai báo công cụ
# =====================================================================

def _schema(name: str, description: str, properties: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
    }


_ZALO_ID = {
    "type": "string",
    "description": "ID Zalo dạng chuỗi; không dùng số vì ID dài sẽ bị JavaScript làm tròn.",
}
_ZALO_ID_LIST = {
    "type": "array",
    "items": _ZALO_ID,
}
_THREAD_ID = _ZALO_ID
_THREAD_KIND = {
    "type": "string",
    "enum": ["group", "dm"],
    "description": "Loại hội thoại. Mặc định 'dm'.",
}
_GROUP_ID = _ZALO_ID

# =====================================================================
#  Nhóm 10 — Fanpage Facebook
# =====================================================================

async def zalo_fb_pages(args: Dict[str, Any], **_kw) -> str:
    from . import facebook as fb
    pages = fb.load_pages()
    if not pages:
        return _err("chưa cấu hình Fanpage nào — chạy lay-token-facebook.py "
                    "rồi đặt FB_PAGES_FILE trong .env")
    return _ok({"count": len(pages), "pages": [
        {"name": x.get("name"), "id": x.get("id"), "default": bool(x.get("default"))}
        for x in pages]})


async def zalo_fb_posts(args: Dict[str, Any], **_kw) -> str:
    from . import facebook as fb
    page, err = fb.resolve_page(args.get("page", ""))
    if err:
        return _err(err)
    limit = max(1, min(int(args.get("limit", 5) or 5), 25))
    r = fb.graph(f"{page['id']}/posts", access_token=page["token"], limit=limit,
                 fields="id,message,created_time,permalink_url,"
                        "comments.summary(true).limit(0),reactions.summary(true).limit(0)")
    if "error" in r:
        return _err(f"Facebook: {r['error'].get('message', '')[:160]}")
    out = []
    for x in r.get("data") or []:
        out.append({
            "id": x.get("id"),
            "ngay": (x.get("created_time") or "")[:10],
            "noi_dung": (x.get("message") or "")[:1500],
            "link": x.get("permalink_url"),
            "binh_luan": ((x.get("comments") or {}).get("summary") or {}).get("total_count"),
            "cam_xuc": ((x.get("reactions") or {}).get("summary") or {}).get("total_count"),
        })
    return _ok({"page": page.get("name"), "count": len(out), "posts": out})


async def zalo_fb_comments(args: Dict[str, Any], **_kw) -> str:
    from . import facebook as fb
    post_id = str(args.get("post_id") or "").strip()
    if not post_id:
        return _err("cần `post_id` — lấy từ zalo_fb_posts")
    page, err = fb.resolve_page(args.get("page", ""))
    if err:
        return _err(err)
    limit = max(1, min(int(args.get("limit", 25) or 25), 100))
    r = fb.graph(f"{post_id}/comments", access_token=page["token"], limit=limit,
                 order="reverse_chronological",
                 fields="from,message,created_time,like_count")
    if "error" in r:
        return _err(f"Facebook: {r['error'].get('message', '')[:160]}")
    out = [{
        "nguoi": ((x.get("from") or {}).get("name")) or "(ẩn danh)",
        "ngay": (x.get("created_time") or "")[:16].replace("T", " "),
        "noi_dung": (x.get("message") or "")[:600],
        "thich": x.get("like_count"),
    } for x in (r.get("data") or [])]
    return _ok({"post_id": post_id, "count": len(out), "comments": out})


async def zalo_fb_check(args: Dict[str, Any], **_kw) -> str:
    """Soát một bài đã đăng: Facebook khai gì, và người ngoài có xem được không."""
    from . import facebook as fb
    post_id = str(args.get("post_id") or "").strip()
    if not post_id:
        return _err("cần `post_id` — lấy từ zalo_fb_posts hoặc kết quả zalo_fb_publish")
    page, err = fb.resolve_page(args.get("page", ""))
    if err:
        return _err(err)

    r = fb.graph(post_id, access_token=page["token"],
                 fields="id,created_time,is_published,is_hidden,timeline_visibility,"
                        "privacy,permalink_url,scheduled_publish_time")
    if "error" in r:
        return _err(f"Facebook: {r['error'].get('message', '')[:160]}")

    link = r.get("permalink_url")
    visibility = await asyncio.to_thread(fb.public_visibility, link)
    return _ok({
        "post_id": r.get("id"),
        "page": page.get("name"),
        "link": link,
        "facebook_khai": {
            "da_dang": r.get("is_published"),
            "bi_an": r.get("is_hidden"),
            "dong_thoi_gian": r.get("timeline_visibility"),
            "quyen": (r.get("privacy") or {}).get("description"),
            "hen_gio": r.get("scheduled_publish_time"),
        },
        "hien_thi_cong_khai": visibility,
        "huong_dan": (
            "Người ngoài xem được bài này." if visibility == "cong_khai" else
            "Bài chưa tới giờ đăng nên chưa soi được." if r.get("scheduled_publish_time") else
            "Facebook KHÔNG cho người ngoài xem bài này — báo chủ nhân để xoá và đăng lại."
            if visibility == "khong_xem_duoc" else
            "Chưa kiểm tra được, thử lại sau hoặc mở link bằng cửa sổ ẩn danh."
        ),
    })


async def zalo_fb_draft(args: Dict[str, Any], **_kw) -> str:
    """Soạn bài rồi CHỜ chủ nhân gõ mã duyệt. Không đăng gì ở bước này."""
    from . import facebook as fb
    message = str(args.get("message") or "").strip()
    if not message:
        return _err("cần `message` — nội dung bài đăng")
    page, err = fb.resolve_page(args.get("page", ""))
    if err:
        return _err(err)

    raw = args.get("photos") or ([args["photo"]] if args.get("photo") else [])
    if isinstance(raw, str):
        raw = [raw]
    photos = [str(x).strip() for x in raw if str(x).strip()][:10]
    for path in photos:
        if not os.path.isfile(path):
            return _err(f"không có tệp ảnh '{path}' — dùng zalo_kb_list để tìm đúng đường dẫn")

    saved = fb.save_draft(page, message, photos)
    return _ok({
        **saved,
        "huong_dan": (
            f"Đã soạn xong nhưng CHƯA đăng. Hãy đưa TOÀN VĂN bài viết cho chủ "
            f"nhân xem, kèm tên Fanpage '{page.get('name')}' và số ảnh, rồi nói "
            f"rõ: muốn đăng thì nhắn lại mã {saved['code']}. Tuyệt đối không tự "
            f"gọi zalo_fb_publish thay chủ nhân."
        ),
    })


async def zalo_fb_publish(args: Dict[str, Any], **_kw) -> str:
    """Đăng bản nháp. Chỉ chạy khi mã duyệt nằm trong tin nhắn chủ nhân vừa gõ."""
    from . import facebook as fb
    code = str(args.get("code") or "").strip().upper()
    if not code:
        return _err("cần `code` — mã duyệt chủ nhân vừa nhắn")

    # Điểm chịu lực: đối chiếu với NGUYÊN VĂN tin nhắn người dùng, không phải
    # với chuỗi mô hình truyền vào. Mô hình có thể bị dụ để truyền bất cứ thứ
    # gì, nhưng không viết được tin nhắn thay chủ nhân.
    human = _turn().get("text") or ""
    if not fb.confirmed_in_message(code, human):
        logger.warning("[fb] chặn đăng bài: mã %s không có trong tin nhắn chủ nhân", code)
        return _err(
            "chưa đăng. Mã duyệt phải do chính chủ nhân gõ trong tin nhắn của "
            "họ. Hãy hỏi lại chủ nhân và chờ họ nhắn mã, đừng tự điền."
        )

    # Kiểm giờ hẹn TRƯỚC khi lấy bản nháp: take_draft dùng một lần là mất.
    scheduled_time = args.get("scheduled_publish_time")
    if scheduled_time in (None, ""):
        scheduled_time = None
    else:
        try:
            scheduled_time = int(scheduled_time)
        except (TypeError, ValueError):
            return _err("`scheduled_publish_time` phải là UNIX timestamp tính bằng giây")

    draft, err = fb.take_draft(code)
    if err:
        return _err(err)

    page, message, photos = draft["page"], draft["message"], draft["photos"]

    media_ids = []
    for path in photos:
        up = fb.upload_photo(page, path)
        if "error" in up:
            return _err(f"tải ảnh '{os.path.basename(path)}' thất bại: "
                        f"{up['error'].get('message', '')[:120]}")
        media_ids.append(up.get("id"))

    params = {"access_token": page["token"], "message": message}
    for i, mid in enumerate(media_ids):
        params[f"attached_media[{i}]"] = json.dumps({"media_fbid": mid})

    # Facebook chỉ nhận giờ hẹn từ 10 phút tới 75 ngày sau; ngoài khoảng đó
    # Graph API trả lỗi rõ ràng nên không tự kiểm lại ở đây.
    if scheduled_time is not None:
        params["published"] = "false"
        params["scheduled_publish_time"] = scheduled_time

    r = fb.graph(f"{page['id']}/feed", "POST", timeout=300, **params)
    if "error" in r:
        return _err(f"Facebook: {r['error'].get('message', '')[:160]}")

    post_id = r.get("id")
    info = fb.graph(post_id, access_token=page["token"], fields="permalink_url")
    link = info.get("permalink_url")
    logger.info("[fb] đã %s %s lên %s", "lên lịch" if scheduled_time else "đăng", post_id, page.get("name"))

    # Đăng xong phải soi bằng mắt người ngoài trước khi nói với chủ nhân là
    # xong: Graph API từng khai "đã đăng, công khai" cho bài mà chỉ quản trị
    # viên nhìn thấy. Bài hẹn giờ thì chưa có gì để soi, đợi tới giờ đăng.
    visibility = "chua_toi_gio" if scheduled_time else await asyncio.to_thread(fb.public_visibility, link)
    guide = {
        "cong_khai": "Bài đã hiện công khai, người ngoài xem được.",
        "khong_xem_duoc": ("Facebook KHÔNG cho người ngoài xem bài này dù Graph API báo đã đăng. "
                           "Nói thẳng với chủ nhân, đừng báo là đã đăng xong."),
        "khong_ro": "Chưa kiểm tra được hiển thị công khai — báo chủ nhân là chưa chắc chắn.",
        "chua_toi_gio": "Bài mới chỉ được hẹn giờ. Tới giờ đăng hãy dùng zalo_fb_check để soát lại.",
    }[visibility]
    return _ok({
        "da_dang": True,
        "len_lich": scheduled_time is not None,
        "thoi_gian_hen": scheduled_time,
        "page": page.get("name"),
        "post_id": post_id,
        "so_anh": len(media_ids),
        "link": link,
        "hien_thi_cong_khai": visibility,
        "huong_dan": guide,
    })



TOOLS = [
    # --- Nhóm 10: Fanpage Facebook ---
    ("zalo_fb_pages", "📘", _schema(
        "zalo_fb_pages",
        "Liệt kê các Fanpage Facebook đã cấu hình, kèm Page nào là mặc định.",
        {},
        [],
    ), zalo_fb_pages, TOOLSET_OWNER),

    ("zalo_fb_posts", "📰", _schema(
        "zalo_fb_posts",
        "Đọc các bài đăng gần nhất của một Fanpage, kèm số bình luận và cảm xúc.",
        {
            "page": {"type": "string", "description":
                     "Tên hoặc id Fanpage. Bỏ trống thì dùng Page mặc định."},
            "limit": {"type": "integer", "description": "Số bài, tối đa 25 (mặc định 5)."},
        },
        [],
    ), zalo_fb_posts, TOOLSET_OWNER),

    ("zalo_fb_comments", "💬", _schema(
        "zalo_fb_comments",
        "Đọc bình luận dưới một bài đăng Fanpage, mới nhất trước. Dùng khi cần "
        "nắm xem mọi người đang hỏi gì để tổng hợp lại.",
        {
            "post_id": _ZALO_ID,
            "page": {"type": "string", "description": "Tên hoặc id Fanpage."},
            "limit": {"type": "integer", "description": "Số bình luận, tối đa 100."},
        },
        ["post_id"],
    ), zalo_fb_comments, TOOLSET_OWNER),

    ("zalo_fb_draft", "📝", _schema(
        "zalo_fb_draft",
        "Soạn một bài đăng Fanpage và lấy mã duyệt. CHƯA đăng gì cả. Sau khi "
        "gọi, phải đưa toàn văn bài viết cho chủ nhân xem và chờ họ nhắn lại mã.",
        {
            "message": {"type": "string", "description": "Toàn văn nội dung bài đăng."},
            "page": {"type": "string", "description":
                     "Tên hoặc id Fanpage. Bỏ trống thì dùng Page mặc định."},
            "photo": {"type": "string", "description":
                      "Đường dẫn một ảnh trên máy hoặc trong kho tài liệu."},
            "photos": {"type": "array", "items": {"type": "string"},
                       "description": "Nhiều ảnh, tối đa 10."},
        },
        ["message"],
    ), zalo_fb_draft, TOOLSET_OWNER),

    ("zalo_fb_check", "🔍", _schema(
        "zalo_fb_check",
        "Soát một bài Fanpage đã đăng: Facebook khai gì (đã đăng, bị ẩn, quyền) "
        "và quan trọng hơn là người ngoài có xem được không. Dùng sau khi đăng, "
        "và dùng lại khi bài hẹn giờ đã tới giờ.",
        {
            "post_id": {"type": "string", "description": "ID bài, lấy từ zalo_fb_posts hoặc kết quả đăng."},
            "page": {"type": "string", "description": "Tên hoặc ID Fanpage. Bỏ trống là Page mặc định."},
        },
        ["post_id"],
    ), zalo_fb_check, TOOLSET_OWNER),

    ("zalo_fb_publish", "🚀", _schema(
        "zalo_fb_publish",
        "Đăng hoặc hẹn giờ đăng bản nháp lên Fanpage. CHỈ gọi sau khi chính chủ "
        "nhân đã nhắn mã duyệt trong tin nhắn của họ — không bao giờ tự điền mã thay họ.",
        {
            "code": {"type": "string", "description": "Mã duyệt chủ nhân vừa nhắn."},
            "scheduled_publish_time": {
                "type": "integer",
                "description": "Hẹn giờ đăng: UNIX timestamp tính bằng giây, từ 10 phút tới "
                               "75 ngày sau. Bỏ trống để đăng ngay.",
            },
        },
        ["code"],
    ), zalo_fb_publish, TOOLSET_OWNER),

    # --- Nhóm 11: việc hẹn giờ của nhóm ---
    ("zalo_group_cron", "⏲️", _schema(
        "zalo_group_cron",
        "Hẹn giờ cho nhóm Zalo đang trò chuyện: đến giờ bot tự soạn và gửi nội "
        "dung vào nhóm (nhắc họp, bản tin, tóm tắt nhóm). `create` tạo việc mới, "
        "`list` xem các việc của nhóm, `remove` xoá theo `job_id`. Lặp tối đa 1 "
        "lần mỗi ngày; mỗi người tối đa 3 việc, mỗi nhóm tối đa 10.",
        {
            "action": {"type": "string", "enum": ["create", "list", "remove"]},
            "prompt": {"type": "string", "description":
                       "Việc bot làm khi đến giờ, tối đa 1000 ký tự. Viết đủ ý vì lúc "
                       "chạy bot không nhớ cuộc trò chuyện này."},
            "schedule": {"type": "string", "description":
                         "Lịch: 'every day at 7am', 'every monday 9am', '0 7 * * *', "
                         "'2026-09-18T07:30' (một lần), 'in 2h' (một lần)."},
            "name": {"type": "string", "description": "Tên ngắn cho việc hẹn giờ."},
            "job_id": {"type": "string", "description": "Mã việc hẹn giờ cần xoá, lấy từ action 'list'."},
        },
        ["action"],
    ), zalo_group_cron, TOOLSET_PUBLIC),

    # --- Nhóm 1: gửi nội dung ---
    ("zalo_send_file", "📎", _schema(
        "zalo_send_file",
        "Gửi ảnh, video hoặc tệp lên một hội thoại Zalo. Dùng khi cần đưa cho "
        "người dùng một tài liệu vừa tạo, ảnh chụp màn hình hay bản báo cáo.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "path": {"type": "string", "description":
                     "Đường dẫn tệp. Người trong nhóm chỉ gửi được tệp thuộc kho "
                     "tài liệu — dùng đúng đường dẫn mà zalo_kb_list trả về."},
            "paths": {"type": "array", "items": {"type": "string"},
                      "description": "Nhiều tệp cùng lúc."},
            "caption": {"type": "string", "description":
                        "Lời nhắn đi kèm tệp, ví dụ tên tài liệu."},
        },
        ["thread_id"],
    ), zalo_send_file, TOOLSET_PUBLIC),

    ("zalo_make_file", "📄", _schema(
        "zalo_make_file",
        "Tạo tệp Word (docx), PowerPoint (pptx), Excel (xlsx) hoặc PDF từ nội dung em soạn "
        "rồi gửi luôn vào nhóm đang chat — dùng khi thầy cô nhờ làm giáo án, đề, danh sách, "
        "slide, bảng điểm dưới dạng tệp. Chỉ dùng trong nhóm; mỗi người tối đa 5 tệp/giờ. "
        "Tệp chỉ có chữ và bảng, không chèn ảnh; hệ thống tự trình bày: Word theo thể thức "
        "Nghị định 30 (A4, Times New Roman, chữ đen — in nộp được), PDF/PowerPoint/Excel có màu, "
        "bảng tô nền, số trang. Soạn cho đẹp: chia mục bằng # rõ ràng, dữ liệu so sánh thì dùng bảng, "
        "mỗi slide 3–6 ý ngắn, slide chỉ có tiêu đề (bullets rỗng) làm slide chuyển phần. "
        "PowerPoint ở đây là slide CHỮ theo một mẫu cố định (dải tiêu đề xanh + gạch đầu dòng): không có ảnh, "
        "không theo được tệp mẫu/template hay phong cách người dùng gửi — slide đẹp có ảnh thì dùng zalo_studio "
        "kind=slide; đừng nói tệp này giống mẫu của họ. "
        "Chỉ báo đã gửi khi kết quả trả về thành công.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "format": {"type": "string", "enum": ["docx", "pptx", "xlsx", "pdf"],
                       "description": "Loại tệp."},
            "title": {"type": "string", "description": "Tiêu đề tài liệu, cũng dùng làm tên tệp."},
            "filename": {"type": "string", "description": "Tên tệp mong muốn (không bắt buộc)."},
            "content": {"type": "string", "description":
                        "Với docx/pdf: nội dung Markdown — # tiêu đề, - gạch đầu dòng, 1. đánh số, "
                        "**đậm**, bảng dạng | a | b |. Tối đa 30.000 ký tự. Công thức viết Unicode (H₂O, x²)."},
            "slides": {"type": "array", "description": "Với pptx: tối đa 40 slide, mỗi slide tối đa 15 ý.",
                       "items": {"type": "object", "properties": {
                           "title": {"type": "string"},
                           "bullets": {"type": "array", "items": {"type": "string"}},
                       }}},
            "sheets": {"type": "array", "description":
                       "Với xlsx: tối đa 5 trang tính; `rows` là các dòng, dòng đầu là tiêu đề cột.",
                       "items": {"type": "object", "properties": {
                           "name": {"type": "string"},
                           "rows": {"type": "array", "items": {"type": "array", "items": {}}},
                       }}},
            "caption": {"type": "string", "description": "Lời nhắn đi kèm tệp."},
        },
        ["thread_id", "format", "title"],
    ), zalo_make_file, TOOLSET_PUBLIC),

    ("zalo_pdf", "📑", _schema(
        "zalo_pdf",
        "Xử lý tệp PDF người dùng gửi trong cuộc trò chuyện (tin vừa gửi, tin họ reply hoặc tin "
        "gần đó): chuyển sang Word (to_word), gộp nhiều PDF thành một (merge), tách lấy một số "
        "trang (split). Tệp kết quả gửi thẳng vào cuộc trò chuyện này. Chỉ gọi khi người dùng "
        "nhờ đổi/gộp/tách PDF — muốn đọc nội dung thì không cần, chữ trong tệp đã kèm sẵn.",
        {
            "action": {"type": "string", "enum": ["to_word", "merge", "split"],
                       "description": "to_word: PDF → .docx; merge: gộp các PDF theo thứ tự; split: lấy các trang chỉ định."},
            "files": {"type": "array", "items": {"type": "integer"},
                      "description": "Số thứ tự tệp PDF theo thứ tự xuất hiện (1 = tệp đầu). Bỏ trống = tất cả."},
            "pages": {"type": "string", "description": "Chỉ cho split: khoảng trang, ví dụ '1-3, 5, 8-'."},
            "caption": {"type": "string", "description": "Lời nhắn kèm tệp (tuỳ chọn)."},
        },
        ["action"],
    ), zalo_pdf, TOOLSET_PUBLIC),

    ("zalo_studio", "🏭", _schema(
        "zalo_studio",
        "Xưởng tạo sản phẩm của 2Anh Studio: nhờ máy chủ làm slide PowerPoint đẹp (có ảnh minh hoạ), giáo án 5512, "
        "văn bản hành chính NĐ30 / văn bản Đoàn / văn bản Đảng, đề kiểm tra, đề KHTN tiếng Anh, SKKN, trò chơi "
        "(trắc nghiệm, ghép đôi, ô chữ, vòng quay, thẻ lật, đếm ngược), thí nghiệm ảo, video giải thích (viết tay, "
        "cắt dán, Vox có ảnh AI, video ngắn TikTok có nhân vật minh hoạ) và video bài giảng từ slide — rồi tự gửi tệp vào "
        "cuộc trò chuyện này sau vài phút. Bot TỰ nhắn người dùng lời báo chờ; đừng lặp lại. VIDEO (kind=video) đi hai "
        "bước: (1) hỏi người dùng phong cách → action=plan (bot viết và gửi kịch bản kèm mã) → (2) người dùng đồng ý → "
        "action=make kèm plan_id; muốn sửa → action=plan với plan_id và feedback. Loại khác: gọi MỘT lần action=make khi "
        "đủ thông tin. Bị từ chối (chưa bật, hết lượt) thì nói đúng lý do, không tự làm bằng cách khác.",
        {
            "kind": {"type": "string", "enum": ["slide", "giao_an", "van_ban", "van_ban_doan", "van_ban_dang",
                                                "de_kiem_tra", "de_tieng_anh", "skkn", "tro_choi", "thi_nghiem",
                                                "video", "video_bai_giang"],
                     "description": "Loại sản phẩm."},
            "brief": {"type": "string", "description":
                      "Yêu cầu đầy đủ bằng tiếng Việt: chủ đề, môn, lớp, số lượng, đơn vị, người ký, nội dung "
                      "người dùng đưa (chép lại chữ từ ảnh họ gửi nếu có). Tối đa 8.000 ký tự."},
            "options": {"type": "object", "properties": {
                "loai": {"type": "string", "enum": ["bai-giang", "bao-cao-tong-ket", "hoat-dong-doan",
                                                    "poster-mang-xa-hoi", "tap-huan-workshop", "quiz", "matching",
                                                    "crossword", "spinwheel", "flashcard", "timer"],
                         "description": "slide / video_bai_giang: kiểu bài; tro_choi: loại trò chơi."},
                "kieu": {"type": "string", "enum": ["viet-tay", "cat-dan", "vox", "ngan"],
                         "description": "Chỉ với video: phong cách người dùng đã chọn — viet-tay (viết tay trên bảng), "
                                        "cat-dan (cắt dán giấy), vox (ảnh minh hoạ AI), ngan (video ngắn TikTok/Reels khổ dọc: "
                                        "hình đổi theo từng câu, nhân vật minh hoạ tự ghép theo nội dung, số liệu, tin "
                                        "nhắn; giao diện tự chọn theo nội dung; hợp kỹ năng sống, mẹo học, tin nhanh, giải "
                                        "mã số liệu)."}},
                        "additionalProperties": False},
            "action": {"type": "string", "enum": ["plan", "make"],
                       "description": "plan: chỉ video — viết kịch bản gửi người dùng duyệt. make (mặc định): làm sản phẩm."},
            "plan_id": {"type": "string", "description": "Mã kịch bản (kb-…) bot đã gửi: make để dựng đúng bản đã duyệt; "
                                                         "plan để sửa bản đó."},
            "feedback": {"type": "string", "description": "Chỉ plan khi sửa: người dùng muốn sửa gì trong kịch bản."},
            "confirmed": {"type": "boolean", "description": "Chỉ video_bai_giang: người dùng đã chốt kiểu bài và dàn ý."},
        },
        ["kind"],
    ), zalo_studio, TOOLSET_PUBLIC),

    ("zalo_media", "🎨", _schema(
        "zalo_media",
        "Vẽ ảnh AI hoặc tạo video AI ngắn theo mô tả, rồi gửi vào cuộc trò chuyện này. Bot TỰ nhắn lời báo chờ. "
        "kind=image: vẽ (hoặc sửa theo ảnh mẫu trong `images`) và gửi ngay. kind=video: TRƯỚC KHI gọi, hỏi người dùng "
        "phong cách rồi gửi kịch bản ngắn (cảnh, góc máy, chuyển động, thời lượng, khổ) để họ xác nhận; đồng ý rồi mới "
        "gọi với `style` và confirmed=true; chạy nền 3–15 phút, xong tự gửi. Gọi MỘT lần cho một yêu cầu. Bị từ chối (chưa bật, hết lượt trong ngày) thì nói đúng lý do, không tự làm "
        "bằng cách khác.",
        {
            "kind": {"type": "string", "enum": ["image", "video"]},
            "prompt": {"type": "string", "description": "Mô tả chi tiết ảnh/video cần tạo (tiếng Việt hoặc tiếng Anh)."},
            "aspect": {"type": "string", "description": "Ảnh: square | landscape | portrait. Video: 9:16 (dọc) | 16:9 | 1:1."},
            "seconds": {"type": "integer", "description": "Chỉ video: độ dài giây (bỏ trống = theo cài đặt)."},
            "images": {"type": "array", "items": {"type": "string"}, "maxItems": 4,
                       "description": "Ảnh mẫu (đường dẫn ảnh người dùng vừa gửi, hoặc link https): ảnh sửa theo mẫu; video lấy làm khung đầu."},
            "style": {"type": "string", "description": "Phong cách người dùng đã chọn (bắt buộc với video): điện ảnh, hoạt hình 3D, anime…"},
            "confirmed": {"type": "boolean", "description": "Chỉ video: người dùng đã xác nhận kịch bản."},
        },
        ["kind", "prompt"],
    ), zalo_media, TOOLSET_PUBLIC),


    ("zalo_send_voice", "🎙️", _schema(
        "zalo_send_voice",
        "Gửi tin nhắn thoại từ một URL âm thanh (định dạng .aac). Kết hợp với "
        "công cụ chuyển văn bản thành giọng nói để trả lời bằng giọng.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "url": {"type": "string", "description":
                    "URL công khai hoặc đường dẫn tệp âm thanh local do text_to_speech trả về."},
            "ttl": {"type": "integer", "description": "Thời gian tự xoá (ms). 0 = không xoá."},
        },
        ["thread_id", "url"],
    ), zalo_send_voice, TOOLSET_PUBLIC),

    ("zalo_send_sticker", "🎨", _schema(
        "zalo_send_sticker",
        "Tìm và gửi một sticker Zalo theo từ khoá. Dùng cho câu chuyện nhẹ "
        "nhàng, chúc mừng, cảm ơn.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "keyword": {"type": "string", "description": "Từ khoá tìm sticker, ví dụ 'vui', 'cảm ơn'."},
        },
        ["thread_id", "keyword"],
    ), zalo_send_sticker, TOOLSET_PUBLIC),

    ("zalo_send_link", "🔗", _schema(
        "zalo_send_link",
        "Gửi một liên kết kèm thẻ xem trước (ảnh, tiêu đề) thay vì chỉ dán URL trần.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "url": {"type": "string", "description": "Liên kết cần gửi."},
            "message": {"type": "string", "description": "Lời nhắn đi kèm."},
        },
        ["thread_id", "url"],
    ), zalo_send_link, TOOLSET_PUBLIC),

    ("zalo_forward", "↪️", _schema(
        "zalo_forward",
        "Chuyển tiếp một tin nhắn sang nhiều hội thoại khác.",
        {
            "message": {"type": "string", "description": "Nội dung cần chuyển tiếp."},
            "thread_ids": {**_ZALO_ID_LIST, "description": "Danh sách hội thoại nhận."},
            "thread_kind": _THREAD_KIND,
        },
        ["message", "thread_ids"],
    ), zalo_forward, TOOLSET_OWNER),

    # --- Nhóm 2: đọc ngữ cảnh ---
    ("zalo_read_history", "📜", _schema(
        "zalo_read_history",
        "Đọc tin của một DM hoặc nhóm Zalo từ SQLite bền vững. Mặc định lấy `count` tin gần nhất. "
        "Muốn tổng hợp thảo luận (vd. 'tổng hợp nhóm hôm nay') thì truyền `since_hours`: công cụ đọc "
        "HẾT tin trong khoảng đó, trả từng dòng '[ngày giờ] Tên: nội dung'; nếu `con_nua` = true thì gọi "
        "lại với `cursor` = `next_cursor` cho tới hết rồi mới tổng hợp.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "count": {"type": "integer", "description": "Số tin gần nhất muốn đọc (tối đa 100, mặc định 30)."},
            "since_hours": {"type": "number", "description": "Đọc hết tin trong N giờ qua (tối đa 168). Dùng khi cần tổng hợp."},
            "cursor": {"type": "string", "description": "Đọc tiếp từ `next_cursor` của lần gọi trước (giữ nguyên since_hours)."},
        },
        ["thread_id"],
    ), zalo_read_history, TOOLSET_OWNER),

    ("zalo_group_history", "🗒️", _schema(
        "zalo_group_history",
        "Chỉ dùng trong việc hẹn giờ của nhóm: đọc các tin gần đây của chính nhóm "
        "mà việc hẹn giờ này gửi kết quả về, để tóm tắt hay nhắc lại cho đúng.",
        {"count": {"type": "integer", "description": "Số tin muốn đọc (tối đa 100, mặc định 30)."}},
        [],
    ), zalo_group_history, TOOLSET_CRON),

    ("zalo_list_groups", "👥", _schema(
        "zalo_list_groups",
        "Liệt kê các nhóm Zalo mà tài khoản này đang tham gia.",
        {}, [],
    ), zalo_list_groups, TOOLSET_OWNER),

    ("zalo_group_welcome", "👋", _schema(
        "zalo_group_welcome",
        "Bật, sửa hoặc tắt lời chào tự động khi có thành viên mới vào một nhóm. Sidecar gom người "
        "mới theo đợt: đủ batch_size người thì gửi MỘT tin tag tên tất cả họ rồi kèm lời chào; chưa "
        "đủ thì sau max_wait_minutes vẫn gửi cho những người đã vào. Tin chào là chữ cố định, bot "
        "không tự viết thêm. Tìm group_id bằng zalo_list_groups. Bỏ trống group_id để xem cấu hình "
        "hiện có của mọi nhóm.",
        {
            "group_id": {"type": "string", "description": "ID nhóm (từ zalo_list_groups). Bỏ trống để xem cấu hình."},
            "enabled": {"type": "boolean", "description": "Bật (true) hoặc tắt (false)."},
            "message": {"type": "string", "description": "Lời chào/lời nhắc đặt sau dòng tag tên. Không cần tự viết @tên."},
            "group_name": {"type": "string", "description": "Tên nhóm, để ghi nhớ cho dễ đọc."},
            "batch_size": {"type": "integer", "description": "Gom bao nhiêu người mới thì gửi một lần (1–20, mặc định 5)."},
            "max_wait_minutes": {"type": "integer", "description": "Chờ tối đa bao nhiêu phút nếu chưa đủ người (mặc định 15)."},
        },
        [],
    ), zalo_group_welcome, TOOLSET_OWNER),

    ("zalo_friend_group", "🧩", _schema(
        "zalo_friend_group",
        "Kết bạn rồi tạo nhóm. action=create: gửi lời mời kết bạn cho member_ids; người ĐẦU TIÊN "
        "đồng ý thì sidecar tự tạo nhóm group_name gồm người đó và chủ nhân, ai đồng ý sau được thêm "
        "vào nhóm; kết quả được báo lại chính cuộc trò chuyện này (không cần hẹn giờ kiểm tra). "
        "Người đã là bạn sẵn được tính là đồng ý ngay. action=list: xem các kế hoạch đang chờ. "
        "action=cancel: huỷ một kế hoạch theo plan_id. Kế hoạch tự hết hạn sau 30 ngày.",
        {
            "action": {"type": "string", "enum": ["create", "list", "cancel"], "description": "Mặc định list."},
            "member_ids": {"type": "array", "items": _ZALO_ID, "description": "UID những người cần kết bạn và đưa vào nhóm."},
            "member_names": {"type": "array", "items": {"type": "string"}, "description": "Tên hiển thị, cùng thứ tự member_ids — dùng trong thông báo."},
            "group_name": {"type": "string", "description": "Tên nhóm sẽ tạo."},
            "message": {"type": "string", "description": "Lời nhắn kèm lời mời kết bạn."},
            "plan_id": {"type": "string", "description": "Mã kế hoạch khi huỷ."},
            "include_closed": {"type": "boolean", "description": "list: xem cả kế hoạch đã xong/huỷ."},
        },
        [],
    ), zalo_friend_group, TOOLSET_OWNER),

    ("zalo_thread_history", "🔎", _schema(
        "zalo_thread_history",
        "Tra lịch sử tin nhắn THẬT của chính cuộc trò chuyện này (nhóm này, hoặc tin nhắn riêng này) từ kho SQLite. "
        "Dùng khi được hỏi chính xác về chuyện đã qua: 'hôm trước ai nói gì', 'ai đã gửi file X', 'bot trả lời gì hôm thứ Hai'. "
        "Tìm theo từ khoá `query` (không phân biệt dấu, khớp cả tên tệp), lọc theo tên người gửi `sender`, trong `days` ngày gần đây. "
        "Trả từng dòng '[ngày giờ] Tên: nội dung', cũ trước mới sau, tối đa 40 tin. Không đọc được nhóm hay người khác.",
        {
            "query": {"type": "string", "description": "Từ khoá cần tìm, ví dụ 'kế hoạch' hoặc 'bao cao.docx'. Bỏ trống = các tin gần nhất."},
            "sender": {"type": "string", "description": "Một phần tên người gửi, ví dụ 'Lan'."},
            "days": {"type": "integer", "description": "Tìm trong bao nhiêu ngày gần đây (1–30, mặc định 7)."},
            "limit": {"type": "integer", "description": "Số tin tối đa (1–40, mặc định 20)."},
        },
        [],
    ), zalo_thread_history, TOOLSET_PUBLIC),

    ("zalo_reply_style", "🎨", _schema(
        "zalo_reply_style",
        "CHỈ CHỦ NHÂN: xem/đổi CÀI ĐẶT cách trả lời của bot — xưng hô, giọng, độ dài, emoji, màu chữ, mẫu tên tệp, "
        "lời dặn thêm. Chủ nhân dặn kiểu \"từ giờ trả lời ngắn thôi\", \"gọi anh là sếp\", \"đừng tô màu đỏ\", "
        "\"tên file đừng thêm giờ\" thì đổi ở ĐÂY, KHÔNG ghi vào trí nhớ (memory) — trí nhớ chỉ để thông tin như "
        "thông tin cá nhân, link, giá. Gọi không tham số để xem cài đặt hiện tại; chỉ truyền mục cần đổi.",
        {
            "self_name": {"type": "string", "description": "Bot tự xưng (vd. 'em')."},
            "owner_name": {"type": "string", "description": "Gọi chủ nhân là gì (vd. 'sếp', 'anh')."},
            "others_name": {"type": "string", "description": "Gọi người khác là gì (vd. 'anh/chị', 'thầy cô')."},
            "tone": {"type": "string", "enum": ["friendly", "playful", "formal"]},
            "length": {"type": "string", "enum": ["short", "medium", "detailed"]},
            "emoji": {"type": "string", "enum": ["none", "few", "many"]},
            "colors": {"type": "array", "items": {"type": "string", "enum": ["red", "green", "orange", "yellow"]},
                       "description": "Các màu chữ được dùng."},
            "color_level": {"type": "string", "enum": ["none", "few", "normal"], "description": "Mức tô màu."},
            "file_name": {"type": "string", "enum": ["name_time", "name_date", "name"],
                          "description": "Tên tệp: Tên_YYYYMMDD-HHMMSS / Tên_YYYYMMDD / chỉ Tên."},
            "extra": {"type": "string", "description": "Lời dặn thêm về cách trả lời (tối đa 500 ký tự; '' để xoá)."},
            "auto_lookup": {"type": "boolean", "description": "Tự tra web trước khi trả lời câu hỏi cần thông tin mới (mặc định bật)."},
        },
        [],
    ), zalo_reply_style, TOOLSET_OWNER),

    ("zalo_memory_remember", "🧠", _schema(
        "zalo_memory_remember",
        "CHỈ CHỦ NHÂN: khi chủ nhân dặn \"nhớ giúp…\", ghi điều đó vào trí nhớ dài hạn của CHÍNH cuộc trò chuyện "
        "này (nhóm này, hoặc tin nhắn riêng này). Nhóm/người khác không thấy. Viết `text` thành một câu rõ nghĩa.",
        {"text": {"type": "string", "description": "Điều cần nhớ, một câu đầy đủ (tối đa 1000 ký tự)."}},
        ["text"],
    ), zalo_memory_remember, TOOLSET_OWNER),

    ("zalo_memory_forget", "🧽", _schema(
        "zalo_memory_forget",
        "CHỈ CHỦ NHÂN: khi chủ nhân dặn \"quên chuyện X đi\", xoá khỏi trí nhớ dài hạn của CHÍNH cuộc trò chuyện "
        "này. Gọi lần 1 với `query` để xem tối đa 5 mục khớp; gọi lần 2 với `uris` (lấy từ kết quả lần 1) để xoá.",
        {
            "query": {"type": "string", "description": "Chuyện cần quên, ví dụ 'mã tủ đồ'."},
            "uris": {"type": "array", "items": {"type": "string"}, "description": "URI các mục cần xoá (từ lần gọi trước)."},
        },
        [],
    ), zalo_memory_forget, TOOLSET_OWNER),

    ("zalo_group_members", "🧑‍🤝‍🧑", _schema(
        "zalo_group_members",
        "Xem danh sách thành viên một nhóm, kèm tên hiển thị.",
        {"thread_id": _GROUP_ID},
        ["thread_id"],
    ), zalo_group_members, TOOLSET_PUBLIC),

    ("zalo_find_user", "🔍", _schema(
        "zalo_find_user",
        "Tìm một người dùng Zalo theo số điện thoại hoặc tên đăng nhập.",
        {
            "phone": {"type": "string", "description": "Số điện thoại."},
            "username": {"type": "string", "description": "Tên đăng nhập Zalo."},
        },
        [],
    ), zalo_find_user, TOOLSET_OWNER),

    ("zalo_user_info", "👤", _schema(
        "zalo_user_info",
        "Xem hồ sơ một người dùng Zalo theo UID.",
        {"user_id": _ZALO_ID},
        ["user_id"],
    ), zalo_user_info, TOOLSET_OWNER),

    ("zalo_list_friends", "📇", _schema(
        "zalo_list_friends",
        "Liệt kê danh bạ bạn bè Zalo.",
        {}, [],
    ), zalo_list_friends, TOOLSET_OWNER),

    ("zalo_send_friend_request", "🤝", _schema(
        "zalo_send_friend_request",
        "Gửi lời mời kết bạn tới một người dùng Zalo theo UID (tìm UID bằng zalo_find_user hoặc "
        "zalo_group_members). Muốn kết bạn XONG rồi lập nhóm với họ thì dùng zalo_friend_group.",
        {
            "user_id": _ZALO_ID,
            "msg": {"type": "string", "description": "Lời nhắn kèm lời mời (mặc định: Xin chào, mình kết bạn nhé!)."},
        },
        ["user_id"],
    ), zalo_send_friend_request, TOOLSET_OWNER),

    ("zalo_accept_friend_request", "🫱", _schema(
        "zalo_accept_friend_request",
        "Đồng ý lời mời kết bạn mà một người đã gửi tới bot. Bot không bao giờ tự đồng ý — "
        "chỉ gọi khi chủ nhân bảo nhận người đó.",
        {"user_id": _ZALO_ID},
        ["user_id"],
    ), zalo_accept_friend_request, TOOLSET_OWNER),

    # --- Nhóm 3: tính năng riêng của Zalo ---
    ("zalo_create_poll", "🗳️", _schema(
        "zalo_create_poll",
        "Tạo một cuộc bình chọn trong nhóm Zalo. Hữu ích khi cần chốt lịch, "
        "lấy ý kiến tập thể.",
        {
            "group_id": _GROUP_ID,
            "question": {"type": "string", "description": "Câu hỏi bình chọn."},
            "options": {"type": "array", "items": {"type": "string"},
                        "description": "Các phương án, tối thiểu 2."},
            "multi_choice": {"type": "boolean", "description": "Cho chọn nhiều phương án."},
            "allow_add_option": {"type": "boolean", "description": "Cho người khác thêm phương án."},
            "anonymous": {"type": "boolean", "description": "Bình chọn kín."},
            "hide_preview": {"type": "boolean", "description": "Ẩn kết quả cho tới khi khoá."},
        },
        ["group_id", "question", "options"],
    ), zalo_create_poll, TOOLSET_OWNER),

    ("zalo_poll_detail", "📊", _schema(
        "zalo_poll_detail",
        "Xem kết quả một cuộc bình chọn: ai chọn gì, bao nhiêu phiếu.",
        {"poll_id": _ZALO_ID},
        ["poll_id"],
    ), zalo_poll_detail, TOOLSET_OWNER),

    ("zalo_lock_poll", "🔒", _schema(
        "zalo_lock_poll",
        "Khoá một cuộc bình chọn, không cho bỏ phiếu thêm.",
        {"poll_id": _ZALO_ID},
        ["poll_id"],
    ), zalo_lock_poll, TOOLSET_OWNER),

    ("zalo_vote_poll", "✅", _schema(
        "zalo_vote_poll",
        "Bot tự bỏ phiếu trong một cuộc bình chọn Zalo. Gọi zalo_poll_detail trước để lấy "
        "`option_id` của phương án; truyền danh sách rỗng để rút phiếu. Phiếu mới thay phiếu cũ "
        "của bot. Phương án chưa có thì dùng zalo_add_poll_options.",
        {
            "poll_id": _ZALO_ID,
            "option_ids": {"type": "array", "items": _ZALO_ID,
                           "description": "Mã phương án muốn chọn (option_id); rỗng = rút phiếu."},
        },
        ["poll_id", "option_ids"],
    ), zalo_vote_poll, TOOLSET_OWNER),

    ("zalo_add_poll_options", "➕", _schema(
        "zalo_add_poll_options",
        "Thêm phương án mới vào một cuộc bình chọn Zalo đang mở (bình chọn phải cho thêm phương án), "
        "có thể bỏ phiếu luôn cho phương án vừa thêm.",
        {
            "poll_id": _ZALO_ID,
            "options": {"type": "array", "items": {"type": "string"},
                        "description": "Nội dung các phương án mới."},
            "vote": {"type": "boolean", "description": "Bot bỏ phiếu cho phương án vừa thêm."},
            "keep_voted_option_ids": {"type": "array", "items": _ZALO_ID,
                                      "description": "Mã phương án bot đang chọn và muốn giữ phiếu (xem voted trong zalo_poll_detail)."},
        },
        ["poll_id", "options"],
    ), zalo_add_poll_options, TOOLSET_OWNER),

    ("zalo_create_note", "📌", _schema(
        "zalo_create_note",
        "Tạo ghi chú ghim ở đầu nhóm Zalo — nơi mọi thành viên đều thấy.",
        {
            "group_id": _GROUP_ID,
            "title": {"type": "string", "description": "Nội dung ghi chú."},
            "pin": {"type": "boolean", "description": "Ghim lên đầu nhóm. Mặc định có."},
        },
        ["group_id", "title"],
    ), zalo_create_note, TOOLSET_OWNER),

    ("zalo_create_reminder", "⏰", _schema(
        "zalo_create_reminder",
        "Đặt lời nhắc gốc của Zalo trong một hội thoại. Khác với cron của "
        "Hermes: lời nhắc này hiện ngay trong Zalo cho mọi thành viên thấy.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "title": {"type": "string", "description": "Nội dung nhắc."},
            "start_time": {"type": "integer",
                           "description": "Thời điểm nhắc, tính bằng mili giây kể từ epoch."},
            "repeat": {"type": "integer",
                       "description": "0 không lặp, 1 hằng ngày, 2 hằng tuần, 3 hằng tháng."},
        },
        ["thread_id", "title", "start_time"],
    ), zalo_create_reminder, TOOLSET_PUBLIC),

    ("zalo_list_reminders", "🔔", _schema(
        "zalo_list_reminders",
        "Xem các lời nhắc đang đặt trong một hội thoại.",
        {"thread_id": _THREAD_ID, "thread_kind": _THREAD_KIND},
        ["thread_id"],
    ), zalo_list_reminders, TOOLSET_PUBLIC),

    ("zalo_remove_reminder", "🗑️", _schema(
        "zalo_remove_reminder",
        "Xoá một lời nhắc đã đặt. Dùng khi đặt nhầm giờ hoặc việc đã xong.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "reminder_id": _ZALO_ID,
        },
        ["thread_id", "reminder_id"],
    ), zalo_remove_reminder, TOOLSET_PUBLIC),

    ("zalo_pin_conversation", "📍", _schema(
        "zalo_pin_conversation",
        "Ghim hoặc bỏ ghim một hội thoại lên đầu danh sách chat.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "pinned": {"type": "boolean", "description": "true để ghim, false để bỏ."},
        },
        ["thread_id"],
    ), zalo_pin_conversation, TOOLSET_OWNER),

    ("zalo_mute", "🔕", _schema(
        "zalo_mute",
        "Tắt hoặc bật lại thông báo của một hội thoại.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "muted": {"type": "boolean", "description": "true để tắt thông báo."},
            "duration": {"type": "integer",
                         "description": "Số giây tắt. -1 là vĩnh viễn (mặc định)."},
        },
        ["thread_id"],
    ), zalo_mute, TOOLSET_OWNER),

    # --- Nhóm 4: sửa sai & quản trị ---
    ("zalo_undo", "↩️", _schema(
        "zalo_undo",
        "Thu hồi một tin do chính bot gửi. Bỏ trống mã tin để thu hồi tin "
        "gần nhất của bot trong hội thoại; có thể truyền msg_id/cli_msg_id cụ thể.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "msg_id": _ZALO_ID,
            "cli_msg_id": _ZALO_ID,
        },
        ["thread_id"],
    ), zalo_undo, TOOLSET_OWNER),

    ("zalo_rename_group", "✏️", _schema(
        "zalo_rename_group",
        "Đổi tên một nhóm Zalo. Cần quyền quản trị nhóm.",
        {
            "group_id": _GROUP_ID,
            "name": {"type": "string", "description": "Tên mới."},
        },
        ["group_id", "name"],
    ), zalo_rename_group, TOOLSET_OWNER),

    ("zalo_group_member_change", "🚪", _schema(
        "zalo_group_member_change",
        "Thêm hoặc xoá thành viên khỏi nhóm. Cần quyền quản trị. Việc này ảnh "
        "hưởng tới người thật — hãy xác nhận với chủ trước khi làm.",
        {
            "group_id": _GROUP_ID,
            "user_ids": {**_ZALO_ID_LIST, "description": "Danh sách UID."},
            "action": {"type": "string", "enum": ["add", "remove"]},
        },
        ["group_id", "user_ids", "action"],
    ), zalo_group_member_change, TOOLSET_OWNER),

    ("zalo_group_deputy", "🎖️", _schema(
        "zalo_group_deputy",
        "Trao hoặc thu hồi quyền phó nhóm cho một thành viên.",
        {
            "group_id": _GROUP_ID,
            "user_id": _ZALO_ID,
            "action": {"type": "string", "enum": ["add", "remove"]},
        },
        ["group_id", "user_id", "action"],
    ), zalo_group_deputy, TOOLSET_OWNER),

    ("zalo_pending_members", "📥", _schema(
        "zalo_pending_members",
        "Xem danh sách người đang chờ được duyệt vào nhóm.",
        {"group_id": _GROUP_ID},
        ["group_id"],
    ), zalo_pending_members, TOOLSET_OWNER),

    ("zalo_review_member", "✅", _schema(
        "zalo_review_member",
        "Duyệt hoặc từ chối người xin vào nhóm.",
        {
            "group_id": _GROUP_ID,
            "user_ids": _ZALO_ID_LIST,
            "approve": {"type": "boolean", "description": "true là duyệt, false là từ chối."},
        },
        ["group_id", "user_ids"],
    ), zalo_review_member, TOOLSET_OWNER),

    # --- Nhóm 5: lập nhóm & lời mời ---
    ("zalo_create_group", "🆕", _schema(
        "zalo_create_group",
        "Lập một nhóm Zalo mới với danh sách thành viên cho trước. Dùng khi "
        "cần một chỗ riêng cho một việc cụ thể. Việc này tạo ra nhóm thật và "
        "gửi thông báo tới từng người — hãy xác nhận với chủ trước khi làm.",
        {
            "member_ids": {
                **_ZALO_ID_LIST,
                "description": "UID những người sẽ được thêm vào. Bắt buộc, không được rỗng.",
            },
            "name": {"type": "string", "description": "Tên nhóm."},
            "avatar_path": {"type": "string", "description": "Đường dẫn ảnh đại diện nhóm."},
        },
        ["member_ids"],
    ), zalo_create_group, TOOLSET_OWNER),

    ("zalo_invite_to_groups", "✉️", _schema(
        "zalo_invite_to_groups",
        "Mời một người vào một hoặc nhiều nhóm cùng lúc. Gửi lời mời thật tới "
        "người đó — hãy hỏi chủ trước.",
        {
            "user_id": _ZALO_ID,
            "group_ids": {**_ZALO_ID_LIST, "description": "Các nhóm muốn mời vào."},
        },
        ["user_id", "group_ids"],
    ), zalo_invite_to_groups, TOOLSET_OWNER),

    ("zalo_group_link", "🔗", _schema(
        "zalo_group_link",
        "Xem, bật hoặc tắt link mời của một nhóm. Dùng `action` = 'detail' để "
        "lấy link hiện có, 'enable' để bật, 'disable' để thu hồi.",
        {
            "group_id": _GROUP_ID,
            "action": {"type": "string", "enum": ["detail", "enable", "disable"],
                       "description": "Mặc định 'detail'."},
        },
        ["group_id"],
    ), zalo_group_link, TOOLSET_OWNER),

    ("zalo_join_group_link", "🚪", _schema(
        "zalo_join_group_link",
        "Tham gia một nhóm Zalo bằng link mời. Sau khi vào, tài khoản bot sẽ "
        "đọc được tin nhắn của nhóm đó.",
        {"link": {"type": "string", "description": "Link mời nhóm Zalo."}},
        ["link"],
    ), zalo_join_group_link, TOOLSET_OWNER),

    # --- Nhóm 6: hồ sơ tài khoản bot ---
    ("zalo_set_bio", "📝", _schema(
        "zalo_set_bio",
        "Đổi dòng mô tả trên hồ sơ Zalo của chính tài khoản bot. Truyền chuỗi "
        "rỗng để xoá.",
        {"bio": {"type": "string", "description": "Nội dung mô tả mới."}},
        ["bio"],
    ), zalo_set_bio, TOOLSET_OWNER),

    ("zalo_set_active_status", "🟢", _schema(
        "zalo_set_active_status",
        "Bật hoặc tắt hiển thị trạng thái đang hoạt động của tài khoản bot. "
        "Tắt đi thì người khác không thấy bot online.",
        {"active": {"type": "boolean", "description": "true là hiện, false là ẩn."}},
        ["active"],
    ), zalo_set_active_status, TOOLSET_OWNER),

    # --- Nhóm 7: kho tài liệu tư vấn ---
    ("zalo_kb_list", "📚", _schema(
        "zalo_kb_list",
        "Liệt kê tài liệu trong kho tri thức để tư vấn (sản phẩm, dịch vụ, "
        "hướng dẫn). Gọi công cụ này trước để biết có những tệp nào, rồi mới "
        "đọc tệp phù hợp bằng zalo_kb_read. Chỉ dùng khi câu hỏi thật sự cần "
        "tra tài liệu — chuyện trò thông thường thì trả lời thẳng.",
        {"query": {"type": "string",
                   "description": "Lọc theo tên tệp, ví dụ 'gia' hay 'huong-dan'. Để trống là liệt kê tất cả."}},
        [],
    ), zalo_kb_list, TOOLSET_PUBLIC),

    ("zalo_kb_read", "📖", _schema(
        "zalo_kb_read",
        "Đọc một tệp trong kho tài liệu tư vấn. Đường dẫn lấy từ zalo_kb_list. "
        "Chỉ đọc được tệp văn bản nằm trong kho, không ra ngoài được.",
        {"path": {"type": "string",
                  "description": "Đường dẫn tương đối trong kho, ví dụ 'docs/bang-gia.md'."}},
        ["path"],
    ), zalo_kb_read, TOOLSET_PUBLIC),

    # --- Nhóm 8: tra cứu Internet ---
    ("zalo_web_search", "🔎", _schema(
        "zalo_web_search",
        "Tìm kiếm trên Internet. Dùng khi câu hỏi cần thông tin mới hoặc nằm "
        "ngoài kiến thức sẵn có và kho tài liệu.",
        {
            "query": {"type": "string", "description": "Nội dung cần tìm."},
            "limit": {"type": "integer", "description": "Số kết quả, 1-10. Mặc định 5."},
        },
        ["query"],
    ), zalo_web_search, TOOLSET_PUBLIC),

    ("zalo_web_read", "🌐", _schema(
        "zalo_web_read",
        "Đọc nội dung một hoặc vài trang web theo địa chỉ, kể cả link Google "
        "Docs/Sheets/Slides đã bật chia sẻ công khai. Chỉ đọc được địa chỉ công "
        "cộng http/https, tối đa 5 trang mỗi lần. Link video (YouTube, TikTok…) "
        "thì dùng zalo_video_info.",
        {
            "url": {"type": "string", "description": "Địa chỉ trang cần đọc."},
            "urls": {"type": "array", "items": {"type": "string"},
                     "description": "Nhiều địa chỉ cùng lúc, tối đa 5."},
        },
        [],
    ), zalo_web_read, TOOLSET_PUBLIC),

    ("zalo_academic_search", "🔬", _schema(
        "zalo_academic_search",
        "Tra bài báo khoa học đã bình duyệt. Câu hỏi về y tế, sức khoẻ, thuốc, bệnh, dinh dưỡng, "
        "sinh học → dùng công cụ này TRƯỚC web search (source=pubmed). Hoá học, môi trường, giáo dục, "
        "kỹ thuật, mọi ngành → source=openalex (phủ rộng, có số trích dẫn và link PDF mở); cần bài có "
        "sẵn PDF toàn văn → source=core; crossref để tra theo thông tin thư mục; vật lý, toán, tin học, thống kê (bản thảo mới nhất, chưa chắc bình duyệt — nói rõ khi trích) → source=arxiv; y sinh cần cả bản thảo, bằng sáng chế, cờ toàn văn mở → source=europepmc. Dịch câu hỏi sang "
        "2–4 từ khoá tiếng Anh. action=find_pdf tìm bản PDF miễn phí hợp pháp của một DOI; "
        "action=fulltext đọc toàn văn bài trên PubMed Central (DOI hoặc PMCID); action=journal tra "
        "tạp chí trên DOAJ theo ISSN hoặc tên (không có trong DOAJ không có nghĩa là tạp chí kém — "
        "tạp chí thu phí, hybrid không vào DOAJ); action=cite tạo trích dẫn chuẩn (APA, Vancouver…) "
        "từ DOI. Trả lời bằng tiếng Việt, dẫn tác giả (năm) và link cho từng ý; chỉ dẫn bài công cụ "
        "trả về, không tự bịa. Thông tin y tế chỉ để tham khảo — nhắc người hỏi gặp bác sĩ khi cần.",
        {
            "action": {"type": "string", "enum": ["search", "cite", "find_pdf", "fulltext", "journal"],
                       "description": "Mặc định search."},
            "query": {"type": "string", "description": "search: từ khoá tiếng Anh, vd. 'biochar cadmium soil'. "
                                                      "journal: ISSN hoặc tên tạp chí. fulltext: PMCID."},
            "source": {"type": "string", "enum": ["pubmed", "openalex", "core", "crossref", "arxiv", "europepmc"],
                       "description": "Mặc định pubmed."},
            "limit": {"type": "integer", "description": "Số bài, 1–10. Mặc định 5."},
            "abstracts": {"type": "boolean", "description": "Kèm tóm tắt (trừ crossref). Mặc định có."},
            "doi": {"type": "string", "description": "Cho action=cite/find_pdf/fulltext, vd. 10.1038/s41586-020-2649-2."},
            "style": {"type": "string", "enum": ["apa", "ieee", "vancouver", "harvard", "chicago", "mla"],
                      "description": "Cho action=cite. Mặc định apa."},
        },
        [],
    ), zalo_academic_search, TOOLSET_PUBLIC),

    ("zalo_weather", "🌤️", _schema(
        "zalo_weather",
        "Thời tiết hiện tại và dự báo tới 7 ngày cho một địa danh (giờ Việt Nam): trời, nhiệt độ, cảm giác như, "
        "độ ẩm, khả năng mưa, lượng mưa, gió, chỉ số UV. Dùng công cụ này TRƯỚC web search khi được hỏi thời tiết. "
        "Trả lời ngắn bằng tiếng Việt, ghi nguồn Open-Meteo.",
        {
            "place": {"type": "string", "description": "Tên tỉnh/thành/địa danh, vd. 'Hải Phòng', 'Đà Lạt', 'Tokyo'."},
            "days": {"type": "integer", "description": "Số ngày dự báo, 1–7. Mặc định 3."},
        },
        ["place"],
    ), zalo_weather, TOOLSET_PUBLIC),

    ("zalo_exchange_rate", "💱", _schema(
        "zalo_exchange_rate",
        "Tỷ giá và quy đổi tiền tệ mới nhất (có VND), mã ISO 3 chữ: USD, VND, EUR, JPY, CNY, KRW, GBP, THB… "
        "Dùng TRƯỚC web search khi được hỏi tỷ giá hay quy đổi tiền. Là tỷ giá tham chiếu, không phải giá mua/bán "
        "của ngân hàng hay chợ đen — nói rõ điều này. Không có giá vàng.",
        {
            "base": {"type": "string", "description": "Đồng tiền gốc, vd. USD."},
            "target": {"type": "string", "description": "Đồng tiền đích, vd. VND."},
            "amount": {"type": "number", "description": "Số tiền cần đổi. Mặc định 1."},
        },
        ["base", "target"],
    ), zalo_exchange_rate, TOOLSET_PUBLIC),

    ("zalo_dictionary", "📖", _schema(
        "zalo_dictionary",
        "Tra từ điển: tiếng Anh (mặc định) có phiên âm, nghĩa theo từ loại, ví dụ, đồng nghĩa/trái nghĩa, link "
        "audio phát âm; thứ tiếng khác (lang=vi, fr, ja, zh…) tra qua Wiktionary. Dùng khi học sinh hỏi nghĩa, "
        "cách đọc, cách dùng một từ. Giải thích lại bằng tiếng Việt.",
        {
            "word": {"type": "string", "description": "Từ hoặc cụm từ ngắn, vd. 'resilient'."},
            "lang": {"type": "string", "description": "Mã ngôn ngữ của từ: en (mặc định), vi, fr, ja, zh, ko…"},
        },
        ["word"],
    ), zalo_dictionary, TOOLSET_PUBLIC),

    ("zalo_species", "🌿", _schema(
        "zalo_species",
        "Tra một loài sinh vật (cây, con vật, nấm…): tên khoa học, tên thường gọi, ảnh, số quan sát, phân loại "
        "giới → ngành → lớp → bộ → họ → chi, link Wikipedia. Nguồn iNaturalist + GBIF. QUAN TRỌNG: nguồn này "
        "gần như không hiểu tên tiếng Việt — tự đổi sang tên khoa học (vd. hoa sen → Nelumbo nucifera, cá chép → "
        "Cyprinus carpio) hoặc tên tiếng Anh rồi mới gọi; xem `other_matches` để chắc đúng loài.",
        {
            "name": {"type": "string", "description": "Tên khoa học hoặc tên tiếng Anh, vd. 'Nelumbo nucifera'."},
        },
        ["name"],
    ), zalo_species, TOOLSET_PUBLIC),

    ("zalo_video_info", "🎬", _schema(
        "zalo_video_info",
        "Đọc thông tin một video YouTube, TikTok, Facebook, Instagram, X, Vimeo "
        "hoặc Dailymotion: tiêu đề, kênh, thời lượng, mô tả và phụ đề/lời thoại "
        "nếu có — dùng để hiểu và tóm tắt video. Không tải video về. Đây là "
        "việc mặc định khi có người gửi link video.",
        {
            "url": {"type": "string", "description": "Link video."},
            "transcript": {"type": "boolean",
                           "description": "Lấy phụ đề/lời thoại. Mặc định có; tắt nếu chỉ cần tiêu đề."},
        },
        ["url"],
    ), zalo_video_info, TOOLSET_PUBLIC),

    ("zalo_video_ghep", "✂️", _schema(
        "zalo_video_ghep",
        "Cắt và GHÉP ĐƠN THUẦN nhiều đoạn video thành một video rồi tự gửi vào cuộc trò chuyện (chạy nền, tự nhắn "
        "chờ). Nguồn: link video hoặc video người dùng gửi vào Zalo. Tự đưa các đoạn về cùng khổ (dọc/ngang theo đa "
        "số, hình lệch tỉ lệ đặt trên nền mờ). KHÔNG có hiệu ứng: người dùng muốn phụ đề, nhạc nền, logo hay hiệu ứng "
        "chuyển cảnh thì dùng zalo_video_edit. Chỉ cắt một đoạn từ MỘT link thì dùng zalo_video_download (start/end). "
        "Người trong nhóm: tối đa 5 đoạn, tổng 10 phút, 3 lần mỗi giờ.",
        {"doan": {"type": "array", "maxItems": 10, "description": "Các đoạn theo đúng thứ tự ghép. Mỗi đoạn: `url` (link video) HOẶC `tep` (video người dùng gửi vào Zalo, đếm từ 1 theo thứ tự gửi), kèm `start`/`end` (giây hoặc phút:giây) nếu chỉ lấy một phần.", "items": {"type": "object", "properties": {"url": {"type": "string"}, "tep": {"type": "integer", "minimum": 1}, "start": {"type": "string"}, "end": {"type": "string"}}, "additionalProperties": False}},
          "caption": {"type": "string", "description": "Lời nhắn kèm video (tuỳ chọn)."}},
        ["doan"],
    ), zalo_video_ghep, TOOLSET_PUBLIC),

    ("zalo_video_edit", "🎞️", _schema(
        "zalo_video_edit",
        "Sửa video: cắt ghép các đoạn KÈM phụ đề, nhạc nền, logo và/hoặc hiệu ứng chuyển cảnh, rồi tự gửi vào cuộc "
        "trò chuyện (chạy nền, tự nhắn chờ). Ghép đơn thuần thì dùng zalo_video_ghep. Phụ đề: tự soạn các câu kèm mốc "
        "theo video KẾT QUẢ (video YouTube có phụ đề thì đọc lời và mốc bằng zalo_video_info trước); hiện chữ vàng viền "
        "đen font Phudu. Logo, nhạc: tệp người dùng gửi (ảnh / tệp nhạc, đếm từ 1) hoặc link nhạc. Người trong nhóm: "
        "tối đa 5 đoạn, tổng 10 phút, 3 lần mỗi giờ.",
        {"doan": {"type": "array", "maxItems": 10, "description": "Các đoạn theo đúng thứ tự ghép. Mỗi đoạn: `url` (link video) HOẶC `tep` (video người dùng gửi vào Zalo, đếm từ 1 theo thứ tự gửi), kèm `start`/`end` (giây hoặc phút:giây) nếu chỉ lấy một phần.", "items": {"type": "object", "properties": {"url": {"type": "string"}, "tep": {"type": "integer", "minimum": 1}, "start": {"type": "string"}, "end": {"type": "string"}}, "additionalProperties": False}},
          "chuyen_canh": {"type": "string", "enum": ["khong", "mo", "truot", "xoa", "tron", "phong"],
                          "description": "Hiệu ứng chuyển giữa các đoạn: mo (mờ dần), truot (trượt), xoa (lau ngang), "
                                         "tron (mở vòng tròn), phong (phóng to)."},
          "logo_tep": {"type": "integer", "minimum": 1, "description": "Ảnh logo người dùng gửi (đếm từ 1)."},
          "logo_vi_tri": {"type": "string", "enum": ["tren-phai", "tren-trai", "duoi-phai", "duoi-trai"]},
          "nhac_tep": {"type": "integer", "minimum": 1, "description": "Tệp nhạc người dùng gửi (đếm từ 1)."},
          "nhac_url": {"type": "string", "description": "Link YouTube/TikTok… lấy tiếng làm nhạc nền."},
          "am_luong_nhac": {"type": "integer", "minimum": 0, "maximum": 100, "description": "Âm lượng nhạc nền, mặc định 25."},
          "tat_tieng_goc": {"type": "boolean", "description": "Tắt tiếng gốc của video (chỉ còn nhạc nền)."},
          "phu_de": {"type": "array", "maxItems": 300, "description": "Phụ đề theo mốc của video kết quả.",
                     "items": {"type": "object", "properties": {"tu": {"type": "string"}, "den": {"type": "string"},
                                                               "chu": {"type": "string"}},
                               "required": ["tu", "den", "chu"], "additionalProperties": False}},
          "caption": {"type": "string", "description": "Lời nhắn kèm video (tuỳ chọn)."}},
        ["doan"],
    ), zalo_video_edit, TOOLSET_PUBLIC),

    ("zalo_video_download", "⬇️", _schema(
        "zalo_video_download",
        "Tải video (Full HD, không logo TikTok) rồi gửi tệp vào cuộc trò chuyện "
        "này; CẮT ĐƯỢC một đoạn: truyền start/end thì chỉ tải và gửi đúng đoạn đó "
        "(nhanh hơn tải cả video — video dài mà chỉ cần một đoạn thì luôn truyền "
        "start/end). CHỈ gọi khi người dùng nói rõ muốn tải/lấy/cắt file video — "
        "gửi link hay nhờ tóm tắt thì dùng zalo_video_info. Người trong nhóm: "
        "video (hoặc đoạn cắt) tối đa 20 phút, 300 MB, 3 lần mỗi giờ.",
        {
            "url": {"type": "string", "description": "Link video."},
            "caption": {"type": "string", "description": "Lời nhắn kèm tệp (tuỳ chọn)."},
            "start": {"type": "string", "description": "Mốc bắt đầu đoạn cắt: số giây (80) hoặc phút:giây (1:20) "
                                                        "/ giờ:phút:giây. Bỏ trống = từ đầu. Người dùng viết "
                                                        "\"1.20\" hay \"1p20\" thường là 1 phút 20 giây → \"1:20\"."},
            "end": {"type": "string", "description": "Mốc kết thúc đoạn cắt, cùng cách viết. Bỏ trống = đến hết video."},
        },
        ["url"],
    ), zalo_video_download, TOOLSET_PUBLIC),

    # --- Nhóm 9: sổ hồ sơ người quen ---
    ("zalo_remember_person", "🧠", _schema(
        "zalo_remember_person",
        "Ghi nhớ thông tin người đang trò chuyện để lần sau xưng hô và tư vấn "
        "cho đúng. Gọi khi họ tự giới thiệu — tên, công việc, lĩnh vực, sở "
        "thích, nhu cầu. Chỉ lưu điều họ tự nói ra, đừng suy đoán. Không lưu "
        "thông tin nhạy cảm như số tài khoản hay mật khẩu. Điều ghi ở cuộc trò chuyện nào "
        "chỉ được dùng lại ở chính cuộc trò chuyện đó và khi nhắn riêng với người đó.",
        {
            "name": {"type": "string", "description": "Tên hoặc cách xưng hô họ muốn."},
            "note": {"type": "string", "description": "Ghi chú ngắn về họ."},
            "fields": {"type": "object",
                       "description": "Các mục rời, ví dụ {\"lĩnh vực\": \"kỹ thuật\", \"đơn vị\": \"phòng IT\"}."},
            "user_id": _ZALO_ID,
        },
        [],
    ), zalo_remember_person, TOOLSET_PUBLIC),

    ("zalo_recall_person", "🔖", _schema(
        "zalo_recall_person",
        "Xem lại hồ sơ đã lưu của một người. Thường không cần gọi — hồ sơ của "
        "người đang nhắn đã được kẹp sẵn vào đầu cuộc trò chuyện.",
        {"user_id": _ZALO_ID},
        [],
    ), zalo_recall_person, TOOLSET_PUBLIC),

    ("zalo_list_people", "📒", _schema(
        "zalo_list_people",
        "Liệt kê những người bot đã ghi nhớ, mới nhất trước.",
        {"limit": {"type": "integer", "description": "Số hồ sơ, tối đa 200. Mặc định 50."}},
        [],
    ), zalo_list_people, TOOLSET_OWNER),

    ("zalo_forget_person", "🗑️", _schema(
        "zalo_forget_person",
        "Xoá hồ sơ một người khỏi sổ nhớ.",
        {"user_id": _ZALO_ID},
        ["user_id"],
    ), zalo_forget_person, TOOLSET_OWNER),
]


DANGEROUS_TOOL_NAMES = frozenset({
    "zalo_lock_poll", "zalo_pin_conversation", "zalo_mute", "zalo_undo",
    "zalo_rename_group", "zalo_group_member_change", "zalo_group_deputy",
    "zalo_review_member", "zalo_create_group", "zalo_invite_to_groups",
    "zalo_group_link", "zalo_join_group_link", "zalo_set_bio",
    "zalo_set_active_status", "zalo_friend_group",
})

# Kết bạn: gửi hàng loạt dễ bị Zalo khoá tính năng, nên chỉ đăng ký khi chủ bot
# bật ZALO_FRIEND_TOOLS=true (sidecar cũng kiểm lại công tắc này).
FRIEND_TOOL_NAMES = frozenset({"zalo_send_friend_request", "zalo_accept_friend_request", "zalo_friend_group"})


def _friend_tools_enabled() -> bool:
    return str(os.getenv("ZALO_FRIEND_TOOLS") or "").strip().lower() in {"1", "true", "yes", "on"}

_CONFIRM_SCHEMA = {
    "type": "string",
    "pattern": "^[A-F0-9]{6}$",
    "description": "Chỉ dùng khi lần gọi trước trả về confirmation_required: truyền đúng mã sáu ký tự đó sau khi chủ nhân nhắn XÁC NHẬN <MÃ>.",
}

# `detail` của zalo_group_link chỉ đọc nên không cần mã; hai action `enable`
# và `disable` được kiểm tra lúc thực thi. Mã không bắt buộc ở schema: mặc định
# không cần mã, còn khi bật thì lần gọi đầu phải tạo challenge thay vì bị JSON
# Schema chặn trước handler.
for _name, _emoji, _tool_schema, _handler, _toolset in TOOLS:
    if _name not in DANGEROUS_TOOL_NAMES:
        continue
    _parameters = _tool_schema["parameters"]
    _properties = _parameters.setdefault("properties", {})
    _properties.pop("confirm", None)
    _properties["confirmation_code"] = dict(_CONFIRM_SCHEMA)
    _parameters["required"] = [item for item in _parameters["required"] if item != "confirm"]


# Hai công cụ này chỉ chạy trong tin nhắn riêng. Trong nhóm, tin của mọi thành
# viên cùng nằm trong ngữ cảnh một phiên — ai đó thả vào nhóm một đoạn chữ soạn
# sẵn là có thể lái mô hình mà chủ nhân không hề biết. Nhắn riêng thì ngữ cảnh
# chỉ có lời chủ nhân.
DM_ONLY_TOOLS = frozenset({"zalo_fb_draft", "zalo_fb_publish"})


def _confirmation_required(tool_name: str, args: Dict[str, Any]) -> bool:
    if tool_name == "zalo_group_link":
        return str(args.get("action") or "detail").lower() in {"enable", "disable"}
    if tool_name == "zalo_friend_group":
        # Chỉ lập kế hoạch mới dẫn tới tạo nhóm; xem/huỷ thì không.
        return str(args.get("action") or "list").lower() == "create"
    return tool_name in DANGEROUS_TOOL_NAMES


def _confirmation_codes_enabled() -> bool:
    """Có bắt chủ nhân gửi lại mã xác nhận cho thao tác nguy hiểm không (mặc định: không).

    Tắt thì chủ nhân nhắn là bot làm luôn, trong nhóm hay nhắn riêng đều vậy —
    người ngoài vẫn không chạm được vì các công cụ này chỉ nằm trong bộ của chủ
    và sidecar kiểm lại lần nữa. Bật ``ZALO_CONFIRM_DANGEROUS=true`` thì mỗi thao
    tác cần chủ nhân gửi lại ``XÁC NHẬN <MÃ>``, chặn thêm trường hợp tài liệu hay
    trang web bot đọc có cài lệnh ẩn dụ bot tự làm ngay trong lượt chat của chủ.
    Đọc lúc gọi chứ không lúc nạp module, để đổi .env rồi khởi động lại là ăn.
    """
    return str(os.getenv("ZALO_CONFIRM_DANGEROUS") or "").strip().lower() in {"1", "true", "yes", "on"}


def _confirmed_action(handler, tool_name: str):
    async def guarded(args: Dict[str, Any], **kw) -> str:
        call_args = dict(args)
        required = _confirmation_required(tool_name, call_args)
        confirmed = False
        if required and not _confirmation_codes_enabled():
            if not _turn().get("is_owner"):
                return _err("thao tác này chỉ chủ nhân mới được thực hiện")
            if tool_name == "zalo_undo":
                call_args = _with_quoted_undo_target(call_args)
            confirmed = True
        elif required:
            turn = _turn()
            if not turn.get("is_owner"):
                return _err("thao tác này chỉ chủ nhân mới được xác nhận")
            now = time.monotonic()
            for pending_key, pending in list(_PENDING_CONFIRMATIONS.items()):
                if pending["expires_at"] <= now:
                    _PENDING_CONFIRMATIONS.pop(pending_key, None)
            actor = str(turn.get("sender_uid") or "")
            thread = str(turn.get("thread_id") or "")
            key = (actor, thread, tool_name)
            pending = _PENDING_CONFIRMATIONS.get(key)
            if tool_name == "zalo_undo":
                call_args = _with_quoted_undo_target(call_args)
                if (pending and not call_args.get("msg_id") and not call_args.get("cli_msg_id")):
                    previous = pending.get("arguments") or {}
                    same_destination = all(
                        str(call_args.get(name) or "") == str(previous.get(name) or "")
                        for name in ("thread_id", "thread_kind")
                    )
                    if same_destination and previous.get("msg_id") and previous.get("cli_msg_id"):
                        call_args["msg_id"] = previous["msg_id"]
                        call_args["cli_msg_id"] = previous["cli_msg_id"]
            normalized_args = {
                name: value for name, value in call_args.items()
                if name not in {"confirm", "confirmation_code"}
            }
            fingerprint = hashlib.sha256(
                json.dumps(normalized_args, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
            ).hexdigest()
            supplied = str(call_args.get("confirmation_code") or "").strip().upper()
            phrase = f"XÁC NHẬN {supplied}" if supplied else ""
            # Gộp khoảng trắng: gõ trên điện thoại hay lọt dấu cách đôi.
            human_text = " ".join(str(turn.get("text") or "").split()).upper()
            if (pending and supplied and secrets.compare_digest(supplied, pending["code"])
                    and secrets.compare_digest(fingerprint, pending["fingerprint"])
                    and phrase == human_text):
                _PENDING_CONFIRMATIONS.pop(key, None)
                confirmed = True
            else:
                if not pending or pending["fingerprint"] != fingerprint:
                    pending = {
                        "code": secrets.token_hex(3).upper(),
                        "fingerprint": fingerprint,
                        "arguments": normalized_args,
                        "expires_at": now + _CONFIRMATION_TTL_SECONDS,
                    }
                    _PENDING_CONFIRMATIONS[key] = pending
                return json.dumps({
                    "success": False,
                    "error": f"Cần chủ nhân gửi một tin nhắn mới: XÁC NHẬN {pending['code']}",
                    "confirmation_required": True,
                    "confirmation_code": pending["code"],
                }, ensure_ascii=False)
        token = _CONFIRMED.set(confirmed)
        try:
            return await handler(call_args, **kw)
        finally:
            _CONFIRMED.reset(token)

    guarded.__name__ = getattr(handler, "__name__", tool_name)
    guarded.__doc__ = getattr(handler, "__doc__", None)
    return guarded


def _dm_only(handler, tool_name: str):
    async def guarded(args: Dict[str, Any], **kw) -> str:
        turn = _turn()
        if turn and turn.get("is_group"):
            logger.info("[zalo] chặn %s — chỉ dùng được khi nhắn riêng", tool_name)
            return _err("việc này chỉ làm được khi nhắn riêng với mình, "
                        "không làm trong nhóm")
        return await handler(args, **kw)

    guarded.__name__ = getattr(handler, "__name__", tool_name)
    guarded.__doc__ = getattr(handler, "__doc__", None)
    return guarded



def _owner_only(handler, tool_name: str):
    """Bọc một công cụ để chỉ chủ nhân gọi được.

    Đây mới là rào chắn thật. Việc chia toolset chỉ giấu công cụ khỏi danh
    sách — mà Hermes lại tự bật mọi toolset của plugin trừ khi bị tắt tường
    minh, nên không thể trông cậy vào nó một mình. Kiểm tra ngay tại điểm
    thực thi thì dù công cụ có lọt vào danh sách, người ngoài gọi vẫn bị từ
    chối.
    """
    async def guarded(args: Dict[str, Any], **kw) -> str:
        turn = _turn()
        if not turn.get("is_owner"):
            logger.info("[zalo] chặn %s — %s không phải chủ nhân",
                        tool_name, turn.get("sender_uid"))
            return _err("công cụ này chỉ chủ nhân dùng được")
        return await handler(args, **kw)

    guarded.__name__ = getattr(handler, "__name__", tool_name)
    guarded.__doc__ = getattr(handler, "__doc__", None)
    return guarded


_PUBLIC_TOOL_NAMES = frozenset(name for name, _e, _s, _h, toolset in TOOLS if toolset == TOOLSET_PUBLIC)
# Hai cầu nối chỉ đọc của Tool Search. ``tool_call`` thì xét công cụ thật bên trong.
_TOOL_SEARCH_READS = frozenset({"tool_search", "tool_describe"})


def _busy_input_injects() -> bool:
    """Hermes có thể chèn tin mới vào lượt đang chạy không (``interrupt``/``steer``).

    Chế độ ``queue`` thì tin mới chờ thành lượt riêng, không lẫn vào lượt này.
    Chỉ tin là ``queue`` khi cả biến môi trường gateway đặt lúc khởi động lẫn
    config.yaml hiện tại đều nói vậy: lệnh ``/busy`` đổi config lúc đang chạy mà
    không đổi biến môi trường. Lệch nhau hoặc không đọc được thì coi như có chèn
    — thà hạ quyền nhầm còn hơn.
    """
    modes = []
    env_mode = os.getenv("HERMES_GATEWAY_BUSY_INPUT_MODE", "")
    if env_mode:
        modes.append(env_mode)
    try:
        from hermes_cli.config import load_config_readonly

        modes.append(str(((load_config_readonly() or {}).get("display") or {}).get("busy_input_mode") or ""))
    except Exception:
        return True
    return not all(mode.strip().lower() == "queue" for mode in modes)


def _outsider_spoke_after(turn: Dict[str, Any]) -> bool:
    """Có người ngoài gọi bot trong cùng hội thoại sau khi lượt này bắt đầu không.

    Chế độ ``busy_input_mode`` interrupt/steer của Hermes chèn tin mới vào lượt
    đang chạy, nên lượt của chủ nhân có thể đang xử lý cả lời của người ngoài.
    """
    adapter, seq = _ACTIVE_ADAPTER, turn.get("seq")
    if adapter is None or seq is None or not _busy_input_injects():
        return False
    return any(
        other.get("thread_id") == turn.get("thread_id")
        and not other.get("is_owner")
        and other.get("seq", 0) > seq
        for other in list((getattr(adapter, "_turns", None) or {}).values())
    )


def _member_may_call(name: str, args: Any) -> bool:
    if name in _PUBLIC_TOOL_NAMES or name in _TOOL_SEARCH_READS:
        return True
    if name == "tool_call":
        # Lõi thường đã tháo ra công cụ thật trước khi gọi hook; phòng khi chưa.
        try:
            from tools.tool_search import resolve_underlying_call

            underlying, _args, error = resolve_underlying_call(args if isinstance(args, dict) else {})
        except Exception:
            return False
        return bool(underlying) and not error and underlying != "tool_call" and _member_may_call(underlying, {})
    try:
        from tools.registry import registry

        toolset = str(registry.get_toolset_for_tool(name) or "")
    except Exception:
        return False
    return toolset.startswith("mcp-") and _mcp_open_to_members(name, toolset)


def _public_mcp_patterns() -> List[str]:
    """Các MCP chủ nhân mở cho người trong nhóm, khai trong ``ZALO_PUBLIC_MCP``."""
    try:
        from agent.secret_scope import UnscopedSecretError, get_secret
        try:
            raw = get_secret("ZALO_PUBLIC_MCP", "")
        except UnscopedSecretError:
            # Đang multiplex mà không có scope: không đoán sang hồ sơ khác —
            # danh sách này MỞ quyền, đọc nhầm là mở nhầm.
            return []
    except Exception:
        raw = os.getenv("ZALO_PUBLIC_MCP", "")
    return [part.strip() for part in str(raw or "").split(",") if part.strip()]


def _mcp_open_to_members(name: str, toolset: str) -> bool:
    """Công cụ MCP này có được người trong nhóm gọi không — mặc định KHÔNG.

    Hermes cấp mọi MCP server cho mọi nền tảng, kể cả lượt của người lạ trong
    nhóm. Mở mặc định thì cắm một server dọn ổ đĩa, chạy Apify tốn tiền hay đọc
    Gmail là người ngoài gọi được ngay. Mỗi mục trong ``ZALO_PUBLIC_MCP`` khớp
    (kiểu glob) với tên server (``rag``), toolset (``mcp-rag``) hoặc tên công
    cụ (``rag_search``); ``*`` mở hết như trước bản 1.11.1.
    """
    import fnmatch

    server = toolset[len("mcp-"):]
    return any(
        fnmatch.fnmatchcase(server, pattern) or fnmatch.fnmatchcase(toolset, pattern)
        or fnmatch.fnmatchcase(name, pattern)
        for pattern in _public_mcp_patterns()
    )


def _feature_block(turn: Dict[str, Any], name: str, args: Any) -> Optional[Dict[str, str]]:
    """Lượt không phải của chủ nhân gọi công cụ thuộc nút đang tắt → chặn.

    Đọc ``permissions.json`` qua group_permissions (đọc lại khi tệp đổi). Trong
    nhóm: bảng của nhóm đó; ``zalo_group_cron`` chỉ bị chặn khi tạo mới — xem và
    xoá việc đã có vẫn được (spec §8.3). Nhắn riêng: mục ``dm`` (spec §16) — nút
    chung cho tin nhắn riêng, ghi đè theo từng người. Đọc lỗi → không chặn.
    """
    real, real_args = name, args if isinstance(args, dict) else {}
    if name == "tool_call":
        try:
            from tools.tool_search import resolve_underlying_call

            real, real_args, error = resolve_underlying_call(real_args)
        except Exception:
            return None  # _member_may_call tự từ chối tool_call không tháo được
        if error or not real:
            return None
        if not isinstance(real_args, dict):
            real_args = {}
    if real in group_permissions.STUDIO_TOOLS:
        return _studio_block(turn, real_args, real)
    feature = group_permissions.feature_of(real)
    if feature is None:
        return None
    if not turn.get("is_group"):
        if feature not in group_permissions.DM_FEATURES:
            return None
        try:
            if group_permissions.dm_settings(str(turn.get("sender_uid") or ""))["features"][feature]:
                return None
        except Exception as exc:  # đọc quyền hỏng không được làm hỏng lượt
            logger.warning("[zalo] không đọc được quyền nhắn riêng: %s", exc)
            return None
        label = group_permissions.FEATURE_LABELS[feature]
        logger.info("[zalo] chặn %s — nhắn riêng với %s đang tắt %s", real, turn.get("sender_uid"), feature)
        return {
            "action": "block",
            "message": (f"Chủ bot chưa bật tính năng {label} khi nhắn riêng với người này. Hãy nói ngắn gọn "
                        f"với người hỏi rằng {label} đang tắt trong tin nhắn riêng; đừng gọi lại công cụ này "
                        "và đừng dùng công cụ khác để làm thay."),
        }
    if feature == "groupCron" and str((real_args or {}).get("action") or "").strip().lower() != "create":
        return None
    try:
        if group_permissions.group_settings(str(turn.get("thread_id") or ""))["features"][feature]:
            return None
    except Exception as exc:  # đọc quyền hỏng không được làm hỏng lượt
        logger.warning("[zalo] không đọc được quyền nhóm: %s", exc)
        return None
    label = group_permissions.FEATURE_LABELS[feature]
    logger.info("[zalo] chặn %s — nhóm %s đang tắt %s", real, turn.get("thread_id"), feature)
    return {
        "action": "block",
        "message": (f"Nhóm này chưa bật tính năng {label}. Hãy nói ngắn gọn với người hỏi rằng "
                    f"chủ bot đã tắt {label} trong nhóm này; đừng gọi lại công cụ này và đừng "
                    "dùng công cụ khác để làm thay."),
    }


def _studio_block(turn: Dict[str, Any], args: Dict[str, Any], tool: str = "zalo_studio") -> Optional[Dict[str, str]]:
    """``zalo_studio`` / ``zalo_media``: nút áp tuỳ ``kind``. Khác các nút cũ, đọc quyền lỗi thì CHẶN (xem _studio_rules)."""
    from .studio import recipes

    kind = str((args or {}).get("kind") or "")
    if tool == "zalo_media":
        switch = {"image": "studioImage", "video": "studioAIVideo"}.get(kind)
    else:
        recipe = recipes.RECIPES.get(kind)
        switch = recipe.switch if recipe else None
    if switch is None:
        return None  # công cụ tự báo kind sai
    if _studio_rules(turn)["features"].get(switch):
        return None
    label = group_permissions.STUDIO_LABELS[switch]
    where = "trong nhóm này" if turn.get("is_group") else "khi nhắn riêng với người này"
    logger.info("[zalo] chặn %s(%s) — %s đang tắt %s", tool, kind, turn.get("sender_uid"), switch)
    return {
        "action": "block",
        "message": (f"Chủ bot chưa bật tính năng {label} {where}. Hãy nói ngắn gọn với người hỏi rằng tính năng "
                    "này đang tắt; đừng gọi lại công cụ này và đừng dùng công cụ khác để làm thay."),
    }



def _tool_off_block(name: str, args: Any) -> Optional[Dict[str, str]]:
    """Công cụ chủ bot tắt riêng ở trang Công cụ (``tools.off``, spec §18.6) → chặn. Đọc lỗi → không chặn thêm."""
    real = name
    if name == "tool_call":
        try:
            from tools.tool_search import resolve_underlying_call

            real, _args, error = resolve_underlying_call(args if isinstance(args, dict) else {})
        except Exception:
            return None
        if error or not real:
            return None
    try:
        if not group_permissions.tool_off(real):
            return None
    except Exception as exc:
        logger.warning("[zalo] không đọc được danh sách công cụ tắt: %s", exc)
        return None
    logger.info("[zalo] chặn %s — chủ bot đã tắt công cụ này với thành viên", real)
    return {
        "action": "block",
        "message": (f"Chủ bot đã tắt công cụ {real} với người không phải chủ nhân. Hãy nói ngắn gọn với người hỏi "
                    "rằng việc này hiện chưa làm được; đừng gọi lại công cụ này và đừng dùng công cụ khác để làm thay."),
    }


def guard_member_tool_call(tool_name: str = "", args: Any = None, **_kw) -> Optional[Dict[str, str]]:
    """Hook ``pre_tool_call``: lượt không phải của riêng chủ nhân chỉ chạy được công cụ công khai.

    toolsets_for_source chỉ đưa ``zalo_public`` cho người ngoài, nhưng Hermes
    còn "đóng băng" danh sách công cụ theo phiên (``restore_agent_tool_prefix``):
    phiên nhóm do chủ nhân mở trước thì lượt sau của bất kỳ ai cũng được cấp lại
    ``terminal``, ``read_file``, ``vision_analyze``… Chặn tại điểm thực thi thì
    dù công cụ lọt vào danh sách, người ngoài gọi vẫn không chạy được. Lượt của
    chủ nhân mà có người ngoài gọi bot chen vào cũng bị hạ về mức công khai.

    Không có lượt Zalo (CLI, nền tảng khác, cron) thì để yên.
    """
    turn = _TURN.get()
    if not turn:
        return None
    if (turn.get("is_owner") or turn.get("core_tools")) and not _outsider_spoke_after(turn):
        return None
    name = str(tool_name or "")
    blocked = _tool_off_block(name, args) or _feature_block(turn, name, args)
    if blocked:
        return blocked
    if _member_may_call(name, args):
        return None
    # tool_call hỏng (vd. gộp nhiều công cụ thường trong một lần — Hermes không nhận) thì nói đúng lỗi để model gọi lại
    # cho đúng, đừng báo "chỉ chủ nhân" làm nó bỏ cuộc. Vẫn chặn: Hermes cũng sẽ từ chối, không có gì chạy.
    if name == "tool_call":
        try:
            from tools.tool_search import resolve_underlying_call

            _real, _args, error = resolve_underlying_call(args if isinstance(args, dict) else {})
        except Exception:
            error = ""
        if error:
            return {"action": "block", "message": (f"tool_call không hợp lệ: {error} "
                                                   "Gọi lại từng công cụ một: mỗi tool_call chỉ một công cụ.")}
    logger.warning("[zalo] chặn %s — lượt của %s không phải của riêng chủ nhân", name, turn.get("sender_uid"))
    reason = ("lượt của chủ nhân nhưng có tin người khác chen vào"
              if turn.get("is_owner") or turn.get("core_tools")
              else "lượt này do người trong nhóm gửi")
    # Nói luôn đường đi đúng: model chỉ nhìn thấy công cụ lõi đã bị ghim vào
    # phiên, còn công cụ Zalo công khai thì nằm sau tool_search — bị chặn mà
    # không được chỉ chỗ thì nó bỏ cuộc và trả lời "không tra được".
    # Không gợi ý công cụ thuộc nút đang tắt ở nhóm này — gợi ý xong lại bị chặn.
    off: set = set()
    try:
        if turn.get("is_group"):
            off = set(group_permissions.disabled_features(str(turn.get("thread_id") or "")))
        else:
            off = set(group_permissions.dm_disabled_features(str(turn.get("sender_uid") or "")))
    except Exception as exc:
        logger.warning("[zalo] không đọc được quyền nhóm/nhắn riêng: %s", exc)
    hints = ", ".join(text for feature, text in (
        ("kb", "cần tra tài liệu thì dùng zalo_kb_list rồi zalo_kb_read"),
        ("files", "cần gửi tệp thì zalo_send_file"),
        ("history", "cần xem lại tin cũ thì zalo_thread_history"),
    ) if feature not in off)
    return {
        "action": "block",
        "message": (f"Công cụ {name} chỉ dùng được trong lượt của riêng chủ nhân ({reason}). "
                    f"{hints[:1].upper()}{hints[1:]} — tìm bằng tool_search nếu chưa thấy. "
                    "Đừng gọi lại công cụ này."),
    }


def define_platform_composite() -> None:
    """Định nghĩa tường minh toolset ``hermes-zalo``.

    Khi toolset này không tồn tại, Hermes tự sinh nó bằng
    ``_HERMES_CORE_TOOLS`` — và bộ lõi ấy chứa sẵn cả nhóm ``kanban_*``. Hậu
    quả: khối "recover non-configurable toolsets" trong ``tools_config`` thấy
    ``kanban ⊆ universe`` nên bật kanban cho MỌI người nhắn vào nền tảng, kể
    cả người lạ trong nhóm. Không cấu hình nào cản được — đây là đường đi
    vòng qua ``toolsets_for_source()``, nên bảng công việc riêng của chủ nhân
    thành đọc/ghi công khai.

    Định nghĩa tường minh ở đây khiến nhánh tự sinh không chạy nữa. Vẫn lấy
    ``_HERMES_CORE_TOOLS`` làm gốc để bám theo Hermes khi nâng cấp, chỉ trừ
    đúng phần kanban. Chủ nhân vẫn dùng kanban qua Zalo được: adapter liệt kê
    thẳng ``kanban`` trong override dành riêng cho họ.
    """
    try:
        from toolsets import (_HERMES_CORE_TOOLS, create_custom_toolset,
                              resolve_toolset)
    except ImportError as exc:
        logger.warning("[zalo] không định nghĩa được hermes-zalo: %s", exc)
        return

    core = set(_HERMES_CORE_TOOLS)
    private = set(resolve_toolset("kanban", include_registry=False))
    create_custom_toolset(
        name="hermes-zalo",
        description="Công cụ lõi Hermes cho nền tảng Zalo (không gồm kanban).",
        tools=sorted(core - private),
        includes=[],
    )
    # Bộ nhớ đệm của resolve_toolset khoá theo registry chứ không theo
    # TOOLSETS, nên một định nghĩa đến muộn có thể bị kết quả đã đệm che mất.
    try:
        import toolsets as _ts
        _ts._resolve_toolset_memo.clear()
    except Exception:
        pass

    logger.info("[zalo] hermes-zalo: %d công cụ (đã loại %d công cụ kanban)",
                len(core - private), len(private))


def define_cron_member_toolset() -> None:
    """Định nghĩa toolset ``zalo_cron_member`` cho việc hẹn giờ do thành viên tạo.

    Job của thành viên ghim ``enabled_toolsets = [zalo_cron_member, no_mcp]``,
    nên lúc chạy agent chỉ cầm đúng CRON_MEMBER_TOOLS — không terminal, không
    đọc tệp, không MCP, không nhắm hội thoại khác.
    """
    try:
        from toolsets import create_custom_toolset
    except ImportError as exc:
        logger.warning("[zalo] không định nghĩa được %s: %s", TOOLSET_CRON_MEMBER, exc)
        return

    create_custom_toolset(
        name=TOOLSET_CRON_MEMBER,
        description="Công cụ cho việc hẹn giờ do thành viên nhóm Zalo tạo.",
        tools=list(CRON_MEMBER_TOOLS),
        includes=[],
    )
    try:
        import toolsets as _ts
        _ts._resolve_toolset_memo.clear()
    except Exception:
        pass


def register_tools(ctx) -> None:
    """Đăng ký công cụ Zalo, chia làm hai mức quyền."""
    counts = {TOOLSET_PUBLIC: 0, TOOLSET_OWNER: 0, TOOLSET_CRON: 0}
    friend_tools = _friend_tools_enabled()
    for name, emoji, schema, handler, toolset in TOOLS:
        if name in FRIEND_TOOL_NAMES and not friend_tools:
            continue
        guarded = handler
        if toolset == TOOLSET_OWNER:
            guarded = _owner_only(
                _confirmed_action(
                    _dm_only(handler, name) if name in DM_ONLY_TOOLS else handler,
                    name,
                ),
                name,
            )
        try:
            ctx.register_tool(
                name=name,
                toolset=toolset,
                schema=schema,
                handler=_with_cron_turn(guarded, name),
                is_async=True,
                description=schema["description"],
                emoji=emoji,
            )
            counts[toolset] = counts.get(toolset, 0) + 1
        except Exception as exc:  # pragma: no cover — đăng ký hỏng không được làm chết plugin
            logger.warning("[zalo] không đăng ký được công cụ %s: %s", name, exc)
    logger.info(
        "[zalo] đã đăng ký %d công cụ — %d công khai, %d chỉ chủ nhân, %d cho cron",
        sum(counts.values()), counts.get(TOOLSET_PUBLIC, 0), counts.get(TOOLSET_OWNER, 0),
        counts.get(TOOLSET_CRON, 0),
    )
    # Trang Công cụ của dashboard (spec §18.6) đọc danh sách này — cố hết sức, không làm hỏng việc nạp plugin.
    try:
        write_tools_manifest(friend_tools=friend_tools)
    except Exception:
        logger.warning("[zalo] không ghi được tools-manifest.json", exc_info=True)


def tools_manifest(*, friend_tools: bool) -> Dict[str, Any]:
    """Mọi công cụ Zalo: tên, mức quyền, mô tả, nút tính năng điều khiển, có đang được đăng ký không."""
    rows = []
    for name, _emoji, schema, _handler, toolset in TOOLS:
        rows.append({
            "name": name,
            "toolset": toolset,
            "description": str(schema.get("description") or "")[:400],
            "feature": group_permissions.feature_of(name) or ("studio" if name in group_permissions.STUDIO_TOOLS else
                                                              ("always" if name in group_permissions.ALWAYS_ON else None)),
            "registered": not (name in FRIEND_TOOL_NAMES and not friend_tools),
            "dmOnly": name in DM_ONLY_TOOLS,
            "confirm": name in DANGEROUS_TOOL_NAMES,
        })
    return {"v": 1, "generatedAt": int(time.time() * 1000), "tools": rows}


def write_tools_manifest(*, friend_tools: bool, path=None) -> None:
    from pathlib import Path
    target = Path(path) if path else group_permissions.permissions_path().parent / "tools-manifest.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(tools_manifest(friend_tools=friend_tools), ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, target)
