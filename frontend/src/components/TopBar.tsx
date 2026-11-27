import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Dna,
  Download,
  FileCode2,
  FolderOpen,
  Image,
  Maximize2,
  PanelLeft,
  Square,
  Trash2,
  Triangle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { fetchGenomes, searchGenes } from '../api';
import { formatBp, formatBpExact, parseLocus, sharedCamera } from '../engine/camera';
import { exportViewPNG, exportViewSVG } from '../engine/exporter';
import { useViewerStore } from '../store/useViewerStore';
import type { GeneSearchHit, GenomeInfo } from '../types';

export const TopBar: React.FC = () => {
  const chroms = useViewerStore((s) => s.chroms);
  const tracks = useViewerStore((s) => s.tracks);
  const sidebarOpen = useViewerStore((s) => s.sidebarOpen);
  const setSidebarOpen = useViewerStore((s) => s.setSidebarOpen);
  const globalMatrixMode = useViewerStore((s) => s.globalMatrixMode);
  const setGlobalMatrixMode = useViewerStore((s) => s.setGlobalMatrixMode);
  const selectedGenome = useViewerStore((s) => s.selectedGenome);
  const setSelectedGenome = useViewerStore((s) => s.setSelectedGenome);
  const addReferenceGeneTrack = useViewerStore((s) => s.addReferenceGeneTrack);
  const clearAllTracks = useViewerStore((s) => s.clearAllTracks);
  const exportSessionJSON = useViewerStore((s) => s.exportSessionJSON);
  const importSessionJSON = useViewerStore((s) => s.importSessionJSON);
  const setToast = useViewerStore((s) => s.setToast);

  const [chrom, setChrom] = useState(sharedCamera.get().chrom);
  const [locusText, setLocusText] = useState(
    `${sharedCamera.get().chrom}:${formatBpExact(sharedCamera.get().startBp)}-${formatBpExact(sharedCamera.get().endBp)}`
  );
  const [genomes, setGenomes] = useState<GenomeInfo[]>([]);
  const [geneHits, setGeneHits] = useState<GeneSearchHit[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const editingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchGenomes()
      .then((list) => setGenomes(list))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    const unsub = sharedCamera.subscribe((st, reason) => {
      if (reason !== 'move') return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setChrom(st.chrom);
        if (!editingRef.current) {
          setLocusText(`${st.chrom}:${formatBpExact(st.startBp)}-${formatBpExact(st.endBp)}`);
        }
      }, 45);
    });
    return () => {
      unsub();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // Live gene symbol search when user types non-locus text
  useEffect(() => {
    if (!searchFocused) {
      setGeneHits([]);
      return;
    }
    const q = locusText.trim();
    if (q.length < 2 || q.includes(':') || /^\d/.test(q)) {
      setGeneHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      searchGenes(selectedGenome, q, 10, ctrl.signal)
        .then((hits) => setGeneHits(hits))
        .catch(() => {});
    }, 160);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [locusText, searchFocused, selectedGenome]);

  const jumpToGene = (hit: GeneSearchHit) => {
    const info = chroms.find((c) => c.name.toLowerCase() === hit.chrom.toLowerCase());
    const chromLen = info?.length ?? Math.max(hit.end + 500_000, 1_000_000);
    const chromName = info?.name ?? hit.chrom;
    const geneLen = Math.max(1000, hit.end - hit.start);
    const pad = Math.max(50_000, geneLen * 4);
    sharedCamera.setChrom(chromName, chromLen, false);
    sharedCamera.setRange(Math.max(0, hit.start - pad), Math.min(chromLen, hit.end + pad));
    setGeneHits([]);
    setSearchFocused(false);
    editingRef.current = false;
    setToast(`Jumped to ${hit.name} (${hit.chrom}:${formatBpExact(hit.start)}-${formatBpExact(hit.end)})`, 'info');
  };

  const handleChromChange = (newChrom: string) => {
    const info = chroms.find((c) => c.name === newChrom);
    sharedCamera.setChrom(newChrom, info?.length ?? 10_000_000, true);
  };

  const handleLocusSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseLocus(locusText, chrom);
    if (parsed) {
      const info = chroms.find((c) => c.name.toLowerCase() === parsed.chrom.toLowerCase());
      if (info && info.name !== sharedCamera.get().chrom) {
        sharedCamera.setChrom(info.name, info.length, false);
      }
      sharedCamera.setRange(parsed.start, parsed.end);
      editingRef.current = false;
      setSearchFocused(false);
      return;
    }

    // Fall back to consensus genome gene search!
    const q = locusText.trim();
    if (q.length >= 2) {
      if (geneHits.length > 0) {
        jumpToGene(geneHits[0]);
        return;
      }
      const hits = await searchGenes(selectedGenome, q, 5);
      if (hits.length > 0) {
        jumpToGene(hits[0]);
        return;
      }
    }
    setToast(`No locus or ${selectedGenome} gene matching "${q}"`, 'error');
  };

  const handleSaveSession = () => {
    const json = exportSessionJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fastglass-session-${chrom}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLoadSession = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await importSessionJSON(text);
    e.target.value = '';
  };

  return (
    <header className="h-12 shrink-0 bg-slate-900/95 border-b border-slate-800 px-3 flex items-center gap-2 select-none z-30">
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className={`p-1.5 rounded-md border transition-colors shrink-0 ${
          sidebarOpen
            ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
            : 'bg-slate-800/70 border-slate-700 text-slate-300 hover:text-white'
        }`}
        title="Toggle Track & File Browser"
      >
        <PanelLeft className="w-4 h-4" />
      </button>

      <div className="flex items-center gap-1.5 mr-1 shrink-0">
        <div className="w-2.5 h-2.5 rounded-sm bg-gradient-to-tr from-sky-400 via-amber-300 to-rose-500" />
        <span className="font-semibold tracking-tight text-sm text-slate-100">FastGlass</span>
      </div>

      {/* Consensus Genome Selector + 1-click Gene Track */}
      <div className="flex items-center bg-slate-800/80 border border-slate-700 rounded-md overflow-hidden shrink-0">
        <select
          value={selectedGenome}
          onChange={(e) => setSelectedGenome(e.target.value)}
          className="h-8 bg-transparent px-1.5 py-0 text-xs font-mono text-indigo-300 focus:outline-none"
          title="Consensus reference genome for gene search & RefSeq gene track"
        >
          {genomes.length === 0 ? (
            <option value={selectedGenome} className="bg-slate-900 text-slate-100">
              {selectedGenome}
            </option>
          ) : (
            genomes.map((g) => (
              <option key={g.id} value={g.id} className="bg-slate-900 text-slate-100">
                {g.id}
              </option>
            ))
          )}
        </select>
        <button
          onClick={() => void addReferenceGeneTrack(selectedGenome)}
          className="h-8 px-2 flex items-center gap-1 border-l border-slate-700 hover:bg-indigo-500/20 text-xs text-indigo-200 transition-colors"
          title={`Add ${selectedGenome} consensus RefSeq gene track`}
        >
          <Dna className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">Genes</span>
        </button>
      </div>

      {/* Chromosome selector */}
      <select
        value={chrom}
        onChange={(e) => handleChromChange(e.target.value)}
        className="h-8 bg-slate-800 border border-slate-700 rounded-md px-2 py-0 text-xs leading-8 font-mono text-slate-100 focus:outline-none focus:border-sky-500 shrink-0"
        title="Active chromosome"
      >
        {chroms.length === 0 ? (
          <option value={chrom}>{chrom}</option>
        ) : (
          chroms.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))
        )}
      </select>

      {/* Unified Locus + Consensus Gene Search */}
      <form
        onSubmit={(e) => void handleLocusSubmit(e)}
        className="relative flex items-center gap-1 flex-1 min-w-[190px] max-w-md"
      >
        <input
          type="text"
          value={locusText}
          onFocus={() => {
            editingRef.current = true;
            setSearchFocused(true);
          }}
          onBlur={() => {
            // Delay blur so clicking dropdown item registers first
            window.setTimeout(() => {
              editingRef.current = false;
              setSearchFocused(false);
            }, 160);
          }}
          onChange={(e) => setLocusText(e.target.value)}
          placeholder={`Locus or ${selectedGenome} gene (e.g. dpy-27, chrX:2Mb-6Mb)`}
          className="h-8 w-full bg-slate-950 border border-slate-700 rounded-md px-2.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
        />
        <button
          type="submit"
          className="h-8 px-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md text-xs text-slate-200 transition-colors shrink-0"
        >
          Go
        </button>

        {/* Live Gene Autocomplete Dropdown */}
        {searchFocused && geneHits.length > 0 && (
          <div className="absolute top-9 left-0 right-10 bg-slate-900/98 border border-slate-700 rounded-lg shadow-2xl overflow-hidden z-50">
            <div className="px-2.5 py-1 bg-slate-950/70 border-b border-slate-800 text-[10px] text-slate-400 flex justify-between">
              <span>{selectedGenome} Consensus Genes</span>
              <span>Click to jump</span>
            </div>
            {geneHits.map((h) => (
              <button
                key={`${h.chrom}-${h.start}-${h.name}`}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  jumpToGene(h);
                }}
                className="w-full px-2.5 py-1.5 hover:bg-sky-500/20 flex items-center justify-between text-left text-xs border-b border-slate-800/60 last:border-0"
              >
                <span className="font-semibold text-indigo-300 font-mono">
                  {h.name}{' '}
                  <span className="text-[10px] text-slate-500 font-normal">({h.strand})</span>
                </span>
                <span className="text-[10px] font-mono text-slate-400">
                  {h.chrom}:{formatBp(h.start)}–{formatBp(h.end)}
                </span>
              </button>
            ))}
          </div>
        )}
      </form>

      {/* Zoom controls */}
      <div className="flex items-center bg-slate-800/80 border border-slate-700 rounded-md overflow-hidden shrink-0">
        <button
          onClick={() => sharedCamera.zoomAtFraction(0.5, 0.5)}
          className="h-8 px-2 text-slate-300 hover:text-white hover:bg-slate-700/80 transition-colors"
          title="Zoom in (2×)"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => sharedCamera.zoomAtFraction(0.5, 2.0)}
          className="h-8 px-2 text-slate-300 hover:text-white hover:bg-slate-700/80 border-l border-slate-700 transition-colors"
          title="Zoom out (2×)"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => sharedCamera.resetZoom()}
          className="h-8 px-2 text-slate-300 hover:text-white hover:bg-slate-700/80 border-l border-slate-700 transition-colors"
          title="Reset to whole chromosome"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Triangle / Square global switch */}
      <div
        className="flex items-center bg-slate-800/80 border border-slate-700 rounded-md p-0.5 text-xs shrink-0"
        title="Default 2D Hi-C heatmap orientation"
      >
        <button
          onClick={() => setGlobalMatrixMode('triangle')}
          className={`flex items-center gap-1 px-2 py-1 rounded transition-colors ${
            globalMatrixMode === 'triangle'
              ? 'bg-sky-500/25 text-sky-300'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Triangle className="w-3 h-3" />
          <span className="hidden xl:inline">Triangle</span>
        </button>
        <button
          onClick={() => setGlobalMatrixMode('square')}
          className={`flex items-center gap-1 px-2 py-1 rounded transition-colors ${
            globalMatrixMode === 'square'
              ? 'bg-sky-500/25 text-sky-300'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Square className="w-3 h-3" />
          <span className="hidden xl:inline">Square</span>
        </button>
      </div>

      <div className="flex-1" />

      {/* Export Figure (PNG / SVG) + Session Save/Load/Clear */}
      <div className="flex items-center gap-1 shrink-0 relative">
        <button
          onClick={() => setExportOpen((v) => !v)}
          disabled={tracks.length === 0}
          className="h-8 px-2.5 flex items-center gap-1.5 bg-emerald-600/20 hover:bg-emerald-600/35 disabled:opacity-40 border border-emerald-500/40 rounded-md text-xs text-emerald-200 transition-colors"
          title="Export figure as PNG or SVG"
        >
          <Camera className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">Export</span>
        </button>

        {exportOpen && (
          <div className="absolute top-10 right-20 z-50 w-44 bg-slate-900/98 border border-slate-700 rounded-lg shadow-2xl p-1.5 space-y-1 text-xs">
            <button
              onClick={() => {
                exportViewPNG(tracks);
                setExportOpen(false);
                setToast('Exported high-res PNG figure', 'info');
              }}
              className="w-full px-2.5 py-1.5 rounded hover:bg-slate-800 flex items-center gap-2 text-slate-200"
            >
              <Image className="w-3.5 h-3.5 text-emerald-400" />
              <span>Export PNG (2× HiDPI)</span>
            </button>
            <button
              onClick={() => {
                exportViewSVG(tracks);
                setExportOpen(false);
                setToast('Exported vector SVG figure', 'info');
              }}
              className="w-full px-2.5 py-1.5 rounded hover:bg-slate-800 flex items-center gap-2 text-slate-200"
            >
              <FileCode2 className="w-3.5 h-3.5 text-sky-400" />
              <span>Export SVG (Vector)</span>
            </button>
          </div>
        )}

        <button
          onClick={handleSaveSession}
          disabled={tracks.length === 0}
          className="h-8 px-2 flex items-center gap-1 bg-slate-800/80 hover:bg-slate-700 disabled:opacity-40 border border-slate-700 rounded-md text-xs text-slate-200 transition-colors"
          title="Save session JSON"
        >
          <Download className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="h-8 px-2 flex items-center gap-1 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 rounded-md text-xs text-slate-200 transition-colors"
          title="Load session JSON"
        >
          <FolderOpen className="w-3.5 h-3.5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleLoadSession}
        />
        {tracks.length > 0 && (
          <button
            onClick={clearAllTracks}
            className="h-8 px-2 flex items-center gap-1 bg-rose-950/60 hover:bg-rose-900/70 border border-rose-800/60 rounded-md text-xs text-rose-300 transition-colors"
            title="Remove all tracks"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </header>
  );
};
