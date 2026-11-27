import type { ArcItem, IntervalItem, TrackMetadata } from '../types';

export const DEMO_CHROM = 'chrX';
export const DEMO_CHROM_LEN = 17_718_942;

// Canonical 17 C. elegans chrX TAD boundaries (bp)
export const DEMO_TAD_BOUNDS: [number, number, string][] = [
  [1, 3_085_000, 'TAD1'],
  [3_085_001, 4_035_000, 'TAD2'],
  [4_035_001, 5_055_000, 'TAD3'],
  [5_055_001, 6_305_000, 'TAD4'],
  [6_305_001, 7_085_000, 'TAD5'],
  [7_085_001, 8_165_000, 'TAD6'],
  [8_165_001, 9_565_000, 'TAD7'],
  [9_565_001, 10_525_000, 'TAD8'],
  [10_525_001, 11_355_000, 'TAD9'],
  [11_355_001, 12_255_000, 'TAD10'],
  [12_255_001, 13_025_000, 'TAD11'],
  [13_025_001, 13_895_000, 'TAD12'],
  [13_895_001, 14_585_000, 'TAD13'],
  [14_585_001, 15_395_000, 'TAD14'],
  [15_395_001, 16_155_000, 'TAD15'],
  [16_155_001, 16_965_000, 'TAD16'],
  [16_965_001, 17_718_942, 'TAD17'],
];

// Strong rex/loop anchor sites along chrX (bp)
const REX_ANCHORS = [
  1_210_000, 2_190_000, 3_085_000, 4_035_000, 4_391_000, 5_055_000, 6_305_000,
  7_085_000, 8_165_000, 9_565_000, 10_525_000, 11_355_000, 12_255_000,
  13_025_000, 13_895_000, 14_585_000, 15_395_000, 16_155_000, 16_965_000,
];

