# Dashboard quản trị Zalo trong Hermes — Kế hoạch thi công

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm một tab "Zalo" vào Hermes Dashboard để khách tự vận hành bot — xem sức khoẻ, quét lại QR, đọc lịch sử, sửa cấu hình — mà không phải mở tệp `.env` bằng Notepad.

**Architecture:** Plugin dashboard theo đúng khuôn `plugins/kanban` của Hermes: `manifest.json` khai tab, `plugin_api.py` là FastAPI router mount tại `/api/plugins/zalo/`, `dist/index.js` là IIFE đăng ký component React qua SDK của host. Dữ liệu lịch sử đọc thẳng SQLite chế độ chỉ đọc; hành động sống (QR, gửi tin) gọi HTTP sang sidecar kèm `ZALO_BRIDGE_TOKEN`.

**Tech Stack:** Python 3 + FastAPI (phía host), JavaScript thuần + React qua `window.__HERMES_PLUGIN_SDK__` (phía giao diện), `node:sqlite`, `node --test`, `unittest`.

**Spec:** `docs/superpowers/specs/2026-09-09-zalo-dashboard-plugin-design.md` (bản cập nhật 2026-09-10)

## Global Constraints

- **Không thêm dependency npm nào.** Bộ phụ thuộc giữ đúng bốn gói: `express`, `ws`, `yaml`, `zca-js`.
- **Không thêm dependency Python nào.** `plugin_api.py` chỉ dùng thư viện chuẩn + `fastapi` (host đã có).
- **Không dùng bundler.** `dist/index.js` sinh ra bằng script nối chuỗi, không webpack/esbuild/rollup.
- **Chữ hiển thị cho người dùng: tiếng Việt, không lộ thuật ngữ hạ tầng.** Không có "sidecar", "bridge", "WebSocket", "toolset" trong giao diện. Là "Kết nối Zalo" và "Trợ lý". Mọi thông báo lỗi kèm bước tiếp theo cần làm.
- **Chú thích trong mã: tiếng Việt. Tên tệp/hàm/biến: tiếng Anh.**
- **SQLite luôn mở chế độ chỉ đọc** (`mode=ro`). Dashboard không có đường ghi vào lịch sử.
- **`GET /config` chỉ trả về khoá bắt đầu bằng `ZALO_`.** Tuyệt đối không trả cả tệp `.env` — nó chứa `EXA_API_KEY`, token Facebook, khoá model.
- **Không hiển thị số điện thoại, cookie hay IMEI** ở bất kỳ đâu trong giao diện.
- **Token dùng lại `ZALO_BRIDGE_TOKEN`**, không sinh token thứ hai. So sánh bằng `timingSafeEqual`, không dùng `===`.
- **Không `git push`, không `git tag`, không rewrite lịch sử.**
- **Không chạy `npm run install:hermes`, `doctor`, `uninstall:hermes` lên bản Hermes thật** (`E:\Hermes`) — chúng ghi vào bản đang chạy của chủ nhân. Test phải dùng thư mục tạm.
- **Không `kill`/`taskkill`/`pkill`.** Sidecar production PID 22524 đang phục vụ bot Zalo thật trên cổng 3872/3873. Không bind hai cổng đó — test dùng `port: 0`.
- **Mỗi task một commit.** Thân commit tiếng Việt, kết thúc đúng dòng `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Chạy test: `npm test`. Mốc hiện tại: **89 JS + 36 Python**. Số test phải tăng, không được giảm.

**Bảng số test dự kiến sau mỗi task** — dùng để bắt lỗi sớm nếu con số lệch:

| Sau task | JS | Python | Ghi chú |
|---|---|---|---|
| (mốc) | 89 | 36 | |
| 1 | 89 | 38 | +2 test hợp đồng plugin |
| 2 | 89 | 43 | +5 test đọc SQLite |
| 3 | 89 | 49 | +6 test cấu hình |
| 4 | 94 | 49 | +5 test `control-api` |
| 5 | 94 | 55 | +6 test ghi cấu hình |
| 6 | 94 | 56 | +1 test bảng route (có thể skip nếu thiếu `fastapi`) |
| 7 | 94 | 56 | giao diện không có test tự động |
| 8 | 97 | 56 | +3 test trình cài |
| 9 | 97 | 56 | chỉ tài liệu |

---

## File Structure

**Thêm mới — thư mục `hermes-dashboard-plugin/`:**

| Tệp | Trách nhiệm |
|---|---|
| `manifest.json` | Khai tab "Zalo", icon, vị trí, trỏ tới `dist/index.js` và `plugin_api.py` |
| `plugin_api.py` | FastAPI router: đọc SQLite, đọc/ghi cấu hình, chuyển tiếp sang sidecar |
| `src/00-sdk.js` | Lấy `React`/`hooks`/`components` từ `__HERMES_PLUGIN_SDK__`, thoái lui êm nếu thiếu |
| `src/10-connection.js` | Màn Kết nối: QR, hồ sơ, sức khoẻ, thẻ "Việc cần làm" |
| `src/20-conversations.js` | Màn Hội thoại: danh sách + khung tin nhắn + tìm kiếm |
| `src/30-control.js` | Màn Điều khiển: allowlist, ngưỡng, sổ người quen, kho tài liệu |
| `src/40-audit.js` | Màn Nhật ký: bảng `audit_log` |
| `src/99-register.js` | Dải trạng thái + 4 tab + `__HERMES_PLUGINS__.register("zalo", App)` |
| `dist/index.js` | Nối chuỗi từ `src/`, **có commit** |
| `dist/style.css` | CSS riêng, bám design token của host |
| `build.js` | Nối tệp theo thứ tự tên, ~30 dòng |
| `test_plugin_api.py` | Test Python cho `plugin_api.py` |

**Thêm mới — phía sidecar:**

| Tệp | Trách nhiệm |
|---|---|
| `control-api.js` | Các route `/control/*`, kiểm `ZALO_BRIDGE_TOKEN` |
| `control-api.test.js` | Test cho `control-api.js` |

**Sửa tệp có sẵn:**

| Tệp | Sửa gì |
|---|---|
| `server.js` | Nạp `control-api.js` |
| `scripts/hermes-install-lib.js` | Chép plugin dashboard khi cài; thêm mục kiểm cho `doctor`; gỡ khi `uninstall` |
| `scripts/run-python-tests.js` | Thêm `hermes-dashboard-plugin/test_plugin_api.py` vào danh sách |
| `README.md`, `README.vi.md` | Thêm mục về tab Zalo |

**Vì sao tách `src/` rồi nối thành `dist/`:** kanban và achievements đều commit sẵn `dist` và khách không phải build — đó là ưu điểm lớn nhất của hệ plugin này, phải giữ. Nhưng viết cả 4 màn vào một tệp ~1200 dòng thì khó sửa. Nối chuỗi bằng script tầm thường giải quyết cả hai, không thêm dependency.

---

## Task 1: Bộ khung plugin — tab hiện ra trong Hermes

**Files:**
- Create: `hermes-dashboard-plugin/manifest.json`
- Create: `hermes-dashboard-plugin/plugin_api.py`
- Create: `hermes-dashboard-plugin/src/00-sdk.js`
- Create: `hermes-dashboard-plugin/src/99-register.js`
- Create: `hermes-dashboard-plugin/build.js`
- Create: `hermes-dashboard-plugin/dist/index.js` (sinh ra)
- Create: `hermes-dashboard-plugin/dist/style.css`
- Test: `hermes-dashboard-plugin/test_plugin_api.py`

**Interfaces:**
- Consumes: không có
- Produces: `router` (FastAPI APIRouter) trong `plugin_api.py`; hàm `buildDist()` trong `build.js`; biến toàn cục `window.__HERMES_PLUGINS__.register("zalo", App)`

Mục tiêu task này: **tab Zalo hiện ra trong Hermes Dashboard và trả về một trang trống có tiêu đề.** Chưa có dữ liệu thật. Làm được điều này nghĩa là hợp đồng plugin đã đúng — phần còn lại chỉ là đắp thêm.

- [ ] **Step 1: Viết test cho endpoint đầu tiên**

Tạo `hermes-dashboard-plugin/test_plugin_api.py`:

```python
"""Test cho plugin dashboard Zalo.

Chạy được mà không cần Hermes thật: import trực tiếp module rồi gọi hàm.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent


def load_plugin_api():
    """Nạp plugin_api.py như một module độc lập."""
    spec = importlib.util.spec_from_file_location(
        "zalo_plugin_api", PLUGIN_DIR / "plugin_api.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["zalo_plugin_api"] = module
    spec.loader.exec_module(module)
    return module


class PluginContractTest(unittest.TestCase):
    def test_module_exposes_a_router(self):
        api = load_plugin_api()
        self.assertTrue(hasattr(api, "router"), "plugin_api.py phải xuất biến `router`")

    def test_ping_reports_the_plugin_is_alive(self):
        api = load_plugin_api()
        result = api.ping()
        self.assertEqual(result["plugin"], "zalo")
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

```bash
cd /e/2anh-zalo-bot
/e/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest discover -s hermes-dashboard-plugin -p "test_*.py" -v
```

Mong đợi: FAIL — không có tệp `plugin_api.py`.

- [ ] **Step 3: Viết `plugin_api.py` tối thiểu**

```python
"""Backend cho tab Zalo trong Hermes Dashboard.

Host mount router này tại /api/plugins/zalo/ và đặt nó sau dashboard_auth,
nên mọi route ở đây đã được xác thực sẵn.
"""
from __future__ import annotations

try:
    from fastapi import APIRouter
except Exception:  # cho phép chạy test mà không cần cài fastapi
    class APIRouter:  # type: ignore
        def get(self, *_args, **_kwargs):
            return lambda fn: fn

        def post(self, *_args, **_kwargs):
            return lambda fn: fn

        def put(self, *_args, **_kwargs):
            return lambda fn: fn

        def delete(self, *_args, **_kwargs):
            return lambda fn: fn


router = APIRouter()


@router.get("/ping")
def ping() -> dict:
    """Kiểm tra plugin đã được nạp chưa."""
    return {"ok": True, "plugin": "zalo"}
```

- [ ] **Step 4: Chạy lại, xác nhận XANH**

```bash
cd /e/2anh-zalo-bot
/e/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest discover -s hermes-dashboard-plugin -p "test_*.py" -v
```

Mong đợi: 2 test PASS.

- [ ] **Step 5: Viết `manifest.json`**

```json
{
  "name": "zalo",
  "label": "Zalo",
  "description": "Quản trị bot Zalo — trạng thái kết nối, lịch sử hội thoại, phân quyền và nhật ký thao tác",
  "icon": "MessageCircle",
  "version": "1.0.0",
  "tab": {
    "path": "/zalo",
    "position": "after:skills"
  },
  "entry": "dist/index.js",
  "css": "dist/style.css",
  "api": "plugin_api.py"
}
```

- [ ] **Step 6: Viết `src/00-sdk.js`**

```javascript
// Lấy SDK do Hermes Dashboard bơm vào. Nếu thiếu thì thoái lui êm — không vỡ
// trắng màn trên bản Hermes cũ chưa có SDK.
const SDK = window.__HERMES_PLUGIN_SDK__;
if (!SDK || !window.__HERMES_PLUGINS__) return;

const React = SDK.React;
const h = React.createElement;
const { useState, useEffect } = SDK.hooks;
const C = SDK.components;
const fetchJSON = SDK.fetchJSON;

// Gọi API của chính plugin này. Host lo phần xác thực.
const api = (path, options) => fetchJSON(`/api/plugins/zalo${path}`, options);
```

- [ ] **Step 7: Viết `src/99-register.js`**

```javascript
function ZaloPage() {
  const [ping, setPing] = useState(null);

  useEffect(() => {
    api('/ping').then(setPing).catch(() => setPing({ ok: false }));
  }, []);

  return h('div', { className: 'zalo-page' },
    h('h1', null, 'Zalo'),
    h('p', { className: 'zalo-muted' },
      ping === null ? 'Đang kiểm tra kết nối…'
        : ping.ok ? 'Plugin đã nạp xong.'
        : 'Không gọi được backend của plugin.'),
  );
}

window.__HERMES_PLUGINS__.register('zalo', ZaloPage);
```

- [ ] **Step 8: Viết `build.js`**

```javascript
#!/usr/bin/env node
/**
 * Nối các tệp trong src/ thành dist/index.js.
 *
 * Không dùng bundler: hệ plugin của Hermes nạp một tệp IIFE duy nhất, và
 * khách không phải build gì cả. Nối chuỗi theo thứ tự tên tệp là đủ —
 * thêm webpack vào đây chỉ tạo thêm một thứ phải bảo trì.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function buildDist() {
  const srcDir = join(ROOT, 'src');
  const parts = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort()
    .map((f) => readFileSync(join(srcDir, f), 'utf8'));

  const body = parts.join('\n\n');
  const output = `(function () {\n  "use strict";\n${body}\n})();\n`;

  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  writeFileSync(join(ROOT, 'dist', 'index.js'), output, 'utf8');
  return output.length;
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')) {
  console.log(`dist/index.js: ${buildDist()} ký tự`);
}
```

- [ ] **Step 9: Viết `dist/style.css`**

```css
/* Bám design token của host để tự khớp sáng/tối. */
.zalo-page {
  padding: 1.5rem;
  color: var(--color-foreground);
}

