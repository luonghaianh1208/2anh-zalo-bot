# Cron cho mọi nhóm Zalo — gửi được ngoài lượt chat, thành viên tự tạo cron

**Ngày:** 2026-09-11
**Trạng thái:** Thiết kế đã duyệt trong chat, chờ duyệt bản spec
**Dự án:** 2anh-zalo-bot (bản đang chạy thật: Lăng Tiêu, v1.3.0 `13d62ed`)

---

## 1. Bối cảnh — lỗi đã xác minh

Chủ nhân tạo cron trong một nhóm Zalo thì cron không gửi được vào nhóm đó, và
khi chạy cũng không dùng được công cụ Zalo nào. Hai nguyên nhân gốc:

### 1.1 Sidecar chặn mọi tin gửi ngoài lượt chat, trừ tới chủ nhân và kênh nhà

Ngoài một lượt chat, adapter không có người gửi nên gắn `actorRole: "system"`
(`hermes-plugin/zalo_tools/tools.py` — `current_authorization`). Sidecar chỉ
cho vai trò này gửi tới UID chủ nhân hoặc `ZALO_HOME_CHANNEL`
(`zalo-policy.js:91-98`).

Mọi đường gửi không gắn với tin vừa tới đều rơi vào đây:

- kết quả cron (`cron/scheduler.py` → `DeliveryRouter` → `adapter.send`);
- câu trả lời dang dở gửi bù sau khi gateway khởi động lại
  (`gateway/run.py` — `_redeliver_pending_obligations`, bật do
  `gateway.delivery_ledger: true`).

**Bằng chứng** — `audit_log` của Lăng Tiêu (`data/zalo.sqlite`), 18 lần
`auth_required` khi gửi vào nhóm `9133571695356732407`:

| Thời điểm | Vai trò | Ghi chú |
|---|---|---|
| 08/09 18:04, 09/09 00:15, 09/09 10:59 | public (auth rỗng, trước v1.1.1) | kèm cả tin tới DM chủ nhân |
| 11/09 07:14 | public | 4 lần, ngay sau khi gateway khởi động |
| 11/09 09:10, 09:13 | system | 4 lần mỗi đợt, ngay sau khi gateway khởi động |

Hai cron đang chờ chạy trên Lăng Tiêu sẽ gặp đúng lỗi này:
"Nhắc trước 3 ngày: NK Tiếng nói Xanh" (18/09 07:30) và "NK Ma túy" (25/09 07:30),
cả hai `deliver: zalo:9133571695356732407`.

### 1.2 Công cụ Zalo trong cron không biết mình đang chạy cho ai

Cron chạy không có lượt chat nên `_turn()` rỗng:

