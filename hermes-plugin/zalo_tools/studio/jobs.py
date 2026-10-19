"""Hàng đợi xưởng: nhận việc, viết (AI không công cụ) → kiểm → dựng (tiến trình con) → gửi → dọn.

Chạy trên MỘT luồng riêng có vòng lặp asyncio của nó: vòng lặp của luồng agent chỉ chạy khi có
công cụ đang chạy, việc nền gắn vào đó sẽ đứng im ngay khi ``zalo_studio`` trả lời. Mặc định một
việc một lúc (``ZALO_STUDIO_CONCURRENCY`` tối đa 2), tối đa 5 việc chờ, mỗi người một việc.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import stat
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Tuple

from . import author, builtin, doan_docx, images, mau, recipes, sandbox, validate
from .. import group_permissions as gp
from . import ledger as ledger_module
from .ledger import Ledger

logger = logging.getLogger(__name__)

MAX_QUEUE = 5
MAX_FILES = 4
MAX_FILE_BYTES = {".mp4": 200 * 1024 * 1024}
DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_SLIDE_PAGES = validate.MAX_PAGES
MAX_TEMPLATE_BYTES = 40 * 1024 * 1024   # tệp .pptx mẫu người dùng gửi
STALE_DIR_SECONDS = 24 * 3600
# error.step của bộ dựng 2Anh Studio do NỘI DUNG sai (viết lại được); bước khác là lỗi máy.
CONTENT_STEPS = {"input", "parse", "canh", "model", "check", "framework", "json", "the-thuc"}
SLIDE_MAX_AI_IMAGES = 4
SLIDE_MAX_WEB_IMAGES = 6
IMAGE_TOOL_NAME = "2Anh Zalo (máy chủ)"
LECTURE_VOICE = "vi-VN-HoaiMyNeural"   # edge-tts: chỉ khi 2Anh Studio cũ chưa có giong_bai_giang.py
# Giọng VieNeu của lời giảng (2Anh Studio vi.20 giong_bai_giang.py; máy không có VieNeu thì script tự lùi về edge-tts).
LECTURE_VIENEU = "thu-giang"
# Mã lỗi của bộ kiểm văn bản Đoàn do DỮ LIỆU còn thiếu (bản nháp) — không phải lỗi thể thức của bộ sinh.
DOAN_DRAFT_CODES = {"placeholder": "Bản nháp: còn ô [CẦN BỔ SUNG] cần điền",
                    "invalid_document_number": "Số văn bản để trống cho văn thư điền"}
# Trả lượt CHỈ khi việc chưa tốn gì: không ảnh nào, token ≤ ngưỡng nhỏ này (một lời gọi AI thật — có hướng dẫn
# trong system prompt — luôn vượt xa). Lỗi máy sau khi đã tốn (bộ dựng hỏng, gửi không được…) vẫn tính lượt:
# nếu không, người ngoài cố tình làm hỏng (tìm ảnh không ra, ký tự lạ…) là được việc miễn phí vô hạn.
SPEND_TOKENS = ledger_module.SPEND_TOKENS
# Trang thí nghiệm ảo (2Anh Studio) chỉ cần CSS + JS nội tuyến và canvas — như games.html, không mạng, không ảnh.
THI_NGHIEM_CSP = ("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; "
                  "connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; "
                  "worker-src 'none'; base-uri 'none'; form-action 'none'")


class StudioError(Exception):
    """Việc hỏng. ``refund``: lỗi do máy — chỉ được trả lượt khi việc CHƯA tốn gì (``spent``) và người này chưa hết
    trần trả lượt hôm nay (sổ lượt); ngược lại (do nội dung) luôn tính lượt."""

    def __init__(self, message: str, *, refund: bool):
        super().__init__(message)
        self.refund = refund


class Busy(Exception):
    pass


@dataclass
class Job:
    id: str
    kind: str
    brief: str
    options: Dict[str, str]
    turn: Dict[str, Any]          # danh tính chụp lúc nhận việc — nơi gửi trả, không lấy từ mô hình
    created: float = field(default_factory=time.time)
    script: str = ""              # video: kịch bản người dùng đã duyệt (bước lên kịch bản) — dựng đúng bản này
    template: str = ""            # slide: tệp .pptx mẫu người dùng gửi (đã kiểm nằm trong cache/documents)

    @property
    def uid(self) -> str:
        return str(self.turn.get("sender_uid") or "")

    @property
    def name(self) -> str:
        return str(self.turn.get("sender_name") or "") or "bạn"

    @property
    def recipe(self) -> recipes.Recipe:
        return recipes.RECIPES[self.kind]


def new_job_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)


@dataclass
class Outcome:
    files: List[Path]
    notes: List[str]
    usage: author.Usage
    images: int = 0


def stamp_names(files: List[Path]) -> List[Path]:
    """Đổi tên tệp gửi đi theo mẫu tên tệp chủ bot đã cài (vd. ``van-ban_20261012-153000.docx``)."""
    from ..reply_style import file_name

    out = []
    for f in files:
        target = f.with_name(file_name(f.stem, f.suffix))
        try:
            out.append(f.rename(target) if target != f and not target.exists() else f)
        except OSError:
            out.append(f)
    return out


def spent(usage: author.Usage, images: int) -> bool:
    """Việc đã tốn tiền thật chưa: có ảnh, token vượt ngưỡng nhỏ, hoặc đã gọi AI mà không biết số token."""
    tokens = usage.input_tokens + usage.output_tokens
    return images > 0 or tokens > SPEND_TOKENS or (usage.calls > 0 and tokens == 0)


# Đường dẫn tuyệt đối (Windows/POSIX/UNC), tên tệp mã — không đưa cho người ngoài.
_PATHISH = re.compile(r"(?<![\w/\\])(?:[A-Za-z]:[\\/]|\\\\|/(?=[\w.~-]+/))[^\s'\"<>|,;()]*"
                      r"|\b[\w.-]+\.(?:py|pyc|js|mjs|cjs|ts|json|sh|ps1|exe|dll|so|env|db|log)\b", re.I)
_INTERNAL = re.compile(r"traceback|exception|errno|winerror|\b[A-Z][a-z]+Error\b|\bline \d+|File \"", re.I)


def public_message(text: str) -> str:
    """Câu lỗi gửi cho người nhờ: bỏ đường dẫn/tên tệp mã; dấu vết lỗi bên trong → câu chung."""
    text = " ".join(str(text or "").split())
    if _INTERNAL.search(text):
        return "máy chủ gặp lỗi khi dựng sản phẩm"
    return _PATHISH.sub("…", text)[:300]


def _regular_files(job_dir: Path, folder: Path, suffix: str) -> List[Path]:
    """Tệp thường có đuôi ``suffix`` trong ``folder`` — ``scandir`` + ``lstat`` (không theo liên kết); gặp liên kết,
    FIFO, tệp nhiều liên kết cứng → ``UnsafeJobDir``. Thư mục chưa có → []."""
    folder = sandbox.contained(job_dir, folder)
    if not os.path.isdir(folder):
        return []
    out = []
    with os.scandir(folder) as entries:
        for entry in entries:
            if not entry.name.lower().endswith(suffix):
                continue
            st = os.lstat(entry.path)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink > 1:
                raise sandbox.UnsafeJobDir("thư mục kết quả có liên kết/tệp lạ")
            out.append(Path(entry.path))
    return sorted(out)


def add_csp(job_dir: Path, page: Path, policy: str = THI_NGHIEM_CSP) -> None:
    """Chèn ``<meta http-equiv="Content-Security-Policy">`` ngay sau ``<head>`` (trước mọi style/script) — đọc/ghi
    không theo liên kết. Không có ``<head>`` → trang lạ, dừng (không gửi trang không có CSP)."""
    html = sandbox.read_file(job_dir, page, limit=DEFAULT_MAX_FILE_BYTES).decode("utf-8")
    match = re.search(r"<head(?:\s[^>]*)?>", html, re.I)
    if not match or re.search(r"http-equiv\s*=\s*[\"']?content-security-policy", html, re.I):
        raise StudioError("trang thí nghiệm không đúng khuôn", refund=False)
    meta = f'\n<meta http-equiv="Content-Security-Policy" content="{policy}">'
    sandbox.write_file(job_dir, page, (html[:match.end()] + meta + html[match.end():]).encode("utf-8"))


# ---------------------------------------------------------------------- dựng
def _last_json(text: str) -> Dict[str, Any]:
    for line in reversed((text or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                value = json.loads(line)
                return value if isinstance(value, dict) else {}
            except json.JSONDecodeError:
                return {}
    return {}


def collect(job_dir: Path, project: Path, outputs: Sequence[str]) -> List[Path]:
    """Tệp kết quả: nằm trong thư mục việc, đúng đuôi, không quá cỡ; nhiều nhất 4 tệp. Quét lại thư mục việc trước
    (liên kết tượng trưng/tệp lạ → dừng, tính lượt)."""
    try:
        sandbox.scan_job_dir(job_dir)
    except sandbox.UnsafeJobDir:
        raise StudioError("bộ dựng để lại tệp không an toàn nên đã dừng", refund=False) from None
    root = job_dir.resolve()
    found = []
    for path in sorted(project.rglob("*")):
        try:
            real = path.resolve()
        except OSError:
            continue
        if path.is_symlink() or not real.is_file() or root not in real.parents:
            continue
        if real.suffix.lower() not in outputs or "backup" in real.relative_to(root).parts:
            continue
        if real.stat().st_size > MAX_FILE_BYTES.get(real.suffix.lower(), DEFAULT_MAX_FILE_BYTES):
            raise StudioError("tệp làm ra quá lớn để gửi qua Zalo", refund=False)
        found.append(real)
    if not found:
        raise StudioError("bộ dựng không tạo ra tệp nào", refund=True)
    return found[:MAX_FILES]


class Builder:
    """Một việc: chỗ cài, thư mục việc, AI viết, chạy bộ dựng. Tách riêng để test thay từng phần."""

    def __init__(self, job: Job, llm: Any, where: recipes.Places, job_dir: Path,
                 on_spend: Optional[Callable[[author.Usage, int], None]] = None):
        self.job, self.llm, self.where, self.job_dir = job, llm, where, job_dir
        self.recipe = job.recipe
        self.project = job_dir / "p"
        self.on_spend = on_spend
        self.usage = author.Usage(limit=self.recipe.max_tokens, listener=self._spent)
        self.notes: List[str] = []
        self.images_used = 0
        self.guides = author.read_guides(recipes.guide_paths(self.recipe, where, job.options))

    def _spent(self) -> None:
        """Token/ảnh vừa tăng — báo bên gọi để ghi sổ dần (lỗi ghi sổ không được làm hỏng việc)."""
        if self.on_spend:
            try:
                self.on_spend(self.usage, self.images_used)
            except Exception as exc:
                logger.warning("[zalo] xưởng %s: không ghi dần chi phí: %s", self.job.id, exc)

    async def write(self, *, types: Sequence[str] = (), repair: Optional[Tuple[str, str]] = None) -> str:
        return await author.write_source(
            self.llm, kind=self.job.kind, builder=self.recipe.builder, source=self.recipe.source,
            guides=self.guides, brief=self.job.brief, options=self.job.options, usage=self.usage,
            types=types, repair=repair)

    async def run(self, argv: Sequence[str], *, timeout: Optional[int] = None,
                  extra: Sequence[Optional[Path]] = (), extra_env: Optional[Dict[str, str]] = None,
                  network: Optional[bool] = None) -> sandbox.Result:
        """``network``: None = theo công thức. Bước nào không cần mạng thì truyền False (lập kế hoạch ảnh, kiểm…).

        Trước VÀ SAU mỗi bước, quét thư mục việc: bộ dựng (đã chạy nội dung của AI) để lại liên kết tượng trưng /
        tệp đặc biệt (FIFO…) / liên kết cứng → gỡ và dừng việc, TÍNH lượt (nghi do nội dung) — nên mọi chỗ tiến
        trình cha đọc/ghi sau bước này không gặp liên kết. Đường dẫn cấu hình không dùng được cho systemd (khoảng
        trắng…) → lỗi máy."""
        try:
            sandbox.prepare_job_dir(self.job_dir)
            read_only = sandbox.read_only_paths(str(self.where.python) if self.where.python else None,
                                                self.where.studio, *extra)
            result = await sandbox.run(argv, self.job_dir, timeout=timeout or self.recipe.timeout,
                                       network=self.recipe.network if network is None else network,
                                       read_only=read_only, extra_env=extra_env)
            sandbox.scan_job_dir(self.job_dir)
            return result
        except sandbox.UnsafeJobDir as exc:
            logger.warning("[zalo] xưởng %s: %s", self.job.id, exc)
            raise StudioError("bộ dựng để lại tệp không an toàn nên đã dừng", refund=False) from None
        except sandbox.SandboxConfigError as exc:
            logger.error("[zalo] xưởng %s: %s", self.job.id, exc)
            raise StudioError("hộp cát trên máy chủ cấu hình sai", refund=True) from None

    # -- ảnh: chỉ plugin vẽ/tải, ở tiến trình cha (studio/images.py) --------------
    async def picture(self, request: Dict[str, str], *, size: str, orientation: str) -> images.Picture:
        if "icon" in request:
            # Icon Iconify miễn phí, không tốn lượt vẽ/tìm ảnh: không tính vào images_used, không chặn hoàn lượt.
            return await images.search_icon(request["icon"])
        if "ai" in request:
            picture = await images.generate(request["ai"], size)
        else:
            picture = await images.search_web(request["web"], orientation)
        self.images_used += 1
        self._spent()
        return picture

    async def deck_images(self, requests: List[Dict[str, str]], folder: Path) -> Dict[str, Dict[str, str]]:
        """Ảnh slide mô hình đã xin → ``{mã: {path (tương đối từ svg_output), note}}``; ảnh không lấy được thì bỏ."""
        got: Dict[str, Dict[str, str]] = {}
        for request in requests:
            try:
                picture = await self.picture(request, size="1536x1024", orientation="landscape")
            except images.ImageError as exc:
                logger.info("[zalo] xưởng %s: bỏ ảnh %s — %s", self.job.id, request["id"], exc)
                self.notes.append(f"không lấy được ảnh {request['id']} ({exc})")
                continue
            path = images.save(picture, folder, request["id"], root=self.job_dir)
            if "icon" in request:
                credit = "icon PNG vuông nền trong suốt, một màu — đặt nhỏ (khoảng 64–160 px) cạnh tiêu đề/ý"
                # Bộ icon CC BY bắt buộc ghi nguồn; MIT/Apache/ISC/OFL thì không cần ghi trên trang.
                if "CC BY" in picture.license.upper():
                    credit += f"; ghi rất nhỏ ở chân trang: 'Icon: {picture.provider.split('/', 1)[-1]} · {picture.license}'"
            elif "ai" in request:
                credit = "ảnh vẽ bằng AI"
            else:
                credit = f"ảnh web — ghi nhỏ dưới ảnh: 'Ảnh: {picture.author} · {picture.license}'"
            got[request["id"]] = {"path": f"../images/{path.name}",
                                  "note": f"{(request.get('ai') or request.get('web') or request.get('icon'))[:80]}; {credit}"}
        return got

    async def with_repair(self, attempt: Callable[[str], Awaitable[List[Path]]], first: str) -> List[Path]:
        """Thử nội dung; nội dung sai thì nhờ AI viết lại đúng một lần."""
        text = first
        for round_ in (1, 2):
            try:
                return await attempt(text)
            except validate.SourceError as exc:
                if round_ == 2:
                    raise StudioError(f"nội dung chưa dựng được ({exc})", refund=False) from None
                logger.info("[zalo] xưởng %s: viết lại vì %s", self.job.id, exc)
                text = await self.write(types=self._types(), repair=(text, str(exc)))
        raise AssertionError("unreachable")

    def _types(self) -> Sequence[str]:
        return recipes.DOC_TYPES.get(self.recipe.script, ())

    # -- từng loại bộ dựng -------------------------------------------------
    async def studio_cli(self) -> List[Path]:
        library = validate.library_ids(self.where.studio)
        extra_env: Dict[str, str] = {}
        extra: List[Optional[Path]] = []
        if self.recipe.kind == "video":
            browsers = sandbox.browsers_dir()
            extra.append(browsers)
            if browsers:
                extra_env = {"PLAYWRIGHT_BROWSERS_PATH": str(browsers), "LOCALAPPDATA": str(browsers.parent)}

        async def attempt(text: str) -> List[Path]:
            if self.recipe.kind == "thi_nghiem":
                text = validate.check_thi_nghiem(text, library)
            elif self.recipe.kind == "video":
                text = validate.check_video(text, library)
            else:
                text = validate.clean_text(text)
            if self.project.exists():
                shutil.rmtree(self.project)
            self.project.mkdir(parents=True)
            sandbox.write_file(self.job_dir, self.project / self.recipe.source, text.encode("utf-8"))
            if self.recipe.kind == "video" and validate.front_matter(text)[0].get("phong-cach") == "vox":
                await self.vox_images(extra, extra_env)
            args = [a.replace("{project}", str(self.project)) for a in self.recipe.args]
            result = await self.run([str(self.where.python), str(self.where.studio / self.recipe.script), *args],
                                    extra=extra, extra_env=extra_env)
            files = self._studio_result(result)
            if self.recipe.kind == "thi_nghiem":
                for page in files:
                    if page.suffix.lower() == ".html":
                        add_csp(self.job_dir, page)
            return files

        return await self.with_repair(attempt, self.job.script or await self.write())

    async def vox_images(self, extra: Sequence[Optional[Path]], extra_env: Optional[Dict[str, str]]) -> None:
        """Video Vox: 2Anh Studio LẬP KẾ HOẠCH ảnh (trong hộp cát, không mạng) → plugin vẽ/tải đúng các ảnh đó ở
        tiến trình cha → 2Anh Studio xử lý ảnh đã có (trong hộp cát, không mạng, không khoá)."""
        script = str(self.where.studio / "tools" / "vi" / "anh_vox.py")
        plan = await self.run([str(self.where.python), script, str(self.project), "--chi-ke-hoach"], timeout=120,
                              network=False, extra=extra, extra_env=extra_env)
        if plan.timed_out or not _last_json(plan.out).get("ready"):
            error = _last_json(plan.out).get("error") or {}
            if error.get("step") in CONTENT_STEPS:
                raise validate.SourceError(str(error.get("message") or "kế hoạch ảnh sai")[:600])
            raise StudioError("chưa lập được kế hoạch ảnh cho video", refund=True)
        try:
            raw = sandbox.read_file(self.job_dir, self.project / "anh" / "ai" / "ke-hoach.json", limit=2_000_000)
            items = json.loads(raw.decode("utf-8"))["muc"]
        except sandbox.UnsafeJobDir:
            raise StudioError("kế hoạch ảnh của video không an toàn", refund=False) from None
        except (OSError, ValueError, KeyError, TypeError):
            raise StudioError("kế hoạch ảnh của video hỏng", refund=True) from None
        root = self.project.resolve()
        wanted = []
        for item in items if isinstance(items, list) else []:
            source = item.get("nguon") if isinstance(item, dict) else None
            if source not in ("ve", "tim"):
                raise validate.SourceError("video chỉ dùng ảnh `ve:` hoặc `tim:` (không dùng tệp có sẵn)")
            target = (self.project / str(item.get("file_goc") or "")).resolve()
            size = str(item.get("kich_thuoc") or "1920x1080")
            if root not in target.parents or target.suffix not in (".png", ".jpg") or not re.fullmatch(r"\d{3,4}x\d{3,4}", size):
                raise StudioError("kế hoạch ảnh của video có mục lạ", refund=True)
            wanted.append((source, str(item.get("prompt") or ""), size, target))
        if sum(1 for w in wanted if w[0] == "ve") > images.MAX_AI_IMAGES:
            raise validate.SourceError(f"video cần quá {images.MAX_AI_IMAGES} ảnh AI — bớt nhịp `anh: ve:`/nền cảnh")
        if sum(1 for w in wanted if w[0] == "tim") > images.MAX_WEB_IMAGES:
            raise validate.SourceError(f"video cần quá {images.MAX_WEB_IMAGES} ảnh web — bớt nhịp `anh: tim:`")
        # Tìm ảnh web TRƯỚC khi vẽ ảnh AI: từ khoá không ra ảnh thì dừng khi chưa tốn tiền vẽ.
        wanted.sort(key=lambda w: w[0] != "tim")
        sources = []
        for source, prompt, size, target in wanted:
            if target.is_file():
                continue
            request = {"ai": prompt} if source == "ve" else {"web": prompt}
            try:
                width, height = (int(n) for n in size.split("x"))
                picture = await self.picture(request, size=size, orientation="portrait" if width < height else "landscape")
            except images.ImageError as exc:
                # Từ khoá/mô tả do nội dung chọn → tính lượt (không thì tìm-không-ra là lối lấy việc miễn phí).
                raise StudioError(f"không lấy được ảnh cho video ({exc})", refund=False) from None
            try:
                sandbox.write_file(self.job_dir, target, picture.data)   # không theo liên kết, không ra ngoài
            except sandbox.UnsafeJobDir:
                raise StudioError("thư mục ảnh của video không an toàn", refund=False) from None
            if source == "tim":
                sources.append({"filename": target.name, "author": picture.author, "license_name": picture.license,
                                "provider": picture.provider, "source_url": picture.source_url})
        if sources:
            images.sources_manifest(sources, self.project / "anh" / "image_sources.json", root=self.job_dir)
        model = images.image_config().model
        done = await self.run([str(self.where.python), script, str(self.project), "--cong-cu", IMAGE_TOOL_NAME,
                               "--mo-hinh", model], timeout=900, network=False, extra=extra, extra_env=extra_env)
        if done.timed_out or not _last_json(done.out).get("ready"):
            logger.warning("[zalo] xưởng %s: xử lý ảnh Vox lỗi — %s", self.job.id, (done.out + done.err)[-2000:])
            raise StudioError("chưa xử lý được ảnh cho video", refund=True)

    def _studio_result(self, result: sandbox.Result) -> List[Path]:
        if result.timed_out:
            raise StudioError("làm quá lâu nên đã dừng", refund=True)
        report = _last_json(result.out)
        if report.get("ready"):
            self.notes = [str(w)[:200] for w in (report.get("warnings") or [])[:3]]
            return collect(self.job_dir, self.project, self.recipe.outputs)
        error = report.get("error") if isinstance(report.get("error"), dict) else {}
        if error.get("step") in CONTENT_STEPS:
            raise validate.SourceError(str(error.get("message") or "nội dung sai ngữ pháp")[:600])
        logger.warning("[zalo] xưởng %s: bộ dựng lỗi %s — %s", self.job.id, error or result.code, result.err[-2000:])
        raise StudioError("máy chủ chưa dựng được sản phẩm này", refund=True)

    async def node_engine(self) -> List[Path]:
        skill = self.where.skills / self.recipe.script

        async def attempt(text: str) -> List[Path]:
            data = validate.check_engine_json(text, self._types(), recipes.ENGINE_KEYS[self.recipe.script])
            if self.project.exists():
                shutil.rmtree(self.project)
            self.project.mkdir(parents=True)
            source = self.project / self.recipe.source
            sandbox.write_file(self.job_dir, source, json.dumps(data, ensure_ascii=False).encode("utf-8"))
            out = self.project / "van-ban.docx"
            script = skill / recipes.node_engine(self.recipe, data["loai_van_ban"])
            result = await self.run([self.where.node, str(script), "--input", str(source), "--output", str(out)],
                                    extra=[skill])
            if result.timed_out:
                raise StudioError("làm quá lâu nên đã dừng", refund=True)
            if result.code != 0 or not out.is_file():
                logger.warning("[zalo] xưởng %s: bộ soạn văn bản lỗi %s — %s", self.job.id, result.code, result.err[-2000:])
                raise validate.SourceError("bộ soạn văn bản không đọc được nội dung — kiểm lại các trường theo ví dụ")
            return collect(self.job_dir, self.project, self.recipe.outputs)

        return await self.with_repair(attempt, await self.write(types=self._types()))

    async def markdown_docx(self) -> List[Path]:
        async def attempt(text: str) -> List[Path]:
            text = validate.clean_text(text)
            self.project.mkdir(parents=True, exist_ok=True)
            out = self.project / f"{self.recipe.source.rsplit('.', 1)[0]}.docx"
            await asyncio.to_thread(builtin.build_markdown_docx, text, self.recipe.label, out)
            return collect(self.job_dir, self.project, self.recipe.outputs)

        return await self.with_repair(attempt, await self.write())

    async def game_html(self) -> List[Path]:
        kind = self.job.options.get("loai", "quiz")

        async def attempt(text: str) -> List[Path]:
            data = validate.check_game(text, kind)
            self.project.mkdir(parents=True, exist_ok=True)
            builtin.build_game_html(data, self.project / f"tro-choi-{kind}.html")
            return collect(self.job_dir, self.project, self.recipe.outputs)

        return await self.with_repair(attempt, await self.write())

    async def doan_docx(self) -> List[Path]:
        validator = self.where.skills / self.recipe.script / "scripts" / "validate_van_ban_doan.py"

        async def attempt(text: str) -> List[Path]:
            data = validate.check_doan_json(text)
            self.project.mkdir(parents=True, exist_ok=True)
            out = self.project / "van-ban-doan.docx"
            await asyncio.to_thread(doan_docx.build, data, out)
            report = await self.doan_report(validator, out)
            errors = [i for i in report.get("items") or [] if isinstance(i, dict) and i.get("level") == "error"]
            hard = [i for i in errors if i.get("code") not in DOAN_DRAFT_CODES]
            if hard:
                logger.warning("[zalo] xưởng %s: bộ kiểm văn bản Đoàn báo %s", self.job.id, hard)
                raise StudioError("văn bản Đoàn chưa qua bộ kiểm thể thức", refund=False)
            self.notes = [DOAN_DRAFT_CODES[i["code"]] for i in errors] + ["Chưa ký, chưa đóng dấu"]
            return collect(self.job_dir, self.project, self.recipe.outputs)

        return await self.with_repair(attempt, await self.write())

    async def doan_report(self, validator: Path, docx: Path) -> Dict[str, Any]:
        """Bộ kiểm của skill soan-van-ban-doan chạy như MỌI bộ dựng: tiến trình con trong hộp cát, dòng lệnh cố định
        (``validate_van_ban_doan.py <docx> --profile doan --json``), không mạng — không nạp mã skill vào gateway.
        Python của gateway (có python-docx) được gắn chỉ đọc."""
        python = Path(sys.executable)
        result = await self.run([str(python), str(validator), str(docx), "--profile", "doan", "--json"], timeout=120,
                                network=False, extra=[validator.parent, Path(sys.prefix), *sandbox.read_only_paths(str(python))])
        try:
            report = json.loads(result.out) if not result.timed_out and result.code in (0, 2) else None
        except ValueError:
            report = None
        if not isinstance(report, dict):
            logger.warning("[zalo] xưởng %s: bộ kiểm văn bản Đoàn lỗi %s — %s", self.job.id, result.code, result.err[-2000:])
            raise StudioError("chưa kiểm được thể thức văn bản Đoàn", refund=True)
        return report

    async def _deck(self) -> Tuple[Dict[str, Any], Dict[int, str], Path, Dict[str, Dict[str, str]]]:
        """Dàn ý → ảnh → trang SVG → bộ kiểm (sửa 1 vòng). Trả (dàn ý, trang, thư mục scripts, ảnh)."""
        scripts = self.where.studio / "skills" / "ppt-master" / "scripts"
        py = str(self.where.python)
        guard = await self.run([py, str(scripts / "attribution_guard.py")], timeout=60, network=False)
        if guard.code != 0:
            raise StudioError("bộ làm slide trên máy chủ không còn nguyên vẹn", refund=True)
        try:
            outline = await author.write_outline(self.llm, guides=self.guides, brief=self.job.brief,
                                                 options=self.job.options, usage=self.usage, max_pages=MAX_SLIDE_PAGES,
                                                 max_ai=SLIDE_MAX_AI_IMAGES, max_web=SLIDE_MAX_WEB_IMAGES,
                                                 max_icon=images.MAX_ICONS)
        except validate.SourceError as exc:
            raise StudioError(f"chưa lập được dàn ý ({exc})", refund=False) from None
        init = await self.run([py, str(scripts / "project_manager.py"), "init", "deck", "--quick-generate",
                               "--dir", str(self.job_dir)], timeout=120, network=False)
        with os.scandir(self.job_dir) as entries:
            decks = sorted(Path(e.path) for e in entries
                           if e.name.startswith("deck_") and stat.S_ISDIR(os.lstat(e.path).st_mode))
        if init.code != 0 or not decks:
            raise StudioError("chưa tạo được dự án slide", refund=True)
        self.project = decks[0]
        pics = await self.deck_images(outline.get("images") or [], self.project / "images")
        # Ảnh không lấy được thì bỏ khỏi dàn ý, để AI viết trang không còn trỏ tới nó.
        outline["images"] = [i for i in outline.get("images") or [] if i["id"] in pics]
        refs = {k: v["path"] for k, v in pics.items()}
        available = {k: v["note"] for k, v in pics.items()}
        pages = {}
        for index in range(1, len(outline["pages"]) + 1):
            pages[index] = await self._page(outline, index, None, refs, available)
        svg_dir = self.project / "svg_output"
        for round_ in (1, 2):
            for old in _regular_files(self.job_dir, svg_dir, ".svg"):
                os.unlink(old)
            for index, text in pages.items():
                role = outline["pages"][index - 1]["role"]
                sandbox.write_file(self.job_dir, svg_dir / f"{index:02d}_{role}.svg", text.encode("utf-8"))
            await self.run([py, str(scripts / "compact_svg_styles.py"), str(svg_dir), "--inplace"], timeout=120,
                           network=False)
            check = await self.run([py, str(scripts / "svg_quality_checker.py"), str(self.project), "--quick-generate",
                                    "--canonical-authoring", "--stage", "final", "--json"], timeout=300, network=False)
            errors = self._checker_errors()
            if check.code == 0 and not errors:
                break
            if round_ == 2 or not errors:
                raise StudioError("slide chưa qua được bộ kiểm của 2Anh Studio", refund=not errors)
            for index, message in errors.items():
                pages[index] = await self._page(outline, index, (pages[index], message), refs, available)
        return outline, pages, scripts, pics

    async def slides(self) -> List[Path]:
        if self.job.template:
            scripts = await self._template_deck()
        else:
            _outline, _pages, scripts, _pics = await self._deck()
        export = await self.run([str(self.where.python), str(scripts / "svg_to_pptx.py"), str(self.project),
                                 "--quick-generate", "--no-notes"], timeout=600, network=False)
        if export.timed_out or export.code != 0:
            logger.warning("[zalo] xưởng %s: xuất pptx lỗi %s — %s", self.job.id, export.code, export.err[-2000:])
            raise StudioError("chưa xuất được tệp PowerPoint", refund=True)
        return collect(self.job_dir, self.project / "exports", self.recipe.outputs)[:1]

    async def _template_deck(self) -> Path:
        """Slide theo MẪU: tệp .pptx người dùng gửi → trang mẫu SVG (hộp cát, không mạng) → AI viết chữ từng ô →
        trang mới giữ nguyên thiết kế → bộ kiểm. Trả thư mục scripts."""
        scripts = self.where.studio / "skills" / "ppt-master" / "scripts"
        py = str(self.where.python)
        guard = await self.run([py, str(scripts / "attribution_guard.py")], timeout=60, network=False)
        if guard.code != 0:
            raise StudioError("bộ làm slide trên máy chủ không còn nguyên vẹn", refund=True)
        try:
            with open(self.job.template, "rb") as fh:
                data = fh.read(MAX_TEMPLATE_BYTES + 1)
        except OSError:
            raise StudioError("không còn tệp mẫu người dùng gửi — nhờ họ gửi lại", refund=True) from None
        if len(data) > MAX_TEMPLATE_BYTES:
            raise StudioError("tệp mẫu lớn quá (tối đa 40 MB)", refund=True)
        source = sandbox.write_file(self.job_dir, self.job_dir / "mau.pptx", data)
        out = self.job_dir / "mau"
        imported = await self.run([py, str(scripts / "pptx_template_import.py"), str(source), "-o", str(out),
                                   "--inheritance-mode", "flat"], timeout=300, network=False)
        pages_src = _regular_files(self.job_dir, out / "svg", ".svg")
        if imported.timed_out or imported.code != 0 or not pages_src:
            logger.warning("[zalo] xưởng %s: đọc mẫu lỗi %s — %s", self.job.id, imported.code, imported.err[-2000:])
            raise StudioError("chưa đọc được tệp mẫu (cần tệp PowerPoint .pptx còn mở được)", refund=True)
        protos = {}
        for path in pages_src[:mau.MAX_TEMPLATE_PAGES]:
            match = re.search(r"(\d+)$", path.stem)
            try:
                root = mau.parse_page(sandbox.read_file(self.job_dir, path, limit=5_000_000).decode("utf-8"))
            except (mau.TemplateError, UnicodeDecodeError) as exc:
                logger.info("[zalo] xưởng %s: bỏ trang mẫu %s — %s", self.job.id, path.name, exc)
                continue
            if match:
                protos[int(match.group(1))] = (root, mau.slots(root))
        if not any(ss for _root, ss in protos.values()):
            raise StudioError("tệp mẫu không có trang nào có ô chữ để làm theo", refund=True)
        try:
            plan = await author.write_template_plan(
                self.llm, brief=self.job.brief, options=self.job.options, listing=mau.listing(protos),
                usage=self.usage, max_pages=MAX_SLIDE_PAGES,
                check=lambda data: mau.check_plan(data, protos, MAX_SLIDE_PAGES))
        except validate.SourceError as exc:
            raise StudioError(f"chưa viết được chữ theo mẫu ({exc})", refund=False) from None
        init = await self.run([py, str(scripts / "project_manager.py"), "init", "deck", "--quick-generate",
                               "--dir", str(self.job_dir)], timeout=120, network=False)
        with os.scandir(self.job_dir) as entries:
            decks = sorted(Path(e.path) for e in entries
                           if e.name.startswith("deck_") and stat.S_ISDIR(os.lstat(e.path).st_mode))
        if init.code != 0 or not decks:
            raise StudioError("chưa tạo được dự án slide", refund=True)
        self.project = decks[0]
        # Ảnh của mẫu (nền, hình trang trí): trang mẫu trỏ "../images/<tệp>" từ svg_output.
        for suffix in (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp"):
            for pic in _regular_files(self.job_dir, out / "images", suffix):
                sandbox.write_file(self.job_dir, self.project / "images" / pic.name,
                                   sandbox.read_file(self.job_dir, pic, limit=MAX_TEMPLATE_BYTES))
        svg_dir = self.project / "svg_output"
        for index, page in enumerate(plan, 1):
            text, notes = mau.build_page(protos[page["mau"]][0], page["o"])
            if notes:
                logger.info("[zalo] xưởng %s: trang %d — %s", self.job.id, index, "; ".join(notes))
            sandbox.write_file(self.job_dir, svg_dir / f"{index:02d}_mau{page['mau']}.svg", text.encode("utf-8"))
        await self.run([py, str(scripts / "compact_svg_styles.py"), str(svg_dir), "--inplace"], timeout=120,
                       network=False)
        check = await self.run([py, str(scripts / "svg_quality_checker.py"), str(self.project), "--quick-generate",
                                "--canonical-authoring", "--stage", "final", "--json"], timeout=300, network=False)
        if check.code != 0:
            errors = self._checker_errors()
            logger.warning("[zalo] xưởng %s: slide theo mẫu chưa qua bộ kiểm — %s", self.job.id, errors)
            raise StudioError("slide theo mẫu chưa qua được bộ kiểm của 2Anh Studio", refund=not errors)
        return scripts

    async def lecture_video(self) -> List[Path]:
        """Video bài giảng (§11 của 2Anh Studio): slide → lời giảng → giọng đọc → PPTX gắn tiếng → MP4 (FFmpeg)."""
        outline, _pages, scripts, _pics = await self._deck()
        py = str(self.where.python)
        try:
            notes = await author.write_notes(self.llm, guides=self.guides, brief=self.job.brief,
                                             options=self.job.options, outline=outline, usage=self.usage)
        except validate.SourceError as exc:
            raise StudioError(f"chưa viết được lời giảng ({exc})", refund=False) from None
        notes_dir = self.project / "notes"
        for svg in _regular_files(self.job_dir, self.project / "svg_output", ".svg"):
            index = int(svg.name[:2]) if svg.name[:2].isdigit() else 0
            if index not in notes:
                raise StudioError("trang slide không khớp lời giảng", refund=True)
            sandbox.write_file(self.job_dir, notes_dir / f"{svg.stem}.md", (notes[index] + "\n").encode("utf-8"))
        narrate = self.where.studio / "tools" / "vi" / "giong_bai_giang.py"
        steps = (
            (([py, str(narrate), str(self.project), "--giong", LECTURE_VIENEU] if narrate.is_file() else
              [py, str(scripts / "notes_to_audio.py"), str(self.project), "--voice", LECTURE_VOICE]), 1800, True),
            ([py, str(scripts / "svg_to_pptx.py"), str(self.project), "--quick-generate", "--with-notes",
              "--recorded-narration", "audio"], 600, False),
            ([py, str(self.where.studio / "tools" / "vi" / "video.py"), str(self.project), "--cach", "ffmpeg",
              "--phu-de", "hinh", "--do-phan-giai", "720"], 1800, False),
        )
        browsers = sandbox.browsers_dir()
        # video.py chụp slide bằng Chromium: chỉ cho nó đúng chỗ Chromium (môi trường đã lọc không có LOCALAPPDATA).
        # video.py tự bật máy chủ xem trước (svg_editor/server.py --daemon) trên 127.0.0.1 rồi visual_review.py
        # (Chromium) đọc nó, tắt khi xong — cả ba trong CÙNG một đơn vị systemd. Bước này chạy network=False →
        # PrivateNetwork=yes: đơn vị có loopback riêng, nên 127.0.0.1 của đơn vị chạy được mà không chạm 127.0.0.1
        # của máy (9router, dashboard, sidecar). Chỉ bước giọng đọc (edge-tts) có mạng, và bước đó không cần
        # loopback (IPAddressDeny chặn localhost). Đừng đổi bước video.py sang network=True.
        extra_env = ({"PLAYWRIGHT_BROWSERS_PATH": str(browsers), "LOCALAPPDATA": str(browsers.parent)} if browsers else None)
        for argv, timeout, network in steps:
            result = await self.run(argv, timeout=timeout, network=network, extra=[browsers], extra_env=extra_env)
            if result.timed_out or result.code != 0:
                logger.warning("[zalo] xưởng %s: bước %s lỗi %s — %s", self.job.id, Path(argv[1]).name, result.code,
                               (result.out + result.err)[-2000:])
                raise StudioError("chưa dựng được video bài giảng", refund=True)
        return collect(self.job_dir, self.project, self.recipe.outputs)[:1]

    async def _page(self, outline: Dict[str, Any], index: int, repair: Optional[Tuple[str, str]],
                    refs: Optional[Dict[str, str]] = None, available: Optional[Dict[str, str]] = None) -> str:
        text = await author.write_page(self.llm, guides=self.guides, brief=self.job.brief, options=self.job.options,
                                       outline=outline, index=index, usage=self.usage, repair=repair,
                                       available=available)
        try:
            return validate.check_svg(validate.drop_missing_images(text, refs or {}), refs)
        except validate.SourceError as exc:
            if repair is not None:
                raise StudioError(f"trang {index} chưa dựng được ({exc})", refund=False) from None
            return await self._page(outline, index, (text, str(exc)), refs, available)

    def _checker_errors(self) -> Dict[int, str]:
        """Báo cáo của bộ kiểm (viết trong hộp cát) — đọc bằng ``read_file`` (không theo liên kết, không FIFO, có trần)."""
        try:
            raw = sandbox.read_file(self.job_dir, self.project / "validation" / "svg_quality_report.json", limit=5_000_000)
            report = json.loads(raw.decode("utf-8"))
        except (OSError, ValueError):
            return {}
        out = {}
        for item in (report.get("files") or []) if isinstance(report, dict) else []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("file") or "")
            if item.get("errors") and name[:2].isdigit():
                out[int(name[:2])] = "; ".join(str(e) for e in item["errors"])[:1500]
        return out


async def produce(job: Job, llm: Any, job_dir: Path, where: Optional[recipes.Places] = None, *,
                  track: Optional[List["Builder"]] = None,
                  on_spend: Optional[Callable[[author.Usage, int], None]] = None) -> Outcome:
    """Làm một việc. Mọi lỗi ra ngoài mang ``usage``/``images`` đã tốn; ``track`` nhận Builder để bên gọi vẫn thấy chi
    phí khi việc bị huỷ giữa chừng (hết thời hạn). Lỗi lạ do nội dung (ký tự không mã hoá được, giá trị python-docx
    từ chối…) và vượt trần token → ``StudioError`` tính lượt."""
    where = where or recipes.places()
    reason = recipes.missing(job.recipe, where)
    if reason:
        raise StudioError(reason, refund=True)
    builder = Builder(job, llm, where, job_dir, on_spend)
    if track is not None:
        track.append(builder)
    try:
        try:
            files = await getattr(builder, job.recipe.builder)()
        except author.BudgetExceeded:
            raise StudioError("việc dùng quá trần token của một việc nên đã dừng", refund=False) from None
        except sandbox.UnsafeJobDir as exc:
            logger.warning("[zalo] xưởng %s: %s", job.id, exc)
            raise StudioError("bộ dựng để lại tệp không an toàn nên đã dừng", refund=False) from None
        except validate.SourceError as exc:
            raise StudioError(f"nội dung chưa dựng được ({exc})", refund=False) from None
        except (UnicodeError, ValueError) as exc:
            logger.info("[zalo] xưởng %s: nội dung không dựng được: %r", job.id, exc)
            raise StudioError("nội dung có ký tự hoặc giá trị không dựng được", refund=False) from None
    except BaseException as exc:
        exc.usage = builder.usage  # type: ignore[attr-defined]
        exc.images = builder.images_used  # type: ignore[attr-defined]
        raise
    return Outcome(files=files, notes=builder.notes, usage=builder.usage, images=builder.images_used)


def estimate_minutes(kind: str, options: Optional[Dict[str, str]] = None) -> str:
    """Khoảng phút chờ để báo người dùng (thực đo trên hai máy, hàng đợi trống)."""
    if kind == "video":
        return "10–25" if (options or {}).get("kieu") == "vox" else "5–15"
    return {"video_bai_giang": "15–30", "slide": "5–15"}.get(kind, "2–5")


DRAFT_DEADLINE = 600


async def draft(job: Job, llm: Any, where: Optional[recipes.Places] = None, *, feedback: str = "",
                previous: str = "") -> str:
    """Bước lên kịch bản của video: AI viết ``video.md`` (hoặc sửa bản trước theo ý người dùng), kiểm ngữ pháp của
    xưởng, sai thì nhờ viết lại đúng một lần. Không dựng gì, không chạy bộ dựng. Trả bản đã kiểm."""
    where = where or recipes.places()
    reason = recipes.missing(job.recipe, where)
    if reason:
        raise StudioError(reason, refund=True)
    builder = Builder(job, llm, where, sandbox.work_root() / job.id)
    library = validate.library_ids(where.studio) if where.studio else set()
    repair = (previous, f"Người dùng muốn sửa kịch bản như sau (giữ phần không được nhắc tới): {feedback}") if previous else None
    try:
        text = await builder.write(repair=repair)
        try:
            return validate.check_video(text, library)
        except validate.SourceError as exc:
            return validate.check_video(await builder.write(repair=(text, str(exc))), library)
    except author.BudgetExceeded:
        raise StudioError("kịch bản dùng quá trần token nên đã dừng", refund=False) from None
    except validate.SourceError as exc:
        raise StudioError(f"chưa viết được kịch bản đúng mẫu ({exc})", refund=False) from None


# ---------------------------------------------------------------------- hàng đợi
Deliver = Callable[[Job, List[Path], str], Awaitable[bool]]
Notify = Callable[[Job, str], Awaitable[None]]
Allowed = Callable[[Job], bool]


class Studio:
    def __init__(self, *, ledger: Ledger, llm: Callable[[], Any], deliver: Deliver, notify: Notify,
                 still_allowed: Allowed, quota_left: Callable[[Job], Optional[int]],
                 concurrency: Optional[int] = None, max_queue: int = MAX_QUEUE):
        self.ledger, self.llm, self.deliver, self.notify = ledger, llm, deliver, notify
        self.still_allowed, self.quota_left = still_allowed, quota_left
        wanted = concurrency or int(os.getenv("ZALO_STUDIO_CONCURRENCY", "1") or 1)
        self.concurrency = max(1, min(2, wanted))
        self.max_queue = max_queue
        self._pending: Dict[str, Job] = {}
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._sem: Optional[asyncio.Semaphore] = None
        try:
            # Thứ tự: dừng đơn vị systemd còn sống từ lần trước → dọn thư mục việc mồ côi → xử lý sổ.
            sandbox.stop_all_units()
            sweep_work_root(orphans=True)
            lost = ledger.sweep_lost()
            if lost:
                logger.info("[zalo] xưởng: %d việc dở từ lần chạy trước — trả lượt nếu chưa tốn gì, còn lại tính lượt", lost)
        except Exception as exc:
            logger.warning("[zalo] xưởng: không dọn được việc cũ: %s", exc)
        # Dashboard đọc studio-policy.json để khoá nút video + hiện ghi chú (Windows / Linux không hộp cát).
        gp.publish_video_policy()

    # -- luồng nền ----------------------------------------------------------
    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            if self._loop is None:
                loop = asyncio.new_event_loop()
                ready = threading.Event()

                def main() -> None:
                    asyncio.set_event_loop(loop)
                    self._sem = asyncio.Semaphore(self.concurrency)
                    ready.set()
                    loop.run_forever()

                threading.Thread(target=main, name="zalo-studio", daemon=True).start()
                ready.wait(5)
                self._loop = loop
            return self._loop

    def pending_for(self, uid: str) -> bool:
        with self._lock:
            return any(job.uid == uid for job in self._pending.values())

    def submit(self, job: Job) -> int:
        """Xếp việc; trả vị trí (1 = làm ngay). Đầy hàng hoặc người này đang có việc → Busy."""
        with self._lock:
            if any(other.uid == job.uid for other in self._pending.values()):
                raise Busy("bạn đang có một việc chưa xong — chờ việc đó gửi xong rồi nhờ tiếp")
            if len(self._pending) >= self.max_queue:
                raise Busy("xưởng đang bận nhiều việc — thử lại sau ít phút")
            self._pending[job.id] = job
            position = len(self._pending)
        asyncio.run_coroutine_threadsafe(self._run(job), self._ensure_loop())
        return position

    async def _run(self, job: Job) -> None:
        if self._sem is None:
            self._sem = asyncio.Semaphore(self.concurrency)
        try:
            async with self._sem:
                await self.run_job(job)
        finally:
            with self._lock:
                self._pending.pop(job.id, None)

    async def run_job(self, job: Job) -> None:
        """Làm một việc từ đầu tới cuối; không bao giờ ném ra ngoài. Mọi kết cục ghi sổ đủ token + ảnh đã tốn.

        Trả lượt chỉ khi: lỗi do máy (``StudioError.refund`` hoặc lỗi lạ) VÀ việc chưa tốn gì (``spent``) VÀ người này
        chưa hết trần trả lượt hôm nay (sổ lượt tự đổi thành ``failed``). Cả việc có thời hạn tổng ``recipe.deadline``."""
        job_dir = sandbox.work_root() / job.id
        track: List[Builder] = []
        outcome: Optional[Outcome] = None
        keep = False
        self.ledger.finish(job.id, "running")

        def on_spend(usage: author.Usage, images_used: int) -> None:
            self.ledger.progress(job.id, input_tokens=usage.input_tokens, output_tokens=usage.output_tokens,
                                 images=images_used)

        def cost() -> Tuple[author.Usage, int]:
            if outcome is not None:
                return outcome.usage, outcome.images
            if track:
                return track[0].usage, track[0].images_used
            return author.Usage(), 0

        try:
            job_dir.mkdir(parents=True, exist_ok=False)
            llm = self.llm()
            if llm is None:
                raise StudioError("Hermes trên máy chủ chưa hỗ trợ xưởng (thiếu ctx.llm)", refund=True)
            loop = asyncio.get_running_loop()
            started = loop.time()
            try:
                outcome = await asyncio.wait_for(produce(job, llm, job_dir, track=track, on_spend=on_spend), timeout=job.recipe.deadline)
            except asyncio.TimeoutError:
                if loop.time() - started < job.recipe.deadline - 1:
                    raise  # hết giờ của một lời gọi bên trong, không phải thời hạn của việc
                raise StudioError("làm quá thời hạn của một việc nên đã dừng", refund=False) from None
            if not self.still_allowed(job):
                raise StudioError("chủ bot vừa tắt tính năng này", refund=True)
            left = self.quota_left(job)
            caption = f"Xong {job.recipe.label} cho {job.name}."
            if outcome.notes:
                caption += " Cần soát: " + "; ".join(outcome.notes)
            if left is not None:
                caption += f" Hôm nay còn {left} lượt."
            sent = await self.deliver(job, stamp_names(outcome.files), caption)
            if sent is None:
                keep = True  # Zalo chưa xác nhận: tệp có thể vẫn đang gửi — xoá sau
            elif not sent:
                raise StudioError("chưa gửi được tệp vào Zalo", refund=True)
            self.ledger.finish(job.id, "ok", input_tokens=outcome.usage.input_tokens,
                               output_tokens=outcome.usage.output_tokens, images=outcome.images)
        except Exception as exc:
            usage, images_used = cost()
            usage = getattr(exc, "usage", usage)
            images_used = getattr(exc, "images", images_used)
            if isinstance(exc, StudioError):
                logger.info("[zalo] xưởng %s (%s, %s): %s", job.id, job.kind, job.uid, exc)
                machine, error, said = exc.refund, str(exc), public_message(str(exc))
            else:  # lỗi lạ: báo gọn, ghi đủ vào log
                logger.exception("[zalo] xưởng %s hỏng bất ngờ: %s", job.id, exc)
                machine, error, said = True, "lỗi bên trong", "xưởng gặp lỗi bên trong"
            wanted = "refunded" if machine and not spent(usage, images_used) else "failed"
            status = self.ledger.finish(job.id, wanted, input_tokens=usage.input_tokens,
                                        output_tokens=usage.output_tokens, error=error, images=images_used)
            tail = " Lượt này không bị trừ." if status == "refunded" else ""
            await self._safe_notify(job, f"Xin lỗi {job.name}, chưa làm được {job.recipe.label}: {said}.{tail}")
        finally:
            if keep:
                timer = threading.Timer(900, shutil.rmtree, args=(job_dir,), kwargs={"ignore_errors": True})
                timer.daemon = True
                timer.start()
            else:
                shutil.rmtree(job_dir, ignore_errors=True)

    def submit_draft(self, job: Job, *, feedback: str, previous: str,
                     done: Callable[[Job, str], Awaitable[None]]) -> None:
        """Viết kịch bản ở luồng nền của xưởng (không chiếm chỗ dựng); xong gọi ``done(job, video_md)``, hỏng thì báo
        người nhờ. Không ném ra ngoài."""
        async def run() -> None:
            try:
                llm = self.llm()
                if llm is None:
                    raise StudioError("Hermes trên máy chủ chưa hỗ trợ xưởng (thiếu ctx.llm)", refund=True)
                text = await asyncio.wait_for(draft(job, llm, feedback=feedback, previous=previous), timeout=DRAFT_DEADLINE)
                await done(job, text)
            except Exception as exc:
                if isinstance(exc, (StudioError, asyncio.TimeoutError)):
                    said = public_message(str(exc)) if isinstance(exc, StudioError) else "viết kịch bản quá lâu"
                    logger.info("[zalo] xưởng %s: kịch bản hỏng: %s", job.id, exc)
                else:
                    logger.exception("[zalo] xưởng %s: kịch bản hỏng bất ngờ: %s", job.id, exc)
                    said = "xưởng gặp lỗi bên trong"
                await self._safe_notify(job, f"Xin lỗi {job.name}, chưa viết được kịch bản video: {said}. Nhờ lại sau ít phút nhé.")

        asyncio.run_coroutine_threadsafe(run(), self._ensure_loop())

    async def _safe_notify(self, job: Job, text: str) -> None:
        try:
            await self.notify(job, text)
        except Exception as exc:
            logger.warning("[zalo] xưởng %s: không báo được người nhờ: %s", job.id, exc)


JOB_DIR_NAME = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{6}$")


def sweep_work_root(now: Optional[float] = None, *, orphans: bool = False) -> None:
    """Dọn thư mục việc sót lại quá 24 giờ (gateway tắt ngang khi đang dựng). ``orphans=True`` (lúc khởi tạo xưởng,
    chưa có việc nào chạy): xoá mọi thư mục việc còn lại bất kể tuổi — chỉ thư mục đúng dạng mã việc, không đi theo
    liên kết."""
    root = sandbox.work_root()
    if not root.is_dir():
        return
    now = now or time.time()
    for child in root.iterdir():
        try:
            if child.is_symlink() or not child.is_dir():
                continue
            if (orphans and JOB_DIR_NAME.match(child.name)) or now - child.stat().st_mtime > STALE_DIR_SECONDS:
                shutil.rmtree(child, ignore_errors=True)
        except OSError:
            continue
