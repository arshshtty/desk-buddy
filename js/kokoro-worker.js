/* Desk Buddy: on-device "natural voice" text-to-speech with Kokoro-82M (kokoro-js, self-hosted in js/vendor/kokoro,
   on the same self-hosted transformers.js / ONNX Runtime as Whisper). Runs in a module Web Worker so the face keeps
   animating. The model (onnx-community/Kokoro-82M-v1.0-ONNX, about 92 MB at q8) and the voice files (0.5 MB each)
   download from Hugging Face the first time and are then kept in the browser's cache.

   in:  {type:"load", device:"auto"|"wasm"|"webgpu"}
        {type:"speak", id, text, voice, speed}
   out: {type:"progress", file, loaded, total, status}
        {type:"ready", device, dtype, ms, warmMs}  |  {type:"error", id?, message}
        {type:"audio", id, audio: Float32Array, rate, ms} */
import { env } from "./vendor/transformers/transformers.min.js";
import { KokoroTTS } from "./vendor/kokoro/kokoro.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
try {
  env.backends.onnx.wasm.wasmPaths = new URL("./vendor/transformers/", import.meta.url).href;
  if (!self.crossOriginIsolated) env.backends.onnx.wasm.numThreads = 1;
} catch (e) { /* older layout */ }

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let tts = null, loading = null, info = null;

async function hasWebGPU() {
  try { return !!(self.navigator && navigator.gpu && (await navigator.gpu.requestAdapter())); } catch (e) { return false; }
}
async function load(device) {
  const t0 = performance.now();
  const progress_callback = (p) => {
    if (p && (p.status === "progress" || p.status === "initiate" || p.status === "done"))
      postMessage({ type: "progress", file: p.file, loaded: p.loaded || 0, total: p.total || 0, status: p.status });
  };
  // WebGPU needs the full-precision model (326 MB) to sound right, so it's only used when asked for.
  const tries = [];
  if (device === "webgpu" && (await hasWebGPU())) tries.push({ device: "webgpu", dtype: "fp32" });
  tries.push({ device: "wasm", dtype: "q8" });
  let lastErr = null;
  for (const t of tries) {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL, { dtype: t.dtype, device: t.device, progress_callback });
      info = t;
      const w0 = performance.now();
      await tts.generate("Hi.", { voice: "af_heart" });          // warm up (and fetch the default voice)
      return { device: t.device, dtype: t.dtype, ms: Math.round(performance.now() - t0), warmMs: Math.round(performance.now() - w0) };
    } catch (e) { lastErr = e; tts = null; }
  }
  throw lastErr || new Error("Kokoro failed to load");
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === "load") {
      if (!loading) loading = load(m.device);
      postMessage(Object.assign({ type: "ready" }, await loading));
    } else if (m.type === "speak") {
      if (!tts) { if (!loading) throw new Error("not loaded"); await loading; }
      const t0 = performance.now();
      const out = await tts.generate(String(m.text || ""), { voice: m.voice || "af_heart", speed: m.speed || 1 });
      const audio = out.audio instanceof Float32Array ? out.audio : new Float32Array(out.audio || []);
      postMessage({ type: "audio", id: m.id, audio, rate: out.sampling_rate || 24000, ms: Math.round(performance.now() - t0) }, [audio.buffer]);
    }
  } catch (err) {
    if (m.type === "load") loading = null;
    postMessage({ type: "error", id: m.id, message: String((err && err.message) || err) });
  }
};
