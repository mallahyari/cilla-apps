import "@fontsource/vazirmatn/400.css";
import "@fontsource/vazirmatn/500.css";
import "@fontsource/vazirmatn/600.css";
import "@fontsource/vazirmatn/700.css";
import { CillaBrowserTTS, isModelCached } from "@cilla-apps/cilla-web";

type SpeakerId = "del" | "aghl";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connDot = $<HTMLSpanElement>("connDot");
const micSelect = $<HTMLSelectElement>("micSelect");
const clearBtn = $<HTMLButtonElement>("clearBtn");
const modelBanner = $<HTMLElement>("modelBanner");
const modelStatus = $<HTMLSpanElement>("modelStatus");
const loadModelBtn = $<HTMLButtonElement>("loadModelBtn");
const modelProgress = $<HTMLProgressElement>("modelProgress");
const theater = $<HTMLElement>("theater");
const userPill = $<HTMLDivElement>("userPill");
const bubbleDel = $<HTMLDivElement>("bubbleDel");
const bubbleAghl = $<HTMLDivElement>("bubbleAghl");
const textDel = $<HTMLParagraphElement>("textDel");
const textAghl = $<HTMLParagraphElement>("textAghl");
const mouthDel = document.getElementById("mouthDel") as unknown as SVGEllipseElement;
const mouthAghl = document.getElementById("mouthAghl") as unknown as SVGEllipseElement;
const promptChips = $<HTMLDivElement>("promptChips");
const micBtn = $<HTMLButtonElement>("micBtn");
const micLabel = $<HTMLSpanElement>("micLabel");
const textForm = $<HTMLFormElement>("textForm");
const textInput = $<HTMLInputElement>("textInput");

const tts = new CillaBrowserTTS({
  modelBaseUrl: "/model",
  voices: ["parisa", "voice1", "voice2"],
  defaultVoice: "parisa",
});

let ws: WebSocket | null = null;
let roundId = 0;
let activeSpeaker: SpeakerId | null = null;
let smoothLevel = 0;
// Track full text of each turn so each speech bubble displays the exact line being spoken
const turnTexts = new Map<string, string>();
const turnSpeakers = new Map<string, SpeakerId>();

// Mic recording state (raw 16 kHz PCM16 binary WS)
let micStream: MediaStream | null = null;
let micAudioCtx: AudioContext | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let micAnalyser: AnalyserNode | null = null;
let micProcessor: ScriptProcessorNode | null = null;
let micTimeData: Float32Array<ArrayBuffer> | null = null;
let pcmChunks: Float32Array[] = [];
let recording = false;
let startingMic = false;
let silenceRaf = 0;

// 60fps real-time lip-sync loop driven by CillaBrowserTTS output loudness
function lipSyncLoop() {
  const target = activeSpeaker ? tts.getOutputLevel() : 0;
  smoothLevel = smoothLevel + (target - smoothLevel) * 0.36;

  if (activeSpeaker === "del") {
    const ry = 4.5 + smoothLevel * 16;
    const rx = 13 + smoothLevel * 5;
    mouthDel.setAttribute("ry", ry.toFixed(1));
    mouthDel.setAttribute("rx", rx.toFixed(1));
  } else if (activeSpeaker === "aghl") {
    const ry = 4 + smoothLevel * 15;
    const rx = 12 + smoothLevel * 5;
    mouthAghl.setAttribute("ry", ry.toFixed(1));
    mouthAghl.setAttribute("rx", rx.toFixed(1));
  }
  requestAnimationFrame(lipSyncLoop);
}
lipSyncLoop();

function setActiveSpeaker(speaker: SpeakerId | null, bubbleText?: string) {
  activeSpeaker = speaker;
  theater.dataset.active = speaker || "none";

  if (speaker === "del") {
    bubbleDel.hidden = false;
    bubbleAghl.hidden = true;
    if (bubbleText !== undefined) textDel.textContent = bubbleText;
  } else if (speaker === "aghl") {
    bubbleAghl.hidden = false;
    bubbleDel.hidden = true;
    if (bubbleText !== undefined) textAghl.textContent = bubbleText;
  } else {
    bubbleDel.hidden = true;
    bubbleAghl.hidden = true;
  }

  if (!recording) {
    micBtn.className = speaker ? "mic-btn speaking" : "mic-btn idle";
    micLabel.textContent = speaker ? "توقف" : "بپرس";
  }
}

