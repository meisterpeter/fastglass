from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol

import numpy as np

TrackKind = Literal["matrix2d", "signal1d", "interval1d", "gene1d", "feature2d"]


def normalize_chrom_key(name: str) -> str:
    """Canonical key for matching chromosome aliases like 'chrX' <-> 'X'."""
    s = name.strip()
    low = s.lower()
    if low in ("chrm", "chrmt", "mtdna", "mt", "m"):
        return "mt"
    if low.startswith("chr"):
        return low[3:]
    return low


def resolve_chrom(requested: str, available: list[str] | dict[str, Any]) -> str | None:
    """Resolve a requested chromosome name against a track's available chromosomes."""
    if requested in available:
        return requested
    target = normalize_chrom_key(requested)
    for c in available:
        if normalize_chrom_key(c) == target:
            return c
    return None


def bin_intervals_to_signal(
    starts: np.ndarray,
    ends: np.ndarray,
    values: np.ndarray,
    view_start: int,
    view_end: int,
    bins: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Bin sorted intervals into `bins` pixels returning (mean, min, max) float32 arrays.

    NaN indicates bins with no overlapping data.
    """
    bins = max(1, min(int(bins), 8192))
    out_mean = np.full(bins, np.nan, dtype=np.float32)
    out_min = np.full(bins, np.nan, dtype=np.float32)
    out_max = np.full(bins, np.nan, dtype=np.float32)

    if len(starts) == 0 or view_end <= view_start:
        return out_mean, out_min, out_max

    right = int(np.searchsorted(starts, view_end, side="left"))
    if right == 0:
        return out_mean, out_min, out_max
    left = int(np.searchsorted(ends[:right], view_start, side="right"))
    if left > 0:
        lo_check = max(0, left - 256)
        mask_back = ends[lo_check:left] > view_start
        if np.any(mask_back):
            left = lo_check + int(np.argmax(mask_back))

    s = starts[left:right]
    e = ends[left:right]
    v = values[left:right]
    valid = (~np.isnan(v)) & (e > view_start) & (s < view_end)
    if not np.any(valid):
        return out_mean, out_min, out_max

    s = s[valid]
    e = e[valid]
    v = v[valid].astype(np.float64, copy=False)

    span = float(view_end - view_start)
    scale = bins / span
    b0 = np.clip(np.floor((s - view_start) * scale).astype(np.int64), 0, bins - 1)
    b1 = np.clip(np.ceil((e - view_start) * scale).astype(np.int64) - 1, 0, bins - 1)
    b1 = np.maximum(b0, b1)

    same = b0 == b1
    sums = np.zeros(bins, dtype=np.float64)
    counts = np.zeros(bins, dtype=np.int64)
    mins = np.full(bins, np.inf, dtype=np.float64)
    maxs = np.full(bins, -np.inf, dtype=np.float64)

    if np.any(same):
        idx = b0[same]
        vals = v[same]
        np.add.at(sums, idx, vals)
        np.add.at(counts, idx, 1)
        np.minimum.at(mins, idx, vals)
        np.maximum.at(maxs, idx, vals)

    if np.any(~same):
        wide_b0 = b0[~same]
        wide_b1 = b1[~same]
        wide_v = v[~same]
        for a, b, val in zip(wide_b0.tolist(), wide_b1.tolist(), wide_v.tolist()):
            sl = slice(a, b + 1)
            sums[sl] += val
            counts[sl] += 1
            mins[sl] = np.minimum(mins[sl], val)
            maxs[sl] = np.maximum(maxs[sl], val)

    has = counts > 0
    out_mean[has] = (sums[has] / counts[has]).astype(np.float32)
    out_min[has] = mins[has].astype(np.float32)
    out_max[has] = maxs[has].astype(np.float32)
    return out_mean, out_min, out_max


@dataclass
class TrackMetadata:
    track_id: str
    name: str
    path: str
    format_id: str
    track_kind: TrackKind
    chroms: list[dict[str, Any]] = field(default_factory=list)
    resolutions: list[int] = field(default_factory=list)
    normalizations: list[str] = field(default_factory=list)
    columns: list[str] = field(default_factory=list)
    default_column: str | None = None
    has_rgb: bool = False
    value_min: float | None = None
    value_max: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "track_id": self.track_id,
            "name": self.name,
            "path": self.path,
            "format_id": self.format_id,
            "track_kind": self.track_kind,
            "chroms": self.chroms,
            "resolutions": self.resolutions,
            "normalizations": self.normalizations,
            "columns": self.columns,
            "default_column": self.default_column,
            "has_rgb": self.has_rgb,
            "value_min": self.value_min,
            "value_max": self.value_max,
            "extra": self.extra,
        }


class TrackAdapter(Protocol):
    path: Path
    format_id: str
    track_kind: TrackKind

    def get_metadata(self, track_id: str) -> TrackMetadata: ...
    def close(self) -> None: ...
