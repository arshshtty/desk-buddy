/* Desk Buddy: wiring. Voice detected -> one recognition session -> wake word -> command -> local intent or Claude
   -> speech, with the eye reacting throughout. While Buddy talks (and for 800 ms after) the mic is ignored,
   and anything that sounds like Buddy's own recent words is dropped, so it never answers itself. */
(function () {
  "use strict";
  const DB = window.DB;
  const $ = (id) => document.getElementById(id);

  let settings = DB.store.loadSettings();
  let eye = DB.makeFace(settings.face, $("eye"));   // "ball" (default) or "eye": same interface either way
  function setFace(kind) {
    const old = eye;
    if ((kind === "eye") === !(old instanceof DB.BallFace)) return;
    old.destroy();
    eye = DB.makeFace(kind, $("eye"));
    eye.adopt(old);
  }
  const cam = new DB.Camera($("preview"));
  let stt = DB.makeSTT(settings.sttEngine, { lang: settings.lang });
  let tts = DB.makeTTS(settings.ttsEngine);
  const notesApi = { add: (t) => DB.store.addNote(t), list: () => DB.store.notes() };
  const brain = new DB.Brain(() => settings, () => DB.store.getKey(), notesApi);
  const vad = new DB.VoiceDetector();

  const COOLDOWN_MS = 2000;     // recognition starts at most once every 2 s (each start beeps on Android)
  const TAIL_MS = 800;          // keep ignoring the mic this long after Buddy stops talking
  const BARGE_TAIL_MS = 300;    // shorter when the speech was cut off by a tap
  const ECHO_WINDOW_MS = 120000;

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
    releaseMic: false,      // fallback if a phone won't let recognition share the mic with the detector
  };

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
    if (stt.running) return setStatus(listeningForCommand() ? "Listening…" : "Hearing you…", "wake");
    if (listeningForCommand()) return setStatus(settings.listenMode === "always" ? "Listening… just talk" : "Press 🎙️ to talk", "wake");
    if (settings.listenMode === "off") return setStatus("Microphone off (settings)", "off");
    if (settings.listenMode === "tap") return setStatus("Press 🎙️ to talk", "off");
    if (vad.running) return setStatus('Say "' + settings.wakeWord + '…" or press 🎙️', "on");
    return setStatus("Mic starting…", "off");
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
  // Recognition starts a moment after you start speaking (on Android it can't be given the audio from
  // before it started), so the first syllable of the wake word can be lost: "Jarvis" -> "arvis"/"service",
  // "Buddy" -> "daddy". At the start of an utterance we accept a clipped or slightly wrong wake word.
  const nearLoose = (heard, want) => near(heard, want) ||
    (want.length >= 4 && lev(heard, want) <= 2) ||
    (heard.length >= 3 && want.length - heard.length <= 3 && want.endsWith(heard)) ||
    (want.length >= 5 && heard.length >= 3 && lev(heard, want.slice(Math.max(1, want.length - heard.length))) <= 1);
  /** Returns the words after the wake word, "" if it was said alone, or null if it wasn't said. */
  function afterWake(text) {
    const wt = tokens(settings.wakeWord), tt = tokens(text);
    if (!wt.length) return null;
    for (let i = 0; i + wt.length <= tt.length; i++) {
      // loose matching only for the first word, or the second after "hey"/"ok"/"hi"
      const loose = i === 0 || (i === 1 && /^(hey|hi|ok|okay|oi|yo)$/.test(tt[0]));
      if (wt.every((w, j) => (loose && j === 0 ? nearLoose : near)(tt[i + j], w))) return tt.slice(i + wt.length).join(" ");
    }
    return null;
  }

  /* Echo filter: a transcript made mostly of words Buddy just said is Buddy hearing itself. */
  const STOPWORDS = new Set(("a an the and or but so to of in on at for with from by as is it it's its i i'm you you're me my " +
    "your we he she they them this that there here be am are was were do does did have has had what what's how who " +
    "not no yes oh um uh like just").split(" "));
  function contentTokens(s) {
    const wake = new Set(tokens(settings.wakeWord));
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
  const isEcho = (text) => echoScore(text) > 0.5;
  const muted = () => tts.speaking || Date.now() < st.muteUntil;
  const STOP_RE = /^(stop|stop it|stop talking|be quiet|quiet|shut up|enough|never mind|nevermind|cancel|ok stop|okay stop)\b/i;

  function activity(kind) {
    st.lastActivity = Date.now();
    $("controls").classList.remove("dim");
    if (eye.asleep || eye.mood === "sleepy") eye.wake(kind === "speech" || kind === "tap");
  }

  /* ---------------- speech in ---------------- */
  // Only start recognition when it's needed: a voice onset in "always" mode, or a tap. At most once per COOLDOWN_MS.
  function startRecognition(source) {
    if (!st.started || settings.listenMode === "off" || stt.running || muted() || !stt.supported) return false;
    if (source === "voice" && settings.listenMode !== "always") return false;
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
    if (st.releaseMic && vad.running) vad.stop();
    st.lastSttStart = Date.now();
    st.sessionSource = source;
    const ok = stt.start({ track: st.releaseMic ? null : vad.track, source });
    idleStatus();
    return ok;
  }
  async function ensureMic() {
    if (!st.started || settings.listenMode !== "always" || vad.running || stt.running) return;
    try { await vad.start(); if (/^Microphone/.test(st.error)) st.error = ""; }
    catch (e) {
      st.error = "Microphone: " + (e && e.name === "NotAllowedError" ? "permission was refused" : (e && (e.message || e.name)) || "unavailable");
    }
    idleStatus();
  }
  function updateMute() {
    vad.setMuted(muted());
    if (!muted() && st.mutePending) { st.mutePending = false; idleStatus(); }
  }

  function wireSTT() {
    stt.onSpeech = () => { if (!muted()) activity("speech"); };
    stt.onState = (state, detail) => {
      if (state === "error") {
        // Some phones may not let recognition use the mic while the detector holds it open.
        if (/No microphone/.test(detail || "") && vad.running && !st.releaseMic) { st.releaseMic = true; return; }
        st.error = detail || "Microphone error";
      } else if (state === "listening") st.error = "";
      idleStatus();
    };
    stt.onEnd = () => {
      // No restart here. The next voice onset (or tap) starts the next session.
      if (st.releaseMic) ensureMic();
      const h = $("heard");
      if (h.classList.contains("partial")) showHeard("");
      idleStatus();
    };
    stt.onResult = (text, isFinal) => {
      if (muted()) { if (isFinal) st.drops.muted++; return; }
      if (!isFinal) { if (!isEcho(text)) showHeard(text, "partial"); return; }
      handleFinal(text);
    };
    vad.onVoiceStart = () => {
      if (muted()) return;
      if (eye.asleep || eye.mood === "sleepy") activity("voice"); else st.lastActivity = Date.now();
      startRecognition("voice");
    };
  }

  /** Handle one final transcript. Returns what happened, for the tests:
      "muted" | "echo" | "ignored" | "wake" | "stop" | "command" | "empty". */
  function handleFinal(text) {
    text = String(text || "").trim();
    if (!text) return "empty";
    if (muted()) { st.drops.muted++; return "muted"; }
    if (isEcho(text)) { st.drops.echo++; showHeard(""); return "echo"; }
    const wakeRest = afterWake(text);
    if (STOP_RE.test((wakeRest == null ? text : wakeRest).trim()) && (wakeRest !== null || listeningForCommand())) {
      showHeard(text);
      st.awaitUntil = st.followUntil = st.pttUntil = 0;
      eye.setListening(false); idleStatus();
      return "stop";
    }
    const now = Date.now();
    let cmd = null;
    if (wakeRest !== null) {
      activity("speech");
      showHeard(text);
      if (wakeRest) cmd = wakeRest;
      else {
        st.awaitUntil = now + 8000;
        eye.setMood("curious", 8); eye.setListening(true); idleStatus();
        setTimeout(() => { if (Date.now() >= st.awaitUntil) { eye.setListening(listeningForCommand()); idleStatus(); } }, 8100);
        return "wake";
      }
    } else if (listeningForCommand()) { activity("speech"); showHeard(text); cmd = text; }
    if (cmd == null) {                      // not for Buddy (no wake word): show it faintly, do nothing
      st.drops.ignored++;
      showHeard(text, true);
      return "ignored";
    }
    st.awaitUntil = st.pttUntil = st.followUntil = 0;
    eye.setListening(false);
    $("btnTalk").classList.remove("active");
    runCommand(cmd);
    return "command";
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
      if (tempCam && settings.camera === "off") cam.stop();
      updateCamButtons();
    }
    return ask(question || "What is this? Look at the picture and tell me briefly.", image);
  }

  async function ask(text, image) {
    const my = ++st.askToken;
    eye.setMood("thinking"); idleStatus();
    try {
      const reply = await brain.ask(text, image);
      if (my !== st.askToken) return;
      eye.setMood(reply.mood || "neutral", 6);
      await say(reply.text);
    } catch (e) {
      if (my !== st.askToken) return;
      eye.setMood("surprised", 2);
      const msg = e instanceof DB.BrainError ? e.message : "Something went wrong.";
      await say(msg, true);
    } finally { idleStatus(); }
  }

  /* ---------------- speech out ---------------- */
  function wireTTS() {
    tts.onStart = () => {
      // Hard mute: Buddy must never hear itself. Kill any running recognition and ignore the mic.
      st.muteUntil = Infinity;
      clearTimeout(st.pendingStart); st.pendingStart = 0;
      vad.setMuted(true);
      if (stt.running) stt.abort();
      if ($("heard").classList.contains("partial")) showHeard("");
      eye.setSpeaking(true); idleStatus();
    };
    tts.onWord = () => eye.pulse();
    tts.onEnd = () => {
      eye.setSpeaking(false);
      const tail = st.bargeAt && Date.now() - st.bargeAt < 200 ? BARGE_TAIL_MS : TAIL_MS;
      st.bargeAt = 0;
      st.muteUntil = Date.now() + tail;
      st.mutePending = true;
      setTimeout(updateMute, tail + 10);
      idleStatus();
    };
    tts.onVoices = () => fillVoices();
  }
  async function say(text, noFollow) {
    showSaid(text);
    if (!tts.supported) return;
    rememberSaid(text);
    await tts.speak(text, { voice: settings.voiceURI, rate: +settings.rate, pitch: +settings.pitch, lang: settings.lang });
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
    cam.motionOn = !!settings.motion;
  }
  cam.onMotion = (mv) => {
    if (mv.amount > 0.04) activity("motion");
    if (eye.asleep || eye.mood === "thinking" || (down && !down.barge)) return;
    eye.lookAt(mv.x, mv.y * 0.8, 700);
  };

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
  setInterval(() => {
    if (!st.started) return;
    const now = Date.now(), idle = now - st.lastActivity;
    const sleepyAfter = Math.max(1, +settings.sleepyMinutes || 3) * 60000;
    if (tts.speaking || brain.busy || listeningForCommand()) { st.lastActivity = Math.max(st.lastActivity, now - 5000); return; }
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
    $("sWake").value = s.wakeWord; $("sListenMode").value = s.listenMode; $("sLang").value = s.lang;
    $("sName").value = s.name; $("sFollow").value = s.followUp;
    fillVoices();
    $("sRate").value = s.rate; $("sPitch").value = s.pitch; $("oRate").textContent = (+s.rate).toFixed(2); $("oPitch").textContent = (+s.pitch).toFixed(2);
    $("sCamera").value = s.camera; $("sMotion").checked = s.motion; $("sPreview").checked = s.preview;
    $("sSttEngine").value = s.sttEngine; $("sTtsEngine").value = s.ttsEngine; $("sLocalUrl").value = s.localUrl;
    $("sWakeLock").checked = s.wakeLock; $("sSleepy").value = s.sleepyMinutes; $("sFace").value = s.face;
    keyState();
    $("settingsDlg").showModal();
    $("settingsForm").scrollTop = 0;
  }
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
      listenMode: ["always", "tap", "off"].includes($("sListenMode").value) ? $("sListenMode").value : "always",
      name: $("sName").value.trim() || DB.store.DEFAULTS.name,
      lang: $("sLang").value.trim() || DB.store.DEFAULTS.lang,
      followUp: Math.max(0, Math.min(30, Math.round(num("sFollow", 8)))),
      voiceURI: $("sVoice").value,
      rate: num("sRate", 1), pitch: num("sPitch", 1),
      camera: $("sCamera").value, motion: $("sMotion").checked, preview: $("sPreview").checked,
      sttEngine: "browser", ttsEngine: "browser",                  // local server isn't built yet
      wakeLock: $("sWakeLock").checked,
      face: $("sFace").value === "eye" ? "eye" : "ball",
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
    if (st.started) {
      if (settings.listenMode !== prev.listenMode) {
        if (settings.listenMode === "always") ensureMic();
        else { vad.stop(); clearTimeout(st.pendingStart); if (settings.listenMode === "off" && stt.running) stt.abort(); }
      }
      if (settings.camera !== prev.camera) {
        if (settings.camera === "off") cam.stop();
        else cam.start(settings.camera).catch((e) => showSaid("Camera: " + (e.message || e.name))).then(updateCamButtons);
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
    $("notesEmpty").textContent = 'No notes yet. Say "' + settings.wakeWord + ', take a note: buy milk".';
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

  /* ---------------- start ---------------- */
  async function start() {
    if (st.started) return;
    st.started = true;
    $("startOverlay").hidden = true;
    activity("tap");
    requestWakeLock();
    ensureMic();          // "always" mode: open the mic stream once; recognition only starts when a voice is heard
    if (settings.camera !== "off") {
      try { await cam.start(settings.camera); } catch (e) { showSaid("Camera: " + (e.message || e.name)); }
    }
    updateCamButtons();
    eye.setMood("happy", 2.5);
    const hi = !DB.store.getKey() ? "Hi! Add a Claude API key in settings so I can think."
      : settings.listenMode === "always" ? 'Hi! Say "' + settings.wakeWord + '" when you need me.'
      : "Hi! Press the microphone when you need me.";
    say(hi, true);
    idleStatus();
  }
  $("btnStart").addEventListener("click", start);
  if (!window.isSecureContext) $("secureWarn").hidden = false;
  if (!stt.supported) showSaid("Speech recognition isn't available in this browser. Use Chrome; the buttons still work.", true);

  wireSTT(); wireTTS(); fillVoices(); updateCamButtons(); idleStatus();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  // For debugging and the automated tests. Nothing here exposes the API key.
  window.deskBuddy = { get eye() { return eye; }, setFace, cam, brain, vad, get stt() { return stt; }, get tts() { return tts; }, get settings() { return settings; },
                       state: st, handleFinal, runCommand, afterWake, isEcho, echoScore, muted, startRecognition, showHeard, showSaid, start };
})();