.zalo-muted {
  color: var(--color-muted-foreground);
}

.zalo-card {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 0.5rem);
  padding: 1rem;
  margin-bottom: 1rem;
}
```

- [ ] **Step 10: Sinh `dist/index.js` và kiểm cú pháp**

```bash
cd /e/2anh-zalo-bot/hermes-dashboard-plugin
node build.js
node --check dist/index.js && echo "CU PHAP OK"
```

Mong đợi: in ra số ký tự, cú pháp hợp lệ.

- [ ] **Step 11: Thêm test Python của plugin vào `npm test`**

Sửa `scripts/run-python-tests.js`: thêm `hermes-dashboard-plugin` vào danh sách thư mục quét. Đọc tệp đó trước để biết nó đang liệt kê thế nào rồi thêm cho khớp.

- [ ] **Step 12: Chạy toàn bộ test**

```bash
cd /e/2anh-zalo-bot && npm test 2>&1 | grep -E "^# (tests|pass|fail)|Tổng số test Python"
```

Mong đợi: JS vẫn 89; Python tăng từ 36 lên 38.

- [ ] **Step 13: Commit**

```bash
cd /e/2anh-zalo-bot
find . -name __pycache__ -type d -not -path "./node_modules/*" -exec rm -rf {} + 2>/dev/null
git add hermes-dashboard-plugin scripts/run-python-tests.js
git commit -m "feat(dashboard): bộ khung plugin Zalo cho Hermes Dashboard

Tab Zalo hiện ra trong Hermes Dashboard với một trang tối thiểu gọi được
backend của chính nó. Chưa có dữ liệu thật — mục đích là chốt đúng hợp
đồng plugin (manifest + router + đăng ký component) trước khi đắp thêm.

Nối src/ thành dist/ bằng script nối chuỗi, không dùng bundler: hệ plugin
của Hermes nạp một tệp IIFE duy nhất và khách không phải build gì cả.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Đọc SQLite — lịch sử và nhật ký

**Files:**
- Modify: `hermes-dashboard-plugin/plugin_api.py`
- Modify: `hermes-dashboard-plugin/test_plugin_api.py`

**Interfaces:**
- Consumes: `router` từ Task 1
- Produces: `resolve_sidecar_dir()`, `open_store(readonly=True)`, `list_threads()`, `thread_messages(thread_id, before, limit)`, `search_messages(query, limit)`, `audit_entries(status, limit)`

Lược đồ SQLite (đọc từ `zalo-store.js` của repo — **đừng đoán, mở tệp ra xem**):

- Bảng `messages`: `identity_key`, `account_id`, `thread_id`, `thread_type`, `msg_id`, `cli_msg_id`, `sender_uid`, `sender_name`, `text`, `msg_type`, `timestamp_ms`, `is_self`, `source`, `created_at_ms`, `updated_at_ms`
- Bảng `audit_log`: `id`, `request_id`, `account_id`, `actor_uid`, `actor_role`, `action`, `category`, `thread_id`, `thread_type`, `status`, `target_summary`, `error`, `created_at_ms`
- Chỉ mục có sẵn: `idx_messages_thread_time` trên `(account_id, thread_type, thread_id, timestamp_ms DESC)`

- [ ] **Step 1: Viết test trước**

Thêm vào `test_plugin_api.py`:

```python
import sqlite3
import tempfile


def make_store(path):
    """Dựng một zalo.sqlite tối thiểu giống thật để test."""
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE messages (
          identity_key TEXT PRIMARY KEY, account_id TEXT NOT NULL,
          thread_id TEXT NOT NULL, thread_type INTEGER NOT NULL,
          msg_id TEXT, cli_msg_id TEXT,
          sender_uid TEXT NOT NULL DEFAULT '', sender_name TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL DEFAULT '', msg_type TEXT NOT NULL DEFAULT '',
          timestamp_ms INTEGER NOT NULL, is_self INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL,
          account_id TEXT NOT NULL DEFAULT '', actor_uid TEXT NOT NULL DEFAULT '',
          actor_role TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
          category TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '',
          thread_type INTEGER, status TEXT NOT NULL,
          target_summary TEXT, error TEXT, created_at_ms INTEGER NOT NULL
        );
    """)
    conn.execute(
        "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ('k1', 'acc', 'nhom1', 1, 'm1', 'c1', 'u1', 'Lan', 'chào cả nhà',
         'webchat', 1_700_000_000_000, 0, 'live', 0, 0),
    )
    conn.execute(
        "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ('k2', 'acc', 'nhom1', 1, 'm2', 'c2', 'acc', 'Bot', 'chào bạn',
         'webchat', 1_700_000_001_000, 1, 'outbound', 0, 0),
    )
    conn.execute(
        "INSERT INTO audit_log (request_id, account_id, actor_uid, actor_role,"
        " action, category, thread_id, thread_type, status, created_at_ms)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        ('r1', 'acc', 'u1', 'owner', 'sendMessage', 'send', 'nhom1', 1,
         'succeeded', 1_700_000_002_000),
    )
    conn.commit()
    conn.close()


class StoreReadTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = Path(self.dir.name) / "zalo.sqlite"
        make_store(self.db)
        self.api = load_plugin_api()

    def test_lists_threads_with_message_counts(self):
        threads = self.api.list_threads(self.db)
        self.assertEqual(len(threads), 1)
        self.assertEqual(threads[0]["thread_id"], "nhom1")
        self.assertEqual(threads[0]["message_count"], 2)

    def test_returns_messages_newest_last(self):
        rows = self.api.thread_messages(self.db, "nhom1", limit=10)
        self.assertEqual([r["text"] for r in rows], ["chào cả nhà", "chào bạn"])
        self.assertTrue(rows[1]["is_self"])

    def test_search_finds_text_across_threads(self):
        rows = self.api.search_messages(self.db, "cả nhà")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["thread_id"], "nhom1")

    def test_audit_entries_can_filter_failures_only(self):
        self.assertEqual(len(self.api.audit_entries(self.db)), 1)
        self.assertEqual(len(self.api.audit_entries(self.db, status="failed")), 0)

    def test_store_is_opened_read_only(self):
        conn = self.api.open_store(self.db)
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("DELETE FROM messages")
        conn.close()
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

```bash
cd /e/2anh-zalo-bot
/e/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest discover -s hermes-dashboard-plugin -p "test_*.py" -v
```

Mong đợi: 5 test mới FAIL — chưa có các hàm đó.

- [ ] **Step 3: Viết các hàm đọc SQLite**

Thêm vào `plugin_api.py`. Mở chế độ chỉ đọc bằng URI:

```python
import sqlite3
from pathlib import Path
from typing import Any, Optional


