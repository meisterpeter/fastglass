export type TrackKind = 'matrix2d' | 'signal1d' | 'interval1d' | 'gene1d' | 'feature2d';

export interface ChromInfo {
  name: string;
  length: number;
}

export interface TrackMetadata {
  track_id: string;
  name: string;
  path: string;
  format_id: string;
  track_kind: TrackKind;
  chroms: ChromInfo[];
  resolutions: number[];
  normalizations: string[];
  columns: string[];
  default_column: string | null;
  has_rgb: boolean;
  value_min: number | null;
  value_max: number | null;
  extra: Record<string, unknown>;
}

export type ColormapId = 'fall' | 'reds' | 'viridis' | 'inferno' | 'bwr' | 'coolwarm' | 'grey';
export type MatrixMode = 'triangle' | 'square';
export type CompareMode = 'none' | 'split' | 'log2ratio' | 'diff';
export type SignalStyle = 'area' | 'line' | 'bar';
export type BedStyle = 'blocks' | 'arcs';

export interface TrackConfig {
  id: string; // unique instance id in UI stack
  trackId: string; // backend track_id
  meta: TrackMetadata;
  visible: boolean;
  height: number;

  // 2D matrix settings
  matrixMode: MatrixMode;
  norm: string;
  colormap: ColormapId;
  logScale: boolean;
  autoContrast: boolean;
  vmin: number;
  vmax: number;
  gamma: number;
  compareMode: CompareMode;
  compareTrackId: string | null;
  compareTrackName: string | null;

  // 1D signal settings
  column: string | null;
  signalStyle: SignalStyle;
  color: string;
  negColor: string;
  autoY: boolean;
  yMin: number;
  yMax: number;

  // 1D interval / 2D feature settings
  bedStyle: BedStyle;
  overlayOnHeatmaps: boolean;
  overlayColor: string;
}

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  format?: string | null;
  size?: number;
}

export interface FsListResponse {
  cwd: string;
  root: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface IntervalItem {
  start: number;
  end: number;
  name?: string;
  score?: number | null;
  strand?: string;
  color?: string | null;
}

export interface GeneItem {
  start: number;
  end: number;
  cdsStart?: number;
  cdsEnd?: number;
  name: string;
  strand: string;
  exons: [number, number][];
}

export interface GenomeInfo {
  id: string;
  label: string;
  cached: boolean;
  loaded: boolean;
}

export interface GeneSearchHit {
  name: string;
  chrom: string;
  start: number;
  end: number;
  strand: string;
}

export interface ArcItem {
  start1: number;
  end1: number;
  start2: number;
  end2: number;
  name?: string;
  score?: number | null;
  color?: string | null;
  kind?: string;
}
