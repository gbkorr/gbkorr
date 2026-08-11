// Rendering, adaptive run loop, and UI wiring for the TGM test canvas.
'use strict';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

// Presets set every control — sliders, seed, speed, draw mode — so a preset
// run is fully deterministic. Each entry lists only its deltas from the base.
const PRESET_BASE = {
  linkRange: 0.18, mobility: 0.04, contraction: 1, cohesion: 0,
  branching: 1, genesis: 0, bounds: 6, rngSeed: 1,
  speed: 300, drawMode: 'links',
  thickS: 0.002, thickMin: 1, thickMax: 12,
};
const PRESETS = {
  dendritic: { mobility: 2 },
  porous: { cohesion: 0.4, mobility: 0.1 },
  filamentous: { branching: 0.05, speed: 1000 },
  roots: { drawMode: 'weighted', thickS: 0.005, thickMin: 0.5, thickMax: 12, genesis: 10 ** -5 },
};

let model = null;
let running = true;

// --- adaptive pacing state ---
// Each frame we run as many timesteps as fit in FRAME_BUDGET_MS, using an
// exponential moving average of measured step cost so one slow step never
// blows the frame. This is what adapts the simulation to the machine's speed.
const FRAME_BUDGET_MS = 7;
let emaStepMs = 0.05;
let allowance = 0; // steps banked by the steps/sec cap
let lastFrameTime = performance.now();
let stepsSinceMeasure = 0, measureElapsed = 0, measuredSps = 0;

// Adaptive draw rate, triangle mode only: filling tens of thousands of shaded
// triangles is expensive, so triangle draws render less often instead of
// slowing the simulation — the cost is amortized to at most RENDER_BUDGET_MS
// per frame — and are skipped entirely while nothing visible has changed
// (paused / finished). The other modes draw every frame as usual.
const RENDER_BUDGET_MS = 5;
let emaRenderMs = 0;
let framesSinceRender = 0;
let lastRenderSig = '';
let modelGen = 0; // bumped on restart so a fresh run always redraws

// Parameter ranges from Table 1 of the paper (bounds range per author).
// logMin: slider uses a log scale from logMin to max, with the far-left position
// mapping to exactly 0. squared: slider position is squared, concentrating
// travel on small values. expo: the value is 10^e with the exponent e swept in
// steps of 0.1 between expo.min and expo.max, far-left mapping to exactly 0
// (the slider element's own min/max in the HTML span these positions).
const PARAM_RANGES = {
  linkRange: { min: 0.1, max: 0.25 },
  contraction: { min: 0.5, max: 8 },
  mobility: { min: 0.04, max: 4 },
  cohesion: { min: 0, max: 0.6 },
  branching: { min: 0, max: 1, squared: true },
  genesis: { min: 0, max: 1e-2, expo: { min: -8, max: -2 } },
  bounds: { min: 1, max: 16, step: 1 },
  // Display-only (weighted-network thickness): applied live, not on restart.
  thickS: { min: 0, max: 0.1, logMin: 0.001 },
  thickMin: { min: 0.5, max: 4 },
  thickMax: { min: 1, max: 16 },
};
const PARAM_DEFAULTS = {
  linkRange: 0.18, contraction: 1, mobility: 0.04, cohesion: 0,
  branching: 1, genesis: 0, bounds: 8,
  thickS: 0.02, thickMin: 1, thickMax: 6,
};
const GROWTH_RATE = 0.05; // fixed, per Table 1
const SLIDER_MAX = 1000;

// Exponent rounded to one decimal — the resolution expo sliders step at.
function expOf(v) {
  return Math.round(Math.log10(v) * 10) / 10;
}

function clampParam(id, v) {
  const r = PARAM_RANGES[id];
  if (r.expo !== undefined) {
    if (v <= 0) return 0;
    return 10 ** Math.min(r.expo.max, Math.max(r.expo.min, expOf(v)));
  }
  v = Math.min(r.max, Math.max(r.min, v));
  if (r.step) v = Math.round(v / r.step) * r.step;
  return v;
}

