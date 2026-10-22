"""Phân quyền theo nhóm — đọc nóng ``<HERMES_HOME>/zalo/permissions.json``.

Dashboard ghi tệp này (ghi nguyên tử), plugin chỉ đọc. Mỗi lần hỏi, plugin
``stat`` tệp; dấu (mtime, cỡ, inode) không đổi thì dùng bản đã phân tích trong
bộ nhớ, đổi thì đọc lại — nên bấm Lưu trên dashboard là có hiệu lực ngay, không
phải khởi động lại gateway.

Tệp chỉ **bớt** quyền trong bộ công cụ công khai, không bao giờ cấp quyền chủ
nhân. Không có tệp → y như trước khi có tính năng này. Tệp hỏng → ghi cảnh báo
và dùng mặc định (mọi tính năng bật), không bao giờ làm bot im.

Lớp gộp: mặc định gốc ← ``defaults`` trong tệp ← thư mục chứa nhóm (``folders[<fid>]``,
mỗi nhóm thuộc tối đa một thư mục) ← ``groups[<id>]``. Khoá nào thiếu hoặc sai kiểu thì rơi xuống lớp dưới. ``reply_only_tagged`` = None nghĩa
là "theo cờ toàn cục" ``ZALO_GROUP_REPLY_ONLY_TAGGED`` của adapter.
"""

import json
import logging
import os
import re
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

FEATURES = ("web", "files", "voice", "reminders", "groupCron", "kb", "people", "academic", "video", "history")

FEATURE_TOOLS: Dict[str, tuple] = {
    "web": ("zalo_web_search", "zalo_web_read", "zalo_weather", "zalo_exchange_rate"),
    "files": ("zalo_send_file", "zalo_make_file", "zalo_pdf"),
    "voice": ("zalo_send_voice",),
    "reminders": ("zalo_create_reminder", "zalo_list_reminders", "zalo_remove_reminder"),
    "groupCron": ("zalo_group_cron",),
    "kb": ("zalo_kb_list", "zalo_kb_read", "zalo_skill_list", "zalo_skill_read"),
    "people": ("zalo_remember_person", "zalo_recall_person"),
    "academic": ("zalo_academic_search", "zalo_dictionary", "zalo_species"),
    "video": ("zalo_video_info", "zalo_video_download", "zalo_video_ghep", "zalo_video_edit"),
    "history": ("zalo_thread_history",),
}

# Công cụ công khai luôn bật, không có nút.
ALWAYS_ON = frozenset({"zalo_send_sticker", "zalo_send_link", "zalo_group_members"})

FEATURE_LABELS: Dict[str, str] = {
    "web": "tra cứu web",
    "files": "gửi và tạo tệp",
    "voice": "tin nhắn thoại",
    "reminders": "nhắc hẹn",
    "groupCron": "hẹn giờ cho nhóm",
    "kb": "kho tài liệu và skill",
    "people": "sổ người quen",
    "academic": "tra cứu học thuật",
    "video": "tải, cắt ghép, sửa và xem thông tin video",
    "history": "tra lịch sử trò chuyện",
}

_TOOL_FEATURE = {tool: feature for feature, tools in FEATURE_TOOLS.items() for tool in tools}

# Nhắn riêng (mục ``dm`` của tệp, spec §16). "Hẹn giờ cho nhóm" không có nghĩa
# ngoài nhóm — zalo_group_cron tự từ chối khi nhắn riêng — nên không có nút này.
DM_FEATURES = tuple(feature for feature in FEATURES if feature != "groupCron")
DM_WHO = ("owners", "list", "everyone")

