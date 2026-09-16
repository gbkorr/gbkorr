// Octave dials: a detented rotary per hand, 9 positions (±2 octaves in half-octave steps) over a 240° throw.
// Only the amber pointer (.oct-turn) rotates — the cap, knurling and shading stay put, because the light does
// not move when you turn a knob. Rotation is one CSS custom property, so easing is CSS's problem.
import { octaveLabel } from '../input.js';
import { $, clamp } from './util.js';

const OCT_MIN = -4, OCT_MAX = 4, OCT_SWEEP = 30; // degrees per half-octave step; 8 steps = 240°
const OCT_NUM_R = 33; // numbered ring, far enough out that a two-glyph '−2' clears the knob's skirt
// 0 points straight down and the arc opens upward, clear of the reading above it; measured clockwise from up,
// so −2 lands upper-left and +2 upper-right and the scale reads left-to-right.
const octDeg = (step) => 180 - step * OCT_SWEEP;
const polar = (r, deg) => { const a = (deg - 90) * Math.PI / 180; return [32 + r * Math.cos(a), 32 + r * Math.sin(a)]; };
const line = (r1, r2, deg, attrs) => {
  const [x1, y1] = polar(r1, deg), [x2, y2] = polar(r2, deg);
  return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" ${attrs}/>`;
};
// emitted once; both dials reference the gradients by id (same document, so that resolves)
const DIAL_DEFS = `<defs>
  <radialGradient id="ok-top" cx="0.36" cy="0.28" r="0.9">
    <stop offset="0" stop-color="#82828d"/><stop offset="0.5" stop-color="#3d3d45"/><stop offset="1" stop-color="#1c1c22"/>
  </radialGradient>
  <linearGradient id="ok-knurl" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#9497a0"/><stop offset="0.45" stop-color="#4d4d57"/><stop offset="1" stop-color="#212127"/>
  </linearGradient>
  <radialGradient id="ok-seat" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0.86" stop-color="#000" stop-opacity="0"/><stop offset="0.95" stop-color="#000" stop-opacity="0.34"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
  </radialGradient>
</defs>`;
let dialDefsDone = false;

// The dial is the reading, so the scale carries the numbers: whole octaves as numerals −2..2, the halves as
// marks. The viewBox opens to -10..74 to hold the numerals, keeping the centre at (32, 32) — which is what
// stepAt reads off the element's rect.
function buildDial(el) {
  let scale = '', numbers = '';
  for (let k = OCT_MIN + 1; k < OCT_MAX; k += 2)      // the half octaves; the wholes are numbered instead
    scale += line(27, 30, octDeg(k), 'class="oct-detent" stroke-width="1.1"');
  for (let k = OCT_MIN; k <= OCT_MAX; k += 2) {       // half-steps −4..4 are octaves −2..2
    const [x, y] = polar(OCT_NUM_R, octDeg(k));
    numbers += `<text class="oct-num" x="${x.toFixed(2)}" y="${y.toFixed(2)}">${String(k / 2).replace('-', '−')}</text>`;
  }
  let knurl = '';
  for (let i = 0; i < 30; i++) knurl += line(16.6, 21, i * 12, '');
  el.innerHTML = `<svg viewBox="-10 -10 84 84" aria-hidden="true">
    ${dialDefsDone ? '' : DIAL_DEFS}
    <g class="oct-scale">${scale}</g>
    <g class="oct-nums">${numbers}</g>
    <circle cx="32" cy="32" r="23" fill="url(#ok-seat)"/>
    <circle cx="32" cy="32" r="21" fill="url(#ok-knurl)"/>
    <g stroke="#00000075" stroke-width="1.1">${knurl}</g>
    <circle cx="32" cy="32" r="16.4" fill="url(#ok-top)"/>
    <circle cx="32" cy="32" r="16.4" fill="none" stroke="#ffffff22" stroke-width="0.9"/>
    <g class="oct-turn">${line(4.5, 14, 0, 'stroke="#d9a441" stroke-width="2.2" stroke-linecap="round"')}</g>
  </svg>`;
  dialDefsDone = true;
}

export function createDials({ getOctave, setOctave }) {
  // Grab a dial and it turns to where you point — nine detents over 240° make each a wide target, so a single
  // click sets the octave outright. Wheel and arrows step; the Shift+key hotkeys drive the same setOctave, so
  // the dial follows them too.
  function setupDial(hand, sfx) {
    const dial = $('octDial' + sfx);
    buildDial(dial);
    const set = (s) => setOctave(hand, clamp(s, OCT_MIN, OCT_MAX));
    const stepAt = (e) => {
      const r = dial.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.right) / 2, dy = e.clientY - (r.top + r.bottom) / 2;
      if (Math.hypot(dx, dy) < 8) return null; // too close to the spindle for an angle to mean anything
      // atan2(dx, dy): 0° straight down — the centre of the throw — positive toward +2 on the right
      const deg = Math.atan2(dx, dy) * 180 / Math.PI;
      // Hard stops: just past either end the value clamps, but deep in the dead sector above it holds instead —
      // the two extremes meet at 12 o'clock, and without this a pixel of travel there flips ±2.
      if (Math.abs(deg) > OCT_MAX * OCT_SWEEP + OCT_SWEEP / 2) return null;
      return clamp(Math.round(deg / OCT_SWEEP), OCT_MIN, OCT_MAX);
    };
    const onMove = (e) => { const s = stepAt(e); if (s !== null) set(s); };
    const endTurn = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', endTurn); };
    dial.addEventListener('pointerdown', (e) => {
      onMove(e); dial.focus(); // focus so the arrows work straight after a grab; the ring stays off (kbd-nav)
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', endTurn);
      e.preventDefault();
    });
    dial.addEventListener('wheel', (e) => { set(getOctave(hand) + (e.deltaY < 0 ? 1 : -1)); e.preventDefault(); }, { passive: false });
    // the full ARIA slider key set (input.js hands a focused control all of these); Page = a whole octave
    dial.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 2, PageDown: -2 }[e.key];
      if (d) set(getOctave(hand) + d);
      else if (e.key === 'Home') set(OCT_MIN);
      else if (e.key === 'End') set(OCT_MAX);
      else return;
      e.preventDefault();
    });
  }
  setupDial('right', 'R');
  setupDial('left', 'L');

  /** Point the dial's needle at step o and update its ARIA reading. */
  function show(hand, o) {
    const dial = $('octDial' + (hand === 'right' ? 'R' : 'L'));
    dial.style.setProperty('--oct-deg', octDeg(o) + 'deg');
    dial.setAttribute('aria-valuenow', o);
    dial.setAttribute('aria-valuetext', octaveLabel(o) + ' octaves');
  }

  return { show };
}
