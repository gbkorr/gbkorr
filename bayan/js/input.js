// Keyboard → engine. Everything is keyed by e.code (physical key) so Shift and OS layouts don't matter.
//
// Space is the bellows pump and the sustain pedal at once: pressure boost while held (engine.setPump), and a key
// released under it fades over TUNING[kind].fadeRelease; letting go damps whatever still rings.
//
// Hold Shift OR Enter plus a key to work the registers and octaves (bass is a fixed 16'+8' stack):
//   rank toggles, home row, in switch order:
const RANK_KEYS = { KeyJ: '+5', KeyK: '4', KeyL: '8', Semicolon: '8c', Quote: '16' };
//   preset select, the row above, in switch order:
const PRESET_KEYS = { KeyU: 'base', KeyI: 'main', KeyO: 'clarion', KeyP: 'organ',
                      BracketLeft: 'master', BracketRight: 'chime', Backslash: 'wave' };
//   octave shift by a half step — left key of each pair lowers, matching their bottom-row order:
const OCTAVE_KEYS = { Period: ['right', -1], Slash: ['right', 1], KeyM: ['left', -1], Comma: ['left', 1] };

// Keyboard-navigation hand-off: a focused control keeps arrows/Home/End/Page always, and Space/Enter only when
// focus arrived by Tab (html.kbd-nav, set in main.js — see STRUCTURE.md for why :focus-visible can't do this).
// Playing any note blurs the control and hands the keyboard back to the instrument.
const NAV_KEYS = /^(Arrow|Page|Home$|End$)/;
const tag = (el) => (el instanceof Element ? el.tagName.toUpperCase() : ''); // SVG tag names come back lower-case
const isControl = (el) => /^(INPUT|SELECT|TEXTAREA)$/.test(tag(el)) || el?.getAttribute?.('role') === 'slider';
// only what actually consumes Space or Enter: a range input (the volume faders) uses neither, so Space with one
// focused still works the bellows
const takesActivation = (el) => tag(el) === 'BUTTON' || (tag(el) === 'A' && el.hasAttribute('href'))
  || (tag(el) === 'INPUT' && el.type !== 'range');
const kbdNav = () => document.documentElement.classList.contains('kbd-nav');

// Octave shift in half-octave steps -4..4: whole steps are octaves, the odd half a tritone (±6) — exactly two
// keys sideways on the B-system lattice, so a hand position survives a half-step shift.
export const octaveSemis = (step) => 12 * Math.floor(step / 2) + (step & 1 ? 6 : 0);
export const octaveLabel = (step) => {
  const body = (Math.trunc(Math.abs(step) / 2) || '') + (step % 2 ? '½' : '') || '0';
  return step > 0 ? '+' + body : step < 0 ? '−' + body : body;
};

export class KeyboardInput {
  constructor(layout, engine, ui) {
    this.layout = layout;
    this.engine = engine;
    this.ui = ui;
    this.held = new Map(); // code -> timestamp
    // half-octave steps, -4..4; the left hand starts an octave down (display −1) because layout.js voices
    // BASS_TOP high
    this.octave = { right: 0, left: -2 };
    this.enterHeld = false; // Enter is a second register modifier alongside Shift
    this.peak = 0;
    this.onDown = this.onDown.bind(this);
    this.onUp = this.onUp.bind(this);
    this.releaseAll = this.releaseAll.bind(this);
  }

  attach() {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    // Firefox quick-find opens on ' and / at keypress time; keydown preventDefault alone is not enough there.
    // Same exception as onDown: a tabbed-to button keeps its Space, which browsers act on after keypress.
    window.addEventListener('keypress', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.code === 'Space' && kbdNav() && takesActivation(e.target)) return;
      if (this.layout.has(e.code) || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
  }

  onDown(e) {
    if (e.repeat) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return; // browser shortcuts pass through untouched
    if (document.querySelector('dialog[open]')) return; // typing inside the info popup is not playing
    if (isControl(e.target) && NAV_KEYS.test(e.code)) return; // a focused slider works off its own arrows
    if (e.code === 'Space' || e.code === 'Enter') {
      if (kbdNav() && takesActivation(e.target)) return; // ...and a tabbed-to control off its own Space/Enter
      if (e.code === 'Space') this.engine.setPump(true); else this.enterHeld = true;
      e.preventDefault();
      return;
    }
    if (e.shiftKey || this.enterHeld) {
      if (RANK_KEYS[e.code] || PRESET_KEYS[e.code]) {
        // pass which switch was worked so the UI can throw it, the way a click's :active does
        if (RANK_KEYS[e.code]) { this.engine.toggleRank(RANK_KEYS[e.code]); this.ui.registers({ rank: RANK_KEYS[e.code] }); }
        else { this.engine.setPreset(PRESET_KEYS[e.code]); this.ui.registers({ preset: PRESET_KEYS[e.code] }); }
        e.preventDefault();
        return;
      }
      if (OCTAVE_KEYS[e.code]) {
        const [hand, d] = OCTAVE_KEYS[e.code];
        this.setOctave(hand, this.octave[hand] + d);
        e.preventDefault();
        return;
      }
    }
    if (e.code === 'PageUp' || e.code === 'PageDown') {
      this.setOctave('right', this.octave.right + (e.code === 'PageUp' ? 1 : -1));
      e.preventDefault();
      return;
    }
    const entry = this.layout.get(e.code);
    if (!entry) return;
    if (e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) e.target.blur();
    e.preventDefault();
    if (this.held.has(e.code)) return;
    this.held.set(e.code, performance.now());
    this.peak = Math.max(this.peak, this.held.size);
    const shift = octaveSemis(this.octave[entry.hand]);
    this.engine.noteOn(e.code, entry.notes.map((n) => n + shift), entry.kind);
    this.ui.key(e.code, true);
  }

  onUp(e) {
    if (e.code === 'Space') { this.engine.setPump(false); return; }
    if (e.code === 'Enter') { this.enterHeld = false; return; }
    if (!this.held.has(e.code)) return;
    this.held.delete(e.code);
    this.engine.noteOff(e.code);
    this.ui.key(e.code, false);
  }

  setOctave(hand, o) {
    o = Math.max(-4, Math.min(4, o));
    // No-op on the same value: a drag lands on the same detent frame after frame, and a key held at a stop
    // clamps to what it has. Both used to re-speak every sounding note, stuttering the held chord.
    if (o === this.octave[hand]) return;
    this.octave[hand] = o;
    this.retrigger();
    this.ui.octave(hand, o);
  }

  /** Re-speak every held key so a register/octave change applies to notes already sounding. */
  retrigger() {
    for (const code of this.held.keys()) {
      const entry = this.layout.get(code);
      if (!entry) continue;
      this.engine.noteOff(code, false); // a re-speak, not a note ending: never leaves a pedal tail
      this.engine.noteOn(code, entry.notes.map((n) => n + octaveSemis(this.octave[entry.hand])), entry.kind);
    }
  }

  setLayout(layout) { this.releaseAll(); this.layout = layout; }

  releaseAll() {
    for (const code of [...this.held.keys()]) { this.engine.noteOff(code); this.ui.key(code, false); }
    this.held.clear();
    this.enterHeld = false;
    this.engine.setBellows(true);
    this.engine.setPump(false);
  }

  /** Keys held a long time without keyup — likely a missed keyup (rollover/ghosting). */
  stuckKeys(ms = 15000) {
    const now = performance.now();
    return [...this.held].filter(([, t]) => now - t > ms).map(([c]) => c);
  }
}
