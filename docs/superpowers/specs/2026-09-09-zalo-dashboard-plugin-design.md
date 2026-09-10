# Dashboard quản trị Zalo — plugin trong Hermes Dashboard

**Ngày:** 2026-09-09 · **Cập nhật:** 2026-09-10
**Trạng thái:** Thiết kế đã duyệt, điều kiện tiên quyết đã xong, sẵn sàng lập kế hoạch
**Dự án:** 2anh-zalo-bot

> **Cập nhật 2026-09-10 — bốn giả định đã đổi.** Spec viết trước khi hợp nhất hai
> nhánh phát triển song song. Kiến trúc nền đã khác ở bốn chỗ; các mục liên quan
> đã được sửa tại chỗ và đánh dấu 🔄. Tóm tắt:
>
> 1. **Token cầu nối đã tồn tại.** Không cần viết `control-token.js` mới. Trình
>    cài `scripts/hermes-install-lib.js` đã sinh `ZALO_BRIDGE_TOKEN` ngẫu nhiên
>    (`ensureSidecarEnv`), ghi vào `.env` của sidecar và `config.yaml` của Hermes.
>    `hermes-bridge.js:306-308` bắt buộc phải có token mới khởi động được.
> 2. **Trình cài đã đổi.** Không còn `npm run setup` chép tay; nay là
>    `npm run install:hermes` với `install-hermes.js` + `hermes-install-lib.js`,
>    có `doctor` và `uninstall`. Việc chép plugin dashboard phải cắm vào bộ này.
> 3. **`server.js` đã có CSRF và xác thực WebSocket.** Route `/control/*` mới
>    phải đi theo khuôn đó, không dựng cơ chế riêng.
> 4. **Đã có `paths.js` và `scripts/setup-env.js`.** Việc dò thư mục Hermes và
>    nạp `.env` dùng lại, không viết trùng.

---

## 1. Mục tiêu

Đưa toàn bộ việc quản trị Zalo vào một tab trong Hermes Dashboard, để khách hàng
tự vận hành được mà không cần gọi cho người cài đặt.

Ba việc khách phải tự làm được:

1. Biết bot còn sống hay không, và hỏng ở đâu nếu hỏng.
2. Quét lại mã QR khi phiên Zalo hết hạn — đây là sự cố thường gặp nhất.
3. Sửa cấu hình thường dùng (ai được sai bảo bot, nhịp gửi, kho tài liệu)
   mà không phải mở tệp `.env` bằng Notepad.

## 2. Phi mục tiêu

Cố ý **không** làm, để giữ phạm vi:

- Không dựng WebSocket cho cập nhật thời gian thực. Poll là đủ.
- Không làm trang phân tích/thống kê nâng cao (số tin theo ngày, ước lượng chi
  phí model). Có thể thêm sau, không thuộc lần này.
- Không viết test tự động cho lớp giao diện JS.
- Không thay thế trang `127.0.0.1:3872`. Nó rút gọn còn màn cứu hộ.
- Không thêm bundler, không thêm dependency npm cho phần dashboard.

## 3. Điều kiện tiên quyết — ✅ ĐÃ XONG (2026-09-10)

Spec ban đầu ghi: các mô-đun `zalo-store.js`, `runtime-health.js`,
`legacy-history-import.js`, `zalo-policy.js` chỉ tồn tại ở bản production, phải
đồng bộ về repo trước.

**Việc đó đã hoàn tất.** Repo hiện có đủ:

| Cần | Trạng thái |
|---|---|
| `zalo-store.js` — SQLite `messages`/`audit_log`/`backfill_state` | ✅ |
| `runtime-health.js` | ✅ |
| `legacy-history-import.js`, `zalo-policy.js` | ✅ |
| Token xác thực cầu nối | ✅ `ZALO_BRIDGE_TOKEN`, sinh lúc cài |
| Trình cài có `doctor` + `uninstall` | ✅ |
| Bộ test | ✅ 89 JS + 36 Python |

Không còn vật cản nào để bắt đầu plugin này.

## 4. Quyết định đã chốt

| # | Quyết định | Lý do |
|---|---|---|
| 1 | Phạm vi: Vận hành + Quan sát + Điều khiển | Khách tự vận hành được mà không cần hỗ trợ |
| 2 | Hermes là giao diện chính; `:3872` rút gọn còn màn QR cứu hộ | Hermes Dashboard hỏng thì vẫn còn đường đăng nhập lại Zalo |
| 3 | Cấu hình tách đôi theo mức rủi ro | Xem §7 |
| 4 | Kiến trúc: đọc SQLite trực tiếp + gọi sidecar cho hành động | Theo đúng khuôn `plugins/kanban`; sidecar tắt vẫn xem được lịch sử |

