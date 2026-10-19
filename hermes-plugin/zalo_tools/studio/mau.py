"""Slide theo MẪU người dùng gửi: trang mẫu (SVG do ``pptx_template_import.py`` dựng từ tệp .pptx, trong hộp cát) giữ
nguyên thiết kế; AI chỉ viết chữ cho từng ô, ở đây tự ngắt dòng / co chữ theo bề rộng ô.

Trang mẫu đến từ tệp người dùng gửi nên coi là KHÔNG tin cậy: không DOCTYPE/thực thể, mọi ``href`` chỉ được trỏ tới
``../images/<tệp>`` (ảnh mẫu đã tách ra) hoặc ``#id`` trong trang; thẻ script/foreignObject bị bỏ. Chữ AI viết chỉ được
gán vào ``text`` của phần tử (ElementTree tự thoát ký tự) — không bao giờ ghép thành XML."""
from __future__ import annotations

import copy
import re
from typing import Any, Dict, List, Tuple
from xml.etree import ElementTree as ET

SVG = "http://www.w3.org/2000/svg"
XLINK = "http://www.w3.org/1999/xlink"
ET.register_namespace("", SVG)
ET.register_namespace("xlink", XLINK)

MAX_TEMPLATE_PAGES = 30
MAX_SLOTS = 40                 # ô chữ mỗi trang mẫu đưa cho AI
MAX_SLOT_CHARS = 600
_HREF_OK = re.compile(r"^(?:\.\./images/[A-Za-z0-9._-]{1,80}|#[A-Za-z0-9._-]{1,80})$")
_DROP_TAGS = {"script", "foreignObject", "iframe", "object", "embed", "audio", "video"}


class TemplateError(ValueError):
    pass


def _tag(el: ET.Element) -> str:
    return el.tag.split("}")[-1]


def parse_page(text: str) -> ET.Element:
    """Trang mẫu → cây SVG đã lọc. Lỗi → TemplateError."""
    if re.search(r"<!(?:DOCTYPE|ENTITY)", text, re.I):
        raise TemplateError("trang mẫu có DOCTYPE/ENTITY")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise TemplateError(f"trang mẫu không đọc được ({exc})") from None
    if _tag(root) != "svg":
        raise TemplateError("trang mẫu không phải SVG")
    parent = {c: p for p in root.iter() for c in p}
    for el in list(root.iter()):
        bad = _tag(el) in _DROP_TAGS
        for name, value in list(el.attrib.items()):
            local = name.split("}")[-1].lower()
            if local.startswith("on"):
                del el.attrib[name]
            elif local in ("href", "src") and not _HREF_OK.match(value.strip()):
                bad = True
        if bad and el in parent:
            parent[el].remove(el)
    return root


def _text_of(el: ET.Element) -> str:
    return " ".join("".join(el.itertext()).split())


def slots(root: ET.Element) -> List[Dict[str, Any]]:
    """Ô chữ: ``<text>`` là con trực tiếp của nhóm có ``data-pptx-frame`` (khung hộp chữ trong PowerPoint)."""
    out = []
    for g in root.iter(f"{{{SVG}}}g"):
        frame = g.get("data-pptx-frame")
        if not frame:
            continue
        try:
            _x, _y, w, h = (float(v) for v in frame.split())
        except ValueError:
            continue
        for t in [c for c in g if c.tag == f"{{{SVG}}}text"]:
            text = _text_of(t)
            if not text or w <= 0:
                continue
            spans = t.findall(f"{{{SVG}}}tspan")
            first = spans[0] if spans else None
            try:
                size = float(t.get("font-size") or (first.get("font-size") if first is not None else "") or 24)
            except ValueError:
                size = 24.0
            dys = []
            for s in spans:
                try:
                    dys.append(float(s.get("dy")))
                except (TypeError, ValueError):
                    pass
            out.append({"el": t, "w": w, "h": h, "size": size, "lh": dys[0] if dys else size * 1.2,
                        "lines": 1 + len(dys), "text": text})
    return out[:MAX_SLOTS]


# Bề rộng tương đối của ký tự (× cỡ chữ), gần với font không chân thường gặp (Raleway, Arial, Montserrat…).
_NARROW = set("iljtf.,;:'!|ìíỉĩịI1()[] ")
_WIDE = set("mwMWQOGĐDHNUCÂÔƠ@%&")


def text_width(text: str, size: float) -> float:
    total = 0.0
    for ch in text:
        if ch in _NARROW:
            total += 0.3
        elif ch in _WIDE:
            total += 0.82
        elif ch.isupper() or ch.isdigit():
            total += 0.66
        else:
            total += 0.53
    return total * size


