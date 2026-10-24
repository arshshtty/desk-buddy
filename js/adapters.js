/* Desk Buddy: speech adapters.
   Everything else talks to STT and TTS only through these two small interfaces, so a
   "local server" engine (faster-whisper for STT, Kokoro for TTS) can be dropped in later.

   STT interface                         TTS interface
     .supported   boolean                  .supported   boolean
     .running     boolean                  .speaking    boolean
     .start()                              .voices()    -> [{id, name, lang, isDefault}]
     .stop()                               .speak(text, {voice, rate, pitch, lang}) -> Promise (resolves when done or cancelled)
     .setLang(lang)                        .cancel()
     onResult(text, isFinal)               onStart(), onWord(), onEnd(), onVoices()
     onSpeech()   any sign of speech
     onState(state, detail)  "listening" | "idle" | "error"
*/
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});
  const noop = () => {};

  /* ---------------- Browser speech recognition (Web Speech API) ---------------- */
  class BrowserSTT {
    constructor(opts) {
      this.Impl = window.SpeechRecognition || window.webkitSpeechRecognition || null;
      this.supported = !!this.Impl;
      this.lang = (opts && opts.lang) || "en-AU";
      this.wanted = false; this.running = false;
      this.rec = null; this.backoff = 250; this.lastStart = 0; this.fatal = false;
      this.onResult = noop; this.onSpeech = noop; this.onState = noop;
      // Chrome (Android especially) ends recognition every few seconds even with continuous = true,
      // and sometimes ends without firing onend. A watchdog restarts it.
      this.watchdog = setInterval(() => {
        if (this.wanted && !this.running && Date.now() - this.lastStart > 4000) this._start();
      }, 2000);
    }
    setLang(l) { this.lang = l || this.lang; if (this.rec) this.rec.lang = this.lang; }
    start() {
      if (!this.supported) { this.onState("error", "Speech recognition isn't available in this browser"); return; }
      this.wanted = true; this.fatal = false; this.backoff = 250;
      this._start();
    }
    stop() {
      this.wanted = false;
      if (this.rec) { try { this.rec.abort(); } catch (e) { /* already stopped */ } }
    }
    _make() {
      const r = new this.Impl();
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;
      r.lang = this.lang;
      r.onstart = () => { this.running = true; this.onState("listening"); };
      r.onspeechstart = () => this.onSpeech();
      r.onresult = (ev) => {
        let interim = "", final = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (res.isFinal) final += res[0].transcript; else interim += res[0].transcript;
        }
        this.backoff = 250;
        this.onSpeech();
        if (final.trim()) this.onResult(final.trim(), true);
        else if (interim.trim()) this.onResult(interim.trim(), false);
      };
      r.onerror = (ev) => {
        const e = ev.error;
        if (e === "no-speech" || e === "aborted") return;           // normal; onend restarts
        if (e === "not-allowed" || e === "service-not-allowed") {
          this.fatal = true; this.wanted = false;
          this.onState("error", "Microphone permission was refused");
          return;
        }
        if (e === "audio-capture") this.onState("error", "No microphone found");
        else if (e === "network") this.onState("error", "Speech service unreachable (needs internet)");
        else if (e === "language-not-supported") this.onState("error", "Speech language not supported: " + this.lang);
        else this.onState("error", "Speech error: " + e);
        this.backoff = Math.min(10000, this.backoff * 3);
      };
      r.onend = () => {
        this.running = false;
        if (this.wanted && !this.fatal) setTimeout(() => this._start(), this.backoff);
        else this.onState("idle");
      };
      return r;
    }
    _start() {
      if (!this.wanted || this.running) return;
      if (!this.rec) this.rec = this._make();
      this.lastStart = Date.now();
      try { this.rec.start(); }
      catch (e) {
        // InvalidStateError: it's already running. Anything else: rebuild it next time.
        if (!(e && e.name === "InvalidStateError")) this.rec = null;
      }
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
    constructor() { this.supported = false; this.running = false; this.onResult = noop; this.onSpeech = noop; this.onState = noop; }
    setLang() {}
    start() { this.onState("error", "The local speech server isn't built yet"); }
    stop() {}
  }
  class LocalServerTTS {
    constructor() { this.supported = false; this.speaking = false; this.onStart = noop; this.onWord = noop; this.onEnd = noop; this.onVoices = noop; }
    voices() { return []; }
    speak() { return Promise.resolve(); }
    cancel() {}
  }

  DB.makeSTT = (engine, opts) => (engine === "local" ? new LocalServerSTT(opts) : new BrowserSTT(opts));
  DB.makeTTS = (engine, opts) => (engine === "local" ? new LocalServerTTS(opts) : new BrowserTTS(opts));
  DB.BrowserSTT = BrowserSTT; DB.BrowserTTS = BrowserTTS;
})();
