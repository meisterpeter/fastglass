import type { Signal1DData } from '../api';
import type { ArcItem, BedStyle, GeneItem, IntervalItem, MatrixMode, SignalStyle } from '../types';
import { formatBp } from './camera';

export function setupHiDPI(
  canvas: HTMLCanvasElement,
  width: number,
  height: number
): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.max(1, Math.round(width * dpr));
  const ph = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function pickNiceStep(spanBp: number, widthPx: number): number {
  const targetTicks = Math.max(3, Math.floor(widthPx / 120));
  const raw = spanBp / targetTicks;
  const pow10 = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  const frac = raw / pow10;
  if (frac <= 1.5) return pow10;
  if (frac <= 3) return 2 * pow10;
  if (frac <= 7) return 5 * pow10;
  return 10 * pow10;
}

export function drawRuler(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  chrom: string,
  startBp: number,
  endBp: number,
  hoverBp: number | null
): void {
  const ctx = setupHiDPI(canvas, width, height);
  if (!ctx) return;

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  const span = Math.max(1, endBp - startBp);
  const step = pickNiceStep(span, width);
  const firstTick = Math.ceil(startBp / step) * step;

  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height - 0.5);
  ctx.lineTo(width, height - 0.5);
  ctx.stroke();

  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#94a3b8';
  ctx.textBaseline = 'top';

  const spanLabel = `${chrom} · ${formatBp(span)}`;
  const sw = ctx.measureText(spanLabel).width + 14;
  const badgeLeft = width - sw - 6;

  for (let bp = firstTick; bp <= endBp; bp += step) {
    const x = ((bp - startBp) / span) * width;
    ctx.strokeStyle = '#475569';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, height - 8);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();

    // Minor half-tick
    const halfX = ((bp - step * 0.5 - startBp) / span) * width;
    if (halfX >= 0 && halfX <= width) {
      ctx.strokeStyle = '#334155';
      ctx.beginPath();
      ctx.moveTo(halfX + 0.5, height - 4);
      ctx.lineTo(halfX + 0.5, height);
      ctx.stroke();
    }

    const label = formatBp(bp);
    const tw = ctx.measureText(label).width;
    const lx = Math.max(4, Math.min(width - tw - 4, x - tw / 2));
    if (lx + tw < badgeLeft - 6) {
      ctx.fillText(label, lx, 6);
    }
  }

  // Span badge on right
  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.fillRect(badgeLeft, 3, sw, 18);
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(spanLabel, badgeLeft + 7, 6);

  if (hoverBp !== null && hoverBp >= startBp && hoverBp <= endBp) {
    const hx = ((hoverBp - startBp) / span) * width;
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx + 0.5, 0);
    ctx.lineTo(hx + 0.5, height);
    ctx.stroke();

    const hl = formatBp(hoverBp);
    const hw = ctx.measureText(hl).width + 10;
    const bx = Math.max(2, Math.min(width - hw - 2, hx - hw / 2));
    ctx.fillStyle = '#0284c7';
    ctx.fillRect(bx, 2, hw, 16);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(hl, bx + 5, 4);
  }
}

