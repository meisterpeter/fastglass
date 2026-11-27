from __future__ import annotations

import gzip
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from .base import TrackMetadata, bin_intervals_to_signal, resolve_chrom


def _open_text(path: Path):
    if path.suffix.lower() == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def _parse_rgb(val: str) -> str | None:
    parts = val.strip().split(",")
    if len(parts) == 3:
        try:
            r, g, b = int(parts[0]), int(parts[1]), int(parts[2])
            if 0 <= r <= 255 and 0 <= g <= 255 and 0 <= b <= 255:
                return f"rgb({r},{g},{b})"
        except ValueError:
            pass
    return None


class BedAdapter:
    """Fast in-memory sorted-array adapter for .bed (BED3/4/6/9/12, itemRgb) files."""

    format_id = "bed"
    track_kind = "interval1d"

    def __init__(self, path: Path) -> None:
        self.path = path
        self.has_rgb = False
        self._by_chrom: dict[str, dict[str, Any]] = {}
        self.chrom_lengths: dict[str, int] = {}
        self._load()

    def _load(self) -> None:
        raw_s: dict[str, list[int]] = defaultdict(list)
        raw_e: dict[str, list[int]] = defaultdict(list)
        raw_name: dict[str, list[str]] = defaultdict(list)
        raw_score: dict[str, list[float]] = defaultdict(list)
        raw_strand: dict[str, list[str]] = defaultdict(list)
        raw_color: dict[str, list[str | None]] = defaultdict(list)

        with _open_text(self.path) as fh:
            for line in fh:
                s = line.strip()
                if not s or s.startswith("#") or s.startswith("track ") or s.startswith("browser "):
                    continue
                parts = s.split("\t")
                if len(parts) < 3:
                    parts = s.split()
                if len(parts) < 3:
                    continue
                try:
                    chrom = parts[0]
                    st = int(float(parts[1]))
                    en = int(float(parts[2]))
                except ValueError:
                    continue
                if en < st:
                    st, en = en, st
                name = parts[3] if len(parts) > 3 else ""
                score = np.nan
                if len(parts) > 4:
                    try:
                        score = float(parts[4])
                    except ValueError:
                        score = np.nan
                strand = parts[5] if len(parts) > 5 else "."
                color = None
                if len(parts) > 8:
                    color = _parse_rgb(parts[8])
                    if color is not None:
                        self.has_rgb = True
                raw_s[chrom].append(st)
                raw_e[chrom].append(en)
                raw_name[chrom].append(name)
                raw_score[chrom].append(score)
                raw_strand[chrom].append(strand)
                raw_color[chrom].append(color)

        for chrom, s_list in raw_s.items():
            starts = np.asarray(s_list, dtype=np.int64)
            ends = np.asarray(raw_e[chrom], dtype=np.int64)
            order = np.argsort(starts, kind="mergesort")
            starts = starts[order]
            ends = ends[order]
            scores = np.asarray(raw_score[chrom], dtype=np.float32)[order]
            names = [raw_name[chrom][i] for i in order]
            strands = [raw_strand[chrom][i] for i in order]
            colors = [raw_color[chrom][i] for i in order]
            prefix_max_end = np.maximum.accumulate(ends)
            self._by_chrom[chrom] = {
                "starts": starts,
                "ends": ends,
                "prefix_max_end": prefix_max_end,
                "scores": scores,
                "names": names,
                "strands": strands,
                "colors": colors,
            }
            self.chrom_lengths[chrom] = int(np.max(ends)) if len(ends) else 0

    def _slice_indices(self, chrom: str, start: int, end: int) -> tuple[str | None, np.ndarray]:
        resolved = resolve_chrom(chrom, list(self._by_chrom.keys()))
        if resolved is None:
            return None, np.empty(0, dtype=np.int64)
        data = self._by_chrom[resolved]
        starts = data["starts"]
        ends = data["ends"]
        pmax = data["prefix_max_end"]
        right = int(np.searchsorted(starts, end, side="left"))
        if right == 0:
            return resolved, np.empty(0, dtype=np.int64)
        left = int(np.searchsorted(pmax[:right], start, side="right"))
        sub_ends = ends[left:right]
        mask = sub_ends > start
        idx = np.nonzero(mask)[0] + left
        return resolved, idx

    def features_1d(self, chrom: str, start: int, end: int, max_items: int = 4000) -> dict[str, Any]:
        resolved, idx = self._slice_indices(chrom, start, end)
        if resolved is None or len(idx) == 0:
            return {"mode": "intervals", "items": [], "total": 0}
        data = self._by_chrom[resolved]
        total = int(len(idx))

        if total > max_items:
            pick = np.linspace(0, total - 1, max_items, dtype=np.int64)
            idx = idx[pick]

        starts = data["starts"]
        ends = data["ends"]
        scores = data["scores"]
        names = data["names"]
        strands = data["strands"]
        colors = data["colors"]

        items = [
            {
                "start": int(starts[i]),
                "end": int(ends[i]),
                "name": names[i],
                "score": None if np.isnan(scores[i]) else float(scores[i]),
                "strand": strands[i],
                "color": colors[i],
            }
            for i in idx.tolist()
        ]
        return {"mode": "intervals", "items": items, "total": total, "truncated": total > max_items}

    def features_2d(
        self, chrom_x: str, chrom_y: str, start_x: int, end_x: int, start_y: int, end_y: int, max_items: int = 3000
    ) -> dict[str, Any]:
        rx = resolve_chrom(chrom_x, list(self._by_chrom.keys()))
        ry = resolve_chrom(chrom_y, list(self._by_chrom.keys()))
        if rx is None or rx != ry:
            return {"items": []}
        q_start = min(start_x, start_y)
        q_end = max(end_x, end_y)
        resolved, idx = self._slice_indices(rx, q_start, q_end)
        if resolved is None or len(idx) == 0:
            return {"items": []}
        data = self._by_chrom[resolved]
        if len(idx) > max_items:
            idx = idx[:max_items]
        items = [
            {
                "start1": int(data["starts"][i]),
                "end1": int(data["ends"][i]),
                "start2": int(data["starts"][i]),
                "end2": int(data["ends"][i]),
                "name": data["names"][i],
                "score": None if np.isnan(data["scores"][i]) else float(data["scores"][i]),
                "color": data["colors"][i],
                "kind": "domain",
            }
            for i in idx.tolist()
        ]
        return {"items": items}

    def get_metadata(self, track_id: str) -> TrackMetadata:
        return TrackMetadata(
            track_id=track_id,
            name=self.path.name,
            path=str(self.path),
            format_id=self.format_id,
            track_kind="interval1d",
            chroms=[{"name": c, "length": l} for c, l in self.chrom_lengths.items()],
            has_rgb=self.has_rgb,
            extra={"can_overlay_2d": True},
        )

    def close(self) -> None:
        pass


