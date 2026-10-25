/* Desk Buddy: wiring. Voice detected -> one recognition session (Web Speech) or one on-device Whisper
   transcription -> wake word -> command -> local intent or Claude -> speech, with the face reacting
   throughout. While Buddy talks (and for 800 ms after) the mic is ignored, and anything that sounds like
   Buddy's own recent words is dropped, so it never answers itself.

   Web Speech on phones: some phones won't let recognition hear the mic while the voice detector holds
   it. That is detected (an error, no audio within a few seconds, or nothing recognised while you were
   clearly talking) and the app switches strategy automatically: "shared" -> "release" (close the
   detector's mic while recognising, reopen it after) -> "continuous" (plain always-on recognition,
   which beeps on Android). What worked is remembered on the device. The diagnostics strip shows it all.

   The camera (on by default) is only analysed on the device: motion, a face, someone arriving, the
   lights. Nothing is sent to Claude unless you ask it to look, or turn on "curious glances". */
(function () {
  "use strict";
  const DB = window.DB;
  const $ = (id) => document.getElementById(id);

  let settings = DB.store.loadSettings();
  let eye = DB.makeFace(settings.face, $("eye"));   // "sphere" (default) or "eye": same interface either way
  function setFace(kind) {
    const old = eye;
    if ((kind === "eye" ? "eye" : "sphere") === old.kind) return;
    old.destroy();
    eye = DB.makeFace(kind, $("eye"));
    eye.adopt(old);
  }
  const cam = new DB.Camera($("preview"));
  let tts = DB.makeTTS(settings.ttsEngine);
  const notesApi = { add: (t) => DB.store.addNote(t), list: () => DB.store.notes() };
  const brain = new DB.Brain(() => settings, () => DB.store.getKey(), notesApi);
  const vad = new DB.VoiceDetector();
  function applyVadSettings() {
    vad.sensitivity = +settings.sensitivity || 6;
    vad.calibration = settings.micCal && settings.micCal.noise ? settings.micCal : null;
    const changed = vad.processing !== settings.micProcessing;
    vad.processing = settings.micProcessing || "balanced";
    return changed;
  }
  applyVadSettings();
  // Which recogniser: "auto" = Web Speech (with the fallbacks), or on-device Whisper where Web Speech is missing.
  const hasWebSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const engineFor = (s) => (s.sttEngine === "whisper" || (s.sttEngine === "auto" && !hasWebSpeech) ? "whisper" : "browser");
  let stt = makeEngine();
  function makeEngine() {
    const kind = engineFor(settings);
    const e = DB.makeSTT(kind, { lang: settings.lang, model: settings.whisperModel });
    if (kind === "whisper") e.attach(vad);
    return e;
  }
  const isWhisper = () => stt.kind === "whisper";

  const COOLDOWN_MS = 2000;     // recognition starts at most once every 2 s (each start beeps on Android)
  const AWAIT_MS = 8000;        // after the wake word on its own, the next thing you say is for Buddy
  const TAIL_MS = 800;          // keep ignoring the mic this long after Buddy stops talking
  const BARGE_TAIL_MS = 300;    // shorter when the speech was cut off by a tap
  const ECHO_WINDOW_MS = 120000;
  const STUCK_SPEAK_MS = 120000;  // no single reply is spoken for this long
  const STUCK_PHASE_MS = 60000;

  const st = {
    started: false,
    lastActivity: Date.now(),
    awaitUntil: 0,          // wake word heard on its own: next utterance is the command
    followUntil: 0,         // after a reply: follow-ups need no wake word
    pttUntil: 0,            // push-to-talk armed
    noteArmed: false,       // "take a note" with no text: next utterance is the note
    askToken: 0,
    lastYawn: 0,
    lastGlance: 0,
    wakeLock: null,
    error: "",
    muteUntil: 0,           // the mic is ignored until then (Buddy talking + tail)
    lastSttStart: 0,
    pendingStart: 0,
    sessionSource: "",      // what started the current recognition session: "voice" | "tap"
    recentSaid: [],         // last two things Buddy said, for the echo filter
    drops: { echo: 0, muted: 0, ignored: 0 },
    strategy: "shared",     // Web Speech mic strategy in use: "shared" | "release" | "continuous"
    srFails: 0,             // failures in a row with the current strategy
    lastFailure: "",
    sess: null,             // the current Web Speech session, for failure detection
    watchdogMs: 3500,       // no audio from the recogniser this long after it starts = it can't hear the mic
    lastVoiceEnd: 0,
    contBackoff: 0,
    events: [],             // recent recognition events, for the diagnostics strip
    lastTranscript: "",
    camError: "",
    darkAt: 0,
    lastHi: 0,
    greets: 0,
    lastGlanceAsk: 0,
    glances: 0,
    lastHint: 0,
    lastSpokeEnd: 0,
    phase: "idle",          // "idle" | "heard" | "thinking" | "speaking", for the diagnostics strip and the watchdog
    phaseAt: Date.now(),
    lastReply: "",          // what happened to the last command: "spoken", "caption only (…)", an error
  };
  function setPhase(p) { if (st.phase !== p) { st.phase = p; st.phaseAt = Date.now(); } }
  function pickStrategy() {
    st.strategy = settings.srMode !== "auto" ? settings.srMode : (DB.store.learnedStrategy() || "shared");
    st.srFails = 0;
  }
  pickStrategy();

  /* ---------------- small helpers ---------------- */
  function setStatus(text, dot) {
    $("statusText").textContent = text;
    const d = $("micDot");
    d.className = "dot " + (dot || (stt.running || vad.running ? "on" : "off"));
  }
  function idleStatus() {
    if (!st.started) return setStatus("Tap to start", "off");
    if (st.error) return setStatus(st.error, "err");
    if (tts.speaking) return setStatus("Speaking… tap the eye to stop", "on");
    if (brain.busy) return setStatus("Thinking…", "on");
    if (isWhisper() && stt.state === "loading") return setStatus("Getting the on-device speech model ready… " + progressText(), "off");
    if (isWhisper() && stt.pending) return setStatus("Working out what you said…", "wake");
    if (stt.running) return setStatus(listeningForCommand() ? "Listening…" : "Hearing you…", "wake");
    if (listeningForCommand()) return setStatus(settings.listenMode === "always" ? "Listening… just talk" : "Press 🎙️ to talk", "wake");
    if (settings.listenMode === "off") return setStatus("Microphone off (settings)", "off");
    if (settings.listenMode === "tap") return setStatus("Press 🎙️ to talk", "off");
    if (vad.running || (st.strategy === "continuous" && !isWhisper())) return setStatus('Say "' + primaryWake() + '…" or press 🎙️', "on");
    return setStatus("Mic starting…", "off");
  }
  function progressText() {
    const p = stt.progress || {};
    return p.total ? Math.round(p.loaded / 1e6) + " of " + Math.round(p.total / 1e6) + " MB" : "";
  }
  function listeningForCommand() {
    const now = Date.now();
    return now < st.awaitUntil || now < st.followUntil || now < st.pttUntil;
  }
  /* Captions: "You: …" (right, blue) only for real things you said; "<name>: …" (left) for Buddy. */
  function captionLine(el, base, who, text, extra) {
    el.textContent = "";
    el.className = "line " + base + (extra ? " " + extra : "");
    if (!text) return;
    const w = document.createElement("span"); w.className = "who"; w.textContent = who + ":";
    const t = document.createElement("span"); t.className = "txt"; t.textContent = text;
    el.append(w, t);
  }
  // interim: true = faint (still hearing you, or not for Buddy); "partial" = recognition still in progress
  function showHeard(text, interim) { captionLine($("heard"), "heard", "You", text, interim ? "interim" + (interim === "partial" ? " partial" : "") : ""); }
  function showSaid(text, aside) { captionLine($("said"), "said", (settings.name || "Buddy").trim() || "Buddy", text, aside ? "aside" : ""); }

  function tokens(s) {
    return String(s).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
  }
  function lev(a, b) {
    const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  const near = (heard, want) => heard === want || (want.length >= 5 && lev(heard, want) <= 1);
  // Consonant skeleton: how a word sounds, roughly. "Jarvis", "Jervis", "Charvis", "Jarvis's" -> "jrvs";
  // "service" -> "srvs", "travis" -> "trvs", "arvis" -> "rvs".
  function skeleton(w) {
    let x = String(w).toLowerCase().replace(/'s$/, "").replace(/[^a-z]/g, "");
    x = x.replace(/^(dj|ch|sh|zh|j|g(?=[eiy]))/, "j").replace(/ph/g, "f").replace(/ck/g, "k")
         .replace(/c(?=[eiy])/g, "s").replace(/[cqk]/g, "k").replace(/z/g, "s").replace(/w/g, "v").replace(/x/g, "ks");
    const first = x[0] || "";
    x = x.slice(1).replace(/[aeiouyh]/g, "");
    x = (/[aeiouy]/.test(first) ? "" : first) + x;
    return x.replace(/(.)\1+/g, "$1");
  }
  // Recognition starts a moment after you start speaking (on Android it can't be given the audio from
  // before it started), so the first syllable of the wake word can be lost, and Whisper-tiny mishears
  // names: "Jarvis" -> "arvis"/"service"/"Jervis"/"travis"/"Charvis", "Buddy" -> "daddy". At the start of
  // an utterance (or after "hey"/"ok") we accept a clipped, misheard or similar-sounding wake word.
  function nearLoose(heard, want) {
    if (near(heard, want)) return true;
    heard = heard.replace(/'s$/, "");
    if (want.length >= 4 && lev(heard, want) <= 2) return true;
    if (heard.length >= 3 && want.length - heard.length <= 3 && want.endsWith(heard)) return true;
    if (want.length >= 5 && heard.length >= 3 && lev(heard, want.slice(Math.max(1, want.length - heard.length))) <= 1) return true;
    const h = skeleton(heard), w = skeleton(want);
    if (!h || !w) return false;
    if (h === w && w.length >= 2) return true;
    if (w.length >= 4 && h.length >= 3 && lev(h, w) <= 1) return true;          // jrvs ~ srvs, trvs, jrvst
    if (w.length >= 4 && h.length >= 3 && w.endsWith(h)) return true;           // rvs: first sound lost
    return false;
  }
  const nearMid = (heard, want) => near(heard, want) || (want.length >= 4 && lev(heard.replace(/'s$/, ""), want) <= 2) ||
    (skeleton(want).length >= 3 && skeleton(heard) === skeleton(want));
  const GREET_RE = /^(hey|hi|hello|ok|okay|oi|yo|hiya|ey|a|uh|um|oh|so|right|excuse)$/;
  // How a word sounds, more loosely than skeleton(): voiced and unvoiced pairs merge (d/t, b/p, g/k, v/f,
  // s/z), and an "r" between a vowel and a consonant is dropped (non-rhotic "birdie" ~ "buddy"). Short wake words like
  // "Buddy" have a tiny skeleton ("bd"), so they need this: "body", "buddie", "bodie", "birdie", "butty",
  // "bud", "but he" all come out as "pt".
  function soundKey(w) {
    let x = String(w).toLowerCase().replace(/'s$/, "").replace(/[^a-z]/g, "");
    if (!x) return "";
    x = x.replace(/^(dj|ch|sh|zh|j|g(?=[eiy]))/, "j").replace(/ph/g, "f").replace(/ck/g, "k").replace(/qu/g, "k")
         .replace(/c(?=[eiy])/g, "s").replace(/[cqk]/g, "k").replace(/x/g, "ks").replace(/w/g, "v");
    x = x.replace(/([aeiouy])r(?=[^aeiouy])/g, "$1");
    const first = x[0];
    x = x.slice(1).replace(/[aeiouyh]/g, "");
    x = (/[aeiouy]/.test(first) ? "" : first) + x;
    x = x.replace(/d/g, "t").replace(/b/g, "p").replace(/g/g, "k").replace(/v/g, "f").replace(/z/g, "s");
    return x.replace(/(.)\1+/g, "$1");
  }
  // Everyday words that sound like short wake words. They only count when they're the whole utterance.
  const COMMON = new Set(("but bit bet bat bad bed bid bud's put pot pat pet pit pity petty pretty potty bought boot " +
    "about by buy be bye bee been did dad do done dead died date data daddy baby bobby's pop pope pub tab tub " +
    "the a an it is was").split(" "));
  /** How well one heard word matches one wake-word word: 3 exact, 2 close spelling (or same sound for a
      longer word), 1.5 same sound for a short word ("body" ~ "buddy"), 1 loose (clipped or misheard), 0 no. */
  function wordScore(heard, want) {
    if (!heard || !want) return 0;
    const h = heard.replace(/'s$/, "");
    if (heard === want || h === want || (!want.endsWith("s") && h.replace(/s$/, "") === want)) return 3;
    if (COMMON.has(heard) || COMMON.has(h)) return 0;
    const hk = soundKey(heard), wk = soundKey(want), d = lev(h, want);
    if (near(h, want) || (want.length >= 6 && d <= 2)) return 2;
    if (hk && hk === wk) return wk.length >= 3 ? 2 : 1.5;
    if (want.length >= 4 && d <= 2 && h[0] === want[0]) return 1.5;
    if (nearLoose(heard, want)) return 1;
    // short wake words: same first letter, one sound different ("bobby" ~ "buddy"), similar length
    if (wk.length >= 2 && hk.length >= 1 && h[0] === want[0] && lev(hk, wk) <= 1 && Math.abs(h.length - want.length) <= 1) return 1;
    return 0;
  }
  /** The wake words, from Settings ("Buddy, Hey Buddy, Jarvis"): lists of words, longest first. */
  function wakeList() {
    const out = [], seen = new Set();
    for (const part of String(settings.wakeWord || "").split(/[,;\/|]+/)) {
      let t = tokens(part);
      if (t.length > 1 && GREET_RE.test(t[0])) t = t.slice(1);   // "Hey Buddy": the "hey" is optional anyway
      const k = t.join(" ");
      if (t.length && !seen.has(k)) { seen.add(k); out.push(t); }
    }
    return out.sort((x, y) => y.length - x.length);
  }
  const primaryWake = () => {
    const first = String(settings.wakeWord || "").split(/[,;\/|]+/).map((x) => x.trim()).filter(Boolean)[0];
    return first || DB.store.DEFAULTS.wakeWord;
  };
  /** Find a wake word in `text`. Returns { rest, path, heard, wake } or null.
      rest: the words around the wake word ("" if it was said alone). path says which rule matched:
      "alone", "start", "after-greeting", "start-fuzzy", "near-start" (2nd/3rd word), "end", "middle", "split". */
  function matchWake(text) {
    const tt = tokens(text), list = wakeList();
    if (!tt.length || !list.length) return null;
    // Very short utterances ("buddy", "hey body", "but he") are almost certainly the wake word on its own.
    let best = null;
    const consider = (i, len, score, wt, how) => {
      const before = tt.slice(0, i), after = tt.slice(i + len);
      const greetOnly = before.every((w) => GREET_RE.test(w));
      const alone = greetOnly && after.length === 0;
      const atStart = i === 0;
      const afterGreet = !atStart && greetOnly;
      const atEnd = after.length === 0 || (after.length === 1 && /^(please|mate|now|thanks)$/.test(after[0]));
      let ok, path;
      if (alone) { ok = score >= 1; path = "alone"; }
      else if (atStart || afterGreet) { ok = score >= 1; path = score >= 3 ? (atStart ? "start" : "after-greeting") : "start-fuzzy"; }
      else if (atEnd && score >= 1.5) { ok = true; path = "end"; }
      else if (i <= 2 && score >= 2) { ok = true; path = "near-start"; }
      else { ok = score >= 3 || (score >= 2 && soundKey(wt[0]).length >= 3); path = "middle"; }
      if (how === "split" && ok) path = alone ? "alone" : "split";
      if (!ok) return;
      const rank = score * 10 + (alone ? 5 : atStart || afterGreet ? 4 : atEnd ? 3 : 0) + len;
      if (!best || rank > best.rank) best = { rank, rest: before.filter((w) => !(greetOnly && GREET_RE.test(w))).concat(after).join(" "),
        path, heard: tt.slice(i, i + len).join(" "), wake: wt.join(" ") };
    };
    for (const wt of list) {
      for (let i = 0; i < tt.length; i++) {
        if (i + wt.length <= tt.length) {
          let sc = 3;
          for (let j = 0; j < wt.length; j++) sc = Math.min(sc, j === 0 ? wordScore(tt[i + j], wt[j]) : (wordScore(tt[i + j], wt[j]) >= 2 ? 3 : 0));
          if (sc > 0) consider(i, wt.length, sc, wt, "");
        }
        // a one-word wake word split in two ("jar vis", "but he")
        if (wt.length === 1 && i + 1 < tt.length && tt[i].length <= 4 && (tt[i] + tt[i + 1]).length >= 4) {
          const joined = tt[i] + tt[i + 1];
          // the same sound only counts when the second half is just a vowel sound ("but he", "bud e"), so
          // "but it" / "but I" don't
          const sc = nearLoose(joined, wt[0]) || (/^(h[aeiouy]+|e+|ie|y)$/.test(tt[i + 1]) && soundKey(joined) === soundKey(wt[0])) ? 1 : 0;
          // only at the edges: "but he said" in the middle of a sentence isn't "Buddy"
          if (sc && (i === 0 || tt.slice(0, i).every((w) => GREET_RE.test(w)) || i + 2 === tt.length)) consider(i, 2, sc, wt, "split");
        }
      }
    }
    if (!best) return null;
    delete best.rank;
    return best;
  }
  /** Returns the words around the wake word, "" if it was said alone, or null if it wasn't said. */
  function afterWake(text) { const m = matchWake(text); return m ? m.rest : null; }
  /** Does this utterance need the wake word right now? */
  function wakeNeeded() {
    if (settings.wakeMode === "off") return false;
    if (settings.wakeMode === "conversation") return !(cam.on && cam.present);
    return true;
  }

  /* Echo filter: a transcript made mostly of words Buddy just said is Buddy hearing itself. */
  const STOPWORDS = new Set(("a an the and or but so to of in on at for with from by as is it it's its i i'm you you're me my " +
    "your we he she they them this that there here be am are was were do does did have has had what what's how who " +
    "not no yes oh um uh like just").split(" "));
  function contentTokens(s) {
    const wake = new Set(wakeList().flat());
    return tokens(s).filter((w) => !STOPWORDS.has(w) && !wake.has(w));
  }
  function rememberSaid(text) {
    st.recentSaid.push({ text: String(text), at: Date.now() });
    if (st.recentSaid.length > 2) st.recentSaid.shift();
  }
  function echoScore(text) {
    const t = contentTokens(text);
    if (t.length < 3) return 0;                     // too short to judge
    const now = Date.now();
    const said = new Set(st.recentSaid.filter((r) => now - r.at < ECHO_WINDOW_MS).flatMap((r) => contentTokens(r.text)));
    if (!said.size) return 0;
    return t.filter((w) => said.has(w)).length / t.length;
  }
  // Real echo arrives while Buddy talks (ignored anyway) or just after. Later, only a near-copy counts, so a
  // follow-up that reuses Buddy's words ("what about the weather tomorrow?") isn't thrown away.
  const isEcho = (text) => { const sc = echoScore(text); return Date.now() - (st.lastSpokeEnd || 0) < 5000 ? sc > 0.5 : sc >= 0.85; };
  const muted = () => tts.speaking || Date.now() < st.muteUntil;
  const STOP_RE = /^(stop|stop it|stop talking|be quiet|quiet|shut up|enough|never mind|nevermind|cancel|ok stop|okay stop)\b/i;

  function activity(kind) {
    st.lastActivity = Date.now();
    $("controls").classList.remove("dim");
    if (eye.asleep || eye.mood === "sleepy") eye.wake(kind === "speech" || kind === "tap");
  }

  /* ---------------- speech in ---------------- */
  function logEvent(name) {
    st.events.push({ name, at: Date.now() });
    if (st.events.length > 8) st.events.shift();
  }
  function abortSTT() { if (st.sess) st.sess.aborted = true; if (stt.running || stt.pending) stt.abort(); }

  // Only start recognition when it's needed: a voice onset in "always" mode, or a tap. At most once per COOLDOWN_MS
  // for Web Speech (each start beeps on Android); Whisper makes no sound, so it has no cooldown.
  function startRecognition(source) {
    if (!st.started || settings.listenMode === "off" || stt.running || muted() || !stt.supported) return false;
    if (source === "voice" && settings.listenMode !== "always" && !(isWhisper() && Date.now() < st.pttUntil)) return false;
    if (isWhisper()) {
      if (!vad.running) { ensureMic(true).then(() => { if (!stt.running && !muted()) stt.start({ source }); idleStatus(); }); return true; }
      const ok = stt.start({ source });
      idleStatus();
      return ok;
    }
    if (st.strategy === "continuous" && settings.listenMode === "always") { runContinuous(); return stt.running; }
    const wait = COOLDOWN_MS - (Date.now() - st.lastSttStart);
    if (wait > 0) {
      // Too soon: try again when the cooldown ends if you're still talking (or you tapped).
      clearTimeout(st.pendingStart);
      st.pendingStart = setTimeout(() => {
        st.pendingStart = 0;
        if (source === "tap" ? Date.now() < st.pttUntil : vad.inSpeech) startRecognition(source);
      }, wait + 10);
      return false;
    }
    const release = st.strategy !== "shared";
    if (release && vad.running) vad.stop();
    st.lastSttStart = Date.now();
    st.sessionSource = source;
    const sess = (st.sess = { t: Date.now(), source, strategy: st.strategy, audio: false, result: false, aborted: false, error: "" });
    const ok = stt.start({ track: release ? null : vad.track, source, continuous: st.strategy === "continuous" });
    if (!ok) st.sess = null;
    else {
      // Watchdog: recognition that started but never got any audio can't hear the mic.
      setTimeout(() => {
        if (st.sess === sess && !sess.audio && !sess.result && !sess.aborted && stt.running) {
          srFailure("no audio reached speech recognition within " + (st.watchdogMs / 1000) + " s", 2);
          sess.aborted = true; stt.abort();
        }
      }, st.watchdogMs);
    }
    idleStatus();
    return ok;
  }
  // Plain continuous recognition: the last-resort fallback for phones where nothing else hears you.
  function runContinuous() {
    clearTimeout(st.contTimer); st.contTimer = 0;
    if (!st.started || isWhisper() || st.strategy !== "continuous" || settings.listenMode !== "always" || stt.running || muted()) return;
    if (vad.running) vad.stop();
    st.lastSttStart = Date.now();
    st.sess = { t: Date.now(), source: "continuous", strategy: "continuous", audio: false, result: false, aborted: false };
    stt.start({ continuous: true, source: "continuous" });
    idleStatus();
  }
  /** Count a Web Speech failure; after `limit` in a row, move to the next strategy. */
  function srFailure(reason, limit) {
    st.lastFailure = reason;
    st.srFails++;
    logEvent("failure: " + reason);
    if (st.srFails < limit) return;
    if (settings.srMode !== "auto") { st.error = "Speech recognition can't hear the mic (" + reason + "). Try another option under Settings > Listening."; idleStatus(); return; }
    const next = st.strategy === "shared" ? "release" : st.strategy === "release" ? "continuous" : "";
    if (!next) return;
    st.strategy = next; st.srFails = 0;
    DB.store.setLearnedStrategy(next);
    logEvent("switched to " + next);
    if (next === "continuous") {
      showSaid("I couldn't hear you through the voice detector, so I've switched to plain always-on recognition. On Android it will beep each time it restarts. On-device Whisper (Settings > Speech engines) avoids that.", true);
      setTimeout(runContinuous, 400);
    }
    idleStatus();
  }
  async function ensureMic(force) {
    if (!st.started || settings.listenMode === "off" || vad.running) return;
    if (settings.listenMode !== "always" && !force) return;
    if (!isWhisper()) {
      if (stt.running) return;
      if (st.strategy === "continuous") { runContinuous(); return; }
    }
    try {
      applyVadSettings();
      await vad.start();
      if (/^Microphone/.test(st.error)) st.error = "";
    } catch (e) {
      st.error = "Microphone: " + (e && e.name === "NotAllowedError" ? "permission was refused" : (e && (e.message || e.name)) || "unavailable");
    }
    idleStatus();
  }
  function updateMute() {
    vad.setMuted(muted());
    if (!muted() && st.mutePending) { st.mutePending = false; idleStatus(); runContinuous(); }
  }

  function wireSTT() {
    stt.onSpeech = () => { if (!muted()) activity("speech"); };
    stt.onEvent = (name) => {
      logEvent(name);
      const sess = st.sess;
      if (!sess) return;
      if (/^(audiostart|soundstart|speechstart)$/.test(name)) sess.audio = true;
      if (/^result/.test(name)) { sess.result = true; sess.audio = true; st.srFails = 0; }
    };
    stt.onProgress = () => { idleStatus(); };
    stt.onState = (state, detail, code) => {
      if (state === "error") {
        const sess = st.sess;
        if (!isWhisper() && sess && (code === "audio-capture" || code === "not-allowed")) {
          sess.error = code;
          // With the detector holding the mic, these usually mean "the mic is busy", not a missing mic or a refusal.
          if (sess.strategy === "shared") { srFailure(code + " while the voice detector had the mic", 1); return; }
          if (sess.strategy === "release" && code === "audio-capture") { srFailure(code, 2); return; }
          if (code === "not-allowed") stt.fatal = true;
        }
        st.error = detail || "Microphone error";
      } else if (state === "listening") st.error = "";
      idleStatus();
    };
    stt.onEnd = (got) => {
      // No restart here (except the continuous fallback). The next voice onset (or tap) starts the next session.
      const sess = st.sess; st.sess = null;
      if (st.interimWake) { st.interimWake = null; eye.setListening(listeningForCommand()); }
      if (!isWhisper() && sess && !sess.result && !sess.aborted && !sess.error && sess.source === "voice") {
        // A voice started this session but nothing was recognised. Once is normal (a cough, the TV);
        // repeatedly means recognition can't hear the mic this way.
        const voiceMs = (vad.inSpeech ? Date.now() : st.lastVoiceEnd) - sess.t;
        if (sess.strategy === "release" || voiceMs >= 800) srFailure("nothing recognised while you were talking", sess.strategy === "release" ? 3 : 2);
      }
      if (!isWhisper() && st.strategy === "continuous" && settings.listenMode === "always") {
        const dur = Date.now() - st.lastSttStart;
        st.contBackoff = dur < 1500 ? Math.min(5000, (st.contBackoff || 250) * 2) : 0;
        clearTimeout(st.contTimer);
        // Restart straight away (keeps it warm, so less of your first word is lost), backing off only if it keeps ending at once.
        st.contTimer = setTimeout(runContinuous, st.contBackoff || 60);
      } else if (!isWhisper() && st.strategy !== "shared") ensureMic();
      if (isWhisper() && settings.listenMode !== "always" && !stt.running && Date.now() >= st.pttUntil) vad.stop();
      const h = $("heard");
      if (h.classList.contains("partial")) showHeard("");
      idleStatus();
    };
    stt.onResult = (text, isFinal, meta) => {
      if (isFinal) st.lastTranscript = text;
      if (muted()) { if (isFinal) st.drops.muted++; return; }
      if (!isFinal) {
        if (isEcho(text)) return;
        showHeard(text, "partial");
        // Interim wake word: react as soon as it's heard (the final may drop it, especially on iPhone).
        if (!st.interimWake && wakeNeeded() && !listeningForCommand()) {
          const m = matchWake(text);
          if (m) { st.interimWake = m; eye.setListening(true); setStatus("Listening…", "wake"); }
        }
        return;
      }
      handleFinal(text, meta);
      if (isWhisper() && settings.listenMode !== "always" && Date.now() >= st.pttUntil) vad.stop();
    };
    vad.onVoiceStart = () => {
      if (muted()) return;
      if (eye.asleep || eye.mood === "sleepy") activity("voice"); else st.lastActivity = Date.now();
      if (isWhisper() && stt.armed && !stt.running) { stt.begin("tap"); idleStatus(); return; }
      startRecognition("voice");
    };
    vad.onVoiceEnd = () => {
      st.lastVoiceEnd = Date.now();
      if (isWhisper() && stt.running) { stt.finish(); idleStatus(); }
    };
  }
  function switchEngine() {
    abortSTT();
    stt = makeEngine();
    pickStrategy();
    wireSTT();
    if (st.started && isWhisper()) stt.load();
  }

  /** Handle one final transcript. Returns what happened, for the tests:
      "muted" | "echo" | "ignored" | "wake" | "stop" | "command" | "empty".
      meta.interims: the interim transcripts of this utterance (Web Speech), checked for the wake word too. */
  function handleFinal(text, meta) {
    text = String(text || "").trim();
    const interimWake = st.interimWake; st.interimWake = null;
    if (!text) return "empty";
    if (muted()) { st.drops.muted++; return "muted"; }
    if (isEcho(text)) { st.drops.echo++; showHeard(""); return "echo"; }
    let wake = matchWake(text);
    if (!wake) {
      // The final transcript lost the wake word, but an interim had it: count it, and use the whole final.
      let im = interimWake;
      for (const t of (meta && meta.interims) || []) { if (im) break; im = matchWake(t); }
      // ...unless the interim was only the start of a longer word: "bud" -> "budget is tight"
      if (im && tokens(text).some((w) => w !== im.heard && w.length > im.heard.length && w.startsWith(im.heard))) im = null;
      if (im) {
        const r = matchWake(text);
        wake = { rest: r ? r.rest : text, path: "interim (" + im.path + ")", heard: im.heard, wake: im.wake };
        // the final may be just the rest of the interim: if the interim's leftover words are the whole final, it was said alone
        if (tokens(text).join(" ") === tokens(im.heard).join(" ")) wake.rest = "";
      }
    }
    const wakeRest = wake ? wake.rest : null;
    const now = Date.now();
    const followOpen = listeningForCommand();
    if (STOP_RE.test((wakeRest == null ? text : wakeRest).trim()) && (wakeRest !== null || followOpen)) {
      showHeard(text);
      noteWake(wake ? wake.path : "follow-up", wake, text);
      st.awaitUntil = st.followUntil = st.pttUntil = 0;
      eye.setListening(false); idleStatus();
      return "stop";
    }
    let cmd = null;
    if (wakeRest !== null) {
      activity("speech");
      showHeard(text);
      noteWake(wake.path, wake, text);
      if (wakeRest) cmd = wakeRest;
      else {
        // Said on its own: acknowledge (chime / "Yes?") and listen for the question without the wake word.
        st.awaitUntil = now + AWAIT_MS;
        eye.setMood("curious", 8); eye.setListening(true); idleStatus();
        ackWake();
        setTimeout(() => { if (Date.now() >= st.awaitUntil) { eye.setListening(listeningForCommand()); idleStatus(); } }, AWAIT_MS + 100);
        return "wake";
      }
    } else if (followOpen || !wakeNeeded()) {
      activity("speech"); showHeard(text); cmd = text;
      noteWake(!wakeNeeded() ? "not needed" : now < st.awaitUntil ? "after the wake word alone" : now < st.pttUntil ? "mic button" : "follow-up", null, text);
    }
    if (cmd == null) {                      // not for Buddy (no wake word): show it faintly, and say why
      st.drops.ignored++;
      if (interimWake) { eye.setListening(listeningForCommand()); idleStatus(); }   // an interim looked like the wake word, but wasn't
      showHeard(text, true);
      noteWake("none", null, text);
      logEvent("ignored: no wake word");
      if (now - st.lastHint > 12000 && !tts.speaking && !brain.busy) {
        st.lastHint = now;
        const w = primaryWake();
        showSaid('I heard "' + text.slice(0, 60) + '", but not "' + w + '". Try saying "' + w + '" by itself, wait for the chime, then ask. ' +
          'Or say it at the end ("…, ' + w + '"), add other wake words in Settings, or turn off "Require the wake word".', true);
      }
      return "ignored";
    }
    setPhase("heard");
    st.awaitUntil = st.pttUntil = st.followUntil = 0;
    eye.setListening(false);
    $("btnTalk").classList.remove("active");
    runCommand(cmd);
    return "command";
  }
  /** Remember which wake rule fired, for the diagnostics strip. */
  function noteWake(path, wake, text) {
    st.lastWake = { path, heard: wake ? wake.heard : "", wake: wake ? wake.wake : "", text, at: Date.now() };
  }
  /** "I'm listening": a short two-note chime (default), a spoken "Yes?", or nothing. */
  function ackWake() {
    showSaid("Yes?");
    if (settings.wakeAck === "none") return;
    if (settings.wakeAck === "yes") { say("Yes?", true).then(() => { st.awaitUntil = Math.max(st.awaitUntil, Date.now() + AWAIT_MS); eye.setListening(true); idleStatus(); }); return; }
    chime();
  }
  function chime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = st.chimeCtx || (st.chimeCtx = new AC());
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const t0 = ctx.currentTime + 0.02;
      [[880, 0], [1320, 0.11]].forEach(([f, dt]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + dt + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.16);
        o.connect(g); g.connect(ctx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.18);
      });
      st.chimes = (st.chimes || 0) + 1;
    } catch (e) { logEvent("chime failed: " + ((e && e.message) || e)); }
  }
  /* ---------------- commands ---------------- */
  const NOTE_RE = /^(?:please\s+)?(?:can you\s+)?(?:take|make|add|write|jot)(?:\s+down)?(?:\s+me)?\s+a\s+note(?:\s+(?:that|saying|to say|of))?[\s:,-]*(.*)$/i;
  const NOTE2_RE = /^note(?:\s+that)?[\s:,-]+(.+)$/i;
  const READ_RE = /\b(read|list|tell me|what are|what's in|show)\b.*\bnotes?\b/i;
  const LOOK_RE = /\b(what(?:'s| is) (?:this|that|here)|look at (?:this|that|me|it)|what do you see|what can you see|what am i (?:holding|wearing|doing)|can you see|take a look|have a look|read this|who is this|describe (?:this|what you see))\b/i;
  const SLEEP_RE = /\b(go to sleep|good ?night|sleep now|nap time)\b/i;
  const FORGET_RE = /\b(forget (?:our|the|this) conversation|start over|new conversation|clear (?:your|the) memory)\b/i;

  async function runCommand(cmd) {
    cmd = String(cmd).trim();
    if (!cmd) return;
    activity("speech");
    setPhase("heard");
    if (st.noteArmed) {
      st.noteArmed = false;
      const n = DB.store.addNote(cmd);
      eye.setMood("happy", 3);
      return say(n ? "Got it. I noted: " + n.text : "I didn't catch a note.");
    }
    let m = cmd.match(NOTE_RE) || cmd.match(NOTE2_RE);
    if (m) {
      const body = (m[1] || "").trim();
      if (!body) { st.noteArmed = true; st.followUntil = Date.now() + 10000; eye.setListening(true); return say("Sure. What should the note say?"); }
      const n = DB.store.addNote(body);
      eye.setMood("happy", 3);
      return say("Noted: " + n.text);
    }
    if (READ_RE.test(cmd)) {
      const list = DB.store.notes();
      eye.setMood(list.length ? "happy" : "curious", 3);
      if (!list.length) return say("You don't have any notes yet.");
      const last = list.slice(-10);
      return say("You have " + list.length + (list.length === 1 ? " note. " : " notes. ") +
        (list.length > 10 ? "Here are the last ten. " : "") + last.map((n, i) => (i + 1) + ": " + n.text + ".").join(" "));
    }
    if (SLEEP_RE.test(cmd)) { await say("Goodnight.", true); eye.sleep(); $("controls").classList.add("dim"); return; }
    if (FORGET_RE.test(cmd)) { brain.forget(); eye.setMood("surprised", 1.5); return say("Okay, fresh start."); }
    if (LOOK_RE.test(cmd)) return look(cmd);
    return ask(cmd, null);
  }

  async function look(question) {
    activity("tap");
    const tempCam = !cam.on;
    let image = null;
    try {
      eye.setMood("curious", 4);
      if (tempCam) { await cam.start(cam.facing); await new Promise((r) => setTimeout(r, 700)); }  // let exposure settle
      image = await cam.grab(768, 0.75);
    } catch (e) {
      eye.setMood("surprised", 2);
      return say("I can't see anything. " + (e && e.message ? e.message : "The camera didn't start."), true);
    } finally {
      if (tempCam && (settings.camera === "off" || st.camError)) cam.stop();
      updateCamButtons();
    }
    return ask(question || "What is this? Look at the picture and tell me briefly.", image);
  }

  async function ask(text, image) {
    const my = ++st.askToken;
    setPhase("thinking");
    eye.setMood("thinking"); idleStatus();
    try {
      const reply = await brain.ask(text, image);
      if (my !== st.askToken) return;
      eye.setMood(reply.mood || "neutral", 6);
      await say(reply.text);
    } catch (e) {
      if (my !== st.askToken) return;
      eye.setMood("surprised", 2);
      // Never swallow an error: say it, caption it, and put it in the diagnostics strip.
      const msg = e instanceof DB.BrainError ? e.message : "Something went wrong: " + ((e && (e.message || e.name)) || "unknown error");
      logEvent("claude: " + (e && e.kind ? e.kind : "error"));
      await say(msg, true);
    } finally { if (my === st.askToken && st.phase === "thinking") setPhase("idle"); idleStatus(); }
  }

  /* ---------------- speech out ---------------- */
  function wireTTS() {
    tts.onStart = () => {
      // Hard mute: Buddy must never hear itself. Kill any running recognition and ignore the mic.
      st.muteUntil = Infinity;
      clearTimeout(st.pendingStart); st.pendingStart = 0;
      clearTimeout(st.contTimer); st.contTimer = 0;
      vad.setMuted(true);
      abortSTT();
      if ($("heard").classList.contains("partial")) showHeard("");
      eye.setSpeaking(true); setPhase("speaking"); idleStatus();
    };
    tts.onWord = () => eye.pulse();
    tts.onEnd = () => {
      eye.setSpeaking(false);
      st.lastSpokeEnd = Date.now();
      if (st.phase === "speaking") setPhase("idle");
      const tail = st.bargeAt && Date.now() - st.bargeAt < 200 ? BARGE_TAIL_MS : TAIL_MS;
      st.bargeAt = 0;
      st.muteUntil = Date.now() + tail;
      st.mutePending = true;
      setTimeout(updateMute, tail + 10);
      idleStatus();
    };
    tts.onVoices = () => fillVoices();
    tts.onError = (msg) => { logEvent("voice out: " + msg); };
  }
  async function say(text, noFollow) {
    showSaid(text);                       // the caption always shows, whatever happens to the voice
    rememberSaid(text);
    const errBefore = tts.lastErrorAt || 0;
    if (tts.supported) {
      try { await tts.speak(text, { voice: settings.voiceURI, rate: +settings.rate, pitch: +settings.pitch, lang: settings.lang }); }
      catch (e) { logEvent("voice out: " + ((e && e.message) || "failed")); }
      st.lastReply = (tts.lastErrorAt || 0) <= errBefore ? "spoken"
        : /didn't report its end/.test(tts.lastError) ? "spoken, but the end wasn't reported" : "caption only (" + tts.lastError + ")";
    } else st.lastReply = "caption only (this browser can't speak)";
    if (st.phase === "heard") setPhase("idle");
    if (!noFollow && settings.followUp > 0 && st.started && settings.listenMode === "always") {
      const ms = TAIL_MS + settings.followUp * 1000;
      st.followUntil = Date.now() + ms;
      eye.setListening(true); idleStatus();
      setTimeout(() => {
        if (!listeningForCommand()) { eye.setListening(false); idleStatus(); }
      }, ms + 100);
    }
  }
  function stopSpeaking() {
    if (tts.speaking) { st.bargeAt = Date.now(); tts.cancel(); eye.setSpeaking(false); eye.setMood("surprised", 0.8); }
  }

  /* ---------------- touch: pet, poke, barge-in ---------------- */
  let down = null;
  $("eye").addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, dist: 0, t: Date.now(), petted: false };
    activity("tap");
    if (tts.speaking) { stopSpeaking(); down.barge = true; return; }
    if (eye.isOnEye(e.clientX, e.clientY)) { if (eye.poke) eye.poke(); eye.pet(e.clientX, e.clientY); }
    else { eye.lookAt((e.clientX - eye.cx) / eye.R, (e.clientY - eye.cy) / eye.R, 1500); eye.setMood("curious", 2); }
  });
  $("eye").addEventListener("pointermove", (e) => {
    if (!down || down.barge) return;
    down.dist += Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down.x = e.clientX; down.y = e.clientY;
    eye.lookAt((e.clientX - eye.cx) / eye.R, (e.clientY - eye.cy) / eye.R, 800);
    if (!down.petted && down.dist > eye.R * 0.8) {        // a stroke, not a tap
      down.petted = true;
      eye.pet(e.clientX, e.clientY);
      showSaid(["Mmm, that's nice.", "Hehe.", "Purrr…", "More, please."][Math.floor(Math.random() * 4)] + " (you're petting me)", true);
    }
  });
  const up = () => { down = null; };
  $("eye").addEventListener("pointerup", up);
  $("eye").addEventListener("pointercancel", up);

  /* ---------------- buttons ---------------- */
  function pushToTalk() {
    if (!st.started) return start();
    activity("tap");
    if (settings.listenMode === "off") { showSaid("My microphone is off. Turn listening on in settings.", true); return; }
    const wasSpeaking = tts.speaking;
    stopSpeaking();
    st.pttUntil = Date.now() + 8000;
    eye.setMood("curious", 8); eye.setListening(true);
    $("btnTalk").classList.add("active");
    idleStatus();
    // after a tap barge-in, wait out the short mute tail first
    if (!(st.strategy === "continuous" && stt.running && !isWhisper()))
      setTimeout(() => startRecognition("tap"), wasSpeaking ? BARGE_TAIL_MS + 30 : 0);
    setTimeout(() => {
      if (Date.now() >= st.pttUntil) {
        $("btnTalk").classList.remove("active");
        if (!listeningForCommand()) eye.setListening(false);
        idleStatus();
      }
    }, 8100);
  }
  $("btnTalk").addEventListener("click", pushToTalk);
  $("btnLook").addEventListener("click", () => { if (!st.started) return start(); stopSpeaking(); look(null); });
  $("btnCam").addEventListener("click", async () => {
    try { if (cam.on) cam.stop(); else await cam.start(cam.facing); }
    catch (e) { showSaid("Camera: " + (e.message || e.name)); }
    updateCamButtons();
  });
  $("btnFlip").addEventListener("click", async () => {
    try { await cam.flip(); } catch (e) { showSaid("Camera: " + (e.message || e.name)); }
    updateCamButtons();
  });
  $("btnFull").addEventListener("click", toggleFullscreen);
  $("btnSettings").addEventListener("click", openSettings);
  $("btnNotes").addEventListener("click", openNotes);
  window.addEventListener("keydown", (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (document.querySelector("dialog[open]")) return;
    if (e.code === "Space") { e.preventDefault(); pushToTalk(); }
    if (e.key === "Escape") stopSpeaking();
  });

  function updateCamButtons() {
    $("btnCam").classList.toggle("active", cam.on);
    $("btnFlip").title = "Switch camera (now " + (cam.facing === "user" ? "front" : "back") + ")";
    $("preview").hidden = !(cam.on && settings.preview);
    $("camDot").hidden = !cam.on;
    cam.motionOn = !!settings.motion;
    if (!settings.faceDetect) cam.detector = null;
  }
  async function startCamera(facing) {
    try {
      await cam.start(facing);
      st.camError = "";
    } catch (e) {
      st.camError = e && e.name === "NotAllowedError" ? "blocked" : (e && (e.message || e.name)) || "unavailable";
      cam.stop();
    }
    updateCamButtons();
    return !st.camError;
  }
  function cameraNote() {
    return st.camError === "blocked"
      ? "The camera is blocked, so I can't see you. I'll still listen. You can allow it in the browser's site settings, or turn it off in Settings."
      : "The camera didn't start (" + st.camError + "). I'll still listen.";
  }

  /* ---------------- perception (camera, on this device only) ---------------- */
  const faceRecent = () => cam.face && Date.now() - cam.faceAt < 1500;
  const busyFace = () => eye.asleep || eye.mood === "thinking" || (down && !down.barge);
  cam.onMotion = (mv) => {
    if (cam.light === "dark") return;
    if (mv.amount > 0.04) activity("motion");
    if (busyFace() || faceRecent()) return;
    eye.lookAt(mv.x, mv.y * 0.8, 700);
  };
  cam.onFace = (f) => {
    if (busyFace()) return;
    eye.lookAt(f.x * 1.1, f.y * 0.8, 900);
  };
  cam.onPresence = (present, awayMs) => {
    if (!present || !st.started) return;
    if (awayMs < cam.awayMs) return;
    // Someone's back after a while: wake up with a little greeting.
    st.greets++;
    activity("presence");
    eye.wake(false);
    eye.setMood("happy", 2.5); eye.blink(); if (eye.poke) eye.poke();
    const now = Date.now();
    if (settings.greetHi && !tts.speaking && !brain.busy && now - st.lastHi > Math.max(1, +settings.greetMinutes || 10) * 60000) {
      st.lastHi = now;
      say("Hi!", true);
    }
  };
  cam.onLight = (l) => {
    if (!st.started) return;
    if (l === "dark") {
      st.darkAt = Date.now();
      if (!tts.speaking && !brain.busy) eye.setMood("sleepy");
    } else {
      st.darkAt = 0;
      if (eye.asleep || eye.mood === "sleepy") { activity("tap"); eye.wake(true); }
    }
  };
  cam.onStartle = () => {
    if (!st.started || eye.asleep || tts.speaking) return;
    activity("motion");
    eye.setMood("surprised", 1.2);
    if (eye.poke) eye.poke();
  };
  // Curious glances (opt-in, off by default): one small photo every N minutes while someone is there.
  async function maybeGlance() {
    const now = Date.now();
    if (settings.glances === "off" || !st.started || !cam.on || !cam.present || !DB.store.getKey()) return;
    if (tts.speaking || brain.busy || listeningForCommand() || eye.asleep || stt.running) return;
    if (now - st.lastGlanceAsk < Math.max(1, +settings.glanceMinutes || 10) * 60000) return;
    st.lastGlanceAsk = now;
    try {
      const image = await cam.grab(320, 0.6);
      st.glances++;
      const r = await brain.ask("(Curious glance: nobody asked you anything. Look at this camera picture and make one short, friendly, " +
        "playful remark about something you notice, in under 15 words. Don't ask a question.)", image, { noHistory: true, maxTokens: 300 });
      if (tts.speaking || listeningForCommand()) return;
      eye.setMood(r.mood || "curious", 4);
      if (settings.glances === "speak") say(r.text, true); else showSaid(r.text, true);
    } catch (e) { /* a glance is optional: stay quiet on errors */ }
  }
  setInterval(maybeGlance, 20000);

  /* ---------------- always-on helpers ---------------- */
  async function requestWakeLock() {
    if (!settings.wakeLock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      st.wakeLock = await navigator.wakeLock.request("screen");
      st.wakeLock.addEventListener("release", () => { st.wakeLock = null; });
    } catch (e) { /* refused (battery saver) or not allowed yet */ }
  }
  function releaseWakeLock() { if (st.wakeLock) { st.wakeLock.release().catch(() => {}); st.wakeLock = null; } }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { cam.pause(); updateCamButtons(); return; }
    if (cam.paused && st.started) cam.resume().catch(() => {}).then(updateCamButtons);
    if (document.visibilityState === "visible" && st.started) {
      requestWakeLock();
      if (vad.running && vad.stream && vad.stream.getAudioTracks().some((t) => t.readyState !== "live")) vad.stop();
      ensureMic();                                  // reopens the detector's stream if the phone closed it; never starts recognition
    }
  });
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch (e) { showSaid("Full screen isn't available here."); }
  }

  /* ---------------- idle behaviour ---------------- */
  // Watchdog: no state may stick. Speaking with no end, or a mute that outlived the speech, would keep the
  // mic deaf for ever; "thinking" can't outlast the brain's own 45 s timeout.
  setInterval(() => {
    const now = Date.now();
    if (tts.speaking && tts.started && now - tts.started > STUCK_SPEAK_MS) { logEvent("watchdog: speech stuck, stopped it"); tts.cancel(); }
    if (!tts.speaking && st.muteUntil === Infinity) { st.muteUntil = now + TAIL_MS; st.mutePending = true; setTimeout(updateMute, TAIL_MS + 10); }
    if ((st.phase === "thinking" && !brain.busy && now - st.phaseAt > 3000) || (st.phase !== "idle" && now - st.phaseAt > STUCK_PHASE_MS)) {
      logEvent("watchdog: stuck in " + st.phase + ", back to idle"); setPhase("idle"); idleStatus();
    }
  }, 1000);
  setInterval(() => {
    if (!st.started) return;
    const now = Date.now(), idle = now - st.lastActivity;
    const sleepyAfter = Math.max(1, +settings.sleepyMinutes || 3) * 60000;
    if (tts.speaking || brain.busy || listeningForCommand()) { st.lastActivity = Math.max(st.lastActivity, now - 5000); return; }
    cam.setSlow(!!eye.asleep);
    if (st.darkAt && cam.light === "dark" && now - st.darkAt > 20000 && !eye.asleep) { eye.sleep(); $("controls").classList.add("dim"); }
    if (eye.asleep) return;
    if (idle > 20000 && now - st.lastGlance > 15000 && Math.random() < 0.15) {   // random glance with a double blink
      st.lastGlance = now;
      eye.lookAt(Math.random() < 0.5 ? -0.9 : 0.9, Math.random() * 0.6 - 0.3, 900);
      eye.blink(); setTimeout(() => eye.blink(), 380);
      if (Math.random() < 0.3 && eye.mood === "neutral") eye.setMood("curious", 2);
    }
    if (idle > sleepyAfter * 0.5 && now - st.lastYawn > 50000 && Math.random() < 0.08) { st.lastYawn = now; eye.yawn(); }
    if (idle > sleepyAfter && eye.mood !== "sleepy") eye.setMood("sleepy");
    if (idle > sleepyAfter * 2) { eye.sleep(); $("controls").classList.add("dim"); }
  }, 1000);

  /* ---------------- settings dialog ---------------- */
  function fillVoices() {
    const sel = $("sVoice"), cur = settings.voiceURI;
    const list = tts.voices().slice().sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    sel.textContent = "";
    const def = document.createElement("option"); def.value = ""; def.textContent = "Browser default"; sel.appendChild(def);
    for (const v of list) {
      const o = document.createElement("option");
      o.value = v.id; o.textContent = v.name + " (" + v.lang + ")" + (v.local ? "" : " · online");
      sel.appendChild(o);
    }
    sel.value = list.some((v) => v.id === cur) ? cur : "";
  }
  function keyState() {
    $("keyState").textContent = DB.store.getKey() ? "A key is saved on this device." : "No key saved.";
  }
  function openSettings() {
    const s = settings;
    $("sKey").value = "";
    $("sModel").value = s.model; $("sEffort").value = s.effort; $("sSystem").value = s.system; $("sMemory").value = s.memory;
    $("sWake").value = s.wakeWord; $("sWakeMode").value = s.wakeMode; $("sWakeAck").value = s.wakeAck; $("sListenMode").value = s.listenMode; $("sLang").value = s.lang;
    $("sName").value = s.name; $("sFollow").value = s.followUp;
    fillVoices();
    $("sRate").value = s.rate; $("sPitch").value = s.pitch; $("oRate").textContent = (+s.rate).toFixed(2); $("oPitch").textContent = (+s.pitch).toFixed(2);
    $("sCamera").value = s.camera; $("sMotion").checked = s.motion; $("sPreview").checked = s.preview;
    $("sFaceDetect").checked = s.faceDetect; $("sGreetHi").checked = s.greetHi; $("sGreetMin").value = s.greetMinutes;
    $("sGlances").value = s.glances; $("sGlanceMin").value = s.glanceMinutes;
    $("sSttEngine").value = s.sttEngine; $("sTtsEngine").value = s.ttsEngine; $("sLocalUrl").value = s.localUrl;
    $("sWhisperModel").value = s.whisperModel; $("sSrMode").value = s.srMode;
    $("sSens").value = s.sensitivity; $("oSens").textContent = s.sensitivity; $("sMicProc").value = s.micProcessing;
    $("sDiag").checked = s.diagnostics;
    $("calState").textContent = s.micCal ? "Calibrated: room " + s.micCal.noise.toFixed(4) + ", voice " + s.micCal.speech.toFixed(4) + "." : "Not calibrated (uses the automatic noise floor).";
    $("faceDetState").textContent = cam.detector || ("FaceDetector" in window) ? "This browser can detect faces on the device." : "This browser has no face detector, so the eyes follow motion only.";
    $("sWakeLock").checked = s.wakeLock; $("sSleepy").value = s.sleepyMinutes; $("sFace").value = s.face;
    keyState();
    $("settingsDlg").showModal();
    $("settingsForm").scrollTop = 0;
  }
  $("sSens").addEventListener("input", () => { $("oSens").textContent = $("sSens").value; });
  $("btnCalibrate").addEventListener("click", () => { $("settingsDlg").close("cancel"); calibrate(); });
  $("btnClearCal").addEventListener("click", () => {
    settings = Object.assign({}, settings, { micCal: null }); DB.store.saveSettings(settings); applyVadSettings();
    $("calState").textContent = "Not calibrated (uses the automatic noise floor).";
  });
  $("sRate").addEventListener("input", () => { $("oRate").textContent = (+$("sRate").value).toFixed(2); });
  $("sPitch").addEventListener("input", () => { $("oPitch").textContent = (+$("sPitch").value).toFixed(2); });
  $("btnClearKey").addEventListener("click", () => { DB.store.clearKey(); $("sKey").value = ""; keyState(); });
  $("btnResetSystem").addEventListener("click", () => { $("sSystem").value = DB.store.DEFAULT_SYSTEM; });
  $("btnTestVoice").addEventListener("click", () => {
    rememberSaid("Hi, I'm your desk buddy.");
    tts.speak("Hi, I'm your desk buddy.", { voice: $("sVoice").value, rate: +$("sRate").value, pitch: +$("sPitch").value, lang: $("sLang").value });
  });
  $("settingsDlg").addEventListener("close", () => {
    if ($("settingsDlg").returnValue !== "save") { $("sKey").value = ""; return; }
    const prev = settings;
    const num = (id, d) => { const v = parseFloat($(id).value); return isFinite(v) ? v : d; };
    const next = Object.assign({}, prev, {
      model: $("sModel").value.trim() || DB.store.DEFAULTS.model,
      effort: $("sEffort").value,
      system: $("sSystem").value.trim() || DB.store.DEFAULT_SYSTEM,
      memory: Math.max(0, Math.min(20, Math.round(num("sMemory", 6)))),
      wakeWord: $("sWake").value.trim() || DB.store.DEFAULTS.wakeWord,
      wakeAck: ["chime", "yes", "none"].includes($("sWakeAck").value) ? $("sWakeAck").value : "chime",
      wakeMode: ["on", "conversation", "off"].includes($("sWakeMode").value) ? $("sWakeMode").value : "on",
      listenMode: ["always", "tap", "off"].includes($("sListenMode").value) ? $("sListenMode").value : "always",
      name: $("sName").value.trim() || DB.store.DEFAULTS.name,
      lang: $("sLang").value.trim() || DB.store.DEFAULTS.lang,
      followUp: Math.max(0, Math.min(30, Math.round(num("sFollow", 8)))),
      voiceURI: $("sVoice").value,
      rate: num("sRate", 1), pitch: num("sPitch", 1),
      camera: $("sCamera").value, motion: $("sMotion").checked, preview: $("sPreview").checked,
      faceDetect: $("sFaceDetect").checked, greetHi: $("sGreetHi").checked,
      greetMinutes: Math.max(1, Math.min(240, Math.round(num("sGreetMin", 10)))),
      glances: ["off", "show", "speak"].includes($("sGlances").value) ? $("sGlances").value : "off",
      glanceMinutes: Math.max(2, Math.min(240, Math.round(num("sGlanceMin", 10)))),
      sttEngine: ["auto", "browser", "whisper"].includes($("sSttEngine").value) ? $("sSttEngine").value : "auto",
      whisperModel: $("sWhisperModel").value in DB.WHISPER_MODELS ? $("sWhisperModel").value : DB.store.DEFAULTS.whisperModel,
      srMode: ["auto", "shared", "release", "continuous"].includes($("sSrMode").value) ? $("sSrMode").value : "auto",
      sensitivity: Math.max(1, Math.min(10, Math.round(num("sSens", 6)))),
      micProcessing: $("sMicProc").value in DB.VoiceDetector.PROCESSING ? $("sMicProc").value : "balanced",
      diagnostics: $("sDiag").checked,
      ttsEngine: "browser",                                        // local server isn't built yet
      wakeLock: $("sWakeLock").checked,
      face: $("sFace").value === "eye" ? "eye" : "sphere",
      sleepyMinutes: Math.max(1, Math.min(120, Math.round(num("sSleepy", 3)))),
    });
    const key = $("sKey").value; $("sKey").value = "";
    if (key.trim()) DB.store.setKey(key);
    settings = next;
    DB.store.saveSettings(settings);
    applySettings(prev);
  });
  function applySettings(prev) {
    stt.setLang(settings.lang);
    if (settings.face !== prev.face) setFace(settings.face);
    const procChanged = applyVadSettings();
    const engineChanged = engineFor(settings) !== stt.kind || (isWhisper() && settings.whisperModel !== prev.whisperModel);
    if (settings.srMode !== prev.srMode) { if (settings.srMode !== "auto") DB.store.setLearnedStrategy(""); }
    if (engineChanged || settings.srMode !== prev.srMode) {
      switchEngine();
      if (st.started && settings.listenMode === "always") { if (!isWhisper() && st.strategy === "continuous") runContinuous(); else { if (procChanged) vad.stop(); vad.stop(); ensureMic(); } }
    } else if (procChanged && vad.running) { vad.stop(); ensureMic(); }
    showDiag();
    if (st.started) {
      if (settings.listenMode !== prev.listenMode) {
        if (settings.listenMode === "always") ensureMic();
        else { vad.stop(); clearTimeout(st.pendingStart); if (settings.listenMode === "off" && stt.running) stt.abort(); }
      }
      if (settings.camera !== prev.camera) {
        if (settings.camera === "off") cam.stop();
        else startCamera(settings.camera).then((ok) => { if (!ok) showSaid(cameraNote(), true); });
      }
      if (settings.wakeLock) requestWakeLock(); else releaseWakeLock();
    }
    updateCamButtons();
    idleStatus();
  }

  /* ---------------- notes dialog ---------------- */
  function renderNotes() {
    const list = DB.store.notes(), ul = $("notesList");
    ul.textContent = "";
    $("notesEmpty").hidden = list.length > 0;
    $("notesEmpty").textContent = 'No notes yet. Say "' + primaryWake() + ', take a note: buy milk".';
    for (const n of list.slice().reverse()) {
      const li = document.createElement("li");
      const t = document.createElement("div"); t.className = "t"; t.textContent = n.text;
      const tm = document.createElement("time"); tm.dateTime = n.at; tm.textContent = new Date(n.at).toLocaleString(); t.appendChild(tm);
      const del = document.createElement("button"); del.type = "button"; del.textContent = "✕"; del.title = "Delete this note";
      del.addEventListener("click", () => { DB.store.deleteNote(n.id); renderNotes(); });
      li.append(t, del); ul.appendChild(li);
    }
  }
  function openNotes() { renderNotes(); $("notesDlg").showModal(); }
  $("btnExportNotes").addEventListener("click", () => {
    const blob = new Blob([DB.store.notesMarkdown()], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    a.download = "desk-buddy-notes-" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + ".md";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("btnClearNotes").addEventListener("click", () => {
    if (DB.store.notes().length && confirm("Delete all notes on this device?")) { DB.store.clearNotes(); renderNotes(); }
  });

  /* ---------------- diagnostics strip ---------------- */
  const lvlPos = (v) => Math.max(0, Math.min(1, (Math.log10(Math.max(v, 1e-4)) + 4) / 3.3));   // 0.0001 .. 0.2, log scale
  function micState() {
    if (!st.started) return "not started";
    if (settings.listenMode === "off") return "mic off (settings)";
    if (tts.speaking) return "muted while speaking";
    if (muted()) return "muted (tail after speaking)";
    if (isWhisper()) {
      if (stt.state === "loading") return "loading model " + progressText();
      if (stt.running) return "voice: recording";
      if (stt.pending) return "transcribing";
      if (stt.armed) return "waiting for your voice";
    } else {
      if (stt.running) return st.strategy === "continuous" ? "recognising (continuous)" : "recognising";
      if (st.pendingStart) return "cooldown";
    }
    if (vad.inSpeech) return "voice";
    if (vad.running) return "idle";
    if (settings.listenMode === "tap") return "idle (tap to talk)";
    return "mic closed";
  }
  function engineText() {
    if (isWhisper()) {
      const m = String(settings.whisperModel).replace(/^.*whisper-/, "");
      const i = stt.info ? ", " + stt.info.device + " " + stt.info.dtype : "";
      const lat = stt.lastMs ? ", last " + (stt.lastMs / 1000).toFixed(1) + " s" : "";
      return "On-device Whisper (" + m + i + lat + (stt.state === "error" ? ", failed: " + stt.error : "") + ")";
    }
    const how = { shared: "shared mic", release: "mic released while recognising", continuous: "continuous fallback (beeps)" }[st.strategy];
    return "Web Speech: " + how + (settings.srMode === "auto" ? " (auto)" : " (forced)") + (st.srFails ? ", " + st.srFails + " miss" : "");
  }
  function showDiag() { $("diag").hidden = !settings.diagnostics; }
  function updateDiag() {
    if (!settings.diagnostics) return;
    const live = vad.running;
    $("dLvl").style.width = live ? (lvlPos(vad.level) * 100).toFixed(1) + "%" : "0%";
    $("dTh").style.left = (lvlPos(vad.threshold) * 100).toFixed(1) + "%";
    $("dTh").hidden = !live;
    $("dLvl").className = vad.inSpeech ? "voice" : vad.level > vad.threshold ? "over" : "";
    $("dState").textContent = micState();
    $("dEngine").textContent = engineText();
    $("dNums").textContent = live ? "level " + vad.level.toFixed(4) + " · threshold " + vad.threshold.toFixed(4) + " · floor " + vad.floor.toFixed(4) + (vad.ctx && vad.ctx.state !== "running" ? " · audio " + vad.ctx.state : "")
      : (st.strategy === "continuous" && !isWhisper() ? "no level meter in continuous mode (recognition has the mic)" : "mic level: not measuring");
    const ev = st.events[st.events.length - 1];
    $("dEvent").textContent = ev ? "last event: " + ev.name + " (" + Math.max(0, Math.round((Date.now() - ev.at) / 100) / 10) + " s ago)" : "last event: none yet";
    $("dText").textContent = "last heard: " + (st.lastTranscript ? "\u201c" + st.lastTranscript + "\u201d" : "nothing yet");
    const b = brain.last, nv = tts.voices().length;
    $("dReply").textContent = "reply: " + st.phase + (st.phase !== "idle" ? " " + Math.round((Date.now() - st.phaseAt) / 1000) + " s" : "") +
      " · wake word " + (settings.wakeMode === "on" ? "required" : settings.wakeMode === "off" ? "off" : wakeNeeded() ? "required (nobody on camera)" : "not needed (someone's here)") +
      (listeningForCommand() ? " · follow-up open" : "") +
      " · claude " + (!DB.store.getKey() ? "no key" : b ? (b.ok ? "ok " + (b.ms / 1000).toFixed(1) + " s" : b.text.slice(0, 90)) : "not asked yet") +
      " · voice out " + (tts.supported ? (tts.voiceUsed || "default") + ", " + nv + " voices" + (st.lastReply ? ", last " + st.lastReply : "") +
        (tts.lastError && Date.now() - tts.lastErrorAt < 120000 ? ", error: " + tts.lastError : "") : "unsupported");
    const lw = st.lastWake;
    $("dWake").textContent = "wake words: " + wakeList().map((w) => w.join(" ")).join(", ") + " · last match: " +
      (!lw ? "none yet" : (lw.path === "none" ? "none (no wake word in \u201c" + lw.text.slice(0, 40) + "\u201d)" :
        lw.path + (lw.heard ? " (heard \u201c" + lw.heard + "\u201d for " + lw.wake + ")" : "")) + " " + Math.round((Date.now() - lw.at) / 1000) + " s ago");
    $("dCam").textContent = cam.on ? "camera: on · " + cam.faceDetection + " · light " + cam.light + (cam.present ? " · someone here" : "") : "camera: " + (st.camError ? st.camError : "off");
  }
  setInterval(updateDiag, 150);
  showDiag();

  /* Calibrate: measure the room for 2 s, then your voice for 3 s, and put the threshold between them. */
  async function calibrate() {
    if (!st.started) await start();
    if (!vad.running) { await ensureMic(true); }
    if (!vad.running) { showSaid("I need the microphone to calibrate.", true); return; }
    stopSpeaking();
    st.muteUntil = Date.now() + 6000; vad.setMuted(true);       // don't react while calibrating
    showSaid("Calibrating: stay quiet for a moment…", true);
    await new Promise((r) => setTimeout(r, 300));
    const quiet = await vad.measure(2000);
    showSaid("Now talk normally for three seconds, like you would to me…", true);
    const loud = await vad.measure(3000);
    st.muteUntil = 0; updateMute();
    const noise = Math.max(0.0002, quiet.p50), speech = loud.p90;
    if (!(speech > noise * 1.8)) {
      showSaid("I couldn't hear a clear difference between quiet and talking (room " + noise.toFixed(4) + ", voice " + speech.toFixed(4) + "). Try again a bit closer.", true);
      return;
    }
    settings = Object.assign({}, settings, { micCal: { noise, speech, at: new Date().toISOString() } });
    DB.store.saveSettings(settings); applyVadSettings();
    showSaid("Calibrated: room " + noise.toFixed(4) + ", voice " + speech.toFixed(4) + ". I'll start listening above " + vad.threshold.toFixed(4) + ".", true);
  }

  /* ---------------- start ---------------- */
  async function start() {
    if (st.started) return;
    tts.unlock();                         // must happen inside the tap: Android won't speak otherwise
    st.started = true;
    $("startOverlay").hidden = true;
    activity("tap");
    requestWakeLock();
    if (isWhisper()) stt.load();                  // first time: downloads the model (then it's cached)
    ensureMic();          // "always" mode: open the mic stream once; recognition only starts when a voice is heard
    if (settings.camera !== "off") await startCamera(settings.camera);
    updateCamButtons();
    eye.setMood("happy", 2.5);
    const hi = !DB.store.getKey() ? "Hi! Add a Claude API key in settings so I can think."
      : settings.listenMode === "always" ? 'Hi! Say "' + primaryWake() + '" when you need me.'
      : "Hi! Press the microphone when you need me.";
    await say(hi, true);
    if (st.camError) showSaid(cameraNote(), true);
    idleStatus();
  }
  $("btnStart").addEventListener("click", start);
  if (!window.isSecureContext) $("secureWarn").hidden = false;
  if (!stt.supported) showSaid("Speech recognition isn't available in this browser. Use Chrome; the buttons still work.", true);

  wireSTT(); wireTTS(); fillVoices(); updateCamButtons(); idleStatus();
  // resume a suspended audio context on any touch (some phones suspend it)
  window.addEventListener("pointerdown", () => { tts.unlock(); if (vad.ctx && vad.ctx.state === "suspended") vad.ctx.resume().catch(() => {}); }, true);

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  // For debugging and the automated tests. Nothing here exposes the API key.
  window.deskBuddy = { get eye() { return eye; }, setFace, cam, brain, vad, get stt() { return stt; }, get tts() { return tts; }, get settings() { return settings; },
                       state: st, handleFinal, runCommand, afterWake, matchWake, wakeList, soundKey, skeleton, wakeNeeded, chime, setPhase, isEcho, echoScore, muted, startRecognition, showHeard, showSaid, start,
                       say, micState, engineText, calibrate, maybeGlance, runContinuous, srFailure, get strategy() { return st.strategy; } };
})();