### Quyết định 3 nói rõ

Cấu hình **phân quyền** (`ZALO_ALLOWED_USERS`, `ZALO_DM_POLICY`,
`ZALO_ALLOW_ALL_USERS`, `ZALO_GROUP_REPLY_ONLY_TAGGED`) chỉ có **một** nguồn sự
thật là `.env` của Hermes. Dashboard ghi vào đó rồi yêu cầu khởi động lại gateway.

Cấu hình **tinh chỉnh** (ngưỡng rate-limit, ngưỡng flood, `ZALO_KB_DIR`, sổ người
quen) ghi vào `<hermes>/zalo/settings.json`, adapter đọc nóng, có hiệu lực ngay.

Không trộn hai nhóm. Lý do nằm trong lịch sử chính dự án này: bộ não Node cũ bị
gỡ bỏ vì nó có một bộ luật phân quyền thứ hai, lỏng hơn, chạy đúng lúc không ai
để ý. Thêm một nguồn sự thật nóng cho quyền là lặp lại đúng lỗi đó. Việc phải
khởi động lại khi đổi chủ nhân là **tính năng**, không phải hạn chế: nó buộc
thay đổi quyền phải có chủ đích và nhìn thấy được.

## 5. Kiến trúc

### 5.1 Ba đường dữ liệu

| Cần gì | Đường đi | Vì sao |
|---|---|---|
| Lịch sử, nhật ký, danh sách hội thoại | `plugin_api.py` mở `<sidecar>/data/zalo.sqlite` chế độ `mode=ro` | Dữ liệu đã đóng băng. Sidecar tắt vẫn đọc được. |
| Trạng thái sống, QR, đăng xuất, gửi tin | HTTP → `127.0.0.1:3872`, kèm control-token | Chỉ sidecar biết phiên Zalo còn sống không |
| Cấu hình | Đọc/ghi `.env` Hermes + `<hermes>/zalo/settings.json` | Theo quyết định 3 |
| Kiểm tra cài đặt ("Việc cần làm") | Đọc `<hermes>/config.yaml`, chỉ đọc | Cần biết `known_plugin_toolsets.zalo` đã khai chưa |
| Khởi động lại gateway | `POST /api/gateway/restart` của chính host | Đã tồn tại; host dùng đúng khuôn này sau khi cài Telegram/WhatsApp |

Thư mục Hermes lấy bằng `get_hermes_home()` của `hermes_constants` — cùng cách
`plugins/hermes-achievements/dashboard/plugin_api.py` đang làm, kèm bản dự phòng
đọc `HERMES_HOME` khi import thất bại.

Hermes Dashboard và gateway là **hai tiến trình riêng**, chia sẻ trạng thái qua
tệp. Đây là khuôn mẫu của nhà — `plugins/kanban/dashboard/plugin_api.py` đọc
SQLite trực tiếp chứ không nói chuyện với gateway.

### 5.2 Tìm thư mục sidecar

Theo thứ tự: biến `ZALO_SIDECAR_DIR` trong `.env` của Hermes → `<hermes>/zca-test`
→ `<hermes>/2anh-zalo-bot`. Không thấy thì tab hiển thị đúng một câu hướng dẫn
đặt biến đó, không đổ lỗi mơ hồ.

### 5.3 Nhịp cập nhật

Poll, không WebSocket:

- 3 giây — dải trạng thái (mọi màn)
- 1 giây — khi đang chờ quét QR
- Theo yêu cầu — lịch sử, nhật ký, cấu hình

Kanban dùng WebSocket vì có kéo-thả nhiều người đồng thời. Ở đây không có nhu cầu
đó; thêm WS là phức tạp không đổi lấy gì.

## 6. Phân rã tệp

### 6.1 Thêm vào repo

```
hermes-dashboard-plugin/
  manifest.json          tab "Zalo", icon MessageCircle, position after:skills
  plugin_api.py          FastAPI router, mục tiêu dưới 500 dòng
  src/
    00-sdk.js            lấy React/hooks/components từ __HERMES_PLUGIN_SDK__
    10-connection.js     màn Kết nối
    20-conversations.js  màn Hội thoại
    30-control.js        màn Điều khiển
    40-audit.js          màn Nhật ký
    99-register.js       __HERMES_PLUGINS__.register("zalo", App)
  dist/index.js          nối chuỗi từ src/, CÓ commit
  dist/style.css
  build.js               nối tệp theo thứ tự tên, khoảng 30 dòng, không bundler
```

