# 2Anh Zalo Bot

[English](README.md) | **Tiếng Việt**

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
* Tính cách đặt ở `platform_hints.zalo` của Hermes — một chỗ duy nhất, không rải ra nhiều tệp

**Một bộ não duy nhất.** Hermes trả lời tất cả. Hermes chưa cắm thì bot nói thẳng là đang mất kết nối và mời nhắn lại sau — không có đường dự phòng nào.

Trước đây *có* một bộ não Node dự phòng gọi thẳng LLM. Đã bỏ, vì hai lý do. Nó không bao giờ chạy nên âm thầm mục ruỗng — mấy lỗi nặng nhất của dự án (định tuyến nhóm sai, kiểm chủ nhân sai) đều nằm trong đoạn đó và sống sót nhiều tháng vì không ai đi qua. Nguy hiểm hơn: khi nó *có* chạy thì lại chạy bằng bộ luật khác — Hermes phân quyền theo toolset, còn bộ não Node đọc một tệp JSON và không có tầng phân quyền nào. Hermes rớt là hệ thống lặng lẽ hạ cấp sang bộ luật lỏng hơn, đúng lúc không ai để ý.

**45 công cụ cho agent** — thay cho trang quản trị. Nói bằng lời thay vì bấm nút:

| Nhóm | Công cụ |
|---|---|
| Gửi nội dung | `zalo_send_file` `zalo_send_voice` `zalo_send_sticker` `zalo_send_link` `zalo_forward` |
| Đọc ngữ cảnh | `zalo_read_history` `zalo_list_groups` `zalo_group_members` `zalo_find_user` `zalo_user_info` `zalo_list_friends` |
| Riêng của Zalo | `zalo_create_poll` `zalo_poll_detail` `zalo_lock_poll` `zalo_create_note` `zalo_create_reminder` `zalo_list_reminders` `zalo_remove_reminder` `zalo_pin_conversation` `zalo_mute` |
| Sửa sai & quản trị | `zalo_undo` `zalo_rename_group` `zalo_group_member_change` `zalo_group_deputy` `zalo_pending_members` `zalo_review_member` |
| Lập nhóm & lời mời | `zalo_create_group` `zalo_invite_to_groups` `zalo_group_link` `zalo_join_group_link` |
| Hồ sơ bot | `zalo_set_bio` `zalo_set_active_status` |

Ví dụ: *"Tạo bình chọn trong nhóm Tổ Hoá hỏi thứ mấy họp được, ba phương án thứ 3, 5, 7"* — agent tự gọi `zalo_list_groups` rồi `zalo_create_poll`.

Cầu nối chỉ chấp nhận các hàm zca-js nằm trong **danh sách trắng**. Những hàm dễ làm khoá tài khoản (gửi lời mời kết bạn hàng loạt, chặn người, giải tán nhóm) hay chạm tới tiền bạc cố tình bị bỏ ra ngoài.

### Hai mức quyền

45 công cụ chia làm hai nhóm, quyết định bằng `ZALO_ALLOWED_USERS`:

| | Chủ nhân | Người khác trong nhóm |
|---|---|---|
| Toolset | `hermes-zalo` + `zalo_owner` + `zalo_public` | chỉ `zalo_public` |
| Số công cụ Zalo | 45 | 14 |
| `terminal`, `read_file`, `write_file` | ✅ | ❌ |
| `browser_*`, `web_search` | ✅ | ❌ |
| Nhắm tới hội thoại khác | ✅ | ❌ — khoá trong cuộc trò chuyện hiện tại |
| Nhắn riêng với bot | ✅ | ❌ mặc định (`ZALO_DM_POLICY`) |

**14 công cụ công khai:** gửi tệp · gửi thoại · gửi sticker · gửi liên kết · đặt lời nhắc · xem lời nhắc · xoá lời nhắc · xem thành viên nhóm · liệt kê kho tài liệu · đọc tài liệu · nhớ người quen · tra sổ người quen · **tìm kiếm web · đọc trang web**.

Việc phân nhóm toolset chỉ *giấu* công cụ khỏi danh sách. Rào chắn thật nằm ở tầng thực thi: mỗi công cụ thuộc nhóm chủ nhân được bọc một lớp kiểm tra danh tính người gửi, nên dù công cụ có lọt vào danh sách vì cấu hình sai thì người ngoài gọi vẫn bị từ chối.

