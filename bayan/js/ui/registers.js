// Register switch banks: the manual rank toggles and the automatic presets. Both drive engine.manual — a preset
// writes the toggles, and a preset lights when the toggles equal it — so the banks can never disagree.
import { RANKS, RANK_ORDER, PRESETS } from '../reed.js';
import { $ } from './util.js';

// The icon is the Italian reed-rank symbol (icons/*.svg): a circle split into 4'/8'/16' bands, a filled dot per
// active reed. Hardcoded so it can recolour; 8c takes the centre-left slot the icon set leaves empty for a
// second 8-foot rank. A rank missing from DOT throws at module load.
const DOT = { '4': [28.4, 8.9], '8': [28.4, 28.6], '8c': [9.2, 28.6], '16': [28.4, 48.7], '+5': [42, 17.2] };
function regIcon(reeds) {
  const dots = reeds.map((k) => `<circle cx="${DOT[k][0]}" cy="${DOT[k][1]}" r="6.1" fill="currentColor" stroke="none"/>`).join('');
  return `<svg viewBox="0 0 57.2 57.2" class="reg-icon" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7">
    <circle cx="28.6" cy="28.6" r="28.1"/>
    <line x1="2.5" y1="17.2" x2="54.5" y2="17.2"/><line x1="3.7" y1="40.5" x2="53.7" y2="40.5"/>${dots}
  </svg>`;
}
// keybind glyph shown on each switch (hold Shift or Enter + this key — see input.js)
const RANK_KEY = { '+5': 'J', '4': 'K', '8': 'L', '8c': ':', '16': '"' };
const RANK_LABEL = { '4': '4′', '8': '8′', '8c': '8c', '16': '16′', '+5': '+5' }; // prime only on the plain feet
const PRESET_KEY = { base: 'U', main: 'I', clarion: 'O', organ: 'P', master: '{', chime: '}', wave: '|' };
// display order (= the U I O P { } | key order); the last two are the fifth-flavoured pair, set a little apart
const PRESET_ORDER = ['base', 'main', 'clarion', 'organ', 'master', 'chime', 'wave'];

export function createRegisters({ engine, onChange }) {
  const manualBank = $('regManual'), presetBank = $('regPreset');

  function makeSwitch(label, keyGlyph, reeds) {
    const b = document.createElement('button');
    b.className = 'reg-switch';
    b.innerHTML = `<span class="reg-key">${keyGlyph}</span>` + regIcon(reeds) + `<span class="reg-label">${label}</span>`;
    return b;
  }
  for (const rank of RANK_ORDER) {
    const b = makeSwitch(RANK_LABEL[rank], RANK_KEY[rank], [rank]);
    b.dataset.rank = rank;
    b.addEventListener('click', () => { engine.toggleRank(rank); render(); });
    manualBank.appendChild(b);
  }
  for (const name of PRESET_ORDER) {
    const b = makeSwitch(name, PRESET_KEY[name], PRESETS[name]);
    b.dataset.preset = name;
    b.addEventListener('click', () => { engine.setPreset(name); render(); });
    presetBank.appendChild(b);
  }

  // A switch worked from the keyboard throws like a clicked one: .pressed runs the same movement CSS gives
  // :active. Restarting needs the class off and a reflow first, so a re-hit re-throws instead of sitting still.
  function flashSwitch(hit) {
    const b = hit.rank ? manualBank.querySelector(`[data-rank="${hit.rank}"]`)
                       : presetBank.querySelector(`[data-preset="${hit.preset}"]`);
    if (!b) return;
    b.classList.remove('pressed');
    void b.offsetWidth;
    b.classList.add('pressed');
  }
  for (const bank of [manualBank, presetBank])
    bank.addEventListener('animationend', (e) => e.target.classList.remove('pressed'));

  /** Repaint both banks from engine state; `hit` = {rank}|{preset} throws that switch (a hotkey press). */
  function render(hit) {
    for (const b of manualBank.children) b.classList.toggle('on', engine.manual.has(b.dataset.rank));
    for (const b of presetBank.children) b.classList.toggle('on', engine.preset === b.dataset.preset);
    onChange(); // held keys pick up the new reed set; key labels follow the register
    if (hit) flashSwitch(hit);
  }

  return { render };
}
