import asyncio
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from jsonschema import Draft7Validator

ROOT = os.path.dirname(__file__)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from gateway.config import PlatformConfig
import plugins
import plugins.platforms

# Chạy test trực tiếp từ repo 2anh-zalo-bot nhưng dùng lõi Hermes đã cài trên máy.
# Ưu tiên hai plugin trong repo này, không vô tình test bản đã cài ở Hermes.
plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
plugins.platforms.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.platforms.__path__)]
from plugins.platforms.zalo import adapter as zalo_adapter
from plugins.zalo_tools import tools as zalo_tools
from cron import jobs as real_cron_jobs


class DummyZaloTools:
    def set_turn_context(self, **kwargs):
        self.context = kwargs


class CapturingSocket:
    def __init__(self):
        self.frames = []

    async def send(self, raw):
        self.frames.append(json.loads(raw))


class FakeToolContext:
    def __init__(self):
        self.handlers = {}
        self.hooks = {}

    def register_tool(self, **kwargs):
        self.handlers[kwargs["name"]] = kwargs["handler"]

    def register_hook(self, hook_name, callback):
        self.hooks.setdefault(hook_name, []).append(callback)


class FakeCronJobs:
    """Thay module cron.jobs của Hermes trong test — giữ job trong bộ nhớ."""

    parse_schedule = staticmethod(real_cron_jobs.parse_schedule)
    is_terminal_job = staticmethod(real_cron_jobs.is_terminal_job)
    effective_job_state = staticmethod(real_cron_jobs.effective_job_state)
    _ensure_croniter = staticmethod(real_cron_jobs._ensure_croniter)

    def __init__(self, jobs=None):
        self.jobs = [dict(job) for job in (jobs or [])]
        self.created = []
        self.removed = []

    @property
    def croniter(self):
        return real_cron_jobs.croniter

    def get_job(self, job_id):
        return next((job for job in self.jobs if job["id"] == job_id), None)

    def list_jobs(self, include_disabled=False):
        return [job for job in self.jobs if include_disabled or job.get("enabled", True)]

    def create_job(self, **kwargs):
        self.created.append(kwargs)
        job = {
            "id": f"new-{len(self.created)}", "enabled": True, "name": kwargs.get("name"),
            "schedule_display": kwargs["schedule"], "next_run_at": None,
            "prompt": kwargs["prompt"], "deliver": kwargs["deliver"], "origin": kwargs["origin"],
        }
        self.jobs.append(job)
        return job

    def remove_job(self, job_id):
        self.removed.append(job_id)
        before = len(self.jobs)
        self.jobs = [job for job in self.jobs if job["id"] != job_id]
        return len(self.jobs) < before


