/* Desk Buddy: camera (getUserMedia), frame grabs for Claude, and on-device perception.

   Perception runs entirely in this page on a 160x120 copy of the picture, about 8 times a second
   (2 a second while Buddy sleeps). Nothing is sent anywhere. It reports:
     onMotion({x, y, amount})    where things move (x mirrored for the front camera, -1..1)
     onFace({x, y, size})        a face, where the browser has the FaceDetector API (Chrome on Android/ChromeOS/macOS)
     onPresence(present, awayMs) someone arrived (after being away awayMs) or left
     onLight("dark" | "light")   the room went dark, or the lights came back on
     onStartle(amount)           a big sudden movement
*/
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});
  const W = 160, H = 120;

  class Camera {
    constructor(video) {
      this.video = video;
      this.stream = null;
      this.facing = "user";
      this.onMotion = () => {}; this.onFace = () => {}; this.onPresence = () => {}; this.onLight = () => {}; this.onStartle = () => {};
      this.motionOn = true;
      this.small = document.createElement("canvas");
      this.small.width = W; this.small.height = H;
      this.sctx = this.small.getContext("2d", { willReadFrequently: true });
      this.prev = null; this.timer = 0; this.slow = false; this.paused = false; this.simulate = false;
      this.fps = 8;
      // perception state
      this.brightness = -1; this.light = "light"; this.darkSince = 0; this.lightSince = 0;
      this.present = false; this.lastSeen = 0; this.leftAt = Date.now(); this.awayMs = 120000; this.calm = 0;
      this.face = null; this.faceAt = 0; this.faceBusy = false; this.lastFaceTry = 0;
      this.detector = null;
      try { if ("FaceDetector" in window) this.detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 }); } catch (e) { this.detector = null; }
      this.stats = { frames: 0, motion: 0, faces: 0 };
    }
    get on() { return !!this.stream; }
    get supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
    get faceDetection() { return this.detector ? "FaceDetector" : "none (motion only)"; }

    async start(facing) {
      if (!this.supported) throw new Error("Camera isn't available here (it needs HTTPS or localhost)");
      if (facing) this.facing = facing;
      this.stop();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: this.facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 30 } },
      });
      // iPhone: the video must be muted + inline to play without a tap, and it must be playing for drawImage to get pixels.
      this.video.muted = true; this.video.playsInline = true; this.video.autoplay = true;
      this.video.setAttribute("playsinline", ""); this.video.setAttribute("muted", "");
      this.video.srcObject = this.stream;
      this.video.classList.toggle("mirror", this.facing === "user");
      try { await this.video.play(); } catch (e) { /* autoplay is muted, so this normally works */ }
      this.prev = null; this.brightness = -1; this.paused = false;
      this._loop();
    }
    stop() {
      clearTimeout(this.timer); this.timer = 0;
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.video.srcObject = null;
    }
    async flip() {
      const next = this.facing === "user" ? "environment" : "user";
      if (this.on) await this.start(next); else this.facing = next;
      return this.facing;
    }
    /** Turn the camera off while the page is hidden; resume() turns it back on. */
    pause() { if (this.on) { this.stop(); this.paused = true; } }
    async resume() { if (this.paused) { this.paused = false; await this.start(this.facing); } }
    setSlow(slow) { if (slow !== this.slow) { this.slow = slow; if (this.on) this._loop(); } }
    async ready(ms) {
      const v = this.video;
      if (v.paused && this.stream) { try { await v.play(); } catch (e) { /* ignore */ } }
      if (v.readyState >= 2 && v.videoWidth) return true;
      return new Promise((res) => {
        const ok = () => { if (v.readyState >= 2 && v.videoWidth) { clearTimeout(t); v.removeEventListener("loadeddata", ok); v.removeEventListener("canplay", ok); res(true); } };
        const t = setTimeout(() => { v.removeEventListener("loadeddata", ok); v.removeEventListener("canplay", ok); res(v.readyState >= 2 && !!v.videoWidth); }, ms || 2500);
        v.addEventListener("loadeddata", ok); v.addEventListener("canplay", ok);
      });
    }
    /** JPEG of the current frame as base64 (no data: prefix), longest side <= maxSide. */
    async grab(maxSide, quality) {
      if (!this.on) throw new Error("Camera is off");
      await this.ready();
      const v = this.video, w = v.videoWidth, h = v.videoHeight;
      if (!w || !h || v.readyState < 2) throw new Error("No camera frame yet");
      const k = Math.min(1, (maxSide || 768) / Math.max(w, h));
      const cv = document.createElement("canvas");
      cv.width = Math.round(w * k); cv.height = Math.round(h * k);
      cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
      const data = cv.toDataURL("image/jpeg", quality || 0.75).split(",")[1];
      if (!data || data.length < 200) throw new Error("The camera picture came out empty");
      this.lastGrab = { w: cv.width, h: cv.height, bytes: Math.round(data.length * 0.75), at: Date.now(), facing: this.facing };
      return data;
    }

    _loop() {
      clearTimeout(this.timer);
      const tick = () => {
        this.timer = setTimeout(tick, 1000 / (this.slow ? 2 : this.fps));
        try { this._frame(); } catch (e) { /* a frame can fail while the camera restarts */ }
      };
      this.timer = setTimeout(tick, 100);
    }
    _frame() {
      if (!this.on || this.simulate || this.video.readyState < 2) return;
      this.sctx.drawImage(this.video, 0, 0, W, H);
      const d = this.sctx.getImageData(0, 0, W, H).data;
      const g = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) g[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
      this.analyze(g, Date.now());
      this._detectFace();
    }

    /** One 160x120 grey frame (Uint8Array). Public so the tests can feed made-up frames. */
    analyze(g, now) {
      now = now || Date.now();
      this.stats.frames++;
      let sum = 0; for (let i = 0; i < g.length; i += 4) sum += g[i];
      const b = sum / (g.length / 4);
      const prevB = this.brightness;
      this.brightness = prevB < 0 ? b : prevB + (b - prevB) * 0.35;
      this._light(b, now);
      const p = this.prev; this.prev = g;
      if (!p || p.length !== g.length) return;
      // A sudden change in overall brightness is the lights (or auto-exposure), not movement.
      if (prevB >= 0 && Math.abs(b - prevB) > 25) { this.calm = 0; return; }
      let n = 0, sx = 0, sy = 0;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        const i = y * W + x;
        if (Math.abs(g[i] - p[i]) > 28) { n++; sx += x; sy += y; }
      }
      const amount = n / ((W / 2) * (H / 2));
      if (amount > 0.3 && this.calm >= 5 && this.light === "light") this.onStartle(amount);
      this.calm = amount < 0.05 ? this.calm + 1 : 0;
      if (amount < 0.015) { this._presence(false, now); return; }
      this._presence(true, now);
      if (amount > 0.7 || !this.motionOn) return;      // the whole picture changed: the camera moved
      let x = (sx / n / (W - 1)) * 2 - 1, y = (sy / n / (H - 1)) * 2 - 1;
      if (this.facing === "user") x = -x;                // front camera: its left is the screen's right
      this.stats.motion++;
      this.onMotion({ x, y, amount });
    }
    _light(b, now) {
      if (this.light === "light") {
        if (b < 22) { if (!this.darkSince) this.darkSince = now; if (now - this.darkSince > 4000) { this.light = "dark"; this.lightSince = 0; this.onLight("dark"); } }
        else this.darkSince = 0;
      } else if (b > 45) { if (!this.lightSince) this.lightSince = now; if (now - this.lightSince > 600) { this.light = "light"; this.darkSince = 0; this.onLight("light"); } }
      else this.lightSince = 0;
    }
    _presence(seen, now) {
      if (seen) {
        if (!this.present) {
          const away = now - this.leftAt;
          this.present = true; this.onPresence(true, away);
        }
        this.lastSeen = now;
      } else if (this.present && now - this.lastSeen > this.awayMs) {
        this.present = false; this.leftAt = this.lastSeen; this.onPresence(false, 0);
      }
    }
    async _detectFace() {
      if (!this.detector || this.faceBusy || Date.now() - this.lastFaceTry < (this.slow ? 2000 : 400)) return;
      this.faceBusy = true; this.lastFaceTry = Date.now();
      try {
        const faces = await this.detector.detect(this.small);
        if (faces && faces.length) this.reportFace(faces[0].boundingBox, W, H);
      } catch (e) { this.detector = null; }                // not usable on this device: motion only
      finally { this.faceBusy = false; }
    }
    /** A face box in a w x h picture (public so the tests can feed one). */
    reportFace(box, w, h) {
      let x = ((box.x + box.width / 2) / w) * 2 - 1, y = ((box.y + box.height / 2) / h) * 2 - 1;
      if (this.facing === "user") x = -x;
      this.face = { x, y, size: box.width / w }; this.faceAt = Date.now(); this.stats.faces++;
      this._presence(true, Date.now());
      this.onFace(this.face);
    }
  }

  DB.Camera = Camera;
})();
