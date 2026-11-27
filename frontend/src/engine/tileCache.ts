import { fetchTile2D, type Tile2DData } from '../api';

export interface CachedTile {
  key: string;
  trackId: string;
  chrom: string;
  resolution: number;
  tx: number;
  ty: number;
  norm: string;
  data: Float32Array;
  tileSize: number;
  min: number;
  max: number;
  p98: number;
}

export class Tile2DCache {
  private cache = new Map<string, CachedTile>();
  private inFlight = new Map<string, { controller: AbortController; promise: Promise<CachedTile | null> }>();
  private maxTiles: number;

  constructor(maxTiles = 320) {
    this.maxTiles = maxTiles;
  }

  static makeKey(
    trackId: string,
    chrom: string,
    resolution: number,
    tx: number,
    ty: number,
    norm: string
  ): string {
    return `${trackId}|${chrom}|${resolution}|${tx}|${ty}|${norm}`;
  }

  get(key: string): CachedTile | undefined {
    const val = this.cache.get(key);
    if (val) {
      // refresh LRU order
      this.cache.delete(key);
      this.cache.set(key, val);
    }
    return val;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  getLoadedForTrack(trackId: string, chrom: string, norm: string): CachedTile[] {
    const out: CachedTile[] = [];
    for (const tile of this.cache.values()) {
      if (tile.trackId === trackId && tile.chrom === chrom && tile.norm === norm) {
        out.push(tile);
      }
    }
    return out;
  }

  request(
    trackId: string,
    chrom: string,
    resolution: number,
    tx: number,
    ty: number,
    norm: string,
    onLoaded: (tile: CachedTile) => void,
    tileSize = 256
  ): void {
    const key = Tile2DCache.makeKey(trackId, chrom, resolution, tx, ty, norm);
    if (this.cache.has(key) || this.inFlight.has(key)) return;

    const controller = new AbortController();
    const promise = fetchTile2D(trackId, chrom, resolution, tx, ty, norm, tileSize, controller.signal)
      .then((res: Tile2DData) => {
        const entry: CachedTile = {
          key,
          trackId,
          chrom,
          resolution: res.resolution,
          tx,
          ty,
          norm,
          data: res.data,
          tileSize: res.tileSize,
          min: res.min,
          max: res.max,
          p98: res.p98,
        };
        this.put(entry);
        onLoaded(entry);
        return entry;
      })
      .catch(() => null)
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, { controller, promise });
  }

  abortExcept(trackId: string, keepKeys: Set<string>): void {
    for (const [key, entry] of this.inFlight.entries()) {
      if (key.startsWith(`${trackId}|`) && !keepKeys.has(key)) {
        entry.controller.abort();
        this.inFlight.delete(key);
      }
    }
  }

  private put(tile: CachedTile): void {
    if (this.cache.has(tile.key)) {
      this.cache.delete(tile.key);
    }
    while (this.cache.size >= this.maxTiles) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
    this.cache.set(tile.key, tile);
  }

  clearTrack(trackId: string): void {
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(`${trackId}|`)) {
        this.cache.delete(key);
      }
    }
    for (const [key, entry] of this.inFlight.entries()) {
      if (key.startsWith(`${trackId}|`)) {
        entry.controller.abort();
        this.inFlight.delete(key);
      }
    }
  }
}

export const sharedTileCache = new Tile2DCache(400);