Về `dist/`: kanban và achievements đều commit sẵn bản dist, và khách **không phải
build** — đó là ưu điểm lớn nhất của hệ plugin này. Nhưng viết cả 4 màn vào một
tệp khoảng 1200 dòng thì khó sửa, nên tách nguồn ra `src/` và gộp bằng một script
nối chuỗi tầm thường. Commit cả `src/` lẫn `dist/`.

### 6.2 Thêm vào sidecar — 🔄 ĐÃ SỬA

Spec ban đầu định viết `control-token.js` để sinh token riêng. **Không cần nữa** —
token đã có sẵn:

- `scripts/hermes-install-lib.js` hàm `ensureSidecarEnv()` sinh `ZALO_BRIDGE_TOKEN`
  ngẫu nhiên lúc cài, ghi vào `.env` của sidecar và `platforms.zalo.extra.bridge_token`
  trong `config.yaml` của Hermes.
- `hermes-bridge.js:306-308` bắt buộc phải có token mới khởi động được.

Vậy chỉ cần thêm:

```
control-api.js         các route /control/*, dùng lại ZALO_BRIDGE_TOKEN
control-api.test.js
```

Tách khỏi `server.js` có chủ đích: tệp đó đang là nơi mọi thứ đổ về.

**Dùng lại token cầu nối thay vì sinh token thứ hai** — một bí mật, một nơi cấp,
một chỗ thu hồi. Hai token cho cùng một sidecar là hai thứ phải giữ đồng bộ, và
sớm muộn sẽ lệch.

### 6.3 Sửa tệp có sẵn — 🔄 ĐÃ SỬA

- **`scripts/hermes-install-lib.js`** — chép `hermes-dashboard-plugin/` sang
  **`<hermes-home>/plugins/zalo/dashboard/`**. Spec ban đầu ghi `scripts/setup.js`
  và đường dẫn `dashboard-plugins/zalo/` — **cả hai đều sai**:
  - Trình cài đã đổi: nay là `install-hermes.js` + `hermes-install-lib.js`.
  - Đường dẫn thật: `_discover_dashboard_plugins()` trong
    `hermes_cli/web_server.py:18635` quét `<plugins_root>/<tên>/dashboard/manifest.json`,
    với `plugins_root` là `~/.hermes/plugins` (user) hoặc `<repo>/plugins` (bundled).
    Không có thư mục nào tên `dashboard-plugins`.

  Phải cắm vào đúng bộ trình cài này để `doctor` kiểm được và `uninstall` gỡ được.
- **`scripts/doctor.js`** — thêm một mục kiểm: plugin dashboard đã chép chưa.
- **`scripts/uninstall-hermes.js`** — gỡ luôn thư mục plugin dashboard.
- `server.js` — nạp `control-api.js`. Không cần phát token vào HTML trang cứu hộ:
  trang đó dùng ba route công khai sẵn có, không đụng `/control/*`.
- `public/index.html` — giữ nguyên. Nó đã là màn QR gọn, không cần rút thêm.
- `README.md` + `README.vi.md` — thêm mục về tab Zalo trong Hermes Dashboard.

## 7. Hợp đồng API

### 7.1 `plugin_api.py` — mount tại `/api/plugins/zalo/`

Đã nằm sau `dashboard_auth` của host.

| Route | Việc |
|---|---|
| `GET /status` | Hợp nhất: trạng thái Zalo, sidecar sống không, trợ lý cắm chưa, số tin hôm nay, sức khoẻ |
| `GET /setup-check` | Danh sách vấn đề cài đặt cho thẻ "Việc cần làm" |
| `POST /qr/start` · `GET /qr` · `POST /logout` | Chuyển tiếp sang sidecar |
| `GET /threads` | Danh sách hội thoại từ SQLite (tên, số tin, lần cuối) |
| `GET /threads/{id}/messages` | Tin nhắn một hội thoại, phân trang theo `before` |
| `GET /search` | Tìm toàn văn trong `messages.text` |
| `GET /audit` | Bảng `audit_log`, lọc theo `status` |
| `GET /config` | **Chỉ các khoá `ZALO_*`**, tách hai nhóm `needs_restart` / `hot` |
| `PUT /config/permissions` | Ghi `.env`, trả `pending_restart: true` |
| `PUT /config/tuning` | Ghi `settings.json`, có hiệu lực ngay |
| `GET /people` · `DELETE /people/{uid}` | Sổ hồ sơ người quen |
| `POST /send` | Gửi tin tay; chuyển tiếp sang `POST /control/send` |