Các thao tác nguy hiểm như thu hồi tin, đổi tên nhóm, sửa thành viên hoặc quyền phó nhóm còn cần xác nhận hai lượt. Agent trả một mã sáu ký tự; chủ nhân phải gửi một tin nhắn mới đúng nguyên câu `XÁC NHẬN <MÃ>` trong vòng 5 phút. Mã được khóa theo UID chủ nhân, cuộc trò chuyện, công cụ và đúng bộ tham số nên không thể dùng lại cho người, nhóm hay thao tác khác.

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

### Trí nhớ

**Hội thoại** — Hermes lưu cả phiên vào `state.db` và tự nén khi dài, không phải một cửa sổ vài chục tin. Có tìm kiếm toàn văn để tra lại chuyện cũ.

**Hồ sơ người quen** — `memories/USER.md` của Hermes chỉ có một hồ sơ, của chủ nhân. Trong nhóm Zalo thì mỗi người một khác, nên plugin giữ thêm một cuốn sổ tra theo UID (`ZALO_PEOPLE_FILE`, mặc định `<hermes>/zalo/people.json`).

Khi ai đó tự giới thiệu, agent gọi `zalo_remember_person`. Lần sau người ấy nhắn, hồ sơ được kẹp sẵn vào đầu tin — bot xưng hô đúng ngay từ câu đầu, không phải hỏi lại.

| Công cụ | Ai dùng được |
|---|---|
| `zalo_remember_person` | mọi người — nhưng **chỉ ghi cho chính mình** |
| `zalo_recall_person` | mọi người — chỉ xem hồ sơ của mình |
| `zalo_list_people` · `zalo_forget_person` | chỉ chủ nhân |

> Hồ sơ ở đây là **lời tự khai**, không phải danh tính đã xác thực — ai cũng có thể nói "tôi là quản trị viên". Nó chỉ dùng để xưng hô và hiểu ngữ cảnh, **không bao giờ dùng để cấp quyền**. Quyền vẫn chỉ dựa vào `ZALO_ALLOWED_USERS`.
>
> Chủ nhân ghi hộ được cho người khác; người thường thì không. Nếu ai cũng ghi hộ được thì một người có thể gán nhãn sai cho người khác, rồi bot mang nhãn đó ra dùng ở lượt sau.

### Session tách theo nhóm

Mỗi nhóm Zalo là một phiên riêng — chuyện ở nhóm này không lẫn sang nhóm khác. Trong cùng một nhóm thì mọi người **chung một phiên**, để bot nối được mạch hội thoại tập thể: A hỏi *"sản phẩm X giá bao nhiêu?"*, B hỏi tiếp *"còn hàng không?"* thì bot hiểu B đang nói về X.

Đặt bằng `group_sessions_per_user: false` ở **cấp cao nhất** của `config.yaml` (Hermes ưu tiên cấp này hơn khoá cùng tên trong mục `gateway:`).

Cả nhóm dùng được bot mà **không phải khai báo từng UID** — đặt `ZALO_ALLOW_ALL_USERS=true` để gateway mở cổng vào, rào chắn thật nằm ở tầng toolset. Cờ đó **không** phong ai làm chủ: `ZALO_ALLOWED_USERS` mới quyết định điều đó.

Nhắn riêng vẫn chỉ dành cho chủ (`ZALO_DM_POLICY=owner-only`). Một tin nhắn riêng là hội thoại kín, không ai trong nhóm nhìn thấy để kiểm chứng — nên cửa đó đóng chặt hơn.

Điểm cốt lõi: toolset mặc định của mọi nền tảng Hermes (`hermes-<tên>`) **luôn kèm** `terminal`, `read_file`, `write_file`, `browser_*`. Ai được dùng nó là chạy được lệnh shell và đọc được mọi tệp trên máy chủ — kể cả tệp chứa khoá API. Vì vậy người ngoài chỉ nhận `zalo_public`, một toolset riêng không chứa bộ lõi đó.

