import { reedWave, bandValue } from './reed.js';
import { midiToFreq } from './layout.js';
import { TUNING } from './tuning.js';

let noiseBuf = null;
function getNoise(ctx) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}
export function preloadNoise(ctx) { getNoise(ctx); }

// Calibration to what analysis/compare.py measures (see analysis/calibrate_spread.py).
const NOISE_CAL = 90;  // white noise (uniform ±1) per-bin level vs a unit sinusoid in a 16384-point Hann FFT
const FM_CAL = 100;    // cents rms of the >3 Hz pitch trace per unit of fmCents

/**
 * Level trim for phase-coherent stacks (SOUND.md §17). Ranks at exactly the same pitch are phase-locked for the
 * life of the note (shared phase hash, frequency and mod buses), so their partials add in amplitude; ranks at any
 * other interval drift and add in power. 8'+8c is the only locked pair and ran ~2.6 dB hot. Group ranks by
 * sounding pitch, sum coherently within a group and in power across groups, and return the factor that restores
 * the independent-reed level. One flat number per voice on purpose: a per-harmonic fix would rewrite the spectrum,
 * and the in-phase stacking IS that register's sound.
 * @param {Array<[string, number]>} pitched [pitch key, amplitude] per sounding rank
 */
function coherenceTrim(pitched) {
  const groups = new Map();
  let power = 0;
  for (const [key, amp] of pitched) {
    groups.set(key, (groups.get(key) || 0) + amp); // same pitch: amplitudes add
    power += amp * amp;                            // independent reeds: powers add
  }
  let coherent = 0;
  for (const a of groups.values()) coherent += a * a;
  return coherent > 0 ? Math.sqrt(power / coherent) : 1; // 1 whenever every rank sits at its own pitch
}

/** Raised-cosine 0 → 1 over d seconds from t, as linear segments (smooth ends: no spectral splatter). */
const S_STEPS = [0.15, 0.3, 0.5, 0.7, 0.85, 1];
function rampS(param, t, d) {
  for (const x of S_STEPS) param.linearRampToValueAtTime(0.5 - 0.5 * Math.cos(Math.PI * x), t + d * x);
}

/**
 * One sounding key, possibly several ranks.
 * Graph per rank: osc → gain [→ onset/timbre filters] → lp1 → lp2 → env → dest, with breath noise
 * (noise → lowpass → gain) injected at lp1, and jitter + flutter + the bellows pitch bus on every detune.
 * Interface: speak(), release(seconds?), damp(), reattack(), kill().
 */
