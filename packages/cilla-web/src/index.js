/**
 * Reusable browser TTS wrapper for Cilla Mini (phonon-tts WASM + official persian.js).
 */
import { PhononTTS } from "phonon-tts";
import * as P from "./persian.js";

export * as persian from "./persian.js";

const SAMPLE_RATE = 24000;
const MODEL_CACHE = "phonon-tts-v1";

const cat = (...parts) => {
  const total = parts.reduce((n, a) => n + a.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const a of parts) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
};

function loudest(chunk) {
  const win = Math.floor(0.02 * SAMPLE_RATE);
  let maxRms = 0;
  for (let i = 0; i < chunk.length; i += win) {
    let sum = 0;
    const end = Math.min(i + win, chunk.length);
    for (let j = i; j < end; j++) sum += chunk[j] * chunk[j];
    const rms = Math.sqrt(sum / (end - i));
    if (rms > maxRms) maxRms = rms;
  }
  return maxRms;
}

export async function isModelCached(modelBaseUrl = "/model") {
  try {
    return !!(await caches.match(`${modelBaseUrl}/model.safetensors`, {
      cacheName: MODEL_CACHE,
    }));
  } catch {
    return false;
  }
}

export class CillaBrowserTTS {
  constructor({ modelBaseUrl = "/model", voices = ["parisa", "voice1", "voice2"], defaultVoice = "parisa" } = {}) {
    this.modelBaseUrl = modelBaseUrl.replace(/\/$/, "");
    this.voiceNames = voices;
    this.defaultVoice = defaultVoice;
    this.model = null;
    this.tokenCounter = null;
    this.audioCtx = null;
    this.analyser = null;
    this.freqData = null;
    this.activeSources = new Set();
    this.startTimers = new Set();
    this.nextPlayTime = 0;
    this.queue = [];
    this.processing = false;
    this.generationId = 0;
    this.activeStream = null;
    this.speaking = false;
    this.idleTimer = null;
    this.onSpeakingChange = null;
  }

  get isLoaded() {
    return this.model !== null;
  }

  async load({ onProgress } = {}) {
    if (this.model) return this.model;

    const tokResp = await fetch(`${this.modelBaseUrl}/tokenizer.json`);
    if (!tokResp.ok) throw new Error(`Failed to fetch tokenizer.json (${tokResp.status})`);
    const tokJson = await tokResp.json();
    this.tokenCounter = P.makeTokenCounter(tokJson);

    const voices = {};
    for (const v of this.voiceNames) {
      voices[v] = `${this.modelBaseUrl}/voices/${v}.safetensors`;
    }

    const files = {};
    let fromCache = true;
    this.model = await PhononTTS.load({
      lang: "none",
      quant: "f32",
      device: "cpu",
      threads: "auto",
      model: {
        weights: { f32: `${this.modelBaseUrl}/model.safetensors` },
        tokenizer: `${this.modelBaseUrl}/tokenizer.json`,
        config: `${this.modelBaseUrl}/config.json`,
        voices,
        defaultVoice: this.defaultVoice,
      },
      onProgress: ({ file, loaded, total, cached }) => {
        files[file] = { loaded, total: total || loaded };
        if (!cached) fromCache = false;
        let L = 0;
        let T = 0;
        for (const f of Object.values(files)) {
          L += f.loaded;
          T += f.total;
        }
        onProgress?.({ loaded: L, total: T, ratio: T ? L / T : 0, fromCache });
      },
    });

    return this.model;
  }

  _setSpeaking(val) {
    if (this.speaking === val) return;
    this.speaking = val;
    this.onSpeakingChange?.(val);
  }

  _ensureAudioContext() {
    if (!this.audioCtx || this.audioCtx.state === "closed") {
      // Use the system's native sample rate (e.g. 48 kHz) to avoid macOS CoreAudio conflicts
      // with microphone capture; createBuffer(..., 24000) resamples cleanly in WebAudio.
      this.audioCtx = new AudioContext();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.78;
      this.analyser.connect(this.audioCtx.destination);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.nextPlayTime = this.audioCtx.currentTime + 0.04;
    }
    if (this.audioCtx.state !== "running") {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  /** Returns normalized [0..1] live RMS loudness of Cilla Mini's spoken output. */
  getOutputLevel() {
    if (!this.analyser || !this.freqData || !this.speaking) return 0;
    this.analyser.getByteTimeDomainData(this.freqData);
    let sum = 0;
    for (let i = 0; i < this.freqData.length; i++) {
      const v = (this.freqData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.freqData.length) * 3.2);
  }

  /** Copies live output frequency bins (0..255) into a Uint8Array for visualizers. */
  getOutputFrequencyData(out) {
    if (!this.analyser || !this.speaking) {
      out.fill(0);
      return;
    }
    this.analyser.getByteFrequencyData(out);
  }

  /** Call inside a user click/submit handler so AudioContext is unlocked for later WS responses. */
  unlock() {
    this._ensureAudioContext();
  }

  /** Stop all queued & playing audio immediately (barge-in) while keeping AudioContext unlocked. */
  stop() {
    this.generationId++;
    this.queue = [];
    clearTimeout(this.idleTimer);
    if (this.activeStream) {
      try {
        this.activeStream.cancel();
      } catch {
        // ignore
      }
      this.activeStream = null;
    }
    for (const t of this.startTimers) clearTimeout(t);
    this.startTimers.clear();
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore
      }
    }
    this.activeSources.clear();
    this.nextPlayTime = 0;
    this._setSpeaking(false);
  }

