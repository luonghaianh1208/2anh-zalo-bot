# Nhật ký thay đổi

Theo chuẩn [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/).

## [2.9.0] — 2026-10-10

### Thêm
- **Cập nhật bot ngay trên dashboard** (Bảo trì › Cập nhật, chỉ Quản trị): khi GitHub có bản 2anh-zalo-bot mới, bấm **Cập nhật bot lên vX**:
  1. Tự sao lưu cài đặt và ghi nhận bản đang chạy.
  2. Lấy mã mới — bản cài git: `git checkout <tag>`; bản cài thường: tải gói phát hành từ GitHub, giải nén đè (giữ `.env`, `data/`).
  3. `npm ci` nếu thư viện đổi, chạy bộ cài `install-hermes.js --no-dashboard` của mã mới (chép plugin, dựng plugin.yaml, bổ sung config).
  4. Khởi động lại kết nối Zalo → trợ lý → dashboard, chờ bot chạy lại bình thường.
  5. Lỗi hoặc sau 3 phút chưa khoẻ → **tự quay về bản cũ**.
  Trang hiện từng bước và nhật ký, tự nối lại khi dashboard khởi động lại. Trên Linux trình cập nhật chạy bằng `systemd-run` nên không bị tắt theo dashboard.
- **Thanh trạng thái báo "Có bản mới vX"** cho mọi người đăng nhập (Quản trị bấm vào là tới Bảo trì; Chủ bot thấy lời nhắc báo người quản trị); hiện "Đang cập nhật bot…" khi đang cập nhật.
- `scripts/self-update.js` (chạy tay được: `node scripts/self-update.js --to vX.Y.Z`).

## [2.8.3] — 2026-10-10

### Đổi
- Nút **Ủng hộ tác giả** chuyển lên thanh trạng thái đầu mọi trang (nút trắng nổi bật, trái tim đỏ) cho mọi người dễ thấy; bỏ nút trùng ở thanh bên.

## [2.8.2] — 2026-10-10

### Thêm
- **Ủng hộ tác giả**: nút ở thanh bên dashboard và trang Tài khoản mở mã VietQR (MB Bank 0328186264 — LUONG HAI ANH), bấm để chép số tài khoản; thêm mục ủng hộ kèm QR vào README.

## [2.8.1] — 2026-10-10

### Sửa
- Bảo trì › Sao lưu: nút **Tải về** báo lỗi 404 trên máy chủ Linux (bản sao lưu nằm trong thư mục `.hermes`).

## [2.8.0] — 2026-10-10

### Thêm
- **Trang "Skill"** (Hệ thống, chỉ Quản trị): mọi skill của trợ lý — mô tả, nguồn (có sẵn / tự tạo / từ kho / tải lên), số lần dùng.
  - **Bật/tắt trên Zalo** (danh sách riêng `skills.platform_disabled.zalo`, hiệu lực từ cuộc trò chuyện mới, không đụng dòng lệnh/Telegram); xem nội dung SKILL.md; gỡ skill cài thêm.
  - **Thêm skill**: tải lên `.zip` hoặc `SKILL.md`; duyệt danh mục chính thức của Hermes (137 skill); tìm trên kho cộng đồng. Mọi skill đều qua **bộ quét an toàn của Hermes** — skill bị đánh giá không an toàn không cài được; có nút "Kiểm tra an toàn" trước khi cài. Gói tải lên không được chứa `.skillignore`, symlink, đường dẫn lạ, và không bao giờ đè skill đang có.
- **Kết nối MCP** quản lý đầy đủ trên dashboard:
  - **Thêm từ danh mục Hermes** (65 dịch vụ: Notion, Linear, Atlassian, Canva…) một lần bấm, điền khoá nếu dịch vụ cần; hoặc **theo địa chỉ https riêng** (không cần đăng nhập / OAuth / khoá token — khoá chỉ lưu trong .env).
  - **Kiểm tra** thật (kết nối và liệt kê công cụ), **chọn công cụ** dùng/không dùng, **Đăng nhập** OAuth qua trang dashboard (dịch vụ chuyển về `/api/mcp-oauth/callback`), **Gỡ**.
- **Trang "Bảo trì"** (chỉ Quản trị):
  - **Cập nhật**: phiên bản bot Zalo và bản mới nhất trên GitHub (kèm "có gì mới"); phiên bản Hermes, **Kiểm tra bản mới**, **Cập nhật Hermes** (chạy `hermes update --yes --backup` nền, xem nhật ký tiến độ).
  - **Sao lưu**: bản sao lưu cài đặt (.zip: cấu hình, .env, SOUL, trí nhớ, skill, phân quyền/sổ người quen Zalo, tài khoản dashboard, lịch hẹn) — tạo, **tải về**, **khôi phục** (từ bản trên máy hoặc tệp tải lên; luôn lưu hiện trạng trước), xoá; **điểm khôi phục của Hermes** (gồm cả lịch sử trò chuyện) — tạo, khôi phục.
- Dashboard: cầu nối `dashboard/lib/hermes-admin.py` chạy bằng chính Python của Hermes, gọi hàm nội bộ Hermes (không đọc bảng chữ dòng lệnh); tự tìm Python (`ZALO_HERMES_PYTHON` → venv trong HERMES_HOME → venv cạnh lệnh `hermes`). Mỗi lần dashboard ghi config.yaml qua Hermes đều giữ bản sao (10 bản gần nhất, `zalo/dashboard/config-backups`).

## [2.7.0] — 2026-10-09

### Thêm
- **Khoá dự phòng tự đổi** (Khoá API & Model › Khoá API › Quản lý khoá): mỗi dịch vụ (Tavily, Exa, CORE, Apify, Vbee, ảnh xưởng…) có thể có tới 10 khoá xếp theo thứ tự ưu tiên.
  - Khi công cụ báo lỗi khoá / hết lượt / hết tiền (401/402/403/429, "quota", "insufficient credits"…), plugin **tự chuyển sang khoá kế** ngay trong lượt trả lời và dặn model gọi lại — **không cần khởi động lại**. Khoá lỗi nghỉ 1 giờ (hết lượt) hoặc 1 ngày (khoá sai) rồi mới được dùng lại.
  - Quản lý trên dashboard: thêm khoá dự phòng (kèm ghi chú), dùng khoá này, đổi thứ tự (↑↓), kiểm tra từng khoá, xoá; xem khoá nào đang dùng / đang nghỉ và các lần tự đổi gần đây.
  - Đổi khoá của công cụ trên dashboard có hiệu lực ngay (plugin đồng bộ trước mỗi lần gọi công cụ); chỉ khoá Telegram/Discord/cổng AI còn cần khởi động lại.
- Plugin: mô-đun `zalo_tools/key_pool.py` (móc `pre_tool_call` + `transform_tool_result`), kho `<HERMES_HOME>/zalo/key-pool.json` (quyền 600), nhật ký `key-events.jsonl`.

## [2.6.1] — 2026-10-09

### Sửa
- Khoá API › Kiểm tra: CORE báo "không gọi được" do địa chỉ kiểm tra bị chuyển hướng — dùng đúng địa chỉ cuối.
- Khoá dùng qua cổng AI (vd. `GEMINI_API_KEY`, `ANH_AI_KEY` trùng khoá 9router) được kiểm qua cổng AI thay vì gọi thẳng Google (trước báo lỗi 400 sai).
- Ẩn khoá nội bộ (`VBEE_WEBHOOK_SECRET`…) khỏi danh sách; `CUSTOM_API_KEY` có tên dễ hiểu.

## [2.6.0] — 2026-10-09

### Thêm
- **Trang "Khoá API & Model"** (Hệ thống, chỉ Quản trị):
  - **Model AI**: mỗi chức năng dùng AI một thẻ — Trò chuyện chính, Dự phòng, Giọng đọc, Nghe giọng nói, Tạo ảnh, Ảnh cho xưởng, Trí nhớ tự học (OpenViking) — model gì, qua đâu; nút **Thử** gửi một câu ngắn và báo thời gian. Đổi model chính ngay tại đây (danh sách lấy từ cổng AI, gồm combo) — chuyển từ trang Agent sang.
  - **Khoá API**: mỗi khoá dịch vụ một dòng (Tra web Tavily/Exa, CORE, Gemini, Vbee, Apify, Telegram, Discord, cổng AI chính…) — dùng cho tính năng nào, đã đặt chưa (chỉ 4 ký tự cuối), **Kiểm tra** (gọi thử dịch vụ), **Thay khoá / Gỡ khoá / Thêm khoá dịch vụ**. Khoá cũ không bao giờ hiện ra; Nhật ký chỉ ghi tên khoá; ghi .env / config.yaml có .bak; nhắc khởi động lại trợ lý.
- Trang Agent chỉ còn mức suy nghĩ và tính cách.

## [2.5.0] — 2026-10-09

### Thêm
- **Lịch hẹn › Luồng** (kiểu node như n8n), bên cạnh Lịch tuần:
  - Mỗi lịch hẹn là một làn **Khi nào → Bot làm gì → Gửi vào**; bấm khối để sửa.
  - Kéo nhóm/người từ bảng bên phải thả vào cột "Gửi vào" để **gửi cùng một kết quả tới nhiều nơi** (tối đa 10); kéo khối nơi nhận sang luồng khác để chuyển; × để bỏ. Màn cảm ứng/bàn phím dùng ô "+ Thêm nơi gửi".
  - Cửa sổ sửa cũng chọn được nhiều nơi gửi. Nơi gửi không thuộc Zalo (nếu có) được giữ nguyên; việc do thành viên nhóm tạo vẫn chỉ gửi vào chính nhóm đó.
- API: `targets` (danh sách) cho tạo/sửa lịch hẹn; `/api/schedules` trả `targets`, `targetNames`.

## [2.4.0] — 2026-10-09