# Xưởng tạo sản phẩm (spec §17): 4 nút, nằm cùng ``features`` của mặc định/nhóm/
# nhắn riêng/từng người. KHÁC 9 nút cũ: thiếu khoá = TẮT, đọc tệp lỗi = TẮT —
# xưởng dùng tài nguyên AI của chủ bot nên không bao giờ mở vì lỗi.
STUDIO_FEATURES = ("studioSlides", "studioDocs", "studioExams", "studioVideo", "studioImage", "studioAIVideo")
STUDIO_LABELS: Dict[str, str] = {
    "studioSlides": "làm slide PowerPoint",
    "studioDocs": "soạn văn bản và giáo án",
    "studioExams": "làm đề thi, SKKN, trò chơi, thí nghiệm ảo",
    "studioVideo": "làm video",
    "studioImage": "vẽ ảnh AI",
    "studioAIVideo": "tạo video AI",
}
# Công cụ của xưởng: một công cụ, nút nào áp tuỳ ``kind`` (xem studio/recipes.py).
# ``zalo_media`` (vẽ ảnh AI / tạo video AI): nút ``studioImage`` / ``studioAIVideo`` tuỳ ``kind``, hạn mức riêng.
STUDIO_TOOLS = frozenset({"zalo_studio", "zalo_media"})
MEDIA_FEATURES = frozenset({"studioImage", "studioAIVideo"})
# Chính sách cài đặt (spec §17.6): máy Windows không có hộp cát của hệ điều hành → video (bộ dựng nặng nhất, có
# mạng) luôn tắt ở đây, bất kể tệp quyền nói gì. Linux chạy không hộp cát cũng vậy — xem video_policy().
# Dashboard cùng máy hiện ghi chú và khoá nút.
VIDEO_BLOCKED = sys.platform == "win32"
WINDOWS_VIDEO_NOTE = "Máy chủ Windows không có hộp cát — video tắt"
PLAIN_VIDEO_NOTE = ("Máy chủ chưa dùng được hộp cát systemd (cần Linux, gateway chạy bằng root, có systemd-run, "
                    "không đặt ZALO_STUDIO_SANDBOX=none) — video tắt")
DEFAULT_STUDIO_QUOTA = 3
# Vẽ ảnh AI / tạo video AI: số ảnh, số video mỗi người mỗi ngày — cùng chuỗi lớp với số lượt xưởng.
DEFAULT_IMAGE_QUOTA = 5
DEFAULT_VIDEO_QUOTA = 1
QUOTA_KEYS = ("studioQuota", "imageQuota", "videoQuota")
MAX_STUDIO_QUOTA = 50

_lock = threading.Lock()
_cache: Dict[str, Any] = {"key": None, "data": None}


def permissions_path() -> Path:
    """``ZALO_PERMISSIONS_FILE`` (test, cài đặt đặc biệt) hoặc ``<HERMES_HOME>/zalo/permissions.json``."""
    explicit = (os.getenv("ZALO_PERMISSIONS_FILE") or "").strip()
    if explicit:
        return Path(explicit).expanduser()
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.getenv("HERMES_HOME") or Path.home() / ".hermes").expanduser()
    return home / "zalo" / "permissions.json"


def feature_of(tool_name: str) -> Optional[str]:
    """Nút điều khiển công cụ này; None nếu công cụ không thuộc nút nào."""
    return _TOOL_FEATURE.get(str(tool_name or ""))


def _bools(raw: Any, keys) -> Dict[str, bool]:
    if not isinstance(raw, dict):
        return {}
    return {key: raw[key] for key in keys if isinstance(raw.get(key), bool)}


def _quota(value: Any) -> Optional[int]:
    """Số lượt xưởng hợp lệ (số nguyên 0–50, không phải bool) hoặc None."""
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_STUDIO_QUOTA:
        return value
    return None


def _layer(raw: Any) -> Dict[str, Any]:
    """Một lớp (defaults hoặc một nhóm): chỉ giữ khoá hợp lệ, đúng kiểu bool."""
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Any] = _bools(raw, ("active", "replyOnlyTagged"))
    features = _bools(raw.get("features"), FEATURES)
    if features:
        out["features"] = features
    studio = _bools(raw.get("features"), STUDIO_FEATURES)
    if studio:
        out["studio"] = studio
    for key in QUOTA_KEYS:
        quota = _quota(raw.get(key))
        if quota is not None:
            out[key] = quota
    return out


