from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from .adapters.base import TrackMetadata
from .adapters.bedpe import BedpeAdapter
from .adapters.bigwig import BigWigAdapter
from .adapters.hic import HicAdapter
from .adapters.intervals import BedAdapter, BedGraphAdapter, GeneAnnotationAdapter
from .adapters.mcool import McoolAdapter
from .adapters.tabular import GenericTabularAdapter
from .genomes import GenomeManager

SUPPORTED_EXTENSIONS: dict[str, str] = {
    ".mcool": "mcool",
    ".cool": "cool",
    ".hic": "hic",
    ".bw": "bigwig",
    ".bigwig": "bigwig",
    ".bb": "bigbed",
    ".bigbed": "bigbed",
    ".bedgraph": "bedgraph",
    ".bg": "bedgraph",
    ".bed": "bed",
    ".narrowpeak": "bed",
    ".broadpeak": "bed",
    ".bedpe": "bedpe",
    ".gtf": "gtf",
    ".gff": "gff3",
    ".gff3": "gff3",
    ".tsv": "tabular",
    ".csv": "tabular",
    ".tab": "tabular",
    ".txt": "tabular",
}


def detect_format(path: Path) -> str | None:
    """Detect track format from extension (handling .gz) and magic bytes."""
    name_low = path.name.lower()
    if name_low.endswith(".gz"):
        base_low = name_low[:-3]
    else:
        base_low = name_low

    for ext, fmt in SUPPORTED_EXTENSIONS.items():
        if base_low.endswith(ext):
            return fmt

    try:
        with open(path, "rb") as f:
            magic = f.read(8)
        if magic.startswith(b"\x89HDF\r\n\x1a\n"):
            return "mcool"
        if magic.startswith(b"HIC\x00"):
            return "hic"
        if magic[:4] in (b"\x26\xfc\x8f\x88", b"\x88\x8f\xfc\x26"):
            return "bigwig"
        if magic[:4] in (b"\xeb\xf2\x89\x87", b"\x87\x89\xf2\xeb"):
            return "bigbed"
    except OSError:
        pass
    return None


def make_track_id(path: Path) -> str:
    resolved = str(path.resolve())
    return hashlib.sha1(resolved.encode("utf-8")).hexdigest()[:12]


def create_adapter(path: Path, fmt: str | None = None):
    fmt = fmt or detect_format(path)
    if fmt in ("mcool", "cool"):
        return McoolAdapter(path)
    if fmt == "hic":
        return HicAdapter(path)
    if fmt in ("bigwig", "bigbed"):
        return BigWigAdapter(path)
    if fmt == "bed":
        return BedAdapter(path)
    if fmt == "bedgraph":
        return BedGraphAdapter(path)
    if fmt in ("gtf", "gff3"):
        return GeneAnnotationAdapter(path)
    if fmt == "bedpe":
        return BedpeAdapter(path)
    if fmt == "tabular":
        return GenericTabularAdapter(path)
    raise ValueError(f"Unsupported track format for '{path.name}' (detected: {fmt})")


class TileLRUCache:
    """Thread-safe byte-budgeted LRU cache for binary tiles."""

    def __init__(self, max_bytes: int = 256 * 1024 * 1024) -> None:
        self.max_bytes = max_bytes
        self._lock = threading.Lock()
        self._store: OrderedDict[tuple[Any, ...], tuple[bytes, dict[str, Any]]] = OrderedDict()
        self._cur_bytes = 0

    def get(self, key: tuple[Any, ...]) -> tuple[bytes, dict[str, Any]] | None:
        with self._lock:
            val = self._store.get(key)
            if val is not None:
                self._store.move_to_end(key)
            return val

    def put(self, key: tuple[Any, ...], payload: bytes, meta: dict[str, Any]) -> None:
        size = len(payload)
        if size > self.max_bytes:
            return
        with self._lock:
            if key in self._store:
                old_payload, _ = self._store.pop(key)
                self._cur_bytes -= len(old_payload)
            while self._cur_bytes + size > self.max_bytes and self._store:
                _, (ev_payload, _) = self._store.popitem(last=False)
                self._cur_bytes -= len(ev_payload)
            self._store[key] = (payload, meta)
            self._cur_bytes += size

    def invalidate_track(self, track_id: str) -> None:
        with self._lock:
            drop = [k for k in self._store if k and k[0] == track_id]
            for k in drop:
                p, _ = self._store.pop(k)
                self._cur_bytes -= len(p)


class TrackRegistry:
    """Manages open track adapters and caches."""

    def __init__(self, root_dir: Path) -> None:
        self.root_dir = root_dir.resolve()
        self._lock = threading.RLock()
        self._tracks: dict[str, Any] = {}
        self._meta: dict[str, TrackMetadata] = {}
        self.tile_cache = TileLRUCache(max_bytes=256 * 1024 * 1024)
        self.genomes = GenomeManager()

    def open_genome(self, genome_id: str) -> TrackMetadata:
        tid = f"genome-{genome_id}"
        with self._lock:
            if tid in self._meta:
                return self._meta[tid]
        adapter = self.genomes.get_adapter(genome_id)
        meta = adapter.get_metadata(tid)
        with self._lock:
            self._tracks[tid] = adapter
            self._meta[tid] = meta
        return meta

    def open_track(self, raw_path: str, format_override: str | None = None) -> TrackMetadata:
        if raw_path.startswith("genome://"):
            return self.open_genome(raw_path[len("genome://") :].strip())
        p = Path(raw_path)
        if not p.is_absolute():
            p = (self.root_dir / p).resolve()
        else:
            p = p.resolve()
        if not p.exists() or not p.is_file():
            raise FileNotFoundError(f"File not found: {p}")

        tid = make_track_id(p)
        with self._lock:
            if tid in self._meta and format_override is None:
                return self._meta[tid]
            if tid in self._tracks:
                self._tracks[tid].close()
                self.tile_cache.invalidate_track(tid)
            adapter = create_adapter(p, fmt=format_override)
            meta = adapter.get_metadata(tid)
            self._tracks[tid] = adapter
            self._meta[tid] = meta
            return meta

    def get_adapter(self, track_id: str):
        with self._lock:
            if track_id not in self._tracks:
                raise KeyError(f"Track '{track_id}' is not registered")
            return self._tracks[track_id]

    def get_metadata(self, track_id: str) -> TrackMetadata:
        with self._lock:
            if track_id not in self._meta:
                raise KeyError(f"Track '{track_id}' is not registered")
            return self._meta[track_id]

    def list_tracks(self) -> list[dict[str, Any]]:
        with self._lock:
            return [m.to_dict() for m in self._meta.values()]

    def close_track(self, track_id: str) -> bool:
        with self._lock:
            adapter = self._tracks.pop(track_id, None)
            self._meta.pop(track_id, None)
            self.tile_cache.invalidate_track(track_id)
            if adapter is not None:
                adapter.close()
                return True
            return False

    def close_all(self) -> None:
        with self._lock:
            for adapter in self._tracks.values():
                adapter.close()
            self._tracks.clear()
            self._meta.clear()
