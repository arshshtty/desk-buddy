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

  /** Turn an HTTP error from the Messages API into a short message Buddy can say. */
  function classify(status, type, detail, model) {
    const d = String(detail || "");
    const short = d.length > 160 ? d.slice(0, 157) + "…" : d;
    let e;
    if (status === 401) e = new BrainError("auth", "My Claude API key was refused. Check it in settings.");
    else if (status === 403) e = new BrainError("auth", "My Claude API key isn't allowed to do that" + (short ? ": " + short : "."));
    else if (status === 429) e = new BrainError("rate", "I'm being rate limited by Claude. Try again in a moment.");
    else if (status === 404 || type === "not_found_error" || /model/i.test(d) && /not.?found|does not exist|invalid model|unknown model/i.test(d))
      e = new BrainError("model", "Claude doesn't know the model \u201c" + model + "\u201d. Pick another one in settings.");
    else if (status === 400 && /effort|output_config/i.test(d)) e = new BrainError("effort", "Claude rejected the effort setting: " + short);
    else if (status === 529 || status >= 500) e = new BrainError("overloaded", "Claude is busy right now. Try again in a moment.");
    else if (status === 413) e = new BrainError("bad", "That was too big to send to Claude.");
    else e = new BrainError("bad", "Claude said the request was invalid" + (short ? ": " + short : "."));
    e.status = status; e.detail = d;
    return e;
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
      this.last = null;                  // {ok, ms, at, text}: the last call, for the diagnostics strip
      this.noEffortFor = "";
      this.fetch = (...a) => window.fetch(...a);   // looked up at call time, so tests can mock window.fetch
    }
    forget() { this.history = []; }

    _system(s, opts) {
      const now = new Date();
      opts = opts || {};
      let out = s.system + "\n\nCurrent local date and time: " + now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }) +
        ". The user has " + this.notes.list().length + " saved notes.";
      if (opts.name) out += " Your name is " + opts.name + (opts.wake ? '; people get your attention by saying "' + opts.wake + '"' : "") + ".";
      // v7: say plainly whether this question comes with a picture, so the reply never guesses.
      if (opts.camera === "attached")
        out += "\n\nCamera: the image attached to the user's latest message is a live snapshot from your desk camera (" + (opts.facing || "front") +
          " camera), taken the moment they finished speaking. Use it when the question is about what you can see, or when it helps; otherwise ignore it.";
      else if (opts.camera)
        out += "\n\nCamera: no camera image is attached to this message (" + opts.camera + "). If the user asks about what you can see, say you didn't get a picture this time and why, briefly.";
      return out;
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
        // A failed fetch is a TypeError with no detail: offline, DNS, or the browser blocked it (CORS, an ad blocker).
        throw new BrainError("network", navigator.onLine === false ? "I'm offline, so I can't reach Claude."
          : "I couldn't reach Claude. Check the internet connection, or a blocker in the browser.");
      }
      if (!res.ok) {
        let detail = "", type = "";
        try { const j = await res.json(); detail = (j && j.error && j.error.message) || ""; type = (j && j.error && j.error.type) || ""; } catch (e) { /* not JSON */ }
        throw classify(res.status, type, detail, body.model);
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
     * opts.noHistory: don't send or keep conversation memory (used by curious glances). opts.maxTokens.
     */
    async ask(text, image, opts) {
      opts = opts || {};
      const s = this.getSettings();
      const userContent = [];
      if (image) userContent.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
      userContent.push({ type: "text", text: text || "What do you see?" });

      const keep = opts.noHistory ? 0 : Math.max(0, (s.memory | 0) * 2);
      const past = keep ? this.history.slice(-keep) : [];
      while (past.length && past[0].role !== "user") past.shift();
      const messages = past.map((m) => ({ role: m.role, content: m.content })).concat([{ role: "user", content: userContent }]);

      const body = { model: s.model || DB.store.DEFAULTS.model, max_tokens: opts.maxTokens || 1024, system: this._system(s, opts), tools: TOOLS, messages };
      // Effort (output_config.effort) is optional; if the model rejects it once, stop sending it for that model.
      if (s.effort && this.noEffortFor !== body.model) body.output_config = { effort: s.effort };

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      this.busy = true;
      const t0 = Date.now();
      try {
        let rawText = "";
        for (let round = 0; round < 4; round++) {
          let data;
          try { data = await this._post(body, ctrl.signal); }
          catch (e) {
            if (e.kind === "effort" && body.output_config) {
              this.noEffortFor = body.model; delete body.output_config;
              data = await this._post(body, ctrl.signal);
            } else throw e;
          }
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
        if (!reply.text) reply.text = "Hmm, I lost my words there.";
        this.last = { ok: true, ms: Date.now() - t0, at: Date.now(), text: "", image: !!image, imageInfo: opts.imageInfo || "" };
        // Rolling memory keeps plain text only; images aren't re-sent.
        if (opts.noHistory) return { text: reply.text, mood: reply.mood, raw: rawText };
        this.history.push({ role: "user", content: (image ? "[showed you a camera picture] " : "") + (text || "What do you see?") });
        this.history.push({ role: "assistant", content: (reply.mood ? "[" + reply.mood + "] " : "") + reply.text });
        if (this.history.length > 40) this.history = this.history.slice(-40);
        return { text: reply.text, mood: reply.mood, raw: rawText };
      } catch (e) {
        this.last = { ok: false, ms: Date.now() - t0, at: Date.now(), image: !!image, imageInfo: opts.imageInfo || "", text: (e.kind || "error") + (e.status ? " " + e.status : "") + ": " + (e.detail || e.message) };
        throw e;
      } finally {
        clearTimeout(timer);
        this.busy = false;
      }
    }
  }

  DB.Brain = Brain;
  DB.BrainError = BrainError;
  DB.classifyBrainError = classify;
  DB.parseReply = parseReply;
})();
