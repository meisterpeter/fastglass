import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  GripVertical,
  Layers,
  Settings2,
  X,
} from 'lucide-react';
import {
  fetchFeatures1D,
  fetchSignal1D,
  type Features1DResponse,
  type Signal1DData,
} from '../api';
import { sharedCamera } from '../engine/camera';
import {
  drawArcTrack,
  drawGeneTrack,
  drawIntervalTrack,
  drawSignalTrack,
} from '../engine/canvas1d';
import { useViewerStore } from '../store/useViewerStore';
import type { ArcItem, BedStyle, GeneItem, IntervalItem, SignalStyle, TrackConfig } from '../types';

interface Props {
  track: TrackConfig;
  index: number;
  total: number;
  onDragStart: (idx: number) => void;
  onDragOver: (e: React.DragEvent, idx: number) => void;
  onDrop: (idx: number) => void;
}

const BADGE_COLORS: Record<string, string> = {
  bigwig: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
  bedgraph: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  tabular: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  bed: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  bigbed: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  gtf: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  gff3: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  refgene: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  bedpe: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30',
};

export const OneDTrack: React.FC<Props> = ({
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

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef(track);
  trackRef.current = track;

  const signalRef = useRef<{ start: number; end: number; chrom: string; data: Signal1DData } | null>(
    null
  );
  const featRef = useRef<Features1DResponse | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const dragRef = useRef<{ active: boolean; lastX: number }>({ active: false, lastX: 0 });
  const resizeRef = useRef<{ active: boolean; startY: number; startH: number }>({
    active: false,
    startY: 0,
    startH: 88,
  });

  const paintRef = useRef<() => void>(() => {});
  paintRef.current = () => {
    const el = containerRef.current;
    const canvas = canvasRef.current;
    const cfg = trackRef.current;
    if (!el || !canvas || !cfg.visible) return;
    const rect = el.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const cam = sharedCamera.get();

    if (cfg.meta.track_kind === 'signal1d') {
      drawSignalTrack(
        canvas,
        w,
        h,
        signalRef.current?.data ?? null,
        cam.startBp,
        cam.endBp,
        cam.hoverBp,
        {
          style: cfg.signalStyle,
          color: cfg.color,
          negColor: cfg.negColor,
          autoY: cfg.autoY,
          yMin: cfg.yMin,
          yMax: cfg.yMax,
        }
      );
    } else if (cfg.meta.track_kind === 'gene1d') {
      const items = (featRef.current?.items as GeneItem[]) || [];
      drawGeneTrack(canvas, w, h, items, cam.startBp, cam.endBp, cam.hoverBp, cfg.color);
    } else if (cfg.meta.track_kind === 'feature2d') {
      const items = (featRef.current?.items as ArcItem[]) || [];
      drawArcTrack(canvas, w, h, items, cam.startBp, cam.endBp, cam.hoverBp, cfg.color);
    } else {
      const items = (featRef.current?.items as IntervalItem[]) || [];
      drawIntervalTrack(canvas, w, h, items, cam.startBp, cam.endBp, cam.hoverBp, {
        color: cfg.color,
        bedStyle: cfg.bedStyle,
        hasRgb: cfg.meta.has_rgb,
      });
    }
  };

  // Data fetching + camera subscriptions
  useEffect(() => {
    let controller = new AbortController();
    let timer: number | null = null;

    const loadData = () => {
      const el = containerRef.current;
      const cfg = trackRef.current;
      if (!el || !cfg.visible) return;
      const width = Math.max(120, Math.round(el.getBoundingClientRect().width));
      const cam = sharedCamera.get();

      controller.abort();
      controller = new AbortController();
      const sig = controller.signal;

      if (cfg.meta.track_kind === 'signal1d') {
        const bins = Math.min(2048, Math.max(128, Math.round(width)));
        fetchSignal1D(cfg.trackId, cam.chrom, cam.startBp, cam.endBp, bins, cfg.column, sig)
          .then((data) => {
            signalRef.current = { start: cam.startBp, end: cam.endBp, chrom: cam.chrom, data };
            paintRef.current();
          })
          .catch(() => {});
      } else {
        fetchFeatures1D(cfg.trackId, cam.chrom, cam.startBp, cam.endBp, 4500, sig)
          .then((res) => {
            featRef.current = res;
            paintRef.current();
          })
          .catch(() => {});
      }
    };

    loadData();
    const unsub = sharedCamera.subscribe((_st, reason) => {
      paintRef.current();
      if (reason === 'move') {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(loadData, 55);
      }
    });
    const ro = new ResizeObserver(() => {
      paintRef.current();
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(loadData, 90);
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      unsub();
      ro.disconnect();
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [track.trackId, track.visible, track.column]);

  // Repaint on style changes
  useEffect(() => {
    paintRef.current();
  }, [
    track.height,
    track.signalStyle,
    track.color,
    track.negColor,
    track.autoY,
    track.yMin,
    track.yMax,
    track.bedStyle,
  ]);

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
  }, [track.visible]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { active: true, lastX: e.clientX };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    if (dragRef.current.active) {
      const dx = e.clientX - dragRef.current.lastX;
      dragRef.current.lastX = e.clientX;
      sharedCamera.panByPixels(dx, rect.width);
      return;
    }
    const cam = sharedCamera.get();
    const frac = (e.clientX - rect.left) / rect.width;
    sharedCamera.setHover(cam.startBp + frac * (cam.endBp - cam.startBp), null);
  };

  const handleMouseUp = () => {
    dragRef.current.active = false;
  };

  const handleMouseLeave = () => {
    dragRef.current.active = false;
    sharedCamera.setHover(null, null);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { active: true, startY: e.clientY, startH: track.height };
    const onMove = (me: MouseEvent) => {
      if (!resizeRef.current.active) return;
      const nextH = Math.max(38, Math.min(420, resizeRef.current.startH + (me.clientY - resizeRef.current.startY)));
      updateTrack(track.id, { height: nextH });
    };
    const onUp = () => {
      resizeRef.current.active = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const canOverlay = Boolean(track.meta.extra?.can_overlay_2d);
  const badgeCls = BADGE_COLORS[track.meta.format_id] || 'bg-slate-700 text-slate-200 border-slate-600';

  return (
    <div
      data-export-track-id={track.id}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={() => onDrop(index)}
      className="relative w-full border-b border-slate-800/90 bg-[#0b1120] group"
      style={{ height: track.visible ? track.height : 30 }}
    >
      {/* Floating compact header */}
      <div className="absolute top-1 left-2 right-2 z-10 flex items-center justify-between gap-2 pointer-events-none">
        <div
          draggable
          onDragStart={() => onDragStart(index)}
          className="pointer-events-auto flex items-center gap-1.5 min-w-0 bg-slate-900/85 backdrop-blur-sm border border-slate-800 rounded px-1.5 py-0.5 text-[11px]"
        >
          <GripVertical className="w-3 h-3 text-slate-500 cursor-grab shrink-0" />
          <span className={`text-[9px] font-bold px-1 rounded border shrink-0 ${badgeCls}`}>
            {track.meta.format_id.toUpperCase()}
          </span>
          <span className="font-medium text-slate-200 truncate min-w-0" title={track.meta.path}>
            {track.meta.name}
          </span>

          {/* Generic tabular column selector right in header */}
          {track.meta.columns.length > 0 && (
            <select
              value={track.column || track.meta.default_column || ''}
              onChange={(e) => updateTrack(track.id, { column: e.target.value })}
              className="bg-slate-800 border border-slate-700 rounded px-1.5 py-0 text-[10px] font-mono text-amber-300 focus:outline-none focus:border-sky-500 shrink-0 max-w-[140px]"
              title="Select numeric signal column"
            >
              {track.meta.columns.map((col) => (
                <option key={col} value={col}>
                  {col}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Right controls */}
        <div className="pointer-events-auto shrink-0 flex items-center gap-0.5 bg-slate-900/85 backdrop-blur-sm border border-slate-800 rounded px-1 py-0.5">
          {canOverlay && (
            <button
              onClick={() =>
                updateTrack(track.id, { overlayOnHeatmaps: !track.overlayOnHeatmaps })
              }
              className={`px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1 transition-colors ${
                track.overlayOnHeatmaps
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
              title="Overlay TADs/loops directly on 2D Hi-C heatmaps"
            >
              <Layers className="w-3 h-3" />
              <span className="hidden sm:inline">2D</span>
            </button>
          )}

          <button
            onClick={() => setSettingsOpen((v) => !v)}
            className={`p-1 rounded transition-colors ${
              settingsOpen
                ? 'bg-sky-500/25 text-sky-300'
                : 'hover:bg-slate-800 text-slate-400 hover:text-white'
            }`}
            title="Track style settings"
          >
            <Settings2 className="w-3 h-3" />
          </button>

          {index > 0 && (
            <button
              onClick={() => moveTrack(track.id, -1)}
              className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
              title="Move up"
            >
              <ChevronUp className="w-3 h-3" />
            </button>
          )}
          {index < total - 1 && (
            <button
              onClick={() => moveTrack(track.id, 1)}
              className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
              title="Move down"
            >
              <ChevronDown className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={() => updateTrack(track.id, { visible: !track.visible })}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
            title={track.visible ? 'Collapse track' : 'Show track'}
          >
            {track.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          </button>
          <button
            onClick={() => removeTrack(track.id)}
            className="p-1 rounded hover:bg-rose-500/25 text-slate-400 hover:text-rose-300"
            title="Remove track"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Inline Style Popover */}
      {settingsOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute top-8 right-2 z-30 w-60 bg-slate-900/98 border border-slate-700 rounded-lg shadow-2xl p-3 space-y-2.5 text-xs"
        >
          {track.meta.track_kind === 'signal1d' && (
            <>
              <div>
                <label className="text-[10px] uppercase text-slate-400 block mb-1">Plot Style</label>
                <div className="grid grid-cols-3 gap-1">
                  {(['area', 'line', 'bar'] as SignalStyle[]).map((st) => (
                    <button
                      key={st}
                      onClick={() => updateTrack(track.id, { signalStyle: st })}
                      className={`py-1 rounded border text-[11px] capitalize ${
                        track.signalStyle === st
                          ? 'bg-sky-500/20 border-sky-400 text-sky-200'
                          : 'border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
                  <span>Pos</span>
                  <input
                    type="color"
                    value={track.color}
                    onChange={(e) => updateTrack(track.id, { color: e.target.value })}
                    className="w-6 h-5 bg-transparent border-0 cursor-pointer"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
                  <span>Neg</span>
                  <input
                    type="color"
                    value={track.negColor}
                    onChange={(e) => updateTrack(track.id, { negColor: e.target.value })}
                    className="w-6 h-5 bg-transparent border-0 cursor-pointer"
                  />
                </label>
              </div>

              <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={track.autoY}
                  onChange={(e) => updateTrack(track.id, { autoY: e.target.checked })}
                  className="accent-sky-500"
                />
                <span>Auto Y-axis range</span>
              </label>

              {!track.autoY && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-slate-400 block">Y min</label>
                    <input
                      type="number"
                      step="any"
                      value={track.yMin}
                      onChange={(e) => updateTrack(track.id, { yMin: Number(e.target.value) })}
                      className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-400 block">Y max</label>
                    <input
                      type="number"
                      step="any"
                      value={track.yMax}
                      onChange={(e) => updateTrack(track.id, { yMax: Number(e.target.value) })}
                      className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono"
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {track.meta.track_kind === 'interval1d' && (
            <>
              <div>
                <label className="text-[10px] uppercase text-slate-400 block mb-1">Display</label>
                <div className="grid grid-cols-2 gap-1">
                  {(['blocks', 'arcs'] as BedStyle[]).map((st) => (
                    <button
                      key={st}
                      onClick={() => updateTrack(track.id, { bedStyle: st })}
                      className={`py-1 rounded border text-[11px] capitalize ${
                        track.bedStyle === st
                          ? 'bg-sky-500/20 border-sky-400 text-sky-200'
                          : 'border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center justify-between text-[11px] text-slate-300">
                <span>Track color</span>
                <input
                  type="color"
                  value={track.color}
                  onChange={(e) => updateTrack(track.id, { color: e.target.value })}
                  className="w-7 h-5 bg-transparent border-0 cursor-pointer"
                />
              </label>
            </>
          )}

          {canOverlay && (
            <label className="flex items-center justify-between text-[11px] text-slate-300 pt-1 border-t border-slate-800">
              <span>2D Overlay color</span>
              <input
                type="color"
                value={track.overlayColor}
                onChange={(e) => updateTrack(track.id, { overlayColor: e.target.value })}
                className="w-7 h-5 bg-transparent border-0 cursor-pointer"
              />
            </label>
          )}

          {(track.meta.track_kind === 'gene1d' || track.meta.track_kind === 'feature2d') && (
            <label className="flex items-center justify-between text-[11px] text-slate-300">
              <span>Color</span>
              <input
                type="color"
                value={track.color}
                onChange={(e) => updateTrack(track.id, { color: e.target.value })}
                className="w-7 h-5 bg-transparent border-0 cursor-pointer"
              />
            </label>
          )}
        </div>
      )}

      {/* 1D Canvas */}
      {track.visible && (
        <div
          ref={containerRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onDoubleClick={() => sharedCamera.zoomAtFraction(0.5, 0.5)}
          className="w-full h-full cursor-grab active:cursor-grabbing overflow-hidden"
        >
          <canvas ref={canvasRef} data-export-role="1d" className="w-full h-full block" />
        </div>
      )}

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
