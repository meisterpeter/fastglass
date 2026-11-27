from __future__ import annotations

import gzip
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from .base import TrackMetadata, resolve_chrom


def _open_text(path: Path):
    if path.suffix.lower() == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


class BedpeAdapter:
    """Adapter for .bedpe paired 2D genomic intervals (loops, arcs, domains)."""

    format_id = "bedpe"
    track_kind = "feature2d"

    def __init__(self, path: Path) -> None:
        self.path = path
        self._pairs: dict[tuple[str, str], dict[str, Any]] = {}
        self.chrom_lengths: dict[str, int] = {}
        self._load()

    def _load(self) -> None:
        raw: dict[tuple[str, str], list[tuple[int, int, int, int, str, float, str | None]]] = defaultdict(list)
        with _open_text(self.path) as fh:
            for line in fh:
                s = line.strip()
                if not s or s.startswith("#") or s.startswith("track ") or s.startswith("browser "):
                    continue
                parts = s.split("\t")
                if len(parts) < 6:
                    parts = s.split()
                if len(parts) < 6:
                    continue
                try:
                    c1, s1, e1 = parts[0], int(float(parts[1])), int(float(parts[2]))
                    c2, s2, e2 = parts[3], int(float(parts[4])), int(float(parts[5]))
                except ValueError:
                    continue
                name = parts[6] if len(parts) > 6 else ""
                score = np.nan
                if len(parts) > 7:
                    try:
                        score = float(parts[7])
                    except ValueError:
                        score = np.nan
                color = None
                if len(parts) > 10 and "," in parts[10]:
                    color = f"rgb({parts[10]})"
                raw[(c1, c2)].append((s1, e1, s2, e2, name, score, color))
                self.chrom_lengths[c1] = max(self.chrom_lengths.get(c1, 0), e1)
                self.chrom_lengths[c2] = max(self.chrom_lengths.get(c2, 0), e2)

        for key, rows in raw.items():
            rows.sort(key=lambda r: r[0])
            self._pairs[key] = {
                "s1": np.asarray([r[0] for r in rows], dtype=np.int64),
                "e1": np.asarray([r[1] for r in rows], dtype=np.int64),
                "s2": np.asarray([r[2] for r in rows], dtype=np.int64),
                "e2": np.asarray([r[3] for r in rows], dtype=np.int64),
                "names": [r[4] for r in rows],
                "scores": np.asarray([r[5] for r in rows], dtype=np.float32),
                "colors": [r[6] for r in rows],
            }

    def features_1d(self, chrom: str, start: int, end: int, max_items: int = 3000) -> dict[str, Any]:
        chroms = list(self.chrom_lengths.keys())
        rc = resolve_chrom(chrom, chroms)
        if rc is None or (rc, rc) not in self._pairs:
            return {"mode": "arcs", "items": [], "total": 0}
        d = self._pairs[(rc, rc)]
        span_s = np.minimum(d["s1"], d["s2"])
        span_e = np.maximum(d["e1"], d["e2"])
        mask = (span_e > start) & (span_s < end)
        idx = np.nonzero(mask)[0]
        total = int(len(idx))
        if total > max_items:
            idx = idx[:max_items]
        items = [
            {
                "start1": int(d["s1"][i]),
                "end1": int(d["e1"][i]),
                "start2": int(d["s2"][i]),
                "end2": int(d["e2"][i]),
                "name": d["names"][i],
                "score": None if np.isnan(d["scores"][i]) else float(d["scores"][i]),
                "color": d["colors"][i],
            }
            for i in idx.tolist()
        ]
        return {"mode": "arcs", "items": items, "total": total, "truncated": total > max_items}

    def features_2d(
        self,
        chrom_x: str,
        chrom_y: str,
        start_x: int,
        end_x: int,
        start_y: int,
        end_y: int,
        max_items: int = 4000,
    ) -> dict[str, Any]:
        chroms = list(self.chrom_lengths.keys())
        rx = resolve_chrom(chrom_x, chroms)
        ry = resolve_chrom(chrom_y, chroms)
        if rx is None or ry is None:
            return {"items": []}
        items: list[dict[str, Any]] = []
        for pair_key, transposed in [((rx, ry), False), ((ry, rx), True)]:
            if transposed and rx == ry:
                continue
            d = self._pairs.get(pair_key)
            if d is None:
                continue
            s1, e1, s2, e2 = (d["s2"], d["e2"], d["s1"], d["e1"]) if transposed else (d["s1"], d["e1"], d["s2"], d["e2"])
            mask = (e1 > start_x) & (s1 < end_x) & (e2 > start_y) & (s2 < end_y)
            if rx == ry:
                mask = mask | ((e2 > start_x) & (s2 < end_x) & (e1 > start_y) & (s1 < end_y))
            idx = np.nonzero(mask)[0]
            for i in idx[:max_items].tolist():
                items.append(
                    {
                        "start1": int(s1[i]),
                        "end1": int(e1[i]),
                        "start2": int(s2[i]),
                        "end2": int(e2[i]),
                        "name": d["names"][i],
                        "score": None if np.isnan(d["scores"][i]) else float(d["scores"][i]),
                        "color": d["colors"][i],
                        "kind": "loop",
                    }
                )
        return {"items": items[:max_items]}

    def get_metadata(self, track_id: str) -> TrackMetadata:
        return TrackMetadata(
            track_id=track_id,
            name=self.path.name,
            path=str(self.path),
            format_id=self.format_id,
            track_kind="feature2d",
            chroms=[{"name": c, "length": l} for c, l in self.chrom_lengths.items()],
            extra={"can_overlay_2d": True},
        )

    def close(self) -> None:
        pass
