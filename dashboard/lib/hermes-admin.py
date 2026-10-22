"""Cầu nối dashboard → mã Hermes (chạy bằng Python của Hermes, cwd = thư mục hermes-agent).

Dashboard (Node) gọi: ``python hermes-admin.py <lệnh>``, đưa tham số JSON qua stdin, nhận đúng MỘT dòng JSON
trên stdout: ``{"ok": true, ...}`` hoặc ``{"ok": false, "error": "..."}``. Mọi thứ Hermes tự in ra (rich console,
cảnh báo) bị dồn sang stderr để không làm hỏng dòng JSON.

Dùng chính hàm nội bộ của Hermes (cùng đường đi với ``hermes skills ...`` và dashboard gốc của Hermes) thay vì đọc
bảng chữ của dòng lệnh: danh sách skill, bật/tắt, kho skill (tìm/xem/quét/cài), tải lên .zip qua bộ quét an toàn.
Không bao giờ cài khi bộ quét không cho phép (không có "--force").
"""

import importlib
import io
import json
import os
import re
import shutil
import sys
import zipfile
import zlib
from pathlib import PurePosixPath

_REAL_STDOUT = sys.stdout

SKILL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")  # tên skill mới (tải lên) — cũng là tên thư mục
# Skill sẵn có có thể mang tên có dấu cách; skill trùng tên được Hermes gọi theo đường dẫn "nhóm/tên" (load_name) —
# cho "/" ở giữa nhưng không ở đầu/cuối, không có đoạn "." hay "..".
EXISTING_NAME = re.compile(r"^(?!/)(?!.*(?:^|/)\.{1,2}(?:/|$))[^\x00-\x1f\x7f\\]{1,128}(?<!/)$")
IDENTIFIER = re.compile(r"^[A-Za-z0-9@_.:/-]{1,200}$")
PLATFORM = "zalo"
MAX_SKILL_MD = 200_000
MAX_ZIP_FILES = 200
MAX_ZIP_BYTES = 8 * 1024 * 1024


class Refusal(Exception):
    """Lỗi người dùng hiểu được (tiếng Việt) — trả nguyên văn."""


def reply(obj):
    _REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _REAL_STDOUT.flush()


def pick(attr, *modules):
    """Lấy ``attr`` từ module đầu tiên có nó (Hermes hay dời hàm sang module mới, giữ tên cũ một thời gian)."""
    for name in modules:
        try:
            mod = importlib.import_module(name)
        except Exception:
            continue
        if name != modules[-1] and attr not in getattr(mod, "__dict__", {}):
            continue
        if hasattr(mod, attr):
            return getattr(mod, attr)
    raise Refusal(f"Bản Hermes này thiếu {attr} — cập nhật Hermes rồi thử lại.")


def quiet_console():
    from rich.console import Console
    buf = io.StringIO()
    return Console(file=buf, width=160, no_color=True, highlight=False, soft_wrap=True), buf


def need_skill_name(value):
    name = str(value or "").strip()
    if not EXISTING_NAME.match(name):
        raise Refusal("Tên skill không hợp lệ.")
    return name


def need_identifier(value):
    ident = str(value or "").strip()
    if not IDENTIFIER.match(ident) or ".." in ident:
        raise Refusal("Mã skill trên kho không hợp lệ.")
    return ident


def clear_prompt_cache():
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache
        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception:
        pass


# ─── Skill: danh sách, xem, bật/tắt ────────────────────────────────────────


def _platform_off(config):
    """Chỉ danh sách tắt RIÊNG của Zalo (skills.platform_disabled.zalo) — không trộn danh sách tắt chung."""
    from hermes_cli.skills_config import _normalize_skill_names
    skills = config.get("skills") if isinstance(config.get("skills"), dict) else {}
    per = skills.get("platform_disabled") if isinstance(skills.get("platform_disabled"), dict) else {}
    return set(_normalize_skill_names(per.get(PLATFORM)))


def _global_off(config):
    from hermes_cli.skills_config import get_disabled_skills
    return set(get_disabled_skills(config))


def _hub_entries():
    HubLockFile = pick("HubLockFile", "tools.skills_hub_lock", "tools.skills_hub")
    return {e.get("name"): e for e in HubLockFile().list_installed() if e.get("name")}


def _skills_root():
    from hermes_constants import get_hermes_home
    return get_hermes_home() / "skills"


def _skill_dirs():
    """tên (frontmatter, như Hermes hiển thị) → thư mục skill. Đi đúng các thư mục Hermes quét, tên đầu tiên thắng."""
    from agent.skill_utils import get_external_skills_dirs, iter_skill_index_files
    from tools.skills_tool import _parse_frontmatter
    out = {}
    for base in [_skills_root(), *get_external_skills_dirs()]:
        if not base.exists():
            continue
        for md in iter_skill_index_files(base, "SKILL.md"):
            try:
                fm, _ = _parse_frontmatter(md.read_text(encoding="utf-8-sig", errors="replace")[:4000])
            except Exception:
                continue
            out.setdefault(str(fm.get("name") or md.parent.name)[:64], md.parent)
    return out


def _lock_by_dir(hub):
    """thư mục skill (tuyệt đối, chữ thường) → (tên trong lock, mục lock): nối skill với lock theo install_path."""
    root = _skills_root()
    out = {}
    for lock_name, e in hub.items():
        rel = str(e.get("install_path") or "").strip("/")
        if rel:
            out[os.path.normcase(str(root.joinpath(*rel.split("/"))))] = (lock_name, e)
    return out


def _skill_entry(name):
    path = _skill_dirs().get(name)
    if path is None:
        raise Refusal("Không tìm thấy skill này — tải lại trang.")
    return path