class ZaloAdapterMediaContextTest(unittest.IsolatedAsyncioTestCase):
    def make_adapter(self):
        adapter = zalo_adapter.ZaloAdapter(
            PlatformConfig(
                enabled=True,
                extra={
                    "bridge_url": "ws://127.0.0.1:9",
                    "reply_only_tagged": True,
                    "ack_gestures": False,
                },
            )
        )
        adapter._self_profile = {"user_id": "bot-uid", "display_name": "Lăng Tiêu"}
        adapter._flood.check = lambda _uid: None
        return adapter

    def test_bridge_url_contains_shared_token_without_changing_existing_query(self):
        self.assertEqual(
            zalo_adapter._authenticated_bridge_url(
                "ws://127.0.0.1:3873/path?existing=1", "bridge secret"
            ),
            "ws://127.0.0.1:3873/path?existing=1&token=bridge+secret",
        )
        with self.assertRaisesRegex(ValueError, "ZALO_BRIDGE_TOKEN"):
            zalo_adapter._authenticated_bridge_url("ws://127.0.0.1:3873", "")

    async def test_unmentioned_group_image_is_saved_as_context_only(self):
        adapter = self.make_adapter()
        handled = []

        async def handle(event):
            handled.append(event)

        adapter.handle_message = handle

        await adapter._on_message(
            {
                "type": "message",
                "id": "m1",
                "threadId": "g1",
                "threadType": zalo_adapter.THREAD_TYPE_GROUP,
                "senderUid": "u1",
                "senderName": "Yến",
                "text": "",
                "msgType": "chat.photo",
                "mediaUrls": ["https://example.com/photo.jpg"],
            }
        )

        self.assertEqual(handled, [])
        self.assertEqual(
            list(adapter._recent_group_messages["g1"])[0]["media_urls"],
            ["https://example.com/photo.jpg"],
        )

    async def test_later_mentioned_context_question_attaches_recent_image(self):
        adapter = self.make_adapter()
        handled = []

        async def handle(event):
            handled.append(event)

        adapter.handle_message = handle

        async def fake_cache(url):
            return f"C:/cache/{url.rsplit('/', 1)[-1]}"

        with patch.object(zalo_adapter, "cache_image_from_url", side_effect=fake_cache), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=DummyZaloTools()):
            await adapter._on_message(
                {
                    "type": "message",
                    "id": "m1",
                    "threadId": "g1",
                    "threadType": zalo_adapter.THREAD_TYPE_GROUP,
                    "senderUid": "u1",
                    "senderName": "Yến",
                    "text": "",
                    "msgType": "chat.photo",
                    "mediaUrls": ["https://example.com/photo.jpg"],
                }
            )
            await adapter._on_message(
                {
                    "type": "message",
                    "id": "m2",
                    "threadId": "g1",
                    "threadType": zalo_adapter.THREAD_TYPE_GROUP,
                    "senderUid": "u1",
                    "senderName": "Yến",
                    "text": "@Lăng Tiêu đây là xe máy điện hay xe đạp điện?",
                    "mentions": [{"uid": "bot-uid"}],
                }
            )

        self.assertEqual(len(handled), 1)
        event = handled[0]
        self.assertIn("đây là xe máy điện", event.text)
        self.assertEqual(event.media_urls, ["C:/cache/photo.jpg"])
        self.assertEqual(event.media_types, ["image/jpeg"])
        self.assertIn("Ngữ cảnh gần nhất trong nhóm Zalo", event.channel_context)
        self.assertIn("đã gửi 1 ảnh", event.channel_context)

    async def test_quote_image_is_attached_and_reply_context_set(self):
        adapter = self.make_adapter()
        handled = []
        dummy_tools = DummyZaloTools()

        async def handle(event):
            handled.append(event)

        adapter.handle_message = handle

        async def fake_cache(url):
            return f"C:/cache/{url.rsplit('/', 1)[-1]}"

        with patch.object(zalo_adapter, "cache_image_from_url", side_effect=fake_cache), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=dummy_tools):
            await adapter._on_message(
                {
                    "type": "message",
                    "id": "m3",
                    "threadId": "g1",
                    "threadType": zalo_adapter.THREAD_TYPE_GROUP,
                    "senderUid": "u1",
                    "senderName": "Yến",
                    "text": "@Lăng Tiêu cái này là gì?",
                    "mentions": [{"uid": "bot-uid"}],
                    "quote": {
                        "id": "q1",
                        "authorId": "bot-uid",
                        "authorName": "Lăng Tiêu",
                        "text": "",
                        "cliMsgId": "qc1",
                        "mediaUrls": ["https://example.com/quoted.jpg"],
                    },
                }
            )

        self.assertEqual(len(handled), 1)
        event = handled[0]
        self.assertEqual(event.media_urls, ["C:/cache/quoted.jpg"])
        self.assertEqual(event.reply_to_message_id, "q1")
        self.assertEqual(event.reply_to_text, "[Tin được reply có ảnh]")
        self.assertEqual(event.reply_to_author_id, "bot-uid")
        self.assertEqual(event.reply_to_author_name, "Lăng Tiêu")
        self.assertTrue(event.reply_to_is_own_message)
        self.assertEqual(dummy_tools.context["reply_msg_id"], "q1")
        self.assertEqual(dummy_tools.context["reply_cli_msg_id"], "qc1")
        self.assertTrue(dummy_tools.context["reply_is_own"])

    async def test_unreadable_quote_image_names_the_reason_instead_of_claiming_it_was_attached(self):
        adapter = self.make_adapter()
        handled = []

        async def handle(event):
            handled.append(event)

        adapter.handle_message = handle

        async def fake_cache(url):
            raise ValueError("Refusing to cache non-image data as .jpg (starts with: '�\\n')")

        with patch.object(zalo_adapter, "cache_image_from_url", side_effect=fake_cache), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=DummyZaloTools()):
            await adapter._on_message(
                {
                    "type": "message",
                    "id": "m4",
                    "threadId": "g1",
                    "threadType": zalo_adapter.THREAD_TYPE_GROUP,
                    "senderUid": "u1",
                    "senderName": "Liên",
                    "text": "@Lăng Tiêu nhận xét ảnh này",
                    "mentions": [{"uid": "bot-uid"}],
                    "quote": {
                        "id": "q2", "authorId": "u1", "authorName": "Liên", "text": "",
                        "mediaUrls": ["https://photo-stal-17.zdn.vn/gr/jxl/88b9/2aOb"],
                    },
                }
            )

        self.assertEqual(len(handled), 1)
        event = handled[0]
        self.assertEqual(event.media_urls, [])
        self.assertNotIn("đã được đính kèm", event.channel_context)
        self.assertIn("Không đọc được 1 ảnh", event.channel_context)
        self.assertIn("JXL", event.channel_context)
        self.assertIn("gửi lại", event.channel_context)

    async def test_owner_dm_with_undownloadable_image_still_reaches_the_agent_with_the_reason(self):
        adapter = self.make_adapter()
        handled = []

        async def handle(event):
            handled.append(event)

        adapter.handle_message = handle

        async def fake_cache(url):
            raise ValueError("Inbound image payload is too large (99 bytes > 10 bytes)")

        with patch.object(adapter, "_is_owner", return_value=True), \
                patch.object(zalo_adapter, "cache_image_from_url", side_effect=fake_cache), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=DummyZaloTools()):
            await adapter._on_message(
                {
                    "type": "message",
                    "id": "dm-img",
                    "threadId": "1234567890123456789",
                    "threadType": zalo_adapter.THREAD_TYPE_USER,
                    "senderUid": "1234567890123456789",
                    "senderName": "Lương Hải Anh Cnt",
                    "text": "",
                    "msgType": "chat.photo",
                    "mediaUrls": ["https://example.com/big.jpg"],
                }
            )

        self.assertEqual(len(handled), 1)
        event = handled[0]
        self.assertEqual(event.media_urls, [])
        self.assertIn("[Người dùng gửi ảnh]", event.text)
        self.assertIn("quá dung lượng", event.channel_context)

    def test_image_failure_reason_distinguishes_format_network_and_size(self):
        reason = zalo_adapter._image_failure_reason
        non_image = ValueError("Refusing to cache non-image data as .jpg (starts with: 'x')")
        self.assertIn("JXL", reason("https://photo-stal-17.zdn.vn/gr/jxl/a/b", non_image))
        self.assertIn("không phải ảnh", reason("https://example.com/a", non_image))
        self.assertIn("quá dung lượng", reason("https://example.com/a", ValueError("Inbound image payload is too large (9 bytes > 1 bytes)")))
        self.assertIn("quá thời gian", reason("https://example.com/a", TimeoutError("timed out")))

        import httpx
        request = httpx.Request("GET", "https://example.com/a")
        gone = httpx.HTTPStatusError("404", request=request, response=httpx.Response(404, request=request))
        self.assertIn("HTTP 404", reason("https://example.com/a", gone))
        self.assertIn("quá thời gian", reason("https://example.com/a", httpx.ReadTimeout("slow", request=request)))

    async def test_inbound_dm_id_is_reused_as_dm_for_outbound_reply(self):
        adapter = self.make_adapter()
        adapter.handle_message = lambda _event: asyncio.sleep(0)

        sent = []

        async def fake_command(command, expect_ack=False):
            sent.append(command)
            return {"ok": True, "msgId": "reply-1"}

        adapter._command = fake_command
        with patch.object(adapter, "_is_owner", return_value=True), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=DummyZaloTools()):
            await adapter._on_message(
                {
                    "type": "message",
                    "id": "dm-1",
                    "threadId": "1234567890123456789",
                    "threadType": zalo_adapter.THREAD_TYPE_USER,
                    "senderUid": "1234567890123456789",
                    "senderName": "Lương Hải Anh Cnt",
                    "text": "Chào em",
                }
            )
            result = await adapter.send("1234567890123456789", "Em chào anh")

        self.assertTrue(result.success)
        self.assertEqual(sent[-1]["threadType"], zalo_adapter.THREAD_TYPE_USER)

    async def test_send_strips_hermes_plain_text_fallback_marker(self):
        adapter = self.make_adapter()
        sent = []

        async def fake_command(command, expect_ack=False):
            sent.append(command)
            return {"ok": True, "msgId": "reply-1"}

        adapter._command = fake_command
        result = await adapter.send(
            "1234567890123456789",
            "(Response formatting failed, plain text:)\n\nNội dung trả lời",
        )

        self.assertTrue(result.success)
        self.assertEqual(sent[-1]["text"], "Nội dung trả lời")

    async def test_send_strips_hermes_cron_wrapper_but_keeps_normal_text(self):
        adapter = self.make_adapter()
        sent = []

        async def fake_command(command, expect_ack=False):
            sent.append(command)
            return {"ok": True, "msgId": "cron-1"}

        adapter._command = fake_command
        wrapped = (
            "Cronjob Response: Nhắc họp\n(job_id: abc123)\n-------------\n\n"
            "Mai 7h30 họp chi đoàn nhé!\n\n"
            'To stop or manage this job, send me a new message (e.g. "stop reminder Nhắc họp").'
        )
        await adapter.send("9133571695356732407", wrapped, metadata={"chat_type": "group", "job_id": "abc123"})
        await adapter.send(
            "9133571695356732407", "Cronjob Response: là tên một mục trong báo cáo",
            metadata={"chat_type": "group"},
        )

        self.assertEqual(sent[0]["text"], "Mai 7h30 họp chi đoàn nhé!")
        self.assertEqual(sent[1]["text"], "Cronjob Response: là tên một mục trong báo cáo")

    async def test_send_drops_hermes_self_improvement_notice_but_keeps_normal_text(self):
        adapter = self.make_adapter()
        sent = []

        async def fake_command(command, expect_ack=False):
            sent.append(command)
            return {"ok": True, "msgId": "m1"}

        adapter._command = fake_command
        result = await adapter.send(
            "9133571695356732407", "💾 Self-improvement review: Skill 'zalo-chat-operations' patched",
            metadata={"chat_type": "group", "_interim_send": True},
        )
        self.assertTrue(result.success)
        self.assertEqual(sent, [])

        await adapter.send("9133571695356732407", "💾 là biểu tượng lưu tệp", metadata={"chat_type": "group"})
        self.assertEqual([c["text"] for c in sent], ["💾 là biểu tượng lưu tệp"])

    async def test_send_splits_new_message_marker_into_separate_messages(self):
        adapter = self.make_adapter()
        sent = []

        async def fake_command(command, expect_ack=False):
            sent.append(command)
            return {"ok": True, "msgId": f"m{len(sent)}"}

        adapter._command = fake_command
        result = await adapter.send(
            "9133571695356732407",
            "THÔNG BÁO\nMai họp chi đoàn lúc 7h30.\n\n[[NEW_MESSAGE]]\nEm soạn xong rồi ạ, anh xem tin trên nhé.",
            metadata={"chat_type": "group"},
        )

        self.assertTrue(result.success)
        self.assertEqual(
            [c["text"] for c in sent],
            ["THÔNG BÁO\nMai họp chi đoàn lúc 7h30.", "Em soạn xong rồi ạ, anh xem tin trên nhé."],
        )

    async def test_send_split_marker_never_leaks_when_the_model_formats_it_loosely(self):
        adapter = self.make_adapter()
        sent = []

        async def fake_command(command, expect_ack=False):
            sent.append(command)
            return {"ok": True, "msgId": f"m{len(sent)}"}

        adapter._command = fake_command
        for text in (
            "Bản soạn A\n**[[NEW_MESSAGE]]**\nXác nhận A",
            "Bản soạn B\r\n[[new_message]].\r\nXác nhận B",
            "Bản soạn C [[NEW MESSAGE]] Xác nhận C",
        ):
            await adapter.send("9133571695356732407", text, metadata={"chat_type": "group"})

        self.assertEqual(
            [c["text"] for c in sent],
            ["Bản soạn A", "Xác nhận A", "Bản soạn B", "Xác nhận B", "Bản soạn C", "Xác nhận C"],
        )

    async def test_owner_listed_in_ignore_sender_uids_is_still_answered(self):
        owner = "5736877140444221354"
        adapter = zalo_adapter.ZaloAdapter(
            PlatformConfig(
                enabled=True,
                extra={
                    "bridge_url": "ws://127.0.0.1:9",
                    "reply_only_tagged": True,
                    "ack_gestures": False,
                    "ignore_sender_uids": [owner],
                },
            )
        )
        adapter._self_profile = {"user_id": "bot-uid", "display_name": "Lăng Tiêu"}
        adapter._flood.check = lambda _uid: None
        handled = []

        async def handle(event):
            handled.append(event)

        adapter.handle_message = handle
        with patch.object(adapter, "_is_owner", side_effect=lambda uid: str(uid) == owner), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=DummyZaloTools()):
            await adapter._on_message({
                "type": "message", "id": "g-own", "threadId": "g1", "threadType": zalo_adapter.THREAD_TYPE_GROUP,
                "senderUid": owner, "senderName": "Chủ nhân", "text": "@Lăng Tiêu tóm tắt giúp",
                "mentions": [{"uid": "bot-uid"}],
            })
            await adapter._on_message({
                "type": "message", "id": "dm-own", "threadId": owner, "threadType": zalo_adapter.THREAD_TYPE_USER,
                "senderUid": owner, "senderName": "Chủ nhân", "text": "Chào em",
            })

        self.assertEqual([event.message_id for event in handled], ["g-own", "dm-own"])

    async def test_messages_from_ignored_bot_accounts_never_start_a_turn_but_stay_as_context(self):
        adapter = zalo_adapter.ZaloAdapter(
            PlatformConfig(
                enabled=True,
                extra={
                    "bridge_url": "ws://127.0.0.1:9",
                    "reply_only_tagged": True,
                    "ack_gestures": False,
                    "ignore_sender_uids": ["5736877140444221354"],
                },
            )
        )
        adapter._self_profile = {"user_id": "bot-uid", "display_name": "Lăng Tiêu"}
        adapter._flood.check = lambda _uid: None
        handled = []

        async def handle(event):
            handled.append(event)

        adapter.handle_message = handle
        frame = {
            "type": "message", "threadId": "g1", "threadType": zalo_adapter.THREAD_TYPE_GROUP,
            "text": "@Lăng Tiêu soi giúp ảnh này", "mentions": [{"uid": "bot-uid"}],
        }
        with patch.object(zalo_adapter, "_zalo_tools", return_value=DummyZaloTools()):
            await adapter._on_message({**frame, "id": "b1", "senderUid": "5736877140444221354", "senderName": "Uyển Nhi"})
            await adapter._on_message({**frame, "id": "m1", "senderUid": "3915070541883948642", "senderName": "Liên"})

        self.assertEqual([event.source.user_id for event in handled], ["3915070541883948642"])
        self.assertEqual(
            [entry["sender_uid"] for entry in adapter._recent_group_messages["g1"]],
            ["5736877140444221354", "3915070541883948642"],
        )

    async def test_turn_binding_failure_falls_back_to_public_not_system(self):
        adapter = self.make_adapter()

        class ExplodingTurns(dict):
            def get(self, *_args, **_kwargs):
                raise RuntimeError("hỏng bảng lượt")

        adapter._turns = ExplodingTurns()
        source = adapter.build_source(
            chat_id="group-1", chat_name="group-1", chat_type="group",
            user_id="2222222222222222222", user_name="M", message_id="m-x",
        )
        with patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            toolsets = adapter.toolsets_for_source(source)
            auth = zalo_tools.current_authorization()

        self.assertEqual(toolsets, [zalo_adapter.TOOLSET_PUBLIC])
        self.assertEqual(auth["actorRole"], "public")
        self.assertEqual(auth["actorUid"], "2222222222222222222")
        self.assertEqual(auth["sourceThreadId"], "group-1")

    async def test_turn_remembers_sender_display_name(self):
        adapter = self.make_adapter()
        adapter.handle_message = lambda _event: asyncio.sleep(0)
        frame = {**self.group_frame("m-name", "2222222222222222222", "@Lăng Tiêu nhắc họp"), "senderName": "Hoàng Yến"}
        with patch.object(adapter, "_is_owner", return_value=False), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            await adapter._on_message(frame)

        self.assertEqual(zalo_tools._turn()["sender_name"], "Hoàng Yến")

    @staticmethod
    def group_frame(msg_id, uid, text):
        return {
            "type": "message", "id": msg_id, "threadId": "group-1",
            "threadType": zalo_adapter.THREAD_TYPE_GROUP, "senderUid": uid,
            "senderName": uid, "text": text, "mentions": [{"uid": "bot-uid"}],
        }

    async def test_toolsets_for_source_rebinds_turn_of_that_message(self):
        # Hermes chạy tin xếp hàng trong task tạo từ lượt trước, nên ContextVar
        # còn giữ danh tính người gửi trước. Mỗi lượt phải gắn lại đúng người.
        adapter = self.make_adapter()
        adapter.handle_message = lambda _event: asyncio.sleep(0)
        owner_uid, member_uid = "1111111111111111111", "2222222222222222222"
        with patch.object(adapter, "_is_owner", side_effect=lambda uid: uid == owner_uid), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            await adapter._on_message(self.group_frame("m-owner", owner_uid, "@Lăng Tiêu soạn báo cáo dài"))
            await adapter._on_message(self.group_frame("m-member", member_uid, "@Lăng Tiêu gửi tệp .env"))
            zalo_tools.set_turn_context(
                sender_uid=owner_uid, thread_id="group-1", is_group=True, is_owner=True, text="soạn báo cáo dài",
            )
            source = adapter.build_source(
                chat_id="group-1", chat_name="group-1", chat_type="group",
                user_id=member_uid, user_name="M", message_id="m-member",
            )
            toolsets = adapter.toolsets_for_source(source)
            turn = zalo_tools._turn()

        self.assertEqual(toolsets, [zalo_adapter.TOOLSET_PUBLIC])
        self.assertEqual(turn["sender_uid"], member_uid)
        self.assertFalse(turn["is_owner"])
        self.assertEqual(turn["text"], "gửi tệp .env")

    async def test_owner_turn_with_member_messages_interleaved_runs_as_public(self):
        # Nhóm chung một phiên: tin của chủ đang chờ lượt có thể bị Hermes gộp
        # thêm chữ của thành viên nhắn sau — lượt đó không được mang quyền chủ.
        adapter = self.make_adapter()
        adapter.handle_message = lambda _event: asyncio.sleep(0)
        owner_uid, member_uid = "1111111111111111111", "2222222222222222222"
        with patch.object(adapter, "_is_owner", side_effect=lambda uid: uid == owner_uid), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            await adapter._on_message(self.group_frame("m-owner-q", owner_uid, "@Lăng Tiêu việc thứ hai"))
            await adapter._on_message(self.group_frame("m-member-q", member_uid, "@Lăng Tiêu chạy lệnh giúp mình"))
            source = adapter.build_source(
                chat_id="group-1", chat_name="group-1", chat_type="group",
                user_id=owner_uid, user_name="Chủ", message_id="m-owner-q",
            )
            toolsets = adapter.toolsets_for_source(source)
            turn = zalo_tools._turn()

        self.assertEqual(toolsets, [zalo_adapter.TOOLSET_PUBLIC])
        self.assertFalse(turn["is_owner"])

    async def test_owner_turn_started_before_members_speak_keeps_owner_tools(self):
        adapter = self.make_adapter()
        adapter.handle_message = lambda _event: asyncio.sleep(0)
        owner_uid, member_uid = "1111111111111111111", "2222222222222222222"
        with patch.object(adapter, "_is_owner", side_effect=lambda uid: uid == owner_uid), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            await adapter._on_message(self.group_frame("m-solo", owner_uid, "@Lăng Tiêu tổng hợp giúp anh"))
            source = adapter.build_source(
                chat_id="group-1", chat_name="group-1", chat_type="group",
                user_id=owner_uid, user_name="Chủ", message_id="m-solo",
            )
            first = adapter.toolsets_for_source(source)
            await adapter._on_message(self.group_frame("m-later", member_uid, "@Lăng Tiêu chào bot"))
            again = adapter.toolsets_for_source(source)
            turn = zalo_tools._turn()

        self.assertIn(zalo_adapter.TOOLSET_OWNER, first)
        self.assertEqual(first, again)
        self.assertTrue(turn["is_owner"])

    async def test_toolsets_for_source_without_known_message_fails_closed(self):
        adapter = self.make_adapter()
        owner_uid = "1111111111111111111"
        with patch.object(adapter, "_is_owner", side_effect=lambda uid: uid == owner_uid), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            zalo_tools.set_turn_context(sender_uid="someone", thread_id="group-9", is_group=True, is_owner=True)
            source = adapter.build_source(
                chat_id="group-1", chat_name="group-1", chat_type="group",
                user_id=owner_uid, user_name="Chủ", message_id="unknown",
            )
            adapter.toolsets_for_source(source)
            turn = zalo_tools._turn()

        self.assertEqual(turn["sender_uid"], owner_uid)
        self.assertEqual(turn["thread_id"], "group-1")
        self.assertFalse(turn["is_owner"])

    async def test_group_turn_text_drops_bot_mention_so_confirmation_can_match(self):
        adapter = self.make_adapter()
        adapter.handle_message = lambda _event: asyncio.sleep(0)
        with patch.object(adapter, "_is_owner", return_value=True), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            await adapter._on_message(self.group_frame("m-confirm", "1111111111111111111", "@Lăng Tiêu  XÁC NHẬN A1B2C3"))

        self.assertEqual(zalo_tools._turn()["text"], "XÁC NHẬN A1B2C3")

    async def test_stranger_dm_sethome_gets_only_their_uid(self):
        adapter = self.make_adapter()
        handled = []

        async def fake_handle(event):
            handled.append(event)

        adapter.handle_message = fake_handle
        sent = []

        async def fake_command(command, expect_ack=False):
            sent.append((command, zalo_tools.current_authorization()))
            return {"ok": True, "msgId": "reply-1"}

        adapter._command = fake_command
        stranger = "3333333333333333333"
        with patch.object(adapter, "_is_owner", return_value=False), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            await adapter._on_message({
                "type": "message", "id": "dm-sethome", "threadId": stranger,
                "threadType": zalo_adapter.THREAD_TYPE_USER, "senderUid": stranger,
                "senderName": "Khách", "text": " /SetHome ",
            })

        self.assertEqual(handled, [])
        self.assertEqual(len(sent), 1)
        self.assertIn(stranger, sent[0][0]["text"])
        self.assertIn("chưa cấp quyền chủ", sent[0][0]["text"])
        self.assertEqual(sent[0][1]["actorUid"], stranger)
        self.assertEqual(sent[0][1]["actorRole"], "public")

    def test_owner_uid_is_a_dm_target_even_with_19_digits(self):
        adapter = self.make_adapter()
        owner_uid = "9000000000000000001"
        with patch.object(adapter, "_is_owner", side_effect=lambda uid: uid == owner_uid):
            self.assertEqual(adapter._guess_thread_type(owner_uid, {}), zalo_adapter.THREAD_TYPE_USER)
            self.assertEqual(adapter._guess_thread_type("9000000000000000002", {}), zalo_adapter.THREAD_TYPE_GROUP)

    def test_env_enablement_does_not_blank_out_config_yaml_values(self):
        # Hermes ghi kết quả _env_enablement ĐÈ lên extra của config.yaml. Trả
        # về bridge_token rỗng khi .env không đặt là xoá mất token trình cài ghi.
        keys = ("ZALO_BRIDGE_URL", "ZALO_BRIDGE_TOKEN", "ZALO_GROUP_REPLY_ONLY_TAGGED", "ZALO_HOME_CHANNEL")
        with patch.dict(os.environ, {}):
            for key in keys:
                os.environ.pop(key, None)
            seed = zalo_adapter._env_enablement() or {}
            self.assertNotIn("bridge_token", seed)
            self.assertNotIn("bridge_url", seed)
            self.assertNotIn("reply_only_tagged", seed)

            os.environ["ZALO_BRIDGE_TOKEN"] = "env-token"
            os.environ["ZALO_GROUP_REPLY_ONLY_TAGGED"] = "false"
            seed = zalo_adapter._env_enablement() or {}
            self.assertEqual(seed["bridge_token"], "env-token")
            self.assertIs(seed["reply_only_tagged"], False)

    def test_bridge_url_from_env_wins_over_config_extra(self):
        with patch.dict(os.environ, {"ZALO_BRIDGE_URL": "ws://127.0.0.1:3900"}):
            adapter = zalo_adapter.ZaloAdapter(
                PlatformConfig(enabled=True, extra={"bridge_url": "ws://127.0.0.1:3873"})
            )
        self.assertEqual(adapter._bridge_url, "ws://127.0.0.1:3900")

    async def test_send_voice_uploads_local_audio_then_forwards_zalo_cdn_url(self):
        adapter = self.make_adapter()
        calls = []

        async def fake_invoke(method, args):
            calls.append((method, args))
            if method == "uploadAttachment":
                return {
                    "ok": True,
                    "result": [{"fileUrl": "https://cdn.zalo.test/voice.aac"}],
                }
            return {"ok": True, "result": {"message": {"msgId": "voice-1"}}}

        adapter.invoke = fake_invoke
        with tempfile.NamedTemporaryFile(suffix=".aac", delete=False) as audio:
            audio.write(b"aac")
            audio_path = audio.name
        try:
            result = await adapter.send_voice(
                "2054797107487294899",
                audio_path,
                metadata={"chat_type": "group"},
            )
        finally:
            os.unlink(audio_path)

        self.assertTrue(result.success)
        self.assertEqual(calls[0][0], "uploadAttachment")
        self.assertEqual(calls[0][1][1:], ["2054797107487294899", 1])
        self.assertEqual(calls[1], (
            "sendVoice",
            [
                {"voiceUrl": "https://cdn.zalo.test/voice.aac", "ttl": 0},
                "2054797107487294899",
                1,
            ],
        ))

    async def test_send_voice_accepts_media_delivery_is_voice_flag(self):
        adapter = self.make_adapter()

        async def fake_invoke(method, args):
            if method == "uploadAttachment":
                return {
                    "ok": True,
                    "result": [{"fileUrl": "https://cdn.zalo.test/voice.aac"}],
                }
            return {"ok": True, "result": {"msgId": "voice-media-1"}}

        adapter.invoke = fake_invoke
        with tempfile.NamedTemporaryFile(suffix=".aac", delete=False) as audio:
            audio.write(b"aac")
            audio_path = audio.name
        try:
            result = await adapter.send_voice(
                "9133571695356732407",
                audio_path,
                metadata={"chat_type": "group"},
                is_voice=True,
            )
        finally:
            os.unlink(audio_path)

        self.assertTrue(result.success)
        self.assertEqual(result.message_id, "voice-media-1")

    async def test_invoke_frame_carries_server_verifiable_turn_authorization(self):
        adapter = self.make_adapter()
        socket = CapturingSocket()
        adapter._ws = socket
        turn_token = zalo_tools._TURN.set({
            "sender_uid": "owner-1",
            "thread_id": "source-dm",
            "is_group": False,
            "is_owner": True,
            "text": "đổi tên nhóm",
        })
        try:
            pending = asyncio.create_task(adapter.invoke(
                "changeGroupName", ["Tên mới", "group-1"], confirmed=True,
            ))
            await asyncio.sleep(0)
            frame = socket.frames[0]
            await adapter._dispatch({"type": "ack", "reqId": frame["reqId"], "ok": True})
            await pending
        finally:
            zalo_tools._TURN.reset(turn_token)

        self.assertEqual(frame["auth"], {
            "actorUid": "owner-1",
            "actorRole": "owner",
            "sourceThreadId": "source-dm",
            "sourceThreadType": 0,
            "confirmed": True,
        })

    async def test_history_and_undo_frames_carry_owner_context_and_confirmation(self):
        adapter = self.make_adapter()
        socket = CapturingSocket()
        adapter._ws = socket
        turn_token = zalo_tools._TURN.set({
            "sender_uid": "owner-1", "thread_id": "group-1", "is_group": True,
            "is_owner": True, "text": "thu hồi tin vừa gửi",
        })
        try:
            history_task = asyncio.create_task(adapter.read_history(
                "group-1", 20, {"chat_type": "group"},
            ))
            await asyncio.sleep(0)
            history_frame = socket.frames[-1]
            await adapter._dispatch({"type": "ack", "reqId": history_frame["reqId"], "ok": True})
            await history_task

            undo_task = asyncio.create_task(adapter.undo_message(
                "group-1", metadata={"chat_type": "group"}, confirmed=True,
            ))
            await asyncio.sleep(0)
            undo_frame = socket.frames[-1]
            await adapter._dispatch({"type": "ack", "reqId": undo_frame["reqId"], "ok": True})
            await undo_task
        finally:
            zalo_tools._TURN.reset(turn_token)

        self.assertEqual(history_frame["auth"]["actorUid"], "owner-1")
        self.assertFalse(history_frame["auth"]["confirmed"])
        self.assertTrue(undo_frame["auth"]["confirmed"])

    async def test_application_heartbeat_sends_ping_without_authorization_payload(self):
        adapter = self.make_adapter()
        socket = CapturingSocket()
        adapter._ws = socket
        adapter._heartbeat_interval_s = 0.01
        task = asyncio.create_task(adapter._heartbeat_loop())
        try:
            await asyncio.sleep(0.025)
        finally:
            adapter._closing = True
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        self.assertGreaterEqual(len(socket.frames), 1)
        self.assertEqual(socket.frames[0], {"type": "ping"})

    async def test_ack_gesture_uses_the_current_sender_authorization_context(self):
        adapter = self.make_adapter()
        adapter._ack_gestures = True
        adapter._auto_react = False
        adapter.handle_message = lambda _event: asyncio.sleep(0)
        observed = []

        async def fake_command(payload, expect_ack=False):
            observed.append((payload, zalo_tools.current_authorization()))
            return None

        adapter._command = fake_command
        with patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools), \
                patch.object(adapter, "_may_greet", return_value=True):
            await adapter._on_message({
                "type": "message", "id": "ack-1", "cliMsgId": "ack-c1",
                "threadId": "group-ack", "threadType": zalo_adapter.THREAD_TYPE_GROUP,
                "senderUid": "member-current", "senderName": "Thành viên",
                "text": "@Lăng Tiêu chào em", "mentions": [{"uid": "bot-uid"}],
            })

        self.assertEqual(observed[0][0]["type"], "ack_message")
        self.assertEqual(observed[0][1]["actorUid"], "member-current")
        self.assertEqual(observed[0][1]["sourceThreadId"], "group-ack")

    async def test_zalo_send_voice_accepts_tts_local_path(self):
        class FakeAdapter:
            async def send_voice(self, chat_id, audio_path, metadata=None):
                self.call = (chat_id, audio_path, metadata)
                return zalo_adapter.SendResult(success=True, message_id="voice-2")

            async def invoke(self, method, args):
                return {"ok": False, "error": "local paths are not public URLs"}

        fake = FakeAdapter()
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as audio:
            audio.write(b"mp3")
            audio_path = audio.name
        previous = zalo_tools._ACTIVE_ADAPTER
        zalo_tools._ACTIVE_ADAPTER = fake
        turn_token = zalo_tools._TURN.set({
            "sender_uid": "1234567890123456789",
            "thread_id": "1234567890123456789",
            "is_group": False,
            "is_owner": True,
            "text": "Gửi voice vào nhóm Đệ ruột",
        })
        try:
            response = await zalo_tools.zalo_send_voice({
                "thread_id": 2054797107487294899,
                "thread_kind": "group",
                "url": audio_path,
            })
        finally:
            zalo_tools._TURN.reset(turn_token)
            zalo_tools._ACTIVE_ADAPTER = previous
            os.unlink(audio_path)

        self.assertTrue(json.loads(response)["success"])
        self.assertEqual(fake.call, (
            "2054797107487294899",
            audio_path,
            {"chat_type": "group"},
        ))

    async def test_ack_wakes_a_command_waiting_on_another_event_loop(self):
        # Công cụ chạy trên vòng lặp riêng của luồng agent, ack tới trên vòng lặp
        # gateway. Ack phải đánh thức lệnh ngay, không để nó chờ hết thời gian chờ.
        adapter = self.make_adapter()
        socket = CapturingSocket()
        adapter._ws = socket
        result = {}

        def tool_thread():
            loop = asyncio.new_event_loop()
            try:
                started = time.monotonic()
                result["ack"] = loop.run_until_complete(adapter._command(
                    {"type": "history", "threadId": "g1", "threadType": 1}, expect_ack=True,
                ))
                result["seconds"] = time.monotonic() - started
            finally:
                loop.close()

        with patch.object(zalo_adapter, "ACK_TIMEOUT_SECONDS", 3), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            thread = threading.Thread(target=tool_thread)
            thread.start()
            for _ in range(200):
                if socket.frames:
                    break
                await asyncio.sleep(0.01)
            await adapter._dispatch({"type": "ack", "reqId": socket.frames[0]["reqId"], "ok": True})
            await asyncio.to_thread(thread.join)

        self.assertEqual(result["ack"], {"type": "ack", "reqId": socket.frames[0]["reqId"], "ok": True})
        self.assertLess(result["seconds"], 1.0)