export class ReedVoice {
  constructor(ctx, dest, midi, kind, ranks, opts = {}) {
    this.ctx = ctx;
    this.freq = midiToFreq(midi);
    this.p = TUNING[kind];
    this.alive = true;   // key still down
    this.dead = false;   // torn down (kill); between the two the voice is fading and damp() can shorten it
    this.endsAt = Infinity;
    this.killTimer = null;
    const p = this.p, t = ctx.currentTime;

    this.env = ctx.createGain();
    this.env.gain.value = 0;
    this.env.connect(dest);

    const family = kind === 'melody' ? 'melody' : 'bass';
    const sp = p.spread;
    // slow random pitch walk: noise → 3 Hz lowpass → gain (cents) → osc.detune
    this.jitterSrc = ctx.createBufferSource();
    this.jitterSrc.buffer = getNoise(ctx); this.jitterSrc.loop = true;
    this.jitterSrc.loopStart = Math.random() * 1.5;
    const jlp = ctx.createBiquadFilter(); jlp.type = 'lowpass'; jlp.frequency.value = 3; jlp.Q.value = 0.5;
    this.jitterGain = ctx.createGain(); this.jitterGain.gain.value = p.jitter * 90;
    this.jitterSrc.connect(jlp).connect(this.jitterGain);
    // fast pitch flutter (bellows shake): same noise → bandpass at sp.fmHz → gain (cents) → osc.detune;
    // broadens harmonic k by k·cents — the sideband skirts around the recording's harmonics
    const fbp = ctx.createBiquadFilter(); fbp.type = 'bandpass'; fbp.frequency.value = sp.fmHz; fbp.Q.value = 0.7;
    // Ranks that can sound (a 16' reed below 20 Hz is dropped). The lowest sets the flutter depth, attack floor
    // and bend weight: the biggest reed is the slowest to speak.
    const kept = ranks.filter((r) => { const f = this.freq * Math.pow(2, r.oct + (r.semis || 0) / 12); return f >= 20 && f <= 8000; });
    this.lowMidi = kept.length ? midi + Math.min(...kept.map((r) => 12 * r.oct + (r.semis || 0))) : midi;
    this.lowFreq = midiToFreq(this.lowMidi);
    this.fmGain = ctx.createGain(); this.fmGain.gain.value = bandValue(family, this.lowMidi, 'fmCents', sp.fmCents) * FM_CAL;
    this.jitterSrc.connect(fbp).connect(this.fmGain);
    this.jitterSrc.start();

    // breath/leak noise source, shared by the ranks (each shapes and scales it for its own pitch)
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = getNoise(ctx); this.noiseSrc.loop = true;
    this.noiseSrc.loopStart = Math.random() * 1.5;
    this.noiseSrc.start();

    // Every rank is a reed of its own: wave table, opening knee and breath noise follow that rank's *sounding*
    // pitch, so 16'+8' on one key sounds like two reeds, not one reed with an octave effect.
    this.ranks = [];
    // A rank with its own family (RANKS[].family — the 8c cassotto reeds) draws wave/noise/knee/level from it;
    // envelope, bend, opening and pan stay with the voice's kind. Without a rank family both fall back to p.
    const famName = (r) => r.family || family;
    const famTuning = (r) => (r.family && TUNING[r.family]) || p;
    // steady level of one rank: its weight × the band's octave fade (octave ranks only) × its family's gain
    const rankAmp = (r) => r.gain * (r.oct > 0 ? bandValue(famName(r), midi, 'octGain', 1) : 1) * (famTuning(r).gain ?? p.gain);
    const trim = coherenceTrim(kept.map((r) => [`${r.oct || 0}:${r.semis || 0}:${r.detune || 0}`, rankAmp(r)]));
    // One phase variant for all presses: notes already differ (phases keyed to absolute pitch), and the phase set
    // moves the crest factor ~2 dB through the compressor, so varying it made a note's level differ per press.
    const variant = 0;
    kept.forEach((r, i) => {
      const f = this.freq * Math.pow(2, r.oct + (r.semis || 0) / 12);
      const rmidi = midi + 12 * r.oct + (r.semis || 0);
      const rfam = famName(r), rp = famTuning(r);
      const amp = rankAmp(r) * trim;
      const cutoff = Math.max(rp.cutoff ?? p.cutoff, f * (rp.cutoffMinHarm ?? p.cutoffMinHarm ?? 0)); // high reeds keep cutoffMinHarm harmonics under the knee
      const lp1 = ctx.createBiquadFilter(); lp1.type = 'lowpass'; lp1.Q.value = 0.7;
      const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.Q.value = 0.7;
      lp1.connect(lp2).connect(this.env);
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(reedWave(ctx, f, rfam, variant));
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = amp;
      // Onset/timbre chain, only for families that define it (the bass): fundPk = late fundamental (narrow cut at
      // f lifting over onset.fundTime), midPk = hot mids relaxing over onset.midTime, then the steady top-shelf
      // and midrange trims (timbre.*, read at note start, optionally weighted to low reeds).
      osc.connect(g);
      let last = g, fundPk = null, midPk = null, h1Db = 0;
      if (p.onset || p.timbre) {
        fundPk = ctx.createBiquadFilter(); fundPk.type = 'peaking'; fundPk.frequency.value = f; fundPk.Q.value = 4; fundPk.gain.value = 0;
        midPk = ctx.createBiquadFilter(); midPk.type = 'peaking'; midPk.frequency.value = f * ((p.onset && p.onset.midHarm) || 5); midPk.Q.value = 1.2; midPk.gain.value = 0;
        const tb = p.timbre || {}, tw = tb.lowWeighted ? Math.min(1, Math.max(0, ((p.bend?.top ?? 0) - rmidi) / (p.bend?.span || 1))) : 1;
        const top = ctx.createBiquadFilter(); top.type = 'highshelf'; top.frequency.value = tb.topHz || 1000; top.gain.value = (tb.topDb || 0) * tw;
        const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = tb.midHz || 1200; mid.Q.value = tb.midQ || 1.5; mid.gain.value = (tb.midDb || 0) * tw;
        g.connect(fundPk).connect(midPk).connect(top).connect(mid);
        last = mid; h1Db = (tb.h1Db || 0) * tw;
      }
      last.connect(lp1);
      this.jitterGain.connect(osc.detune);
      this.fmGain.connect(osc.detune);
      if (opts.pitchBus) opts.pitchBus.connect(osc.detune);
      osc.start();
      // breath noise: bands[].noise = dB of the inter-harmonic floor vs the table's 0 dB reference
      const nlp = ctx.createBiquadFilter(); nlp.type = 'lowpass'; nlp.frequency.value = sp.noiseLp; nlp.Q.value = 0.5;
      const ng = ctx.createGain(); ng.gain.value = Math.pow(10, bandValue(rfam, rmidi, 'noise', -80) / 20) * NOISE_CAL * amp;
      this.noiseSrc.connect(nlp).connect(ng).connect(lp1);
      // Low reeds open their top late: the lowpass starts at openStartHarm·f (when below the usual start) and
      // ramps over openTimeLow. lowW = how far below the usual start that is (0 = normal note, 1 = very low).
      const usual = cutoff * p.openStart, low = p.openStartHarm ? f * p.openStartHarm : usual;
      const lowW = Math.min(1, Math.max(0, 1 - low / usual));
      this.ranks.push({ osc, baseDetune: r.detune, lps: [lp1, lp2], cutoff, start: Math.min(usual, low), lowW, fundPk, midPk, rmidi, h1Db });
    });

    this.speak(t, !!opts.legato, true);
  }