class BedGraphAdapter:
    """Fast sorted-array adapter for .bedGraph / .bg files."""

    format_id = "bedgraph"
    track_kind = "signal1d"

    def __init__(self, path: Path) -> None:
        self.path = path
        self._by_chrom: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
        self.chrom_lengths: dict[str, int] = {}
        self.val_min: float | None = None
        self.val_max: float | None = None
        self._load()

    def _load(self) -> None:
        raw_s: dict[str, list[int]] = defaultdict(list)
        raw_e: dict[str, list[int]] = defaultdict(list)
        raw_v: dict[str, list[float]] = defaultdict(list)
        with _open_text(self.path) as fh:
            for line in fh:
                s = line.strip()
                if not s or s.startswith("#") or s.startswith("track ") or s.startswith("browser "):
                    continue
                parts = s.split()
                if len(parts) < 4:
                    continue
                try:
                    c = parts[0]
                    st = int(float(parts[1]))
                    en = int(float(parts[2]))
                    val = float(parts[3])
                except ValueError:
                    continue
                raw_s[c].append(st)
                raw_e[c].append(en)
                raw_v[c].append(val)

        gmin, gmax = np.inf, -np.inf
        for c, sl in raw_s.items():
            starts = np.asarray(sl, dtype=np.int64)
            ends = np.asarray(raw_e[c], dtype=np.int64)
            vals = np.asarray(raw_v[c], dtype=np.float32)
            order = np.argsort(starts, kind="mergesort")
            starts, ends, vals = starts[order], ends[order], vals[order]
            self._by_chrom[c] = (starts, ends, vals)
            self.chrom_lengths[c] = int(np.max(ends)) if len(ends) else 0
            fin = vals[np.isfinite(vals)]
            if len(fin):
                gmin = min(gmin, float(np.min(fin)))
                gmax = max(gmax, float(np.max(fin)))
        if np.isfinite(gmin):
            self.val_min = gmin
            self.val_max = gmax

    def signal_1d(
        self, chrom: str, start: int, end: int, bins: int = 800, column: str | None = None
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        resolved = resolve_chrom(chrom, list(self._by_chrom.keys()))
        if resolved is None:
            empty = np.full(max(1, bins), np.nan, dtype=np.float32)
            return empty, empty.copy(), empty.copy()
        starts, ends, vals = self._by_chrom[resolved]
        return bin_intervals_to_signal(starts, ends, vals, start, end, bins)

    def get_metadata(self, track_id: str) -> TrackMetadata:
        return TrackMetadata(
            track_id=track_id,
            name=self.path.name,
            path=str(self.path),
            format_id=self.format_id,
            track_kind="signal1d",
            chroms=[{"name": c, "length": l} for c, l in self.chrom_lengths.items()],
            value_min=self.val_min,
            value_max=self.val_max,
        )

    def close(self) -> None:
        pass


_GTF_ATTR_RE = re.compile(r'(\w+)\s+"([^"]+)"')


def _parse_attrs(attr_str: str, is_gff: bool) -> dict[str, str]:
    out: dict[str, str] = {}
    if is_gff:
        for item in attr_str.split(";"):
            item = item.strip()
            if "=" in item:
                k, v = item.split("=", 1)
                out[k.strip()] = v.strip()
    else:
        for m in _GTF_ATTR_RE.finditer(attr_str):
            out[m.group(1)] = m.group(2)
    return out


class GeneAnnotationAdapter:
    """Fast gene/transcript/exon adapter for .gtf and .gff3 files."""

    format_id = "gtf"
    track_kind = "gene1d"

    def __init__(self, path: Path) -> None:
        self.path = path
        low = path.name.lower()
        self._is_gff = ".gff" in low
        self.format_id = "gff3" if self._is_gff else "gtf"
        self._by_chrom: dict[str, dict[str, Any]] = {}
        self.chrom_lengths: dict[str, int] = {}
        self._load()

    def _load(self) -> None:
        genes: dict[tuple[str, str], dict[str, Any]] = {}
        parent_to_gene: dict[str, str] = {}

        with _open_text(self.path) as fh:
            for line in fh:
                if not line or line.startswith("#"):
                    continue
                parts = line.rstrip("\n\r").split("\t")
                if len(parts) < 9:
                    continue
                chrom, _src, ftype, st_s, en_s, _sc, strand, _ph, attr_s = parts[:9]
                ftype_l = ftype.lower()
                if ftype_l not in ("gene", "transcript", "mrna", "exon", "cds"):
                    continue
                try:
                    st = max(0, int(st_s) - 1)
                    en = int(en_s)
                except ValueError:
                    continue
                attrs = _parse_attrs(attr_s, self._is_gff)
                if self._is_gff:
                    if ftype_l == "gene":
                        gid = attrs.get("ID") or attrs.get("Name") or f"{chrom}:{st}-{en}"
                        name = attrs.get("Name") or attrs.get("gene_name") or gid
                        g = genes.setdefault(
                            (chrom, gid),
                            {"start": st, "end": en, "strand": strand, "name": name, "exons": []},
                        )
                        g["start"] = min(g["start"], st)
                        g["end"] = max(g["end"], en)
                        g["name"] = name
                    elif ftype_l in ("transcript", "mrna"):
                        tid = attrs.get("ID", "")
                        pid = attrs.get("Parent", tid)
                        if tid and pid:
                            parent_to_gene[tid] = pid
                        g = genes.setdefault(
                            (chrom, pid),
                            {"start": st, "end": en, "strand": strand, "name": attrs.get("Name") or pid, "exons": []},
                        )
                        g["start"] = min(g["start"], st)
                        g["end"] = max(g["end"], en)
                    elif ftype_l in ("exon", "cds"):
                        pid = attrs.get("Parent", "").split(",")[0]
                        gid = parent_to_gene.get(pid, pid or f"{chrom}:{st}-{en}")
                        g = genes.setdefault(
                            (chrom, gid),
                            {"start": st, "end": en, "strand": strand, "name": attrs.get("Name") or gid, "exons": []},
                        )
                        g["start"] = min(g["start"], st)
                        g["end"] = max(g["end"], en)
                        g["exons"].append([st, en])
                else:
                    gid = attrs.get("gene_id") or attrs.get("transcript_id") or f"{chrom}:{st}-{en}"
                    name = attrs.get("gene_name") or attrs.get("gene_symbol") or gid
                    g = genes.setdefault(
                        (chrom, gid),
                        {"start": st, "end": en, "strand": strand, "name": name, "exons": []},
                    )
                    g["start"] = min(g["start"], st)
                    g["end"] = max(g["end"], en)
                    if name and g["name"] == gid:
                        g["name"] = name
                    if ftype_l in ("exon", "cds"):
                        g["exons"].append([st, en])

        per_chrom: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for (chrom, _gid), g in genes.items():
            exons = g["exons"]
            if exons:
                exons.sort()
                merged = [exons[0]]
                for s, e in exons[1:]:
                    if s <= merged[-1][1]:
                        merged[-1][1] = max(merged[-1][1], e)
                    else:
                        merged.append([s, e])
                g["exons"] = merged
            per_chrom[chrom].append(g)

        for chrom, glist in per_chrom.items():
            glist.sort(key=lambda x: x["start"])
            starts = np.asarray([g["start"] for g in glist], dtype=np.int64)
            ends = np.asarray([g["end"] for g in glist], dtype=np.int64)
            pmax = np.maximum.accumulate(ends) if len(ends) else np.empty(0, dtype=np.int64)
            self._by_chrom[chrom] = {
                "starts": starts,
                "ends": ends,
                "prefix_max_end": pmax,
                "genes": glist,
            }
            self.chrom_lengths[chrom] = int(np.max(ends)) if len(ends) else 0

    def features_1d(self, chrom: str, start: int, end: int, max_items: int = 1200) -> dict[str, Any]:
        resolved = resolve_chrom(chrom, list(self._by_chrom.keys()))
        if resolved is None:
            return {"mode": "genes", "items": [], "total": 0}
        data = self._by_chrom[resolved]
        starts = data["starts"]
        ends = data["ends"]
        pmax = data["prefix_max_end"]
        right = int(np.searchsorted(starts, end, side="left"))
        if right == 0:
            return {"mode": "genes", "items": [], "total": 0}
        left = int(np.searchsorted(pmax[:right], start, side="right"))
        idx = np.nonzero(ends[left:right] > start)[0] + left
        total = int(len(idx))
        if total > max_items:
            pick = np.linspace(0, total - 1, max_items, dtype=np.int64)
            idx = idx[pick]
        genes = data["genes"]
        items = [genes[i] for i in idx.tolist()]
        return {"mode": "genes", "items": items, "total": total, "truncated": total > max_items}

    def get_metadata(self, track_id: str) -> TrackMetadata:
        return TrackMetadata(
            track_id=track_id,
            name=self.path.name,
            path=str(self.path),
            format_id=self.format_id,
            track_kind="gene1d",
            chroms=[{"name": c, "length": l} for c, l in self.chrom_lengths.items()],
        )

    def close(self) -> None:
        pass