def skills_list(_args):
    from hermes_cli.config import load_config
    from tools.skills_tool import _find_all_skills
    from agent.skill_utils import ESSENTIAL_SKILLS
    config = load_config()
    zalo_off, everywhere = _platform_off(config), _global_off(config)
    try:
        from tools import skill_usage
        # Hermes đổi tên hàm này qua các bản (_read_bundled_manifest_names → _read_bundled_names); import cứng một tên
        # làm cả khối rơi vào nhánh dự phòng — số lượt dùng luôn 0, mọi skill thành "Tự tạo".
        read_bundled = (getattr(skill_usage, "_read_bundled_names", None)
                        or getattr(skill_usage, "_read_bundled_manifest_names", None) or (lambda: set()))
        usage, bundled, activity_count = skill_usage.load_usage(), set(read_bundled()), skill_usage.activity_count
    except Exception:
        usage, bundled, activity_count = {}, set(), (lambda _u: 0)
    dirs, by_dir = _skill_dirs(), _lock_by_dir(_hub_entries())
    out = []
    for s in _find_all_skills(skip_disabled=True):
        name = s.get("name") or ""
        path = dirs.get(name)
        lock_name, h = by_dir.get(os.path.normcase(str(path)), (None, None)) if path else (None, None)
        if h:
            origin = "upload" if h.get("source") == "upload" else "hub"
        else:
            origin = "bundled" if name in bundled else "local"
        out.append({
            "name": name,
            "description": s.get("description") or "",
            "category": s.get("category") or "",
            "enabled": name not in zalo_off and name not in everywhere,
            "offEverywhere": name in everywhere,
            "essential": name in ESSENTIAL_SKILLS,
            "usage": int(activity_count(usage.get(name, {})) or 0),
            "origin": origin,
            "lockName": lock_name or "",
            "trust": (h or {}).get("trust_level") or "",
            "identifier": (h or {}).get("identifier") or "",
        })
    out.sort(key=lambda s: (s["category"].lower(), s["name"].lower()))
    return {"skills": out}


def skills_view(args):
    name = need_skill_name(args.get("name"))
    path = _skill_entry(name)
    try:
        text = (path / "SKILL.md").read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        raise Refusal("Không đọc được nội dung skill.")
    files = sorted(p.relative_to(path).as_posix() for p in path.rglob("*") if p.is_file())[:100]
    return {"name": name, "content": text[:MAX_SKILL_MD], "truncated": len(text) > MAX_SKILL_MD, "files": files}


def skills_toggle(args):
    """Bật/tắt trên Zalo (danh sách riêng). Skill đang tắt chung cho mọi nơi chỉ bật lại khi có ``everywhere: true``."""
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import save_disabled_skills
    from agent.skill_utils import ESSENTIAL_SKILLS
    name = need_skill_name(args.get("name"))
    enabled = args.get("enabled")
    if not isinstance(enabled, bool):
        raise Refusal("Giá trị bật/tắt không hợp lệ.")
    if name in ESSENTIAL_SKILLS and not enabled:
        raise Refusal("Skill này là lõi của Hermes, không tắt được.")
    _skill_entry(name)
    config = load_config()
    everywhere = _global_off(config)
    if enabled and name in everywhere:
        if args.get("everywhere") is not True:
            raise Refusal("Skill này đang tắt cho mọi nơi (cả dòng lệnh, Telegram). Xác nhận bật lại ở mọi nơi.")
        everywhere.discard(name)
        save_disabled_skills(config, everywhere)
        config = load_config()
    off = _platform_off(config)
    if enabled:
        off.discard(name)
    else:
        off.add(name)
    save_disabled_skills(config, off, PLATFORM)
    return {"name": name, "enabled": enabled}


# ─── Kho skill: tìm, xem trước, quét, cài, gỡ ───────────────────────────────


def _meta(m):
    return {
        "name": getattr(m, "name", ""),
        "description": (getattr(m, "description", "") or "")[:400],
        "source": getattr(m, "source", "") or "",
        "identifier": getattr(m, "identifier", "") or "",
        "trust": getattr(m, "trust_level", "community") or "community",
        "repo": getattr(m, "repo", None),
    }


def _installed_identifiers():
    return {e.get("identifier") for e in _hub_entries().values() if e.get("identifier")}


def hub_search(args):
    create_source_router = pick("create_source_router", "tools.skills_hub_search", "tools.skills_hub")
    parallel_search_sources = pick("parallel_search_sources", "tools.skills_hub_search", "tools.skills_hub")
    query = str(args.get("q") or "").strip()[:100]
    if not query:
        return {"results": []}
    results, _counts, timed_out = parallel_search_sources(create_source_router(), query=query, source_filter="all", overall_timeout=25)
    rank = {"builtin": 2, "trusted": 1, "community": 0}
    seen = {}
    for r in results:
        cur = seen.get(r.identifier)
        if cur is None or rank.get(r.trust_level, 0) > rank.get(cur.trust_level, 0):
            seen[r.identifier] = r
    installed = _installed_identifiers()
    ordered = sorted(seen.values(), key=lambda m: -rank.get(m.trust_level, 0))[:30]
    out = [dict(_meta(m), installed=m.identifier in installed) for m in ordered]
    return {"results": out, "timedOut": list(timed_out or [])}


def hub_official(_args):
    """Danh mục skill chính thức đi kèm Hermes (đọc tại chỗ, không cần mạng)."""
    OptionalSkillSource = pick("OptionalSkillSource", "tools.skills_hub_official", "tools.skills_hub")
    installed = _installed_identifiers()
    out = []
    for m in OptionalSkillSource().list_local():
        ident = getattr(m, "identifier", "") or ""
        rel = ident.split("/", 1)[-1] if "/" in ident else ident
        out.append(dict(_meta(m), category=rel.split("/", 1)[0] if "/" in rel else "", installed=ident in installed))
    out.sort(key=lambda s: (s["category"], s["name"]))
    return {"skills": out}


SOURCE_ID = re.compile(r"^[A-Za-z0-9._-]{1,40}$")


def need_source(value):
    source = str(value or "").strip()
    if source and not SOURCE_ID.match(source):
        raise Refusal("Nguồn kho không hợp lệ.")
    return source


