import "@fontsource/vazirmatn/400.css";
import "@fontsource/vazirmatn/500.css";
import "@fontsource/vazirmatn/600.css";
import "@fontsource/vazirmatn/700.css";
import { CillaBrowserTTS, isModelCached } from "@cilla-apps/cilla-web";
import { VoiceOrbCanvas, type OrbVisualState } from "./orbCanvas";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connDot = $<HTMLSpanElement>("connDot");
const stackInfo = $<HTMLParagraphElement>("stackInfo");
const micSelect = $<HTMLSelectElement>("micSelect");
const voiceSelect = $<HTMLSelectElement>("voiceSelect");
const clearBtn = $<HTMLButtonElement>("clearBtn");
const modelBanner = $<HTMLElement>("modelBanner");
const modelStatus = $<HTMLSpanElement>("modelStatus");
const loadModelBtn = $<HTMLButtonElement>("loadModelBtn");
const modelProgress = $<HTMLProgressElement>("modelProgress");
const orbCanvasEl = $<HTMLCanvasElement>("orbCanvas");
const orbBtn = $<HTMLButtonElement>("orbBtn");
const orbIcon = $<HTMLSpanElement>("orbIcon");
const statePill = $<HTMLDivElement>("statePill");
const orbLabel = $<HTMLSpanElement>("orbLabel");
const autoStopToggle = $<HTMLInputElement>("autoStopToggle");
const metricsEl = $<HTMLDivElement>("metrics");
const chatEl = $<HTMLElement>("chat");
const emptyState = $<HTMLDivElement>("emptyState");
const promptChips = $<HTMLDivElement>("promptChips");
const textForm = $<HTMLFormElement>("textForm");
const textInput = $<HTMLInputElement>("textInput");

const tts = new CillaBrowserTTS({ modelBaseUrl: "/model", defaultVoice: "parisa" });

let ws: WebSocket | null = null;
let turnId = 0;
let orbState: OrbVisualState = "idle";
let startingMic = false;
let activeAssistantBubble: HTMLDivElement | null = null;
let lastMetrics: { asrMs?: number; firstSentenceMs?: number; firstAudioMs?: number } = {};

// Mic recording & live spectrum state (raw PCM16 @ 16 kHz -> binary WebSocket, zero ffmpeg)
let micStream: MediaStream | null = null;
let micAudioCtx: AudioContext | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let micAnalyser: AnalyserNode | null = null;
let micProcessor: ScriptProcessorNode | null = null;
let micTimeData: Float32Array<ArrayBuffer> | null = null;
let micFreqData = new Uint8Array(128);
let ttsFreqData = new Uint8Array(128);
let pcmChunks: Float32Array[] = [];
let recording = false;
let silenceRaf = 0;
let liveMicLevel = 0;

const ICONS: Record<OrbVisualState, string> = {
  idle: `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/></svg>`,
  listening: `<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="3"/></svg>`,
  thinking: `<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><circle cx="6" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="18" cy="12" r="2.2"/></svg>`,
  speaking: `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="5" y1="9" x2="5" y2="15"/><line x1="9.5" y1="5" x2="9.5" y2="19"/><line x1="14.5" y1="7" x2="14.5" y2="17"/><line x1="19" y1="10" x2="19" y2="14"/></svg>`,
};

const orbCanvas = new VoiceOrbCanvas(orbCanvasEl, () => {
  if (orbState === "listening" && micAnalyser) {
    micAnalyser.getByteFrequencyData(micFreqData);
    return { level: liveMicLevel, spectrum: micFreqData };
  }
  if (orbState === "speaking") {
    tts.getOutputFrequencyData(ttsFreqData);
    return { level: tts.getOutputLevel(), spectrum: ttsFreqData };
  }
  return { level: 0 };
});

window.addEventListener("error", (e) => {
  addMessage("system", `خطای صفحه: ${e.message || String(e.error)}`);
});
window.addEventListener("unhandledrejection", (e) => {
  addMessage("system", `خطای غیرمنتظره: ${String(e.reason)}`);
});

