/* Desk Buddy: settings, API key and notes, all kept in this browser's localStorage. */
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});

  const K_SETTINGS = "deskbuddy.settings.v1";
  const K_KEY = "deskbuddy.apiKey";
  const K_NOTES = "deskbuddy.notes.v1";
  const K_STRATEGY = "deskbuddy.srStrategy";   // what worked for Web Speech on this device

  const DEFAULT_SYSTEM =
    "You are Desk Buddy, a small round-eyed robot that lives on Vivek's desk. " +
    "You are curious, warm and a little cheeky. Your replies are spoken aloud by a text-to-speech voice, so: " +
    "keep them short (one to three sentences), use plain conversational words, no markdown, no lists, no emoji, " +
    "and spell out symbols. If you're shown a camera image, describe only what matters for the question. " +
    "Start every reply with your mood in square brackets, one of: [neutral] [happy] [curious] [surprised] [thinking] [sleepy] [angry]. " +
    "Use the save_note tool when asked to remember or note something, and list_notes when asked about notes.";

  const DEFAULTS = {
    model: "claude-sonnet-5-5",
    effort: "low",
    system: DEFAULT_SYSTEM,
    memory: 6,
    v: 4,                    // settings version (for migrations)
    face: "sphere",          // "sphere" (default) or "eye" (Classic eye)
    name: "Buddy",           // shown in the captions as "Buddy: ..."
    wakeWord: "Jarvis",
    listenMode: "always",    // "always" (voice-activated), "tap" (tap to talk only), "off"
    lang: navigator.language || "en-AU",
    followUp: 8,
    voiceURI: "",
    rate: 1.05,
    pitch: 1.1,
    camera: "user",          // camera on at start: "user" (front), "environment" (back) or "off"
    motion: true,            // eyes follow motion / a face
    preview: false,
    faceDetect: true,        // use the browser's FaceDetector where it exists (on-device)
    greetHi: false,          // say "hi" when someone comes back (at most every greetMinutes)
    greetMinutes: 10,
    glances: "off",          // curious glances: "off" | "show" | "speak" (sends one small photo to Claude)
    glanceMinutes: 10,
    sttEngine: "auto",       // "auto" (Web Speech with fallbacks) | "browser" (Web Speech) | "whisper" (on-device)
    whisperModel: "Xenova/whisper-tiny.en",
    srMode: "auto",          // Web Speech mic strategy: "auto" | "shared" | "release" | "continuous"
    sensitivity: 6,          // voice detector, 1..10
    micProcessing: "balanced",
    micCal: null,            // {noise, speech} measured by "Calibrate microphone"
    diagnostics: true,
    ttsEngine: "browser",
    localUrl: "",
    wakeLock: true,
    sleepyMinutes: 3,
  };

  function safeParse(s, fallback) {
    try { const v = JSON.parse(s); return v == null ? fallback : v; } catch (e) { return fallback; }
  }

  DB.store = {
    DEFAULTS,
    DEFAULT_SYSTEM,
    loadSettings() {
      const saved = safeParse(localStorage.getItem(K_SETTINGS), {});
      // v1 had a checkbox "alwaysListen" instead of listenMode.
      if (saved.listenMode == null && saved.alwaysListen === false) saved.listenMode = "tap";
      delete saved.alwaysListen; delete saved.barge;
      const s = Object.assign({}, DEFAULTS, saved);
      if (!["always", "tap", "off"].includes(s.listenMode)) s.listenMode = "always";
      // v4: the Round ball was replaced by the Sphere; the camera is on at start; Web Speech becomes "auto".
      if (!(saved.v >= 4)) {
        if (s.camera === "off") s.camera = "user";
        if (s.sttEngine === "browser" || s.sttEngine === "local") s.sttEngine = "auto";
        s.v = 4;
      }
      if (s.face !== "eye") s.face = "sphere";
      if (!["auto", "browser", "whisper"].includes(s.sttEngine)) s.sttEngine = "auto";
      if (!["auto", "shared", "release", "continuous"].includes(s.srMode)) s.srMode = "auto";
      if (!["off", "show", "speak"].includes(s.glances)) s.glances = "off";
      s.sensitivity = Math.max(1, Math.min(10, +s.sensitivity || 6));
      return s;
    },
    saveSettings(s) {
      const copy = {};
      for (const k of Object.keys(DEFAULTS)) copy[k] = s[k];   // only known keys, never the API key
      localStorage.setItem(K_SETTINGS, JSON.stringify(copy));
    },
    learnedStrategy() { return localStorage.getItem(K_STRATEGY) || ""; },
    setLearnedStrategy(v) { if (v) localStorage.setItem(K_STRATEGY, v); else localStorage.removeItem(K_STRATEGY); },
    getKey() { return localStorage.getItem(K_KEY) || ""; },
    setKey(k) { if (k) localStorage.setItem(K_KEY, k.trim()); },
    clearKey() { localStorage.removeItem(K_KEY); },

    notes() { return safeParse(localStorage.getItem(K_NOTES), []); },
    addNote(text) {
      const t = String(text || "").trim();
      if (!t) return null;
      const list = this.notes();
      const n = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: t, at: new Date().toISOString() };
      list.push(n);
      localStorage.setItem(K_NOTES, JSON.stringify(list));
      return n;
    },
    deleteNote(id) {
      localStorage.setItem(K_NOTES, JSON.stringify(this.notes().filter((n) => n.id !== id)));
    },
    clearNotes() { localStorage.removeItem(K_NOTES); },
    notesMarkdown() {
      const lines = ["# Desk Buddy notes", "", "Exported " + new Date().toLocaleString(), ""];
      for (const n of this.notes()) lines.push("- " + n.text.replace(/\n+/g, " ") + " _(" + new Date(n.at).toLocaleString() + ")_");
      return lines.join("\n") + "\n";
    },
  };
})();
