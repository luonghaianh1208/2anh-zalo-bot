"""Phân quyền theo nhóm (spec §8): đọc permissions.json, chặn công cụ, adapter."""

import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(__file__)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from gateway.config import PlatformConfig  # noqa: E402
import zalo_test_env  # noqa: E402,F401  (cho "zalo" là nền tảng hợp lệ)
import plugins  # noqa: E402
import plugins.platforms  # noqa: E402

plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
plugins.platforms.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.platforms.__path__)]
from plugins.zalo_tools import group_permissions as gp  # noqa: E402
from plugins.zalo_tools import tools as zalo_tools  # noqa: E402
from plugins.platforms.zalo import adapter as zalo_adapter  # noqa: E402

GROUP_A = "2054797107487294899"
GROUP_B = "2054797107487294811"
OWNER = "1234567890123456789"
MEMBER = "9876543210987654321"


class PermissionsFile:
    """Tệp permissions.json tạm; ZALO_PERMISSIONS_FILE trỏ vào nó trong suốt test."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="zalo-perm-")
        self.path = os.path.join(self.dir, "permissions.json")
        self.enterContext(patch.dict(os.environ, {"ZALO_PERMISSIONS_FILE": self.path}))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.stamp = 1_700_000_000_000_000_000

    def write(self, data):
        """Ghi như dashboard (tệp tạm rồi đổi tên) và đẩy mtime lên để chắc chắn khác lần trước."""
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(data if isinstance(data, str) else json.dumps(data))
        os.replace(tmp, self.path)
        self.stamp += 1_000_000_000
        os.utime(self.path, ns=(self.stamp, self.stamp))


class GroupPermissionsTest(PermissionsFile, unittest.TestCase):
    def test_missing_file_means_everything_on_and_global_reply_flag(self):
        rules = gp.group_settings(GROUP_A)
        self.assertEqual(rules["active"], True)
        self.assertIsNone(rules["reply_only_tagged"])
        self.assertTrue(all(rules["features"][f] for f in gp.FEATURES))
        self.assertEqual(gp.disabled_features(GROUP_A), [])

    def test_group_entry_overrides_defaults_key_by_key(self):
        self.write({"version": 1,
                    "defaults": {"active": True, "replyOnlyTagged": True, "features": {"video": False}},
                    "groups": {GROUP_A: {"name": "Tổ Hoá", "replyOnlyTagged": False,
                                         "features": {"web": False, "video": True}}}})
        a = gp.group_settings(GROUP_A)
        self.assertEqual(a["reply_only_tagged"], False)
        self.assertEqual(gp.disabled_features(GROUP_A), ["web"])
        b = gp.group_settings(GROUP_B)
        self.assertEqual(b["reply_only_tagged"], True)
        self.assertEqual(gp.disabled_features(GROUP_B), ["video"])

    def test_edit_takes_effect_without_restart(self):
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"features": {"web": False}}}})
        self.assertEqual(gp.disabled_features(GROUP_A), ["web"])
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"features": {"kb": False}}}})
        self.assertEqual(gp.disabled_features(GROUP_A), ["kb"])
        os.remove(self.path)
        self.assertEqual(gp.disabled_features(GROUP_A), [])

    def test_corrupt_file_logs_warning_and_falls_back_to_everything_on(self):
        for bad in ("{không phải json", "[]", json.dumps({"version": 2, "defaults": {"active": False}})):
            self.write(bad)
            with self.assertLogs(gp.logger, level="WARNING"):
                rules = gp.group_settings(GROUP_A)
            self.assertTrue(rules["active"])
            self.assertEqual(gp.disabled_features(GROUP_A), [])

    def test_wrong_types_and_unknown_keys_are_ignored(self):
        self.write({"version": 1,
                    "defaults": {"active": "false", "features": {"web": 0, "nope": False, "kb": False}},
                    "groups": {GROUP_A: "rác", GROUP_B: {"features": ["web"]}}})
        self.assertTrue(gp.group_settings(GROUP_A)["active"])
        self.assertEqual(gp.disabled_features(GROUP_A), ["kb"])
        self.assertEqual(gp.disabled_features(GROUP_B), ["kb"])

    def test_every_public_tool_belongs_to_exactly_one_switch_or_always_on(self):
        public = {name for name, _e, _s, _h, toolset in zalo_tools.TOOLS if toolset == zalo_tools.TOOLSET_PUBLIC}
        mapped = [tool for feature in gp.FEATURES for tool in gp.FEATURE_TOOLS[feature]]
        self.assertEqual(len(mapped), len(set(mapped)), "một công cụ nằm ở hai nút")
        self.assertFalse(set(mapped) & gp.ALWAYS_ON)
        self.assertFalse(set(mapped) & gp.STUDIO_TOOLS)
        self.assertEqual(set(mapped) | gp.ALWAYS_ON | gp.STUDIO_TOOLS, public,
                         "công cụ công khai mới phải được xếp vào một nút (spec §8.2)")
        self.assertEqual(set(gp.FEATURE_TOOLS), set(gp.FEATURES))
        self.assertEqual(set(gp.FEATURE_LABELS), set(gp.FEATURES))


class PeopleScopeToolsTest(PermissionsFile, unittest.IsolatedAsyncioTestCase):
    """Sổ người quen theo nơi ghi: điều nói ở nhóm nào chỉ dùng lại ở nhóm đó và khi nhắn riêng với chính người đó."""

    def setUp(self):
        super().setUp()
        self.enterContext(patch.dict(os.environ, {"ZALO_PEOPLE_FILE": os.path.join(self.dir, "people.json")}))
        self.addCleanup(zalo_tools.bind_turn, None)

    def turn(self, sender, thread, *, group=True, owner=False):
        zalo_tools.set_turn_context(sender_uid=sender, thread_id=thread, is_group=group, is_owner=owner)

    async def call(self, fn, **args):
        return json.loads(await fn(args))

    async def test_fact_said_in_group_a_stays_in_group_a_and_owner_dm(self):
        self.turn(OWNER, GROUP_A, owner=True)
        await self.call(zalo_tools.zalo_remember_person, fields={"tai_san": "14 chỉ vàng"})
        self.turn(OWNER, GROUP_B, owner=True)
        await self.call(zalo_tools.zalo_remember_person, fields={"chuc_vu": "giáo viên"})

        self.turn(OWNER, GROUP_B, owner=True)
        here = (await self.call(zalo_tools.zalo_recall_person))["result"]["profile"]
        self.assertEqual(here.get("fields"), {"chuc_vu": "giáo viên"}, "nhóm B không thấy tài sản nói ở nhóm A")
        listed = (await self.call(zalo_tools.zalo_list_people))["result"]["people"]
        self.assertNotIn("vàng", json.dumps(listed, ensure_ascii=False))

        self.turn(OWNER, GROUP_A, owner=True)
        here = (await self.call(zalo_tools.zalo_recall_person))["result"]["profile"]
        self.assertEqual(here.get("fields"), {"tai_san": "14 chỉ vàng"})

        self.turn(OWNER, OWNER, group=False, owner=True)
        mine = (await self.call(zalo_tools.zalo_recall_person))["result"]["profile"]
        self.assertEqual(mine["fields"], {"tai_san": "14 chỉ vàng", "chuc_vu": "giáo viên"}, "nhắn riêng: đủ")

    async def test_changed_value_moves_to_new_place_same_value_is_shared(self):
        from plugins.zalo_tools import people

        self.turn(MEMBER, GROUP_A)
        await self.call(zalo_tools.zalo_remember_person, fields={"lop": "12A1"})
        self.turn(MEMBER, GROUP_B)
        await self.call(zalo_tools.zalo_remember_person, fields={"lop": "12A1"})
        self.assertIn("lop: 12A1", people.describe_person(MEMBER, scope=f"g:{GROUP_A}"))
        self.assertIn("lop: 12A1", people.describe_person(MEMBER, scope=f"g:{GROUP_B}"))
        await self.call(zalo_tools.zalo_remember_person, fields={"lop": "12A2"})
        self.assertNotIn("lop", people.describe_person(MEMBER, scope=f"g:{GROUP_A}"), "giá trị mới không sang nhóm cũ")
        self.assertIn("lop: 12A2", people.describe_person(MEMBER, scope=f"g:{GROUP_B}"))

    async def test_remember_result_only_shows_this_place(self):
        self.turn(OWNER, GROUP_A, owner=True)
        await self.call(zalo_tools.zalo_remember_person, fields={"tai_san": "14 chỉ vàng"})
        self.turn(OWNER, GROUP_B, owner=True)
        got = await self.call(zalo_tools.zalo_remember_person, fields={"chuc_vu": "giáo viên"})
        text = json.dumps(got, ensure_ascii=False)
        self.assertNotIn("vàng", text)
        self.assertNotIn(GROUP_A, text, "không lộ ID nhóm khác qua danh sách nơi ghi")

    async def test_owner_cron_into_someone_elses_dm_is_not_full_view(self):
        from plugins.zalo_tools import people

        people.remember_person(OWNER, fields={"tai_san": "14 chỉ vàng"}, scope=f"g:{GROUP_A}")
        people.remember_person(MEMBER, name="Lan", fields={"lop": "12A1"}, scope=f"g:{GROUP_A}")
        self.turn(OWNER, MEMBER, group=False, owner=True)  # việc hẹn giờ của chủ nhân gửi vào DM của Lan
        listed = (await self.call(zalo_tools.zalo_list_people))["result"]
        recalled = (await self.call(zalo_tools.zalo_recall_person, user_id=OWNER))["result"]
        self.assertNotIn("vàng", json.dumps([listed, recalled], ensure_ascii=False))

    async def test_own_dm_hides_notes_the_owner_wrote_in_owner_dm_and_group_list_hides_names(self):
        from plugins.zalo_tools import people

        people.remember_person(MEMBER, name="Lan", fields={"lop": "12A1"}, scope=f"g:{GROUP_A}")
        people.remember_person(MEMBER, note="chủ nhân nhận xét riêng", scope=f"u:{OWNER}")
        mine = people.describe_person(MEMBER, scope=f"u:{MEMBER}")
        self.assertIn("lop: 12A1", mine)
        self.assertNotIn("nhận xét riêng", mine)
        people.remember_person(OWNER, name="Chủ", fields={"x": "y"}, scope=f"g:{GROUP_A}")
        self.turn(OWNER, GROUP_B, owner=True)
        listed = (await self.call(zalo_tools.zalo_list_people))["result"]
        self.assertEqual(listed, {"count": 0, "people": {}}, "nhóm B không biết ai có trong sổ")

    async def test_member_recall_in_group_and_no_scope_fail_closed(self):
        from plugins.zalo_tools import people

        people.remember_person(MEMBER, name="Lan", note="khai riêng", fields={"sdt": "0912"}, scope=f"u:{MEMBER}")
        self.turn(MEMBER, GROUP_A)
        got = (await self.call(zalo_tools.zalo_recall_person))["result"]["profile"]
        self.assertEqual(got, {"name": "Lan"}, "điều khai khi nhắn riêng không ra nhóm")
        self.assertEqual(people.describe_person(MEMBER), "Lan", "không rõ nơi → chỉ tên")


class FolderRulesTest(PermissionsFile, unittest.TestCase):
    """Quy tắc riêng của thư mục: chỉ nhóm/người trong thư mục được đính, nơi khác không."""

    def setUp(self):
        super().setUp()
        from plugins.zalo_tools import folder_rules
        self.fr = folder_rules
        self.fr._seen.clear()
        self.write({"version": 1, "folders": {
            "khkt1": {"name": "KHKT", "groups": [GROUP_A], "people": [{"uid": MEMBER, "name": "Em A"}],
                      "rules": "1. Hỏi trước – gợi sau.\n2. Không làm hộ bài đánh giá."},
            "lop": {"name": "Lớp", "groups": [GROUP_B]},
        }})

    def hook(self, thread_id, is_group, sender, session="s1"):
        zalo_tools.bind_turn({"sender_uid": sender, "thread_id": thread_id, "is_group": is_group, "is_owner": False})
        self.addCleanup(zalo_tools.bind_turn, None)
        return self.fr.pre_llm_call(session_id=session, platform="zalo")

    def test_lookup_by_group_folder_and_person_folder(self):
        self.assertEqual(gp.folder_rules(GROUP_A, True)[0], "KHKT")
        self.assertIsNone(gp.folder_rules(GROUP_B, True))  # thư mục không có quy tắc
        self.assertEqual(gp.folder_rules(MEMBER, False, MEMBER)[0], "KHKT")
        self.assertIsNone(gp.folder_rules(OWNER, False, OWNER))

    def test_hook_injects_full_rules_then_short_reminder_and_repeats(self):
        first = self.hook(GROUP_A, True, OWNER)["context"]
        self.assertIn("Không làm hộ bài đánh giá", first)
        second = self.hook(GROUP_A, True, OWNER)["context"]
        self.assertNotIn("Không làm hộ", second)
        self.assertIn("KHKT", second)
        for _ in range(self.fr.REPEAT_EVERY - 2):
            self.hook(GROUP_A, True, OWNER)
        self.assertIn("Không làm hộ", self.hook(GROUP_A, True, OWNER)["context"])

    def test_dm_of_person_in_folder_gets_rules_others_do_not(self):
        self.assertIn("Hỏi trước", self.hook(MEMBER, False, MEMBER, "dm")["context"])
        self.assertIsNone(self.hook(GROUP_B, True, MEMBER, "g2"))
        self.assertIsNone(self.hook(OWNER, False, OWNER, "o"))
        self.assertIsNone(self.fr.pre_llm_call(session_id="x", platform="telegram"))

    def test_changed_rules_are_sent_again_in_full(self):
        self.hook(GROUP_A, True, OWNER)
        self.write({"version": 1, "folders": {"khkt1": {"name": "KHKT", "groups": [GROUP_A], "rules": "Quy tắc mới."}}})
        self.assertIn("Quy tắc mới.", self.hook(GROUP_A, True, OWNER)["context"])


class BomTest(PermissionsFile, unittest.TestCase):
    def test_hand_edited_file_with_bom_is_read(self):
        with open(self.path, "w", encoding="utf-8-sig") as fh:
            fh.write(json.dumps({"version": 1, "defaults": {}, "groups": {GROUP_A: {"active": False}}}))
        self.assertFalse(gp.group_settings(GROUP_A)["active"])


class UnreadableFileTest(PermissionsFile, unittest.TestCase):
    def test_permission_error_is_logged_as_unreadable_not_corrupt(self):
        self.write({"version": 1, "defaults": {"features": {"web": False}}, "groups": {}})
        with patch.object(gp.Path, "read_text", side_effect=PermissionError(13, "Permission denied")), \
                self.assertLogs(gp.logger, level="ERROR") as logs:
            self.assertTrue(gp.group_settings(GROUP_A)["features"]["web"])
        self.assertIn("the gateway user cannot read it", logs.output[0])
        self.assertIn(self.path, logs.output[0])
        self.assertNotIn("hỏng", logs.output[0])


class GuardFeatureTest(PermissionsFile, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.write({"version": 1, "defaults": {},
                    "groups": {GROUP_A: {"features": {"web": False, "groupCron": False}}}})
        self.addCleanup(zalo_tools.bind_turn, None)

    def turn(self, *, thread=GROUP_A, owner=False, group=True):
        zalo_tools.bind_turn({"sender_uid": OWNER if owner else MEMBER, "thread_id": thread,
                              "is_group": group, "is_owner": owner, "text": ""})

    def test_owner_tool_refusal_hints_only_tools_enabled_in_this_group(self):
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"features": {"kb": False}}}})
        self.turn()
        message = zalo_tools.guard_member_tool_call("terminal", {"command": "ls"})["message"]
        self.assertNotIn("zalo_kb_list", message)
        self.assertIn("Cần gửi tệp thì zalo_send_file", message)
        self.turn(thread=GROUP_B)
        message = zalo_tools.guard_member_tool_call("terminal", {"command": "ls"})["message"]
        self.assertIn("Cần tra tài liệu thì dùng zalo_kb_list", message)
        self.assertIn("zalo_send_file", message)

    def test_member_in_group_with_web_off_is_refused_in_plain_vietnamese(self):
        self.turn()
        verdict = zalo_tools.guard_member_tool_call("zalo_web_search", {"query": "giá vàng"})
        self.assertEqual(verdict["action"], "block")
        self.assertIn("Nhóm này chưa bật tính năng tra cứu web", verdict["message"])
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_kb_list", {}))
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_send_sticker", {}))

    def test_other_group_dm_and_owner_are_not_affected(self):
        self.turn(thread=GROUP_B)
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_web_search", {"query": "x"}))
        self.turn(owner=True)
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_web_search", {"query": "x"}))
        self.write({"version": 1, "defaults": {"features": {"web": False}}, "groups": {}})
        self.turn(thread=MEMBER, group=False)
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_web_search", {"query": "x"}))

    def test_group_cron_off_blocks_only_create(self):
        self.turn()
        self.assertEqual(zalo_tools.guard_member_tool_call("zalo_group_cron", {"action": "create"})["action"], "block")
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_group_cron", {"action": "list"}))
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_group_cron", {"action": "remove", "job_id": "a"}))

    def test_tool_call_bridge_is_checked_against_the_real_tool(self):
        self.turn()
        with patch("tools.tool_search.resolve_underlying_call",
                   return_value=("zalo_web_read", {"url": "https://a.vn"}, None)):
            verdict = zalo_tools.guard_member_tool_call(
                "tool_call", {"name": "zalo_web_read", "arguments": {"url": "https://a.vn"}})
        self.assertEqual(verdict["action"], "block")

    def test_tool_call_with_non_dict_arguments_does_not_crash(self):
        self.turn()
        with patch("tools.tool_search.resolve_underlying_call",
                   return_value=("zalo_group_cron", ["lạ"], None)):
            verdict = zalo_tools.guard_member_tool_call("tool_call", {"name": "zalo_group_cron"})
        self.assertIsNone(verdict)

    def test_owner_turn_with_outsider_interjection_is_held_to_group_rules(self):
        zalo_tools.bind_turn({"sender_uid": OWNER, "thread_id": GROUP_A, "is_group": True,
                              "is_owner": True, "text": "", "seq": 1})
        with patch.object(zalo_tools, "_outsider_spoke_after", return_value=True):
            verdict = zalo_tools.guard_member_tool_call("zalo_web_search", {"query": "x"})
        self.assertEqual(verdict["action"], "block")
        self.assertIn("chưa bật", verdict["message"])

    def test_no_zalo_turn_means_no_check(self):
        zalo_tools.bind_turn(None)
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_web_search", {"query": "x"}))


class AdapterHarness:
    """Adapter thật, cầu nối giả: ghi lại tin nào được chuyển cho agent."""

    def make_adapter(self, reply_only_tagged=True):
        adapter = zalo_adapter.ZaloAdapter(PlatformConfig(enabled=True, extra={
            "bridge_url": "ws://127.0.0.1:9", "reply_only_tagged": reply_only_tagged, "ack_gestures": False,
        }))
        adapter._self_profile = {"user_id": "bot-uid", "display_name": "Lăng Tiêu"}
        adapter._flood.check = lambda _uid: None
        self.handled = []

        async def handle(event):
            self.handled.append(event)

        adapter.handle_message = handle
        return adapter

    async def say(self, adapter, msg_id, sender, text, *, tagged=True, thread=GROUP_A):
        frame = {"type": "message", "id": msg_id, "threadId": thread,
                 "threadType": zalo_adapter.THREAD_TYPE_GROUP, "senderUid": sender,
                 "senderName": "Lan", "text": text}
        if tagged:
            frame["mentions"] = [{"uid": "bot-uid"}]
        with patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            await adapter._on_message(frame)


class AdapterGroupRulesTest(PermissionsFile, AdapterHarness, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        self.enterContext(patch.dict(os.environ, {"ZALO_ALLOWED_USERS": OWNER}))

    async def test_inactive_group_ignores_members_but_keeps_context_and_owner(self):
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"active": False}}})
        adapter = self.make_adapter()
        await self.say(adapter, "m1", MEMBER, "@Lăng Tiêu chào bot")
        self.assertEqual(self.handled, [])
        self.assertEqual(list(adapter._recent_group_messages[GROUP_A])[0]["text"], "@Lăng Tiêu chào bot")
        await self.say(adapter, "m2", OWNER, "@Lăng Tiêu tóm tắt nhóm")
        self.assertEqual(len(self.handled), 1)
        await self.say(adapter, "m3", MEMBER, "@Lăng Tiêu chào", thread=GROUP_B)
        self.assertEqual(len(self.handled), 2)

    async def test_reply_only_tagged_overrides_global_flag_per_group(self):
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"replyOnlyTagged": False}}})
        adapter = self.make_adapter(reply_only_tagged=True)
        await self.say(adapter, "m1", MEMBER, "ai biết lịch họp không", tagged=False)
        self.assertEqual(len(self.handled), 1)
        await self.say(adapter, "m2", MEMBER, "ai biết lịch họp không", tagged=False, thread=GROUP_B)
        self.assertEqual(len(self.handled), 1)

        self.write({"version": 1, "defaults": {"replyOnlyTagged": True}, "groups": {}})
        adapter = self.make_adapter(reply_only_tagged=False)
        await self.say(adapter, "m3", MEMBER, "ai biết lịch họp không", tagged=False)
        self.assertEqual(len(self.handled), 0)

    async def test_member_turn_lists_disabled_features_owner_turn_does_not(self):
        self.write({"version": 1, "defaults": {"features": {"video": False}},
                    "groups": {GROUP_A: {"features": {"web": False}}}})
        adapter = self.make_adapter()
        await self.say(adapter, "m1", MEMBER, "@Lăng Tiêu tra giá vàng")
        context = self.handled[0].channel_context
        self.assertIn("Nhóm này đang tắt: tra cứu web, tải, cắt ghép, sửa và xem thông tin video", context)
        await self.say(adapter, "m2", OWNER, "@Lăng Tiêu tra giá vàng")
        self.assertNotIn("đang tắt", self.handled[1].channel_context or "")

    async def test_member_turn_with_everything_on_has_no_disabled_line(self):
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"replyOnlyTagged": True}}})
        adapter = self.make_adapter()
        await self.say(adapter, "m1", MEMBER, "@Lăng Tiêu tra giá vàng")
        self.assertEqual(len(self.handled), 1)
        self.assertNotIn("Nhóm này đang tắt", self.handled[0].channel_context or "")
        self.assertNotIn("Nhóm này đang tắt", self.handled[0].text)

    async def test_custom_group_permissions_override_legacy_owner_only_list(self):
        # Sự cố 09/10: nhóm nằm trong owner_only_groups cũ (config.yaml) — mở trên Phân quyền mà thành viên vẫn bị bỏ qua.
        adapter = self.make_adapter()
        adapter._owner_only_groups = {GROUP_A, GROUP_B}
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"active": True, "replyOnlyTagged": False}}})
        await self.say(adapter, "m1", MEMBER, "chào bot", tagged=False)
        self.assertEqual(len(self.handled), 1, "nhóm đã phân quyền riêng: phân quyền thắng danh sách cũ")
        await self.say(adapter, "m2", MEMBER, "@Lăng Tiêu chào", thread=GROUP_B)
        self.assertEqual(len(self.handled), 1, "nhóm chưa chỉnh riêng: danh sách cũ vẫn áp")
        await self.say(adapter, "m3", OWNER, "@Lăng Tiêu chào", thread=GROUP_B)
        self.assertEqual(len(self.handled), 2, "chủ nhân không bao giờ bị chặn")

    async def test_people_off_skips_profile_for_members_but_not_owner(self):
        from plugins.zalo_tools import people

        self.enterContext(patch.dict(os.environ, {"ZALO_PEOPLE_FILE": os.path.join(self.dir, "people.json")}))
        people.remember_person(MEMBER, name="Lan", note="Giáo viên Hoá", scope=f"g:{GROUP_B}")
        people.remember_person(OWNER, name="Chủ", note="Hiệu trưởng", scope=f"g:{GROUP_A}")
        adapter = self.make_adapter()
        await self.say(adapter, "m1", MEMBER, "@Lăng Tiêu chào", thread=GROUP_B)
        self.assertIn("Giáo viên Hoá", self.handled[-1].text)
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"features": {"people": False}}}})
        await self.say(adapter, "m2", MEMBER, "@Lăng Tiêu chào")
        self.assertNotIn("Người nhắn", self.handled[-1].text)
        self.assertNotIn("Giáo viên Hoá", self.handled[-1].text)
        await self.say(adapter, "m3", OWNER, "@Lăng Tiêu chào")
        self.assertIn("Hiệu trưởng", self.handled[-1].text)

    async def test_half_updated_install_without_group_permissions_keeps_answering(self):
        self.write({"version": 1, "defaults": {"features": {"web": False}},
                    "groups": {GROUP_A: {"active": False}}})
        adapter = self.make_adapter()
        with patch.object(zalo_adapter, "_group_permissions", lambda: None):
            self.assertIsNone(adapter._group_rules(GROUP_A))
            await self.say(adapter, "m1", MEMBER, "@Lăng Tiêu chào")
        self.assertEqual(len(self.handled), 1)
        self.assertNotIn("đang tắt", self.handled[0].channel_context or "")

    async def test_corrupt_file_never_silences_the_bot(self):
        self.write("{hỏng")
        adapter = self.make_adapter()
        with self.assertLogs(gp.logger, level="WARNING"):
            await self.say(adapter, "m1", MEMBER, "@Lăng Tiêu chào")
        self.assertEqual(len(self.handled), 1)
        self.assertNotIn("đang tắt", self.handled[0].channel_context or "")


class CronDeliveryTest(PermissionsFile, AdapterHarness, unittest.IsolatedAsyncioTestCase):
    """Nhóm tắt "Hoạt động": việc hẹn giờ của thành viên không gửi gì vào nhóm; của chủ nhân vẫn gửi."""

    def setUp(self):
        super().setUp()
        self.enterContext(patch.dict(os.environ, {"ZALO_ALLOWED_USERS": OWNER}))
        jobs = {
            "member-job": {"id": "member-job", "deliver": f"zalo:{GROUP_A}",
                           "origin": {"platform": "zalo", "chat_id": GROUP_A, "zalo_scope": "group",
                                      "zalo_creator_uid": MEMBER}},
            "owner-group-job": {"id": "owner-group-job", "deliver": f"zalo:{GROUP_A}",
                                "origin": {"platform": "zalo", "chat_id": GROUP_A, "zalo_scope": "group",
                                           "zalo_creator_uid": OWNER}},
            "owner-native-job": {"id": "owner-native-job", "deliver": f"zalo:{GROUP_A}",
                                 "origin": {"platform": "zalo", "chat_id": GROUP_A}},
        }

        class FakeJobs:
            @staticmethod
            def get_job(job_id):
                return jobs.get(job_id)

        self.enterContext(patch.object(zalo_tools, "_cron_jobs", return_value=FakeJobs))
        self.enterContext(patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools))
        self.adapter = self.make_adapter()
        self.sent = []

        async def command(payload, expect_ack=False):
            self.sent.append(payload)
            return {"ok": True, "msgId": "1"}

        self.adapter._command = command

    async def deliver(self, job_id, chat=GROUP_A):
        return await self.adapter.send(chat, "Bản tin sáng", metadata={"job_id": job_id, "notify": True})

    async def test_member_job_into_inactive_group_is_not_posted_and_logged(self):
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"active": False}}})
        with self.assertLogs(zalo_adapter.logger, level="INFO") as logs:
            result = await self.deliver("member-job")
        self.assertTrue(result.success)
        self.assertEqual(self.sent, [])
        self.assertTrue(any("member-job" in line and GROUP_A in line for line in logs.output))

    async def test_owner_jobs_still_post_into_inactive_group(self):
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"active": False}}})
        await self.deliver("owner-group-job")
        await self.deliver("owner-native-job")
        self.assertEqual(len(self.sent), 2)

    async def test_member_job_posts_when_group_is_active_or_only_other_group_is_off(self):
        await self.deliver("member-job")
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_B: {"active": False}}})
        await self.deliver("member-job")
        # Tắt "Hẹn giờ cho nhóm" chỉ chặn tạo mới — việc đã có vẫn gửi.
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"features": {"groupCron": False}}}})
        await self.deliver("member-job")
        self.assertEqual(len(self.sent), 3)

    async def test_ordinary_replies_and_unknown_jobs_are_not_affected(self):
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"active": False}}})
        await self.adapter.send(GROUP_A, "trả lời chủ nhân")
        await self.deliver("job-da-xoa")
        self.assertEqual(len(self.sent), 2)


# Kịch bản ghi tệp bằng đúng dashboard/lib/permissions.js (như khi bấm Lưu trên giao diện:
# bản nháp xuất phát từ trạng thái đang hiệu lực mà dashboard hiển thị).
_NODE_FIXTURE = r"""
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [modUrl, home, stepsJson] = process.argv.slice(1);
const { createPermissionsStore, makeGlobalReplyOnlyTagged, parseDm, parseStudio } = await import(modUrl);
const store = createPermissionsStore({
  file: join(home, 'zalo', 'permissions.json'),
  globalReplyOnlyTagged: makeGlobalReplyOnlyTagged({ envFile: join(home, '.env'), configFile: join(home, 'config.yaml') }),
});
for (const step of JSON.parse(stepsJson)) {
  if (step.dm) { store.setDm(parseDm(step.dm)); continue; }
  if (step.quotas) { store.setStudio(parseStudio(step.quotas)); continue; }
  const view = store.get();
  const base = step.group ? (view.groups[step.group] || view.defaults) : view.defaults;
  const s = { active: base.active, replyOnlyTagged: base.replyOnlyTagged, features: { ...base.features }, studio: { ...base.studio } };
  Object.assign(s, step.set || {});
  Object.assign(s.features, step.features || {});
  Object.assign(s.studio, step.studio || {});
  if (step.studioQuota !== undefined) s.studioQuota = step.studioQuota;
  if (step.group) store.setGroup(step.group, s); else store.setDefaults(s);
}
"""


class DashboardContractTest(AdapterHarness, unittest.IsolatedAsyncioTestCase):
    """Tệp do dashboard (JS) ghi phải được plugin (Python) hiểu đúng như giao diện đã hiện."""

    def setUp(self):
        self.node = shutil.which("node")
        if not self.node:
            self.skipTest("không có node trong PATH")
        self.home = tempfile.mkdtemp(prefix="zalo-contract-")
        self.addCleanup(shutil.rmtree, self.home, True)
        self.enterContext(patch.dict(os.environ, {
            "ZALO_PERMISSIONS_FILE": os.path.join(self.home, "zalo", "permissions.json"),
            "ZALO_ALLOWED_USERS": OWNER,
        }))

    def hermes_env(self, text):
        with open(os.path.join(self.home, ".env"), "w", encoding="utf-8") as fh:
            fh.write(text)

    def dashboard_saves(self, steps):
        import subprocess
        from pathlib import Path
        mod = Path(ROOT, "dashboard", "lib", "permissions.js").resolve().as_uri()
        result = subprocess.run(
            [self.node, "--input-type=module", "-e", _NODE_FIXTURE, mod, self.home, json.dumps(steps)],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    async def test_s1_turning_off_one_feature_keeps_the_hermes_tag_flag(self):
        # Hermes: trả lời mọi tin. Trên dashboard chỉ tắt "web" ở nhóm A.
        self.hermes_env("ZALO_GROUP_REPLY_ONLY_TAGGED=false\n")
        self.dashboard_saves([{"group": GROUP_A, "features": {"web": False}}])
        rules = gp.group_settings(GROUP_A)
        self.assertIn(rules["reply_only_tagged"], (False, None))
        self.assertFalse(rules["features"]["web"])
        self.assertTrue(all(on for key, on in rules["features"].items() if key != "web"))
        # Và adapter thật (cờ Hermes false) vẫn trả lời tin không tag trong nhóm A.
        adapter = self.make_adapter(reply_only_tagged=False)
        await self.say(adapter, "c1", MEMBER, "ai biết lịch họp không", tagged=False)
        self.assertEqual(len(self.handled), 1)

    async def test_s2_defaults_change_reaches_groups_that_do_not_override_the_key(self):
        self.hermes_env("ZALO_GROUP_REPLY_ONLY_TAGGED=false\n")
        self.dashboard_saves([
            {"group": GROUP_A, "features": {"web": False}},
            {"set": {"replyOnlyTagged": True}, "features": {"kb": False}},
        ])
        for group in (GROUP_A, GROUP_B):
            rules = gp.group_settings(group)
            self.assertIs(rules["reply_only_tagged"], True, group)
            self.assertFalse(rules["features"]["kb"], group)
        self.assertFalse(gp.group_settings(GROUP_A)["features"]["web"])
        self.assertTrue(gp.group_settings(GROUP_B)["features"]["web"])

    async def test_s3_dm_section_written_by_dashboard_is_read_by_plugin(self):
        # Lưu nhóm trước và sau mục Nhắn riêng: không lần lưu nào làm mất phần của lần kia.
        all8 = {feature: True for feature in gp.DM_FEATURES}
        lan = "1234567890123456"
        self.dashboard_saves([
            {"group": GROUP_A, "features": {"web": False}},
            {"dm": {"who": "list", "features": {**all8, "video": False},
                    "people": [{"uid": lan, "name": "Cô Lan", "features": {**all8, "voice": False}}]}},
            {"group": GROUP_B, "features": {"kb": False}},
        ])
        self.assertIs(gp.dm_allows(lan), True)
        self.assertIs(gp.dm_allows(MEMBER), False)
        self.assertEqual(gp.dm_disabled_features(lan), ["voice"], "người có nút riêng: video bật lại, thoại tắt")
        self.assertEqual(gp.dm_disabled_features(MEMBER), ["video"])
        self.assertEqual(gp.disabled_features(GROUP_A), ["web"])
        self.assertEqual(gp.disabled_features(GROUP_B), ["kb"])

    async def test_s4_studio_switches_and_quotas_written_by_dashboard_are_read_by_plugin(self):
        self.enterContext(patch.object(gp, "VIDEO_BLOCKED", False))
        self.enterContext(patch.object(gp, "sandbox_mode", lambda: "systemd"))
        all8 = {feature: True for feature in gp.DM_FEATURES}
        lan = "1234567890123456"
        off = {f: False for f in gp.STUDIO_FEATURES}
        self.dashboard_saves([
            {"studio": {"studioSlides": True, "studioDocs": True}},
            {"group": GROUP_A, "studio": {"studioDocs": False, "studioVideo": True}, "studioQuota": 5},
            {"dm": {"who": "everyone", "features": all8, "studio": {**off, "studioExams": True},
                    "people": [{"uid": lan, "features": all8, "studio": {**off, "studioExams": True, "studioSlides": True}}]}},
            {"quotas": {"quota": 2, "people": [{"uid": lan, "name": "Cô Lan", "quota": 9}]}},
            {"group": GROUP_B, "features": {"kb": False}},
        ])
        a = gp.studio_settings(MEMBER, GROUP_A, True)
        self.assertEqual(a, {"features": {**off, "studioSlides": True, "studioVideo": True}, "quota": 5})
        self.assertEqual(gp.studio_settings(MEMBER, GROUP_B, True), {"features": {**off, "studioSlides": True, "studioDocs": True}, "quota": 2})
        self.assertEqual(gp.studio_settings(MEMBER, MEMBER, False), {"features": {**off, "studioExams": True}, "quota": 2})
        self.assertEqual(gp.studio_settings(lan, lan, False), {"features": {**off, "studioExams": True, "studioSlides": True}, "quota": 9})
        self.assertEqual(gp.studio_settings(lan, GROUP_A, True)["quota"], 9, "hạn mức riêng của người thắng nhóm")
        self.assertEqual(gp.disabled_features(GROUP_B), ["kb"])


STRANGER = "5555555555555555555"


class DmPermissionsTest(PermissionsFile, unittest.TestCase):
    """Mục "dm" của permissions.json (spec §16)."""

    def test_missing_dm_section_means_env_policy_and_everything_on(self):
        self.assertIsNone(gp.dm_allows(MEMBER))
        self.write({"version": 1, "defaults": {"features": {"web": False}}, "groups": {}})
        self.assertIsNone(gp.dm_allows(MEMBER))
        self.assertEqual(gp.dm_disabled_features(MEMBER), [], "bảng nhóm không áp cho tin nhắn riêng")

    def test_who_list_everyone_owners(self):
        self.write({"version": 1, "dm": {"who": "list", "people": {MEMBER: {"name": "Cô Lan"}}}})
        self.assertIs(gp.dm_allows(MEMBER), True)
        self.assertIs(gp.dm_allows(STRANGER), False)
        self.write({"version": 1, "dm": {"who": "everyone"}})
        self.assertIs(gp.dm_allows(STRANGER), True)
        self.write({"version": 1, "dm": {"who": "owners", "people": {MEMBER: {}}}})
        self.assertIs(gp.dm_allows(MEMBER), False)
        self.write({"version": 1, "dm": {"who": "ai cũng được"}})
        self.assertIsNone(gp.dm_allows(MEMBER), "who lạ → theo ZALO_DM_POLICY")

    def test_features_merge_default_dm_then_person(self):
        self.write({"version": 1, "dm": {"who": "everyone", "features": {"web": False, "groupCron": False},
                                         "people": {MEMBER: {"features": {"web": True, "video": False, "kb": "no"}}}}})
        self.assertEqual(gp.dm_disabled_features(STRANGER), ["web"])
        self.assertEqual(gp.dm_disabled_features(MEMBER), ["video"])
        self.assertNotIn("groupCron", gp.dm_settings(MEMBER)["features"])
        self.assertEqual(gp.DM_FEATURES, tuple(f for f in gp.FEATURES if f != "groupCron"))

    def test_non_digit_uid_keys_and_garbage_are_ignored(self):
        self.write({"version": 1, "dm": {"who": "list", "people": {"abc": {}, "１２３": {}, MEMBER: "rác"}}})
        self.assertIs(gp.dm_allows("abc"), False)
        self.assertIs(gp.dm_allows("１２３"), False, "chữ số toàn khổ không phải UID")
        self.assertIs(gp.dm_allows(MEMBER), True, "mục rác vẫn là có tên trong danh sách — giống dm-rules.js")
        self.write({"version": 1, "dm": "rác"})
        self.assertIsNone(gp.dm_allows(MEMBER))


class GuardDmFeatureTest(PermissionsFile, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.write({"version": 1, "dm": {"who": "everyone", "features": {"web": False},
                                         "people": {MEMBER: {"features": {"web": True, "kb": False}}}}})
        self.addCleanup(zalo_tools.bind_turn, None)

    def dm_turn(self, uid, owner=False):
        zalo_tools.bind_turn({"sender_uid": uid, "thread_id": uid, "is_group": False, "is_owner": owner, "text": ""})

    def test_dm_feature_off_is_refused_with_dm_wording(self):
        self.dm_turn(STRANGER)
        verdict = zalo_tools.guard_member_tool_call("zalo_web_search", {"query": "x"})
        self.assertEqual(verdict["action"], "block")
        self.assertIn("khi nhắn riêng", verdict["message"])
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_kb_list", {}))

    def test_per_person_override_and_owner_exempt(self):
        self.dm_turn(MEMBER)
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_web_search", {"query": "x"}))
        self.assertEqual(zalo_tools.guard_member_tool_call("zalo_kb_read", {"name": "a"})["action"], "block")
        message = zalo_tools.guard_member_tool_call("terminal", {"command": "ls"})["message"]
        self.assertNotIn("zalo_kb_list", message, "không gợi ý công cụ đang tắt với người này")
        self.dm_turn(OWNER, owner=True)
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_web_search", {"query": "x"}))

    def test_group_cron_is_not_a_dm_switch_and_group_turns_ignore_dm_section(self):
        self.write({"version": 1, "dm": {"who": "everyone", "features": {"web": False}}})
        self.dm_turn(STRANGER)
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_group_cron", {"action": "create"}))
        zalo_tools.bind_turn({"sender_uid": STRANGER, "thread_id": GROUP_A, "is_group": True, "is_owner": False, "text": ""})
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_web_search", {"query": "x"}))

    def test_unreadable_dm_rules_do_not_block(self):
        self.dm_turn(STRANGER)
        with patch.object(gp, "dm_settings", side_effect=RuntimeError("hỏng")), \
                self.assertLogs(zalo_tools.logger, level="WARNING"):
            self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_web_search", {"query": "x"}))

    def test_sethome_turn_marks_the_authorization(self):
        zalo_tools.bind_turn({"sender_uid": STRANGER, "thread_id": STRANGER, "is_group": False,
                              "is_owner": False, "text": "/sethome", "sethome": True})
        self.assertEqual(zalo_tools.current_authorization()["notice"], "sethome")
        self.dm_turn(STRANGER)
        self.assertNotIn("notice", zalo_tools.current_authorization())


class AdapterDmTest(PermissionsFile, AdapterHarness, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        self.enterContext(patch.dict(os.environ, {"ZALO_ALLOWED_USERS": OWNER}))

    def dm_adapter(self, policy="owner-only"):
        adapter = self.make_adapter()
        adapter._dm_policy = policy
        return adapter

    async def dm(self, adapter, msg_id, sender, text):
        frame = {"type": "message", "id": msg_id, "threadId": sender,
                 "threadType": zalo_adapter.THREAD_TYPE_USER, "senderUid": sender,
                 "senderName": "Lan", "text": text}
        with patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            await adapter._on_message(frame)

    async def test_without_dm_section_env_policy_decides_as_before(self):
        adapter = self.dm_adapter("owner-only")
        await self.dm(adapter, "d1", STRANGER, "chào bot")
        self.assertEqual(self.handled, [])
        await self.dm(adapter, "d2", OWNER, "chào bot")
        self.assertEqual(len(self.handled), 1)
        adapter = self.dm_adapter("open")  # adapter mới, self.handled làm lại từ đầu
        await self.dm(adapter, "d3", STRANGER, "chào bot")
        self.assertEqual(len(self.handled), 1)

    async def test_dashboard_list_overrides_env_policy_both_ways(self):
        self.write({"version": 1, "dm": {"who": "list", "people": {MEMBER: {}}}})
        adapter = self.dm_adapter("owner-only")
        await self.dm(adapter, "d1", MEMBER, "chào bot")
        await self.dm(adapter, "d2", STRANGER, "chào bot")
        self.assertEqual([e.source.user_id for e in self.handled], [MEMBER])
        adapter = self.dm_adapter("open")  # adapter mới, self.handled làm lại từ đầu
        await self.dm(adapter, "d3", STRANGER, "chào bot")
        self.assertEqual(self.handled, [], "tệp nói danh sách thì ZALO_DM_POLICY=open không mở thêm")
        self.write({"version": 1, "dm": {"who": "owners", "people": {MEMBER: {}}}})
        await self.dm(adapter, "d4", MEMBER, "chào bot")
        await self.dm(adapter, "d5", OWNER, "chào bot")
        self.assertEqual([e.source.user_id for e in self.handled], [OWNER], "chỉ chủ nhân: người trong danh sách cũng không vào")

    async def test_member_dm_lists_disabled_features_and_skips_people_profile(self):
        from plugins.zalo_tools import people

        self.enterContext(patch.dict(os.environ, {"ZALO_PEOPLE_FILE": os.path.join(self.dir, "people.json")}))
        people.remember_person(MEMBER, name="Lan", note="Giáo viên Hoá")
        self.write({"version": 1, "dm": {"who": "everyone", "features": {"web": False, "people": False}}})
        adapter = self.dm_adapter()
        await self.dm(adapter, "d1", MEMBER, "tra giá vàng")
        self.assertIn("Tin nhắn riêng này đang tắt: tra cứu web, sổ người quen", self.handled[0].channel_context)
        self.assertNotIn("Giáo viên Hoá", self.handled[0].text)
        await self.dm(adapter, "d2", OWNER, "tra giá vàng")
        self.assertNotIn("đang tắt", self.handled[1].channel_context or "")

    async def test_errors_and_half_install_fall_back_to_env_policy_never_wider(self):
        self.write({"version": 1, "dm": {"who": "everyone"}})
        adapter = self.dm_adapter("owner-only")
        with patch.object(gp, "dm_allows", side_effect=RuntimeError("hỏng")), \
                patch.object(gp, "dm_settings", side_effect=RuntimeError("hỏng")), \
                self.assertLogs(zalo_adapter.logger, level="WARNING"):
            await self.dm(adapter, "d1", STRANGER, "chào bot")
        self.assertEqual(self.handled, [])
        with patch.object(zalo_adapter, "_group_permissions", lambda: None):
            await self.dm(adapter, "d2", STRANGER, "chào bot")
        self.assertEqual(self.handled, [])
        self.write("{hỏng")
        adapter = self.dm_adapter("open")
        with self.assertLogs(gp.logger, level="WARNING"):
            await self.dm(adapter, "d3", STRANGER, "chào bot")
        self.assertEqual(len(self.handled), 1, "tệp hỏng → ZALO_DM_POLICY=open như trước")

    async def test_stranger_sethome_reply_carries_the_sethome_notice(self):
        self.write({"version": 1, "dm": {"who": "list", "people": {}}})
        adapter = self.dm_adapter()
        sent = []

        async def command(payload, expect_ack=False):
            sent.append(zalo_tools.current_authorization())
            return {"ok": True, "msgId": "1"}

        adapter._command = command
        await self.dm(adapter, "d1", STRANGER, "/sethome")
        self.assertEqual(self.handled, [])
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["notice"], "sethome")
        self.assertEqual(sent[0]["actorUid"], STRANGER)


REAL_SANDBOX_MODE = gp.sandbox_mode


class FolderPermissionsTest(PermissionsFile, unittest.TestCase):
    """Thư mục nhóm: mặc định ← thư mục ← nhóm; mỗi nhóm một thư mục; nhóm trong thư mục thắng danh sách cũ."""

    def setUp(self):
        super().setUp()
        self.enterContext(patch.object(gp, "VIDEO_BLOCKED", False))
        self.enterContext(patch.object(gp, "sandbox_mode", lambda: "systemd"))

    def test_group_inherits_folder_and_own_keys_win(self):
        self.write({"version": 1,
                    "defaults": {"active": True, "replyOnlyTagged": True, "features": {"studioSlides": True}},
                    "folders": {"lop": {"name": "Lớp học", "groups": [GROUP_A, GROUP_B], "active": False,
                                        "replyOnlyTagged": False, "features": {"web": False, "studioSlides": False},
                                        "studioQuota": 1}},
                    "groups": {GROUP_B: {"active": True, "features": {"web": True}, "studioQuota": 5}}})
        a, b = gp.group_settings(GROUP_A), gp.group_settings(GROUP_B)
        self.assertEqual((a["active"], a["reply_only_tagged"], a["features"]["web"], a["custom"]), (False, False, False, True))
        self.assertEqual((b["active"], b["reply_only_tagged"], b["features"]["web"]), (True, False, True))
        self.assertEqual(gp.disabled_features(GROUP_A), ["web"])
        self.assertEqual(gp.studio_settings(MEMBER, GROUP_A, True), {"features": {**{f: False for f in gp.STUDIO_FEATURES}}, "quota": 1})
        self.assertEqual(gp.studio_settings(MEMBER, GROUP_B, True)["quota"], 5)
        outside = gp.group_settings("1111111111")
        self.assertEqual((outside["active"], outside["custom"]), (True, False))
        self.assertTrue(gp.studio_settings(MEMBER, "1111111111", True)["features"]["studioSlides"])

    def test_group_in_two_folders_follows_the_first_and_bad_entries_ignored(self):
        self.write({"version": 1,
                    "folders": {"a1": {"groups": [GROUP_A], "features": {"kb": False}},
                                "b2": {"groups": [GROUP_A, "x1", 5], "features": {"kb": True, "video": False}},
                                "BAD ID": {"groups": [GROUP_B], "active": False}, "c3": "hỏng"}})
        self.assertFalse(gp.group_settings(GROUP_A)["features"]["kb"])
        self.assertTrue(gp.group_settings(GROUP_A)["features"]["video"])
        self.assertTrue(gp.group_settings(GROUP_B)["active"])

    def test_file_without_folders_behaves_as_before(self):
        self.write({"version": 1, "defaults": {"features": {"voice": False}}, "groups": {GROUP_A: {"active": False}}})
        self.assertEqual(gp.disabled_features(GROUP_B), ["voice"])
        self.assertFalse(gp.group_settings(GROUP_A)["active"])

    def test_person_in_folder_may_dm_and_gets_folder_features_and_studio(self):
        other = "1111111111111111111"
        self.write({"version": 1,
                    "defaults": {"features": {"kb": False, "studioDocs": True}},
                    "folders": {"bch": {"name": "BCH", "groups": [GROUP_A], "people": [{"uid": MEMBER, "name": "Lan"}, other],
                                        "features": {"web": False, "studioSlides": True}, "studioQuota": 7}},
                    "dm": {"who": "list", "features": {"voice": False}, "people": {other: {"features": {"web": True}}}}})
        s = gp.dm_settings(MEMBER)
        self.assertTrue(s["listed"], "vào thư mục = có trong danh sách nhắn riêng")
        self.assertTrue(gp.dm_allows(MEMBER))
        self.assertEqual((s["features"]["web"], s["features"]["kb"], s["features"]["voice"]), (False, False, True),
                         "thấy sao áp vậy: mặc định ← thư mục, không theo tính năng chung nhắn riêng")
        self.assertEqual(set(s["features"]), set(gp.DM_FEATURES))
        studio = gp.studio_settings(MEMBER, MEMBER, False)
        self.assertEqual((studio["features"]["studioSlides"], studio["features"]["studioDocs"], studio["quota"]), (True, True, 7))
        self.assertTrue(gp.dm_settings(other)["features"]["web"], "chỉnh riêng của người thắng thư mục")
        outsider = gp.dm_settings("2222222222222222222")
        self.assertEqual((outsider["listed"], outsider["features"]["voice"]), (False, False))
        self.assertFalse(gp.dm_allows("2222222222222222222"))


class StudioPermissionsTest(PermissionsFile, unittest.TestCase):
    """Xưởng tạo sản phẩm (spec §17): thiếu khoá/lỗi = tắt; hạn mức người ← nhóm ← mặc định ← 3."""

    def setUp(self):
        super().setUp()
        # Máy chạy test có thể là Windows (và không có systemd): chính sách "video tắt khi không có hộp cát"
        # được thử riêng bên dưới.
        self.enterContext(patch.object(gp, "VIDEO_BLOCKED", False))
        self.enterContext(patch.object(gp, "sandbox_mode", lambda: "systemd"))

    def test_ai_image_video_switches_and_daily_quotas_follow_the_layers(self):
        self.assertEqual(gp.media_quotas(MEMBER, GROUP_A, True), {"image": 5, "video": 1}, "chưa có tệp → 5 ảnh, 1 video")
        self.write({"version": 1, "defaults": {"features": {"studioImage": True}},
                    "groups": {GROUP_A: {"imageQuota": 2}},
                    "studio": {"quota": 3, "image": 7, "video": 0, "people": {MEMBER: {"quota": 3, "video": 4}}}})
        self.assertEqual(gp.media_quotas(MEMBER, GROUP_A, True), {"image": 2, "video": 4}, "nhóm thắng mặc định, người thắng nhóm")
        self.assertEqual(gp.media_quotas(STRANGER, GROUP_B, True), {"image": 7, "video": 0})
        self.assertEqual(gp.media_quotas(STRANGER, STRANGER, False), {"image": 7, "video": 0})
        rules = gp.studio_settings(MEMBER, GROUP_A, True)["features"]
        self.assertTrue(rules["studioImage"])
        self.assertFalse(rules["studioAIVideo"], "thiếu khoá = tắt")
        with patch.object(gp, "VIDEO_BLOCKED", True):
            self.write({"version": 1, "defaults": {"features": {"studioAIVideo": True, "studioVideo": True}}})
            rules = gp.studio_settings(MEMBER, GROUP_A, True)["features"]
            self.assertTrue(rules["studioAIVideo"], "video AI chạy ở Stali, không cần hộp cát")
            self.assertFalse(rules["studioVideo"])
        self.assertIn("zalo_media", gp.STUDIO_TOOLS)

    def test_linux_without_systemd_sandbox_forces_video_off_with_its_own_note(self):
        self.write({"version": 1, "defaults": {"features": {"studioVideo": True, "studioSlides": True}},
                    "dm": {"features": {"studioVideo": True}}})
        self.assertTrue(gp.studio_settings(MEMBER, GROUP_A, True)["features"]["studioVideo"])
        self.assertEqual(gp.video_policy(), {"videoBlocked": False, "note": ""})
        with patch.object(gp, "sandbox_mode", lambda: "plain"):
            for thread, is_group in ((GROUP_A, True), (MEMBER, False)):
                rules = gp.studio_settings(MEMBER, thread, is_group)["features"]
                self.assertFalse(rules["studioVideo"])
                self.assertEqual(rules["studioSlides"], is_group)
            self.assertEqual(gp.video_policy(), {"videoBlocked": True, "note": gp.PLAIN_VIDEO_NOTE})
        # Đường thật, không giả: ZALO_STUDIO_SANDBOX=none → sandbox.mode() là plain trên mọi máy.
        with patch.object(gp, "sandbox_mode", REAL_SANDBOX_MODE), patch.dict(os.environ, {"ZALO_STUDIO_SANDBOX": "none"}):
            self.assertEqual(gp.sandbox_mode(), "plain")
            self.assertFalse(gp.studio_settings(MEMBER, GROUP_A, True)["features"]["studioVideo"])
        with patch.object(gp, "VIDEO_BLOCKED", True):
            self.assertEqual(gp.video_policy(), {"videoBlocked": True, "note": gp.WINDOWS_VIDEO_NOTE})

    def test_video_policy_is_published_next_to_permissions_for_the_dashboard(self):
        with patch.object(gp, "sandbox_mode", lambda: "plain"):
            data = gp.publish_video_policy()
        self.assertEqual(gp.video_policy_path(), gp.permissions_path().parent / "studio-policy.json")
        with open(gp.video_policy_path(), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), data)
        self.assertEqual(data, {"version": 1, "videoBlocked": True, "note": gp.PLAIN_VIDEO_NOTE, "sandbox": "plain"})

    def test_unreadable_permissions_file_keeps_every_studio_switch_off(self):
        self.write({"version": 1, "defaults": {"features": {f: True for f in gp.STUDIO_FEATURES}},
                    "dm": {"who": "everyone", "features": {f: True for f in gp.STUDIO_FEATURES}}})
        with patch.object(gp.Path, "read_text", side_effect=PermissionError(13, "Permission denied")), \
                self.assertLogs(gp.logger, level="ERROR"):
            for thread, is_group in ((GROUP_A, True), (MEMBER, False)):
                self.assertEqual(gp.studio_settings(MEMBER, thread, is_group)["features"],
                                 {f: False for f in gp.STUDIO_FEATURES})

    def test_windows_policy_forces_video_off_whatever_the_file_says(self):
        self.write({"version": 1, "defaults": {"features": {"studioVideo": True, "studioSlides": True}},
                    "dm": {"features": {"studioVideo": True}}})
        with patch.object(gp, "VIDEO_BLOCKED", True):
            for thread, is_group in ((GROUP_A, True), (MEMBER, False)):
                rules = gp.studio_settings(MEMBER, thread, is_group)["features"]
                self.assertFalse(rules["studioVideo"])
                self.assertEqual(rules["studioSlides"], is_group)

    def test_missing_file_corrupt_file_and_missing_keys_keep_every_studio_switch_off(self):
        for content in (None, "{hỏng", {"version": 1, "defaults": {"features": {"web": False}}, "groups": {}}):
            if content is not None:
                self.write(content)
            for is_group, thread in ((True, GROUP_A), (False, MEMBER)):
                rules = gp.studio_settings(MEMBER, thread, is_group)
                self.assertEqual(rules["features"], {f: False for f in gp.STUDIO_FEATURES}, content)
                self.assertEqual(rules["quota"], gp.DEFAULT_STUDIO_QUOTA)

    def test_group_switches_layer_defaults_then_group_and_never_touch_old_switches(self):
        self.write({"version": 1,
                    "defaults": {"features": {"studioSlides": True, "studioDocs": True}},
                    "groups": {GROUP_A: {"features": {"studioDocs": False, "studioVideo": True}, "studioQuota": 5}}})
        a = gp.studio_settings(MEMBER, GROUP_A, True)
        self.assertEqual(a["features"], {"studioSlides": True, "studioDocs": False, "studioExams": False, "studioVideo": True, "studioImage": False, "studioAIVideo": False})
        self.assertEqual(a["quota"], 5)
        b = gp.studio_settings(MEMBER, GROUP_B, True)
        self.assertEqual(b["features"]["studioDocs"], True)
        self.assertEqual(b["quota"], 3)
        self.assertEqual(gp.disabled_features(GROUP_A), [], "nút xưởng không lẫn vào 9 nút cũ")

    def test_dm_switches_layer_dm_then_person_and_group_entries_do_not_leak_into_dm(self):
        self.write({"version": 1,
                    "defaults": {"features": {"studioVideo": True}},
                    "groups": {},
                    "dm": {"who": "everyone", "features": {"studioSlides": True},
                           "people": {MEMBER: {"features": {"studioSlides": False, "studioExams": True}}}}})
        mine = gp.studio_settings(MEMBER, MEMBER, False)["features"]
        self.assertEqual(mine, {"studioSlides": False, "studioDocs": False, "studioExams": True, "studioVideo": False, "studioImage": False, "studioAIVideo": False})
        other = gp.studio_settings(OWNER, OWNER, False)["features"]
        self.assertTrue(other["studioSlides"])
        self.assertFalse(other["studioVideo"], "nút mặc định của nhóm không áp cho nhắn riêng")
        self.assertEqual(gp.dm_disabled_features(MEMBER), [], "nút xưởng không lẫn vào 8 nút nhắn riêng")

    def test_quota_person_beats_group_beats_default_and_garbage_is_ignored(self):
        self.write({"version": 1, "defaults": {}, "groups": {GROUP_A: {"studioQuota": 7}, GROUP_B: {"studioQuota": 99}},
                    "studio": {"quota": 2, "people": {MEMBER: {"name": "Lan", "quota": 10}, "abc": {"quota": 1},
                                                      OWNER: {"quota": True}}}})
        self.assertEqual(gp.studio_settings(MEMBER, GROUP_A, True)["quota"], 10)
        self.assertEqual(gp.studio_settings(MEMBER, MEMBER, False)["quota"], 10)
        self.assertEqual(gp.studio_settings(OWNER, GROUP_A, True)["quota"], 7)
        self.assertEqual(gp.studio_settings(OWNER, GROUP_B, True)["quota"], 2, "99 vượt trần 50 → bỏ")
        self.assertEqual(gp.studio_settings(OWNER, OWNER, False)["quota"], 2, "True không phải số lượt")
        self.write({"version": 1, "studio": {"quota": 0}})
        self.assertEqual(gp.studio_settings(MEMBER, GROUP_A, True)["quota"], 0)

    def test_wrong_types_never_turn_a_switch_on(self):
        self.write({"version": 1, "defaults": {"features": {"studioSlides": "true", "studioDocs": 1}},
                    "groups": {GROUP_A: {"features": ["studioVideo"]}},
                    "dm": {"features": {"studioExams": "yes"}}})
        self.assertFalse(any(gp.studio_settings(MEMBER, GROUP_A, True)["features"].values()))
        self.assertFalse(any(gp.studio_settings(MEMBER, MEMBER, False)["features"].values()))


class AdapterStudioNoteTest(PermissionsFile, AdapterHarness, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        self.enterContext(patch.dict(os.environ, {"ZALO_ALLOWED_USERS": OWNER,
                                                  "ZALO_STUDIO_USAGE_FILE": os.path.join(self.dir, "studio-usage.json")}))

    async def test_member_turn_mentions_the_studio_only_when_a_switch_is_on(self):
        adapter = self.make_adapter()
        await self.say(adapter, "m1", MEMBER, "@Lăng Tiêu làm slide giúp")
        self.assertNotIn("Xưởng tạo sản phẩm", self.handled[-1].channel_context or "")
        self.write({"version": 1, "defaults": {"features": {"studioSlides": True}}, "groups": {}})
        await self.say(adapter, "m2", MEMBER, "@Lăng Tiêu làm slide giúp")
        context = self.handled[-1].channel_context
        self.assertIn("[Xưởng tạo sản phẩm", context)
        self.assertIn("slide (slide PowerPoint)", context)
        self.assertIn("còn 3 lượt", context)
        await self.say(adapter, "m3", OWNER, "@Lăng Tiêu làm slide giúp")
        self.assertNotIn("Xưởng tạo sản phẩm", self.handled[-1].channel_context or "")


class ToolsOffTest(PermissionsFile, unittest.TestCase):
    """Giai đoạn 7B (spec §18.6): trang Công cụ tắt riêng từng công cụ với người không phải chủ nhân."""

    def setUp(self):
        super().setUp()
        self.addCleanup(zalo_tools.bind_turn, None)

    def turn(self, *, owner=False, group=True):
        zalo_tools.bind_turn({"sender_uid": OWNER if owner else MEMBER, "thread_id": GROUP_A if group else MEMBER,
                              "is_group": group, "is_owner": owner, "text": ""})

    def test_tool_off_blocks_members_in_groups_and_dm_but_never_owner(self):
        self.write({"version": 1, "defaults": {}, "groups": {}, "tools": {"off": ["zalo_pdf", "BAD NAME", 5]}})
        self.assertTrue(gp.tool_off("zalo_pdf"))
        self.assertFalse(gp.tool_off("zalo_make_file"), "cùng nút 'files' nhưng không bị tắt")
        for group in (True, False):
            self.turn(group=group)
            verdict = zalo_tools.guard_member_tool_call("zalo_pdf", {})
            self.assertEqual(verdict["action"], "block")
            self.assertIn("Chủ bot đã tắt công cụ zalo_pdf", verdict["message"])
            self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_make_file", {}))
        self.turn(owner=True)
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_pdf", {}))

    def test_missing_or_broken_tools_section_changes_nothing(self):
        for data in ({"version": 1}, {"version": 1, "tools": "x"}, {"version": 1, "tools": {"off": "zalo_pdf"}}):
            self.write(data)
            self.turn()
            self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_pdf", {}), data)
        self.write("{hỏng")
        self.assertFalse(gp.tool_off("zalo_pdf"))

    def test_tool_off_lookup_error_blocks_nothing_extra(self):
        """Đọc danh sách công cụ tắt lỗi bất ngờ → không chặn thêm (hành vi trước 7B)."""
        self.turn()
        with patch.object(gp, "tool_off", side_effect=RuntimeError("hỏng")):
            self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_pdf", {}))

    def test_manifest_lists_every_tool_with_its_switch(self):
        path = os.path.join(self.dir, "tools-manifest.json")
        zalo_tools.write_tools_manifest(friend_tools=False, path=path)
        with open(path, encoding="utf-8") as fh:
            manifest = json.load(fh)
        rows = {t["name"]: t for t in manifest["tools"]}
        self.assertEqual(len(rows), len(zalo_tools.TOOLS))
        self.assertEqual(rows["zalo_web_search"]["feature"], "web")
        self.assertEqual(rows["zalo_web_search"]["toolset"], zalo_tools.TOOLSET_PUBLIC)
        self.assertEqual(rows["zalo_send_sticker"]["feature"], "always")
        self.assertEqual(rows["zalo_studio"]["feature"], "studio")
        self.assertFalse(rows["zalo_send_friend_request"]["registered"])
        self.assertTrue(all(r["description"] for r in manifest["tools"]))


class ThreadHistoryToolTest(PermissionsFile, unittest.IsolatedAsyncioTestCase):
    """zalo_thread_history (spec §19.5): đúng hội thoại của lượt, chỉ đọc, giới hạn, có nút "history"."""

    def setUp(self):
        super().setUp()
        self.calls = []
        test = self

        class FakeAdapter:
            async def search_history(self, chat_id, **kw):
                test.calls.append((chat_id, kw))
                return {"ok": True, "result": {"messages": [
                    {"ts": 1_759_000_000_000, "senderName": "Cô Lan", "senderUid": "555", "msgType": "share.file",
                     "text": "Báo cáo tháng 9.docx\nhttps://f.zdn.vn/abc"},
                    {"ts": 1_759_000_060_000, "senderName": "Minh", "senderUid": "666", "msgType": "webchat", "text": "ok cô"},
                ]}}

        zalo_tools.set_active_adapter(FakeAdapter())
        self.addCleanup(zalo_tools.clear_active_adapter)
        self.addCleanup(zalo_tools.bind_turn, None)
        zalo_tools._THREAD_HISTORY_QUOTA.clear()

    def turn(self, *, thread=GROUP_A, owner=False, group=True):
        zalo_tools.bind_turn({"sender_uid": OWNER if owner else MEMBER, "thread_id": thread,
                              "is_group": group, "is_owner": owner, "text": ""})

    async def test_reads_only_the_current_thread_even_if_model_names_another(self):
        self.turn()
        out = json.loads(await zalo_tools.zalo_thread_history(
            {"query": "báo cáo", "thread_id": GROUP_B, "days": 999, "limit": 999}))
        self.assertTrue(out["success"])
        chat_id, kw = self.calls[0]
        self.assertEqual(chat_id, GROUP_A)
        self.assertEqual(kw["limit"], 40)
        self.assertEqual(kw["metadata"], {"chat_type": "group"})
        self.assertEqual(out["result"]["days"], 30)
        text = out["result"]["text"]
        self.assertIn("Cô Lan: [tệp] Báo cáo tháng 9.docx", text)
        self.assertNotIn("https://", text)
        self.assertNotIn("555", text)

    async def test_members_are_rate_limited_owner_is_not(self):
        self.turn()
        for _ in range(zalo_tools.THREAD_HISTORY_PER_HOUR):
            self.assertTrue(json.loads(await zalo_tools.zalo_thread_history({}))["success"])
        self.assertFalse(json.loads(await zalo_tools.zalo_thread_history({}))["success"])
        self.turn(owner=True)
        self.assertTrue(json.loads(await zalo_tools.zalo_thread_history({}))["success"])

    def test_history_switch_blocks_members_and_is_public_and_on_by_default(self):
        self.assertIn("zalo_thread_history", zalo_tools._PUBLIC_TOOL_NAMES)
        self.assertEqual(gp.feature_of("zalo_thread_history"), "history")
        self.turn()
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_thread_history", {}))
        self.write({"version": 1, "groups": {GROUP_A: {"features": {"history": False}}}})
        verdict = zalo_tools.guard_member_tool_call("zalo_thread_history", {})
        self.assertEqual(verdict["action"], "block")
        self.assertIn("tra lịch sử trò chuyện", verdict["message"])
        self.turn(owner=True)
        self.assertIsNone(zalo_tools.guard_member_tool_call("zalo_thread_history", {}))
        self.turn(thread=MEMBER, group=False)
        self.write({"version": 1, "dm": {"who": "everyone", "features": {"history": False}}})
        self.assertEqual(zalo_tools.guard_member_tool_call("zalo_thread_history", {})["action"], "block")

    def test_refusal_hint_points_members_to_thread_history_not_owner_tool(self):
        self.turn()
        message = zalo_tools.guard_member_tool_call("terminal", {"command": "ls"})["message"]
        self.assertIn("zalo_thread_history", message)
        self.assertNotIn("zalo_read_history", message)
        self.write({"version": 1, "groups": {GROUP_A: {"features": {"history": False}}}})
        self.assertNotIn("zalo_thread_history", zalo_tools.guard_member_tool_call("terminal", {"command": "ls"})["message"])


class ThreadIdSchemaTests(unittest.TestCase):
    """Công cụ tự lấy hội thoại hiện tại không được bắt buộc `thread_id` trong schema.

    Hermes kiểm tra `required` của công cụ bị hoãn ở cầu `tool_call` TRƯỚC khi vào
    guardrail, nên thiếu tham số ở đó bị lặp vô hạn thay vì dừng sau vài lần.
    """

    SCOPED = {
        "zalo_send_file", "zalo_make_file", "zalo_send_voice", "zalo_send_sticker",
        "zalo_send_link", "zalo_read_history", "zalo_group_members", "zalo_create_reminder",
        "zalo_list_reminders", "zalo_remove_reminder", "zalo_undo",
    }

    def required(self, name):
        schema = next(s for n, _e, s, _h, _t in zalo_tools.TOOLS if n == name)
        return schema["parameters"]["required"]

    def test_tools_scoped_to_current_thread_do_not_require_thread_id(self):
        for name in self.SCOPED:
            self.assertNotIn("thread_id", self.required(name), name)

    def test_other_required_arguments_stay(self):
        self.assertEqual(self.required("zalo_make_file"), ["format", "title"])
        self.assertEqual(self.required("zalo_create_reminder"), ["title", "start_time"])

    def test_tools_with_no_current_thread_fallback_still_require_it(self):
        for name in ("zalo_pin_conversation", "zalo_mute"):
            self.assertIn("thread_id", self.required(name), name)

    def test_empty_send_file_call_is_a_normal_tool_error(self):
        # Phải là lỗi của chính công cụ để guardrail đếm được và dừng vòng lặp.
        result = json.loads(asyncio.run(zalo_tools.zalo_send_file({})))
        self.assertIn("path", result["error"])


if __name__ == "__main__":
    unittest.main()
