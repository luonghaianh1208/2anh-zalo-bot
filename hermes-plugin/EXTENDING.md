# Thêm công cụ mới — những cái bẫy đã trả giá

Tài liệu này không mô tả kiến trúc (xem README). Nó ghi lại **những chỗ hỏng mà
không báo lỗi** — loại lỗi tốn nhiều giờ nhất, vì mọi thứ trông vẫn chạy đúng.

Điểm chung của sáu cái bẫy dưới đây: hệ thống không hề gãy. Log vẫn xanh, bot vẫn
trả lời, chỉ là trả lời sai thứ. Nên nguyên tắc bao trùm là **đo ở nơi người dùng
thật chạm tới**, không đo ở tầng gần mình nhất.

---

## 1. Hai bản module, hai trạng thái khác nhau

**Triệu chứng:** bot trả lời "Zalo chưa kết nối, chạy `npm start`…" trong khi
log vừa in `sidecar ready — logged in as …`.

Hermes nạp plugin dưới namespace riêng `hermes_plugins.<slug>`. Nếu adapter viết

```python
from plugins.zalo_tools.tools import set_active_adapter   # ✗
```

thì Python dựng ra một đối tượng module **thứ hai**, mang `_ACTIVE_ADAPTER` riêng:

```
adapter  ──gắn cầu vào──>  plugins.zalo_tools.tools          _ACTIVE_ADAPTER = adapter
agent    ──gọi công cụ──>  hermes_plugins.zalo_tools.tools   _ACTIVE_ADAPTER = None
```

Hai bên không bao giờ gặp nhau. Cách đúng là phân giải lúc chạy (xem `_zalo_tools()`
trong `zalo/adapter.py`) và **ghi tên module đã chọn vào log**:

```
[zalo] connected to sidecar at ws://… (công cụ: hermes_plugins.zalo_tools.tools)
```

> **Áp dụng rộng:** bất kỳ trạng thái nào chia sẻ giữa hai plugin đều dính bẫy này.
> Hằng số là chuỗi thì trùng lặp vô hại — chỉ **trạng thái thay đổi được** mới bắt
> buộc dùng chung một bản.

## 2. Plugin `kind: platform` nạp lười

Hermes hoãn import mọi platform plugin cho tới khi gateway thật sự chạm tới nền
tảng đó. Công cụ đăng ký ở đấy vào registry **muộn hơn** lúc Hermes chốt danh sách
toolset, nên bị coi là tên lạ và loại sạch — không một dòng cảnh báo.

**Quy tắc:** công cụ luôn nằm ở plugin `kind: standalone` riêng. Platform plugin
chỉ giữ adapter.

## 3. Hermes tự bật mọi toolset plugin nó chưa từng thấy

Đây là bẫy nguy hiểm nhất, vì nó **âm thầm vô hiệu hoá phân quyền**. Toolset mới
mặc định BẬT cho mọi phiên cho tới khi được khai là "đã biết":

```yaml
known_plugin_toolsets:
  zalo:
    - zalo_owner
    - zalo_public
```

Thiếu dòng này thì `zalo_owner` được cấp cho cả người lạ nhắn vào nhóm, dù adapter
đã giới hạn qua `toolsets_for_source()`.

## 4. Đừng đặt tên toolset trùng khoá nền tảng

Toolset tên `zalo` bị Hermes tự bật cho mọi phiên vì trùng khoá platform. Đổi
thành `zalo_owner` mới chặn được. (Đổi tên là cần, nhưng chưa đủ — vẫn phải làm
mục 3.)

## 5. Phân toolset chỉ là *giấu*, không phải *chặn*

Mục 3 và 4 cho thấy danh sách toolset có thể bị hệ thống can thiệp sau lưng mình.
Nên rào chắn thật phải nằm ở **tầng thực thi**: mỗi công cụ nhóm chủ nhân được
bọc một lớp kiểm tra danh tính người gửi (`_owner_only` trong `tools.py`). Dù công
cụ có lọt vào danh sách vì cấu hình sai, người ngoài gọi vẫn bị từ chối.

