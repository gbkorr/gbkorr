// Debug panel (?debug or F9): live sliders bound to TUNING paths. Values go straight into TUNING — the next
// note picks them up — and "copy values" logs + copies them as JSON to paste back into js/tuning.js.
import { TUNING } from '../tuning.js';
import { $ } from './util.js';

// [TUNING path under the family, label, min, max, step]; a param a family doesn't define is skipped for it
const DEBUG_PARAMS = [
  ['pitchDip', 'bend cents', -80, 0, 1], ['pitchTau', 'bend τ (s)', 0.01, 0.3, 0.005],
  ['bendTime', 'bend time (s)', 0.02, 1, 0.01], ['bendCurve', 'bend curve (1 = linear)', 0.5, 4, 0.1],
  ['bend.lowCents', 'low: extra cents', -80, 0, 1], ['bend.lowTime', 'low: extra time (s)', 0, 1, 0.01],
  ['bend.top', 'low: top (midi)', 24, 96, 1], ['bend.span', 'low: span (semis)', 1, 60, 1],
  ['bend.silentMul', 'silent ×', 0.5, 4, 0.1], ['attackPeriods', 'attack ≥ periods', 0, 12, 0.5],
  ['release', 'release (s)', 0.02, 0.6, 0.01], ['fadeRelease', 'pedal fade, Space (s)', 0.3, 8, 0.1],
  ['openStartHarm', 'open: start harmonic (0 = off)', 0, 16, 0.5], ['openTimeLow', 'open: time (s)', 0.05, 1, 0.01],
  ['onset.fundDb', 'late fundamental (dB)', -30, 0, 1], ['onset.fundTime', 'late fundamental time (s)', 0.02, 0.5, 0.01],
  ['onset.midDb', 'mid bump (dB)', 0, 15, 0.5], ['onset.midHarm', 'mid bump harmonic (reload)', 2, 10, 0.5], ['onset.midTime', 'mid bump time (s)', 0.05, 1, 0.01],
  ['timbre.topDb', 'timbre: top shelf (dB)', -24, 12, 0.5], ['timbre.topHz', 'timbre: shelf from (Hz)', 300, 4000, 50],
  ['timbre.midDb', 'timbre: midrange (dB)', -18, 12, 0.5], ['timbre.midHz', 'timbre: mid centre (Hz)', 300, 4000, 50], ['timbre.midQ', 'timbre: mid width (Q)', 0.5, 6, 0.1],
  ['timbre.h1Db', 'timbre: fundamental (dB)', -12, 18, 0.5], ['timbre.lowWeighted', 'timbre: low reeds only (1) / all (0)', 0, 1, 1],
];
const getPath = (path) => path.split('.').reduce((o, k) => o?.[k], TUNING);
const setPath = (path, v) => { const ks = path.split('.'), o = ks.slice(0, -1).reduce((o, k) => o[k], TUNING); o[ks.at(-1)] = v; };

export function initDebug() {
  const debugEl = $('debug'), debugDefaults = {};

  function buildDebug() {
    const box = $('debugSliders'); box.innerHTML = '';
    const cols = ['melody', 'bass'].map((fam) => DEBUG_PARAMS.flatMap(([sub, label, min, max, step]) => {
      const path = `${fam}.${sub}`;
      if (getPath(path) === undefined) return []; // the family doesn't define this param
      debugDefaults[path] ??= getPath(path);
      const l = document.createElement('label');
      l.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
      const inp = l.querySelector('input'), out = l.querySelector('output');
      inp.value = getPath(path); out.value = String(getPath(path));
      inp.addEventListener('input', () => { setPath(path, parseFloat(inp.value)); out.value = inp.value; });
      l.dataset.path = path;
      return l;
    }));
    for (const fam of ['melody', 'bass']) { const h = document.createElement('h4'); h.textContent = fam; box.appendChild(h); }
    // two-column grid, melody left, bass right; blank cells fill the shorter column
    for (let i = 0; i < Math.max(cols[0].length, cols[1].length); i++)
      for (const col of cols) box.appendChild(col[i] ?? document.createElement('div'));
  }
  function debugValues() { const o = {}; for (const l of debugEl.querySelectorAll('label')) o[l.dataset.path] = getPath(l.dataset.path); return o; }
  function toggleDebug(show = debugEl.hidden) {
    debugEl.hidden = !show;
    if (show && !debugEl.dataset.built) { buildDebug(); debugEl.dataset.built = '1'; }
  }
  $('debugClose').addEventListener('click', () => toggleDebug(false));
  $('debugReset').addEventListener('click', () => { for (const [p, v] of Object.entries(debugDefaults)) setPath(p, v); buildDebug(); });
  $('debugCopy').addEventListener('click', () => {
    const json = JSON.stringify(debugValues(), null, 1); console.log(json);
    navigator.clipboard?.writeText(json).catch(() => {});
  });
  window.addEventListener('keydown', (e) => { if (e.code === 'F9') { toggleDebug(); e.preventDefault(); } });
  if (new URLSearchParams(location.search).has('debug')) toggleDebug(true);
}
