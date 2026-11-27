from __future__ import annotations

import os
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .registry import TrackRegistry, detect_format

DEFAULT_ROOT = Path(os.environ.get("FASTGLASS_ROOT", Path(__file__).resolve().parents[3]))
UPLOAD_DIR = Path(__file__).resolve().parents[2] / ".uploads"
SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__", ".worktrees", ".agents", ".licenses", "fastglass"}

registry = TrackRegistry(DEFAULT_ROOT)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    yield
    registry.close_all()


app = FastAPI(title="FastGlass Tile Server", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-Tile-Size",
        "X-Tile-Min",
        "X-Tile-Max",
        "X-Tile-P98",
        "X-Resolution",
        "X-Bins",
        "X-Signal-Min",
        "X-Signal-Max",
    ],
)


class OpenTrackRequest(BaseModel):
    path: str
    format_override: str | None = None


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "root": str(registry.root_dir), "tracks_open": len(registry.list_tracks())}


@app.get("/api/genomes")
def list_genomes() -> list[dict[str, Any]]:
    return registry.genomes.list_genomes()


@app.post("/api/genomes/{genome_id}/open")
def open_genome_track(genome_id: str) -> dict[str, Any]:
    try:
        meta = registry.open_genome(genome_id)
        return meta.to_dict()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/genomes/{genome_id}/search")
def search_genome_genes(
    genome_id: str,
    q: str = Query(..., min_length=1),
    limit: int = Query(default=15, ge=1, le=50),
) -> list[dict[str, Any]]:
    try:
        adapter = registry.genomes.get_adapter(genome_id)
        return adapter.search(q, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/fs/list")
def list_files(
    path: str = Query(default="", description="Relative path from workspace root or absolute path"),
    only_supported: bool = Query(default=True),
) -> dict[str, Any]:
    if not path:
        target = registry.root_dir
    else:
        p = Path(path)
        target = p.resolve() if p.is_absolute() else (registry.root_dir / p).resolve()

    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=404, detail=f"Directory not found: {target}")

    dirs: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    try:
        entries = sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    for entry in entries:
        if entry.name.startswith(".") and entry.is_dir():
            continue
        if entry.is_dir():
            if entry.name in SKIP_DIRS:
                continue
            dirs.append({"name": entry.name, "path": str(entry), "is_dir": True})
        elif entry.is_file():
            fmt = detect_format(entry)
            if only_supported and fmt is None:
                continue
            try:
                size = entry.stat().st_size
            except OSError:
                size = 0
            files.append(
                {
                    "name": entry.name,
                    "path": str(entry),
                    "is_dir": False,
                    "format": fmt,
                    "size": size,
                }
            )

    parent = str(target.parent) if target.parent != target else None
    return {
        "cwd": str(target),
        "root": str(registry.root_dir),
        "parent": parent,
        "entries": dirs + files,
    }


@app.get("/api/tracks")
def list_tracks() -> list[dict[str, Any]]:
    return registry.list_tracks()


@app.post("/api/tracks/open")
def open_track(req: OpenTrackRequest) -> dict[str, Any]:
    try:
        meta = registry.open_track(req.path, format_override=req.format_override)
        return meta.to_dict()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/tracks/upload")
async def upload_track(file: UploadFile = File(...)) -> dict[str, Any]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")
    safe_name = Path(file.filename).name
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOAD_DIR / safe_name
    with open(dest, "wb") as out:
        shutil.copyfileobj(file.file, out)
    try:
        meta = registry.open_track(str(dest))
        return meta.to_dict()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/tracks/{track_id}")
def close_track(track_id: str) -> dict[str, Any]:
    removed = registry.close_track(track_id)
    return {"track_id": track_id, "closed": removed}