export function drawSignalTrack(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  signal: Signal1DData | null,
  startBp: number,
  endBp: number,
  hoverBp: number | null,
  opts: {
    style: SignalStyle;
    color: string;
    negColor: string;
    autoY: boolean;
    yMin: number;
    yMax: number;
  }
): { usedMin: number; usedMax: number } {
  const ctx = setupHiDPI(canvas, width, height);
  if (!ctx) return { usedMin: 0, usedMax: 1 };

  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, width, height);

  const padTop = 22;
  const padBot = 6;
  const plotH = Math.max(10, height - padTop - padBot);

  if (!signal || signal.bins === 0) {
    return { usedMin: opts.yMin, usedMax: opts.yMax };
  }

  let lo = opts.yMin;
  let hi = opts.yMax;
  if (opts.autoY) {
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < signal.bins; i++) {
      const a = signal.min[i];
      const b = signal.max[i];
      if (Number.isFinite(a) && a < mn) mn = a;
      if (Number.isFinite(b) && b > mx) mx = b;
    }
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
      mn = 0;
      mx = 1;
    }
    if (mn >= 0) {
      lo = 0;
      hi = mx > 0 ? mx * 1.08 : 1;
    } else if (mx <= 0) {
      lo = mn * 1.08;
      hi = 0;
    } else {
      const pad = (mx - mn) * 0.08;
      lo = mn - pad;
      hi = mx + pad;
    }
  }
  if (hi <= lo) hi = lo + 1;

  const toY = (v: number) => padTop + plotH - ((v - lo) / (hi - lo)) * plotH;
  const zeroY = Math.max(padTop, Math.min(padTop + plotH, toY(0)));

  // Zero / baseline rule
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, zeroY + 0.5);
  ctx.lineTo(width, zeroY + 0.5);
  ctx.stroke();

  const n = signal.bins;
  const binW = width / n;

  if (opts.style === 'bar' || opts.style === 'area') {
    const drawW = Math.max(1, Math.ceil(binW));
    for (let i = 0; i < n; i++) {
      const v = signal.mean[i];
      if (!Number.isFinite(v)) continue;
      const x = i * binW;
      const y = toY(v);
      const isNeg = v < 0;
      ctx.fillStyle = isNeg ? opts.negColor : opts.color;
      if (opts.style === 'area') {
        ctx.globalAlpha = 0.78;
      } else {
        ctx.globalAlpha = 0.92;
      }
      const top = Math.min(y, zeroY);
      const h = Math.max(1, Math.abs(zeroY - y));
      ctx.fillRect(x, top, drawW, h);
    }
    ctx.globalAlpha = 1.0;

    // Subtle crisp top line on area mode
    if (opts.style === 'area') {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = signal.mean[i];
        if (!Number.isFinite(v)) {
          started = false;
          continue;
        }
        const x = (i + 0.5) * binW;
        const y = toY(v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = opts.color;
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
  } else {
    // Line style with subtle min-max range band
    ctx.fillStyle = opts.color;
    ctx.globalAlpha = 0.16;
    for (let i = 0; i < n; i++) {
      const mn = signal.min[i];
      const mx = signal.max[i];
      if (!Number.isFinite(mn) || !Number.isFinite(mx)) continue;
      const yTop = toY(mx);
      const yBot = toY(mn);
      ctx.fillRect(i * binW, yTop, Math.max(1, Math.ceil(binW)), Math.max(1, yBot - yTop));
    }
    ctx.globalAlpha = 1.0;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = signal.mean[i];
      if (!Number.isFinite(v)) {
        started = false;
        continue;
      }
      const x = (i + 0.5) * binW;
      const y = toY(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Y-axis scale badge (bottom-right with subtle backdrop pill)
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));
  const label = `[${fmt(lo)}, ${fmt(hi)}]`;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(11, 17, 32, 0.82)';
  ctx.fillRect(width - tw - 12, height - 18, tw + 8, 14);
  ctx.fillStyle = 'rgba(203, 213, 225, 0.9)';
  ctx.fillText(label, width - tw - 8, height - 8);

  // Hover crosshair
  if (hoverBp !== null && hoverBp >= startBp && hoverBp <= endBp) {
    const span = Math.max(1, endBp - startBp);
    const hx = ((hoverBp - startBp) / span) * width;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx + 0.5, 0);
    ctx.lineTo(hx + 0.5, height);
    ctx.stroke();
  }

  return { usedMin: lo, usedMax: hi };
}

