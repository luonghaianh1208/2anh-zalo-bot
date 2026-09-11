# Nhật ký thay đổi

Theo chuẩn [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/).

## [1.2.0] — 2026-09-11

### Thêm

- **Hẹn giờ đăng Fanpage.** `zalo_fb_publish` nhận thêm `scheduled_publish_time`
  (UNIX timestamp tính bằng giây, từ 10 phút tới 75 ngày sau); bỏ trống thì đăng
  ngay như trước. Giờ hẹn sai định dạng bị từ chối trước khi bản nháp bị dùng
  mất. Tính năng này trước chỉ có trên một máy chạy riêng — nay gộp vào sản phẩm,
  bỏ lời gọi `upload_photo(..., published=False)` sai chữ ký đi kèm bản đó.

## [1.1.1] — 2026-09-11

### Bảo mật

- **Người ngoài mượn được quyền chủ nhân khi tin phải xếp hàng.** Danh tính
  người gửi nằm trong một ContextVar chỉ gán lúc tin tới; Hermes chạy tin xếp
  hàng trong task tạo ra từ lượt trước nên thừa hưởng danh tính người gửi
  trước. Thành viên tag bot đúng lúc chủ nhân đang giao việc là chạy công cụ
  bằng quyền chủ (vd. gửi `data/session.json` lên nhóm). Nay adapter nhớ danh
  tính theo mã tin và gắn lại mỗi lượt trong `toolsets_for_source`; lượt của
  chủ mà có người ngoài nhắn chen vào trước khi chạy (Hermes có thể gộp chữ
  của họ vào chung) thì chạy với quyền công khai. Sidecar chỉ coi là chủ khi
  UID nằm trong allowlist **và** adapter xác nhận `actorRole: owner`.
- **Dashboard 3872 bị DNS rebinding.** Trang web lạ trỏ tên miền về
  `127.0.0.1` là đăng xuất được bot và lấy được ảnh QR. Nay mọi yêu cầu HTTP
  và WebSocket có `Host` khác `127.0.0.1`/`localhost` đều bị từ chối.
- **`zalo_send_voice` cho người ngoài truyền URL tuỳ ý** → sidecar gửi yêu cầu
  tới địa chỉ nội bộ (dò mạng LAN). Nay người ngoài chỉ dùng được địa chỉ web
  công cộng.

### Sửa

- **Xác nhận hai bước không bao giờ khớp trong nhóm**: chữ đem đối chiếu còn
  dính `@tên bot`. Nay bỏ phần tag và gộp khoảng trắng trước khi so.
- **Cron, kênh nhà và thông báo của gateway bị bridge chặn** ("Thiếu ngữ cảnh
  phân quyền") vì ngoài lượt chat không có người gửi. Nay adapter gửi vai trò
  `system`, sidecar chỉ cho vai trò này gửi chữ/báo đang gõ tới chủ nhân hoặc
  `ZALO_HOME_CHANNEL`. UID chủ nhân 19 chữ số không còn bị đoán nhầm là nhóm.
- **`zalo_group_members` luôn ra rỗng**: gọi `getGroupMembersInfo` bằng ID nhóm
  trong khi hàm này nhận ID thành viên. Nay sidecar có lệnh `group_members`
  hỏi `getGroupInfo` trước rồi mới tra hồ sơ (tối đa 200 người).
- **Đổi cổng bridge theo README không ăn**: `ZALO_BRIDGE_PORT` bị đọc lúc nạp
  module, trước khi `.env` được nạp; adapter lại ưu tiên `extra.bridge_url`
  hơn `ZALO_BRIDGE_URL`. Nay cả hai đọc đúng thứ tự.
- **`install:hermes` xoá comment và làm tròn số lớn trong `config.yaml`** (ID
  19 chữ số thành số khác), không giữ bản sao lưu. Nay sửa ngay trên Document
  YAML, giữ nguyên comment và từng chữ số, và lưu `config.yaml.bak-<giờ>`.
- **Cài lại với `--hermes-home` khác không sửa `HERMES_HOME`** trong `.env`
  của sidecar. Nay giá trị được cập nhật.
- **Hermes đã cắm thì người lạ nhắn `/sethome` không nhận được gì.** Nay adapter
  trả UID của chính người nhắn (không cấp quyền). Tin trả lời UID tách chữ
  "tuỳ chọn" ra dòng riêng để chép vào `.env` không dính chữ thừa.
- **`npm test` báo đỏ trên bản clone mới** khi Python hệ thống không có lõi
  Hermes. Nay suite adapter được bỏ qua kèm cảnh báo.
- Tài liệu: các bước `/sethome` đúng thực tế, `doctor` kiểm 9 mục, tên biến
  `ZALO_DM_POLICY`/`ZALO_GROUP_REPLY_ONLY_TAGGED`, `data/` có `zalo.sqlite`,
  giao thức bridge đủ lệnh, gỡ cài đặt để lại khoá nào trong `config.yaml`,
  gợi ý định dạng gửi mô hình bỏ "4000 ký tự" và "tiêu đề đỏ" đã lỗi thời;
  dashboard và mô tả công cụ không còn ghi cứng tên "Lăng Tiêu" hay nói bot
  "vẫn trả lời ở mức trò chuyện" khi Hermes chưa cắm.

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
