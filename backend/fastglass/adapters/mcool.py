from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import h5py
import numpy as np

from .base import TrackMetadata, resolve_chrom


class McoolAdapter:
    """High-speed direct HDF5 reader for .mcool and .cool Hi-C contact matrices."""

    format_id = "mcool"
    track_kind = "matrix2d"

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._h5 = h5py.File(str(path), "r")
        self._is_mcool = "resolutions" in self._h5
        if self._is_mcool:
            res_keys = sorted(int(k) for k in self._h5["resolutions"].keys())
            self.resolutions = res_keys
            self.format_id = "mcool"
        else:
            binsize = int(self._h5.attrs.get("bin-size", 0))
            if binsize <= 0:
                starts = self._h5["bins"]["start"][:2]
                binsize = int(starts[1] - starts[0]) if len(starts) > 1 else 10000
            self.resolutions = [binsize]
            self.format_id = "cool"

        coarsest = self._group(self.resolutions[-1])
        raw_names = coarsest["chroms"]["name"][:]
        raw_lengths = coarsest["chroms"]["length"][:]
        self.chrom_names: list[str] = [
            n.decode("utf-8") if isinstance(n, (bytes, bytearray)) else str(n)
            for n in raw_names
        ]
        self.chrom_lengths: dict[str, int] = {
            name: int(length) for name, length in zip(self.chrom_names, raw_lengths)
        }
        self.chrom_index: dict[str, int] = {name: i for i, name in enumerate(self.chrom_names)}

        finest = self._group(self.resolutions[0])
        bin_cols = set(finest["bins"].keys())
        self.normalizations: list[str] = []
        if "weight" in bin_cols:
            self.normalizations.append("balanced")
            self.normalizations.append("oe")
        self.normalizations.append("raw")
        for extra_w in ("KR", "VC", "VC_SQRT", "SCALE"):
            if extra_w in bin_cols:
                self.normalizations.append(extra_w)

        self._chrom_offsets: dict[int, np.ndarray] = {}
        self._weights_cache: dict[tuple[int, str, str], np.ndarray] = {}
        self._expected_cache: dict[tuple[int, str], np.ndarray] = {}

    def _group(self, resolution: int) -> h5py.Group:
        if self._is_mcool:
            return self._h5["resolutions"][str(resolution)]
        return self._h5

    def _nearest_resolution(self, requested: int) -> int:
        if requested in self.resolutions:
            return requested
        for r in self.resolutions:
            if r >= requested:
                return r
        return self.resolutions[-1]

    def _get_chrom_offset(self, resolution: int) -> np.ndarray:
        if resolution not in self._chrom_offsets:
            grp = self._group(resolution)
            self._chrom_offsets[resolution] = grp["indexes"]["chrom_offset"][:].astype(np.int64)
        return self._chrom_offsets[resolution]

    def _get_chrom_bin_range(self, resolution: int, chrom: str) -> tuple[int, int]:
        resolved = resolve_chrom(chrom, self.chrom_names)
        if resolved is None:
            raise KeyError(f"Chromosome '{chrom}' not found in {self.path.name}")
        idx = self.chrom_index[resolved]
        offsets = self._get_chrom_offset(resolution)
        return int(offsets[idx]), int(offsets[idx + 1])

    def _get_weights(self, resolution: int, chrom: str, weight_col: str) -> np.ndarray | None:
        key = (resolution, chrom, weight_col)
        if key in self._weights_cache:
            return self._weights_cache[key]
        grp = self._group(resolution)
        if weight_col not in grp["bins"]:
            return None
        b0, b1 = self._get_chrom_bin_range(resolution, chrom)
        w = grp["bins"][weight_col][b0:b1].astype(np.float64)
        self._weights_cache[key] = w
        return w

    def _get_expected(self, resolution: int, chrom: str) -> np.ndarray:
        key = (resolution, chrom)
        if key in self._expected_cache:
            return self._expected_cache[key]
        grp = self._group(resolution)
        b0, b1 = self._get_chrom_bin_range(resolution, chrom)
        n_bins = b1 - b0
        w = self._get_weights(resolution, chrom, "weight")
        bin1_offsets = grp["indexes"]["bin1_offset"][b0 : b1 + 1].astype(np.int64)
        p_start = int(bin1_offsets[0])
        p_end = int(bin1_offsets[-1])

        exp_sum = np.zeros(n_bins, dtype=np.float64)
        chunk_size = 2_000_000
        for p0 in range(p_start, p_end, chunk_size):
            p1 = min(p0 + chunk_size, p_end)
            c_b1 = grp["pixels"]["bin1_id"][p0:p1]
            c_b2 = grp["pixels"]["bin2_id"][p0:p1]
            mask = (c_b2 >= b0) & (c_b2 < b1)
            if not np.any(mask):
                continue
            r = (c_b1[mask] - b0).astype(np.int64)
            c = (c_b2[mask] - b0).astype(np.int64)
            cnt = grp["pixels"]["count"][p0:p1][mask].astype(np.float64)
            if w is not None:
                val = cnt * w[r] * w[c]
                good = np.isfinite(val)
                r = r[good]
                c = c[good]
                val = val[good]
            else:
                val = cnt
            dist = c - r
            valid_d = (dist >= 0) & (dist < n_bins)
            np.add.at(exp_sum, dist[valid_d], val[valid_d])

        if w is not None:
            valid_bin = np.isfinite(w) & (w > 0)
            v_f = valid_bin.astype(np.float64)
            fft_len = 1 << (2 * n_bins - 1).bit_length()
            fv = np.fft.rfft(v_f, n=fft_len)
            pair_counts = np.rint(np.fft.irfft(fv * np.conj(fv), n=fft_len)[:n_bins])
            pair_counts = np.maximum(pair_counts, 1.0)
        else:
            pair_counts = np.arange(n_bins, 0, -1, dtype=np.float64)

        expected = exp_sum / pair_counts
        expected[expected <= 0] = np.nan
        self._expected_cache[key] = expected
        return expected

    def _read_rect_upper(
        self,
        grp: h5py.Group,
        row_start: int,
        row_end: int,
        col_start: int,
        col_end: int,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        if row_start >= row_end or col_start >= col_end:
            empty_i = np.empty(0, dtype=np.int64)
            empty_f = np.empty(0, dtype=np.float64)
            return empty_i, empty_i, empty_f
        offsets = grp["indexes"]["bin1_offset"][row_start : row_end + 1]
        p0 = int(offsets[0])
        p1 = int(offsets[-1])
        if p0 >= p1:
            empty_i = np.empty(0, dtype=np.int64)
            empty_f = np.empty(0, dtype=np.float64)
            return empty_i, empty_i, empty_f
        b1 = grp["pixels"]["bin1_id"][p0:p1]
        b2 = grp["pixels"]["bin2_id"][p0:p1]
        mask = (b2 >= col_start) & (b2 < col_end)
        if not np.any(mask):
            empty_i = np.empty(0, dtype=np.int64)
            empty_f = np.empty(0, dtype=np.float64)
            return empty_i, empty_i, empty_f
        cnt = grp["pixels"]["count"][p0:p1][mask].astype(np.float64)
        return b1[mask].astype(np.int64), b2[mask].astype(np.int64), cnt

    def tile_2d(
        self,
        chrom_x: str,
        chrom_y: str,
        resolution: int,
        tile_x: int,
        tile_y: int,
        tile_size: int = 256,
        norm: str = "balanced",
    ) -> tuple[np.ndarray, dict[str, Any]]:
        with self._lock:
            res = self._nearest_resolution(resolution)
            grp = self._group(res)
            res_cx = resolve_chrom(chrom_x, self.chrom_names)
            res_cy = resolve_chrom(chrom_y, self.chrom_names)
            if res_cx is None or res_cy is None:
                mat = np.full((tile_size, tile_size), np.nan, dtype=np.float32)
                return mat, {"resolution": res, "min": 0.0, "max": 0.0, "p98": 0.0}

            bx0, bx1 = self._get_chrom_bin_range(res, res_cx)
            by0, by1 = self._get_chrom_bin_range(res, res_cy)
            nx_chrom = bx1 - bx0
            ny_chrom = by1 - by0

            lx0 = tile_x * tile_size
            lx1 = min(lx0 + tile_size, nx_chrom)
            ly0 = tile_y * tile_size
            ly1 = min(ly0 + tile_size, ny_chrom)

            mat = np.zeros((tile_size, tile_size), dtype=np.float32)
            if lx1 < lx0 + tile_size:
                valid_cols = max(0, lx1 - lx0)
                mat[:, valid_cols:] = np.nan
            if ly1 < ly0 + tile_size:
                valid_rows = max(0, ly1 - ly0)
                mat[valid_rows:, :] = np.nan

            if lx0 >= nx_chrom or ly0 >= ny_chrom or lx1 <= lx0 or ly1 <= ly0:
                return mat, {"resolution": res, "min": 0.0, "max": 0.0, "p98": 0.0}

            gx0, gx1 = bx0 + lx0, bx0 + lx1
            gy0, gy1 = by0 + ly0, by0 + ly1

            weight_col = None
            if norm in ("balanced", "oe"):
                weight_col = "weight"
            elif norm != "raw" and norm in grp["bins"]:
                weight_col = norm

            wx = self._get_weights(res, res_cx, weight_col) if weight_col else None
            wy = self._get_weights(res, res_cy, weight_col) if weight_col else None

            if wx is not None:
                bad_x = ~np.isfinite(wx[lx0:lx1])
                if np.any(bad_x):
                    mat[: (ly1 - ly0), : (lx1 - lx0)][:, bad_x] = np.nan
            if wy is not None:
                bad_y = ~np.isfinite(wy[ly0:ly1])
                if np.any(bad_y):
                    mat[: (ly1 - ly0), : (lx1 - lx0)][bad_y, :] = np.nan

            def apply_weights(r_g: np.ndarray, c_g: np.ndarray, cnt: np.ndarray, transposed: bool) -> np.ndarray:
                if wx is None or wy is None:
                    return cnt
                if not transposed:
                    return cnt * wy[r_g - by0] * wx[c_g - bx0]
                else:
                    return cnt * wx[r_g - bx0] * wy[c_g - by0]

            r1, c1, v1 = self._read_rect_upper(grp, gy0, gy1, gx0, gx1)
            if len(v1) > 0:
                val1 = apply_weights(r1, c1, v1, transposed=False)
                good = np.isfinite(val1)
                if np.any(good):
                    mat[r1[good] - gy0, c1[good] - gx0] = val1[good].astype(np.float32)

            if gx0 < gy1:
                r2, c2, v2 = self._read_rect_upper(grp, gx0, gx1, gy0, gy1)
                if len(v2) > 0:
                    off_diag = r2 != c2
                    if np.any(off_diag):
                        r2, c2, v2 = r2[off_diag], c2[off_diag], v2[off_diag]
                        val2 = apply_weights(r2, c2, v2, transposed=True)
                        good = np.isfinite(val2)
                        if np.any(good):
                            mat[c2[good] - gy0, r2[good] - gx0] = val2[good].astype(np.float32)

            if norm == "oe" and res_cx == res_cy:
                expected = self._get_expected(res, res_cx)
                rows = np.arange(ly0, ly1, dtype=np.int64)[:, None]
                cols = np.arange(lx0, lx1, dtype=np.int64)[None, :]
                dists = np.abs(cols - rows)
                exp_patch = expected[dists]
                sub = mat[: (ly1 - ly0), : (lx1 - lx0)]
                with np.errstate(divide="ignore", invalid="ignore"):
                    oe_patch = sub / exp_patch
                mat[: (ly1 - ly0), : (lx1 - lx0)] = oe_patch.astype(np.float32)

            finite_pos = mat[np.isfinite(mat) & (mat > 0)]
            if len(finite_pos) > 0:
                vmin = float(np.min(finite_pos))
                vmax = float(np.max(finite_pos))
                p98 = float(np.percentile(finite_pos, 98))
            else:
                vmin, vmax, p98 = 0.0, 0.0, 0.0

            return mat, {"resolution": res, "min": vmin, "max": vmax, "p98": p98}

    def get_metadata(self, track_id: str) -> TrackMetadata:
        return TrackMetadata(
            track_id=track_id,
            name=self.path.name,
            path=str(self.path),
            format_id=self.format_id,
            track_kind="matrix2d",
            chroms=[{"name": c, "length": self.chrom_lengths[c]} for c in self.chrom_names],
            resolutions=self.resolutions,
            normalizations=self.normalizations,
        )

    def close(self) -> None:
        with self._lock:
            try:
                self._h5.close()
            except Exception:
                pass
