#!/usr/bin/env python3
"""Owner-scoped host-relayed narration and HyperFrames video worker."""

from __future__ import annotations

import html
import json
import os
import re
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Mapping

JOBS_ROOT = Path("/opt/data/video-jobs")
RELAY_SOCKET_PATH = Path("/opt/data/video/vivibe-relay.sock")
HYPERFRAMES_BIN = Path("/opt/hermes-video-worker/node_modules/.bin/hyperframes")
FFPROBE_BIN = "ffprobe"
MAX_TITLE_LENGTH = 120
MAX_SCRIPT_LENGTH = 4_000
MAX_NARRATION_CHUNK_LENGTH = 1_200
MAX_AUDIO_BYTES = 50 * 1024 * 1024
POLL_ATTEMPTS = 60
POLL_INTERVAL_SECONDS = 2
REQUEST_TIMEOUT_SECONDS = 20
WORKER_DEADLINE_SECONDS = 300
MAX_AUDIO_DURATION_SECONDS = 62
UNSAFE_TEXT = re.compile(r"[\\/$`;&|<>{}\[\]*()]")
JOB_ID = re.compile(r"^[0-9a-f]{32}$")
URL_IN_TEXT = re.compile(r"(?:https?://|www\.)", re.IGNORECASE)
MAX_PROJECT_EXPORT_ID_LENGTH = 512


def _validate_project_export_id(value: Any) -> str:
    if (not isinstance(value, str) or not 1 <= len(value) <= MAX_PROJECT_EXPORT_ID_LENGTH
            or not value.isprintable() or any(ord(character) <= 32 for character in value)
            or len(value.encode("utf-8")) > MAX_PROJECT_EXPORT_ID_LENGTH):
        raise _fail()
    return value


ASPECTS = {
    "9:16": (720, 1280),
    "1:1": (1080, 1080),
    "16:9": (1280, 720),
}


class VideoJobError(Exception):
    """Expected job failure with no sensitive detail."""



def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _fail()
    return remaining


def _request_timeout(deadline: float) -> float:
    return min(REQUEST_TIMEOUT_SECONDS, _remaining(deadline))


def _fail() -> VideoJobError:
    return VideoJobError("video generation failed")




def _validate_text(value: Any, *, maximum: int) -> str:
    if not isinstance(value, str):
        raise _fail()
    value = value.strip()
    if (not value or len(value) > maximum or URL_IN_TEXT.search(value)
            or UNSAFE_TEXT.search(value) or any(ord(character) < 32 and character not in "\n\t" for character in value)):
        raise _fail()
    return value


def validate_request(raw: Any) -> dict[str, Any]:
    """Accept only exact, fixed-shape worker payloads."""
    if not isinstance(raw, Mapping):
        raise _fail()
    expected = {
        "job_id", "owner_uid", "thread_id", "title", "script", "aspect_ratio", "duration_seconds",
    }
    if set(raw) != expected:
        raise _fail()
    job_id = raw["job_id"]
    if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
        raise _fail()
    owner_uid = raw["owner_uid"]
    thread_id = raw["thread_id"]
    if (not isinstance(owner_uid, str) or not owner_uid or len(owner_uid) > 256
            or not isinstance(thread_id, str) or not thread_id or len(thread_id) > 256):
        raise _fail()
    aspect_ratio = raw["aspect_ratio"]
    duration = raw["duration_seconds"]
    if aspect_ratio not in ASPECTS or isinstance(duration, bool) or not isinstance(duration, int):
        raise _fail()
    if not 5 <= duration <= 60:
        raise _fail()
    return {
        "job_id": job_id,
        "owner_uid": owner_uid,
        "thread_id": thread_id,
        "title": _validate_text(raw["title"], maximum=MAX_TITLE_LENGTH),
        "script": _validate_text(raw["script"], maximum=MAX_SCRIPT_LENGTH),
        "aspect_ratio": aspect_ratio,
        "duration_seconds": duration,
    }


def _job_directory(job_id: str) -> Path:
    return JOBS_ROOT / job_id

def _create_job_directory(job_id: str) -> Path:
    try:
        JOBS_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        root_stat = JOBS_ROOT.lstat()
        if (stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode)
                or stat.S_IMODE(root_stat.st_mode) != 0o700):
            raise _fail()
        directory = _job_directory(job_id)
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            existing = directory.lstat()
            if (stat.S_ISLNK(existing.st_mode) or not stat.S_ISDIR(existing.st_mode)
                    or stat.S_IMODE(existing.st_mode) != 0o700):
                raise _fail()
        return directory
    except OSError:
        raise _fail() from None


def _status_payload(job: Mapping[str, Any], state: str, progress: int) -> dict[str, Any]:
    payload = {
        "job_id": job["job_id"],
        "owner_uid": job["owner_uid"],
        "thread_id": job["thread_id"],
        "state": state,
        "progress": progress,
    }
    if state == "failed":
        payload["error"] = "video generation failed"
    return payload


