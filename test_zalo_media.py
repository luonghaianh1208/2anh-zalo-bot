"""Test đọc tài liệu Google/trang web/video của zalo_tools (media.py + ba công cụ công khai).

Cần Python trong venv của Hermes (lõi Hermes cung cấp tools.url_safety). Chạy: npm run test:py
"""

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import plugins  # noqa: E402

# Cùng cách với test_zalo_adapter.py: ưu tiên plugin trong repo hơn bản đã cài.
plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
from plugins.zalo_tools import media, tools  # noqa: E402

GROUP = "g1"
MEMBER = {"sender_uid": "u1", "thread_id": GROUP, "is_group": True, "is_owner": False}
YT = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
SHEET = "https://docs.google.com/spreadsheets/d/ABC_123/edit#gid=0"


def run(coro):
    return asyncio.run(coro)


def as_member(text="", **extra):
    turn = {**MEMBER, "text": text, **extra}
    return mock.patch.object(tools, "_turn", return_value=turn)


class DownloadIntentTest(unittest.TestCase):
    def test_matches_download_requests(self):
        import unicodedata
        for text in ("tải video này giúp em", "@Lăng Tiêu tai ve cho chi", "download giúp",
                     "gửi file video nhé", "tai video tiktok nay", "lưu video lại",
                     "Tải về https://youtu.be/abc", unicodedata.normalize("NFD", "tải video")):
            self.assertTrue(tools._wants_download(text), text)

    def test_ignores_plain_links_summaries_and_lookalikes(self):
        for text in ("tóm tắt video này", "xem link này đi https://youtu.be/x", "video hay quá",
                     "server quá tải rồi", "tải lên drive giúp", "đọc giúp https://x.com/download/abc",
                     "đọc https://drive.google.com/uc?export=download&id=1"):
            self.assertFalse(tools._wants_download(text), text)


