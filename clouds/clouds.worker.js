/* Render thread: owns the wasm module and paces frames; the page only
 * paints. Messages in: {cmd:'init', cfg, cols, rows} | {cmd:'resize', cols, rows}
 * | {cmd:'pause'} | {cmd:'resume'}. Out: {cmd:'frame', cols, rows, blocks,
 * glyph, fg, bg} with the typed arrays transferred. */
importScripts('clouds.js');

let M, fps = 20, cols = 0, rows = 0, blocks = 1, running = false, timer = null;
let t0 = 0, next = 0, paused = false;
const set = (k, v) => M.ccall('clouds_set', null, ['string', 'number'], [k, v]);

function frame() {
  timer = null;
  if (paused) return;
  const now = performance.now();
  M._clouds_frame((now - t0) / 1000);
  const n = cols * rows;
  const H = M.HEAPU8;
  const gp = M._clouds_glyphs(), fp = M._clouds_fg(), bp = M._clouds_bg();
  const glyph = H.slice(gp, gp + n), fg = H.slice(fp, fp + 3 * n), bg = H.slice(bp, bp + 3 * n);
  postMessage({ cmd: 'frame', cols, rows, blocks, glyph, fg, bg },
              [glyph.buffer, fg.buffer, bg.buffer]);
  const period = 1000 / fps;
  next += period;
  let wait = next - performance.now();
  if (wait < 0) { next = performance.now(); wait = 0; } /* fell behind: don't catch up */
  timer = setTimeout(frame, wait);
}

onmessage = async (e) => {
  const m = e.data;
  if (m.cmd === 'init') {
    M = await createClouds();
    const c = m.cfg;
    cols = m.cols; rows = m.rows; fps = c.fps;
    blocks = M.ccall('clouds_init', 'number',
      ['number', 'number', 'number', 'number', 'string', 'number', 'number'],
      [cols, rows, c.ascii ? 0 : 1, c.mono ? 1 : 0, c.ramp, c.quality, c.seed]) && !c.ascii && !c.mono;
    for (const [k, v] of Object.entries(c.scene)) set(k, v);
    t0 = performance.now(); next = t0;
    frame();
  } else if (m.cmd === 'resize' && M) {
    cols = m.cols; rows = m.rows;
    M._clouds_resize(cols, rows);
  } else if (m.cmd === 'pause') {
    paused = true; if (timer) { clearTimeout(timer); timer = null; }
  } else if (m.cmd === 'resume' && M && paused) {
    paused = false; next = performance.now(); frame();
  }
};
