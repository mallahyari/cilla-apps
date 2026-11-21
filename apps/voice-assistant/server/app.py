"""FastAPI WebSocket server for the Offline Persian Voice Assistant."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from pathlib import Path

from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from asr import LocalPersianASR
from llm import LocalLLMClient
from persian_stream import PersianSentenceBuffer

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MODEL_DIR = REPO_ROOT / "models" / "cilla-mini" / "phonon" / "model"
MODEL_DIR = Path(os.getenv("CILLA_MODEL_DIR", str(DEFAULT_MODEL_DIR))).resolve()

asr = LocalPersianASR()
llm = LocalLLMClient()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await asyncio.to_thread(asr.load)
    yield


app = FastAPI(title="Cilla Offline Persian Voice Assistant", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    weights_ok = (MODEL_DIR / "model.safetensors").is_file()
    voices = (
        sorted(p.stem for p in (MODEL_DIR / "voices").glob("*.safetensors"))
        if (MODEL_DIR / "voices").is_dir()
        else []
    )
    return {
        "ok": True,
        "asr_backend": asr.backend,
        "asr_model": asr.model_name,
        "llm_base_url": llm.base_url,
        "llm_model": llm.model,
        "tts_model_ready": weights_ok,
        "voices": voices,
    }


@app.api_route("/model/{file_path:path}", methods=["GET", "HEAD"])
async def serve_model_file(file_path: str):
    """Serve Cilla Mini Phonon weights/tokenizer/voices with Cross-Origin-Resource-Policy."""
    target = (MODEL_DIR / file_path).resolve()
    if not str(target).startswith(str(MODEL_DIR)) or not target.is_file():
        return JSONResponse({"error": f"Model file not found: {file_path}"}, status_code=404)
    return FileResponse(
        target,
        headers={
            "Cross-Origin-Resource-Policy": "same-origin",
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


@app.websocket("/ws/chat")
async def ws_chat(ws: WebSocket) -> None:
    await ws.accept()
    history: list[dict[str, str]] = []
    active_task: asyncio.Task | None = None

    async def cancel_active() -> None:
        nonlocal active_task
        if active_task and not active_task.done():
            active_task.cancel()
            try:
                await active_task
            except asyncio.CancelledError:
                pass
        active_task = None

    async def run_turn(user_text: str, turn_id: int) -> None:
        history.append({"role": "user", "content": user_text})
        buf = PersianSentenceBuffer()
        full_reply: list[str] = []
        t0 = time.perf_counter()
        first_sentence_ms: int | None = None

        try:
            async for token in llm.stream_chat(history):
                full_reply.append(token)
                await ws.send_json({"type": "token", "turnId": turn_id, "text": token})
                for sentence in buf.push(token):
                    if first_sentence_ms is None:
                        first_sentence_ms = int((time.perf_counter() - t0) * 1000)
                    await ws.send_json(
                        {
                            "type": "sentence",
                            "turnId": turn_id,
                            "text": sentence,
                            "firstSentenceMs": first_sentence_ms,
                        }
                    )

            for sentence in buf.flush():
                if first_sentence_ms is None:
                    first_sentence_ms = int((time.perf_counter() - t0) * 1000)
                await ws.send_json(
                    {
                        "type": "sentence",
                        "turnId": turn_id,
                        "text": sentence,
                        "firstSentenceMs": first_sentence_ms,
                    }
                )

            assistant_text = "".join(full_reply).strip()
            if assistant_text:
                history.append({"role": "assistant", "content": assistant_text})
            await ws.send_json(
                {
                    "type": "done",
                    "turnId": turn_id,
                    "text": assistant_text,
                    "llmTotalMs": int((time.perf_counter() - t0) * 1000),
                }
            )
        except asyncio.CancelledError:
            await ws.send_json({"type": "cancelled", "turnId": turn_id})
            raise
        except Exception as exc:
            await ws.send_json({"type": "error", "turnId": turn_id, "message": str(exc)})

    try:
        while True:
            event = await ws.receive()
            if event.get("type") == "websocket.disconnect":
                break

            # Fast binary path: [4-byte uint32 LE turnId][16 kHz mono int16 PCM]
            binary = event.get("bytes")
            if binary is not None:
                if len(binary) <= 4:
                    continue
                turn_id = int.from_bytes(binary[:4], "little")
                pcm_bytes = binary[4:]
                await cancel_active()
                await ws.send_json({"type": "status", "turnId": turn_id, "stage": "transcribing"})
                try:
                    transcript, asr_ms = await asyncio.to_thread(asr.transcribe_pcm16, pcm_bytes)
                except Exception as exc:
                    await ws.send_json(
                        {"type": "error", "turnId": turn_id, "message": f"ASR error: {exc}"}
                    )
                    continue

                if not transcript:
                    await ws.send_json(
                        {"type": "empty_transcript", "turnId": turn_id, "asrMs": asr_ms}
                    )
                    continue

                await ws.send_json(
                    {
                        "type": "transcript",
                        "turnId": turn_id,
                        "text": transcript,
                        "asrMs": asr_ms,
                    }
                )
                active_task = asyncio.create_task(run_turn(transcript, turn_id))
                continue

            raw = event.get("text")
            if not raw:
                continue
            msg = json.loads(raw)
            msg_type = msg.get("type")
            turn_id = int(msg.get("turnId", 0))

            if msg_type == "cancel":
                await cancel_active()
                continue

            if msg_type == "clear":
                await cancel_active()
                history.clear()
                await ws.send_json({"type": "cleared"})
                continue

            if msg_type == "text":
                await cancel_active()
                text = (msg.get("text") or "").strip()
                if not text:
                    continue
                active_task = asyncio.create_task(run_turn(text, turn_id))
                continue

            if msg_type == "audio":
                await cancel_active()
                b64 = msg.get("data") or ""
                mime = msg.get("mimeType") or "audio/webm"
                if not b64:
                    continue
                await ws.send_json({"type": "status", "turnId": turn_id, "stage": "transcribing"})
                try:
                    audio_bytes = base64.b64decode(b64)
                    transcript, asr_ms = await asyncio.to_thread(asr.transcribe, audio_bytes, mime)
                except Exception as exc:
                    await ws.send_json(
                        {"type": "error", "turnId": turn_id, "message": f"ASR error: {exc}"}
                    )
                    continue

                if not transcript:
                    await ws.send_json(
                        {"type": "empty_transcript", "turnId": turn_id, "asrMs": asr_ms}
                    )
                    continue

                await ws.send_json(
                    {
                        "type": "transcript",
                        "turnId": turn_id,
                        "text": transcript,
                        "asrMs": asr_ms,
                    }
                )
                active_task = asyncio.create_task(run_turn(transcript, turn_id))
    except WebSocketDisconnect:
        await cancel_active()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8787")),
        reload=False,
    )
