from __future__ import annotations

import gzip
import threading
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from .adapters.base import TrackMetadata, resolve_chrom

GENOME_CACHE_DIR = Path(__file__).resolve().parents[2] / ".genome_cache"

GENOME_CATALOG: dict[str, dict[str, Any]] = {
    "ce11": {
        "id": "ce11",
        "label": "C. elegans (ce11 / WBcel235)",
        "urls": [
            "https://hgdownload.soe.ucsc.edu/goldenPath/ce11/database/refGene.txt.gz",
            "https://hgdownload.soe.ucsc.edu/goldenPath/ce11/database/ncbiRefSeq.txt.gz",
        ],
    },
    "hg38": {
        "id": "hg38",
        "label": "Human (hg38 / GRCh38)",
        "urls": [
            "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/ncbiRefSeq.txt.gz",
            "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/refGene.txt.gz",
        ],
    },
    "hg19": {
        "id": "hg19",
        "label": "Human (hg19 / GRCh37)",
        "urls": [
            "https://hgdownload.soe.ucsc.edu/goldenPath/hg19/database/refGene.txt.gz",
        ],
    },
    "mm39": {
        "id": "mm39",
        "label": "Mouse (mm39 / GRCm39)",
        "urls": [
            "https://hgdownload.soe.ucsc.edu/goldenPath/mm39/database/ncbiRefSeq.txt.gz",
        ],
    },
    "mm10": {
        "id": "mm10",
        "label": "Mouse (mm10 / GRCm38)",
        "urls": [
            "https://hgdownload.soe.ucsc.edu/goldenPath/mm10/database/refGene.txt.gz",
        ],
    },
    "dm6": {
        "id": "dm6",
        "label": "D. melanogaster (dm6 / BDGP6)",
        "urls": [
            "https://hgdownload.soe.ucsc.edu/goldenPath/dm6/database/refGene.txt.gz",
        ],
    },
    "sacCer3": {
        "id": "sacCer3",
        "label": "S. cerevisiae (sacCer3)",
        "urls": [
            "https://hgdownload.soe.ucsc.edu/goldenPath/sacCer3/database/ncbiRefSeq.txt.gz",
            "https://hgdownload.soe.ucsc.edu/goldenPath/sacCer3/database/sgdGene.txt.gz",
        ],
    },
}


def ensure_genome_file(genome_id: str) -> Path:
    if genome_id not in GENOME_CATALOG:
        raise ValueError(f"Unknown genome '{genome_id}'. Supported: {list(GENOME_CATALOG.keys())}")
    GENOME_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = GENOME_CACHE_DIR / f"{genome_id}_refGene.txt.gz"
    if target.is_file() and target.stat().st_size > 1000:
        return target

    last_err: Exception | None = None
    for url in GENOME_CATALOG[genome_id]["urls"]:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "FastGlass/0.1"})
            tmp = target.with_suffix(".tmp")
            with urllib.request.urlopen(req, timeout=30) as resp, open(tmp, "wb") as out:
                out.write(resp.read())
            tmp.replace(target)
            return target
        except Exception as exc:
            last_err = exc
    raise RuntimeError(f"Failed to fetch gene annotations for {genome_id}: {last_err}")


