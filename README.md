# 2Anh Zalo Bot

Cầu nối đưa **Zalo** vào [Hermes Agent](https://github.com/NousResearch/hermes-agent) như một nền tảng đầy đủ — ngang hàng với Telegram, Discord, Slack.

Nhắn tin trên Zalo là nói chuyện với chính con agent đang chạy trên máy bạn: đủ tools, memory, skills và cron.

```
Zalo  ⇄  sidecar zca-js (Node)  ⇄  WebSocket  ⇄  plugin Python  ⇄  Hermes Agent
```

---

## Vì sao lại có cầu nối

Zalo không có API bot cho tài khoản cá nhân, và hai thư viện Zalo viết bằng Python đều không dùng được:

| Thư viện | Tình trạng |
|---|---|
| `zlapi` | Tác giả ghi rõ *stop_updating*, máy chủ đăng nhập đã bị gỡ |
| `zca-py` | Còn ở mức Alpha |
| **`zca-js`** | Đang được bảo trì, 149 API — nhưng là **JavaScript** |

Plugin nền tảng của Hermes lại viết bằng **Python**. Nên bản này giữ `zca-js` làm lớp Zalo và nối sang Python qua WebSocket cục bộ:

* **sidecar** giữ phiên Zalo — đăng nhập QR, lưu cookie, tự nối lại, gọi API gửi/thả cảm xúc/đang soạn tin;
* **plugin Python** lo phần Hermes — phân quyền, lọc tag trong nhóm, đẩy tin vào agent.

---

## Tính năng

**Kết nối**
* Đăng nhập bằng QR qua trình duyệt, không cần nhập mật khẩu
* Lưu phiên — khởi động lại máy không phải quét lại
* Tự nối lại khi mất kết nối (2 → 5 → 10 → 30 → 60 giây)

**Phân quyền — mặc định đóng**
* Người lạ nhắn riêng thì bot im lặng (`dmPolicy: owner-only`)
* Trong nhóm chỉ trả lời khi được tag đúng tên bot
* Nhận diện UID Zalo thật, loại bỏ số điện thoại điền nhầm chỗ

**Trả lời**
* Markdown của Hermes được dịch sang định dạng gốc của Zalo — in đậm, đỏ, xanh lá, cam, vàng, nghiêng, gạch ngang
* Thả cảm xúc theo ngữ cảnh câu chữ (55 icon), báo đã đọc, hiệu ứng đang soạn tin
* Nhiều tính cách (persona) cấu hình được, đặt riêng cho từng nhóm

**Hai chế độ**
| Chế độ | Khi nào | Khả năng |
|---|---|---|
| `hermes-agent` | Hermes đang cắm vào cầu | Đầy đủ tools, memory, skills, cron |
| `chatbot-noi-bo` | Không có Hermes | Gọi thẳng LLM, chỉ trò chuyện |

Chuyển chế độ tự động, không cần cấu hình. Xem `/api/status` để biết đang chạy chế độ nào.

**31 công cụ cho agent** — thay cho trang quản trị. Nói bằng lời thay vì bấm nút:

| Nhóm | Công cụ |
|---|---|
| Gửi nội dung | `zalo_send_file` `zalo_send_voice` `zalo_send_sticker` `zalo_send_link` `zalo_forward` |
| Đọc ngữ cảnh | `zalo_read_history` `zalo_list_groups` `zalo_group_members` `zalo_find_user` `zalo_user_info` `zalo_list_friends` |
| Riêng của Zalo | `zalo_create_poll` `zalo_poll_detail` `zalo_lock_poll` `zalo_create_note` `zalo_create_reminder` `zalo_list_reminders` `zalo_pin_conversation` `zalo_mute` |
| Sửa sai & quản trị | `zalo_undo` `zalo_rename_group` `zalo_group_member_change` `zalo_group_deputy` `zalo_pending_members` `zalo_review_member` |
| Lập nhóm & lời mời | `zalo_create_group` `zalo_invite_to_groups` `zalo_group_link` `zalo_join_group_link` |
| Hồ sơ bot | `zalo_set_bio` `zalo_set_active_status` |

Ví dụ: *"Tạo bình chọn trong nhóm Tổ Hoá hỏi thứ mấy họp được, ba phương án thứ 3, 5, 7"* — agent tự gọi `zalo_list_groups` rồi `zalo_create_poll`.

Cầu nối chỉ chấp nhận các hàm zca-js nằm trong **danh sách trắng**. Những hàm dễ làm khoá tài khoản (gửi lời mời kết bạn hàng loạt, chặn người, giải tán nhóm) hay chạm tới tiền bạc cố tình bị bỏ ra ngoài.

### Hai mức quyền

31 công cụ chia làm hai nhóm, quyết định bằng `ZALO_ALLOWED_USERS`:

| | Chủ nhân | Người khác trong nhóm |
|---|---|---|
| Toolset | `hermes-zalo` + `zalo_public` | chỉ `zalo_public` |
| Số công cụ Zalo | 31 | 7 |
| `terminal`, `read_file`, `write_file` | ✅ | ❌ |
| `browser_*`, `web_search` | ✅ | ❌ |
| Nhắm tới hội thoại khác | ✅ | ❌ — khoá trong cuộc trò chuyện hiện tại |
| Nhắn riêng với bot | ✅ | ❌ mặc định (`ZALO_DM_POLICY`) |

**11 công cụ công khai:** gửi tệp · gửi thoại · gửi sticker · gửi liên kết · đặt lời nhắc · xem lời nhắc · xem thành viên nhóm · liệt kê kho tài liệu · đọc tài liệu · **tìm kiếm web · đọc trang web**.

### Tra cứu Internet

Hai công cụ web là **bản bọc** của `web_search`/`web_extract` chứ không cấp thẳng. Lý do: mọi toolset sẵn có chứa chúng (`debugging`, `coding`) đều kèm luôn `terminal` và `read_file` — cấp một cái là cấp cả cụm.

Bọc lại còn bịt được một lỗ hổng: `web_extract` nhận URL tuỳ ý, nên nếu để nguyên thì `http://127.0.0.1:20128/v1/models` hay `file:///…/.env` là đủ để đọc nội bộ qua đường Internet. Bản bọc chỉ cho `http`/`https` trỏ ra địa chỉ công cộng — chặn loopback, dải mạng riêng, link-local, và cả `169.254.169.254` (địa chỉ metadata của máy chủ đám mây).

### Kho tài liệu tư vấn

Người trong nhóm không có `read_file`, nhưng bot vẫn cần đọc tài liệu để tư vấn sản phẩm. `ZALO_KB_DIR` mở đúng một cánh cửa hẹp: chỉ đọc, chỉ trong thư mục đó.

Ba lớp chặn:
1. Mọi đường dẫn được ép về đường dẫn thật rồi kiểm tra lại — `../`, `..\`, symlink đều không thoát ra ngoài
2. Bỏ qua thư mục ẩn (`.git`, `.env`, `.backup`), `node_modules`, `dist`, `build`, và tệp có tên gợi ý dữ liệu riêng tư (`backup`, `order`, `customer`, `secret`…)
3. Chỉ đọc tệp văn bản, tối đa 60 KB mỗi lần

Bộ lọc áp cho **cả liệt kê lẫn đọc** — che khỏi danh sách không phải là chặn, đoán đúng tên tệp vẫn phải bị từ chối.

> Nên trỏ vào một thư mục tài liệu thuần. Trỏ vào cả thư mục dự án thì bộ lọc vẫn giữ được, nhưng bạn đang dựa vào nó thay vì vào ranh giới rõ ràng.

### Session tách theo nhóm

Mỗi nhóm Zalo là một phiên riêng — chuyện ở nhóm này không lẫn sang nhóm khác. Trong cùng một nhóm thì mọi người **chung một phiên**, để bot nối được mạch hội thoại tập thể: A hỏi *"sản phẩm X giá bao nhiêu?"*, B hỏi tiếp *"còn hàng không?"* thì bot hiểu B đang nói về X.

Đặt bằng `group_sessions_per_user: false` ở **cấp cao nhất** của `config.yaml` (Hermes ưu tiên cấp này hơn khoá cùng tên trong mục `gateway:`).

Cả nhóm dùng được bot mà **không phải khai báo từng UID** — đặt `ZALO_ALLOW_ALL_USERS=true` để gateway mở cổng vào, rào chắn thật nằm ở tầng toolset. Cờ đó **không** phong ai làm chủ: `ZALO_ALLOWED_USERS` mới quyết định điều đó.

Nhắn riêng vẫn chỉ dành cho chủ (`ZALO_DM_POLICY=owner-only`). Một tin nhắn riêng là hội thoại kín, không ai trong nhóm nhìn thấy để kiểm chứng — nên cửa đó đóng chặt hơn.

Điểm cốt lõi: toolset mặc định của mọi nền tảng Hermes (`hermes-<tên>`) **luôn kèm** `terminal`, `read_file`, `write_file`, `browser_*`. Ai được dùng nó là chạy được lệnh shell và đọc được mọi tệp trên máy chủ — kể cả tệp chứa khoá API. Vì vậy người ngoài chỉ nhận `zalo_public`, một toolset riêng không chứa bộ lõi đó.

Công cụ công khai còn bị **khoá phạm vi**: người ngoài truyền `thread_id` của nhóm khác sẽ bị từ chối, chỉ tác động được lên đúng cuộc trò chuyện họ đang tham gia. Ngữ cảnh lượt tin lưu bằng `contextvars` — gateway xử lý nhiều lượt song song, biến thường sẽ lẫn người này sang người kia.

**Trang quét QR** tại `http://127.0.0.1:3872` — chỉ dùng lúc đăng nhập lần đầu và khi phiên hết hạn. Không có trang quản trị: mọi thao tác đều ra lệnh cho agent.

---

## Yêu cầu

* **Node.js 20+**
* **Một tài khoản Zalo phụ** — xem phần Rủi ro bên dưới
* *(tuỳ chọn)* **Hermes Agent** — không có thì bot chạy chế độ chatbot độc lập

---

## Cài đặt

```bash
git clone https://github.com/luonghaianh1208/2anh-zalo-bot.git
cd 2anh-zalo-bot
npm install
npm run setup
npm start
```

`npm run setup` sẽ: tạo `data/` với cấu hình mẫu, tạo `.env`, tìm thư mục Hermes, chép plugin vào đó và cài gói `websockets`. Chạy lại nhiều lần được — không đè lên thứ bạn đã sửa.

### Kết nối Zalo

1. Mở `http://127.0.0.1:3872`
2. Bấm **Tạo QR**, quét bằng Zalo trên điện thoại *(dùng tài khoản phụ)*
3. Từ Zalo cá nhân của bạn, nhắn `/sethome` cho tài khoản vừa quét
   → bot ghi nhận bạn là chủ và in ra UID

### Nối vào Hermes

Thêm UID vừa nhận vào file `.env` **của Hermes** (`%LOCALAPPDATA%\hermes\.env` trên Windows, `~/.hermes/.env` trên Linux/macOS):

```env
ZALO_BRIDGE_URL=ws://127.0.0.1:3873
ZALO_ALLOWED_USERS=<UID Zalo của bạn>
ZALO_HOME_CHANNEL=<UID Zalo của bạn>
ZALO_GROUP_REPLY_ONLY_TAGGED=true
```

Rồi khởi động Hermes:

```bash
hermes gateway run
```

**Thứ tự quan trọng:** sidecar phải chạy trước, Hermes mới cắm vào cầu được. Chạy ngược lại thì Hermes vẫn lên nhưng kênh Zalo im cho tới lần thử nối lại kế tiếp.

Kiểm tra đã thông chưa:

```bash
curl http://127.0.0.1:3872/api/status
# "hermesAttached": true, "mode": "hermes-agent"
```

---

## Cấu hình

### `data/bot_settings.json`

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `enabled` | `true` | Bật/tắt toàn bộ bot |
| `dmPolicy` | `owner-only` | `owner-only` \| `allowlist` \| `open` |
| `replyOnlyTagged` | `true` | Trong nhóm chỉ trả lời khi được tag |
| `silentListenOnly` | `false` | Chỉ nghe, không nói |
| `adminUids` | `[]` | UID chủ nhân — điền bằng `/sethome` |
| `allowedUids` | `[]` | Ai được nhắn riêng khi `dmPolicy: allowlist` |
| `ownerName` | `""` | Tên chủ, dùng khi bot tự giới thiệu |
| `orgName` | `""` | Tên đơn vị |
| `persona` | `friendly` | Tính cách mặc định |
| `groups` | `{}` | Ghi đè cấu hình cho từng nhóm |

> **UID Zalo là dãy số dài 17–21 chữ số, không bắt đầu bằng `0`.** Số điện thoại thì ngược lại. Điền nhầm số điện thoại vào `adminUids` sẽ bị bỏ qua kèm cảnh báo trong log — đây là chủ ý, để một mục sai định dạng không vô tình mở quyền cho tất cả mọi người.

### `data/personas.json`

Mỗi tính cách gồm `name`, `system_prompt`, `tone`, `greeting`, `creativity` (0–1). Sửa thẳng trong file, hoặc nhờ agent sửa hộ.

---

## Định dạng tin nhắn

Hermes cứ viết Markdown như bình thường; cầu nối dịch sang style gốc của Zalo trước khi gửi:

| Markdown | Hiển thị trên Zalo |
|---|---|
| `# H1`, `## H2` | **đậm + đỏ** |
| `### H3` | **đậm + cam** |
| `**text**` | **đậm** |
| `*text*` | *nghiêng* |
| `` `code` `` | **đậm** |
| `~~text~~` | ~~gạch ngang~~ |
| `> quote` | *nghiêng* |
| `- item` | • item |
| `[chữ](url)` | **chữ** (url) |
| `[green]…[/green]` | **xanh lá** |
| `[red]` `[orange]` `[yellow]` | các màu tương ứng |

Emoji hiển thị gốc, dùng thoải mái.

---

## API

Giữ lại để chẩn đoán bằng `curl` — không có giao diện nào gọi chúng nữa.

| Đường dẫn | Việc |
|---|---|
| `GET /api/status` | Trạng thái đăng nhập, chế độ, đã cắm Hermes chưa |
| `POST /api/qr/start` | Bắt đầu đăng nhập QR |
| `POST /api/logout` | Đăng xuất, xoá phiên |
| `GET /api/groups` | Danh sách nhóm đang tham gia |
| `GET \| POST /api/config` | Đọc / ghi `bot_settings.json` |
| `GET \| POST /api/personas` | Đọc / ghi `personas.json` |
| `POST /api/send-home` | Gửi tin nhắn tay tới một UID |

Cổng WebSocket `3873` là giao thức riêng giữa sidecar và Hermes: `hello`, `message`, `ack` đi từ sidecar ra; `send`, `typing`, `ack_message`, `invoke` đi từ Hermes vào.

---

## Rủi ro cần biết trước khi dùng

**`zca-js` là thư viện không chính thức**, dựng lại từ Zalo Web. Dùng nó **vi phạm điều khoản dịch vụ của Zalo** và tài khoản có thể bị khoá.

* **Luôn dùng tài khoản phụ.** Đừng đăng nhập tài khoản chính hay tài khoản công việc.
* Đừng gửi tin hàng loạt, đừng tự động kết bạn — đó là những hành vi dễ bị đánh dấu nhất.
* Giữ `replyOnlyTagged: true` trong nhóm.

**Bảo mật:** thư mục `data/` chứa cookie và IMEI của phiên Zalo. Ai lấy được file đó là đăng nhập được vào tài khoản đó. `.gitignore` đã chặn sẵn — đừng gỡ ra.

Dashboard chỉ nghe ở `127.0.0.1`, **không có mật khẩu**. Đừng mở nó ra mạng ngoài.

---

## Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Log ghi `no saved session` | Chưa quét QR, hoặc cookie hết hạn → quét lại |
| `hermesAttached: false` | Hermes chưa chạy, hoặc `ZALO_BRIDGE_URL` sai cổng |
| Bot im khi nhắn riêng | Chưa `/sethome`, hoặc UID chưa có trong `ZALO_ALLOWED_USERS` |
| Bot im trong nhóm | Chưa tag đúng tên bot — mặc định chỉ trả lời khi được gọi |
| `Unauthorized user ... on zalo` | Đúng như thiết kế: người đó không nằm trong allowlist |
| Tin nhắn hiện `**` hoặc `[red]` | Sidecar chạy bản cũ — `git pull` rồi khởi động lại |
| Cổng bị chiếm | Đổi `ZCA_PORT` / `ZALO_BRIDGE_PORT` trong `.env` |

Log của sidecar in thẳng ra terminal đang chạy `npm start`. Log Hermes nằm ở `<hermes>/logs/gateway.log`.

---

## Giấy phép

MIT — xem [LICENSE](LICENSE).

Không liên kết với Zalo hay VNG. `zca-js` thuộc về [RFS-ADRENO/zca-js](https://github.com/RFS-ADRENO/zca-js).
