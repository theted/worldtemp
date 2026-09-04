import * as THREE from 'three';

/**
 * The colour ramps — defined exactly once, consumed by the globe shader, the legend bar and the
 * hover swatch. Defining them twice is how a legend silently starts lying about what it labels.
 *
 * Ramps come in two kinds, and the distinction is not cosmetic:
 *
 *   - **Diverging** ramps claim that their midpoint means something. Here that midpoint is 0 °C, so
 *     the freezing line and the sea-ice edge draw themselves. A diverging ramp is only honest if
 *     that midpoint is actually pinned to freezing — see `zeroSplit` below, which is what keeps it
 *     pinned even when the window moves or the encoded range is asymmetric.
 *   - **Sequential** ramps only claim low-to-high. They are the right choice whenever the scale is
 *     windowed to the view, because a floating window has no meaningful midpoint: zoomed into the
 *     Sahara in July the coolest thing visible is about 30 °C, and a diverging ramp would render it
 *     deep violet.
 */

export interface Stop {
  /**
   * Position in the ramp's own space, 0…1.
   *
   * For sequential ramps this is the normalised value directly. For diverging ramps it is
   * *canonical* space, where 0.5 is the midpoint by construction; the shader stretches each half
   * so that 0.5 lands on 0 °C wherever that falls in the current window.
   */
  t: number;
  hex: string;
}

export type PaletteKind = 'diverging' | 'sequential';

export interface Palette {
  id: string;
  label: string;
  kind: PaletteKind;
  stops: readonly Stop[];
}

/** Blue → white → red, the meteorological convention. White is welded to 0 °C. */
const THERMAL: readonly Stop[] = [
  { t: 0.0, hex: '#100a24' },
  { t: 0.09, hex: '#1b1440' },
  { t: 0.2, hex: '#242a72' },
  { t: 0.31, hex: '#2a5bb5' },
  { t: 0.4, hex: '#3f9ada' },
  { t: 0.46, hex: '#8ed5ee' },
  { t: 0.485, hex: '#d8eef7' },
  { t: 0.5, hex: '#f7f9f6' }, // 0 °C
  { t: 0.515, hex: '#fdefc8' },
  { t: 0.56, hex: '#fbd07a' },
  { t: 0.66, hex: '#f5a03f' },
  { t: 0.78, hex: '#e8563a' },
  { t: 0.9, hex: '#b81f3b' },
  { t: 1.0, hex: '#6d0f2f' },
];

/**
 * Magma-like. Monotonic in lightness, so it reads purely as low → high.
 *
 * The dark end is a visible violet rather than near-black on purpose: against the `#07090d` page
 * the globe would otherwise lose its silhouette wherever the coldest visible region meets the limb.
 * The same constraint applies to every sequential ramp here.
 */
