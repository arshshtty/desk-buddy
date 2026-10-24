/* Desk Buddy: speech adapters.
   Everything else talks to STT and TTS only through these two small interfaces, so a
   "local server" engine (faster-whisper for STT, Kokoro for TTS) can be dropped in later.

   STT interface                         TTS interface
     .supported   boolean                  .supported   boolean
     .running     boolean                  .speaking    boolean
     .start({track}) one session          .voices()    -> [{id, name, lang, isDefault}]
     .stop() .abort()                      .speak(text, {voice, rate, pitch, lang}) -> Promise (resolves when done or cancelled)
     .setLang(lang)                        .cancel()
     onEnd(gotResult)
     onResult(text, isFinal)               onStart(), onWord(), onEnd(), onVoices()
     onSpeech()   any sign of speech
     onState(state, detail, code)  "listening" | "idle" | "error"
     onEvent(name) every raw recognition event, for the diagnostics strip
   js/whisper.js adds a third STT engine (on-device Whisper) with the same interface.
*/
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});
  const noop = () => {};

  /* ---------------- Browser speech recognition (Web Speech API) ----------------
     One session per utterance: start() is called when the voice detector hears speech (or on a
     tap), the session ends by itself after the utterance, and nothing restarts it. There is no
     restart loop or watchdog any more: on Android every start plays a system sound, so the
     number of starts is kept as low as possible. */
  class BrowserSTT {
    constructor(opts) {
      this.Impl = window.SpeechRecognition || window.webkitSpeechRecognition || null;
      this.supported = !!this.Impl;
      this.lang = (opts && opts.lang) || "en-AU";
      this.running = false; this.rec = null; this.fatal = false;
      this.starts = 0; this.lastStart = 0; this.gotResult = false; this.maxTimer = 0; this.source = "";
      this.onResult = noop; this.onSpeech = noop; this.onState = noop; this.onEnd = noop; this.onEvent = noop;
    }
    get kind() { return "browser"; }
    setLang(l) { this.lang = l || this.lang; if (this.rec) this.rec.lang = this.lang; }
    /** Start one recognition session. opts.track: optional audio MediaStreamTrack (Chrome 135+ desktop)
        so recognition can hear a slightly delayed copy of the mic, which keeps the first syllable. */
    start(opts) {
      opts = opts || {};
      if (!this.supported) { this.onState("error", "Speech recognition isn't available in this browser", "unsupported"); return false; }
      if (this.fatal || this.running) return false;
      const r = this._make(!!opts.continuous);
      this.rec = r; this.gotResult = false; this.source = opts.source || "";
      this.lastStart = Date.now(); this.starts++;
      this.running = true;                       // set now so nothing else starts a second session
      let ok = false;
      this.usedTrack = false;
      if (opts.track && opts.track.readyState === "live") { try { r.start(opts.track); ok = true; this.usedTrack = true; } catch (e) { /* not supported: use the mic */ } }
      if (!ok) { try { r.start(); ok = true; } catch (e) { ok = false; this.onEvent("start-failed: " + (e && e.name)); } }
      if (!ok) { this.running = false; this.rec = null; return false; }
      clearTimeout(this.maxTimer);
      if (!opts.continuous) this.maxTimer = setTimeout(() => this.stop(), opts.maxMs || 15000);   // never leave it open long
      return true;
    }
    /** Stop listening but return what was heard. */
    stop() { if (this.rec && this.running) { try { this.rec.stop(); } catch (e) { /* already stopped */ } } }
    /** Stop now and throw away anything heard (used when Buddy starts talking). */
    abort() { if (this.rec && this.running) { try { this.rec.abort(); } catch (e) { /* already stopped */ } } }
    _make(continuous) {
      const r = new this.Impl();
      r.continuous = !!continuous;               // normally false: end by itself after one utterance
      r.interimResults = true;
      r.maxAlternatives = 1;
      r.lang = this.lang;
      r.onstart = () => { if (r === this.rec) { this.onEvent("start"); this.onState("listening"); } };
      r.onaudiostart = () => { if (r === this.rec) this.onEvent("audiostart"); };
      r.onsoundstart = () => { if (r === this.rec) this.onEvent("soundstart"); };
      r.onspeechstart = () => { if (r === this.rec) this.onEvent("speechstart"); this.onSpeech(); };
      r.onnomatch = () => { if (r === this.rec) this.onEvent("nomatch"); };
      r.onresult = (ev) => {
        if (r !== this.rec) return;
        let interim = "", final = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (res.isFinal) final += res[0].transcript; else interim += res[0].transcript;
        }
        this.onSpeech();
        this.onEvent(final.trim() ? "result (final)" : "result");
        if (final.trim()) { this.gotResult = true; this.onResult(final.trim(), true); }
        else if (interim.trim()) this.onResult(interim.trim(), false);
      };
      r.onerror = (ev) => {
        const e = ev.error;
        if (r === this.rec) this.onEvent("error: " + e);
        if (e === "no-speech" || e === "aborted") return;           // normal
        // The app decides what's fatal: on some phones "not-allowed"/"audio-capture" only mean the mic is busy.
        if (e === "not-allowed" || e === "service-not-allowed") this.onState("error", "Microphone permission was refused", e);
        else if (e === "audio-capture") this.onState("error", "No microphone found", e);
        else if (e === "network") this.onState("error", "Speech service unreachable (needs internet)", e);
        else if (e === "language-not-supported") this.onState("error", "Speech language not supported: " + this.lang, e);
        else this.onState("error", "Speech error: " + e, e);
      };
      r.onend = () => {
        if (r !== this.rec) return;
        clearTimeout(this.maxTimer);
        this.running = false; this.rec = null;
        this.onEvent("end");
        this.onState("idle");
        this.onEnd(this.gotResult);              // no restart: the next voice onset starts a new session
      };
      return r;
    }
  }

  /* ---------------- Browser speech synthesis ---------------- */
  class BrowserTTS {
    constructor() {
      this.synth = window.speechSynthesis || null;
      this.supported = !!(this.synth && window.SpeechSynthesisUtterance);
      this.speaking = false; this.token = 0; this.keepAlive = 0; this.resolveCurrent = null;
      this.onStart = noop; this.onWord = noop; this.onEnd = noop; this.onVoices = noop;
      if (this.supported) {
        this.synth.addEventListener ? this.synth.addEventListener("voiceschanged", () => this.onVoices())
                                    : (this.synth.onvoiceschanged = () => this.onVoices());
      }
    }
    voices() {
      if (!this.supported) return [];
      return this.synth.getVoices().map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, isDefault: v.default, local: v.localService }));
    }
    _chunks(text) {
      // Chrome cuts long utterances off after about 15 s, so speak sentence-sized pieces.
      const parts = String(text).replace(/\s+/g, " ").match(/[^.!?;:]+[.!?;:]*\s*/g) || [String(text)];
      const out = []; let cur = "";
      for (const p of parts) {
        if ((cur + p).length > 180 && cur) { out.push(cur.trim()); cur = ""; }
        cur += p;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    }
    speak(text, opts) {
      opts = opts || {};
      if (!this.supported || !String(text || "").trim()) return Promise.resolve();
      this.cancel();
      const my = ++this.token;
      const voice = this.synth.getVoices().find((v) => v.voiceURI === opts.voice) || null;
      const chunks = this._chunks(text);
      this.speaking = true;
      this.onStart();
      clearInterval(this.keepAlive);
      this.keepAlive = setInterval(() => { if (this.synth.speaking) this.synth.resume(); }, 8000);  // desktop Chrome stall workaround
      return new Promise((resolve) => {
        this.resolveCurrent = resolve;
        const finish = () => {
          if (my !== this.token) return;
          clearInterval(this.keepAlive);
          this.speaking = false; this.resolveCurrent = null;
          this.onEnd(); resolve();
        };
        let i = 0;
        const next = () => {
          if (my !== this.token) return;
          if (i >= chunks.length) return finish();
          const u = new SpeechSynthesisUtterance(chunks[i++]);
          if (voice) { u.voice = voice; u.lang = voice.lang; } else if (opts.lang) u.lang = opts.lang;
          u.rate = opts.rate || 1; u.pitch = opts.pitch == null ? 1 : opts.pitch;
          u.onboundary = (e) => { if (e.name === "word" || e.name === undefined) this.onWord(); };
          u.onend = next;
          u.onerror = (e) => { if (e.error === "interrupted" || e.error === "canceled") return; next(); };
          this.synth.speak(u);
        };
        next();
      });
    }
    cancel() {
      if (!this.supported) return;
      const wasSpeaking = this.speaking;
      this.token++;
      clearInterval(this.keepAlive);
      try { this.synth.cancel(); } catch (e) { /* ignore */ }
      this.speaking = false;
      if (this.resolveCurrent) { const r = this.resolveCurrent; this.resolveCurrent = null; r(); }
      if (wasSpeaking) this.onEnd();
    }
  }

  /* ---------------- Local server stubs (not built yet) ----------------
     Planned protocol, so the server can be written later:
       STT: stream or POST 16 kHz mono audio to  {url}/stt   -> {"text": "...", "final": true}
       TTS: POST {"text": "...", "voice": "af_heart"} to {url}/tts -> audio/wav, played via an <audio> element
     The settings page shows the URL field disabled until this exists. */
  class LocalServerSTT {
    constructor() { this.supported = false; this.running = false; this.starts = 0; this.onResult = noop; this.onSpeech = noop; this.onState = noop; this.onEnd = noop; this.onEvent = noop; }
    get kind() { return "local"; }
    setLang() {}
    start() { this.onState("error", "The local speech server isn't built yet"); return false; }
    stop() {}
    abort() {}
  }
  class LocalServerTTS {
    constructor() { this.supported = false; this.speaking = false; this.onStart = noop; this.onWord = noop; this.onEnd = noop; this.onVoices = noop; }
    voices() { return []; }
    speak() { return Promise.resolve(); }
    cancel() {}
  }

  DB.makeSTT = (engine, opts) => (engine === "local" ? new LocalServerSTT(opts)
    : engine === "whisper" && DB.WhisperSTT ? new DB.WhisperSTT(opts) : new BrowserSTT(opts));
  DB.makeTTS = (engine, opts) => (engine === "local" ? new LocalServerTTS(opts) : new BrowserTTS(opts));
  DB.BrowserSTT = BrowserSTT; DB.BrowserTTS = BrowserTTS;
})();
