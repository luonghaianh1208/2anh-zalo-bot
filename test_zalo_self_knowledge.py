"""Test bot biết tính năng và phiên bản của chính nó (self_knowledge.py). Không gọi mạng.

Chạy: npm run test:py
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import plugins  # noqa: E402

plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
from plugins.zalo_tools import self_knowledge as sk  # noqa: E402

SAMPLE = """# Nhật ký thay đổi

## [2.66.0] — 2026-11-02

### Thêm — Trang Gửi hàng loạt cho chăm sóc khách hàng

- chi tiết không cần đưa vào

### Sửa — Quét mã QR xong dashboard vẫn báo mất kết nối

## [2.65.0] — 2026-10-31

### Thêm — Cảnh báo bot đang đốt tiền model

## [2.64.0] — 2026-10-23
"""


class SelfKnowledgeTest(unittest.TestCase):
    def test_detects_questions_about_the_bot_itself(self):
        for q in ("bản mới đã có gửi tin hàng loạt chưa", "bot có tính năng gửi hàng loạt không?",
                  "phiên bản hiện tại là gì", "v2.66 có gì mới", "dashboard có xem được tiến độ không",
                  "em có hỗ trợ đọc file pdf không"):
            self.assertTrue(sk.about_self(q), q)
        for q in ("soạn thông báo họp chi đoàn", "giá vàng hôm nay", "chào em", "tính năng hoá học của kim loại kiềm", ""):
            self.assertFalse(sk.about_self(q), q)

    def test_reads_versions_and_entry_titles_newest_first(self):
        items = sk.releases(SAMPLE)
        self.assertEqual([v for v, _, _ in items], ["2.66.0", "2.65.0", "2.64.0"])
        self.assertEqual(items[0][2], ["Thêm — Trang Gửi hàng loạt cho chăm sóc khách hàng",
                                       "Sửa — Quét mã QR xong dashboard vẫn báo mất kết nối"])
        self.assertEqual(len(sk.releases(SAMPLE, limit=1)), 1)

    def test_note_names_running_version_and_forbids_guessing(self):
        note = sk.build_note(sk.releases(SAMPLE))
        self.assertIn("Bot đang chạy bản 2.66.0", note)
        self.assertIn("Gửi hàng loạt", note)
        self.assertIn("không tra web", note)
        self.assertIn("không được khẳng định là chưa có", note)
        self.assertIn("2.64.0 (2026-10-23): sửa lỗi nhỏ", note)

    def test_hook_only_on_zalo_and_only_for_self_questions(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "CHANGELOG.md"
            path.write_text(SAMPLE, encoding="utf-8")
            old = sk.CANDIDATES
            sk.CANDIDATES = (Path(d) / "khong-co.md", path)
            try:
                msg = "[Lương Hải Anh] [Người nhắn — Lương Hải Anh. Lời tự khai]\nbản mới đã có gửi tin hàng loạt chưa"
                out = sk.pre_llm_call(platform="zalo", user_message=msg)
                self.assertIn("2.66.0", out["context"])
                self.assertIsNone(sk.pre_llm_call(platform="telegram", user_message=msg))
                self.assertIsNone(sk.pre_llm_call(platform="zalo", user_message="soạn giáo án bài 9"))
            finally:
                sk.CANDIDATES = old

    def test_missing_changelog_does_nothing(self):
        old = sk.CANDIDATES
        sk.CANDIDATES = (Path(tempfile.gettempdir()) / "khong-co-tep-nay.md",)
        try:
            self.assertIsNone(sk.pre_llm_call(platform="zalo", user_message="bản mới có gì"))
        finally:
            sk.CANDIDATES = old

    def test_real_changelog_parses(self):
        items = sk.load((Path(ROOT) / "CHANGELOG.md",))
        self.assertTrue(items)
        self.assertRegex(items[0][0], r"^\d+\.\d+\.\d+$")


if __name__ == "__main__":
    unittest.main()
