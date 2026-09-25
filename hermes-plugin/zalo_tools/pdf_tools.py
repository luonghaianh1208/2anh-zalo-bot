"""Chuyển PDF sang Word, gộp và tách PDF — cho tệp người dùng gửi vào cuộc trò chuyện.

Công cụ không nhận đường dẫn từ mô hình. Adapter ghi danh sách tệp đính kèm của
đúng lượt đang chạy (tin vừa gửi, tin được reply, vài tin gần đó trong nhóm)
vào turn; ở đây chỉ chọn trong danh sách ấy theo số thứ tự. Nhờ vậy người trong
nhóm không trỏ được tới tệp nào khác trên máy chủ.

PDF do người ngoài gửi có thể được soạn để làm treo máy (hàng trăm nghìn trang,
ảnh nén bung ra hàng GB). Nên việc nặng chạy trong tiến trình con: quá giờ hay
lượt bị huỷ thì giết hẳn, không để luồng chạy mồ côi chiếm CPU/RAM của gateway.

Cần ``pymupdf`` (gộp/tách) và ``pdf2docx`` (sang Word).
"""

import json
import re
import sys
import threading
from pathlib import Path
from typing import Dict, List

MAX_FILE_MB = 30
MAX_PAGES_TO_WORD = 60
MAX_PAGES_TOTAL = 500
MAX_FILES = 10
TIMEOUT_S = 120
# Mỗi lúc một việc PDF cho cả bot: pdf2docx ngốn CPU, chạy song song là nghẽn.
LOCK = threading.Lock()
_RESULT_TAG = "__PDF_RESULT__"
_WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
                     *(f"LPT{i}" for i in range(1, 10))}


class PdfError(Exception):
    """Lỗi nói được thẳng cho người dùng."""


def is_pdf(item: Dict[str, str]) -> bool:
    return (str(item.get("mime") or "").lower() == "application/pdf"
            or str(item.get("name") or item.get("path") or "").lower().endswith(".pdf"))


def pick_pdfs(attachments: List[Dict[str, str]], picks: List[int]) -> List[Dict[str, str]]:
    """Chọn PDF theo số thứ tự (1-based) trong danh sách PDF của lượt; rỗng = tất cả."""
    pdfs = [a for a in attachments if is_pdf(a) and Path(str(a.get("path") or "")).is_file()]
    if not pdfs:
        raise PdfError("không thấy tệp PDF nào trong tin này — gửi hoặc reply vào tin có tệp PDF rồi nhờ lại")
    if not picks:
        return pdfs
    chosen = []
    for n in picks:
        if not isinstance(n, int) or not 1 <= n <= len(pdfs):
            raise PdfError(f"chỉ có {len(pdfs)} tệp PDF — số thứ tự {n} không hợp lệ")
        chosen.append(pdfs[n - 1])
    return chosen


def parse_pages(spec: str, page_count: int) -> List[int]:
    """'1-3, 5, 8-' → [0,1,2,4,7,...] (0-based, giữ thứ tự, bỏ trùng)."""
    pages: List[int] = []
    seen = set()
    for part in str(spec or "").replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d*)\s*-\s*(\d*)|(\d+)", part)
        if not m:
            raise PdfError(f"không hiểu khoảng trang '{part}' — viết kiểu 1-3, 5, 8-")
        if m.group(3):
            lo = hi = int(m.group(3))
        else:
            lo = int(m.group(1) or 1)
            hi = int(m.group(2) or page_count)
        if lo < 1 or hi > page_count or lo > hi:
            raise PdfError(f"khoảng trang '{part}' nằm ngoài 1–{page_count}")
        for p in range(lo - 1, hi):
            if p not in seen:
                seen.add(p)
                pages.append(p)
        if len(pages) > MAX_PAGES_TOTAL:
            raise PdfError(f"tách tối đa {MAX_PAGES_TOTAL} trang một lần")
    if not pages:
        raise PdfError("cần khoảng trang, ví dụ 1-3, 5")
    return pages


def _label(item: Dict[str, str]) -> str:
    return str(item.get("name") or Path(item["path"]).name)


