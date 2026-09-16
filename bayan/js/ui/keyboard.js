// The key board: builds the key DOM, keeps labels/colours current, and owns both key animations —
// the octave-shift slide and the split-step cross-fade (design notes in STRUCTURE.md).
import { ROWS, ROW_STAGGER, leftCounts, keyLabel, noteName } from '../layout.js';
import { RANKS } from '../reed.js';
import { octaveSemis } from '../input.js';
import { $ } from './util.js';

const BLACK = new Set([1, 3, 6, 8, 10]); // incidental pitch classes → black keys

export function createKeyboard({ engine, getInput, getLayout, getSplit, onRendered }) {
  const keyEls = new Map(); // code → .key element (one Map for the life of the app; render() refills it)
  const kbEl = $('keyboard');
  const slowMo = matchMedia('(prefers-reduced-motion: reduce)');
  const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };

  // ---- key DOM ----
  // One continuous keyboard: every physical key in its real position, coloured/shaped by hand and pitch class,
  // with a gap (.handstart margin) before the first melody key of each row.
  function render() {
    landNow(false); // the strip and the cross-fade are about to stop existing; the rebuild repaints anyway
    const el = $('keyboard');
    el.innerHTML = '';
    keyEls.clear();
    const counts = leftCounts(getSplit());
    ROWS.forEach((row, r) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'row';
      rowEl.style.setProperty('--indent', ROW_STAGGER[r]);
      row.forEach((code, i) => {
        const entry = getLayout().get(code);
        const k = document.createElement('div');
        k.className = `key ${entry.kind} ${isBlack(code) ? 'black' : 'white'}` + (i === counts[r] ? ' handstart' : '');
        k.innerHTML = `<b>${keyLabel(code)}</b><b class="b-was"></b><span>${labelNote(code)}</span>`;
        rowEl.appendChild(k);
        keyEls.set(code, k);
      });
      el.appendChild(rowEl);
    });
    onRendered();
  }

  function keyHeld(code, on) { keyEls.get(code)?.classList.toggle('held', on); }

  // ---- note labels ----
  // Each key shows the sounding pitch of the reference reed plus its hand's octave shift; melody follows the
  // active register (prefer 8'/8c, else 4'/16'/+5), bass is always its 8' reference. Colour tracks the label.
  function refOffset() {
    const reeds = engine.activeReeds();
    const ref = ['8', '8c', '4', '16', '+5'].find((k) => reeds.includes(k)) || '8';
    const r = RANKS[ref];
    return (r.oct || 0) * 12 + (r.semis || 0);
  }
  function labelMidi(code) {
    const entry = getLayout().get(code);
    const oct = octaveSemis(getInput()?.octave[entry.hand] || 0);
    const off = entry.hand === 'right' ? refOffset() : 0;
    return entry.notes[0] + oct + off;
  }
  function labelNote(code) { return noteName(labelMidi(code)); }
  function isBlack(code) { return BLACK.has(((labelMidi(code) % 12) + 12) % 12); }
  function paintSlot(el, midi) {
    const s = el.querySelector('span'); if (s) s.textContent = noteName(midi);
    const black = BLACK.has(((midi % 12) + 12) % 12);
    el.classList.toggle('black', black);
    el.classList.toggle('white', !black);
  }
  function paintKey(code, el) { paintSlot(el, labelMidi(code)); }

  // ---- octave-shift slide ----
  // The board carries one offset per hand rather than animating a change: every slot renders its committed note
  // at x + u, with u integrated toward target, so retargeting mid-slide is free and landing (repaint + zero u)
  // is invisible. sigma = slots one step moves the notes (+2 melody, −2 bass), read off the layout.
  const HANDS = ['right', 'left'];
  const RATE = 10;      // 1/s approach rate: 90% of the way in ln(10)/RATE seconds
  const EPS = 0.15;     // px; the snap before landing must be sub-pixel or it is the jump being avoided
  const DT_MAX = 0.05, DT_RESUME = 0.25; // s: one long frame must not teleport; a returning tab should just land
  const smooth = (t) => t * t * (3 - 2 * t);

  const committed = { right: null, left: null }; // the octave the DOM is painted for; null until the first shift
  const u = { right: 0, left: 0 }, target = { right: 0, left: 0 };
  const geo = { right: null, left: null };
  let rafId = 0, lastT = 0, cool = 0;

  // Geometry cache per hand. offsetLeft/offsetTop are layout positions — they ignore the slide transform, so the
  // cache can be rebuilt mid-slide. Built on the first shift, not at startup, so the legend metrics are final.
  function buildGeo(hand) {
    const rows = [];
    let d = 0, pitch = 0;
    for (const row of ROWS) {
      const codes = row.filter((code) => keyEls.has(code) && getLayout().get(code).hand === hand);
      if (!codes.length) continue;
      const cells = codes.map((code, k) => {
        const el = keyEls.get(code);
        return { el, b: el.querySelector('b'), was: el.querySelector('.b-was'),
                 x: el.offsetLeft, w: el.offsetWidth, k, op: 1 };
      });
      const last = cells.at(-1);
      // the hand gap sits before cells[0], never between two of them, so neighbours give both the key pitch
      // and the lattice step (±3 semitones per key, hence sigma = 6/d = ±2)
      if (!d && codes.length > 1) {
        d = getLayout().get(codes[1]).notes[0] - getLayout().get(codes[0]).notes[0];
        pitch = cells[1].x - cells[0].x;
      }
      rows.push({ cells, ghosts: [], at: new Set(), y: cells[0].el.offsetTop, x0: cells[0].x,
                  lo: cells[0].x, hi: last.x + last.w, base: getLayout().get(codes[0]).notes[0],
                  letters: codes.map(keyLabel) });
    }
    if (!d) return null;
    for (const row of rows) for (const c of row.cells) if (c.was && c.b) c.was.style.top = `${c.b.offsetTop}px`;
    const layer = document.createElement('div');
    layer.className = 'key-ghosts';
    kbEl.prepend(layer);
    return { rows, layer, fl: 0, d, pitch, sigma: 6 / d, melody: hand === 'right',
             uvar: hand === 'right' ? '--u-melody' : '--u-bass',
             fvar: hand === 'right' ? '--f-melody' : '--f-bass' };
  }
  function dropGeo(hand) {
    if (!geo[hand]) return;
    geo[hand].layer.remove();
    geo[hand] = null;
  }

  // what slot k sounds when the hand is painted for octave step m
  const noteAt = (g, row, k, m) => row.base + g.d * k + octaveSemis(m) + (g.melody ? refOffset() : 0);

  function repaintHand(hand) {
    const g = geo[hand];
    if (!g) { for (const [code, el] of keyEls) if (getLayout().get(code).hand === hand) paintKey(code, el); return; }
    const m = committed[hand] ?? getInput().octave[hand];
    for (const row of g.rows) {
      for (const c of row.cells) paintSlot(c.el, noteAt(g, row, c.k, m));
      for (const c of row.ghosts) paintSlot(c.el, noteAt(g, row, c.k, m));
    }
  }
  function updateLabels() { for (const hand of HANDS) repaintHand(hand); }

  // Ghost slots past either end of a hand's strip. Grow-only: one no longer needed is off the board by
  // construction and already at zero opacity, and a ghost never overlaps a real key.
  function addGhost(g, row, k, m) {
    if (row.at.has(k)) return;
    row.at.add(k);
    const src = row.cells[k < 0 ? 0 : row.cells.length - 1];
    const el = src.el.cloneNode(true);
    el.classList.remove('held');
    const x = row.x0 + k * g.pitch;
    el.style.cssText = `position:absolute;left:${x}px;top:${row.y}px;margin:0`;
    const c = { el, b: el.querySelector('b'), was: el.querySelector('.b-was'), x, w: src.w, k, op: 1 };
    if (c.was && src.was) c.was.style.top = src.was.style.top;
    setText(c.b, row.letters[k + g.fl] ?? '');
    setText(c.was, row.letters[k + g.fl + 1] ?? '');
    paintSlot(el, noteAt(g, row, k, m));
    g.layer.appendChild(el);
    row.ghosts.push(c);
  }
  function ensureGhosts(hand) {
    const g = geo[hand], m = committed[hand];
    // both sides at once when the pending value crosses back over committed mid-slide
    const back = Math.ceil(Math.max(0, u[hand], target[hand]) / g.pitch);
    const fwd = Math.ceil(Math.max(0, -u[hand], -target[hand]) / g.pitch);
    for (const row of g.rows) {
      for (let n = 1; n <= back; n++) addGhost(g, row, -n, m);
      for (let n = 1; n <= fwd; n++) addGhost(g, row, row.cells.length - 1 + n, m);
    }
  }
  function dropGhosts(hand) {
    const g = geo[hand]; if (!g) return;
    g.layer.textContent = '';
    for (const row of g.rows) { row.ghosts.length = 0; row.at.clear(); }
  }

  // a key thins only where it crosses the edge of its hand's window, in proportion to how much is outside;
  // interior keys stay at 1 and write nothing
  function fade(c, row, x) {
    const X = c.x + x;
    const out = Math.max(row.lo - X, X + c.w - row.hi, 0);
    const o = out >= c.w ? 0 : 1 - out / c.w;
    if (Math.abs(o - c.op) < 1 / 512) return;
    c.op = o;
    c.el.style.opacity = o === 1 ? '' : o.toFixed(3);
  }

  // One frame: two custom properties per hand plus a handful of opacities. Each key wears the letter of the
  // slot it stands over, dissolving between the two it lies between; the fraction is hand-wide, so it is a
  // property too, and the text only changes when the strip crosses a slot boundary.
  function frame(hand) {
    const g = geo[hand], x = u[hand];
    kbEl.style.setProperty(g.uvar, x.toFixed(2));
    const dl = x / g.pitch, fl = Math.floor(dl + 1e-6);
    kbEl.style.setProperty(g.fvar, smooth(Math.min(1, Math.max(0, dl - fl))).toFixed(4));
    if (fl !== g.fl) {
      g.fl = fl;
      for (const row of g.rows) for (const c of row.cells.concat(row.ghosts)) {
        setText(c.b, row.letters[c.k + fl] ?? '');
        setText(c.was, row.letters[c.k + fl + 1] ?? '');
      }
    }
    for (const row of g.rows) {
      for (const c of row.cells) fade(c, row, x);
      for (const c of row.ghosts) fade(c, row, x);
    }
  }

  function commit(hand) {
    committed[hand] = getInput().octave[hand];
    u[hand] = 0; target[hand] = 0;
    dropGhosts(hand);
    repaintHand(hand);
    frame(hand);
  }

  function tick(now) {
    rafId = 0;
    // clamped low too: a frame's timestamp can precede the performance.now() taken at kick, and a negative dt
    // flips the step and throws the strip the wrong way
    const dt = Math.max(0, (now - lastT) / 1000); lastT = now;
    const land = dt > DT_RESUME;                              // a backgrounded tab came back: just be there
    const step = 1 - Math.exp(-RATE * Math.min(dt, DT_MAX));  // frame-rate-independent first-order approach
    let busy = false;
    for (const hand of HANDS) {
      if (u[hand] === target[hand]) continue;
      u[hand] = land ? target[hand] : u[hand] + (target[hand] - u[hand]) * step;
      if (Math.abs(target[hand] - u[hand]) < EPS) { u[hand] = target[hand]; commit(hand); }
      else { busy = true; ensureGhosts(hand); frame(hand); }
    }
    cool = busy ? 2 : cool - 1;
    // .shifting lingers two frames past the last movement so the commit repaint happens while the dome's colour
    // transition is still suppressed; otherwise half the board cross-fades black/white at rest
    if (cool > 0) rafId = requestAnimationFrame(tick);
    else kbEl.classList.remove('shifting');
  }
  function kick() {
    cool = 2;
    if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(tick); }
  }

  // abandon any slide and be where the dial says, now: the DOM is about to be rebuilt, or nobody is watching
  function landNow(repaint = true) {
    fadeLand();     // the split's clones are .key elements inside #keyboard, so they ride .shifting too
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0; cool = 0;
    for (const hand of HANDS) {
      if (committed[hand] === null) continue;
      committed[hand] = getInput().octave[hand];
      u[hand] = 0; target[hand] = 0;
      if (geo[hand]) {
        dropGhosts(hand);
        if (repaint) repaintHand(hand);
        frame(hand);   // always: otherwise the offset properties keep a stale value into the next shift
      }
      dropGeo(hand);
    }
    kbEl.classList.remove('shifting');
  }

  function onOctaveChanged(hand) {
    if (committed[hand] === null) { committed[hand] = getInput().octave[hand]; return; } // the startup call
    const g = geo[hand] || (geo[hand] = buildGeo(hand));
    if (!g) return;
    const t = -g.sigma * (getInput().octave[hand] - committed[hand]) * g.pitch;
    if (t === target[hand]) return;   // the dial re-firing the same detent, or a drag held against an end stop
    // Land the split fade: .shifting matches every .key, the split's clones included, so they would slide
    // wearing a stale legend — and fade()'s inline opacity loses to a running animation.
    fadeLand();
    target[hand] = t;
    if (slowMo.matches) { u[hand] = t; commit(hand); return; }
    kbEl.classList.add('shifting');
    ensureGhosts(hand);
    frame(hand);
    kick();
  }
  slowMo.addEventListener('change', () => landNow());
  document.addEventListener('visibilitychange', () => { if (document.hidden) landNow(); });

  // ---- split-step cross-fade ----
  // One split step moves exactly one key per row (the .handstart margin hops), so that key changes hands and
  // nothing else moves. It does not travel: a clone left in place fades out while the rebuilt key fades in, so
  // the step reads as one key changing hands. prepareSplitFade runs before the rebuild, playSplitFade after.
  const FADE_MS = 130;
  let fadeLayer = null, fadeAnims = [], fadingIn = new Map(); // code → the fade-in running on that key

  // The keys that change hands between two splits: leftCounts moves every row's boundary by the same step, so
  // the movers on row r are the indices between the old count and the new one.
  function handChangers(a, b) {
    const ca = leftCounts(a), cb = leftCounts(b), out = [];
    ROWS.forEach((row, r) => {
      for (let i = Math.min(ca[r], cb[r]); i < Math.max(ca[r], cb[r]); i++) if (row[i]) out.push(row[i]);
    });
    return out;
  }
  // Clone the movers where they stand (offsetLeft/offsetTop: layout positions, immune to the slide transform).
  // cloneNode copies no running animation and the fade-in is off the inline style, so a key caught mid-fade
  // starts its corpse at the carried opacity instead of full.
  function fadeGhosts(codes, carry) {
    const ghosts = [];
    for (const code of codes) {
      const el = keyEls.get(code); if (!el) continue;
      const g = el.cloneNode(true);
      g.classList.remove('held');
      g.style.cssText = `position:absolute;left:${el.offsetLeft}px;top:${el.offsetTop}px;margin:0`;
      ghosts.push({ el: g, op: carry.get(code) ?? 1 });
    }
    return ghosts;
  }
  // A key still fading in when the next step lands (a drag steps faster than one fade) resumes from where it
  // had got to instead of popping to full. Read before the rebuild destroys the elements.
  function fadeCarry() {
    const carry = new Map();
    for (const code of fadingIn.keys()) {
      const el = keyEls.get(code);
      if (el) carry.set(code, parseFloat(getComputedStyle(el).opacity));
    }
    return carry;
  }
  // Land the cross-fade this instant. cancel(), not finish(): a cancelled animation drops its element straight
  // back to the stylesheet's opacity, which is exactly where a landed fade-in belongs.
  function fadeLand() {
    for (const a of fadeAnims) a.cancel();
    fadeAnims = []; fadingIn.clear();
    if (fadeLayer) { fadeLayer.remove(); fadeLayer = null; }
  }
  function prepareSplitFade(oldSplit, newSplit) {
    const codes = handChangers(oldSplit, newSplit); // exactly the keys that change hands
    const carry = fadeCarry();                      // how far keys from the last step had got
    const ghosts = fadeGhosts(codes, carry);        // cloned before render() tears them down
    return { codes, carry, ghosts };
  }
  // Web Animations, not a stylesheet transition: opacity stays off the inline style (so the next step's
  // cloneNode captures a clean key) and cancelling is a real land rather than a race with a retarget.
  function playSplitFade({ ghosts, codes, carry }) {
    if (slowMo.matches) return; // the step is the whole animation: no clones, nothing left part-way dim
    const layer = document.createElement('div');
    layer.className = 'key-ghosts'; // its own layer: dropGhosts/dropGeo only ever clear the octave strip's
    for (const g of ghosts) layer.appendChild(g.el);
    kbEl.prepend(layer);            // under the real keys; shows only on a multi-step jump where old and new overlap
    fadeLayer = layer;
    // duration scaled to the opacity left, so both sides cross at the same rate whatever they inherited;
    // fill:forwards or a ghost pops back to full for the frame between finishing and removal
    for (const { el, op } of ghosts)
      fadeAnims.push(el.animate({ opacity: [op, 0] }, { duration: FADE_MS * op, easing: 'ease', fill: 'forwards' }));
    for (const code of codes) if (!carry.has(code)) carry.set(code, 0); // this step's keys start from nothing
    for (const [code, from] of carry) {
      const el = keyEls.get(code); if (!el) continue;
      const a = el.animate({ opacity: [from, 1] }, { duration: FADE_MS * (1 - from), easing: 'ease' });
      fadingIn.set(code, a); fadeAnims.push(a);
    }
    if (!fadeAnims.length) { fadeLand(); return; } // nothing to animate; do not strand the empty layer
    // Wait for all of them: a carried key can finish much sooner than the clones' full fade and would tear them
    // down early. A re-step has already called fadeLand and cancelling rejects, so the rejection is ignored and
    // the guard is the layer's identity.
    Promise.all(fadeAnims.map((a) => a.finished)).then(() => { if (fadeLayer === layer) fadeLand(); }, () => {});
  }

  return { keyEls, render, keyHeld, updateLabels, onOctaveChanged, prepareSplitFade, playSplitFade };
}