class VideoDownloadGuardTest(unittest.TestCase):
    def setUp(self):
        tools._VIDEO_QUOTA.clear()
        tools._VIDEO_INFO_QUOTA.clear()

    def test_outsider_interjecting_owner_turn_is_treated_as_member(self):
        owner = {**MEMBER, "is_owner": True, "text": "tóm tắt video này"}
        with mock.patch.object(tools, "_turn", return_value=owner), \
                mock.patch.object(tools, "_outsider_spoke_after", return_value=True), \
                mock.patch.object(media, "download_video") as dl:
            res = self._call()
        self.assertFalse(res["success"])
        self.assertIn("chưa yêu cầu tải", res["error"])
        dl.assert_not_called()

    def test_refused_while_another_download_runs(self):
        self.assertTrue(media.DOWNLOAD_LOCK.acquire(blocking=False))
        try:
            with as_member("tải video"), mock.patch.object(media, "download_video") as dl:
                res = self._call()
        finally:
            media.DOWNLOAD_LOCK.release()
        self.assertFalse(res["success"])
        self.assertIn("đang tải", res["error"])
        dl.assert_not_called()
        self.assertEqual(tools._VIDEO_QUOTA.get("u1", []), [])

    def test_video_info_quota_for_members(self):
        import time
        tools._VIDEO_INFO_QUOTA["u1"] = [time.time()] * tools.VIDEO_INFO_QUOTA_PER_HOUR
        with as_member("tóm tắt"), mock.patch.object(media, "video_info") as info:
            res = json.loads(run(tools.zalo_video_info({"url": YT})))
        self.assertFalse(res["success"])
        info.assert_not_called()

    def _call(self, url=YT, **args):
        return json.loads(run(tools.zalo_video_download({"url": url, **args})))

    def test_member_without_download_intent_is_refused(self):
        with as_member("tóm tắt giúp chị video này"), \
                mock.patch.object(media, "download_video") as dl:
            res = self._call()
        self.assertFalse(res["success"])
        self.assertIn("chưa yêu cầu tải", res["error"])
        dl.assert_not_called()

    def test_member_in_dm_is_refused(self):
        with as_member("tải video", is_group=False):
            res = self._call()
        self.assertFalse(res["success"])

    def test_non_video_url_is_refused(self):
        with as_member("tải video"):
            res = self._call(url="http://127.0.0.1:20128/v1/models")
        self.assertFalse(res["success"])
        self.assertIn("chỉ tải được video", res["error"])

    def test_always_sends_to_current_thread_even_if_another_is_asked(self):
        seen = {}
        invoke = mock.AsyncMock(return_value=tools._ok({}))
        with as_member("tải video"), \
                mock.patch.object(media, "download_video", self._fake_download(seen)), \
                mock.patch.object(tools, "_invoke", invoke):
            self._call(thread_id="another-group")
        self.assertEqual(invoke.call_args.args[1][1], GROUP)

    def test_quota_per_hour(self):
        import time
        tools._VIDEO_QUOTA["u1"] = [time.time()] * tools.VIDEO_QUOTA_PER_HOUR
        with as_member("tải video"), mock.patch.object(media, "download_video") as dl:
            res = self._call()
        self.assertFalse(res["success"])
        self.assertIn("mỗi giờ", res["error"])
        dl.assert_not_called()

    def _fake_download(self, seen):
        async def fake(url, workdir, *, max_minutes):
            seen["workdir"], seen["max_minutes"] = workdir, max_minutes
            path = Path(workdir, "clip.mp4")
            path.write_bytes(b"x")
            return str(path)
        return fake

    def test_sends_to_current_thread_then_deletes_file(self):
        seen = {}
        invoke = mock.AsyncMock(return_value=tools._ok({"attachment": [{"msgId": 1}]}))
        with as_member("tải video này"), \
                mock.patch.object(media, "download_video", self._fake_download(seen)), \
                mock.patch.object(tools, "_invoke", invoke):
            res = self._call()
        self.assertTrue(res["success"])
        method, (payload, thread, _kind) = invoke.call_args.args
        self.assertEqual(method, "sendMessage")
        self.assertEqual(thread, GROUP)
        self.assertTrue(payload["attachments"][0].endswith("clip.mp4"))
        self.assertEqual(seen["max_minutes"], media.VIDEO_MAX_MINUTES)
        self.assertFalse(os.path.exists(seen["workdir"]))
        self.assertEqual(len(tools._VIDEO_QUOTA["u1"]), 1)

    def test_owner_has_no_duration_limit(self):
        seen = {}
        invoke = mock.AsyncMock(return_value=tools._ok({}))
        owner = {**MEMBER, "is_owner": True, "text": "lấy clip này"}
        with mock.patch.object(tools, "_turn", return_value=owner), \
                mock.patch.object(media, "download_video", self._fake_download(seen)), \
                mock.patch.object(tools, "_invoke", invoke):
            res = self._call()
        self.assertTrue(res["success"])
        self.assertIsNone(seen["max_minutes"])

    def test_sidecar_timeout_defers_deletion_and_says_do_not_retry(self):
        seen = {}
        invoke = mock.AsyncMock(return_value=tools._err("Sidecar không phản hồi lệnh sendMessage (quá hạn chờ)"))
        with as_member("tải video"), \
                mock.patch.object(media, "download_video", self._fake_download(seen)), \
                mock.patch.object(tools, "_invoke", invoke), \
                mock.patch.object(media, "schedule_cleanup") as later:
            res = self._call()
        self.assertEqual(res["result"]["status"], "unconfirmed")
        self.assertIn("ĐỪNG tải lại", res["result"]["note"])
        later.assert_called_once_with(seen["workdir"])
        self.assertTrue(os.path.exists(seen["workdir"]))
        Path(seen["workdir"], "clip.mp4").unlink()
        os.rmdir(seen["workdir"])
        self.assertEqual(len(tools._VIDEO_QUOTA["u1"]), 1)
        self.assertFalse(media.DOWNLOAD_LOCK.locked())

    def test_failed_download_still_costs_quota_and_releases_lock(self):
        async def failing(url, workdir, *, max_minutes):
            raise media.MediaError("không tải được")
        with as_member("tải video"), mock.patch.object(media, "download_video", failing):
            self._call()
        self.assertEqual(len(tools._VIDEO_QUOTA["u1"]), 1)
        self.assertFalse(media.DOWNLOAD_LOCK.locked())

    def test_download_error_still_deletes_dir(self):
        seen = {}

        async def failing(url, workdir, *, max_minutes):
            seen["workdir"] = workdir
            raise media.MediaError("video dài quá 20 phút")
        with as_member("tải video"), mock.patch.object(media, "download_video", failing):
            res = self._call()
        self.assertFalse(res["success"])
        self.assertIn("20 phút", res["error"])
        self.assertFalse(os.path.exists(seen["workdir"]))


