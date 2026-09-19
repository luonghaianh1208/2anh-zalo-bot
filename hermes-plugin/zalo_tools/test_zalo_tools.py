import importlib.util
import sys
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import AsyncMock, patch


spec = importlib.util.spec_from_file_location(
    "zalo_tools_under_test", Path(__file__).with_name("tools.py")
)
zalo_tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zalo_tools)


class FakeToolContext:
    def __init__(self):
        self.handlers = {}

    def register_tool(self, **kwargs):
        self.handlers[kwargs["name"]] = kwargs["handler"]


class ZaloFindUserTest(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_display_names_with_tool_guidance(self):
        expected_error = (
            "username phải là tên đăng nhập Zalo, không phải tên hiển thị. "
            "Để tìm UID của một người trong nhóm, dùng zalo_group_members. "
            "Nếu có số điện thoại, truyền vào tham số phone."
        )
        with patch.object(
            zalo_tools, "_invoke", new_callable=AsyncMock,
            return_value='{"success": true, "result": "unexpected lookup"}',
        ) as invoke:
            for username in (
                "Nguyen Van An", "Nguyen\tAn", "nhathuy123 ",
                "Hồng", "Đan", "ĐẶNG", "Ho\u0302\u0300ng",
            ):
                with self.subTest(username=username):
                    result = json.loads(await zalo_tools.zalo_find_user({"username": username}))
                    self.assertEqual(result, {"success": False, "error": expected_error})
                    self.assertIn("zalo_group_members", result["error"])
            invoke.assert_not_awaited()

    async def test_login_name_reaches_invoke_unchanged(self):
        expected = '{"success": true, "result": {"user_id": "9000000000000000001"}}'
        with patch.object(
            zalo_tools, "_invoke", new_callable=AsyncMock, return_value=expected,
        ) as invoke:
            result = await zalo_tools.zalo_find_user({"username": "nhathuy123"})
            self.assertEqual(result, expected)
            invoke.assert_awaited_once_with("findUserByUsername", ["nhathuy123"])

    async def test_phone_takes_precedence_over_display_name(self):
        expected = '{"success": true, "result": {"user_id": "9000000000000000001"}}'
        with patch.object(
            zalo_tools, "_invoke", new_callable=AsyncMock, return_value=expected,
        ) as invoke:
            result = await zalo_tools.zalo_find_user({"phone": "+0000000000", "username": "Nguyen Van An"})
            self.assertEqual(result, expected)
            invoke.assert_awaited_once_with("findUser", ["+0000000000"])


class ZaloGuestGroupTest(unittest.IsolatedAsyncioTestCase):
    OWNER = "owner"

    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.zalo_dir = Path(self.directory.name) / "hermes" / "zalo"
        self.zalo_dir.mkdir(parents=True)
        self.groups_path = self.zalo_dir / "guest-groups.json"
        self.groups_path.write_text(
            json.dumps({"version": 1, "guestGroups": ["group-a"]}), encoding="utf-8"
        )
        self.environment = patch.dict(os.environ, {"ZALO_GUEST_GROUPS_FILE": str(self.groups_path)})
        self.environment.start()
        context = FakeToolContext()
        zalo_tools.register_tools(context)
        self.grant_group = context.handlers["zalo_grant_guest_group"]
        self.revoke_group = context.handlers["zalo_revoke_guest_group"]

    async def asyncTearDown(self):
        zalo_tools.bind_turn(None)
        self.environment.stop()
        self.directory.cleanup()

    def owner_dm(self):
        zalo_tools.set_turn_context(sender_uid=self.OWNER, thread_id="dm", is_group=False, is_owner=True)

    async def test_owner_dm_updates_only_group_source_atomically(self):
        self.owner_dm()
        inode = self.groups_path.stat().st_ino
        result = json.loads(await self.grant_group({"group_id": "group-b"}))
        self.assertTrue(result["success"])
        self.assertEqual(
            json.loads(self.groups_path.read_text()),
            {"version": 1, "guestGroups": ["group-a", "group-b"]},
        )
        self.assertNotEqual(self.groups_path.stat().st_ino, inode)
        self.assertEqual(stat.S_IMODE(self.groups_path.stat().st_mode), 0o600)
        result = json.loads(await self.revoke_group({"group_id": "group-a"}))
        self.assertTrue(result["success"])
        self.assertEqual(json.loads(self.groups_path.read_text())["guestGroups"], ["group-b"])

    async def test_final_group_removal_leaves_empty_deny_scope(self):
        self.owner_dm()
        result = json.loads(await self.revoke_group({"group_id": "group-a"}))
        self.assertTrue(result["success"])
        self.assertEqual(json.loads(self.groups_path.read_text())["guestGroups"], [])

    async def test_group_outsider_and_unknown_context_leave_source_unchanged(self):
        before = self.groups_path.read_bytes()
        for turn in (
            {"sender_uid": "outsider", "thread_id": "dm", "is_group": False, "is_owner": False},
            {"sender_uid": self.OWNER, "thread_id": "group-a", "is_group": True, "is_owner": True},
            None,
        ):
            if turn is None:
                zalo_tools.bind_turn(None)
            else:
                zalo_tools.set_turn_context(**turn)
            result = json.loads(await self.grant_group({"group_id": "group-b"}))
            self.assertFalse(result["success"])
            self.assertEqual(self.groups_path.read_bytes(), before)

    async def test_invalid_identifier_leaves_source_unchanged(self):
        self.owner_dm()
        before = self.groups_path.read_bytes()
        result = json.loads(await self.grant_group({"group_id": "group id"}))
        self.assertFalse(result["success"])
        self.assertEqual(self.groups_path.read_bytes(), before)


class ZaloCoreToolDenyTest(unittest.TestCase):
    def setUp(self):
        self.turn_token = zalo_tools._TURN.set(None)

    def tearDown(self):
        zalo_tools._TURN.reset(self.turn_token)

    def test_every_zalo_role_denies_generic_core_tools(self):
        for turn in (
            {"sender_uid": "guest", "thread_id": "group", "is_group": True, "is_owner": False},
            {"sender_uid": "owner", "thread_id": "dm", "is_group": False, "is_owner": True},
        ):
            zalo_tools.bind_turn(turn)
            for tool_name in zalo_tools.ZALO_DENIED_CORE_TOOLS:
                with self.subTest(role=turn["sender_uid"], tool_name=tool_name):
                    verdict = zalo_tools.guard_member_tool_call(tool_name=tool_name)
                    self.assertEqual(verdict, {
                        "action": "block",
                        "message": "Hành động này không khả dụng qua Zalo.",
                    })

    def test_every_zalo_role_denies_unresolved_tool_call(self):
        for turn in (
            {"sender_uid": "guest", "thread_id": "group", "is_group": True, "is_owner": False},
            {"sender_uid": "owner", "thread_id": "dm", "is_group": False, "is_owner": True},
        ):
            with self.subTest(role=turn["sender_uid"]), \
                    patch.dict(sys.modules, {"tools.tool_search": None}):
                zalo_tools.bind_turn(turn)
                verdict = zalo_tools.guard_member_tool_call(tool_name="tool_call", args={})
                self.assertEqual(verdict, {
                    "action": "block",
                    "message": "Hành động này không khả dụng qua Zalo.",
                })

    def test_owner_retains_narrow_guest_group_lifecycle_tools(self):
        zalo_tools.bind_turn({
            "sender_uid": "owner", "thread_id": "dm", "is_group": False, "is_owner": True,
        })
        self.assertIsNone(zalo_tools.guard_member_tool_call(tool_name="zalo_grant_guest_group"))
        self.assertIsNone(zalo_tools.guard_member_tool_call(tool_name="zalo_revoke_guest_group"))
if __name__ == "__main__":
    unittest.main()
