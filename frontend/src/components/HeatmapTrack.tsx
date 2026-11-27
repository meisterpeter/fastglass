import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  GitCompareArrows,
  GripVertical,
  Settings2,
  Square,
  Triangle,
  X,
} from 'lucide-react';
import { fetchFeatures2D } from '../api';
import { formatBp, sharedCamera } from '../engine/camera';
import { drawHeatmapOverlays, type OverlayLayer } from '../engine/canvas1d';
import { COLORMAP_LIST, getColormapGradientCSS } from '../engine/colormaps';
import { sharedTileCache, type CachedTile } from '../engine/tileCache';
import {
  computeVisibleTiles,
  pickResolution,
  WebGLHeatmapRenderer,
  type TileDrawPair,
} from '../engine/webglHeatmap';
import { useViewerStore } from '../store/useViewerStore';
import type { ColormapId, CompareMode, TrackConfig } from '../types';

interface Props {
  track: TrackConfig;
  index: number;
  total: number;
  onDragStart: (idx: number) => void;
  onDragOver: (e: React.DragEvent, idx: number) => void;
  onDrop: (idx: number) => void;
}

const TILE_SIZE = 256;

const COMPARE_LABELS: Record<CompareMode, string> = {
  none: 'Single (A)',
  split: 'Split ▲A / ▼B',
  log2ratio: 'log2(A / B)',
  diff: 'Diff (A − B)',
};

function computeAutoRange(tiles: CachedTile[]): { vmin: number; vmax: number } {
  const diag = tiles.filter((t) => t.tx === t.ty && t.p98 > 0);
  const pool = diag.length > 0 ? diag : tiles.filter((t) => t.p98 > 0);
  const p98s = pool.map((t) => t.p98);
  if (p98s.length === 0) return { vmin: 0.0001, vmax: 0.05 };
  p98s.sort((a, b) => a - b);
  const refVal = p98s[Math.floor(p98s.length * 0.75)];
  const vmax = Math.max(refVal * 1.4, 1e-6);
  const vmin = Math.max(vmax * 0.002, 1e-7);
  return { vmin, vmax };
}