  /** Reed speak: pitch bend-in, spectral opening (pitch-relative on low reeds), amplitude swell. */
  speak(t, legato, initial) {
    const p = this.p, b = p.bend || {};
    // Shaped bend (bass): start flat by pitchDip and settle over bendTime. Low reeds bend deeper and slower —
    // the extra fades in from bend.top down over bend.span, by the lowest sounding rank. From silence, depth and
    // time scale by bend.silentMul; a re-speak uses half depth. Families with pitchTau (the melody) settle
    // exponentially from pitchDip instead.
    const w = Math.min(1, Math.max(0, ((b.top ?? 0) - this.lowMidi) / (b.span || 1)));
    const mul = initial && !legato ? (b.silentMul ?? 1) : 1;
    const dip = (p.pitchDip + (b.lowCents || 0) * w) * mul * (initial ? 1 : 0.5);
    const T = (p.bendTime + (b.lowTime || 0) * w) * mul;
    // detune(x) = dip · (1−x)^q over T, six linear segments; q = 1 linear rise, q ≈ 3 exponential-like settle
    const q = p.bendCurve ?? 1;
    const o = p.onset || {};
    for (const { osc, baseDetune, lps, cutoff, start, lowW, fundPk, midPk, rmidi, h1Db } of this.ranks) {
      osc.detune.cancelScheduledValues(t);
      if (p.pitchTau) {
        osc.detune.setValueAtTime(baseDetune + p.pitchDip * (initial ? 1 : 0.5), t);
        osc.detune.setTargetAtTime(baseDetune, t, p.pitchTau);
      } else {
        osc.detune.setValueAtTime(baseDetune + dip, t);
        for (let i = 1; i <= 6; i++) osc.detune.linearRampToValueAtTime(baseDetune + dip * Math.pow(1 - i / 6, q), t + T * i / 6);
      }
      if (fundPk) {
        // late fundamental / hot mids, weighted by how low this rank is (same top/span as the bend), half on a re-speak
        const ow = Math.min(1, Math.max(0, ((b.top ?? 0) - rmidi) / (b.span || 1))) * (initial ? 1 : 0.5);
        fundPk.gain.cancelScheduledValues(t);
        fundPk.gain.setValueAtTime((o.fundDb || 0) * ow + h1Db, t);   // ends on the steady fundamental trim (timbre.h1Db)
        fundPk.gain.linearRampToValueAtTime(h1Db, t + (o.fundTime || 0.12));
        const mT = o.midTime || 0.3, mG = (o.midDb || 0) * ow;
        midPk.gain.cancelScheduledValues(t);
        midPk.gain.setValueAtTime(mG, t);
        midPk.gain.setValueAtTime(mG, t + 0.3 * mT);          // hold, then relax
        midPk.gain.setTargetAtTime(0, t + 0.3 * mT, 0.25 * mT);
      }
      for (const f of lps) {
        f.frequency.cancelScheduledValues(t);
        f.frequency.setValueAtTime(initial ? start : Math.max(start, f.frequency.value * 0.6), t);
        if (lowW > 0.02) { // low reed: constant-rate (octaves/s) opening — the 1-2 kHz formant arriving late
          f.frequency.exponentialRampToValueAtTime(cutoff, t + (p.openTimeLow || 0.3) * lowW + 3 * p.openTau * (1 - lowW));
        } else {
          f.frequency.setTargetAtTime(cutoff, t + (legato ? 0 : p.swell * 0.3), legato ? p.legatoOpenTau : p.openTau);
        }
      }
    }
    if (initial) {
      // raised-cosine swell, floored at attackPeriods cycles of the lowest reed (33 Hz cannot speak in 12 ms)
      this.env.gain.setValueAtTime(0, t);
      rampS(this.env.gain, t, Math.max(legato ? p.legatoAttack : p.swell, (p.attackPeriods || 0) / this.lowFreq));
    }
  }