export function drawIntervalTrack(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  items: IntervalItem[],
  startBp: number,
  endBp: number,
  hoverBp: number | null,
  opts: { color: string; bedStyle: BedStyle; hasRgb: boolean }
): void {
  const ctx = setupHiDPI(canvas, width, height);
  if (!ctx) return;

  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, width, height);

  const span = Math.max(1, endBp - startBp);
  const padTop = 28;
  const padBot = 6;
  const availH = Math.max(10, height - padTop - padBot);

  if (opts.bedStyle === 'arcs') {
    // Draw BED intervals as Bezier arches connecting start -> end (great for loop BEDs!)
    const baseY = height - padBot;
    ctx.lineWidth = 1.4;
    for (const it of items) {
      const x1 = ((it.start - startBp) / span) * width;
      const x2 = ((it.end - startBp) / span) * width;
      const distPx = Math.abs(x2 - x1);
      if (distPx < 1) continue;
      const arcH = Math.min(availH * 0.92, Math.max(8, distPx * 0.42));
      ctx.strokeStyle = it.color || opts.color;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(x1, baseY);
      ctx.quadraticCurveTo((x1 + x2) * 0.5, baseY - arcH * 1.9, x2, baseY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
  } else if (opts.hasRgb) {
    // Dense single-band chromatin-state painting (Evans RGB states, etc.)
    const bandH = Math.min(28, Math.max(10, availH * 0.72));
    const y = padTop + (availH - bandH) * 0.5;
    for (const it of items) {
      const x1 = ((it.start - startBp) / span) * width;
      const x2 = ((it.end - startBp) / span) * width;
      const w = Math.max(1.2, x2 - x1);
      ctx.fillStyle = it.color || opts.color;
      ctx.fillRect(x1, y, w, bandH);
    }
  } else {
    // Multi-row packed interval blocks with labels
    const rowH = 14;
    const rowGap = 3;
    const maxRows = Math.max(1, Math.floor(availH / (rowH + rowGap)));
    const rowEnds = new Float64Array(maxRows).fill(-1e9);

    ctx.font = '10px Inter, sans-serif';
    ctx.textBaseline = 'middle';

    for (const it of items) {
      const x1 = ((it.start - startBp) / span) * width;
      const x2 = ((it.end - startBp) / span) * width;
      const w = Math.max(2, x2 - x1);
      let row = 0;
      for (; row < maxRows; row++) {
        if (x1 >= rowEnds[row] + 2) break;
      }
      if (row >= maxRows) row = maxRows - 1;
      rowEnds[row] = Math.max(rowEnds[row], x1 + w);

      const y = padTop + row * (rowH + rowGap);
      ctx.fillStyle = it.color || opts.color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x1, y, w, rowH);
      ctx.globalAlpha = 1.0;

      if (it.name && w > 28) {
        ctx.fillStyle = '#f8fafc';
        const label = it.name;
        const tw = ctx.measureText(label).width;
        if (tw + 6 < w) {
          ctx.fillText(label, x1 + 4, y + rowH * 0.5);
        }
      }
    }
  }

  if (hoverBp !== null && hoverBp >= startBp && hoverBp <= endBp) {
    const hx = ((hoverBp - startBp) / span) * width;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx + 0.5, 0);
    ctx.lineTo(hx + 0.5, height);
    ctx.stroke();
  }
}

