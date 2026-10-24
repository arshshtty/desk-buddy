/* Desk Buddy: the round animated eye, drawn on a <canvas>.
   Same look as the Round-Eye Face Tracker firmware (RoundEye.ino): navy skin, white eye, blue iris,
   blink every 1.5-6 s, idle wander, moods with lids. Geometry is in the firmware's 240 px units, scaled. */
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});

  const C = {
    skin: "rgb(10,14,30)", white: "rgb(245,245,245)", iris: "rgb(20,110,220)", iris2: "rgb(10,60,140)",
    pupil: "rgb(0,0,0)", shine: "rgb(255,255,255)", mouth: "rgba(200,215,245,0.85)", listen: "rgba(255,204,0,0.55)",
  };
  const MOODS = ["neutral", "happy", "curious", "surprised", "thinking", "sleepy", "angry"];
  const rand = (a, b) => a + Math.random() * (b - a);
  const ease = (k, dt) => 1 - Math.pow(1 - k, dt / 16.7);   // frame-rate independent easing

  function normMood(m) {
    m = String(m || "").toLowerCase();
    if (MOODS.includes(m)) return m;
    if (/^(exc|lov|joy|glad|pleas)/.test(m)) return "happy";
    if (/^(sad|tir)/.test(m)) return "sleepy";
    if (/^(sho|amaz|wow|conf)/.test(m)) return "surprised";
    if (/^(ske|grum|annoy|mad)/.test(m)) return "angry";
    if (/^(think|ponder|hmm)/.test(m)) return "thinking";
    if (/^(cur|inter)/.test(m)) return "curious";
    return "neutral";
  }

  class Eye {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext("2d");
      this.frames = 0;
      this.mood = "neutral"; this.moodUntil = 0;
      this.gx = 0; this.gy = 0; this.tx = 0; this.ty = 0;
      this.gazeUntil = 0; this.nextWander = 0;
      this.lid = 1; this.blinkStart = 0; this.blinking = false; this.nextBlink = performance.now() + 2000;
      this.pupil = 26;
      this.open = 1;              // extra lid factor: 0 when asleep, eased
      this.asleep = false;
      this.speaking = false; this.level = 0; this.boost = 0;
      this.listening = false;
      this.yawnStart = 0;
      this.tilt = 0;
      this.petUntil = 0;
      this.last = performance.now();
      this.lastDraw = 0;
      this.resize = this.resize.bind(this);
      window.addEventListener("resize", this.resize);
      this.resize();
      const loop = (t) => { this.tick(t); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = window.innerWidth; this.h = window.innerHeight;
      this.cv.width = Math.round(this.w * dpr); this.cv.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const usableH = this.h - 150;            // room for captions and buttons
      this.R = Math.max(60, Math.min(this.w * 0.42, usableH * 0.38));
      this.cx = this.w / 2;
      this.cy = Math.max(this.R + 40, usableH * 0.46);
    }

    /* ---- public API ---- */
    setMood(m, seconds) {
      m = normMood(m);
      this.mood = m;
      this.moodUntil = seconds > 0 ? performance.now() + seconds * 1000 : 0;
      if (m !== "sleepy") this.asleep = false;
      this.blink();
    }
    blink() { if (!this.blinking) { this.blinking = true; this.blinkStart = performance.now(); } }
    lookAt(x, y, holdMs) {
      this.tx = Math.max(-1, Math.min(1, x)); this.ty = Math.max(-1, Math.min(1, y));
      this.gazeUntil = performance.now() + (holdMs || 1500);
    }
    setSpeaking(on) { this.speaking = !!on; if (!on) this.boost = 0; }
    pulse() { this.boost = 1; }                     // call on each spoken word
    setListening(on) { this.listening = !!on; }
    yawn() { if (!this.asleep) this.yawnStart = performance.now(); }
    sleep() { this.asleep = true; this.mood = "sleepy"; this.moodUntil = 0; }
    wake(surprise) {
      const was = this.asleep || this.mood === "sleepy";
      this.asleep = false;
      if (was) this.setMood(surprise ? "surprised" : "neutral", surprise ? 1.2 : 0);
      return was;
    }
    pet(x, y) {
      this.wake(false);
      this.petUntil = performance.now() + 1800;
      this.setMood("happy", 3);
      if (x != null) this.lookAt((x - this.cx) / this.R, (y - this.cy) / this.R, 1200);
    }
    isOnEye(x, y) { return Math.hypot(x - this.cx, y - this.cy) < this.R * 1.1; }

    /* ---- animation ---- */
    tick(now) {
      const dt = Math.min(100, now - this.last);
      this.last = now;
      if (now - this.lastDraw < 30) return;      // about 30 fps is plenty, and kinder to an old phone's battery
      const fdt = now - this.lastDraw;
      this.lastDraw = now;
      this.update(now, fdt || dt);
      this.draw(now);
      this.frames++;
    }

    update(now, dt) {
      if (this.moodUntil && now > this.moodUntil) { this.mood = "neutral"; this.moodUntil = 0; }
      const sleepy = this.mood === "sleepy";
      const yawning = this.yawnStart && now - this.yawnStart < 2400;
      if (!yawning) this.yawnStart = 0;

      // gaze
      if (this.mood === "thinking" && now > this.gazeUntil) {
        this.tx = 0.55 + Math.sin(now / 900) * 0.08; this.ty = -0.55;
      } else if (now > this.gazeUntil && now > this.nextWander && !this.asleep) {
        const r = sleepy ? 0.25 : this.mood === "curious" ? 0.85 : 0.7;
        this.tx = rand(-1, 1) * r; this.ty = rand(-1, 1) * r * 0.6;
        this.nextWander = now + rand(900, 3000) * (sleepy ? 2 : 1);
      }
      if (this.asleep) { this.tx = 0; this.ty = 0.3; }
      const k = ease(sleepy ? 0.08 : 0.3, dt);
      this.gx += (this.tx - this.gx) * k; this.gy += (this.ty - this.gy) * k;

      // blink
      if (!this.blinking && now > this.nextBlink) this.blink();
      if (this.blinking) {
        const t = (now - this.blinkStart) / 160;
        if (t < 1) this.lid = 1 - t; else if (t < 2) this.lid = t - 1;
        else { this.lid = 1; this.blinking = false; this.nextBlink = now + rand(1500, 6000) * (sleepy ? 2 : 1); }
      }

      // lids for sleep and yawns
      let openWant = this.asleep ? 0 : 1;
      if (yawning) {
        const p = (now - this.yawnStart) / 2400;
        openWant = 1 - 0.75 * Math.sin(Math.PI * Math.min(1, p * 1.1));
      }
      if (this.asleep) openWant = 0.02 + 0.03 * (1 + Math.sin(now / 1400));   // slow breathing
      this.open += (openWant - this.open) * ease(this.asleep ? 0.04 : 0.15, dt);

      // pupil size
      const pw = { surprised: 14, happy: 30, angry: 20, curious: 32, thinking: 22 }[this.mood] || 26;
      this.pupil += (pw + (this.speaking ? this.level * 4 : 0) - this.pupil) * ease(0.2, dt);

      // mouth level while speaking: words give a kick, then it chatters and decays
      if (this.speaking) {
        this.boost = Math.max(0, this.boost - dt / 260);
        const chatter = 0.35 + 0.35 * Math.abs(Math.sin(now / 75)) * (0.6 + 0.4 * Math.sin(now / 210));
        const want = Math.min(1, chatter + this.boost * 0.5);
        this.level += (want - this.level) * ease(0.5, dt);
      } else {
        this.level += (0 - this.level) * ease(0.3, dt);
      }
      const tiltWant = this.mood === "curious" ? 0.14 : yawning ? -0.06 : 0;
      this.tilt += (tiltWant - this.tilt) * ease(0.1, dt);
    }

    draw(now) {
      const c = this.ctx, R = this.R, s = R / 112;
      const m = this.mood;
      c.fillStyle = C.skin;
      c.fillRect(0, 0, this.w, this.h);

      c.save();
      c.translate(this.cx, this.cy);
      c.rotate(this.tilt);

      const er = (m === "surprised" ? 112 : m === "curious" ? 108 : 104) * s;
      if (this.listening) {
        c.beginPath(); c.arc(0, 0, er + 9 * s, 0, Math.PI * 2);
        c.lineWidth = 5 * s; c.strokeStyle = C.listen; c.stroke();
      }
      c.beginPath(); c.arc(0, 0, er, 0, Math.PI * 2); c.fillStyle = C.white; c.fill();

      const ix = this.gx * 52 * s, iy = this.gy * 52 * s;
      const disk = (x, y, r, col) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = col; c.fill(); };
      disk(ix, iy, 52 * s, C.iris);
      disk(ix, iy, 40 * s, C.iris2);
      disk(ix, iy, this.pupil * s, C.pupil);
      disk(ix - 18 * s, iy - 20 * s, 10 * s, C.shine);
      disk(ix + 14 * s, iy + 16 * s, 4 * s, C.shine);

      // lids, clipped to the eye
      c.save();
      c.beginPath(); c.arc(0, 0, er + 1, 0, Math.PI * 2); c.clip();
      c.fillStyle = C.skin;
      let topOpen = this.lid * this.open;
      if (m === "sleepy") topOpen *= 0.45;
      if (m === "happy") topOpen *= 0.85;
      if (m === "thinking") topOpen *= 0.8;
      const topY = -er + (1 - topOpen) * 2 * er;
      if (topY > -er) {
        c.fillRect(-er - 20, -er - 20, 2 * er + 40, topY + er + 20);
        c.beginPath(); c.ellipse(0, topY, 130 * s, 22 * s, 0, 0, Math.PI * 2); c.fill();
      }
      if (m === "angry") {                         // slanted brow, like the firmware
        c.beginPath(); c.moveTo(-120 * s, -120 * s); c.lineTo(120 * s, -120 * s); c.lineTo(-120 * s, -10 * s); c.fill();
      }
      if (m === "curious") {                       // one side a little lower: "hmm?"
        c.beginPath(); c.moveTo(-120 * s, -120 * s); c.lineTo(120 * s, -120 * s); c.lineTo(120 * s, -58 * s);
        c.quadraticCurveTo(10 * s, -92 * s, -120 * s, -108 * s); c.closePath(); c.fill();
      }
      const petting = now < this.petUntil;
      if (m === "happy" || petting) {              // smiling lower lid (higher while being petted)
        disk(0, er + (petting ? 40 : 70) * s, 140 * s, C.skin);
      }
      c.restore();

      if (topOpen < 0.06 || this.open < 0.08) {    // closed line
        c.fillStyle = C.iris2;
        c.fillRect(-90 * s, -3 * s, 180 * s, 6 * s);
      }
      c.restore();

      this.drawMouth(now, s);
      if (this.asleep) this.drawZzz(now, s);
    }

    drawMouth(now, s) {
      const c = this.ctx, m = this.mood;
      const y = this.cy + this.R + 26 * s;
      c.save();
      c.translate(this.cx, y);
      c.fillStyle = C.mouth; c.strokeStyle = C.mouth; c.lineCap = "round";
      const yawning = this.yawnStart && now - this.yawnStart < 2400;
      if (yawning) {
        const p = Math.sin(Math.PI * Math.min(1, (now - this.yawnStart) / 2400));
        c.beginPath(); c.ellipse(0, 0, 16 * s + 8 * s * p, 4 * s + 22 * s * p, 0, 0, Math.PI * 2); c.fill();
      } else if (this.speaking || this.level > 0.05) {
        const h = 3 * s + this.level * 18 * s;
        c.beginPath(); c.ellipse(0, 0, 22 * s - this.level * 4 * s, h, 0, 0, Math.PI * 2); c.fill();
      } else if (m === "thinking") {
        for (let i = 0; i < 3; i++) {
          const b = Math.max(0, Math.sin(now / 220 - i * 0.9)) * 6 * s;
          c.beginPath(); c.arc((i - 1) * 14 * s, -b, 4 * s, 0, Math.PI * 2); c.fill();
        }
      } else if (m === "surprised") {
        c.lineWidth = 4 * s; c.beginPath(); c.arc(0, 0, 8 * s, 0, Math.PI * 2); c.stroke();
      } else if (m === "happy") {
        c.lineWidth = 5 * s; c.beginPath(); c.arc(0, -12 * s, 22 * s, 0.2 * Math.PI, 0.8 * Math.PI); c.stroke();
      } else if (m === "angry") {
        c.lineWidth = 5 * s; c.beginPath(); c.arc(0, 14 * s, 18 * s, 1.2 * Math.PI, 1.8 * Math.PI); c.stroke();
      } else {
        c.lineWidth = 5 * s; c.beginPath(); c.moveTo(-14 * s, 0); c.lineTo(14 * s, 0); c.stroke();
      }
      c.restore();
    }

    drawZzz(now, s) {
      const c = this.ctx;
      c.save();
      c.fillStyle = "rgba(200,215,245,0.8)";
      for (let i = 0; i < 3; i++) {
        const p = ((now / 2200 + i / 3) % 1);
        c.globalAlpha = Math.sin(Math.PI * p);
        c.font = "600 " + Math.round((14 + p * 16) * s) + "px system-ui, sans-serif";
        c.fillText("z", this.cx + this.R * 0.7 + p * 30 * s, this.cy - this.R * 0.7 - p * 60 * s);
      }
      c.restore();
    }
  }

  DB.Eye = Eye;
  DB.normMood = normMood;
  DB.MOODS = MOODS;
})();
