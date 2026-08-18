// Sound effects synthesized with the Web Audio API — no audio files, nothing to download.
// Browsers block audio until a user gesture, so the context is resumed on the first
// click/keydown/touch (see armAudio, called once from the socket provider).

let audioCtx = null;
let muted = false;

function actx() {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return null;
    }
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

let armed = false;
export function armAudio() {
  if (armed || typeof document === "undefined") return;
  armed = true;
  ["click", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, () => actx(), { once: true }));
}

export function isMuted() {
  return muted;
}
export function setMuted(m) {
  muted = !!m;
}

function tone(freq, dur, { type = "sine", gain = 0.2, delay = 0, sweep = 0 } = {}) {
  if (muted) return;
  const ctx = actx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

export const sfx = {
  tick: () => tone(820, 0.05, { type: "square", gain: 0.07 }),
  tickHot: () => tone(1280, 0.07, { type: "square", gain: 0.11 }),
  ding: () => { tone(880, 0.12, { gain: 0.2 }); tone(1320, 0.16, { gain: 0.14, delay: 0.05 }); },
  buzz: () => tone(170, 0.22, { type: "sawtooth", gain: 0.16, sweep: -70 }),
  pop: () => tone(520, 0.07, { type: "triangle", gain: 0.11 }),
  roundWin: () => [523, 659, 784].forEach((f, i) => tone(f, 0.18, { type: "triangle", gain: 0.16, delay: i * 0.08 })),
  roundLose: () => [392, 311].forEach((f, i) => tone(f, 0.24, { gain: 0.16, delay: i * 0.11 })),
  fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, { type: "square", gain: 0.15, delay: i * 0.12 })),
  sparkle: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.14, { type: "triangle", gain: 0.14, delay: i * 0.06 })),
  join: () => { tone(587, 0.1, { type: "triangle", gain: 0.16 }); tone(880, 0.15, { type: "triangle", gain: 0.16, delay: 0.09 }); },
};