## 6. Composite `hermes-<platform>` tự sinh kéo theo cả kanban

Bẫy này ảnh hưởng **mọi** plugin platform, không riêng Zalo.

`hermes-zalo` không có trong `TOOLSETS`. Khi thiếu, `resolve_toolset()` tự sinh nó
bằng `_HERMES_CORE_TOOLS` — và bộ lõi ấy chứa sẵn 14 công cụ `kanban_*`. Khối
"recover non-configurable toolsets" trong `tools_config.py` thấy
`kanban ⊆ universe` nên bật kanban cho **mọi** người nhắn vào nền tảng, đi vòng
qua `toolsets_for_source()`. Không cấu hình nào cản được:
`known_builtin_toolsets` không ăn thua (kanban không phải "recently shipped"),
còn `agent.disabled_toolsets` thì áp dụng toàn cục cho mọi nền tảng.

Cách xử lý ở đây (`define_platform_composite()` trong `tools.py`): **định nghĩa
tường minh** `hermes-zalo` để nhánh tự sinh không chạy nữa, lấy
`_HERMES_CORE_TOOLS` làm gốc (để bám theo Hermes khi nâng cấp) và trừ đi đúng
phần kanban. Chủ nhân vẫn dùng kanban qua Zalo được vì adapter liệt kê thẳng
`kanban` trong override dành riêng cho họ.

> Nhớ dọn `toolsets._resolve_toolset_memo` sau khi định nghĩa: bộ đệm khoá theo
> registry chứ không theo `TOOLSETS`, nên định nghĩa đến muộn có thể bị kết quả
> đã đệm che mất.

---

## Ghép API zca-js: đọc `.d.ts`, đừng tin trí nhớ

Tên trường giữa các API **không** thống nhất. Đầu ra của API này thường không
vừa đầu vào của API kia.

Ví dụ đã trả giá — `zalo_send_sticker` im lặng thất bại suốt vì:

| | Hình dạng |
|---|---|
| `searchSticker` **trả về** | `{sticker_id, cate_id, type}` — snake_case |
| `sendSticker` **đòi** | `{id, cateId, type}` — camelCase, tên khác |

Truyền thẳng object sang thì `id`/`cateId` thành `undefined`, Zalo trả
`"Missing sticker id"`, còn agent thì thử vài lượt rồi tự chế lại câu trả lời
bằng emoji chữ — nhìn từ ngoài y như bot "không thích" gửi sticker.

Cũng vậy, **số lượng tham số** phải khớp. `getGroupChatHistory(groupId, count?)`
chỉ nhận hai; gọi ba tham số thì `null` rơi vào chỗ `count` và số tin yêu cầu bị
bỏ qua trong im lặng.

**Quy trình bắt buộc trước khi thêm một công cụ gọi API mới:**

```bash
cat node_modules/zca-js/dist/apis/<tenApi>.d.ts
```

Đọc đúng ba thứ: **thứ tự tham số**, **số lượng tham số**, **tên trường** của
object. Rồi gọi thử thật qua cầu nối trước khi viết công cụ Python.

---

## Kiểm chứng: đo đúng tầng

Ba lần trong quá trình làm, phép thử báo xanh trong khi hệ thống thật vẫn hỏng —
đều vì đo ở tầng thấp hơn tầng người dùng chạm tới:

| Đã đo | Bỏ qua mất | Hệ quả |
|---|---|---|
| `resolve_toolset()` trực tiếp | `_get_platform_tools()` | tưởng agent có công cụ, thực ra không |
| script Node gọi thẳng bridge | toàn bộ tầng Python | sticker "gửi được" nhưng bot vẫn không gửi được |
| số toolset trả về | công cụ có gọi nổi không | tưởng phân quyền xong, thực ra công cụ chết |

**Thứ tự kiểm chứng đúng, từ yếu tới mạnh:**

1. Đọc `.d.ts` — biết hình dạng đúng
2. Gọi thật qua cầu nối — biết API sống
3. Gọi qua handler Python với `set_turn_context` — biết phân quyền và ngữ cảnh đúng
4. **Tag bot trong nhóm thật** — cái duy nhất chứng minh cả chuỗi thông

