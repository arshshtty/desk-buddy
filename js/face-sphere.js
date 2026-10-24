/* Desk Buddy: the "Sphere" face (default). A softly lit, glowing orb with two large, simple eyes.
   Shares all behaviour with the Classic eye (js/eye.js: gaze, blinks, moods, sleep, yawns, speech);
   this file only adds springy motion and redraws.

   Look: deep-space background with a vignette; a sphere lit by a key light from the upper left
   (soft terminator), a cool rim light from behind, a faint warm subsurface glow, a glossy specular
   highlight, a contact shadow below and a bloom halo around it. Every static layer is painted once
   into an offscreen canvas (rebuilt only on resize), so a frame is a handful of drawImage calls.

   Motion: the face (eyes and mouth) sits on the sphere's surface and turns toward where it looks,
   foreshortening as it goes; gaze moves on an under-damped spring (saccades overshoot a little);
   blinks have a small anticipation and an overshooting reopen; the orb floats and breathes; a tap
   squishes it. Moods change the eye shapes only: happy = crescents, surprised = wide, sleepy = lids,
   curious = one eye bigger, thinking = eyes up and to the side, angry = slanted lids. The mouth is a
   small soft line that only appears while talking or smiling. */
(function () {
  "use strict";
  const DB = (window.DB = window.DB || {});
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const easeOutBack = (t) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const easeIn = (t) => t * t;

  const P = {                                  // palette
    bg0: "#121842", bg1: "#080b22", bg2: "#020309",
    s0: "#f3f6ff", s1: "#c3cdfd", s2: "#8a95f2", s3: "#5559c9", s4: "#2d2b86", s5: "#161450",
    rim: [140, 225, 255], sss: [255, 150, 210], halo: [118, 136, 255], haloWarm: [255, 196, 120],
    eye0: "#101640", eye1: "#05071c", eyeGlow: [120, 200, 255], mouth: "rgba(10,12,44,0.92)",
  };
  const rgba = (c, a) => "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";

  // A damped spring towards a target: under-damped values overshoot a little.
  class Spring {
    constructor(v, k, c) { this.v = v; this.t = v; this.vel = 0; this.k = k; this.c = c; }
    step(dt) {
      const s = Math.min(0.05, dt / 1000);    // seconds, clamped for stability
      const a = -this.k * (this.v - this.t) - this.c * this.vel;
      this.vel += a * s; this.v += this.vel * s;
      return this.v;
    }
  }

  function layer(w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }

  class SphereFace extends DB.Eye {
    constructor(canvas) {
      super(canvas);
      this.kind = "sphere";
      this.fx = new Spring(0, 170, 15); this.fy = new Spring(0, 170, 15);        // where the face points
      this.sq = new Spring(0, 320, 9);                                          // tap squish
      this.ew = new Spring(1, 240, 22); this.eh = new Spring(1, 240, 22);       // eye width/height scale
      this.lidM = new Spring(0, 200, 22); this.happyM = new Spring(0, 200, 20); // mood lid / crescent
      this.angryM = new Spring(0, 200, 22); this.curM = new Spring(0, 160, 16); // slant / one eye bigger
      this.mouthA = new Spring(0, 140, 20); this.listenA = new Spring(0, 60, 14); this.sleepA = new Spring(0, 30, 11);
      this.lidB = 1; this.antic = 0; this.t0 = performance.now();
    }
    poke() { this.sq.vel += 2.2; }

    resize() {
      super.resize();
      const usableH = this.h - 150;
      this.R = Math.max(60, Math.min(this.w * 0.43, usableH * 0.39));
      this.cx = this.w / 2;
      this.cy = Math.max(this.R * 1.25 + 30, usableH * 0.47);
      this._build();
    }
    isOnEye(x, y) { return Math.hypot(x - this.cx, y - this.cy) < this.R * 1.05; }

    /* ---- static layers (built once per size) ---- */
    _build() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2), R = this.R * dpr, W = this.w * dpr, H = this.h * dpr;
      this.dpr = dpr; this.L = {};
      // background: deep space, vignette, a few faint stars
      const bg = layer(W, H), b = bg.getContext("2d");
      const cx = this.cx * dpr, cy = this.cy * dpr;
      let g = b.createRadialGradient(cx, cy, R * 0.2, cx, cy, Math.hypot(W, H) * 0.62);
      g.addColorStop(0, P.bg0); g.addColorStop(0.45, P.bg1); g.addColorStop(1, P.bg2);
      b.fillStyle = g; b.fillRect(0, 0, W, H);
      let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 70; i++) {
        const x = rnd() * W, y = rnd() * H, r = (0.4 + rnd() * 0.9) * dpr;
        b.fillStyle = "rgba(210,220,255," + (0.04 + rnd() * 0.16).toFixed(3) + ")";
        b.beginPath(); b.arc(x, y, r, 0, TAU); b.fill();
      }
      g = b.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.55)");
      b.fillStyle = g; b.fillRect(0, 0, W, H);
      this.L.bg = bg;

      // bloom halo (cool and warm versions; warm shows while listening)
      const halo = (col) => {
        const s = R * 3.6, c = layer(s, s), x = c.getContext("2d"), m = s / 2;
        const hg = x.createRadialGradient(m, m, R * 0.85, m, m, m);
        hg.addColorStop(0, rgba(col, 0.42)); hg.addColorStop(0.18, rgba(col, 0.2)); hg.addColorStop(0.45, rgba(col, 0.07)); hg.addColorStop(1, rgba(col, 0));
        x.fillStyle = hg; x.fillRect(0, 0, s, s);
        return c;
      };
      this.L.halo = halo(P.halo); this.L.haloWarm = halo(P.haloWarm);

      // contact shadow
      { const s = R * 2, c = layer(s, s * 0.4), x = c.getContext("2d");
        x.translate(s / 2, s * 0.2); x.scale(1, 0.2);
        const sg = x.createRadialGradient(0, 0, 0, 0, 0, s * 0.45);
        sg.addColorStop(0, "rgba(0,0,6,0.7)"); sg.addColorStop(0.6, "rgba(0,0,6,0.25)"); sg.addColorStop(1, "rgba(0,0,6,0)");
        x.fillStyle = sg; x.beginPath(); x.arc(0, 0, s * 0.45, 0, TAU); x.fill();
        this.L.shadow = c; }

      // the sphere body: key light, terminator, rim, subsurface, occlusion
      { const pad = 4, s = R * 2 + pad * 2, c = layer(s, s), x = c.getContext("2d"), m = s / 2;
        x.save(); x.beginPath(); x.arc(m, m, R, 0, TAU); x.clip();
        const kx = m - R * 0.4, ky = m - R * 0.46;
        let k = x.createRadialGradient(kx, ky, R * 0.02, kx, ky, R * 1.75);
        k.addColorStop(0, P.s0); k.addColorStop(0.16, P.s1); k.addColorStop(0.42, P.s2); k.addColorStop(0.66, P.s3); k.addColorStop(0.86, P.s4); k.addColorStop(1, P.s5);
        x.fillStyle = k; x.fillRect(0, 0, s, s);
        // warm subsurface glow low in the body (light scattering through it)
        x.globalCompositeOperation = "screen";
        k = x.createRadialGradient(m + R * 0.15, m + R * 0.55, 0, m + R * 0.15, m + R * 0.55, R * 0.85);
        k.addColorStop(0, rgba(P.sss, 0.16)); k.addColorStop(0.6, rgba(P.sss, 0.06)); k.addColorStop(1, rgba(P.sss, 0));
        x.fillStyle = k; x.fillRect(0, 0, s, s);
        // cool rim light from behind, strongest at the lower right
        const rim = layer(s, s), r = rim.getContext("2d");
        let rg = r.createRadialGradient(m, m, R * 0.72, m, m, R);
        rg.addColorStop(0, rgba(P.rim, 0)); rg.addColorStop(0.75, rgba(P.rim, 0.22)); rg.addColorStop(0.95, rgba(P.rim, 0.75)); rg.addColorStop(1, rgba(P.rim, 0.35));
        r.fillStyle = rg; r.fillRect(0, 0, s, s);
        r.globalCompositeOperation = "destination-in";
        const lg = r.createLinearGradient(m - R * 0.6, m - R * 0.7, m + R * 0.75, m + R * 0.8);
        lg.addColorStop(0, "rgba(0,0,0,0)"); lg.addColorStop(0.55, "rgba(0,0,0,0.25)"); lg.addColorStop(1, "rgba(0,0,0,1)");
        r.fillStyle = lg; r.fillRect(0, 0, s, s);
        x.drawImage(rim, 0, 0);
        // soft occlusion at the very bottom, where it nears the floor
        x.globalCompositeOperation = "multiply";
        k = x.createRadialGradient(m, m + R * 1.5, R * 0.3, m, m + R * 1.5, R * 0.82);
        k.addColorStop(0, "rgba(70,60,140,0.75)"); k.addColorStop(0.6, "rgba(170,165,225,1)"); k.addColorStop(1, "rgba(255,255,255,1)");
        x.fillStyle = k; x.fillRect(0, 0, s, s);
        x.restore();
        // a hair of anti-aliased edge glow
        x.globalCompositeOperation = "source-over";
        x.beginPath(); x.arc(m, m, R - 0.5 * dpr, 0, TAU); x.lineWidth = 1.2 * dpr; x.strokeStyle = rgba(P.rim, 0.18); x.stroke();
        this.L.body = c; this.L.bodyPad = pad; }

      // glossy specular highlight (light stays put while the face turns)
      { const s = R * 2, c = layer(s, s), x = c.getContext("2d"), m = s / 2;
        const spot = (ox, oy, rx, ry, rot, a) => {
          x.save(); x.translate(m + ox * R, m + oy * R); x.rotate(rot); x.scale(1, ry / rx);
          const sg = x.createRadialGradient(0, 0, 0, 0, 0, rx * R);
          sg.addColorStop(0, "rgba(255,255,255," + a + ")"); sg.addColorStop(0.45, "rgba(255,255,255," + a * 0.45 + ")"); sg.addColorStop(1, "rgba(255,255,255,0)");
          x.fillStyle = sg; x.beginPath(); x.arc(0, 0, rx * R, 0, TAU); x.fill(); x.restore();
        };
        spot(-0.42, -0.55, 0.38, 0.2, -0.62, 0.35);   // broad soft window
        spot(-0.45, -0.57, 0.15, 0.075, -0.62, 0.9);  // hot core
        spot(0.5, 0.62, 0.16, 0.05, -0.75, 0.16);     // faint bounce at the lower right
        this.L.spec = c; }

      // eye scratch canvases and their soft occlusion blob
      const ea = 0.148 * R, eb = 0.2 * R;
      this.ea = ea / dpr; this.eb = eb / dpr;
      this.L.eyeA = layer(ea * 5, eb * 4); this.L.eyeB = layer(ea * 5, eb * 4);
      { const s = eb * 3.2, c = layer(s, s), x = c.getContext("2d"), m = s / 2;
        const og = x.createRadialGradient(m, m, eb * 0.85, m, m, eb * 1.3);
        og.addColorStop(0, "rgba(20,16,70,0.14)"); og.addColorStop(1, "rgba(20,16,70,0)");
        x.fillStyle = og; x.fillRect(0, 0, s, s); this.L.eyeAO = c; }
    }

    /* ---- motion ---- */
    update(now, dt) {
      super.update(now, dt);
      const m = this.mood, asleep = this.asleep;
      // face direction follows the gaze target on a spring (overshoots a touch on big saccades)
      this.fx.t = this.tx; this.fy.t = this.ty;
      this.fx.step(dt); this.fy.step(dt);
      this.sq.step(dt);
      // blink: tiny anticipation (eyes widen), quick close, overshooting reopen
      if (this.blinking) {
        const t = now - this.blinkStart;
        if (t < 50) { this.antic = 0.07 * Math.sin(Math.PI * t / 50); this.lidB = 1; }
        else if (t < 120) { this.antic = 0; this.lidB = 1 - easeIn((t - 50) / 70); }
        else if (t < 150) this.lidB = 0;
        else this.lidB = Math.min(1.06, easeOutBack(Math.min(1, (t - 150) / 170)));
      } else { this.lidB = 1; this.antic = 0; }
      // mood targets
      const T = { w: 1, h: 1, lid: 0, happy: 0, angry: 0, cur: 0 };
      if (m === "happy" || now < this.petUntil) { T.happy = 1; T.h = 0.96; T.w = 1.04; }
      if (m === "surprised") { T.w = 1.14; T.h = 1.22; }
      if (m === "sleepy") { T.lid = 0.52; T.h = 0.94; }
      if (m === "curious") { T.cur = 1; }
      if (m === "thinking") { T.lid = 0.18; T.h = 0.96; }
      if (m === "angry") { T.angry = 1; T.lid = 0.22; }
      this.ew.t = T.w; this.eh.t = T.h; this.lidM.t = T.lid; this.happyM.t = T.happy; this.angryM.t = T.angry; this.curM.t = T.cur;
      for (const s of [this.ew, this.eh, this.lidM, this.happyM, this.angryM, this.curM]) s.step(dt);
      const smiling = this.happyM.v > 0.5 && !this.speaking;
      this.mouthA.t = this.speaking || this.level > 0.05 ? 1 : smiling ? 0.85 : 0;
      this.mouthA.step(dt);
      this.listenA.t = this.listening ? 1 : 0; this.listenA.step(dt);
      this.sleepA.t = asleep ? 1 : 0; this.sleepA.step(dt);
    }

    /* ---- drawing ---- */
    draw(now) {
      const c = this.ctx, L = this.L, dpr = this.dpr, R = this.R;
      if (!L || !L.bg) return;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(L.bg, 0, 0);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sleep = clamp(this.sleepA.v, 0, 1);
      const t = (now - this.t0) / 1000;
      const float = Math.sin(t * (sleep > 0.5 ? 0.45 : 0.9)) * R * (0.026 - 0.012 * sleep) + sleep * R * 0.03;
      const breathe = 1 + Math.sin(t * (sleep > 0.5 ? 0.55 : 1.1)) * 0.009 + this.level * 0.012;
      const sq = clamp(this.sq.v, -0.25, 0.25);
      const sx = breathe * (1 + sq * 0.6), sy = breathe * (1 - sq);
      const cx = this.cx, cy = this.cy + float;

      // contact shadow (smaller and fainter as it floats up)
      const sh = L.shadow, lift = (float / R + 0.03) * 8;
      c.save(); c.globalAlpha = clamp(0.85 - lift * 0.5, 0.35, 1);
      const shw = (sh.width / dpr) * (1 - lift * 0.08) * sx;
      c.drawImage(sh, cx - shw / 2, this.cy + R * 1.13 - (sh.height / dpr) / 2, shw, sh.height / dpr);
      c.restore();

      // halo / bloom
      const hs = L.halo.width / dpr * (1 + this.level * 0.05);
      const hA = (0.85 + 0.15 * Math.sin(t * 1.3) + this.level * 0.3) * (1 - 0.6 * sleep);
      c.save();
      c.globalAlpha = clamp(hA * (1 - this.listenA.v), 0, 1); c.drawImage(L.halo, cx - hs / 2, cy - hs / 2, hs, hs);
      if (this.listenA.v > 0.01) { c.globalAlpha = clamp(this.listenA.v * hA, 0, 1); c.drawImage(L.haloWarm, cx - hs / 2, cy - hs / 2, hs, hs); }
      c.restore();

      // body
      c.save();
      c.translate(cx, cy); c.scale(sx, sy);
      const bs = L.body.width / dpr;
      c.drawImage(L.body, -bs / 2, -bs / 2, bs, bs);

      // face on the surface, turned toward the gaze
      const yaw = clamp(this.fx.v, -1.3, 1.3) * 0.4, pitch = clamp(this.fy.v, -1.3, 1.3) * 0.3 + this.tilt * 0;
      const roll = this.tilt * 0.6;
      this._drawFace(c, now, yaw, pitch, roll);
      c.drawImage(L.spec, -R, -R, 2 * R, 2 * R);
      if (sleep > 0.01) {                           // asleep: the light dims
        c.globalAlpha = 0.38 * sleep; c.fillStyle = "#070826";
        c.beginPath(); c.arc(0, 0, R + 0.5, 0, TAU); c.fill(); c.globalAlpha = 1;
      }
      c.restore();
      if (this.asleep) this._zzz(now);
    }

    _surface(lon, lat) {                            // sphere point -> screen offset and foreshortening
      return { x: this.R * Math.cos(lat) * Math.sin(lon), y: this.R * Math.sin(lat), fx: Math.cos(lon), fy: Math.cos(lat) };
    }

    _drawFace(c, now, yaw, pitch, roll) {
      const R = this.R, open = clamp(this.open, 0, 1);
      const spread = 0.3, eyeLat = -0.07;
      const cur = this.curM.v;
      // gaze inside the eye (highlights move with it)
      const gx = clamp(this.fx.v, -1, 1), gy = clamp(this.fy.v, -1, 1);
      for (const side of [-1, 1]) {
        const lon = side * spread + yaw, lat = eyeLat + pitch + side * roll * 0.25;
        const p = this._surface(lon, lat);
        const big = 1 + cur * (side < 0 ? 0.17 : -0.1);
        const lid = 1 - (1 - clamp(this.lidM.v, 0, 1)) * clamp(this.lidB, 0, 1.1) * open;   // 0 open .. 1 shut
        this._eye(c, side < 0 ? this.L.eyeA : this.L.eyeB, p, side, {
          w: this.ew.v * big * (1 + this.antic * 0.4), h: this.eh.v * big * (1 + this.antic),
          lid: clamp(lid, -0.06, 1), happy: clamp(this.happyM.v, 0, 1.1), angry: clamp(this.angryM.v, 0, 1.1), gx, gy, roll,
        });
      }
      // mouth: only while talking or smiling
      const ma = clamp(this.mouthA.v, 0, 1);
      if (ma > 0.02) {
        const p = this._surface(yaw * 0.95, 0.3 + pitch * 0.9);
        c.save(); c.translate(p.x, p.y); c.rotate(roll * 0.6); c.scale(p.fx, p.fy); c.globalAlpha = ma;
        if (this.speaking || this.level > 0.05) {
          const lv = clamp(this.level, 0, 1), w = R * (0.115 - lv * 0.025), h = R * (0.018 + lv * 0.065);
          c.fillStyle = P.mouth; c.beginPath();
          c.ellipse(0, h * 0.3, w, h, 0, 0, TAU); c.fill();
          c.globalCompositeOperation = "source-atop";
          const mg = c.createRadialGradient(0, h, 0, 0, h, w);
          mg.addColorStop(0, "rgba(255,140,190,0.45)"); mg.addColorStop(1, "rgba(255,140,190,0)");
          c.fillStyle = mg; c.fillRect(-w, -h, 2 * w, 3 * h);
        } else {
          c.strokeStyle = P.mouth; c.lineWidth = R * 0.032; c.lineCap = "round";
          c.beginPath(); c.moveTo(-R * 0.1, -R * 0.018); c.quadraticCurveTo(0, R * 0.07, R * 0.1, -R * 0.018); c.stroke();
        }
        c.restore();
      }
    }

    _eye(c, cv, p, side, o) {
      const dpr = this.dpr, x = cv.getContext("2d"), W = cv.width, H = cv.height;
      const a = this.ea * dpr * o.w, b = this.eb * dpr * o.h, mx = W / 2, my = H / 2;
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.globalCompositeOperation = "source-over";
      x.clearRect(0, 0, W, H);
      const shut = o.lid > 0.9;
      if (!shut) {
        // base shape: a clean rounded oval, deep navy with a soft inner glow
        let g = x.createLinearGradient(0, my - b, 0, my + b);
        g.addColorStop(0, P.eye0); g.addColorStop(1, P.eye1);
        x.fillStyle = g; x.beginPath(); x.ellipse(mx, my, a, b, 0, 0, TAU); x.fill();
        x.globalCompositeOperation = "source-atop";
        g = x.createRadialGradient(mx - o.gx * a * 0.2, my + b * 0.75, 0, mx, my + b * 0.6, b * 1.1);
        g.addColorStop(0, rgba(P.eyeGlow, 0.55)); g.addColorStop(0.5, rgba(P.eyeGlow, 0.16)); g.addColorStop(1, rgba(P.eyeGlow, 0));
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        // highlights move with the gaze
        const hx = mx + (-0.32 + o.gx * 0.22) * a, hy = my + (-0.42 + o.gy * 0.18) * b;
        const hl = 1 - clamp(o.happy, 0, 1) * 0.9;
        x.fillStyle = "rgba(255,255,255," + (0.92 * hl).toFixed(3) + ")";
        x.beginPath(); x.ellipse(hx, hy, a * 0.24, b * 0.15, -0.5, 0, TAU); x.fill();
        x.fillStyle = "rgba(255,255,255," + (0.32 * hl).toFixed(3) + ")";
        x.beginPath(); x.arc(mx + (0.34 + o.gx * 0.15) * a, my + (0.3 + o.gy * 0.12) * b, a * 0.1, 0, TAU); x.fill();
        // lids and crescents cut the shape (no outlines anywhere)
        x.globalCompositeOperation = "destination-out";
        x.fillStyle = "#000";
        if (o.lid > 0.001 || o.angry > 0.01) {
          const lidY = my - b + 2 * b * Math.max(0, o.lid);
          x.save(); x.translate(mx, lidY);
          x.rotate(-side * o.angry * 0.42);          // angry: inner corners lower
          x.beginPath(); x.ellipse(0, -b * 2, a * 2.2, b * 2, 0, 0, TAU); x.fill();
          x.restore();
        }
        if (o.happy > 0.01) {                       // happy: lift a curve from below -> a crescent
          const cy2 = my + b * (2.3 - 1.32 * o.happy);
          x.beginPath(); x.ellipse(mx, cy2, a * 1.6, b * 1.3, 0, 0, TAU); x.fill();
        }
      }
      // place it on the sphere, foreshortened by the surface angle
      const c2 = this.ctx;
      const w = W / dpr, h = H / dpr;
      c2.save(); c2.translate(p.x, p.y); c2.rotate(o.roll * 0.6); c2.scale(Math.max(0.2, p.fx), Math.max(0.2, p.fy));
      const ao = this.L.eyeAO, aw = ao.width / dpr * o.w;
      if (!shut) { c2.globalAlpha = clamp(1 - o.lid, 0, 1) * clamp(1 - o.happy, 0, 1) * 0.9; c2.drawImage(ao, -aw / 2, -aw / 2 + this.eb * 0.12, aw, aw); c2.globalAlpha = 1; }
      if (shut) {                                   // closed: a soft curved line
        c2.strokeStyle = P.eye0; c2.lineCap = "round"; c2.lineWidth = this.R * 0.034;
        c2.beginPath(); c2.moveTo(-this.ea * 0.95, 0); c2.quadraticCurveTo(0, this.eb * 0.42, this.ea * 0.95, 0); c2.stroke();
      } else c2.drawImage(cv, -w / 2, -h / 2, w, h);
      c2.restore();
    }

    _zzz(now) {
      const c = this.ctx, R = this.R;
      c.save(); c.fillStyle = "rgba(200,210,255,0.75)";
      for (let i = 0; i < 3; i++) {
        const p = ((now / 2600 + i / 3) % 1);
        c.globalAlpha = Math.sin(Math.PI * p) * 0.7;
        c.font = "500 " + Math.round(R * (0.08 + p * 0.08)) + "px system-ui, sans-serif";
        c.fillText("z", this.cx + R * 0.62 + p * R * 0.25, this.cy - R * 0.72 - p * R * 0.4);
      }
      c.restore();
    }
  }

  DB.Eye.prototype.kind = "eye";
  DB.SphereFace = SphereFace;
  DB.FACES = { sphere: "Sphere", eye: "Classic eye" };
  DB.makeFace = (kind, canvas) => (kind === "eye" ? new DB.Eye(canvas) : new SphereFace(canvas));
})();
