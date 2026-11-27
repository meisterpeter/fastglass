import { BigBed, BigWig } from '@gmod/bbi';
import Straw from 'hic-straw';
import type {
  ArcItem,
  ChromInfo,
  FsListResponse,
  GeneItem,
  GeneSearchHit,
  GenomeInfo,
  IntervalItem,
  TrackMetadata,
} from '../types';
import {
  DEMO_CATALOG,
  generateDemoTile2D,
  getDemoFeatures1D,
  getDemoFeatures2D,
  getDemoMetadata,
  getDemoSignal1D,
} from './demoData';

const GENOME_LIST: { id: string; label: string; track: string; fallbackChroms: ChromInfo[] }[] = [
  {
    id: 'ce11',
    label: 'C. elegans (ce11 / WBcel235)',
    track: 'refGene',
    fallbackChroms: [
      { name: 'chrI', length: 15_072_434 },
      { name: 'chrII', length: 15_279_421 },
      { name: 'chrIII', length: 13_783_801 },
      { name: 'chrIV', length: 17_493_829 },
      { name: 'chrV', length: 20_924_180 },
      { name: 'chrX', length: 17_718_942 },
    ],
  },
  {
    id: 'hg38',
    label: 'Human (hg38 / GRCh38)',
    track: 'ncbiRefSeqCurated',
    fallbackChroms: [
      { name: 'chr1', length: 248_956_422 },
      { name: 'chr2', length: 242_193_529 },
      { name: 'chr3', length: 198_295_559 },
      { name: 'chrX', length: 156_040_895 },
    ],
  },
  {
    id: 'hg19',
    label: 'Human (hg19 / GRCh37)',
    track: 'refGene',
    fallbackChroms: [
      { name: 'chr1', length: 249_250_621 },
      { name: 'chrX', length: 155_270_560 },
    ],
  },
  {
    id: 'mm39',
    label: 'Mouse (mm39 / GRCm39)',
    track: 'ncbiRefSeqCurated',
    fallbackChroms: [
      { name: 'chr1', length: 195_154_279 },
      { name: 'chrX', length: 169_476_592 },
    ],
  },
  {
    id: 'mm10',
    label: 'Mouse (mm10 / GRCm38)',
    track: 'refGene',
    fallbackChroms: [
      { name: 'chr1', length: 195_471_971 },
      { name: 'chrX', length: 171_031_299 },
    ],
  },
  {
    id: 'dm6',
    label: 'D. melanogaster (dm6 / BDGP6)',
    track: 'refGene',
    fallbackChroms: [
      { name: 'chr2L', length: 23_513_712 },
      { name: 'chr2R', length: 25_286_936 },
      { name: 'chr3L', length: 28_110_227 },
      { name: 'chr3R', length: 32_079_331 },
      { name: 'chrX', length: 23_542_271 },
    ],
  },
  {
    id: 'sacCer3',
    label: 'S. cerevisiae (sacCer3)',
    track: 'ncbiRefSeqCurated',
    fallbackChroms: [{ name: 'chrI', length: 230_218 }],
  },
];

function normChromKey(c: string): string {
  const low = c.trim().toLowerCase();
  if (low === 'chrm' || low === 'chrmt' || low === 'mtdna' || low === 'mt' || low === 'm') return 'mt';
  return low.startsWith('chr') ? low.slice(3) : low;
}

function resolveChromName(req: string, available: string[]): string | null {
  if (available.includes(req)) return req;
  const k = normChromKey(req);
  for (const c of available) {
    if (normChromKey(c) === k) return c;
  }
  return null;
}

async function readTextMaybeGzip(src: File | Response, filename: string): Promise<string> {
  const isGz = filename.toLowerCase().endsWith('.gz');
  if (!isGz) {
    return src.text();
  }
  const stream = src instanceof File ? src.stream() : src.body;
  if (!stream || typeof DecompressionStream === 'undefined') {
    throw new Error('Gzip decompression is not supported in this browser');
  }
  const ds = new DecompressionStream('gzip');
  const decompressed = stream.pipeThrough(ds);
  return new Response(decompressed).text();
}

function binIntervalsToSignal(
  starts: Int32Array | number[],
  ends: Int32Array | number[],
  vals: Float32Array | number[],
  viewStart: number,
  viewEnd: number,
  bins: number
): { mean: Float32Array; min: Float32Array; max: Float32Array; bins: number; sigMin: number; sigMax: number } {
  const nBins = Math.max(1, Math.min(4096, Math.round(bins)));
  const mean = new Float32Array(nBins).fill(NaN);
  const min = new Float32Array(nBins).fill(NaN);
  const max = new Float32Array(nBins).fill(NaN);
  const sums = new Float64Array(nBins);
  const counts = new Int32Array(nBins);
  const mins = new Float64Array(nBins).fill(Infinity);
  const maxs = new Float64Array(nBins).fill(-Infinity);

  const span = Math.max(1, viewEnd - viewStart);
  const scale = nBins / span;

  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = ends[i];
    if (e <= viewStart) continue;
    if (s >= viewEnd) break;
    const v = vals[i];
    if (!Number.isFinite(v)) continue;
    const b0 = Math.max(0, Math.min(nBins - 1, Math.floor((s - viewStart) * scale)));
    const b1 = Math.max(b0, Math.min(nBins - 1, Math.ceil((e - viewStart) * scale) - 1));
    for (let b = b0; b <= b1; b++) {
      sums[b] += v;
      counts[b]++;
      if (v < mins[b]) mins[b] = v;
      if (v > maxs[b]) maxs[b] = v;
    }
  }

  let sigMin = Infinity;
  let sigMax = -Infinity;
  for (let b = 0; b < nBins; b++) {
    if (counts[b] > 0) {
      mean[b] = sums[b] / counts[b];
      min[b] = mins[b];
      max[b] = maxs[b];
      if (min[b] < sigMin) sigMin = min[b];
      if (max[b] > sigMax) sigMax = max[b];
    }
  }
  return {
    mean,
    min,
    max,
    bins: nBins,
    sigMin: Number.isFinite(sigMin) ? sigMin : 0,
    sigMax: Number.isFinite(sigMax) ? sigMax : 1,
  };
}

