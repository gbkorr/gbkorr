// Entry point: constructs the engine and input, wires the ui/ modules together, and keeps the one-off page
// chrome (start overlay, theme, info dialog, kbd-nav flag). See STRUCTURE.md for the map.
import { buildLayout, DEFAULT_SPLIT, SPLIT_MIN, SPLIT_MAX } from './layout.js';
import { AudioEngine } from './engine.js';
import { KeyboardInput } from './input.js';
import { TUNING } from './tuning.js';
import { $, clamp } from './ui/util.js';
import { createKeyboard } from './ui/keyboard.js';
import { createRegisters } from './ui/registers.js';
import { createSplitControl } from './ui/split.js';
import { createDials } from './ui/dials.js';
import { initDebug } from './ui/debug.js';

window.TUNING = TUNING; // live-tweakable from the console (see tuning.js)

let split = DEFAULT_SPLIT;
let layout = buildLayout(split);
const engine = new AudioEngine();
window.engine = engine; // for console poking and the offline test pages
let input; // assigned below; the ui modules only touch it from event handlers

const kb = createKeyboard({
  engine,
  getInput: () => input,
  getLayout: () => layout,
  getSplit: () => split,
  onRendered: () => splitCtl.position(),
});
const registers = createRegisters({
  engine,
  onChange: () => { input.retrigger(); kb.updateLabels(); }, // held keys pick up the new reeds; labels follow
});
const splitCtl = createSplitControl({ getSplit: () => split, keyEls: kb.keyEls, onSplit: setSplit });
const dials = createDials({
  getOctave: (hand) => input.octave[hand],
  setOctave: (hand, o) => input.setOctave(hand, o),
});

// A split change is a keyboard rebuild with a cross-fade on the keys that change hands; the fade state is read
// before the rebuild destroys the old keys and played on the new ones.
function setSplit(s) {
  s = clamp(Math.round(s), SPLIT_MIN, SPLIT_MAX);
  if (s === split) { splitCtl.place(); return; } // same detent: the cap just follows the pointer
  const fade = kb.prepareSplitFade(split, s);
  split = s;
  layout = buildLayout(split);
  input.setLayout(layout);
  kb.render(); // lands the previous fade, rebuilds every key, repositions the knob
  kb.playSplitFade(fade);
}

// engine/input → ui notifications
const ui = {
  key: kb.keyHeld,
  octave: (hand, o) => { dials.show(hand, o); kb.onOctaveChanged(hand); },
  registers: registers.render,
};

input = new KeyboardInput(layout, engine, ui);
kb.render();
registers.render();
for (const hand of ['right', 'left']) ui.octave(hand, input.octave[hand]); // the left hand starts at −1 octave

// ---- start overlay: the AudioContext needs a user gesture ----
async function start() {
  await engine.init();
  $('overlay').classList.add('hidden');
}
$('overlay').addEventListener('click', start);
window.addEventListener('keydown', () => { if (!engine.ready) start(); }, { capture: true });
input.attach();

// Keyboard-navigation mode (html.kbd-nav): Tab in and the controls take a focus ring and answer Space/Enter
// (input.js); any pointerdown turns it off. :focus-visible can't draw this line — see STRUCTURE.md.
// Capture phase, so the flag is already right when anything else handles the event.
const setKbdNav = (on) => document.documentElement.classList.toggle('kbd-nav', on);
window.addEventListener('keydown', (e) => { if (e.key === 'Tab') setKbdNav(true); }, { capture: true });
window.addEventListener('pointerdown', () => setKbdNav(false), { capture: true });

// ---- light/dark slide switch (dark = default; checked = light) ----
const themeToggle = $('themeToggle');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  themeToggle.checked = t === 'light';
  try { localStorage.setItem('bayan-theme', t); } catch {}
}
themeToggle.addEventListener('change', () => applyTheme(themeToggle.checked ? 'light' : 'dark'));
let savedTheme = 'dark';
try { savedTheme = localStorage.getItem('bayan-theme') || 'dark'; } catch {}
applyTheme(savedTheme);

// ---- info popup ----
const infoDialog = $('infoDialog');
$('infoBtn').addEventListener('click', () => infoDialog.showModal());
$('infoClose').addEventListener('click', () => infoDialog.close());
infoDialog.addEventListener('click', (e) => { if (e.target === infoDialog) infoDialog.close(); }); // backdrop click

// ---- volume faders ----
for (const [hand, sfx] of [['right', 'R'], ['left', 'L']]) {
  const fader = $('vol' + sfx);
  fader.addEventListener('input', () => engine.setVolume(hand, parseFloat(fader.value)));
  fader.addEventListener('wheel', (e) => {
    fader.value = clamp(parseFloat(fader.value) + (e.deltaY < 0 ? 0.05 : -0.05), 0, 1);
    engine.setVolume(hand, parseFloat(fader.value));
    e.preventDefault();
  }, { passive: false });
}

initDebug();

window.addEventListener('resize', () => splitCtl.position());
requestAnimationFrame(() => splitCtl.position()); // first layout may not be settled when the module runs
// the knob's ease-back is armed only once the board has settled: the first layout passes move the cap from
// nowhere to its detent, and that must not read as a slide
window.addEventListener('load', () => { splitCtl.position(); $('splitKnob').classList.add('eased'); });