Công cụ công khai còn bị **khoá phạm vi**: người ngoài truyền `thread_id` của nhóm khác sẽ bị từ chối, chỉ tác động được lên đúng cuộc trò chuyện họ đang tham gia. Ngữ cảnh lượt tin lưu bằng `contextvars` — gateway xử lý nhiều lượt song song, biến thường sẽ lẫn người này sang người kia.

**Trang quét QR** tại `http://127.0.0.1:3872` — chỉ dùng lúc đăng nhập lần đầu và khi phiên hết hạn. Không có trang quản trị: mọi thao tác đều ra lệnh cho agent.

### Giữ tài khoản không bị khoá

Hai lớp riêng biệt, bảo vệ hai thứ khác nhau.

**Giãn nhịp gửi (`rate-limiter.js`)** bảo vệ tài khoản Zalo. Hermes trả lời xong thường bắn liền mấy thứ sát nhau — đoạn văn bản, sticker, có khi cả tệp — mà Zalo thì quét hành vi spam trên tài khoản cá nhân, và mất tài khoản là mất luôn cả kênh.

Dùng token bucket chứ không phải "ngủ 3 giây sau mỗi tin", vì ngủ cố định làm chậm cả những lượt trả lời bình thường. Bucket có sẵn 5 token nên **một lượt trả lời thông thường đi ra ngay, không trễ mili giây nào**; chỉ khi gửi dồn kéo dài mới bị giãn về 20 tin/phút. Câu trả lời chỉ bị tách khi dài hơn 4000 ký tự, nên phải viết hơn 20.000 ký tự mới chạm hạn mức.

Hai chi tiết để không hỏng trải nghiệm:

- **Ưu tiên** — tin trả lời trong hội thoại xếp trước thao tác hàng loạt. Chủ nhân bảo bot chuyển tiếp tới 20 nhóm thì việc đó không làm người đang nói chuyện phải chờ.
- **Từ chối sớm** — adapter chờ ack tối đa 30 giây; giữ lâu hơn thì agent tưởng gửi hỏng và thử lại, thành ra càng spam. Nên khi hàng quá dài, bridge báo lỗi rõ ràng để agent biết dừng.

Chỉ áp cho thứ người khác nhìn thấy được (nhắn tin, sticker, tệp, chuyển tiếp, bình chọn, mời nhóm). Gõ phím, đã xem, thả cảm xúc, đọc dữ liệu đều không bị bóp — bóp chúng chỉ làm bot có vẻ chậm chạp chứ không giảm rủi ro gì.

**Chống nhắn dồn dập (`hermes-plugin/zalo/flood.py`)** bảo vệ ví tiền và nhóm. Bot chỉ trả lời khi bị tag, nhưng mỗi lần tag là một lượt gọi mô hình tính phí — ai đó tag hai mươi lần trong một phút là hai mươi lượt.

Ngưỡng để rộng tay có chủ đích: 6 tin trong 15 giây nhanh hơn nhịp hỏi của người thật khá nhiều. Quá ngưỡng thì bot **nói đúng một câu rồi im** trong 90 giây — im lặng đột ngột trông như bot hỏng và người ta sẽ tag thêm nữa, đúng thứ ta đang muốn tránh. Chủ nhân được miễn trừ, và một người bị chặn không ảnh hưởng ai khác trong nhóm.

Cả hai đều chỉnh được qua `.env` (xem `.env.example`).

---

## Yêu cầu

* **Node.js 22+**
* **Một tài khoản Zalo phụ** — xem phần Rủi ro bên dưới
* **Hermes Agent đã cài đặt** — sidecar không có bộ não dự phòng độc lập

---

## Cài đặt

Nếu giao việc cho một coding agent, chỉ cần gửi yêu cầu: **“Clone repo này và cài vào Hermes Agent theo `AGENTS.md`; chạy `doctor` và báo lại kết quả.”** Agent không cần biết trước cấu trúc nội bộ của plugin.

```bash
git clone https://github.com/luonghaianh1208/2anh-zalo-bot.git
cd 2anh-zalo-bot
npm ci
npm run install:hermes -- --hermes-home <đường-dẫn-Hermes>
npm run doctor -- --hermes-home <đường-dẫn-Hermes>
```

### Giọng Việt offline tùy chọn