def _sources(source=""):
    """Các nguồn kho; có ``source`` thì chỉ đúng nguồn đó (xem trước, quét và cài cùng một skill, không lạc nguồn)."""
    create_source_router = pick("create_source_router", "tools.skills_hub_search", "tools.skills_hub")
    sources = create_source_router()
    if not source:
        return sources
    matches = pick("_source_matches", "tools.skills_hub_install", "hermes_cli.skills_hub", "tools.skills_hub")
    pinned = [s for s in sources if matches(s, source)]
    if not pinned:
        raise Refusal("Không có nguồn kho này trên máy.")
    return pinned


def _resolve(ident, source=""):
    resolve = pick("_resolve_source_meta_and_bundle", "hermes_cli.skills_hub")
    meta, bundle, _src = resolve(ident, _sources(source))
    if not bundle and not meta:
        raise Refusal("Không tìm thấy skill này trên kho.")
    return meta, bundle


def hub_preview(args):
    ident, source = need_identifier(args.get("identifier")), need_source(args.get("source"))
    meta, bundle = _resolve(ident, source)
    files = {}
    for rel, content in ((bundle.files or {}).items() if bundle else []):
        if isinstance(content, bytes):
            try:
                content = content.decode("utf-8")
            except UnicodeDecodeError:
                content = ""
        files[rel] = content
    skill_md = files.get("SKILL.md", "") or ""
    return dict(_meta(meta or bundle), identifier=ident, content=skill_md[:MAX_SKILL_MD], files=sorted(files)[:100])


def _scan_report(result, allowed, reason):
    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for f in result.findings:
        if f.severity in counts:
            counts[f.severity] += 1
    return {
        "verdict": result.verdict,
        "trust": result.trust_level,
        "policy": "allow" if allowed is True else "ask" if allowed is None else "block",
        "reason": reason,
        "counts": counts,
        "findings": [{"severity": f.severity, "category": f.category, "file": f.file, "line": f.line,
                      "description": f.description} for f in result.findings[:30]],
    }


def _refuse_scan_ignore(bundle):
    bad = sorted({rel for rel in (getattr(bundle, "files", None) or {}) if rel.replace("\\", "/").rsplit("/", 1)[-1].lower() in SCAN_IGNORE_FILES})
    if bad:
        raise Refusal(f"Skill này có {', '.join(bad)} (tệp tắt bớt bộ quét an toàn) — không cài từ dashboard.")


def hub_scan(args):
    """Quét an toàn một skill trên kho mà không cài. Dùng thư mục cách ly chung với lúc cài → dashboard xếp hàng lệnh này."""
    from tools.skills_guard import scan_skill, should_allow_install
    quarantine_bundle = pick("quarantine_bundle", "tools.skills_hub_install", "tools.skills_hub")
    ident, source = need_identifier(args.get("identifier")), need_source(args.get("source"))
    meta, bundle = _resolve(ident, source)
    if not bundle:
        raise Refusal("Không tải được skill này để quét.")
    _refuse_scan_ignore(bundle)
    scan_source = "official" if bundle.source == "official" else (getattr(bundle, "identifier", "") or ident)
    q = None
    try:
        q = quarantine_bundle(bundle)
        result = scan_skill(q, source=scan_source)
    finally:
        if q is not None:
            shutil.rmtree(q, ignore_errors=True)
    allowed, reason = should_allow_install(result, force=False)
    return dict(_scan_report(result, allowed, reason), name=bundle.name, identifier=ident)


def hub_install(args):
    from hermes_cli.skills_hub import do_install
    ident, source = need_identifier(args.get("identifier")), need_source(args.get("source"))
    _meta_unused, bundle = _resolve(ident, source)  # nguồn lạ → báo ngay; xem trước tệp của gói
    if bundle:
        _refuse_scan_ignore(bundle)
    before = {n: e.get("installed_at") for n, e in _hub_entries().items()}
    console, buf = quiet_console()
    do_install(ident, console=console, skip_confirm=True, force=False, source_id=source or None)
    after = _hub_entries()
    new = [n for n, e in after.items() if n not in before or before[n] != e.get("installed_at")]
    if not new:
        tail = [ln.strip() for ln in buf.getvalue().splitlines() if ln.strip()][-6:]
        raise Refusal(("Chưa cài được skill: " + (" · ".join(tail) or "kho không trả về skill hợp lệ."))[:600])
    clear_prompt_cache()
    return {"name": new[0], "identifier": after[new[0]].get("identifier") or ident}


def skills_uninstall(args):
    """Gỡ theo tên trong sổ cài (lockName) — chỉ skill cài từ kho hoặc tải lên."""
    uninstall_skill = pick("uninstall_skill", "tools.skills_hub_install", "tools.skills_hub")
    name = need_skill_name(args.get("name"))
    if name not in _hub_entries():
        raise Refusal("Chỉ gỡ được skill cài từ kho hoặc tải lên. Skill có sẵn thì tắt đi.")
    ok, msg = uninstall_skill(name)
    if not ok:
        raise Refusal(f"Chưa gỡ được: {msg}"[:400])
    clear_prompt_cache()
    return {"name": name}


# ─── Tải lên: .zip hoặc SKILL.md → quét an toàn → cài ───────────────────────

# Tệp mà bộ quét của Hermes đọc từ CHÍNH skill để bỏ qua tệp khác — trong gói tải lên thì không được có.
SCAN_IGNORE_FILES = {".skillignore", ".clawhubignore"}
WINDOWS_RESERVED = re.compile(r"^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$", re.I)


def _frontmatter_name(text):
    """Tên skill đúng như Hermes đọc (parser YAML của Hermes)."""
    from tools.skills_tool import _parse_frontmatter
    try:
        fm, _ = _parse_frontmatter(text)
    except Exception:
        return ""
    name = fm.get("name") if isinstance(fm, dict) else None
    return name.strip() if isinstance(name, str) else ""


