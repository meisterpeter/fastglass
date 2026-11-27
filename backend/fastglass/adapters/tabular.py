from __future__ import annotations

import csv
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


_CHROM_CANDIDATES = {"chrom", "#chrom", "chr", "chromosome", "seqname", "seqnames", "contig", "scaffold"}
_START_CANDIDATES = {
    "start",
    "start_bp",
    "chromstart",
    "bin_start",
    "begin",
    "pos",
    "position",
    "pos_bp",
    "mid",
    "mid_bp",
    "midpoint",
    "center",
    "center_bp",
    "coord",
    "bp",
}
_END_CANDIDATES = {"end", "end_bp", "chromend", "bin_end", "stop", "stop_bp"}
_NAME_CANDIDATES = {"name", "id", "gene", "gene_name", "label", "motif", "site", "cluster", "state", "type"}
_STRAND_CANDIDATES = {"strand", "orient", "orientation"}
_DEPRIORITIZED_SIGNAL = {
    "valid",
    "is_valid",
    "bin",
    "bin_id",
    "bin_idx",
    "index",
    "idx",
    "mid",
    "mid_bp",
    "midpoint",
    "center",
    "center_bp",
    "length",
    "width",
    "size",
    "pos",
    "position",
    "start",
    "end",
    "start_bp",
    "end_bp",
    "start_kb",
    "end_kb",
    "pos_kb",
    "pos_mb",
    "mid_kb",
    "mid_mb",
}

_CHROM_FROM_NAME_RE = re.compile(r"(chr(?:[IVX]+|\d+|X|Y|M|MtDNA))", re.IGNORECASE)


def _infer_chrom_from_filename(name: str) -> str:
    m = _CHROM_FROM_NAME_RE.search(name)
    if m:
        raw = m.group(1)
        return "chr" + raw[3:]
    return "chrX"


def _is_float(val: str) -> bool:
    if not val or val in (".", "NA", "NaN", "nan", "null", "None", ""):
        return False
    try:
        float(val)
        return True
    except ValueError:
        return False


def _parse_float(val: str) -> float:
    if not val or val in (".", "NA", "NaN", "nan", "null", "None"):
        return float("nan")
    try:
        return float(val)
    except ValueError:
        return float("nan")


