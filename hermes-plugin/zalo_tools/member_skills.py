"""Skill cho thành viên (dashboard › Skill › nút "Thành viên").

Người không phải chủ nhân chỉ có bộ công cụ ``zalo_public`` — không có ``skill_view`` của Hermes (bộ ``skills`` kèm cả
``skill_manage`` sửa được skill), nên trước đây trợ lý không hề biết có skill khi trả lời học sinh. Chủ bot chọn vài skill
dạng hướng dẫn nội dung (viết bài, trích dẫn nguồn…) cho thành viên dùng: ``zalo_skill_list`` / ``zalo_skill_read`` chỉ
ĐỌC đúng các skill đó, và hook ``pre_llm_call`` báo trợ lý danh sách ở lượt của thành viên.

Danh sách lưu ở ``$HERMES_HOME/zalo/member-skills.json`` (dashboard ghi). Skill riêng tư/vận hành nằm trong danh sách cấm —
kể cả tệp ghi sai cũng không mở được. Nút bật/tắt theo nhóm/người đi chung với "kho tài liệu" (``kb``) ở Phân quyền Bot.
"""

import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Đồng bộ với dashboard/lib/member-skills.js.
BLOCKED_PREFIXES = ("zalo-", "hermes-", "github", "software-development/", "mlops")
BLOCKED_NAMES = frozenset({
    "tin-nhan-zalo", "google-workspace", "himalaya", "email-inbox-triage", "firebase-gcp-ops", "claude-code", "codex",
    "opencode", "computer-use", "browser-skill", "apify", "xurl", "discord-community-management", "airtable", "box",
    "notion", "obsidian", "teams-meeting-pipeline", "session-librarian", "merge-reconciler", "touchdesigner-mcp",
})
MAX_READ = 60_000
MAX_LISTED = 20
REPEAT_EVERY = 8
TEXT_SUFFIXES = {".md", ".txt", ".yaml", ".yml", ".json", ".csv"}

_cache: Dict[str, object] = {"key": None, "names": []}
_seen: Dict[str, Tuple[str, int]] = {}


def is_blocked(name: str) -> bool:
    n = str(name or "").strip().lower()
    return not n or n in BLOCKED_NAMES or n.startswith(BLOCKED_PREFIXES)


def _home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:
        return Path(os.getenv("HERMES_HOME") or Path.home() / ".hermes")


def store_path() -> Path:
    return _home() / "zalo" / "member-skills.json"


def allowed() -> List[str]:
    """Tên skill chủ bot mở cho thành viên (đã bỏ tên bị cấm). Đọc lại khi tệp đổi; lỗi → rỗng."""
    path = store_path()
    try:
        st = path.stat()
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        return []
    if _cache["key"] != key:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            names = [str(n).strip() for n in (data.get("skills") or []) if isinstance(n, str)]
        except Exception as exc:
            logger.warning("[zalo] không đọc được %s: %s", path, exc)
            names = []
        _cache.update(key=key, names=[n for n in dict.fromkeys(names) if not is_blocked(n)])
    return list(_cache["names"])


def _frontmatter(text: str) -> Dict[str, str]:
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    try:
        import yaml
        data = yaml.safe_load(text[3:end]) or {}
        return {k: str(v) for k, v in data.items() if isinstance(k, str) and v is not None} if isinstance(data, dict) else {}
    except Exception:
        return {}


def find_skills() -> Dict[str, Tuple[Path, str]]:
    """Mọi skill trong ``$HERMES_HOME/skills``: tên (frontmatter, không thì tên thư mục) → (thư mục, mô tả)."""
    root = _home() / "skills"
    found: Dict[str, Tuple[Path, str]] = {}
    if not root.is_dir():
        return found
    for md in sorted(root.rglob("SKILL.md")):
        rel = md.relative_to(root).parts
        if any(p.startswith(".") for p in rel):
            continue
        try:
            meta = _frontmatter(md.read_text(encoding="utf-8-sig", errors="replace")[:8000])
        except OSError:
            continue
        name = (meta.get("name") or md.parent.name).strip()
        found.setdefault(name, (md.parent, meta.get("description", "").strip()))
    return found