def _read_upload(path, filename):
    """→ {đường_tương_đối: bytes} của skill, SKILL.md ở gốc."""
    size = os.path.getsize(path)
    if size > MAX_ZIP_BYTES:
        raise Refusal("Tệp quá lớn (tối đa 8 MB).")
    if filename.lower().endswith(".md"):
        with open(path, "rb") as fh:
            return {"SKILL.md": fh.read()}
    if not zipfile.is_zipfile(path):
        raise Refusal("Chỉ nhận tệp .zip hoặc SKILL.md.")
    files = {}
    seen = set()
    total = 0
    try:
        with zipfile.ZipFile(path) as zf:
            infos = [i for i in zf.infolist() if not i.is_dir()]
            if len(infos) > MAX_ZIP_FILES:
                raise Refusal(f"Tệp nén có quá nhiều tệp (tối đa {MAX_ZIP_FILES}).")
            for info in infos:
                rel = info.filename.replace("\\", "/")
                parts = [p for p in PurePosixPath(rel).parts if p not in ("", ".")]
                if not parts or rel.startswith("/") or any(
                        p == ".." or ":" in p or p != p.rstrip(". ") or WINDOWS_RESERVED.match(p) for p in parts):
                    raise Refusal("Tệp nén chứa đường dẫn không an toàn.")
                if parts[0] in ("__MACOSX",) or parts[-1] in (".DS_Store", "Thumbs.db"):
                    continue
                if parts[-1].lower() in SCAN_IGNORE_FILES:
                    raise Refusal(f"Tệp nén chứa {parts[-1]} (tệp tắt bớt bộ quét an toàn) — không nhận.")
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise Refusal("Tệp nén chứa liên kết (symlink) — không nhận.")
                key = "/".join(parts)
                if key.casefold() in seen:
                    raise Refusal("Tệp nén có hai tệp trùng tên (khác hoa/thường).")
                seen.add(key.casefold())
                total += info.file_size
                if total > MAX_ZIP_BYTES * 4:
                    raise Refusal("Tệp nén giải ra quá lớn.")
                files[key] = zf.read(info)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, zipfile.LargeZipFile, zlib.error, EOFError):
        raise Refusal("Không giải nén được (tệp hỏng, có mật khẩu hoặc kiểu nén lạ).")
    # Cho phép một thư mục bọc ngoài (skill-x/SKILL.md).
    if "SKILL.md" not in files:
        tops = {k.split("/", 1)[0] for k in files}
        if len(tops) == 1 and all("/" in k for k in files):
            top = tops.pop()
            files = {k[len(top) + 1:]: v for k, v in files.items()}
    if "SKILL.md" not in files:
        raise Refusal("Không thấy SKILL.md ở gốc tệp nén.")
    return files


def _upload_clash(name, hub):
    """Tên mới đụng skill/thư mục đang có (so không phân biệt hoa thường, trên đĩa lẫn theo tên) → câu từ chối."""
    root = _skills_root()
    mine = hub.get(name) or {}
    same_upload = mine.get("source") == "upload" and str(mine.get("install_path") or "").strip("/") == name
    if same_upload:
        return ""
    key = name.casefold()
    if root.exists() and any(p.name.casefold() == key for p in root.iterdir()):
        return f"Đã có thư mục skill tên “{name}”. Đổi tên trong SKILL.md, hoặc gỡ skill cũ trước."
    if any(n.casefold() == key for n in _skill_dirs()) or any(n.casefold() == key for n in hub):
        return f"Đã có skill tên “{name}”. Đổi tên trong SKILL.md, hoặc gỡ skill cũ trước."
    return ""


def skills_upload(args):
    from tools.skills_guard import scan_skill, should_allow_install
    SkillBundle = pick("SkillBundle", "tools.skills_hub_models", "tools.skills_hub")
    quarantine_bundle = pick("quarantine_bundle", "tools.skills_hub_install", "tools.skills_hub")
    install_from_quarantine = pick("install_from_quarantine", "tools.skills_hub_install", "tools.skills_hub")
    path = str(args.get("path") or "")
    if not path or not os.path.isfile(path):
        raise Refusal("Không thấy tệp tải lên.")
    files = _read_upload(path, str(args.get("filename") or ""))
    try:
        text = files["SKILL.md"].decode("utf-8-sig")
    except UnicodeDecodeError:
        raise Refusal("SKILL.md phải là văn bản UTF-8.")
    if len(text) > MAX_SKILL_MD:
        raise Refusal("SKILL.md quá dài.")
    name = _frontmatter_name(text)
    if not SKILL_NAME.match(name) or WINDOWS_RESERVED.match(name):
        raise Refusal("SKILL.md thiếu dòng name: hợp lệ ở phần đầu (chữ, số, dấu - _ .).")
    clash = _upload_clash(name, _hub_entries())
    if clash:
        raise Refusal(clash)
    bundle = SkillBundle(name=name, files=files, source="upload", identifier=f"upload/{name}", trust_level="community")
    try:
        q = quarantine_bundle(bundle)
    except (ValueError, OSError) as exc:
        raise Refusal(f"Tệp nén không hợp lệ: {_short_error(exc)}")
    try:
        result = scan_skill(q, source=f"upload/{name}")
        allowed, reason = should_allow_install(result, force=False)
        report = _scan_report(result, allowed, reason)
        if allowed is not True:
            return {"installed": False, "name": name, "scan": report}
        try:
            install_from_quarantine(q, name, "", bundle, result)
        except (ValueError, OSError) as exc:
            raise Refusal(f"Chưa cài được: {_short_error(exc)}")
    finally:
        shutil.rmtree(q, ignore_errors=True)
    clear_prompt_cache()
    return {"installed": True, "name": name, "scan": report}


# ─── MCP: danh mục, cài, thêm theo địa chỉ, kiểm tra, chọn công cụ, gỡ, đăng nhập OAuth ─────────

