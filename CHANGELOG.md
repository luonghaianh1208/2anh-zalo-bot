# Nhật ký thay đổi

Theo chuẩn [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/).

## [1.8.0] — 2026-09-12

### Thêm

- **Tự chuyển ảnh JPEG XL sang JPEG.** Ảnh nào Zalo chỉ có bản `/gr/jxl/` thì
  adapter tải về, giải mã rồi lưu thành JPEG để model xem được, thay vì báo lỗi.
  Cần gói tuỳ chọn `pillow-jxl-plugin` (có wheel dựng sẵn cho Windows và Linux);
  thiếu gói thì vẫn báo đúng lý do và nhờ gửi lại dạng JPG như cũ.

## [1.7.1] — 2026-09-12

### Sửa

- **Ảnh Zalo bị từ chối vì "định dạng JXL".** Cùng một tấm ảnh, Zalo đưa hai
  đường dẫn: `/gr/jpg/<mã>/<id>.jpg` mở được và `/gr/jxl/<mã>/<id>` là JPEG XL
  mà Hermes không mở nổi. Bot vớ phải bản JXL rồi báo "chưa xem được hình" trong
  khi bản JPG nằm ngay cùng tin nhắn. Nay gom theo mã ảnh và bỏ bản JXL khi tấm
  đó còn bản đọc được; ảnh chỉ có mỗi bản JXL thì vẫn báo đúng lý do như cũ.

## [1.7.0] — 2026-09-12

### Thêm

- **Kiểm tra bài Fanpage có thật sự công khai không.** Graph API từng khai
  `is_published: true`, `is_hidden: false`, quyền "Công khai" cho một bài mà
  người ngoài không xem được (ca ngày 09/09/2026). Token của Page nhìn thấy mọi
  thứ, nên `facebook.public_visibility()` hỏi bằng đường không token — trình
  nhúng bài viết công khai. `zalo_fb_publish` trả kèm kết quả này khi đăng ngay,
  và công cụ mới `zalo_fb_check` soát lại bất kỳ bài nào theo ID (dùng cho bài
  hẹn giờ, sau khi tới giờ đăng).

### Sửa

- Hướng dẫn trình bày cấm bot tự viết script hay gọi thẳng Graph API để đăng
  Fanpage — đó là cách nó đi vòng qua cửa mã duyệt hôm 08/09 và tạo ra bài
  hỏng. Thiếu tham số thì báo chủ nhân, và chỉ được nói "đã đăng" sau khi kiểm
  tra hiển thị công khai.

## [1.6.2] — 2026-09-12

### Sửa

- **Thẻ chia sẻ link bị tải về như ảnh.** Thẻ link của Zalo (`chat.recommended`:
  TikTok, Facebook, Google Meet, Drive…) cũng mang `href` và ảnh thu nhỏ như tin
  ảnh, nên bot tải link về rồi báo "không đọc được ảnh". Nay chỉ tin thật sự có
  media (ảnh, tệp, video, thoại) mới nhặt URL; link để nguyên trong chữ và bot
  đọc bằng `zalo_web_read`. Áp cho cả tin được reply.

## [1.6.1] — 2026-09-12

### Sửa

- **Thành viên gửi tệp thì bot vẫn không đọc được.** Hermes chỉ lưu tệp rồi bảo
  agent tự mở, nhưng người trong nhóm không có `read_file` nên chịu chết. Adapter
  nay tự rút chữ từ tệp (PDF, DOCX, XLSX…) và kèm thẳng vào tin, nên bot trả lời
  được ngay cả khi người gửi không phải chủ nhân.

## [1.6.0] — 2026-09-12

### Sửa

- **Tệp PDF, DOCX, XLSX bị đọc như ảnh rồi báo lỗi.** Tin gửi tệp của Zalo
  (`share.file`) có cùng hình dạng với tin ảnh, mà cầu nối lại gắn cứng
  `image/jpeg` cho mọi URL — nên tệp bị tải về như ảnh, hỏng, rồi bot trả lời
  "không đọc được ảnh" hoặc mô tả tài liệu như một tấm hình. Cầu nối nay phân
  loại từng tệp đính kèm (`zalo-attachments.js`): ảnh, video, âm thanh hay tài
  liệu, kèm tên và MIME thật; tin gửi tệp bỏ luôn ảnh thu nhỏ đi kèm. Adapter
  tải tài liệu vào cache tài liệu của Hermes và đánh dấu lượt là `DOCUMENT`, nên
  gateway chèn ghi chú trỏ agent tới tệp để tự rút chữ (PDF, DOCX, XLSX…).
  Tin được reply cũng được phân loại như vậy.

## [1.5.2] — 2026-09-12

### Sửa

