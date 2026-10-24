/* Desk Buddy: "On-device Whisper" speech-to-text engine. No speech recognition API, so no
   Android beep, and the audio never leaves the device. The voice detector (js/vad.js) already
   has the mic open; it cuts out each utterance (with ~0.8 s of pre-roll, so the start of the wake
   word isn't lost), resamples it to 16 kHz, and js/whisper-worker.js transcribes it.

   Same interface as the other STT engines (see js/adapters.js), plus:
     .attach(vad)        the detector to take audio from
     .load() -> Promise  download/prepare the model (shows progress through onProgress)
     .begin() .finish()  called by the app at voice start / end
     .state  "idle" | "loading" | "ready" | "error"   .progress {loaded,total}   .lastMs (latency)
*/
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});
  const noop = () => {};

  // Whisper sometimes "hears" these in silence or noise.
  const HALLUCINATIONS = /^(you|thank you|thanks|thank you for watching|thanks for watching|bye|okay|so|uh|um|hmm|\.|,)[.!?]*$/i;
  function cleanWhisper(text) {
    let t = String(text || "").replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, " ").replace(/\s+/g, " ").trim();
    if (!/[\p{L}\p{N}]/u.test(t)) return "";
    return t;
  }

  class WhisperSTT {
    constructor(opts) {
      opts = opts || {};
      this.model = opts.model || "Xenova/whisper-tiny.en";
      this.device = opts.device || "auto";
      this.supported = !!(window.Worker && window.WebAssembly);
      this.running = false;            // capturing an utterance
      this.armed = false;              // a tap asked for the next utterance
      this.pending = 0;                // utterances being transcribed
      this.state = "idle"; this.error = ""; this.info = null; this.progress = { loaded: 0, total: 0, files: {} };
      this.vad = null; this.worker = null; this.ready = null; this.seq = 0; this.token = 0; this.starts = 0;
      this.lastMs = 0; this.lastAudioMs = 0; this.lastText = ""; this.maxTimer = 0; this.callbacks = new Map();
      this.onResult = noop; this.onSpeech = noop; this.onState = noop; this.onEnd = noop; this.onEvent = noop; this.onProgress = noop;
    }
    get kind() { return "whisper"; }
    get capturing() { return this.running; }
    attach(vad) { this.vad = vad; vad.capture = true; }
    setLang() { /* the .en models are English only */ }
    load() {
      if (this.ready) return this.ready;
      this.state = "loading"; this.onEvent("loading " + this.model); this.onProgress(this.progress);
      this.worker = new Worker(new URL("js/whisper-worker.js", document.baseURI).href, { type: "module" });
      this.ready = new Promise((resolve, reject) => {
        this.worker.onmessage = (e) => {
          const m = e.data || {};
          if (m.type === "progress") {
            if (m.file) this.progress.files[m.file] = { loaded: m.loaded, total: m.total };
            let l = 0, t = 0; for (const f of Object.values(this.progress.files)) { l += f.loaded || 0; t += f.total || 0; }
            this.progress.loaded = l; this.progress.total = t; this.onProgress(this.progress);
          } else if (m.type === "ready") {
            this.state = "ready"; this.info = { device: m.device, dtype: m.dtype, loadMs: m.ms };
            this.onEvent("ready (" + m.device + ", " + m.dtype + ")"); this.onProgress(this.progress); resolve(this.info);
          } else if (m.type === "result" || (m.type === "error" && m.id)) {
            const cb = this.callbacks.get(m.id); this.callbacks.delete(m.id); if (cb) cb(m);
          } else if (m.type === "error") {
            this.state = "error"; this.error = m.message; this.ready = null;
            this.onEvent("error: " + m.message); this.onState("error", "On-device Whisper failed to load: " + m.message, "whisper-load");
            reject(new Error(m.message));
          }
        };
        this.worker.onerror = (e) => {
          this.state = "error"; this.error = (e && e.message) || "worker error"; this.ready = null;
          this.onEvent("error: " + this.error); this.onState("error", "On-device Whisper failed: " + this.error, "whisper-load");
          reject(new Error(this.error));
        };
      });
      this.ready.catch(noop);
      this.worker.postMessage({ type: "load", model: this.model, device: this.device });
      return this.ready;
    }
    /** Arm for the next utterance (a tap), or begin now if a voice is already going. */
    start(opts) {
      opts = opts || {};
      if (!this.supported || this.running) return false;
      if (!this.vad || !this.vad.running) { this.armed = true; return true; }
      if (this.vad.inSpeech || opts.source === "voice") return this.begin(opts.source);
      this.armed = true; this.onEvent("armed"); return true;
    }
    begin(source) {
      if (!this.vad || this.running) return false;
      this.load();
      this.armed = false; this.running = true; this.starts++; this.source = source || "voice";
      this.vad.beginCapture();
      this.onEvent("recording"); this.onState("listening"); this.onSpeech();
      clearTimeout(this.maxTimer);
      this.maxTimer = setTimeout(() => this.finish(), 15000);
      return true;
    }
    /** End of the utterance: transcribe it. */
    finish() {
      if (!this.running) return;
      clearTimeout(this.maxTimer);
      this.running = false;
      const audio = this.vad && this.vad.endCapture();
      const my = this.token;
      if (!audio || audio.length < 16000 * 0.4) { this.onEvent("too short"); this.onState("idle"); this.onEnd(false); return; }
      const id = ++this.seq;
      let t0 = performance.now();                  // reset when it's actually sent (it may wait for the model)
      this.pending++; this.lastAudioMs = Math.round(audio.length / 16);
      this.onEvent("transcribing " + (audio.length / 16000).toFixed(1) + " s");
      this.onState("idle");
      const done = (m) => {
        this.pending = Math.max(0, this.pending - 1);
        this.lastMs = Math.round(performance.now() - t0);
        if (my !== this.token) { this.onEvent("dropped (cancelled)"); return; }
        if (m.type === "error") { this.onEvent("error: " + m.message); this.onEnd(false); return; }
        const text = cleanWhisper(m.text);
        this.lastText = m.text;
        this.onEvent("result in " + this.lastMs + " ms");
        if (!text || (HALLUCINATIONS.test(text) && audio.length < 16000 * 2.5)) { this.onEnd(false); return; }
        this.onResult(text, true);
        this.onEnd(true);
      };
      this.callbacks.set(id, done);
      const send = () => { t0 = performance.now(); this.worker.postMessage({ type: "transcribe", id, audio }, [audio.buffer]); };
      if (this.state === "ready") send();
      else this.load().then(send, () => done({ type: "error", message: "model not loaded" }));
    }
    stop() { this.armed = false; this.finish(); }
    /** Throw away the utterance being recorded and any transcription still running (Buddy started talking). */
    abort() {
      this.armed = false; this.token++;
      clearTimeout(this.maxTimer);
      if (this.running) { this.running = false; if (this.vad) this.vad.cancelCapture(); this.onEvent("aborted"); this.onState("idle"); this.onEnd(false); }
    }
    /** For tests and the diagnostics: transcribe a 16 kHz buffer directly. */
    transcribe(audio) {
      return this.load().then(() => new Promise((res) => {
        const id = ++this.seq, t0 = performance.now();
        this.callbacks.set(id, (m) => res({ text: m.text || "", error: m.message, ms: Math.round(performance.now() - t0) }));
        this.worker.postMessage({ type: "transcribe", id, audio });
      }));
    }
  }

  DB.WhisperSTT = WhisperSTT;
  DB.cleanWhisper = cleanWhisper;
  DB.WHISPER_MODELS = { "Xenova/whisper-tiny.en": "Tiny (English, ~40 MB download)", "Xenova/whisper-base.en": "Base (English, ~75 MB, more accurate, slower)" };
})();