MCP_NAME = re.compile(r"^(?!\.+$)[A-Za-z0-9_.-]{1,64}$")
TOOL_PATTERN = re.compile(r"^[^\x00-\x1f\x7f]{1,200}$")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def _mcp_servers():
    from hermes_cli.mcp_config import _get_mcp_servers
    return _get_mcp_servers()


def need_mcp(args, must_exist=True):
    name = str(args.get("name") or "").strip()
    if not MCP_NAME.match(name):
        raise Refusal("Tên kết nối chỉ gồm chữ, số, dấu - _ . (tối đa 64 ký tự).")
    servers = _mcp_servers()
    if must_exist and name not in servers:
        raise Refusal("Không có kết nối MCP này — tải lại trang.")
    return name, servers.get(name) or {}


def _short_error(exc):
    text = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
    return text[:240]


def mcp_catalog(_args):
    from hermes_cli import mcp_catalog as mc
    from hermes_cli.config import get_env_value
    servers = _mcp_servers()
    out = []
    for e in mc.list_catalog():
        t = e.transport
        out.append({
            "name": e.name,
            "description": (e.description or "")[:400],
            "source": e.source or "",
            "transport": t.type,
            "auth": getattr(e.auth, "type", "none"),
            "env": [{"name": s.name, "prompt": s.prompt, "required": s.required, "secret": s.secret,
                     "isSet": bool(get_env_value(s.name))} for s in (e.auth.env or [])],
            "needsBuild": e.install is not None,
            "installed": e.name in servers,
            "runs": t.url or " ".join([t.command or ""] + list(t.args or []))[:200],
            "postInstall": (e.post_install or "")[:600],
        })
    return {"entries": out}


def _save_env(values, allowed):
    from hermes_cli.config import save_env_value
    for key, value in values.items():
        if key not in allowed:
            raise Refusal(f"Kết nối này không dùng biến {key}.")
        value = str(value or "").strip()
        if not value:
            continue
        if len(value) > 4096 or re.search(r"[\x00-\x1f\x7f]", value):
            raise Refusal(f"Giá trị {key} không hợp lệ.")
        save_env_value(key, value)


def mcp_install(args):
    from hermes_cli import mcp_catalog as mc
    from hermes_cli.config import get_env_value
    name = str(args.get("name") or "").strip()
    entry = mc.get_entry(name) if MCP_NAME.match(name) else None
    if entry is None:
        raise Refusal("Không có kết nối này trong danh mục.")
    if entry.install is not None:
        raise Refusal(f"Kết nối này cần tải mã nguồn và dựng trên máy — người cài đặt chạy: hermes mcp install {name}")
    env = args.get("env") or {}
    if not isinstance(env, dict):
        raise Refusal("Thông tin khoá không hợp lệ.")
    specs = {s.name: s for s in (entry.auth.env or [])}
    _save_env(env, set(specs))
    missing = [s.prompt or s.name for s in specs.values() if s.required and not get_env_value(s.name)]
    if missing:
        raise Refusal("Còn thiếu: " + "; ".join(missing))
    try:
        mc.install_entry(entry, enable=True)
    except mc.CatalogError as exc:
        raise Refusal(f"Chưa cài được: {_short_error(exc)}")
    return {"name": name, "auth": entry.auth.type}


def mcp_add(args):
    from urllib.parse import urlparse
    from hermes_cli.mcp_config import _save_bearer_auth_token, _save_mcp_server
    name, _cfg = need_mcp(args, must_exist=False)
    if name in _mcp_servers():
        raise Refusal("Đã có kết nối trùng tên — đặt tên khác.")
    url = str(args.get("url") or "").strip()
    try:
        u = urlparse(url)
        host, _port = u.hostname, u.port
    except ValueError:
        raise Refusal("Địa chỉ phải dạng https://…")
    if u.scheme not in ("https", "http") or not host or len(url) > 500 or re.search(r"\s", url):
        raise Refusal("Địa chỉ phải dạng https://…")
    if u.scheme == "http" and u.hostname not in LOOPBACK:
        raise Refusal("Địa chỉ ngoài máy phải dùng https://.")
    auth = args.get("auth") or "none"
    cfg = {"url": url, "enabled": True}
    if auth == "oauth":
        cfg["auth"] = "oauth"
    elif auth == "bearer":
        token = str(args.get("token") or "").strip()
        if not token or len(token) > 4096 or re.search(r"[\x00-\x1f\x7f]", token):
            raise Refusal("Dán khoá (token) của dịch vụ.")
        from hermes_cli.mcp_config import _env_key_for_server
        key = _env_key_for_server(name)
        if any(_env_key_for_server(other) == key for other in _mcp_servers()):
            raise Refusal("Tên này trùng chỗ lưu khoá với một kết nối khác — đặt tên khác.")
        cfg["headers"] = _save_bearer_auth_token(name, token)
    elif auth != "none":
        raise Refusal("Kiểu đăng nhập không hợp lệ.")
    if not _save_mcp_server(name, cfg):
        raise Refusal("Hermes từ chối cấu hình này.")
    return {"name": name, "auth": auth}


ENV_REF = re.compile(r"\$\{([A-Z][A-Z0-9_]{1,63})\}")
TIMEOUT_RANGE = {"timeout": (10, 3600), "connect_timeout": (5, 600)}


def _key_refs(cfg):
    """Tên biến .env mà kết nối dùng làm khoá: các `${TÊN}` trong headers/env. Biến ZALO_/HERMES_ không bao giờ là khoá."""
    refs = {}
    for block in ("headers", "env"):
        values = cfg.get(block) if isinstance(cfg.get(block), dict) else {}
        for field, value in values.items():
            for ref in ENV_REF.findall(str(value)):
                if not ref.startswith(("ZALO_", "HERMES_")):
                    refs[ref] = refs.get(ref) or (block == "headers" and str(field).lower() == "authorization"
                                                  and str(value).lstrip().lower().startswith("bearer "))
    return refs  # tên → True nếu là khoá "Bearer …" (bỏ chữ Bearer người dùng lỡ dán kèm)


