// Reed spectra as PeriodicWaves, from the measured harmonic curves in tuning.js.
// One wave set per (family, semitone); several phase variants keep simultaneous notes from phasing identically, while the
// ranks of one voice share a variant so their common partials always add the same way.
import { TUNING } from './tuning.js';

const VARIANTS = 4;
const cache = new Map();

/** dB of harmonic n (1-based) from one band's table + slope. */
function bandDb(b, n) {
  const c = b.curve;
  return n <= c.length ? c[n - 1] : c[c.length - 1] + b.slope * (n - c.length);
}

/** The two bands around a MIDI note and the interpolation weight of the upper one (clamped beyond the outer bands). */
function bandsAround(family, midi) {
  const bands = TUNING[family].bands;
  let hi = bands.findIndex(b => b.midi >= midi);
  if (hi < 0) hi = bands.length - 1;
  const a = bands[Math.max(0, hi - 1)], b = bands[hi];
  const t = a === b ? 0 : Math.min(1, Math.max(0, (midi - a.midi) / (b.midi - a.midi)));
  return [a, b, t];
}

/** A scalar band parameter (e.g. `noise`) interpolated by MIDI note. */
export function bandValue(family, midi, key, dflt) {
  const [a, b, t] = bandsAround(family, midi);
  return (1 - t) * (a[key] ?? dflt) + t * (b[key] ?? dflt);
}

/** Reed table for a MIDI note: dB-interpolation between the two bands around it. */
export function curveAt(family, midi, nHarm) {
  const [a, b, t] = bandsAround(family, midi);
  const out = new Float64Array(nHarm);
  for (let n = 1; n <= nHarm; n++) out[n - 1] = (1 - t) * bandDb(a, n) + t * bandDb(b, n);
  return out;
}

function buildWave(ctx, family, nHarm, variant, midi) {
  const curve = curveAt(family, midi, nHarm);
  const real = new Float32Array(nHarm + 1);
  const imag = new Float32Array(nHarm + 1);
  // Phases hash (variant, absolute pitch of the partial): ranks of one voice (same variant) then agree on every
  // shared partial, so a stack always sums the same way instead of adding/cancelling at random per note.
  const phase = (n) => { let s = ((variant * 7919 + midi + Math.round(12 * Math.log2(n))) * 9301 + 49297) % 233280; s = (s * 9301 + 49297) % 233280; return s / 233280 * 2 * Math.PI; };
  for (let n = 1; n <= nHarm; n++) {
    let a = Math.pow(10, curve[n - 1] / 20);
    a *= 0.5 + 0.5 * Math.cos(Math.PI * (n - 1) / (2 * nHarm)); // gentle top taper (anti-alias)
    const phi = n > 1 ? phase(n) : 0;
    real[n] = a * Math.cos(phi);
    imag[n] = a * Math.sin(phi);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
}

export function reedWave(ctx, freq, family = 'melody', variant = 0) {
  const limit = Math.min(16000, ctx.sampleRate * 0.45);
  let n = Math.max(4, Math.min(80, Math.floor(limit / freq)));
  const nHarm = Math.max(4, Math.round(Math.pow(2, Math.round(Math.log2(n) * 2) / 2)));
  const midi = Math.round(69 + 12 * Math.log2(freq / 440)); // one wave set per semitone (lazy, cheap)
  const key = `${family}:${nHarm}:${midi}`;
  if (!cache.has(key)) cache.set(key, Array.from({ length: VARIANTS }, (_, i) => buildWave(ctx, family, nHarm, i, midi)));
  return cache.get(key)[variant % VARIANTS];
}

// Reed ranks, toggled by the register switches; {oct, semis?, gain, detune} as ReedVoice consumes them.
// A rank may name its own reed `family` (a TUNING key with `bands` and optionally cutoff/cutoffMinHarm/gain):
// voice.js then draws that rank's wave, breath noise, knee and level from there. 8c (the cassotto reeds,
// SOUND.md §15) is the only such rank; everything else uses TUNING.melody.
export const RANKS = {
  '4':  { oct: 1,  gain: 1.0,  detune: 2 },
  '8':  { oct: 0,  gain: 1.0,  detune: 0 },
  '8c': { oct: 0,  gain: 0.6,  detune: 0, family: 'cassotto' }, // second 8-foot rank, brighter reeds; 5/7 by ear against the others
  '16': { oct: -1, gain: 0.85, detune: -1.5 },
  '+5': { oct: 0,  semis: 7, gain: 1.0, detune: 1 }, // a perfect fifth above
};
export const RANK_ORDER = ['+5', '4', '8', '8c', '16']; // switch-row order (= the J K L : " keys)
// Automatic registers, in switch-row order. Selecting one writes its ranks into the manual toggles
// (engine.setPreset); a preset lights when the manual set equals it (engine.preset). Sets must stay distinct.
export const PRESETS = {
  base:    ['8', '8c'],
  main:    ['8', '16'],
  clarion: ['4', '8', '8c'],
  organ:   ['4', '8', '16'],
  master:  ['4', '8', '8c', '16'],
  chime:   ['4', '+5'],
  wave:    ['8', '+5', '16'],
};
