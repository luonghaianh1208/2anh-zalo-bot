"""Test skill cho thành viên (member_skills.py, zalo_skill_list/zalo_skill_read). Không gọi mạng.

Chạy: npm run test:py
"""

import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import plugins  # noqa: E402

plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
from plugins.zalo_tools import group_permissions, member_skills as ms, tools  # noqa: E402

SKILL = "---\nname: {name}\ndescription: {desc}\n---\n\n# {name}\n\nHướng dẫn của {name}.\n"


class MemberSkillsTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="zalo-mskill-"))
        self.addCleanup(shutil.rmtree, self.home, True)
        ms._cache.update(key=None, names=[])
        ms._seen.clear()
        self.enterContext(mock.patch.object(ms, "_home", return_value=self.home))
        for rel, name in (("writing/content-giao-duc", "content-giao-duc"), ("ops/tin-nhan-zalo", "tin-nhan-zalo"),
                          ("research/grounded-citations", "grounded-citations")):
            d = self.home / "skills" / rel
            (d / "references").mkdir(parents=True)
            (d / "SKILL.md").write_text(SKILL.format(name=name, desc=f"Mô tả {name}"), encoding="utf-8")
            (d / "references" / "mau.md").write_text("Mẫu bài.", encoding="utf-8")
        (self.home / "bi-mat.md").write_text("khoá bí mật", encoding="utf-8")

    def allow(self, names):
        ms.store_path().parent.mkdir(parents=True, exist_ok=True)
        ms.store_path().write_text(json.dumps({"skills": names}), encoding="utf-8")
        ms._cache.update(key=None)

    def call(self, fn, args):
        return json.loads(asyncio.run(fn(args)))

    def test_only_allowed_and_never_blocked(self):
        self.assertEqual(ms.allowed(), [])
        self.allow(["content-giao-duc", "tin-nhan-zalo", "khong-co", "content-giao-duc"])
        self.assertEqual(ms.allowed(), ["content-giao-duc", "khong-co"])  # tên cấm bị bỏ dù tệp có ghi
        self.assertEqual([r["name"] for r in ms.listing()], ["content-giao-duc"])  # không có trên máy thì không liệt kê
        for name in ("zalo-bot-management", "hermes-agent", "google-workspace", "github-auth", ""):
            self.assertTrue(ms.is_blocked(name), name)
        self.assertFalse(ms.is_blocked("grounded-citations"))

    def test_read_skill_and_linked_file_only_inside_skill(self):
        self.allow(["content-giao-duc"])
        got = ms.read("content-giao-duc")
        self.assertEqual(got["file"], "SKILL.md")
        self.assertIn("Hướng dẫn của content-giao-duc", got["content"])
        self.assertEqual(got["files"], ["SKILL.md", "references/mau.md"])
        self.assertEqual(ms.read("content-giao-duc", "references/mau.md")["content"], "Mẫu bài.")
        for bad in ("../../bi-mat.md", "/etc/passwd", "..\\..\\bi-mat.md"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                ms.read("content-giao-duc", bad)
        with self.assertRaises(ValueError):
            ms.read("grounded-citations")  # có trên máy nhưng chưa mở cho thành viên
        with self.assertRaises(ValueError):
            ms.read("tin-nhan-zalo")

    def test_tools_return_json_errors_instead_of_raising(self):
        self.allow(["grounded-citations"])
        self.assertEqual([r["name"] for r in self.call(tools.zalo_skill_list, {})["result"]["skills"]], ["grounded-citations"])
        ok = self.call(tools.zalo_skill_read, {"name": "grounded-citations"})
        self.assertTrue(ok["success"])
        bad = self.call(tools.zalo_skill_read, {"name": "content-giao-duc"})
        self.assertFalse(bad["success"])
        self.assertIn("không mở cho thành viên", bad["error"])

    def test_note_only_for_members_with_feature_on(self):
        self.allow(["content-giao-duc"])
        member = {"thread_id": "g1", "is_group": True, "sender_uid": "1", "is_owner": False}
        with mock.patch.object(tools, "_turn", return_value=member), \
                mock.patch.object(group_permissions, "disabled_features", return_value=[]):
            first = ms.pre_llm_call(session_id="s", platform="zalo")
            second = ms.pre_llm_call(session_id="s", platform="zalo")
        self.assertIn("content-giao-duc", first["context"])
        self.assertIn("zalo_skill_read", first["context"])
        self.assertNotIn("content-giao-duc", second["context"])  # lượt sau chỉ nhắc một dòng
        with mock.patch.object(tools, "_turn", return_value={**member, "is_owner": True}):
            self.assertIsNone(ms.pre_llm_call(session_id="o", platform="zalo"))  # chủ nhân đã có skill_view
        with mock.patch.object(tools, "_turn", return_value=member), \
                mock.patch.object(group_permissions, "disabled_features", return_value=["kb"]):
            self.assertIsNone(ms.pre_llm_call(session_id="k", platform="zalo"))  # nhóm tắt "kho tài liệu và skill"
        self.assertIsNone(ms.pre_llm_call(session_id="t", platform="telegram"))

    def test_tools_are_public_and_follow_kb_switch(self):
        names = {t[0]: t[4] for t in tools.TOOLS}
        self.assertEqual(names["zalo_skill_list"], tools.TOOLSET_PUBLIC)
        self.assertEqual(names["zalo_skill_read"], tools.TOOLSET_PUBLIC)
        self.assertEqual(group_permissions.feature_of("zalo_skill_read"), "kb")


class BlocklistSyncTest(unittest.TestCase):
    def test_dashboard_and_plugin_block_the_same_skills(self):
        import re
        js = Path(ROOT, "dashboard", "lib", "member-skills.js").read_text(encoding="utf-8")
        prefixes = re.findall(r"'([^']+)'", re.search(r"BLOCKED_PREFIXES = \[(.*?)\]", js, re.S).group(1))
        names = re.findall(r"'([^']+)'", re.search(r"BLOCKED_NAMES = new Set\(\[(.*?)\]\)", js, re.S).group(1))
        self.assertEqual(tuple(prefixes), ms.BLOCKED_PREFIXES)
        self.assertEqual(set(names), set(ms.BLOCKED_NAMES))


if __name__ == "__main__":
    unittest.main()