def mcp_edit(args):
    """Sửa kết nối đã có: địa chỉ (chỉ kiểu http), khoá trong .env (chỉ biến mà kết nối đang dùng), thời gian chờ.
    Không bao giờ trả lại giá trị khoá."""
    from urllib.parse import urlparse
    from hermes_cli.config import save_env_value
    from hermes_cli.mcp_config import _save_mcp_server, _strip_bearer_prefix
    name, cfg = need_mcp(args)
    cfg = dict(cfg)
    changed, relogin = [], False
    url = args.get("url")
    if url is not None and str(url).strip() != str(cfg.get("url") or ""):
        if not cfg.get("url"):
            raise Refusal("Kết nối này chạy bằng lệnh trên máy chủ — không có địa chỉ để sửa.")
        url = str(url).strip()
        try:
            u = urlparse(url)
            host, _port = u.hostname, u.port
        except ValueError:
            raise Refusal("Địa chỉ phải dạng https://…")
        if u.scheme not in ("https", "http") or not host or len(url) > 500 or re.search(r"\s", url):
            raise Refusal("Địa chỉ phải dạng https://…")
        if u.scheme == "http" and u.hostname not in LOOPBACK:
            raise Refusal("Địa chỉ ngoài máy phải dùng https://.")
        relogin = cfg.get("auth") == "oauth" and urlparse(str(cfg["url"])).hostname != host
        cfg["url"] = url
        changed.append("địa chỉ")
    keys = args.get("keys") or {}
    if not isinstance(keys, dict):
        raise Refusal("Thông tin khoá không hợp lệ.")
    refs = _key_refs(cfg)
    for key, value in keys.items():
        if key not in refs:
            raise Refusal(f"Kết nối này không dùng khoá {key}.")
        value = str(value or "").strip()
        if not value:
            continue  # để trống = giữ khoá cũ
        if refs[key]:
            value = _strip_bearer_prefix(value)
        if not value or len(value) > 4096 or re.search(r"[\x00-\x1f\x7f]", value):
            raise Refusal("Khoá không hợp lệ — dán lại đúng khoá của dịch vụ.")
        save_env_value(key, value)
        changed.append("khoá")
    for field, (lo, hi) in TIMEOUT_RANGE.items():
        if field not in args:
            continue
        raw = args.get(field)
        if raw in (None, ""):
            if field in cfg:
                cfg.pop(field)
                changed.append("thời gian chờ")
            continue
        try:
            seconds = int(raw)
        except (TypeError, ValueError):
            raise Refusal("Thời gian chờ phải là số giây.")
        if not lo <= seconds <= hi:
            raise Refusal(f"Thời gian chờ phải từ {lo} đến {hi} giây.")
        if cfg.get(field) != seconds:
            cfg[field] = seconds
            changed.append("thời gian chờ")
    if cfg != (_mcp_servers().get(name) or {}) and not _save_mcp_server(name, cfg):
        raise Refusal("Hermes từ chối cấu hình này.")
    if relogin:
        try:
            from tools.mcp_oauth import remove_oauth_tokens
            remove_oauth_tokens(name)
        except Exception:
            pass
    return {"name": name, "changed": sorted(set(changed)), "relogin": relogin}


def _tool_enabled(tool, tools_cfg):
    from fnmatch import fnmatchcase
    if not isinstance(tools_cfg, dict):
        return True
    include, exclude = tools_cfg.get("include"), tools_cfg.get("exclude")
    if isinstance(include, list):
        return any(fnmatchcase(tool, str(p)) for p in include)
    if isinstance(exclude, list):
        return not any(fnmatchcase(tool, str(p)) for p in exclude)
    return True


def mcp_test(args):
    from hermes_cli.mcp_config import _oauth_tokens_present, _probe_single_server
    name, cfg = need_mcp(args)
    if cfg.get("auth") == "oauth" and not _oauth_tokens_present(name):
        return {"name": name, "connected": False, "needsLogin": True, "tools": []}
    try:
        from tools.mcp_oauth import suppress_interactive_oauth
    except ImportError:
        from contextlib import nullcontext as suppress_interactive_oauth
    try:
        with suppress_interactive_oauth():
            tools = _probe_single_server(name, cfg, connect_timeout=25)
    except Exception as exc:
        return {"name": name, "connected": False, "error": _short_error(exc), "tools": []}
    tcfg = cfg.get("tools")
    return {"name": name, "connected": True, "tools": [
        {"name": t, "description": (d or "")[:300], "enabled": _tool_enabled(t, tcfg)} for t, d in tools[:500]]}


def mcp_tools(args):
    from hermes_cli.config import load_config, save_config
    name, _cfg = need_mcp(args)
    off = args.get("disabled")
    if not isinstance(off, list) or len(off) > 500 or not all(isinstance(t, str) and TOOL_PATTERN.match(t) for t in off):
        raise Refusal("Danh sách công cụ không hợp lệ.")
    config = load_config()
    entry = config["mcp_servers"][name]
    block = entry.get("tools") if isinstance(entry.get("tools"), dict) else {}
    block.pop("include", None)
    if off:
        block["exclude"] = sorted(set(off))
    else:
        block.pop("exclude", None)
    if block:
        entry["tools"] = block
    else:
        entry.pop("tools", None)
    save_config(config)
    return {"name": name, "disabled": sorted(set(off))}


def mcp_remove(args):
    from hermes_cli import mcp_catalog as mc
    name, _cfg = need_mcp(args)
    # Chỉ xoá thư mục mã nguồn đã tải (mcp-installs/<tên>) khi kết nối đúng là mục của danh mục.
    mc.uninstall_entry(name, purge_install_dir=bool(MCP_NAME.match(name) and mc.get_entry(name)))
    try:
        from tools.mcp_oauth import remove_oauth_tokens
        remove_oauth_tokens(name)
    except Exception:
        pass
    return {"name": name}