class WebReadRoutingTest(unittest.TestCase):
    def test_google_doc_read_directly_not_via_web_extract(self):
        read = mock.AsyncMock(return_value={"url": SHEET, "content": "a,b", "truncated": False})
        core = mock.AsyncMock()
        with as_member(), mock.patch.object(media, "read_google_doc", read), \
                mock.patch.object(tools, "_core", core):
            res = json.loads(run(tools.zalo_web_read({"url": SHEET})))
        self.assertTrue(res["success"])
        read.assert_awaited_once_with(
            "https://docs.google.com/spreadsheets/d/ABC_123/export?format=csv", SHEET)
        core.assert_not_called()

    def test_private_google_doc_reports_error(self):
        read = mock.AsyncMock(side_effect=media.MediaError("tài liệu chưa bật chia sẻ"))
        with as_member(), mock.patch.object(media, "read_google_doc", read):
            res = json.loads(run(tools.zalo_web_read({"url": SHEET})))
        self.assertFalse(res["success"])
        self.assertIn("chưa bật chia sẻ", res["error"])

    def test_plain_page_uses_web_extract_first(self):
        core = mock.AsyncMock(return_value=json.dumps({"results": [{"content": "hi"}]}))
        with as_member(), mock.patch.object(tools, "_core", core), \
                mock.patch.object(media, "read_web_page") as direct:
            out = run(tools.zalo_web_read({"url": "https://example.com"}))
        self.assertIn("hi", out)
        direct.assert_not_called()

    def test_falls_back_to_direct_fetch_when_web_extract_fails(self):
        core = mock.AsyncMock(return_value=json.dumps({"success": False, "error": "inaccessible"}))
        direct = mock.AsyncMock(return_value={"url": "https://example.com", "content": "ok"})
        with as_member(), mock.patch.object(tools, "_core", core), \
                mock.patch.object(media, "read_web_page", direct):
            res = json.loads(run(tools.zalo_web_read({"url": "https://example.com"})))
        self.assertTrue(res["success"])
        direct.assert_awaited_once_with("https://example.com")

    def test_drive_file_link_keeps_old_web_extract_path(self):
        core = mock.AsyncMock(return_value=json.dumps({"results": [{"content": "pdf text"}]}))
        with as_member(), mock.patch.object(tools, "_core", core), \
                mock.patch.object(media, "read_google_doc") as direct:
            run(tools.zalo_web_read({"url": "https://drive.google.com/file/d/XYZ/view"}))
        direct.assert_not_called()
        self.assertEqual(core.call_args.args[1]["urls"],
                         ["https://drive.google.com/uc?export=download&id=XYZ"])

    def test_internal_addresses_blocked_before_any_fetch(self):
        with as_member(), mock.patch.object(media, "read_web_page") as direct, \
                mock.patch.object(tools, "_core") as core:
            res = json.loads(run(tools.zalo_web_read({"url": "http://127.0.0.1:1933/mcp"})))
        self.assertFalse(res["success"])
        direct.assert_not_called()
        core.assert_not_called()