class ZaloToolSchemaTest(unittest.TestCase):
    def test_every_zalo_tool_has_one_unique_public_or_owner_assignment(self):
        names = [name for name, _emoji, _schema, _handler, _toolset in zalo_tools.TOOLS]
        assignments = [toolset for _name, _emoji, _schema, _handler, toolset in zalo_tools.TOOLS]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(set(assignments), {
            zalo_tools.TOOLSET_PUBLIC, zalo_tools.TOOLSET_OWNER, zalo_tools.TOOLSET_CRON,
        })
        self.assertEqual(assignments.count(zalo_tools.TOOLSET_PUBLIC), 15)
        self.assertEqual(assignments.count(zalo_tools.TOOLSET_OWNER), 31)
        self.assertEqual(assignments.count(zalo_tools.TOOLSET_CRON), 1)

    def test_zalo_ids_remain_strings_through_hermes_argument_coercion(self):
        import model_tools

        original = "2054797107487294899"
        schema = next(
            schema for name, _emoji, schema, _handler, _toolset in zalo_tools.TOOLS
            if name == "zalo_undo"
        )
        with patch.object(model_tools.registry, "get_schema", return_value=schema):
            coerced = model_tools.coerce_tool_args("zalo_undo", {
                "thread_id": original,
                "thread_kind": "group",
            })

        self.assertEqual(coerced["thread_id"], original)
        self.assertIsInstance(coerced["thread_id"], str)

    def test_send_voice_requires_string_zalo_thread_id(self):
        schema = next(
            schema for name, _emoji, schema, _handler, _toolset in zalo_tools.TOOLS
            if name == "zalo_send_voice"
        )["parameters"]

        errors = list(Draft7Validator(schema).iter_errors({
            "thread_id": "2054797107487294899",
            "thread_kind": "group",
            "url": "https://example.com/voice.aac",
        }))

        self.assertEqual(errors, [])

    def test_all_zalo_id_fields_are_declared_as_strings(self):
        for name, _emoji, schema, _handler, _toolset in zalo_tools.TOOLS:
            properties = schema["parameters"].get("properties", {})
            for key, spec in properties.items():
                if not (key.endswith("_id") or key.endswith("_ids")):
                    continue
                item_spec = spec.get("items") if spec.get("type") == "array" else spec
                with self.subTest(tool=name, field=key):
                    self.assertEqual(item_spec.get("type"), "string")

    def test_dangerous_owner_tools_expose_human_confirmation_code(self):
        dangerous = {
            "zalo_lock_poll", "zalo_pin_conversation", "zalo_mute", "zalo_undo",
            "zalo_rename_group", "zalo_group_member_change", "zalo_group_deputy",
            "zalo_review_member", "zalo_create_group", "zalo_invite_to_groups",
            "zalo_group_link", "zalo_join_group_link", "zalo_set_bio",
            "zalo_set_active_status",
        }
        schemas = {name: schema["parameters"] for name, _emoji, schema, _handler, _toolset in zalo_tools.TOOLS}
        for name in dangerous:
            with self.subTest(tool=name):
                self.assertNotIn("confirmation_code", schemas[name]["required"])
                self.assertEqual(schemas[name]["properties"]["confirmation_code"]["type"], "string")

    def test_cron_member_toolset_holds_only_safe_group_tools(self):
        from toolsets import resolve_toolset

        zalo_tools.define_cron_member_toolset()

        self.assertEqual(set(resolve_toolset(zalo_tools.TOOLSET_CRON_MEMBER, include_registry=False)), {
            "zalo_web_search", "zalo_web_read", "zalo_kb_list", "zalo_kb_read", "zalo_group_history",
        })

    def test_no_mcp_sentinel_in_per_job_toolsets_adds_no_mcp_servers(self):
        from cron.scheduler import _resolve_cron_enabled_toolsets

        self.assertEqual(
            _resolve_cron_enabled_toolsets({"enabled_toolsets": ["zalo_cron_member", "no_mcp"]}, {}),
            ["zalo_cron_member"],
        )


