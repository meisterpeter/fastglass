import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  FilePlus2,
  Folder,
  Home,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Upload,
} from 'lucide-react';
import { getRuntimeMode, listFiles, uploadTrack } from '../api';
import { useViewerStore } from '../store/useViewerStore';
import type { FsEntry } from '../types';

const FORMAT_BADGES: Record<string, { label: string; cls: string }> = {
  mcool: { label: 'MCOOL', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/30' },
  cool: { label: 'COOL', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/30' },
  hic: { label: 'HIC', cls: 'bg-orange-500/20 text-orange-300 border-orange-500/30' },
  bigwig: { label: 'BW', cls: 'bg-sky-500/20 text-sky-300 border-sky-500/30' },
  bigbed: { label: 'BB', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  bedgraph: { label: 'BG', cls: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' },
  bed: { label: 'BED', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  bedpe: { label: 'BEDPE', cls: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30' },
  gtf: { label: 'GTF', cls: 'bg-violet-500/20 text-violet-300 border-violet-500/30' },
  gff3: { label: 'GFF3', cls: 'bg-violet-500/20 text-violet-300 border-violet-500/30' },
  tabular: { label: 'TSV', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
};

function formatBytes(bytes?: number): string {
  if (!bytes) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}G`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}M`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)}K`;
  return `${bytes}B`;
}

export const FileDrawer: React.FC = () => {
  const addTrackByPath = useViewerStore((s) => s.addTrackByPath);
  const addTrackFromMeta = useViewerStore((s) => s.addTrackFromMeta);
  const tracks = useViewerStore((s) => s.tracks);
  const setToast = useViewerStore((s) => s.setToast);

  const [cwd, setCwd] = useState('');
  const [root, setRoot] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [manualPath, setManualPath] = useState('');
  const [isBrowserMode, setIsBrowserMode] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getRuntimeMode()
      .then((m) => setIsBrowserMode(m === 'browser'))
      .catch(() => {});
  }, []);

  const loadDir = useCallback(async (dirPath = '') => {
    setLoading(true);
    try {
      const res = await listFiles(dirPath, true);
      setCwd(res.cwd);
      setRoot(res.root);
      setParent(res.parent);
      setEntries(res.entries);
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to browse directory', 'error');
    } finally {
      setLoading(false);
    }
  }, [setToast]);

  useEffect(() => {
    void loadDir('');
  }, [loadDir]);

  const handleAdd = async (path: string) => {
    setOpeningPath(path);
    try {
      await addTrackByPath(path);
    } finally {
      setOpeningPath(null);
    }
  };

  const handleManualOpen = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = manualPath.trim().replace(/^["']|["']$/g, '');
    if (!p) return;
    await handleAdd(p);
    setManualPath('');
  };

  const handleUploadFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      try {
        const meta = await uploadTrack(file);
        addTrackFromMeta(meta);
        setToast(`Loaded ${meta.name}`, 'info');
      } catch (err) {
        setToast(err instanceof Error ? err.message : `Failed to load ${file.name}`, 'error');
      }
    }
    e.target.value = '';
  };

  const openPaths = new Set(tracks.map((t) => t.meta.path));
  const filtered = entries.filter((e) =>
    !filter.trim() ? true : e.name.toLowerCase().includes(filter.trim().toLowerCase())
  );

  const shortCwd =
    root && cwd.startsWith(root)
      ? cwd.slice(root.length).replace(/^[/\\]+/, '') || '/'
      : cwd;

  return (
    <aside className="w-72 shrink-0 bg-slate-900/90 border-r border-slate-800 flex flex-col h-full select-none">
      {/* Header + open path */}
      <div className="p-2.5 border-b border-slate-800 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Add Tracks
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => uploadRef.current?.click()}
              className="px-2 py-1 rounded bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-[11px] text-sky-300 flex items-center gap-1 transition-colors"
              title="Upload / pick local file"
            >
              <Upload className="w-3 h-3" />
              <span>File</span>
            </button>
            <input
              ref={uploadRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleUploadFiles}
            />
          </div>
        </div>

        {/* Paste local path or remote HTTPS URL */}
        <form onSubmit={handleManualOpen} className="flex gap-1">
          <input
            type="text"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            placeholder={
              isBrowserMode
                ? 'Paste https:// URL (.hic, .bw, .bed, .tsv)...'
                : 'Paste local file path...'
            }
            className="flex-1 min-w-0 h-7 bg-slate-950 border border-slate-700/80 rounded px-2 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-sky-500"
          />
          <button
            type="submit"
            className="h-7 px-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-200"
            title={isBrowserMode ? 'Load remote URL' : 'Open path'}
          >
            <FilePlus2 className="w-3.5 h-3.5" />
          </button>
        </form>

        {/* Search filter */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter current folder..."
            className="w-full h-7 bg-slate-950/80 border border-slate-800 rounded pl-7 pr-2 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
          />
        </div>
      </div>

      {/* Directory breadcrumb bar */}
      <div className="px-2.5 py-1.5 bg-slate-950/50 border-b border-slate-800/80 flex items-center gap-1 text-[11px] text-slate-400">
        <button
          onClick={() => void loadDir('')}
          className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-100"
          title="Workspace root"
        >
          <Home className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => parent && void loadDir(parent)}
          disabled={!parent}
          className="p-1 rounded hover:bg-slate-800 disabled:opacity-30 text-slate-400 hover:text-slate-100"
          title="Up one folder"
        >
          <ArrowUp className="w-3.5 h-3.5" />
        </button>
        <span className="truncate flex-1 font-mono text-[10px] text-slate-400" title={cwd}>
          {shortCwd}
        </span>
        <button
          onClick={() => void loadDir(cwd)}
          className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-100"
          title="Refresh"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {loading && entries.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 px-3 text-xs text-slate-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
            <span>Scanning folder...</span>
          </div>
        )}
        {filtered.length === 0 && !loading && (
          <div className="text-center py-8 px-3 text-xs text-slate-500">
            No supported track files in this folder.
          </div>
        )}
        {filtered.map((entry) => {
          if (entry.is_dir) {
            return (
              <button
                key={entry.path}
                onClick={() => {
                  setFilter('');
                  void loadDir(entry.path);
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-800/80 text-left text-xs text-slate-300 transition-colors"
              >
                <Folder className="w-3.5 h-3.5 text-amber-400/80 shrink-0" />
                <span className="truncate flex-1">{entry.name}</span>
              </button>
            );
          }

          const badge = entry.format ? FORMAT_BADGES[entry.format] : null;
          const isAdded = openPaths.has(entry.path);
          const isOpening = openingPath === entry.path;

          return (
            <div
              key={entry.path}
              onClick={() => void handleAdd(entry.path)}
              className="group w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-slate-800/90 cursor-pointer text-xs transition-colors"
              title={`${entry.name} (${formatBytes(entry.size)}) — click to add track`}
            >
              {badge && (
                <span
                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${badge.cls}`}
                >
                  {badge.label}
                </span>
              )}
              <span className="truncate flex-1 text-slate-200 group-hover:text-white">
                {entry.name}
              </span>
              <span className="text-[10px] text-slate-500 font-mono shrink-0 hidden group-hover:hidden sm:inline">
                {formatBytes(entry.size)}
              </span>
              <button
                type="button"
                disabled={isOpening}
                className={`p-1 rounded shrink-0 transition-colors ${
                  isAdded
                    ? 'bg-emerald-500/20 text-emerald-300 hover:bg-sky-500/30 hover:text-sky-200'
                    : 'bg-slate-800 text-slate-300 group-hover:bg-sky-500 group-hover:text-white'
                }`}
                title={isAdded ? 'Already active (click to add another view)' : 'Add track'}
              >
                {isOpening ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : isAdded ? (
                  <Check className="w-3 h-3" />
                ) : (
                  <Plus className="w-3 h-3" />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Supported formats footer */}
      <div className="px-2.5 py-2 border-t border-slate-800 text-[10px] text-slate-500 leading-relaxed">
        {isBrowserMode ? (
          <>
            100% client-side in browser: drop or open local{' '}
            <span className="text-slate-400">.hic, .bw, .bb, .bed, .bedGraph, .gtf, .gff3, .bedpe, .tsv, .csv</span>{' '}
            files or paste remote URLs.
          </>
        ) : (
          <>
            Supports <span className="text-slate-400">.mcool, .cool, .hic, .bw, .bb, .bed, .bedGraph, .gtf, .gff3, .bedpe, .tsv, .csv</span>. Drag &amp; drop files anywhere.
          </>
        )}
      </div>
    </aside>
  );
};
