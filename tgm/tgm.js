// Triangular Growth Model (TGM) — core simulation.
// Pure computation, no DOM/canvas: keeps the model portable to a Web Worker later.
// Follows section 4.1 of the paper. Neighbor adjacency is symmetric (derived from
// links, no duplicates), per the written definition.
'use strict';

// Small seedable PRNG so runs are reproducible while debugging.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class TGM {
  constructor(params) {
    const p = Object.assign({
      linkRange: 0.18,
      contraction: 1,
      mobility: 2,
      cohesion: 0,      // capped at 1: weighted distance only makes linked particles appear further
      bounds: 3,
      growthRate: 0.05,
      density: 200,
      seedPos: [0.5, 0.5], // as a fraction of bounds
      rngSeed: 1,
      branching: 1, // probability a new triangle lets BOTH new links grow (else one at random)
      genesis: 0,   // probability per unlinked particle per timestep of spontaneously linking
    }, params);
    p.cohesion = Math.min(1, Math.max(0, p.cohesion));
    p.branching = Math.min(1, Math.max(0, p.branching));
    p.genesis = Math.min(1, Math.max(0, p.genesis));
    this.params = p;
    this.rand = mulberry32(p.rngSeed);

    const bounds = p.bounds;
    const n = Math.round(p.density * bounds * bounds);
    const N = this.N = n + 1; // +1 for the seed particle at index 0

    this.posX = new Float32Array(N);
    this.posY = new Float32Array(N);
    this.linked = new Uint8Array(N);
    this.unlinkedCount = N;
    // Genesis attempts that provably can never succeed (see genesisPhase).
    this.genesisIneligible = new Uint8Array(N);
    this.ineligibleCount = 0;
    this.timer = new Float32Array(N);   // remaining mobile timesteps
    this.neighbors = new Array(N);      // per-particle array of linked particle indices

    this.posX[0] = p.seedPos[0] * bounds;
    this.posY[0] = p.seedPos[1] * bounds;
    for (let i = 1; i < N; i++) {
      this.posX[i] = this.rand() * bounds;
      this.posY[i] = this.rand() * bounds;
    }

    // Links as parallel arrays of particle indices.
    this.linkA = [];
    this.linkB = [];
    this.linkActive = [];
    this.linkParent = []; // index of the link this one grew from (-1 for seed/genesis roots)
    this.activeLinkCount = 0;
    this.linkSet = new Set(); // pair keys, so an existing link is never duplicated

    // Triangles as parallel arrays of particle indices, recorded at growth.
    this.triA = [];
    this.triB = [];
    this.triC = [];

    this._descCache = null; // descendant counts, memoized by link count
    this._descCacheLen = -1;

    this.mobileList = [];     // indices of currently mobile particles
    this.scratchX = [];       // proposed positions, applied simultaneously
    this.scratchY = [];

    this.timestep = 0;
    this.done = false;

    // Spatial grid: built once at initialization. Cohesion ≤ 1 means the true
    // search radius never exceeds linkRange, and contraction rarely moves a
    // particle across a cell boundary, so the grid is never rebuilt.
    this.buildGrid();

    // Seed link: connect the seed particle to its nearest particle.
    let bestD2 = Infinity, bestI = -1;
    for (let i = 1; i < N; i++) {
      const dx = this.posX[i] - this.posX[0];
      const dy = this.posY[i] - this.posY[0];
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestI = i; }
    }
    this.addLink(0, bestI);
    this.makeLinked(0);
    this.makeLinked(bestI);
  }

  buildGrid() {
    const { bounds, linkRange } = this.params;
    const N = this.N;
    const cell = this.cellSize = linkRange;
    const W = this.gridW = Math.max(1, Math.ceil(bounds / cell));
    const cells = W * W;
    const start = this.cellStart = new Int32Array(cells + 1);
    const entries = this.cellEntries = new Int32Array(N);
    const idx = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const gx = Math.min(W - 1, Math.max(0, Math.floor(this.posX[i] / cell)));
      const gy = Math.min(W - 1, Math.max(0, Math.floor(this.posY[i] / cell)));
      idx[i] = gy * W + gx;
      start[idx[i] + 1]++;
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const cursor = start.slice(0, cells);
    for (let i = 0; i < N; i++) entries[cursor[idx[i]]++] = i;
  }

  // Returns the new link's index, or -1 if the pair already existed
  // (an existing link is never duplicated).
  addLink(a, b, parent = -1) {
    const key = Math.min(a, b) * this.N + Math.max(a, b);
    if (this.linkSet.has(key)) return -1;
    this.linkSet.add(key);
    this.linkA.push(a);
    this.linkB.push(b);
    this.linkActive.push(1);
    this.linkParent.push(parent);
    this.activeLinkCount++;
    (this.neighbors[a] || (this.neighbors[a] = [])).push(b);
    (this.neighbors[b] || (this.neighbors[b] = [])).push(a);
    return this.linkA.length - 1;
  }

  makeLinked(i) {
    if (this.linked[i]) return;
    this.linked[i] = 1;
    this.unlinkedCount--;
    if (this.genesisIneligible[i]) {
      this.genesisIneligible[i] = 0;
      this.ineligibleCount--;
    }
    const { contraction, mobility, growthRate } = this.params;
    const t = contraction / (mobility * growthRate);
    if (Number.isFinite(t) && t > 0) {
      this.timer[i] = t;
      this.mobileList.push(i);
    }
  }

  // Find the valid particle with the least weighted distance to the link's midpoint.
  searchNearest(a, b) {
    const { linkRange, cohesion } = this.params;
    const mx = (this.posX[a] + this.posX[b]) / 2;
    const my = (this.posY[a] + this.posY[b]) / 2;
    const W = this.gridW, cell = this.cellSize;
    const cx = Math.min(W - 1, Math.max(0, Math.floor(mx / cell)));
    const cy = Math.min(W - 1, Math.max(0, Math.floor(my / cell)));
    const x0 = Math.max(0, cx - 1), x1 = Math.min(W - 1, cx + 1);
    const y0 = Math.max(0, cy - 1), y1 = Math.min(W - 1, cy + 1);

    let best = linkRange; // must be strictly within link_range
    let bestP = -1;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const c = gy * W + gx;
        const end = this.cellStart[c + 1];
        for (let k = this.cellStart[c]; k < end; k++) {
          const q = this.cellEntries[k];
          if (q === a || q === b) continue;
          const dx = this.posX[q] - mx;
          const dy = this.posY[q] - my;
          let w = Math.sqrt(dx * dx + dy * dy);
          if (this.linked[q]) {
            if (cohesion === 0) continue; // only unlinked particles are valid
            w /= cohesion;
          }
          if (w >= best) continue;
          const nb = this.neighbors[q]; // invalid if already linked to both endpoints
          if (nb && nb.includes(a) && nb.includes(b)) continue;
          best = w;
          bestP = q;
        }
      }
    }
    return bestP;
  }

  // Genesis: each unlinked particle spontaneously links with its nearest valid
  // particle with probability `genesis` at the beginning of the timestep.
  genesisPhase() {
    const g = this.params.genesis;
    if (g <= 0 || this.unlinkedCount - this.ineligibleCount === 0) return;
    const cohesionZero = this.params.cohesion === 0;
    // Geometric skips between successes, so the cost scales with the number of
    // firing particles rather than one random draw per unlinked particle.
    const logq = g < 1 ? Math.log(1 - g) : 0;
    let skip = g < 1 ? Math.floor(Math.log(1 - this.rand()) / logq) : 0;
    for (let i = 0; i < this.N; i++) {
      if (this.linked[i] || this.genesisIneligible[i]) continue;
      if (skip > 0) { skip--; continue; }
      const p = this.searchNearest(i, i); // midpoint of (i,i) is the particle itself
      if (p >= 0) {
        this.addLink(i, p);
        this.makeLinked(i);
        this.makeLinked(p);
      } else if (cohesionZero) {
        // With cohesion 0 the target must be an unlinked particle; unlinked
        // particles never move and the unlinked set only shrinks, so a failed
        // attempt can never succeed later. Retire this particle from genesis
        // (it can still be captured by a growing link).
        this.genesisIneligible[i] = 1;
        this.ineligibleCount++;
      }
      if (g < 1) skip = Math.floor(Math.log(1 - this.rand()) / logq);
    }
  }

  step() {
    if (this.done) return;
    this.timestep++;
    const { growthRate, branching, genesis } = this.params;

    this.genesisPhase();

    // Growth: links grow serially; links created this timestep become eligible
    // next timestep (genesis links, created at the beginning, are eligible now).
    const startCount = this.linkA.length;
    for (let i = 0; i < startCount; i++) {
      if (!this.linkActive[i]) continue;
      if (this.rand() >= growthRate) continue;
      this.linkActive[i] = 0; // deactivates whether or not it finds a valid particle
      this.activeLinkCount--;
      const a = this.linkA[i], b = this.linkB[i];
      const p = this.searchNearest(a, b);
      if (p >= 0) {
        const l1 = this.addLink(a, p, i);
        const l2 = this.addLink(b, p, i);
        this.makeLinked(p);
        this.triA.push(a);
        this.triB.push(b);
        this.triC.push(p);
        // Branching: with probability 1-branching, only one of the triangle's two
        // new links may grow. Applies only when both links are genuinely new — a
        // lone new link (the other already existed) can't fork and always grows.
        if (l1 >= 0 && l2 >= 0 && branching < 1 && this.rand() >= branching) {
          const drop = this.rand() < 0.5 ? l1 : l2;
          this.linkActive[drop] = 0;
          this.activeLinkCount--;
        }
      }
    }

    this.contract();
    // With genesis active, unlinked particles could still spawn new structures,
    // but rather than waiting out their ~1/genesis-step clocks (which reads as
    // ticking forever at small genesis), a quiet model — nothing active, nothing
    // mobile — simply terminates once it's past the 1k-step startup window.
    this.done = this.activeLinkCount === 0 && this.mobileList.length === 0 &&
      (genesis === 0 || this.timestep > 1000 ||
        this.unlinkedCount - this.ineligibleCount === 0);
  }

  // Move each mobile particle toward the centroid of its neighbors; applied simultaneously.
  contract() {
    const { mobility, growthRate } = this.params;
    const k = mobility * growthRate;
    const list = this.mobileList;
    const m = list.length;
    for (let j = 0; j < m; j++) {
      const i = list[j];
      const nb = this.neighbors[i];
      let cx = 0, cy = 0;
      for (let q = 0; q < nb.length; q++) {
        cx += this.posX[nb[q]];
        cy += this.posY[nb[q]];
      }
      cx /= nb.length;
      cy /= nb.length;
      this.scratchX[j] = this.posX[i] + (cx - this.posX[i]) * k;
      this.scratchY[j] = this.posY[i] + (cy - this.posY[i]) * k;
    }
    for (let j = 0; j < m; j++) {
      const i = list[j];
      this.posX[i] = this.scratchX[j];
      this.posY[i] = this.scratchY[j];
    }
    // Tick timers; swap-remove particles that are no longer mobile.
    for (let j = list.length - 1; j >= 0; j--) {
      const i = list[j];
      if (--this.timer[i] <= 0) {
        list[j] = list[list.length - 1];
        list.pop();
      }
    }
  }

  // Per-link descendant counts over the link network (a link's descendants are
  // the links that grew from it, transitively). A child link is always created
  // after its parent, so one reverse pass suffices; memoized by link count,
  // since counts only change when links are added.
  descendants() {
    const L = this.linkA.length;
    if (this._descCacheLen === L) return this._descCache;
    const parent = this.linkParent;
    const desc = new Int32Array(L);
    for (let i = L - 1; i > 0; i--) {
      if (parent[i] >= 0) desc[parent[i]] += desc[i] + 1;
    }
    this._descCache = desc;
    this._descCacheLen = L;
    return desc;
  }

  // Console sanity checks (not called during normal runs).
  checkInvariants() {
    const issues = [];
    if (this.linkSet.size !== this.linkA.length) issues.push('duplicate links present');
    for (let i = 0; i < this.N; i++) {
      const nb = this.neighbors[i];
      if (!nb) continue;
      if (new Set(nb).size !== nb.length) issues.push(`particle ${i} has duplicate neighbors`);
      for (const q of nb) {
        if (!this.neighbors[q] || !this.neighbors[q].includes(i)) issues.push(`asymmetric adjacency ${i}<->${q}`);
      }
    }
    return issues.length ? issues : 'ok';
  }
}