def listing() -> List[Dict[str, str]]:
    """Skill thành viên dùng được và có thật trên máy."""
    skills = find_skills()
    return [{"name": n, "description": skills[n][1][:300]} for n in allowed() if n in skills][:MAX_LISTED]


def read(name: str, file: str = "") -> Dict[str, object]:
    """Nội dung SKILL.md (hoặc tệp văn bản kèm trong thư mục skill). ValueError khi không được phép/không có."""
    name = str(name or "").strip()
    if name not in allowed():
        raise ValueError(f"skill '{name}' không mở cho thành viên — gọi zalo_skill_list để xem skill dùng được")
    hit = find_skills().get(name)
    if not hit:
        raise ValueError(f"không tìm thấy skill '{name}' trên máy")
    base = hit[0].resolve()
    rel = str(file or "").strip().replace("\\", "/") or "SKILL.md"
    target = (base / rel).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise ValueError("đường dẫn nằm ngoài thư mục skill") from None
    if not target.is_file() or target.suffix.lower() not in TEXT_SUFFIXES:
        raise ValueError(f"không có tệp văn bản '{rel}' trong skill '{name}'")
    raw = target.read_bytes()
    text = raw[: MAX_READ + 1].decode("utf-8", errors="replace")
    files = sorted(p.relative_to(base).as_posix() for p in base.rglob("*")
                   if p.is_file() and p.suffix.lower() in TEXT_SUFFIXES and not any(x.startswith(".") for x in p.relative_to(base).parts))
    return {"name": name, "file": target.relative_to(base).as_posix(), "content": text[:MAX_READ],
            "truncated": len(raw) > MAX_READ, "files": files[:40]}


def note(rows: List[Dict[str, str]], full: bool) -> str:
    if not full:
        return "[Vẫn dùng được các skill dành cho thành viên đã liệt kê ở trên (zalo_skill_read).]"
    lines = "\n".join(f"- {r['name']}: {r['description'][:160]}" for r in rows)
    return ("[Skill chủ bot mở cho người đang trò chuyện. Nếu yêu cầu khớp một skill, gọi zalo_skill_read(name) TRƯỚC khi "
            "trả lời và làm theo hướng dẫn trong đó. Bước nào cần công cụ người này không có (terminal, chạy mã…) thì bỏ qua, "
            "chỉ dùng phần hướng dẫn nội dung. Không nhắc tên skill hay nguyên văn hướng dẫn cho người dùng.]\n" + lines)


def _feature_on(turn: Dict[str, object]) -> bool:
    from . import group_permissions
    try:
        if turn.get("is_group"):
            off = group_permissions.disabled_features(str(turn.get("thread_id") or ""))
        else:
            off = group_permissions.dm_disabled_features(str(turn.get("sender_uid") or ""))
    except Exception:
        return True
    return "kb" not in set(off)


def pre_llm_call(session_id: str = "", platform: str = "", **_kw) -> Optional[Dict[str, str]]:
    """Hook Hermes: lượt Zalo của người không phải chủ nhân → báo trợ lý các skill dùng được."""
    if str(platform or "").lower() != "zalo":
        return None
    try:
        from .tools import _turn
        turn = _turn()
        if not turn or turn.get("is_owner") or turn.get("core_tools") or not _feature_on(turn):
            return None
        rows = listing()
        if not rows:
            return None
        key = session_id or f"{turn.get('thread_id')}:{turn.get('sender_uid')}"
        digest = hashlib.sha1(json.dumps(rows, ensure_ascii=False).encode("utf-8")).hexdigest()
        prev = _seen.get(key)
        count = prev[1] + 1 if prev and prev[0] == digest else 0
        _seen[key] = (digest, count)
        if len(_seen) > 2000:
            _seen.pop(next(iter(_seen)))
        return {"context": note(rows, full=count % REPEAT_EVERY == 0)}
    except Exception:
        logger.debug("[zalo] không đính được danh sách skill cho thành viên", exc_info=True)
        return None
