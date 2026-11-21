"""OpenAI-compatible streaming LLM client (works with Ollama and llama-server)."""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator

import httpx

DEFAULT_LLM_BASE_URL = "http://localhost:11434/v1"
DEFAULT_LLM_MODEL = "aya-expanse:8b"

SYSTEM_PROMPT_FA = (
    "تو یک دستیار صوتی فارسی، صمیمی، دقیق و مختصر هستی. "
    "فقط به زبان فارسی روان، طبیعی و معیار پاسخ بده. "
    "متن کاربر از تشخیص گفتار صوتی آمده و ممکن است غلط املایی کوچک یا کلمه‌ی انگلیسی داشته باشد؛ منظور واقعی کاربر را بفهم و پاسخ درست بده. "
    "پاسخ‌هایت باید کوتاه باشند (حداکثر دو یا سه جمله‌ی کوتاه) تا برای خواندن با صدا مناسب باشند. "
    "از هیچ علامت مارک‌داون مثل ستاره، خط تیره، لیست، کد یا ایموجی استفاده نکن. "
    "از حروف لاتین استفاده نکن و نام‌ها و اصطلاحات را به فارسی بنویس (مثلاً پایتون یا گوگل). "
    "از نقطه‌گذاری فارسی مثل نقطه، ویرگول و علامت سؤال استفاده کن."
)


class LocalLLMClient:
    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
    ) -> None:
        self.base_url = (base_url or os.getenv("LLM_BASE_URL", DEFAULT_LLM_BASE_URL)).rstrip("/")
        self.model = model or os.getenv("LLM_MODEL", DEFAULT_LLM_MODEL)

    async def stream_chat(
        self,
        history: list[dict[str, str]],
    ) -> AsyncIterator[str]:
        messages = [{"role": "system", "content": SYSTEM_PROMPT_FA}, *history[-10:]]
        payload: dict = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "temperature": 0.3,
            "max_tokens": 180,
        }
        if "qwen3" in self.model.lower():
            payload["think"] = False
        headers = {"Authorization": "Bearer local"}

        in_think = False
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
                        f"LLM error {response.status_code} ({self.base_url}): {body.decode(errors='ignore')[:300]}"
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
                    delta = choices[0].get("delta") or {}
                    content = delta.get("content")
                    if not content:
                        continue
                    # Strip any <think>...</think> blocks if a server ignores think=False
                    if "<think>" in content:
                        in_think = True
                        content = content.split("<think>", 1)[0]
                    if in_think:
                        if "</think>" in content:
                            in_think = False
                            content = content.split("</think>", 1)[1]
                        else:
                            continue
                    if content:
                        yield content
