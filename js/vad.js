/* Desk Buddy: voice-activity detector.
   Keeps ONE microphone stream open for the whole session (opening a getUserMedia stream doesn't
   make Android beep; starting speech recognition does). It measures loudness (RMS) about 33
   times a second, tracks the room's background noise, and fires onVoiceStart only after at least
   250 ms of sound clearly above that noise. Recognition is started from there, so it isn't
   running (and beeping) all the time.

   .start() -> Promise     opens the mic (needs a tap first because of the AudioContext)
   .stop()                 closes it
   .muted                  while true nothing fires and the noise estimate isn't updated
   .inSpeech .level .floor
   .track                  audio track for recognition: a ~0.5 s delayed copy of the mic where the
                           browser can recognise from a track (desktop Chrome 135+), else null
   onVoiceStart(), onVoiceEnd(), onLevel(rms)
*/
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});
  const noop = () => {};

  class VoiceDetector {
    constructor(opts) {
      opts = opts || {};
      this.frameMs = opts.frameMs || 30;
      this.minSpeechMs = opts.minSpeechMs || 250;   // sound must last this long to count as speech
      this.gapMs = opts.gapMs || 120;               // short dips allowed while building up to onset
      this.hangoverMs = opts.hangoverMs || 700;     // quiet this long ends the speech
      this.factor = opts.factor || 3;               // onset threshold = noise floor x factor
      this.minLevel = opts.minLevel || 0.006;       // never trigger below this RMS
      this.preRollMs = opts.preRollMs == null ? 500 : opts.preRollMs;
      this.running = false; this.muted = false; this.inSpeech = false;
      this.level = 0; this.floor = 0.004; this.calibrated = 0;
      this.stream = null; this.ctx = null; this.analyser = null; this.timer = 0; this.track = null;
      this._above = 0; this._gap = 0; this._quiet = 0; this.onsets = 0;
      this.onVoiceStart = noop; this.onVoiceEnd = noop; this.onLevel = noop;
    }
    get supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext)); }
    async start() {
      if (this.running) { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(noop); return; }
      if (!this.supported) throw new Error("This browser can't open the microphone");
      // Create the AudioContext before awaiting anything, while the tap still counts as a user gesture.
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      if (ctx.state === "suspended") ctx.resume().catch(noop);
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
          video: false,
        });
      } catch (e) { ctx.close().catch(noop); throw e; }
      this.ctx = ctx;
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);                   // not connected to the speakers
      this.buf = new Float32Array(this.analyser.fftSize);
      // Pre-roll: recognition can't be handed audio from the past, but desktop Chrome can recognise
      // from a track. Feeding it a delayed copy means the 250 ms used to detect speech isn't lost.
      // Android Chrome can't use a track yet, so there it hears the live mic and may miss the first syllable.
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
      this.running = true; this.calibrated = 0;
      this.timer = setInterval(() => this._tick(), this.frameMs);
    }
    stop() {
      clearInterval(this.timer); this.timer = 0;
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.ctx) this.ctx.close().catch(noop);
      this.stream = this.ctx = this.analyser = this.track = null;
      this.running = false; this._reset();
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
    get threshold() { return Math.max(this.floor * this.factor, this.floor + 0.004, this.minLevel); }
    _tick() {
      if (!this.analyser) return;
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(noop);
      const v = this.rms(), dt = this.frameMs;
      this.level = v; this.onLevel(v);
      if (this.calibrated < 300) {                  // first 0.3 s: learn the room quickly
        this.floor = this.calibrated === 0 ? Math.max(v, 0.0005) : this.floor + (v - this.floor) * 0.3;
        this.calibrated += dt; return;
      }
      if (this.muted) return;
      const on = this.threshold, off = Math.max(this.floor * 2, this.minLevel * 0.7);
      if (!this.inSpeech) {
        if (v > on) { this._above += dt; this._gap = 0; }
        else {
          this._gap += dt;
          if (this._gap > this.gapMs) this._above = 0;
          // Adaptive noise floor: follows quiet quickly, rises slowly (a fan switching on is
          // learned in a few seconds; a voice is too short to drag it up).
          if (this._above === 0) {
            const k = v < this.floor ? 0.15 : 0.02;
            this.floor = Math.min(0.2, Math.max(0.0005, this.floor + (v - this.floor) * k));
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
  DB.VoiceDetector = VoiceDetector;
})();
