import importlib.util
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


class ZaloGuestGrantTest(unittest.IsolatedAsyncioTestCase):
    OWNER_UID = "9000000000000000001"
    ENV_GUEST_UID = "9000000000000000002"
    FILE_GUEST_UID = "9000000000000000003"
    NEW_GUEST_UID = "9000000000000000004"
    GROUP_UID = "9000000000000000005"

    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.data_root = Path(self.directory.name)
        self.zalo_dir = self.data_root / "hermes" / "zalo"
        self.zalo_dir.mkdir(parents=True)
        self.guests_path = self.zalo_dir / "guests.json"
        self.roster_path = self.zalo_dir / "roster.json"
        self.log_path = self.zalo_dir / "guest-grants.log"
        self.guests_path.write_text(
            json.dumps({"version": 1, "guests": [self.FILE_GUEST_UID]}), encoding="utf-8"
        )
        self.roster_path.write_text(json.dumps({
            "version": 1,
            "owners": [self.OWNER_UID],
            "guests": [self.ENV_GUEST_UID, self.FILE_GUEST_UID],
            "guestGroups": [self.GROUP_UID],
        }), encoding="utf-8")
        self.environment = patch.dict(os.environ, {
            # DATA_ROOT rỗng là đúng điều kiện production: đo trong container
            # hermes ngày 18/09/2026 thì biến này không được đặt. Công cụ phải
            # lấy đường từ ZALO_ROSTER_FILE, nên test đặt DATA_ROOT rỗng để một
            # lần quay lại dùng DATA_ROOT sẽ làm test đỏ ngay.
            "DATA_ROOT": "",
            "ZALO_ROSTER_FILE": str(self.roster_path),
            "ZALO_ALLOWED_USERS": f" {self.OWNER_UID} ",
            "GATEWAY_ALLOWED_USERS": f" {self.ENV_GUEST_UID} ",
            "ZALO_GUEST_GROUPS": f" {self.GROUP_UID} ",
        })
        self.environment.start()
        context = FakeToolContext()
        zalo_tools.register_tools(context)
        self.grant = context.handlers["zalo_grant_guest"]
        self.revoke = context.handlers["zalo_revoke_guest"]

    async def asyncTearDown(self):
        zalo_tools.bind_turn(None)
        self.environment.stop()
        self.directory.cleanup()

    def set_turn(self, *, is_owner=True, is_group=False):
        zalo_tools.set_turn_context(
            sender_uid=self.OWNER_UID if is_owner else "9000000000000000006",
            thread_id=self.GROUP_UID if is_group else "9000000000000000007",
            is_group=is_group,
            is_owner=is_owner,
        )

    def guest_data(self):
        return json.loads(self.guests_path.read_text(encoding="utf-8"))

    async def test_registered_tools_refuse_non_owner_and_owner_in_group(self):
        entries = {name: toolset for name, _emoji, _schema, _handler, toolset in zalo_tools.TOOLS}
        self.assertEqual(entries["zalo_grant_guest"], zalo_tools.TOOLSET_OWNER)
        self.assertEqual(entries["zalo_revoke_guest"], zalo_tools.TOOLSET_OWNER)

        self.set_turn(is_owner=False)
        non_owner = json.loads(await self.grant({"user_id": self.NEW_GUEST_UID}))
        self.assertEqual(non_owner, {"success": False, "error": "công cụ này chỉ chủ nhân dùng được"})

        self.set_turn(is_group=True)
        in_group = json.loads(await self.grant({"user_id": self.NEW_GUEST_UID}))
        self.assertEqual(in_group, {
            "success": False,
            "error": "việc này chỉ làm được khi nhắn riêng với mình, không làm trong nhóm",
        })

    async def test_refuses_owner_uid_from_roster(self):
        self.set_turn()
        result = json.loads(await self.grant({"user_id": self.OWNER_UID}))
        self.assertEqual(result, {
            "success": False,
            "error": f"UID {self.OWNER_UID} là chủ nhân trong roster, không thể cấp quyền khách",
        })
        self.assertEqual(self.guest_data()["guests"], [self.FILE_GUEST_UID])

    async def test_grant_then_revoke_restores_guests_writes_modes_and_audits_each_operation(self):
        self.set_turn()
        before = self.guest_data()
        granted = json.loads(await self.grant({"user_id": self.NEW_GUEST_UID}))
        self.assertEqual(granted["result"]["user_id"], self.NEW_GUEST_UID)
        self.assertEqual(granted["result"]["action"], "granted")
        self.assertIn(self.NEW_GUEST_UID, self.guest_data()["guests"])
        self.assertEqual(stat.S_IMODE(self.guests_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.roster_path.stat().st_mode), 0o600)
        grant_lines = self.log_path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(grant_lines), 1)
        self.assertRegex(grant_lines[0], rf"\bgrant {self.NEW_GUEST_UID}$")

        revoked = json.loads(await self.revoke({"user_id": self.NEW_GUEST_UID}))
        self.assertEqual(revoked["result"]["user_id"], self.NEW_GUEST_UID)
        self.assertEqual(revoked["result"]["action"], "revoked")
        self.assertEqual(self.guest_data(), before)
        revoke_lines = self.log_path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(revoke_lines), 2)
        self.assertRegex(revoke_lines[-1], rf"\brevoke {self.NEW_GUEST_UID}$")

    async def test_tool_and_sync_script_produce_the_same_roster(self):
        env_file = self.data_root / "hermes" / ".env"
        env_file.write_text(
            "\n".join([
                f"ZALO_ALLOWED_USERS= {self.OWNER_UID} ",
                f"GATEWAY_ALLOWED_USERS= {self.ENV_GUEST_UID} ",
                f"ZALO_GUEST_GROUPS= {self.GROUP_UID} ",
                "",
            ]),
            encoding="utf-8",
        )
        sync_script = Path(__file__).resolve().parents[3] / "my-ultron" / "deploy" / "sync-zalo-roster.sh"
        subprocess.run(["bash", str(sync_script), str(self.data_root)], check=True, capture_output=True, text=True)

        self.set_turn()
        await self.grant({"user_id": self.NEW_GUEST_UID})
        tool_roster = self.roster_path.read_text(encoding="utf-8")
        subprocess.run(["bash", str(sync_script), str(self.data_root)], check=True, capture_output=True, text=True)
        script_roster = self.roster_path.read_text(encoding="utf-8")
        self.assertEqual(tool_roster, script_roster)


    async def test_roster_write_failure_restores_guest_source(self):
        self.set_turn()
        before_guests = self.guests_path.read_text(encoding="utf-8")
        before_roster = self.roster_path.read_text(encoding="utf-8")
        write_json = zalo_tools._write_json_atomic

        def fail_roster_write(path, data):
            if path == self.roster_path:
                raise OSError("injected roster write failure")
            write_json(path, data)

        with patch.object(zalo_tools, "_write_json_atomic", side_effect=fail_roster_write):
            result = json.loads(await self.grant({"user_id": self.NEW_GUEST_UID}))

        self.assertFalse(result["success"])
        self.assertEqual(self.guests_path.read_text(encoding="utf-8"), before_guests)
        self.assertEqual(self.roster_path.read_text(encoding="utf-8"), before_roster)

    async def test_audit_failure_reports_live_access_truthfully(self):
        self.set_turn()
        with patch.object(zalo_tools, "_append_guest_grant_log", side_effect=OSError("injected audit failure")):
            result = json.loads(await self.grant({"user_id": self.NEW_GUEST_UID}))

        self.assertTrue(result["success"])
        self.assertIn("nhật ký", result["result"]["warning"])
        self.assertIn(self.NEW_GUEST_UID, self.guest_data()["guests"])
        roster = json.loads(self.roster_path.read_text(encoding="utf-8"))
        self.assertIn(self.NEW_GUEST_UID, roster["guests"])

    async def test_rejects_non_string_or_multiline_guest_ids(self):
        self.set_turn()
        before_guests = self.guests_path.read_text(encoding="utf-8")
        before_roster = self.roster_path.read_text(encoding="utf-8")

        for user_id in (9000000000000000004, "9000000000000000004\nforged grant"):
            with self.subTest(user_id=user_id):
                result = json.loads(await self.grant({"user_id": user_id}))
                self.assertFalse(result["success"])
                self.assertIn("UID Zalo dạng chuỗi", result["error"])

        self.assertEqual(self.guests_path.read_text(encoding="utf-8"), before_guests)
        self.assertEqual(self.roster_path.read_text(encoding="utf-8"), before_roster)
        self.assertFalse(self.log_path.exists())

if __name__ == "__main__":
    unittest.main()