- **`zalo_kb_list` che mất phần lớn kho khi kho lớn.** Kho 1378 tệp thì 200 tệp
  đầu rơi hết vào một thư mục, agent tưởng kho chỉ có chừng đó. Kết quả nay kèm
  `folders` (thư mục cấp 1 và số tệp) để agent biết còn nhánh nào mà thu hẹp
  `query`.

## [1.5.1] — 2026-09-12

### Thêm

- `ZALO_KB_PUBLIC_DIRS`: giới hạn kho tài liệu ở vài thư mục cấp 1 (tên cách
  nhau bằng dấu phẩy). Kho thật thường là cả một ổ đĩa nhiều năm, trong khi
  người trong nhóm chỉ cần thư mục của năm hiện hành. Áp cho cả liệt kê, đọc và
  gửi tệp; để trống thì mở cả kho như trước.

### Sửa

- **Bị chặn xong bot bỏ cuộc.** Hermes ghim công cụ lõi vào phiên nhóm còn công
  cụ Zalo nằm sau `tool_search`, nên khi thành viên hỏi tài liệu, model gọi
  `terminal`/`search_files`, bị chặn rồi trả lời "không tra được" thay vì tra
  kho. Câu báo khi bị chặn nay nói đúng tình huống và chỉ sang `zalo_kb_list`,
  `zalo_kb_read`, `zalo_send_file`, `zalo_read_history`; hướng dẫn trình bày
  cũng dặn tra kho trước khi nghĩ tới công cụ lõi.

## [1.5.0] — 2026-09-11

### Thêm

- **Tag thật trong nhóm.** Bot viết `@Tên hiển thị` thì sidecar gắn tag Zalo
  thật (người đó nhận thông báo) khi tên khớp trọn đúng một người — lấy từ
  người vừa nhắn trong nhóm và danh sách thành viên. Tên trùng, không khớp, còn
  tiếp bằng chữ hoa ("@Trang Nguyễn"), bị cắt ở cuối chunk thì giữ dạng chữ;
  nhóm đông hơn 200 người chỉ tag người vừa nhắn; tra thành viên quá 4 giây thì
  gửi không tag. Hướng dẫn trình bày dặn chỉ tag khi thật sự cần gọi người đó.
- **Bản soạn đứng riêng một tin.** Nhờ soạn thông báo/tin nhắn thì bot viết đúng
  nội dung, không lời mở đầu, rồi dòng `[[NEW_MESSAGE]]` và một câu xác nhận;
  adapter tách thành hai tin nhắn để copy được ngay. Dấu được nhận cả khi in
  đậm, viết thường, kèm dấu câu hay chung dòng, nên không lọt vào tin nhắn.
- `platforms.zalo.extra.ignore_sender_uids` (hoặc `ZALO_IGNORE_SENDER_UIDS`):
  tin của tài khoản bot khác trong nhóm vẫn giữ làm ngữ cảnh nhưng không gọi dậy
  bot. Không áp cho tin nhắn riêng và không bao giờ áp cho chủ nhân.

### Sửa

- Thông báo nội bộ "💾 Self-improvement review / Memory updated" của Hermes không
  còn gửi vào hội thoại Zalo.
- Chế độ `busy_input_mode: queue` thì tin người ngoài xếp hàng thành lượt riêng,
  nên lượt đang chạy của chủ nhân không bị hạ quyền nữa.

## [1.4.1] — 2026-09-11

### Bảo mật

- **Thành viên nhóm chạy được `terminal`, `read_file`, `vision_analyze`…**
  `toolsets_for_source` chỉ đưa `zalo_public` cho người ngoài, nhưng Hermes
  "đóng băng" danh sách công cụ theo phiên (`restore_agent_tool_prefix`): phiên
  nhóm do chủ nhân mở trước thì lượt sau của bất kỳ ai cũng được cấp lại bộ công
  cụ của chủ nhân. Plugin `zalo_tools` nay đăng ký hook `pre_tool_call` chặn tại
  điểm thực thi: lượt không phải chủ nhân chỉ chạy được công cụ `zalo_public`,
  công cụ MCP và cầu nối Tool Search (`tool_call` xét theo công cụ bên trong).
- **Tin người ngoài chen vào lượt đang chạy của chủ nhân.** Chế độ
  `busy_input_mode` interrupt/steer chèn tin mới vào lượt đang chạy; có người
  ngoài gọi bot trong cùng hội thoại thì phần còn lại của lượt bị hạ về mức
  công khai. Lượt tự chạy tiếp không khớp tin nào (vd. sau khi khởi động lại)
  chỉ giữ công cụ lõi trong hội thoại riêng với chủ nhân.
- Trình cài đặt đặt `plugins.hook_callback_timeout: 0`. Để timeout mặc định thì
  Hermes khoá callback dùng chung giữa mọi luồng, các lời gọi công cụ song song
  bị chặn nhầm "still running" (đo được 286/320 lần); chạy đồng bộ thì 0 lần.

