"""Test chuyển PDF sang Word, gộp, tách (pdf_tools.py + công cụ zalo_pdf).

Cần Python trong venv của Hermes có pymupdf và pdf2docx. Chạy: npm run test:py
"""

import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import pymupdf as fitz  # noqa: E402
import plugins  # noqa: E402

# Cùng cách với test_zalo_adapter.py: ưu tiên plugin trong repo hơn bản đã cài.
plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
from plugins.zalo_tools import pdf_tools, tools  # noqa: E402

GROUP = "g1"
FONT = next((f for f in (r"C:\Windows\Fonts\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
             if os.path.exists(f)), None)


def run(coro):
    return asyncio.run(coro)


def make_pdf(path, pages=3, text="Kế hoạch hoạt động Đoàn trường tháng 10", scanned=False, password=None):
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page()
        if scanned:
            page.draw_rect(fitz.Rect(50, 50, 300, 300), color=(0, 0, 0), fill=(0.5, 0.5, 0.5))
        elif FONT:
            page.insert_font(fontname="vn", fontfile=FONT)
            page.insert_text((72, 72), f"{text} — trang {i + 1}", fontname="vn", fontsize=14)
        else:
            page.insert_text((72, 72), f"Page {i + 1}")
    kwargs = {}
    if password:
        kwargs = {"encryption": fitz.PDF_ENCRYPT_AES_256, "owner_pw": password, "user_pw": password}
    doc.save(str(path), **kwargs)
    doc.close()
    return {"name": Path(path).name, "path": str(path), "mime": "application/pdf"}


class PdfToolsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.out = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)
        shutil.rmtree(self.out, ignore_errors=True)

    def pdf(self, name="ke-hoach.pdf", **kw):
        return make_pdf(Path(self.dir, name), **kw)

    def test_pick_pdfs_uses_only_turn_attachments(self):
        a, b = self.pdf("a.pdf"), self.pdf("b.pdf")
        docx = {"name": "x.docx", "path": a["path"].replace("a.pdf", "x.docx"), "mime": "application/msword"}
        self.assertEqual(pdf_tools.pick_pdfs([docx, a, b], []), [a, b])
        self.assertEqual(pdf_tools.pick_pdfs([a, b], [2]), [b])
        with self.assertRaises(pdf_tools.PdfError):
            pdf_tools.pick_pdfs([a, b], [3])
        with self.assertRaises(pdf_tools.PdfError):
            pdf_tools.pick_pdfs([], [])
        missing = {"name": "gone.pdf", "path": str(Path(self.dir, "gone.pdf")), "mime": "application/pdf"}
        with self.assertRaises(pdf_tools.PdfError):
            pdf_tools.pick_pdfs([missing], [])

    def test_parse_pages(self):
        self.assertEqual(pdf_tools.parse_pages("1-3, 5", 10), [0, 1, 2, 4])
        self.assertEqual(pdf_tools.parse_pages("8-", 10), [7, 8, 9])
        self.assertEqual(pdf_tools.parse_pages("-2;2", 10), [0, 1])
        for bad in ("", "0", "11", "5-3", "abc", "1-99"):
            with self.assertRaises(pdf_tools.PdfError, msg=bad):
                pdf_tools.parse_pages(bad, 10)

    @unittest.skipUnless(FONT, "cần font có dấu tiếng Việt")
    def test_to_word_keeps_vietnamese_text(self):
        import docx

        out = pdf_tools.to_word(self.pdf(pages=2), self.out)
        self.assertTrue(out.endswith("ke-hoach.docx"))
        text = "\n".join(p.text for p in docx.Document(out).paragraphs)
        self.assertIn("Kế hoạch hoạt động Đoàn trường", text)

    def test_to_word_refuses_scanned_and_long_files(self):
        with self.assertRaises(pdf_tools.PdfError) as ctx:
            pdf_tools.to_word(self.pdf("scan.pdf", scanned=True), self.out)
        self.assertIn("bản quét", str(ctx.exception))
        with mock.patch.object(pdf_tools, "MAX_PAGES_TO_WORD", 2):
            with self.assertRaises(pdf_tools.PdfError):
                pdf_tools.to_word(self.pdf("dai.pdf", pages=3), self.out)

    def test_password_protected_is_refused(self):
        with self.assertRaises(pdf_tools.PdfError) as ctx:
            pdf_tools.split(self.pdf("khoa.pdf", password="123"), "1", self.out)
        self.assertIn("mật khẩu", str(ctx.exception))

    def test_fake_pdf_is_refused_by_signature(self):
        fake = Path(self.dir, "trang.pdf")
        fake.write_text("<html><body>not a pdf</body></html>", encoding="utf-8")
        with self.assertRaises(pdf_tools.PdfError) as ctx:
            pdf_tools.split({"name": "trang.pdf", "path": str(fake), "mime": "application/pdf"}, "1", self.out)
        self.assertIn("không phải PDF", str(ctx.exception))

    def test_page_count_checked_on_open_for_every_action(self):
        big = self.pdf("dai.pdf", pages=4)
        with mock.patch.object(pdf_tools, "MAX_PAGES_TOTAL", 3):
            for call in (lambda: pdf_tools.split(big, "1", self.out),
                         lambda: pdf_tools.to_word(big, self.out),
                         lambda: pdf_tools.merge([big, big], self.out)):
                with self.assertRaises(pdf_tools.PdfError):
                    call()
            with self.assertRaises(pdf_tools.PdfError):
                pdf_tools.parse_pages("1-", 10)          # tách quá trần cũng bị chặn

    def test_windows_reserved_names_are_prefixed(self):
        self.assertEqual(pdf_tools._stem({"name": "CON.pdf"}), "_CON")
        self.assertEqual(pdf_tools._stem({"name": "nul.tar.pdf"}), "_nul.tar")
        self.assertEqual(pdf_tools._stem({"name": '../a:b*?.pdf'}), "a b")

    def test_merge_and_split(self):
        merged = pdf_tools.merge([self.pdf("a.pdf", pages=2), self.pdf("b.pdf", pages=3)], self.out)
        with fitz.open(merged) as d:
            self.assertEqual(d.page_count, 5)
        with self.assertRaises(pdf_tools.PdfError):
            pdf_tools.merge([self.pdf("c.pdf")], self.out)
        part = pdf_tools.split(self.pdf("d.pdf", pages=6), "2-3, 6", self.out)
        with fitz.open(part) as d:
            self.assertEqual(d.page_count, 3)
            # Font nhúng có thể đọc dấu cách ra NBSP — chuẩn hoá trước khi so.
            self.assertIn("trang 2", d[0].get_text().replace("\xa0", " "))
            self.assertIn("trang 6", d[2].get_text().replace("\xa0", " "))


