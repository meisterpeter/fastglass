from __future__ import annotations

import struct
import threading
import zlib
from pathlib import Path
from typing import Any

import numpy as np

from .base import TrackMetadata, resolve_chrom


def _read_cstr(f) -> str:
    buf = bytearray()
    while True:
        b = f.read(1)
        if not b or b == b"\x00":
            break
        buf.extend(b)
    return buf.decode("utf-8", errors="replace")


class HicAdapter:
    """Direct reader for Juicer .hic files (v6-v9), with optional hicstraw acceleration."""

    format_id = "hic"
    track_kind = "matrix2d"

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._straw = None
        try:
            import hicstraw  # type: ignore

            self._straw = hicstraw.HiCFile(str(path))
        except Exception:
            self._straw = None

        self.chrom_names: list[str] = []
        self.chrom_lengths: dict[str, int] = {}
        self.chrom_indices: dict[str, int] = {}
        self.resolutions: list[int] = []
        self.normalizations: list[str] = ["NONE"]
        self._version = 0
        self._master_offset = 0
        self._footer_map: dict[str, tuple[int, int]] = {}
        self._norm_index: dict[tuple[str, str, int, int], tuple[int, int]] = {}
        self._matrix_cache: dict[tuple[int, int, int], dict[str, Any]] = {}
        self._norm_vec_cache: dict[tuple[str, int, int], np.ndarray | None] = {}

        if self._straw is not None:
            for c in self._straw.getChromosomes():
                if c.name.lower() == "all":
                    continue
                self.chrom_names.append(c.name)
                self.chrom_lengths[c.name] = int(c.length)
                self.chrom_indices[c.name] = int(c.index)
            self.resolutions = sorted(int(r) for r in self._straw.getResolutions())
            try:
                norms = list(self._straw.getNormalizations())
                self.normalizations = ["NONE"] + [n for n in norms if n != "NONE"]
            except Exception:
                self.normalizations = ["NONE", "KR", "VC", "VC_SQRT"]
        else:
            self._parse_header_and_footer()

    def _parse_header_and_footer(self) -> None:
        with open(self.path, "rb") as f:
            magic = _read_cstr(f)
            if magic != "HIC":
                raise ValueError(f"Not a valid .hic file: {self.path}")
            (self._version,) = struct.unpack("<i", f.read(4))
            (self._master_offset,) = struct.unpack("<q", f.read(8))
            _genome = _read_cstr(f)
            if self._version >= 9:
                _norm_pos, _norm_nbytes = struct.unpack("<qq", f.read(16))
            (n_attr,) = struct.unpack("<i", f.read(4))
            for _ in range(n_attr):
                _read_cstr(f)
                _read_cstr(f)
            (n_chroms,) = struct.unpack("<i", f.read(4))
            for idx in range(n_chroms):
                name = _read_cstr(f)
                length = struct.unpack("<q" if self._version >= 9 else "<i", f.read(8 if self._version >= 9 else 4))[0]
                if name.lower() == "all":
                    continue
                self.chrom_names.append(name)
                self.chrom_lengths[name] = int(length)
                self.chrom_indices[name] = idx
            (n_bp_res,) = struct.unpack("<i", f.read(4))
            bp_res = list(struct.unpack(f"<{n_bp_res}i", f.read(4 * n_bp_res)))
            self.resolutions = sorted(int(r) for r in bp_res)

            f.seek(self._master_offset)
            _nbytes = struct.unpack("<q" if self._version >= 9 else "<i", f.read(8 if self._version >= 9 else 4))[0]
            (n_entries,) = struct.unpack("<i", f.read(4))
            for _ in range(n_entries):
                key = _read_cstr(f)
                fpos, size = struct.unpack("<qi", f.read(12))
                self._footer_map[key] = (fpos, size)

            try:
                (n_exp,) = struct.unpack("<i", f.read(4))
                for _ in range(n_exp):
                    _unit = _read_cstr(f)
                    _binsize = struct.unpack("<i", f.read(4))[0]
                    n_vals = struct.unpack("<q" if self._version >= 9 else "<i", f.read(8 if self._version >= 9 else 4))[0]
                    f.seek(n_vals * (4 if self._version >= 9 else 8), 1)
                    (n_sf,) = struct.unpack("<i", f.read(4))
                    f.seek(n_sf * 12, 1)

                (n_norm_exp,) = struct.unpack("<i", f.read(4))
                for _ in range(n_norm_exp):
                    _ntype = _read_cstr(f)
                    _unit = _read_cstr(f)
                    _binsize = struct.unpack("<i", f.read(4))[0]
                    n_vals = struct.unpack("<q" if self._version >= 9 else "<i", f.read(8 if self._version >= 9 else 4))[0]
                    f.seek(n_vals * (4 if self._version >= 9 else 8), 1)
                    (n_sf,) = struct.unpack("<i", f.read(4))
                    f.seek(n_sf * 12, 1)

                (n_norm_vecs,) = struct.unpack("<i", f.read(4))
                norms_seen: set[str] = set()
                for _ in range(n_norm_vecs):
                    ntype = _read_cstr(f)
                    c_idx = struct.unpack("<i", f.read(4))[0]
                    unit = _read_cstr(f)
                    res = struct.unpack("<i", f.read(4))[0]
                    fpos = struct.unpack("<q", f.read(8))[0]
                    nbytes = struct.unpack("<q" if self._version >= 9 else "<i", f.read(8 if self._version >= 9 else 4))[0]
                    if unit == "BP":
                        self._norm_index[(ntype, unit, c_idx, res)] = (fpos, nbytes)
                        norms_seen.add(ntype)
                self.normalizations = ["NONE"] + sorted(norms_seen)
            except Exception:
                self.normalizations = ["NONE"]

    def _nearest_resolution(self, requested: int) -> int:
        if requested in self.resolutions:
            return requested
        for r in self.resolutions:
            if r >= requested:
                return r
        return self.resolutions[-1]

    def _load_norm_vec(self, norm: str, chrom_idx: int, res: int) -> np.ndarray | None:
        if norm in ("NONE", "raw"):
            return None
        key = (norm, chrom_idx, res)
        if key in self._norm_vec_cache:
            return self._norm_vec_cache[key]
        entry = self._norm_index.get((norm, "BP", chrom_idx, res))
        if entry is None:
            self._norm_vec_cache[key] = None
            return None
        fpos, _ = entry
        with open(self.path, "rb") as f:
            f.seek(fpos)
            n_vals = struct.unpack("<q" if self._version >= 9 else "<i", f.read(8 if self._version >= 9 else 4))[0]
            dtype = np.float32 if self._version >= 9 else np.float64
            vec = np.frombuffer(f.read(n_vals * np.dtype(dtype).itemsize), dtype=dtype).astype(np.float64)
        vec[vec == 0] = np.nan
        self._norm_vec_cache[key] = vec
        return vec

    def _load_matrix_zoom_info(self, c1: int, c2: int, res: int) -> dict[str, Any] | None:
        key = (c1, c2, res)
        if key in self._matrix_cache:
            return self._matrix_cache[key]
        footer_key = f"{c1}_{c2}"
        if footer_key not in self._footer_map:
            return None
        fpos, _ = self._footer_map[footer_key]
        with open(self.path, "rb") as f:
            f.seek(fpos)
            _mc1, _mc2, n_res = struct.unpack("<iii", f.read(12))
            for _ in range(n_res):
                unit = _read_cstr(f)
                _res_idx = struct.unpack("<i", f.read(4))[0]
                _sum_counts, _occupied, _std, _pct = struct.unpack("<ffff", f.read(16))
                binsize, block_bin_count, block_col_count, n_blocks = struct.unpack("<iiii", f.read(16))
                blocks: dict[int, tuple[int, int]] = {}
                for _b in range(n_blocks):
                    bid, bpos, bsize = struct.unpack("<iqi", f.read(16))
                    blocks[bid] = (bpos, bsize)
                if unit == "BP" and binsize == res:
                    info = {
                        "block_bin_count": block_bin_count,
                        "block_col_count": block_col_count,
                        "blocks": blocks,
                    }
                    self._matrix_cache[key] = info
                    return info
        return None

    def _read_block(self, bpos: int, bsize: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        with open(self.path, "rb") as f:
            f.seek(bpos)
            raw = zlib.decompress(f.read(bsize))
        mv = memoryview(raw)
        offset = 0
        (n_records,) = struct.unpack_from("<i", mv, offset)
        offset += 4
        if self._version < 7:
            arr = np.frombuffer(mv[offset : offset + n_records * 12], dtype=[("x", "<i4"), ("y", "<i4"), ("c", "<f4")])
            return arr["x"].astype(np.int64), arr["y"].astype(np.int64), arr["c"].astype(np.float64)

        bin_x_off, bin_y_off = struct.unpack_from("<ii", mv, offset)
        offset += 8
        use_float = mv[offset] != 0
        offset += 1
        btype = mv[offset]
        offset += 1

        xs: list[np.ndarray] = []
        ys: list[np.ndarray] = []
        cs: list[np.ndarray] = []

        if btype == 1:
            (n_rows,) = struct.unpack_from("<h", mv, offset)
            offset += 2
            for _ in range(n_rows):
                (row_off,) = struct.unpack_from("<h", mv, offset)
                offset += 2
                y_val = bin_y_off + row_off
                (n_cols,) = struct.unpack_from("<h", mv, offset)
                offset += 2
                col_xs = np.empty(n_cols, dtype=np.int64)
                col_cs = np.empty(n_cols, dtype=np.float64)
                for j in range(n_cols):
                    (col_off,) = struct.unpack_from("<h", mv, offset)
                    offset += 2
                    if use_float:
                        (cnt,) = struct.unpack_from("<f", mv, offset)
                        offset += 4
                    else:
                        (cnt,) = struct.unpack_from("<h", mv, offset)
                        offset += 2
                    col_xs[j] = bin_x_off + col_off
                    col_cs[j] = float(cnt)
                xs.append(col_xs)
                ys.append(np.full(n_cols, y_val, dtype=np.int64))
                cs.append(col_cs)
            if not xs:
                return np.empty(0, np.int64), np.empty(0, np.int64), np.empty(0, np.float64)
            return np.concatenate(xs), np.concatenate(ys), np.concatenate(cs)
        elif btype == 2:
            (n_pts,) = struct.unpack_from("<i", mv, offset)
            offset += 4
            (w,) = struct.unpack_from("<h", mv, offset)
            offset += 2
            if use_float:
                vals = np.frombuffer(mv[offset : offset + n_pts * 4], dtype="<f4")
                good = np.isfinite(vals) & (vals != 0)
            else:
                vals = np.frombuffer(mv[offset : offset + n_pts * 2], dtype="<i2")
                good = (vals != -32768) & (vals != 0)
            idx = np.nonzero(good)[0]
            r = idx // w
            c = idx % w
            return (bin_x_off + c).astype(np.int64), (bin_y_off + r).astype(np.int64), vals[idx].astype(np.float64)

        return np.empty(0, np.int64), np.empty(0, np.int64), np.empty(0, np.float64)

    def tile_2d(
        self,
        chrom_x: str,
        chrom_y: str,
        resolution: int,
        tile_x: int,
        tile_y: int,
        tile_size: int = 256,
        norm: str = "NONE",
    ) -> tuple[np.ndarray, dict[str, Any]]:
        with self._lock:
            res = self._nearest_resolution(resolution)
            res_cx = resolve_chrom(chrom_x, self.chrom_names)
            res_cy = resolve_chrom(chrom_y, self.chrom_names)
            mat = np.zeros((tile_size, tile_size), dtype=np.float32)
            if res_cx is None or res_cy is None:
                mat[:] = np.nan
                return mat, {"resolution": res, "min": 0.0, "max": 0.0, "p98": 0.0}

            nx_chrom = int(np.ceil(self.chrom_lengths[res_cx] / res))
            ny_chrom = int(np.ceil(self.chrom_lengths[res_cy] / res))
            lx0 = tile_x * tile_size
            lx1 = min(lx0 + tile_size, nx_chrom)
            ly0 = tile_y * tile_size
            ly1 = min(ly0 + tile_size, ny_chrom)

            if lx1 < lx0 + tile_size:
                mat[:, max(0, lx1 - lx0) :] = np.nan
            if ly1 < ly0 + tile_size:
                mat[max(0, ly1 - ly0) :, :] = np.nan
            if lx0 >= nx_chrom or ly0 >= ny_chrom or lx1 <= lx0 or ly1 <= ly0:
                return mat, {"resolution": res, "min": 0.0, "max": 0.0, "p98": 0.0}

            norm_use = "NONE" if norm in ("raw", "NONE") else norm
            if norm_use == "balanced":
                for candidate in ("KR", "SCALE", "VC_SQRT", "VC", "NONE"):
                    if candidate in self.normalizations:
                        norm_use = candidate
                        break

            if self._straw is not None:
                mzd = self._straw.getMatrixZoomData(res_cx, res_cy, "observed", norm_use, "BP", res)
                arr = mzd.getRecordsAsMatrix(lx0 * res, (lx1 - 1) * res, ly0 * res, (ly1 - 1) * res)
                sub = np.asarray(arr, dtype=np.float32)
                h = min(sub.shape[0], ly1 - ly0)
                w = min(sub.shape[1], lx1 - lx0)
                mat[:h, :w] = sub[:h, :w]
            else:
                ci_x = self.chrom_indices[res_cx]
                ci_y = self.chrom_indices[res_cy]
                swapped = ci_x > ci_y
                c1, c2 = (ci_y, ci_x) if swapped else (ci_x, ci_y)
                info = self._load_matrix_zoom_info(c1, c2, res)
                if info is not None:
                    bbc = info["block_bin_count"]
                    bcc = info["block_col_count"]
                    blocks = info["blocks"]
                    nv1 = self._load_norm_vec(norm_use, c1, res)
                    nv2 = self._load_norm_vec(norm_use, c2, res)

                    q_ranges = [(lx0, lx1, ly0, ly1)]
                    if ci_x == ci_y and (ly1 > lx0):
                        q_ranges.append((ly0, ly1, lx0, lx1))

                    seen_bids: set[int] = set()
                    for rx0, rx1, ry0, ry1 in q_ranges:
                        bx_start, bx_end = rx0 // bbc, (rx1 - 1) // bbc
                        by_start, by_end = ry0 // bbc, (ry1 - 1) // bbc
                        for bx in range(bx_start, bx_end + 1):
                            for by in range(by_start, by_end + 1):
                                bid = by * bcc + bx
                                if bid in seen_bids or bid not in blocks:
                                    continue
                                seen_bids.add(bid)
                                bpos, bsize = blocks[bid]
                                xs, ys, cs = self._read_block(bpos, bsize)
                                if len(cs) == 0:
                                    continue
                                if nv1 is not None and nv2 is not None:
                                    valid_n = (xs < len(nv1)) & (ys < len(nv2))
                                    xs, ys, cs = xs[valid_n], ys[valid_n], cs[valid_n]
                                    cs = cs / (nv1[xs] * nv2[ys])
                                    good = np.isfinite(cs)
                                    xs, ys, cs = xs[good], ys[good], cs[good]
                                if swapped:
                                    xs, ys = ys, xs
                                m1 = (xs >= lx0) & (xs < lx1) & (ys >= ly0) & (ys < ly1)
                                if np.any(m1):
                                    mat[ys[m1] - ly0, xs[m1] - lx0] = cs[m1].astype(np.float32)
                                if ci_x == ci_y:
                                    m2 = (ys >= lx0) & (ys < lx1) & (xs >= ly0) & (xs < ly1)
                                    if np.any(m2):
                                        mat[xs[m2] - ly0, ys[m2] - lx0] = cs[m2].astype(np.float32)

            finite_pos = mat[np.isfinite(mat) & (mat > 0)]
            if len(finite_pos) > 0:
                vmin, vmax = float(np.min(finite_pos)), float(np.max(finite_pos))
                p98 = float(np.percentile(finite_pos, 98))
            else:
                vmin = vmax = p98 = 0.0
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
        pass
