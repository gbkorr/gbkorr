import { ReedVoice, preloadNoise } from './voice.js';
import { RANKS, PRESETS } from './reed.js';
import { TUNING } from './tuning.js';

const MAX_VOICES = 16;
const MAX_FADING = 16; // pedal tails still sounding after their keys came up; past this the oldest is damped
// Whole-register names for the compat setRegister below (how the offline test pages ask for a register):
// the four single ranks plus every preset, spread in so the combos cannot drift from PRESETS.
const NAMED_RANKS = {
  piccolo: ['4'], clarinet: ['8'], bassoon: ['16'], cassotto: ['8c'],
  ...PRESETS,
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.groups = new Map(); // keyId -> { voices, t, kind }
    // The right-hand register IS `manual`, the set of active rank toggles. setPreset writes this set and the
    // `preset` getter reads back whichever preset it equals, so the two switch banks can never disagree.
    // Bass is always TUNING.bass.stack.
    this.manual = new Set(['8', '8c']); // = the "base" preset
    this.volumes = { right: 0.7, left: 0.4 };  // must match the #volR / #volL fader defaults in index.html
    this.bellowsOpen = true;
    this.lastNoteOff = -1;
    // Space is a sustain pedal as well as a pump: while held, a released key fades over TUNING[kind].fadeRelease
    // instead of closing, and the tail lives in `fading` until it finishes or the pedal comes up (dampFading).
    // Tails still sound, so they still count for the polyphony gain and for legato — see soundingCount.
    this.sustain = false;
    this.fading = [];
  }

  /** @param {BaseAudioContext} [ctx] optional injected context (tests use OfflineAudioContext) */
  async init(ctx) {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    ctx = ctx || new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    preloadNoise(ctx);

    // per-hand buses with a little stereo placement, into the polyphony-scaled voice bus
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 0.22;
    this.hands = {};
    for (const hand of ['right', 'left']) { const g = ctx.createGain(); g.gain.value = this.volumes[hand]; g.connect(this.voiceBus); this.hands[hand] = g; }
    this.buses = {};
    for (const kind of ['melody', 'bass']) {
      const pan = ctx.createStereoPanner(); pan.pan.value = TUNING[kind].pan;
      pan.connect(this.hands[kind === 'melody' ? 'right' : 'left']);
      if (kind === 'melody') { this.buses[kind] = pan; continue; }
      // bass side: its own resonator/radiation EQ (TUNING.bassBody) in front of the panner
      const eq = TUNING.bassBody.map(([type, f, q, g]) => mkFilter(ctx, type, f, q, g));
      eq.reduce((a, b) => (a.connect(b), b)).connect(pan);
      this.buses[kind] = eq[0];
    }

    // shared pitch offset (cents) driven by bellows pressure (the pump, not the faders — see setPump)
    this.pitchBus = ctx.createConstantSource(); this.pitchBus.offset.value = 0; this.pitchBus.start();

    // bellows gain: 1 = open, 0 = closed (per-hand volume lives in the hand gains)
    this.bellows = ctx.createGain();
    this.bellows.gain.value = 1;
    // slow pressure drift, multiplicative (a gain stage at 1 + lfo) so a closed bellows stays fully closed
    this.driftStage = ctx.createGain(); this.driftStage.gain.value = 1;
    this.drift = ctx.createOscillator(); this.drift.frequency.value = TUNING.pressure.driftHz * (0.8 + Math.random() * 0.4);
    this.driftGain = ctx.createGain(); this.driftGain.gain.value = Math.pow(10, TUNING.pressure.driftDb / 20) - 1;
    this.drift.connect(this.driftGain).connect(this.driftStage.gain); this.drift.start();
    // pressure boost while Space is held, ramping back after release
    this.boostStage = ctx.createGain(); this.boostStage.gain.value = 1;
    this.pump = { ...TUNING.pump };

    // body resonances
    const eq = TUNING.body.map(([f, q, g]) => mkFilter(ctx, 'peaking', f, q, g));
    this.brightness = ctx.createBiquadFilter();
    this.brightness.type = 'highshelf'; this.brightness.frequency.value = 2500; this.brightness.gain.value = 0;

    // near-dry room
    this.conv = ctx.createConvolver(); this.conv.buffer = makeIR(ctx, TUNING.reverb.seconds);
    this.wet = ctx.createGain(); this.wet.gain.value = TUNING.reverb.wet;
    this.dry = ctx.createGain(); this.dry.gain.value = 1;

    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -12; this.glue.knee.value = 12; this.glue.ratio.value = 2;
    this.glue.attack.value = 0.008; this.glue.release.value = 0.25; // fast attack: a reed has no transient to let through
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -4; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001; this.limiter.release.value = 0.06;
    this.master = ctx.createGain(); this.master.gain.value = 0.8;

    let n = this.voiceBus.connect(this.bellows).connect(this.driftStage).connect(this.boostStage);
    for (const f of eq) n = n.connect(f);
    n = n.connect(this.brightness);
    n.connect(this.dry).connect(this.glue);
    n.connect(this.conv).connect(this.wet).connect(this.glue);
    this.glue.connect(this.limiter).connect(this.master).connect(ctx.destination);

    for (const hand of ['right', 'left']) this.setVolume(hand, this.volumes[hand]);
  }

  get ready() { return !!this.ctx && (this.ctx.state === 'running' || this.ctx instanceof OfflineAudioContext); }
  get voiceCount() { let n = 0; for (const g of this.groups.values()) n += g.voices.length; return n; }
  /** Everything audible: keys down plus pedal tails. What the polyphony gain divides, and what makes a note legato. */
  get soundingCount() { return this.voiceCount + this.fading.length; }

  toggleRank(k) { if (!RANKS[k]) return; this.manual.has(k) ? this.manual.delete(k) : this.manual.add(k); }
  setPreset(name) { if (PRESETS[name]) this.manual = new Set(PRESETS[name]); } // sets the manual toggles to match
  activeReeds() { return [...this.manual]; }
  /** The lit preset: the one the manual set exactly equals, else null. Derived, so a hand-built stack lights
   *  its preset by itself and re-selecting a lit preset is a no-op. */
  get preset() {
    for (const [name, ranks] of Object.entries(PRESETS))
      if (ranks.length === this.manual.size && ranks.every((k) => this.manual.has(k))) return name;
    return null;
  }

  // Compatibility: select a whole named register (the GUI uses toggleRank / setPreset instead).
  setRegister(name) { if (NAMED_RANKS[name]) this.manual = new Set(NAMED_RANKS[name]); }

  /** A hand's fader: plain output gain, 0 = silent, 1 = unity. Pressure expression (tuning, brightness)
   *  deliberately does NOT ride the faders — it belongs to the pump (setPump), so a balance can be set
   *  without retuning the instrument. */
  setVolume(hand, v) {
    this.volumes[hand] = v;
    if (!this.ctx) return;
    this.hands[hand].gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  _updatePolyGain() {
    this._pruneFading();
    const n = Math.max(1, this.soundingCount);
    this.voiceBus.gain.setTargetAtTime(0.22 / Math.pow(n, TUNING.polyExp), this.ctx.currentTime, 0.03);
  }

  noteOn(keyId, notes, kind) {
    if (!this.ready) return;
    if (this.groups.has(keyId)) return;
    while (this.voiceCount + notes.length > MAX_VOICES) this._stealOldest();
    const ranks = kind === 'melody' ? this.activeReeds().map((k) => RANKS[k]) : TUNING.bass.stack;
    if (!ranks.length) return; // all register switches off = silent
    const now = this.ctx.currentTime;
    const legato = this.soundingCount > 0 || now - this.lastNoteOff < TUNING.legatoWindow;
    const opts = { legato, pitchBus: this.pitchBus };
    const voices = notes.map((m) => new ReedVoice(this.ctx, this.buses[kind], m, kind, ranks, opts));
    this.groups.set(keyId, { voices, t: now, kind });
    this._updatePolyGain();
  }

  /** @param {boolean} [fade] let the note ring out (default: whether the pedal is down). A re-speak — register
   *  change under a held key, a stolen voice — passes false so it replaces the note instead of leaving a tail. */
  noteOff(keyId, fade = this.sustain) {
    const g = this.groups.get(keyId);
    if (!g) return;
    this.groups.delete(keyId);
    for (const v of g.voices) {
      v.release(fade ? TUNING[g.kind].fadeRelease : undefined);
      if (fade) this.fading.push(v);
    }
    this.lastNoteOff = this.ctx.currentTime;
    this._updatePolyGain();
  }

  allOff() { for (const k of [...this.groups.keys()]) this.noteOff(k, false); this.dampFading(); }

  /** The pedal came up: every tail closes at its reed's own release time. */
  dampFading() {
    for (const v of this.fading) v.damp();
    this.fading.length = 0;
  }

  /** Forget tails that have gone quiet; if they pile up, damp the oldest rather than let the wash grow. */
  _pruneFading() {
    if (!this.fading.length) return;
    const now = this.ctx.currentTime;
    this.fading = this.fading.filter((v) => v.endsAt > now && !v.dead);
    while (this.fading.length > MAX_FADING) this.fading.shift().damp();
  }

  _stealOldest() {
    let oldest = null;
    for (const [k, g] of this.groups) if (!oldest || g.t < oldest[1].t) oldest = [k, g];
    if (oldest) this.noteOff(oldest[0], false);
  }

  setBellows(open) {
    if (!this.ctx || this.bellowsOpen === open) return;
    this.bellowsOpen = open;
    const t = this.ctx.currentTime;
    const g = this.bellows.gain;
    const stop = 0.012;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    if (open) {
      g.linearRampToValueAtTime(1, t + Math.max(0.025, stop));
      for (const grp of this.groups.values()) for (const v of grp.voices) v.reattack();
    } else {
      g.linearRampToValueAtTime(0, t + stop);
    }
  }

  /** Space: bellows pump and sustain pedal in one. On press: optional reversal dip, every held reed re-speaks,
   *  pressure rises toward 1 + boost while held; on release it ramps back at the same rate and the pedal tails
   *  are damped. Pressure is more than level — see _pressureExpression. */
  setPump(held) {
    if (!this.ctx) return;
    this.sustain = held;
    if (!held) this.dampFading(); // pedal up: the tails go with it
    const t = this.ctx.currentTime;
    const b = this.boostStage.gain, top = 1 + this.pump.boost, rate = Math.max(0.01, this.pump.boost) / Math.max(0.01, this.pump.seconds);
    b.cancelScheduledValues(t);
    b.setValueAtTime(b.value, t);
    if (held) {
      if (this.bellowsOpen && this.pump.dip > 0) { // reversal: quick dip and recovery
        const g = this.bellows.gain, d = this.pump.dipMs / 1000;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(1 - this.pump.dip, t + d * 0.3);
        g.linearRampToValueAtTime(1, t + d);
      }
      for (const grp of this.groups.values()) for (const v of grp.voices) v.reattack();
    }
    const target = held ? top : 1;
    const ramp = Math.max(0.01, Math.abs(target - b.value) / rate);
    b.linearRampToValueAtTime(target, t + ramp);
    this._pressureExpression(target, t, ramp);
  }

  /** The non-level side of pressure: pitchCentsPerDb of sharpening (a reed rises as it is driven harder —
   *  measured on the recordings) and a little more top. Follows the pump's own ramp. */
  _pressureExpression(level, t, ramp) {
    const db = 20 * Math.log10(level);
    for (const [param, target] of [[this.pitchBus.offset, TUNING.pressure.pitchCentsPerDb * db],
                                   [this.brightness.gain, 0.6 * db]]) {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(target, t + ramp);
    }
  }

  setPumpOptions(opts) { Object.assign(this.pump, opts); }
}

function mkFilter(ctx, type, f, q, gain) {
  const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = gain; return b;
}

function makeIR(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.25));
  }
  return buf;
}
