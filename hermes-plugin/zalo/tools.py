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
import json
import logging
from typing import Any, Dict, List, Optional

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
TOOLSET_OWNER = "zalo"

# Ngữ cảnh của lượt tin đang xử lý. Dùng ContextVar chứ không phải biến thường:
# gateway xử lý nhiều lượt song song, biến thường sẽ lẫn người này sang người
# kia — đúng loại lỗi khiến ai cũng thành chủ nhân.
_TURN: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar(
    "zalo_turn", default=None
)


def set_turn_context(*, sender_uid: str, thread_id: str, is_group: bool, is_owner: bool) -> None:
    """Adapter gọi trước khi đẩy tin vào agent."""
    _TURN.set({
        "sender_uid": str(sender_uid),
        "thread_id": str(thread_id),
        "is_group": bool(is_group),
        "is_owner": bool(is_owner),
    })


def _turn() -> Dict[str, Any]:
    return _TURN.get() or {}


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


async def _invoke(method: str, args: List[Any]) -> str:
    """Gọi một hàm zca-js qua cầu nối và gói kết quả lại thành JSON."""
    adapter = _ACTIVE_ADAPTER
    if adapter is None:
        return _err(
            "Zalo chưa kết nối. Chạy `npm start` trong thư mục 2anh-zalo-bot, "
            "rồi khởi động lại gateway."
        )
    ack = await adapter.invoke(method, args)
    if ack is None:
        return _err(f"Sidecar không phản hồi lệnh {method} (quá hạn chờ)")
    if not ack.get("ok"):
        return _err(ack.get("error") or f"{method} thất bại")
    return _ok(ack.get("result"))


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
    return await _invoke("uploadAttachment", [paths, thread_id, _thread_type(kind)])


async def zalo_send_voice(args: Dict[str, Any], **_kw) -> str:
    url = args.get("url")
    if not url:
        return _err("cần `url`")
    thread_id, kind, err = _scoped_thread(args)
    if err:
        return err
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

    return await _invoke("sendSticker", [stickers[0], thread_id, _thread_type(kind)])


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
        {"message": message}, targets, _thread_type(args.get("thread_kind")),
    ])


# =====================================================================
#  Nhóm 2 — Đọc ngữ cảnh
# =====================================================================

async def zalo_read_history(args: Dict[str, Any], **_kw) -> str:
    thread_id = str(args.get("thread_id") or "")
    if not thread_id:
        return _err("cần `thread_id`")
    count = min(int(args.get("count", 30)), 100)
    return await _invoke("getGroupChatHistory", [thread_id, None, count])


async def zalo_list_groups(args: Dict[str, Any], **_kw) -> str:
    return await _invoke("getAllGroups", [])


async def zalo_group_members(args: Dict[str, Any], **_kw) -> str:
    thread_id, _kind, err = _scoped_thread(args)
    if err:
        return err
    return await _invoke("getGroupMembersInfo", [thread_id])


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

async def zalo_undo(args: Dict[str, Any], **_kw) -> str:
    msg_id = str(args.get("msg_id") or "")
    cli_msg_id = str(args.get("cli_msg_id") or "")
    thread_id = str(args.get("thread_id") or "")
    if not msg_id or not thread_id:
        return _err("cần `msg_id` và `thread_id`")
    return await _invoke("undo", [
        {"msgId": msg_id, "cliMsgId": cli_msg_id},
        thread_id, _thread_type(args.get("thread_kind")),
    ])


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
    return await _invoke(method, [uids, group_id])


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
        "members": uids,
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


_THREAD_ID = {"type": "string", "description": "ID hội thoại Zalo (nhóm hoặc người dùng)."}
_THREAD_KIND = {
    "type": "string",
    "enum": ["group", "dm"],
    "description": "Loại hội thoại. Mặc định 'dm'.",
}
_GROUP_ID = {"type": "string", "description": "ID nhóm Zalo."}