def open_store(db_path: Path) -> sqlite3.Connection:
    """Mở kho SQLite ở chế độ CHỈ ĐỌC.

    Dashboard không bao giờ được ghi vào lịch sử — mọi thao tác ghi đi qua
    sidecar để còn ghi được audit_log.
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _rows(db_path: Path, sql: str, params: tuple = ()) -> list[dict]:
    conn = open_store(db_path)
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def list_threads(db_path: Path, limit: int = 100) -> list[dict]:
    """Danh sách hội thoại, mới nhất lên đầu."""
    return _rows(db_path, """
        SELECT thread_id, thread_type,
               COUNT(*) AS message_count,
               MAX(timestamp_ms) AS last_at_ms,
               MAX(CASE WHEN is_self = 0 THEN sender_name END) AS last_sender
        FROM messages
        GROUP BY thread_id, thread_type
        ORDER BY last_at_ms DESC
        LIMIT ?
    """, (limit,))


def thread_messages(db_path: Path, thread_id: str,
                    before: Optional[int] = None, limit: int = 50) -> list[dict]:
    """Tin nhắn một hội thoại, cũ trước mới sau.

    `before` là mốc timestamp_ms để lật trang ngược về quá khứ.
    """
    if before is None:
        rows = _rows(db_path, """
            SELECT * FROM messages WHERE thread_id = ?
            ORDER BY timestamp_ms DESC LIMIT ?
        """, (thread_id, limit))
    else:
        rows = _rows(db_path, """
            SELECT * FROM messages WHERE thread_id = ? AND timestamp_ms < ?
            ORDER BY timestamp_ms DESC LIMIT ?
        """, (thread_id, before, limit))
    return list(reversed(rows))


def search_messages(db_path: Path, query: str, limit: int = 50) -> list[dict]:
    """Tìm chuỗi trong nội dung tin nhắn."""
    if not query.strip():
        return []
    return _rows(db_path, """
        SELECT * FROM messages WHERE text LIKE ? ESCAPE '\\'
        ORDER BY timestamp_ms DESC LIMIT ?
    """, (f"%{_escape_like(query)}%", limit))


def _escape_like(value: str) -> str:
    """Vô hiệu ký tự đại diện của LIKE để người dùng gõ % không quét cả bảng."""
    return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def audit_entries(db_path: Path, status: Optional[str] = None,
                  limit: int = 100) -> list[dict]:
    """Nhật ký thao tác, mới nhất lên đầu."""
    if status:
        return _rows(db_path, """
            SELECT * FROM audit_log WHERE status = ?
            ORDER BY created_at_ms DESC LIMIT ?
        """, (status, limit))
    return _rows(db_path, """
        SELECT * FROM audit_log ORDER BY created_at_ms DESC LIMIT ?
    """, (limit,))
```

- [ ] **Step 4: Chạy lại, xác nhận XANH**

```bash
cd /e/2anh-zalo-bot
/e/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest discover -s hermes-dashboard-plugin -p "test_*.py" -v
```

Mong đợi: 7 test PASS (2 của Task 1 + 5 mới) — tổng Python 43.

- [ ] **Step 5: Commit**

```bash
cd /e/2anh-zalo-bot
find . -name __pycache__ -type d -not -path "./node_modules/*" -exec rm -rf {} + 2>/dev/null
git add hermes-dashboard-plugin
git commit -m "feat(dashboard): đọc lịch sử và nhật ký từ SQLite

Mở kho ở chế độ chỉ đọc — dashboard không có đường ghi vào lịch sử, mọi
thao tác ghi phải đi qua sidecar để còn ghi được audit_log.

Tìm kiếm vô hiệu ký tự đại diện của LIKE: khách gõ dấu % vào ô tìm kiếm
thì đó là chữ cần tìm, không phải lệnh quét cả bảng.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Tìm sidecar và đọc cấu hình an toàn

**Files:**
- Modify: `hermes-dashboard-plugin/plugin_api.py`
- Modify: `hermes-dashboard-plugin/test_plugin_api.py`

**Interfaces:**
- Consumes: `open_store()` từ Task 2
- Produces: `hermes_home()`, `resolve_sidecar_dir()`, `read_zalo_env()`, `bridge_token()`, `setup_problems()`

Đây là task có bề mặt bảo mật cao nhất: đọc `.env` của Hermes, nơi chứa `EXA_API_KEY`, token Facebook, khoá model.

- [ ] **Step 1: Viết test trước**

Thêm vào `test_plugin_api.py`:

```python
class ConfigReadTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = Path(self.dir.name)
        (self.home / ".env").write_text(
            "ZALO_ALLOWED_USERS=123456789012345\n"
            "ZALO_DM_POLICY=owner-only\n"
            "EXA_API_KEY=bi-mat-tuyet-doi\n"
            "OPENAI_API_KEY=cung-bi-mat\n",
            encoding="utf-8",
        )
        self.api = load_plugin_api()

    def test_reads_only_zalo_keys(self):
        env = self.api.read_zalo_env(self.home)
        self.assertEqual(env["ZALO_ALLOWED_USERS"], "123456789012345")
        self.assertEqual(env["ZALO_DM_POLICY"], "owner-only")

    def test_never_leaks_non_zalo_secrets(self):
        env = self.api.read_zalo_env(self.home)
        self.assertNotIn("EXA_API_KEY", env)
        self.assertNotIn("OPENAI_API_KEY", env)
        blob = repr(env)
        self.assertNotIn("bi-mat-tuyet-doi", blob)
        self.assertNotIn("cung-bi-mat", blob)

    def test_missing_env_file_is_not_an_error(self):
        empty = Path(self.dir.name) / "trong"
        empty.mkdir()
        self.assertEqual(self.api.read_zalo_env(empty), {})

    def test_setup_problems_flags_an_empty_allowlist(self):
        (self.home / ".env").write_text("ZALO_ALLOWED_USERS=\n", encoding="utf-8")
        (self.home / "config.yaml").write_text("known_plugin_toolsets:\n  zalo:\n    - zalo_owner\n    - zalo_public\n", encoding="utf-8")
        problems = self.api.setup_problems(self.home)
        self.assertTrue(any("chủ nhân" in p["message"] for p in problems))

    def test_setup_problems_flags_missing_known_toolsets(self):
        (self.home / "config.yaml").write_text("plugins:\n  enabled: []\n", encoding="utf-8")
        problems = self.api.setup_problems(self.home)
        self.assertTrue(any("known_plugin_toolsets" in p["message"] for p in problems))

    def test_setup_problems_is_empty_when_everything_is_configured(self):
        (self.home / "config.yaml").write_text(
            "known_plugin_toolsets:\n  zalo:\n    - zalo_owner\n    - zalo_public\n",
            encoding="utf-8",
        )
        self.assertEqual(self.api.setup_problems(self.home), [])
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

```bash
cd /e/2anh-zalo-bot
/e/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest discover -s hermes-dashboard-plugin -p "test_*.py" -v
```

Mong đợi: 6 test mới FAIL.

- [ ] **Step 3: Viết các hàm cấu hình**

Thêm vào `plugin_api.py`:

```python
import os

# Chỉ những khoá này mới được trả ra ngoài. `.env` của Hermes còn chứa
# EXA_API_KEY, token Facebook, khoá model — trả nhầm là rò khoá thật.
ZALO_ENV_PREFIX = "ZALO_"


def hermes_home() -> Path:
    """Thư mục Hermes. Dùng helper của host, có bản dự phòng khi import lỗi."""
    try:
        from hermes_constants import get_hermes_home  # type: ignore
        return Path(get_hermes_home())
    except Exception:
        value = (os.environ.get("HERMES_HOME") or "").strip()
        return Path(value) if value else Path.home() / ".hermes"


def read_zalo_env(home: Path) -> dict:
    """Đọc `.env` của Hermes, CHỈ lấy khoá bắt đầu bằng ZALO_."""
    path = Path(home) / ".env"
    if not path.is_file():
        return {}
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        if key.startswith(ZALO_ENV_PREFIX):
            result[key] = value.strip().strip('"').strip("'")
    return result


def setup_problems(home: Path) -> list[dict]:
    """Những vấn đề cài đặt hay gặp, để hiện thẻ "Việc cần làm"."""
    problems: list[dict] = []
    env = read_zalo_env(home)

    if not any(v.strip() for v in env.get("ZALO_ALLOWED_USERS", "").split(",")):
        problems.append({
            "id": "no-owner",
            "message": "Chưa khai UID chủ nhân — bot sẽ không nghe lời ai.",
            "fix": "Nhắn /sethome cho tài khoản bot để lấy UID, rồi điền vào ô "
                   "\"Ai được sai bảo bot\" bên dưới.",
        })

    config = Path(home) / "config.yaml"
    text = config.read_text(encoding="utf-8", errors="replace") if config.is_file() else ""
    if "known_plugin_toolsets" not in text:
        problems.append({
            "id": "no-known-toolsets",
            "message": "config.yaml chưa khai known_plugin_toolsets cho Zalo.",
            "fix": "Chạy lại `npm run install:hermes` — trình cài tự khai mục này. "
                   "Thiếu nó thì người lạ nhắn vào nhóm cũng được cấp quyền chủ nhân.",
        })

    return problems
```

- [ ] **Step 4: Chạy lại, xác nhận XANH**

```bash
cd /e/2anh-zalo-bot
/e/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest discover -s hermes-dashboard-plugin -p "test_*.py" -v
```

Mong đợi: 13 test PASS — tổng Python 49.

- [ ] **Step 5: Commit**

```bash
cd /e/2anh-zalo-bot
find . -name __pycache__ -type d -not -path "./node_modules/*" -exec rm -rf {} + 2>/dev/null
git add hermes-dashboard-plugin
git commit -m "feat(dashboard): đọc cấu hình Zalo và phát hiện lỗi cài đặt

read_zalo_env chỉ trả về khoá bắt đầu bằng ZALO_. .env của Hermes còn chứa
EXA_API_KEY, token Facebook và khoá model — trả cả tệp là rò khoá thật ra
giao diện. Có test khẳng định các khoá đó không lọt.

setup_problems phát hiện hai lỗi cài đặt hay gặp nhất: chưa khai UID chủ
nhân, và config.yaml thiếu known_plugin_toolsets (thiếu nó thì người lạ
nhắn vào nhóm cũng được cấp quyền chủ nhân).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Route `/control/*` trên sidecar

**Files:**
- Create: `control-api.js`
- Create: `control-api.test.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: `ZALO_BRIDGE_TOKEN` từ môi trường; `sendSystemNotice` từ `hermes-bridge.js`
- Produces: `mountControlApi(app, { api, health, token })`

**Đọc trước khi viết:** `hermes-bridge.js` quanh dòng 306-350 để xem cách nó kiểm token bằng `timingSafeEqual`. Làm y như vậy, không dùng `===`.

- [ ] **Step 1: Viết test trước**

Tạo `control-api.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountControlApi } from './control-api.js';

const TOKEN = 'a'.repeat(64);

function startServer(overrides = {}) {
  const app = express();
  app.use(express.json());
  mountControlApi(app, {
    token: TOKEN,
    health: { snapshot: () => ({ status: 'ok' }) },
    api: { sendMessage: async () => ({ message: { msgId: 'm1' } }) },
    ...overrides,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function url(server, path) {
  return `http://127.0.0.1:${server.address().port}${path}`;
}

test('control routes reject a request with no token', async () => {
  const server = await startServer();
  try {
    const res = await fetch(url(server, '/control/health'));
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('control routes reject a wrong token', async () => {
  const server = await startServer();
  try {
    const res = await fetch(url(server, '/control/health'), {
      headers: { 'X-Zalo-Control-Token': 'b'.repeat(64) },
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('control routes accept the correct token', async () => {
  const server = await startServer();
  try {
    const res = await fetch(url(server, '/control/health'), {
      headers: { 'X-Zalo-Control-Token': TOKEN },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  } finally {
    server.close();
  }
});

test('a token of a different length is rejected without throwing', async () => {
  const server = await startServer();
  try {
    const res = await fetch(url(server, '/control/health'), {
      headers: { 'X-Zalo-Control-Token': 'ngan' },
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('sending a message requires a thread id', async () => {
  const server = await startServer();
  try {
    const res = await fetch(url(server, '/control/send'), {
      method: 'POST',
      headers: { 'X-Zalo-Control-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'chào' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

```bash
cd /e/2anh-zalo-bot && node --test control-api.test.js
```

Mong đợi: FAIL — `Cannot find module './control-api.js'`.

- [ ] **Step 3: Viết `control-api.js`**

```javascript
import { timingSafeEqual } from 'node:crypto';

/**
 * Các route điều khiển dành cho tab Zalo trong Hermes Dashboard.
 *
 * Dùng lại ZALO_BRIDGE_TOKEN thay vì sinh token thứ hai: một bí mật, một nơi
 * cấp, một chỗ thu hồi. Hai token cho cùng một sidecar là hai thứ phải giữ
 * đồng bộ, và sớm muộn sẽ lệch.
 *
 * Nghe ở 127.0.0.1 KHÔNG phải là xác thực — mọi tiến trình khác trên máy
 * khách đều gọi được.
 */

const HEADER = 'x-zalo-control-token';

function tokenMatches(supplied, expected) {
  if (typeof supplied !== 'string' || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual ném lỗi khi hai buffer khác độ dài — kiểm trước.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function mountControlApi(app, { token, health, api }) {
  const guard = (req, res, next) => {
    if (!tokenMatches(req.get(HEADER), token)) {
      return res.status(401).json({ error: 'Thiếu hoặc sai token điều khiển' });
    }
    return next();
  };

  app.get('/control/health', guard, (req, res) => {
    res.json(health?.snapshot?.() ?? {});
  });

  app.post('/control/send', guard, async (req, res) => {
    const threadId = String(req.body?.threadId ?? '').trim();
    const text = String(req.body?.text ?? '').trim();
    if (!threadId) return res.status(400).json({ error: 'Thiếu threadId' });
    if (!text) return res.status(400).json({ error: 'Thiếu nội dung tin nhắn' });

    try {
      const result = await api.sendMessage(
        { msg: text }, threadId, Number(req.body?.threadType) === 1 ? 1 : 0,
      );
      res.json({ ok: true, msgId: result?.message?.msgId ?? null });
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error) });
    }
  });
}
```

- [ ] **Step 4: Chạy lại, xác nhận XANH**

```bash
cd /e/2anh-zalo-bot && node --test control-api.test.js
```

Mong đợi: 5 test PASS.

- [ ] **Step 5: Nạp vào `server.js`**

Đọc `server.js` để tìm chỗ `app` đã dựng xong và `api`/`runtimeHealth` đã có, rồi thêm:

```javascript
import { mountControlApi } from './control-api.js';
```

và ở chỗ thích hợp sau khi `api` sẵn sàng:

```javascript
mountControlApi(app, {
  token: process.env.ZALO_BRIDGE_TOKEN,
  health: runtimeHealth,
  api,
});
```

**Cẩn thận:** `api` chỉ có sau khi đăng nhập Zalo. Đọc kỹ luồng trong `server.js` — nếu `api` là biến thay đổi theo thời gian thì truyền một hàm lấy giá trị hiện tại, đừng truyền giá trị lúc khởi động.

- [ ] **Step 6: Chạy toàn bộ test**

```bash
cd /e/2anh-zalo-bot && npm test 2>&1 | grep -E "^# (tests|pass|fail)|Tổng số test Python"
```

Mong đợi: JS tăng từ 89 lên 94; Python vẫn 43 (không đụng phần Python).

- [ ] **Step 7: Commit**

```bash
cd /e/2anh-zalo-bot
git add control-api.js control-api.test.js server.js
git commit -m "feat(sidecar): route /control/* cho dashboard, dùng lại token cầu nối

Dashboard cần hai thứ sidecar mới biết: sức khoẻ runtime và khả năng gửi
tin. Cả hai đòi ZALO_BRIDGE_TOKEN — nghe ở 127.0.0.1 không phải là xác
thực, mọi tiến trình khác trên máy khách đều gọi được.

Dùng lại token cầu nối thay vì sinh token thứ hai: một bí mật, một nơi
cấp, một chỗ thu hồi.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Ghi cấu hình — hai nhóm, hai cách

**Files:**
- Modify: `hermes-dashboard-plugin/plugin_api.py`
- Modify: `hermes-dashboard-plugin/test_plugin_api.py`

**Interfaces:**
- Consumes: `read_zalo_env()`, `hermes_home()` từ Task 3
- Produces: `write_permission_env(home, updates)`, `read_tuning(home)`, `write_tuning(home, updates)`

**Nguyên tắc từ spec, không được trộn:**

- Cấu hình **phân quyền** (`ZALO_ALLOWED_USERS`, `ZALO_DM_POLICY`, `ZALO_ALLOW_ALL_USERS`, `ZALO_GROUP_REPLY_ONLY_TAGGED`) → ghi `.env` của Hermes, trả `pending_restart: true`.
- Cấu hình **tinh chỉnh** (ngưỡng rate-limit, flood, `ZALO_KB_DIR`) → ghi `<hermes>/zalo/settings.json`, có hiệu lực ngay.

Việc phải khởi động lại khi đổi chủ nhân là **tính năng**, không phải hạn chế: nó buộc thay đổi quyền phải có chủ đích và nhìn thấy được.

- [ ] **Step 1: Viết test trước**

```python
PERMISSION_KEYS = {
    "ZALO_ALLOWED_USERS", "ZALO_DM_POLICY",
    "ZALO_ALLOW_ALL_USERS", "ZALO_GROUP_REPLY_ONLY_TAGGED",
}


class ConfigWriteTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = Path(self.dir.name)
        (self.home / ".env").write_text(
            "# ghi chú của khách\n"
            "EXA_API_KEY=giu-nguyen\n"
            "ZALO_ALLOWED_USERS=cu\n",
            encoding="utf-8",
        )
        self.api = load_plugin_api()

    def test_updates_only_the_requested_key(self):
        self.api.write_permission_env(self.home, {"ZALO_ALLOWED_USERS": "moi"})
        text = (self.home / ".env").read_text(encoding="utf-8")
        self.assertIn("ZALO_ALLOWED_USERS=moi", text)
        self.assertIn("EXA_API_KEY=giu-nguyen", text)
        self.assertIn("# ghi chú của khách", text)

    def test_appends_a_key_that_did_not_exist(self):
        self.api.write_permission_env(self.home, {"ZALO_DM_POLICY": "open"})
        self.assertIn("ZALO_DM_POLICY=open",
                      (self.home / ".env").read_text(encoding="utf-8"))

    def test_keeps_a_backup_of_the_previous_env(self):
        self.api.write_permission_env(self.home, {"ZALO_ALLOWED_USERS": "moi"})
        backup = self.home / ".env.bak"
        self.assertTrue(backup.is_file())
        self.assertIn("ZALO_ALLOWED_USERS=cu", backup.read_text(encoding="utf-8"))

    def test_refuses_to_write_a_key_outside_the_permission_group(self):
        with self.assertRaises(ValueError):
            self.api.write_permission_env(self.home, {"EXA_API_KEY": "cuop"})

    def test_tuning_round_trips_through_settings_json(self):
        self.api.write_tuning(self.home, {"ZALO_FLOOD_THRESHOLD": 9})
        self.assertEqual(self.api.read_tuning(self.home)["ZALO_FLOOD_THRESHOLD"], 9)

    def test_tuning_never_touches_the_env_file(self):
        before = (self.home / ".env").read_text(encoding="utf-8")
        self.api.write_tuning(self.home, {"ZALO_KB_DIR": "D:/tai-lieu"})
        self.assertEqual((self.home / ".env").read_text(encoding="utf-8"), before)
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

```bash
cd /e/2anh-zalo-bot
/e/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest discover -s hermes-dashboard-plugin -p "test_*.py" -v
```

Mong đợi: 6 test mới FAIL.

- [ ] **Step 3: Viết các hàm ghi cấu hình**

```python
import json
import tempfile

# Bốn khoá này quyết định AI ĐƯỢC DÙNG BOT. Chúng chỉ có một nguồn sự thật là
# .env của Hermes, và đổi chúng thì phải khởi động lại gateway. Đó là tính
# năng, không phải hạn chế: buộc thay đổi quyền phải có chủ đích.
PERMISSION_KEYS = frozenset({
    "ZALO_ALLOWED_USERS",
    "ZALO_DM_POLICY",
    "ZALO_ALLOW_ALL_USERS",
    "ZALO_GROUP_REPLY_ONLY_TAGGED",
})


def write_permission_env(home: Path, updates: dict) -> dict:
    """Ghi các khoá phân quyền vào .env của Hermes.

    Sửa đúng dòng cần sửa, giữ nguyên phần còn lại của tệp (kể cả chú thích
    và các khoá bí mật), ghi qua tệp tạm rồi đổi tên nguyên tử.
    """
    lạ = set(updates) - PERMISSION_KEYS
    if lạ:
        raise ValueError(f"Khoá không thuộc nhóm phân quyền: {sorted(lạ)}")

    path = Path(home) / ".env"
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []

    remaining = dict(updates)
    output: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line else ""
        if key in remaining:
            output.append(f"{key}={remaining.pop(key)}")
        else:
            output.append(line)
    for key, value in remaining.items():
        output.append(f"{key}={value}")

    if path.is_file():
        (Path(home) / ".env.bak").write_text(
            path.read_text(encoding="utf-8"), encoding="utf-8")

    _atomic_write(path, "\n".join(output) + "\n")
    return {"pending_restart": True}


def _atomic_write(path: Path, text: str) -> None:
    """Ghi qua tệp tạm rồi đổi tên — không để lại tệp nửa vời khi mất điện."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _tuning_path(home: Path) -> Path:
    return Path(home) / "zalo" / "settings.json"