// Deterministic fast hash -> [0, 1)
function hash2(a: number, b: number, seed: number): number {
  let x = (a * 374761393 + b * 668265263 + seed * 2147483647) | 0;
  x = ((x ^ (x >>> 13)) * 1274126177) | 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function getTadIndex(bp: number): number {
  for (let i = 0; i < DEMO_TAD_BOUNDS.length; i++) {
    if (bp <= DEMO_TAD_BOUNDS[i][1]) return i;
  }
  return DEMO_TAD_BOUNDS.length - 1;
}

export function compartmentSignal(bp: number): number {
  // Smooth multi-scale A/B compartment profile along chrX
  const mb = bp / 1_000_000;
  return (
    0.95 * Math.sin(mb * 1.45 + 0.4) +
    0.55 * Math.cos(mb * 3.1 - 0.8) +
    0.35 * Math.sin(mb * 6.3 + 1.2)
  );
}

export function chipRexSignal(bp: number, scale = 1.0): number {
  let sum = 0.08 + 0.05 * Math.max(0, compartmentSignal(bp));
  for (const a of REX_ANCHORS) {
    const d = (bp - a) / 18_000;
    if (Math.abs(d) < 6) {
      sum += 4.2 * scale * Math.exp(-0.5 * d * d);
    }
  }
  // Smaller secondary peaks
  const sec = Math.sin(bp / 45_000) * Math.cos(bp / 19_000);
  if (sec > 0.72) sum += (sec - 0.72) * 3.5 * scale;
  return sum;
}

export const DEMO_CATALOG: {
  id: string;
  name: string;
  format: string;
  description: string;
  size: number;
}[] = [
  {
    id: 'demo://wt_hic',
    name: 'ce11_chrX_WT_demo.mcool',
    format: 'mcool',
    description: 'Wild-type C. elegans chrX Hi-C (TADs + rex loops)',
    size: 0,
  },
  {
    id: 'demo://ko_hic',
    name: 'ce11_chrX_CondensinDC_KO_demo.mcool',
    format: 'mcool',
    description: 'Condensin-DC depleted chrX Hi-C (for Split/Diff)',
    size: 0,
  },
  {
    id: 'demo://tads',
    name: 'chrX_17_TADs.bed',
    format: 'bed',
    description: '17 dosage-compensation TADs (2D overlay enabled)',
    size: 0,
  },
  {
    id: 'demo://chromstates',
    name: 'chromStates_ce11_rgb.bed',
    format: 'bed',
    description: 'Multi-color RGB chromatin states across chrX',
    size: 0,
  },
  {
    id: 'demo://eigenvector',
    name: 'chrX_cis_eigenvectors_2kb.tsv',
    format: 'tabular',
    description: 'A/B compartment E1 & dot-score E2 (multi-column TSV)',
    size: 0,
  },
  {
    id: 'demo://chip',
    name: 'DPY27_SDC3_ChIP_ce11_2kb.tsv',
    format: 'tabular',
    description: 'DPY-27 & SDC-3 ChIP-seq signal tracks (multi-column TSV)',
    size: 0,
  },
  {
    id: 'demo://loops',
    name: 'chrX_rex_loops.bedpe',
    format: 'bedpe',
    description: 'Focal rex-rex chromatin loops (1D arcs + 2D overlay)',
    size: 0,
  },
];

export function getDemoMetadata(demoId: string): TrackMetadata {
  const chroms = [{ name: DEMO_CHROM, length: DEMO_CHROM_LEN }];
  if (demoId === 'demo://wt_hic' || demoId === 'demo://ko_hic') {
    const isKO = demoId === 'demo://ko_hic';
    return {
      track_id: demoId,
      name: isKO ? 'ce11_chrX_CondensinDC_KO_demo.mcool' : 'ce11_chrX_WT_demo.mcool',
      path: demoId,
      format_id: 'mcool',
      track_kind: 'matrix2d',
      chroms,
      resolutions: [2000, 5000, 10000, 20000, 50000, 100000],
      normalizations: ['balanced', 'oe', 'raw'],
      columns: [],
      default_column: null,
      has_rgb: false,
      value_min: null,
      value_max: null,
      extra: { demo: true, perturbed: isKO },
    };
  }
  if (demoId === 'demo://tads') {
    return {
      track_id: demoId,
      name: 'chrX_17_TADs.bed',
      path: demoId,
      format_id: 'bed',
      track_kind: 'interval1d',
      chroms,
      resolutions: [],
      normalizations: [],
      columns: [],
      default_column: null,
      has_rgb: false,
      value_min: null,
      value_max: null,
      extra: { can_overlay_2d: true, demo: true },
    };
  }
  if (demoId === 'demo://chromstates') {
    return {
      track_id: demoId,
      name: 'chromStates_ce11_rgb.bed',
      path: demoId,
      format_id: 'bed',
      track_kind: 'interval1d',
      chroms,
      resolutions: [],
      normalizations: [],
      columns: [],
      default_column: null,
      has_rgb: true,
      value_min: null,
      value_max: null,
      extra: { can_overlay_2d: false, demo: true },
    };
  }
  if (demoId === 'demo://eigenvector') {
    return {
      track_id: demoId,
      name: 'chrX_cis_eigenvectors_2kb.tsv',
      path: demoId,
      format_id: 'tabular',
      track_kind: 'signal1d',
      chroms,
      resolutions: [],
      normalizations: [],
      columns: ['E1_AB_z', 'E2_dots_smooth_z'],
      default_column: 'E1_AB_z',
      has_rgb: false,
      value_min: -2.2,
      value_max: 2.2,
      extra: { demo: true },
    };
  }
  if (demoId === 'demo://chip') {
    return {
      track_id: demoId,
      name: 'DPY27_SDC3_ChIP_ce11_2kb.tsv',
      path: demoId,
      format_id: 'tabular',
      track_kind: 'signal1d',
      chroms,
      resolutions: [],
      normalizations: [],
      columns: ['DPY27_N2_L3', 'SDC3_N2_L3'],
      default_column: 'DPY27_N2_L3',
      has_rgb: false,
      value_min: 0,
      value_max: 4.5,
      extra: { demo: true },
    };
  }
  if (demoId === 'demo://loops') {
    return {
      track_id: demoId,
      name: 'chrX_rex_loops.bedpe',
      path: demoId,
      format_id: 'bedpe',
      track_kind: 'feature2d',
      chroms,
      resolutions: [],
      normalizations: [],
      columns: [],
      default_column: null,
      has_rgb: false,
      value_min: null,
      value_max: null,
      extra: { can_overlay_2d: true, demo: true },
    };
  }
  throw new Error(`Unknown demo track: ${demoId}`);
}

/** Synthesize crisp 256×256 Float32 Hi-C tile for WT or Condensin-DC KO demo. */
export function generateDemoTile2D(
  demoId: string,
  chrom: string,
  resolution: number,
  tileX: number,
  tileY: number,
  norm: string,
  tileSize = 256
): { data: Float32Array; tileSize: number; resolution: number; min: number; max: number; p98: number } {
  const isKO = demoId === 'demo://ko_hic';
  const data = new Float32Array(tileSize * tileSize);

  if (chrom.toLowerCase() !== 'chrx' && chrom.toLowerCase() !== 'x') {
    data.fill(NaN);
    return { data, tileSize, resolution, min: 0, max: 0, p98: 0 };
  }

  const maxBin = Math.ceil(DEMO_CHROM_LEN / resolution);
  const bx0 = tileX * tileSize;
  const by0 = tileY * tileSize;

  // Precompute per-row/col TAD id, compartment, and nearest rex distance
  const xTad = new Int16Array(tileSize);
  const yTad = new Int16Array(tileSize);
  const xComp = new Float32Array(tileSize);
  const yComp = new Float32Array(tileSize);
  const xRex = new Float32Array(tileSize);
  const yRex = new Float32Array(tileSize);

  const rexSigma = Math.max(resolution * 1.4, 38_000);
  const calcRex = (bp: number) => {
    let best = 0;
    for (const a of REX_ANCHORS) {
      const d = (bp - a) / rexSigma;
      if (Math.abs(d) < 4.5) {
        const v = Math.exp(-0.5 * d * d);
        if (v > best) best = v;
      }
    }
    return best;
  };

  for (let i = 0; i < tileSize; i++) {
    const gx = (bx0 + i + 0.5) * resolution;
    const gy = (by0 + i + 0.5) * resolution;
    xTad[i] = getTadIndex(gx);
    yTad[i] = getTadIndex(gy);
    xComp[i] = compartmentSignal(gx);
    yComp[i] = compartmentSignal(gy);
    xRex[i] = calcRex(gx);
    yRex[i] = calcRex(gy);
  }

  const seed = isKO ? 7717 : 3821;
  const posVals: number[] = [];
  let vmin = Infinity;
  let vmax = -Infinity;

  for (let r = 0; r < tileSize; r++) {
    const gyBin = by0 + r;
    const rowOff = r * tileSize;
    if (gyBin >= maxBin) {
      data.fill(NaN, rowOff, rowOff + tileSize);
      continue;
    }
    for (let c = 0; c < tileSize; c++) {
      const gxBin = bx0 + c;
      if (gxBin >= maxBin) {
        data[rowOff + c] = NaN;
        continue;
      }
      const dBins = Math.abs(gxBin - gyBin);
      const distBp = dBins * resolution;

      // Expected distance-decay P(s)
      const expected = 0.24 / Math.pow(1 + distBp / 45_000, isKO ? 0.94 : 0.84);

      // TAD insulation boost (strong in WT, largely dissolved in Condensin-DC KO)
      const sameTad = xTad[c] === yTad[r];
      const tadFactor = sameTad
        ? isKO
          ? 1.12
          : 2.35
        : distBp < 1_800_000
          ? isKO
            ? 0.96
            : 0.68
          : 0.85;

      // Focal rex-rex loops & architectural stripes (strong in WT, depleted in KO)
      const rexPair = xRex[c] * yRex[r];
      const rexStripe = (xRex[c] + yRex[r]) * (sameTad ? 0.22 : 0.04);
      const loopMult =
        1.0 +
        (isKO ? 0.35 : 5.8) * rexPair * (distBp > 80_000 && distBp < 4_500_000 ? 1.0 : 0.2) +
        (isKO ? 0.1 : 1.1) * rexStripe;

      // A/B compartment plaid (stronger in KO when condensin-DC loop extrusion is removed)
      const compProd = Math.tanh(xComp[c] * 0.7) * Math.tanh(yComp[r] * 0.7);
      const compFactor = Math.exp((isKO ? 0.42 : 0.18) * compProd);

      // Symmetric deterministic texture
      const loB = Math.min(gxBin, gyBin);
      const hiB = Math.max(gxBin, gyBin);
      const n1 = hash2(loB, hiB, seed);
      const n2 = hash2(loB + 17, hiB + 31, seed + 13);
      const noise = 0.78 + 0.44 * (0.5 * (n1 + n2));

      let val: number;
      if (norm === 'oe') {
        val = tadFactor * loopMult * compFactor * noise;
      } else {
        val = expected * tadFactor * loopMult * compFactor * noise;
        if (norm === 'raw') {
          val *= 1200;
        }
      }

      data[rowOff + c] = val;
      if (val > 0) {
        if (val < vmin) vmin = val;
        if (val > vmax) vmax = val;
        if (((r + c) & 3) === 0) posVals.push(val);
      }
    }
  }

  let p98 = 0.05;
  if (posVals.length > 0) {
    posVals.sort((a, b) => a - b);
    p98 = posVals[Math.min(posVals.length - 1, Math.floor(posVals.length * 0.98))];
  }
  return {
    data,
    tileSize,
    resolution,
    min: Number.isFinite(vmin) ? vmin : 0,
    max: Number.isFinite(vmax) ? vmax : 0,
    p98,
  };
}

const STATE_PALETTE = [
  'rgb(228,26,28)',
  'rgb(55,126,184)',
  'rgb(77,175,74)',
  'rgb(152,78,163)',
  'rgb(255,127,0)',
  'rgb(255,215,0)',
  'rgb(166,86,40)',
  'rgb(247,129,191)',
  'rgb(128,128,128)',
  'rgb(82,141,212)',
];

let cachedChromStates: IntervalItem[] | null = null;
function getDemoChromStates(): IntervalItem[] {
  if (cachedChromStates) return cachedChromStates;
  const out: IntervalItem[] = [];
  let pos = 0;
  let idx = 0;
  while (pos < DEMO_CHROM_LEN) {
    const h = hash2(idx, 13, 991);
    const len = Math.round(1_500 + h * 14_000);
    const end = Math.min(DEMO_CHROM_LEN, pos + len);
    const cVal = compartmentSignal(pos + len * 0.5);
    let colorIdx = Math.floor(hash2(idx, 41, 202) * STATE_PALETTE.length);
    if (cVal > 0.6 && hash2(idx, 7, 19) > 0.35) colorIdx = 0; // Active promoter/enhancer red
    else if (cVal < -0.6 && hash2(idx, 9, 29) > 0.35) colorIdx = 8; // Repressed grey/purple
    out.push({
      start: pos,
      end,
      name: `S${colorIdx + 1}`,
      color: STATE_PALETTE[colorIdx],
    });
    pos = end;
    idx++;
  }
  cachedChromStates = out;
  return out;
}

export function getDemoSignal1D(
  demoId: string,
  chrom: string,
  start: number,
  end: number,
  bins: number,
  column?: string | null
): { mean: Float32Array; min: Float32Array; max: Float32Array; bins: number; sigMin: number; sigMax: number } {
  const mean = new Float32Array(bins);
  const min = new Float32Array(bins);
  const max = new Float32Array(bins);
  if (chrom.toLowerCase() !== 'chrx' && chrom.toLowerCase() !== 'x') {
    mean.fill(NaN);
    min.fill(NaN);
    max.fill(NaN);
    return { mean, min, max, bins, sigMin: 0, sigMax: 0 };
  }

  let sigMin = Infinity;
  let sigMax = -Infinity;
  const span = Math.max(1, end - start);

  for (let i = 0; i < bins; i++) {
    const bp = start + ((i + 0.5) / bins) * span;
    let v = 0;
    if (demoId === 'demo://eigenvector') {
      if (column === 'E2_dots_smooth_z') {
        v = chipRexSignal(bp, 0.85) - 0.6;
      } else {
        v = compartmentSignal(bp) + 0.15 * (hash2(Math.floor(bp / 4000), 3, 55) - 0.5);
      }
    } else if (demoId === 'demo://chip') {
      const sc = column === 'SDC3_N2_L3' ? 0.82 : 1.0;
      v = chipRexSignal(bp, sc) * (0.85 + 0.3 * hash2(Math.floor(bp / 2000), 11, 88));
    }
    mean[i] = v;
    min[i] = v * 0.92;
    max[i] = v * 1.08;
    if (v < sigMin) sigMin = v;
    if (v > sigMax) sigMax = v;
  }

  return {
    mean,
    min,
    max,
    bins,
    sigMin: Number.isFinite(sigMin) ? sigMin : 0,
    sigMax: Number.isFinite(sigMax) ? sigMax : 1,
  };
}

export function getDemoFeatures1D(
  demoId: string,
  chrom: string,
  start: number,
  end: number,
  maxItems = 4000
): { mode: 'intervals' | 'genes' | 'arcs'; items: (IntervalItem | ArcItem)[]; total: number } {
  if (chrom.toLowerCase() !== 'chrx' && chrom.toLowerCase() !== 'x') {
    return { mode: demoId === 'demo://loops' ? 'arcs' : 'intervals', items: [], total: 0 };
  }
  if (demoId === 'demo://tads') {
    const items: IntervalItem[] = DEMO_TAD_BOUNDS.filter(([s, e]) => e > start && s < end).map(
      ([s, e, name]) => ({ start: s, end: e, name })
    );
    return { mode: 'intervals', items, total: items.length };
  }
  if (demoId === 'demo://chromstates') {
    const all = getDemoChromStates().filter((it) => it.end > start && it.start < end);
    const total = all.length;
    if (total <= maxItems) return { mode: 'intervals', items: all, total };
    const picked: IntervalItem[] = [];
    for (let i = 0; i < maxItems; i++) {
      picked.push(all[Math.floor((i * (total - 1)) / Math.max(1, maxItems - 1))]);
    }
    return { mode: 'intervals', items: picked, total };
  }
  if (demoId === 'demo://loops') {
    const loops = buildDemoLoops().filter(
      (l) => Math.max(l.end1, l.end2) > start && Math.min(l.start1, l.start2) < end
    );
    return { mode: 'arcs', items: loops, total: loops.length };
  }
  return { mode: 'intervals', items: [], total: 0 };
}

function buildDemoLoops(): ArcItem[] {
  const out: ArcItem[] = [];
  for (let i = 0; i < REX_ANCHORS.length; i++) {
    for (let j = i + 1; j < Math.min(REX_ANCHORS.length, i + 4); j++) {
      const a = REX_ANCHORS[i];
      const b = REX_ANCHORS[j];
      if (b - a > 3_600_000) continue;
      out.push({
        start1: a - 12_000,
        end1: a + 12_000,
        start2: b - 12_000,
        end2: b + 12_000,
        name: `rex_${i + 1}-${j + 1}`,
        kind: 'loop',
      });
    }
  }
  return out;
}

export function getDemoFeatures2D(
  demoId: string,
  chrom: string,
  start: number,
  end: number
): { items: ArcItem[] } {
  if (chrom.toLowerCase() !== 'chrx' && chrom.toLowerCase() !== 'x') {
    return { items: [] };
  }
  if (demoId === 'demo://tads') {
    return {
      items: DEMO_TAD_BOUNDS.filter(([s, e]) => e > start && s < end).map(([s, e, name]) => ({
        start1: s,
        end1: e,
        start2: s,
        end2: e,
        name,
        kind: 'domain',
      })),
    };
  }
  if (demoId === 'demo://loops') {
    return {
      items: buildDemoLoops().filter(
        (l) => l.end1 > start && l.start1 < end && l.end2 > start && l.start2 < end
      ),
    };
  }
  return { items: [] };
}
