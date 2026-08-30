import * as THREE from 'three';

/**
 * The temperature colour ramp — defined exactly once, consumed by both the globe shader and the
 * DOM legend. Defining it twice is how a legend silently starts lying about what it labels.
 *
 * Diverging, with the near-white stop pinned to 0 °C. Because the encoded range is symmetric
 * (−50…+50), 0 °C sits precisely at t = 0.5, so the freezing line reads as a bright band across the
 * globe without any rescaling — the sea ice edge and the snow line draw themselves.
 */

export interface Stop {
  /** Position in the normalised range, 0 = tMin, 1 = tMax. */
  t: number;
  hex: string;
}

export const STOPS: readonly Stop[] = [
  { t: 0.0, hex: '#150e2e' }, // −50 °C  deep violet
  { t: 0.09, hex: '#242a72' }, // −41
  { t: 0.19, hex: '#2a5bb5' }, // −31
  { t: 0.3, hex: '#3f9ada' }, // −20
  { t: 0.4, hex: '#8ed5ee' }, // −10
  { t: 0.47, hex: '#d8eef7' }, //  −3
  { t: 0.5, hex: '#f7f9f6' }, //   0 °C  freezing
  { t: 0.53, hex: '#fdefc8' }, //  +3
  { t: 0.6, hex: '#fbd07a' }, // +10
  { t: 0.7, hex: '#f5a03f' }, // +20
  { t: 0.8, hex: '#e8563a' }, // +30
  { t: 0.9, hex: '#b81f3b' }, // +40
  { t: 1.0, hex: '#6d0f2f' }, // +50 °C  deep crimson
];

const LUT_SIZE = 256;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Samples the ramp at a normalised position, interpolating between the two bracketing stops. */
export function rampAt(t: number): [number, number, number] {
  const x = Math.min(Math.max(t, 0), 1);
  let i = 0;
  while (i < STOPS.length - 2 && STOPS[i + 1]!.t < x) i++;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  const f = b.t === a.t ? 0 : (x - a.t) / (b.t - a.t);
  const ca = hexToRgb(a.hex);
  const cb = hexToRgb(b.hex);
  return [
    Math.round(ca[0] + (cb[0] - ca[0]) * f),
    Math.round(ca[1] + (cb[1] - ca[1]) * f),
    Math.round(ca[2] + (cb[2] - ca[2]) * f),
  ];
}

/**
 * A 256×1 lookup texture the fragment shader indexes with the normalised temperature.
 *
 * `colorSpace` is left as NoColorSpace and the renderer runs with output conversion disabled, so
 * these bytes reach the framebuffer untouched. That is what makes the globe and the CSS legend
 * below it provably the same colour rather than approximately the same colour.
 */
export function makeRampTexture(): THREE.DataTexture {
  const data = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const [r, g, b] = rampAt(i / (LUT_SIZE - 1));
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, LUT_SIZE, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** The same ramp as a CSS gradient, for the legend bar. */
export function rampCss(direction = 'to right'): string {
  const parts = STOPS.map((s) => `${s.hex} ${(s.t * 100).toFixed(1)}%`);
  return `linear-gradient(${direction}, ${parts.join(', ')})`;
}

/** CSS colour for a temperature, used by the hover tooltip's swatch. */
export function cssForTemp(celsius: number, tMin: number, tMax: number): string {
  const [r, g, b] = rampAt((celsius - tMin) / (tMax - tMin));
  return `rgb(${r} ${g} ${b})`;
}