### Thêm
- **Lịch hẹn dễ dùng cho người không rành kỹ thuật**:
  - Lịch tuần 7 cột (điện thoại xếp dọc): mỗi việc một thẻ giờ · tên · gửi vào đâu, viền màu theo trạng thái. **Kéo thẻ sang ngày khác để dời lịch** (một lần: đổi ngày; các thứ: đổi thứ; hằng tháng: đổi ngày trong tháng).
  - **Tạo / sửa bằng lời thường**: tên, bot sẽ làm gì, gửi vào (chọn nhóm/người), lặp lại (Một lần / Hằng ngày / Các thứ T2…CN / Hằng tháng), giờ (thêm nhiều giờ). Tạm dừng, chạy lại, xoá ngay trong cửa sổ.
  - Lịch phức tạp nằm ở "Lịch nâng cao"; cron gốc chỉ Quản trị sửa. Mọi thay đổi đi qua `hermes cron create/edit` và chỉ gửi phần thật sự đổi; việc hẹn giờ nhóm giữ nguyên chỉ dẫn hệ thống và nơi gửi.
- **Trí nhớ dạng thẻ**:
  - Sổ người quen: mỗi người một thẻ, thông tin dạng nhãn ("Lớp: 12A1") kèm nơi bot được dùng; sửa trong cửa sổ có nút gợi ý (Xưng hô, Chức vụ, Lớp, Môn dạy…).
  - Bộ nhớ của trợ lý (Quản trị): danh sách câu thường, thêm/sửa/xoá trong cửa sổ, thanh dung lượng.
- API: `POST/PUT /api/schedules/cron`, `POST /api/admin/agent-memory/:target`; `/api/people` kèm nơi dùng từng mục.

## [2.3.1] — 2026-10-09

### Sửa
- Nhật ký (Có lỗi, Hoạt động AI): lời gọi qua cầu nối `tool_call` của Hermes hiện đúng tên công cụ thật bên trong (vd. `zalo_kb_list`, hoặc `zalo_kb_list + zalo_web_search` khi gói nhiều), thay vì chỉ "tool_call".
- Thành viên nhóm: khi model gói nhiều công cụ thường trong một `tool_call` (Hermes không nhận), bot báo đúng lỗi "gọi lại từng công cụ một" thay vì "chỉ dùng được trong lượt của chủ nhân" — model gọi lại được thay vì bỏ cuộc.

## [2.3.0] — 2026-10-09

### Thay đổi
- **Gộp Nhật ký và Theo dõi agent thành một trang "Nhật ký"** (dùng khi có lỗi hoặc cần tra lại); menu chỉ còn một mục.
  - Mở ra là tab **Có lỗi** (7 ngày): việc bot làm hỏng, thao tác dashboard lỗi, và — với Quản trị — công cụ AI báo lỗi kèm nhóm, người hỏi, câu hỏi (bấm để xem trong Hoạt động AI). Không có lỗi thì chỉ một dòng xanh.
  - Các tab khác chỉ mở khi cần: **Thao tác** (người trên dashboard), **Bot gửi**, **Hoạt động AI** (chỉ Quản trị — trang Theo dõi agent cũ; đường `#/trace` vẫn mở đúng tab này).
  - Một ô tìm chung theo nhóm, người, hành động.
- API: `/api/audit?source=zalo|dashboard`, `/api/admin/trace/errors?days=7`.

## [2.2.2] — 2026-10-09

### Thay đổi
- **Theo dõi agent gọn hơn nữa**:
  - Mỗi cuộc trò chuyện một dòng: gộp các phiên của cùng nhóm/người (trước đây mỗi lần làm mới phiên là thêm một dòng), bỏ phiên trống.
  - Bấm cả dòng để mở các lượt gần nhất (đi ngược qua các phiên); model và token thu thành một dòng nhỏ cuối.
  - Mỗi lượt chỉ hiện người hỏi và câu hỏi thật — bỏ khối ngữ cảnh nhóm, thẻ hồ sơ, đoạn trích dẫn mà trợ lý chèn thêm.
  - Ô lọc theo tên nhóm/người.

## [2.2.1] — 2026-10-09

### Sửa
- **Phân quyền nhóm không có tác dụng** với nhóm nằm trong danh sách cũ "Nhóm chỉ chủ nhân gọi được bot" (`owner_only_groups` trong config.yaml / `ZALO_OWNER_ONLY_GROUPS`): danh sách này chặn thành viên trước khi bot đọc phân quyền dashboard, và trang Phân quyền không hiện ra.
  - Nhóm đã phân quyền riêng trên dashboard: phân quyền đó thắng danh sách cũ (áp ngay, không cần khởi động lại).
  - Trang Phân quyền đánh dấu nhóm còn bị danh sách cũ chặn ("Chỉ chủ nhân (Cấu hình)") kèm giải thích; lưu nhóm đó (kể cả bằng mặc định) luôn giữ mục riêng để thắng danh sách cũ.
  - Ghi chú ở Cấu hình: nên chỉnh ở Phân quyền Bot.

## [2.2.0] — 2026-10-09

### Thay đổi
- **Kho tri thức gọn**:
  - Nguồn có sẵn (thư mục trên máy, kể cả Google Drive đồng bộ về máy; tệp `.url` là lối tắt link) chỉ hiện số tệp theo thư mục, không liệt kê từng tệp; tìm tệp khi cần.
  - Tài liệu tự tạo hiện từng tài liệu với nút **Chi tiết**: đổi tên, sửa nội dung `.md`/`.txt`, thay tệp, xoá.
  - Thêm **Viết tài liệu mới** ngay trên trang (lưu thành `.md`).
  - **Sửa nguồn** (chỉ Quản trị): chọn thư mục con bot được đọc, hoặc chuyển gốc trong danh sách người cài đặt cho phép (`ZALO_KB_ALLOWED_ROOTS`, cách nhau bằng `;`). Không nhận đường dẫn tự do. Lưu xong cần khởi động lại trợ lý.
- **Theo dõi agent gọn**: mỗi phiên một dòng (tên · lần cuối · số tin/công cụ); model và token nằm trong **Chi tiết**; mỗi lượt gập lại, bấm mới hiện công cụ và câu trả lời.
- Thêm cửa sổ chi tiết dùng chung (`<dialog>`): hỏi lại trước khi đóng bản đang sửa.

## [2.1.4] — 2026-10-09

### Bảo mật
- Lịch sử trò chuyện: bản nhập từ phiên Hermes cũ không bao giờ ghi đè tin đã bắt trực tiếp từ Zalo (trước đây ghi đè bằng prompt đã kẹp ngữ cảnh/trích dẫn), và bỏ đoạn trích dẫn "[Replying to …]" khi nhập.
- Tin bot đã thu hồi để lại dấu (băm phần đầu nội dung, không lưu chữ): bản sao nhập về sau từ Hermes cũ vào lịch sử ở dạng trống — sửa trường hợp bản sao xuất hiện sau khi đã thu hồi.

## [2.1.3] — 2026-10-09

### Bảo mật
- **Sổ người quen theo nơi ghi** — sự cố: tài sản chủ nhân khai ở một nhóm bị bot nhắc lại ở nhóm khác. Hồ sơ trước đây đi theo người nên được kẹp vào mọi cuộc trò chuyện. Nay mỗi mục hồ sơ nhớ nơi nó được nói (`scopes` trong people.json):
  - chỉ dùng lại ở đúng nhóm/tin nhắn riêng đó, và khi nhắn riêng với chính người đó (trừ điều người khác ghi về họ trong tin nhắn riêng của người khác);
  - mục cũ chưa có nơi ghi → chỉ dùng khi nhắn riêng với chính người đó; tên luôn dùng được;
  - `zalo_remember_person` / `zalo_recall_person` / `zalo_list_people` chỉ trả phần dùng được ở cuộc trò chuyện hiện tại; xem đủ cả sổ chỉ khi chủ nhân nhắn riêng với bot (không áp dụng cho việc hẹn giờ gửi vào tin nhắn riêng người khác); liệt kê trong nhóm không lộ ai có trong sổ;
  - sửa một mục trên dashboard thì mục đó chỉ còn dùng khi nhắn riêng (không đẩy giá trị mới sang nhóm cũ).
- Nhập lịch sử Hermes cũ không còn chép thẻ hồ sơ "[Người nhắn — …]" vào lịch sử trò chuyện (kể cả tin có trích dẫn trả lời).
- Bot thu hồi tin của chính nó → nội dung cũng bị xoá khỏi lịch sử (cả bản sao nhập từ Hermes cũ); nhập lại/backfill không khôi phục.

## [2.1.2] — 2026-10-09

### Sửa
- Dashboard › Trí nhớ › **Kho tri thức tự học** báo "Lỗi bên trong dashboard" (500) ở mọi máy: dashboard đọc `OPENVIKING_ENDPOINT` trong `.env` của Hermes nhưng khoá này chưa nằm trong danh sách khoá được phép đọc.
- **Insight nhóm › Tóm tắt AI** hỏng ("gọi AI lỗi … surrogates not allowed") khi nhóm có tin dài chứa emoji: dashboard cắt tin 300 ký tự theo đơn vị UTF-16 nên chẻ đôi emoji. Nay cắt theo ký tự; phía trợ lý cũng thay nửa ký tự lẻ bằng "?" thay vì làm hỏng cả lần tóm tắt (áp dụng cho cả tên nhóm).

## [2.1.1] — 2026-10-09

Bản lớn **Dashboard v2**: gom toàn bộ các bản 1.19.0 → 1.28.1 thành một mốc phiên bản mới. Không đổi mã so với 1.28.1; chi tiết từng phần xem các mục bên dưới.

### Điểm chính
- **Dashboard v2** (tiến trình riêng, 127.0.0.1:3880, đăng nhập bằng mã Zalo, vai trò Quản trị / Chủ bot): Tổng quan, Phiên chat (tìm trong phiên, Ảnh/Video·Tệp·Link), Nhật ký, Liên hệ, Lịch hẹn, Insight nhóm, Sức khoẻ máy chủ + cảnh báo Telegram, Mức dùng AI, thương hiệu, quét QR.
- **Phân quyền** theo từng nhóm và từng người (nhắn riêng), bật/tắt công cụ, studio sản phẩm (slide, tài liệu, đề/trò chơi, video) cho người ngoài với hạn mức mỗi ngày.
- **Trang quản trị**: Agent, Công cụ, Theo dõi agent, Kết nối MCP, Cấu hình (sửa config.yaml an toàn, có bản .bak).
- **Trí nhớ**: Kho tri thức, Second brain, và trí nhớ dài hạn OpenViking tách riêng từng nhóm/người (`zalo_memory`, chỉ Linux) + công cụ tra lịch sử trò chuyện `zalo_thread_history`; Kho tri thức tự học trên dashboard.