def _write_status(directory: Path, job: Mapping[str, Any], state: str, progress: int) -> dict[str, Any]:
    if state not in {"queued", "running", "completed", "failed"} or not 0 <= progress <= 100:
        raise _fail()
    status = _status_payload(job, state, progress)
    temporary = directory / ".status.json.tmp"
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(status, output, separators=(",", ":"), ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, directory / "status.json")
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise _fail() from None
    return status


def chunk_narration(script: str) -> list[str]:
    words = script.split()
    chunks: list[str] = []
    current: list[str] = []
    current_length = 0
    for word in words:
        if len(word) > MAX_NARRATION_CHUNK_LENGTH:
            raise _fail()
        needed = len(word) + (1 if current else 0)
        if current and current_length + needed > MAX_NARRATION_CHUNK_LENGTH:
            chunks.append(" ".join(current))
            current = [word]
            current_length = len(word)
        else:
            current.append(word)
            current_length += needed
    if not current:
        raise _fail()
    chunks.append(" ".join(current))
    return chunks


def _safe_relay_socket() -> None:
    try:
        entry = RELAY_SOCKET_PATH.lstat()
    except OSError:
        raise _fail() from None
    if stat.S_ISLNK(entry.st_mode) or not stat.S_ISSOCK(entry.st_mode) or stat.S_IMODE(entry.st_mode) != 0o600:
        raise _fail()


