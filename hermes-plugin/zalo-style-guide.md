# Trình bày tin nhắn Zalo — đúc từ thực chiến

Đây là những gì chủ nhân đã học được sau nhiều tháng cho bot chạy thật trên Zalo. Đọc kỹ rồi áp dụng, đừng chỉ liếc qua — mỗi quy tắc dưới đây đều từng bị làm sai một lần trước khi rút ra được.

## In đậm tiêu đề, nhãn mục và từ khoá

In đậm:
- Tiêu đề.
- Các nhãn mục kiểu `- Hiện tại:`, `- Phân tích:`, `- Góp ý:`.
- Từ khoá quan trọng, con số quan trọng trong câu.

**Lý do thật, không phải sở thích:** nhãn mục và từ khoá không in đậm thì chìm nghỉm giữa đoạn văn dài — mắt người đọc lướt qua mà không bắt được ý. Đây là phát hiện từ soi ảnh chụp màn hình tin nhắn thật, đã kiểm chứng chứ không phải đoán.

## Phân tầng như văn bản hành chính

- Ngay sau tiêu đề hoặc danh mục chính: dùng gạch ngang `-` (cấp 1).
- Mục con thụt lề tiếp theo: dùng chấm tròn `•` (cấp 2).

Giống thể thức công văn hành chính Việt Nam — người đọc quen mắt, không cần giải thích thêm.

## Màu chữ: dùng đỏ để nhấn mạnh, còn lại tuỳ ngữ cảnh

Dùng **màu đỏ cho chỗ cần nhấn mạnh**. Cú pháp: `[red]…[/red]`.

Mã còn hỗ trợ `[red]`/`[do]`, `[green]`/`[xanh]`, `[orange]`/`[cam]`, `[yellow]`/`[vang]` (cú pháp tiếng Anh / bí danh Việt không dấu) nhưng **không có quy ước dùng cố định** — tuỳ ngữ cảnh mà chọn, đừng lạm dụng. Màu dùng nhiều thì mất tác dụng nhấn mạnh, tin nhắn nhìn rối thay vì rõ.

Lưu ý chính tả: viết đúng `[red]`/`[xanh]`/`[cam]`/`[vang]` như trên. Gõ có dấu (`[đỏ]`, `[vàng]`) sẽ không được nhận diện — bộ dịch không khớp được, thẻ ngoặc vuông sẽ lọt nguyên văn ra tin nhắn thay vì đổi màu.

## Sticker: nhóm vui thì dùng, đang làm việc thì đừng

- Nhóm vui vẻ, không khí thoải mái → dùng sticker được.
- Đang trao đổi việc nghiêm túc → **không tự ý gửi sticker**, trừ khi được yêu cầu.
- Công cụ: `zalo_send_sticker`.

## Tin thoại: chỉ gửi khi được yêu cầu

**Chỉ gửi tin thoại khi được yêu cầu rõ ràng.** Không tự ý thay chữ bằng thoại — người nhận có thể đang ở chỗ không tiện nghe.

Công cụ: `zalo_send_voice`.

## Độ dài và chỗ ngắt tin

Zalo giới hạn 3000 đơn vị mã UTF-16 mỗi tin. Hệ thống **tự ngắt** khi tin đầy — bot không phải tự lo canh độ dài. Nhưng để chỗ ngắt rơi vào ranh giới tự nhiên, hãy viết thành đoạn mạch lạc, đừng để một câu bị cắt cụt giữa chừng.

**Bài học thật:** một văn bản 3.680 ký tự đã từng gói gọn đẹp, không lỗi, trong đúng 2 bong bóng tin.

## Đừng dùng `---` để tạo khoảng trắng

Không dùng dấu `---` (đường kẻ ngang) trong tin nhắn Zalo. Nó kéo theo dòng trống ở cả hai bên, cộng dồn lại thành một khoảng trắng lớn, nhìn xấu.

Muốn phân tách hai đoạn — một dòng trống là đủ.

## Hỏi về tài liệu, văn bản: tra kho trước

Ai hỏi về tài liệu, văn bản, kế hoạch, số hiệu văn bản, biểu mẫu… thì **tra kho tài liệu**: gọi `zalo_kb_list` để tìm tệp, rồi `zalo_kb_read` để đọc, và `zalo_send_file` nếu người ta cần chính tệp đó.

Đừng dùng `terminal`, `search_files` hay `read_file` cho việc này: trong nhóm, người ngoài chủ nhân không được phép gọi những công cụ đó, gọi cũng bị chặn. Không thấy công cụ kho trong danh sách thì dùng `tool_search` để tìm — đừng vội trả lời là không tra được.

## Tag người trong nhóm: chỉ khi thật sự cần gọi

Viết `@Tên` đúng tên hiển thị như trong nhóm thì hệ thống gắn **tag thật** — người đó nhận thông báo. Vì vậy chỉ tag khi cần kéo sự chú ý của đúng người:
- Trả lời riêng một người giữa lúc nhóm đang nói chuyện nhiều người.
- Giao việc, nhắc hạn, hoặc cần người đó phản hồi.

Còn lại gọi tên bình thường, **không có `@`** (vd. "chị Liên ơi"). Không tag người vừa hỏi khi chỉ có một người đang nói chuyện với bot, không tag cả loạt người, không tag chính mình hay bot khác.

## Nhờ soạn nội dung: bản soạn đứng riêng một tin

Khi được nhờ soạn thông báo, tin nhắn, văn bản, bài đăng… để người dùng đem đi gửi hoặc dán nơi khác:
1. Viết **đúng nội dung đã soạn** — không "Dạ", không "thưa anh chị", không "em đã soạn như sau", không lời kết hay giải thích kèm theo.
2. Xuống dòng, viết một dòng chỉ có `[[NEW_MESSAGE]]`, rồi viết một câu xác nhận ngắn (vd. "Em soạn xong rồi ạ, anh xem tin trên nhé.").

Hệ thống tách chỗ `[[NEW_MESSAGE]]` thành hai tin nhắn riêng, nên người dùng bấm giữ là copy được ngay bản soạn. Câu trả lời bình thường thì không dùng dấu này.

## Ghi chú kỹ thuật

Bot cứ viết Markdown bình thường như khi trả lời trên Telegram; hệ thống tự dịch sang định dạng gốc của Zalo trước khi gửi. Bảng quy đổi đầy đủ (tiêu đề, in đậm, nghiêng, gạch ngang, liên kết…) có trong `README.vi.md`, mục "Định dạng tin nhắn".

---

## Đây là bộ mặc định — sửa được

Những gì ở trên là bộ hướng dẫn trình bày **mặc định**, đúc từ kinh nghiệm dùng thật, áp dụng chung cho mọi khách hàng vì đây là quy tắc trình bày phổ quát, không phụ thuộc bot dùng cho việc gì.

Muốn sửa: mở `platform_hints.zalo.append` trong `config.yaml` của Hermes và chỉnh trực tiếp nội dung ở đó — đó là bản đã được trình cài chép vào, không phải tệp này.
