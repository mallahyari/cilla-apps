# Offline Persian Voice Assistant

A 100% offline, low-latency Persian voice assistant built with:

- **ASR (Speech-to-Text):** [`mehdi-hf/embeddinggemma2-asr-ctc-farsi-v1`](https://huggingface.co/mehdi-hf/embeddinggemma2-asr-ctc-farsi-v1) (`FarsiCTC`, ~100× real-time on Apple MPS)
- **LLM (Brain):** **Ollama** (`aya-expanse:8b`, 5.1 GB, Cohere multilingual with first-class Persian) by default — or **`llama.cpp` (`llama-server`)** via one env var
- **TTS (Voice):** **[Cilla Mini](https://huggingface.co/mehdi-hf/cilla-mini)** (18.2M, 107 MB) streaming inside the browser via `phonon-tts` WebAssembly (~20 ms to first audio)

## Prerequisites

1. **Download Cilla Mini (`phonon/` files)** into `models/cilla-mini`:
   ```bash
   hf download mehdi-hf/cilla-mini --include "phonon/*" --local-dir models/cilla-mini
   ```
2. **Pull a Persian-capable local LLM** in Ollama:
   ```bash
   ollama pull aya-expanse:8b
   ```
   *(Or use `llama.cpp` instead of Ollama — see below.)*
3. **`ffmpeg`** installed (`brew install ffmpeg` on macOS).

## Run Locally

### 1. Start the Python backend (`uv`)
```bash
cd apps/voice-assistant/server
uv sync
uv run python app.py
```

### 2. Start the Web UI (`pnpm`)
In a second terminal from the repo root:
```bash
pnpm install
pnpm --filter @cilla-apps/voice-assistant-web dev
```

Open **http://localhost:5173** in Chrome/Edge/Safari, click **بارگذاری مدل صوتی** (cached in your browser after the first load), and tap the orb or press **Space** to talk!

## Using `llama.cpp` (`llama-server`) instead of Ollama

The server speaks the standard OpenAI-compatible `/v1/chat/completions` streaming API, so you can swap in `llama.cpp` with zero code changes:

```bash
# Terminal 1: start llama-server with a small GGUF model
llama-server -hf ggml-org/gemma-3-1b-it-GGUF:Q4_K_M --port 8080

# Terminal 2: point the backend at llama-server
cd apps/voice-assistant/server
LLM_BASE_URL=http://localhost:8080/v1 LLM_MODEL=gemma-3-1b-it uv run python app.py
```

## Configuration (Environment Variables)

| Variable | Default | Description |
| --- | --- | --- |
| `ASR_MODEL` | `mehdi-hf/embeddinggemma2-asr-ctc-farsi-v1` | HuggingFace repo ID for `FarsiCTC` |
| `ASR_MODEL_DIR` | `models/embeddinggemma2-asr-ctc-farsi-v1` | Local path to downloaded `FarsiCTC` model |
| `LLM_BASE_URL` | `http://localhost:11434/v1` | Any OpenAI-compatible local server (Ollama, `llama-server`, LM Studio) |
| `LLM_MODEL` | `aya-expanse:8b` | Model name served by `LLM_BASE_URL` |
| `CILLA_MODEL_DIR` | `models/cilla-mini/phonon/model` | Path to Cilla Mini's Phonon model directory |
| `PORT` | `8787` | FastAPI backend port |
