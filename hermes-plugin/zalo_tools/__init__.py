"""Bộ công cụ Zalo — đăng ký sớm để Hermes công nhận toolset.

Vì sao tách khỏi ``plugins/platforms/zalo``: Hermes nạp mọi plugin
``kind: platform`` theo kiểu lười (xem ``_register_deferred_platform``) để
``hermes chat`` không phải import cả hai chục nền tảng mỗi lần khởi động. Hệ
quả là công cụ do một platform plugin đăng ký chỉ vào registry khi gateway
chạm tới nền tảng đó — muộn hơn lúc Hermes lập danh sách khoá toolset, nên
``zalo`` và ``zalo_public`` bị coi là tên lạ và agent mất sạch công cụ.

Plugin ``standalone`` nạp ngay lúc khám phá, nên đặt công cụ ở đây là đủ.
Adapter nền tảng vẫn nằm bên ``platforms/zalo`` và import lại từ đây.
"""

import logging

from .group_permissions import publish_video_policy
from .tools import (define_cron_member_toolset, define_platform_composite,
                    guard_member_tool_call, register_tools, set_studio_context)

logger = logging.getLogger(__name__)

__all__ = ["register"]


def register(ctx) -> None:
    """Điểm vào plugin — Hermes gọi lúc khám phá."""
    register_tools(ctx)
    # Xưởng tạo sản phẩm gọi AI qua ctx.llm (không công cụ) — giữ ctx để lấy lúc cần.
    set_studio_context(ctx)
    # Dashboard đọc studio-policy.json để khoá nút video: ghi ngay lúc nạp, không đợi lời gọi zalo_studio đầu tiên.
    try:
        publish_video_policy()
    except Exception:  # cố hết sức — không được làm hỏng việc nạp plugin
        logger.warning("[zalo] không ghi được studio-policy.json lúc nạp plugin", exc_info=True)
    # Cảnh báo hành vi nguy hiểm trong nhóm: adapter tìm mô-đun đã nạp theo namespace của Hermes — nạp sẵn ở đây.
    try:
        from . import group_safety  # noqa: F401
    except Exception:  # cố hết sức — thiếu thì chỉ không có cảnh báo
        logger.warning("[zalo] không nạp được bộ lọc an toàn nhóm", exc_info=True)
    # Insight nhóm (spec §18.5): luồng nền nhận yêu cầu tóm tắt từ dashboard qua tệp, gọi ctx.llm không công cụ.
    try:
        from .insight_ai import start_insight_worker
        start_insight_worker(lambda: getattr(ctx, "llm", None))
    except Exception:  # cố hết sức — dashboard sẽ báo "trợ lý chưa trả lời"
        logger.warning("[zalo] không bật được luồng tóm tắt nhóm", exc_info=True)
    # Rào chắn tại điểm thực thi: Hermes cấp lại công cụ đã ghim của phiên nhóm
    # cho mọi lượt, kể cả lượt của người ngoài. Xem guard_member_tool_call().
    ctx.register_hook("pre_tool_call", guard_member_tool_call)
    # Bộ nhớ trợ lý sửa giữa chừng (dashboard / cuộc trò chuyện khác): phiên đang chạy dùng lại lời nhắc cũ đã lưu,
    # nên đính phần chênh vào tin của lượt — xem memory_drift.py.
    try:
        from . import memory_drift
        ctx.register_hook("pre_llm_call", memory_drift.pre_llm_call)
    except Exception:  # cố hết sức — thiếu thì phiên đang chạy chỉ thấy bộ nhớ mới khi bắt đầu phiên mới
        logger.warning("[zalo] không bật được báo bộ nhớ vừa cập nhật", exc_info=True)
    # Thẻ phân loại bộ nhớ: bot vừa ghi nhớ → AI tách thành thẻ một ý + gắn loại (luồng nền); dashboard xin đề xuất
    # "Sắp xếp lại" qua cùng hàng đợi — xem memory_tags.py.
    try:
        from . import memory_tags
        memory_tags.start_worker(lambda: getattr(ctx, "llm", None))
        ctx.register_hook("post_tool_call", memory_tags.post_tool_call)
    except Exception:  # cố hết sức — thiếu thì bộ nhớ vẫn chạy, chỉ không tự gắn thẻ
        logger.warning("[zalo] không bật được gắn thẻ bộ nhớ", exc_info=True)
    # Câu hỏi cần thông tin mới ("mới nhất", giá, quy định…): plugin tự tra web trước rồi đính kết quả + luật dùng nguồn
    # vào tin của lượt — mô hình không thể "quên tra" (xem freshness.py). Tắt ở Cấu hình › Phong cách trả lời.
    try:
        from . import freshness
        ctx.register_hook("pre_llm_call", freshness.pre_llm_call)
    except Exception:  # cố hết sức — thiếu thì bot vẫn trả lời, chỉ không tự tra trước
        logger.warning("[zalo] không bật được tra cứu trước khi trả lời", exc_info=True)
    # Skill chủ bot mở cho thành viên (dashboard › Skill › "Thành viên"): báo trợ lý danh sách ở lượt của thành viên.
    try:
        from . import member_skills
        ctx.register_hook("pre_llm_call", member_skills.pre_llm_call)
    except Exception:  # cố hết sức — thiếu thì thành viên không được gợi ý skill, công cụ vẫn dùng được
        logger.warning("[zalo] không bật được skill cho thành viên", exc_info=True)
    # Quy tắc riêng của thư mục (Phân quyền › thư mục): nhóm/người trong thư mục được trả lời theo bộ quy tắc đó.
    try:
        from . import folder_rules
        ctx.register_hook("pre_llm_call", folder_rules.pre_llm_call)
    except Exception:  # cố hết sức — thiếu thì bot trả lời theo vai trò chung
        logger.warning("[zalo] không bật được quy tắc riêng của thư mục", exc_info=True)
    # Cài đặt trả lời (xưng hô, độ dài, màu…) + giờ hiện tại: đính mỗi lượt Zalo, sửa là áp dụng ngay — xem reply_style.py.
    try:
        from . import reply_style
        ctx.register_hook("pre_llm_call", reply_style.pre_llm_call)
    except Exception:  # cố hết sức — thiếu thì bot trả lời theo hướng dẫn mặc định
        logger.warning("[zalo] không bật được cài đặt trả lời", exc_info=True)
    # Kho khoá dự phòng (trang Khoá API & Model): đồng bộ khoá đang dùng vào os.environ trước mỗi lời gọi công cụ,
    # và đổi sang khoá kế khi kết quả công cụ báo lỗi khoá / hết lượt — không cần khởi động lại.
    try:
        from . import key_pool
        key_pool.sync()
        ctx.register_hook("pre_tool_call", key_pool.before_tool_call)
        ctx.register_hook("transform_tool_result", key_pool.on_tool_result)
    except Exception:  # cố hết sức — thiếu kho khoá thì công cụ vẫn chạy với khoá trong .env
        logger.warning("[zalo] không bật được kho khoá dự phòng", exc_info=True)
    # Nguồn tạo ảnh/video (dashboard › Tạo ảnh & video): image_gen.provider "2anh" đi lần lượt Stali → 9router → ChatGPT
    # theo ưu tiên, lỗi thì sang nguồn kế; video_gen.provider "stali". Xem media_engines.py.
    try:
        from . import media_engines
        media_engines.register(ctx)
    except Exception:  # cố hết sức — thiếu thì image_generate/video_generate dùng nguồn khác đã cấu hình
        logger.warning("[zalo] không đăng ký được nguồn tạo ảnh/video", exc_info=True)
    # Phải chạy sau register_tools: định nghĩa dựa trên bộ công cụ lõi và
    # cần dọn bộ nhớ đệm của resolve_toolset sau khi registry đã đổi.
    define_platform_composite()
    define_cron_member_toolset()
