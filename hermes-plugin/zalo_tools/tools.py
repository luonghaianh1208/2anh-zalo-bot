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
# Cố tình KHÔNG đặt tên trùng khoá nền tảng ("zalo"): Hermes tự bật toolset
# cùng tên với nền tảng cho mọi phiên, nên đặt trùng thì người ngoài cũng nhận
# luôn bộ công cụ dành riêng cho chủ.
TOOLSET_OWNER = "zalo_owner"

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
    # Chữ ký là (groupId, count?) — chỉ hai tham số. Truyền ba thì `None` rơi
    # vào chỗ count và số tin agent xin bị bỏ qua trong im lặng.
    return await _invoke("getGroupChatHistory", [thread_id, count])


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


def _kb_allowed(rel_posix: str) -> bool:
    """Đường dẫn tương đối này có nên lộ ra cho người hỏi không."""
    parts = rel_posix.split("/")
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
        payload["note"] = (f"còn {total - len(shown)} tệp nữa — thu hẹp bằng "
                           f"tham số `query` để tìm đúng thứ cần")
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
    # Đổi sau khi kiểm tra an toàn, không phải trước — để phép kiểm luôn nhìn
    # đúng địa chỉ người dùng đưa vào.
    urls = [_google_export_url(u) for u in urls]
    return await _core("web_extract", {"urls": urls[:5]}, attempts=2)


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
        )
    except ValueError as exc:
        return _err(str(exc))
    return _ok({"user_id": target, "profile": entry})


async def zalo_recall_person(args: Dict[str, Any], **_kw) -> str:
    from .people import get_person

    turn = _turn()
    sender = turn.get("sender_uid") or ""
    target = str(args.get("user_id") or "").strip() or sender
    if target != sender and not turn.get("is_owner"):
        return _err("chỉ xem được hồ sơ của chính mình")

    person = get_person(target)
    if not person:
        return _ok({"user_id": target, "profile": None, "note": "chưa có hồ sơ"})
    return _ok({"user_id": target, "profile": person})


async def zalo_list_people(args: Dict[str, Any], **_kw) -> str:
    from .people import list_people
    return _ok(list_people(limit=max(1, min(int(args.get("limit", 50) or 50), 200))))


async def zalo_forget_person(args: Dict[str, Any], **_kw) -> str:
    from .people import forget_person

    uid = str(args.get("user_id") or "").strip()
    if not uid:
        return _err("cần `user_id`")
    return _ok({"user_id": uid, "removed": forget_person(uid)})


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
        "KHÔNG DÙNG ĐƯỢC — Zalo trả lỗi 404 với thư viện hiện tại (zca-js "
        "2.1.2). Đừng gọi; nếu cần bối cảnh thì dựa vào các tin trong phiên "
        "hội thoại hiện tại.",
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

    ("zalo_remove_reminder", "🗑️", _schema(
        "zalo_remove_reminder",
        "Xoá một lời nhắc đã đặt. Dùng khi đặt nhầm giờ hoặc việc đã xong.",
        {
            "thread_id": _THREAD_ID,
            "thread_kind": _THREAD_KIND,
            "reminder_id": {"type": "string", "description": "Mã lời nhắc, lấy từ zalo_list_reminders."},
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
        "KHÔNG DÙNG ĐƯỢC — Zalo đòi cả `cliMsgId` khi thu hồi, nhưng lệnh gửi "
        "chỉ trả về `msgId` nên không có đường lấy. Nếu lỡ gửi nhầm thì nhắn "
        "thêm một tin đính chính.",
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
        "Đọc nội dung một hoặc vài trang web theo địa chỉ. Chỉ đọc được địa "
        "chỉ công cộng http/https, tối đa 5 trang mỗi lần.",
        {
            "url": {"type": "string", "description": "Địa chỉ trang cần đọc."},
            "urls": {"type": "array", "items": {"type": "string"},
                     "description": "Nhiều địa chỉ cùng lúc, tối đa 5."},
        },
        [],
    ), zalo_web_read, TOOLSET_PUBLIC),

    # --- Nhóm 9: sổ hồ sơ người quen ---
    ("zalo_remember_person", "🧠", _schema(
        "zalo_remember_person",
        "Ghi nhớ thông tin người đang trò chuyện để lần sau xưng hô và tư vấn "
        "cho đúng. Gọi khi họ tự giới thiệu — tên, công việc, lĩnh vực, sở "
        "thích, nhu cầu. Chỉ lưu điều họ tự nói ra, đừng suy đoán. Không lưu "
        "thông tin nhạy cảm như số tài khoản hay mật khẩu.",
        {
            "name": {"type": "string", "description": "Tên hoặc cách xưng hô họ muốn."},
            "note": {"type": "string", "description": "Ghi chú ngắn về họ."},
            "fields": {"type": "object",
                       "description": "Các mục rời, ví dụ {\"lĩnh vực\": \"kỹ thuật\", \"đơn vị\": \"phòng IT\"}."},
            "user_id": {"type": "string",
                        "description": "Chỉ chủ nhân mới ghi hộ người khác được. Bỏ trống là ghi cho người đang nhắn."},
        },
        [],
    ), zalo_remember_person, TOOLSET_PUBLIC),

    ("zalo_recall_person", "🔖", _schema(
        "zalo_recall_person",
        "Xem lại hồ sơ đã lưu của một người. Thường không cần gọi — hồ sơ của "
        "người đang nhắn đã được kẹp sẵn vào đầu cuộc trò chuyện.",
        {"user_id": {"type": "string",
                     "description": "Bỏ trống là xem hồ sơ của chính người đang nhắn."}},
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
        {"user_id": {"type": "string", "description": "UID Zalo của người cần xoá."}},
        ["user_id"],
    ), zalo_forget_person, TOOLSET_OWNER),
]


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
        if turn and not turn.get("is_owner"):
            logger.info("[zalo] chặn %s — %s không phải chủ nhân",
                        tool_name, turn.get("sender_uid"))
            return _err("công cụ này chỉ chủ nhân dùng được")
        return await handler(args, **kw)

    guarded.__name__ = getattr(handler, "__name__", tool_name)
    guarded.__doc__ = getattr(handler, "__doc__", None)
    return guarded


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


def register_tools(ctx) -> None:
    """Đăng ký công cụ Zalo, chia làm hai mức quyền."""
    counts = {TOOLSET_PUBLIC: 0, TOOLSET_OWNER: 0}
    for name, emoji, schema, handler, toolset in TOOLS:
        try:
            ctx.register_tool(
                name=name,
                toolset=toolset,
                schema=schema,
                handler=handler if toolset == TOOLSET_PUBLIC else _owner_only(handler, name),
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
