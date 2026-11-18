// Drawing sound: a brush or marker moving over paper, made live with Web Audio (no sound files).
//
// How it sounds natural:
//  - The source is "paper grain" noise: white noise whose loudness flickers like fibres catching
//    the tip, plus a separate layer of tiny crackles for scratchy brushes.
//  - It follows the hand. Faster strokes are louder and brighter and the grain runs faster; when the
//    pen stops, the sound dies away within a tenth of a second, as a real brush does.
//  - Each brush has its own character: Pen is a soft felt-tip, Spray is a steady airy hiss while
//    pressed, Hatch is scratchy, and Polka and Triangles are soft dabs as each mark lands.
//  - Bigger brushes sound lower and fuller. The sound pans left or right with the pen, and every
//    stroke starts at a random spot in the noise so no two strokes sound the same.

const BRUSH_SOUND = {
  //        filter Hz, Q,  body, crackle, loudness, held hiss, dab spacing (fraction of width)
  pen:    { f: 1700, q: 0.9, body: 0.55, crackle: 0.12, gain: 0.55, idle: 0.03, dab: 0 },
  spray:  { f: 5200, q: 0.6, body: 0.05, crackle: 0.0,  gain: 0.3,  idle: 0.65, dab: 0 },
  hatch:  { f: 2600, q: 1.2, body: 0.3,  crackle: 0.55, gain: 0.5,  idle: 0.02, dab: 0 },
  ripple: { f: 2100, q: 1.0, body: 0.45, crackle: 0.25, gain: 0.5,  idle: 0.02, dab: 0 },
  polka:  { f: 1300, q: 0.8, body: 0.6,  crackle: 0.05, gain: 0.16, idle: 0.0,  dab: 0.05 },
  tri:    { f: 1700, q: 0.9, body: 0.4,  crackle: 0.15, gain: 0.16, idle: 0.0,  dab: 0.04 },
};

const LOUDNESS = 2.5; // overall level at Sound = 100% (the compressor keeps peaks in check)