interface BrowserTrackRecord {
  meta: TrackMetadata;
  tile2d?: (
    chrom: string,
    resolution: number,
    tx: number,
    ty: number,
    norm: string,
    tileSize: number
  ) => Promise<{ data: Float32Array; tileSize: number; resolution: number; min: number; max: number; p98: number }>;
  signal1d?: (
    chrom: string,
    start: number,
    end: number,
    bins: number,
    column?: string | null
  ) => Promise<{ mean: Float32Array; min: Float32Array; max: Float32Array; bins: number; sigMin: number; sigMax: number }>;
  features1d?: (
    chrom: string,
    start: number,
    end: number,
    maxItems: number
  ) => Promise<{ mode: 'intervals' | 'genes' | 'arcs'; items: (IntervalItem | GeneItem | ArcItem)[]; total?: number }>;
  features2d?: (
    chrom: string,
    start: number,
    end: number,
    maxItems: number
  ) => Promise<{ items: ArcItem[] }>;
}

const tracks = new Map<string, BrowserTrackRecord>();
const ucscWindowCache = new Map<string, GeneItem[]>();
const ucscChromCache = new Map<string, ChromInfo[]>();

let nextBrowserTrackId = 1;
function makeId(prefix: string): string {
  return `browser-${prefix}-${nextBrowserTrackId++}`;
}

function parseRgb(val?: string): string | null {
  if (!val) return null;
  const parts = val.trim().split(',');
  if (parts.length === 3) {
    const [r, g, b] = parts.map(Number);
    if ([r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
      return `rgb(${r},${g},${b})`;
    }
  }
  return null;
}

function buildBedTrack(name: string, path: string, text: string): BrowserTrackRecord {
  const byChrom = new Map<string, IntervalItem[]>();
  const chromLen = new Map<string, number>();
  let hasRgb = false;

  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#') || s.startsWith('track ') || s.startsWith('browser ')) continue;
    let parts = s.split('\t');
    if (parts.length < 3) parts = s.split(/\s+/);
    if (parts.length < 3) continue;
    const chrom = parts[0];
    let st = Number(parts[1]);
    let en = Number(parts[2]);
    if (!Number.isFinite(st) || !Number.isFinite(en)) continue;
    if (en < st) [st, en] = [en, st];
    const score = parts[4] !== undefined && Number.isFinite(Number(parts[4])) ? Number(parts[4]) : null;
    const color = parseRgb(parts[8]);
    if (color) hasRgb = true;
    const list = byChrom.get(chrom) ?? [];
    list.push({ start: st, end: en, name: parts[3] || '', score, strand: parts[5] || '.', color });
    byChrom.set(chrom, list);
    chromLen.set(chrom, Math.max(chromLen.get(chrom) ?? 0, en));
  }

  for (const list of byChrom.values()) list.sort((a, b) => a.start - b.start);
  const avail = Array.from(byChrom.keys());
  const id = makeId('bed');
  const meta: TrackMetadata = {
    track_id: id,
    name,
    path,
    format_id: 'bed',
    track_kind: 'interval1d',
    chroms: avail.map((c) => ({ name: c, length: chromLen.get(c) ?? 0 })),
    resolutions: [],
    normalizations: [],
    columns: [],
    default_column: null,
    has_rgb: hasRgb,
    value_min: null,
    value_max: null,
    extra: { can_overlay_2d: true },
  };

  return {
    meta,
    async features1d(chrom, start, end, maxItems) {
      const rc = resolveChromName(chrom, avail);
      if (!rc) return { mode: 'intervals', items: [], total: 0 };
      const all = (byChrom.get(rc) ?? []).filter((it) => it.end > start && it.start < end);
      const total = all.length;
      if (total <= maxItems) return { mode: 'intervals', items: all, total };
      const picked: IntervalItem[] = [];
      for (let i = 0; i < maxItems; i++) {
        picked.push(all[Math.floor((i * (total - 1)) / Math.max(1, maxItems - 1))]);
      }
      return { mode: 'intervals', items: picked, total };
    },
    async features2d(chrom, start, end, maxItems) {
      const rc = resolveChromName(chrom, avail);
      if (!rc) return { items: [] };
      const all = (byChrom.get(rc) ?? []).filter((it) => it.end > start && it.start < end).slice(0, maxItems);
      return {
        items: all.map((it) => ({
          start1: it.start,
          end1: it.end,
          start2: it.start,
          end2: it.end,
          name: it.name,
          color: it.color,
          kind: 'domain',
        })),
      };
    },
  };
}

function buildBedGraphTrack(name: string, path: string, text: string): BrowserTrackRecord {
  const byChrom = new Map<string, { s: number[]; e: number[]; v: number[] }>();
  const chromLen = new Map<string, number>();
  let vmin = Infinity;
  let vmax = -Infinity;

  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#') || s.startsWith('track ') || s.startsWith('browser ')) continue;
    const parts = s.split(/\s+/);
    if (parts.length < 4) continue;
    const c = parts[0];
    const st = Number(parts[1]);
    const en = Number(parts[2]);
    const val = Number(parts[3]);
    if (!Number.isFinite(st) || !Number.isFinite(en) || !Number.isFinite(val)) continue;
    let entry = byChrom.get(c);
    if (!entry) {
      entry = { s: [], e: [], v: [] };
      byChrom.set(c, entry);
    }
    entry.s.push(st);
    entry.e.push(en);
    entry.v.push(val);
    chromLen.set(c, Math.max(chromLen.get(c) ?? 0, en));
    if (val < vmin) vmin = val;
    if (val > vmax) vmax = val;
  }

  const avail = Array.from(byChrom.keys());
  const id = makeId('bg');
  const meta: TrackMetadata = {
    track_id: id,
    name,
    path,
    format_id: 'bedgraph',
    track_kind: 'signal1d',
    chroms: avail.map((c) => ({ name: c, length: chromLen.get(c) ?? 0 })),
    resolutions: [],
    normalizations: [],
    columns: [],
    default_column: null,
    has_rgb: false,
    value_min: Number.isFinite(vmin) ? vmin : null,
    value_max: Number.isFinite(vmax) ? vmax : null,
    extra: {},
  };

  return {
    meta,
    async signal1d(chrom, start, end, bins) {
      const rc = resolveChromName(chrom, avail);
      if (!rc) {
        const empty = new Float32Array(bins).fill(NaN);
        return { mean: empty, min: empty.slice(), max: empty.slice(), bins, sigMin: 0, sigMax: 1 };
      }
      const d = byChrom.get(rc)!;
      return binIntervalsToSignal(d.s, d.e, d.v, start, end, bins);
    },
  };
}