def _open(item: Dict[str, str]):
    """Mở một PDF đã soát: đúng là PDF, không quá nặng, không khoá, không quá nhiều trang."""
    import pymupdf as fitz

    path = Path(item["path"])
    if path.stat().st_size > MAX_FILE_MB * 1024 * 1024:
        raise PdfError(f"tệp '{_label(item)}' nặng quá {MAX_FILE_MB} MB")
    # Tên và loại tệp do người gửi khai; đuôi .html/.svg mà mở tự do thì PyMuPDF
    # đổi sang bộ đọc khác. Chỉ nhận tệp có chữ ký PDF.
    with open(path, "rb") as fh:
        if b"%PDF-" not in fh.read(1024):
            raise PdfError(f"tệp '{_label(item)}' không phải PDF")
    try:
        doc = fitz.open(str(path), filetype="pdf")
    except Exception:
        raise PdfError(f"tệp '{_label(item)}' không phải PDF đọc được")
    if doc.needs_pass:
        doc.close()
        raise PdfError(f"tệp '{_label(item)}' có mật khẩu — gỡ mật khẩu rồi gửi lại")
    if doc.page_count > MAX_PAGES_TOTAL:
        count = doc.page_count
        doc.close()
        raise PdfError(f"tệp '{_label(item)}' dài {count} trang — tối đa {MAX_PAGES_TOTAL} trang")
    return doc


def _stem(item: Dict[str, str]) -> str:
    name = Path(str(item.get("name") or item.get("path") or "tai-lieu")).stem
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", name).strip(" .")[:80] or "tai-lieu"
    return f"_{name}" if name.split(".")[0].upper() in _WINDOWS_RESERVED else name


def to_word(item: Dict[str, str], out_dir: str) -> str:
    from pdf2docx import Converter

    doc = _open(item)
    try:
        if doc.page_count > MAX_PAGES_TO_WORD:
            raise PdfError(f"tệp dài {doc.page_count} trang — chỉ chuyển sang Word tối đa "
                           f"{MAX_PAGES_TO_WORD} trang; tách bớt trang trước rồi chuyển")
        if not any(page.get_text().strip() for page in doc):
            raise PdfError("tệp là bản quét ảnh, không có chữ để chuyển sang Word (cần nhận dạng chữ OCR)")
    finally:
        doc.close()
    out = Path(out_dir, f"{_stem(item)}.docx")
    cv = Converter(item["path"])
    try:
        # Mặc định pdf2docx bỏ qua trang lỗi rồi vẫn báo xong — thà báo lỗi còn hơn
        # gửi một tệp Word thiếu trang mà không ai biết.
        cv.convert(str(out), ignore_page_error=False)
    finally:
        cv.close()
    return str(out)


def merge(items: List[Dict[str, str]], out_dir: str) -> str:
    import pymupdf as fitz

    if len(items) < 2:
        raise PdfError("cần ít nhất 2 tệp PDF để gộp")
    if len(items) > MAX_FILES:
        raise PdfError(f"gộp tối đa {MAX_FILES} tệp một lần")
    out_doc = fitz.open()
    try:
        for item in items:
            src = _open(item)
            try:
                if out_doc.page_count + src.page_count > MAX_PAGES_TOTAL:
                    raise PdfError(f"tệp gộp vượt {MAX_PAGES_TOTAL} trang")
                out_doc.insert_pdf(src)
            finally:
                src.close()
        out = Path(out_dir, f"{_stem(items[0])} (gộp {len(items)} tệp).pdf")
        out_doc.save(str(out), garbage=3, deflate=True)
    finally:
        out_doc.close()
    return str(out)


def split(item: Dict[str, str], pages_spec: str, out_dir: str) -> str:
    import pymupdf as fitz

    src = _open(item)
    try:
        pages = parse_pages(pages_spec, src.page_count)
        out_doc = fitz.open()
        try:
            # Chèn theo từng dải trang liền nhau thay vì từng trang một.
            start = prev = pages[0]
            for p in pages[1:] + [None]:
                if p is not None and p == prev + 1:
                    prev = p
                    continue
                out_doc.insert_pdf(src, from_page=start, to_page=prev)
                if p is not None:
                    start = prev = p
            label = re.sub(r"[^\d,\-]", "", str(pages_spec))[:40]
            out = Path(out_dir, f"{_stem(item)} (trang {label}).pdf")
            out_doc.save(str(out), garbage=3, deflate=True)
        finally:
            out_doc.close()
    finally:
        src.close()
    return str(out)


