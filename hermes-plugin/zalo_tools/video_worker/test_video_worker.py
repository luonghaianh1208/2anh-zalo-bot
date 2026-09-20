import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    "video_worker_under_test", Path(__file__).with_name("video_worker.py")
)
video_worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = video_worker
spec.loader.exec_module(video_worker)

class VideoWorkerTest(unittest.TestCase):
    def setUp(self):
        self.payload = {
            "job_id": "a" * 32,
            "owner_uid": "owner",
            "thread_id": "owner",
            "title": "Launch update",
            "script": "Narration for this launch update.",
            "aspect_ratio": "9:16",
            "duration_seconds": 12,
        }

    def test_rejects_payloads_with_unexpected_or_unsafe_values(self):
        for key, value in (
            ("title", "../../secret"),
            ("script", "https://example.test"),
            ("script", "$(whoami)"),
            ("aspect_ratio", "4:3"),
            ("duration_seconds", 61),
            ("job_id", "A" * 32),
        ):
            with self.subTest(key=key, value=value):
                payload = dict(self.payload)
                payload[key] = value
                with self.assertRaises(video_worker.VideoJobError):
                    video_worker.validate_request(payload)
        payload = dict(self.payload)
        payload["extra"] = "forbidden"
        with self.assertRaises(video_worker.VideoJobError):
            video_worker.validate_request(payload)

    def test_secret_file_must_be_regular_nonsymlink_and_0600(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            secure = root / "secure"
            secure.write_text("key\n", encoding="utf-8")
            secure.chmod(0o600)
            self.assertEqual(video_worker._read_secret(secure), "key")
            insecure = root / "insecure"
            insecure.write_text("key\n", encoding="utf-8")
            insecure.chmod(0o640)
            with self.assertRaises(video_worker.VideoJobError):
                video_worker._read_secret(insecure)
            target = root / "target"
            target.write_text("key\n", encoding="utf-8")
            target.chmod(0o600)
            link = root / "link"
            link.symlink_to(target)
            with self.assertRaises(video_worker.VideoJobError):
                video_worker._read_secret(link)

    def test_accepts_only_secure_precreated_job_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "jobs"
            root.mkdir(mode=0o700)
            directory = root / self.payload["job_id"]
            directory.mkdir(mode=0o700)
            with patch.object(video_worker, "JOBS_ROOT", root):
                self.assertEqual(video_worker._create_job_directory(self.payload["job_id"]), directory)
            insecure = root / ("b" * 32)
            insecure.mkdir(mode=0o700)
            insecure.chmod(0o755)
            with patch.object(video_worker, "JOBS_ROOT", root):
                with self.assertRaises(video_worker.VideoJobError):
                    video_worker._create_job_directory("b" * 32)

    def test_composition_has_fixed_hyperframes_timeline_metadata(self):
        composition = video_worker._composition_html(video_worker.validate_request(self.payload))
        self.assertIn('data-composition-id="owner-video" data-start="0" data-duration="12"', composition)
        self.assertIn('data-width="720" data-height="1280" data-fps="30"', composition)
        self.assertEqual(composition.count('data-start="0" data-duration="12"'), 3)

    def test_lucylab_request_has_exact_method_input_and_bearer_auth(self):
        response = Mock()
        response.status = 200
        response.read.return_value = b'{"result":{"projectExportId":"project"}}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response
        with patch.object(video_worker, "build_opener", return_value=opener):
            result = video_worker._rpc(
                "ttsLongText", {"text": "Narration", "userVoiceId": "voice", "speed": 1}, "key", float("inf")
            )
        self.assertEqual(result, {"projectExportId": "project"})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, video_worker.LUCYLAB_ENDPOINT)
        self.assertEqual(request.get_header("Authorization"), "Bearer key")
        self.assertEqual(json.loads(request.data), {
            "method": "ttsLongText",
            "input": {"text": "Narration", "userVoiceId": "voice", "speed": 1},
        })

    def test_poll_rejects_provider_error_and_non_https_result_urls(self):
        with patch.object(video_worker, "_rpc", return_value={"jobId": "job", "state": "completed", "progress": 100, "result": "http://audio.test/x"}):
            with self.assertRaises(video_worker.VideoJobError):
                video_worker._wait_for_audio("project", "key", float("inf"))
        with patch.object(video_worker, "_rpc", return_value={"jobId": "job", "state": "failed", "progress": 0, "result": "https://audio.test/x"}):
            with self.assertRaises(video_worker.VideoJobError):
                video_worker._wait_for_audio("project", "key", float("inf"))
        with patch.object(video_worker.socket, "getaddrinfo", return_value=[(None, None, None, None, ("127.0.0.1", 443))]):
            with self.assertRaises(video_worker.VideoJobError):
                video_worker._audio_url("https://audio.test/x")

    def test_atomic_status_never_contains_secret_or_job_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            job = video_worker.validate_request(self.payload)
            status = video_worker._write_status(directory, job, "failed", 100)
            serialized = (directory / "status.json").read_text(encoding="utf-8")
        self.assertEqual(status["error"], "video generation failed")
        self.assertNotIn("vivibe", serialized)
        self.assertNotIn(str(directory), serialized)
        self.assertNotIn("narration.mp3", serialized)

    def test_render_and_probe_use_fixed_commands_and_fixed_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "output.mp4").write_bytes(b"mp4")
            completed = Mock()
            completed.stdout = json.dumps({
                "streams": [{"codec_type": "video"}, {"codec_type": "audio"}],
                "format": {"duration": "12.0"},
            })
            with patch.object(video_worker.subprocess, "run", return_value=completed) as run:
                output = video_worker._render(directory, float("inf"))
                video_worker._validate_video(output, 12, float("inf"))
        render_command = run.call_args_list[0].args[0]
        probe_command = run.call_args_list[1].args[0]
        self.assertEqual(render_command, [str(video_worker.HYPERFRAMES_BIN), "render"])
        self.assertEqual(output.name, "video.mp4")
        self.assertEqual(probe_command[-1], str(output))


if __name__ == "__main__":
    unittest.main()
