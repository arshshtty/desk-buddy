/* Desk Buddy: wiring. Wake word -> command -> local intent or Claude -> speech, with the eye reacting throughout. */
(function () {
  "use strict";
  const DB = window.DB;
  const $ = (id) => document.getElementById(id);

  let settings = DB.store.loadSettings();
  const eye = new DB.Eye($("eye"));
  const cam = new DB.Camera($("preview"));
  let stt = DB.makeSTT(settings.sttEngine, { lang: settings.lang });
  let tts = DB.makeTTS(settings.ttsEngine);
  const notesApi = { add: (t) => DB.store.addNote(t), list: () => DB.store.notes() };
  const brain = new DB.Brain(() => settings, () => DB.store.getKey(), notesApi);

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
  };

  /* ---------------- small helpers ---------------- */
  function setStatus(text, dot) {
    $("statusText").textContent = text;
    const d = $("micDot");
    d.className = "dot " + (dot || (stt.running ? "on" : "off"));
  }
  function idleStatus() {
    if (!st.started) return setStatus("Tap to start", "off");
    if (st.error) return setStatus(st.error, "err");
    if (tts.speaking) return setStatus("Speaking… tap the eye to stop", "on");
    if (brain.busy) return setStatus("Thinking…", "on");
    if (listeningForCommand()) return setStatus("Listening…", "wake");
    if (stt.running) return setStatus('Say "' + settings.wakeWord + '…" or press 🎙️', "on");
    return setStatus(settings.alwaysListen ? "Mic starting…" : "Press 🎙️ to talk", "off");
  }
  function listeningForCommand() {
    const now = Date.now();
    return now < st.awaitUntil || now < st.followUntil || now < st.pttUntil;
  }
  function showHeard(final, interim) {
    const el = $("heard");
    el.textContent = final || "";
    if (interim) { const s = document.createElement("span"); s.className = "interim"; s.textContent = (final ? " " : "") + interim; el.appendChild(s); }
  }
  function showSaid(text) { $("said").textContent = text || ""; }

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
  /** Returns the words after the wake word, "" if it was said alone, or null if it wasn't said. */
  function afterWake(text) {
    const wt = tokens(settings.wakeWord), tt = tokens(text);
    if (!wt.length) return null;
    for (let i = 0; i + wt.length <= tt.length; i++) {
      if (wt.every((w, j) => near(tt[i + j], w))) return tt.slice(i + wt.length).join(" ");
    }
    return null;
  }
  const STOP_RE = /^(stop|stop it|stop talking|be quiet|quiet|shut up|enough|never mind|nevermind|cancel|ok stop|okay stop)\b/i;

  function activity(kind) {
    st.lastActivity = Date.now();
    $("controls").classList.remove("dim");
    if (eye.asleep || eye.mood === "sleepy") eye.wake(kind === "speech" || kind === "tap");
  }

  /* ---------------- speech in ---------------- */
  function wireSTT() {
    stt.onSpeech = () => activity("speech");
    stt.onState = (state, detail) => {
      st.error = state === "error" ? detail || "Microphone error" : "";
      idleStatus();
    };
    stt.onResult = (text, isFinal) => {
      if (!isFinal) {
        showHeard("", text);
        if (tts.speaking) {
          if (settings.barge === "any" && text.length > 3) stopSpeaking();
          else if (settings.barge === "wake" && (afterWake(text) !== null || STOP_RE.test(text.trim()))) stopSpeaking();
        }
        return;
      }
      showHeard(text, "");
      handleFinal(text);
    };
  }

  function handleFinal(text) {
    activity("speech");
    const wakeRest = afterWake(text);
    if (tts.speaking) {
      if (settings.barge === "tap") return;
      if (settings.barge === "wake" && wakeRest === null && !STOP_RE.test(text.trim())) return;  // probably hearing itself
      stopSpeaking();
    }
    if (STOP_RE.test((wakeRest == null ? text : wakeRest).trim()) && (wakeRest !== null || listeningForCommand())) {
      st.awaitUntil = st.followUntil = st.pttUntil = 0;
      eye.setListening(false); idleStatus();
      return;
    }
    const now = Date.now();
    let cmd = null;
    if (wakeRest !== null) {
      if (wakeRest) cmd = wakeRest;
      else {
        st.awaitUntil = now + 8000;
        eye.setMood("curious", 8); eye.setListening(true); idleStatus();
        setTimeout(() => { if (Date.now() >= st.awaitUntil) { eye.setListening(listeningForCommand()); idleStatus(); } }, 8100);
        return;
      }
    } else if (listeningForCommand()) cmd = text;
    if (cmd == null) return;
    st.awaitUntil = st.pttUntil = st.followUntil = 0;
    eye.setListening(false);
    if (!settings.alwaysListen) stt.stop();
    runCommand(cmd);
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
      eye.setSpeaking(true); idleStatus();
      if (settings.barge === "tap" && stt.running) stt.stop();
    };
    tts.onWord = () => eye.pulse();
    tts.onEnd = () => {
      eye.setSpeaking(false);
      if (settings.barge === "tap" && settings.alwaysListen && st.started) stt.start();
      idleStatus();
    };
    tts.onVoices = () => fillVoices();
  }
  async function say(text, noFollow) {
    showSaid(text);
    if (!tts.supported) return;
    await tts.speak(text, { voice: settings.voiceURI, rate: +settings.rate, pitch: +settings.pitch, lang: settings.lang });
    if (!noFollow && settings.followUp > 0 && st.started) {
      st.followUntil = Date.now() + settings.followUp * 1000;
      if (!stt.running && !settings.alwaysListen) stt.start();
      eye.setListening(true); idleStatus();
      setTimeout(() => {
        if (!listeningForCommand()) {
          eye.setListening(false);
          if (!settings.alwaysListen && !brain.busy && !tts.speaking) stt.stop();
          idleStatus();
        }
      }, settings.followUp * 1000 + 100);
    }
  }
  function stopSpeaking() {
    if (tts.speaking) { tts.cancel(); eye.setSpeaking(false); eye.setMood("surprised", 0.8); }
  }

  /* ---------------- touch: pet, poke, barge-in ---------------- */
  let down = null;
  $("eye").addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, dist: 0, t: Date.now(), petted: false };
    activity("tap");
    if (tts.speaking) { stopSpeaking(); down.barge = true; return; }
    if (eye.isOnEye(e.clientX, e.clientY)) eye.pet(e.clientX, e.clientY);
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
      showSaid(["Mmm, that's nice.", "Hehe.", "Purrr…", "More, please."][Math.floor(Math.random() * 4)]);
    }
  });
  const up = () => { down = null; };
  $("eye").addEventListener("pointerup", up);
  $("eye").addEventListener("pointercancel", up);

  /* ---------------- buttons ---------------- */
  function pushToTalk() {
    if (!st.started) return start();
    activity("tap");
    stopSpeaking();
    st.pttUntil = Date.now() + 8000;
    eye.setMood("curious", 8); eye.setListening(true);
    if (!stt.running) stt.start();
    $("btnTalk").classList.add("active");
    idleStatus();
    setTimeout(() => {
      if (Date.now() >= st.pttUntil) {
        $("btnTalk").classList.remove("active");
        if (!listeningForCommand()) {
          eye.setListening(false);
          if (!settings.alwaysListen && !brain.busy && !tts.speaking) stt.stop();
        }
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
      if (settings.alwaysListen) stt.start();
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
    $("sWake").value = s.wakeWord; $("sAlwaysListen").checked = s.alwaysListen; $("sLang").value = s.lang;
    $("sBarge").value = s.barge; $("sFollow").value = s.followUp;
    fillVoices();
    $("sRate").value = s.rate; $("sPitch").value = s.pitch; $("oRate").textContent = (+s.rate).toFixed(2); $("oPitch").textContent = (+s.pitch).toFixed(2);
    $("sCamera").value = s.camera; $("sMotion").checked = s.motion; $("sPreview").checked = s.preview;
    $("sSttEngine").value = s.sttEngine; $("sTtsEngine").value = s.ttsEngine; $("sLocalUrl").value = s.localUrl;
    $("sWakeLock").checked = s.wakeLock; $("sSleepy").value = s.sleepyMinutes;
    keyState();
    $("settingsDlg").showModal();
    $("settingsForm").scrollTop = 0;
  }
  $("sRate").addEventListener("input", () => { $("oRate").textContent = (+$("sRate").value).toFixed(2); });
  $("sPitch").addEventListener("input", () => { $("oPitch").textContent = (+$("sPitch").value).toFixed(2); });
  $("btnClearKey").addEventListener("click", () => { DB.store.clearKey(); $("sKey").value = ""; keyState(); });
  $("btnResetSystem").addEventListener("click", () => { $("sSystem").value = DB.store.DEFAULT_SYSTEM; });
  $("btnTestVoice").addEventListener("click", () => {
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
      alwaysListen: $("sAlwaysListen").checked,
      lang: $("sLang").value.trim() || DB.store.DEFAULTS.lang,
      barge: $("sBarge").value,
      followUp: Math.max(0, Math.min(30, Math.round(num("sFollow", 8)))),
      voiceURI: $("sVoice").value,
      rate: num("sRate", 1), pitch: num("sPitch", 1),
      camera: $("sCamera").value, motion: $("sMotion").checked, preview: $("sPreview").checked,
      sttEngine: "browser", ttsEngine: "browser",                  // local server isn't built yet
      wakeLock: $("sWakeLock").checked,
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
    if (st.started) {
      if (settings.alwaysListen && !stt.running) stt.start();
      if (!settings.alwaysListen && prev.alwaysListen) stt.stop();
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
    if (settings.alwaysListen) stt.start();
    if (settings.camera !== "off") {
      try { await cam.start(settings.camera); } catch (e) { showSaid("Camera: " + (e.message || e.name)); }
    }
    updateCamButtons();
    eye.setMood("happy", 2.5);
    const hi = DB.store.getKey()
      ? 'Hi! Say "' + settings.wakeWord + '" when you need me.'
      : "Hi! Add a Claude API key in settings so I can think.";
    say(hi, true);
    idleStatus();
  }
  $("btnStart").addEventListener("click", start);
  if (!window.isSecureContext) $("secureWarn").hidden = false;
  if (!stt.supported) showHeard("Speech recognition isn't available in this browser. Use Chrome; the buttons still work.", "");

  wireSTT(); wireTTS(); fillVoices(); updateCamButtons(); idleStatus();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  // For debugging and the automated tests. Nothing here exposes the API key.
  window.deskBuddy = { eye, cam, brain, get stt() { return stt; }, get tts() { return tts; }, get settings() { return settings; },
                       state: st, handleFinal, runCommand, afterWake, start };
})();