function buildBedpeTrack(name: string, path: string, text: string): BrowserTrackRecord {
  const byChrom = new Map<string, ArcItem[]>();
  const chromLen = new Map<string, number>();

  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#') || s.startsWith('track ') || s.startsWith('browser ')) continue;
    let parts = s.split('\t');
    if (parts.length < 6) parts = s.split(/\s+/);
    if (parts.length < 6) continue;
    const c1 = parts[0];
    const s1 = Number(parts[1]);
    const e1 = Number(parts[2]);
    const c2 = parts[3];
    const s2 = Number(parts[4]);
    const e2 = Number(parts[5]);
    if (![s1, e1, s2, e2].every(Number.isFinite)) continue;
    chromLen.set(c1, Math.max(chromLen.get(c1) ?? 0, e1));
    chromLen.set(c2, Math.max(chromLen.get(c2) ?? 0, e2));
    if (normChromKey(c1) !== normChromKey(c2)) continue;
    const list = byChrom.get(c1) ?? [];
    list.push({
      start1: s1,
      end1: e1,
      start2: s2,
      end2: e2,
      name: parts[6] || '',
      score: parts[7] && Number.isFinite(Number(parts[7])) ? Number(parts[7]) : null,
      color: parseRgb(parts[10]),
      kind: 'loop',
    });
    byChrom.set(c1, list);
  }

  const avail = Array.from(byChrom.keys());
  const id = makeId('bedpe');
  const meta: TrackMetadata = {
    track_id: id,
    name,
    path,
    format_id: 'bedpe',
    track_kind: 'feature2d',
    chroms: avail.map((c) => ({ name: c, length: chromLen.get(c) ?? 0 })),
    resolutions: [],
    normalizations: [],
    columns: [],
    default_column: null,
    has_rgb: false,
    value_min: null,
    value_max: null,
    extra: { can_overlay_2d: true },
  };

  return {
    meta,
    async features1d(chrom, start, end, maxItems) {
      const rc = resolveChromName(chrom, avail);
      if (!rc) return { mode: 'arcs', items: [], total: 0 };
      const all = (byChrom.get(rc) ?? []).filter(
        (a) => Math.max(a.end1, a.end2) > start && Math.min(a.start1, a.start2) < end
      );
      return { mode: 'arcs', items: all.slice(0, maxItems), total: all.length };
    },
    async features2d(chrom, start, end, maxItems) {
      const rc = resolveChromName(chrom, avail);
      if (!rc) return { items: [] };
      const all = (byChrom.get(rc) ?? []).filter(
        (a) => a.end1 > start && a.start1 < end && a.end2 > start && a.start2 < end
      );
      return { items: all.slice(0, maxItems) };
    },
  };
}

function buildGtfTrack(name: string, path: string, text: string): BrowserTrackRecord {
  const isGff = name.toLowerCase().includes('.gff');
  const genesMap = new Map<string, GeneItem & { chrom: string }>();
  const parentToGene = new Map<string, string>();
  const chromLen = new Map<string, number>();

  const parseAttrs = (str: string): Record<string, string> => {
    const out: Record<string, string> = {};
    if (isGff) {
      for (const p of str.split(';')) {
        const eq = p.indexOf('=');
        if (eq > 0) out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
      }
    } else {
      const re = /(\w+)\s+"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(str)) !== null) out[m[1]] = m[2];
    }
    return out;
  };

  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) continue;
    const p = raw.split('\t');
    if (p.length < 9) continue;
    const ftype = p[2].toLowerCase();
    if (!['gene', 'transcript', 'mrna', 'exon', 'cds'].includes(ftype)) continue;
    const chrom = p[0];
    const st = Math.max(0, Number(p[3]) - 1);
    const en = Number(p[4]);
    const strand = p[6] || '.';
    if (!Number.isFinite(st) || !Number.isFinite(en) || en <= st) continue;
    const attrs = parseAttrs(p[8]);
    let gid: string;
    let gname: string;
    if (isGff) {
      if (ftype === 'transcript' || ftype === 'mrna') {
        if (attrs.ID && attrs.Parent) parentToGene.set(attrs.ID, attrs.Parent.split(',')[0]);
        gid = attrs.Parent?.split(',')[0] || attrs.ID || `${chrom}:${st}-${en}`;
      } else if (ftype === 'exon' || ftype === 'cds') {
        const pid = attrs.Parent?.split(',')[0] || '';
        gid = parentToGene.get(pid) || pid || `${chrom}:${st}-${en}`;
      } else {
        gid = attrs.ID || attrs.Name || `${chrom}:${st}-${en}`;
      }
      gname = attrs.Name || attrs.gene_name || gid;
    } else {
      gid = attrs.gene_id || attrs.transcript_id || `${chrom}:${st}-${en}`;
      gname = attrs.gene_name || attrs.gene_symbol || gid;
    }

    const key = `${chrom}|${gid}`;
    let g = genesMap.get(key);
    if (!g) {
      g = { chrom, start: st, end: en, strand, name: gname, exons: [] };
      genesMap.set(key, g);
    } else {
      g.start = Math.min(g.start, st);
      g.end = Math.max(g.end, en);
      if (gname && g.name === gid) g.name = gname;
    }
    if (ftype === 'exon' || ftype === 'cds') g.exons.push([st, en]);
    chromLen.set(chrom, Math.max(chromLen.get(chrom) ?? 0, en));
  }

  const byChrom = new Map<string, GeneItem[]>();
  for (const g of genesMap.values()) {
    g.exons.sort((a, b) => a[0] - b[0]);
    const list = byChrom.get(g.chrom) ?? [];
    list.push({ start: g.start, end: g.end, strand: g.strand, name: g.name, exons: g.exons });
    byChrom.set(g.chrom, list);
  }
  for (const list of byChrom.values()) list.sort((a, b) => a.start - b.start);

  const avail = Array.from(byChrom.keys());
  const id = makeId('gtf');
  const meta: TrackMetadata = {
    track_id: id,
    name,
    path,
    format_id: isGff ? 'gff3' : 'gtf',
    track_kind: 'gene1d',
    chroms: avail.map((c) => ({ name: c, length: chromLen.get(c) ?? 0 })),
    resolutions: [],
    normalizations: [],
    columns: [],
    default_column: null,
    has_rgb: false,
    value_min: null,
    value_max: null,
    extra: {},
  };

  return {
    meta,
    async features1d(chrom, start, end, maxItems) {
      const rc = resolveChromName(chrom, avail);
      if (!rc) return { mode: 'genes', items: [], total: 0 };
      const all = (byChrom.get(rc) ?? []).filter((g) => g.end > start && g.start < end);
      return { mode: 'genes', items: all.slice(0, maxItems), total: all.length };
    },
  };
}