@app.get("/api/tracks/{track_id}/metadata")
def track_metadata(track_id: str) -> dict[str, Any]:
    try:
        return registry.get_metadata(track_id).to_dict()
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/tracks/{track_id}/tile2d")
def get_tile_2d(
    track_id: str,
    chrom_x: str = Query(...),
    chrom_y: str | None = Query(default=None),
    resolution: int = Query(..., gt=0),
    tile_x: int = Query(..., ge=0),
    tile_y: int = Query(..., ge=0),
    tile_size: int = Query(default=256, ge=32, le=512),
    norm: str = Query(default="balanced"),
) -> Response:
    cy = chrom_y or chrom_x
    cache_key = (track_id, "2d", chrom_x, cy, resolution, tile_x, tile_y, tile_size, norm)
    cached = registry.tile_cache.get(cache_key)
    if cached is not None:
        payload, stats = cached
    else:
        try:
            adapter = registry.get_adapter(track_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if not hasattr(adapter, "tile_2d"):
            raise HTTPException(status_code=400, detail="Track does not support 2D matrix tiles")
        mat, stats = adapter.tile_2d(chrom_x, cy, resolution, tile_x, tile_y, tile_size=tile_size, norm=norm)
        payload = np.ascontiguousarray(mat, dtype="<f4").tobytes()
        registry.tile_cache.put(cache_key, payload, stats)

    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            "X-Tile-Size": str(tile_size),
            "X-Resolution": str(stats.get("resolution", resolution)),
            "X-Tile-Min": f"{stats.get('min', 0.0):.8g}",
            "X-Tile-Max": f"{stats.get('max', 0.0):.8g}",
            "X-Tile-P98": f"{stats.get('p98', 0.0):.8g}",
            "Cache-Control": "private, max-age=300",
        },
    )


@app.get("/api/tracks/{track_id}/signal1d")
def get_signal_1d(
    track_id: str,
    chrom: str = Query(...),
    start: int = Query(..., ge=0),
    end: int = Query(..., gt=0),
    bins: int = Query(default=800, ge=16, le=4096),
    column: str | None = Query(default=None),
) -> Response:
    cache_key = (track_id, "sig1d", chrom, start, end, bins, column or "")
    cached = registry.tile_cache.get(cache_key)
    if cached is not None:
        payload, stats = cached
    else:
        try:
            adapter = registry.get_adapter(track_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if not hasattr(adapter, "signal_1d"):
            raise HTTPException(status_code=400, detail="Track does not support 1D signal queries")
        mean_a, min_a, max_a = adapter.signal_1d(chrom, start, end, bins=bins, column=column)
        stacked = np.concatenate(
            [
                np.ascontiguousarray(mean_a, dtype="<f4"),
                np.ascontiguousarray(min_a, dtype="<f4"),
                np.ascontiguousarray(max_a, dtype="<f4"),
            ]
        )
        fin = stacked[np.isfinite(stacked)]
        stats = {
            "min": float(np.min(fin)) if len(fin) else 0.0,
            "max": float(np.max(fin)) if len(fin) else 0.0,
        }
        payload = stacked.tobytes()
        registry.tile_cache.put(cache_key, payload, stats)

    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            "X-Bins": str(bins),
            "X-Signal-Min": f"{stats['min']:.8g}",
            "X-Signal-Max": f"{stats['max']:.8g}",
            "Cache-Control": "private, max-age=60",
        },
    )


@app.get("/api/tracks/{track_id}/features1d")
def get_features_1d(
    track_id: str,
    chrom: str = Query(...),
    start: int = Query(..., ge=0),
    end: int = Query(..., gt=0),
    max_items: int = Query(default=4000, ge=10, le=20000),
) -> dict[str, Any]:
    try:
        adapter = registry.get_adapter(track_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not hasattr(adapter, "features_1d"):
        raise HTTPException(status_code=400, detail="Track does not support 1D feature queries")
    return adapter.features_1d(chrom, start, end, max_items=max_items)


@app.get("/api/tracks/{track_id}/features2d")
def get_features_2d(
    track_id: str,
    chrom_x: str = Query(...),
    chrom_y: str | None = Query(default=None),
    start_x: int = Query(..., ge=0),
    end_x: int = Query(..., gt=0),
    start_y: int | None = Query(default=None),
    end_y: int | None = Query(default=None),
    max_items: int = Query(default=4000, ge=10, le=20000),
) -> dict[str, Any]:
    try:
        adapter = registry.get_adapter(track_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not hasattr(adapter, "features_2d"):
        return {"items": []}
    cy = chrom_y or chrom_x
    sy = start_y if start_y is not None else start_x
    ey = end_y if end_y is not None else end_x
    return adapter.features_2d(chrom_x, cy, start_x, end_x, sy, ey, max_items=max_items)


FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if (FRONTEND_DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")


@app.get("/")
def serve_index():
    index_file = FRONTEND_DIST / "index.html"
    if index_file.is_file():
        return FileResponse(str(index_file))
    return {"message": "FastGlass API running. Build frontend with fastglass/build_frontend.ps1 or run Vite dev server."}
