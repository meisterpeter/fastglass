import type { ColormapId, CompareMode, MatrixMode } from '../types';
import { getColormapLUT } from './colormaps';
import type { CachedTile } from './tileCache';

const VERT_SRC = `#version 300 es
precision highp float;
precision highp int;

in vec2 a_uv;

uniform float u_startBp;
uniform float u_spanBp;
uniform float u_aspect; // width / height
uniform int u_mode;     // 0 = square, 1 = triangle
uniform vec4 u_tileBp;  // (gx0, gx1, gy0, gy1)

out vec2 v_uv;
out vec2 v_genomic;

void main() {
  float gx = mix(u_tileBp.x, u_tileBp.y, a_uv.x);
  float gy = mix(u_tileBp.z, u_tileBp.w, a_uv.y);
  v_uv = a_uv;
  v_genomic = vec2(gx, gy);

  vec2 ndc;
  if (u_mode == 1) {
    float mid = 0.5 * (gx + gy);
    float sep = gx - gy;
    float fx = (mid - u_startBp) / u_spanBp;
    float fy = (0.5 * sep / u_spanBp) * u_aspect;
    ndc = vec2(fx * 2.0 - 1.0, fy * 2.0 - 1.0);
  } else {
    float fx = (gx - u_startBp) / u_spanBp;
    float fy = (gy - u_startBp) / u_spanBp;
    ndc = vec2(fx * 2.0 - 1.0, 1.0 - fy * 2.0);
  }

  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;
in vec2 v_genomic;

uniform sampler2D u_tileTex;
uniform sampler2D u_tileTexB;
uniform sampler2D u_lutTex;
uniform int u_mode;
uniform int u_compareMode; // 0 = single, 1 = split, 2 = log2ratio, 3 = diff
uniform int u_hasB;
uniform int u_logScale;
uniform int u_isOE;
uniform float u_vmin;
uniform float u_vmax;
uniform float u_vminB;
uniform float u_vmaxB;
uniform float u_gamma;
uniform float u_chromLen;

out vec4 outColor;

float safePow(float x, float g) {
  return x <= 0.0 ? 0.0 : pow(x, g);
}

float mapSingle(float val, float vmin, float vmax) {
  if (u_isOE == 1) {
    float lv = log2(max(val, 1e-4));
    float lim = max(abs(vmax), 0.5);
    return clamp(0.5 + 0.5 * (lv / lim), 0.0, 1.0);
  }
  if (u_logScale == 1) {
    if (val <= 0.0) return 0.0;
    float eps = max(vmin * 0.5, vmax * 1e-4);
    float lo = log(max(vmin, 0.0) + eps);
    float hi = log(max(vmax, vmin + 1e-9) + eps);
    return clamp((log(val + eps) - lo) / max(hi - lo, 1e-9), 0.0, 1.0);
  }
  return clamp((val - vmin) / max(vmax - vmin, 1e-9), 0.0, 1.0);
}

void main() {
  if (u_mode == 1 && v_genomic.x < v_genomic.y) {
    discard;
  }
  if (v_genomic.x > u_chromLen || v_genomic.y > u_chromLen || v_genomic.x < 0.0 || v_genomic.y < 0.0) {
    discard;
  }

  vec4 maskColor = vec4(0.88, 0.90, 0.93, 1.0);

  // Split upper (A) / lower (B) diagonal in Square mode
  if (u_compareMode == 1) {
    bool isLower = v_genomic.x < v_genomic.y;
    if (isLower) {
      if (u_hasB == 0) {
        outColor = vec4(0.08, 0.10, 0.15, 1.0);
        return;
      }
      float vb = texture(u_tileTexB, v_uv).r;
      if (isnan(vb) || isinf(vb)) {
        outColor = maskColor;
        return;
      }
      float tb = safePow(mapSingle(vb, u_vminB, u_vmaxB), max(u_gamma, 0.05));
      outColor = texture(u_lutTex, vec2(tb, 0.5));
      return;
    } else {
      float va = texture(u_tileTex, v_uv).r;
      if (isnan(va) || isinf(va)) {
        outColor = maskColor;
        return;
      }
      float ta = safePow(mapSingle(va, u_vmin, u_vmax), max(u_gamma, 0.05));
      outColor = texture(u_lutTex, vec2(ta, 0.5));
      return;
    }
  }

  // Differential: log2((A + eps) / (B + eps))
  if (u_compareMode == 2) {
    if (u_hasB == 0) {
      outColor = vec4(0.08, 0.10, 0.15, 1.0);
      return;
    }
    float va = texture(u_tileTex, v_uv).r;
    float vb = texture(u_tileTexB, v_uv).r;
    if (isnan(va) || isinf(va) || isnan(vb) || isinf(vb)) {
      outColor = maskColor;
      return;
    }
    float eps = max(u_vmin, 1e-4);
    float lr = log2((max(va, 0.0) + eps) / (max(vb, 0.0) + eps));
    float lim = max(abs(u_vmax), 0.25);
    float t = clamp(0.5 + 0.5 * (lr / lim), 0.0, 1.0);
    // Symmetric gamma around 0.5 for diverging maps
    float s = (t - 0.5) * 2.0;
    float sg = sign(s) * safePow(abs(s), max(u_gamma, 0.05));
    outColor = texture(u_lutTex, vec2(0.5 + 0.5 * sg, 0.5));
    return;
  }

  // Differential: A - B
  if (u_compareMode == 3) {
    if (u_hasB == 0) {
      outColor = vec4(0.08, 0.10, 0.15, 1.0);
      return;
    }
    float va = texture(u_tileTex, v_uv).r;
    float vb = texture(u_tileTexB, v_uv).r;
    if (isnan(va) || isinf(va) || isnan(vb) || isinf(vb)) {
      outColor = maskColor;
      return;
    }
    float d = va - vb;
    float lim = max(abs(u_vmax), 1e-5);
    float t = clamp(0.5 + 0.5 * (d / lim), 0.0, 1.0);
    float s = (t - 0.5) * 2.0;
    float sg = sign(s) * safePow(abs(s), max(u_gamma, 0.05));
    outColor = texture(u_lutTex, vec2(0.5 + 0.5 * sg, 0.5));
    return;
  }

  // Standard single matrix
  float val = texture(u_tileTex, v_uv).r;
  if (isnan(val) || isinf(val)) {
    outColor = maskColor;
    return;
  }
  float t = safePow(mapSingle(val, u_vmin, u_vmax), max(u_gamma, 0.05));
  outColor = texture(u_lutTex, vec2(t, 0.5));
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('Failed to create shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile error: ${log}`);
  }
  return sh;
}