function sliderToValue(id, pos) {
  const r = PARAM_RANGES[id];
  if (r.expo !== undefined) {
    return pos === 0 ? 0 : clampParam(id, 10 ** (r.expo.min + (pos - 1) / 10));
  }
  const t = pos / SLIDER_MAX;
  let v;
  if (r.logMin) {
    // exponent e sweeps 1 (-> logMin) down to 0 (-> max)
    const e = 1 - t;
    v = t === 0 ? r.min : r.max * (r.logMin / r.max) ** e;
  } else if (r.squared) {
    v = r.min + (r.max - r.min) * t * t;
  } else {
    v = r.min + (r.max - r.min) * t;
  }
  return clampParam(id, v);
}

function valueToSlider(id, v) {
  const r = PARAM_RANGES[id];
  if (r.expo !== undefined) {
    if (v <= 0) return 0;
    const maxPos = Math.round((r.expo.max - r.expo.min) * 10) + 1;
    return Math.min(maxPos, Math.max(1, Math.round((expOf(v) - r.expo.min) * 10) + 1));
  }
  let t;
  if (r.logMin) {
    if (v <= r.logMin) {
      t = 0;
    } else {
      const e = Math.min(1, Math.max(0, Math.log(v / r.max) / Math.log(r.logMin / r.max)));
      t = 1 - e;
    }
  } else if (r.squared) {
    t = Math.sqrt(Math.max(0, (v - r.min) / (r.max - r.min)));
  } else {
    t = (v - r.min) / (r.max - r.min);
  }
  return Math.round(Math.min(1, Math.max(0, t)) * SLIDER_MAX);
}

function fmt(id, v) {
  const r = PARAM_RANGES[id];
  if (r && r.expo !== undefined && v > 0) {
    const e = expOf(v);
    return e === 0 ? '1' : '1e' + e;
  }
  return String(parseFloat(v.toPrecision(2)));
}

// parseFloat truncates fractional exponents ("1e-6.5" -> 1e-6), so split manually.
function parseNum(s) {
  const m = /^\s*([-+]?[0-9.]+)e([-+]?[0-9.]+)\s*$/i.exec(s);
  return m ? parseFloat(m[1]) * 10 ** parseFloat(m[2]) : parseFloat(s);
}

// Set a parameter's box and slider together; snaps out-of-range values into
// range unless snap is false (presets may exceed the caps deliberately — the
// slider just pegs at its end while the box keeps the true value).
function setParam(id, v, snap = true) {
  if (!Number.isFinite(v)) v = PARAM_DEFAULTS[id];
  else if (snap) v = clampParam(id, v);
  $(id).value = fmt(id, v);
  $(id + 'Slider').value = valueToSlider(id, v);
}

// Reads boxes as-is: typed values were already snapped by the change handler,
// and preset-written values may intentionally exceed the slider ranges.
function readParams() {
  const val = (id) => {
    const v = parseNum($(id).value);
    return Number.isFinite(v) ? v : PARAM_DEFAULTS[id];
  };
  return {
    linkRange: val('linkRange'),
    contraction: val('contraction'),
    mobility: val('mobility'),
    cohesion: val('cohesion'),
    branching: val('branching'),
    genesis: val('genesis'),
    bounds: val('bounds'),
    growthRate: GROWTH_RATE,
    rngSeed: parseInt($('rngSeed').value, 10) || 1,
  };
}

function restart() {
  model = new TGM(readParams());
  window.model = model; // exposed for console poking (e.g. model.checkInvariants())
  modelGen++;
  emaRenderMs = 0; // a new run starts small; re-learn the draw cost from scratch
  framesSinceRender = 0;
  lastRenderSig = '';
  emaStepMs = 0.05;
  allowance = 0;
  running = true;
  $('pause').textContent = 'Pause';
}