function buildTabularTrack(name: string, path: string, text: string): BrowserTrackRecord {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('##') && !l.startsWith('track ') && !l.startsWith('browser '));
  if (lines.length === 0) throw new Error(`Empty tabular file: ${name}`);

  const delim = name.toLowerCase().endsWith('.csv')
    ? ','
    : lines[0].includes('\t')
      ? '\t'
      : lines[0].includes(',')
        ? ','
        : null;
  const splitRow = (ln: string) => (delim ? ln.split(delim) : ln.split(/\s+/));

  const first = splitRow(lines[0]);
  const isNum = (v: string) => Boolean(v && !['.', 'NA', 'NaN', 'nan', 'null', 'None'].includes(v) && Number.isFinite(Number(v)));
  const firstNorm = first.map((c) => c.trim().replace(/^#/, '').toLowerCase());
  const CHROM_COLS = new Set(['chrom', 'chr', 'chromosome', 'seqname', 'seqnames', 'contig']);
  const START_COLS = new Set(['start', 'start_bp', 'chromstart', 'bin_start', 'pos', 'position', 'pos_bp', 'mid', 'mid_bp', 'center', 'bp']);
  const END_COLS = new Set(['end', 'end_bp', 'chromend', 'bin_end', 'stop']);
  const DEPRIO = new Set(['valid', 'is_valid', 'bin', 'bin_id', 'index', 'idx', 'mid', 'mid_bp', 'length', 'width']);

  const hasHeader =
    firstNorm.some((c) => CHROM_COLS.has(c) || START_COLS.has(c) || END_COLS.has(c)) ||
    first.every((c) => !isNum(c));

  const headers = hasHeader ? first.map((c) => c.trim().replace(/^#/, '')) : first.map((_, i) => `col_${i}`);
  const hLow = headers.map((h) => h.toLowerCase());
  const rows = (hasHeader ? lines.slice(1) : lines).map(splitRow).filter((r) => r.length >= 2);
  if (rows.length === 0) throw new Error(`No data rows in ${name}`);

  let chromI = hLow.findIndex((h) => CHROM_COLS.has(h));
  let startI = hLow.findIndex((h) => START_COLS.has(h));
  let endI = hLow.findIndex((h) => END_COLS.has(h));
  if (startI < 0) {
    if (rows[0].length >= 3 && !isNum(rows[0][0]) && isNum(rows[0][1])) {
      chromI = 0;
      startI = 1;
      if (isNum(rows[0][2]) && Number(rows[0][2]) >= Number(rows[0][1])) endI = 2;
    } else if (isNum(rows[0][0])) {
      startI = 0;
    } else {
      throw new Error(`Could not detect coordinate column in ${name} (headers: ${headers.join(', ')})`);
    }
  }

  const coordSet = new Set([chromI, startI, endI].filter((i) => i >= 0));
  const sample = rows.slice(0, 150);
  const numCols: number[] = [];
  for (let ci = 0; ci < headers.length; ci++) {
    if (coordSet.has(ci)) continue;
    const vals = sample.map((r) => r[ci]).filter((v) => v && !['.', 'NA', 'NaN', 'nan'].includes(v));
    if (vals.length > 0 && vals.filter(isNum).length >= vals.length * 0.8) {
      numCols.push(ci);
    }
  }

  const mChrom = name.match(/(chr(?:[IVX]+|\d+|X|Y|M))/i);
  const fallbackChrom = mChrom ? 'chr' + mChrom[1].slice(3) : 'chrX';

  const preferred = numCols.map((i) => headers[i]).filter((h) => !DEPRIO.has(h.toLowerCase()));
  const allCols = [...preferred, ...numCols.map((i) => headers[i]).filter((h) => !preferred.includes(h))];
  const defCol = allCols[0] ?? null;

  const byChrom = new Map<string, { s: number[]; e: number[]; cols: Record<string, number[]> }>();
  const chromLen = new Map<string, number>();

  for (const r of rows) {
    const st = Number(r[startI]);
    if (!Number.isFinite(st)) continue;
    const en = endI >= 0 && Number.isFinite(Number(r[endI])) ? Number(r[endI]) : st + 2000;
    const c = chromI >= 0 && r[chromI] ? r[chromI].trim() : fallbackChrom;
    let entry = byChrom.get(c);
    if (!entry) {
      const colsObj: Record<string, number[]> = {};
      for (const col of allCols) colsObj[col] = [];
      entry = { s: [], e: [], cols: colsObj };
      byChrom.set(c, entry);
    }
    entry.s.push(st);
    entry.e.push(Math.max(en, st + 1));
    for (const ci of numCols) {
      const colName = headers[ci];
      const rawV = r[ci];
      entry.cols[colName].push(isNum(rawV) ? Number(rawV) : NaN);
    }
    chromLen.set(c, Math.max(chromLen.get(c) ?? 0, en));
  }

  let vmin = Infinity;
  let vmax = -Infinity;
  if (defCol) {
    for (const d of byChrom.values()) {
      for (const v of d.cols[defCol]) {
        if (Number.isFinite(v)) {
          if (v < vmin) vmin = v;
          if (v > vmax) vmax = v;
        }
      }
    }
  }

  const avail = Array.from(byChrom.keys());
  const id = makeId('tsv');
  const meta: TrackMetadata = {
    track_id: id,
    name,
    path,
    format_id: 'tabular',
    track_kind: defCol ? 'signal1d' : 'interval1d',
    chroms: avail.map((c) => ({ name: c, length: chromLen.get(c) ?? 0 })),
    resolutions: [],
    normalizations: [],
    columns: allCols,
    default_column: defCol,
    has_rgb: false,
    value_min: Number.isFinite(vmin) ? vmin : null,
    value_max: Number.isFinite(vmax) ? vmax : null,
    extra: {},
  };

  return {
    meta,
    async signal1d(chrom, start, end, bins, column) {
      const rc = resolveChromName(chrom, avail);
      const col = column && allCols.includes(column) ? column : defCol;
      if (!rc || !col) {
        const empty = new Float32Array(bins).fill(NaN);
        return { mean: empty, min: empty.slice(), max: empty.slice(), bins, sigMin: 0, sigMax: 1 };
      }
      const d = byChrom.get(rc)!;
      return binIntervalsToSignal(d.s, d.e, d.cols[col], start, end, bins);
    },
    async features1d(chrom, start, end, maxItems) {
      const rc = resolveChromName(chrom, avail);
      if (!rc) return { mode: 'intervals', items: [], total: 0 };
      const d = byChrom.get(rc)!;
      const items: IntervalItem[] = [];
      for (let i = 0; i < d.s.length && items.length < maxItems; i++) {
        if (d.e[i] > start && d.s[i] < end) {
          items.push({ start: d.s[i], end: d.e[i] });
        }
      }
      return { mode: 'intervals', items, total: items.length };
    },
  };
}

async function buildHicTrack(name: string, path: string, source: File | string): Promise<BrowserTrackRecord> {
  const straw = new Straw(typeof source === 'string' ? { url: source } : { file: source });
  const md = await straw.getMetaData();
  let norms: string[] = ['NONE'];
  try {
    const n = await straw.getNormalizationOptions();
    if (n && n.length > 0) norms = n;
  } catch {
    norms = ['NONE', 'KR', 'VC', 'VC_SQRT', 'SCALE'];
  }
  const chroms: ChromInfo[] = (md.chromosomes || [])
    .filter((c) => c.name.toLowerCase() !== 'all')
    .map((c) => ({ name: c.name, length: c.size }));
  const avail = chroms.map((c) => c.name);
  const chromLenMap = new Map(chroms.map((c) => [c.name, c.length]));
  const resolutions = [...(md.resolutions || [10000])].sort((a, b) => a - b);

  const id = makeId('hic');
  const meta: TrackMetadata = {
    track_id: id,
    name,
    path,
    format_id: 'hic',
    track_kind: 'matrix2d',
    chroms,
    resolutions,
    normalizations: norms,
    columns: [],
    default_column: null,
    has_rgb: false,
    value_min: null,
    value_max: null,
    extra: {},
  };

  return {
    meta,
    async tile2d(chrom, resolution, tx, ty, norm, tileSize) {
      const rc = resolveChromName(chrom, avail);
      const data = new Float32Array(tileSize * tileSize);
      if (!rc) {
        data.fill(NaN);
        return { data, tileSize, resolution, min: 0, max: 0, p98: 0 };
      }
      const cLen = chromLenMap.get(rc) ?? 0;
      const lx0 = tx * tileSize;
      const ly0 = ty * tileSize;
      const xStartBp = lx0 * resolution;
      const xEndBp = Math.min(cLen, (lx0 + tileSize) * resolution);
      const yStartBp = ly0 * resolution;
      const yEndBp = Math.min(cLen, (ly0 + tileSize) * resolution);

      if (xStartBp >= cLen || yStartBp >= cLen) {
        data.fill(NaN);
        return { data, tileSize, resolution, min: 0, max: 0, p98: 0 };
      }

      const normUse = norm === 'raw' ? 'NONE' : norm === 'balanced' ? (norms.includes('KR') ? 'KR' : norms[0]) : norm;
      const recs = await straw.getContactRecords(
        normUse,
        { chr: rc, start: xStartBp, end: Math.max(xStartBp + 1, xEndBp - 1) },
        { chr: rc, start: yStartBp, end: Math.max(yStartBp + 1, yEndBp - 1) },
        'BP',
        resolution
      );

      const posVals: number[] = [];
      let vmin = Infinity;
      let vmax = -Infinity;
      for (const rec of recs) {
        const val = rec.counts;
        if (!Number.isFinite(val)) continue;
        const cx = rec.bin1 - lx0;
        const cy = rec.bin2 - ly0;
        if (cx >= 0 && cx < tileSize && cy >= 0 && cy < tileSize) {
          data[cy * tileSize + cx] = val;
        }
        const cx2 = rec.bin2 - lx0;
        const cy2 = rec.bin1 - ly0;
        if (cx2 >= 0 && cx2 < tileSize && cy2 >= 0 && cy2 < tileSize) {
          data[cy2 * tileSize + cx2] = val;
        }
        if (val > 0) {
          if (val < vmin) vmin = val;
          if (val > vmax) vmax = val;
          posVals.push(val);
        }
      }

      // Mark out-of-chrom padding as NaN
      const maxBin = Math.ceil(cLen / resolution);
      const validCols = Math.max(0, Math.min(tileSize, maxBin - lx0));
      const validRows = Math.max(0, Math.min(tileSize, maxBin - ly0));
      for (let r = 0; r < tileSize; r++) {
        if (r >= validRows) {
          data.fill(NaN, r * tileSize, (r + 1) * tileSize);
        } else if (validCols < tileSize) {
          data.fill(NaN, r * tileSize + validCols, (r + 1) * tileSize);
        }
      }

      let p98 = 0;
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
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeBbiFilehandle(source: File | string): any {
  if (typeof source !== 'string') {
    const file = source;
    return {
      async read(length: number, position: number): Promise<Uint8Array<ArrayBuffer>> {
        const buf = await file.slice(position, position + length).arrayBuffer();
        return new Uint8Array(buf);
      },
      async readFile(opts?: string | { encoding?: string }): Promise<Uint8Array<ArrayBuffer> | string> {
        const enc = typeof opts === 'string' ? opts : opts?.encoding;
        if (enc === 'utf8' || enc === 'utf-8') return file.text();
        return new Uint8Array(await file.arrayBuffer());
      },
      async stat(): Promise<{ size: number }> {
        return { size: file.size };
      },
      async close(): Promise<void> {},
    };
  }
  const url = source;
  return {
    async read(length: number, position: number): Promise<Uint8Array<ArrayBuffer>> {
      const res = await fetch(url, {
        headers: { Range: `bytes=${position}-${position + length - 1}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} reading ${url}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async readFile(opts?: string | { encoding?: string }): Promise<Uint8Array<ArrayBuffer> | string> {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} reading ${url}`);
      const enc = typeof opts === 'string' ? opts : opts?.encoding;
      if (enc === 'utf8' || enc === 'utf-8') return res.text();
      return new Uint8Array(await res.arrayBuffer());
    },
    async stat(): Promise<{ size: number }> {
      const res = await fetch(url, { method: 'HEAD' });
      const cl = Number(res.headers.get('content-length') || 0);
      return { size: cl };
    },
    async close(): Promise<void> {},
  };
}

async function buildBigWigTrack(name: string, path: string, source: File | string): Promise<BrowserTrackRecord> {
  const filehandle = makeBbiFilehandle(source);
  const bw = new BigWig({ filehandle });
  const header = await bw.getHeader();
  const chroms: ChromInfo[] = Object.values(header.refsByNumber).map((ref) => ({
    name: ref.name,
    length: ref.length,
  }));
  const avail = chroms.map((c) => c.name);
  const id = makeId('bw');
  const meta: TrackMetadata = {
    track_id: id,
    name,
    path,
    format_id: 'bigwig',
    track_kind: 'signal1d',
    chroms,
    resolutions: [],
    normalizations: [],
    columns: [],
    default_column: null,
    has_rgb: false,
    value_min: null,
    value_max: null,
    extra: {},
  };

  return {
    meta,
    async signal1d(chrom, start, end, bins) {
      const rc = resolveChromName(chrom, avail);
      if (!rc) {
        const empty = new Float32Array(bins).fill(NaN);
        return { mean: empty, min: empty.slice(), max: empty.slice(), bins, sigMin: 0, sigMax: 1 };
      }
      const scale = bins / Math.max(1, end - start);
      const feats = await bw.getFeatures(rc, Math.max(0, Math.floor(start)), Math.ceil(end), { scale });
      const s: number[] = [];
      const e: number[] = [];
      const v: number[] = [];
      for (const f of feats) {
        s.push(f.start);
        e.push(f.end);
        v.push(f.score ?? NaN);
      }
      return binIntervalsToSignal(s, e, v, start, end, bins);
    },
  };
}

async function buildBigBedTrack(name: string, path: string, source: File | string): Promise<BrowserTrackRecord> {
  const filehandle = makeBbiFilehandle(source);
  const bb = new BigBed({ filehandle });
  const header = await bb.getHeader();
  const chroms: ChromInfo[] = Object.values(header.refsByNumber).map((ref) => ({
    name: ref.name,
    length: ref.length,
  }));
  const avail = chroms.map((c) => c.name);
  const id = makeId('bb');
  const meta: TrackMetadata = {
    track_id: id,
    name,
    path,
    format_id: 'bigbed',
    track_kind: 'interval1d',
    chroms,
    resolutions: [],
    normalizations: [],
    columns: [],
    default_column: null,
    has_rgb: false,
    value_min: null,
    value_max: null,
    extra: { can_overlay_2d: true },
  };

  return {
    meta,
    async features1d(chrom, start, end, maxItems) {
      const rc = resolveChromName(chrom, avail);
      if (!rc) return { mode: 'intervals', items: [], total: 0 };
      const feats = await bb.getFeatures(rc, Math.max(0, Math.floor(start)), Math.ceil(end));
      const items: IntervalItem[] = feats.slice(0, maxItems).map((f) => {
        const rest = f.rest ? f.rest.split('\t') : [];
        return {
          start: f.start,
          end: f.end,
          name: rest[0] || '',
          score: rest[1] && Number.isFinite(Number(rest[1])) ? Number(rest[1]) : null,
          strand: rest[2] || '.',
          color: parseRgb(rest[5]),
        };
      });
      return { mode: 'intervals', items, total: feats.length };
    },
  };
}

async function openUcscGenomeTrack(genomeId: string): Promise<TrackMetadata> {
  const tid = `genome-${genomeId}`;
  const existing = tracks.get(tid);
  if (existing) return existing.meta;

  const entry = GENOME_LIST.find((g) => g.id === genomeId) ?? GENOME_LIST[0];
  let chroms = ucscChromCache.get(entry.id);
  if (!chroms) {
    try {
      const res = await fetch(`https://api.genome.ucsc.edu/list/chromosomes?genome=${encodeURIComponent(entry.id)}`);
      if (res.ok) {
        const json = await res.json();
        const obj = json.chromosomes || {};
        const parsed = Object.entries(obj)
          .filter(([k]) => !k.includes('_'))
          .map(([k, v]) => ({ name: k, length: Number(v) }))
          .filter((c) => Number.isFinite(c.length) && c.length > 0);
        if (parsed.length > 0) chroms = parsed;
      }
    } catch {
      // fall back to built-in sizes
    }
    chroms = chroms ?? entry.fallbackChroms;
    ucscChromCache.set(entry.id, chroms);
  }

  const avail = chroms.map((c) => c.name);
  const meta: TrackMetadata = {
    track_id: tid,
    name: `${entry.id} Genes (RefSeq)`,
    path: `genome://${entry.id}`,
    format_id: 'refgene',
    track_kind: 'gene1d',
    chroms,
    resolutions: [],
    normalizations: [],
    columns: [],
    default_column: null,
    has_rgb: false,
    value_min: null,
    value_max: null,
    extra: { genome_id: entry.id, genome_label: entry.label, source: 'ucsc-api' },
  };

  tracks.set(tid, {
    meta,
    async features1d(chrom, start, end) {
      const rc = resolveChromName(chrom, avail) ?? chrom;
      const s0 = Math.max(0, Math.floor(start));
      const e0 = Math.max(s0 + 1, Math.ceil(end));
      const cacheKey = `${entry.id}|${rc}|${Math.floor(s0 / 50000)}|${Math.ceil(e0 / 50000)}`;
      const cached = ucscWindowCache.get(cacheKey);
      if (cached) {
        const visible = cached.filter((g) => g.end > s0 && g.start < e0);
        return { mode: 'genes', items: visible, total: visible.length };
      }

      const url = `https://api.genome.ucsc.edu/getData/track?genome=${encodeURIComponent(
        entry.id
      )};track=${encodeURIComponent(entry.track)};chrom=${encodeURIComponent(
        rc
      )};start=${s0};end=${e0};maxItemsOutput=1500`;
      const res = await fetch(url);
      if (!res.ok) return { mode: 'genes', items: [], total: 0 };
      const json = await res.json();
      const rawList = (json[entry.track] || []) as Record<string, unknown>[];

      // Deduplicate to longest canonical isoform per gene symbol
      const best = new Map<string, GeneItem>();
      for (const r of rawList) {
        const st = Number(r.txStart);
        const en = Number(r.txEnd);
        if (!Number.isFinite(st) || !Number.isFinite(en) || en <= st) continue;
        const gname = String(r.name2 || r.name || '');
        const prev = best.get(gname);
        if (prev && prev.end - prev.start >= en - st) continue;

        const exS = String(r.exonStarts || '')
          .split(',')
          .filter(Boolean)
          .map(Number);
        const exE = String(r.exonEnds || '')
          .split(',')
          .filter(Boolean)
          .map(Number);
        const exons: [number, number][] = [];
        for (let i = 0; i < Math.min(exS.length, exE.length); i++) {
          if (exE[i] > exS[i]) exons.push([exS[i], exE[i]]);
        }
        best.set(gname, {
          name: gname,
          start: st,
          end: en,
          cdsStart: Number.isFinite(Number(r.cdsStart)) ? Number(r.cdsStart) : undefined,
          cdsEnd: Number.isFinite(Number(r.cdsEnd)) ? Number(r.cdsEnd) : undefined,
          strand: String(r.strand || '.'),
          exons,
        });
      }

      const items = Array.from(best.values()).sort((a, b) => a.start - b.start);
      if (ucscWindowCache.size > 120) ucscWindowCache.clear();
      ucscWindowCache.set(cacheKey, items);
      return { mode: 'genes', items, total: items.length };
    },
  });

  return meta;
}

export const browserBackend = {
  listDemoFiles(): FsListResponse {
    return {
      cwd: 'Online Demo Datasets',
      root: 'Online Demo Datasets',
      parent: null,
      entries: DEMO_CATALOG.map((d) => ({
        name: d.name,
        path: d.id,
        is_dir: false,
        format: d.format,
        size: d.size,
      })),
    };
  },

  listGenomes(): GenomeInfo[] {
    return GENOME_LIST.map((g) => ({
      id: g.id,
      label: g.label,
      cached: true,
      loaded: tracks.has(`genome-${g.id}`),
    }));
  },

  async openGenome(genomeId: string): Promise<TrackMetadata> {
    return openUcscGenomeTrack(genomeId);
  },

  async searchGenes(genomeId: string, q: string, limit = 12, signal?: AbortSignal): Promise<GeneSearchHit[]> {
    const url = `https://api.genome.ucsc.edu/search?search=${encodeURIComponent(q)}&genome=${encodeURIComponent(genomeId)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) return [];
    const json = await res.json();
    const groups = (json.positionMatches || []) as { name: string; matches?: { position: string; posName?: string }[] }[];
    const seen = new Set<string>();
    const out: GeneSearchHit[] = [];

    // Prioritize refGene / ncbiRefSeq / knownGene tracks
    const sorted = [...groups].sort((a, b) => {
      const score = (n: string) => (/refseq|refgene|knowngene|ensgene|wormbase/i.test(n) ? 0 : 1);
      return score(a.name) - score(b.name);
    });

    for (const grp of sorted) {
      for (const m of grp.matches || []) {
        const match = String(m.position || '').match(/^([^:]+):(\d+)-(\d+)$/);
        if (!match) continue;
        const chrom = match[1];
        if (chrom.includes('_')) continue;
        const start = Number(match[2]);
        const end = Number(match[3]);
        const label = m.posName ? `${q} (${m.posName})` : q;
        const dedupKey = `${chrom}:${Math.round(start / 500)}-${Math.round(end / 500)}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        out.push({ name: label, chrom, start, end, strand: '+' });
        if (out.length >= limit) return out;
      }
    }
    return out;
  },

  async openByPath(rawPath: string): Promise<TrackMetadata> {
    if (rawPath.startsWith('genome://')) {
      return openUcscGenomeTrack(rawPath.slice('genome://'.length).trim());
    }
    if (rawPath.startsWith('demo://')) {
      const existing = tracks.get(rawPath);
      if (existing) return existing.meta;
      const meta = getDemoMetadata(rawPath);
      tracks.set(rawPath, {
        meta,
        async tile2d(chrom, res, tx, ty, norm, tileSize) {
          return generateDemoTile2D(rawPath, chrom, res, tx, ty, norm, tileSize);
        },
        async signal1d(chrom, start, end, bins, col) {
          return getDemoSignal1D(rawPath, chrom, start, end, bins, col);
        },
        async features1d(chrom, start, end, maxItems) {
          return getDemoFeatures1D(rawPath, chrom, start, end, maxItems);
        },
        async features2d(chrom, start, end) {
          return getDemoFeatures2D(rawPath, chrom, start, end);
        },
      });
      return meta;
    }
    if (/^https?:\/\//i.test(rawPath)) {
      const cleanUrl = rawPath.split('?')[0];
      const name = decodeURIComponent(cleanUrl.split('/').pop() || 'remote_track');
      const low = name.toLowerCase();
      let rec: BrowserTrackRecord;
      if (low.endsWith('.hic')) {
        rec = await buildHicTrack(name, rawPath, rawPath);
      } else if (low.endsWith('.bw') || low.endsWith('.bigwig')) {
        rec = await buildBigWigTrack(name, rawPath, rawPath);
      } else if (low.endsWith('.bb') || low.endsWith('.bigbed')) {
        rec = await buildBigBedTrack(name, rawPath, rawPath);
      } else if (low.endsWith('.mcool') || low.endsWith('.cool')) {
        throw new Error(
          'Remote/local .mcool HDF5 files require the local FastGlass Python server (`./run.ps1`). In Online mode, open .hic, .bw, .bb, .bed, .bedGraph, .gtf, .gff3, .bedpe, or .tsv/.csv directly!'
        );
      } else {
        const res = await fetch(rawPath);
        if (!res.ok) throw new Error(`Failed to fetch URL (${res.status}): ${rawPath}`);
        const text = await readTextMaybeGzip(res, name);
        rec = parseTextTrack(name, rawPath, text);
      }
      tracks.set(rec.meta.track_id, rec);
      return rec.meta;
    }

    throw new Error(
      'In Online Browser mode, pick a Demo dataset, paste an https:// URL, or drop/select local files (.hic, .bw, .bb, .bed, .bedGraph, .gtf, .bedpe, .tsv/.csv).'
    );
  },

  async openLocalFile(file: File): Promise<TrackMetadata> {
    const name = file.name;
    const low = name.toLowerCase();
    let rec: BrowserTrackRecord;
    if (low.endsWith('.hic')) {
      rec = await buildHicTrack(name, `local://${name}`, file);
    } else if (low.endsWith('.bw') || low.endsWith('.bigwig')) {
      rec = await buildBigWigTrack(name, `local://${name}`, file);
    } else if (low.endsWith('.bb') || low.endsWith('.bigbed')) {
      rec = await buildBigBedTrack(name, `local://${name}`, file);
    } else if (low.endsWith('.mcool') || low.endsWith('.cool')) {
      throw new Error(
        '.mcool / .cool HDF5 files use the local FastGlass Python server (`./run.ps1`). In Online Browser mode, you can open .hic, .bw, .bb, .bed, .bedGraph, .gtf, .gff3, .bedpe, and .tsv/.csv directly in-browser!'
      );
    } else {
      const text = await readTextMaybeGzip(file, name);
      rec = parseTextTrack(name, `local://${name}`, text);
    }
    tracks.set(rec.meta.track_id, rec);
    return rec.meta;
  },

  closeTrack(trackId: string): void {
    if (!trackId.startsWith('demo://') && !trackId.startsWith('genome-')) {
      tracks.delete(trackId);
    }
  },

  async tile2d(trackId: string, chrom: string, res: number, tx: number, ty: number, norm: string, tileSize: number) {
    const rec = tracks.get(trackId);
    if (!rec?.tile2d) throw new Error(`Track ${trackId} has no 2D matrix tiles`);
    return rec.tile2d(chrom, res, tx, ty, norm, tileSize);
  },

  async signal1d(trackId: string, chrom: string, start: number, end: number, bins: number, column?: string | null) {
    const rec = tracks.get(trackId);
    if (!rec?.signal1d) throw new Error(`Track ${trackId} has no 1D signal`);
    return rec.signal1d(chrom, start, end, bins, column);
  },

  async features1d(trackId: string, chrom: string, start: number, end: number, maxItems: number) {
    const rec = tracks.get(trackId);
    if (!rec?.features1d) return { mode: 'intervals' as const, items: [] };
    return rec.features1d(chrom, start, end, maxItems);
  },

  async features2d(trackId: string, chrom: string, start: number, end: number, maxItems: number) {
    const rec = tracks.get(trackId);
    if (!rec?.features2d) return { items: [] };
    return rec.features2d(chrom, start, end, maxItems);
  },
};

function parseTextTrack(name: string, path: string, text: string): BrowserTrackRecord {
  const base = name.toLowerCase().endsWith('.gz') ? name.slice(0, -3).toLowerCase() : name.toLowerCase();
  if (base.endsWith('.bedpe')) return buildBedpeTrack(name, path, text);
  if (base.endsWith('.bedgraph') || base.endsWith('.bg')) return buildBedGraphTrack(name, path, text);
  if (base.endsWith('.gtf') || base.endsWith('.gff') || base.endsWith('.gff3')) return buildGtfTrack(name, path, text);
  if (base.endsWith('.bed') || base.endsWith('.narrowpeak') || base.endsWith('.broadpeak')) {
    return buildBedTrack(name, path, text);
  }
  return buildTabularTrack(name, path, text);
}
