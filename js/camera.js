/* Desk Buddy: camera (getUserMedia), frame grabs for Claude, and light motion detection. */
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});

  class Camera {
    constructor(video) {
      this.video = video;
      this.stream = null;
      this.facing = "user";
      this.onMotion = () => {};
      this.motionOn = false;
      this.small = document.createElement("canvas");
      this.small.width = 40; this.small.height = 30;
      this.sctx = this.small.getContext("2d", { willReadFrequently: true });
      this.prev = null;
      this.timer = 0;
    }
    get on() { return !!this.stream; }
    get supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

    async start(facing) {
      if (!this.supported) throw new Error("Camera isn't available here (it needs HTTPS or localhost)");
      if (facing) this.facing = facing;
      this.stop();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: this.facing }, width: { ideal: 640 }, height: { ideal: 480 } },
      });
      this.video.srcObject = this.stream;
      this.video.classList.toggle("mirror", this.facing === "user");
      try { await this.video.play(); } catch (e) { /* autoplay is muted, so this normally works */ }
      this.prev = null;
      this._loop();
    }
    stop() {
      clearInterval(this.timer); this.timer = 0;
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.video.srcObject = null;
    }
    async flip() {
      const next = this.facing === "user" ? "environment" : "user";
      if (this.on) await this.start(next); else this.facing = next;
      return this.facing;
    }
    async ready(ms) {
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth) return true;
      return new Promise((res) => {
        const t = setTimeout(() => res(false), ms || 2500);
        v.addEventListener("loadeddata", () => { clearTimeout(t); res(true); }, { once: true });
      });
    }
    /** JPEG of the current frame as base64 (no data: prefix), longest side <= maxSide. */
    async grab(maxSide, quality) {
      if (!this.on) throw new Error("Camera is off");
      await this.ready();
      const v = this.video, w = v.videoWidth, h = v.videoHeight;
      if (!w || !h) throw new Error("No camera frame yet");
      const k = Math.min(1, (maxSide || 768) / Math.max(w, h));
      const cv = document.createElement("canvas");
      cv.width = Math.round(w * k); cv.height = Math.round(h * k);
      cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
      return cv.toDataURL("image/jpeg", quality || 0.75).split(",")[1];
    }

    _loop() {
      clearInterval(this.timer);
      this.timer = setInterval(() => this._motion(), 150);
    }
    _motion() {
      if (!this.motionOn || !this.on || this.video.readyState < 2) return;
      const W = 40, H = 30;
      this.sctx.drawImage(this.video, 0, 0, W, H);
      const d = this.sctx.getImageData(0, 0, W, H).data;
      const g = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) g[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
      const p = this.prev; this.prev = g;
      if (!p) return;
      let n = 0, sx = 0, sy = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (Math.abs(g[i] - p[i]) > 28) { n++; sx += x; sy += y; }
      }
      const amount = n / (W * H);
      if (amount < 0.02 || amount > 0.6) return;       // too little is noise; too much is the camera moving or the lights changing
      let x = (sx / n / (W - 1)) * 2 - 1, y = (sy / n / (H - 1)) * 2 - 1;
      // The front camera faces the same way as the eye: something on the camera's left is on the screen's right.
      if (this.facing === "user") x = -x;
      this.onMotion({ x, y, amount });
    }
  }

  DB.Camera = Camera;
})();
