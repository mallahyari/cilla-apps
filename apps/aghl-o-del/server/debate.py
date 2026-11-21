"""Debate director for عقل و دل (Head vs. Heart) using OpenAI-compatible local LLM."""

from __future__ import annotations

import json
import os
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

DEFAULT_LLM_BASE_URL = "http://localhost:11434/v1"
DEFAULT_LLM_MODEL = "aya-expanse:8b"

_MARKDOWN_RE = re.compile(r"[*_`~#>]+")
_BULLET_RE = re.compile(r"(?m)^\s*[-•●▪]\s+")
_PREFIX_RE = re.compile(r"^\s*(دل|عقل)\s*[:：\-—]\s*")
_SENTENCE_END_RE = re.compile(r"([.؟!\n]+)\s*")
_PERSIAN_CHAR_RE = re.compile(r"[\u0600-\u06FF]")


@dataclass(frozen=True)
class Character:
    id: str
    name: str
    voice: str
    system_prompt: str


COMMON_RULES = (
    "فقط به زبان فارسی روان و طبیعی صحبت کن. "
    "خیلی کوتاه و کوبنده حرف بزن: فقط و فقط یک یا حداکثر دو جمله‌ی کوتاه در یک پاراگراف (حداکثر ۲۵ کلمه). "
    "جمله‌ی دوم را حتماً کامل تمام کن و هیچ‌وقت پاراگراف دوم ننویس. "
    "نام خودت را در ابتدای جمله ننویس (مثلاً ننویس «دل:» یا «عقل:»). "
    "از هیچ علامت مارک‌داون، ایموجی، لیست یا حروف انگلیسی استفاده نکن. "
    "از نقطه‌گذاری فارسی مثل نقطه، ویرگول و علامت سؤال استفاده کن."
)

CHARACTERS: dict[str, Character] = {
    "del": Character(
        id="del",
        name="دل",
        voice="parisa",
        system_prompt=(
            "تو شخصیت «دل» هستی؛ احساسی، پرشور، جسور و طرفدار لذت بردن از زندگی و دنبال کردن اشتیاق. "
            "در کنار تو شخصیت «عقل» نشسته و با هم درباره دغدغه‌ی کاربر بحث صمیمی و کمی شوخ‌طبعانه می‌کنید. "
            + COMMON_RULES
        ),
    ),
    "aghl": Character(
        id="aghl",
        name="عقل",
        voice="voice2",
        system_prompt=(
            "تو شخصیت «عقل» هستی؛ آرام، منطقی، واقع‌بین، دوراندیش و کمی طناز. "
            "در کنار تو شخصیت «دل» نشسته و با هم درباره دغدغه‌ی کاربر بحث صمیمی می‌کنید؛ گاهی با لحن مودبانه و بامزه حرف «دل» را نقد می‌کنی. "
            + COMMON_RULES
        ),
    ),
}

# 4-turn lively debate sequence
DEBATE_PLAN: list[tuple[str, str]] = [
    ("del", "واکنش اولیه‌ی پرشور و احساسی به سوال کاربر بده و پیشنهادت را بگو."),
    ("aghl", "به حرف «دل» واکنش منطقی نشان بده و جنبه‌های عملی و ریسک‌ها را به کاربر یادآوری کن."),
    ("del", "با یک استدلال گرم و انسانی جواب «عقل» را بده و بگو چرا گاهی باید ریسک کرد."),
    ("aghl", "جمع‌بندی نهایی و متعادل خودت را کوتاه و قاطع به کاربر بگو."),
]


def sanitize_fa(text: str) -> str:
    text = _PREFIX_RE.sub("", text)
    text = _BULLET_RE.sub("", text)
    text = _MARKDOWN_RE.sub("", text)
    text = text.replace("?", "؟").replace(",", "،").replace(";", "؛")
    text = re.sub(r"[A-Za-z]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


class PersianSentenceBuffer:
    def __init__(self) -> None:
        self._buf = ""

    def push(self, token: str) -> list[str]:
        self._buf += token
        ready: list[str] = []
        while True:
            match = _SENTENCE_END_RE.search(self._buf)
            if not match:
                break
            end = match.end()
            chunk = self._buf[:end].strip()
            self._buf = self._buf[end:]
            cleaned = sanitize_fa(chunk)
            if cleaned and _PERSIAN_CHAR_RE.search(cleaned):
                ready.append(cleaned)
        return ready

    def flush(self) -> list[str]:
        if not self._buf.strip():
            self._buf = ""
            return []
        cleaned = sanitize_fa(self._buf)
        self._buf = ""
        return [cleaned] if cleaned and _PERSIAN_CHAR_RE.search(cleaned) else []


class DebateDirector:
    def __init__(self, base_url: str | None = None, model: str | None = None) -> None:
        self.base_url = (base_url or os.getenv("LLM_BASE_URL", DEFAULT_LLM_BASE_URL)).rstrip("/")
        self.model = model or os.getenv("LLM_MODEL", DEFAULT_LLM_MODEL)

    async def stream_character_line(
        self,
        speaker_id: str,
        stage_cue: str,
        transcript_log: list[dict[str, str]],
    ) -> AsyncIterator[str]:
        char = CHARACTERS[speaker_id]
        # Format shared debate context cleanly for the active character
        context_lines = []
        for entry in transcript_log[-8:]:
            who = entry["speaker"]
            label = "کاربر" if who == "user" else CHARACTERS[who].name
            context_lines.append(f"{label}: {entry['text']}")
        convo_text = "\n".join(context_lines)

        messages = [
            {"role": "system", "content": char.system_prompt},
            {
                "role": "user",
                "content": (
                    f"گفتگوی تا این لحظه:\n{convo_text}\n\n"
                    f"نوبت تو ({char.name}) است. {stage_cue}"
                ),
            },
        ]
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "temperature": 0.55,
            "max_tokens": 220,
        }
        headers = {"Authorization": "Bearer local"}

        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/chat/completions",
                json=payload,
                headers=headers,
            ) as response:
                if response.status_code != 200:
                    body = await response.aread()
                    raise RuntimeError(
                        f"LLM error {response.status_code}: {body.decode(errors='ignore')[:250]}"
                    )
                async for line in response.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    content = (choices[0].get("delta") or {}).get("content")
                    if content:
                        yield content