export function drawGeneTrack(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  genes: GeneItem[],
  startBp: number,
  endBp: number,
  hoverBp: number | null,
  color: string
): void {
  const ctx = setupHiDPI(canvas, width, height);
  if (!ctx) return;

  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, width, height);

  const span = Math.max(1, endBp - startBp);
  const padTop = 24;
  const rowH = 18;
  const maxRows = Math.max(1, Math.floor((height - padTop - 4) / rowH));
  const rowEnds = new Float64Array(maxRows).fill(-1e9);

  ctx.font = '10px Inter, sans-serif';
  ctx.textBaseline = 'middle';

  for (const g of genes) {
    const x1 = ((g.start - startBp) / span) * width;
    const x2 = ((g.end - startBp) / span) * width;
    const w = Math.max(2, x2 - x1);
    const labelW = g.name ? ctx.measureText(g.name).width + 6 : 0;
    const totalEnd = x1 + Math.max(w, labelW);

    let row = 0;
    for (; row < maxRows; row++) {
      if (x1 >= rowEnds[row] + 6) break;
    }
    if (row >= maxRows) continue;
    rowEnds[row] = totalEnd;

    const midY = padTop + row * rowH + 6;
    const strandColor = g.strand === '-' ? '#f472b6' : g.strand === '+' ? '#38bdf8' : color;

    // Intron backbone
    ctx.strokeStyle = strandColor;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x1, midY);
    ctx.lineTo(x1 + w, midY);
    ctx.stroke();

    // Directional intron chevrons when zoomed in enough
    if (w > 24 && (g.strand === '+' || g.strand === '-')) {
      ctx.strokeStyle = strandColor;
      ctx.lineWidth = 1;
      const dir = g.strand === '+' ? 1 : -1;
      for (let cx = x1 + 12; cx < x1 + w - 8; cx += 22) {
        ctx.beginPath();
        ctx.moveTo(cx - dir * 3, midY - 2.5);
        ctx.lineTo(cx, midY);
        ctx.lineTo(cx - dir * 3, midY + 2.5);
        ctx.stroke();
      }
    }

    // Exons (thicker for CDS, thinner for UTR when cdsStart/cdsEnd are available)
    ctx.fillStyle = strandColor;
    const hasCds =
      typeof g.cdsStart === 'number' &&
      typeof g.cdsEnd === 'number' &&
      g.cdsEnd > g.cdsStart;
    if (g.exons && g.exons.length > 0) {
      for (const [es, ee] of g.exons) {
        const ex1 = ((es - startBp) / span) * width;
        const ex2 = ((ee - startBp) / span) * width;
        const ew = Math.max(1.5, ex2 - ex1);
        if (!hasCds) {
          ctx.fillRect(ex1, midY - 4, ew, 8);
        } else {
          // Draw UTR thin bar first
          ctx.fillRect(ex1, midY - 2.2, ew, 4.4);
          // Overlay thick CDS portion
          const cs = Math.max(es, g.cdsStart!);
          const ce = Math.min(ee, g.cdsEnd!);
          if (ce > cs) {
            const cx1 = ((cs - startBp) / span) * width;
            const cx2 = ((ce - startBp) / span) * width;
            ctx.fillRect(cx1, midY - 4.2, Math.max(1.5, cx2 - cx1), 8.4);
          }
        }
      }
    } else {
      ctx.fillRect(x1, midY - 3, w, 6);
    }

    // Label
    if (g.name && span < 8_000_000) {
      ctx.fillStyle = '#e2e8f0';
      const lx = Math.max(2, x1);
      ctx.fillText(g.name, lx, midY + 9);
    }
  }

  if (hoverBp !== null && hoverBp >= startBp && hoverBp <= endBp) {
    const hx = ((hoverBp - startBp) / span) * width;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx + 0.5, 0);
    ctx.lineTo(hx + 0.5, height);
    ctx.stroke();
  }
}

export function drawArcTrack(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  arcs: ArcItem[],
  startBp: number,
  endBp: number,
  hoverBp: number | null,
  color: string
): void {
  const ctx = setupHiDPI(canvas, width, height);
  if (!ctx) return;

  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, width, height);

  const span = Math.max(1, endBp - startBp);
  const padTop = 22;
  const padBot = 6;
  const baseY = height - padBot;
  const availH = Math.max(12, baseY - padTop);

  ctx.lineWidth = 1.5;
  for (const a of arcs) {
    const m1 = 0.5 * (a.start1 + a.end1);
    const m2 = 0.5 * (a.start2 + a.end2);
    const x1 = ((m1 - startBp) / span) * width;
    const x2 = ((m2 - startBp) / span) * width;
    const distPx = Math.abs(x2 - x1);
    if (distPx < 1) continue;
    const arcH = Math.min(availH * 0.95, Math.max(10, distPx * 0.45));
    ctx.strokeStyle = a.color || color;
    ctx.globalAlpha = 0.78;
    ctx.beginPath();
    ctx.moveTo(x1, baseY);
    ctx.quadraticCurveTo((x1 + x2) * 0.5, baseY - arcH * 1.9, x2, baseY);
    ctx.stroke();
  }
  ctx.globalAlpha = 1.0;

  if (hoverBp !== null && hoverBp >= startBp && hoverBp <= endBp) {
    const hx = ((hoverBp - startBp) / span) * width;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx + 0.5, 0);
    ctx.lineTo(hx + 0.5, height);
    ctx.stroke();
  }
}

export interface OverlayLayer {
  color: string;
  items: ArcItem[];
}

