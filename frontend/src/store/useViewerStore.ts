import { create } from 'zustand';
import { closeTrack, openGenomeTrack, openTrack } from '../api';
import { sharedCamera } from '../engine/camera';
import { sharedTileCache } from '../engine/tileCache';
import type { ChromInfo, MatrixMode, TrackConfig, TrackMetadata } from '../types';

const SIGNAL_PALETTE = ['#38bdf8', '#34d399', '#a78bfa', '#fbbf24', '#fb7185', '#2dd4bf', '#60a5fa'];
const OVERLAY_PALETTE = ['#22d3ee', '#facc15', '#4ade80', '#f472b6', '#fb923c'];

let nextPaletteIdx = 0;

function makeDefaultConfig(meta: TrackMetadata, globalMode: MatrixMode): TrackConfig {
  const isSigned =
    meta.value_min !== null && meta.value_max !== null && meta.value_min < 0 && meta.value_max > 0;
  const color = isSigned ? '#38bdf8' : SIGNAL_PALETTE[nextPaletteIdx % SIGNAL_PALETTE.length];
  const overlayColor = OVERLAY_PALETTE[nextPaletteIdx % OVERLAY_PALETTE.length];
  nextPaletteIdx++;

  const isLoopName = /loop|pair|arc/i.test(meta.name);
  const isTadName = /tad|domain/i.test(meta.name);

  let defaultHeight = 90;
  if (meta.track_kind === 'matrix2d') {
    defaultHeight = globalMode === 'triangle' ? 300 : 420;
  } else if (meta.track_kind === 'interval1d') {
    defaultHeight = meta.has_rgb ? 52 : isLoopName ? 82 : 64;
  } else if (meta.track_kind === 'gene1d') {
    defaultHeight = 110;
  } else if (meta.track_kind === 'feature2d') {
    defaultHeight = 90;
  }

  const defaultNorm =
    meta.normalizations.includes('balanced')
      ? 'balanced'
      : meta.normalizations.includes('KR')
        ? 'KR'
        : meta.normalizations[0] || 'raw';

  return {
    id: `${meta.track_id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    trackId: meta.track_id,
    meta,
    visible: true,
    height: defaultHeight,

    matrixMode: globalMode,
    norm: defaultNorm,
    colormap: defaultNorm === 'oe' ? 'bwr' : 'fall',
    logScale: true,
    autoContrast: true,
    vmin: 0.0001,
    vmax: 0.05,
    gamma: 1.0,
    compareMode: 'none',
    compareTrackId: null,
    compareTrackName: null,

    column: meta.default_column,
    signalStyle: 'area',
    color,
    negColor: '#f43f5e',
    autoY: true,
    yMin: meta.value_min ?? 0,
    yMax: meta.value_max ?? 1,

    bedStyle: isLoopName ? 'arcs' : 'blocks',
    overlayOnHeatmaps: meta.track_kind === 'feature2d' || isTadName,
    overlayColor,
  };
}

interface ViewerStore {
  tracks: TrackConfig[];
  chroms: ChromInfo[];
  sidebarOpen: boolean;
  globalMatrixMode: MatrixMode;
  squareSize: number; // 0 = auto-fit 1:1 square to viewport, >0 = user-resized 1:1 square px
  selectedGenome: string;
  toast: { message: string; kind: 'info' | 'error' } | null;

  setSidebarOpen: (open: boolean) => void;
  setSquareSize: (px: number) => void;
  setSelectedGenome: (genomeId: string) => void;
  setToast: (message: string, kind?: 'info' | 'error') => void;
  clearToast: () => void;

  addTrackFromMeta: (meta: TrackMetadata) => void;
  addTrackByPath: (path: string) => Promise<void>;
  addReferenceGeneTrack: (genomeId?: string) => Promise<void>;
  removeTrack: (id: string) => void;
  updateTrack: (id: string, patch: Partial<TrackConfig>) => void;
  reorderTracks: (fromIdx: number, toIdx: number) => void;
  moveTrack: (id: string, dir: -1 | 1) => void;
  setGlobalMatrixMode: (mode: MatrixMode) => void;
  clearAllTracks: () => void;

  exportSessionJSON: () => string;
  importSessionJSON: (raw: string) => Promise<void>;
}

export const useViewerStore = create<ViewerStore>((set, get) => ({
  tracks: [],
  chroms: [],
  sidebarOpen: true,
  globalMatrixMode: 'triangle',
  squareSize: 0,
  selectedGenome: 'ce11',
  toast: null,

  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSquareSize: (px) => set({ squareSize: Math.max(0, Math.round(px)) }),
  setSelectedGenome: (genomeId) => set({ selectedGenome: genomeId }),

  setToast: (message, kind = 'info') => {
    set({ toast: { message, kind } });
    window.setTimeout(() => {
      if (get().toast?.message === message) {
        set({ toast: null });
      }
    }, 4500);
  },

  clearToast: () => set({ toast: null }),

  addTrackFromMeta: (meta) => {
    const state = get();
    const cfg = makeDefaultConfig(meta, state.globalMatrixMode);

    // Merge chromosomes (prefer longer/authoritative matrix2d chrom lengths)
    const chromMap = new Map<string, number>();
    for (const c of state.chroms) {
      chromMap.set(c.name, c.length);
    }
    for (const c of meta.chroms) {
      const prev = chromMap.get(c.name) ?? 0;
      if (meta.track_kind === 'matrix2d' || c.length > prev) {
        chromMap.set(c.name, Math.max(prev, c.length));
      }
    }
    const mergedChroms: ChromInfo[] = Array.from(chromMap.entries()).map(([name, length]) => ({
      name,
      length,
    }));

    // If this is the first track (or first matrix2d track), initialize camera cleanly
    const hadTracks = state.tracks.length > 0;
    const hadMatrix = state.tracks.some((t) => t.meta.track_kind === 'matrix2d');
    if ((!hadTracks || (!hadMatrix && meta.track_kind === 'matrix2d')) && mergedChroms.length > 0) {
      // Prefer chrX if present (super convenient for C. elegans), else first chromosome
      const preferred =
        mergedChroms.find((c) => c.name.toLowerCase() === 'chrx' || c.name.toLowerCase() === 'x') ||
        mergedChroms[0];
      sharedCamera.setChrom(preferred.name, preferred.length, true);
    }

    // Place 2D matrices near the top, 1D tracks below
    let nextTracks: TrackConfig[];
    if (meta.track_kind === 'matrix2d') {
      const lastMatIdx = state.tracks.reduce(
        (acc, t, i) => (t.meta.track_kind === 'matrix2d' ? i : acc),
        -1
      );
      nextTracks = [
        ...state.tracks.slice(0, lastMatIdx + 1),
        cfg,
        ...state.tracks.slice(lastMatIdx + 1),
      ];
    } else {
      nextTracks = [...state.tracks, cfg];
    }

    set({ tracks: nextTracks, chroms: mergedChroms });
  },

  addTrackByPath: async (path: string) => {
    try {
      const meta = await openTrack(path);
      get().addTrackFromMeta(meta);
      get().setToast(`Added ${meta.name} (${meta.format_id})`, 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      get().setToast(msg, 'error');
    }
  },

  addReferenceGeneTrack: async (genomeId?: string) => {
    const gid = genomeId || get().selectedGenome;
    try {
      get().setToast(`Loading ${gid} consensus genes...`, 'info');
      const meta = await openGenomeTrack(gid);
      get().addTrackFromMeta(meta);
      get().setToast(`Added ${meta.name}`, 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      get().setToast(msg, 'error');
    }
  },

  removeTrack: (id) => {
    const state = get();
    const target = state.tracks.find((t) => t.id === id);
    const remaining = state.tracks.filter((t) => t.id !== id);
    set({ tracks: remaining });
    if (target) {
      const stillUsed = remaining.some(
        (t) => t.trackId === target.trackId || t.compareTrackId === target.trackId
      );
      if (!stillUsed) {
        sharedTileCache.clearTrack(target.trackId);
        void closeTrack(target.trackId);
      }
    }
  },

  updateTrack: (id, patch) => {
    set((s) => ({
      tracks: s.tracks.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, ...patch };
        // Smart defaults when switching comparison mode
        if (patch.compareMode && patch.compareMode !== t.compareMode) {
          if (patch.compareMode === 'split') {
            next.matrixMode = 'square';
            next.height = Math.max(t.height, 420);
            if (t.compareMode === 'log2ratio' || t.compareMode === 'diff') {
              next.colormap = t.norm === 'oe' ? 'bwr' : 'fall';
            }
          } else if (patch.compareMode === 'log2ratio') {
            next.colormap = 'bwr';
            next.vmax = 2.0;
            next.autoContrast = true;
          } else if (patch.compareMode === 'diff') {
            next.colormap = 'bwr';
            next.autoContrast = true;
          } else if (patch.compareMode === 'none') {
            next.colormap = next.norm === 'oe' ? 'bwr' : 'fall';
            next.autoContrast = true;
          }
        }
        // Smart colormap switch when toggling O/E
        if (patch.norm === 'oe' && t.norm !== 'oe' && next.compareMode === 'none') {
          next.colormap = 'bwr';
          next.vmax = 2.0;
        } else if (patch.norm && patch.norm !== 'oe' && t.norm === 'oe' && next.compareMode === 'none') {
          next.colormap = 'fall';
          next.autoContrast = true;
        }
        return next;
      }),
    }));
  },

  reorderTracks: (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    set((s) => {
      if (fromIdx < 0 || toIdx < 0 || fromIdx >= s.tracks.length || toIdx >= s.tracks.length) {
        return s;
      }
      const copy = [...s.tracks];
      const [moved] = copy.splice(fromIdx, 1);
      copy.splice(toIdx, 0, moved);
      return { tracks: copy };
    });
  },

  moveTrack: (id, dir) => {
    const idx = get().tracks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    get().reorderTracks(idx, idx + dir);
  },

  setGlobalMatrixMode: (mode) => {
    set((s) => ({
      globalMatrixMode: mode,
      tracks: s.tracks.map((t) =>
        t.meta.track_kind === 'matrix2d'
          ? { ...t, matrixMode: mode, height: mode === 'triangle' ? Math.min(t.height, 340) : Math.max(t.height, 400) }
          : t
      ),
    }));
  },

  clearAllTracks: () => {
    const tracks = get().tracks;
    set({ tracks: [] });
    const seen = new Set<string>();
    for (const t of tracks) {
      if (!seen.has(t.trackId)) {
        seen.add(t.trackId);
        sharedTileCache.clearTrack(t.trackId);
        void closeTrack(t.trackId);
      }
    }
  },

  exportSessionJSON: () => {
    const cam = sharedCamera.get();
    const payload = {
      version: 1,
      selectedGenome: get().selectedGenome,
      camera: {
        chrom: cam.chrom,
        startBp: Math.round(cam.startBp),
        endBp: Math.round(cam.endBp),
      },
      globalMatrixMode: get().globalMatrixMode,
      tracks: get().tracks.map((t) => ({
        path: t.meta.path,
        visible: t.visible,
        height: t.height,
        matrixMode: t.matrixMode,
        norm: t.norm,
        colormap: t.colormap,
        logScale: t.logScale,
        autoContrast: t.autoContrast,
        vmin: t.vmin,
        vmax: t.vmax,
        gamma: t.gamma,
        compareMode: t.compareMode,
        compareTrackId: t.compareTrackId,
        compareTrackName: t.compareTrackName,
        column: t.column,
        signalStyle: t.signalStyle,
        color: t.color,
        negColor: t.negColor,
        autoY: t.autoY,
        yMin: t.yMin,
        yMax: t.yMax,
        bedStyle: t.bedStyle,
        overlayOnHeatmaps: t.overlayOnHeatmaps,
        overlayColor: t.overlayColor,
      })),
    };
    return JSON.stringify(payload, null, 2);
  },

  importSessionJSON: async (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      get().clearAllTracks();
      if (parsed.selectedGenome) {
        set({ selectedGenome: parsed.selectedGenome });
      }
      if (parsed.globalMatrixMode) {
        set({ globalMatrixMode: parsed.globalMatrixMode });
      }
      for (const item of parsed.tracks || []) {
        const meta = await openTrack(item.path);
        get().addTrackFromMeta(meta);
        const added = [...get().tracks].reverse().find((t) => t.trackId === meta.track_id);
        if (added) {
          const { path: _p, ...rest } = item;
          get().updateTrack(added.id, rest);
        }
      }
      if (parsed.camera?.chrom) {
        const cInfo = get().chroms.find((c) => c.name === parsed.camera.chrom);
        sharedCamera.setChrom(
          parsed.camera.chrom,
          cInfo?.length ?? Math.max(parsed.camera.endBp || 1_000_000, 1_000_000),
          false
        );
        if (typeof parsed.camera.startBp === 'number' && typeof parsed.camera.endBp === 'number') {
          sharedCamera.setRange(parsed.camera.startBp, parsed.camera.endBp);
        }
      }
      get().setToast('Session restored', 'info');
    } catch (err) {
      get().setToast(`Invalid session file: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  },
}));
