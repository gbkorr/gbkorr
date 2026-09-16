// Key → note tables. Everything keyed by KeyboardEvent.code (physical key).
//
// Both hands use the same B-system lattice on the keyboard: note = base + 3*column + rowOffset,
// so every row is a minor-third cycle and a chromatic run walks down-right one row at a time.
//
// Left hand (chords.png rotated so its left edge is the top of the keyboard): 4 rows, high notes on the LEFT:
//   note = BASS_TOP - 3*column - row (number row -0, Q -1, A -2, Z -3 = the next number-row key, the duplicated 4th row).
// Right hand (pattern.png): 4 rows, note = MELODY_BASE + 3*column + row, rows number/Q/A/Z = -1/0/+1/+2,
//   so the number row duplicates the Z row one key to the left (6 = B, 7 = N, ...).
// A split index decides ownership: keys left of the split (following the physical stagger) are bass.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

export const KEY_LABEL = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/',
};
export const keyLabel = (code) => KEY_LABEL[code] || code.replace(/^(Key|Digit)/, '');

export const ROWS = [
  ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'],
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'],
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
];
// Physical x offset of each row's first key, in key units (real keyboard stagger).
export const ROW_STAGGER = [0, 0.5, 0.75, 1.25];

export const DEFAULT_SPLIT = 5;      // Q-row index of the first right-hand key (Y)
export const SPLIT_MIN = 2, SPLIT_MAX = 9;
const BASS_TOP = 71;    // B4 on Digit1 at octave 0; the left hand starts an octave down at −1 (input.js), so
                        // Digit1 sounds B3 by default (A#2 (T) .. B3 at split 5)
const MELODY_BASE = 51; // so that with split 5: Y = F#4, G = E4, V = D4 (pattern.png)

/** Number of left-hand keys per row for a split: 1-6 / Q-T / A-F / Z-C at split 5 (6/5/4/3).
 *  The right hand takes the rest of each row (7.., Y.., G.., V..). */
export function leftCounts(split) { return [split + 1, split, split - 1, split - 2]; }

export function buildLayout(split = DEFAULT_SPLIT) {
  const map = new Map();
  const counts = leftCounts(split);
  ROWS.forEach((row, r) => row.forEach((code, i) => {
    if (i < counts[r]) map.set(code, { hand: 'left', kind: 'bass', notes: [BASS_TOP - 3 * i - r] });
    else map.set(code, { hand: 'right', kind: 'melody', notes: [MELODY_BASE + 3 * i + (r - 1)] });
  }));
  return map;
}

export function leftRows(split) { const c = leftCounts(split); return ROWS.map((row, r) => row.slice(0, c[r])); }
export function rightRows(split) { const c = leftCounts(split); return ROWS.map((row, r) => row.slice(c[r])); }