def mcp_oauth(args):
    """Đăng nhập OAuth qua trang dashboard: in dòng {stage: authorize, url, state}, chờ một dòng callback
    {code, state, error} trên stdin, rồi in kết quả cuối. Luồng OAuth (DCR, PKCE, kiểm state, đổi token) là của Hermes."""
    import secrets
    import threading
    from urllib.parse import urlparse
    from hermes_constants import get_hermes_home
    from tools.mcp_dashboard_oauth import DashboardOAuthFlow
    run_flow = pick("_run_dashboard_mcp_oauth", "hermes_cli.web_server_mcp", "hermes_cli.web_server")
    name, cfg = need_mcp(args)
    if not cfg.get("url"):
        raise Refusal("Kết nối chạy bằng lệnh trên máy không đăng nhập OAuth — dùng khoá ở phần cài đặt.")
    if cfg.get("headers") and cfg.get("auth") != "oauth":
        raise Refusal("Kết nối này dùng khoá (token), không dùng đăng nhập.")
    redirect = str(args.get("redirect_uri") or "")
    r = urlparse(redirect)
    if not (r.scheme == "https" or (r.scheme == "http" and r.hostname in LOOPBACK)) or not r.hostname:
        raise Refusal("Địa chỉ quay về không hợp lệ — đặt địa chỉ công khai của dashboard.")
    cfg = dict(cfg, auth="oauth")
    flow = DashboardOAuthFlow(flow_id=secrets.token_urlsafe(16), server_name=name, profile=None,
                              hermes_home=str(get_hermes_home().expanduser().resolve(strict=False)),
                              redirect_uri=redirect, reconnect_live=False)
    threading.Thread(target=run_flow, args=(flow, cfg), daemon=True).start()
    import asyncio
    try:
        url = asyncio.run(flow.wait_for_authorization_url(timeout=45))
    except Exception as exc:
        flow.mark_error(str(exc))
        flow._worker_done.wait(30)
        raise Refusal(f"Chưa mở được trang đăng nhập: {_short_error(flow.error or exc)}")
    reply({"ok": True, "stage": "authorize", "url": url, "state": flow.expected_state})
    line = sys.stdin.readline()
    try:
        cb = json.loads(line) if line.strip() else {}
        flow.deliver_callback(code=cb.get("code"), state=cb.get("state"), error=cb.get("error"))
    except Exception as exc:
        flow.mark_error(str(exc) or "Huỷ")
    flow._worker_done.wait(330)
    snap = flow.snapshot()
    if snap["status"] != "approved":
        raise Refusal(f"Đăng nhập chưa xong: {_short_error(snap.get('error') or 'hết thời gian chờ')}")
    return {"name": name, "stage": "done", "tools": len(getattr(flow, "tools", []) or [])}


# ─── Sao lưu cài đặt bot (.zip nhẹ, tải về/khôi phục được) + điểm khôi phục nhanh của Hermes ─────────

BACKUP_MARK = "2anh-backup.json"
BACKUP_FILES = {"config.yaml", ".env", "SOUL.md", "auth.json", "cron/jobs.json"}
BACKUP_DIRS = ("memories/", "skills/", "zalo/")
BACKUP_SKIP_PARTS = {".hub", "node_modules", "__pycache__", ".git", "venv", ".venv", ".cache"}
BACKUP_SKIP_FILES = {"zalo/dashboard/sessions.json"}
# Thư mục của dashboard nằm trong zalo/ nhưng không phải cài đặt: chính các bản sao lưu (tệp .partial đang ghi từng tự
# nén chính nó, phình tới hàng chục GB), mã tải về khi cập nhật, tệp chờ gửi.
BACKUP_SKIP_PREFIXES = ("zalo/dashboard/backups/", "zalo/dashboard/update-tmp/", "zalo/dashboard/outbox/")
BACKUP_MAX_FILE = 20 * 1024 * 1024
BACKUP_KEEP = 5
BACKUP_NAME = re.compile(r"^hermes-zalo-\d{8}-\d{6}(-[a-z0-9-]{1,30})?\.zip$")
SNAPSHOT_ID = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


def _home():
    from hermes_constants import get_hermes_home
    return get_hermes_home()


def _backup_wanted(rel):
    """Đường tương đối (posix) có thuộc bản sao lưu cài đặt không."""
    parts = rel.split("/")
    if any(p in BACKUP_SKIP_PARTS or p in ("", ".", "..") for p in parts) or rel in BACKUP_SKIP_FILES:
        return False
    if rel.endswith((".pyc", ".db-wal", ".db-shm", ".lock", ".partial")) or rel.startswith(BACKUP_SKIP_PREFIXES):
        return False
    return rel in BACKUP_FILES or rel.startswith(BACKUP_DIRS)


def _backup_dir(args):
    d = str(args.get("dir") or "")
    if not d or not os.path.isabs(d):
        raise Refusal("Thiếu thư mục chứa bản sao lưu.")
    os.makedirs(d, exist_ok=True)
    return d


def _make_backup(out_dir, label=""):
    import time
    home = _home()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"hermes-zalo-{stamp}{'-' + label if label else ''}.zip"
    final = os.path.join(out_dir, name)
    tmp = final + ".partial"
    count = 0
    skipped = []
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        roots = [home / f for f in sorted(BACKUP_FILES)] + [home / d.rstrip("/") for d in BACKUP_DIRS]
        for path in sorted(p for r in roots for p in ([r] if r.is_file() else r.rglob("*") if r.is_dir() else [])):
            if not path.is_file() or path.is_symlink():
                continue
            if os.path.abspath(path) in (os.path.abspath(tmp), os.path.abspath(final)):
                continue  # không bao giờ nén chính tệp đang ghi (thư mục sao lưu có thể nằm trong vùng được sao lưu)
            rel = path.relative_to(home).as_posix()
            if not _backup_wanted(rel):
                continue
            if path.stat().st_size > BACKUP_MAX_FILE:
                skipped.append(rel)
                continue
            zf.write(path, rel)
            count += 1
        zf.writestr(BACKUP_MARK, json.dumps({"version": 1, "created": stamp, "files": count, "skipped": skipped}, ensure_ascii=False))
    os.replace(tmp, final)
    olds = sorted((f for f in os.listdir(out_dir) if BACKUP_NAME.match(f)), reverse=True)[BACKUP_KEEP:]
    for f in olds:
        os.remove(os.path.join(out_dir, f))
    return {"file": name, "size": os.path.getsize(final), "files": count, "skipped": skipped}