class MediaHelpersTest(unittest.TestCase):
    def test_is_video_url(self):
        for ok in (YT, "https://youtu.be/abc", "https://vt.tiktok.com/x", "https://www.facebook.com/watch/?v=1"):
            self.assertTrue(media.is_video_url(ok), ok)
        for bad in ("https://evil-youtube.com/x", "http://localhost/youtube.com", "file:///C:/x.mp4",
                    "https://youtube.com.evil.net/", "https://example.com"):
            self.assertFalse(media.is_video_url(bad), bad)

    def test_ytdlp_disables_generic_extractor(self):
        base = media._ytdlp_base()
        self.assertIn("--ignore-config", base)
        self.assertEqual(base[base.index("--use-extractors") + 1], "default,-generic")
        self.assertEqual(base[base.index("--playlist-items") + 1], "1")

    def test_vtt_to_text_dedupes_rolling_captions(self):
        vtt = ("WEBVTT\nKind: captions\n\n00:00:01.000 --> 00:00:03.000\nxin chào\n\n"
               "00:00:03.000 --> 00:00:05.000\nxin chào\ncác bạn &amp; thầy cô\n\n"
               "01:02:03.000 --> 01:02:05.000\n<c>cuối</c>\n")
        self.assertEqual(media.vtt_to_text(vtt), "[00:01] xin chào\n[00:03] các bạn & thầy cô\n[62:03] cuối")

    def test_html_to_text_drops_scripts_keeps_blocks(self):
        raw = ("<html><head><title>Trang</title><script>alert(1)</script></head>"
               "<body><p>Đoạn một</p><div>Đoạn&nbsp;hai</div><style>p{}</style></body></html>").encode()
        title, text = media.html_to_text(raw, "utf-8")
        self.assertEqual(title, "Trang")
        self.assertEqual(text.splitlines(), ["Trang", "Đoạn một", "Đoạn hai"])

    def _page(self, ctype, body=b"a,b\n1,2"):
        return {"final_url": "x", "content_type": ctype, "encoding": "utf-8", "body": body, "truncated": False}

    def test_google_login_page_means_private(self):
        with mock.patch.object(media, "_fetch", mock.AsyncMock(return_value=self._page("text/html"))):
            with self.assertRaises(media.MediaError):
                run(media.read_google_doc("https://docs.google.com/x/export", SHEET))

    def test_google_csv_is_returned(self):
        with mock.patch.object(media, "_fetch", mock.AsyncMock(return_value=self._page("text/csv; charset=utf-8"))):
            got = run(media.read_google_doc("https://docs.google.com/x/export", SHEET))
        self.assertEqual(got["content"], "a,b\n1,2")

    def test_fetch_refuses_unsafe_url(self):
        with self.assertRaises(media.MediaError):
            run(media._fetch("http://127.0.0.1:20128/v1/models"))

    def test_video_info_parses_info_and_prefers_vietnamese_subs(self):
        async def fake_run(args, timeout):
            out = args[args.index("-o") + 1]
            workdir = os.path.dirname(out)
            Path(workdir, "v.info.json").write_text(json.dumps(
                {"title": "Tiêu đề", "uploader": "Kênh", "duration_string": "0:19",
                 "extractor_key": "Youtube", "webpage_url": YT, "description": "mô tả"}), encoding="utf-8")
            Path(workdir, "v.en.vtt").write_text("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n", encoding="utf-8")
            Path(workdir, "v.vi.vtt").write_text("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nxin chào\n", encoding="utf-8")
            return 0, "", ""
        with mock.patch.object(media, "_run_ytdlp", fake_run):
            info = run(media.video_info("https://www.tiktok.com/@a/video/1"))
        self.assertEqual(info["title"], "Tiêu đề")
        self.assertEqual(info["transcript_language"], "vi")
        self.assertEqual(info["transcript"], "[00:01] xin chào")

    def test_video_info_without_subs_warns_not_to_guess(self):
        async def fake_run(args, timeout):
            workdir = os.path.dirname(args[args.index("-o") + 1])
            Path(workdir, "v.info.json").write_text(json.dumps({"title": "t"}), encoding="utf-8")
            return 0, "", ""
        with mock.patch.object(media, "_run_ytdlp", fake_run):
            info = run(media.video_info("https://www.tiktok.com/@a/video/1"))
        self.assertEqual(info["transcript"], "")
        self.assertIn("đừng đoán", info["transcript_note"])

    def test_youtube_skips_ytdlp_subtitles(self):
        seen = {}

        async def fake_run(args, timeout):
            seen["args"] = args
            workdir = os.path.dirname(args[args.index("-o") + 1])
            Path(workdir, "v.info.json").write_text(json.dumps({"title": "t"}), encoding="utf-8")
            return 0, "", ""
        with mock.patch.object(media, "_run_ytdlp", fake_run), \
                mock.patch.object(media, "_youtube_transcript", return_value=("en", "[00:01] hi")):
            info = run(media.video_info(YT))
        self.assertNotIn("--write-subs", seen["args"])
        self.assertEqual(info["transcript"], "[00:01] hi")

