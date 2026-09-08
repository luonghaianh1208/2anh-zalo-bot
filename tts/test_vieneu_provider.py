import tempfile
import unittest
from pathlib import Path

from vieneu_provider import synthesize_to_wav


class FakeVieNeu:
    def __init__(self):
        self.calls = []

    def infer(self, text, *, voice, speed):
        self.calls.append((text, voice, speed))
        return b"fake-audio"

    def save(self, audio, output_path):
        Path(output_path).write_bytes(b"RIFF-vieneu")


class VieNeuProviderTests(unittest.TestCase):
    def test_uses_vieneu_nano_with_northern_male_voice(self):
        engine = FakeVieNeu()
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "voice.wav"
            backend = synthesize_to_wav(
                "Xin chào Lăng Tiêu",
                output,
                voice="Minh Quân",
                speed=1.0,
                engine_factory=lambda: engine,
            )
            self.assertEqual("vieneu", backend)
            self.assertEqual(
                [("Xin chào Lăng Tiêu", "Minh Quân", 1.0)], engine.calls,
            )
            self.assertEqual(b"RIFF-vieneu", output.read_bytes())

    def test_falls_back_to_edge_when_vieneu_fails(self):
        def broken_engine():
            raise RuntimeError("VieNeu unavailable")

        calls = []

        def edge_fallback(text, output_path, voice, speed):
            calls.append((text, Path(output_path), voice, speed))
            Path(output_path).write_bytes(b"RIFF-edge")

        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "voice.wav"
            backend = synthesize_to_wav(
                "Nội dung dự phòng",
                output,
                voice="Minh Quân",
                speed=1.1,
                engine_factory=broken_engine,
                edge_fallback=edge_fallback,
            )
            self.assertEqual("edge", backend)
            self.assertEqual(
                [("Nội dung dự phòng", output, "vi-VN-NamMinhNeural", 1.1)],
                calls,
            )
            self.assertEqual(b"RIFF-edge", output.read_bytes())


if __name__ == "__main__":
    unittest.main()