**Ai ghi `audit_log`:** `plugin_api.py` mở SQLite ở chế độ chỉ đọc nên **không**
ghi được. Bản ghi nhật ký cho tin gửi tay do **sidecar** tạo khi xử lý
`POST /control/send`, với `actor_role = "dashboard"` và `actor_uid` là UID chủ
nhân đang đăng nhập dashboard. Một nơi ghi duy nhất, không có đường vòng.

Nút "Khởi động lại trợ lý" gọi thẳng `POST /api/gateway/restart` của host, không
đi qua plugin.

### 7.2 Sidecar

Ba route hiện có (`GET /api/status`, `POST /api/qr/start`, `POST /api/logout`)
giữ nguyên hành vi để trang cứu hộ dùng được. Trang cứu hộ do chính sidecar phục
vụ nên token được nhúng vào HTML lúc phục vụ — không cần đường vòng nào.

Route mới, **luôn đòi `ZALO_BRIDGE_TOKEN`** (🔄 dùng lại token cầu nối sẵn có,
không sinh token thứ hai):

| Route | Việc |
|---|---|
| `GET /control/health` | Ảnh chụp từ `runtime-health.js` |
| `POST /control/send` | Gửi tin theo lệnh dashboard |
| `POST /control/groups/refresh` | Lấy lại danh sách nhóm từ Zalo |

Thiếu hoặc sai token → `401`. So token bằng `timingSafeEqual` như
`hermes-bridge.js` đang làm, không dùng `===`.

**`plugin_api.py` lấy token ở đâu:** đọc `platforms.zalo.extra.bridge_token`
trong `config.yaml` của Hermes — chỗ trình cài đã ghi sẵn. Không đọc `.env` của
sidecar (dashboard có thể chạy ở máy khác thư mục sidecar).

## 8. Giao diện

### 8.1 Bố cục

Dải trạng thái cố định phía trên, không cuộn mất; 4 tab con bên dưới.

```
┌──────────────────────────────────────────────────────────┐
│ ● Zalo: Đang hoạt động — Lăng Tiêu   ● Trợ lý: đã kết nối │  ← dính
│   Tin hôm nay: 47 · Hoạt động lúc 14:32                   │
├──────────────────────────────────────────────────────────┤
│  Kết nối │ Hội thoại │ Điều khiển │ Nhật ký                │
└──────────────────────────────────────────────────────────┘
```

Lý do không dùng một trang cuộn dài: việc khách làm 95% thời gian chỉ là xem bot
còn sống không và quét lại QR, nên hai thứ đó không được nằm sau một cú click.
Nhưng màn Hội thoại cần cả chiều cao màn hình. Dải dính giải quyết cả hai.

Khi phiên Zalo hết hạn, cả dải chuyển nền `--hermes-diag-warning` và mọc nút
**"Quét mã đăng nhập lại"** — hiện ở mọi tab.

### 8.2 Ngôn ngữ

Tiếng Việt thường, **không lộ thuật ngữ hạ tầng**. Không có "sidecar", "bridge",
"WebSocket", "toolset". Là "Kết nối Zalo" và "Trợ lý". Mọi thông báo lỗi phải
kèm bước tiếp theo cần làm.

### 8.3 Bốn màn

**Kết nối** (mặc định) — Chưa đăng nhập: thẻ QR to giữa màn. Đã đăng nhập: thẻ hồ
sơ nhỏ + nút Đăng xuất, nhường chỗ cho thẻ **Sức khoẻ** (nhận tin lần cuối, gửi
lần cuối, lỗi gần nhất, chạy được bao lâu).

Thẻ **Việc cần làm** chỉ hiện khi có vấn đề thật: chưa khai
`known_plugin_toolsets`, allowlist rỗng, chưa cắm được trợ lý. Ba lỗi cài đặt hay
gặp nhất tự hiện ra kèm cách sửa.

**Hội thoại** — Trái: danh sách nhóm/người. Phải: khung tin nhắn cuộn + ô tìm
kiếm toàn văn. Tin của bot canh phải, khác màu.

**Điều khiển** — bốn khối:

| Khối | Hiệu lực |
|---|---|
| Ai được sai bảo bot | Ghi `.env`; banner vàng dính "Thay đổi chưa có hiệu lực" + nút Khởi động lại |
| Nhịp gửi & chống dồn dập (5 thanh trượt) | `settings.json`, ăn ngay |
| Sổ người quen | Ăn ngay |
| Kho tài liệu tư vấn | Ăn ngay; hiện số tệp đọc được để biết trỏ đúng chưa |

**Nhật ký** — bảng `audit_log`: *lúc nào · ai (tên + vai trò) · làm gì · ở đâu ·
kết quả*. Lọc nhanh "chỉ xem cái hỏng".

### 8.4 Thẩm mỹ

Bám design token của host — `--color-card`, `--color-border`, `--color-foreground`,
`--color-muted-foreground`, `--color-primary`, `--radius`,
`--hermes-diag-critical/error/warning` — để tự khớp sáng/tối và trông như ruột
của Hermes. Dùng `C.Card`, `C.CardContent`, `C.Button` của SDK ở đâu vừa; phần
còn lại tự dựng bằng `React.createElement` + CSS riêng, đúng cách kanban làm.

## 9. Bảo mật

Bốn lớp, mỗi lớp chặn một thứ khác nhau:

1. **`dashboard_auth` của host** — tab đã nằm sau đó, không phải tự dựng.
2. **control-token** cho `/control/*` của sidecar. Nghe `127.0.0.1` không phải là
   xác thực: mọi tiến trình khác trên máy khách đều gọi được. Token sinh ngẫu
   nhiên lúc khởi động, ghi vào `data/control-token` (đã nằm trong `.gitignore`).
3. **SQLite mở `mode=ro`** — dashboard không có đường ghi vào lịch sử.
4. **Lọc khoá khi đọc `.env`** — chỗ nguy hiểm nhất. `.env` của Hermes chứa
   `EXA_API_KEY`, token Facebook, khoá model. `plugin_api.py` **chỉ được trả về
   các khoá `ZALO_*`**, tuyệt đối không trả cả tệp. Lúc ghi: sửa đúng dòng cần
   sửa, ghi qua tệp tạm rồi đổi tên nguyên tử, giữ `.env.bak`.

Thêm hai ràng buộc:

- **Không hiển thị số điện thoại, cookie hay IMEI** ở bất kỳ đâu trong giao diện.
- **Gửi tin tay từ dashboard được ghi vào `audit_log`** với vai trò riêng. Một
  tin gửi từ giao diện phải để lại dấu vết y như tin agent tự gửi.

## 10. Kiểm thử

**Python** (`pytest`, theo khuôn `tests/plugins/test_kanban_dashboard_plugin.py`):

- Đọc được `messages` và `audit_log` từ SQLite
- `GET /config` **không rò khoá ngoài `ZALO_*`**
- Ghi `.env` giữ nguyên các dòng khác và tạo `.env.bak`
- Sidecar tắt: `/threads` vẫn trả dữ liệu, `/status` báo đúng là đang tắt
- Chặn path traversal ở mọi tham số đường dẫn

**Node** (`node --test`, nối vào bộ 53 test đang xanh):

- `control-token.test.js` — sinh token, quyền tệp, đọc lại
- `control-api.test.js` — 401 khi thiếu/sai token; route hợp lệ đi qua;
  `POST /control/send` ghi đúng một dòng `audit_log` với `actor_role="dashboard"`

**Giao diện**: không test tự động — chi phí quá lớn so với giá trị. Thay bằng
checklist kiểm tay ngắn trong README.

## 11. Rủi ro

| Rủi ro | Cách xử lý |
|---|---|
| Hợp đồng SDK đổi giữa các bản Hermes | Bản `dist` dò tính năng rồi thoái lui êm, đúng cách achievements xử lý `SDK.useI18n`. Không vỡ trắng màn. |
| Khách chỉ chạy `hermes gateway run`, không chạy dashboard | Plugin chỉ là thêm; mọi thứ vẫn chạy như cũ nếu không mở dashboard. README nói rõ. |
| Đường dẫn sidecar dò sai | `ZALO_SIDECAR_DIR` ghi đè; không tìm thấy thì hiện hướng dẫn cụ thể |
| Lịch sử lớn làm chậm truy vấn | Đã có `idx_messages_thread_time`; phân trang bắt buộc, không route nào trả toàn bộ bảng |

## 12. Các bước tiếp theo

1. Đồng bộ production → repo (§3) — điều kiện tiên quyết
2. Lập kế hoạch thi công qua kỹ năng `writing-plans`