const MAGMA: readonly Stop[] = [
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

/** Viridis. Perceptually uniform, and the only ramp here that survives colour-blindness intact. */
const VIRIDIS: readonly Stop[] = [
  { t: 0.0, hex: '#3b1d5e' },
  { t: 0.13, hex: '#472d7b' },
  { t: 0.25, hex: '#3b528b' },
  { t: 0.38, hex: '#2c728e' },
  { t: 0.5, hex: '#21918c' },
  { t: 0.63, hex: '#27ad81' },
  { t: 0.75, hex: '#5ec962' },
  { t: 0.88, hex: '#aadc32' },
  { t: 1.0, hex: '#fde725' },
];

/**
 * Turbo (Mikhailov, Google). A rainbow that is actually usable.
 *
 * Rainbows have a bad name in visualisation, and jet earned it: it reverses lightness in the middle,
 * inventing edges where the data is smooth and hiding real ones where it is not. Turbo was built to
 * keep the discriminating power of a full-spectrum ramp — many more distinguishable steps than any
 * two-hue ramp can offer — while making lightness climb monotonically the whole way. It is the
 * right choice when the question is "how many different values can I tell apart", and the wrong one
 * when the question is "is this above or below freezing", which is what the diverging ramps answer.
 */
const TURBO: readonly Stop[] = [
  { t: 0.0, hex: '#30123b' },
  { t: 0.07, hex: '#4145ab' },
  { t: 0.13, hex: '#4675ed' },
  { t: 0.2, hex: '#39a2fc' },
  { t: 0.27, hex: '#1bcfd4' },
  { t: 0.34, hex: '#24eca6' },
  { t: 0.41, hex: '#61fc6c' },
  { t: 0.48, hex: '#a4fc3b' },
  { t: 0.55, hex: '#d1e834' },
  { t: 0.62, hex: '#f3c63a' },
  { t: 0.69, hex: '#fe9b2d' },
  { t: 0.76, hex: '#f36315' },
  { t: 0.83, hex: '#d93806' },
  { t: 0.9, hex: '#b11901' },
  { t: 1.0, hex: '#7a0402' },
];

/**
 * ColorBrewer Spectral, cold end first. Diverging, and far wider through hue than thermal.
 *
 * Thermal spends its whole budget on blue and red so that white can mean exactly one thing. Spectral
 * gives that up — its midpoint is a pale straw rather than a white — and buys green, cyan and amber
 * with the difference. Two views that thermal renders as "cool blue" and "slightly cooler blue"
 * separate here into teal and green.
 */
const SPECTRAL: readonly Stop[] = [
  { t: 0.0, hex: '#4b3d8f' },
  { t: 0.1, hex: '#3288bd' },
  { t: 0.2, hex: '#66c2a5' },
  { t: 0.3, hex: '#abdda4' },
  { t: 0.4, hex: '#e6f598' },
  { t: 0.5, hex: '#fbf8c0' }, // 0 °C
  { t: 0.6, hex: '#fee08b' },
  { t: 0.7, hex: '#fdae61' },
  { t: 0.8, hex: '#f46d43' },
  { t: 0.9, hex: '#d53e4f' },
  { t: 1.0, hex: '#9e0142' },
];

/** Plasma. Magma's wider sibling — it reaches blue at the bottom instead of stopping at violet. */
const PLASMA: readonly Stop[] = [
  { t: 0.0, hex: '#1c0a86' },
  { t: 0.12, hex: '#41049d' },
  { t: 0.25, hex: '#6a00a8' },
  { t: 0.38, hex: '#8f0da4' },
  { t: 0.5, hex: '#b12a90' },
  { t: 0.62, hex: '#cc4778' },
  { t: 0.72, hex: '#e16462' },
  { t: 0.82, hex: '#f2844b' },
  { t: 0.9, hex: '#fca636' },
  { t: 0.96, hex: '#fcce25' },
  { t: 1.0, hex: '#f0f921' },
];

/** No hue at all — the quickest way to tell a real pattern from an artefact of the palette. */
const MONO: readonly Stop[] = [
  { t: 0.0, hex: '#1a1e26' },
  { t: 0.5, hex: '#8b939e' },
  { t: 1.0, hex: '#f4f7fa' },
];

export const PALETTES: readonly Palette[] = [
  { id: 'thermal', label: 'thermal', kind: 'diverging', stops: THERMAL },
  { id: 'spectral', label: 'spectral', kind: 'diverging', stops: SPECTRAL },
  { id: 'turbo', label: 'turbo', kind: 'sequential', stops: TURBO },
  { id: 'magma', label: 'magma', kind: 'sequential', stops: MAGMA },
  { id: 'plasma', label: 'plasma', kind: 'sequential', stops: PLASMA },
  { id: 'viridis', label: 'viridis', kind: 'sequential', stops: VIRIDIS },
  { id: 'mono', label: 'mono', kind: 'sequential', stops: MONO },
];

export const DEFAULT_PALETTE_ID = 'magma';

export function paletteById(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES.find((p) => p.id === DEFAULT_PALETTE_ID)!;
}

const LUT_SIZE = 256;
type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Maps a windowed value into a diverging ramp's canonical space, so that 0 °C always lands on the
 * ramp's midpoint.
 *
 * Each half is stretched independently: everything below freezing fills [0, 0.5] and everything
 * above fills [0.5, 1]. That keeps white on freezing whatever the window is, and it degrades
 * sensibly when the window doesn't straddle 0 °C at all — `zero` clamps to an end and the view uses
 * a single half of the ramp, which is the honest thing to show for an all-warm or all-cold view.
 */
export function zeroSplit(w: number, zero: number): number {
  return w < zero ? (w / Math.max(zero, 1e-4)) * 0.5 : 0.5 + ((w - zero) / Math.max(1 - zero, 1e-4)) * 0.5;
}

/**
 * Where the field's reference value sits inside a window, clamped to the ramp.
 *
 * `pivot` is 0 °C for temperature and 12 hours for day length — the two values a diverging ramp is
 * entitled to weld its midpoint to. It defaults to 0 so the temperature callers read unchanged.
 */
export function zeroPosition(lo: number, hi: number, pivot = 0): number {
  return Math.min(Math.max((pivot - lo) / (hi - lo), 0), 1);
}

/** Samples a ramp at a position in its own space. */
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
 * A 256×1 lookup texture the fragment shader indexes with the windowed value.
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

/**
 * A palette as a CSS gradient for the legend bar.
 *
 * A diverging ramp's stops are repositioned by the same split the shader applies, so the white band
 * on the legend sits exactly under 0 °C — otherwise the bar would promise a midpoint the globe
 * doesn't have.
 */
export function rampCss(palette: Palette, zero: number, direction = 'to right'): string {
  const place = (t: number) => {
    if (palette.kind !== 'diverging') return t;
    return t < 0.5 ? t * 2 * zero : zero + (t - 0.5) * 2 * (1 - zero);
  };
  const parts = palette.stops.map((s) => `${s.hex} ${(place(s.t) * 100).toFixed(2)}%`);
  return `linear-gradient(${direction}, ${parts.join(', ')})`;
}

/** Colour for a windowed value, cross-faded between two palettes exactly as the shader does. */
export function blendedCss(a: Palette, b: Palette, w: number, zero: number, blend: number): string {
  const ca = rampAt(a.stops, a.kind === 'diverging' ? zeroSplit(w, zero) : w);
  const cb = rampAt(b.stops, b.kind === 'diverging' ? zeroSplit(w, zero) : w);
  const c = (i: 0 | 1 | 2) => Math.round(ca[i] + (cb[i] - ca[i]) * blend);
  return `rgb(${c(0)} ${c(1)} ${c(2)})`;
}