RENDER_MAX_PAGES = 5
RENDER_MAX_SIDE_PX = 1800       # trang khổ khổng lồ không được bung thành ảnh hàng GB
RENDER_TIMEOUT_S = 60


def render(item: Dict[str, str], out_dir: str, max_pages: int = RENDER_MAX_PAGES) -> Dict:
    """Chuyển vài trang đầu thành JPEG để mô hình đọc bằng thị giác (PDF bản quét)."""
    import pymupdf as fitz

    doc = _open(item)
    try:
        paths = []
        for i in range(min(doc.page_count, max_pages)):
            page = doc[i]
            longest = max(page.rect.width, page.rect.height) or 1
            zoom = min(130 / 72, RENDER_MAX_SIDE_PX / longest)
            out = Path(out_dir, f"trang-{i + 1}.jpg")
            page.get_pixmap(matrix=fitz.Matrix(zoom, zoom)).save(str(out), jpg_quality=80)
            paths.append(str(out))
        return {"paths": paths, "total_pages": doc.page_count}
    finally:
        doc.close()


def _do(job: Dict):
    if job["action"] == "to_word":
        return to_word(job["items"][0], job["out_dir"])
    if job["action"] == "merge":
        return merge(job["items"], job["out_dir"])
    if job["action"] == "render":
        return render(job["items"][0], job["out_dir"])
    return split(job["items"][0], job.get("pages") or "", job["out_dir"])


async def _run_worker(job: Dict, timeout: int):
    import asyncio
    import os

    from .media import _kill_tree

    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(Path(__file__).resolve()),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, env=env,
    )
    try:
        out, _err = await asyncio.wait_for(proc.communicate(json.dumps(job).encode()), timeout=timeout)
    except asyncio.TimeoutError:
        await _kill_tree(proc)
        raise PdfError("tệp PDF xử lý quá lâu nên đã dừng — thử tệp nhỏ hơn hoặc tách bớt trang")
    except BaseException:
        await _kill_tree(proc)
        raise
    lines = [line for line in out.decode("utf-8", "replace").splitlines() if line.startswith(_RESULT_TAG)]
    if not lines:
        raise PdfError("không xử lý được tệp PDF này")
    result = json.loads(lines[-1][len(_RESULT_TAG):])
    if not result.get("ok"):
        raise PdfError(result.get("error") or "không xử lý được tệp PDF này")
    return result["result"]


def _inside(path: str, out_dir: str) -> Path:
    p = Path(path).resolve()
    if not p.is_file() or not p.is_relative_to(Path(out_dir).resolve()):
        raise PdfError("không xử lý được tệp PDF này")
    return p


async def run(action: str, items: List[Dict[str, str]], out_dir: str, pages: str = "") -> str:
    """Chạy việc PDF trong tiến trình con; trả đường dẫn tệp kết quả nằm trong ``out_dir``."""
    result = await _run_worker({"action": action, "items": items, "out_dir": out_dir, "pages": pages}, TIMEOUT_S)
    return str(_inside(result, out_dir))


async def render_pages(item: Dict[str, str], out_dir: str) -> Dict:
    """Ảnh JPEG của vài trang đầu (tiến trình con, có hạn giờ); ``{"paths", "total_pages"}``."""
    result = await _run_worker({"action": "render", "items": [item], "out_dir": out_dir}, RENDER_TIMEOUT_S)
    return {"paths": [str(_inside(p, out_dir)) for p in result.get("paths") or []],
            "total_pages": int(result.get("total_pages") or 0)}


def _worker() -> None:
    """Điểm vào của tiến trình con: đọc việc từ stdin, in kết quả có gắn thẻ."""
    job = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    try:
        result = {"ok": True, "result": _do(job)}
    except PdfError as exc:
        result = {"ok": False, "error": str(exc)}
    except ImportError:
        result = {"ok": False, "error": "máy chủ chưa cài thư viện xử lý PDF (pymupdf, pdf2docx)"}
    except Exception as exc:  # PDF hỏng kiểu lạ: báo gọn, không lộ chi tiết máy chủ
        print(f"pdf worker: {type(exc).__name__}: {exc}", file=sys.stderr)
        result = {"ok": False, "error": "không xử lý được tệp PDF này"}
    print(_RESULT_TAG + json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    _worker()