// Discrete round-number speed caps; the slider's last position is unlimited.
const SPEED_STEPS = [3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300,
  500, 700, 1000, 1500, 2000, 3000, 5000, 7000, 10000];
function speedCap() {
  const v = parseInt($('speed').value, 10);
  if (v >= SPEED_STEPS.length) return Infinity;
  return SPEED_STEPS[v];
}

function updateSpeedLabel() {
  const cap = speedCap();
  $('speedLabel').textContent = Number.isFinite(cap) ? String(cap) : 'unlimited';
}

// --- main loop ---
function frame(now) {
  const dt = Math.min(0.25, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  if (running && model && !model.done) {
    const cap = speedCap();
    if (Number.isFinite(cap)) {
      allowance = Math.min(allowance + cap * dt, Math.max(1, cap * 0.25));
    }
    const t0 = performance.now();
    while (performance.now() - t0 + emaStepMs < FRAME_BUDGET_MS) {
      if (Number.isFinite(cap)) {
        if (allowance < 1) break;
        allowance -= 1;
      }
      const s0 = performance.now();
      model.step();
      emaStepMs = emaStepMs * 0.9 + (performance.now() - s0) * 0.1;
      stepsSinceMeasure++;
      if (model.done) break;
    }
  }

  measureElapsed += dt;
  if (measureElapsed >= 0.5) {
    measuredSps = Math.round(stepsSinceMeasure / measureElapsed);
    stepsSinceMeasure = 0;
    measureElapsed = 0;
  }

  framesSinceRender++;
  if ($('drawMode').value === 'triangles') {
    // Redraw only when something visible changed, at most once per
    // ceil(emaRenderMs / RENDER_BUDGET_MS) frames — the counter keeps running
    // through skips, so a change after a quiet stretch redraws immediately.
    const sig = `${modelGen},${model.timestep},${$('showFree').checked},${canvas.width}`;
    if (sig !== lastRenderSig && framesSinceRender >= Math.ceil(emaRenderMs / RENDER_BUDGET_MS)) {
      const r0 = performance.now();
      render();
      emaRenderMs = emaRenderMs * 0.8 + (performance.now() - r0) * 0.2;
      framesSinceRender = 0;
      lastRenderSig = sig;
    }
  } else {
    render();
    lastRenderSig = ''; // so switching back to triangle mode redraws at once
  }
  updateStats();
  requestAnimationFrame(frame);
}

// --- rendering ---
function fitCanvas() {
  const stage = document.getElementById('stage');
  const size = Math.max(100, Math.min(stage.clientWidth, stage.clientHeight) - 24);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
}

function render() {
  if (!model) return;
  const { posX, posY, linked, N } = model;
  const scale = canvas.width / model.params.bounds;
  const base = Math.max(1, canvas.width / 1200);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if ($('showFree').checked) {
    ctx.fillStyle = '#c8c8c8';
    ctx.beginPath();
    const r = Math.max(1, canvas.width / 900);
    for (let i = 0; i < N; i++) {
      if (linked[i]) continue;
      ctx.rect(posX[i] * scale - r / 2, posY[i] * scale - r / 2, r, r);
    }
    ctx.fill();
  }

  const mode = $('drawMode').value;
  if (mode === 'links') drawLinks(scale, base);
  else if (mode === 'triangles') drawTriangles(scale);
  else drawNetwork(scale, base, mode === 'weighted');
}

function drawLinks(scale, base) {
  const { posX, posY, linkA, linkB } = model;
  ctx.strokeStyle = '#111';
  ctx.lineWidth = base;
  ctx.beginPath();
  for (let i = 0; i < linkA.length; i++) {
    ctx.moveTo(posX[linkA[i]] * scale, posY[linkA[i]] * scale);
    ctx.lineTo(posX[linkB[i]] * scale, posY[linkB[i]] * scale);
  }
  ctx.stroke();
}

function drawTriangles(scale) {
  const { posX, posY, triA, triB, triC } = model;
  ctx.fillStyle = '#111';
  ctx.beginPath();
  for (let i = 0; i < triA.length; i++) {
    const ax = posX[triA[i]] * scale, ay = posY[triA[i]] * scale;
    let bx = posX[triB[i]] * scale, by = posY[triB[i]] * scale;
    let cx = posX[triC[i]] * scale, cy = posY[triC[i]] * scale;
    // Consistent winding: under the nonzero fill rule, overlapping subpaths
    // wound in opposite directions cancel and punch white holes wherever the
    // structure folds over itself. Orienting every triangle the same way makes
    // overlaps accumulate winding instead, so the fill is a true union.
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) {
      const tx = bx, ty = by;
      bx = cx; by = cy; cx = tx; cy = ty;
    }
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(cx, cy);
    ctx.closePath();
  }
  ctx.fill();
}

