"""Local Persian ASR using mehdi-hf/embeddinggemma2-asr-ctc-farsi-v1 (FarsiCTC)."""

from __future__ import annotations

import os
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

# Must be set before torch is imported on macOS Apple Silicon (MPS).
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

IS_APPLE_SILICON = platform.system() == "Darwin" and platform.machine() == "arm64"
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ASR_REPO = "mehdi-hf/embeddinggemma2-asr-ctc-farsi-v1"
DEFAULT_ASR_DIR = REPO_ROOT / "models" / "embeddinggemma2-asr-ctc-farsi-v1"
DEFAULT_WHISPER_MODEL = (
    "mlx-community/whisper-large-v3-turbo" if IS_APPLE_SILICON else "large-v3-turbo"
)


class LocalPersianASR:
    def __init__(self, model_name: str | None = None) -> None:
        self.backend = os.getenv("ASR_BACKEND", "embeddinggemma2-ctc").lower()
        if self.backend == "whisper":
            self.model_name = model_name or os.getenv("ASR_MODEL", DEFAULT_WHISPER_MODEL)
        else:
            self.model_name = model_name or os.getenv("ASR_MODEL", DEFAULT_ASR_REPO)
        self.local_dir = Path(os.getenv("ASR_MODEL_DIR", str(DEFAULT_ASR_DIR))).resolve()
        self._model = None

    def _resolve_model_dir(self) -> str:
        if (self.local_dir / "model.safetensors").is_file() and (
            self.local_dir / "egemma2_probe" / "infer.py"
        ).is_file():
            return str(self.local_dir)

        from huggingface_hub import snapshot_download

        return snapshot_download(self.model_name)

    def load(self) -> None:
        if self._model is not None:
            return
        if self.backend == "whisper":
            if IS_APPLE_SILICON:
                self._model = "mlx-whisper"
            else:
                from faster_whisper import WhisperModel

                self._model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
            return

        model_dir = self._resolve_model_dir()
        if model_dir not in sys.path:
            sys.path.insert(0, model_dir)
        from egemma2_probe.infer import FarsiCTC

        device = os.getenv("ASR_DEVICE") or None
        self._model = FarsiCTC.from_pretrained(model_dir, device=device)
        # Warm up MPS/CPU kernels so the first user utterance runs at full speed (~60 ms).
        self._model.transcribe(np.zeros(16000, dtype=np.float32))

    def _transcribe_array(self, pcm: np.ndarray) -> str:
        if self.backend == "whisper":
            if IS_APPLE_SILICON:
                import mlx_whisper

                result = mlx_whisper.transcribe(
                    pcm,
                    path_or_hf_repo=self.model_name,
                    language="fa",
                    condition_on_previous_text=False,
                )
                return (result.get("text") or "").strip()
            segments, _ = self._model.transcribe(pcm, language="fa", vad_filter=True)
            return " ".join(seg.text.strip() for seg in segments).strip()
        return (self._model.transcribe(pcm) or "").strip()

    def transcribe_pcm16(self, pcm_bytes: bytes) -> tuple[str, int]:
        """Fast path: transcribe raw 16 kHz mono int16 PCM directly in memory (no ffmpeg, no disk)."""
        self.load()
        t0 = time.perf_counter()
        pcm = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
        text = self._transcribe_array(pcm)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        return text, elapsed_ms

    def _to_wav16k(self, audio_bytes: bytes, suffix: str) -> str:
        """Fallback: convert encoded browser audio bytes to 16 kHz mono WAV via ffmpeg."""
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as src:
            src.write(audio_bytes)
            src_path = src.name

        wav_path = src_path + ".wav"
        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-loglevel",
                    "error",
                    "-i",
                    src_path,
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-f",
                    "wav",
                    wav_path,
                ],
                check=True,
                capture_output=True,
            )
            return wav_path
        finally:
            Path(src_path).unlink(missing_ok=True)

    def transcribe(self, audio_bytes: bytes, mime_type: str = "audio/webm") -> tuple[str, int]:
        """Fallback path for encoded audio blobs. Returns (text, elapsed_ms)."""
        self.load()
        suffix = (
            ".wav"
            if "wav" in mime_type
            else ".mp4"
            if "mp4" in mime_type
            else ".ogg"
            if "ogg" in mime_type
            else ".webm"
        )
        wav_path = self._to_wav16k(audio_bytes, suffix)
        t0 = time.perf_counter()
        try:
            text = (self._model.transcribe(wav_path) or "").strip()
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            return text, elapsed_ms
        finally:
            Path(wav_path).unlink(missing_ok=True)