def backup_create(args):
    return _make_backup(_backup_dir(args))


def backup_restore(args):
    """Khôi phục từ một bản sao lưu cài đặt: chỉ ghi các tệp thuộc danh sách sao lưu, không xoá tệp nào.
    Luôn tạo một bản sao lưu hiện trạng trước ("truoc-khoi-phuc") để quay lại được."""
    out_dir = _backup_dir(args)
    path = str(args.get("path") or "")
    if not path or not os.path.isfile(path) or not zipfile.is_zipfile(path):
        raise Refusal("Tệp không phải bản sao lưu .zip.")
    home = _home().resolve()
    try:
        with zipfile.ZipFile(path) as zf:
            names = [i for i in zf.infolist() if not i.is_dir()]
            if BACKUP_MARK not in {i.filename for i in names}:
                raise Refusal("Tệp này không phải bản sao lưu tạo từ dashboard.")
            plan = []
            for info in names:
                rel = info.filename.replace("\\", "/")
                if rel == BACKUP_MARK:
                    continue
                if not _backup_wanted(rel) or (info.external_attr >> 16) & 0o170000 == 0o120000 or info.file_size > BACKUP_MAX_FILE:
                    raise Refusal(f"Bản sao lưu chứa tệp ngoài danh sách cho phép: {rel[:80]}")
                dst = (home / rel).resolve()
                if not dst.is_relative_to(home):
                    raise Refusal("Bản sao lưu chứa đường dẫn không an toàn.")
                plan.append((info, dst))
            before = _make_backup(out_dir, "truoc-khoi-phuc")
            for info, dst in plan:
                dst.parent.mkdir(parents=True, exist_ok=True)
                tmp = dst.with_name(dst.name + ".restore-tmp")
                with zf.open(info) as src, open(tmp, "wb") as fh:
                    shutil.copyfileobj(src, fh)
                os.replace(tmp, dst)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise Refusal("Không giải nén được bản sao lưu (tệp hỏng?).")
    return {"restored": len(plan), "before": before["file"]}


def snapshot_list(_args):
    list_quick_snapshots = pick("list_quick_snapshots", "hermes_cli.backup")
    out = []
    for m in list_quick_snapshots(limit=30):
        out.append({"id": m.get("id", ""), "label": m.get("label") or "", "timestamp": m.get("timestamp", ""),
                    "files": m.get("file_count", 0), "size": m.get("total_size", 0)})
    return {"snapshots": out}


def snapshot_create(args):
    create_quick_snapshot = pick("create_quick_snapshot", "hermes_cli.backup")
    label = re.sub(r"[^a-z0-9-]", "", str(args.get("label") or "dashboard").lower())[:30] or "dashboard"
    snap = create_quick_snapshot(label=label)
    if not snap:
        raise Refusal("Hermes chưa tạo được điểm khôi phục (đang có sao lưu khác chạy?).")
    return {"id": snap}


def snapshot_restore(args):
    restore_quick_snapshot = pick("restore_quick_snapshot", "hermes_cli.backup")
    sid = str(args.get("id") or "")
    if not SNAPSHOT_ID.match(sid) or sid in (".", ".."):
        raise Refusal("Mã điểm khôi phục không hợp lệ.")
    if not restore_quick_snapshot(sid):
        raise Refusal("Không khôi phục được điểm này (không còn hoặc trống).")
    return {"id": sid}


COMMANDS = {
    "skills.list": skills_list,
    "skills.view": skills_view,
    "skills.toggle": skills_toggle,
    "skills.uninstall": skills_uninstall,
    "skills.upload": skills_upload,
    "hub.search": hub_search,
    "hub.official": hub_official,
    "hub.preview": hub_preview,
    "hub.scan": hub_scan,
    "hub.install": hub_install,
    "mcp.catalog": mcp_catalog,
    "mcp.install": mcp_install,
    "mcp.add": mcp_add,
    "mcp.edit": mcp_edit,
    "mcp.test": mcp_test,
    "mcp.tools": mcp_tools,
    "mcp.remove": mcp_remove,
    "mcp.oauth": mcp_oauth,
    "backup.create": backup_create,
    "backup.restore": backup_restore,
    "snapshot.list": snapshot_list,
    "snapshot.create": snapshot_create,
    "snapshot.restore": snapshot_restore,
}
STREAMING = {"mcp.oauth"}  # tham số ở dòng đầu stdin; stdin còn mở để nhận callback


def main():
    sys.stdout = sys.stderr  # Hermes in gì cũng sang stderr; chỉ reply() ghi stdout thật.
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    fn = COMMANDS.get(cmd)
    if fn is None:
        reply({"ok": False, "error": "Lệnh không hợp lệ."})
        return 2
    try:
        raw = sys.stdin.readline() if cmd in STREAMING else sys.stdin.read()
        args = json.loads(raw) if raw.strip() else {}
        if not isinstance(args, dict):
            raise Refusal("Tham số không hợp lệ.")
        reply(dict(fn(args), ok=True))
        return 0
    except Refusal as exc:
        text = str(exc)
        home = os.environ.get("HERMES_HOME", "")
        for p in {home, os.path.realpath(home) if home else ""} - {""}:  # không lộ đường dẫn máy chủ
            text = text.replace(p, "HERMES_HOME")
        reply({"ok": False, "error": text, "user": True})
        return 1
    except Exception as exc:  # lỗi lạ: in chi tiết ra stderr cho nhật ký dashboard, trả câu chung
        import traceback
        traceback.print_exc()
        reply({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