### Nâng cấp từ 1.x
- Không có thay đổi phá vỡ cho bản cài 1.28.x: cập nhật mã, chép lại plugin (`zalo`, `zalo_tools`, `memory/zalo_memory`) rồi khởi động lại sidecar, gateway và dashboard.
- Từ 1.18.x trở về trước: làm theo các mục "Thêm"/"Sửa" của từng bản 1.19.0 → 1.28.1 (permissions.json, dịch vụ dashboard, `ZALO_DASHBOARD_URL`).

## [1.28.1] — 2026-10-09

### Sửa
- Trí nhớ dài hạn: recall và "quên" bỏ nhầm mọi mục có dấu cách trong tên tệp — OpenViking đặt tên tệp trí nhớ bằng tiếng Việt có dấu cách (`…/events/2026/10/09/thiết lập mã bí mật.md`). Nay cho phép dấu cách thường; vẫn chặn `..`, `%`, `\`, `?`, `#`, ký tự điều khiển và các khoảng trắng khác (tab, xuống dòng, NBSP…).

## [1.28.0] — 2026-10-09

### Thêm
- Trí nhớ dài hạn OpenViking (tắt mặc định, chỉ Linux): provider `zalo_memory` — mỗi nhóm, mỗi người một kho riêng (`viking://user/zalo-g-…` / `zalo-u-…`, tài khoản `zalo`); recall mỗi lượt chỉ trong đúng kho đó; trợ lý tự rút trí nhớ theo chu kỳ (mặc định 120 phút, chỉnh ở dashboard).
- Công cụ chỉ chủ nhân `zalo_memory_remember` / `zalo_memory_forget`: "nhớ giúp…" / "quên chuyện… đi" ghi/xoá trong trí nhớ của chính cuộc trò chuyện đang nói.
- Công cụ `zalo_thread_history`: thành viên hỏi "hôm trước ai nói gì / ai gửi file X" thì bot tra lịch sử SQLite của chính nhóm/DM đó (≤30 ngày, ≤40 tin, 20 lần/giờ). Nút **Tra lịch sử trò chuyện** trong Phân quyền (mặc định bật).
- Dashboard › Trí nhớ › **Kho tri thức tự học** (Quản trị + Chủ bot): xem, tìm theo ý nghĩa, sửa, xoá từng mục, "Quên" cả một nhóm/người; Quản trị chỉnh chu kỳ rút và "Rút trí nhớ ngay"; mọi thao tác ghi Nhật ký.
- Bộ cài: chép plugin `zalo_memory` (không tự bật), `doctor` có dòng `long-term-memory`, gợi ý cách bật khi thấy OpenViking.

### An toàn
- Trí nhớ tin nhắn riêng của chủ nhân bot chỉ Quản trị thấy — chặn ở máy chủ dashboard, không chỉ ẩn ở giao diện.
- `zalo_memory` không chạy trên Windows, không chạy khi có `OPENVIKING_API_KEY`, tự tắt nếu plugin OpenViking của Hermes đổi cấu trúc; bot không có công cụ `viking_*`; không ghi kết quả công cụ; ngoài Zalo không gửi yêu cầu nào.
- Công cụ nhớ/quên lấy cuộc trò chuyện từ lượt đang chạy, không từ tham số; từ chối trong việc hẹn giờ; người không phải chủ nhân không gọi được.
- Lệnh sidecar `history_search` chỉ đọc kho, ép đúng hội thoại, bỏ tin chứa mã đăng nhập dashboard và tin thu hồi.
- Second brain tìm có `target_uri` (kho trí nhớ mới không chen vào kết quả).
- Lời từ chối công cụ cho thành viên gợi ý `zalo_thread_history` thay vì công cụ chỉ chủ nhân.

## [1.27.0] — 2026-10-09

### Thêm (chỉ Quản trị)

- **Agent**: đổi model (chỉ tên có trong danh sách của cổng AI, hiệu lực ngay như lệnh `/model`), mức suy nghĩ, tính cách SOUL.md — lịch sử 30 bản + bản gốc, khôi phục một chạm.
- **Công cụ**: mọi công cụ Zalo, ai dùng được, nút nào ở Phân quyền Bot điều khiển; tắt riêng từng công cụ công khai với người ngoài (`permissions.json` mục `tools.off`, hiệu lực ngay, chủ nhân luôn được dùng). Plugin ghi `zalo/tools-manifest.json` lúc nạp để dashboard đọc.
- **Theo dõi agent**: phiên của trợ lý (Zalo, việc hẹn giờ, tất cả) đọc từ `state.db` của Hermes — từng lượt, công cụ đã gọi (chỉ tên tham số và loại/độ dài, không giá trị), xong/lỗi, thời gian, token và model theo phiên; 50 phiên mỗi trang, nút "Xem phiên cũ hơn".
- **Kết nối MCP**: danh sách máy chủ MCP trong `config.yaml` (tên, kiểu, máy:cổng hoặc tên lệnh), có mở cho thành viên không (`ZALO_PUBLIC_MCP`), trạng thái, bật/tắt. Thêm mới vẫn làm trên máy chủ (`hermes mcp install`).
- **Cấu hình**: 13 cài đặt trong danh sách cố định (tag trong nhóm, nhắn riêng, báo đã xem, thả cảm xúc, nhóm chỉ chủ nhân, chống nhắn dồn ×3, kết bạn, mã xác nhận, thư mục kho tài liệu công khai, MCP cho thành viên, số ngày giữ lịch sử) — ghi vào đúng nơi đang có hiệu lực (`config.yaml` mục `platforms.zalo.extra` hoặc `.env` của Hermes); lời chào thành viên mới theo từng nhóm (`data/welcome.json`, hiệu lực ngay).
- Dải vàng "cần khởi động lại" dùng chung cho Agent, Kết nối MCP, Cấu hình + nút khởi động lại kèm lý do trong Nhật ký. Nhật ký có nhãn tiếng Việt cho mọi hành động mới.
- Thanh bên: "Kết nối MCP" ở nhóm Dữ liệu; "Agent", "Công cụ", "Theo dõi agent", "Cấu hình" ở nhóm Hệ thống. Chủ bot không thấy mục nào trong số này.

### An toàn

- Mọi đường dẫn mới chỉ Quản trị (kiểm ở máy chủ, Chủ bot nhận 403).
- `config.yaml` sửa theo dòng, phân tích lại cả tệp và từ chối nếu khoá khác bị đổi; `.bak`; ghi tệp tạm rồi đổi tên; trợ lý vừa ghi chen thì 409. `.env` chỉ khoá trong danh sách, giá trị không chứa nháy/`\`/xuống dòng/`#`/`=` nên không chèn được dòng khác; `.bak`.
- `state.db` mở chỉ đọc (`query_only`, chờ tối đa 1,5 giây); không đọc lời nhắc hệ thống, không hiện kết quả công cụ; câu hỏi/câu trả lời chỉ đoạn đầu, chuỗi trông như khoá bí mật bị che.
- Kết nối MCP: không bao giờ trả `env`, `headers`, `args`, đường dẫn/truy vấn của URL; chỉ dò TCP tới địa chỉ loopback (1,5 giây), máy ngoài không dò, máy chủ stdio không chạy để dò ("không kiểm được từ dashboard"); không có đường thêm máy chủ MCP.
- Cấu hình không bao giờ hiện hay sửa khoá ngoài danh sách; Nhật ký ghi theo từng mục "cũ → mới".

## [1.26.0] — 2026-10-08

### Thêm

- **Thanh bên theo dashboard mẫu**: Tổng quan · Hội thoại · Dữ liệu · Hệ thống · Quản trị; đường dẫn vị trí trên đầu mỗi trang; dòng phụ dưới tên thương hiệu (sửa ở Thương hiệu). Menu "Thêm" trên điện thoại chia theo nhóm.
- **Liên hệ**: bạn bè của bot, người đã nhắn riêng, người có hồ sơ; lời mời kết bạn đang chờ — Đồng ý / Từ chối ngay trên dashboard.
- **Lịch hẹn**: việc hẹn giờ của trợ lý gửi về Zalo (hẹn giờ nhóm và việc của chủ nhân) — tạm dừng, chạy lại, xoá; lời nhắc Zalo theo từng hội thoại — xem, xoá.
- **Trí nhớ**: sửa/xoá hồ sơ trong sổ người quen; Quản trị sửa/xoá từng mục bộ nhớ của trợ lý.
- **Kho tri thức**: danh sách tài liệu bot đọc được; tải lên .docx/.pdf/.md/.txt (≤ 10 MB) vào thư mục riêng; xoá tệp đã tải lên.
- **Insight nhóm**: tin theo ngày, người nhắn nhiều, giờ sôi nổi, loại tin; nút **Tóm tắt chủ đề** bằng AI (giới hạn lượt/ngày, `ZALO_INSIGHT_DAILY`, mặc định 10).
- **Second brain** (Quản trị, chỉ máy chủ Linux): tìm, xem và thêm ghi chú vào OpenViking trên cùng máy. Tắt mặc định; bật bằng `ZALO_SECOND_BRAIN_URL=http://127.0.0.1:1933` trong `.env` của Hermes. Máy Windows luôn tắt. Bộ cài gợi ý cách bật khi thấy OpenViking; `doctor` có dòng `second-brain`.
- Kết nối Zalo: `/control/friends`, `/control/friend-requests[/answer]`, `/control/reminders[/remove]` — có audit_log.

### An toàn

- Ghi people.json, MEMORY.md/USER.md: tệp tạm riêng, `.bak`, từ chối khi bot vừa ghi (409). Tải lên kiểm nội dung khớp đuôi, chỉ xoá trong `tai-len-dashboard`. OpenViking chỉ địa chỉ loopback, chỉ đọc trong 3 gốc, chỉ ghi mới. Tóm tắt AI không công cụ, chỉ chạy khi bấm.

## [1.25.1] — 2026-10-08

### Sửa

- Phiên chat: link Google Drive/Docs/Forms… mà Zalo gửi dưới dạng "chat.recommended" không còn hiện nhầm là "[Danh thiếp] Mở danh thiếp" — giờ hiện đúng tên trang ("[Google Drive]") kèm đường dẫn rút gọn bấm được. Chỉ danh thiếp thật mới ghi "Danh thiếp".

