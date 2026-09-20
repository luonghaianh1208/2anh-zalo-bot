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

    def test_combine_transcodes_provider_audio_to_canonical_mp3(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "chunk-0.mp3").write_bytes(b"wav-content")

            def fake_run(command, **_kwargs):
                (directory / "narration.mp3").write_bytes(b"mp3-content")
                return Mock()

            with patch.object(video_worker.subprocess, "run", side_effect=fake_run) as run:
                narration = video_worker._combine_audio(directory, 1, float("inf"))
        command = run.call_args.args[0]
        self.assertEqual(narration.name, "narration.mp3")
        self.assertEqual(command[:7], ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i"])
        self.assertEqual(command[-3:], ["-c:a", "libmp3lame", "narration.mp3"])

    def test_validate_audio_accepts_provider_wav_before_normalization(self):
        with tempfile.TemporaryDirectory() as temporary:
            audio = Path(temporary) / "chunk-0.mp3"
            audio.write_bytes(b"wav-content")
            completed = Mock(stdout=json.dumps({
                "streams": [{"codec_type": "audio", "codec_name": "pcm_s16le"}],
                "format": {"format_name": "wav", "duration": "3.6"},
            }))
            with patch.object(video_worker.subprocess, "run", return_value=completed):
                video_worker._validate_audio(audio, float("inf"))

    def test_relay_client_requires_exact_safe_responses(self):
        deadline = float("inf")
        with patch.object(video_worker, "_relay", return_value={"ok": True, "project_export_id": "export"}):
            self.assertEqual(video_worker._submit_audio(self.payload["job_id"], "Narration", deadline), "export")
        with patch.object(video_worker, "_relay", return_value={"ok": True, "state": "completed", "progress": 100, "ready": True}):
            self.assertIsNone(video_worker._wait_for_audio(self.payload["job_id"], "export", deadline))
        with patch.object(video_worker, "_relay", return_value={"ok": True}):
            self.assertEqual(video_worker._download_audio(self.payload["job_id"], "export", 0, deadline).name, "chunk-0.mp3")
        with patch.object(video_worker, "_relay", return_value={"ok": True, "url": "https://provider.test/audio"}):
            with self.assertRaises(video_worker.VideoJobError):
                video_worker._download_audio(self.payload["job_id"], "export", 0, deadline)

    def test_submit_rejects_malformed_relay_export_ids(self):
        deadline = float("inf")
        for export_id in (None, "", "has space", "has\twhitespace", "has\x7fcontrol", "x" * 513, "é" * 257):
            with self.subTest(export_id=repr(export_id)):
                with patch.object(video_worker, "_relay", return_value={"ok": True, "project_export_id": export_id}):
                    with self.assertRaises(video_worker.VideoJobError):
                        video_worker._submit_audio(self.payload["job_id"], "Narration", deadline)

    def test_worker_uses_bounded_relay_sequence_without_provider_or_secret_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "jobs"
            root.mkdir(mode=0o700)
            calls = []

            def relay_call(request, deadline):
                self.assertLessEqual(deadline - video_worker.time.monotonic(), video_worker.WORKER_DEADLINE_SECONDS)
                calls.append(request["operation"])
                if request["operation"] == "submit":
                    return {"ok": True, "project_export_id": "export"}
                if request["operation"] == "poll":
                    return {"ok": True, "state": "completed", "progress": 100, "ready": True}
                (root / self.payload["job_id"] / "chunk-0.mp3").write_bytes(b"mp3")
                return {"ok": True}

            with patch.object(video_worker, "JOBS_ROOT", root), \
                    patch.object(video_worker, "_relay", side_effect=relay_call), \
                    patch.object(video_worker, "_validate_audio"), \
                    patch.object(video_worker, "_combine_audio", return_value=root / self.payload["job_id"] / "narration.mp3"), \
                    patch.object(video_worker, "_write_composition"), \
                    patch.object(video_worker, "_render", return_value=root / self.payload["job_id"] / "video.mp4"), \
                    patch.object(video_worker, "_validate_video"):
                result = video_worker.run_job(self.payload)
        self.assertEqual(result["state"], "completed")
        self.assertEqual(calls, ["submit", "poll", "download"])
        self.assertFalse(hasattr(video_worker, "API_KEY_PATH"))
        self.assertFalse(hasattr(video_worker, "VOICE_ID_PATH"))

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