class ZaloToolContractTest(unittest.IsolatedAsyncioTestCase):
    async def test_owner_tool_fails_closed_without_turn_context(self):
        raw_handler = next(
            handler for name, _emoji, _schema, handler, _toolset in zalo_tools.TOOLS
            if name == "zalo_list_people"
        )
        handler = zalo_tools._owner_only(raw_handler, "zalo_list_people")
        token = zalo_tools._TURN.set({})
        try:
            response = await handler({})
        finally:
            zalo_tools._TURN.reset(token)
        self.assertFalse(json.loads(response)["success"])
        self.assertIn("chủ nhân", json.loads(response)["error"])

    async def test_public_voice_cannot_read_local_file_outside_knowledge_base(self):
        class FakeAdapter:
            async def send_voice(self, *_args, **_kwargs):
                raise AssertionError("unsafe local file reached adapter")

        with tempfile.TemporaryDirectory() as knowledge_base, \
                tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as audio:
            audio.write(b"mp3")
            audio_path = audio.name
        previous = zalo_tools._ACTIVE_ADAPTER
        zalo_tools._ACTIVE_ADAPTER = FakeAdapter()
        turn_token = zalo_tools._TURN.set({
            "sender_uid": "public-user", "thread_id": "group-1",
            "is_group": True, "is_owner": False, "text": "gửi voice",
        })
        try:
            with patch.dict(os.environ, {"ZALO_KB_DIR": knowledge_base}):
                response = await zalo_tools.zalo_send_voice({
                    "thread_id": "group-1", "thread_kind": "group", "url": audio_path,
                })
        finally:
            zalo_tools._TURN.reset(turn_token)
            zalo_tools._ACTIVE_ADAPTER = previous
            os.unlink(audio_path)
        self.assertFalse(json.loads(response)["success"])
        self.assertIn("kho tài liệu", json.loads(response)["error"])

    async def test_public_voice_rejects_private_network_url(self):
        class FakeAdapter:
            async def invoke(self, *_args, **_kwargs):
                raise AssertionError("private voice URL reached the sidecar")

        zalo_tools._ACTIVE_ADAPTER = FakeAdapter()
        token = zalo_tools._TURN.set({
            "sender_uid": "public-user", "thread_id": "group-1",
            "is_group": True, "is_owner": False, "text": "gửi voice",
        })
        try:
            response = await zalo_tools.zalo_send_voice({
                "thread_id": "group-1", "thread_kind": "group", "url": "http://127.0.0.1:8080/secret.aac",
            })
        finally:
            zalo_tools._TURN.reset(token)
        self.assertFalse(json.loads(response)["success"])

    async def test_group_members_asks_bridge_for_that_group(self):
        class FakeAdapter:
            def __init__(self):
                self.calls = []

            async def group_members(self, chat_id):
                self.calls.append(chat_id)
                return {"ok": True, "result": {"total": 1, "members": [{"id": "u1", "displayName": "An"}]}}

        fake = FakeAdapter()
        zalo_tools._ACTIVE_ADAPTER = fake
        token = zalo_tools._TURN.set({
            "sender_uid": "public-user", "thread_id": "group-1",
            "is_group": True, "is_owner": False, "text": "nhóm có ai",
        })
        try:
            response = await zalo_tools.zalo_group_members({"thread_id": "group-1"})
        finally:
            zalo_tools._TURN.reset(token)
        self.assertTrue(json.loads(response)["success"], response)
        self.assertEqual(fake.calls, ["group-1"])

    async def test_fb_publish_can_schedule_a_post(self):
        from plugins.zalo_tools import facebook as zalo_fb

        calls = []

        def fake_graph(path, method="GET", **params):
            params.pop("timeout", None)
            calls.append((path, method, params))
            return {"id": "page-1_post-1"} if method == "POST" else {"permalink_url": "https://fb.test/p"}

        draft = {"page": {"id": "page-1", "token": "page-token", "name": "Trang thử"}, "message": "Nội dung", "photos": []}
        with patch.object(zalo_fb, "confirmed_in_message", return_value=True), \
                patch.object(zalo_fb, "take_draft", return_value=(draft, None)), \
                patch.object(zalo_fb, "graph", side_effect=fake_graph):
            response = await zalo_tools.zalo_fb_publish({"code": "ABC123", "scheduled_publish_time": "1790000000"})

        result = json.loads(response)
        self.assertTrue(result["success"], response)
        self.assertTrue(result["result"]["len_lich"])
        self.assertEqual(calls[0][1], "POST")
        self.assertEqual(calls[0][2]["published"], "false")
        self.assertEqual(calls[0][2]["scheduled_publish_time"], 1790000000)

    async def test_fb_publish_rejects_bad_schedule_before_consuming_draft(self):
        from plugins.zalo_tools import facebook as zalo_fb

        with patch.object(zalo_fb, "confirmed_in_message", return_value=True), \
                patch.object(zalo_fb, "take_draft", side_effect=AssertionError("draft consumed")):
            response = await zalo_tools.zalo_fb_publish({"code": "ABC123", "scheduled_publish_time": "ngày mai"})

        self.assertFalse(json.loads(response)["success"])

    def test_authorization_outside_a_chat_turn_is_system(self):
        token = zalo_tools._TURN.set(None)
        try:
            auth = zalo_tools.current_authorization()
        finally:
            zalo_tools._TURN.reset(token)
        self.assertEqual(auth["actorRole"], "system")
        self.assertEqual(auth["actorUid"], "")

    def setUp(self):
        self.previous_adapter = zalo_tools._ACTIVE_ADAPTER
        self.turn_token = zalo_tools._TURN.set({
            "sender_uid": "1234567890123456789",
            "thread_id": "1234567890123456789",
            "is_group": False,
            "is_owner": True,
            "text": "test",
        })

    def tearDown(self):
        zalo_tools._TURN.reset(self.turn_token)
        zalo_tools._ACTIVE_ADAPTER = self.previous_adapter

    async def test_sticker_maps_search_result_to_send_payload(self):
        class FakeAdapter:
            def __init__(self):
                self.calls = []

            async def invoke(self, method, args):
                self.calls.append((method, args))
                if method == "searchSticker":
                    return {"ok": True, "result": [
                        {"sticker_id": "123", "cate_id": "45", "type": "3"},
                    ]}
                return {"ok": True, "result": {"msgId": 999}}

        fake = FakeAdapter()
        zalo_tools._ACTIVE_ADAPTER = fake
        response = await zalo_tools.zalo_send_sticker({
            "thread_id": 9133571695356732407,
            "thread_kind": "group",
            "keyword": "ngủ ngon",
        })

        self.assertTrue(json.loads(response)["success"])
        self.assertEqual(fake.calls[-1], (
            "sendSticker",
            [{"id": 123, "cateId": 45, "type": 3}, "9133571695356732407", 1],
        ))

    async def test_send_file_and_link_normalize_numeric_thread_id(self):
        class FakeAdapter:
            def __init__(self):
                self.calls = []

            async def invoke(self, method, args):
                self.calls.append((method, args))
                return {"ok": True, "result": {"message": {"msgId": 999}}}

        fake = FakeAdapter()
        zalo_tools._ACTIVE_ADAPTER = fake
        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as item:
            item.write(b"test")
            item_path = item.name
        try:
            file_response = await zalo_tools.zalo_send_file({
                "thread_id": 9133571695356732407,
                "thread_kind": "group",
                "path": item_path,
            })
        finally:
            os.unlink(item_path)
        link_response = await zalo_tools.zalo_send_link({
            "thread_id": 9133571695356732407,
            "thread_kind": "group",
            "url": "https://example.com",
        })

        self.assertTrue(json.loads(file_response)["success"])
        self.assertTrue(json.loads(link_response)["success"])
        self.assertEqual(fake.calls[0][1][1], "9133571695356732407")
        self.assertEqual(fake.calls[1][1][1], "9133571695356732407")

    async def test_group_member_change_normalizes_numeric_ids(self):
        class FakeAdapter:
            async def invoke(self, method, args):
                self.call = (method, args)
                return {"ok": True, "result": {"status": 0}}

        fake = FakeAdapter()
        zalo_tools._ACTIVE_ADAPTER = fake
        response = await zalo_tools.zalo_group_member_change({
            "group_id": 9133571695356732407,
            "user_ids": [1234567890123456789],
            "action": "add",
        })

        self.assertTrue(json.loads(response)["success"])
        self.assertEqual(fake.call, (
            "addUserToGroup",
            [["1234567890123456789"], "9133571695356732407"],
        ))

    async def test_other_group_management_tools_normalize_numeric_ids(self):
        class FakeAdapter:
            def __init__(self):
                self.calls = []

            async def invoke(self, method, args):
                self.calls.append((method, args))
                return {"ok": True, "result": {"status": 0}}

        fake = FakeAdapter()
        zalo_tools._ACTIVE_ADAPTER = fake
        await zalo_tools.zalo_group_deputy({
            "group_id": 9133571695356732407,
            "user_id": 1234567890123456789,
            "action": "add",
        })
        await zalo_tools.zalo_review_member({
            "group_id": 9133571695356732407,
            "user_ids": [1234567890123456789],
            "approve": True,
        })
        await zalo_tools.zalo_create_group({"member_ids": [1234567890123456789]})
        await zalo_tools.zalo_invite_to_groups({
            "user_id": 1234567890123456789,
            "group_ids": [9133571695356732407],
        })

        self.assertEqual(fake.calls, [
            ("addGroupDeputy", ["1234567890123456789", "9133571695356732407"]),
            ("reviewPendingMemberRequest", [{
                "members": ["1234567890123456789"], "isApprove": True,
            }, "9133571695356732407"]),
            ("createGroup", [{"members": ["1234567890123456789"]}]),
            ("inviteUserToGroups", [
                "1234567890123456789", ["9133571695356732407"],
            ]),
        ])

    async def test_read_history_uses_adapter_history_contract(self):
        class FakeAdapter:
            async def read_history(self, chat_id, count, metadata=None):
                self.call = (chat_id, count, metadata)
                return {"ok": True, "result": {"messages": [{"msgId": "m1"}]}}

        fake = FakeAdapter()
        zalo_tools._ACTIVE_ADAPTER = fake
        response = await zalo_tools.zalo_read_history({
            "thread_id": 9133571695356732407,
            "thread_kind": "group",
            "count": 20,
        })

        self.assertTrue(json.loads(response)["success"])
        self.assertEqual(fake.call, (
            "9133571695356732407", 20, {"chat_type": "group"},
        ))

    async def test_undo_without_ids_uses_latest_own_message_contract(self):
        class FakeAdapter:
            async def undo_message(self, chat_id, msg_id=None, cli_msg_id=None, metadata=None, *, confirmed=False):
                self.call = (chat_id, msg_id, cli_msg_id, metadata, confirmed)
                return {"ok": True, "result": {"status": 0, "msgId": "m1"}}

        fake = FakeAdapter()
        zalo_tools._ACTIVE_ADAPTER = fake
        response = await zalo_tools.zalo_undo({
            "thread_id": 9133571695356732407,
            "thread_kind": "group",
        })

        self.assertTrue(json.loads(response)["success"])
        self.assertEqual(fake.call, (
            "9133571695356732407", None, None, {"chat_type": "group"}, False,
        ))

    async def test_undo_without_ids_targets_the_quoted_own_message(self):
        class FakeAdapter:
            async def undo_message(self, chat_id, msg_id=None, cli_msg_id=None, metadata=None, *, confirmed=False):
                self.call = (chat_id, msg_id, cli_msg_id, metadata, confirmed)
                return {"ok": True, "result": {"status": 0, "msgId": msg_id}}

        fake = FakeAdapter()
        zalo_tools._ACTIVE_ADAPTER = fake
        quoted_turn = zalo_tools._TURN.set({
            "sender_uid": "owner", "thread_id": "2054797107487294899",
            "is_group": True, "is_owner": True, "text": "thu hồi tin nhắn này",
            "reply_msg_id": "8240551224624", "reply_cli_msg_id": "1788864027075",
            "reply_is_own": True,
        })
        try:
            response = await zalo_tools.zalo_undo({
                "thread_id": "2054797107487294899", "thread_kind": "group",
            })
        finally:
            zalo_tools._TURN.reset(quoted_turn)

        self.assertTrue(json.loads(response)["success"])
        self.assertEqual(fake.call, (
            "2054797107487294899", "8240551224624", "1788864027075",
            {"chat_type": "group"}, False,
        ))

    async def test_owner_dangerous_action_runs_immediately_by_default(self):
        class FakeAdapter:
            def __init__(self):
                self.calls = []

            async def invoke(self, method, args, *, confirmed=False):
                self.calls.append((method, args, confirmed))
                return {"ok": True, "result": {"status": 0}}

        self.enterContext(patch.dict(os.environ, {}))
        os.environ.pop("ZALO_CONFIRM_DANGEROUS", None)
        fake = FakeAdapter()
        zalo_tools._ACTIVE_ADAPTER = fake
        guarded = zalo_tools._confirmed_action(
            zalo_tools.zalo_group_member_change, "zalo_group_member_change",
        )
        args = {"group_id": "g1", "user_ids": ["u1"], "action": "remove"}

        owner_turn = zalo_tools._TURN.set({
            "sender_uid": "owner", "thread_id": "g1", "is_group": True,
            "is_owner": True, "text": "xoá u1 khỏi nhóm",
        })
        try:
            owner = json.loads(await guarded(args))
        finally:
            zalo_tools._TURN.reset(owner_turn)

        member_turn = zalo_tools._TURN.set({
            "sender_uid": "member", "thread_id": "g1", "is_group": True,
            "is_owner": False, "text": "xoá u1 khỏi nhóm",
        })
        try:
            member = json.loads(await guarded(args))
        finally:
            zalo_tools._TURN.reset(member_turn)

        self.assertTrue(owner["success"], owner)
        self.assertFalse(member["success"])
        self.assertEqual(fake.calls, [("removeUserFromGroup", [["u1"], "g1"], True)])

    async def test_undo_confirmation_keeps_the_quoted_target_on_the_later_turn(self):
        self.enterContext(patch.dict(os.environ, {"ZALO_CONFIRM_DANGEROUS": "true"}))

        class FakeAdapter:
            def __init__(self):
                self.calls = []

            async def undo_message(self, chat_id, msg_id=None, cli_msg_id=None, metadata=None, *, confirmed=False):
                self.calls.append((chat_id, msg_id, cli_msg_id, metadata, confirmed))
                return {"ok": True, "result": {"status": 0, "msgId": msg_id}}

        fake = FakeAdapter()
        zalo_tools._ACTIVE_ADAPTER = fake
        guarded = zalo_tools._confirmed_action(zalo_tools.zalo_undo, "zalo_undo")
        args = {"thread_id": "2054797107487294899", "thread_kind": "group"}
        first_turn = zalo_tools._TURN.set({
            "sender_uid": "owner-quoted", "thread_id": "2054797107487294899",
            "is_group": True, "is_owner": True, "text": "thu hồi tin nhắn này",
            "reply_msg_id": "8240551224624", "reply_cli_msg_id": "1788864027075",
            "reply_is_own": True,
        })
        try:
            challenge = json.loads(await guarded(args))
        finally:
            zalo_tools._TURN.reset(first_turn)

        second_turn = zalo_tools._TURN.set({
            "sender_uid": "owner-quoted", "thread_id": "2054797107487294899",
            "is_group": True, "is_owner": True,
            "text": f'XÁC NHẬN {challenge["confirmation_code"]}',
        })
        try:
            result = json.loads(await guarded({
                **args, "confirmation_code": challenge["confirmation_code"],
            }))
        finally:
            zalo_tools._TURN.reset(second_turn)

        self.assertTrue(result["success"])
        self.assertEqual(fake.calls, [(
            "2054797107487294899", "8240551224624", "1788864027075",
            {"chat_type": "group"}, True,
        )])

    async def test_confirmation_guard_requires_code_in_a_later_owner_message(self):
        self.enterContext(patch.dict(os.environ, {"ZALO_CONFIRM_DANGEROUS": "true"}))

        class FakeAdapter:
            def __init__(self):
                self.calls = []

            async def invoke(self, method, args, *, confirmed=False):
                self.calls.append((method, args, confirmed))
                return {"ok": True, "result": {"status": 0}}

        fake = FakeAdapter()
        zalo_tools._ACTIVE_ADAPTER = fake
        guarded = zalo_tools._confirmed_action(
            zalo_tools.zalo_group_member_change, "zalo_group_member_change",
        )
        args = {"group_id": "g1", "user_ids": ["u1"], "action": "remove"}
        first_turn = zalo_tools._TURN.set({
            "sender_uid": "owner", "thread_id": "dm-owner", "is_group": False,
            "is_owner": True, "text": "xóa u1 khỏi nhóm g1",
        })
        try:
            challenge = json.loads(await guarded(args))
            same_turn = json.loads(await guarded({**args, "confirmation_code": challenge["confirmation_code"]}))
        finally:
            zalo_tools._TURN.reset(first_turn)
        second_turn = zalo_tools._TURN.set({
            "sender_uid": "owner", "thread_id": "dm-owner", "is_group": False,
            "is_owner": True, "text": f'XÁC NHẬN {challenge["confirmation_code"]}',
        })
        try:
            allowed = json.loads(await guarded({**args, "confirmation_code": challenge["confirmation_code"]}))
        finally:
            zalo_tools._TURN.reset(second_turn)

        self.assertFalse(challenge["success"])
        self.assertFalse(same_turn["success"])
        self.assertTrue(allowed["success"])
        self.assertEqual(fake.calls, [
            ("removeUserFromGroup", [["u1"], "g1"], True),
        ])

    async def test_confirmation_code_rejects_negation_and_changed_arguments(self):
        self.enterContext(patch.dict(os.environ, {"ZALO_CONFIRM_DANGEROUS": "true"}))

        class FakeAdapter:
            def __init__(self):
                self.calls = []

            async def invoke(self, method, params, *, confirmed=False):
                self.calls.append((method, params, confirmed))
                return {"ok": True, "result": {"status": 0}}

        fake = FakeAdapter()
        previous_adapter = zalo_tools._ACTIVE_ADAPTER
        zalo_tools._ACTIVE_ADAPTER = fake
        guarded = zalo_tools._confirmed_action(
            zalo_tools.zalo_group_member_change, "zalo_group_member_change",
        )
        args = {"group_id": "g1", "user_ids": ["u1"], "action": "remove"}
        first_turn = zalo_tools._TURN.set({
            "sender_uid": "owner-2", "thread_id": "dm-owner-2", "is_group": False,
            "is_owner": True, "text": "xóa u1 khỏi nhóm g1",
        })
        try:
            challenge = json.loads(await guarded(args))
        finally:
            zalo_tools._TURN.reset(first_turn)
        code = challenge["confirmation_code"]

        negated_turn = zalo_tools._TURN.set({
            "sender_uid": "owner-2", "thread_id": "dm-owner-2", "is_group": False,
            "is_owner": True, "text": f"KHÔNG XÁC NHẬN {code}",
        })
        try:
            negated = json.loads(await guarded({**args, "confirmation_code": code}))
        finally:
            zalo_tools._TURN.reset(negated_turn)

        changed_turn = zalo_tools._TURN.set({
            "sender_uid": "owner-2", "thread_id": "dm-owner-2", "is_group": False,
            "is_owner": True, "text": f"XÁC NHẬN {code}",
        })
        try:
            changed = json.loads(await guarded({
                **args, "group_id": "g2", "confirmation_code": code,
            }))
        finally:
            zalo_tools._TURN.reset(changed_turn)
            zalo_tools._ACTIVE_ADAPTER = previous_adapter

        self.assertFalse(negated["success"])
        self.assertFalse(changed["success"])
        self.assertEqual(fake.calls, [])


