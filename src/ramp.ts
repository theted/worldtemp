import * as THREE from 'three';

/**
 * The two temperature colour ramps — defined exactly once, consumed by both the globe shader and
 * the DOM legend. Defining them twice is how a legend silently starts lying about what it labels.
 *
 * There are two because the scale has two modes, and they are not interchangeable:
 *
 *   - **Absolute** (−50…+50 °C) has a genuinely meaningful midpoint, so it gets a *diverging* ramp
 *     with near-white pinned to 0 °C. The freezing line and the sea-ice edge then draw themselves.
 *
 *   - **Relative** windows the scale to whatever is on screen, so its midpoint is an accident of
 *     the current view. A diverging ramp there would be actively misleading: zoomed into the Sahara
 *     in July the coolest thing visible is about 30 °C, and it would render deep violet. Windowed
 *     data gets a *sequential* ramp instead, where lightness rises monotonically and no individual
 *     colour makes a claim about absolute temperature.
 */

export interface Stop {
  /** Position in the normalised range, 0 = window low, 1 = window high. */
  t: number;
  hex: string;
}

/** Absolute mode. Symmetric about 0 °C, which is why white lands exactly on freezing. */
export const DIVERGING_STOPS: readonly Stop[] = [
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

/**
 * Relative mode. Monotonic in lightness, so it reads purely as low→high.
 *
 * The dark end is a visible violet rather than near-black on purpose: against the `#07090d` page
 * the globe would otherwise lose its silhouette wherever the coldest visible region meets the limb.
 */
export const SEQUENTIAL_STOPS: readonly Stop[] = [
  { t: 0.0, hex: '#1e1240' },
  { t: 0.12, hex: '#3a1a72' },
  { t: 0.25, hex: '#62207f' },
  { t: 0.38, hex: '#8b2a6e' },
  { t: 0.52, hex: '#b53c57' },
  { t: 0.66, hex: '#d96742' },
  { t: 0.78, hex: '#ef962c' },
  { t: 0.89, hex: '#f7c04a' },
  { t: 1.0, hex: '#fce9ad' },
];

const LUT_SIZE = 256;

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Samples a ramp at a normalised position, interpolating between the two bracketing stops. */
export function rampAt(stops: readonly Stop[], t: number): Rgb {
  const x = Math.min(Math.max(t, 0), 1);
  let i = 0;
  while (i < stops.length - 2 && stops[i + 1]!.t < x) i++;
  const a = stops[i]!;
  const b = stops[i + 1]!;
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
 * A 256×1 lookup texture the fragment shader indexes with the windowed temperature.
 *
 * `colorSpace` is left as NoColorSpace and the renderer runs with output conversion disabled, so
 * these bytes reach the framebuffer untouched. That is what makes the globe and the CSS legend
 * below it provably the same colour rather than approximately the same colour.
 */
export function makeRampTexture(stops: readonly Stop[]): THREE.DataTexture {
  const data = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const [r, g, b] = rampAt(stops, i / (LUT_SIZE - 1));
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

/** A ramp as a CSS gradient, for the legend bar. */
export function rampCss(stops: readonly Stop[], direction = 'to right'): string {
  return `linear-gradient(${direction}, ${stops
    .map((s) => `${s.hex} ${(s.t * 100).toFixed(1)}%`)
    .join(', ')})`;
}

/**
 * Colour for a normalised position, cross-faded between the two palettes exactly as the shader
 * does — so the tooltip swatch stays correct even mid-transition between modes.
 */
export function blendedCss(w: number, blend: number): string {
  const a = rampAt(DIVERGING_STOPS, w);
  const b = rampAt(SEQUENTIAL_STOPS, w);
  const c = (i: 0 | 1 | 2) => Math.round(a[i] + (b[i] - a[i]) * blend);
  return `rgb(${c(0)} ${c(1)} ${c(2)})`;
}