def read_tuning(home: Path) -> dict:
    """Cấu hình tinh chỉnh — adapter đọc nóng, không cần khởi động lại."""
    path = _tuning_path(home)
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def write_tuning(home: Path, updates: dict) -> dict:
    """Ghi cấu hình tinh chỉnh. Không bao giờ đụng .env."""
    path = _tuning_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    merged = {**read_tuning(home), **updates}
    _atomic_write(path, json.dumps(merged, ensure_ascii=False, indent=2))
    return {"pending_restart": False}
```

- [ ] **Step 4: Chạy lại, xác nhận XANH**

```bash
cd /e/2anh-zalo-bot
/e/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest discover -s hermes-dashboard-plugin -p "test_*.py" -v
```

Mong đợi: 19 test PASS — tổng Python 55.

- [ ] **Step 5: Commit**

```bash
cd /e/2anh-zalo-bot
find . -name __pycache__ -type d -not -path "./node_modules/*" -exec rm -rf {} + 2>/dev/null
git add hermes-dashboard-plugin
git commit -m "feat(dashboard): ghi cấu hình — phân quyền vào .env, tinh chỉnh vào settings.json

Hai nhóm, hai cách, không trộn. Bốn khoá phân quyền chỉ có một nguồn sự
thật là .env của Hermes và đổi chúng thì phải khởi động lại gateway —
đó là tính năng, buộc thay đổi quyền phải có chủ đích và nhìn thấy được.