class ZaloCronTurnTest(unittest.IsolatedAsyncioTestCase):
    OWNER = "9200000000000000001"
    GROUP = "9133000000000000001"
    MEMBER = "3900000000000000001"

    def setUp(self):
        self.turn_token = zalo_tools._TURN.set(None)
        self.previous_adapter = zalo_tools._ACTIVE_ADAPTER
        zalo_tools._ACTIVE_ADAPTER = None
        self.enterContext(patch.dict(os.environ, {"ZALO_ALLOWED_USERS": self.OWNER}))

    def tearDown(self):
        zalo_tools._TURN.reset(self.turn_token)
        zalo_tools._ACTIVE_ADAPTER = self.previous_adapter

    def fake_jobs(self):
        return FakeCronJobs([
            {"id": "owner-job", "deliver": f"zalo:{self.GROUP}",
             "origin": {"platform": "zalo", "chat_id": self.GROUP, "user_id": "someone-else"}},
            {"id": "group-job", "deliver": f"zalo:{self.GROUP}",
             "origin": {"platform": "zalo", "chat_id": self.GROUP, "chat_type": "group",
                        "zalo_scope": "group", "zalo_creator_uid": self.MEMBER, "zalo_creator_name": "Yến"}},
            {"id": "telegram-job", "deliver": "telegram:8617174143",
             "origin": {"platform": "telegram", "chat_id": "8617174143"}},
        ])

    @staticmethod
    async def probe(_args, **_kw):
        return json.dumps({"turn": zalo_tools._turn(), "auth": zalo_tools.current_authorization()})

    async def call(self, task_id, jobs):
        guarded = zalo_tools._with_cron_turn(self.probe, "probe")
        with patch.object(zalo_tools, "_cron_jobs", return_value=jobs):
            return json.loads(await guarded({}, task_id=task_id))

    async def test_owner_created_cron_runs_as_owner_in_its_target_chat(self):
        seen = await self.call("cron:owner-job:run-1", self.fake_jobs())

        self.assertTrue(seen["turn"]["is_owner"])
        self.assertEqual(seen["turn"]["sender_uid"], self.OWNER)
        self.assertEqual(seen["turn"]["thread_id"], self.GROUP)
        self.assertTrue(seen["turn"]["is_group"])
        self.assertEqual(seen["turn"]["text"], "")
        self.assertEqual(seen["auth"]["actorRole"], "owner")
        self.assertEqual(seen["auth"]["sourceThreadType"], zalo_tools.THREAD_GROUP)
        self.assertEqual(seen["auth"]["cronJobId"], "owner-job")

    async def test_group_cron_runs_as_its_creator_locked_to_that_group(self):
        seen = await self.call("cron:group-job:run-1", self.fake_jobs())

        self.assertFalse(seen["turn"]["is_owner"])
        self.assertEqual(seen["turn"]["sender_uid"], self.MEMBER)
        self.assertEqual(seen["turn"]["sender_name"], "Yến")
        self.assertEqual(seen["auth"]["actorRole"], "public")
        self.assertEqual(seen["auth"]["sourceThreadId"], self.GROUP)
        self.assertEqual(seen["auth"]["cronJobId"], "group-job")

    async def test_corrupted_group_marker_never_becomes_an_owner_turn(self):
        jobs = FakeCronJobs([
            {"id": "scope-typo", "deliver": f"zalo:{self.GROUP}",
             "origin": {"platform": "zalo", "chat_id": self.GROUP, "zalo_scope": "Group",
                        "zalo_creator_uid": self.MEMBER}},
            {"id": "creator-only", "deliver": f"zalo:{self.GROUP}",
             "origin": {"platform": "zalo", "chat_id": self.GROUP, "zalo_creator_uid": self.MEMBER}},
        ])
        for task_id in ("cron:scope-typo:run-1", "cron:creator-only:run-1"):
            with self.subTest(task_id=task_id):
                seen = await self.call(task_id, jobs)
                self.assertEqual(seen["turn"], {})
                self.assertEqual(seen["auth"]["actorRole"], "system")

    async def test_non_cron_task_missing_job_or_non_zalo_job_get_no_turn(self):
        jobs = self.fake_jobs()
        for task_id in ("session-abc", "cron:missing:run-1", "cron:telegram-job:run-1", ""):
            with self.subTest(task_id=task_id):
                seen = await self.call(task_id, jobs)
                self.assertEqual(seen["turn"], {})
                self.assertEqual(seen["auth"]["actorRole"], "system")

    async def test_owner_cron_without_allowlist_gets_no_owner_turn(self):
        with patch.dict(os.environ, {"ZALO_ALLOWED_USERS": ""}):
            seen = await self.call("cron:owner-job:run-1", self.fake_jobs())

        self.assertEqual(seen["turn"], {})

    async def test_existing_chat_turn_is_never_replaced(self):
        chat = zalo_tools._TURN.set({
            "sender_uid": self.MEMBER, "thread_id": "other", "is_group": True, "is_owner": False, "text": "hi",
        })
        try:
            seen = await self.call("cron:owner-job:run-1", self.fake_jobs())
        finally:
            zalo_tools._TURN.reset(chat)

        self.assertFalse(seen["turn"]["is_owner"])
        self.assertEqual(seen["turn"]["thread_id"], "other")

    async def test_turn_is_restored_after_the_cron_call(self):
        await self.call("cron:owner-job:run-1", self.fake_jobs())

        self.assertEqual(zalo_tools._turn(), {})

    async def test_registered_owner_tool_works_inside_owner_cron(self):
        class FakeAdapter:
            async def read_history(self, chat_id, count, metadata=None):
                self.call = (chat_id, count, metadata)
                return {"ok": True, "result": {"messages": []}}

        ctx, fake = FakeToolContext(), FakeAdapter()
        zalo_tools.register_tools(ctx)
        zalo_tools._ACTIVE_ADAPTER = fake
        with patch.object(zalo_tools, "_cron_jobs", return_value=self.fake_jobs()):
            response = await ctx.handlers["zalo_read_history"](
                {"thread_id": self.GROUP, "thread_kind": "group", "count": 5},
                task_id="cron:owner-job:run-1",
            )

        self.assertTrue(json.loads(response)["success"], response)
        self.assertEqual(fake.call, (self.GROUP, 5, {"chat_type": "group"}))

    async def test_group_history_reads_only_the_cron_group_and_ignores_model_thread_id(self):
        class FakeAdapter:
            async def read_history(self, chat_id, count, metadata=None):
                self.call = (chat_id, count, metadata)
                return {"ok": True, "result": {"messages": [{"msgId": "m1"}]}}

        ctx, fake = FakeToolContext(), FakeAdapter()
        zalo_tools.register_tools(ctx)
        zalo_tools._ACTIVE_ADAPTER = fake
        with patch.object(zalo_tools, "_cron_jobs", return_value=self.fake_jobs()):
            response = await ctx.handlers["zalo_group_history"](
                {"count": 500, "thread_id": "other-group"}, task_id="cron:group-job:run-1",
            )

        self.assertTrue(json.loads(response)["success"], response)
        self.assertEqual(fake.call, (self.GROUP, 100, {"chat_type": "group"}))

    async def test_group_history_refuses_outside_cron(self):
        chat = zalo_tools._TURN.set({
            "sender_uid": self.MEMBER, "thread_id": self.GROUP, "is_group": True, "is_owner": False, "text": "đọc nhóm",
        })
        try:
            response = await zalo_tools.zalo_group_history({})
        finally:
            zalo_tools._TURN.reset(chat)

        self.assertFalse(json.loads(response)["success"])

    async def test_allowed_owner_uids_fails_closed_when_multiplexed_and_unscoped(self):
        import agent.secret_scope

        with patch.object(
            agent.secret_scope, "get_secret",
            side_effect=agent.secret_scope.UnscopedSecretError("no scope"),
        ):
            self.assertEqual(zalo_tools._allowed_owner_uids(), [])