### Sửa

- **Ảnh không tải được vẫn báo "đã đính kèm".** Ảnh JXL của Zalo bị Hermes từ
  chối cache, nhưng prompt vẫn nói đã đính kèm; model đi lục thư mục cache
  chung và nhận xét nhầm ảnh của nhóm khác. Nay prompt ghi đúng số ảnh đính kèm
  và lý do không đọc được (định dạng chưa hỗ trợ, lỗi HTTP, quá thời gian, quá
  dung lượng), dặn bot báo lại người gửi. Tin chỉ có ảnh lỗi vẫn tới được agent.

## [1.4.0] — 2026-09-11

### Sửa

- **Cron và câu trả lời gửi bù không tới được nhóm.** Tin gửi ngoài lượt chat
  mang vai trò `system`, mà sidecar chỉ cho `system` tới chủ nhân hoặc kênh nhà
  — kết quả cron gửi vào nhóm và câu trả lời gửi bù sau khi gateway khởi động
  lại đều bị chặn (`auth_required`, 18 lần trên máy chạy thật 08–11/09). Nay
  `system` gửi chữ và báo đang gõ được tới mọi hội thoại, vẫn không gọi hàm
  Zalo, không đọc lịch sử, không thu hồi.
- **Cron không dùng được công cụ Zalo nào.** Công cụ nay đọc `task_id` của lượt
  cron để biết job: job tạo bằng công cụ cron gốc (chỉ chủ nhân có) chạy với
  quyền chủ nhân trong hội thoại đích; audit ghi mã cron phát lệnh.
- **Tin cron trong nhóm có khung tiếng Anh** `Cronjob Response… (job_id…)`.
  Adapter Zalo bỏ khung này; nền tảng khác giữ nguyên.
- Gắn danh tính lượt chat bị lỗi thì rơi về quyền công khai của đúng người đó,
  không rơi về `system`.
- **Mỗi lệnh Zalo của công cụ chậm đúng 30 giây.** Ack của sidecar tới trên vòng lặp
  gateway nhưng được trả cho lệnh đang chờ trên vòng lặp của luồng agent bằng
  `set_result` gọi thẳng từ luồng khác, nên lệnh chỉ thấy kết quả khi hết thời gian
  chờ — sticker mất 60 giây, gửi tệp, nhắc hẹn, đọc lịch sử, cron mỗi lệnh 30 giây.
  Nay ack đánh thức đúng vòng lặp của lệnh; giới hạn chờ 30 giây và nhịp gửi chống
  khoá tài khoản giữ nguyên.

### Thêm

- **`zalo_group_cron` — thành viên tự hẹn giờ cho nhóm.** Tạo, xem, xoá việc hẹn
  giờ của nhóm đang trò chuyện. Job khoá cứng đích gửi, toolset
  `zalo_cron_member` (tra web, kho tài liệu, `zalo_group_history` của chính
  nhóm), không script/thư mục/skill/model; lặp tối đa 1 lần/ngày, 3 việc/người,
  10 việc/nhóm; chỉ người tạo hoặc chủ nhân xoá được. Prompt qua bộ quét cron
  của Hermes.
- Trình cài khai thêm `zalo_cron` vào `known_plugin_toolsets.zalo`; `doctor`
  kiểm cả toolset này.

## [1.3.0] — 2026-09-11

### Đổi

- **Thao tác nguy hiểm không còn bắt nhập mã xác nhận.** Thu hồi tin, đổi tên
  nhóm, thêm/xoá thành viên, phó nhóm, link nhóm… chủ nhân nhắn là bot làm
  ngay, trong nhóm hay nhắn riêng đều được. Người ngoài vẫn bị chặn: các công cụ
  này chỉ nằm trong bộ của chủ, adapter kiểm `is_owner` và sidecar kiểm lại.
  Ai muốn giữ lớp mã sáu ký tự (chặn cả lệnh ẩn trong tài liệu hay trang web
  bot đọc) thì đặt `ZALO_CONFIRM_DANGEROUS=true` trong `.env` của Hermes.

## [1.2.1] — 2026-09-11

### Sửa

- **Cài bằng `install:hermes` xong mà Hermes không nối được sidecar** ("Thiếu
  ZALO_BRIDGE_TOKEN trong cấu hình Zalo"). Hermes ghi kết quả `_env_enablement`
  của adapter đè lên `platforms.zalo.extra` trong `config.yaml`, mà hàm này luôn
  trả `bridge_token` rỗng, `bridge_url` mặc định và `reply_only_tagged: true`
  kể cả khi `.env` không đặt — xoá mất token trình cài vừa ghi và lờ đi
  `reply_only_tagged: false` của khách. Nay chỉ trả những khoá thật sự có trong
  env. Phát hiện khi nâng một máy chạy thật lên bản này.

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
