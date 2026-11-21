"""Streaming Persian sentence splitter and sanitizer tailored for Cilla Mini."""

from __future__ import annotations

import re

# Common English tech/everyday terms mapped to Persian script so Cilla Mini speaks them instead of dropping them.
LATIN_MAP: dict[str, str] = {
    "ai": "هوش مصنوعی",
    "llm": "مدل زبانی",
    "tts": "تبدیل متن به گفتار",
    "asr": "تشخیص گفتار",
    "api": "ای‌پی‌آی",
    "cpu": "سی‌پی‌یو",
    "gpu": "جی‌پی‌یو",
    "ram": "رم",
    "mac": "مک",
    "macos": "مک‌اواس",
    "iphone": "آیفون",
    "android": "اندروید",
    "windows": "ویندوز",
    "linux": "لینوکس",
    "python": "پایتون",
    "javascript": "جاوااسکریپت",
    "typescript": "تایپ‌اسکریپت",
    "rust": "راست",
    "react": "ری‌اکت",
    "google": "گوگل",
    "apple": "اپل",
    "openai": "اوپن‌ای‌آی",
    "chatgpt": "چت‌جی‌پی‌تی",
    "ollama": "اولاما",
    "whisper": "ویسپر",
    "cilla": "سیلا",
    "github": "گیت‌هاب",
    "telegram": "تلگرام",
    "instagram": "اینستاگرام",
    "youtube": "یوتیوب",
    "whatsapp": "واتساپ",
    "wifi": "وای‌فای",
    "ok": "اوکی",
    "okay": "اوکی",
}

_MARKDOWN_RE = re.compile(r"[*_`~#>]+")
_BULLET_RE = re.compile(r"(?m)^\s*[-•●▪]\s+")
_LATIN_WORD_RE = re.compile(r"\b([A-Za-z][A-Za-z0-9+#.-]*)\b")
_SENTENCE_END_RE = re.compile(r"([.؟!\n]+)\s*")
_PERSIAN_CHAR_RE = re.compile(r"[\u0600-\u06FF]")


def sanitize_for_tts(text: str) -> str:
    """Clean LLM output so Cilla Mini speaks it naturally without dropping key terms."""
    text = _BULLET_RE.sub("", text)
    text = _MARKDOWN_RE.sub("", text)
    text = text.replace("?", "؟").replace(",", "،").replace(";", "؛")

    def _replace_latin(match: re.Match[str]) -> str:
        word = match.group(1)
        mapped = LATIN_MAP.get(word.lower())
        return mapped if mapped is not None else " "

    text = _LATIN_WORD_RE.sub(_replace_latin, text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def has_persian_speech(text: str) -> bool:
    return bool(_PERSIAN_CHAR_RE.search(text))


class PersianSentenceBuffer:
    """Accumulates streamed LLM tokens and yields complete Persian sentences."""

    def __init__(self, max_clause_chars: int = 160) -> None:
        self._buf = ""
        self._max_clause_chars = max_clause_chars

    def push(self, token: str) -> list[str]:
        self._buf += token
        ready: list[str] = []

        while True:
            match = _SENTENCE_END_RE.search(self._buf)
            if match:
                end = match.end()
                chunk = self._buf[:end].strip()
                self._buf = self._buf[end:]
                cleaned = sanitize_for_tts(chunk)
                if cleaned and has_persian_speech(cleaned):
                    ready.append(cleaned)
                continue

            # If a single sentence is getting long, split at the last Persian comma.
            if len(self._buf) >= self._max_clause_chars:
                comma = self._buf.rfind("،")
                if comma > 40:
                    chunk = self._buf[: comma + 1].strip()
                    self._buf = self._buf[comma + 1 :].lstrip()
                    cleaned = sanitize_for_tts(chunk)
                    if cleaned and has_persian_speech(cleaned):
                        ready.append(cleaned)
                    continue
            break

        return ready

    def flush(self) -> list[str]:
        if not self._buf.strip():
            self._buf = ""
            return []
        cleaned = sanitize_for_tts(self._buf)
        self._buf = ""
        return [cleaned] if cleaned and has_persian_speech(cleaned) else []
