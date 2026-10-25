/* Desk Buddy: the optional "natural voice" (Kokoro-82M, on this device) and the voice-out switch.
   DB.KokoroVoice talks to js/kokoro-worker.js and plays the audio with Web Audio.
   DB.MultiTTS has the same interface as DB.BrowserTTS (speak, cancel, speaking, onStart/onWord/onEnd, ...), so the
   rest of the app doesn't care which voice is talking. It uses Kokoro when it's chosen and loaded, and the system
   voice otherwise, including automatically when Kokoro is too slow on this device or fails. */
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});
  const noop = () => {};

  // A few of Kokoro's 54 voices (grades from the model card: af_heart A, af_bella A-, bf_emma B-, the rest C/D).
  const KOKORO_VOICES = {
    af_heart: "Heart (US, female)", af_bella: "Bella (US, female)", af_nicole: "Nicole (US, female, soft)",
    am_michael: "Michael (US, male)", am_fenrir: "Fenrir (US, male)", am_puck: "Puck (US, male)",
    bf_emma: "Emma (UK, female)", bf_isabella: "Isabella (UK, female)", bm_george: "George (UK, male)", bm_fable: "Fable (UK, male)",
  };
  const SLOW_RTF = 1.25;          // generating takes 1.25x longer than the audio lasts: too slow to sound like a conversation

  class KokoroVoice {
    constructor() {
      this.state = "idle";        // idle | loading | ready | error
      this.error = ""; this.info = null; this.progress = { loaded: 0, total: 0 }; this.files = {};
      this.lastRtf = 0; this.lastMs = 0; this.slow = false; this.worker = null; this.ctx = null;
      this.supported = typeof Worker !== "undefined" && !!(window.AudioContext || window.webkitAudioContext);
      this._id = 0; this._wait = new Map(); this._loadWait = null;
      this.onProgress = noop; this.onState = noop;
    }
    _ensureWorker() {
      if (this.worker) return this.worker;
      const w = (this.worker = (DB.makeKokoroWorker ? DB.makeKokoroWorker() : new Worker("js/kokoro-worker.js", { type: "module" })));
      w.onmessage = (e) => this._msg(e.data || {});
      w.onerror = (e) => this._fail("worker failed: " + ((e && e.message) || "error"));
      return w;
    }
    _msg(m) {
      if (m.type === "progress") {
        if (m.file) {
          const old = this.files[m.file];
          this.files[m.file] = m.status === "done" && old ? [old[1], old[1], "done"] : [m.loaded || 0, m.total || (old ? old[1] : 0), m.status];
        }
        let l = 0, t = 0;
        for (const k in this.files) { const f = this.files[k]; if (f[2] === "done" && f[1]) l += f[1]; else l += f[0]; t += f[1]; }
        this.progress = { loaded: l, total: t };
        this.onProgress(this.progress);
      } else if (m.type === "ready") {
        this.state = "ready"; this.info = { device: m.device, dtype: m.dtype, ms: m.ms, warmMs: m.warmMs }; this.error = "";
        this.onState(this.state);
        if (this._loadWait) { this._loadWait.resolve(); this._loadWait = null; }
      } else if (m.type === "audio" || (m.type === "error" && m.id != null)) {
        const w = this._wait.get(m.id);
        if (w) { this._wait.delete(m.id); m.type === "audio" ? w.resolve(m) : w.reject(new Error(m.message)); }
      } else if (m.type === "error") this._fail(m.message);
    }
    _fail(msg) {
      this.state = "error"; this.error = String(msg || "failed"); this.onState(this.state);
      if (this._loadWait) { this._loadWait.reject(new Error(this.error)); this._loadWait = null; }
      for (const w of this._wait.values()) w.reject(new Error(this.error));
      this._wait.clear();
    }
    /** Start downloading/loading the model (once). Resolves when it's ready. */
    load(device) {
      if (this.state === "ready") return Promise.resolve();
      if (this.state === "loading" && this._loadWait) return this._loadWait.promise;
      if (!this.supported) { this.state = "error"; this.error = "this browser can't run it"; return Promise.reject(new Error(this.error)); }
      this.state = "loading"; this.error = ""; this.slow = false; this.files = {}; this.onState(this.state);
      let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
      promise.catch(noop);
      this._loadWait = { promise, resolve, reject };
      try { this._ensureWorker().postMessage({ type: "load", device: device || "auto" }); } catch (e) { this._fail(e.message || e); }
      return promise;
    }
    generate(text, voice, speed) {
      const id = ++this._id;
      return new Promise((resolve, reject) => {
        this._wait.set(id, { resolve, reject });
        try { this._ensureWorker().postMessage({ type: "speak", id, text, voice, speed }); } catch (e) { this._wait.delete(id); reject(e); }
      });
    }
    /** Call from a tap: iOS only lets Web Audio make sound after one. */
    unlock() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!this.ctx) this.ctx = new AC();
        if (this.ctx.state === "suspended") this.ctx.resume().catch(noop);
        const b = this.ctx.createBuffer(1, 1, 22050), src = this.ctx.createBufferSource();
        src.buffer = b; src.connect(this.ctx.destination); src.start(0);
      } catch (e) { /* ignore */ }
    }
    statusText() {
      if (this.state === "loading") {
        const p = this.progress;
        return "downloading" + (p.total ? " " + (p.loaded / 1e6).toFixed(0) + " of " + (p.total / 1e6).toFixed(0) + " MB" : "…");
      }
      if (this.state === "error") return "failed: " + this.error;
      if (this.state === "ready") return "ready (" + this.info.device + " " + this.info.dtype + (this.lastRtf ? ", speed " + this.lastRtf.toFixed(2) + "x real time" : "") + ")" + (this.slow ? ", too slow here" : "");
      return "not downloaded";
    }
  }

  class MultiTTS {
    /** browser: a DB.BrowserTTS; getSettings(): the current settings (voiceEngine, kokoroVoice, ...). */
    constructor(browser, getSettings) {
      this.browser = browser; this.kokoro = new KokoroVoice(); this.getSettings = getSettings || (() => ({}));
      this.onStart = noop; this.onWord = noop; this.onEnd = noop; this.onVoices = noop; this.onError = noop;
      browser.onStart = () => this.onStart(); browser.onWord = () => this.onWord();
      browser.onEnd = () => this.onEnd(); browser.onVoices = () => this.onVoices(); browser.onError = (m) => this.onError(m);
      this._k = false; this._token = 0; this._src = null; this._resolve = null; this._pulse = 0;
      this._kError = ""; this._kErrorAt = 0; this._kVoice = ""; this._kStarted = 0; this.lastEngine = "";
    }
    get supported() { return this.browser.supported || this.kokoro.supported; }
    get speaking() { return this._k || this.browser.speaking; }
    get started() { return this._k ? this._kStarted : this.browser.started; }
    get voiceUsed() { return this.lastEngine === "kokoro" ? this._kVoice : this.browser.voiceUsed; }
    get lastError() { return this._kErrorAt > (this.browser.lastErrorAt || 0) ? this._kError : this.browser.lastError; }
    get lastErrorAt() { return Math.max(this._kErrorAt, this.browser.lastErrorAt || 0); }
    voices() { return this.browser.voices(); }
    unlock() { this.browser.unlock(); if (this.getSettings().voiceEngine === "kokoro") this.kokoro.unlock(); }
    _error(msg) { this._kError = msg; this._kErrorAt = Date.now(); this.onError(msg); }
    /** Use Kokoro for this reply? (chosen, loaded, and not found too slow here) */
    useKokoro(opts) {
      const s = this.getSettings();
      if ((opts && opts.engine) === "system") return false;
      if (s.voiceEngine !== "kokoro" && (opts && opts.engine) !== "kokoro") return false;
      if (this.kokoro.state === "idle") this.kokoro.load(s.kokoroDevice).catch((e) => this._error("natural voice failed to load: " + e.message));
      return this.kokoro.state === "ready" && !this.kokoro.slow;
    }
    speak(text, opts) {
      opts = opts || {};
      if (!String(text || "").trim()) return Promise.resolve();
      if (this.useKokoro(opts)) return this._speakKokoro(text, opts);
      this.lastEngine = "system";
      this._stopKokoro(false);
      return this.browser.speak(text, opts);
    }
    async _speakKokoro(text, opts) {
      this.browser.cancel();
      this._stopKokoro(true);
      const my = ++this._token, k = this.kokoro, s = this.getSettings();
      const voice = opts.kokoroVoice || s.kokoroVoice || "af_heart";
      const speed = Math.max(0.6, Math.min(1.6, +opts.rate || 1));
      const chunks = sentences(text);
      this.lastEngine = "kokoro"; this._kVoice = "Kokoro " + voice + " (natural voice)";
      this._k = true; this._kStarted = Date.now();
      this.onStart();
      k.unlock();
      const gen = (i) => k.generate(chunks[i], voice, speed);
      let pending = gen(0);
      for (let i = 0; i < chunks.length; i++) {
        let out;
        try { out = await withTimeout(pending, 20000, "the natural voice took too long"); }
        catch (e) {
          if (my !== this._token) return;
          this._error("natural voice: " + e.message + ", used the system voice");
          return this._fallback(chunks.slice(i).join(" "), opts);
        }
        if (my !== this._token) return;
        const dur = out.audio.length / (out.rate || 24000);
        k.lastMs = out.ms; k.lastRtf = dur > 0 ? out.ms / 1000 / dur : 0;
        if (i === 0 && k.lastRtf > SLOW_RTF && out.ms > 1500) {
          // Too slow on this device to keep up with a conversation: use the system voice from now on.
          k.slow = true;
          this._error("natural voice too slow here (" + k.lastRtf.toFixed(1) + "x real time), switched to the system voice");
          return this._fallback(chunks.join(" "), opts);
        }
        if (i + 1 < chunks.length) pending = gen(i + 1);
        await this._play(out, my);
        if (my !== this._token) return;
      }
      this._finish(my);
    }
    _fallback(rest, opts) {
      // Hand over to the system voice without an end/start gap that would unmute the mic.
      this._k = false; clearInterval(this._pulse);
      this.lastEngine = "system";
      const r = this._resolve; this._resolve = null;
      const p = this.browser.speak(rest, opts);
      if (r) r();
      return p;
    }
    _play(out, my) {
      return new Promise((resolve) => {
        const ctx = this.kokoro.ctx;
        if (!ctx) return resolve();
        let done = false;
        const end = () => { if (done) return; done = true; clearInterval(this._pulse); clearTimeout(t); this._src = null; this._resolve = null; resolve(); };
        this._resolve = end;
        try {
          if (ctx.state === "suspended") ctx.resume().catch(noop);
          const buf = ctx.createBuffer(1, out.audio.length, out.rate || 24000);
          buf.getChannelData(0).set(out.audio);
          const src = ctx.createBufferSource(), an = ctx.createAnalyser();
          an.fftSize = 512; src.buffer = buf; src.connect(an); an.connect(ctx.destination);
          src.onended = end; this._src = src; src.start();
          // The mouth follows the loudness of the audio.
          const data = new Float32Array(an.fftSize);
          clearInterval(this._pulse);
          this._pulse = setInterval(() => {
            if (my !== this._token) return;
            an.getFloatTimeDomainData(data);
            let sum = 0; for (let j = 0; j < data.length; j++) sum += data[j] * data[j];
            if (Math.sqrt(sum / data.length) > 0.03) this.onWord();
          }, 120);
        } catch (e) { this._error("natural voice playback failed: " + (e.message || e)); return end(); }
        var t = setTimeout(end, (out.audio.length / (out.rate || 24000)) * 1000 + 2000);   // never wait forever for onended
      });
    }
    _finish(my) {
      if (my !== this._token || !this._k) return;
      this._k = false; clearInterval(this._pulse);
      this.onEnd();
    }
    _stopKokoro(silent) {
      const was = this._k;
      this._token++;
      clearInterval(this._pulse);
      if (this._src) { try { this._src.onended = null; this._src.stop(); } catch (e) { /* ignore */ } this._src = null; }
      if (this._resolve) { const r = this._resolve; this._resolve = null; r(); }
      this._k = false;
      if (was && !silent) this.onEnd();
      return was;
    }
    cancel() {
      const was = this._stopKokoro(true);
      this.browser.cancel();
      if (was) this.onEnd();
    }
  }
  /** Sentence-sized pieces, so the first one is ready quickly; very short bits ride along with the next one. */
  function sentences(text) {
    const parts = String(text).replace(/\s+/g, " ").match(/[^.!?;:]+[.!?;:]*\s*/g) || [String(text)];
    const out = []; let cur = "";
    for (const p of parts) {
      cur += p;
      if (cur.trim().length >= 25 || cur.length > 200) { out.push(cur.trim()); cur = ""; }
    }
    if (cur.trim()) { if (out.length && cur.trim().length < 12) out[out.length - 1] += " " + cur.trim(); else out.push(cur.trim()); }
    return out.length ? out : [String(text).trim()];
  }
  function withTimeout(p, ms, msg) {
    let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
  }

  DB.KokoroVoice = KokoroVoice; DB.MultiTTS = MultiTTS; DB.KOKORO_VOICES = KOKORO_VOICES; DB.KOKORO_SLOW_RTF = SLOW_RTF; DB.kokoroSentences = sentences;
})();