def _studio_section(raw: Any) -> Dict[str, Any]:
    """Mục ``studio`` gốc: ``quota`` mặc định mỗi người mỗi ngày, ``people[uid].quota`` riêng từng người."""
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Any] = {"people": {}, "imagePeople": {}, "videoPeople": {}}
    for key in ("quota", "image", "video"):
        quota = _quota(raw.get(key))
        if quota is not None:
            out[key] = quota
    people = raw.get("people") if isinstance(raw.get("people"), dict) else {}
    for uid, entry in people.items():
        if not (str(uid).isascii() and str(uid).isdigit()) or len(str(uid)) > 32 or not isinstance(entry, dict):
            continue
        quota = _quota(entry.get("quota"))
        if quota is None:
            continue
        out["people"][str(uid)] = quota
        for key, book in (("image", "imagePeople"), ("video", "videoPeople")):
            own = _quota(entry.get(key))
            if own is not None:
                out[book][str(uid)] = own
    return out


def _dm(raw: Any) -> Dict[str, Any]:
    """Mục ``dm``: ``who`` hợp lệ, 8 nút đúng kiểu, ``people`` khoá là UID số — giống ``normalizeDm`` (dm-rules.js)."""
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Any] = {"features": _bools(raw.get("features"), DM_FEATURES), "people": {},
                           "studio": _bools(raw.get("features"), STUDIO_FEATURES)}
    if raw.get("who") in DM_WHO:
        out["who"] = raw["who"]
    people = raw.get("people") if isinstance(raw.get("people"), dict) else {}
    for uid, entry in people.items():
        if not (str(uid).isascii() and str(uid).isdigit()) or len(str(uid)) > 32:
            continue
        own = entry.get("features") if isinstance(entry, dict) else None
        out["people"][str(uid)] = {
            "features": _bools(own, DM_FEATURES),
            "studio": _bools(own, STUDIO_FEATURES),
        }
    return out


_TOOL_NAME = re.compile(r"^[a-z0-9_]{1,64}$")


def _tools_off(raw: Any) -> frozenset:
    """Mục ``tools.off`` (giai đoạn 7B, spec §18.6): công cụ chủ bot tắt với người không phải chủ nhân."""
    if not isinstance(raw, dict) or not isinstance(raw.get("off"), list):
        return frozenset()
    return frozenset(str(n) for n in raw["off"][:200] if isinstance(n, str) and _TOOL_NAME.match(n))


_FOLDER_ID = re.compile(r"^[a-z0-9]{1,16}$")


def _folders(raw: Any) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, str], Dict[str, str]]:
    """Mục ``folders``: ``{fid: lớp}``, ``{group_id: fid}`` và ``{uid: fid}`` — giống ``normalizeFolders`` bên dashboard.

    Thư mục chứa cả nhóm lẫn người (``people``: ``[{uid, name}]`` hoặc chuỗi UID). Mỗi nhóm/người thuộc tối đa một
    thư mục: có ở nhiều thư mục (tệp sửa tay) thì thư mục đứng trước giữ."""
    if not isinstance(raw, dict):
        return {}, {}, {}
    layers: Dict[str, Dict[str, Any]] = {}
    owner: Dict[str, str] = {}
    person_owner: Dict[str, str] = {}
    for fid, entry in raw.items():
        if not _FOLDER_ID.match(str(fid)) or not isinstance(entry, dict):
            continue
        layers[str(fid)] = _layer(entry)
        for gid in entry.get("groups") if isinstance(entry.get("groups"), list) else []:
            if isinstance(gid, str) and gid.isascii() and gid.isdigit() and gid not in owner:
                owner[gid] = str(fid)
        for p in entry.get("people") if isinstance(entry.get("people"), list) else []:
            uid = str((p.get("uid") if isinstance(p, dict) else p) or "")
            if uid.isascii() and uid.isdigit() and len(uid) <= 32 and uid not in person_owner:
                person_owner[uid] = str(fid)
    return layers, owner, person_owner


FOLDER_RULES_MAX = 3000


