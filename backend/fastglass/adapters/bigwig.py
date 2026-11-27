from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np

from .base import TrackMetadata, resolve_chrom


class BigWigAdapter:
    """Rust-accelerated reader for .bigWig / .bw and .bigBed / .bb via pybigtools."""

    format_id = "bigwig"
    track_kind = "signal1d"

    def __init__(self, path: Path) -> None:
        try:
            import pybigtools
        except ImportError as exc:
            raise RuntimeError(
                "pybigtools is required to read .bigWig/.bigBed files. Install with `uv pip install pybigtools`."
            ) from exc

        self.path = path
        self._lock = threading.RLock()
        self._reader = pybigtools.open(str(path))
        self._is_bigbed = bool(self._reader.is_bigbed())
        if self._is_bigbed:
            self.format_id = "bigbed"
            self.track_kind = "interval1d"
        else:
            self.format_id = "bigwig"
            self.track_kind = "signal1d"

        chrom_dict = dict(self._reader.chroms())
        self.chrom_names = list(chrom_dict.keys())
        self.chrom_lengths = {k: int(v) for k, v in chrom_dict.items()}

    def signal_1d(
        self,
        chrom: str,
        start: int,
        end: int,
        bins: int = 800,
        column: str | None = None,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        bins = max(1, min(int(bins), 8192))
        empty = np.full(bins, np.nan, dtype=np.float32)
        with self._lock:
            resolved = resolve_chrom(chrom, self.chrom_names)
            if resolved is None or self._is_bigbed:
                return empty, empty.copy(), empty.copy()
            clen = self.chrom_lengths[resolved]
            s0 = max(0, min(int(start), clen))
            e0 = max(s0 + 1, min(int(end), clen))
            if s0 >= clen or e0 <= s0:
                return empty, empty.copy(), empty.copy()
            try:
                mean_arr = np.asarray(
                    self._reader.values(resolved, s0, e0, bins=bins, summary="mean"),
                    dtype=np.float32,
                )
                min_arr = np.asarray(
                    self._reader.values(resolved, s0, e0, bins=bins, summary="min"),
                    dtype=np.float32,
                )
                max_arr = np.asarray(
                    self._reader.values(resolved, s0, e0, bins=bins, summary="max"),
                    dtype=np.float32,
                )
            except Exception:
                return empty, empty.copy(), empty.copy()
            return mean_arr, min_arr, max_arr

    def features_1d(self, chrom: str, start: int, end: int, max_items: int = 4000) -> dict[str, Any]:
        with self._lock:
            resolved = resolve_chrom(chrom, self.chrom_names)
            if resolved is None or not self._is_bigbed:
                return {"mode": "intervals", "items": []}
            clen = self.chrom_lengths[resolved]
            s0 = max(0, min(int(start), clen))
            e0 = max(s0 + 1, min(int(end), clen))
            items: list[dict[str, Any]] = []
            for rec in self._reader.records(resolved, s0, e0):
                st, en = int(rec[0]), int(rec[1])
                rest = rec[2].split("\t") if len(rec) > 2 and rec[2] else []
                name = rest[0] if len(rest) > 0 else ""
                score = None
                if len(rest) > 1:
                    try:
                        score = float(rest[1])
                    except ValueError:
                        score = None
                strand = rest[2] if len(rest) > 2 else "."
                color = None
                if len(rest) > 5 and "," in rest[5]:
                    color = f"rgb({rest[5]})"
                items.append(
                    {
                        "start": st,
                        "end": en,
                        "name": name,
                        "score": score,
                        "strand": strand,
                        "color": color,
                    }
                )
                if len(items) >= max_items:
                    break
            return {"mode": "intervals", "items": items, "truncated": len(items) >= max_items}

    def get_metadata(self, track_id: str) -> TrackMetadata:
        return TrackMetadata(
            track_id=track_id,
            name=self.path.name,
            path=str(self.path),
            format_id=self.format_id,
            track_kind=self.track_kind,
            chroms=[{"name": c, "length": self.chrom_lengths[c]} for c in self.chrom_names],
        )

    def close(self) -> None:
        with self._lock:
            try:
                self._reader.close()
            except Exception:
                pass