Trước khi cài, agent phải hỏi khách có muốn dùng VieNeu hay không và nói rõ: không cần API key hoặc GPU, model Nano tải khoảng 282 MB ở lần dùng đầu, chạy bằng CPU và phù hợp nhất khi máy duy trì khoảng 10 GB RAM trống. Không được tự bật thay khách.

Nếu khách đồng ý, thêm cờ `--vieneu-tts`:

```bash
npm run install:hermes -- --hermes-home <đường-dẫn-Hermes> --vieneu-tts
npm run doctor -- --hermes-home <đường-dẫn-Hermes>
```

Bộ cài sẽ tạo môi trường Python riêng tại `<HERMES_HOME>/tts/.venv`, cài `vieneu==3.6.4` và `edge-tts`, chọn VieNeu v3 Nano chạy CPU/ONNX với giọng nam miền Bắc `Minh Quân`. Nếu VieNeu lỗi, provider tự chuyển sang Edge `vi-VN-NamMinhNeural`. Các cấu hình TTS khác của khách vẫn được giữ lại.

Nếu không có cờ này, bộ cài không tải, không cấu hình và không thay đổi TTS hiện có.

Nếu Hermes nằm ở vị trí chuẩn hoặc biến `HERMES_HOME` đã có, có thể bỏ tham số `--hermes-home`. Bộ cài sẽ tạo `.env` nếu thiếu, sinh khóa bí mật cho bridge, cài đủ `zalo-platform` và `zalo-tools`, cập nhật các khóa Zalo còn thiếu trong `config.yaml`, cài `websockets` vào Python của Hermes rồi tự chạy kiểm tra. Chạy lại cùng lệnh để nâng cấp; cấu hình, phiên Zalo và SQLite được giữ nguyên.

Sau khi `doctor` đạt, chạy sidecar:

```bash
npm start
```

### Kết nối Zalo

1. Mở `http://127.0.0.1:3872`
2. Bấm **Tạo QR**, quét bằng Zalo trên điện thoại *(dùng tài khoản phụ)*
3. Từ Zalo cá nhân của bạn, nhắn `/sethome` cho tài khoản vừa quét
   → bot ghi nhận bạn là chủ và in ra UID

### Nối vào Hermes thủ công

Phần này chỉ dùng khi không thể chạy bộ cài tự động ở trên.

**Bước 1 — chép plugin vào Hermes.** Thư mục `hermes-plugin/` chứa hai plugin, chép vào đúng chỗ trong mã nguồn Hermes:

```bash
cp -r hermes-plugin/zalo        <hermes-agent>/plugins/platforms/zalo
cp -r hermes-plugin/zalo_tools  <hermes-agent>/plugins/zalo_tools
```

Vì sao lại hai thư mục thay vì một: Hermes nạp mọi plugin `kind: platform` theo kiểu **lười** — chúng chỉ được import khi gateway thật sự chạm tới nền tảng đó, tức là *sau* khi Hermes đã chốt xong danh sách toolset. Công cụ đăng ký muộn như vậy bị coi là tên lạ và bị loại sạch, agent thì không báo lỗi mà chỉ lặng lẽ trả lời bằng chữ. Nên bộ công cụ phải nằm ở một plugin `kind: standalone` riêng, thứ được nạp ngay lúc khám phá.

**Bước 2 — bật cả hai plugin:**

```bash
hermes plugins enable platforms/zalo
hermes plugins enable zalo-tools
```

**Bước 3 — khai báo cấu hình Zalo** trong `config.yaml` của Hermes.

`npm run install:hermes` đã tự làm mục 1 và 2 dưới đây (xem `mergeHermesConfig` trong `scripts/hermes-install-lib.js:84-134`): tự thêm `known_plugin_toolsets.zalo` gồm `zalo_owner` + `zalo_public` nếu còn thiếu, và tự ghi `display.platforms.zalo` (`tool_progress: "off"`, `long_running_notifications: false`, `busy_ack_detail: false`, `show_reasoning: false`, cùng vài khoá khác) mà không đè lên giá trị bạn đã chỉnh tay. Chỉ cần tự gõ YAML dưới đây khi cài **thủ công** (không chạy `install:hermes`) hoặc khi trình cài báo lỗi lúc cập nhật `config.yaml`:

```yaml
# 1. Khai báo toolset là "đã biết" để Hermes không tự cấp quyền chủ cho người lạ:
known_plugin_toolsets:
  zalo:
    - zalo_owner
    - zalo_public

# 2. Tắt hiển thị tiến trình làm việc nội bộ ra nhóm Zalo (tránh lộ dòng 'Working...'):
display:
  platforms:
    zalo:
      tool_progress: "off"
      long_running_notifications: false
      busy_ack_detail: false
      show_reasoning: false

# 3. Tính cách và phong cách phản hồi mô phỏng giọng điệu tự nhiên:
platform_hints:
  zalo:
    append: >-
      Giọng điệu — bạn nói chuyện thay cho chủ nhân: vui vẻ, hoà đồng, thi thoảng
      tếu táo một câu cho đỡ khô, nhưng vào việc thì nghiêm túc và làm tới nơi.
      Bám sát mạch câu chuyện đang diễn ra trong nhóm, nhớ ai vừa nói gì để trả lời
      cho ăn nhập. Khi tư vấn: kiên nhẫn, giải thích chi tiết, hỏi lại cho rõ nhu cầu.
```

Mục 1 và 2 quan trọng dù đã tự động, nên vẫn cần hiểu vì sao: Hermes mặc định **bật** mọi toolset plugin mà nó chưa từng thấy; thiếu khai báo thì `zalo_owner` — bộ công cụ dành riêng chủ nhân — được cấp cho cả người lạ nhắn vào nhóm, dù adapter đã giới hạn. Đồng thời cấu hình `display.platforms.zalo` giúp các bong bóng tin nhắn trong nhóm luôn sạch sẽ, không bị bắn rác thông báo hệ thống. Việc trình cài tự làm hai mục này không phải để bạn khỏi quan tâm — nếu tự cài thủ công mà bỏ sót, hệ quả bảo mật vẫn y như trên.

Mục 3 (tính cách, `platform_hints.zalo.append`) là tuỳ chọn và trình cài **không** tự viết hộ — mặc định Hermes không có persona này, nên nếu muốn giọng điệu như trên thì luôn phải tự thêm, dù cài kiểu nào.

**Bước 4 — thêm UID** vào file `.env` **của Hermes** (`%LOCALAPPDATA%\hermes\.env` trên Windows, `~/.hermes/.env` trên Linux/macOS):

```env
ZALO_BRIDGE_URL=ws://127.0.0.1:3873
ZALO_BRIDGE_TOKEN=<cùng giá trị do bộ cài sinh trong .env của sidecar>
ZALO_ALLOWED_USERS=<UID Zalo của bạn>
ZALO_HOME_CHANNEL=<UID Zalo của bạn>
ZALO_GROUP_REPLY_ONLY_TAGGED=true
```

**Bước 5 — khởi động Hermes:**

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

### Cấu hình nằm ở đâu

Sidecar không còn tệp cấu hình nào. Ai được dùng bot, trả lời khi nào, tính cách ra sao — tất cả nằm bên Hermes:

| Việc | Đặt ở đâu |
|---|---|
| Ai là chủ nhân | `ZALO_ALLOWED_USERS` trong `.env` của Hermes |
| Ai được nhắn riêng | `ZALO_DM_POLICY` |
| Trong nhóm chỉ trả lời khi được tag | `ZALO_GROUP_REPLY_ONLY_TAGGED` |
| Tính cách | `platform_hints.zalo.append` trong `config.yaml` |
| Công cụ mỗi mức quyền được dùng | `known_plugin_toolsets.zalo` + `toolsets_for_source()` |

`data/` của sidecar chỉ giữ phiên đăng nhập Zalo và tệp pid — cả hai do chương trình tự tạo.

> **UID Zalo là dãy số dài 17–21 chữ số, không bắt đầu bằng `0`.** Số điện thoại thì ngược lại. Điền nhầm số điện thoại vào `ZALO_ALLOWED_USERS` thì người đó đơn giản là không khớp với ai — không mở quyền cho ai khác.

---

## Định dạng tin nhắn

Hermes cứ viết Markdown như bình thường; cầu nối dịch sang định dạng gốc của Zalo trước khi gửi:

| Markdown | Hiển thị trên Zalo |
|---|---|
| `# ## ###` tiêu đề | **in đậm** toàn bộ dòng tiêu đề |
| `####` trở xuống | in đậm |
| `1.` `2.` `3.` đầu mục số | **in đậm** phần số thứ tự |
| `- mục` (cấp 1) | `- ` gạch đầu dòng |
| `  • mục` (cấp con thụt lề) | `  • ` dấu chấm tròn |
| `**đậm**` `__đậm__` | in đậm |
| `` `mã` `` | in đậm (Zalo không có chữ đơn cách) |
| `*nghiêng*` `> trích dẫn` | in nghiêng |
| `~~gạch~~` | gạch ngang |
| `[chữ](link)` | chữ (link) |
| `[đỏ]…[/đỏ]` · `[xanh]` `[cam]` `[vàng]` | đổi màu chữ |

### Hai giới hạn của Zalo phải biết

Cả hai đều **không báo lỗi rõ ràng**, nên rất dễ đi tìm nhầm chỗ.

**Độ dài tối đa 3000 ký tự.** Quá thì Zalo trả `"Nội dung quá dài"`. Đo trên tài khoản thật: ASCII, tiếng Việt có dấu và emoji đều dừng ở đúng 3000 — là số **đơn vị mã UTF-16**, không phải byte. Adapter cắt ở 2800 và đếm theo UTF-16, vì mỗi emoji là 1 với `len()` của Python nhưng 2 với Zalo.

Câu trả lời dài được cắt ở chỗ đọc được: hết đoạn, rồi hết câu, cuối cùng mới cắt cứng.

**Mảng định dạng bị giới hạn theo kích thước, khoảng 256 ký tự JSON.** Quá thì Zalo chỉ nói `"Lỗi không xác định"`, không nhắc gì tới định dạng.

| Bộ style | Kích thước | |
|---|---|---|
| 8 style in đậm ngắn | 256 | ✅ |
| 7 style thật của bài | 237 | ✅ |
| 8 style thật (có màu) | 277 | ❌ |
| 9 style in đậm ngắn | 288 | ❌ |

Đây **không** phải giới hạn theo số lượng — một style màu tốn 38 ký tự còn in đậm chỉ 31, nên đếm số style sẽ lúc đúng lúc sai.

Vì thế tiêu đề dùng **một** style cỡ chữ thay vì chồng đậm + màu:

| Cách | Chi phí | Số style |
|---|---|---|
| Đậm + màu (cũ) | 69 | 2 |
| Đậm + phóng to | 65 | 2 |
| **Chỉ phóng to** | **34** | **1** |

Chỗ tốn không nằm ở màu mà ở việc chồng hai style lên cùng một dòng. Một câu trả lời bình thường sinh 30–50 style, nên nếu không tiết chế thì gần như **mọi** câu trả lời có định dạng đều không gửi nổi — bot đọc xong, soạn xong, rồi im lặng.

Khi vẫn quá ngân sách, `capStyles` giữ lại theo mức quan trọng: tiêu đề → màu người dùng tự đánh dấu → in đậm → nghiêng. Phần bị bỏ hiện thành chữ thường, **mất định dạng chứ không mất nội dung**.

---

## API

Chỉ còn đúng bốn route mà trang quét QR và giám sát runtime cần. Sáu route khác (đọc/ghi cấu hình, liệt kê nhóm, gửi tin tay) đã bị xoá: không giao diện nào gọi chúng, chúng không có xác thực, và hai trong số đó gửi được tin nhắn hoặc ghi đè cấu hình.

| Đường dẫn | Việc |
|---|---|
| `GET /api/status` | Trạng thái đăng nhập, chế độ, đã cắm Hermes chưa |
| `POST /api/qr/start` | Bắt đầu đăng nhập QR |
| `GET /api/health` | Ảnh chụp sức khoẻ runtime: trạng thái tổng (`healthy`/`degraded`/`unhealthy`), thời gian chạy, trạng thái phiên Zalo, số client bridge đang gắn và có client nào "nguội" không, tình trạng SQLite, tiến trình backfill, mốc thời gian tin gửi/nhận gần nhất, lỗi gần nhất, và `authorization.ownerConfigured` — có `ZALO_ALLOWED_USERS` hợp lệ hay chưa |
| `POST /api/logout` | Đăng xuất, xoá phiên |

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