def _folder_rules(raw: Any) -> Dict[str, Tuple[str, str]]:
    """``{fid: (tên thư mục, quy tắc riêng)}`` — chỉ thư mục có quy tắc (dashboard › Phân quyền › thư mục)."""
    out: Dict[str, Tuple[str, str]] = {}
    for fid, entry in (raw.items() if isinstance(raw, dict) else []):
        if not _FOLDER_ID.match(str(fid)) or not isinstance(entry, dict):
            continue
        rules = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(entry.get("rules") or "")).strip()[:FOLDER_RULES_MAX]
        if rules:
            out[str(fid)] = (str(entry.get("name") or "Thư mục")[:60], rules)
    return out


def _parse(text: str) -> Dict[str, Any]:
    data = json.loads(text)
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("không phải permissions.json phiên bản 1")
    groups = data.get("groups") if isinstance(data.get("groups"), dict) else {}
    folders, folder_of, person_folder = _folders(data.get("folders"))
    return {
        "folder_rules": _folder_rules(data.get("folders")),
        "defaults": _layer(data.get("defaults")),
        "folders": folders,
        "folder_of": folder_of,
        "person_folder": person_folder,
        "groups": {str(gid): _layer(entry) for gid, entry in groups.items()},
        "dm": _dm(data.get("dm")),
        "studio": _studio_section(data.get("studio")),
        "tools_off": _tools_off(data.get("tools")),
    }


def _load() -> Dict[str, Any]:
    """Bản đã phân tích của tệp; rỗng khi không có tệp hoặc tệp hỏng."""
    path = permissions_path()
    try:
        st = path.stat()
    except OSError:
        return {}
    key = (str(path), st.st_mtime_ns, st.st_size, st.st_ino)
    with _lock:
        if _cache["key"] == key:
            return _cache["data"]
    try:
        data = _parse(path.read_text(encoding="utf-8-sig"))
    except OSError as exc:
        # Tệp còn nguyên, chỉ là tiến trình gateway không mở được (thường do
        # dashboard chạy dưới user khác và ghi tệp quyền 600) — không phải tệp hỏng.
        problem = ("the gateway user cannot read it" if isinstance(exc, PermissionError)
                   else f"read failed: {exc}")
        logger.error("[zalo] không đọc được %s — %s; dùng mặc định, mọi tính năng bật. "
                     "Sửa chủ sở hữu/quyền của tệp cho user chạy gateway.", path, problem)
        data = {}
    except Exception as exc:
        logger.warning("[zalo] permissions.json hỏng (%s) — dùng mặc định, mọi tính năng bật: %s", path, exc)
        data = {}
    with _lock:
        _cache["key"] = key
        _cache["data"] = data
    return data


def group_settings(group_id: str) -> Dict[str, Any]:
    """Quyền đã gộp của một nhóm: ``{active, reply_only_tagged, features, custom}``.

    ``custom``: nhóm có mục riêng trong tệp hoặc nằm trong một thư mục — phân quyền đã chọn này thắng danh sách
    cũ ``owner_only_groups``.
    """
    data = _load()
    defaults = data.get("defaults") or {}
    folder = _folder_layer(data, group_id)
    entry = (data.get("groups") or {}).get(str(group_id or "")) or {}
    features = {feature: True for feature in FEATURES}
    for layer in (defaults, folder, entry):
        features.update(layer.get("features") or {})
    active = entry.get("active", folder.get("active", defaults.get("active", True)))
    reply = entry.get("replyOnlyTagged", folder.get("replyOnlyTagged", defaults.get("replyOnlyTagged")))
    return {"active": active, "reply_only_tagged": reply, "features": features,
            "custom": bool(entry) or str(group_id or "") in (data.get("folder_of") or {})}


def _folder_layer(data: Dict[str, Any], group_id: str) -> Dict[str, Any]:
    fid = (data.get("folder_of") or {}).get(str(group_id or ""))
    return ((data.get("folders") or {}).get(fid) or {}) if fid else {}


def _person_folder_layer(data: Dict[str, Any], uid: str) -> Optional[Dict[str, Any]]:
    """Lớp thư mục chứa người này (None = không ở thư mục nào)."""
    fid = (data.get("person_folder") or {}).get(str(uid or ""))
    return ((data.get("folders") or {}).get(fid) or {}) if fid else None