## [1.25.0] — 2026-10-08

### Thêm

- **Phiên chat — tìm trong hội thoại:** nút kính lúp trên đầu khung tin mở bảng tìm chỉ trong hội thoại đang mở (không phân biệt hoa thường và dấu, tô sáng chỗ trùng, 30 kết quả mỗi trang). Bấm một kết quả thì khung tin tải đoạn quanh tin đó, cuộn tới và viền vàng tin; kéo xuống tải tiếp tin mới hơn, hoặc bấm **Về tin mới nhất**.
- **Phiên chat — bảng Ảnh/Video · Tệp · Link** giống Zalo: lưới ảnh (bấm để xem lớn, video mở ở thẻ mới), danh sách tệp có nút **Tải về**, danh sách link (thẻ link và link trong chữ, bỏ link ảnh/tệp của Zalo). Máy tính: bảng nằm bên phải; điện thoại: phủ cả màn hình.
- **Phiên chat — ảnh, tệp, video ngay trong khung tin:** ảnh thu nhỏ bấm để xem lớn (← → chuyển ảnh, Esc đóng), thẻ tệp có nút **Tải về**, thẻ video có nút phát.
- API mới: `GET /api/chats/:threadId/search`, `GET /api/chats/:threadId/media?kind=photo|file|link`, `GET /api/chats/:threadId/messages?around=` / `?after=`, `GET /api/media/img?u=`.

### An toàn

- Ảnh đi qua dashboard (`/api/media/img`) vì CSP chỉ cho ảnh cùng nguồn. Chỉ nhận https và tên miền con của `zdn.vn`/`zadn.vn`; tự phân giải tên máy, từ chối nếu có địa chỉ nội bộ/máy mình/link-local rồi nối thẳng vào đúng IP đã kiểm (giữ SNI và kiểm chứng chỉ); chuyển hướng tối đa 2 lần, mỗi lần kiểm lại; quá hạn 10 giây; tối đa 5 MB đọc dần; chỉ jpeg/png/webp/gif và byte đầu tệp phải đúng loại; trả kèm `Cache-Control: private, max-age=3600`, `nosniff`, `Content-Security-Policy: default-src 'none'`; mỗi người tối đa 4 ảnh cùng lúc và 120 ảnh/phút, cả dashboard tối đa 6 ảnh cùng lúc (giữ RAM của VPS). Chặn thêm IPv4-compatible (`::/96`), NAT64 cục bộ (`64:ff9b:1::/48`), Teredo (`2001::/32`). Không đệm ảnh trên máy chủ; đăng xuất gửi `Clear-Site-Data: "cache"` để trình duyệt xoá ảnh đã đệm.
- Tệp và video không bao giờ đi qua dashboard: chỉ là link ngoài mở thẻ mới (`rel="noopener noreferrer"`), và chỉ khi là https trên máy chủ tệp/video của Zalo.

## [1.24.0] — 2026-10-08

### Thêm

- **Xưởng tạo sản phẩm:** người không phải chủ nhân nhờ bot làm slide PowerPoint có ảnh AI/ảnh web, giáo án 5512, văn bản NĐ30/Đoàn/Đảng, đề kiểm tra, đề KHTN tiếng Anh, SKKN, 6 loại trò chơi, thí nghiệm ảo, video giải thích (viết tay, cắt dán, Vox) và video bài giảng từ slide bằng 2Anh Studio; bot tự gửi tệp vào đúng cuộc trò chuyện. Công cụ mới `zalo_studio`.
- **Văn bản Đoàn** dựng bằng bộ sinh cố định theo thể thức của skill `soan-van-ban-doan` và được bộ kiểm của skill soát.
- **Dashboard:** hộp "Xưởng tạo sản phẩm" (4 nút) ở Mặc định, từng nhóm, Nhắn riêng và từng người; mục **Hạn mức xưởng** (hạn mức riêng từng người thắng số của nhóm, số của nhóm thắng số mặc định); Sức khoẻ máy chủ hiện lượt dùng, token và số ảnh xưởng theo người.
- Plugin ghi `studio-policy.json` ngay lúc nạp để dashboard khoá nút Video đúng từ đầu (trước đây chỉ ghi sau lần nhờ xưởng đầu tiên).

### Trả lượt

- Chỉ trả lượt khi việc hỏng vì **lỗi máy chủ** và **chưa tốn gì** (không ảnh, token dưới ngưỡng nhỏ); mỗi người mỗi ngày được trả **tối đa bằng số lượt hạn mức** của mình. Việc hỏng vì nội dung, hoặc sau khi đã tốn token/ảnh, vẫn tính lượt.
- Gateway khởi động lại giữa việc: sổ lượt ghi dần token/ảnh nên việc đã tốn bị ghi `failed` và tính lượt; việc chưa tốn gì được trả lượt (vẫn chịu trần trả mỗi ngày). Trước đây mọi việc dở đều được trả lượt.

### An toàn

- AI viết nội dung cho xưởng không có công cụ nào và chỉ được xin ảnh; ảnh do mã cố định vẽ/tải (chỉ https, chặn địa chỉ nội bộ, nối thẳng IP đã kiểm, kiểm byte đầu, có trần số ảnh). Bộ dựng là script cố định chạy trong tiến trình con không có khoá; trên Linux trong hộp cát systemd (user `nobody`, không thấy `/root`). Tệp gửi trả chỉ vào đúng cuộc trò chuyện người nhờ.
- Nút xưởng thiếu hoặc đọc lỗi = tắt. Máy Windows: video luôn tắt.
- Hộp cát bước có mạng (đọc giọng) vẫn chặn `localhost`, mạng nội bộ và địa chỉ của chính máy chủ, nhưng nay cho phép DNS: `IPAddressAllow` cho stub `127.0.0.53` và các máy chủ DNS trong `/etc/resolv.conf` chỉ khi chúng nằm ở dải bị chặn (không bao giờ mở loopback khác, địa chỉ máy chủ hay địa chỉ metadata đám mây). Bước không mạng không đổi.
- Khởi tạo xưởng dừng các đơn vị `zalo-studio-*` còn sống sau khi gateway khởi động lại và xoá thư mục việc mồ côi (chỉ thư mục đúng dạng mã việc).

### Sửa

- Nút Video bị chính sách máy chủ khoá nay gửi `studioVideo: false` khi lưu, giao diện và giá trị lưu khớp nhau.
- Lời gợi ý hạn mức nói rõ hạn mức riêng từng người thắng số của nhóm và số mặc định ("0 = không ai trong nhóm được nhờ, trừ người có hạn mức riêng").

### Kiểm thử

- 597 test JS (593 qua, 4 bỏ qua trên Windows, 0 hỏng) và 420 test Python, đều xanh.

## [1.23.1] — 2026-10-07

### Sửa (giao diện dashboard, rà theo UI/UX Pro Max)

- **Nhắn riêng gọn lại:** chia 3 hộp (Ai được nhắn · Tính năng chung · Danh sách người). Mỗi người là một dòng gập có tóm tắt ("Riêng · 2 tính năng tắt"), bấm "Chỉnh" mới mở, mỗi lúc chỉ mở một người; ô thêm người gập sẵn; có lọc theo tên/UID và "Có chỉnh riêng". Trang 20 người từ ~6700px còn ~1900px.
- **Thanh Lưu dính đáy** ở Phân quyền (nhắn riêng và nhóm): luôn thấy số thay đổi chưa lưu, có nút Hoàn tác. Cột danh sách nhóm đứng yên khi cuộn; khung nhóm chia 2 cột.
- **Điện thoại:** thanh trên còn 4 mục chính + "Thêm ▾"; vùng bấm tối thiểu 44px; tiêu đề hội thoại không còn vỡ dòng.
- **Nhật ký** viết thành câu dễ hiểu, chi tiết kỹ thuật gập vào "Chi tiết kỹ thuật", chỉ đánh dấu dòng lỗi.
- **Sức khoẻ máy chủ:** dưới 4 ngày dữ liệu AI thì chỉ hiện số, biểu đồ 24 giờ có nhãn trục dọc và ghi rõ đã có dữ liệu bao lâu.
- Chữ nhỏ nhất nâng lên 12,5px; phần bị tắt không còn làm mờ chữ giải thích; thẻ Tổng quan không còn khoảng trắng lớn.

## [1.23.0] — 2026-10-07

### Thêm

- **Dashboard: Nhắn riêng** trong Phân quyền Bot. Chọn ai được nhắn riêng với bot (chỉ chủ nhân, chủ nhân và một danh sách người, hoặc mọi người), bật/tắt 8 tính năng khi nhắn riêng, và tính năng riêng cho từng người trong danh sách. Lưu là có hiệu lực ngay; chủ nhân luôn được miễn. Chưa lưu thì bot vẫn theo `ZALO_DM_POLICY`. Trang báo vàng khi chọn cho người ngoài nhắn mà `.env` thiếu `ZALO_ALLOW_ALL_USERS=true`.
- **Dashboard: Sức khoẻ máy chủ.** CPU, RAM, ổ đĩa, thời gian chạy và biểu đồ 24 giờ; trạng thái các dịch vụ của bot; lượt gọi AI và token theo ngày lấy từ `state.db` của Hermes (không có chi phí bằng tiền). Chạy trên cả VPS Linux và máy Windows.
- **Cảnh báo Telegram khi máy chủ quá tải**: ổ đĩa trên 90 %, RAM trên 90 % suốt 5 phút, CPU bận trên 90 % suốt 10 phút — báo một lần, nhắc lại sau 6 giờ, báo khi bình thường lại; mỗi loại cảnh báo có gợi ý xử lý riêng.

### An toàn

- Quyền nhắn riêng được kiểm ở hai lớp: plugin Hermes (cửa vào tin nhắn và công cụ) và kết nối Zalo (lớp thứ hai, từ chối lệnh gửi ra cho lượt của người không được phép). Đọc quyền lỗi thì quay về `ZALO_DM_POLICY`, không bao giờ mở rộng hơn.
- Trang Sức khoẻ máy chủ chỉ chạy lệnh đọc (`systemctl list-units`) trên Linux, không chạy lệnh nào trên Windows; tên dịch vụ hệ thống chỉ Quản trị thấy.
- Phải cập nhật cùng lúc plugin Hermes, kết nối Zalo và dashboard; dashboard cũ lưu phân quyền sẽ làm rơi mục `dm`.