- công cụ chủ nhân bị `_owner_only` chặn (`tools.py:2104-2109`);
- công cụ công khai bị `_scoped_thread` chặn ("không xác định được cuộc trò
  chuyện hiện tại");
- dù lọt qua Python, sidecar cũng chỉ cho `system` gửi chữ, không cho `invoke`.

Hermes có sẵn đầu mối để gỡ: mọi lời gọi công cụ nhận `task_id`, và với cron
nó có dạng `cron:<job_id>:<execution_id>` (`cron/scheduler.py:6134-6137`,
truyền qua `registry.dispatch(..., task_id=...)` tới handler). Công cụ đọc lại
job bằng `cron.jobs.get_job(job_id)` là biết nhóm đích và người tạo.

## 2. Mục tiêu

1. Cron do **chủ nhân** tạo gửi được vào **bất kỳ** nhóm hay DM nào, và dùng
   được công cụ Zalo với quyền chủ nhân.
2. Câu trả lời gửi bù sau khi gateway khởi động lại tới được nhóm.
3. **Thành viên nhóm** tự tạo, xem, xoá cron của nhóm mình qua bot — trong
   giới hạn an toàn ở mục 4.

## 3. Phi mục tiêu

- Không đưa công cụ cron gốc `cronjob_manage` cho thành viên (nó nhận
  `script`, `workdir`, `no_agent`, `enabled_toolsets`… — tức chạy lệnh trên máy).
- Không dựng bộ hẹn giờ riêng trong sidecar Node.
- Không sửa lõi Hermes Agent.
- Không làm persona riêng theo nhóm.
- Không triển khai VPS trong đợt này (làm sau khi Lăng Tiêu chạy ổn).

## 4. Quyết định đã chốt

| Câu hỏi | Chốt |
|---|---|
| Ai tạo được cron trong nhóm | Chủ nhân **và** thành viên |
| Cron của thành viên chạy được gì | AI soạn nội dung; tra web, đọc web, đọc kho tài liệu, đọc lịch sử **chính nhóm đó** |
| Giới hạn số lượng | 3 cron đang bật / người, 10 / nhóm |
| Tần suất lặp dày nhất | 1 lần / ngày (cron một lần thì hẹn giờ nào cũng được) |
| Ai xoá được | Người tạo và chủ nhân; ai trong nhóm cũng xem được |
| Cron tạo bằng `cronjob_manage` | Chạy với quyền chủ nhân — chỉ chủ nhân có công cụ này |

## 5. Thiết kế

### 5.1 Sidecar — `zalo-policy.js`

1. **`system` gửi được tới mọi hội thoại.** Bỏ điều kiện "chủ nhân hoặc kênh
   nhà" cho `send` và `typing`. Vai trò `system` vẫn **không** được `invoke`,
   `history`, `undo` hay bất cứ lệnh nào khác.

   Vì sao an toàn: cầu nối chỉ nghe `127.0.0.1` và bắt token
   (`hermes-bridge.js` — `verifyClient`), nên `system` chỉ có thể đến từ chính
   Hermes. Người ngoài không tạo được lượt `system`: mọi tin của họ đều đi qua
   `_bind_turn_for_source` và mang vai trò `public` (xem 5.2.2).
2. **`history` mở cho `public` nhưng khoá trong đúng hội thoại.** Đổi
   `minimumRole` của lệnh `history` từ `owner` sang `public`; nhánh
   `sameThread` sẵn có đã so `threadId`/`threadType` của lệnh với
   `auth.sourceThreadId`. Python quyết định công cụ nào được phát lệnh này
   (5.4), nên chat thường của thành viên không đổi hành vi.
3. **Audit ghi mã cron.** Nếu `auth.cronJobId` có mặt, đưa vào
   `targetSummary.cronJobId` để tra được lệnh nào do cron nào phát.

### 5.2 Adapter — `hermes-plugin/zalo/adapter.py`

1. **Bỏ đầu–đuôi tiếng Anh của tin cron.** Khi `metadata` có `job_id` và nội
   dung mở đầu bằng `Cronjob Response:`, bỏ khối đầu tới dòng `-------------`
   và dòng cuối `To stop or manage this job…` trước khi chia tin. Chỉ áp cho
   Zalo; Telegram giữ nguyên (`cron.wrap_response` là cấu hình chung, không đụng).
2. **Gắn danh tính hỏng thì rơi về `public`, không rơi về `system`.**
   Nhánh `except` trong `_bind_turn_for_source` hiện gọi `bind_turn(None)` →
   `_TURN = {}` → `current_authorization` trả `system`. Sau khi 5.1.1 nới
   `system`, nhánh này phải gắn một lượt `public` rỗng danh tính
   (`{"sender_uid": uid, "thread_id": chat_id, "is_owner": False, ...}`) để lỗi
   vẫn đóng.

### 5.3 Nhận diện lượt chạy cron — `hermes-plugin/zalo_tools/tools.py`

Thêm lớp bọc ngoài cùng `_with_cron_turn(handler)` cho **mọi** công cụ trong
`register_tools`:

```
nếu _TURN đang có (lượt chat) → chạy như cũ
ngược lại, nếu kw["task_id"] dạng "cron:<job_id>:..." và get_job(job_id) có:
    target = chat_id từ deliver "zalo:<id>" (ưu tiên) hoặc origin.chat_id
    nếu origin.zalo_scope == "group":          # cron của nhóm (5.5)
        turn = {sender_uid: origin.zalo_creator_uid, thread_id: target,
                is_group: True, is_owner: False, text: "", cron_job_id}
    ngược lại:                                   # cron của chủ nhân
        turn = {sender_uid: <UID đầu tiên trong ZALO_ALLOWED_USERS>,
                thread_id: target, is_group: <theo origin.chat_type / loại hội thoại>,
                is_owner: True, text: "", cron_job_id}
    đặt _TURN = turn trong đúng lần gọi này, trả lại giá trị cũ khi xong
còn lại → không gắn gì (công cụ tự chặn như hiện nay)
```

- `text: ""` giữ nguyên hàng rào đăng Fanpage: mã duyệt phải nằm trong tin
  người thật gõ, cron không có tin nào.
- `current_authorization` thêm `cronJobId` khi turn có `cron_job_id`.
- Cron của chủ nhân gửi `actorRole: "owner"` với UID nằm trong allowlist nên
  sidecar hiện tại chấp nhận, không cần luật mới.
- Không có `ZALO_ALLOWED_USERS` hoặc job không đọc được → không gắn turn →
  công cụ chặn như cũ (đóng khi lỗi).

### 5.4 Công cụ và toolset riêng cho cron nhóm

- **`zalo_group_history`** — đọc tối đa 100 tin gần nhất của **hội thoại đang
  gắn trong turn**, không nhận `thread_id` từ mô hình. Đăng ký vào toolset mới
  `zalo_cron` (không nằm trong bộ nào `toolsets_for_source` trả về, nên chat
  thường không thấy). Chỉ chạy khi turn có `cron_job_id`; ngoài cron trả lỗi.
- **Toolset ghép `zalo_cron_member`** — dựng bằng `create_custom_toolset`
  (giống `define_platform_composite`), gồm đúng: `zalo_web_search`,
  `zalo_web_read`, `zalo_kb_list`, `zalo_kb_read`, `zalo_group_history`.
- Trình cài thêm `zalo_cron` vào `known_plugin_toolsets.zalo`, để Hermes không
  tự bật toolset lạ này cho mọi phiên.

### 5.5 Công cụ `zalo_group_cron` — thuộc `zalo_public`

Một công cụ, tham số `action`: `create` | `list` | `remove`.

**Chung:**
- Chỉ dùng **trong nhóm** (`turn.is_group`); nhắn riêng trả lỗi.
- **Trong lượt cron thì từ chối mọi action** — cron không được tự đẻ cron.

**`create`** — `prompt` (bắt buộc, ≤ 1000 ký tự), `schedule` (chuỗi Hermes
hiểu, vd `every day at 7am`, `2026-09-18T07:30`, `in 2h`), `name` (tuỳ chọn,
≤ 80 ký tự).

1. `cron.jobs.parse_schedule(schedule)`; lỗi thì trả nguyên văn gợi ý của Hermes.
2. Tần suất:
   - `once`: thời điểm phải ở tương lai.
   - `interval`: `minutes ≥ 1440`.
   - `cron`: lấy 20 lần chạy kế tiếp bằng `croniter`, **khoảng cách nhỏ nhất**
     giữa hai lần liền nhau phải ≥ 1440 phút (chặn kiểu `0 9,10 * * *`).
3. Hạn mức — chỉ áp cho người không phải chủ nhân, đếm job đang bật và chưa
   kết thúc có `origin.zalo_scope == "group"`:
   - của cùng `zalo_creator_uid` trên mọi nhóm: < 3;
   - của cùng nhóm: < 10.
4. Quét prompt bằng `tools.cronjob_tools._scan_cron_prompt` — cùng bộ quét
   `cronjob_manage` dùng; trả chuỗi khác rỗng nghĩa là bị chặn thì trả lỗi đó.
   Không import được (Hermes đổi tên) thì **từ chối tạo**, không bỏ qua bước quét.
5. Gọi `cron.jobs.create_job` với **mọi trường khoá cứng**:

   | Trường | Giá trị |
   |---|---|
   | `prompt` | lời dặn cố định ("Việc hẹn giờ do {tên} tạo trong nhóm này; chỉ viết nội dung sẽ gửi vào nhóm") + prompt của người dùng |
   | `schedule`, `name` | đã kiểm |
   | `repeat` | `1` nếu `once`, `None` nếu lặp |
   | `deliver` | `zalo:<nhóm hiện tại>` |
   | `origin` | `{platform: "zalo", chat_id, chat_name, chat_type: "group", user_id, zalo_scope: "group", zalo_creator_uid, zalo_creator_name}` |
   | `enabled_toolsets` | `["zalo_cron_member", "no_mcp"]` |
   | `script`, `workdir`, `skills`, `model`, `provider`, `base_url`, `context_from`, `monitor_*` | không truyền |
   | `no_agent` | `False` |

   Chủ nhân dùng `zalo_group_cron` cũng ra đúng loại job hạn chế này (chỉ được
   miễn hạn mức); muốn toàn quyền thì dùng công cụ cron gốc như trước.

**`list`** — mọi job có đích là nhóm hiện tại (`deliver == zalo:<nhóm>` hoặc
`origin.chat_id == nhóm`): mã, tên, lịch, lần chạy kế tiếp, người tạo. Job của
chủ nhân ghi "chủ nhân" và **ẩn prompt**.

**`remove`** — `job_id`. Job phải có đích là nhóm hiện tại.
- Job `zalo_scope == "group"`: người tạo hoặc chủ nhân.
- Job khác (của chủ nhân): chỉ chủ nhân.

## 6. Luồng dữ liệu

**Thành viên tạo cron:**
tag bot trong nhóm → adapter gắn turn `public` → agent gọi
`zalo_group_cron(create)` → kiểm lịch, tần suất, hạn mức, prompt →
`create_job` với trường khoá cứng → `jobs.json`.

**Đến giờ chạy:**
scheduler dựng agent với `enabled_toolsets = zalo_cron_member` → agent gọi
`zalo_group_history` → `_with_cron_turn` đọc job qua `task_id`, gắn turn
`public` khoá trong nhóm → adapter gửi lệnh `history` kèm auth `public` +
`cronJobId` → sidecar kiểm `sameThread` → trả lịch sử → agent soạn nội dung →
scheduler gửi kết quả qua `adapter.send` (vai trò `system`) → sidecar cho qua
(5.1.1) → adapter đã bỏ đầu–đuôi tiếng Anh (5.2.1) → tin vào nhóm.

**Cron của chủ nhân:** giống trên, nhưng turn là `owner`, toolset theo cấu hình
cron hiện có (đủ `zalo_owner`).

## 7. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| `task_id` không phải cron / job đã bị xoá | không gắn turn, công cụ chặn như cũ |
| Lịch sai cú pháp | trả lời thành viên kèm gợi ý định dạng của Hermes |
| Lặp dày hơn 1 ngày | từ chối, nói rõ giới hạn |
| Vượt hạn mức | từ chối, nói còn bao nhiêu cron đang bật |
| Xoá job của nhóm khác / không có quyền | từ chối, không tiết lộ nội dung job |
| Sidecar vẫn từ chối gửi | giữ nguyên đường báo lỗi sẵn có của scheduler (`last_delivery_error`) |

## 8. Kiểm thử

**Node — `zalo-policy.test.js`:**
- `system` gửi `send`/`typing` tới nhóm bất kỳ → cho qua; `system` gọi `invoke`,
  `history`, `undo` → chặn.
- `public` gửi `history` đúng hội thoại → cho qua; hội thoại khác → `cross_thread_denied`.
- `auth.cronJobId` xuất hiện trong `targetSummary` của audit.

**Python — `test_zalo_adapter.py`:**
- `_with_cron_turn`: job không đánh dấu → turn `owner` với UID allowlist; job
  `zalo_scope: group` → turn `public` khoá nhóm; `task_id` thường → không gắn;
  job không tồn tại → không gắn; turn chat sẵn có không bị ghi đè.
- `zalo_group_cron create`: chặn trong DM; chặn trong lượt cron; `interval` <
  1440 bị chặn; cron `0 9,10 * * *` bị chặn; `every day at 7am` qua; `once` quá
  khứ bị chặn; hạn mức 3/người và 10/nhóm; chủ nhân miễn hạn mức; `create_job`
  nhận đúng các trường khoá cứng và **không** nhận `script`/`workdir`/`skills`/`model`.
- `list` ẩn prompt job chủ nhân; `remove` theo đúng bảng quyền.
- `zalo_group_history` ngoài cron → lỗi; trong cron nhóm → đọc đúng nhóm, bỏ
  qua `thread_id` do mô hình truyền.
- Adapter bỏ đầu–đuôi `Cronjob Response` khi có `job_id`, giữ nguyên khi không có.
- `_bind_turn_for_source` gặp ngoại lệ → vai trò `public`, không phải `system`.
- Test sẵn có `test_every_zalo_tool_has_one_unique_public_or_owner_assignment`
  cập nhật cho toolset `zalo_cron`.

**Chạy thật trên Lăng Tiêu** (sau khi test xanh):
1. Cron của chủ nhân `in 2m` gửi vào nhóm test do chủ nhân chỉ định → tin tới
   nhóm, không có đầu tiếng Anh, audit `succeeded`.
2. Thành viên tạo cron `in 2m` có dùng `zalo_group_history` trong nhóm test →
   tin tóm tắt tới nhóm; audit có `cronJobId`.
3. Khởi động lại gateway lúc bot đang trả lời trong nhóm → câu trả lời được gửi bù.

## 9. Rủi ro còn phải kiểm khi chạy thật

1. **Vòng lặp sự kiện.** Công cụ trong cron chạy qua `_run_async` trên luồng
   của cron, còn WebSocket của adapter thuộc vòng lặp gateway. Chat thường đi
   cùng kiểu đường này và đang chạy được (audit: hơn 2.800 lệnh owner thành
   công), nên nhiều khả năng không sao. Nếu bước chạy thật 2 treo hoặc lỗi
   "attached to a different loop": `_command` ghi nhận vòng lặp lúc `connect`
   và chuyển lệnh về vòng đó bằng `run_coroutine_threadsafe`, như
   `tools/send_message_tool.py` đang làm.
2. **Định dạng `task_id` là chi tiết nội bộ của Hermes.** Có test ghim; nâng
   Hermes mà đổi định dạng thì test đỏ trước khi lên máy thật.
3. **Ngữ cảnh hệ thống của agent cron** vẫn nạp `SOUL.md`/`USER.md` như mọi
   lượt chat trong nhóm — cùng mức rủi ro với chat nhóm hiện nay, không rộng hơn.
4. **Chi phí AI:** tối đa 10 cron nhóm × 1 lần/ngày cho mỗi nhóm.

## 10. Triển khai

1. Nhánh `feat/zalo-cron-nhom` trong repo, test xanh (`npm test`).
2. Cài vào Lăng Tiêu bằng `npm run install:hermes -- --hermes-home E:/Hermes`,
   khởi động lại sidecar rồi gateway, chạy 3 bước kiểm thật ở mục 8.
3. Nâng phiên bản 1.4.0, cập nhật `CHANGELOG.md`, README (bảng công cụ, mục cron),
   gộp vào `main`, đẩy GitHub.
4. VPS: đợt riêng, theo đánh giá thay thế bot Tino đã làm ngày 2026-09-11.
