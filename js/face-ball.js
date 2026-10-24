/* Desk Buddy: the "Round ball" face (default). An original character: a big glowing
   tangerine planet with faint bands, two large glossy eyes, eyebrows, blush cheeks and a big
   stretchy mouth. Behaviour (gaze, blinks, moods, sleep, yawns, speech level) comes from DB.Eye;
   this file only adds a little physics (breathing bob, squish) and draws.
   Plain canvas 2D, ~30 fps, no blur filters. */
(function () {
  "use strict";
  const DB = window.DB;
  const ease = (k, dt) => 1 - Math.pow(1 - k, dt / 16.7);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  const C = {
    bg: "rgb(9,12,28)",
    ball0: "#ffd58a", ball1: "#ff9f43", ball2: "#e8632b", band: "rgba(255,240,210,0.13)",
    glow: "rgba(255,160,70,", rim: "rgba(255,230,190,0.35)",
    white: "#fdfdf8", whiteShade: "rgba(40,30,60,0.10)", iris: "#2f7d6d", iris2: "#1d5247", pupil: "#141018",
    shine: "rgba(255,255,255,0.95)", brow: "#6a2f14", blush: "rgba(255,90,120,",
    mouth: "#4a1626", lip: "#7a2a1a", tongue: "#ff7a8a", teeth: "#fffaf0",
    listen: "rgba(255,230,90,", moon: "#e9f0ff", z: "rgba(255,235,200,0.85)",
  };

  // Mouth targets per mood: smile (-1 frown .. 1 grin), open (0..1), width (x R), skew
  const MOUTH = {
    neutral:   { smile: 0.35, open: 0.0, width: 0.30, skew: 0 },
    happy:     { smile: 1.0,  open: 0.35, width: 0.40, skew: 0 },
    curious:   { smile: 0.1,  open: 0.18, width: 0.14, skew: 0.25 },
    surprised: { smile: 0.0,  open: 0.75, width: 0.15, skew: 0 },
    thinking:  { smile: -0.1, open: 0.0, width: 0.18, skew: 0.5 },
    sleepy:    { smile: 0.15, open: 0.05, width: 0.16, skew: 0 },
    angry:     { smile: -0.9, open: 0.0, width: 0.26, skew: 0 },
  };
  // Eyebrows per mood: raise (-1 down .. 1 up), inner tilt (+ = angry V), asymmetric lift of the right brow
  const BROW = {
    neutral: [0.1, 0, 0], happy: [0.45, -0.25, 0], curious: [0.2, 0, 0.55], surprised: [1, -0.1, 0],
    thinking: [0.1, 0.1, 0.5], sleepy: [-0.25, -0.3, 0], angry: [-0.6, 1.6, 0],
  };

  class BallFace extends DB.Eye {
    constructor(canvas) {
      super(canvas);
      this.kind = "ball";
      this.sq = 0; this.sqv = 0;                  // squish spring (poke / pet)
      this.mo = Object.assign({}, MOUTH.neutral);  // current mouth shape (eased)
      this.br = BROW.neutral.slice();
      this.blush = 0.35;
    }
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = window.innerWidth; this.h = window.innerHeight;
      this.cv.width = Math.round(this.w * dpr); this.cv.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const usableH = this.h - 150;                 // captions and buttons below
      this.R = Math.max(70, Math.min(this.w * 0.49, usableH * 0.5));
      this.cx = this.w / 2;
      this.cy = Math.max(this.R + 30, usableH * 0.5 + 10);
      this.bgGrad = null;
    }
    isOnEye(x, y) { return Math.hypot(x - this.cx, y - this.cy) < this.R * 1.02; }
    pet(x, y) { super.pet(x, y); this.sqv -= 0.05; }
    poke() { this.sqv += 0.08; }
    lookAt(x, y, ms) { super.lookAt(x, y, ms); }

    update(now, dt) {
      super.update(now, dt);
      // squish spring
      const kS = 0.012 * dt, damp = Math.pow(0.86, dt / 16.7);
      this.sqv = (this.sqv - this.sq * kS) * damp; this.sq += this.sqv * dt / 16.7;
      if (this.speaking) this.sq += (this.level * 0.02 - this.sq) * 0.05;
      // mouth and brows ease toward the mood
      const m = this.asleep ? "sleepy" : this.mood, mt = MOUTH[m] || MOUTH.neutral, bt = BROW[m] || BROW.neutral;
      const k = ease(0.18, dt);
      for (const key of ["smile", "open", "width", "skew"]) this.mo[key] += (mt[key] - this.mo[key]) * k;
      for (let i = 0; i < 3; i++) this.br[i] += (bt[i] - this.br[i]) * k;
      const petting = now < this.petUntil;
      const bw = petting ? 1 : m === "happy" ? 0.7 : m === "angry" ? 0.15 : 0.35;
      this.blush += (bw - this.blush) * ease(0.08, dt);
    }

    draw(now) {
      const c = this.ctx, R = this.R, m = this.mood;
      c.fillStyle = C.bg; c.fillRect(0, 0, this.w, this.h);

      const breathe = Math.sin(now / (this.asleep ? 1700 : 1200));
      const bob = breathe * R * (this.asleep ? 0.018 : 0.012);
      const sx = 1 + this.sq + breathe * 0.006, sy = 1 - this.sq - breathe * 0.004;

      c.save();
      c.translate(this.cx, this.cy + bob);
      c.rotate(this.tilt * 0.5);

      // soft glow: a few translucent rings (cheaper than a blur filter)
      for (let i = 4; i >= 1; i--) {
        c.beginPath(); c.arc(0, 0, R * (1 + i * 0.045), 0, Math.PI * 2);
        c.fillStyle = C.glow + (0.05 * (5 - i) / 4).toFixed(3) + ")"; c.fill();
      }
      if (this.listening) {
        const p = 0.45 + 0.25 * Math.sin(now / 260);
        c.beginPath(); c.arc(0, 0, R * 1.07, 0, Math.PI * 2);
        c.lineWidth = R * 0.025; c.strokeStyle = C.listen + p.toFixed(2) + ")"; c.stroke();
      }

      c.save();
      c.scale(sx, sy);
      // the planet
      const g = c.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.1, 0, 0, R);
      g.addColorStop(0, C.ball0); g.addColorStop(0.55, C.ball1); g.addColorStop(1, C.ball2);
      c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fillStyle = g; c.fill();
      // faint bands that drift slowly, clipped to the ball
      c.save();
      c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.clip();
      c.fillStyle = C.band;
      const drift = (now / 9000) % 1;
      for (let i = -2; i <= 2; i++) {
        const y = (i + drift * 0.3) * R * 0.42;
        c.beginPath(); c.ellipse(0, y + R * 0.08, R * 1.3, R * 0.05, -0.08, 0, Math.PI * 2); c.fill();
      }
      c.restore();
      c.beginPath(); c.arc(0, 0, R * 0.985, 0, Math.PI * 2); c.lineWidth = R * 0.02; c.strokeStyle = C.rim; c.stroke();

      // blush cheeks
      const ba = this.blush;
      for (const side of [-1, 1]) {
        c.fillStyle = C.blush + (0.10 * ba).toFixed(3) + ")";
        c.beginPath(); c.ellipse(side * R * 0.56, R * 0.2, R * 0.17, R * 0.1, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = C.blush + (0.16 * ba).toFixed(3) + ")";
        c.beginPath(); c.ellipse(side * R * 0.56, R * 0.2, R * 0.11, R * 0.065, 0, 0, Math.PI * 2); c.fill();
      }

      this.drawEyes(now);
      this.drawMouth2(now);
      c.restore();   // scale

      if (m === "thinking" && !this.asleep) this.drawMoon(now);
      c.restore();

      if (this.asleep) this.drawZzz2(now);
    }

    drawEyes(now) {
      const c = this.ctx, R = this.R, m = this.mood;
      const ew = R * (m === "surprised" ? 0.28 : 0.26), ehBase = R * (m === "surprised" ? 0.34 : 0.31);
      const ex = R * 0.34, ey = -R * 0.13;
      // openness: blink (squash and stretch) * sleep/yawn lids * mood
      let open = this.lid * this.open;
      if (m === "sleepy") open *= 0.5;
      if (m === "thinking") open *= 0.85;
      const blinkSquash = 1 - this.lid;                 // 0 open .. 1 shut
      const petting = now < this.petUntil;
      const happyLid = (m === "happy" || petting) ? (petting ? 0.55 : 0.35) : 0;

      for (const side of [-1, 1]) {
        const cx = side * ex;
        const w = ew * (1 + 0.14 * blinkSquash), h = ehBase * (0.9 + 0.1 * this.lid);
        c.save();
        c.translate(cx, ey);
        if (m === "curious" && side === 1) c.scale(1.08, 1.08);
        // eye white with a soft shade at the top
        c.beginPath(); c.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
        c.fillStyle = C.white; c.fill();
        c.save(); c.clip();
        c.fillStyle = C.whiteShade; c.beginPath(); c.ellipse(0, -h * 0.9, w * 1.2, h * 0.45, 0, 0, Math.PI * 2); c.fill();
        // iris + pupil follow the gaze
        const ix = this.gx * w * 0.45, iy = this.gy * h * 0.42;
        const ir = w * 0.62, pr = ir * (this.pupil / 40);
        const disk = (x, y, r, col) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = col; c.fill(); };
        disk(ix, iy, ir, C.iris);
        disk(ix, iy, ir * 0.78, C.iris2);
        disk(ix, iy, clamp(pr, ir * 0.3, ir * 0.75), C.pupil);
        disk(ix - ir * 0.32, iy - ir * 0.36, ir * 0.24, C.shine);   // glossy highlights
        disk(ix + ir * 0.3, iy + ir * 0.3, ir * 0.1, C.shine);
        c.globalAlpha = 0.35; disk(-w * 0.45, -h * 0.5, w * 0.12, "#fff"); c.globalAlpha = 1;
        // lids in skin colour (top: open/blink, bottom: happy squint)
        c.fillStyle = C.ball1;
        const topY = -h + (1 - open) * 2 * h;
        if (topY > -h) {
          c.beginPath(); c.moveTo(-w - 2, -h - 2); c.lineTo(w + 2, -h - 2); c.lineTo(w + 2, topY);
          c.quadraticCurveTo(0, topY + h * 0.25, -w - 2, topY); c.closePath(); c.fill();
        }
        if (happyLid > 0) {
          const by = h - happyLid * 2 * h * 0.6;
          c.beginPath(); c.moveTo(-w - 2, h + 2); c.lineTo(w + 2, h + 2); c.lineTo(w + 2, by + h * 0.25);
          c.quadraticCurveTo(0, by - h * 0.3, -w - 2, by + h * 0.25); c.closePath(); c.fill();
        }
        c.restore();
        // outline, and a closed-eye curve when shut
        c.lineWidth = R * 0.012; c.strokeStyle = "rgba(90,40,20,0.35)";
        c.beginPath(); c.ellipse(0, 0, w, h, 0, 0, Math.PI * 2); c.stroke();
        if (open < 0.08) {
          c.lineWidth = R * 0.022; c.lineCap = "round"; c.strokeStyle = C.brow;
          c.beginPath(); c.moveTo(-w * 0.85, h * 0.05); c.quadraticCurveTo(0, h * (this.asleep ? 0.45 : 0.3), w * 0.85, h * 0.05); c.stroke();
        }
        c.restore();

        // eyebrow
        const [raise, tilt, asym] = this.br;
        const lift = raise + (side === 1 ? asym : 0);
        const byB = ey - ehBase - R * 0.07 - lift * R * 0.07;
        const inner = cx - side * ew * 0.75, outer = cx + side * ew * 0.85;
        c.lineWidth = R * 0.045; c.lineCap = "round"; c.strokeStyle = C.brow;
        c.beginPath();
        c.moveTo(inner, byB + tilt * R * 0.06);
        c.quadraticCurveTo(cx, byB - R * 0.035, outer, byB - tilt * R * 0.02 + R * 0.01);
        c.stroke();
      }
    }

    drawMouth2(now) {
      const c = this.ctx, R = this.R, mo = this.mo;
      const yawning = this.yawnStart && now - this.yawnStart < 2400;
      let open = mo.open, width = mo.width, smile = mo.smile, skew = mo.skew;
      if (this.speaking || this.level > 0.03) {         // talking: the jaw follows the speech level
        open = Math.max(open * 0.5, 0.1 + this.level * 0.75);
        width = lerp(width, 0.3 - this.level * 0.06, 0.6);
        smile = Math.max(smile, 0.25);
        skew *= 0.3;
      }
      if (yawning) {
        const p = Math.sin(Math.PI * Math.min(1, (now - this.yawnStart) / 2400));
        open = lerp(open, 1, p); width = lerp(width, 0.17, p); smile = lerp(smile, 0, p);
      }
      const W = R * width, my = R * 0.36, sk = skew * R * 0.08;
      const curve = smile * R * 0.12;                   // corners up = smile
      const H = open * R * 0.34;
      c.save();
      c.translate(sk, my);
      c.lineCap = "round"; c.lineJoin = "round";
      if (H < R * 0.02) {                               // closed: a single expressive line
        c.lineWidth = R * 0.035; c.strokeStyle = C.lip;
        c.beginPath(); c.moveTo(-W, -curve * 0.5 - sk * 0.4); c.quadraticCurveTo(0, curve * 0.9, W, -curve * 0.5 + sk * 0.4); c.stroke();
        if (this.mood === "thinking" && !this.asleep) {
          c.fillStyle = C.lip;
          for (let i = 0; i < 3; i++) {
            const b = Math.max(0, Math.sin(now / 220 - i * 0.9)) * R * 0.03;
            c.beginPath(); c.arc(W + R * 0.07 + i * R * 0.06, -R * 0.02 - b, R * 0.018, 0, Math.PI * 2); c.fill();
          }
        }
      } else if (open > 0.4 && Math.abs(smile) < 0.3 && !this.speaking) {   // "O" (surprised, yawning)
        c.beginPath(); c.ellipse(0, H * 0.35, Math.max(W, R * 0.1), H * 0.6, 0, 0, Math.PI * 2);
        c.fillStyle = C.mouth; c.fill();
        c.save(); c.clip(); c.fillStyle = C.tongue;
        c.beginPath(); c.ellipse(0, H * 0.85, W * 0.7, H * 0.3, 0, 0, Math.PI * 2); c.fill(); c.restore();
        c.lineWidth = R * 0.022; c.strokeStyle = C.lip; c.stroke();
      } else {
        // open mouth: upper lip curve and a deeper lower curve
        const top = -curve * 0.5, bottom = top + H;
        c.beginPath();
        c.moveTo(-W, top);
        c.quadraticCurveTo(0, top + curve * 0.9 - H * 0.15, W, top);
        c.quadraticCurveTo(W * 0.9, bottom + curve * 0.4, 0, bottom + curve * 0.6);
        c.quadraticCurveTo(-W * 0.9, bottom + curve * 0.4, -W, top);
        c.closePath();
        c.fillStyle = C.mouth; c.fill();
        c.save(); c.clip();
        if (smile > 0.5 && open < 0.6) {                // a strip of teeth on a big grin
          c.fillStyle = C.teeth; c.fillRect(-W, top - R, 2 * W, R + curve * 0.55 + H * 0.12);
        }
        c.fillStyle = C.tongue;
        c.beginPath(); c.ellipse(0, bottom + curve * 0.5, W * 0.55, H * 0.45 + R * 0.02, 0, 0, Math.PI * 2); c.fill();
        c.restore();
        c.lineWidth = R * 0.022; c.strokeStyle = C.lip; c.stroke();
      }
      c.restore();
    }

    drawMoon(now) {                                     // "thinking": a little moon orbits the planet
      const c = this.ctx, R = this.R, a = now / 700;
      const x = Math.cos(a) * R * 1.12, y = Math.sin(a) * R * 0.28 - R * 0.75;
      const front = Math.sin(a) > 0;
      c.globalAlpha = front ? 1 : 0.5;
      c.beginPath(); c.arc(x, y, R * (front ? 0.07 : 0.055), 0, Math.PI * 2); c.fillStyle = C.moon; c.fill();
      c.globalAlpha = 1;
    }

    drawZzz2(now) {
      const c = this.ctx, R = this.R;
      c.save(); c.fillStyle = C.z;
      for (let i = 0; i < 3; i++) {
        const p = ((now / 2400 + i / 3) % 1);
        c.globalAlpha = Math.sin(Math.PI * p);
        c.font = "700 " + Math.round(R * (0.09 + p * 0.1)) + "px system-ui, sans-serif";
        c.fillText("z", this.cx + R * 0.55 + p * R * 0.25 + Math.sin(p * 6 + i) * R * 0.04, this.cy - R * 0.75 - p * R * 0.45);
      }
      c.restore();
    }
  }

  DB.BallFace = BallFace;
  DB.FACES = { ball: "Round ball", eye: "Classic eye" };
  DB.makeFace = (kind, canvas) => (kind === "eye" ? new DB.Eye(canvas) : new BallFace(canvas));
})();