def folder_rules(thread_id: str, is_group: bool, sender_uid: str = "") -> Optional[Tuple[str, str]]:
    """Quy tắc riêng của thư mục chứa cuộc trò chuyện này: nhóm → thư mục của nhóm; nhắn riêng → thư mục của người.

    Trả ``(tên thư mục, quy tắc)`` hoặc None."""
    data = _load()
    key = "folder_of" if is_group else "person_folder"
    fid = (data.get(key) or {}).get(str((thread_id if is_group else sender_uid) or ""))
    return (data.get("folder_rules") or {}).get(fid) if fid else None


def tool_off(tool_name: str) -> bool:
    """Chủ bot đã tắt riêng công cụ này với thành viên/người nhắn riêng chưa (chồng lên các nút tính năng)."""
    return str(tool_name or "") in (_load().get("tools_off") or frozenset())


def disabled_features(group_id: str) -> List[str]:
    """Các nút đang tắt ở nhóm này, theo thứ tự FEATURES."""
    features = group_settings(group_id)["features"]
    return [feature for feature in FEATURES if not features[feature]]


def dm_settings(uid: str) -> Dict[str, Any]:
    """Quyền nhắn riêng của một người KHÔNG phải chủ nhân (bên gọi tự miễn trừ chủ nhân).

    ``who``: "owners" | "list" | "everyone", hoặc None khi tệp chưa chọn (theo
    ``ZALO_DM_POLICY`` của adapter). ``listed``: người này có trong danh sách.
    ``features``: đủ 8 nút — mặc định bật ← ``dm.features`` ← ``dm.people[uid].features``.
    """
    data = _load()
    dm = data.get("dm") or {}
    person = (dm.get("people") or {}).get(str(uid or ""))
    folder = _person_folder_layer(data, uid)
    features = {feature: True for feature in DM_FEATURES}
    if folder is not None:
        # Người trong thư mục nhận đúng các nút thư mục đang hiện: mặc định ← thư mục (thấy sao áp vậy).
        features.update((data.get("defaults") or {}).get("features") or {})
        features.update(folder.get("features") or {})
    else:
        features.update(dm.get("features") or {})
    if person:
        features.update(person.get("features") or {})
    features = {k: bool(features[k]) for k in DM_FEATURES}
    # Vào thư mục = có trong danh sách nhắn riêng.
    return {"who": dm.get("who"), "listed": person is not None or folder is not None, "features": features}


def dm_allows(uid: str) -> Optional[bool]:
    """Người này (không phải chủ nhân) có được nhắn riêng không; None = tệp không nói, theo ZALO_DM_POLICY."""
    settings = dm_settings(uid)
    if settings["who"] is None:
        return None
    return settings["who"] == "everyone" or (settings["who"] == "list" and settings["listed"])


def dm_disabled_features(uid: str) -> List[str]:
    """Các nút đang tắt khi người này nhắn riêng, theo thứ tự DM_FEATURES."""
    features = dm_settings(uid)["features"]
    return [feature for feature in DM_FEATURES if not features[feature]]


def sandbox_mode() -> str:
    """``studio.sandbox.mode()``; lỗi bất kỳ → ``plain`` (đóng)."""
    try:
        from .studio import sandbox
        return sandbox.mode()
    except Exception:
        return "plain"


def video_policy() -> Dict[str, Any]:
    """Video (bộ dựng nặng nhất, có bước ra mạng) chỉ mở khi có hộp cát systemd. Windows, hoặc Linux chạy không
    hộp cát (không root, không systemd-run, ``ZALO_STUDIO_SANDBOX=none``) → ``videoBlocked`` + câu ghi chú (dashboard
    hiện đúng câu này, đọc từ ``studio-policy.json`` — xem ``publish_video_policy``)."""
    if VIDEO_BLOCKED:
        return {"videoBlocked": True, "note": WINDOWS_VIDEO_NOTE}
    if sandbox_mode() != "systemd":
        return {"videoBlocked": True, "note": PLAIN_VIDEO_NOTE}
    return {"videoBlocked": False, "note": ""}


