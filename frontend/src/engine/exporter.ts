import type { ColormapId, TrackConfig } from '../types';
import { formatBp, formatBpExact, sharedCamera } from './camera';
import { drawRuler } from './canvas1d';
import { getColormapLUT } from './colormaps';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getTrackLabel(t: TrackConfig): string {
  if (t.meta.track_kind === 'matrix2d') {
    if (t.compareMode === 'split' && t.compareTrackName) {
      return `Split ▲ ${t.meta.name} / ▼ ${t.compareTrackName} (${t.norm})`;
    }
    if (t.compareMode === 'log2ratio' && t.compareTrackName) {
      return `log2(${t.meta.name} / ${t.compareTrackName}) [${t.norm}]`;
    }
    if (t.compareMode === 'diff' && t.compareTrackName) {
      return `Diff (${t.meta.name} − ${t.compareTrackName}) [${t.norm}]`;
    }
    return `${t.meta.name} (${t.norm})`;
  }
  if (t.meta.track_kind === 'signal1d' && t.column) {
    return `${t.meta.name} · ${t.column}`;
  }
  return t.meta.name;
}

function buildSvgGradientStops(cm: ColormapId): string {
  const lut = getColormapLUT(cm);
  const stops: string[] = [];
  for (let i = 0; i <= 16; i++) {
    const idx = Math.min(255, Math.round((i / 16) * 255));
    const r = lut[idx * 4];
    const g = lut[idx * 4 + 1];
    const b = lut[idx * 4 + 2];
    const pct = ((i / 16) * 100).toFixed(1);
    stops.push(`<stop offset="${pct}%" stop-color="rgb(${r},${g},${b})" />`);
  }
  return stops.join('');
}

