# FastGlass

A lightweight, zero-ingest rewrite of HiGlass designed for **effortless multi-format track management** and **GPU-accelerated 60–120 FPS browsing**.

**Live Online App (GitHub Pages)**: https://meisterpeter.github.io/fastglass/
*(Runs 100% client-side in your browser with interactive demo datasets, live UCSC consensus gene search/tracks, remote URL streaming, and private local file loading for `.hic`, `.bw`/`.bb`, `.bed`, `.bedGraph`, `.gtf`/`.gff3`, `.bedpe`, and `.tsv`/`.csv`. Use `./run.ps1` locally to also read `.mcool`/`.cool` HDF5 files directly from disk.)*

## Features

- **Zero-Ingest Direct File Reading**: Open local `.mcool`, `.cool`, `.hic`, `.bigWig`/`.bw`, `.bigBed`/`.bb`, `.bed`, `.bedGraph`, `.gtf`, `.gff3`, `.bedpe`, and generic `.tsv`/`.csv` files directly from disk with no Docker, PostgreSQL, or `clodius` preprocessing.
- **WebGL2 GPU 2D Hi-C Heatmaps**:
  - 45° Triangular and locked **1:1 Square** views with instant GPU colormap, log/linear, gamma, and contrast controls.
  - **Split Upper/Lower Diagonal (`▲A / ▼B`)** and **Differential (`log2(A / B)` and `A − B`)** matrix comparisons computed directly in the fragment shader.
  - Native `balanced`, `oe` (Observed/Expected), and `raw` normalizations.
  - 1-click 2D TAD/loop overlays from `.bed` and `.bedpe` tracks.
- **Consensus Reference Genomes & Gene Search**: On-demand cached UCSC RefSeq/NCBI gene tracks (`ce11`, `hg38`, `hg19`, `mm39`, `mm10`, `dm6`, `sacCer3`) with live gene symbol autocomplete in the locus bar.
- **Effortless Track Management**: 1-click add/remove, drag-and-drop file upload, drag-to-reorder, resize handles, inline column switching for multi-column `.tsv`/`.csv` files, and JSON session save/load.
- **Publication Export**: High-resolution **2× PNG** and **vector SVG** figure export with ruler, track labels, and colormap colorbars.

## Quick Start (Windows)

```powershell
.\run.ps1
```

Then open **http://127.0.0.1:8765** in your browser.

To point FastGlass at a specific data directory or port:

```powershell
.\run.ps1 -Root "C:\path\to\data" -Port 8765
```

## Manual / Cross-Platform Setup

### Backend (Python 3.11–3.13)
```bash
cd backend
uv venv --python 3.12
uv pip install fastapi "uvicorn[standard]" h5py numpy pydantic python-multipart pybigtools
FASTGLASS_ROOT=/path/to/data uv run uvicorn fastglass.main:app --host 127.0.0.1 --port 8765
```

### Frontend (Node 20+)
```bash
cd frontend
npm install
npm run build   # outputs frontend/dist/ served automatically by FastAPI
# or `npm run dev` for hot-reloading dev server proxying /api to :8765
```

## Supported Formats

| Format | Extensions | Capabilities |
| :--- | :--- | :--- |
| **Cooler / Multi-Res Cooler** | `.mcool`, `.cool` | Direct HDF5 CSR tile streaming, `balanced`, `oe`, and `raw` norms |
| **Juicer Hi-C** | `.hic` | Native v6–v9 binary multi-res reader (auto-uses `hicstraw` if installed) |
| **BigWig / BigBed** | `.bw`, `.bigWig`, `.bb`, `.bigBed` | Rust-backed `pybigtools` zoom-level summaries & interval queries |
| **BED / Peaks** | `.bed`, `.narrowPeak`, `.broadPeak` (+`.gz`) | Auto-detects `itemRgb`, block or arc display, 2D TAD overlay |
| **BedGraph** | `.bedGraph`, `.bg` (+`.gz`) | Pixel-binned 1D signal tracks |
| **Gene Annotations** | `.gtf`, `.gff3`, `.gff` (+`.gz`) | Exon/intron models, strand coloring, gene symbols |
| **2D Paired Features** | `.bedpe` (+`.gz`) | 1D Bezier loop arcs + 2D heatmap overlays |
| **Generic Tabular** | `.tsv`, `.csv`, `.tab`, `.txt` (+`.gz`) | Auto-detects delimiter, 1D/2D coordinates, and selectable numeric columns |
| **Consensus Genomes** | Built-in (`ce11`, `hg38`, `hg19`, `mm39`, `mm10`, `dm6`, `sacCer3`) | Cached UCSC RefSeq/NCBI gene track + instant gene symbol jump |