write_permission_env từ chối mọi khoá ngoài nhóm phân quyền, nên không có
đường nào ghi đè EXA_API_KEY qua giao diện. Ghi nguyên tử qua tệp tạm và
giữ .env.bak.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Nối route HTTP vào `plugin_api.py`

**Files:**
- Modify: `hermes-dashboard-plugin/plugin_api.py`
- Modify: `hermes-dashboard-plugin/test_plugin_api.py`

**Interfaces:**
- Consumes: mọi hàm từ Task 2, 3, 5
- Produces: các route HTTP theo bảng §7.1 của spec

Đến đây các hàm đã có và đã test. Task này chỉ nối chúng vào `router` — phần mỏng nhất, nhưng là chỗ dễ để lọt lỗi phân trang và lọc.

- [ ] **Step 1: Viết test cho lớp route**

```python
class RouteContractTest(unittest.TestCase):
    """Các route phải tồn tại với đúng đường dẫn và phương thức."""

    def setUp(self):
        self.api = load_plugin_api()

    def test_registers_every_documented_route(self):
        paths = {(r.path, tuple(sorted(r.methods))) for r in self.api.router.routes}
        expected = {
            ("/ping", ("GET",)),
            ("/status", ("GET",)),
            ("/setup-check", ("GET",)),
            ("/threads", ("GET",)),
            ("/threads/{thread_id}/messages", ("GET",)),
            ("/search", ("GET",)),
            ("/audit", ("GET",)),
            ("/config", ("GET",)),
            ("/config/permissions", ("PUT",)),
            ("/config/tuning", ("PUT",)),
        }
        missing = expected - paths
        self.assertEqual(missing, set(), f"Thiếu route: {missing}")
```

**Lưu ý:** test này cần `fastapi` thật để `router.routes` có nội dung. Nếu môi trường không có `fastapi`, dùng `unittest.skipUnless` để bỏ qua êm:

```python
try:
    import fastapi  # noqa: F401
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False

@unittest.skipUnless(HAS_FASTAPI, "cần fastapi để kiểm bảng route")
class RouteContractTest(unittest.TestCase):
    ...
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ hoặc SKIP**

```bash
cd /e/2anh-zalo-bot
/e/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest discover -s hermes-dashboard-plugin -p "test_*.py" -v
```

Nếu có `fastapi`: FAIL vì thiếu route. Nếu không: SKIP — ghi rõ trong báo cáo.

- [ ] **Step 3: Viết các route**

```python
from typing import Optional


def _db_path() -> Path:
    """Đường dẫn tới kho SQLite của sidecar."""
    return resolve_sidecar_dir() / "data" / "zalo.sqlite"


@router.get("/status")
def status() -> dict:
    home = hermes_home()
    db = _db_path()
    return {
        "sidecar_dir": str(resolve_sidecar_dir()),
        "store_exists": db.is_file(),
        "problems": setup_problems(home),
    }


@router.get("/setup-check")
def setup_check() -> dict:
    return {"problems": setup_problems(hermes_home())}


@router.get("/threads")
def threads(limit: int = 100) -> dict:
    return {"threads": list_threads(_db_path(), limit=min(max(limit, 1), 200))}


@router.get("/threads/{thread_id}/messages")
def messages(thread_id: str, before: Optional[int] = None, limit: int = 50) -> dict:
    return {"messages": thread_messages(
        _db_path(), thread_id, before=before, limit=min(max(limit, 1), 200))}


@router.get("/search")
def search(q: str = "", limit: int = 50) -> dict:
    return {"messages": search_messages(_db_path(), q, limit=min(max(limit, 1), 200))}


@router.get("/audit")
def audit(status: Optional[str] = None, limit: int = 100) -> dict:
    return {"entries": audit_entries(
        _db_path(), status=status, limit=min(max(limit, 1), 500))}


@router.get("/config")
def config() -> dict:
    home = hermes_home()
    env = read_zalo_env(home)
    return {
        "permissions": {k: v for k, v in env.items() if k in PERMISSION_KEYS},
        "tuning": read_tuning(home),
    }


@router.put("/config/permissions")
def update_permissions(payload: dict) -> dict:
    return write_permission_env(hermes_home(), payload or {})


@router.put("/config/tuning")
def update_tuning(payload: dict) -> dict:
    return write_tuning(hermes_home(), payload or {})
```

Thêm `resolve_sidecar_dir()` nếu Task 3 chưa viết:

```python
def resolve_sidecar_dir() -> Path:
    """Tìm thư mục sidecar.

    Theo thứ tự: ZALO_SIDECAR_DIR trong .env của Hermes → <hermes>/2anh-zalo-bot
    → <hermes>/zca-test. Không thấy thì trả về đường dẫn đoán đầu tiên để
    /status còn báo được là chưa tìm thấy.
    """
    home = hermes_home()
    explicit = read_zalo_env(home).get("ZALO_SIDECAR_DIR", "").strip()
    if explicit:
        return Path(explicit)
    for name in ("2anh-zalo-bot", "zca-test"):
        candidate = home / name
        if (candidate / "server.js").is_file():
            return candidate
    return home / "2anh-zalo-bot"
```

- [ ] **Step 4: Chạy lại, xác nhận XANH**

```bash
cd /e/2anh-zalo-bot
/e/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest discover -s hermes-dashboard-plugin -p "test_*.py" -v
```

Mong đợi: 20 test PASS, hoặc 19 pass + 1 skip nếu thiếu `fastapi` — tổng Python 56.

- [ ] **Step 5: Commit**

```bash
cd /e/2anh-zalo-bot
find . -name __pycache__ -type d -not -path "./node_modules/*" -exec rm -rf {} + 2>/dev/null
git add hermes-dashboard-plugin
git commit -m "feat(dashboard): nối các route HTTP cho tab Zalo

Mười route theo đúng hợp đồng trong spec. Mọi tham số limit đều bị kẹp
trong khoảng an toàn — không route nào trả về toàn bộ bảng, kể cả khi
người gọi truyền limit rất lớn.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Bốn màn hình

**Files:**
- Create: `hermes-dashboard-plugin/src/10-connection.js`
- Create: `hermes-dashboard-plugin/src/20-conversations.js`
- Create: `hermes-dashboard-plugin/src/30-control.js`
- Create: `hermes-dashboard-plugin/src/40-audit.js`
- Modify: `hermes-dashboard-plugin/src/99-register.js`
- Modify: `hermes-dashboard-plugin/dist/style.css`
- Modify: `hermes-dashboard-plugin/dist/index.js` (sinh lại)

**Interfaces:**
- Consumes: `h`, `useState`, `useEffect`, `C`, `api` từ `src/00-sdk.js`
- Produces: `ConnectionScreen`, `ConversationsScreen`, `ControlScreen`, `AuditScreen`

Không có test tự động cho lớp giao diện — spec đã quyết vậy, chi phí quá lớn so với giá trị. Thay bằng checklist kiểm tay ở Task 9.

**Bố cục bắt buộc:** dải trạng thái cố định phía trên (không cuộn mất), 4 tab con bên dưới. Khi phiên Zalo hết hạn, cả dải chuyển nền `--hermes-diag-warning` và mọc nút "Quét mã đăng nhập lại" — hiện ở mọi tab.