export const HeatmapTrack: React.FC<Props> = ({
  track,
  index,
  total,
  onDragStart,
  onDragOver,
  onDrop,
}) => {
  const updateTrack = useViewerStore((s) => s.updateTrack);
  const removeTrack = useViewerStore((s) => s.removeTrack);
  const moveTrack = useViewerStore((s) => s.moveTrack);
  const setSquareSize = useViewerStore((s) => s.setSquareSize);
  const allTracks = useViewerStore((s) => s.tracks);

  const containerRef = useRef<HTMLDivElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGLHeatmapRenderer | null>(null);
  const trackRef = useRef(track);
  trackRef.current = track;

  const overlaysRef = useRef<OverlayLayer[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [activeRes, setActiveRes] = useState<number>(track.meta.resolutions[0] || 10000);
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);
  const [glError, setGlError] = useState<string | null>(null);

  const dragRef = useRef<{ active: boolean; lastX: number }>({ active: false, lastX: 0 });
  const resizeRef = useRef<{ active: boolean; startY: number; startH: number }>({
    active: false,
    startY: 0,
    startH: 300,
  });

  // Other loaded 2D matrix tracks available for Split / Diff comparison
  const otherMatrices = allTracks.filter(
    (t) => t.meta.track_kind === 'matrix2d' && t.trackId !== track.trackId
  );
  // Deduplicate by trackId
  const compareCandidates = Array.from(
    new Map(otherMatrices.map((t) => [t.trackId, t])).values()
  );

  const overlayTracksKey = allTracks
    .filter((t) => t.visible && t.overlayOnHeatmaps && t.meta.track_kind !== 'matrix2d')
    .map((t) => `${t.trackId}:${t.overlayColor}`)
    .join('|');

  const renderNowRef = useRef<() => void>(() => {});
  renderNowRef.current = () => {
    const el = containerRef.current;
    const glCanvas = glCanvasRef.current;
    const ovCanvas = overlayCanvasRef.current;
    const renderer = rendererRef.current;
    const cfg = trackRef.current;
    if (!el || !glCanvas || !ovCanvas || !renderer || !cfg.visible) return;

    const rect = el.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (glCanvas.width !== pw || glCanvas.height !== ph) {
      glCanvas.width = pw;
      glCanvas.height = ph;
    }

    const cam = sharedCamera.get();
    const span = Math.max(1, cam.endBp - cam.startBp);
    const effCompare: CompareMode =
      cfg.compareMode !== 'none' && cfg.compareTrackId ? cfg.compareMode : 'none';
    const effMode = effCompare === 'split' ? 'square' : cfg.matrixMode;

    const partnerTrack = cfg.compareTrackId
      ? useViewerStore.getState().tracks.find((t) => t.trackId === cfg.compareTrackId)
      : undefined;
    const res = pickResolution(
      cfg.meta.resolutions,
      span,
      w,
      effCompare !== 'none' ? partnerTrack?.meta.resolutions : undefined
    );
    setActiveRes((prev) => (prev === res ? prev : res));

    const needed = computeVisibleTiles(
      cam.startBp,
      cam.endBp,
      cam.chromLength,
      res,
      TILE_SIZE,
      effMode,
      w,
      h
    );

    const keepKeysA = new Set<string>();
    const keepKeysB = new Set<string>();
    const targetPairs: TileDrawPair[] = [];
    const targetTilesA: CachedTile[] = [];
    const targetTilesB: CachedTile[] = [];
    let missingAny = false;

    const normB =
      partnerTrack && !partnerTrack.meta.normalizations.includes(cfg.norm)
        ? partnerTrack.meta.normalizations[0] || 'raw'
        : cfg.norm;

    for (const { tx, ty } of needed) {
      const keyA = `${cfg.trackId}|${cam.chrom}|${res}|${tx}|${ty}|${cfg.norm}`;
      keepKeysA.add(keyA);
      const tileA = sharedTileCache.get(keyA);
      if (!tileA) {
        missingAny = true;
        sharedTileCache.request(
          cfg.trackId,
          cam.chrom,
          res,
          tx,
          ty,
          cfg.norm,
          () => requestAnimationFrame(() => renderNowRef.current()),
          TILE_SIZE
        );
      }

      let tileB: CachedTile | undefined;
      if (effCompare !== 'none' && cfg.compareTrackId) {
        const keyB = `${cfg.compareTrackId}|${cam.chrom}|${res}|${tx}|${ty}|${normB}`;
        keepKeysB.add(keyB);
        tileB = sharedTileCache.get(keyB);
        if (!tileB) {
          missingAny = true;
          sharedTileCache.request(
            cfg.compareTrackId,
            cam.chrom,
            res,
            tx,
            ty,
            normB,
            () => requestAnimationFrame(() => renderNowRef.current()),
            TILE_SIZE
          );
        }
      }

      if (tileA) {
        targetTilesA.push(tileA);
        if (tileB) targetTilesB.push(tileB);
        targetPairs.push({ tileA, tileB });
      }
    }
    sharedTileCache.abortExcept(cfg.trackId, keepKeysA);
    if (effCompare !== 'none' && cfg.compareTrackId) {
      sharedTileCache.abortExcept(cfg.compareTrackId, keepKeysB);
    }

    // Progressive coarse fallback while finer tiles stream in
    const drawPairs: TileDrawPair[] = [...targetPairs];
    if (missingAny) {
      const coarseA = sharedTileCache
        .getLoadedForTrack(cfg.trackId, cam.chrom, cfg.norm)
        .filter((t) => t.resolution > res);
      for (const tA of coarseA) {
        let tB: CachedTile | undefined;
        if (effCompare !== 'none' && cfg.compareTrackId) {
          const kB = `${cfg.compareTrackId}|${cam.chrom}|${tA.resolution}|${tA.tx}|${tA.ty}|${normB}`;
          tB = sharedTileCache.get(kB);
        }
        drawPairs.push({ tileA: tA, tileB: tB });
      }
    }

    // Compute effective contrast limits
    const isOE = cfg.norm === 'oe';
    const poolA = targetTilesA.length > 0 ? targetTilesA : drawPairs.map((p) => p.tileA);
    const poolB =
      targetTilesB.length > 0
        ? targetTilesB
        : drawPairs.map((p) => p.tileB).filter((b): b is CachedTile => Boolean(b));

    let vmin = cfg.vmin;
    let vmax = cfg.vmax;
    let vminB = cfg.vmin;
    let vmaxB = cfg.vmax;

    if (effCompare === 'log2ratio') {
      const autoA = computeAutoRange(poolA);
      vmin = Math.max(autoA.vmax * 0.005, 1e-4); // pseudocount eps for log2((A+eps)/(B+eps))
      vmax = cfg.autoContrast ? 2.0 : Math.max(Math.abs(cfg.vmax), 0.25);
    } else if (effCompare === 'diff') {
      if (cfg.autoContrast) {
        const autoA = computeAutoRange(poolA);
        vmax = Math.max(autoA.vmax * 0.6, 1e-4);
      } else {
        vmax = Math.max(Math.abs(cfg.vmax), 1e-5);
      }
      vmin = -vmax;
    } else if (isOE) {
      vmax = cfg.autoContrast ? 2.0 : cfg.vmax;
      vmaxB = vmax;
    } else if (cfg.autoContrast) {
      const aR = computeAutoRange(poolA);
      vmin = aR.vmin;
      vmax = aR.vmax;
      if (effCompare === 'split' && poolB.length > 0) {
        const bR = computeAutoRange(poolB);
        vminB = bR.vmin;
        vmaxB = bR.vmax;
      } else {
        vminB = vmin;
        vmaxB = vmax;
      }
    } else {
      vminB = vmin;
      vmaxB = vmax;
    }

    renderer.render(drawPairs, {
      startBp: cam.startBp,
      endBp: cam.endBp,
      chromLength: cam.chromLength,
      mode: effMode,
      compareMode: effCompare,
      colormap: cfg.colormap,
      logScale: cfg.logScale,
      isOE,
      vmin,
      vmax,
      vminB,
      vmaxB,
      gamma: cfg.gamma,
    });

    const splitInfo =
      effCompare === 'split' && cfg.compareTrackName
        ? { upperLabel: cfg.meta.name, lowerLabel: cfg.compareTrackName }
        : null;

    drawHeatmapOverlays(
      ovCanvas,
      w,
      h,
      cam.startBp,
      cam.endBp,
      effMode,
      overlaysRef.current,
      cam.hoverBp,
      cam.hoverBp2,
      splitInfo
    );
  };

  useEffect(() => {
    const canvas = glCanvasRef.current;
    if (!canvas) return;
    let renderer: WebGLHeatmapRenderer | null = null;
    try {
      renderer = new WebGLHeatmapRenderer(canvas);
      rendererRef.current = renderer;
      setGlError(null);
      renderNowRef.current();
    } catch (err) {
      setGlError(err instanceof Error ? err.message : String(err));
      return;
    }

    const unsub = sharedCamera.subscribe(() => renderNowRef.current());
    const ro = new ResizeObserver(() => renderNowRef.current());
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      unsub();
      ro.disconnect();
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    renderNowRef.current();
  }, [
    track.visible,
    track.height,
    track.matrixMode,
    track.norm,
    track.colormap,
    track.logScale,
    track.autoContrast,
    track.vmin,
    track.vmax,
    track.gamma,
    track.compareMode,
    track.compareTrackId,
  ]);

  // Fetch 2D overlay features when camera moves or overlay tracks change
  useEffect(() => {
    let controller = new AbortController();
    let timer: number | null = null;

    const loadOverlays = () => {
      controller.abort();
      controller = new AbortController();
      const activeOv = useViewerStore
        .getState()
        .tracks.filter((t) => t.visible && t.overlayOnHeatmaps && t.meta.track_kind !== 'matrix2d');
      if (activeOv.length === 0) {
        overlaysRef.current = [];
        renderNowRef.current();
        return;
      }
      const cam = sharedCamera.get();
      Promise.all(
        activeOv.map(async (ov) => {
          try {
            const res = await fetchFeatures2D(
              ov.trackId,
              cam.chrom,
              cam.startBp,
              cam.endBp,
              3000,
              controller.signal
            );
            return { color: ov.overlayColor, items: res.items };
          } catch {
            return { color: ov.overlayColor, items: [] };
          }
        })
      ).then((layers) => {
        overlaysRef.current = layers;
        renderNowRef.current();
      });
    };

    loadOverlays();
    const unsub = sharedCamera.subscribe((_st, reason) => {
      if (reason !== 'move') return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(loadOverlays, 120);
    });
    return () => {
      unsub();
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [overlayTracksKey]);

  // Attach non-passive wheel listener so preventDefault works cleanly with 0 console warnings
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const frac = (e.clientX - rect.left) / rect.width;
      const factor = e.deltaY > 0 ? 1.22 : 0.82;
      sharedCamera.zoomAtFraction(frac, factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { active: true, lastX: e.clientX };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    if (dragRef.current.active) {
      const dx = e.clientX - dragRef.current.lastX;
      dragRef.current.lastX = e.clientX;
      sharedCamera.panByPixels(dx, rect.width);
      return;
    }

    const cam = sharedCamera.get();
    const span = cam.endBp - cam.startBp;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const effMode = track.compareMode === 'split' ? 'square' : track.matrixMode;

    if (effMode === 'triangle') {
      const mid = cam.startBp + (x / rect.width) * span;
      const upPx = Math.max(0, rect.height - y);
      const sep = (2 * upPx / rect.width) * span;
      const g1 = mid - 0.5 * sep;
      const g2 = mid + 0.5 * sep;
      sharedCamera.setHover(g1, g2);
      setHoverInfo(`${formatBp(g1)} ↔ ${formatBp(g2)} (Δ ${formatBp(sep)})`);
    } else {
      const g1 = cam.startBp + (x / rect.width) * span;
      const g2 = cam.startBp + (y / rect.height) * span;
      sharedCamera.setHover(g1, g2);
      setHoverInfo(`${formatBp(g1)} × ${formatBp(g2)} (Δ ${formatBp(Math.abs(g2 - g1))})`);
    }
  };

  const handleMouseUp = () => {
    dragRef.current.active = false;
  };

  const handleMouseLeave = () => {
    dragRef.current.active = false;
    setHoverInfo(null);
    sharedCamera.setHover(null, null);
  };

  const effCompareActive = track.compareMode !== 'none' && Boolean(track.compareTrackId);
  const isSquareMode = track.matrixMode === 'square' || (track.compareMode === 'split' && Boolean(track.compareTrackId));

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const curRect = containerRef.current?.getBoundingClientRect();
    const startH = curRect ? Math.round(curRect.height) : track.height;
    resizeRef.current = { active: true, startY: e.clientY, startH };
    const onMove = (me: MouseEvent) => {
      if (!resizeRef.current.active) return;
      const delta = me.clientY - resizeRef.current.startY;
      if (isSquareMode) {
        setSquareSize(Math.max(300, resizeRef.current.startH + delta));
      } else {
        const nextH = Math.max(120, Math.min(900, resizeRef.current.startH + delta));
        updateTrack(track.id, { height: nextH });
      }
    };
    const onUp = () => {
      resizeRef.current.active = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      data-export-track-id={track.id}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={() => onDrop(index)}
      className="relative w-full border-b border-slate-800 bg-slate-950 group"
      style={
        !track.visible
          ? { height: 32 }
          : isSquareMode
            ? { width: '100%', aspectRatio: '1 / 1' }
            : { height: track.height }
      }
    >
      {/* Floating slim track header */}
      <div className="absolute top-1.5 left-2 right-2 z-10 flex items-center justify-between gap-2 pointer-events-none">
        <div
          draggable
          onDragStart={() => onDragStart(index)}
          className="pointer-events-auto flex items-center gap-1.5 min-w-0 bg-slate-900/88 backdrop-blur-sm border border-slate-700/80 rounded-md px-2 py-0.5 text-xs shadow-sm"
        >
          <GripVertical className="w-3.5 h-3.5 text-slate-500 cursor-grab shrink-0" />
          <span className="text-[9px] font-bold px-1 py-0.2 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 shrink-0">
            {effCompareActive ? track.compareMode.toUpperCase() : track.meta.format_id.toUpperCase()}
          </span>
          <span className="font-medium text-slate-100 truncate min-w-0" title={track.meta.path}>
            {effCompareActive && track.compareTrackName
              ? `${track.meta.name} vs ${track.compareTrackName}`
              : track.meta.name}
          </span>
          <span className="text-[10px] font-mono text-sky-300 bg-sky-500/10 px-1.5 rounded whitespace-nowrap shrink-0">
            {formatBp(activeRes)}
          </span>

          {track.meta.normalizations.length > 1 && (
            <select
              value={track.norm}
              onChange={(e) => updateTrack(track.id, { norm: e.target.value })}
              className="bg-slate-800/90 border border-slate-700 rounded px-1 py-0 text-[10px] text-slate-200 focus:outline-none shrink-0"
              title="Normalization"
            >
              {track.meta.normalizations.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Live 2D hover coordinate pill */}
        {hoverInfo && track.visible && (
          <div className="hidden lg:block shrink-0 whitespace-nowrap bg-slate-900/85 backdrop-blur-sm border border-slate-700/70 rounded px-2 py-0.5 text-[10px] font-mono text-sky-300">
            {hoverInfo}
          </div>
        )}

        {/* Right controls */}
        <div className="pointer-events-auto shrink-0 flex items-center gap-1 bg-slate-900/88 backdrop-blur-sm border border-slate-700/80 rounded-md px-1 py-0.5 shadow-sm">
          {/* Split / Diff Compare Popover Trigger */}
          <button
            onClick={() => {
              setCompareOpen((v) => !v);
              setSettingsOpen(false);
            }}
            className={`px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1 transition-colors ${
              effCompareActive || compareOpen
                ? 'bg-violet-500/25 text-violet-200 border border-violet-500/40'
                : 'hover:bg-slate-800 text-slate-300 hover:text-white'
            }`}
            title="Compare with another Hi-C matrix (Split diagonal, log2 ratio, or difference)"
          >
            <GitCompareArrows className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">
              {effCompareActive ? COMPARE_LABELS[track.compareMode] : 'Compare'}
            </span>
          </button>

          <button
            onClick={() =>
              updateTrack(track.id, {
                matrixMode: track.matrixMode === 'triangle' ? 'square' : 'triangle',
                ...(track.compareMode === 'split' ? { compareMode: 'none' } : {}),
              })
            }
            className="p-1 rounded hover:bg-slate-800 text-slate-300 hover:text-sky-300"
            title={`Switch to ${track.matrixMode === 'triangle' ? 'Square' : 'Triangle'} mode`}
          >
            {track.matrixMode === 'triangle' && track.compareMode !== 'split' ? (
              <Triangle className="w-3.5 h-3.5" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={() => {
              setSettingsOpen((v) => !v);
              setCompareOpen(false);
            }}
            className={`p-1 rounded transition-colors ${
              settingsOpen
                ? 'bg-sky-500/25 text-sky-300'
                : 'hover:bg-slate-800 text-slate-300 hover:text-white'
            }`}
            title="Colormap & contrast settings"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          {index > 0 && (
            <button
              onClick={() => moveTrack(track.id, -1)}
              className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
              title="Move up"
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
          )}
          {index < total - 1 && (
            <button
              onClick={() => moveTrack(track.id, 1)}
              className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
              title="Move down"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => updateTrack(track.id, { visible: !track.visible })}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
            title={track.visible ? 'Collapse track' : 'Show track'}
          >
            {track.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => removeTrack(track.id)}
            className="p-1 rounded hover:bg-rose-500/25 text-slate-400 hover:text-rose-300"
            title="Remove track"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Compare (Split / Log2 Ratio / Diff) Popover */}
      {compareOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute top-10 right-2 z-30 w-72 bg-slate-900/98 border border-slate-700 rounded-lg shadow-2xl p-3 space-y-2.5 text-xs"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-violet-300">
              Matrix Comparison
            </span>
            {effCompareActive && (
              <button
                onClick={() =>
                  updateTrack(track.id, {
                    compareMode: 'none',
                    compareTrackId: null,
                    compareTrackName: null,
                  })
                }
                className="text-[10px] text-slate-400 hover:text-white underline"
              >
                Reset to Single
              </button>
            )}
          </div>

          {compareCandidates.length === 0 ? (
            <div className="text-[11px] text-slate-400 leading-relaxed bg-slate-950/70 border border-slate-800 rounded p-2">
              Open a second <span className="font-mono text-slate-200">.mcool / .cool / .hic</span>{' '}
              track from the left sidebar to enable Split Upper/Lower Diagonal or Differential
              heatmaps.
            </div>
          ) : (
            <>
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">
                  Compare against Matrix B
                </label>
                <select
                  value={track.compareTrackId || ''}
                  onChange={(e) => {
                    const tid = e.target.value || null;
                    const found = compareCandidates.find((c) => c.trackId === tid);
                    updateTrack(track.id, {
                      compareTrackId: tid,
                      compareTrackName: found?.meta.name ?? null,
                      compareMode: tid
                        ? track.compareMode === 'none'
                          ? 'split'
                          : track.compareMode
                        : 'none',
                    });
                  }}
                  className="w-full h-7 bg-slate-950 border border-slate-700 rounded px-2 text-xs text-slate-100 focus:outline-none focus:border-violet-400"
                >
                  <option value="">-- Select second Hi-C matrix --</option>
                  {compareCandidates.map((c) => (
                    <option key={c.trackId} value={c.trackId}>
                      {c.meta.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] text-slate-400 block mb-1">Comparison Mode</label>
                <div className="grid grid-cols-2 gap-1">
                  {(['none', 'split', 'log2ratio', 'diff'] as CompareMode[]).map((mode) => (
                    <button
                      key={mode}
                      disabled={mode !== 'none' && !track.compareTrackId && compareCandidates.length === 0}
                      onClick={() => {
                        const chosenB =
                          track.compareTrackId || compareCandidates[0]?.trackId || null;
                        const chosenName =
                          track.compareTrackName || compareCandidates[0]?.meta.name || null;
                        updateTrack(track.id, {
                          compareMode: mode,
                          compareTrackId: mode === 'none' ? null : chosenB,
                          compareTrackName: mode === 'none' ? null : chosenName,
                        });
                      }}
                      className={`px-2 py-1.5 rounded border text-[11px] transition-colors ${
                        track.compareMode === mode
                          ? 'bg-violet-500/25 border-violet-400 text-violet-100'
                          : 'border-slate-800 hover:border-slate-700 text-slate-300'
                      }`}
                    >
                      {COMPARE_LABELS[mode]}
                    </button>
                  ))}
                </div>
              </div>

              {effCompareActive && (
                <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-800">
                  {track.compareMode === 'split' && (
                    <>Upper triangle = <strong className="text-slate-200">{track.meta.name}</strong>; Lower = <strong className="text-slate-200">{track.compareTrackName}</strong>.</>
                  )}
                  {track.compareMode === 'log2ratio' && (
                    <>Red = enriched in <strong className="text-slate-200">{track.meta.name}</strong>; Blue = enriched in <strong className="text-slate-200">{track.compareTrackName}</strong>. Works in Triangle &amp; Square!</>
                  )}
                  {track.compareMode === 'diff' && (
                    <>Red = A &gt; B; Blue = B &gt; A (linear subtraction). Works in Triangle &amp; Square!</>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Inline GPU Style Popover */}
      {settingsOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute top-10 right-2 z-30 w-64 bg-slate-900/98 border border-slate-700 rounded-lg shadow-2xl p-3 space-y-2.5 text-xs"
        >
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-400 block mb-1">
              Colormap
            </label>
            <div className="grid grid-cols-1 gap-1">
              {COLORMAP_LIST.map((cm) => (
                <button
                  key={cm.id}
                  onClick={() => updateTrack(track.id, { colormap: cm.id as ColormapId })}
                  className={`flex items-center justify-between px-2 py-1 rounded border text-[11px] ${
                    track.colormap === cm.id
                      ? 'border-sky-400 bg-sky-500/15 text-white'
                      : 'border-slate-800 hover:border-slate-700 text-slate-300'
                  }`}
                >
                  <span>{cm.label}</span>
                  <span
                    className="w-16 h-2.5 rounded-sm"
                    style={{ background: getColormapGradientCSS(cm.id) }}
                  />
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between pt-1 border-t border-slate-800">
            <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={track.logScale}
                onChange={(e) => updateTrack(track.id, { logScale: e.target.checked })}
                className="accent-sky-500"
              />
              <span>Log scale</span>
            </label>
            <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={track.autoContrast}
                onChange={(e) => updateTrack(track.id, { autoContrast: e.target.checked })}
                className="accent-sky-500"
              />
              <span>Auto contrast</span>
            </label>
          </div>

          {!track.autoContrast && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-slate-400 block">Min</label>
                <input
                  type="number"
                  step="any"
                  value={track.vmin}
                  onChange={(e) => updateTrack(track.id, { vmin: Number(e.target.value) })}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block">
                  {track.norm === 'oe' || track.compareMode === 'log2ratio' || track.compareMode === 'diff'
                    ? '± Sym Lim'
                    : 'Max'}
                </label>
                <input
                  type="number"
                  step="any"
                  value={track.vmax}
                  onChange={(e) => updateTrack(track.id, { vmax: Number(e.target.value) })}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono"
                />
              </div>
            </div>
          )}

          <div>
            <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
              <span>Contrast / Gamma</span>
              <span className="font-mono text-slate-300">{track.gamma.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0.25"
              max="2.5"
              step="0.05"
              value={track.gamma}
              onChange={(e) => updateTrack(track.id, { gamma: Number(e.target.value) })}
              className="w-full accent-sky-500"
            />
          </div>
        </div>
      )}

      {/* WebGL2 + 2D Overlay Canvases (kept mounted so GPU textures stay warm on collapse/expand) */}
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onDoubleClick={() => sharedCamera.zoomAtFraction(0.5, 0.5)}
        className={`w-full h-full relative cursor-grab active:cursor-grabbing overflow-hidden ${
          track.visible ? 'block' : 'hidden'
        }`}
      >
        {glError ? (
          <div className="w-full h-full flex items-center justify-center p-4 text-xs text-rose-300 font-mono">
            WebGL2 Error: {glError}
          </div>
        ) : (
          <>
            <canvas ref={glCanvasRef} data-export-role="webgl" className="w-full h-full block" />
            <canvas
              ref={overlayCanvasRef}
              data-export-role="overlay"
              className="w-full h-full block absolute inset-0 pointer-events-none"
            />
          </>
        )}
      </div>

      {/* Bottom resize handle */}
      {track.visible && (
        <div
          onMouseDown={startResize}
          className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-sky-500/40 transition-colors z-10"
          title="Drag to resize track height"
        />
      )}
    </div>
  );
};