tts.onSpeakingChange = (speaking: boolean) => {
  if (!speaking) {
    setActiveSpeaker(null);
  }
};

async function loadCillaModel() {
  loadModelBtn.disabled = true;
  modelProgress.hidden = false;
  modelProgress.value = 0;
  modelStatus.textContent = "در حال بارگذاری سیلا مینی…";
  try {
    await tts.load({
      onProgress: ({ loaded, total, ratio, fromCache }) => {
        modelProgress.value = ratio;
        const mb = (b: number) => (b / 1048576).toFixed(0);
        modelStatus.textContent = fromCache
          ? `بارگذاری از حافظه مرورگر: ${mb(loaded)} از ${mb(total)} مگابایت`
          : `دانلود سیلا مینی: ${mb(loaded)} از ${mb(total)} مگابایت`;
      },
    });
    modelProgress.hidden = true;
    loadModelBtn.hidden = true;
    modelBanner.classList.add("ready");
  } catch (err) {
    loadModelBtn.disabled = false;
    modelProgress.hidden = true;
    modelStatus.textContent = `خطا در بارگذاری مدل: ${String(err)}`;
  }
}

loadModelBtn.addEventListener("click", loadCillaModel);

function bargeIn() {
  tts.stop();
  setActiveSpeaker(null);
  turnTexts.clear();
  turnSpeakers.clear();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "cancel", roundId }));
  }
}