**Chữ hiển thị:** tiếng Việt, không có "sidecar"/"bridge"/"WebSocket"/"toolset". Là "Kết nối Zalo" và "Trợ lý".

- [ ] **Step 1: Viết `src/10-connection.js` — màn Kết nối**

Yêu cầu:
- Chưa đăng nhập: thẻ QR to giữa màn, nút "Tạo mã QR".
- Đã đăng nhập: thẻ hồ sơ nhỏ (tên, **không hiện số điện thoại**) + nút Đăng xuất.
- Thẻ Sức khoẻ: nhận tin lần cuối, gửi lần cuối, lỗi gần nhất, chạy được bao lâu.
- Thẻ "Việc cần làm" **chỉ hiện khi `problems` không rỗng** — mỗi vấn đề hiện `message` và `fix`.
- Poll `/status` mỗi 3 giây; khi đang chờ quét QR thì 1 giây.

- [ ] **Step 2: Viết `src/20-conversations.js` — màn Hội thoại**

Yêu cầu:
- Trái: danh sách hội thoại từ `/threads` (tên, số tin, lần cuối).
- Phải: khung tin nhắn từ `/threads/{id}/messages`, cuộn được, tin của bot canh phải và khác màu.
- Ô tìm kiếm gọi `/search`.
- Nút "Xem thêm" lật trang bằng `before` = `timestamp_ms` của tin cũ nhất đang hiện.

- [ ] **Step 3: Viết `src/30-control.js` — màn Điều khiển**

Bốn khối, và **đây là chỗ dễ sai nhất — hai nhóm phải hành xử khác nhau**:

| Khối | Gọi route | Sau khi lưu |
|---|---|---|
| Ai được sai bảo bot | `PUT /config/permissions` | Hiện banner vàng dính "Thay đổi chưa có hiệu lực" + nút "Khởi động lại trợ lý" |
| Nhịp gửi & chống dồn dập | `PUT /config/tuning` | Hiện "Đã lưu" thoáng qua, không banner |
| Sổ người quen | `PUT /config/tuning` | Như trên |
| Kho tài liệu tư vấn | `PUT /config/tuning` | Như trên |

Nút "Khởi động lại trợ lý" gọi `POST /api/gateway/restart` của host (không qua plugin) bằng `SDK.authedFetch`.

- [ ] **Step 4: Viết `src/40-audit.js` — màn Nhật ký**

Yêu cầu:
- Bảng từ `/audit`: lúc nào · ai (tên + vai trò) · làm gì · ở đâu · kết quả.
- Nút lọc nhanh "Chỉ xem cái hỏng" → gọi `/audit?status=failed`.
- Dòng hỏng tô màu `--hermes-diag-error`.

- [ ] **Step 5: Viết lại `src/99-register.js` — dải trạng thái + 4 tab**

```javascript
function ZaloPage() {
  const [tab, setTab] = useState('connection');
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = () => api('/status').then((s) => alive && setStatus(s)).catch(() => {});
    tick();
    const timer = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const tabs = [
    ['connection', 'Kết nối', ConnectionScreen],
    ['conversations', 'Hội thoại', ConversationsScreen],
    ['control', 'Điều khiển', ControlScreen],
    ['audit', 'Nhật ký', AuditScreen],
  ];
  const Screen = (tabs.find((t) => t[0] === tab) || tabs[0])[2];

  return h('div', { className: 'zalo-page' },
    h(StatusBar, { status }),
    h('nav', { className: 'zalo-tabs' }, tabs.map(([key, label]) =>
      h('button', {
        key,
        className: `zalo-tab${key === tab ? ' zalo-tab-active' : ''}`,
        onClick: () => setTab(key),
      }, label))),
    h('div', { className: 'zalo-screen' }, h(Screen, { status })),
  );
}

window.__HERMES_PLUGINS__.register('zalo', ZaloPage);
```

Viết thêm `StatusBar` trong cùng tệp: hiện trạng thái Zalo, trạng thái trợ lý, số tin hôm nay. Khi `status.zalo !== 'logged-in'` thì đổi nền sang `--hermes-diag-warning` và hiện nút "Quét mã đăng nhập lại".

- [ ] **Step 6: Bổ sung CSS**

Thêm vào `dist/style.css`: `.zalo-tabs`, `.zalo-tab`, `.zalo-tab-active`, `.zalo-statusbar`, `.zalo-statusbar-warning`, `.zalo-screen`, `.zalo-thread-list`, `.zalo-message`, `.zalo-message-self`, `.zalo-audit-failed`.

Chỉ dùng design token của host: `--color-card`, `--color-border`, `--color-foreground`, `--color-muted-foreground`, `--color-primary`, `--radius`, `--hermes-diag-error`, `--hermes-diag-warning`.

- [ ] **Step 7: Sinh lại `dist` và kiểm cú pháp**

```bash
cd /e/2anh-zalo-bot/hermes-dashboard-plugin
node build.js && node --check dist/index.js && echo "CU PHAP OK"
```

- [ ] **Step 8: Chạy toàn bộ test**

```bash
cd /e/2anh-zalo-bot && npm test 2>&1 | grep -E "^# (tests|pass|fail)|Tổng số test Python"
```

Mong đợi: không giảm so với Task 6.

- [ ] **Step 9: Commit**

```bash
cd /e/2anh-zalo-bot
git add hermes-dashboard-plugin
git commit -m "feat(dashboard): bốn màn Kết nối, Hội thoại, Điều khiển, Nhật ký

Dải trạng thái dính phía trên vì việc khách làm 95% thời gian chỉ là xem
bot còn sống không và quét lại QR — hai thứ đó không được nằm sau một cú
click. Phiên hết hạn thì cả dải đổi màu và mọc nút quét lại ở mọi tab.

Màn Điều khiển tách rõ hai nhóm: đổi quyền thì hiện banner đòi khởi động
lại, đổi ngưỡng thì ăn ngay. Gạt nút nào chạy đúng logic nấy.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Cắm vào trình cài, doctor và uninstall

**Files:**
- Modify: `scripts/hermes-install-lib.js`
- Modify: `scripts/hermes-install-lib.test.js`

**Interfaces:**
- Consumes: `installHermes()`, `doctorHermes()`, `uninstallHermes()` có sẵn
- Produces: không có

**Đường dẫn đích:** `<hermes-home>/plugins/zalo/dashboard/`

Đây là đường host thật sự quét — `_discover_dashboard_plugins()` trong `hermes_cli/web_server.py:18635` tìm `<plugins_root>/<tên>/dashboard/manifest.json`, với `plugins_root` là `~/.hermes/plugins`. **Không có thư mục nào tên `dashboard-plugins`** — spec bản đầu ghi sai, đã sửa.

- [ ] **Step 1: Viết test trước**

Đọc `scripts/hermes-install-lib.test.js` xem nó dựng fixture thế nào, rồi thêm test theo đúng khuôn đó:

```javascript
test('install copies the dashboard plugin where Hermes looks for it', (t) => {
  const fx = fixture(t);            // dùng helper sẵn có trong tệp
  installHermes({ hermesHome: fx.home, sidecarRoot: fx.sidecar, skipPython: true });
  const manifest = join(fx.home, 'plugins', 'zalo', 'dashboard', 'manifest.json');
  assert.ok(existsSync(manifest), 'manifest.json phải nằm ở plugins/zalo/dashboard/');
  assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).name, 'zalo');
});

test('doctor reports the dashboard plugin as missing before install', (t) => {
  const fx = fixture(t);
  const result = doctorHermes({ hermesHome: fx.home, sidecarRoot: fx.sidecar, skipPython: true });
  const check = result.checks.find((c) => c.name === 'dashboard-plugin');
  assert.ok(check, 'doctor phải có mục kiểm dashboard-plugin');
  assert.equal(check.ok, false);
});