function makeBuffers(ctx) {
  const sr = ctx.sampleRate, n = Math.round(sr * 2.5);
  // Paper grain: white noise, slightly tilted toward the lows, with a flickering loudness
  const grain = ctx.createBuffer(1, n, sr);
  const g = grain.getChannelData(0);
  let lp = 0, env = 0.7, envTarget = 0.7, peak = 0;
  for (let i = 0; i < n; i++) {
    if (i % Math.round(sr / 90) === 0) envTarget = 0.45 + Math.random() * 0.55; // fibre texture
    env += (envTarget - env) * 0.004;
    const w = Math.random() * 2 - 1;
    lp += (w - lp) * 0.12;
    const v = (0.65 * w + 0.9 * lp) * env;
    g[i] = v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  for (let i = 0; i < n; i++) g[i] /= peak;
  // Crackle: sparse tiny clicks, like the tip skipping over the paper's tooth
  const crackle = ctx.createBuffer(1, n, sr);
  const c = crackle.getChannelData(0);
  for (let i = 0; i < n; i++) {
    if (Math.random() < 0.0016) {
      const len = 20 + Math.random() * 80, amp = 0.3 + Math.random() * 0.7;
      for (let k = 0; k < len && i + k < n; k++) c[i + k] += (Math.random() * 2 - 1) * amp * Math.exp(-k / (len / 4));
    }
  }
  return { grain, crackle };
}

export function createBrushSound() {
  let ctx = null, master = null, bufs = null, vol = 0.6;
  let s = null; // the stroke playing now

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      master = ctx.createGain();
      master.gain.value = vol * LOUDNESS;
      master.connect(comp).connect(ctx.destination);
      bufs = makeBuffers(ctx);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  const hold = (param, t) => (param.cancelAndHoldAtTime ? param.cancelAndHoldAtTime(t) : param.cancelScheduledValues(t));

  function loop(buf, rate) {
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true; src.playbackRate.value = rate;
    src.start(ctx.currentTime, Math.random() * buf.duration);
    return src;
  }

  function dab(strength) {
    // One soft mark landing: a short, dull burst of grain
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = bufs.grain;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = (s ? s.P.f : 1400) * (0.8 + Math.random() * 0.5); f.Q.value = 0.7;
    const g = ctx.createGain();
    const peak = strength * (0.7 + Math.random() * 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06 + Math.random() * 0.05);
    src.connect(f).connect(g).connect(s ? s.pan : master);
    src.start(t, Math.random() * (bufs.grain.duration - 0.2));
    src.stop(t + 0.15);
  }

  return {
    volume(v) {
      vol = Math.max(0, Math.min(1, v));
      if (master) master.gain.setTargetAtTime(vol * LOUDNESS, ctx.currentTime, 0.05);
    },

    // x, y in CSS pixels; area = { left, width } of the surface being drawn on
    begin(x, y, { brush = 'pen', size = 6, area = { left: 0, width: 800 }, time = performance.now() } = {}) {
      if (vol <= 0 || !ensure()) return;
      if (s) this.end();
      const P = BRUSH_SOUND[brush] || BRUSH_SOUND.pen;
      const sz = Math.max(0, Math.min(1, (size - 2) / 34));
      const fBase = P.f * (1.15 - 0.35 * sz);
      const t = ctx.currentTime;
      const out = ctx.createGain(); out.gain.value = 0;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      out.connect(pan).connect(master);

      const grain = loop(bufs.grain, 0.9);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = fBase; bp.Q.value = P.q;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 220;
      grain.connect(bp).connect(hp).connect(out);
      const body = ctx.createBiquadFilter(); body.type = 'lowpass'; body.frequency.value = 380 + 300 * (1 - sz);
      const bodyGain = ctx.createGain(); bodyGain.gain.value = P.body * (0.6 + 0.6 * sz);
      grain.connect(body).connect(bodyGain).connect(out);
      const sources = [grain];
      let crackleGain = null;
      if (P.crackle > 0) {
        const cr = loop(bufs.crackle, 1);
        const chp = ctx.createBiquadFilter(); chp.type = 'highpass'; chp.frequency.value = 1400;
        crackleGain = ctx.createGain(); crackleGain.gain.value = 0;
        cr.connect(chp).connect(crackleGain).connect(out);
        sources.push(cr);
      }
      s = { P, fBase, out, pan, bp, grain, crackleGain, sources, area, x, y, time, travel: 0, sv: 0 };
      this.panTo(x);
      // Touch-down: the tip meeting the paper
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(P.gain * (0.18 + P.idle), t + 0.015);
      out.gain.setTargetAtTime(P.gain * P.idle, t + 0.03, 0.05);
      if (P.dab) dab(P.gain * 1.4);
    },

    panTo(x) {
      if (!s || !s.pan.pan) return;
      const p = ((x - s.area.left) / Math.max(1, s.area.width)) * 2 - 1;
      s.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, p)) * 0.6, ctx.currentTime, 0.05);
    },

    move(x, y, pressure = 0, time = performance.now()) {
      if (!s || !ctx) return;
      const dt = Math.max(1, time - s.time) / 1000;
      const d = Math.hypot(x - s.x, y - s.y);
      s.x = x; s.y = y; s.time = time;
      // Speed in surface widths per second, smoothed, 0..1
      const v = Math.min(1, (d / Math.max(1, s.area.width)) / dt / 1.5);
      s.sv += (v - s.sv) * 0.35;
      const sv = s.sv, P = s.P, t = ctx.currentTime;
      const press = pressure > 0 ? 0.55 + 0.7 * pressure : 1;
      const target = P.gain * (P.idle + (1 - P.idle) * (0.1 + 0.9 * Math.sqrt(sv))) * press;
      const g = s.out.gain;
      hold(g, t);
      g.setTargetAtTime(target * (0.92 + Math.random() * 0.16), t, 0.02);
      g.setTargetAtTime(P.gain * P.idle * press, t + 0.08, 0.07); // dies away if the pen stops
      hold(s.bp.frequency, t);
      s.bp.frequency.setTargetAtTime(s.fBase * (0.75 + 0.6 * sv) * (0.97 + Math.random() * 0.06), t, 0.03);
      hold(s.grain.playbackRate, t);
      s.grain.playbackRate.setTargetAtTime(0.85 + 0.4 * sv, t, 0.05);
      if (s.crackleGain) {
        hold(s.crackleGain.gain, t);
        s.crackleGain.gain.setTargetAtTime(P.crackle * Math.min(1, sv * 1.6) * press, t, 0.03);
        s.crackleGain.gain.setTargetAtTime(0, t + 0.08, 0.05);
      }
      this.panTo(x);
      if (P.dab) {
        s.travel += d;
        const spacing = P.dab * s.area.width;
        while (s.travel >= spacing) { s.travel -= spacing; dab(P.gain * 1.4 * press); }
      }
    },

    end() {
      if (!s || !ctx) return;
      const t = ctx.currentTime;
      hold(s.out.gain, t);
      s.out.gain.setTargetAtTime(0, t, 0.035); // lift-off
      for (const src of s.sources) src.stop(t + 0.35);
      s = null;
    },
  };
}