def _relay(request: Mapping[str, Any], deadline: float) -> Mapping[str, Any]:
    try:
        encoded = json.dumps(dict(request), separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
        if len(encoded) > 16 * 1024:
            raise _fail()
        _safe_relay_socket()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(_request_timeout(deadline))
            connection.connect(str(RELAY_SOCKET_PATH))
            connection.sendall(encoded)
            response = bytearray()
            while len(response) <= 16 * 1024:
                part = connection.recv(min(4096, 16 * 1024 + 1 - len(response)))
                if not part:
                    break
                response.extend(part)
                if b"\n" in part:
                    break
        if (not response or len(response) > 16 * 1024 or response.count(b"\n") != 1
                or not response.endswith(b"\n")):
            raise _fail()
        decoded = json.loads(response[:-1].decode("utf-8"))
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
        raise _fail() from None
    if not isinstance(decoded, Mapping) or decoded.get("ok") is not True:
        raise _fail()
    return decoded


def _submit_audio(job_id: str, text: str, deadline: float) -> str:
    result = _relay({"version": 1, "operation": "submit", "job_id": job_id, "text": text}, deadline)
    export_id = result.get("project_export_id")
    if set(result) != {"ok", "project_export_id"}:
        raise _fail()
    return _validate_project_export_id(export_id)


def _wait_for_audio(job_id: str, export_id: str, deadline: float) -> None:
    for _ in range(POLL_ATTEMPTS):
        result = _relay(
            {"version": 1, "operation": "poll", "job_id": job_id, "project_export_id": export_id}, deadline,
        )
        state = result.get("state")
        progress = result.get("progress")
        ready = result.get("ready")
        if (set(result) != {"ok", "state", "progress", "ready"} or not isinstance(state, str)
                or isinstance(progress, bool) or not isinstance(progress, int) or not 0 <= progress <= 100
                or not isinstance(ready, bool)):
            raise _fail()
        if ready:
            return
        if state.lower() in {"failed", "cancelled", "canceled", "error"}:
            raise _fail()
        time.sleep(min(POLL_INTERVAL_SECONDS, _remaining(deadline)))
    raise _fail()


def _download_audio(job_id: str, export_id: str, chunk_index: int, deadline: float) -> Path:
    result = _relay(
        {
            "version": 1,
            "operation": "download",
            "job_id": job_id,
            "project_export_id": export_id,
            "chunk_index": chunk_index,
        },
        deadline,
    )
    if set(result) != {"ok"}:
        raise _fail()
    return _job_directory(job_id) / f"chunk-{chunk_index}.mp3"


def _validate_audio(path: Path, deadline: float) -> None:
    try:
        entry = path.lstat()
        if stat.S_ISLNK(entry.st_mode) or not stat.S_ISREG(entry.st_mode) or entry.st_size > MAX_AUDIO_BYTES:
            raise _fail()
        inspected = subprocess.run(
            [FFPROBE_BIN, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            check=True, timeout=min(30, _remaining(deadline)),
        )
        metadata = json.loads(inspected.stdout)
        streams = metadata.get("streams")
        duration = float(metadata.get("format", {}).get("duration"))
        format_name = str(metadata.get("format", {}).get("format_name") or "")
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError):
        raise _fail() from None
    if (not isinstance(streams, list) or len(streams) != 1 or not isinstance(streams[0], Mapping)
            or streams[0].get("codec_type") != "audio" or streams[0].get("codec_name") not in {"mp3", "aac", "opus", "pcm_s16le"}
            or not any(name in format_name for name in ("mp3", "mpeg", "aac", "ogg", "opus", "wav", "wave"))
            or not 0 < duration <= MAX_AUDIO_DURATION_SECONDS):
        raise _fail()


def _combine_audio(directory: Path, chunk_count: int, deadline: float) -> Path:
    if chunk_count < 1:
        raise _fail()
    manifest = directory / "audio-concat.txt"
    try:
        descriptor = os.open(manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            for index in range(chunk_count):
                output.write(f"file 'chunk-{index}.mp3'\n")
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", "audio-concat.txt", "-c:a", "libmp3lame", "narration.mp3"],
            cwd=directory, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            check=True, timeout=min(60, _remaining(deadline)),
        )
    except (OSError, subprocess.SubprocessError):
        raise _fail() from None
    narration = directory / "narration.mp3"
    if not narration.is_file() or narration.is_symlink():
        raise _fail()
    return narration

def _composition_html(job: Mapping[str, Any]) -> str:
    width, height = ASPECTS[job["aspect_ratio"]]
    duration = job["duration_seconds"]
    title = html.escape(job["title"], quote=True)
    script = html.escape(job["script"], quote=True)
    return f"""<!doctype html>
<html><head><meta charset=\"utf-8\"><style>
html,body{{margin:0;width:{width}px;height:{height}px;overflow:hidden;background:#111827;color:#f9fafb;font-family:Arial,sans-serif}}
main{{height:100%;box-sizing:border-box;padding:8%;display:flex;flex-direction:column;justify-content:center;background:linear-gradient(135deg,#111827,#312e81)}}
h1{{font-size:clamp(42px,6vw,90px);line-height:1.1;margin:0 0 36px}}p{{font-size:clamp(24px,3vw,44px);line-height:1.45;margin:0;white-space:pre-wrap}}
audio{{display:none}}</style></head><body>
<main id=\"owner-video\" data-composition-id=\"owner-video\" data-start=\"0\" data-duration=\"{duration}\" data-width=\"{width}\" data-height=\"{height}\" data-fps=\"30\">
<audio id=\"owner-video-narration\" src=\"./narration.mp3\" preload=\"auto\" data-start=\"0\" data-duration=\"{duration}\" data-track-index=\"10\"></audio>
<section class=\"clip\" data-template=\"owner-video\" data-start=\"0\" data-duration=\"{duration}\" data-track-index=\"2\">
<h1>{title}</h1><p>{script}</p>
</section></main></body></html>"""


def _write_composition(directory: Path, job: Mapping[str, Any]) -> None:
    try:
        index = directory / "index.html"
        descriptor = os.open(index, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(_composition_html(job))
    except OSError:
        raise _fail() from None


def _render(directory: Path, deadline: float) -> Path:
    try:
        subprocess.run(
            [str(HYPERFRAMES_BIN), "render"],
            cwd=directory,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=min(180, _remaining(deadline)),
        )
    except (OSError, subprocess.SubprocessError):
        raise _fail() from None
    rendered = directory / "output.mp4"
    if not rendered.is_file() or rendered.is_symlink():
        raise _fail()
    final = directory / "video.mp4"
    try:
        os.replace(rendered, final)
    except OSError:
        raise _fail() from None
    return final


def _validate_video(path: Path, duration_seconds: int, deadline: float) -> None:
    try:
        inspected = subprocess.run(
            [FFPROBE_BIN, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=True,
            timeout=min(30, _remaining(deadline)),
        )
        metadata = json.loads(inspected.stdout)
        streams = metadata.get("streams")
        duration = float(metadata.get("format", {}).get("duration"))
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError):
        raise _fail() from None
    if (not isinstance(streams, list) or not any(stream.get("codec_type") == "video" for stream in streams if isinstance(stream, Mapping))
            or not any(stream.get("codec_type") == "audio" for stream in streams if isinstance(stream, Mapping))
            or abs(duration - duration_seconds) > 2.0):
        raise _fail()


def run_job(raw: Any) -> dict[str, Any]:
    job = validate_request(raw)
    directory = _create_job_directory(job["job_id"])
    _write_status(directory, job, "queued", 0)
    deadline = time.monotonic() + WORKER_DEADLINE_SECONDS
    try:
        _write_status(directory, job, "running", 5)
        chunks = chunk_narration(job["script"])
        export_ids = [_submit_audio(job["job_id"], chunk, deadline) for chunk in chunks]
        _write_status(directory, job, "running", 45)
        for index, export_id in enumerate(export_ids):
            _wait_for_audio(job["job_id"], export_id, deadline)
            audio = _download_audio(job["job_id"], export_id, index, deadline)
            _validate_audio(audio, deadline)
        _combine_audio(directory, len(export_ids), deadline)
        _write_composition(directory, job)
        _write_status(directory, job, "running", 75)
        _remaining(deadline)
        video = _render(directory, deadline)
        _validate_video(video, job["duration_seconds"], deadline)
        _remaining(deadline)
        return _write_status(directory, job, "completed", 100)
    except Exception:
        return _write_status(directory, job, "failed", 100)


def main() -> int:
    try:
        raw = json.load(sys.stdin)
        result = run_job(raw)
    except Exception:
        result = {"state": "failed", "progress": 100, "error": "video generation failed"}
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 0 if result.get("state") == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
