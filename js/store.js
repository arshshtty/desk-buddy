/* Desk Buddy: settings, API key and notes, all kept in this browser's localStorage. */
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});

  const K_SETTINGS = "deskbuddy.settings.v1";
  const K_KEY = "deskbuddy.apiKey";
  const K_NOTES = "deskbuddy.notes.v1";

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
    wakeWord: "Jarvis",
    alwaysListen: true,
    lang: navigator.language || "en-AU",
    barge: "wake",
    followUp: 8,
    voiceURI: "",
    rate: 1.05,
    pitch: 1.1,
    camera: "off",
    motion: true,
    preview: false,
    sttEngine: "browser",
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
      return Object.assign({}, DEFAULTS, saved);
    },
    saveSettings(s) {
      const copy = {};
      for (const k of Object.keys(DEFAULTS)) copy[k] = s[k];   // only known keys, never the API key
      localStorage.setItem(K_SETTINGS, JSON.stringify(copy));
    },
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
