import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch


spec = importlib.util.spec_from_file_location(
    "zalo_tools_under_test", Path(__file__).with_name("tools.py")
)
zalo_tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zalo_tools)


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


if __name__ == "__main__":
    unittest.main()