function showUserQuestion(text: string) {
  promptChips.hidden = true;
  userPill.textContent = `«${text}»`;
  userPill.hidden = false;
}

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/debate`);

  ws.addEventListener("open", () => connDot.classList.add("online"));
  ws.addEventListener("close", () => {
    connDot.classList.remove("online");
    setTimeout(connectWS, 1500);
  });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.roundId && msg.roundId !== roundId) return;

    switch (msg.type) {
      case "status":
        if (msg.stage === "transcribing") micLabel.textContent = "تشخیص…";
        break;

      case "transcript":
        showUserQuestion(msg.text);
        micLabel.textContent = "شروع…";
        break;

      case "empty_transcript":
        micLabel.textContent = "بپرس";
        break;

      case "turn_start": {
        const key = `${msg.roundId}-${msg.turnIdx}`;
        turnTexts.set(key, "");
        turnSpeakers.set(key, msg.speaker as SpeakerId);
        // If TTS isn't loaded, still animate the speaker directly on tokens
        if (!tts.isLoaded) {
          setActiveSpeaker(msg.speaker as SpeakerId, "");
        }
        break;
      }

      case "token": {
        const key = `${msg.roundId}-${msg.turnIdx}`;
        const updated = ((turnTexts.get(key) || "") + msg.text).replace(
          /^\s*(دل|عقل)\s*[:：\-—]\s*/,
          ""
        );
        turnTexts.set(key, updated);
        if (!tts.isLoaded) {
          const sp = msg.speaker as SpeakerId;
          if (sp === "del") textDel.textContent = updated;
          else textAghl.textContent = updated;
        }
        break;
      }

      case "sentence": {
        const speaker = msg.speaker as SpeakerId;
        const sentenceText = msg.text as string;
        if (tts.isLoaded) {
          tts.enqueue(sentenceText, {
            voice: msg.voice,
            onStart: () => {
              // Show the exact sentence being spoken right on the character's bubble!
              setActiveSpeaker(speaker, sentenceText);
            },
          });
        }
        break;
      }

      case "cleared":
        userPill.hidden = true;
        promptChips.hidden = false;
        setActiveSpeaker(null);
        break;

      case "error":
        userPill.textContent = `خطا: ${msg.message}`;
        userPill.hidden = false;
        setActiveSpeaker(null);
        break;
    }
  });
}

async function refreshMicDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const current = micSelect.value;
    micSelect.replaceChildren(new Option("میکروفون پیش‌فرض", ""));
    inputs.forEach((d, idx) =>
      micSelect.appendChild(new Option(d.label || `میکروفون ${idx + 1}`, d.deviceId))
    );
    if (current && [...micSelect.options].some((o) => o.value === current)) micSelect.value = current;
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
  const ratio = inputSampleRate / 16000;
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

async function startRecording() {
  if (startingMic) return;
  startingMic = true;
  micLabel.textContent = "میکروفون…";
  bargeIn();

  try {
    if (!micStream || !micStream.getAudioTracks().some((t) => t.readyState === "live")) {
      const deviceId = micSelect.value;
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      refreshMicDevices();
    }

    if (!micAudioCtx || micAudioCtx.state === "closed" || !micAnalyser || !micProcessor) {
      micAudioCtx = new AudioContext();
      micSource = micAudioCtx.createMediaStreamSource(micStream);
      micAnalyser = micAudioCtx.createAnalyser();
      micAnalyser.fftSize = 256;
      micProcessor = micAudioCtx.createScriptProcessor(2048, 1, 1);
      micProcessor.onaudioprocess = (ev) => {
        if (!recording) return;
        pcmChunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
      };
      const zeroGain = micAudioCtx.createGain();
      zeroGain.gain.value = 0;
      micSource.connect(micAnalyser);
      micSource.connect(micProcessor);
      micProcessor.connect(zeroGain);
      zeroGain.connect(micAudioCtx.destination);
      micTimeData = new Float32Array(new ArrayBuffer(micAnalyser.fftSize * 4));
    } else if (micAudioCtx.state !== "running") {
      await micAudioCtx.resume();
    }

    pcmChunks = [];
    recording = true;
    startingMic = false;
    micBtn.className = "mic-btn listening";
    micLabel.textContent = "می‌شنوم…";

    let heardSpeech = false;
    let silenceStart = 0;
    const startedAt = performance.now();

    const tick = () => {
      if (!recording || !micAnalyser || !micTimeData) return;
      micAnalyser.getFloatTimeDomainData(micTimeData);
      let sum = 0;
      for (let i = 0; i < micTimeData.length; i++) sum += micTimeData[i] * micTimeData[i];
      const rms = Math.sqrt(sum / micTimeData.length);
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
      silenceRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    recording = false;
    startingMic = false;
    micBtn.className = "mic-btn idle";
    micLabel.textContent = "بپرس";
    userPill.textContent = `خطای میکروفون: ${String(err)}`;
    userPill.hidden = false;
  }
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  cancelAnimationFrame(silenceRaf);
  micBtn.className = "mic-btn idle";

  const pcm16 = downsampleTo16kPcm16(pcmChunks, micAudioCtx?.sampleRate || 48000);
  pcmChunks = [];
  if (pcm16.length < 4800 || !ws || ws.readyState !== WebSocket.OPEN) {
    micLabel.textContent = "بپرس";
    return;
  }

  roundId++;
  micLabel.textContent = "تشخیص…";
  const payload = new ArrayBuffer(4 + pcm16.byteLength);
  new DataView(payload).setUint32(0, roundId, true);
  new Uint8Array(payload, 4).set(new Uint8Array(pcm16.buffer));
  ws.send(payload);
}

function sendDilemma(text: string) {
  const clean = text.trim();
  if (!clean || !ws || ws.readyState !== WebSocket.OPEN) return;
  tts.unlock();
  bargeIn();
  roundId++;
  showUserQuestion(clean);
  ws.send(JSON.stringify({ type: "text", roundId, text: clean }));
}

micBtn.addEventListener("click", () => {
  tts.unlock();
  if (recording) {
    stopRecording();
  } else if (activeSpeaker) {
    bargeIn();
  } else {
    startRecording();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || document.activeElement === textInput) return;
  e.preventDefault();
  if (e.repeat) return;
  micBtn.click();
});

textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const val = textInput.value;
  textInput.value = "";
  sendDilemma(val);
});

promptChips.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
  if (btn?.dataset.prompt) sendDilemma(btn.dataset.prompt);
});

clearBtn.addEventListener("click", () => {
  bargeIn();
  ws?.send(JSON.stringify({ type: "clear" }));
});

async function init() {
  connectWS();
  refreshMicDevices();
  try {
    const r = await fetch("/api/health");
    const info = await r.json();
    if (!info.tts_model_ready) {
      modelStatus.textContent = "فایل مدل در models/cilla-mini/phonon/model پیدا نشد.";
      loadModelBtn.disabled = true;
    } else if (await isModelCached("/model")) {
      loadCillaModel();
    }
  } catch {
    modelStatus.textContent = "سرور محلی (پورت 8788) در دسترس نیست.";
  }
}

init();
