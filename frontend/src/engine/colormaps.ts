import type { ColormapId } from '../types';

type RGB = [number, number, number];

const STOPS: Record<ColormapId, RGB[]> = {
  // Classic HiGlass "fall" colormap
  fall: [
    [255, 255, 255],
    [255, 245, 210],
    [254, 217, 118],
    [253, 141, 60],
    [227, 26, 28],
    [128, 0, 38],
    [20, 5, 10],
  ],
  reds: [
    [255, 255, 255],
    [254, 224, 210],
    [252, 146, 114],
    [239, 59, 44],
    [165, 15, 21],
    [80, 0, 10],
  ],
  viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
  inferno: [
    [0, 0, 4],
    [87, 16, 110],
    [188, 55, 84],
    [249, 142, 9],
    [252, 255, 164],
  ],
  bwr: [
    [20, 60, 180],
    [115, 165, 235],
    [248, 248, 252],
    [240, 130, 115],
    [185, 20, 35],
  ],
  coolwarm: [
    [59, 76, 192],
    [141, 176, 254],
    [221, 221, 221],
    [244, 154, 123],
    [180, 4, 38],
  ],
  grey: [
    [255, 255, 255],
    [180, 180, 180],
    [90, 90, 90],
    [10, 10, 10],
  ],
};

export const COLORMAP_LIST: { id: ColormapId; label: string }[] = [
  { id: 'fall', label: 'Fall (HiGlass)' },
  { id: 'reds', label: 'Reds' },
  { id: 'bwr', label: 'Blue-White-Red (O/E)' },
  { id: 'coolwarm', label: 'Coolwarm' },
  { id: 'inferno', label: 'Inferno' },
  { id: 'viridis', label: 'Viridis' },
  { id: 'grey', label: 'Greyscale' },
];

const lutCache = new Map<ColormapId, Uint8Array>();

export function getColormapLUT(id: ColormapId): Uint8Array {
  const existing = lutCache.get(id);
  if (existing) return existing;
  const stops = STOPS[id] || STOPS.fall;
  const lut = new Uint8Array(256 * 4);
  const nSeg = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const pos = t * nSeg;
    const idx = Math.min(nSeg - 1, Math.floor(pos));
    const frac = pos - idx;
    const c0 = stops[idx];
    const c1 = stops[idx + 1];
    lut[i * 4 + 0] = Math.round(c0[0] + (c1[0] - c0[0]) * frac);
    lut[i * 4 + 1] = Math.round(c0[1] + (c1[1] - c0[1]) * frac);
    lut[i * 4 + 2] = Math.round(c0[2] + (c1[2] - c0[2]) * frac);
    lut[i * 4 + 3] = 255;
  }
  lutCache.set(id, lut);
  return lut;
}

export function getColormapGradientCSS(id: ColormapId): string {
  const stops = STOPS[id] || STOPS.fall;
  const parts = stops.map((c) => `rgb(${c[0]},${c[1]},${c[2]})`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}