class ZaloGroupCronTest(unittest.IsolatedAsyncioTestCase):
    OWNER = "9200000000000000001"
    GROUP = "9133000000000000001"
    OTHER_GROUP = "9133000000000000002"
    MEMBER = "3900000000000000001"
    OTHER_MEMBER = "3900000000000000002"

    def setUp(self):
        self.turn_token = zalo_tools._TURN.set(None)
        self.enterContext(patch.dict(os.environ, {"ZALO_ALLOWED_USERS": self.OWNER}))

    def tearDown(self):
        zalo_tools._TURN.reset(self.turn_token)

    def member_turn(self, uid=None, *, is_owner=False, is_group=True, group=None, **extra):
        return {
            "sender_uid": uid or self.MEMBER, "sender_name": "Yến", "thread_id": group or self.GROUP,
            "is_group": is_group, "is_owner": is_owner, "text": "hẹn giờ", **extra,
        }

    async def run_tool(self, args, jobs, turn):
        token = zalo_tools._TURN.set(turn)
        try:
            with patch.object(zalo_tools, "_cron_jobs", return_value=jobs):
                return json.loads(await zalo_tools.zalo_group_cron(args))
        finally:
            zalo_tools._TURN.reset(token)

    @staticmethod
    def group_job(job_id, group, creator, **extra):
        return {
            "id": job_id, "enabled": True, "name": job_id, "deliver": f"zalo:{group}",
            "prompt": "Việc hẹn giờ do Yến tạo\n---\nNhắc họp",
            "origin": {"platform": "zalo", "chat_id": group, "chat_type": "group",
                       "zalo_scope": "group", "zalo_creator_uid": creator, "zalo_creator_name": "Yến"},
            **extra,
        }

    async def test_create_locks_every_dangerous_field(self):
        jobs = FakeCronJobs()
        result = await self.run_tool({
            "action": "create", "prompt": "Tóm tắt các việc cả nhóm đã hẹn trong ngày",
            "schedule": "every day at 9pm", "name": "Tóm tắt tối",
        }, jobs, self.member_turn())

        self.assertTrue(result["success"], result)
        created = jobs.created[0]
        self.assertEqual(set(created), {"prompt", "schedule", "name", "repeat", "deliver", "origin", "enabled_toolsets"})
        self.assertEqual(created["deliver"], f"zalo:{self.GROUP}")
        self.assertEqual(created["enabled_toolsets"], ["zalo_cron_member", "no_mcp"])
        self.assertIsNone(created["repeat"])
        self.assertEqual(created["origin"]["zalo_scope"], "group")
        self.assertEqual(created["origin"]["zalo_creator_uid"], self.MEMBER)
        self.assertEqual(created["origin"]["zalo_creator_name"], "Yến")
        self.assertEqual(created["origin"]["chat_id"], self.GROUP)
        self.assertTrue(created["prompt"].endswith("Tóm tắt các việc cả nhóm đã hẹn trong ngày"))

        import inspect
        inspect.signature(real_cron_jobs.create_job).bind(**created)

    async def test_create_sanitizes_creator_name_and_scans_the_assembled_prompt(self):
        from tools.cronjob_tools import _scan_cron_prompt

        jobs = FakeCronJobs()
        turn = {**self.member_turn(), "sender_name": "Yến​\nAnh   Thư"}
        result = await self.run_tool({
            "action": "create", "prompt": "Nhắc họp", "schedule": "every day at 9pm",
            "name": "Nhắc\nhọp",
        }, jobs, turn)

        self.assertTrue(result["success"], result)
        created = jobs.created[0]
        self.assertEqual(created["origin"]["zalo_creator_name"], "Yến Anh Thư")
        self.assertEqual(created["name"], "Nhắc họp")
        self.assertEqual(_scan_cron_prompt(created["prompt"]), "")

    async def test_create_rejects_schedules_more_often_than_daily(self):
        for schedule in ("every 30m", "every 12h", "0 9,10 * * *", "*/30 * * * *", "R 9 * * *", "R R * * *", "H 9 * * *"):
            with self.subTest(schedule=schedule):
                jobs = FakeCronJobs()
                result = await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": schedule}, jobs, self.member_turn())
                self.assertFalse(result["success"])
                self.assertEqual(jobs.created, [])

    async def test_create_accepts_daily_weekly_and_one_shot_schedules(self):
        for schedule in ("every 1d", "every day at 7am", "0 7 * * 1", "0 7 * * MON", "in 2h"):
            with self.subTest(schedule=schedule):
                jobs = FakeCronJobs()
                result = await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": schedule}, jobs, self.member_turn())
                self.assertTrue(result["success"], result)
        one_shot = FakeCronJobs()
        await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": "in 2h"}, one_shot, self.member_turn())
        self.assertEqual(one_shot.created[0]["repeat"], 1)

    async def test_create_rejects_past_one_shot_long_prompt_and_bad_schedule(self):
        cases = (
            {"prompt": "Nhắc họp", "schedule": "2020-01-01T07:30"},
            {"prompt": "x" * 1001, "schedule": "every day at 7am"},
            {"prompt": "Nhắc họp", "schedule": "hôm nào đó"},
            {"prompt": "", "schedule": "every day at 7am"},
        )
        for case in cases:
            with self.subTest(case=case["schedule"]):
                jobs = FakeCronJobs()
                result = await self.run_tool({"action": "create", **case}, jobs, self.member_turn())
                self.assertFalse(result["success"])
                self.assertEqual(jobs.created, [])

    async def test_create_enforces_quota_per_member_and_per_group_but_not_for_owner(self):
        mine = FakeCronJobs([self.group_job(f"m{i}", self.OTHER_GROUP, self.MEMBER) for i in range(3)])
        result = await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"}, mine, self.member_turn())
        self.assertFalse(result["success"])
        self.assertIn("3", result["error"])

        crowded = [self.group_job(f"g{i}", self.GROUP, f"39000000000000001{i:02d}") for i in range(10)]
        result = await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"}, FakeCronJobs(crowded), self.member_turn())
        self.assertFalse(result["success"])
        self.assertIn("10", result["error"])

        finished = FakeCronJobs([
            self.group_job("m0", self.OTHER_GROUP, self.MEMBER),
            self.group_job("m1", self.OTHER_GROUP, self.MEMBER),
            self.group_job("m2", self.OTHER_GROUP, self.MEMBER, state="completed"),
        ])
        result = await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"}, finished, self.member_turn())
        self.assertTrue(result["success"], result)

        owner = await self.run_tool(
            {"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"},
            FakeCronJobs(crowded), self.member_turn(self.OWNER, is_owner=True),
        )
        self.assertTrue(owner["success"], owner)

    async def test_tool_works_only_in_groups_and_never_inside_cron(self):
        args = {"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"}
        dm = await self.run_tool(args, FakeCronJobs(), self.member_turn(is_group=False))
        in_cron = await self.run_tool(args, FakeCronJobs(), self.member_turn(cron_job_id="group-job"))
        listing_in_cron = await self.run_tool({"action": "list"}, FakeCronJobs(), self.member_turn(cron_job_id="group-job"))

        self.assertFalse(dm["success"])
        self.assertFalse(in_cron["success"])
        self.assertFalse(listing_in_cron["success"])

    async def test_create_uses_hermes_prompt_scanner_and_refuses_when_it_is_missing(self):
        args = {"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"}
        with patch("tools.cronjob_tools._scan_cron_prompt", return_value="Blocked: threat"):
            blocked = await self.run_tool(args, FakeCronJobs(), self.member_turn())
        with patch.dict(sys.modules, {"tools.cronjob_tools": None}):
            missing = await self.run_tool(args, FakeCronJobs(), self.member_turn())

        self.assertFalse(blocked["success"])
        self.assertIn("Blocked", blocked["error"])
        self.assertFalse(missing["success"])

    async def test_list_shows_this_group_and_hides_owner_prompts(self):
        jobs = FakeCronJobs([
            {"id": "owner-job", "enabled": True, "name": "Bản tin", "deliver": f"zalo:{self.GROUP}",
             "prompt": "bí mật của chủ nhân", "origin": {"platform": "zalo", "chat_id": self.GROUP}},
            self.group_job("group-job", self.GROUP, self.MEMBER),
            self.group_job("elsewhere", self.OTHER_GROUP, self.MEMBER),
        ])
        result = await self.run_tool({"action": "list"}, jobs, self.member_turn(self.OTHER_MEMBER))

        self.assertTrue(result["success"], result)
        items = {item["job_id"]: item for item in result["result"]["jobs"]}
        self.assertEqual(set(items), {"owner-job", "group-job"})
        self.assertEqual(items["owner-job"]["nguoi_tao"], "chủ nhân")
        self.assertNotIn("noi_dung", items["owner-job"])
        self.assertEqual(items["group-job"]["noi_dung"], "Nhắc họp")
        self.assertNotIn("bí mật", json.dumps(result, ensure_ascii=False))

    async def test_remove_follows_creator_or_owner_rule(self):
        def jobs():
            return FakeCronJobs([
                {"id": "owner-job", "enabled": True, "deliver": f"zalo:{self.GROUP}",
                 "origin": {"platform": "zalo", "chat_id": self.GROUP}},
                self.group_job("group-job", self.GROUP, self.MEMBER),
                self.group_job("elsewhere", self.OTHER_GROUP, self.MEMBER),
            ])

        other = jobs()
        self.assertFalse((await self.run_tool({"action": "remove", "job_id": "group-job"}, other, self.member_turn(self.OTHER_MEMBER)))["success"])
        self.assertEqual(other.removed, [])

        creator = jobs()
        self.assertTrue((await self.run_tool({"action": "remove", "job_id": "group-job"}, creator, self.member_turn()))["success"])
        self.assertEqual(creator.removed, ["group-job"])

        member_vs_owner = jobs()
        self.assertFalse((await self.run_tool({"action": "remove", "job_id": "owner-job"}, member_vs_owner, self.member_turn()))["success"])
        self.assertEqual(member_vs_owner.removed, [])

        owner = jobs()
        self.assertTrue((await self.run_tool({"action": "remove", "job_id": "owner-job"}, owner, self.member_turn(self.OWNER, is_owner=True)))["success"])
        self.assertEqual(owner.removed, ["owner-job"])

        wrong_group = jobs()
        self.assertFalse((await self.run_tool({"action": "remove", "job_id": "elsewhere"}, wrong_group, self.member_turn()))["success"])
        self.assertEqual(wrong_group.removed, [])