## [1.22.0] — 2026-10-07

### Thêm

- **Dashboard: Thương hiệu.** Đổi tên, logo và màu; 6 màu gợi ý hoặc nhập mã, kiểm chữ trắng đọc được (≥ 4,5 : 1); xem trước thanh bên và trang đăng nhập trước khi lưu; bật/tắt dòng "Vận hành bởi 2Anh AI"; khôi phục mặc định. Trang đăng nhập hiện thương hiệu ngay khi chưa đăng nhập. Quản trị và Chủ bot đều chỉnh được; mọi lần đổi ghi vào Nhật ký.
- **Dashboard: Chủ nhân bot** (chỉ Quản trị). Thêm/bỏ UID chủ nhân ngay trên dashboard, kèm tên Zalo của từng người; không bao giờ để bot mất chủ nhân cuối cùng. Lưu xong có dải vàng nhắc khởi động lại trợ lý — nút khởi động lại áp dụng cho cả kết nối Zalo lẫn trợ lý. Nếu `.env` riêng của bot cũng ghi danh sách chủ nhân (và đang đè lên), trang báo đỏ.
- **Người dùng** có cột "Đăng nhập gần nhất".

### Sửa

- Thẻ "Lỗi gần nhất" ở Tổng quan nói rõ chuyện gì xảy ra và nên làm gì, thay cho câu chung "xem log cục bộ"; Quản trị thấy thêm mã lỗi.
- Thanh bên cao đủ chiều cao màn hình.
- Nút chọn tệp ảnh hiện tiếng Việt.
- Thanh trên cùng trên điện thoại không còn giãn/nổi lơ lửng ở trang ngắn.

### An toàn

- Logo chỉ lưu dạng PNG ≤ 256 px đã kiểm từng byte, không nhận SVG; logo và màu phục vụ cùng nguồn, giữ nguyên chính sách bảo mật nội dung (CSP).
- Dashboard chỉ đọc và sửa đúng dòng `ZALO_ALLOWED_USERS` trong `.env` của Hermes, giữ bản trước ở `.env.bak`.

## [1.21.0] — 2026-10-07

### Thêm

- **Dashboard: Phân quyền Bot theo nhóm.** Mỗi nhóm có công tắc Hoạt động, Chỉ trả lời khi được tag và 9 tính năng (tra cứu web, gửi và tạo tệp, tin nhắn thoại, nhắc hẹn, hẹn giờ cho nhóm, kho tài liệu, sổ người quen, tra cứu học thuật, video); có mục Mặc định — nhóm chỉnh riêng chỉ giữ những mục khác mặc định, mục còn lại đi theo Mặc định. Quản trị và Chủ bot đều chỉnh được; mọi lần lưu ghi vào Nhật ký. Trang cảnh báo khi rời đi lúc còn thay đổi chưa lưu.
- **Bot áp dụng phân quyền ngay khi lưu**, không cần khởi động lại: công cụ được kiểm tra đúng lúc gọi, và lượt của thành viên kèm một dòng "Nhóm này đang tắt: …" liệt kê tính năng đang tắt, nên bot không hứa việc mình không được làm; chủ nhân không bao giờ bị chặn. Tắt "Hẹn giờ cho nhóm" chỉ chặn tạo việc mới.
- **Nhóm tắt "Hoạt động":** bot bỏ qua tin của thành viên (không trả lời) nhưng vẫn giữ làm ngữ cảnh khi chủ nhân hỏi. Việc hẹn giờ do thành viên tạo không còn gửi tin chữ vào nhóm đang tắt; muốn dừng hẳn, nhờ chủ nhân xoá việc đó. Việc chủ nhân hẹn vẫn gửi.

### Sửa

- Hồ sơ người quen giờ thực sự được nạp (trước đó lệnh nạp mô-đun bị sai nên hồ sơ không bao giờ hiện).
- Hồ sơ người quen được đóng khung là thông tin do chính người đó tự khai, không phải sự thật đã kiểm chứng.
- `permissions.json` có BOM (ví dụ lưu bằng Notepad) vẫn đọc được.
- Bản cài dở (chỉ cập nhật một phần tệp plugin) vẫn trả lời bình thường thay vì im lặng.
- Tắt một tính năng trong nhóm không còn âm thầm đổi cách trả lời khi được tag: dashboard đọc cờ `ZALO_GROUP_REPLY_ONLY_TAGGED` đúng chỗ bot đọc (`.env` và `config.yaml` của Hermes), lần lưu đầu ghi cờ đó vào Mặc định một lần, không ghi vào từng nhóm. Tệp đã lưu bằng bản trước được dọn khi lưu lại mà không đổi hành vi.
- Dashboard cũng đọc được `permissions.json` có BOM.
- Nhóm tắt "Sổ người quen": bot không kèm hồ sơ người nhắn vào lượt của thành viên; câu từ chối công cụ không gợi ý công cụ thuộc tính năng đang tắt.
- Bot không đọc được `permissions.json` vì quyền tệp thì log ERROR nói rõ, không gọi là tệp hỏng; `npm run doctor` trên Linux cảnh báo khi user chạy hermes-gateway không đọc được tệp này.
- Lưu phân quyền trên Windows thử lại khi tệp đang bị khoá tạm.

### An toàn

- Không có `permissions.json` → bot hoạt động y như bản trước. Tệp hỏng → bot dùng mặc định (mọi tính năng bật) và ghi cảnh báo, không bao giờ im lặng.

## [1.20.0] — 2026-10-07

### Thêm

- **Dashboard: Phiên chat.** Danh sách hội thoại, tìm trong nội dung tin nhắn (không phân biệt hoa thường và dấu: "hoc sinh" thấy "học sinh"), cuộn lên để xem tin cũ, xem tin với tin của bot bên phải, nhắn tay dưới tên bot (tối đa 10 tin/phút mỗi người, chỉ vào hội thoại đã có). Đọc lịch sử ở chế độ chỉ đọc nên kết nối Zalo tắt vẫn xem được.
- **Dashboard: Nhật ký.** Gộp việc bot làm và việc làm trên dashboard: lúc nào, ai, làm gì, ở đâu, kết quả; lọc "chỉ lỗi". Chủ bot thấy nhãn dễ hiểu, Quản trị thấy thêm mã kỹ thuật.
- **Tổng quan:** thẻ "Tin nhắn hôm nay" (nhận/gửi tính từ 0 giờ giờ Việt Nam) và 5 nhóm sôi nổi nhất.

### Sửa

- Nhật ký hoạt động của dashboard bỏ qua dòng hỏng thay vì báo lỗi.
- Nhật ký kiểm toán ghi lần đăng nhập thất bại bằng tên tài khoản không có thật là "Người lạ", không hiện chữ đã gõ.
- Mã đăng nhập không bao giờ hiện ra trên dashboard.

## [1.19.0] — 2026-10-07

### Thêm

- **Dashboard quản trị (giai đoạn 1).** Trang web riêng, chỉ nghe `127.0.0.1` (mặc định cổng 3880): xem tình trạng bot, quét lại mã QR Zalo, tạo tài khoản cho khách, đăng nhập bằng mã gửi qua Zalo, cảnh báo qua Telegram.
- **Bộ cài tự cài dịch vụ dashboard.** Linux có root và systemd: ghi `zalo-dashboard.service` rồi bật ngay. Windows: thêm `zalo-dashboard.vbs` chạy ẩn vào thư mục Startup. Không cài được thì in hướng dẫn chạy tay, không làm hỏng lần cài. Bỏ qua bằng `--no-dashboard`.
- Bộ cài in link thiết lập tài khoản Quản trị đầu tiên (dùng một lần, 24 giờ) và khối Caddy khi `ZALO_DASHBOARD_URL` là `https://…`.
- `npm run doctor` thêm ba mục cảnh báo: `dashboard-running`, `dashboard-admin`, `dashboard-telegram`.
- `npm run uninstall:hermes` gỡ cả dịch vụ dashboard (giữ nguyên dữ liệu).
- Biến tuỳ chọn mới trong `.env`: `ZALO_DASHBOARD_PORT`, `ZALO_DASHBOARD_URL`, `ZALO_SIDECAR_RESTART_CMD`, `ZALO_ASSISTANT_RESTART_CMD`.

### Sửa

- Giãn nhịp tự nối lại kết nối Zalo khi nó chết (5 s → 5 phút), tránh khởi động lại dồn dập; bị Zalo đá phiên (mã 3000/3003) thì đánh dấu "cần quét QR lại" thay vì thử mãi.
- Bị Zalo đá phiên thì quét QR lại được ngay, không phải khởi động lại bot.
- Canh gác 30 giây: Zalo mất phiên → báo sau 2 phút; bot ngừng nhận tin quá 10 phút → báo; kết nối Zalo treo → tự khởi động lại một lần rồi báo; hồi phục → báo.
- Tin nhắn chứa mã đăng nhập dashboard không bị lưu vào lịch sử chat.

## [1.18.0] — 2026-10-06

### Thêm

- **`zalo_academic_search` có thêm nguồn và việc mới, ai trong nhóm cũng dùng được.**
  - `source=openalex`: phủ rộng mọi ngành, có số trích dẫn, link PDF mở và tóm tắt.
  - `source=core`: bài toàn văn từ kho lưu trữ của các trường đại học.
  - `action=find_pdf`: tìm bản PDF miễn phí hợp pháp của một DOI, lấy từ OpenAlex (cùng dữ liệu
    Unpaywall, không cần email) và CORE; bỏ qua các bản phải trả phí.
  - `action=fulltext`: đọc toàn văn bài trên PubMed Central theo DOI hoặc PMCID.
  - `action=journal`: tra tạp chí trên DOAJ theo ISSN hoặc tên, gồm phí đăng bài, giấy phép và
    hình thức bình duyệt. Tra theo tên chỉ tính là có trong DOAJ khi trùng đúng tên.
- Khoá tuỳ chọn `CORE_API_KEY`, `OPENALEX_API_KEY` trong `.env` của Hermes. Không có khoá vẫn chạy,
  chỉ ít lượt hơn. Bị giới hạn lượt (HTTP 429) thì báo người dùng thử lại sau.

### Sửa