class ZaloPdfToolTest(unittest.TestCase):
    def setUp(self):
        tools._PDF_QUOTA.clear()
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def turn(self, attachments, **over):
        t = {"sender_uid": "u1", "thread_id": GROUP, "is_group": True, "is_owner": False,
             "text": "chuyển giúp sang word", "attachments": attachments}
        t.update(over)
        return mock.patch.object(tools, "_turn", return_value=t)

    def call(self, **args):
        return json.loads(run(tools.zalo_pdf(args)))

    def test_member_in_dm_is_refused(self):
        with self.turn([], is_group=False):
            self.assertFalse(self.call(action="split", pages="1")["success"])

    def test_no_pdf_in_turn(self):
        with self.turn([]):
            res = self.call(action="to_word")
        self.assertIn("không thấy tệp PDF", res["error"])

    def test_model_supplied_path_is_ignored(self):
        with self.turn([]):
            res = self.call(action="split", pages="1", path=r"E:\Hermes\.env", files=[1])
        self.assertFalse(res["success"])

    def test_several_pdfs_need_a_choice_for_to_word(self):
        a = make_pdf(Path(self.dir, "a.pdf"))
        b = make_pdf(Path(self.dir, "b.pdf"))
        with self.turn([a, b]):
            res = self.call(action="to_word")
        self.assertIn("1) a.pdf", res["error"])

    def test_split_sends_to_current_thread_then_deletes(self):
        a = make_pdf(Path(self.dir, "a.pdf"), pages=4)
        seen = {}

        async def fake_invoke(method, args):
            seen["path"] = args[0]["attachments"][0]
            seen["exists_while_sending"] = os.path.exists(seen["path"])
            seen["thread"] = args[1]
            return tools._ok({"attachment": [{"msgId": 1}]})
        with self.turn([a]), mock.patch.object(tools, "_invoke", fake_invoke):
            res = self.call(action="split", pages="2-3", thread_id="other-group")
        self.assertTrue(res["success"])
        self.assertTrue(seen["exists_while_sending"])
        self.assertEqual(seen["thread"], GROUP)
        self.assertFalse(os.path.exists(seen["path"]))
        self.assertEqual(len(tools._PDF_QUOTA["u1"]), 1)

    def test_quota_per_hour(self):
        tools._PDF_QUOTA["u1"] = [time.time()] * tools.PDF_QUOTA_PER_HOUR
        a = make_pdf(Path(self.dir, "a.pdf"))
        with self.turn([a]), mock.patch.object(tools, "_invoke") as inv:
            res = self.call(action="split", pages="1")
        self.assertIn("mỗi giờ", res["error"])
        inv.assert_not_called()

    def test_bad_page_range_does_not_cost_quota(self):
        a = make_pdf(Path(self.dir, "a.pdf"))
        with self.turn([a]):
            res = self.call(action="split", pages="abc")
        self.assertFalse(res["success"])
        self.assertEqual(tools._PDF_QUOTA.get("u1", []), [])

    def test_busy_lock_refuses_without_cost(self):
        a = make_pdf(Path(self.dir, "a.pdf"))
        self.assertTrue(pdf_tools.LOCK.acquire(blocking=False))
        try:
            with self.turn([a]):
                res = self.call(action="split", pages="1")
        finally:
            pdf_tools.LOCK.release()
        self.assertIn("đang xử lý", res["error"])
        self.assertEqual(tools._PDF_QUOTA.get("u1", []), [])

    def test_sidecar_timeout_keeps_file_and_says_do_not_redo(self):
        a = make_pdf(Path(self.dir, "a.pdf"), pages=2)
        seen = {}

        async def slow_sidecar(method, args):
            seen["path"] = args[0]["attachments"][0]
            return tools._err("Sidecar không phản hồi lệnh sendMessage (quá hạn chờ)")
        with self.turn([a]), mock.patch.object(tools, "_invoke", slow_sidecar), \
                mock.patch("plugins.zalo_tools.media.schedule_cleanup") as later:
            res = self.call(action="split", pages="1")
        self.assertEqual(res["result"]["status"], "unconfirmed")
        later.assert_called_once()
        self.assertTrue(os.path.exists(seen["path"]))
        shutil.rmtree(Path(seen["path"]).parent, ignore_errors=True)
        self.assertFalse(pdf_tools.LOCK.locked())

    def test_worker_errors_come_back_as_messages(self):
        fake = Path(self.dir, "x.pdf")
        fake.write_text("not a pdf", encoding="utf-8")
        with self.turn([{"name": "x.pdf", "path": str(fake), "mime": "application/pdf"}]), \
                mock.patch.object(tools, "_invoke") as inv:
            res = self.call(action="split", pages="1")
        self.assertIn("không phải PDF", res["error"])
        inv.assert_not_called()

    def test_zalo_pdf_is_public(self):
        self.assertIn("zalo_pdf", tools._PUBLIC_TOOL_NAMES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
