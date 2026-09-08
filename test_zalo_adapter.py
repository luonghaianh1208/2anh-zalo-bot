import asyncio
import json
import os
import sys
import tempfile
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


class DummyZaloTools:
    def set_turn_context(self, **kwargs):
        self.context = kwargs


class CapturingSocket:
    def __init__(self):
        self.frames = []

    async def send(self, raw):
        self.frames.append(json.loads(raw))


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
                    "id": "m3",
                    "threadId": "g1",
                    "threadType": zalo_adapter.THREAD_TYPE_GROUP,
                    "senderUid": "u1",
                    "senderName": "Yến",
                    "text": "@Lăng Tiêu cái này là gì?",
                    "mentions": [{"uid": "bot-uid"}],
                    "quote": {
                        "id": "q1",
                        "authorId": "u2",
                        "authorName": "Anh",
                        "text": "",
                        "mediaUrls": ["https://example.com/quoted.jpg"],
                    },
                }
            )

        self.assertEqual(len(handled), 1)
        event = handled[0]
        self.assertEqual(event.media_urls, ["C:/cache/quoted.jpg"])
        self.assertEqual(event.reply_to_message_id, "q1")
        self.assertEqual(event.reply_to_text, "[Tin được reply có ảnh]")
        self.assertEqual(event.reply_to_author_id, "u2")
        self.assertEqual(event.reply_to_author_name, "Anh")

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


class ZaloToolSchemaTest(unittest.TestCase):
    def test_every_zalo_tool_has_one_unique_public_or_owner_assignment(self):
        names = [name for name, _emoji, _schema, _handler, _toolset in zalo_tools.TOOLS]
        assignments = [toolset for _name, _emoji, _schema, _handler, toolset in zalo_tools.TOOLS]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(set(assignments), {
            zalo_tools.TOOLSET_PUBLIC, zalo_tools.TOOLSET_OWNER,
        })
        self.assertEqual(assignments.count(zalo_tools.TOOLSET_PUBLIC), 14)
        self.assertEqual(assignments.count(zalo_tools.TOOLSET_OWNER), 31)

    def test_send_voice_accepts_numeric_zalo_thread_id(self):
        schema = next(
            schema for name, _emoji, schema, _handler, _toolset in zalo_tools.TOOLS
            if name == "zalo_send_voice"
        )["parameters"]

        errors = list(Draft7Validator(schema).iter_errors({
            "thread_id": 2054797107487294899,
            "thread_kind": "group",
            "url": "https://example.com/voice.aac",
        }))

        self.assertEqual(errors, [])

    def test_all_zalo_id_fields_accept_numeric_ids(self):
        for name, _emoji, schema, _handler, _toolset in zalo_tools.TOOLS:
            properties = schema["parameters"].get("properties", {})
            for key, spec in properties.items():
                if not (key.endswith("_id") or key.endswith("_ids")):
                    continue
                candidate = 9133571695356732407
                value = [candidate] if spec.get("type") == "array" else candidate
                errors = list(Draft7Validator(spec).iter_errors(value))
                with self.subTest(tool=name, field=key):
                    self.assertEqual(errors, [])

    def test_dangerous_owner_tools_require_literal_confirmation(self):
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
                if name == "zalo_group_link":
                    self.assertNotIn("confirm", schemas[name]["required"])
                else:
                    self.assertIn("confirm", schemas[name]["required"])
                self.assertEqual(schemas[name]["properties"]["confirm"].get("const"), True)


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

    async def test_confirmation_guard_rejects_missing_flag_and_propagates_true(self):
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
        denied = await guarded({
            "group_id": "g1", "user_ids": ["u1"], "action": "remove",
        })
        allowed = await guarded({
            "group_id": "g1", "user_ids": ["u1"], "action": "remove", "confirm": True,
        })

        self.assertFalse(json.loads(denied)["success"])
        self.assertTrue(json.loads(allowed)["success"])
        self.assertEqual(fake.calls, [
            ("removeUserFromGroup", [["u1"], "g1"], True),
        ])


if __name__ == "__main__":
    unittest.main()