def video_policy_path() -> Path:
    """``studio-policy.json`` cạnh ``permissions.json`` (dashboard đọc để khoá nút video và hiện ghi chú)."""
    return permissions_path().parent / "studio-policy.json"


def publish_video_policy(path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Ghi ``{"version": 1, "videoBlocked", "note", "sandbox"}`` (ghi nguyên tử). Cố hết sức: lỗi → None, ghi log."""
    target = Path(path) if path else video_policy_path()
    data = {"version": 1, **video_policy(), "sandbox": sandbox_mode()}
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, target)
    except OSError as exc:
        logger.warning("[zalo] không ghi được %s: %s", target, exc)
        return None
    return data


def _quota_chain(data: Dict[str, Any], uid: str, thread_id: str, is_group: bool, layer_key: str,
                 default_key: str, people_key: str, default: int) -> int:
    """Hạn mức theo lớp: người (mục ``studio``) ← (trong nhóm) nhóm ← thư mục ← mặc định của mục ``studio`` ← ``default``."""
    quota: Optional[int] = None
    if is_group:
        entry = (data.get("groups") or {}).get(str(thread_id or "")) or {}
        quota = entry.get(layer_key, _folder_layer(data, thread_id).get(layer_key))
    else:
        folder = _person_folder_layer(data, uid)
        if folder is not None:
            quota = folder.get(layer_key)
    studio = data.get("studio") or {}
    own = (studio.get(people_key) or {}).get(str(uid or ""))
    if own is not None:
        return own
    return quota if quota is not None else studio.get(default_key, default)


def media_quotas(uid: str, thread_id: str, is_group: bool) -> Dict[str, int]:
    """Số ảnh AI / video AI mỗi ngày của một người không phải chủ nhân trong hội thoại này."""
    data = _load()
    return {"image": _quota_chain(data, uid, thread_id, is_group, "imageQuota", "image", "imagePeople", DEFAULT_IMAGE_QUOTA),
            "video": _quota_chain(data, uid, thread_id, is_group, "videoQuota", "video", "videoPeople", DEFAULT_VIDEO_QUOTA)}


def studio_settings(uid: str, thread_id: str, is_group: bool) -> Dict[str, Any]:
    """Quyền xưởng của một người KHÔNG phải chủ nhân trong hội thoại này (bên gọi tự miễn trừ chủ nhân).

    ``features``: đủ 4 nút — TẮT ← ``defaults``/``dm`` ← thư mục ← nhóm/người (khoá thiếu rơi xuống lớp dưới;
    không có tệp, tệp hỏng, không đọc được → cả 4 tắt). ``quota``: số việc mỗi ngày —
    ``studio.people[uid]`` ← (trong nhóm) ``groups[id].studioQuota`` ← thư mục ← ``studio.quota`` ← 3.
    """
    data = _load()
    features = {feature: False for feature in STUDIO_FEATURES}
    quota: Optional[int] = None
    if is_group:
        entry = (data.get("groups") or {}).get(str(thread_id or "")) or {}
        folder = _folder_layer(data, thread_id)
        features.update((data.get("defaults") or {}).get("studio") or {})
        features.update(folder.get("studio") or {})
        features.update(entry.get("studio") or {})
        quota = entry.get("studioQuota", folder.get("studioQuota"))
    else:
        dm = data.get("dm") or {}
        person = (dm.get("people") or {}).get(str(uid or ""))
        folder = _person_folder_layer(data, uid)
        if folder is not None:
            features.update((data.get("defaults") or {}).get("studio") or {})
            features.update(folder.get("studio") or {})
            quota = folder.get("studioQuota")
        else:
            features.update(dm.get("studio") or {})
        if person:
            features.update(person.get("studio") or {})
    if video_policy()["videoBlocked"]:
        features["studioVideo"] = False
    studio = data.get("studio") or {}
    own = (studio.get("people") or {}).get(str(uid or ""))
    if own is not None:
        quota = own
    elif quota is None:
        quota = studio.get("quota", DEFAULT_STUDIO_QUOTA)
    return {"features": features, "quota": quota}
