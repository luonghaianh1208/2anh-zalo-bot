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

Mã còn hỗ trợ `[green]`, `[orange]`, `[yellow]` (bí danh tiếng Việt không dấu: `[xanh]`, `[cam]`, `[vang]`) nhưng **không có quy ước dùng cố định** — tuỳ ngữ cảnh mà chọn, đừng lạm dụng. Màu dùng nhiều thì mất tác dụng nhấn mạnh, tin nhắn nhìn rối thay vì rõ.

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

## Ghi chú kỹ thuật

Bot cứ viết Markdown bình thường như khi trả lời trên Telegram; hệ thống tự dịch sang định dạng gốc của Zalo trước khi gửi. Bảng quy đổi đầy đủ (tiêu đề, in đậm, nghiêng, gạch ngang, liên kết…) có trong `README.vi.md`, mục "Định dạng tin nhắn".

---

## Đây là bộ mặc định — sửa được

Những gì ở trên là bộ hướng dẫn trình bày **mặc định**, đúc từ kinh nghiệm dùng thật, áp dụng chung cho mọi khách hàng vì đây là quy tắc trình bày phổ quát, không phụ thuộc bot dùng cho việc gì.

Muốn sửa: mở `platform_hints.zalo.append` trong `config.yaml` của Hermes và chỉnh trực tiếp nội dung ở đó — đó là bản đã được trình cài chép vào, không phải tệp này.
