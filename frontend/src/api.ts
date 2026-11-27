import type {
  ArcItem,
  FsListResponse,
  GeneItem,
  GeneSearchHit,
  GenomeInfo,
  IntervalItem,
  TrackMetadata,
} from './types';

const BASE = '';

export async function fetchHealth(): Promise<{ status: string; root: string; tracks_open: number }> {
  const res = await fetch(`${BASE}/api/health`);
  if (!res.ok) throw new Error(`Backend health error: ${res.status}`);
  return res.json();
}

export async function fetchGenomes(): Promise<GenomeInfo[]> {
  const res = await fetch(`${BASE}/api/genomes`);
  if (!res.ok) throw new Error(`Failed to fetch genomes (${res.status})`);
  return res.json();
}

export async function openGenomeTrack(genomeId: string): Promise<TrackMetadata> {
  const res = await fetch(`${BASE}/api/genomes/${encodeURIComponent(genomeId)}/open`, {
    method: 'POST',
  });
  if (!res.ok) {
    let msg = `Failed to load genome ${genomeId} (${res.status})`;
    try {
      const err = await res.json();
      if (err?.detail) msg = err.detail;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return res.json();
}

export async function searchGenes(
  genomeId: string,
  q: string,
  limit = 12,
  signal?: AbortSignal
): Promise<GeneSearchHit[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  const res = await fetch(
    `${BASE}/api/genomes/${encodeURIComponent(genomeId)}/search?${params}`,
    { signal }
  );
  if (!res.ok) return [];
  return res.json();
}

export async function listFiles(path = '', onlySupported = true): Promise<FsListResponse> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  params.set('only_supported', String(onlySupported));
  const res = await fetch(`${BASE}/api/fs/list?${params}`);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `Failed to list directory (${res.status})`);
  }
  return res.json();
}

export async function openTrack(path: string, formatOverride?: string): Promise<TrackMetadata> {
  const res = await fetch(`${BASE}/api/tracks/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, format_override: formatOverride ?? null }),
  });
  if (!res.ok) {
    let msg = `Failed to open track (${res.status})`;
    try {
      const err = await res.json();
      if (err?.detail) msg = err.detail;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return res.json();
}

export async function uploadTrack(file: File): Promise<TrackMetadata> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${BASE}/api/tracks/upload`, {
    method: 'POST',
    body: fd,
  });
  if (!res.ok) {
    let msg = `Failed to upload ${file.name} (${res.status})`;
    try {
      const err = await res.json();
      if (err?.detail) msg = err.detail;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return res.json();
}

export async function closeTrack(trackId: string): Promise<void> {
  await fetch(`${BASE}/api/tracks/${encodeURIComponent(trackId)}`, { method: 'DELETE' });
}

export interface Tile2DData {
  data: Float32Array;
  tileSize: number;
  resolution: number;
  min: number;
  max: number;
  p98: number;
}

export async function fetchTile2D(
  trackId: string,
  chrom: string,
  resolution: number,
  tileX: number,
  tileY: number,
  norm: string,
  tileSize = 256,
  signal?: AbortSignal
): Promise<Tile2DData> {
  const params = new URLSearchParams({
    chrom_x: chrom,
    chrom_y: chrom,
    resolution: String(resolution),
    tile_x: String(tileX),
    tile_y: String(tileY),
    tile_size: String(tileSize),
    norm,
  });
  const res = await fetch(`${BASE}/api/tracks/${encodeURIComponent(trackId)}/tile2d?${params}`, { signal });
  if (!res.ok) throw new Error(`Tile2D fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  return {
    data: new Float32Array(buf),
    tileSize: Number(res.headers.get('X-Tile-Size') || tileSize),
    resolution: Number(res.headers.get('X-Resolution') || resolution),
    min: Number(res.headers.get('X-Tile-Min') || 0),
    max: Number(res.headers.get('X-Tile-Max') || 0),
    p98: Number(res.headers.get('X-Tile-P98') || 0),
  };
}

export interface Signal1DData {
  mean: Float32Array;
  min: Float32Array;
  max: Float32Array;
  bins: number;
  sigMin: number;
  sigMax: number;
}

export async function fetchSignal1D(
  trackId: string,
  chrom: string,
  start: number,
  end: number,
  bins: number,
  column?: string | null,
  signal?: AbortSignal
): Promise<Signal1DData> {
  const params = new URLSearchParams({
    chrom,
    start: String(Math.max(0, Math.floor(start))),
    end: String(Math.max(1, Math.ceil(end))),
    bins: String(Math.max(16, Math.min(4096, Math.round(bins)))),
  });
  if (column) params.set('column', column);
  const res = await fetch(`${BASE}/api/tracks/${encodeURIComponent(trackId)}/signal1d?${params}`, { signal });
  if (!res.ok) throw new Error(`Signal1D fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const n = Number(res.headers.get('X-Bins') || bins);
  const all = new Float32Array(buf);
  return {
    mean: all.subarray(0, n),
    min: all.subarray(n, 2 * n),
    max: all.subarray(2 * n, 3 * n),
    bins: n,
    sigMin: Number(res.headers.get('X-Signal-Min') || 0),
    sigMax: Number(res.headers.get('X-Signal-Max') || 0),
  };
}

export interface Features1DResponse {
  mode: 'intervals' | 'genes' | 'arcs';
  items: (IntervalItem | GeneItem | ArcItem)[];
  total?: number;
  truncated?: boolean;
}

export async function fetchFeatures1D(
  trackId: string,
  chrom: string,
  start: number,
  end: number,
  maxItems = 4000,
  signal?: AbortSignal
): Promise<Features1DResponse> {
  const params = new URLSearchParams({
    chrom,
    start: String(Math.max(0, Math.floor(start))),
    end: String(Math.max(1, Math.ceil(end))),
    max_items: String(maxItems),
  });
  const res = await fetch(`${BASE}/api/tracks/${encodeURIComponent(trackId)}/features1d?${params}`, { signal });
  if (!res.ok) throw new Error(`Features1D fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchFeatures2D(
  trackId: string,
  chrom: string,
  start: number,
  end: number,
  maxItems = 4000,
  signal?: AbortSignal
): Promise<{ items: ArcItem[] }> {
  const params = new URLSearchParams({
    chrom_x: chrom,
    chrom_y: chrom,
    start_x: String(Math.max(0, Math.floor(start))),
    end_x: String(Math.max(1, Math.ceil(end))),
    start_y: String(Math.max(0, Math.floor(start))),
    end_y: String(Math.max(1, Math.ceil(end))),
    max_items: String(maxItems),
  });
  const res = await fetch(`${BASE}/api/tracks/${encodeURIComponent(trackId)}/features2d?${params}`, { signal });
  if (!res.ok) throw new Error(`Features2D fetch failed: ${res.status}`);
  return res.json();
}