class GenericTabularAdapter:
    """Generic auto-detecting adapter for .tsv, .csv, .tab, .txt genomic tables."""

    format_id = "tabular"
    track_kind = "signal1d"

    def __init__(self, path: Path) -> None:
        self.path = path
        self.chrom_lengths: dict[str, int] = {}
        self.columns: list[str] = []
        self.default_column: str | None = None
        self._col_ranges: dict[str, tuple[float, float]] = {}
        self._mode: str = "signal1d"
        self._signal_by_chrom: dict[str, dict[str, Any]] = {}
        self._intervals_by_chrom: dict[str, dict[str, Any]] = {}
        self._pairs: dict[tuple[str, str], dict[str, Any]] = {}
        self._detected_info: dict[str, Any] = {}
        self._load()

    def _detect_delimiter(self, sample_lines: list[str]) -> str | None:
        ext = self.path.suffix.lower()
        if ext == ".gz" and len(self.path.suffixes) >= 2:
            ext = self.path.suffixes[-2].lower()
        first = sample_lines[0] if sample_lines else ""
        if ext == ".csv":
            return ","
        if "\t" in first:
            return "\t"
        if "," in first and first.count(",") >= 2:
            return ","
        return None

    def _split_row(self, line: str, delim: str | None) -> list[str]:
        if delim == ",":
            return next(csv.reader([line]))
        if delim is not None:
            return line.split(delim)
        return line.split()

    def _load(self) -> None:
        raw_lines: list[str] = []
        with _open_text(self.path) as fh:
            for line in fh:
                s = line.strip()
                if not s or s.startswith("##") or s.startswith("track ") or s.startswith("browser "):
                    continue
                raw_lines.append(s)
        if not raw_lines:
            raise ValueError(f"Empty tabular file: {self.path.name}")

        delim = self._detect_delimiter(raw_lines[:10])
        first_row = self._split_row(raw_lines[0], delim)
        first_norm = [c.strip().lstrip("#").lower() for c in first_row]
        numeric_in_first = sum(1 for c in first_row if _is_float(c))
        has_known_hdr = any(
            c in _CHROM_CANDIDATES or c in _START_CANDIDATES or c in _END_CANDIDATES or c in ("chrom1", "chr1", "start1")
            for c in first_norm
        )
        has_header = has_known_hdr or (len(raw_lines) > 1 and numeric_in_first < len(first_row) / 2 and raw_lines[0].startswith("#") or (numeric_in_first == 0 and len(first_row) >= 2))

        if has_header:
            headers = [c.strip().lstrip("#") for c in first_row]
            data_lines = raw_lines[1:]
        else:
            headers = [f"col_{i}" for i in range(len(first_row))]
            data_lines = raw_lines

        headers_low = [h.lower() for h in headers]
        rows = [self._split_row(ln, delim) for ln in data_lines]
        rows = [r for r in rows if len(r) >= min(2, len(headers))]
        if not rows:
            raise ValueError(f"No data rows found in tabular file: {self.path.name}")

        def find_col(names: set[str]) -> int | None:
            for i, h in enumerate(headers_low):
                if h in names:
                    return i
            return None

        c1_i = find_col({"chrom1", "chr1", "chromosome1"})
        s1_i = find_col({"start1", "start1_bp", "pos1", "pos1_bp", "mid1", "mid1_bp"})
        e1_i = find_col({"end1", "end1_bp"})
        c2_i = find_col({"chrom2", "chr2", "chromosome2"})
        s2_i = find_col({"start2", "start2_bp", "pos2", "pos2_bp", "mid2", "mid2_bp"})
        e2_i = find_col({"end2", "end2_bp"})

        if s1_i is not None and s2_i is not None:
            self._load_2d(rows, headers, c1_i, s1_i, e1_i, c2_i, s2_i, e2_i)
            return

        chrom_i = find_col(_CHROM_CANDIDATES)
        start_i = find_col(_START_CANDIDATES)
        end_i = find_col(_END_CANDIDATES)
        name_i = find_col(_NAME_CANDIDATES)
        strand_i = find_col(_STRAND_CANDIDATES)

        if start_i is None:
            sample = rows[:20]
            if len(sample[0]) >= 3 and all(_is_float(r[1]) for r in sample if len(r) > 1):
                if not all(_is_float(r[0]) for r in sample):
                    chrom_i = 0
                    start_i = 1
                    if all(_is_float(r[2]) for r in sample if len(r) > 2):
                        if all(float(r[2]) >= float(r[1]) for r in sample if len(r) > 2):
                            end_i = 2
                else:
                    start_i = 0

        if start_i is None:
            raise ValueError(
                f"Could not detect genomic coordinate column (e.g. start/pos/mid) in {self.path.name}. "
                f"Columns found: {headers}"
            )

        start_hdr = headers_low[start_i]
        coord_mult = 1
        if start_hdr.endswith("_kb") or start_hdr == "kb":
            coord_mult = 1_000
        elif start_hdr.endswith("_mb") or start_hdr == "mb":
            coord_mult = 1_000_000

        end_mult = 1
        if end_i is not None:
            eh = headers_low[end_i]
            if eh.endswith("_kb") or eh == "kb":
                end_mult = 1_000
            elif eh.endswith("_mb") or eh == "mb":
                end_mult = 1_000_000

        coord_cols = {i for i in (chrom_i, start_i, end_i, strand_i) if i is not None}
        sample = rows[: min(200, len(rows))]
        num_cols: list[int] = []
        for idx in range(len(headers)):
            if idx in coord_cols:
                continue
            vals_present = [r[idx] for r in sample if idx < len(r) and r[idx] not in ("", ".", "NA", "NaN", "nan")]
            if not vals_present:
                continue
            n_float = sum(1 for v in vals_present if _is_float(v))
            if n_float >= 0.8 * len(vals_present):
                num_cols.append(idx)

        default_chrom = _infer_chrom_from_filename(self.path.name)

        raw_s: dict[str, list[int]] = defaultdict(list)
        raw_e: dict[str, list[int]] = defaultdict(list)
        raw_vals: dict[str, dict[str, list[float]]] = defaultdict(lambda: {headers[ci]: [] for ci in num_cols})
        raw_names: dict[str, list[str]] = defaultdict(list)
        raw_strands: dict[str, list[str]] = defaultdict(list)

        for r in rows:
            if start_i >= len(r):
                continue
            try:
                st = int(round(float(r[start_i]) * coord_mult))
            except ValueError:
                continue
            en = st
            if end_i is not None and end_i < len(r):
                try:
                    en = int(round(float(r[end_i]) * end_mult))
                except ValueError:
                    en = st
            chrom = r[chrom_i].strip() if (chrom_i is not None and chrom_i < len(r) and r[chrom_i].strip()) else default_chrom
            raw_s[chrom].append(st)
            raw_e[chrom].append(en)
            for ci in num_cols:
                raw_vals[chrom][headers[ci]].append(_parse_float(r[ci]) if ci < len(r) else float("nan"))
            raw_names[chrom].append(r[name_i] if (name_i is not None and name_i < len(r)) else "")
            raw_strands[chrom].append(r[strand_i] if (strand_i is not None and strand_i < len(r)) else ".")

        inferred_width = 1000
        if end_i is None:
            all_diffs: list[np.ndarray] = []
            for c, sl in raw_s.items():
                if len(sl) >= 2:
                    arr = np.sort(np.asarray(sl, dtype=np.int64))
                    d = np.diff(arr)
                    d = d[d > 0]
                    if len(d):
                        all_diffs.append(d)
            if all_diffs:
                med = int(np.median(np.concatenate(all_diffs)))
                inferred_width = max(1, min(med, 1_000_000))

        preferred_cols = [headers[ci] for ci in num_cols if headers_low[ci] not in _DEPRIORITIZED_SIGNAL]
        all_signal_cols = [headers[ci] for ci in num_cols]

        if preferred_cols or (all_signal_cols and len(rows) > 50):
            self._mode = "signal1d"
            self.track_kind = "signal1d"
            self.columns = preferred_cols + [c for c in all_signal_cols if c not in preferred_cols]
            self.default_column = preferred_cols[0] if preferred_cols else all_signal_cols[0]

            for col in self.columns:
                self._col_ranges[col] = (float("inf"), float("-inf"))

            for c, sl in raw_s.items():
                starts = np.asarray(sl, dtype=np.int64)
                ends = np.asarray(raw_e[c], dtype=np.int64)
                if end_i is None:
                    if "mid" in start_hdr or "center" in start_hdr:
                        half = inferred_width // 2
                        starts = np.maximum(0, starts - half)
                        ends = starts + inferred_width
                    else:
                        ends = starts + inferred_width
                else:
                    ends = np.maximum(ends, starts + 1)

                order = np.argsort(starts, kind="mergesort")
                starts = starts[order]
                ends = ends[order]
                col_arrays: dict[str, np.ndarray] = {}
                for col in self.columns:
                    arr = np.asarray(raw_vals[c][col], dtype=np.float32)[order]
                    col_arrays[col] = arr
                    fin = arr[np.isfinite(arr)]
                    if len(fin):
                        lo, hi = self._col_ranges[col]
                        self._col_ranges[col] = (min(lo, float(np.min(fin))), max(hi, float(np.max(fin))))

                self._signal_by_chrom[c] = {"starts": starts, "ends": ends, "cols": col_arrays}
                self.chrom_lengths[c] = int(np.max(ends)) if len(ends) else 0
        else:
            self._mode = "interval1d"
            self.track_kind = "interval1d"
            for c, sl in raw_s.items():
                starts = np.asarray(sl, dtype=np.int64)
                ends = np.asarray(raw_e[c], dtype=np.int64)
                if end_i is None:
                    ends = starts + inferred_width
                else:
                    ends = np.maximum(ends, starts + 1)
                order = np.argsort(starts, kind="mergesort")
                starts = starts[order]
                ends = ends[order]
                self._intervals_by_chrom[c] = {
                    "starts": starts,
                    "ends": ends,
                    "prefix_max_end": np.maximum.accumulate(ends),
                    "names": [raw_names[c][i] for i in order],
                    "strands": [raw_strands[c][i] for i in order],
                }
                self.chrom_lengths[c] = int(np.max(ends)) if len(ends) else 0

        self._detected_info = {
            "delimiter": "tab" if delim == "\t" else (delim or "whitespace"),
            "has_header": has_header,
            "chrom_col": headers[chrom_i] if chrom_i is not None else f"(inferred: {default_chrom})",
            "start_col": headers[start_i],
            "end_col": headers[end_i] if end_i is not None else f"(inferred +{inferred_width}bp)",
        }

    def _load_2d(
        self,
        rows: list[list[str]],
        headers: list[str],
        c1_i: int | None,
        s1_i: int,
        e1_i: int | None,
        c2_i: int | None,
        s2_i: int,
        e2_i: int | None,
    ) -> None:
        self._mode = "feature2d"
        self.track_kind = "feature2d"
        default_chrom = _infer_chrom_from_filename(self.path.name)
        raw: dict[tuple[str, str], list[tuple[int, int, int, int, str]]] = defaultdict(list)
        for r in rows:
            if max(s1_i, s2_i) >= len(r):
                continue
            try:
                s1 = int(float(r[s1_i]))
                e1 = int(float(r[e1_i])) if (e1_i is not None and e1_i < len(r)) else s1 + 1000
                s2 = int(float(r[s2_i]))
                e2 = int(float(r[e2_i])) if (e2_i is not None and e2_i < len(r)) else s2 + 1000
            except ValueError:
                continue
            c1 = r[c1_i].strip() if (c1_i is not None and c1_i < len(r)) else default_chrom
            c2 = r[c2_i].strip() if (c2_i is not None and c2_i < len(r)) else c1
            raw[(c1, c2)].append((s1, max(e1, s1 + 1), s2, max(e2, s2 + 1), ""))
            self.chrom_lengths[c1] = max(self.chrom_lengths.get(c1, 0), e1)
            self.chrom_lengths[c2] = max(self.chrom_lengths.get(c2, 0), e2)

        for key, items in raw.items():
            items.sort(key=lambda t: t[0])
            self._pairs[key] = {
                "s1": np.asarray([t[0] for t in items], dtype=np.int64),
                "e1": np.asarray([t[1] for t in items], dtype=np.int64),
                "s2": np.asarray([t[2] for t in items], dtype=np.int64),
                "e2": np.asarray([t[3] for t in items], dtype=np.int64),
            }

    def signal_1d(
        self, chrom: str, start: int, end: int, bins: int = 800, column: str | None = None
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        empty = np.full(max(1, bins), np.nan, dtype=np.float32)
        if self._mode != "signal1d":
            return empty, empty.copy(), empty.copy()
        resolved = resolve_chrom(chrom, list(self._signal_by_chrom.keys()))
        if resolved is None:
            return empty, empty.copy(), empty.copy()
        col = column if (column and column in self.columns) else self.default_column
        if col is None:
            return empty, empty.copy(), empty.copy()
        d = self._signal_by_chrom[resolved]
        return bin_intervals_to_signal(d["starts"], d["ends"], d["cols"][col], start, end, bins)

    def features_1d(self, chrom: str, start: int, end: int, max_items: int = 4000) -> dict[str, Any]:
        if self._mode == "interval1d":
            resolved = resolve_chrom(chrom, list(self._intervals_by_chrom.keys()))
            if resolved is None:
                return {"mode": "intervals", "items": [], "total": 0}
            d = self._intervals_by_chrom[resolved]
            right = int(np.searchsorted(d["starts"], end, side="left"))
            if right == 0:
                return {"mode": "intervals", "items": [], "total": 0}
            left = int(np.searchsorted(d["prefix_max_end"][:right], start, side="right"))
            idx = np.nonzero(d["ends"][left:right] > start)[0] + left
            total = int(len(idx))
            if total > max_items:
                pick = np.linspace(0, total - 1, max_items, dtype=np.int64)
                idx = idx[pick]
            items = [
                {
                    "start": int(d["starts"][i]),
                    "end": int(d["ends"][i]),
                    "name": d["names"][i],
                    "strand": d["strands"][i],
                    "color": None,
                }
                for i in idx.tolist()
            ]
            return {"mode": "intervals", "items": items, "total": total}
        elif self._mode == "feature2d":
            rc = resolve_chrom(chrom, list(self.chrom_lengths.keys()))
            if rc is None or (rc, rc) not in self._pairs:
                return {"mode": "arcs", "items": [], "total": 0}
            d = self._pairs[(rc, rc)]
            span_s = np.minimum(d["s1"], d["s2"])
            span_e = np.maximum(d["e1"], d["e2"])
            idx = np.nonzero((span_e > start) & (span_s < end))[0]
            total = int(len(idx))
            if total > max_items:
                idx = idx[:max_items]
            items = [
                {
                    "start1": int(d["s1"][i]),
                    "end1": int(d["e1"][i]),
                    "start2": int(d["s2"][i]),
                    "end2": int(d["e2"][i]),
                    "name": "",
                    "score": None,
                    "color": None,
                }
                for i in idx.tolist()
            ]
            return {"mode": "arcs", "items": items, "total": total}
        return {"mode": "intervals", "items": [], "total": 0}

    def features_2d(
        self, chrom_x: str, chrom_y: str, start_x: int, end_x: int, start_y: int, end_y: int, max_items: int = 4000
    ) -> dict[str, Any]:
        if self._mode == "feature2d":
            rx = resolve_chrom(chrom_x, list(self.chrom_lengths.keys()))
            ry = resolve_chrom(chrom_y, list(self.chrom_lengths.keys()))
            if rx is None or ry is None:
                return {"items": []}
            d = self._pairs.get((rx, ry))
            if d is None:
                return {"items": []}
            mask = (d["e1"] > start_x) & (d["s1"] < end_x) & (d["e2"] > start_y) & (d["s2"] < end_y)
            if rx == ry:
                mask = mask | ((d["e2"] > start_x) & (d["s2"] < end_x) & (d["e1"] > start_y) & (d["s1"] < end_y))
            idx = np.nonzero(mask)[0][:max_items]
            return {
                "items": [
                    {
                        "start1": int(d["s1"][i]),
                        "end1": int(d["e1"][i]),
                        "start2": int(d["s2"][i]),
                        "end2": int(d["e2"][i]),
                        "kind": "loop",
                    }
                    for i in idx.tolist()
                ]
            }
        return {"items": []}

    def get_metadata(self, track_id: str) -> TrackMetadata:
        vmin = vmax = None
        if self.default_column and self.default_column in self._col_ranges:
            lo, hi = self._col_ranges[self.default_column]
            if np.isfinite(lo):
                vmin, vmax = lo, hi
        return TrackMetadata(
            track_id=track_id,
            name=self.path.name,
            path=str(self.path),
            format_id=self.format_id,
            track_kind=self.track_kind,
            chroms=[{"name": c, "length": l} for c, l in self.chrom_lengths.items()],
            columns=self.columns,
            default_column=self.default_column,
            value_min=vmin,
            value_max=vmax,
            extra={
                "detected": self._detected_info,
                "can_overlay_2d": self._mode == "feature2d",
            },
        )

    def close(self) -> None:
        pass