SAFE_SRC = "https://142.250.66.78/videoplayback"   # IP công cộng, không cần DNS


def probe(**over):
    info = {"_type": "video", "duration": 60, "url": SAFE_SRC, "filesize": 10 * 1024 * 1024}
    info.update(over)
    return info


class CheckDownloadableTest(unittest.TestCase):
    def _refused(self, info, max_minutes=20):
        with self.assertRaises(media.MediaError) as ctx:
            media.check_downloadable(info, max_minutes)
        return str(ctx.exception)

    def test_accepts_normal_video(self):
        media.check_downloadable(probe(), 20)

    def test_refuses_playlist_or_channel(self):
        self.assertIn("danh sách phát", self._refused(probe(_type="playlist")))

    def test_refuses_livestreams_even_for_owner(self):
        self.assertIn("trực tiếp", self._refused(probe(is_live=True), None))
        self.assertIn("trực tiếp", self._refused(probe(live_status="is_upcoming"), None))

    def test_refuses_unknown_duration_even_for_owner(self):
        self.assertIn("thời lượng", self._refused(probe(duration=None), None))

    def test_refuses_too_long_for_members(self):
        self.assertIn("20 phút", self._refused(probe(duration=1500)))
        media.check_downloadable(probe(duration=1500), None)   # chủ nhân

    def test_refuses_too_big_merged_formats(self):
        big = {"url": SAFE_SRC, "filesize_approx": 200 * 1024 * 1024}
        self.assertIn("MB", self._refused(probe(requested_formats=[big, big])))

    def test_refuses_source_pointing_inside(self):
        bad = {"url": "http://127.0.0.1:20128/v1/models", "filesize": 1}
        self.assertIn("không an toàn", self._refused(probe(requested_formats=[bad])))


class DownloadVideoTest(unittest.TestCase):
    def _run(self, second_stdout, workdir):
        calls = []

        async def fake_run(args, timeout):
            calls.append(args)
            if "-J" in args:
                return 0, json.dumps(probe()), ""
            return 0, second_stdout(workdir), ""
        with mock.patch.object(media, "_run_ytdlp", fake_run):
            path = run(media.download_video(YT, workdir, max_minutes=20))
        return path, calls

    def test_probes_then_downloads_from_saved_info(self):
        workdir = tempfile.mkdtemp()
        try:
            def out(d):
                p = Path(d, "Video tiếng Việt [x].mp4")
                p.write_bytes(b"x")
                return str(p) + "\n"
            path, calls = self._run(out, workdir)
            self.assertTrue(path.endswith("Video tiếng Việt [x].mp4"))
            self.assertIn("--load-info-json", calls[1])
            self.assertNotIn(YT, calls[1])
        finally:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)

    def test_refuses_path_outside_workdir(self):
        workdir = tempfile.mkdtemp()
        outside = Path(tempfile.mkdtemp(), "secret.env")
        outside.write_text("KEY=1")
        try:
            with self.assertRaises(media.MediaError):
                self._run(lambda d: str(outside) + "\n", workdir)
        finally:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)
            shutil.rmtree(outside.parent, ignore_errors=True)

    def test_silent_abort_reports_size(self):
        workdir = tempfile.mkdtemp()
        try:
            with self.assertRaises(media.MediaError) as ctx:
                self._run(lambda d: "", workdir)
            self.assertIn("MB", str(ctx.exception))
        finally:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)


class PublicToolsetTest(unittest.TestCase):
    def test_new_tools_are_public_and_pass_member_guard(self):
        for name in ("zalo_video_info", "zalo_video_download", "zalo_web_read"):
            self.assertIn(name, tools._PUBLIC_TOOL_NAMES)
            self.assertTrue(tools._member_may_call(name, {}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
