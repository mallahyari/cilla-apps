"""FastAPI WebSocket server for عقل و دل (Head vs. Heart) Persian debate app."""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from asr import LocalPersianASR
from debate import CHARACTERS, DEBATE_PLAN, DebateDirector, PersianSentenceBuffer

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MODEL_DIR = REPO_ROOT / "models" / "cilla-mini" / "phonon" / "model"
MODEL_DIR = Path(os.getenv("CILLA_MODEL_DIR", str(DEFAULT_MODEL_DIR))).resolve()

asr = LocalPersianASR()
director = DebateDirector()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await asyncio.to_thread(asr.load)
    yield


app = FastAPI(title="عقل و دل — Cilla Mini Persian Debate", lifespan=lifespan)
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
        "llm_base_url": director.base_url,
        "llm_model": director.model,
        "tts_model_ready": weights_ok,
        "voices": voices,
    }


@app.api_route("/model/{file_path:path}", methods=["GET", "HEAD"])
async def serve_model_file(file_path: str):
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


@app.websocket("/ws/debate")
async def ws_debate(ws: WebSocket) -> None:
    await ws.accept()
    transcript_log: list[dict[str, str]] = []
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

    async def run_debate(user_text: str, round_id: int) -> None:
        transcript_log.append({"speaker": "user", "text": user_text})
        try:
            for turn_idx, (speaker_id, cue) in enumerate(DEBATE_PLAN):
                char = CHARACTERS[speaker_id]
                await ws.send_json(
                    {
                        "type": "turn_start",
                        "roundId": round_id,
                        "turnIdx": turn_idx,
                        "speaker": speaker_id,
                        "name": char.name,
                        "voice": char.voice,
                    }
                )
                buf = PersianSentenceBuffer()
                pieces: list[str] = []
                t0 = time.perf_counter()

                async for token in director.stream_character_line(
                    speaker_id, cue, transcript_log
                ):
                    pieces.append(token)
                    await ws.send_json(
                        {
                            "type": "token",
                            "roundId": round_id,
                            "turnIdx": turn_idx,
                            "speaker": speaker_id,
                            "text": token,
                        }
                    )
                    for sentence in buf.push(token):
                        await ws.send_json(
                            {
                                "type": "sentence",
                                "roundId": round_id,
                                "turnIdx": turn_idx,
                                "speaker": speaker_id,
                                "voice": char.voice,
                                "text": sentence,
                            }
                        )

                for sentence in buf.flush():
                    await ws.send_json(
                        {
                            "type": "sentence",
                            "roundId": round_id,
                            "turnIdx": turn_idx,
                            "speaker": speaker_id,
                            "voice": char.voice,
                            "text": sentence,
                        }
                    )

                full_line = "".join(pieces).strip()
                if full_line:
                    transcript_log.append({"speaker": speaker_id, "text": full_line})

                await ws.send_json(
                    {
                        "type": "turn_done",
                        "roundId": round_id,
                        "turnIdx": turn_idx,
                        "speaker": speaker_id,
                        "ms": int((time.perf_counter() - t0) * 1000),
                    }
                )

            await ws.send_json({"type": "debate_done", "roundId": round_id})
        except asyncio.CancelledError:
            await ws.send_json({"type": "cancelled", "roundId": round_id})
            raise
        except Exception as exc:
            await ws.send_json({"type": "error", "roundId": round_id, "message": str(exc)})

    try:
        while True:
            event = await ws.receive()
            if event.get("type") == "websocket.disconnect":
                break

            # Fast binary PCM16 path: [4-byte uint32 LE roundId][16 kHz mono int16 PCM]
            binary = event.get("bytes")
            if binary is not None:
                if len(binary) <= 4:
                    continue
                round_id = int.from_bytes(binary[:4], "little")
                pcm_bytes = binary[4:]
                await cancel_active()
                await ws.send_json({"type": "status", "roundId": round_id, "stage": "transcribing"})
                try:
                    transcript, asr_ms = await asyncio.to_thread(asr.transcribe_pcm16, pcm_bytes)
                except Exception as exc:
                    await ws.send_json(
                        {"type": "error", "roundId": round_id, "message": f"ASR error: {exc}"}
                    )
                    continue

                if not transcript:
                    await ws.send_json(
                        {"type": "empty_transcript", "roundId": round_id, "asrMs": asr_ms}
                    )
                    continue

                await ws.send_json(
                    {
                        "type": "transcript",
                        "roundId": round_id,
                        "text": transcript,
                        "asrMs": asr_ms,
                    }
                )
                active_task = asyncio.create_task(run_debate(transcript, round_id))
                continue

            raw = event.get("text")
            if not raw:
                continue
            msg = json.loads(raw)
            msg_type = msg.get("type")
            round_id = int(msg.get("roundId", 0))

            if msg_type == "cancel":
                await cancel_active()
                continue

            if msg_type == "clear":
                await cancel_active()
                transcript_log.clear()
                await ws.send_json({"type": "cleared"})
                continue

            if msg_type == "text":
                await cancel_active()
                text = (msg.get("text") or "").strip()
                if not text:
                    continue
                active_task = asyncio.create_task(run_debate(text, round_id))
    except WebSocketDisconnect:
        await cancel_active()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8788")),
        reload=False,
    )