// Link network: each link is a node at its midpoint, with an edge to the link
// it grew from. Weighted mode strokes edges by the child link's descendant
// count: w = max - (max-min)*(1+s)^(-d), quantized into buckets since canvas
// can't vary lineWidth within one path.
const WEIGHT_BUCKETS = 16;
function drawNetwork(scale, base, weighted) {
  const { posX, posY, linkA, linkB, linkParent } = model;
  const L = linkA.length;
  const midX = new Float32Array(L);
  const midY = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    midX[i] = (posX[linkA[i]] + posX[linkB[i]]) / 2 * scale;
    midY[i] = (posY[linkA[i]] + posY[linkB[i]]) / 2 * scale;
  }

  ctx.strokeStyle = '#111';
  if (!weighted) {
    ctx.lineWidth = base;
    ctx.beginPath();
    for (let i = 0; i < L; i++) {
      if (linkParent[i] < 0) continue;
      ctx.moveTo(midX[i], midY[i]);
      ctx.lineTo(midX[linkParent[i]], midY[linkParent[i]]);
    }
    ctx.stroke();
  } else {
    const val = (id) => {
      const v = parseFloat($(id).value);
      return Number.isFinite(v) ? v : PARAM_DEFAULTS[id];
    };
    const s = val('thickS');
    const minW = val('thickMin');
    const maxW = Math.max(minW, val('thickMax'));
    const desc = model.descendants();
    const span = maxW - minW;
    const decay = 1 + s;
    const buckets = Array.from({ length: WEIGHT_BUCKETS }, () => []);
    for (let i = 0; i < L; i++) {
      if (linkParent[i] < 0) continue;
      const w = maxW - span * decay ** -desc[i];
      const k = span > 0 ? Math.min(WEIGHT_BUCKETS - 1, Math.round((w - minW) / span * (WEIGHT_BUCKETS - 1))) : 0;
      buckets[k].push(midX[i], midY[i], midX[linkParent[i]], midY[linkParent[i]]);
    }
    ctx.lineCap = 'round'; // thick butt-capped segments read as choppy rectangles
    for (let k = 0; k < WEIGHT_BUCKETS; k++) {
      const seg = buckets[k];
      if (!seg.length) continue;
      ctx.lineWidth = base * (minW + span * k / (WEIGHT_BUCKETS - 1));
      ctx.beginPath();
      for (let j = 0; j < seg.length; j += 4) {
        ctx.moveTo(seg[j], seg[j + 1]);
        ctx.lineTo(seg[j + 2], seg[j + 3]);
      }
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  // Parentless nodes (seed and genesis roots) get a dot so an isolated new
  // structure is still visible before it has children.
  ctx.fillStyle = '#111';
  ctx.beginPath();
  const r = Math.max(2, base * 2);
  for (let i = 0; i < L; i++) {
    if (linkParent[i] >= 0) continue;
    ctx.rect(midX[i] - r / 2, midY[i] - r / 2, r, r);
  }
  ctx.fill();
}

function updateStats() {
  if (!model) return;
  const status = model.done ? 'done' : (running ? 'growing' : 'paused');
  $('stats').textContent =
    `status      ${status}\n` +
    `timestep    ${model.timestep}\n` +
    `particles   ${model.N}\n` +
    `links       ${model.linkA.length}\n` +
    `active      ${model.activeLinkCount}\n` +
    `mobile      ${model.mobileList.length}\n` +
    `unlinked    ${model.unlinkedCount}\n` +
    `steps/sec   ${measuredSps}\n` +
    `step cost   ${emaStepMs.toFixed(3)} ms\n` +
    `draw cost   ${emaRenderMs.toFixed(1)} ms`;
}

// --- UI wiring ---
$('restart').addEventListener('click', restart);
$('pause').addEventListener('click', () => {
  running = !running;
  $('pause').textContent = running ? 'Pause' : 'Resume';
});
$('speed').addEventListener('input', () => { allowance = 0; updateSpeedLabel(); });
const syncThicknessControls = () => {
  $('thicknessControls').hidden = $('drawMode').value !== 'weighted';
};
$('drawMode').addEventListener('change', syncThicknessControls);
for (const id of Object.keys(PARAM_RANGES)) {
  $(id + 'Slider').addEventListener('input', () => {
    $(id).value = fmt(id, sliderToValue(id, parseInt($(id + 'Slider').value, 10)));
  });
  $(id).addEventListener('change', () => setParam(id, parseNum($(id).value)));
}
// Keep min weight <= max weight: moving one past the other pushes it along.
const syncThickPair = (changed) => {
  const minV = parseFloat($('thickMin').value);
  const maxV = parseFloat($('thickMax').value);
  if (!(minV > maxV)) return;
  if (changed === 'thickMin') setParam('thickMax', minV);
  else setParam('thickMin', maxV);
};
for (const id of ['thickMin', 'thickMax']) {
  $(id + 'Slider').addEventListener('input', () => syncThickPair(id));
  $(id).addEventListener('change', () => syncThickPair(id));
}
// About popup: content lives in about.txt next to the page. Note fetch of a
// local file is blocked on file:// in most browsers — needs an HTTP server.
let aboutLoaded = false;
$('aboutBtn').addEventListener('click', async () => {
  $('aboutOverlay').hidden = false;
  if (aboutLoaded) return;
  try {
    const res = await fetch('about.txt');
    if (!res.ok) throw new Error(res.status);
    $('aboutText').textContent = await res.text();
    aboutLoaded = true;
  } catch {
    $('aboutText').textContent = 'Could not load about.txt (this page needs to be served over HTTP).';
  }
});
$('aboutClose').addEventListener('click', () => { $('aboutOverlay').hidden = true; });
$('aboutOverlay').addEventListener('click', (e) => {
  if (e.target === $('aboutOverlay')) $('aboutOverlay').hidden = true;
});
$('randomSeed').addEventListener('click', () => {
  $('rngSeed').value = String(1 + Math.floor(Math.random() * 9999));
});
function applyPreset(overrides) {
  const p = { ...PRESET_BASE, ...overrides };
  for (const id of Object.keys(PARAM_RANGES)) setParam(id, p[id]);
  $('rngSeed').value = String(p.rngSeed);
  $('speed').value = String(SPEED_STEPS.indexOf(p.speed));
  $('drawMode').value = p.drawMode;
  syncThicknessControls();
  updateSpeedLabel();
  restart();
}
for (const [name, preset] of Object.entries(PRESETS)) {
  $('preset' + name[0].toUpperCase() + name.slice(1)).addEventListener('click', () => applyPreset(preset));
}
window.addEventListener('resize', () => {
  fitCanvas(); // assigning canvas.width blanks the bitmap, so force a redraw
  lastRenderSig = '';
});

fitCanvas();
// A reload always starts as a deterministic Dendritic run, overriding any
// control values the browser restored from the previous visit.
applyPreset(PRESETS.dendritic);
requestAnimationFrame(frame);