class ReferenceGeneAdapter:
    """Consensus reference genome gene track + instant gene symbol search."""

    format_id = "refgene"
    track_kind = "gene1d"

    def __init__(self, genome_id: str) -> None:
        self.genome_id = genome_id
        self.path = ensure_genome_file(genome_id)
        self._by_chrom: dict[str, dict[str, Any]] = {}
        self.chrom_lengths: dict[str, int] = {}
        self._search_index: list[tuple[str, dict[str, Any]]] = []
        self._load()

    def _load(self) -> None:
        best_gene: dict[tuple[str, str], dict[str, Any]] = {}

        with gzip.open(self.path, "rt", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                parts = line.rstrip("\n\r").split("\t")
                if len(parts) < 11:
                    continue
                if len(parts) >= 13 and parts[3] in ("+", "-"):
                    tx_name = parts[1]
                    chrom = parts[2]
                    strand = parts[3]
                    st_s, en_s, cds_s_s, cds_e_s = parts[4], parts[5], parts[6], parts[7]
                    ex_s_str, ex_e_str = parts[9], parts[10]
                    gene_name = parts[12].strip() or tx_name
                elif parts[2] in ("+", "-"):
                    tx_name = parts[0]
                    chrom = parts[1]
                    strand = parts[2]
                    st_s, en_s, cds_s_s, cds_e_s = parts[3], parts[4], parts[5], parts[6]
                    ex_s_str, ex_e_str = parts[8], parts[9]
                    gene_name = parts[11].strip() if len(parts) > 11 and parts[11].strip() else tx_name
                else:
                    continue

                if "_" in chrom:
                    continue
                try:
                    st = int(st_s)
                    en = int(en_s)
                    cds_s = int(cds_s_s)
                    cds_e = int(cds_e_s)
                except ValueError:
                    continue
                if en <= st:
                    continue

                span = en - st
                key = (chrom, gene_name)
                prev = best_gene.get(key)
                if prev is not None and (prev["end"] - prev["start"]) >= span:
                    continue

                ex_starts = [int(x) for x in ex_s_str.split(",") if x]
                ex_ends = [int(x) for x in ex_e_str.split(",") if x]
                exons = [[a, b] for a, b in zip(ex_starts, ex_ends) if b > a]

                best_gene[key] = {
                    "name": gene_name,
                    "chrom": chrom,
                    "start": st,
                    "end": en,
                    "cdsStart": cds_s,
                    "cdsEnd": cds_e,
                    "strand": strand,
                    "exons": exons,
                }

        per_chrom: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for g in best_gene.values():
            per_chrom[g["chrom"]].append(g)

        all_search: list[tuple[str, dict[str, Any]]] = []
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
            for g in glist:
                all_search.append(
                    (
                        g["name"].lower(),
                        {
                            "name": g["name"],
                            "chrom": g["chrom"],
                            "start": g["start"],
                            "end": g["end"],
                            "strand": g["strand"],
                        },
                    )
                )

        all_search.sort(key=lambda t: (len(t[0]), t[0]))
        self._search_index = all_search

    def search(self, query: str, limit: int = 15) -> list[dict[str, Any]]:
        q = query.strip().lower()
        if not q:
            return []
        exact: list[dict[str, Any]] = []
        prefix: list[dict[str, Any]] = []
        substr: list[dict[str, Any]] = []
        for low_name, rec in self._search_index:
            if low_name == q:
                exact.append(rec)
            elif low_name.startswith(q):
                if len(prefix) < limit:
                    prefix.append(rec)
            elif q in low_name:
                if len(substr) < limit:
                    substr.append(rec)
            if len(exact) + len(prefix) >= limit and len(exact) > 0:
                break
        return (exact + prefix + substr)[:limit]

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
        label = GENOME_CATALOG[self.genome_id]["label"]
        return TrackMetadata(
            track_id=track_id,
            name=f"{self.genome_id} Genes (RefSeq)",
            path=f"genome://{self.genome_id}",
            format_id=self.format_id,
            track_kind="gene1d",
            chroms=[{"name": c, "length": l} for c, l in self.chrom_lengths.items()],
            extra={"genome_id": self.genome_id, "genome_label": label},
        )

    def close(self) -> None:
        pass


class GenomeManager:
    """Thread-safe cache of loaded consensus ReferenceGeneAdapters."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._loaded: dict[str, ReferenceGeneAdapter] = {}

    def list_genomes(self) -> list[dict[str, Any]]:
        out = []
        for gid, info in GENOME_CATALOG.items():
            cached = (GENOME_CACHE_DIR / f"{gid}_refGene.txt.gz").is_file()
            out.append(
                {
                    "id": gid,
                    "label": info["label"],
                    "cached": cached,
                    "loaded": gid in self._loaded,
                }
            )
        return out

    def get_adapter(self, genome_id: str) -> ReferenceGeneAdapter:
        with self._lock:
            if genome_id not in self._loaded:
                self._loaded[genome_id] = ReferenceGeneAdapter(genome_id)
            return self._loaded[genome_id]