class ZaloMemberToolGuardTest(unittest.TestCase):
    """Hermes ghim bộ công cụ của phiên nhóm theo lượt đầu (thường là chủ nhân)
    rồi cấp lại cho mọi lượt sau, bất kể toolsets_for_source trả gì. Hook
    pre_tool_call là rào chắn tại điểm thực thi."""

    MEMBER = "3900000000000000001"
    GROUP = "9133000000000000001"

    def setUp(self):
        self.turn_token = zalo_tools._TURN.set(None)

    def tearDown(self):
        zalo_tools._TURN.reset(self.turn_token)

    def guard(self, tool_name):
        return zalo_tools.guard_member_tool_call(
            tool_name=tool_name, args={}, task_id="t", session_id="s", tool_call_id="c",
        )

    def bind_member(self):
        zalo_tools.bind_turn({"sender_uid": self.MEMBER, "thread_id": self.GROUP,
                              "is_group": True, "is_owner": False, "text": ""})

    def test_member_turn_cannot_run_pinned_core_tools(self):
        self.bind_member()
        for name in ("terminal", "search_files", "read_file", "write_file",
                     "vision_analyze", "execute_code", "delegate_task"):
            verdict = self.guard(name)
            self.assertEqual(verdict["action"], "block", name)
            self.assertIn(name, verdict["message"])

    def test_member_turn_keeps_public_zalo_mcp_and_tool_search_bridge(self):
        self.bind_member()
        public = next(name for name, _e, _s, _h, ts in zalo_tools.TOOLS if ts == zalo_tools.TOOLSET_PUBLIC)
        owner_only = next(name for name, _e, _s, _h, ts in zalo_tools.TOOLS if ts == zalo_tools.TOOLSET_OWNER)
        self.assertIsNone(self.guard(public))
        self.assertIsNone(self.guard("tool_search"))
        self.assertEqual(self.guard(owner_only)["action"], "block")

        from tools.registry import registry
        with patch.object(registry, "get_toolset_for_tool", return_value="mcp-rag"):
            self.assertIsNone(self.guard("rag_search"))

    def test_owner_turn_and_non_zalo_contexts_are_untouched(self):
        self.assertIsNone(self.guard("terminal"))
        zalo_tools.bind_turn(None)
        self.assertIsNone(self.guard("terminal"))
        zalo_tools.bind_turn({"sender_uid": "9200000000000000001", "thread_id": self.GROUP,
                              "is_group": True, "is_owner": True, "text": ""})
        self.assertIsNone(self.guard("terminal"))

    def test_plugin_entry_registers_the_guard_as_pre_tool_call_hook(self):
        import plugins.zalo_tools as plugin

        ctx = FakeToolContext()
        with patch.object(plugin, "define_platform_composite"), \
                patch.object(plugin, "define_cron_member_toolset"):
            plugin.register(ctx)
        self.assertEqual(ctx.hooks.get("pre_tool_call"), [zalo_tools.guard_member_tool_call])

    def test_owner_turn_loses_core_tools_once_an_outsider_tags_the_bot_in_the_same_thread(self):
        class FakeAdapter:
            pass

        adapter = FakeAdapter()
        adapter._turns = {
            "m1": {"thread_id": self.GROUP, "is_owner": True, "seq": 5},
            "m2": {"thread_id": "another-group", "is_owner": False, "seq": 6},
        }
        public = next(name for name, _e, _s, _h, ts in zalo_tools.TOOLS if ts == zalo_tools.TOOLSET_PUBLIC)
        config = {"display": {"busy_input_mode": "interrupt"}}
        with patch.object(zalo_tools, "_ACTIVE_ADAPTER", adapter), \
                patch.dict(os.environ, {"HERMES_GATEWAY_BUSY_INPUT_MODE": "interrupt"}), \
                patch("hermes_cli.config.load_config_readonly", side_effect=lambda: config):
            zalo_tools.bind_turn({"sender_uid": "9200000000000000001", "thread_id": self.GROUP,
                                  "is_group": True, "is_owner": True, "text": "", "seq": 5})
            self.assertIsNone(self.guard("terminal"))

            # busy_input_mode interrupt/steer chèn tin này vào lượt đang chạy.
            adapter._turns["m3"] = {"thread_id": self.GROUP, "is_owner": False, "seq": 7}
            self.assertEqual(self.guard("terminal")["action"], "block")
            self.assertIsNone(self.guard(public))

            # queue ở cả biến môi trường lẫn config: tin đó chờ thành lượt riêng,
            # lượt của chủ nhân giữ nguyên quyền.
            config["display"]["busy_input_mode"] = "queue"
            with patch.dict(os.environ, {"HERMES_GATEWAY_BUSY_INPUT_MODE": "queue"}):
                self.assertIsNone(self.guard("terminal"))

                # /busy steer đổi config lúc đang chạy nhưng không đổi biến môi trường.
                config["display"]["busy_input_mode"] = "steer"
                self.assertEqual(self.guard("terminal")["action"], "block")

    def test_member_tool_call_bridge_is_judged_by_the_wrapped_tool(self):
        self.bind_member()
        verdict = zalo_tools.guard_member_tool_call(
            tool_name="tool_call", args={"name": "terminal", "arguments": {"command": "cat .env"}},
        )
        self.assertEqual(verdict["action"], "block")

        public = next(name for name, _e, _s, _h, ts in zalo_tools.TOOLS if ts == zalo_tools.TOOLSET_PUBLIC)
        with patch("tools.tool_search.resolve_underlying_call", return_value=(public, {}, None)):
            self.assertIsNone(zalo_tools.guard_member_tool_call(tool_name="tool_call", args={"name": public}))

    def test_owner_turn_without_a_matching_message_keeps_core_tools_only_in_a_dm(self):
        adapter = ZaloAdapterMediaContextTest.make_adapter(self)
        bound = []

        class CapturingTools:
            def bind_turn(self, turn):
                bound.append(turn)

        class Source:
            def __init__(self, chat_type):
                self.user_id = "9200000000000000001"
                self.chat_id = "chat-1"
                self.chat_type = chat_type
                self.message_id = "not-a-received-message"

        with patch.object(zalo_adapter, "_zalo_tools", return_value=CapturingTools()), \
                patch.object(adapter, "_is_owner", return_value=True):
            dm = adapter.toolsets_for_source(Source("dm"))
            group = adapter.toolsets_for_source(Source("group"))

        self.assertIn(zalo_tools.TOOLSET_OWNER, dm)
        self.assertFalse(bound[0]["is_owner"])
        self.assertTrue(bound[0]["core_tools"])
        self.assertEqual(group, [zalo_tools.TOOLSET_PUBLIC])
        self.assertFalse(bound[1]["core_tools"])

        zalo_tools.bind_turn(bound[0])
        self.assertIsNone(self.guard("terminal"))
        zalo_tools.bind_turn(bound[1])
        self.assertEqual(self.guard("terminal")["action"], "block")