TOOLS = [
    # --- Nhóm 1: gửi nội dung ---
    ("zalo_send_file", "📎", _schema(
        "zalo_send_file",
        "Gửi ảnh, video hoặc tệp lên một hội thoại Zalo. Dùng khi cần đưa cho "
        "người dùng một tài liệu vừa tạo, ảnh chụp màn hình hay bản báo cáo.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "path": {"type": "string", "description": "Đường dẫn tuyệt đối tới tệp."},
            "paths": {"type": "array", "items": {"type": "string"},
                      "description": "Nhiều tệp cùng lúc."},
        },
        ["thread_id"],
    ), zalo_send_file, TOOLSET_PUBLIC),

    ("zalo_send_voice", "🎙️", _schema(
        "zalo_send_voice",
        "Gửi tin nhắn thoại từ một URL âm thanh (định dạng .aac). Kết hợp với "
        "công cụ chuyển văn bản thành giọng nói để trả lời bằng giọng.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "url": {"type": "string", "description": "URL công khai tới tệp âm thanh."},
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
            "thread_ids": {"type": "array", "items": {"type": "string"},
                           "description": "Danh sách hội thoại nhận."},
            "thread_kind": _THREAD_KIND,
        },
        ["message", "thread_ids"],
    ), zalo_forward, TOOLSET_OWNER),

    # --- Nhóm 2: đọc ngữ cảnh ---
    ("zalo_read_history", "📜", _schema(
        "zalo_read_history",
        "Đọc các tin nhắn gần đây của một nhóm. Dùng khi cần hiểu câu chuyện "
        "đang diễn ra trước khi trả lời, hoặc khi được nhờ tóm tắt nhóm.",
        {
            "thread_id": _THREAD_ID,
            "count": {"type": "integer", "description": "Số tin muốn đọc (tối đa 100, mặc định 30)."},
        },
        ["thread_id"],
    ), zalo_read_history, TOOLSET_OWNER),

    ("zalo_list_groups", "👥", _schema(
        "zalo_list_groups",
        "Liệt kê các nhóm Zalo mà tài khoản này đang tham gia.",
        {}, [],
    ), zalo_list_groups, TOOLSET_OWNER),

    ("zalo_group_members", "🧑‍🤝‍🧑", _schema(
        "zalo_group_members",
        "Xem danh sách thành viên một nhóm, kèm tên và vai trò.",
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
        {"user_id": {"type": "string", "description": "UID Zalo (dãy số dài)."}},
        ["user_id"],
    ), zalo_user_info, TOOLSET_OWNER),

    ("zalo_list_friends", "📇", _schema(
        "zalo_list_friends",
        "Liệt kê danh bạ bạn bè Zalo.",
        {}, [],
    ), zalo_list_friends, TOOLSET_OWNER),

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
        {"poll_id": {"type": "string", "description": "ID cuộc bình chọn."}},
        ["poll_id"],
    ), zalo_poll_detail, TOOLSET_OWNER),

    ("zalo_lock_poll", "🔒", _schema(
        "zalo_lock_poll",
        "Khoá một cuộc bình chọn, không cho bỏ phiếu thêm.",
        {"poll_id": {"type": "string", "description": "ID cuộc bình chọn."}},
        ["poll_id"],
    ), zalo_lock_poll, TOOLSET_OWNER),

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
        "Thu hồi một tin nhắn mà chính bot đã gửi. Dùng khi lỡ gửi nhầm nội "
        "dung hoặc nhầm hội thoại.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "msg_id": {"type": "string", "description": "ID tin nhắn cần thu hồi."},
            "cli_msg_id": {"type": "string", "description": "cliMsgId của tin nhắn đó."},
        },
        ["thread_id", "msg_id"],
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
            "user_ids": {"type": "array", "items": {"type": "string"},
                         "description": "Danh sách UID."},
            "action": {"type": "string", "enum": ["add", "remove"]},
        },
        ["group_id", "user_ids", "action"],
    ), zalo_group_member_change, TOOLSET_OWNER),

    ("zalo_group_deputy", "🎖️", _schema(
        "zalo_group_deputy",
        "Trao hoặc thu hồi quyền phó nhóm cho một thành viên.",
        {
            "group_id": _GROUP_ID,
            "user_id": {"type": "string", "description": "UID thành viên."},
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
            "user_ids": {"type": "array", "items": {"type": "string"}},
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
            "member_ids": {"type": "array", "items": {"type": "string"},
                           "description": "UID những người sẽ được thêm vào. Bắt buộc, không được rỗng."},
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
            "user_id": {"type": "string", "description": "UID người được mời."},
            "group_ids": {"type": "array", "items": {"type": "string"},
                          "description": "Các nhóm muốn mời vào."},
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
]


def register_tools(ctx) -> None:
    """Đăng ký công cụ Zalo, chia làm hai mức quyền."""
    counts = {TOOLSET_PUBLIC: 0, TOOLSET_OWNER: 0}
    for name, emoji, schema, handler, toolset in TOOLS:
        try:
            ctx.register_tool(
                name=name,
                toolset=toolset,
                schema=schema,
                handler=handler,
                is_async=True,
                description=schema["description"],
                emoji=emoji,
            )
            counts[toolset] = counts.get(toolset, 0) + 1
        except Exception as exc:  # pragma: no cover — đăng ký hỏng không được làm chết plugin
            logger.warning("[zalo] không đăng ký được công cụ %s: %s", name, exc)
    logger.info(
        "[zalo] đã đăng ký %d công cụ — %d công khai, %d chỉ chủ nhân",
        sum(counts.values()), counts.get(TOOLSET_PUBLIC, 0), counts.get(TOOLSET_OWNER, 0),
    )