  /** Enqueue a Persian sentence for streaming synthesis & gapless playback. */
  enqueue(text, { voice = this.defaultVoice, temperature = 0.7, seed = 42, onFirstAudio, onStart } = {}) {
    if (!this.model || !this.tokenCounter) {
      throw new Error("Cilla Mini model is not loaded yet.");
    }
    const pieces = P.textToPieces(text, this.tokenCounter);
    if (!pieces.length) return;
    for (let i = 0; i < pieces.length; i++) {
      this.queue.push({
        piece: pieces[i],
        voice,
        temperature,
        seed: seed + i,
        onFirstAudio: i === 0 ? onFirstAudio : undefined,
        onStart: i === 0 ? onStart : undefined,
        enqueuedAt: performance.now(),
      });
    }
    if (!this.processing) {
      this._drain();
    }
  }

  async _drain() {
    this.processing = true;
    const gen = this.generationId;
    clearTimeout(this.idleTimer);

    try {
      while (this.queue.length > 0 && gen === this.generationId) {
        const item = this.queue.shift();
        await this._streamPiece(item, gen);
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        // Items were enqueued while a previous cancelled turn was finishing cleanup.
        this._drain();
      } else if (gen === this.generationId && this.audioCtx) {
        const remainMs = Math.max(0, (this.nextPlayTime - this.audioCtx.currentTime) * 1000) + 120;
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
          if (!this.processing && this.queue.length === 0) {
            this._setSpeaking(false);
          }
        }, remainMs);
      }
    }
  }

  async _streamPiece(item, gen) {
    const ctx = this._ensureAudioContext();
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        // ignore
      }
    }
    const keep = Math.floor(0.12 * SAMPLE_RATE);
    let started = false;
    let lead = new Float32Array(0);
    let held = [];
    let sumsq = 0;
    let count = 0;
    let firstAudioFired = false;

    const schedule = (pcm) => {
      if (!pcm.length || gen !== this.generationId) return;
      const buf = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
      buf.getChannelData(0).set(pcm);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.analyser || ctx.destination);
      this.activeSources.add(src);
      src.onended = () => this.activeSources.delete(src);
      const now = ctx.currentTime;
      if (this.nextPlayTime < now + 0.02) {
        this.nextPlayTime = now + 0.04;
      }
      const startAt = this.nextPlayTime;
      src.start(startAt);
      this.nextPlayTime += buf.duration;
      this._setSpeaking(true);
      if (!firstAudioFired) {
        firstAudioFired = true;
        item.onFirstAudio?.(Math.round(performance.now() - item.enqueuedAt));
        if (item.onStart) {
          const delayMs = Math.max(0, (startAt - now) * 1000);
          const tid = setTimeout(() => {
            this.startTimers.delete(tid);
            if (gen === this.generationId) item.onStart?.();
          }, delayMs);
          this.startTimers.add(tid);
        }
      }
    };

    const stream = this.model.stream(item.piece, {
      voice: item.voice,
      temperature: item.temperature,
      seed: item.seed,
    });
    this.activeStream = stream;

    try {
      for await (const chunk of stream) {
        if (gen !== this.generationId) {
          stream.cancel();
          return;
        }
        for (let j = 0; j < chunk.length; j++) sumsq += chunk[j] * chunk[j];
        count += chunk.length;
        const speech = loudest(chunk) > Math.max(0.001, 0.04 * Math.sqrt(sumsq / count));
        if (!started) {
          if (!speech) {
            lead = cat(lead, chunk);
            if (lead.length > keep) lead = lead.slice(lead.length - keep);
            continue;
          }
          started = true;
          schedule(P.cleanStart(cat(lead, chunk), SAMPLE_RATE));
        } else if (speech) {
          held.forEach(schedule);
          held = [];
          schedule(chunk);
        } else {
          held.push(chunk);
        }
      }
      if (started && held.length && gen === this.generationId) {
        schedule(cat(...held).slice(0, keep));
      }
      this.nextPlayTime += 0.14;
    } finally {
      if (this.activeStream === stream) this.activeStream = null;
    }
  }
}
