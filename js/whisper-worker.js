/* Desk Buddy: on-device speech recognition with Whisper (transformers.js, self-hosted in js/vendor).
   Runs in a module Web Worker so the face keeps animating while it transcribes.
   Models are downloaded from Hugging Face the first time and then kept in the browser's cache.

   in:  {type:"load", model, device:"auto"|"wasm"}
        {type:"transcribe", id, audio: Float32Array (16 kHz mono)}
   out: {type:"progress", file, loaded, total, status}   while downloading
        {type:"ready", device, dtype, ms}  |  {type:"error", message}
        {type:"result", id, text, ms} */
import { pipeline, env } from "./vendor/transformers/transformers.min.js";

env.allowLocalModels = false;            // models come from huggingface.co (then the browser cache)
env.useBrowserCache = true;
const base = new URL("./vendor/transformers/", import.meta.url).href;
try {
  env.backends.onnx.wasm.wasmPaths = base;  // self-hosted onnxruntime-web .mjs/.wasm, not a CDN
  if (!self.crossOriginIsolated) env.backends.onnx.wasm.numThreads = 1;   // no SharedArrayBuffer on GitHub Pages
} catch (e) { /* older layout */ }

let asr = null, loading = null, info = null;

async function hasWebGPU() {
  try { return !!(self.navigator && navigator.gpu && (await navigator.gpu.requestAdapter())); } catch (e) { return false; }
}

async function load(model, device) {
  const t0 = performance.now();
  const progress_callback = (p) => {
    if (p && (p.status === "progress" || p.status === "initiate" || p.status === "done"))
      postMessage({ type: "progress", file: p.file, loaded: p.loaded || 0, total: p.total || 0, status: p.status });
  };
  const tries = [];
  if (device !== "wasm" && (await hasWebGPU())) tries.push({ device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } });
  tries.push({ device: "wasm", dtype: "q8" });
  let lastErr = null;
  for (const t of tries) {
    try {
      asr = await pipeline("automatic-speech-recognition", model, { device: t.device, dtype: t.dtype, progress_callback });
      info = { device: t.device, dtype: typeof t.dtype === "string" ? t.dtype : "fp32+q4" };
      // warm up once so the first real utterance isn't slow
      // (with a short warble rather than silence, so the decoder runs a few steps too)
      const warm = new Float32Array(16000 * 1.5);
      for (let i = 0; i < warm.length; i++) warm[i] = 0.2 * Math.sin(i * (0.05 + 0.03 * Math.sin(i / 1600))) * Math.min(1, i / 800);
      await asr(warm, { chunk_length_s: 30 });
      return Object.assign({ ms: Math.round(performance.now() - t0) }, info);
    } catch (e) { lastErr = e; asr = null; }
  }
  throw lastErr || new Error("Whisper failed to load");
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === "load") {
      if (!loading) loading = load(m.model, m.device);
      const r = await loading;
      postMessage(Object.assign({ type: "ready" }, r));
    } else if (m.type === "transcribe") {
      if (!asr) { if (!loading) throw new Error("not loaded"); await loading; }
      const t0 = performance.now();
      const out = await asr(m.audio, { chunk_length_s: 30 });
      postMessage({ type: "result", id: m.id, text: String((out && out.text) || "").trim(), ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    if (m.type === "load") loading = null;
    postMessage({ type: "error", id: m.id, message: String((err && err.message) || err) });
  }
};