- DOAJ chặn mọi User-Agent có chữ "bot", nên lời gọi DOAJ dùng User-Agent riêng.

## [1.17.0] — 2026-10-05

### Thêm

- **Lệnh `/model` cho chủ nhân, gõ ngay trong Zalo.** `/model` cho xem model đang dùng; `/model list`
  hiện danh sách chọn nhanh (`ZALO_MODEL_CHOICES`), `/model list all` hoặc `/model list <chữ>` lấy từ
  `<base_url>/models`; `/model <tên>` đổi model, `/model default` quay về `ZALO_MODEL_DEFAULT`.
  Lệnh đổi model cho cả bot bằng cách chỉ sửa dòng `model.default` trong `config.yaml`, giữ nguyên
  chú thích. Gateway tự đọc lại config, nên mọi nhóm chạy model mới từ tin tiếp theo. Tên model
  không có trên endpoint, hoặc endpoint không trả lời, thì bot từ chối và không sửa gì.

### Đổi

- `/model` gõ trong Zalo không còn tới lệnh `/model` gốc của Hermes (lệnh đó đổi theo phiên).
  Người không phải chủ nhân gõ `/model` thì bot bỏ qua.

## [1.16.0] — 2026-09-30

### Thêm

- **Kết bạn theo lệnh chủ bot, và "kết bạn xong thì lập nhóm".** Ba công cụ chỉ chủ nhân, nằm sau
  công tắc `ZALO_FRIEND_TOOLS` (mặc định tắt): `zalo_send_friend_request`,
  `zalo_accept_friend_request` và `zalo_friend_group`. Với `zalo_friend_group`, sidecar
  (`zalo-friends.js`) gửi lời mời rồi giữ kế hoạch ở `data/friend-groups.json`: người đầu tiên đồng
  ý thì tạo nhóm ngay gồm người đó và chủ nhân, ai đồng ý sau được thêm vào, kết quả báo lại đúng
  cuộc trò chuyện đã ra lệnh. Nghe sự kiện `friend_event` của zca-js và cứ 10 phút hỏi lại
  `getFriendRequestStatus`; kế hoạch hết hạn sau 30 ngày. Lập kế hoạch cần mã xác nhận khi bật
  `ZALO_CONFIRM_DANGEROUS`.
- **Lời mời kết bạn người lạ gửi tới bot không bao giờ tự đồng ý** — khi bật công tắc, bot nhắn riêng
  báo chủ nhân (mỗi người một lần trong 12 giờ).

### Đổi

- Lời mời kết bạn, tạo nhóm và thêm người của kế hoạch đều xin lượt từ bộ giới hạn nhịp như lệnh
  thường (`acquireSendQuota`); lệnh kết bạn bị tắt không trừ hạn mức. Kế hoạch được lưu trước rồi
  gửi lời mời nền, nên danh sách dài không làm quá hạn ack và bị lập lại; kế hoạch trùng bị từ chối.

## [1.15.2] — 2026-09-29

### Sửa

- **Bot không gửi được ảnh.** zca-js bắt buộc có `imageMetadataGetter` trong options của
  `new Zalo(...)`; sidecar chưa truyền nên mọi lần gửi ảnh nổ `ZaloApiMissingImageMetadataGetter`
  trước khi kịp gọi Zalo. Thêm `image-metadata.js` đọc kích thước PNG/JPEG/GIF/BMP/WebP từ header
  (không thêm dependency), truyền vào qua `zaloOptions()` ở cả đăng nhập QR lẫn kết nối lại.

## [1.15.1] — 2026-09-28

### Sửa

- **Lời chào có tag bị Zalo từ chối không được gửi lại dạng chữ thường.** Biểu thức kiểm mã lỗi
  trong `sendSystemNotice` thiếu dấu `\` (`/^-?d+$/`) nên không bao giờ khớp mã số của Zalo.

## [1.15.0] — 2026-09-28

### Thêm

- **Chào thành viên mới theo đợt, có tag tên.** Sidecar nghe sự kiện vào nhóm và, ở những nhóm
  chủ bot đã bật, gom người mới lại: đủ `batchSize` người (mặc định 5) thì gửi một tin tag tên tất
  cả kèm lời chào; chưa đủ thì sau `maxWaitMinutes` (mặc định 15) vẫn gửi cho những người đã vào.
  Lời chào là chữ cố định chủ bot duyệt, không qua LLM. Cấu hình lưu ở `data/welcome.json`
  (đổi chỗ bằng `ZALO_WELCOME_FILE`), sửa qua công cụ chỉ chủ nhân `zalo_group_welcome` — lệnh
  bridge `welcome_config` cũng chỉ nhận vai chủ nhân. Zalo từ chối tag thì gửi lại chữ thường.

## [1.14.2] — 2026-09-27

### Sửa

- **Thẻ màu trong câu in nghiêng lộ nguyên văn.** Phần trong `*…*` / `_…_` bị chép thẳng, không
  dịch markup bên trong — tin thật ngày 27/9 hiện "[orange]Hải Phòng[/orange]" và cả dấu ` quanh
  chữ. Nay in nghiêng dịch màu, `mã`, liên kết bên trong như in đậm.

### Đổi

- **Hướng dẫn màu chữ chuyển từ "hạn chế" sang "phải có ở đúng chỗ":** tin có nội dung thông tin
  (tóm tắt, thông báo, hướng dẫn, giới thiệu, danh sách) phải có 2–5 chỗ tô màu ở hạn chót, con số
  chính, trạng thái, điều kiện, lưu ý; kèm ví dụ một bản tóm tắt đúng mức. Chỗ đã tô màu thì bỏ in
  đậm ở chính cụm đó.

## [1.14.1] — 2026-09-27

### Sửa

- **Tin sát trần có tag nhiều người không còn mất định dạng.** Ngân sách 3000 byte mỗi tin chỉ tính
  chữ và định dạng, còn tag `@Tên` được gắn sau khi cắt (~50 byte mỗi tag). Tin gần đầy mà tag
  nhiều người có thể vượt ngưỡng, bị Zalo từ chối rồi gửi lại dạng chữ trơn — mất cả màu, in đậm
  lẫn tag. Nay mỗi "@" được giữ chỗ 60 byte khi cắt tin.

### Đổi

- **Hướng dẫn trình bày mặc định có quy ước màu chữ theo ngữ cảnh:** đỏ cho cảnh báo, hạn chót,
  việc bắt buộc; xanh cho đã xong/đạt/đúng; cam cho lưu ý, đang chờ. Chỉ tô cụm ngắn, tối đa ~5
  chỗ mỗi tin, không vừa in đậm vừa tô màu cùng một cụm. Mục độ dài ghi đúng trần ~3000 byte tính
  cả định dạng. Khách đã tự viết hướng dẫn riêng thì trình cài giữ nguyên bản của khách.

## [1.14.0] — 2026-09-26

### Thêm

- **Video không có phụ đề vẫn tóm tắt được.** `zalo_video_info` không tìm thấy phụ đề thì tải
  riêng phần âm thanh (mp3 mono 16 kHz, nhỏ) rồi chép lời bằng **chính STT Hermes đang cấu hình**
  (`transcribe_audio`) — Whisper cục bộ, Groq, OpenAI hay một router đều chạy như nhau, plugin
  không gắn cứng nhà cung cấp nào. Người trong nhóm: video ≤ 20 phút; chủ nhân ≤ 40 phút; cả bot
  mỗi lúc chép một video. Vẫn qua đủ các lớp chặn của tải video (dò `-J`, không livestream/danh
  sách phát, nguồn tải không trỏ vào mạng nội bộ). Kết quả ghi rõ "chép tự động từ âm thanh".
- **PDF bản quét đọc được.** PDF không rút được chữ thì adapter dựng 5 trang đầu thành ảnh JPEG
  (cạnh dài ≤ 1800 px, trong tiến trình con có hạn giờ 60 giây) và gửi kèm tin như ảnh chụp, để
  mô hình đọc bằng thị giác — không cần dịch vụ OCR hay khoá nào thêm. Prompt ghi rõ "bản quét,
  N/M trang đầu gửi kèm dưới dạng ảnh". Tối đa 5 ảnh trang cho cả lượt; mỗi tệp chỉ dựng một lần
  (nhớ theo sha256 — tệp trong ngữ cảnh nhóm không bị dựng lại mỗi lần có người tag bot); cả bot
  tối đa 2 việc dựng cùng lúc, hết chỗ thì bỏ qua.
- Chép lời: khoá chỉ nhả khi luồng chép lời thật sự xong (tối đa 10 phút), âm thanh tải về ≤
  150 MB, lỗi chi tiết của STT chỉ ghi log — người dùng nhận thông báo chung.

## [1.13.0] — 2026-09-26

### Thêm

- **Người trong nhóm hỏi y tế, khoa học là bot tra bài báo đã bình duyệt.** Công cụ công khai
  mới `zalo_academic_search`: PubMed (y sinh, kèm tóm tắt), Crossref (mọi ngành) và tạo trích
  dẫn chuẩn từ DOI (APA, IEEE, Vancouver, Harvard, Chicago, MLA). Mô tả công cụ dặn bot dùng nó
  TRƯỚC web search cho câu hỏi sức khoẻ/thuốc/bệnh, trả lời kèm tác giả (năm) và link, chỉ dẫn
  bài công cụ trả về, và nhắc gặp bác sĩ khi cần.
- Chỉ đọc, không cần khoá, chỉ gọi ba địa chỉ cố định (NCBI, Crossref, doi.org). Không giới hạn
  lượt theo người; mọi lời gọi NCBI đi qua một nhịp chung ~2,5 lần/giây để cả bot không bị NCBI
  chặn (giới hạn của họ là 3 lần/giây mỗi IP khi không có khoá).

## [1.12.0] — 2026-09-26

### Thêm

- **Người trong nhóm nhờ bot chuyển PDF sang Word, gộp và tách PDF.** Công cụ công khai mới
  `zalo_pdf` (`to_word`, `merge`, `split`): làm trên tệp PDF người dùng gửi — tin vừa gửi, tin
  được reply, hoặc vài tin ngay trước đó khi câu hỏi nhắc "file/pdf/gộp/tách/vừa gửi" — rồi gửi
  kết quả vào **đúng nhóm đang chat** và xoá tệp tạm. Công cụ không nhận đường dẫn từ mô hình:
  adapter ghi danh sách tệp của lượt vào turn, công cụ chỉ chọn theo số thứ tự ("PDF số 1, 2…"
  ghi sẵn trong prompt). Tin gửi tiếp của cùng người khi bot đang bận cũng được gom vào.