def wrap(text: str, width: float, size: float) -> List[str]:
    lines: List[str] = []
    cur = ""
    for word in text.split():
        nxt = f"{cur} {word}".strip()
        if cur and text_width(nxt, size) > width:
            lines.append(cur)
            cur = word
        else:
            cur = nxt
    if cur:
        lines.append(cur)
    return lines or [""]


def fill(slot: Dict[str, Any], text: str) -> Tuple[int, int, float]:
    """Thay chữ trong ô: ngắt dòng theo bề rộng khung; quá số dòng cho phép thì co chữ (tối đa còn 70%).
    Trả (số dòng, số dòng cho phép, tỉ lệ co)."""
    t, size0 = slot["el"], slot["size"]
    one_line_title = slot["lines"] == 1 and size0 >= 30
    allow = slot["lines"] if one_line_title else max(slot["lines"] + 1, int(slot["h"] / max(slot["lh"], 1)) + 1)
    scale, lines = 1.0, [text]
    for scale in (1.0, 0.92, 0.85, 0.78, 0.7):
        lines = wrap(text, slot["w"], size0 * scale)
        if len(lines) <= allow:
            break
    first = t.find(f"{{{SVG}}}tspan")
    style = {k: v for k, v in (first.attrib if first is not None else {}).items()
             if k in ("fill", "font-family", "font-weight", "font-style", "fill-opacity")}
    size = size0 * scale
    for child in list(t):
        t.remove(child)
    t.text = None
    t.set("font-size", f"{size:.2f}")
    for i, line in enumerate(lines):
        span = ET.SubElement(t, f"{{{SVG}}}tspan", {**style, "font-size": f"{size:.2f}"})
        if i:
            span.set("x", t.get("x") or "0")
            span.set("dy", f"{slot['lh'] * scale:.2f}")
        span.text = line
    return len(lines), allow, scale


def listing(protos: Dict[int, Tuple[ET.Element, List[Dict[str, Any]]]]) -> str:
    """Mô tả các trang mẫu cho AI: mỗi ô — cỡ chữ, bề rộng, số ký tự gợi ý, chữ mẫu (chỉ để biết vai trò)."""
    parts = []
    for n, (_root, ss) in protos.items():
        rows = []
        for i, s in enumerate(ss, 1):
            per_line = max(4, int(s["w"] / (s["size"] * 0.55)))
            room = per_line * (s["lines"] if s["lines"] == 1 and s["size"] >= 30 else s["lines"] + 1)
            rows.append(f"  S{i}: cỡ {s['size']:.0f}, ~{room} ký tự, mẫu \"{s['text'][:70]}\"")
        parts.append(f"Trang mẫu {n}:\n" + ("\n".join(rows) or "  (không có ô chữ)"))
    return "\n".join(parts)


def build_page(proto: ET.Element, values: Dict[str, Any]) -> Tuple[str, List[str]]:
    """Một trang mới từ trang mẫu + chữ cho các ô (``{"S1": "…"}``). Ô rỗng/thiếu thì bỏ khối chữ đó.
    Trả (SVG, ghi chú các ô phải co/tràn)."""
    root = copy.deepcopy(proto)
    parent = {c: p for p in root.iter() for c in p}
    notes = []
    for k, s in enumerate(slots(root), 1):
        value = " ".join(str(values.get(f"S{k}") or "").split())[:MAX_SLOT_CHARS]
        if not value:
            parent[s["el"]].remove(s["el"])
            continue
        n, allow, scale = fill(s, value)
        if n > allow:
            notes.append(f"S{k} dài hơn ô ({n}/{allow} dòng)")
    return ET.tostring(root, encoding="unicode"), notes


def check_plan(data: Any, pages: Dict[int, Any], max_pages: int) -> List[Dict[str, Any]]:
    """Kế hoạch AI trả: ``{"pages": [{"mau": n, "o": {"S1": "…"}}]}`` → danh sách đã kiểm."""
    from .validate import SourceError
    plan = data.get("pages") if isinstance(data, dict) else None
    if not isinstance(plan, list) or not 1 <= len(plan) <= max_pages:
        raise SourceError(f"cần 1–{max_pages} trang")
    out = []
    for page in plan:
        if not isinstance(page, dict):
            raise SourceError("trang không hợp lệ")
        try:
            n = int(page.get("mau"))
        except (TypeError, ValueError):
            n = -1
        if n not in pages:
            raise SourceError(f"`mau` phải là số trang mẫu có thật: {', '.join(map(str, pages))}")
        values = page.get("o")
        if not isinstance(values, dict):
            raise SourceError("mỗi trang cần `o`: chữ cho các ô S1, S2…")
        out.append({"mau": n, "o": {str(k): str(v)[:MAX_SLOT_CHARS] for k, v in values.items()
                                    if isinstance(v, (str, int, float))}})
    return out