class ZaloKbScopeTest(unittest.IsolatedAsyncioTestCase):
    """ZALO_KB_PUBLIC_DIRS đóng phần còn lại của kho: kho thật là cả một ổ đĩa
    nhiều năm, người trong nhóm chỉ được thấy vài thư mục của năm hiện hành."""

    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        base = self.root.name
        for rel in ("ĐOÀN CNT 26-27/VĂN BẢN PHÁT RA 26-27/21-KH.txt",
                    "ĐOÀN CNT 23-24/23-24 VĂN BẢN PHÁT RA/01-KH.txt",
                    "ngay-goc.txt"):
            path = os.path.join(base, *rel.split("/"))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("nội dung " + rel)
        zalo_tools._KB_CACHE.update(root=None, at=0.0, files=None, skipped=0)
        self.addCleanup(zalo_tools._KB_CACHE.update, root=None, at=0.0, files=None, skipped=0)
        self.addCleanup(self.root.cleanup)
        self.enterContext(patch("agent.secret_scope.get_secret",
                                side_effect=lambda name, default="": os.environ.get(name, default)))
        self.enterContext(patch.dict(os.environ, {"ZALO_KB_DIR": base}))

    def paths(self, payload):
        return sorted(f["path"] for f in json.loads(payload)["result"]["files"])

    async def test_public_dirs_hide_other_years_and_files_at_the_root(self):
        with patch.dict(os.environ, {"ZALO_KB_PUBLIC_DIRS": "ĐOÀN CNT 26-27, ĐOÀN CNT 25 - 26"}):
            self.assertEqual(
                self.paths(await zalo_tools.zalo_kb_list({})),
                ["ĐOÀN CNT 26-27/VĂN BẢN PHÁT RA 26-27/21-KH.txt"],
            )
            # Đoán đúng tên tệp ngoài phạm vi cũng không đọc được.
            denied = json.loads(await zalo_tools.zalo_kb_read(
                {"path": "ĐOÀN CNT 23-24/23-24 VĂN BẢN PHÁT RA/01-KH.txt"}))
            self.assertFalse(denied["success"])
            allowed = json.loads(await zalo_tools.zalo_kb_read(
                {"path": "ĐOÀN CNT 26-27/VĂN BẢN PHÁT RA 26-27/21-KH.txt"}))
            self.assertTrue(allowed["success"])
            self.assertIn("21-KH.txt", allowed["result"]["content"])

    async def test_no_setting_keeps_the_whole_store_visible(self):
        zalo_tools._KB_CACHE.update(root=None, at=0.0, files=None, skipped=0)
        with patch.dict(os.environ, {"ZALO_KB_PUBLIC_DIRS": ""}):
            self.assertEqual(len(self.paths(await zalo_tools.zalo_kb_list({}))), 3)


if __name__ == "__main__":
    unittest.main()