- Giới hạn: chỉ trong nhóm (nhắn riêng chưa hỗ trợ), mỗi người 5 lần/giờ (chủ nhân không giới
  hạn), cả bot mỗi lúc một việc PDF; tệp ≤ 30 MB, ≤ 500 trang, sang Word ≤ 60 trang, gộp ≤ 10
  tệp. Chỉ nhận tệp có chữ ký `%PDF-`; tệp có mật khẩu hay bản quét ảnh được báo rõ.
- **Chống PDF làm treo máy:** việc nặng chạy trong tiến trình con, quá 120 giây hoặc lượt bị huỷ
  thì giết cả cây; số trang kiểm ngay lúc mở; pdf2docx báo lỗi thay vì âm thầm bỏ trang hỏng.
- Cần `uv pip install --python <venv Hermes> pymupdf pdf2docx`; `npm run doctor` báo thiếu.

## [1.11.1] — 2026-09-26

### Bảo mật

- **Người trong nhóm không còn gọi được công cụ MCP mặc định.** Hermes cấp mọi MCP server cho
  mọi nền tảng, và từ 1.4.1 lớp chặn của plugin cho người ngoài gọi mọi công cụ MCP — cắm một
  server dọn ổ đĩa, chạy Apify tốn tiền hay đọc Gmail là người lạ trong nhóm gọi được ngay.
  Nay mặc định chặn; chủ nhân mở từng server/công cụ bằng `ZALO_PUBLIC_MCP` trong `.env` của
  Hermes (tên server `rag`, toolset `mcp-rag`, tên công cụ, cho phép glob; `*` là mở hết như
  cũ). Không đọc được hồ sơ bí mật (multiplex không có scope) thì coi như không mở gì. Chủ
  nhân vẫn dùng mọi MCP như trước.
- **Nâng cấp:** ai đang cho nhóm dùng một MCP server (vd. kho RAG) cần thêm
  `ZALO_PUBLIC_MCP=<tên server>`. `npm run doctor` liệt kê server đang cấu hình và server nào
  đã mở cho nhóm.

## [1.11.0] — 2026-09-26

### Thêm

- **Người trong nhóm nhờ bot đọc và tải video.** Hai công cụ công khai mới:
  - `zalo_video_info` — đọc tiêu đề, kênh, thời lượng, mô tả và phụ đề/lời thoại của video
    YouTube, TikTok, Facebook, Instagram, X, Vimeo, Dailymotion để bot tóm tắt. Không tải
    video. Video không có phụ đề thì bot được dặn chỉ tóm tắt từ tiêu đề/mô tả, không đoán.
  - `zalo_video_download` — tải video Full HD (cạnh ngắn ≤ 1080, TikTok không logo, ưu tiên
    h264/AAC để Zalo phát được), gửi vào **đúng nhóm đang chat**, gửi xong xoá tệp.
- **Chỉ tải khi người dùng thật sự yêu cầu:** tin nhắn chính tay họ gõ phải có cụm như
  “tải video/về/giúp”, “download”, “gửi file video” (bỏ qua chữ trong link; “quá tải”, “tải
  lên” không tính). Nội dung trang web hay mô tả video cài lệnh không kích hoạt được.
- Giới hạn cho người trong nhóm (chủ nhân chỉ chịu giới hạn dung lượng): video ≤ 20 phút và
  ≤ 300 MB, mỗi người 3 lượt tải/giờ (tải hỏng cũng tính) và 20 lượt đọc video/giờ, cả bot
  mỗi lúc tải một video. Không tải livestream, danh sách phát hay cả kênh — với mọi người.
- Cần `uv pip install --python <venv Hermes> "yt-dlp[default,curl-cffi]" youtube-transcript-api`
  và ffmpeg; Node (đã có sẵn cho sidecar) để giải mã YouTube. `npm run doctor` báo thiếu.

### Sửa

- **Link Google Sheets/Docs/Slides công khai đọc được.** `zalo_web_read` trước chuyển link
  sang đường `/export` rồi nhờ `web_extract` đọc, nhưng dịch vụ đọc trang trả “Content was
  inaccessible” dù tài liệu công khai — nhóm gửi sheet mà bot báo không đọc được. Nay bot tải
  thẳng bản xuất văn bản; tài liệu chưa bật chia sẻ thì báo rõ lý do. Tệp Drive (`/file/d/`)
  giữ đường cũ.
- **Trang web `web_extract` không đọc được thì bot tự tải và bóc chữ**, qua HTTP client chống
  SSRF của Hermes (kiểm IP lúc mở kết nối và sau mỗi lần chuyển hướng, không theo proxy môi
  trường, tối đa 3 MB / 30 giây).

## [1.10.11] — 2026-09-25

### Sửa

- **Một link hỏng không còn làm bot “im lặng”.** Ngày 25/9 một link `https://…/jev-ultrafast.git`
  trong thẻ chia sẻ bị coi là tệp đính kèm; bot tải mãi không xong, mà vòng đọc tin lại xử lý
  tuần tự nên mọi tin đến sau — kể cả tin nhắn riêng của chủ nhân — phải chờ gần 3 phút. Ba lớp
  chặn:
  - **Lọc link:** chỉ tải tệp nằm trên CDN của Zalo, hoặc URL/tên tệp có đuôi tệp rõ ràng. Link
    người dùng dán (github.com, trang tin…) để nguyên trong chữ, bot đọc bằng `zalo_web_read`.
  - **Hạn giờ tải:** mỗi tệp tối đa 15 giây, quá thì báo “chưa tải được tệp” thay vì treo.
  - **Mỗi hội thoại một hàng đợi:** tin trong cùng một chat vẫn lần lượt, nhưng một chat kẹt
    không chặn chat khác; tin nhắn riêng của chủ nhân luôn được trả lời ngay.

## [1.10.10] — 2026-09-15

### Sửa

- **Tệp Word theo kỹ thuật trình bày Nghị định 30/2020/NĐ-CP** (theo skill
  `soan-van-ban-doan`, profile `nd30`) thay cho bản tô màu của 1.10.9: A4, lề 20/20/30/15 mm,
  Times New Roman 14 **màu đen**, căn đều hai lề, thụt dòng đầu 1 cm, cách đoạn 6 pt; gạch đầu
  dòng gõ tay `-`/`+` (không dùng danh sách tự động của Word); bảng viền đen, hàng tiêu đề đậm
  lặp lại mỗi trang, không tách hàng qua hai trang; số trang giữa lề trên, không hiện ở trang 1.
  Giáo án, đề, danh sách không phải văn bản hành chính nên không có khối quốc hiệu. PDF,
  PowerPoint, Excel giữ phong cách có màu.

## [1.10.9] — 2026-09-15

### Cải thiện

- **Tệp bot tạo trình bày đẹp, dùng được ngay.** Cả bốn loại dùng chung bảng màu xanh đậm –
  xanh nhấn – nền nhạt:
  - **Word:** khổ A4, lề văn bản hành chính (trái 3 cm, còn lại 2 cm), Times New Roman 13,
    tiêu đề căn giữa có gạch chân màu, đề mục có màu, bảng dòng tiêu đề nền đậm chữ trắng và
    dòng xen kẽ, chữ đậm đổi màu nhấn, số trang ở chân trang.
  - **PDF:** A4, tiêu đề có vạch màu, đề mục màu, gạch đầu dòng chấm màu, bảng tô nền, "Trang x/y".
  - **PowerPoint:** 16:9, slide bìa nền xanh đậm, slide nội dung có dải tiêu đề màu, gạch đầu
    dòng chấm màu, cỡ chữ tự co theo số ý, số slide; slide không có ý thành slide chuyển phần.
  - **Excel:** dòng tiêu đề nền đậm chữ trắng, viền mảnh, dòng xen kẽ, đóng băng dòng đầu, bộ
    lọc, cột tự giãn, in vừa khổ A4 (ngang khi nhiều cột) và lặp dòng tiêu đề mỗi trang.
- Tên tệp giữ dấu cách cho dễ đọc ("Đề kiểm tra.docx") thay vì gạch dưới.
- Mô tả công cụ gợi ý bot soạn nội dung cho đẹp: chia mục rõ, dữ liệu dùng bảng, slide 3–6 ý.

## [1.10.8] — 2026-09-15

### Thêm

- **Thầy cô trong nhóm nhờ bot tạo được tệp Word, PowerPoint, Excel, PDF.** Công cụ công
  khai mới `zalo_make_file`: bot soạn nội dung (Markdown cho docx/pdf, danh sách slide cho
  pptx, bảng cho xlsx), công cụ dựng tệp trong thư mục tạm rồi gửi vào **đúng nhóm đang
  chat**, gửi xong xoá ngay. Không mở quyền ghi tệp, chạy lệnh hay chèn ảnh cho người ngoài;
  các việc khác (tạo ảnh, voice, video, bình chọn…) giữ nguyên chỉ chủ nhân.
- Giới hạn: chỉ trong nhóm (nhắn riêng chưa hỗ trợ), mỗi người **5 tệp/giờ** (chủ nhân không
  giới hạn), nội dung ≤ 30.000 ký tự, ≤ 40 slide (≤ 15 ý/slide), ≤ 5 trang tính × 2.000 dòng ×
  30 cột. Ô Excel bắt đầu bằng `=` được giữ dạng chữ để người ngoài không cài công thức. PDF
  dùng font có dấu tiếng Việt (Arial trên Windows, DejaVu Sans trên Linux, hoặc `ZALO_PDF_FONT`).
- Cần thư viện `python-docx python-pptx openpyxl fpdf2` trong venv Hermes; `npm run doctor`
  báo thiếu kèm lệnh cài.

## [1.10.7] — 2026-09-15

### Thêm

