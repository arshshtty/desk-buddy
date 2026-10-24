/* Desk Buddy: the Claude "brain". Calls the Anthropic Messages API straight from the browser.
   The API key comes from localStorage and is only ever put in the x-api-key header; it is never logged. */
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});

  const API_URL = "https://api.anthropic.com/v1/messages";
  const TOOLS = [
    {
      name: "save_note",
      description: "Save a short note on this device for the user, e.g. when they say 'note that', 'remember to', 'add to my list'.",
      input_schema: { type: "object", properties: { text: { type: "string", description: "The note, in the user's words" } }, required: ["text"] },
    },
    {
      name: "list_notes",
      description: "Get the user's saved notes, newest last, to read them out or answer questions about them.",
      input_schema: { type: "object", properties: {} },
    },
  ];

  class BrainError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; }
  }

  /** Text for speaking: drop markdown and the leading [mood] tag. */
  function parseReply(raw) {
    let text = String(raw || "").trim();
    let mood = null;
    const m = text.match(/^\s*\[([a-zA-Z]+)\]\s*/);
    if (m) { mood = DB.normMood ? DB.normMood(m[1]) : m[1].toLowerCase(); text = text.slice(m[0].length); }
    text = text.replace(/\[(neutral|happy|curious|surprised|thinking|sleepy|angry)\]/gi, "")
               .replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
    return { text, mood };
  }

  class Brain {
    constructor(getSettings, getKey, notes) {
      this.getSettings = getSettings;
      this.getKey = getKey;
      this.notes = notes;                // {add(text), list()}
      this.history = [];
      this.busy = false;
      this.fetch = (...a) => window.fetch(...a);   // looked up at call time, so tests can mock window.fetch
    }
    forget() { this.history = []; }

    _system(s) {
      const now = new Date();
      return s.system + "\n\nCurrent local date and time: " + now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }) +
        ". The user has " + this.notes.list().length + " saved notes.";
    }

    async _post(body, signal) {
      const key = this.getKey();
      if (!key) throw new BrainError("nokey", "No Claude API key yet. Add one in settings.");
      let res;
      try {
        res = await this.fetch(API_URL, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (e && e.name === "AbortError") throw new BrainError("timeout", "Claude took too long to answer.");
        throw new BrainError("network", "I couldn't reach Claude. Check the internet connection.");
      }
      if (!res.ok) {
        let detail = "";
        try { const j = await res.json(); detail = (j && j.error && j.error.message) || ""; } catch (e) { /* not JSON */ }
        const kind = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate" :
                     res.status === 529 || res.status >= 500 ? "overloaded" : "bad";
        const msg = { auth: "My API key was refused. Check it in settings.", rate: "I'm being rate limited. Try again in a moment.",
                      overloaded: "Claude is busy right now. Try again in a moment.", bad: "Claude said the request was invalid" }[kind];
        throw new BrainError(kind, msg + (kind === "bad" && detail ? ": " + detail : "."));
      }
      return res.json();
    }

    _runTool(name, input) {
      if (name === "save_note") {
        const n = this.notes.add(input && input.text);
        return n ? "Saved note: " + n.text : "Nothing to save.";
      }
      if (name === "list_notes") {
        const list = this.notes.list();
        return list.length ? list.map((n, i) => (i + 1) + ". " + n.text).join("\n") : "No notes saved.";
      }
      return "Unknown tool " + name;
    }

    /**
     * Ask Claude. Returns {text, mood, raw}. `image` is optional base64 JPEG.
     */
    async ask(text, image) {
      const s = this.getSettings();
      const userContent = [];
      if (image) userContent.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
      userContent.push({ type: "text", text: text || "What do you see?" });

      const keep = Math.max(0, (s.memory | 0) * 2);
      const past = keep ? this.history.slice(-keep) : [];
      while (past.length && past[0].role !== "user") past.shift();
      const messages = past.map((m) => ({ role: m.role, content: m.content })).concat([{ role: "user", content: userContent }]);

      const body = { model: s.model || DB.store.DEFAULTS.model, max_tokens: 1024, system: this._system(s), tools: TOOLS, messages };
      if (s.effort) body.output_config = { effort: s.effort };

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      this.busy = true;
      try {
        let rawText = "";
        for (let round = 0; round < 4; round++) {
          const data = await this._post(body, ctrl.signal);
          const blocks = Array.isArray(data.content) ? data.content : [];
          rawText += blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
          const uses = blocks.filter((b) => b.type === "tool_use");
          if (data.stop_reason !== "tool_use" || !uses.length) break;
          // Send the assistant turn back unchanged (thinking blocks included), then the tool results.
          body.messages = body.messages.concat([
            { role: "assistant", content: blocks },
            { role: "user", content: uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: this._runTool(u.name, u.input) })) },
          ]);
        }
        const reply = parseReply(rawText);
        if (!reply.text) reply.text = "Hmm.";
        // Rolling memory keeps plain text only; images aren't re-sent.
        this.history.push({ role: "user", content: (image ? "[showed you a camera picture] " : "") + (text || "What do you see?") });
        this.history.push({ role: "assistant", content: (reply.mood ? "[" + reply.mood + "] " : "") + reply.text });
        if (this.history.length > 40) this.history = this.history.slice(-40);
        return { text: reply.text, mood: reply.mood, raw: rawText };
      } finally {
        clearTimeout(timer);
        this.busy = false;
      }
    }
  }

  DB.Brain = Brain;
  DB.BrainError = BrainError;
  DB.parseReply = parseReply;
})();
