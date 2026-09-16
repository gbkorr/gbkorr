// The key-split knob: a detented fader riding below the keyboard, parked in the bass/melody gap of the Z row.
// measure() reads the board into an even detent grid (one key pitch apart); everything else is arithmetic on
// that grid — place() and splitFromClientX use the same numbers, so the cap and the value can never disagree
// about which detent the pointer is nearest, and a drag never re-reads layout per pointermove.
// measure() also aligns the register row and octave pads to the rendered keyboard: one resize pass.
import { ROWS, leftCounts, SPLIT_MIN, SPLIT_MAX } from '../layout.js';
import { $, clamp } from './util.js';

const SPLIT_ROW = 3;      // the Z row: the knob follows its hand gap
const HAND_GAP = 82;      // px, = the .key.handstart margin in style.css
const KNOB_NUDGE = 0.2;   // knob drawn this many key pitches left of the gap ("after this key", not floating)
const KNOB_HALF = 30;     // half #splitKnob's 60px width: the track runs this far past either end detent
const GUTTER = 84;        // px, the volume-fader columns either side of the keyboard (.cols in style.css)

export function createSplitControl({ getSplit, keyEls, onSplit }) {
  const splitKnob = $('splitKnob');
  let detent = { lo: 0, pitch: 56, wrapL: 0, wrapW: 0 }; // the SPLIT_MIN detent and the spacing, in #splitWrap
  let dragX = null; // where the cap's centre wants to be while dragging, in client x; null at rest

  function measure() {
    // the split slider and register block are sized to the rendered keyboard so they line up with it exactly
    const kbEl = $('keyboard');
    $('splitWrap').style.width = kbEl.offsetWidth + 'px';
    $('registers').style.width = (kbEl.offsetWidth + 2 * GUTTER) + 'px'; // centred over the key area
    // each octave dial is centred over the centre of its hand's volume fader below
    for (const [oct, fader] of [['octL', 'volL'], ['octR', 'volR']]) {
      const el = $(oct), pad = el.querySelector('.oct-pad');
      el.style.transform = '';
      const r = $(fader).getBoundingClientRect(), p = pad.getBoundingClientRect();
      el.style.transform = `translateX(${(r.left + r.right) / 2 - (p.left + p.right) / 2}px)`;
    }
    const split = getSplit();
    const row = ROWS[SPLIT_ROW], c = leftCounts(split)[SPLIT_ROW]; // bass keys on this row (0 at SPLIT_MIN)
    const lastBass = keyEls.get(row[c - 1]), firstMel = keyEls.get(row[c]);
    const wrap = $('splitWrap').getBoundingClientRect();
    // offsetLeft, not a client rect: a hand mid-shift carries a transform, and layout positions ignore it
    const kb = kbEl.getBoundingClientRect();
    const keyLeft = (el) => kb.left + el.offsetLeft;
    // key pitch, measured from two number-row bass keys (which never straddle the hand gap)
    const pitch = keyLeft(keyEls.get(ROWS[0][1])) - keyLeft(keyEls.get(ROWS[0][0]));
    // centre of the hand gap (when the whole row is melody, the gap is the first key's handstart margin)
    const gapMid = firstMel ? keyLeft(firstMel) - HAND_GAP / 2
                            : keyLeft(lastBass) + lastBass.offsetWidth + HAND_GAP / 2;
    // each step moves the cap one key pitch, so the detents are an even grid; only its origin is measured
    const lo = gapMid - KNOB_NUDGE * pitch - wrap.left - (split - SPLIT_MIN) * pitch;
    detent = { lo, pitch, wrapL: wrap.left, wrapW: wrap.width };
  }

  function place() {
    const { lo, pitch, wrapL, wrapW } = detent;
    const split = getSplit();
    const x = lo + (split - SPLIT_MIN) * pitch, hi = lo + (SPLIT_MAX - SPLIT_MIN) * pitch;
    // mid-drag the cap rides the pointer (clamped to its travel) instead of hopping detent to detent
    splitKnob.style.left = (dragX === null ? x : clamp(dragX - wrapL, lo, hi)) + 'px';
    splitKnob.setAttribute('aria-valuenow', split);
    const track = $('splitTrack'), label = $('splitLabel');
    // the track runs the travel plus half a cap either end, so a cap on an end detent never overhangs it
    track.style.left = (lo - KNOB_HALF) + 'px'; track.style.right = (wrapW - hi - KNOB_HALF) + 'px';
    // snap marks: one per split, the first half a cap in from the left end (+2 = the last mark's own width)
    track.style.setProperty('--tick-pitch', pitch + 'px');
    track.style.setProperty('--tick-span', ((SPLIT_MAX - SPLIT_MIN) * pitch + 2) + 'px');
    label.style.left = (hi + KNOB_HALF + 14) + 'px'; // KEY SPLIT label hugs the track's right end
  }

  function position() { measure(); place(); }

  // the split under a point: arithmetic off the detent grid, so a step lands half a pitch either side of the cap
  function splitFromClientX(clientX) {
    const n = (clientX - detent.wrapL - detent.lo) / detent.pitch; // the pointer, in detents from SPLIT_MIN
    return clamp(Math.round(n) + SPLIT_MIN, SPLIT_MIN, SPLIT_MAX);
  }

  let dragging = false, grabDx = 0;
  const onMove = (e) => { if (dragging) { dragX = e.clientX + grabDx; onSplit(splitFromClientX(dragX)); } };
  const endDrag = () => {
    dragging = false; dragX = null;
    splitKnob.classList.remove('dragging');
    place(); // eases the cap the last half-pitch onto its detent
    window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', endDrag);
  };
  function beginDrag(e) {
    // grabbing the cap keeps the spot you grabbed under the pointer; grabbing the bare track centres it there
    const r = splitKnob.getBoundingClientRect();
    grabDx = splitKnob.contains(e.target) ? (r.left + r.right) / 2 - e.clientX : 0;
    dragging = true;
    splitKnob.classList.add('dragging');
    onMove(e);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    e.preventDefault();
  }
  splitKnob.addEventListener('pointerdown', beginDrag);
  $('splitWrap').addEventListener('pointerdown', (e) => { if (e.target !== splitKnob) beginDrag(e); });
  splitKnob.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -2, PageUp: 2 }[e.key];
    if (d) onSplit(getSplit() + d);
    else if (e.key === 'Home') onSplit(SPLIT_MIN);
    else if (e.key === 'End') onSplit(SPLIT_MAX);
    else return;
    e.preventDefault();
  });

  return { position, place };
}