function drawColorbarCanvas(
  ctx: CanvasRenderingContext2D,
  cm: ColormapId,
  x: number,
  y: number,
  w: number,
  h: number,
  leftLabel: string,
  rightLabel: string
): void {
  const lut = getColormapLUT(cm);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.fillRect(x - 8, y - 6, w + 16, h + 24);
  ctx.strokeStyle = 'rgba(71, 85, 105, 0.8)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 8, y - 6, w + 16, h + 24);

  const grad = ctx.createLinearGradient(x, y, x + w, y);
  for (let i = 0; i <= 16; i++) {
    const idx = Math.min(255, Math.round((i / 16) * 255));
    grad.addColorStop(i / 16, `rgb(${lut[idx * 4]},${lut[idx * 4 + 1]},${lut[idx * 4 + 2]})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#e2e8f0';
  ctx.textBaseline = 'top';
  ctx.fillText(leftLabel, x, y + h + 3);
  const rw = ctx.measureText(rightLabel).width;
  ctx.fillText(rightLabel, x + w - rw, y + h + 3);
}

function getColorbarLabels(t: TrackConfig): [string, string] {
  if (t.compareMode === 'log2ratio') {
    const lim = t.autoContrast ? 2.0 : Math.abs(t.vmax);
    return [`-${lim.toFixed(1)}`, `+${lim.toFixed(1)} log2`];
  }
  if (t.compareMode === 'diff') {
    const lim = t.autoContrast ? 0.05 : Math.abs(t.vmax);
    return [`-${lim.toPrecision(2)}`, `+${lim.toPrecision(2)}`];
  }
  if (t.norm === 'oe') {
    const lim = t.autoContrast ? 2.0 : Math.abs(t.vmax);
    return [`-${lim.toFixed(1)}`, `+${lim.toFixed(1)} log2 O/E`];
  }
  return [t.logScale ? 'low (log)' : 'min', 'high'];
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getTrackRenderedHeight(t: TrackConfig, width: number): number {
  const el = document.querySelector<HTMLElement>(`[data-export-track-id="${t.id}"]`);
  const measured = el ? Math.round(el.getBoundingClientRect().height) : 0;
  if (measured > 0) return measured;
  if (
    t.meta.track_kind === 'matrix2d' &&
    (t.matrixMode === 'square' || (t.compareMode === 'split' && Boolean(t.compareTrackId)))
  ) {
    return width;
  }
  return t.height;
}

export function exportViewPNG(tracks: TrackConfig[]): void {
  const visible = tracks.filter((t) => t.visible);
  if (visible.length === 0) return;

  const cam = sharedCamera.get();
  const firstEl = document.querySelector<HTMLElement>(`[data-export-track-id="${visible[0].id}"]`);
  const width = Math.max(300, Math.round(firstEl?.getBoundingClientRect().width || 1000));
  const heights = visible.map((t) => getTrackRenderedHeight(t, width));

  const headerH = 34;
  const rulerH = 28;
  const totalH = headerH + rulerH + heights.reduce((sum, h) => sum + h, 0);

  const dpr = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * dpr;
  canvas.height = totalH * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Background
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, width, totalH);

  // Title Header
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, headerH);
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH - 0.5);
  ctx.lineTo(width, headerH - 0.5);
  ctx.stroke();

  ctx.font = '600 13px Inter, -apple-system, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textBaseline = 'middle';
  const span = cam.endBp - cam.startBp;
  const title = `FastGlass  ·  ${cam.chrom}:${formatBpExact(cam.startBp)}–${formatBpExact(cam.endBp)}  (${formatBp(span)})`;
  ctx.fillText(title, 12, headerH / 2);

  // Ruler
  const rulerCanvas = document.createElement('canvas');
  drawRuler(rulerCanvas, width, rulerH, cam.chrom, cam.startBp, cam.endBp, null);
  ctx.drawImage(rulerCanvas, 0, headerH, width, rulerH);

  // Tracks
  let curY = headerH + rulerH;
  visible.forEach((t, idx) => {
    const th = heights[idx];
    const el = document.querySelector<HTMLElement>(`[data-export-track-id="${t.id}"]`);
    if (el) {
      const glCanvas = el.querySelector<HTMLCanvasElement>('canvas[data-export-role="webgl"]');
      const ovCanvas = el.querySelector<HTMLCanvasElement>('canvas[data-export-role="overlay"]');
      const c1d = el.querySelector<HTMLCanvasElement>('canvas[data-export-role="1d"]');

      if (glCanvas) {
        ctx.drawImage(glCanvas, 0, curY, width, th);
      }
      if (ovCanvas) {
        ctx.drawImage(ovCanvas, 0, curY, width, th);
      }
      if (c1d) {
        ctx.drawImage(c1d, 0, curY, width, th);
      }
    }

    // Crisp track label pill (top-left)
    const label = getTrackLabel(t);
    ctx.font = '500 11px Inter, -apple-system, sans-serif';
    const lw = ctx.measureText(label).width + 14;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(8, curY + 6, lw, 20);
    ctx.strokeStyle = 'rgba(71, 85, 105, 0.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(8.5, curY + 6.5, lw - 1, 19);
    ctx.fillStyle = '#f1f5f9';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 15, curY + 16);

    // Colorbar for 2D heatmaps
    if (t.meta.track_kind === 'matrix2d') {
      const [lLbl, rLbl] = getColorbarLabels(t);
      drawColorbarCanvas(ctx, t.colormap, width - 138, curY + 12, 120, 8, lLbl, rLbl);
    }

    // Divider line
    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(0, curY + th - 0.5);
    ctx.lineTo(width, curY + th - 0.5);
    ctx.stroke();

    curY += th;
  });

  canvas.toBlob((blob) => {
    if (!blob) return;
    const fname = `fastglass_${cam.chrom}_${Math.round(cam.startBp)}-${Math.round(cam.endBp)}.png`;
    triggerDownload(blob, fname);
  }, 'image/png');
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

export function exportViewSVG(tracks: TrackConfig[]): void {
  const visible = tracks.filter((t) => t.visible);
  if (visible.length === 0) return;

  const cam = sharedCamera.get();
  const firstEl = document.querySelector<HTMLElement>(`[data-export-track-id="${visible[0].id}"]`);
  const width = Math.max(300, Math.round(firstEl?.getBoundingClientRect().width || 1000));
  const heights = visible.map((t) => getTrackRenderedHeight(t, width));

  const headerH = 34;
  const rulerH = 28;
  const totalH = headerH + rulerH + heights.reduce((sum, h) => sum + h, 0);
  const span = Math.max(1, cam.endBp - cam.startBp);

  const defs: string[] = [];
  const body: string[] = [];

  // Background + Title Header (pure vector)
  body.push(`<rect x="0" y="0" width="${width}" height="${totalH}" fill="#070b14" />`);
  body.push(`<rect x="0" y="0" width="${width}" height="${headerH}" fill="#0f172a" />`);
  body.push(`<line x1="0" y1="${headerH}" x2="${width}" y2="${headerH}" stroke="#1e293b" stroke-width="1" />`);
  const title = `FastGlass · ${cam.chrom}:${formatBpExact(cam.startBp)}–${formatBpExact(cam.endBp)} (${formatBp(span)})`;
  body.push(
    `<text x="12" y="${headerH / 2 + 4}" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="600">${escapeXml(title)}</text>`
  );

  // Pure Vector Ruler
  const rulerGroup: string[] = [];
  rulerGroup.push(`<rect x="0" y="${headerH}" width="${width}" height="${rulerH}" fill="#0f172a" />`);
  rulerGroup.push(
    `<line x1="0" y1="${headerH + rulerH}" x2="${width}" y2="${headerH + rulerH}" stroke="#334155" stroke-width="1" />`
  );
  const step = pickNiceStep(span, width);
  const firstTick = Math.ceil(cam.startBp / step) * step;
  for (let bp = firstTick; bp <= cam.endBp; bp += step) {
    const x = ((bp - cam.startBp) / span) * width;
    rulerGroup.push(
      `<line x1="${x.toFixed(1)}" y1="${headerH + rulerH - 8}" x2="${x.toFixed(1)}" y2="${headerH + rulerH}" stroke="#64748b" stroke-width="1" />`
    );
    rulerGroup.push(
      `<text x="${Math.max(24, Math.min(width - 24, x)).toFixed(1)}" y="${headerH + 14}" text-anchor="middle" fill="#94a3b8" font-family="monospace" font-size="10.5">${escapeXml(formatBp(bp))}</text>`
    );
  }
  body.push(`<g id="ruler">${rulerGroup.join('')}</g>`);

  // Tracks (embedded crisp canvas raster + pure vector labels, borders & colorbar legends)
  let curY = headerH + rulerH;
  visible.forEach((t, idx) => {
    const th = heights[idx];
    const el = document.querySelector<HTMLElement>(`[data-export-track-id="${t.id}"]`);
    const parts: string[] = [];
    const clipId = `clip-track-${idx}`;
    defs.push(`<clipPath id="${clipId}"><rect x="0" y="${curY}" width="${width}" height="${th}" /></clipPath>`);

    if (el) {
      const glCanvas = el.querySelector<HTMLCanvasElement>('canvas[data-export-role="webgl"]');
      const ovCanvas = el.querySelector<HTMLCanvasElement>('canvas[data-export-role="overlay"]');
      const c1d = el.querySelector<HTMLCanvasElement>('canvas[data-export-role="1d"]');

      if (glCanvas) {
        const uri = glCanvas.toDataURL('image/png');
        parts.push(
          `<image x="0" y="${curY}" width="${width}" height="${th}" preserveAspectRatio="none" href="${uri}" clip-path="url(#${clipId})" />`
        );
      }
      if (ovCanvas) {
        const uri = ovCanvas.toDataURL('image/png');
        parts.push(
          `<image x="0" y="${curY}" width="${width}" height="${th}" preserveAspectRatio="none" href="${uri}" clip-path="url(#${clipId})" />`
        );
      }
      if (c1d) {
        const uri = c1d.toDataURL('image/png');
        parts.push(
          `<image x="0" y="${curY}" width="${width}" height="${th}" preserveAspectRatio="none" href="${uri}" clip-path="url(#${clipId})" />`
        );
      }
    }

    // Pure vector label pill
    const label = getTrackLabel(t);
    const estW = Math.max(90, label.length * 6.5 + 18);
    parts.push(
      `<rect x="8" y="${curY + 6}" width="${estW.toFixed(0)}" height="20" rx="4" fill="rgba(15,23,42,0.88)" stroke="#475569" stroke-width="1" />`
    );
    parts.push(
      `<text x="16" y="${curY + 20}" fill="#f1f5f9" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="500">${escapeXml(label)}</text>`
    );

    // Pure vector colorbar for 2D heatmaps
    if (t.meta.track_kind === 'matrix2d') {
      const gradId = `grad-${idx}`;
      defs.push(`<linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">${buildSvgGradientStops(t.colormap)}</linearGradient>`);
      const [lLbl, rLbl] = getColorbarLabels(t);
      const bx = width - 138;
      const by = curY + 12;
      parts.push(
        `<rect x="${bx - 8}" y="${by - 6}" width="136" height="32" rx="4" fill="rgba(15,23,42,0.88)" stroke="#475569" stroke-width="1" />`
      );
      parts.push(`<rect x="${bx}" y="${by}" width="120" height="8" fill="url(#${gradId})" />`);
      parts.push(
        `<text x="${bx}" y="${by + 20}" fill="#e2e8f0" font-family="monospace" font-size="9.5">${escapeXml(lLbl)}</text>`
      );
      parts.push(
        `<text x="${bx + 120}" y="${by + 20}" text-anchor="end" fill="#e2e8f0" font-family="monospace" font-size="9.5">${escapeXml(rLbl)}</text>`
      );
    }

    parts.push(
      `<line x1="0" y1="${curY + th}" x2="${width}" y2="${curY + th}" stroke="#1e293b" stroke-width="1" />`
    );
    body.push(`<g id="track-${idx}-${escapeXml(t.meta.format_id)}">${parts.join('')}</g>`);
    curY += th;
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalH}" viewBox="0 0 ${width} ${totalH}">
  <defs>${defs.join('')}</defs>
  ${body.join('\n  ')}
</svg>`;

  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const fname = `fastglass_${cam.chrom}_${Math.round(cam.startBp)}-${Math.round(cam.endBp)}.svg`;
  triggerDownload(blob, fname);
}
