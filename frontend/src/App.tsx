import React, { useEffect, useRef, useState } from 'react';
import { GitCompareArrows, Sparkles, Upload } from 'lucide-react';
import { getRuntimeMode, uploadTrack } from './api';
import { FileDrawer } from './components/FileDrawer';
import { HeatmapTrack } from './components/HeatmapTrack';
import { OneDTrack } from './components/OneDTrack';
import { RulerTrack } from './components/RulerTrack';
import { TopBar } from './components/TopBar';
import { useViewerStore } from './store/useViewerStore';

const LOCAL_DEMO_PATHS = [
  '382_merge_2000.mcool',
  'genome://ce11',
  'data/annotations/chrX_17_TADs.bed',
  'data/annotations/chromStates_L3_Evans2016_ce11_rgb.bed',
  'data/annotations/chrX_382_cis_eigenvectors_2kb.tsv',
  'data/chip_targets/Kim2022_eLife_DPY27_SDC3_chrX_ce11_2kb.tsv',
];

const ONLINE_DEMO_PATHS = [
  'demo://wt_hic',
  'genome://ce11',
  'demo://tads',
  'demo://chromstates',
  'demo://eigenvector',
  'demo://chip',
  'demo://loops',
];

export const App: React.FC = () => {
  const tracks = useViewerStore((s) => s.tracks);
  const sidebarOpen = useViewerStore((s) => s.sidebarOpen);
  const squareSize = useViewerStore((s) => s.squareSize);
  const setSquareSize = useViewerStore((s) => s.setSquareSize);
  const reorderTracks = useViewerStore((s) => s.reorderTracks);
  const addTrackByPath = useViewerStore((s) => s.addTrackByPath);
  const addTrackFromMeta = useViewerStore((s) => s.addTrackFromMeta);
  const toast = useViewerStore((s) => s.toast);
  const setToast = useViewerStore((s) => s.setToast);

  const mainRef = useRef<HTMLElement>(null);
  const [mainRect, setMainRect] = useState({ width: 1100, height: 820 });
  const dragIdxRef = useRef<number | null>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<'server' | 'browser'>('browser');

  useEffect(() => {
    getRuntimeMode()
      .then((m) => setRuntimeMode(m))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setMainRect({ width: Math.max(320, Math.floor(r.width)), height: Math.max(320, Math.floor(r.height)) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hasSquareMatrix = tracks.some(
    (t) =>
      t.visible &&
      t.meta.track_kind === 'matrix2d' &&
      (t.matrixMode === 'square' || (t.compareMode === 'split' && Boolean(t.compareTrackId)))
  );

  // When a 1:1 Square / Split heatmap is active, keep the entire track stack width synced to the 1:1 square
  const maxSquareW = Math.max(320, mainRect.width - 20);
  const autoSquareW = Math.min(maxSquareW, Math.max(440, mainRect.height - 230));
  const colWidth = hasSquareMatrix
    ? Math.min(maxSquareW, Math.max(300, squareSize > 0 ? squareSize : autoSquareW))
    : null;

  const startWidthResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = colWidth ?? autoSquareW;
    const onMove = (me: MouseEvent) => {
      // Since column is centered, dragging right edge expands symmetrically (2× dx) or clamp cleanly
      const nextW = Math.min(maxSquareW, Math.max(300, startW + (me.clientX - startX) * 2));
      setSquareSize(nextW);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleTrackDragStart = (idx: number) => {
    dragIdxRef.current = idx;
  };

  const handleTrackDragOver = (e: React.DragEvent, _idx: number) => {
    if (dragIdxRef.current !== null) {
      e.preventDefault();
    }
  };

  const handleTrackDrop = (targetIdx: number) => {
    if (dragIdxRef.current !== null && dragIdxRef.current !== targetIdx) {
      reorderTracks(dragIdxRef.current, targetIdx);
    }
    dragIdxRef.current = null;
  };

  const handleExternalDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setFileDragActive(true);
    }
  };

  const handleExternalDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) {
      setFileDragActive(false);
    }
  };

  const handleExternalDrop = async (e: React.DragEvent) => {
    setFileDragActive(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    for (const file of Array.from(files)) {
      try {
        const meta = await uploadTrack(file);
        addTrackFromMeta(meta);
        setToast(`Loaded ${meta.name}`, 'info');
      } catch (err) {
        setToast(err instanceof Error ? err.message : `Failed to load ${file.name}`, 'error');
      }
    }
  };

  const loadDemoWorkspace = async () => {
    setLoadingDemo(true);
    try {
      const list = runtimeMode === 'server' ? LOCAL_DEMO_PATHS : ONLINE_DEMO_PATHS;
      for (const p of list) {
        await addTrackByPath(p);
      }
    } finally {
      setLoadingDemo(false);
    }
  };

  const loadComparisonDemo = async () => {
    setLoadingDemo(true);
    try {
      await addTrackByPath('demo://wt_hic');
      await addTrackByPath('demo://ko_hic');
      await addTrackByPath('genome://ce11');
      await addTrackByPath('demo://tads');
      await addTrackByPath('demo://eigenvector');
      await addTrackByPath('demo://chip');

      const st = useViewerStore.getState();
      const wtTrack = st.tracks.find((t) => t.trackId === 'demo://wt_hic');
      const koTrack = st.tracks.find((t) => t.trackId === 'demo://ko_hic');
      if (wtTrack && koTrack) {
        st.updateTrack(wtTrack.id, {
          compareMode: 'split',
          compareTrackId: koTrack.trackId,
          compareTrackName: koTrack.meta.name,
        });
        st.updateTrack(koTrack.id, {
          compareMode: 'log2ratio',
          compareTrackId: wtTrack.trackId,
          compareTrackName: wtTrack.meta.name,
          matrixMode: 'triangle',
          height: 240,
        });
      }
    } finally {
      setLoadingDemo(false);
    }
  };

  return (
    <div
      onDragOver={handleExternalDragOver}
      onDragLeave={handleExternalDragLeave}
      onDrop={handleExternalDrop}
      className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden relative"
    >
      <TopBar />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {sidebarOpen && <FileDrawer />}

        {/* Main Track Canvas Viewport */}
        <main
          ref={mainRef}
          className="flex-1 flex flex-col min-w-0 overflow-y-auto bg-[#070b14] relative"
        >
          {tracks.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <div className="max-w-md space-y-4">
                <div className="w-12 h-12 mx-auto rounded-xl bg-gradient-to-tr from-sky-500/20 via-amber-400/20 to-rose-500/20 border border-slate-700/80 flex items-center justify-center">
                  <Sparkles className="w-6 h-6 text-sky-400" />
                </div>
                <h1 className="text-xl font-semibold text-slate-100">
                  Zero-Ingest 3D Genome &amp; Track Viewer
                </h1>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Click any file in the left sidebar, paste a local file path, or drag &amp; drop{' '}
                  <span className="text-slate-300 font-mono">.mcool</span>,{' '}
                  <span className="text-slate-300 font-mono">.hic</span>,{' '}
                  <span className="text-slate-300 font-mono">.bw</span>,{' '}
                  <span className="text-slate-300 font-mono">.bed</span>,{' '}
                  <span className="text-slate-300 font-mono">.gtf</span>,{' '}
                  <span className="text-slate-300 font-mono">.bedpe</span>, or{' '}
                  <span className="text-slate-300 font-mono">.tsv/.csv</span> files directly here.
                </p>

                <div className="pt-2 flex flex-wrap items-center justify-center gap-2">
                  <button
                    onClick={() => void loadDemoWorkspace()}
                    disabled={loadingDemo}
                    className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-xs font-medium text-white shadow-lg shadow-sky-900/30 transition-colors"
                  >
                    {loadingDemo
                      ? 'Loading tracks...'
                      : runtimeMode === 'server'
                        ? 'Load Workspace Sample (Hi-C + TADs + ChIP + Eigenvector)'
                        : 'Launch Interactive Demo (Hi-C + ce11 Genes + Tracks)'}
                  </button>
                  {runtimeMode === 'browser' && (
                    <button
                      onClick={() => void loadComparisonDemo()}
                      disabled={loadingDemo}
                      className="px-4 py-2 rounded-lg bg-violet-600/90 hover:bg-violet-500 disabled:opacity-50 text-xs font-medium text-white shadow-lg shadow-violet-900/30 flex items-center gap-1.5 transition-colors"
                    >
                      <GitCompareArrows className="w-3.5 h-3.5" />
                      <span>Split &amp; Differential Demo (WT vs KO)</span>
                    </button>
                  )}
                </div>

                <div className="text-[11px] text-slate-500 pt-2">
                  Scroll to zoom · Drag to pan · Drag track handle <span className="font-mono">≡</span> to reorder · Drag bottom edge to resize
                </div>
              </div>
            </div>
          ) : (
            <div
              className={`flex flex-col relative ${
                colWidth ? 'mx-auto border-x border-slate-800/80 shadow-2xl' : 'w-full'
              }`}
              style={colWidth ? { width: colWidth } : undefined}
            >
              <RulerTrack />
              {tracks.map((track, idx) =>
                track.meta.track_kind === 'matrix2d' ? (
                  <HeatmapTrack
                    key={track.id}
                    track={track}
                    index={idx}
                    total={tracks.length}
                    onDragStart={handleTrackDragStart}
                    onDragOver={handleTrackDragOver}
                    onDrop={handleTrackDrop}
                  />
                ) : (
                  <OneDTrack
                    key={track.id}
                    track={track}
                    index={idx}
                    total={tracks.length}
                    onDragStart={handleTrackDragStart}
                    onDragOver={handleTrackDragOver}
                    onDrop={handleTrackDrop}
                  />
                )
              )}
              <div className="h-24 shrink-0" />

              {/* Right-edge drag handle to resize 1:1 square width smoothly */}
              {colWidth && (
                <div
                  onMouseDown={startWidthResize}
                  className="absolute top-0 bottom-0 -right-1 w-2 cursor-ew-resize hover:bg-sky-500/40 transition-colors z-20"
                  title="Drag to resize 1:1 square viewport width"
                />
              )}
            </div>
          )}
        </main>
      </div>

      {/* External file drop overlay */}
      {fileDragActive && (
        <div className="fixed inset-0 z-50 bg-sky-950/75 backdrop-blur-sm border-2 border-dashed border-sky-400 flex items-center justify-center pointer-events-none">
          <div className="bg-slate-900/95 border border-sky-500/40 rounded-xl px-8 py-6 text-center space-y-2 shadow-2xl">
            <Upload className="w-8 h-8 text-sky-400 mx-auto" />
            <div className="text-sm font-medium text-white">Drop genomic track files to add</div>
            <div className="text-xs text-slate-400">
              .mcool · .cool · .hic · .bw · .bb · .bed · .bedGraph · .gtf · .bedpe · .tsv · .csv
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 px-3.5 py-2 rounded-lg border text-xs shadow-xl backdrop-blur-md ${
            toast.kind === 'error'
              ? 'bg-rose-950/95 border-rose-500/50 text-rose-200'
              : 'bg-slate-900/95 border-slate-700 text-slate-100'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
};

export default App;