- **Công thức LaTeX tự đổi sang ký tự Unicode trước khi gửi Zalo.** Zalo không hiển thị
  LaTeX nên `$Ca^{2+}$` hiện nguyên dấu đô la và mũ. Cầu nối nay đổi trước khi gửi: chỉ số
  trên/dưới (`$K^+$` → K⁺, `$H_2O$` → H₂O, `x^2` → x²), mũi tên (`\rightarrow` → →,
  `\Rightarrow` → ⇒), so sánh (`\le` ≤, `\ge` ≥, `\ne` ≠, `\pm` ±, `\approx` ≈), chữ Hy Lạp
  (`\alpha` α, `\Delta` Δ, `\mu` μ…), phân số (`\frac{a}{b}` → a/b), căn (√), độ (°). Mã trong
  `` `…` ``, tên biến snake_case và giá tiền "$5 và $10" giữ nguyên. Hướng dẫn trình bày dặn
  bot viết thẳng Unicode, không dùng LaTeX.

## [1.10.6] — 2026-09-15

### Thêm

- **Bot tự bỏ phiếu và thêm phương án bình chọn.** Trước đây bot chỉ tạo, xem và khoá bình
  chọn nên khi chủ nhân nhờ "vote giúp" bot đành từ chối. Hai công cụ mới (chỉ chủ nhân gọi
  được): `zalo_vote_poll` chọn phương án theo `option_id` lấy từ `zalo_poll_detail` — danh
  sách rỗng là rút phiếu; `zalo_add_poll_options` thêm phương án mới vào bình chọn đang mở và
  có thể bỏ phiếu luôn cho phương án đó. Cầu nối mở thêm `votePoll`, `addPollOptions`.

## [1.10.5] — 2026-09-15

### Sửa

- **Tag cả nhóm được ở mọi nhóm tới 100 người.** Bản 1.10.4 chỉ cho bot tag `@All` khi là
  trưởng/phó nhóm; thực tế Zalo cho mọi thành viên tag cả nhóm ở nhóm tới 100 người, chỉ
  nhóm đông hơn mới cần trưởng/phó. Bot nay tag được khi nhóm có tối đa 100 người, hoặc khi
  bot là trưởng/phó nhóm. Nếu Zalo vẫn từ chối, cầu nối gửi lại tin dạng chữ thường như cũ.

## [1.10.4] — 2026-09-15

### Sửa

- **Tag cả nhóm (`@All`) thành tag Zalo thật.** Trước đây `@All` trong tin bot gửi luôn
  hiện dạng chữ vì bộ gắn tag chỉ biết tên thành viên. Nay `@All` được gắn tag cả nhóm
  (`uid: "-1"`) — nhưng chỉ khi bot là **trưởng hoặc phó nhóm**, vì Zalo chỉ cho hai vai
  này tag cả nhóm; không phải thì giữ nguyên dạng chữ và hướng dẫn trình bày dặn bot báo
  chủ nhân thay vì nói đã tag thành công. `@Alla`, `@All1`, `a@All` không bị tính.
  Thay cho bản Uyển Nhi tự sửa tại chỗ trên VPS ngày 15/9 (bản đó gắn tag cả nhóm ở mọi
  nhóm và chưa từng chạy vì sidecar chưa khởi động lại).

## [1.10.3] — 2026-09-14

### Sửa

- **Bot không còn gửi một tin thoại hai lần.** Khi được nhờ gửi voice, bot tạo âm thanh
  bằng `text_to_speech` rồi tự gửi bằng `zalo_send_voice`; sau đó gateway Hermes lại tự
  gắn `MEDIA:` của kết quả `text_to_speech` vào câu trả lời cuối và gửi thêm lần nữa (thấy
  ở nhóm VIBE WORKING (2), hai voice cách nhau 4 giây). Adapter nay nhớ tệp thoại đã gửi
  thành công theo từng chat trong 10 phút; cùng tệp vào cùng chat thì bỏ qua và trả lại kết
  quả lần trước. Gửi sang chat khác, hoặc tệp đã bị ghi đè nội dung, vẫn đi bình thường.

## [1.10.2] — 2026-09-14

### Sửa

- **Chủ nhân gọi tên bot trong nhóm không cần tag.** "Nhi ơi", "chào Nhi", "Nhi đâu",
  "nhờ Nhi" nay đánh thức bot khi người gọi là chủ nhân; người khác vẫn phải tag. Tag
  gõ tay viết thường (`@uyển nhi`) hoặc chỉ tên ngắn (`@nhi`) cũng được nhận. Phần
  này do chính Uyển Nhi sửa tại chỗ trên VPS theo yêu cầu của chủ nhân ngày 14/9, nay
  đưa về kho mã kèm test; bỏ một test Uyển Nhi thêm nhầm (cho người lạ hỏi kỹ thuật
  trong nhóm chỉ-chủ-nhân), trái với quy tắc đã chốt và vốn chạy hỏng.

## [1.10.1] — 2026-09-14

### Sửa

- **Tin thoại của bot phát được trên iPhone và Zalo PC.** Trước đây bot đổi âm thanh
  sang AAC thô rồi tải lên CDN tệp của Zalo; link trả về không có đuôi. Android tự dò
  định dạng nên nghe được, còn iPhone và Zalo PC thì không. Nay bot đóng gói M4A (AAC
  mono 44,1 kHz, 64k) với `-movflags +faststart` để khối thông tin nằm đầu tệp, và nối
  đuôi `.m4a` vào link CDN (CDN bỏ qua phần đuôi thêm vào, vẫn trả đúng tệp). Zalo chê
  đuôi `.m4a` thì tự lùi về cách gửi AAC cũ; lỗi mạng thì dừng, không tải lên hai lần.

## [1.10.0] — 2026-09-13

### Thêm

- **Đọc hết tin trong một khoảng thời gian để tổng hợp thảo luận.** `zalo_read_history`
  nhận thêm `since_hours` (tối đa 168 giờ) và `cursor`: đọc thẳng từ kho SQLite mà
  sidecar ghi liên tục, không gọi Zalo, lật trang tới hết và trả từng dòng gọn
  `[ngày giờ] Tên: nội dung`. Trước đây chỉ đọc được 100 tin gần nhất, không đủ cho
  một nhóm cộng đồng. Lệnh cầu nối mới `history_range` chỉ chủ nhân được dùng.
- Hướng dẫn trình bày thêm mục "Tổng hợp thảo luận nhóm": chỉ tổng hợp khi chủ
  nhân yêu cầu, đọc hết mọi trang trước khi viết, gom theo chủ đề.

## [1.9.4] — 2026-09-13

### Thêm

- **Nhóm chỉ chủ nhân gọi được bot** (`owner_only_groups` trong
  `platforms.zalo.extra`, hoặc biến `ZALO_OWNER_ONLY_GROUPS`). Dùng cho nhóm cộng
  đồng đông người mà bot vào để nghe và tổng hợp: người khác tag hay gọi tên
  bot đều không đánh thức bot, nhưng tin của họ vẫn được lưu và giữ làm ngữ
  cảnh, nên chủ nhân gọi là bot đọc được cả cuộc thảo luận. Nhóm khác không
  bị ảnh hưởng.

## [1.9.3] — 2026-09-13

### Sửa

- **Tệp PDF, DOCX lấy từ tin cũ trong nhóm không còn bị coi là ảnh.** Ai đó gửi
  tệp lên nhóm mà chưa tag bot, lúc sau mới tag nhờ đọc, thì bot móc tệp từ ngữ
  cảnh nhóm ra — nhưng ngữ cảnh chỉ giữ đường dẫn, bỏ mất tên và loại tệp. URL
  tệp của Zalo không có đuôi nên tệp bị đoán là ảnh rồi Hermes từ chối ("Refusing
  to cache non-image data"). Gặp thật ở nhóm y tế trên cả hai bot. Nay ngữ cảnh
  nhóm lưu kèm tên và loại tệp, và tệp móc lại dùng đúng thông tin đó.

## [1.9.2] — 2026-09-13

### Thêm

- **Gọi suông trong nhóm thì bot đọc lại 5 tin gần nhất.** Tag trơ hoặc gọi tên
  không kèm câu hỏi ("@Lăng Tiêu", "Lăng Tiêu ơi", "@Lăng Tiêu đâu rồi") nay
  được hiểu là "xem nhóm đang bàn gì đi": adapter kèm 5 tin gần nhất vào ngữ
  cảnh, và hướng dẫn trình bày dặn bot nói thẳng vào việc thay vì hỏi ngược
  "anh cần gì ạ?". Bộ nhớ ngữ cảnh nhóm nâng từ 5 lên 8 tin để luôn đủ 5 tin
  trước câu gọi.

## [1.9.1] — 2026-09-13

### Sửa

- **Tag trơ trong nhóm nay nhìn được tin vừa gửi.** Gửi sticker (hoặc ảnh) rồi
  tag bot mà không viết gì thêm thì trước đây bot hỏi lại "thầy cần gì ạ?":
  ngữ cảnh nhóm chỉ được móc ra khi câu hỏi có chữ kiểu "ảnh này", "cái đó".
  Nay một cái tag không kèm chữ nào được hiểu là "nhìn cái em vừa gửi".
  Thêm "sticker" và "nhãn dán" vào các từ khoá gợi ngữ cảnh.

## [1.9.0] — 2026-09-13

### Thêm

- **Bot đọc được sticker.** Tin `chat.sticker` của Zalo chỉ có ba con số
  `{id, catId, type}` nên trước đây rút chữ ra rỗng và bị bỏ ngay tại
  bot-handler — nhìn từ ngoài là bot lờ đi khi có người gửi nhãn dán. Nay cầu
  nối tra `getStickersDetail` để lấy nhãn chữ và ảnh tĩnh, gắn vào khung tin:
  lịch sử ghi `[Nhãn dán]` thay vì một dòng trống, còn model nhìn
  được cả hình lẫn chữ vẽ trong sticker. Kết quả tra được nhớ theo id nên một
  tràng sticker chỉ tốn đúng một lượt hỏi mỗi mẫu; tra hỏng thì vẫn báo có
  nhãn dán chứ không bỏ tin.
- `getStickersDetail` vào nhóm phương thức đọc công khai của cầu nối.

### Sửa

- Adapter tin danh sách đính kèm do cầu nối phân loại, thay vì loại bỏ mọi tin
  có kiểu nằm trong danh sách "không phải media". Danh sách đó sinh ra để chặn
  việc *đoán* URL từ thẻ chia sẻ link, nhưng nó chặn nhầm cả ảnh sticker.

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
