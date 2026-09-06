# Thêm công cụ mới — những cái bẫy đã trả giá

Tài liệu này không mô tả kiến trúc (xem README). Nó ghi lại **những chỗ hỏng mà
không báo lỗi** — loại lỗi tốn nhiều giờ nhất, vì mọi thứ trông vẫn chạy đúng.

Điểm chung của cả năm bẫy dưới đây: hệ thống không hề gãy. Log vẫn xanh, bot vẫn
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

## Hạn chế đã biết

- **`zalo_read_history` không dùng được.** `getGroupChatHistory` trả HTTP 404 với
  zca-js 2.1.2 (bản mới nhất trên npm tại thời điểm ghi), cả khi gọi đúng chữ ký.
  Đây là giới hạn phía thư viện, không phải lỗi cấu hình. Công cụ vẫn đăng ký
  nhưng sẽ báo lỗi khi gọi.
- **Toolset `kanban` lọt cho người trong nhóm.** Hermes có một khối "recover" luôn
  lấy trọn universe của `hermes-<platform>` bất kể override, nên không config nào
  chặn riêng cho Zalo được. Lối duy nhất là `agent.disabled_toolsets`, mà nó áp
  dụng toàn cục cho mọi nền tảng.