  reattack() { if (this.alive) this.speak(this.ctx.currentTime, true, false); }

  /**
   * Let the note go. `seconds` overrides the reed's own close time — the sustain pedal passes its long
   * fadeRelease here. A fading voice is no longer `alive` but still sounds, and damp() can cut it short.
   */
  release(seconds) {
    if (!this.alive) return;
    this.alive = false;
    this.fade(this.ctx.currentTime, seconds ?? this.p.release);
  }

  /** Cut a fade short (the pedal came up): whatever is left closes at the reed's own release time. */
  damp() {
    if (this.alive || this.dead) return; // only a voice already on its way out
    this.fade(this.ctx.currentTime, this.p.release);
  }

  /**
   * Ramp out over d seconds and schedule teardown. Safe to run again on a voice already fading: the envelope is
   * re-based on where it has got to, and a later stop()/timer overrides the earlier one — which is how damp()
   * pulls a long pedal tail in to the reed's own release.
   */
  fade(t, d) {
    const p = this.p;
    const g = this.env.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + d);
    for (const { lps, cutoff } of this.ranks) for (const f of lps) { // highs go first: a long tail dulls as it dies
      f.frequency.cancelScheduledValues(t);
      f.frequency.setValueAtTime(f.frequency.value, t);
      f.frequency.exponentialRampToValueAtTime(cutoff * p.releaseClose, t + d);
    }
    const stopAt = t + d + 0.02;
    for (const { osc } of this.ranks) osc.stop(stopAt);
    this.noiseSrc.stop(stopAt);
    this.jitterSrc.stop(stopAt);
    this.endsAt = stopAt; // ctx time this voice goes quiet — engine.js prunes its tail list by it
    clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => this.kill(), (d + 0.05) * 1000);
  }

  kill() {
    clearTimeout(this.killTimer);
    try { this.env.disconnect(); for (const { lps } of this.ranks) lps[1].disconnect(); this.jitterGain.disconnect(); this.fmGain.disconnect(); } catch (_) {}
    this.alive = false;
    this.dead = true;
  }
}
