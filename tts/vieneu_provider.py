"""Offline Vietnamese TTS provider for Hermes, with an Edge fallback."""

from __future__ import annotations

import argparse
import asyncio
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable


DEFAULT_VIENEU_VOICE = "Minh Quân"
DEFAULT_EDGE_VOICE = "vi-VN-NamMinhNeural"


def _create_vieneu_engine():
    from vieneu import Vieneu

    return Vieneu(mode="v3nano", backend="onnx")


def _edge_rate(speed: float) -> str:
    return f"{round((speed - 1.0) * 100):+d}%"


def _synthesize_edge(text: str, output_path: Path, voice: str, speed: float) -> None:
    import edge_tts

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise FileNotFoundError("ffmpeg is required for the Edge TTS fallback")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmpdir:
        mp3_path = Path(tmpdir) / "edge-fallback.mp3"
        asyncio.run(edge_tts.Communicate(
            text, voice=voice, rate=_edge_rate(speed),
        ).save(str(mp3_path)))
        subprocess.run([
            ffmpeg, "-y", "-loglevel", "error", "-i", str(mp3_path),
            "-ac", "1", "-ar", "24000", str(output_path),
        ], check=True)


def synthesize_to_wav(
    text: str,
    output_path: Path,
    *,
    voice: str = DEFAULT_VIENEU_VOICE,
    speed: float = 1.0,
    engine_factory: Callable = _create_vieneu_engine,
    edge_fallback: Callable = _synthesize_edge,
) -> str:
    """Write speech to *output_path* and return the backend used."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        engine = engine_factory()
        audio = engine.infer(text, voice=voice, speed=speed)
        engine.save(audio, str(output_path))
        if not output_path.exists() or output_path.stat().st_size == 0:
            raise RuntimeError("VieNeu produced no audio")
        return "vieneu"
    except Exception as vieneu_error:
        try:
            edge_fallback(text, output_path, DEFAULT_EDGE_VOICE, speed)
        except Exception as edge_error:
            raise RuntimeError(
                f"VieNeu failed ({vieneu_error}); Edge fallback failed ({edge_error})"
            ) from edge_error
        if not output_path.exists() or output_path.stat().st_size == 0:
            raise RuntimeError("Edge fallback produced no audio") from vieneu_error
        return "edge"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--voice", default=DEFAULT_VIENEU_VOICE)
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()
    text = Path(args.input).read_text(encoding="utf-8").strip()
    if not text:
        parser.error("input text is empty")
    backend = synthesize_to_wav(
        text,
        Path(args.output),
        voice=args.voice,
        speed=max(0.25, min(4.0, args.speed)),
    )
    print(f"backend={backend}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