Chỉ bước 4 mới là bằng chứng. Ba bước trên chỉ giúp thu hẹp chỗ hỏng.

---

## Log lúc đăng ký plugin KHÔNG tới được tệp

Plugin nạp trước khi handler ghi log gắn vào, nên mọi `logger.info` trong
`register()` biến mất — kể cả khi đăng ký thành công. Đừng dùng nó để xác minh.

Chỗ đo được thật là **trong adapter lúc `connect()`**: logger ở đó đã hoạt động,
và nó nằm trong đúng tiến trình gateway đang chạy. Xem
`_log_permission_selfcheck()` — mỗi lần khởi động ghi đúng hai dòng:

```
[zalo] tự kiểm quyền — chủ nhân: 92 công cụ (39 Zalo), nhạy cảm: [...]
[zalo] tự kiểm quyền — người trong nhóm: 13 công cụ (13 Zalo), không có công cụ nhạy cảm
```

Nếu dòng thứ hai có bất kỳ công cụ nhạy cảm nào, phân quyền đã hỏng — biết ngay
lúc khởi động thay vì đợi ai đó phát hiện trong nhóm.


---

## Trạng thái từng công cụ (kiểm chứng 2026-09-06)

Đã gọi thật qua cầu nối, không suy từ tài liệu. Bot lúc kiểm là **phó nhóm** ở
nhóm thử.

**Chạy được — 31 công cụ.** Toàn bộ nhóm đọc dữ liệu, gửi nội dung (văn bản,
sticker, tệp, liên kết, thoại, chuyển tiếp), bình chọn, lời nhắc, đổi tên nhóm,
link nhóm, tắt thông báo, ghim, hồ sơ bot, sổ người quen, kho tài liệu, đọc
trang web.

**Hỏng — 3 công cụ:**

| Công cụ | Triệu chứng | Nguyên nhân |
|---|---|---|
| `zalo_read_history` | HTTP 404 | Giới hạn zca-js 2.1.2, gọi đúng chữ ký vẫn hỏng |
| `zalo_undo` | Không dùng được | `sendMessage` chỉ trả `{msgId}`, còn `undo` đòi cả `cliMsgId` — không có đường lấy |
| `zalo_web_search` | Backend từ chối | Chưa đặt `EXA_API_KEY` hoặc backend tìm kiếm khác cho Hermes |

`zalo_undo` sửa được: listener vẫn nhận lại tin bot tự gửi (kèm `cliMsgId`), nên
có thể đệm một bảng `msgId → cliMsgId` ngắn hạn rồi tra khi thu hồi.

**Chưa kiểm được — 6 công cụ.** Chúng để lại dấu vết vĩnh viễn hoặc tác động
tới người thật, nên không thử tự động: `zalo_create_note` (không có API xoá ghi
chú), `zalo_create_group`, `zalo_invite_to_groups`, `zalo_join_group_link`,
`zalo_group_member_change`, `zalo_group_deputy`, `zalo_review_member` (cần có
người đang chờ duyệt). Tham số của chúng đã đối chiếu với `.d.ts`, nhưng đối
chiếu không phải là bằng chứng.

---

## Hai lỗi khả dụng đã sửa trong đợt này

**`zalo_list_groups` trả về vô dụng.** `getAllGroups` một mình chỉ cho
`{groupId: version}` — agent nhận một nắm số và không nói nổi cho người dùng
biết đó là nhóm nào. Nay gọi thêm `getGroupInfo` để trả tên, sĩ số và vai trò
của bot trong nhóm.

**Tạo được lời nhắc mà không xoá được.** Đặt nhầm giờ là lời nhắc nằm lại trong
nhóm vĩnh viễn, phải nhờ người vào Zalo xoá tay. Đã thêm `zalo_remove_reminder`.

Bài học chung: một công cụ "gọi không lỗi" chưa chắc dùng được. Phải nhìn vào
thứ nó trả về và hỏi *agent làm gì được với cái này*, và mỗi hành động tạo ra
thứ gì đó phải có đường dọn tương ứng.
