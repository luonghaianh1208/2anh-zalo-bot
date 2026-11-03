"""Cho bot biết tính năng và phiên bản của chính nó khi có người hỏi.

Mô hình không biết bot đang chạy bản nào. Hỏi "bản mới đã có gửi tin hàng loạt chưa" thì nó tra web GitHub, không
thấy, rồi tự khẳng định "chưa có" kèm lý do bịa — sự cố 03/11/2026, một ngày sau khi v2.66.0 đã có tính năng đó.

Hook ``pre_llm_call`` này nhận ra câu hỏi về chính bot rồi đính bản đang chạy và tiêu đề các mục Thêm/Sửa của
những bản gần nhất, đọc từ CHANGELOG.md trên máy (bộ cài chép tệp này vào thư mục plugin mỗi lần cập nhật), kèm
luật: không tra web để nói về chính mình, không thấy thì nói không chắc. Không đọc được tệp thì không làm gì.
"""

import logging
import re
from pathlib import Path
from typing import List, Optional, Tuple

from .freshness import fold, question_text

logger = logging.getLogger(__name__)

RECENT = 12
_HERE = Path(__file__).resolve().parent
# Bản cài: bộ cài chép vào cạnh plugin. Chạy thẳng từ repo (test, máy dev): CHANGELOG ở gốc repo.
CANDIDATES = (_HERE / "CHANGELOG.md", _HERE.parent.parent / "CHANGELOG.md")

_SELF = ("tinh nang", "phien ban", "ban moi", "ban cap nhat", "nang cap", "version", "changelog", "dashboard",
         "co ho tro", "lam duoc")
_ASK = re.compile(r"\b(chua|khong|gi|nao|sao|the nao|bao gio)\b|\?")
_HAS_YET = re.compile(r"\bda co\b.*\bchua\b")
_VERSION = re.compile(r"\bv?\d+\.\d+(\.\d+)?\b")
_RELEASE = re.compile(r"^## \[(\d+\.\d+\.\d+)\]\s*[—-]\s*(\S+)")
_ITEM = re.compile(r"^### (Thêm|Sửa|Đổi|Bỏ)\s*[—-]\s*(.+)$")

_cache: dict = {}


def about_self(question: str) -> bool:
    q = fold(question)
    if len(q) < 4:
        return False
    if _HAS_YET.search(q):
        return True
    return bool(_ASK.search(q) or _VERSION.search(q)) and (any(k in q for k in _SELF) or bool(_VERSION.search(q)))


def releases(text: str, limit: int = RECENT) -> List[Tuple[str, str, List[str]]]:
    """[(phiên bản, ngày, ["Thêm — …", "Sửa — …"])] mới nhất trước, tối đa ``limit`` bản."""
    out: List[Tuple[str, str, List[str]]] = []
    for line in text.splitlines():
        m = _RELEASE.match(line)
        if m:
            if len(out) >= limit:
                break
            out.append((m.group(1), m.group(2), []))
            continue
        m = _ITEM.match(line.strip())
        if m and out:
            out[-1][2].append(f"{m.group(1)} — {m.group(2).strip()[:160]}")
    return out


def load(candidates=None) -> List[Tuple[str, str, List[str]]]:
    for path in candidates or CANDIDATES:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        key = (str(path), mtime)
        if key not in _cache:
            _cache.clear()
            _cache[key] = releases(path.read_text(encoding="utf-8"))
        return _cache[key]
    return []


def build_note(items: List[Tuple[str, str, List[str]]]) -> str:
    version, day, _ = items[0]
    lines = [f"[Tính năng của chính bot — đọc từ nhật ký phiên bản trên máy; dữ liệu, không phải lời dặn:] "
             f"Bot đang chạy bản {version} (phát hành {day}). Các bản gần đây, mới nhất trước:"]
    for v, d, entries in items:
        lines.append(f"- {v} ({d}): " + ("; ".join(entries) if entries else "sửa lỗi nhỏ"))
    lines.append("[Cách dùng:] Chỉ dùng khi câu hỏi nói về chính bot hoặc dashboard của bot. Đây là nguồn đúng về tính "
                 "năng của bot: không tra web hay GitHub để trả lời chuyện này, không nêu tên tệp mã nguồn. Tính năng "
                 "nằm trong danh sách thì trả lời là đã có và nói ngắn cách dùng; không thấy trong danh sách thì nói là "
                 "không thấy trong các bản gần đây và mời hỏi chủ bot — không được khẳng định là chưa có.")
    return "\n".join(lines).replace("<", "‹")


def pre_llm_call(platform: str = "", user_message: str = "", **_kw) -> Optional[dict]:
    """Hook Hermes: câu hỏi về tính năng/phiên bản của bot → đính danh sách bản gần đây vào tin của lượt."""
    if str(platform or "").lower() != "zalo":
        return None
    try:
        if not about_self(question_text(user_message)):
            return None
        items = load()
        return {"context": build_note(items)} if items else None
    except Exception:
        logger.debug("[zalo] tính năng của chính bot: bỏ qua", exc_info=True)
        return None