test('uninstall removes the dashboard plugin directory', (t) => {
  const fx = fixture(t);
  installHermes({ hermesHome: fx.home, sidecarRoot: fx.sidecar, skipPython: true });
  uninstallHermes({ hermesHome: fx.home });
  assert.ok(!existsSync(join(fx.home, 'plugins', 'zalo')),
    'gỡ cài đặt phải xoá thư mục plugin dashboard');
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

```bash
cd /e/2anh-zalo-bot && node --test scripts/hermes-install-lib.test.js
```

Mong đợi: 3 test mới FAIL.

- [ ] **Step 3: Sửa `hermes-install-lib.js`**

Ba chỗ, đọc mã hiện có rồi thêm cho khớp phong cách:

1. Trong `installHermes()`: chép `hermes-dashboard-plugin/` → `<home>/plugins/zalo/dashboard/`. Dùng đúng cơ chế staging + đổi tên nguyên tử mà hàm này đang dùng cho hai plugin kia.
2. Trong `doctorHermes()`: thêm mục `dashboard-plugin` — kiểm `<home>/plugins/zalo/dashboard/manifest.json` tồn tại và đọc được.
3. Trong `uninstallHermes()`: xoá `<home>/plugins/zalo/`.

- [ ] **Step 4: Chạy lại, xác nhận XANH**

```bash
cd /e/2anh-zalo-bot && node --test scripts/hermes-install-lib.test.js
```

Mong đợi: toàn bộ PASS, kể cả các test cũ.

- [ ] **Step 5: Chạy toàn bộ test**

```bash
cd /e/2anh-zalo-bot && npm test 2>&1 | grep -E "^# (tests|pass|fail)|Tổng số test Python"
```

Mong đợi: JS tăng từ 94 lên 97; Python vẫn 43.

- [ ] **Step 6: Kiểm tay trên Hermes giả**

**Không chạy lên `E:\Hermes` thật.** Dựng thư mục tạm:

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/h/hermes-agent/plugins/platforms" "$TMP/h/hermes-agent/gateway"
echo 'customer: giu nguyen' > "$TMP/h/config.yaml"
printf '[project]\nname="hermes-agent"\n' > "$TMP/h/hermes-agent/pyproject.toml"
cd /e/2anh-zalo-bot
node scripts/install-hermes.js --hermes-home "$TMP/h" --skip-python 2>&1 | tail -12
echo "=== plugin dashboard da chep chua ==="
ls "$TMP/h/plugins/zalo/dashboard/"
echo "=== doctor ==="
node scripts/doctor.js --hermes-home "$TMP/h" --skip-python 2>&1 | grep dashboard
rm -rf "$TMP"
```

Mong đợi: thấy `manifest.json`, `plugin_api.py`, `dist/`; doctor báo `[PASS] dashboard-plugin`.

- [ ] **Step 7: Commit**

```bash
cd /e/2anh-zalo-bot
git add scripts/hermes-install-lib.js scripts/hermes-install-lib.test.js
git commit -m "feat(install): cài, kiểm và gỡ plugin dashboard Zalo

Chép sang <hermes-home>/plugins/zalo/dashboard/ — đúng chỗ
_discover_dashboard_plugins() của Hermes quét. Spec bản đầu ghi
'dashboard-plugins/zalo' là sai, không có thư mục nào tên vậy.

doctor thêm một mục kiểm, uninstall gỡ luôn thư mục này.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Kiểm tay đầu-cuối và tài liệu

**Files:**
- Modify: `README.md`
- Modify: `README.vi.md`
- Create: `hermes-dashboard-plugin/KIEM-TAY.md`

**Interfaces:**
- Consumes: mọi thứ từ Task 1–8
- Produces: không có

- [ ] **Step 1: Viết checklist kiểm tay**

Tạo `hermes-dashboard-plugin/KIEM-TAY.md` — danh sách việc phải tự bấm, vì lớp giao diện không có test tự động:

```markdown
# Kiểm tay tab Zalo

Chạy sau mỗi lần sửa giao diện. Mỗi mục phải tự bấm và nhìn thấy kết quả.

## Chuẩn bị
- [ ] `npm run install:hermes -- --hermes-home <hermes>` chạy sạch
- [ ] `npm run doctor -- --hermes-home <hermes>` báo `[PASS] dashboard-plugin`
- [ ] Mở Hermes Dashboard, thấy tab **Zalo** trong thanh bên

## Màn Kết nối
- [ ] Chưa đăng nhập: hiện thẻ QR, bấm "Tạo mã QR" thì QR hiện ra
- [ ] Đã đăng nhập: hiện tên tài khoản, **không hiện số điện thoại**
- [ ] Thẻ Sức khoẻ hiện thời điểm nhận/gửi tin gần nhất
- [ ] Tắt sidecar → dải trạng thái đổi màu, nút "Quét mã đăng nhập lại" hiện ra
- [ ] Xoá `ZALO_ALLOWED_USERS` trong `.env` → thẻ "Việc cần làm" hiện cảnh báo

## Màn Hội thoại
- [ ] Danh sách hội thoại hiện đúng, mới nhất lên đầu
- [ ] Bấm một hội thoại → tin nhắn hiện ra, tin của bot canh phải
- [ ] Gõ vào ô tìm kiếm → kết quả lọc đúng
- [ ] Gõ ký tự `%` vào ô tìm kiếm → không trả về toàn bộ tin nhắn
- [ ] Bấm "Xem thêm" → tin cũ hơn được nạp thêm

## Màn Điều khiển
- [ ] Đổi UID chủ nhân → hiện banner vàng "Thay đổi chưa có hiệu lực"
- [ ] Bấm "Khởi động lại trợ lý" → gateway khởi động lại, banner biến mất
- [ ] Đổi ngưỡng chống dồn dập → hiện "Đã lưu", **không** có banner
- [ ] Mở `<hermes>/.env` → thấy UID mới, các khoá khác nguyên vẹn
- [ ] Mở `<hermes>/zalo/settings.json` → thấy ngưỡng mới

## Màn Nhật ký
- [ ] Bảng hiện thao tác gần nhất
- [ ] Bấm "Chỉ xem cái hỏng" → chỉ còn dòng trạng thái hỏng

## Giao diện
- [ ] Đổi Hermes sang giao diện tối → tab Zalo đổi theo, chữ vẫn đọc được
- [ ] Thu hẹp cửa sổ → không có thanh cuộn ngang
```

- [ ] **Step 2: Chạy hết checklist trên Hermes thật**

Đây là lần duy nhất trong kế hoạch được cài lên `E:\Hermes` thật — vì phải xem tab hiện ra đúng không. Trước khi chạy, **hỏi chủ nhân một câu xác nhận**.

Ghi lại mục nào không đạt. Nếu có mục hỏng, sửa rồi chạy lại từ đầu mục đó.

- [ ] **Step 3: Thêm mục vào README**

`README.vi.md` — thêm mục sau phần "Cài đặt":

```markdown
## Tab Zalo trong Hermes Dashboard

Sau khi cài, Hermes Dashboard có thêm tab **Zalo** với bốn màn:

| Màn | Làm được gì |
|---|---|
| Kết nối | Xem bot còn sống không, quét lại QR khi phiên hết hạn, xem lỗi gần nhất |
| Hội thoại | Đọc lại lịch sử, tìm kiếm toàn văn |
| Điều khiển | Đổi ai được sai bảo bot, chỉnh nhịp gửi, sổ người quen, kho tài liệu |
| Nhật ký | Ai đã sai bảo bot làm gì, thành công hay hỏng |

Đổi cấu hình phân quyền thì cần khởi động lại trợ lý — dashboard hiện banner
nhắc và có sẵn nút bấm. Đổi các ngưỡng khác thì có hiệu lực ngay.

Trang `127.0.0.1:3872` vẫn giữ, dùng khi Hermes Dashboard chưa chạy.
```

`README.md` — viết mục tương đương bằng tiếng Anh.

- [ ] **Step 4: Chạy toàn bộ test lần cuối**

```bash
cd /e/2anh-zalo-bot && npm test 2>&1 | grep -E "^# (tests|pass|fail)|Tổng số test Python"
node --check hermes-dashboard-plugin/dist/index.js
git status --short
```

- [ ] **Step 5: Commit**

```bash
cd /e/2anh-zalo-bot
git add README.md README.vi.md hermes-dashboard-plugin/KIEM-TAY.md
git commit -m "docs: tài liệu tab Zalo và checklist kiểm tay

Lớp giao diện không có test tự động — chi phí quá lớn so với giá trị. Thay
bằng checklist tự bấm, chạy sau mỗi lần sửa giao diện.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Sau kế hoạch này

Tab Zalo hoạt động đầy đủ trong Hermes Dashboard. Khách tự vận hành được: xem sức khoẻ, quét lại QR, đọc lịch sử, sửa cấu hình, xem nhật ký — không phải mở `.env` bằng Notepad.

Việc còn để ngỏ, **cố ý không làm trong lần này** (theo §2 của spec):

- Thống kê nâng cao (số tin theo ngày, ước lượng chi phí model)
- Cập nhật thời gian thực bằng WebSocket — poll đã đủ
- Test tự động cho lớp giao diện
