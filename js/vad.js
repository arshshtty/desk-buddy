/* Desk Buddy: voice-activity detector (and the microphone capture for on-device Whisper).
   Keeps ONE microphone stream open for the whole session (opening a getUserMedia stream doesn't
   make Android beep; starting speech recognition does). It measures loudness (RMS) about 33
   times a second, tracks the room's background noise, and fires onVoiceStart only after at least
   250 ms of sound clearly above that noise.

   .start() -> Promise     opens the mic (needs a tap first because of the AudioContext)
   .stop()                 closes it
   .muted                  while true nothing fires and the noise estimate isn't updated
   .inSpeech .level .floor .threshold .peak (recent loudest level)
   .sensitivity 1..10      higher = triggers on quieter speech (default 6)
   .processing             "balanced" (echo cancel + auto gain, default) | "full" (+ noise suppression) | "raw" (echo cancel only)
   .calibration {noise, speech}  measured levels; when set, the threshold sits between them
   .track                  audio track for recognition: a ~0.5 s delayed copy of the mic where the
                           browser can recognise from a track (desktop Chrome 135+), else null
   .capture = true         also copy raw audio (AudioWorklet, ScriptProcessor fallback) so an
                           utterance can be cut out with beginCapture()/endCapture(), including
                           ~0.8 s from before the onset (pre-roll)
   onVoiceStart(), onVoiceEnd(), onLevel(rms)
*/
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});
  const noop = () => {};
  const lerp = (a, b, t) => a + (b - a) * t;

  const PROCESSING = {
    balanced: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
    full: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    raw: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  };

  class VoiceDetector {
    constructor(opts) {
      opts = opts || {};
      this.frameMs = opts.frameMs || 30;
      this.minSpeechMs = opts.minSpeechMs || 250;   // sound must last this long to count as speech
      this.gapMs = opts.gapMs || 120;               // short dips allowed while building up to onset
      this.hangoverMs = opts.hangoverMs || 700;     // quiet this long ends the speech
      this.preRollMs = opts.preRollMs == null ? 500 : opts.preRollMs;
      this.sensitivity = 6;
      this.processing = "balanced";
      this.calibration = null;
      this.capture = false;
      this.running = false; this.muted = false; this.inSpeech = false;
      this.level = 0; this.floor = 0.004; this.calibrated = 0; this.peak = 0;
      this.stream = null; this.ctx = null; this.analyser = null; this.timer = 0; this.track = null;
      this._above = 0; this._gap = 0; this._quiet = 0; this.onsets = 0;
      this.ring = []; this.ringFrames = 0; this.rec = null; this.captureKind = "";
      this.onVoiceStart = noop; this.onVoiceEnd = noop; this.onLevel = noop;
    }
    get supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext)); }
    /* Sensitivity 1..10 sets how far above the noise floor speech must be. */
    get factor() { return lerp(4, 1.7, (this.sensitivity - 1) / 9); }
    get minLevel() {
      if (this.calibration && this.calibration.speech > this.calibration.noise * 1.5) {
        // halfway (on a log scale) between the measured room noise and your measured voice
        return Math.max(0.0006, Math.sqrt(this.calibration.noise * this.calibration.speech) * lerp(1.3, 0.6, (this.sensitivity - 1) / 9));
      }
      return lerp(0.008, 0.0012, (this.sensitivity - 1) / 9);
    }
    get threshold() {
      return Math.max(this.floor * this.factor, this.floor + lerp(0.005, 0.0008, (this.sensitivity - 1) / 9), this.minLevel);
    }
    get offLevel() { return Math.max(this.floor * Math.max(1.4, this.factor * 0.66), this.minLevel * 0.7); }

    async start() {
      if (this.running) { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(noop); return; }
      if (!this.supported) throw new Error("This browser can't open the microphone");
      // Create the AudioContext before awaiting anything, while the tap still counts as a user gesture.
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      if (ctx.state === "suspended") ctx.resume().catch(noop);
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: Object.assign({ channelCount: 1 }, PROCESSING[this.processing] || PROCESSING.balanced),
          video: false,
        });
      } catch (e) { ctx.close().catch(noop); throw e; }
      this.ctx = ctx;
      const src = (this.src = this.ctx.createMediaStreamSource(this.stream));
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);                   // not connected to the speakers
      this.buf = new Float32Array(this.analyser.fftSize);
      // Pre-roll for Web Speech: recognition can't be handed audio from the past, but desktop Chrome can
      // recognise from a track. Feeding it a delayed copy means the 250 ms used to detect speech isn't lost.
      this.track = null;
      const canTrack = !/Android/i.test(navigator.userAgent) && this.preRollMs > 0 && this.ctx.createMediaStreamDestination;
      if (canTrack) {
        try {
          const delay = this.ctx.createDelay(2);
          delay.delayTime.value = this.preRollMs / 1000;
          const dest = this.ctx.createMediaStreamDestination();
          src.connect(delay); delay.connect(dest);
          this.track = dest.stream.getAudioTracks()[0] || null;
        } catch (e) { this.track = null; }
      }
      this.running = true; this.calibrated = 0; this.peak = 0;
      this.timer = setInterval(() => this._tick(), this.frameMs);
      if (this.capture) await this._startCapture();
    }
    stop() {
      clearInterval(this.timer); this.timer = 0;
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.node) { try { this.node.disconnect(); } catch (e) { /* gone */ } }
      if (this.ctx) this.ctx.close().catch(noop);
      this.stream = this.ctx = this.analyser = this.track = this.src = this.node = null;
      this.ring = []; this.ringFrames = 0; this.rec = null; this.captureKind = "";
      this.running = false; this._reset();
    }
    get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

    /* ---- raw capture for Whisper ---- */
    async _startCapture() {
      const ctx = this.ctx, src = this.src;
      if (!ctx || this.node) return;
      const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);   // keeps the node pulled; silent
      const onChunk = (f32) => this._chunk(f32);
      try {
        if (!ctx.audioWorklet || !window.AudioWorkletNode) throw new Error("no worklet");
        await ctx.audioWorklet.addModule(new URL("js/capture-worklet.js", document.baseURI).href);
        if (this.ctx !== ctx) return;
        const node = new AudioWorkletNode(ctx, "deskbuddy-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        node.port.onmessage = (e) => onChunk(e.data);
        src.connect(node); node.connect(sink);
        this.node = node; this.captureKind = "AudioWorklet";
      } catch (e) {
        const sp = ctx.createScriptProcessor(4096, 1, 1);
        sp.onaudioprocess = (ev) => onChunk(new Float32Array(ev.inputBuffer.getChannelData(0)));
        src.connect(sp); sp.connect(sink);
        this.node = sp; this.captureKind = "ScriptProcessor";
      }
    }
    _chunk(f32) {
      if (this.rec) {
        this.rec.push(f32); this.recFrames += f32.length;
        if (this.recFrames > this.sampleRate * 20) this.rec.shift();   // hard cap
      }
      this.ring.push(f32); this.ringFrames += f32.length;
      const keep = this.sampleRate * 0.9;
      while (this.ringFrames - this.ring[0].length > keep) this.ringFrames -= this.ring.shift().length;
    }
    /** Start keeping audio, beginning with the ~0.8 s before now. */
    beginCapture() { this.rec = this.ring.slice(); this.recFrames = this.ringFrames; return !!this.node; }
    /** Stop keeping audio; returns it as 16 kHz mono Float32Array (or null if nothing was captured). */
    endCapture() {
      const parts = this.rec; this.rec = null;
      if (!parts || !parts.length) return null;
      let n = 0; for (const p of parts) n += p.length;
      const all = new Float32Array(n); let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      return VoiceDetector.resample(all, this.sampleRate, 16000);
    }
    cancelCapture() { this.rec = null; }
    get capturing() { return !!this.rec; }
    static resample(x, from, to) {
      if (from === to) return x;
      const ratio = from / to, n = Math.floor(x.length / ratio), out = new Float32Array(n);
      for (let i = 0; i < n; i++) {                 // box filter over each output sample's span (anti-aliasing)
        const a = Math.floor(i * ratio), b = Math.min(x.length, Math.floor((i + 1) * ratio));
        let s = 0; for (let j = a; j < b; j++) s += x[j];
        out[i] = b > a ? s / (b - a) : x[a] || 0;
      }
      return out;
    }

    /* ---- calibration: measure the room, then your voice ---- */
    async measure(ms) {
      const vals = [];
      const t0 = Date.now();
      await new Promise((res) => { const iv = setInterval(() => { vals.push(this.level); if (Date.now() - t0 >= ms) { clearInterval(iv); res(); } }, this.frameMs); });
      vals.sort((a, b) => a - b);
      const q = (p) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] || 0;
      return { p20: q(0.2), p50: q(0.5), p90: q(0.9) };
    }

    setMuted(m) {
      m = !!m;
      if (m === this.muted) return;
      this.muted = m;
      this._reset();                                // speech must start fresh after the mute ends
    }
    _reset() {
      const was = this.inSpeech;
      this.inSpeech = false; this._above = this._gap = this._quiet = 0;
      if (was) this.onVoiceEnd();
    }
    rms() {
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      return Math.sqrt(sum / this.buf.length);
    }
    _tick() {
      if (!this.analyser) return;
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(noop);
      const v = this.rms(), dt = this.frameMs;
      this.level = v; this.peak = Math.max(v, this.peak * 0.995); this.onLevel(v);
      if (this.calibrated < 300) {                  // first 0.3 s: learn the room quickly
        this.floor = this.calibrated === 0 ? Math.max(v, 0.0003) : this.floor + (v - this.floor) * 0.3;
        this.calibrated += dt; return;
      }
      if (this.muted) return;
      const on = this.threshold, off = this.offLevel;
      if (!this.inSpeech) {
        if (v > on) { this._above += dt; this._gap = 0; }
        else {
          this._gap += dt;
          if (this._gap > this.gapMs) this._above = 0;
          // Adaptive noise floor: follows quiet quickly, rises slowly (a fan switching on is
          // learned in a few seconds; a voice is too short to drag it up).
          if (this._above === 0) {
            const k = v < this.floor ? 0.15 : 0.02;
            this.floor = Math.min(0.2, Math.max(0.0003, this.floor + (v - this.floor) * k));
          }
        }
        if (this._above >= this.minSpeechMs) {
          this.inSpeech = true; this._quiet = 0; this._speechMs = 0; this.onsets++;
          this.onVoiceStart();
        }
      } else {
        if (v < off) this._quiet += dt; else this._quiet = 0;
        this._speechMs = (this._speechMs || 0) + dt;
        if (this._speechMs > 10000) this.floor = Math.min(0.2, this.floor + (v - this.floor) * 0.003);  // constant noise, not a voice
        if (this._quiet >= this.hangoverMs) { this.inSpeech = false; this._above = 0; this.onVoiceEnd(); }
      }
    }
  }
  VoiceDetector.PROCESSING = PROCESSING;
  DB.VoiceDetector = VoiceDetector;
})();
