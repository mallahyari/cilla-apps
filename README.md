# Cilla Apps

A collection of local-first, privacy-preserving Persian voice applications built with **[Cilla Mini](https://huggingface.co/mehdi-hf/cilla-mini)** (18.2M parameters, 24 kHz Persian TTS running on CPU, Apple Silicon, and in-browser WebAssembly).

## Apps

| App | Runtime | Status | Description |
| --- | --- | --- | --- |
| [`voice-assistant`](./apps/voice-assistant) | Browser WASM + Local Python (`uv`) + Ollama / `llama.cpp` | Ready | 100% offline Persian voice assistant with streaming Cilla Mini TTS, local Whisper ASR, and barge-in. |

## Repository Structure

```text
cilla-apps/
├── apps/                # Individual applications (web, desktop, CLI, extensions)
├── packages/
│   ├── cilla-web/       # Shared browser utilities (phonon-tts loader, Persian text prep)
│   └── cilla-py/        # Shared Python helpers (pocket-tts / Phonon wrappers)
└── docs/                # Shared guides (WASM COOP/COEP headers, model setup)
```

## Model & Licensing

- **Model:** [`mehdi-hf/cilla-mini`](https://huggingface.co/mehdi-hf/cilla-mini) (gated HuggingFace repo; accept the terms on the model page before downloading weights).
- **Model License:** CC BY-NC 4.0 for non-commercial use. Commercial licenses are available at [oncillaai.com/pricing](https://oncillaai.com/pricing/).
- Model weights (`*.safetensors`) and generated audio files are gitignored and downloaded locally when running each app.