export interface TileDrawPair {
  tileA: CachedTile;
  tileB?: CachedTile;
}

export interface HeatmapRenderParams {
  startBp: number;
  endBp: number;
  chromLength: number;
  mode: MatrixMode;
  compareMode: CompareMode;
  colormap: ColormapId;
  logScale: boolean;
  isOE: boolean;
  vmin: number;
  vmax: number;
  vminB: number;
  vmaxB: number;
  gamma: number;
}

const COMPARE_TO_INT: Record<CompareMode, number> = {
  none: 0,
  split: 1,
  log2ratio: 2,
  diff: 3,
};

export class WebGLHeatmapRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private lutTex: WebGLTexture;
  private dummyTex: WebGLTexture;
  private activeColormap: ColormapId | null = null;
  private tileTextures = new Map<string, WebGLTexture>();
  private maxTextures = 220;

  private loc: Record<string, WebGLUniformLocation | null> = {};

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error('WebGL2 is not supported in this browser');
    }
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram();
    if (!prog) throw new Error('Failed to create WebGL program');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(prog)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = prog;

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    this.vao = vao;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const verts = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, 'a_uv');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const lutTex = gl.createTexture();
    if (!lutTex) throw new Error('Failed to create LUT texture');
    this.lutTex = lutTex;
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // 1x1 dummy R32F texture when B is absent
    const dummyTex = gl.createTexture();
    if (!dummyTex) throw new Error('Failed to create dummy texture');
    this.dummyTex = dummyTex;
    gl.bindTexture(gl.TEXTURE_2D, dummyTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));

    const names = [
      'u_startBp',
      'u_spanBp',
      'u_aspect',
      'u_mode',
      'u_compareMode',
      'u_hasB',
      'u_tileBp',
      'u_tileTex',
      'u_tileTexB',
      'u_lutTex',
      'u_logScale',
      'u_isOE',
      'u_vmin',
      'u_vmax',
      'u_vminB',
      'u_vmaxB',
      'u_gamma',
      'u_chromLen',
    ];
    for (const n of names) {
      this.loc[n] = gl.getUniformLocation(prog, n);
    }
  }

  private ensureLUT(colormap: ColormapId): void {
    if (this.activeColormap === colormap) return;
    const gl = this.gl;
    const lut = getColormapLUT(colormap);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    this.activeColormap = colormap;
  }

  private getOrUploadTile(tile: CachedTile): WebGLTexture {
    const existing = this.tileTextures.get(tile.key);
    if (existing) {
      this.tileTextures.delete(tile.key);
      this.tileTextures.set(tile.key, existing);
      return existing;
    }

    const gl = this.gl;
    while (this.tileTextures.size >= this.maxTextures) {
      const oldestKey = this.tileTextures.keys().next().value;
      if (oldestKey === undefined) break;
      const oldTex = this.tileTextures.get(oldestKey);
      if (oldTex) gl.deleteTexture(oldTex);
      this.tileTextures.delete(oldestKey);
    }

    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create tile texture');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      tile.tileSize,
      tile.tileSize,
      0,
      gl.RED,
      gl.FLOAT,
      tile.data
    );
    this.tileTextures.set(tile.key, tex);
    return tex;
  }

  render(pairs: TileDrawPair[], params: HeatmapRenderParams): void {
    const gl = this.gl;
    const w = gl.canvas.width;
    const h = gl.canvas.height;
    if (w <= 0 || h <= 0) return;

    gl.viewport(0, 0, w, h);
    gl.clearColor(0.055, 0.075, 0.11, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (pairs.length === 0) return;

    this.ensureLUT(params.colormap);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const spanBp = Math.max(1, params.endBp - params.startBp);
    const effMode = params.compareMode === 'split' ? 'square' : params.mode;

    gl.uniform1f(this.loc.u_startBp, params.startBp);
    gl.uniform1f(this.loc.u_spanBp, spanBp);
    gl.uniform1f(this.loc.u_aspect, w / h);
    gl.uniform1i(this.loc.u_mode, effMode === 'triangle' ? 1 : 0);
    gl.uniform1i(this.loc.u_compareMode, COMPARE_TO_INT[params.compareMode] ?? 0);
    gl.uniform1i(this.loc.u_logScale, params.logScale ? 1 : 0);
    gl.uniform1i(this.loc.u_isOE, params.isOE ? 1 : 0);
    gl.uniform1f(this.loc.u_vmin, params.vmin);
    gl.uniform1f(this.loc.u_vmax, params.vmax);
    gl.uniform1f(this.loc.u_vminB, params.vminB);
    gl.uniform1f(this.loc.u_vmaxB, params.vmaxB);
    gl.uniform1f(this.loc.u_gamma, params.gamma);
    gl.uniform1f(this.loc.u_chromLen, params.chromLength);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(this.loc.u_lutTex, 1);

    gl.uniform1i(this.loc.u_tileTex, 0);
    gl.uniform1i(this.loc.u_tileTexB, 2);

    // Draw coarser resolutions first so finer tiles paint seamlessly on top
    const ordered = [...pairs].sort((a, b) => b.tileA.resolution - a.tileA.resolution);
    for (const pair of ordered) {
      const tile = pair.tileA;
      const texA = this.getOrUploadTile(tile);
      const texB = pair.tileB ? this.getOrUploadTile(pair.tileB) : this.dummyTex;
      const tileSpan = tile.tileSize * tile.resolution;
      const gx0 = tile.tx * tileSpan;
      const gx1 = gx0 + tileSpan;
      const gy0 = tile.ty * tileSpan;
      const gy1 = gy0 + tileSpan;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.uniform1i(this.loc.u_hasB, pair.tileB ? 1 : 0);

      gl.uniform4f(this.loc.u_tileBp, gx0, gx1, gy0, gy1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    for (const tex of this.tileTextures.values()) {
      gl.deleteTexture(tex);
    }
    this.tileTextures.clear();
    gl.deleteTexture(this.lutTex);
    gl.deleteTexture(this.dummyTex);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}

/** Pick optimal available resolution for current viewport width & genomic span. */
export function pickResolution(
  resolutions: number[],
  spanBp: number,
  widthPx: number,
  otherResolutions?: number[]
): number {
  let pool = resolutions;
  if (otherResolutions && otherResolutions.length > 0) {
    const otherSet = new Set(otherResolutions);
    const common = resolutions.filter((r) => otherSet.has(r));
    if (common.length > 0) pool = common;
  }
  if (pool.length === 0) return 10000;
  const sorted = [...pool].sort((a, b) => a - b);
  const bpPerPx = spanBp / Math.max(widthPx, 1);
  const targetRes = bpPerPx * 1.4;
  let chosen = sorted[0];
  for (const r of sorted) {
    if (r <= targetRes) {
      chosen = r;
    } else {
      break;
    }
  }
  return chosen;
}

/** Compute visible (tx, ty) tile coordinates for a given resolution and view mode. */
export function computeVisibleTiles(
  startBp: number,
  endBp: number,
  chromLength: number,
  resolution: number,
  tileSize: number,
  mode: MatrixMode,
  widthPx: number,
  heightPx: number
): { tx: number; ty: number }[] {
  const tileSpan = tileSize * resolution;
  const maxTile = Math.max(0, Math.ceil(chromLength / tileSpan) - 1);
  const spanBp = Math.max(1, endBp - startBp);
  const out: { tx: number; ty: number }[] = [];

  if (mode === 'square') {
    const t0 = Math.max(0, Math.floor(startBp / tileSpan));
    const t1 = Math.min(maxTile, Math.floor(Math.max(0, endBp - 1) / tileSpan));
    for (let ty = t0; ty <= t1; ty++) {
      for (let tx = t0; tx <= t1; tx++) {
        out.push({ tx, ty });
      }
    }
    return out;
  }

  const maxDist = 2.0 * spanBp * (heightPx / Math.max(widthPx, 1));
  const minBinBp = Math.max(0, startBp - maxDist * 0.5);
  const maxBinBp = Math.min(chromLength, endBp + maxDist * 0.5);
  const tMin = Math.max(0, Math.floor(minBinBp / tileSpan));
  const tMax = Math.min(maxTile, Math.floor(Math.max(0, maxBinBp - 1) / tileSpan));

  for (let ty = tMin; ty <= tMax; ty++) {
    const gy0 = ty * tileSpan;
    const gy1 = gy0 + tileSpan;
    for (let tx = ty; tx <= tMax; tx++) {
      const gx0 = tx * tileSpan;
      const gx1 = gx0 + tileSpan;
      const midMin = 0.5 * (gx0 + gy0);
      const midMax = 0.5 * (gx1 + gy1);
      if (midMax < startBp || midMin > endBp) continue;
      const minSep = Math.max(0, gx0 - gy1);
      if (minSep > maxDist) continue;
      out.push({ tx, ty });
    }
  }
  return out;
}
