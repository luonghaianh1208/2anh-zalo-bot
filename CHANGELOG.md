# Nhật ký thay đổi

Theo chuẩn [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/).

## [1.1.1] — 2026-09-11

### Sửa

- **Bot "điếc" mà vẫn báo khoẻ.** Listener zca-js được bật không kèm
  `retryOnClose` và không ai nghe sự kiện `closed`: kết nối nghe tin tới Zalo
  đứt là bot vẫn đăng nhập, vẫn gửi được, nhưng không nhận thêm tin nào — cả
  nhóm lẫn tin riêng — cho tới khi khởi động lại sidecar, trong khi
  `/api/health` vẫn báo `healthy`. Nay listener tự nối lại, đóng hẳn thì tự mở
  lại theo nhịp 5 giây → 5 phút; `/api/health` có thêm `zalo.listener` và báo
  `degraded` khi không nghe được tin; dashboard có ô "Nghe tin Zalo".
- **Tin dài nhiều emoji và in đậm bị Zalo từ chối trong im lặng.** Zalo chặn
  gói tin có byte UTF-8 của chữ cộng JSON định dạng vượt khoảng 3440, chỉ trả
  "Lỗi không xác định"; bộ chia tin cũ chỉ đếm 2000 ký tự và 40 style nên để
  lọt. Nay mỗi tin còn nằm trong 3000 byte.
- **Một đoạn bị từ chối là mất luôn phần sau.** Cầu nối nay gửi lại đúng đoạn
  bị từ chối dạng chữ thường rồi gửi tiếp; lỗi mạng thì không gửi lại để tránh
  trùng tin. Adapter bỏ câu tiếng Anh `(Response formatting failed, plain
  text:)` mà lõi Hermes chèn khi tự gửi lại, để câu nội bộ không lọt vào nhóm.
- **`/api/status` lộ số điện thoại của tài khoản bot.** Hồ sơ lấy từ Zalo và
  hồ sơ đọc từ phiên cũ nay chỉ giữ UID, tên hiển thị, ảnh đại diện.
- **README ghi sai giới hạn định dạng "khoảng 256 ký tự JSON"** và nhắc hàm
  `capStyles` không còn tồn tại; nay mô tả đúng ngân sách byte đo được và cơ
  chế gửi lại. Dashboard không còn ghi cứng tên "Lăng Tiêu" cho ô kết nối Hermes.

### Thêm

- **Log sidecar ra file** `logs/sidecar.log` kèm giờ địa phương, quá 5 MB tự
  dời sang `logs/sidecar.log.1` — sidecar chạy ngầm vẫn tra được giờ sự cố.

## [1.1.0] — 2026-09-10

### Sửa

- **Vòng luẩn quẩn không lấy được UID khi cài mới.** Trước bản này, khách cài
  mới không có cách nào tự lấy UID Zalo của mình: `ZALO_ALLOWED_USERS` trống
  → gateway chặn mọi người → không ai nhắn được → không lấy được UID → không
  điền được allowlist. Nay khi Hermes chưa cắm vào, nhắn riêng đúng nội dung
  `/sethome` (không phân biệt hoa thường, chấp nhận khoảng trắng thừa) cho
  tài khoản bot sẽ trả về UID của chính người gửi kèm hướng dẫn điền vào
  `.env`. Không tự phong quyền chủ, không ghi tệp nào; trong nhóm thì bỏ qua.
- **Script lấy token Facebook in Page Access Token ra màn hình.** Trái với
  đúng lời docstring của tệp là "không in token hay App Secret ra màn hình" —
  token này tương đương chìa khoá Page, lọt vào lịch sử terminal hay ảnh chụp
  màn hình là mất quyền kiểm soát Page. `scripts/lay-token-facebook.py` nay
  chỉ in tên/ID Page, trạng thái vĩnh viễn và quyền còn thiếu; App Secret và
  token ngắn hạn nhập qua `getpass` (ẩn ký tự).
- **Script lấy token Facebook ghi nhầm thư mục.** Khi `HERMES_HOME` chỉ có
  trong `.env` (không phải biến môi trường thật của tiến trình), script rơi
  về ghi `fb_pages.json` vào `scripts/` thay vì thư mục Hermes — khách tìm
  không thấy tệp. Nay tự dò và báo lỗi rõ ràng thay vì ghi bừa.
- **Trình cài và `server.js` không thấy cấu hình khách đã điền đúng hướng
  dẫn.** `HERMES_HOME`, `ZALO_ALLOWED_USERS` và các biến khác nằm trong
  `.env` của Hermes, nhưng trước bản này sidecar chỉ nạp `.env` của chính nó
  — khách làm đúng theo README mà trình cài vẫn không đọc được. Nay
  `server.js` và trình cài nạp thêm `.env` của Hermes (`loadHermesEnv` trong
  `scripts/setup-env.js`) sau khi đã nạp `.env` của sidecar.
- **`GET /api/health` báo sai "chưa cấu hình chủ nhân" dù đã cấu hình đúng.**
  Hệ quả trực tiếp của lỗi nạp `.env` ở trên: `ownerConfigured` đọc
  `process.env.ZALO_ALLOWED_USERS`, biến này trống vì `.env` chứa nó (của
  Hermes) chưa từng được nạp. Sửa cùng lúc với việc nạp `.env` của Hermes ở
  trên.
- **Ba nơi khai ba phiên bản khác nhau.** `package.json` ghi `1.0.0`, thẻ git
  `v1.1.0`, hai `plugin.yaml` ghi `1.1.0` — `npm pack` ra gói mang số phiên
  bản sai. Đồng bộ về `1.1.0`.
- **Tài liệu nói sai số route API.** README ghi "chỉ còn đúng ba route" trong
  khi `server.js` có bốn (`/api/qr/start`, `/api/status`, `/api/health`,
  `/api/logout`) — thiếu hẳn `GET /api/health` khỏi bảng liệt kê.
