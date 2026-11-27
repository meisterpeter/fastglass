export interface CameraState {
  chrom: string;
  chromLength: number;
  startBp: number;
  endBp: number;
  hoverBp: number | null;
  hoverBp2: number | null; // optional second locus when hovering 2D heatmap
}

type Listener = (state: CameraState, reason: 'move' | 'hover') => void;

const MIN_SPAN_BP = 200;

export class GenomicCamera {
  private state: CameraState = {
    chrom: 'chrX',
    chromLength: 17_718_942,
    startBp: 0,
    endBp: 17_718_942,
    hoverBp: null,
    hoverBp2: null,
  };

  private listeners = new Set<Listener>();
  private rafPending = false;
  private pendingReason: 'move' | 'hover' = 'hover';

  get(): CameraState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(reason: 'move' | 'hover'): void {
    if (reason === 'move') {
      this.pendingReason = 'move';
    }
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      const r = this.pendingReason;
      this.pendingReason = 'hover';
      const snap = { ...this.state };
      for (const fn of this.listeners) {
        fn(snap, r);
      }
    });
  }

  setChrom(chrom: string, chromLength: number, resetRange = true): void {
    const len = Math.max(1000, Math.floor(chromLength));
    this.state.chrom = chrom;
    this.state.chromLength = len;
    if (resetRange) {
      this.state.startBp = 0;
      this.state.endBp = len;
    } else {
      this.clamp();
    }
    this.emit('move');
  }

  setRange(startBp: number, endBp: number): void {
    let s = Math.min(startBp, endBp);
    let e = Math.max(startBp, endBp);
    if (e - s < MIN_SPAN_BP) {
      const mid = (s + e) / 2;
      s = mid - MIN_SPAN_BP / 2;
      e = mid + MIN_SPAN_BP / 2;
    }
    this.state.startBp = s;
    this.state.endBp = e;
    this.clamp();
    this.emit('move');
  }

  panByPixels(dxPx: number, widthPx: number): void {
    if (widthPx <= 0) return;
    const span = this.state.endBp - this.state.startBp;
    const deltaBp = -(dxPx / widthPx) * span;
    this.state.startBp += deltaBp;
    this.state.endBp += deltaBp;
    this.clamp();
    this.emit('move');
  }

  zoomAtFraction(frac: number, scaleFactor: number): void {
    const f = Math.max(0, Math.min(1, frac));
    const { startBp, endBp, chromLength } = this.state;
    const span = endBp - startBp;
    const anchor = startBp + f * span;
    const newSpan = Math.max(MIN_SPAN_BP, Math.min(chromLength, span * scaleFactor));
    this.state.startBp = anchor - f * newSpan;
    this.state.endBp = anchor + (1 - f) * newSpan;
    this.clamp();
    this.emit('move');
  }

  resetZoom(): void {
    this.state.startBp = 0;
    this.state.endBp = this.state.chromLength;
    this.emit('move');
  }

  setHover(bp: number | null, bp2: number | null = null): void {
    if (this.state.hoverBp === bp && this.state.hoverBp2 === bp2) return;
    this.state.hoverBp = bp;
    this.state.hoverBp2 = bp2;
    this.emit('hover');
  }

  private clamp(): void {
    const len = this.state.chromLength;
    let span = this.state.endBp - this.state.startBp;
    if (span > len) {
      this.state.startBp = 0;
      this.state.endBp = len;
      return;
    }
    if (span < MIN_SPAN_BP) {
      const mid = (this.state.startBp + this.state.endBp) / 2;
      this.state.startBp = mid - MIN_SPAN_BP / 2;
      this.state.endBp = mid + MIN_SPAN_BP / 2;
      span = MIN_SPAN_BP;
    }
    if (this.state.startBp < 0) {
      this.state.startBp = 0;
      this.state.endBp = span;
    }
    if (this.state.endBp > len) {
      this.state.endBp = len;
      this.state.startBp = Math.max(0, len - span);
    }
  }
}

export const sharedCamera = new GenomicCamera();

export function formatBp(bp: number): string {
  const abs = Math.abs(bp);
  if (abs >= 1_000_000) return `${(bp / 1_000_000).toFixed(2)} Mb`;
  if (abs >= 1_000) return `${(bp / 1_000).toFixed(1)} kb`;
  return `${Math.round(bp)} bp`;
}

export function formatBpExact(bp: number): string {
  return Math.round(bp).toLocaleString('en-US');
}

function parseSingleCoord(raw: string): number | null {
  const s = raw.trim().replace(/,/g, '').toLowerCase();
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*(mb|m|kb|k|bp)?$/);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const unit = m[2] || 'bp';
  if (unit === 'mb' || unit === 'm') return Math.round(val * 1_000_000);
  if (unit === 'kb' || unit === 'k') return Math.round(val * 1_000);
  return Math.round(val);
}

export function parseLocus(
  input: string,
  currentChrom: string
): { chrom: string; start: number; end: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let chrom = currentChrom;
  let rest = trimmed;
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx >= 0) {
    chrom = trimmed.slice(0, colonIdx).trim();
    rest = trimmed.slice(colonIdx + 1).trim();
  }
  const dashParts = rest.split(/[-–]/);
  if (dashParts.length !== 2) return null;
  const s = parseSingleCoord(dashParts[0]);
  const e = parseSingleCoord(dashParts[1]);
  if (s === null || e === null || e <= s) return null;
  return { chrom, start: s, end: e };
}