export interface SplitOverlayInfo {
  upperLabel: string;
  lowerLabel: string;
}

export function drawHeatmapOverlays(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  startBp: number,
  endBp: number,
  mode: MatrixMode,
  overlays: OverlayLayer[],
  hoverBp: number | null,
  hoverBp2: number | null,
  splitInfo?: SplitOverlayInfo | null
): void {
  const ctx = setupHiDPI(canvas, width, height);
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);
  const span = Math.max(1, endBp - startBp);

  // Diagonal divider + corner labels for Split Upper/Lower comparison
  if (splitInfo && mode === 'square') {
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.72)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(width, height);
    ctx.stroke();

    ctx.font = '11px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    const drawCornerPill = (text: string, x: number, y: number, alignRight: boolean) => {
      const tw = ctx.measureText(text).width + 14;
      const rx = alignRight ? x - tw : x;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
      ctx.fillRect(rx, y - 10, tw, 20);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(rx + 0.5, y - 9.5, tw - 1, 19);
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(text, rx + 7, y);
    };
    drawCornerPill(`▲ Upper: ${splitInfo.upperLabel}`, width - 10, 46, true);
    drawCornerPill(`▼ Lower: ${splitInfo.lowerLabel}`, 10, height - 18, false);
  }

  const toScreen = (gx: number, gy: number): [number, number] => {
    if (mode === 'triangle') {
      const a = Math.min(gx, gy);
      const b = Math.max(gx, gy);
      const mid = 0.5 * (a + b);
      const sep = b - a;
      const px = ((mid - startBp) / span) * width;
      const py = height - (0.5 * sep / span) * width;
      return [px, py];
    } else {
      const px = ((gx - startBp) / span) * width;
      const py = ((gy - startBp) / span) * height;
      return [px, py];
    }
  };

  for (const layer of overlays) {
    ctx.strokeStyle = layer.color;
    ctx.lineWidth = 1.6;
    for (const it of layer.items) {
      if (it.kind === 'domain') {
        // Draw TAD triangle in triangle mode, or square along diagonal in square mode
        const a = it.start1;
        const b = it.end1;
        if (mode === 'triangle') {
          const [xL, yL] = toScreen(a, a);
          const [xR, yR] = toScreen(b, b);
          const [xTop, yTop] = toScreen(b, a);
          ctx.beginPath();
          ctx.moveTo(xL, yL);
          ctx.lineTo(xTop, yTop);
          ctx.lineTo(xR, yR);
          ctx.stroke();
        } else {
          const [x1, y1] = toScreen(a, a);
          const [x2, y2] = toScreen(b, b);
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        }
      } else {
        // Loop / BEDPE anchor box or dot
        const mx = 0.5 * (it.start1 + it.end1);
        const my = 0.5 * (it.start2 + it.end2);
        const [px, py] = toScreen(mx, my);
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // Crosshair
  if (hoverBp !== null) {
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    if (mode === 'triangle') {
      if (hoverBp2 !== null && hoverBp2 !== hoverBp) {
        const a = Math.min(hoverBp, hoverBp2);
        const b = Math.max(hoverBp, hoverBp2);
        const [px, py] = toScreen(b, a);
        const [ax, ay] = toScreen(a, a);
        const [bx, by] = toScreen(b, b);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(px, py);
        ctx.lineTo(bx, by);
        ctx.stroke();
      } else {
        const hx = ((hoverBp - startBp) / span) * width;
        ctx.beginPath();
        ctx.moveTo(hx + 0.5, 0);
        ctx.lineTo(hx + 0.5, height);
        ctx.stroke();
      }
    } else {
      const hx = ((hoverBp - startBp) / span) * width;
      ctx.beginPath();
      ctx.moveTo(hx + 0.5, 0);
      ctx.lineTo(hx + 0.5, height);
      ctx.stroke();
      if (hoverBp2 !== null) {
        const hy = ((hoverBp2 - startBp) / span) * height;
        ctx.beginPath();
        ctx.moveTo(0, hy + 0.5);
        ctx.lineTo(width, hy + 0.5);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }
}