function setOrbState(next: OrbVisualState) {
  orbState = next;
  orbBtn.className = `orb-hit ${next}`;
  statePill.className = `state-pill ${next}`;
  orbIcon.innerHTML = ICONS[next];
  orbCanvas.setState(next);

  const labels: Record<OrbVisualState, string> = {
    idle: "بزن و صحبت کن",
    listening: "در حال شنیدن صدای شما…",
    thinking: "در حال فکر کردن…",
    speaking: "سیلا در حال صحبت است (برای توقف بزنید)",
  };
  orbLabel.textContent = labels[next];
}

function renderMetrics() {
  const pills: string[] = [];
  if (lastMetrics.asrMs !== undefined) pills.push(`ASR ${lastMetrics.asrMs} ms`);
  if (lastMetrics.firstSentenceMs !== undefined) pills.push(`LLM ${lastMetrics.firstSentenceMs} ms`);
  if (lastMetrics.firstAudioMs !== undefined) pills.push(`TTS ${lastMetrics.firstAudioMs} ms`);
  metricsEl.innerHTML = pills.map((p) => `<span class="pill">${p}</span>`).join("");
}

function addMessage(role: "user" | "assistant" | "system", text: string): HTMLDivElement {
  emptyState.hidden = true;
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

tts.onSpeakingChange = (speaking: boolean) => {
  if (speaking) {
    setOrbState("speaking");
  } else if (orbState === "speaking") {
    setOrbState("idle");
  }
};

async function loadCillaModel() {
  loadModelBtn.disabled = true;
  modelProgress.hidden = false;
  modelProgress.value = 0;
  modelStatus.textContent = "در حال بارگذاری سیلا مینی در مرورگر…";
  try {
    await tts.load({
      onProgress: ({ loaded, total, ratio, fromCache }) => {
        modelProgress.value = ratio;
        const mb = (b: number) => (b / 1048576).toFixed(0);
        modelStatus.textContent = fromCache
          ? `بارگذاری از حافظه مرورگر: ${mb(loaded)} از ${mb(total)} مگابایت`
          : `دانلود مدل (فقط بار اول): ${mb(loaded)} از ${mb(total)} مگابایت`;
      },
    });
    modelProgress.hidden = true;
    loadModelBtn.hidden = true;
    modelBanner.classList.add("ready");
    modelStatus.textContent = "مدل صوتی سیلا مینی آماده است (اجرای کامل داخل مرورگر).";
  } catch (err) {
    loadModelBtn.disabled = false;
    modelProgress.hidden = true;
    modelStatus.textContent = `خطا در بارگذاری مدل: ${String(err)}`;
  }
}

loadModelBtn.addEventListener("click", loadCillaModel);

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/chat`);

  ws.addEventListener("open", () => {
    connDot.classList.add("online");
  });

  ws.addEventListener("close", () => {
    connDot.classList.remove("online");
    setTimeout(connectWS, 1500);
  });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.turnId && msg.turnId !== turnId) return;

    switch (msg.type) {
      case "status":
        if (msg.stage === "transcribing") {
          setOrbState("thinking");
          orbLabel.textContent = "در حال تشخیص گفتار…";
        }
        break;

      case "transcript":
        lastMetrics.asrMs = msg.asrMs;
        renderMetrics();
        addMessage("user", msg.text);
        activeAssistantBubble = addMessage("assistant", "");
        setOrbState("thinking");
        break;

      case "empty_transcript":
        addMessage("system", "صدایی تشخیص داده نشد. دوباره امتحان کنید.");
        setOrbState("idle");
        break;

      case "token":
        if (!activeAssistantBubble) activeAssistantBubble = addMessage("assistant", "");
        activeAssistantBubble.textContent += msg.text;
        chatEl.scrollTop = chatEl.scrollHeight;
        break;

      case "sentence":
        if (lastMetrics.firstSentenceMs === undefined && msg.firstSentenceMs !== undefined) {
          lastMetrics.firstSentenceMs = msg.firstSentenceMs;
          renderMetrics();
        }
        if (tts.isLoaded) {
          tts.enqueue(msg.text, {
            voice: voiceSelect.value,
            onFirstAudio: (ms: number) => {
              if (lastMetrics.firstAudioMs === undefined) {
                lastMetrics.firstAudioMs = ms;
                renderMetrics();
              }
            },
          });
        }
        break;

      case "done":
        activeAssistantBubble = null;
        if (!tts.speaking && orbState === "thinking") setOrbState("idle");
        break;

      case "cleared":
        chatEl.querySelectorAll(".msg").forEach((n) => n.remove());
        emptyState.hidden = false;
        lastMetrics = {};
        renderMetrics();
        break;

      case "error":
        addMessage("system", `خطا: ${msg.message}`);
        activeAssistantBubble = null;
        setOrbState("idle");
        break;
    }
  });
}

function bargeIn() {
  tts.stop();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "cancel", turnId }));
  }
  activeAssistantBubble = null;
}

async function refreshMicDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const current = micSelect.value;
    micSelect.replaceChildren(new Option("میکروفون پیش‌فرض", ""));
    inputs.forEach((d, idx) => {
      const label = d.label || `میکروفون ${idx + 1}`;
      micSelect.appendChild(new Option(label, d.deviceId));
    });
    if (current && [...micSelect.options].some((o) => o.value === current)) {
      micSelect.value = current;
    }
  } catch {
    // ignore
  }
}

micSelect.addEventListener("change", () => {
  micProcessor?.disconnect();
  micProcessor = null;
  micSource?.disconnect();
  micSource = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  micAnalyser = null;
  micAudioCtx?.close().catch(() => {});
  micAudioCtx = null;
});

function downsampleTo16kPcm16(chunks: Float32Array[], inputSampleRate: number): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  const targetRate = 16000;
  if (inputSampleRate === targetRate) {
    const out = new Int16Array(merged.length);
    for (let i = 0; i < merged.length; i++) {
      const s = Math.max(-1, Math.min(1, merged[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = inputSampleRate / targetRate;
  const outLen = Math.floor(merged.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = merged[idx] || 0;
    const s1 = merged[Math.min(idx + 1, merged.length - 1)] || s0;
    const s = Math.max(-1, Math.min(1, s0 + (s1 - s0) * frac));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function ensureMicStream(): Promise<MediaStream> {
  if (micStream && micStream.getAudioTracks().some((t) => t.readyState === "live")) {
    return micStream;
  }
  const deviceId = micSelect.value;
  const constraints: MediaStreamConstraints = {
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  };
  micStream = await Promise.race([
    navigator.mediaDevices.getUserMedia(constraints),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "میکروفون پاسخ نداد — در نوار آدرس دسترسی میکروفون را چک کنید یا از منوی بالا میکروفون مک‌بوک را انتخاب کنید."
            )
          ),
        12000
      )
    ),
  ]);
  refreshMicDevices();
  return micStream;
}

async function startRecording() {
  if (startingMic) return;
  startingMic = true;
  orbLabel.textContent = "درخواست میکروفون…";
  bargeIn();
  lastMetrics = {};
  renderMetrics();

  if (!navigator.mediaDevices?.getUserMedia) {
    startingMic = false;
    setOrbState("idle");
    addMessage("system", "مرورگر در این آدرس به میکروفون دسترسی ندارد. صفحه را روی http://localhost:5173 باز کنید.");
    return;
  }

  try {
    const stream = await ensureMicStream();

    if (!micAudioCtx || micAudioCtx.state === "closed" || !micAnalyser || !micProcessor) {
      micAudioCtx = new AudioContext();
      micSource = micAudioCtx.createMediaStreamSource(stream);
      micAnalyser = micAudioCtx.createAnalyser();
      micAnalyser.fftSize = 256;
      micAnalyser.smoothingTimeConstant = 0.78;
      micProcessor = micAudioCtx.createScriptProcessor(2048, 1, 1);
      micProcessor.onaudioprocess = (ev) => {
        if (!recording) return;
        const ch = ev.inputBuffer.getChannelData(0);
        pcmChunks.push(new Float32Array(ch));
      };
      // Silent sink keeps ScriptProcessorNode running without echoing mic to speakers
      const zeroGain = micAudioCtx.createGain();
      zeroGain.gain.value = 0;
      micSource.connect(micAnalyser);
      micSource.connect(micProcessor);
      micProcessor.connect(zeroGain);
      zeroGain.connect(micAudioCtx.destination);
      micTimeData = new Float32Array(new ArrayBuffer(micAnalyser.fftSize * 4));
      micFreqData = new Uint8Array(micAnalyser.frequencyBinCount);
    } else if (micAudioCtx.state !== "running") {
      await micAudioCtx.resume();
    }

    pcmChunks = [];
    recording = true;
    startingMic = false;
    setOrbState("listening");

    let heardSpeech = false;
    let silenceStart = 0;
    const startedAt = performance.now();

    const tick = () => {
      if (orbState !== "listening" || !micAnalyser || !micTimeData) return;
      micAnalyser.getFloatTimeDomainData(micTimeData);
      let sum = 0;
      for (let i = 0; i < micTimeData.length; i++) sum += micTimeData[i] * micTimeData[i];
      const rms = Math.sqrt(sum / micTimeData.length);
      liveMicLevel = Math.min(1, rms * 4.5);

      if (autoStopToggle.checked) {
        const now = performance.now();
        if (rms > 0.02) {
          heardSpeech = true;
          silenceStart = 0;
        } else if (heardSpeech && now - startedAt > 450) {
          if (!silenceStart) silenceStart = now;
          else if (now - silenceStart > 550) {
            stopRecording();
            return;
          }
        }
      }
      silenceRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    recording = false;
    startingMic = false;
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    micAnalyser = null;
    micProcessor = null;
    micSource = null;
    micAudioCtx?.close().catch(() => {});
    micAudioCtx = null;
    addMessage("system", `خطا در شروع ضبط صدا: ${String(err)}`);
    setOrbState("idle");
  }
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  cancelAnimationFrame(silenceRaf);
  liveMicLevel = 0;

  const sampleRate = micAudioCtx?.sampleRate || 48000;
  const pcm16 = downsampleTo16kPcm16(pcmChunks, sampleRate);
  pcmChunks = [];

  if (pcm16.length < 4800) {
    // < 0.3s of audio
    addMessage("system", "ضبط خیلی کوتاه بود، دوباره امتحان کنید.");
    setOrbState("idle");
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addMessage("system", "اتصال به سرور محلی برقرار نیست.");
    setOrbState("idle");
    return;
  }

  setOrbState("thinking");
  turnId++;
  const payload = new ArrayBuffer(4 + pcm16.byteLength);
  new DataView(payload).setUint32(0, turnId, true);
  new Uint8Array(payload, 4).set(new Uint8Array(pcm16.buffer));
  ws.send(payload);
}

function sendText(text: string) {
  const clean = text.trim();
  if (!clean || !ws || ws.readyState !== WebSocket.OPEN) return;
  tts.unlock();
  bargeIn();
  lastMetrics = {};
  renderMetrics();
  turnId++;
  addMessage("user", clean);
  activeAssistantBubble = addMessage("assistant", "");
  setOrbState("thinking");
  ws.send(JSON.stringify({ type: "text", turnId, text: clean }));
}

orbBtn.addEventListener("click", () => {
  tts.unlock();
  if (orbState === "listening") {
    stopRecording();
  } else if (orbState === "speaking" || orbState === "thinking") {
    bargeIn();
    setOrbState("idle");
  } else {
    startRecording();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || document.activeElement === textInput) return;
  e.preventDefault();
  if (e.repeat) return;
  orbBtn.click();
});

textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textInput.value;
  textInput.value = "";
  sendText(text);
});

promptChips.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
  if (!btn?.dataset.prompt) return;
  sendText(btn.dataset.prompt);
});

clearBtn.addEventListener("click", () => {
  bargeIn();
  setOrbState("idle");
  ws?.send(JSON.stringify({ type: "clear" }));
});

async function init() {
  connectWS();
  refreshMicDevices();
  try {
    const r = await fetch("/api/health");
    const info = await r.json();
    stackInfo.textContent = `آفلاین · ASR: ${info.asr_model} · LLM: ${info.llm_model} · TTS: Cilla Mini`;
    if (!info.tts_model_ready) {
      modelStatus.textContent =
        "فایل مدل در models/cilla-mini/phonon/model پیدا نشد. دستور hf download را اجرا کنید.";
      loadModelBtn.disabled = true;
    } else if (await isModelCached("/model")) {
      loadCillaModel();
    }
  } catch {
    stackInfo.textContent = "سرور محلی در دسترس نیست (ابتدا سرور Python را اجرا کنید).";
  }
}

init();
