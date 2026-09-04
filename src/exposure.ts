import * as THREE from 'three';
import type { Field } from './field';
import type { FieldSpec } from './fields';
import { vec3ToLonLat, type LonLat } from './geo';

/**
 * Auto-exposure for the temperature field: what is the hottest and coldest thing currently on
 * screen, for the currently selected point in the year?
 *
 * **Sampling happens in screen space, not data space.** Walking the data grid over the visible
 * lat/lon region sounds natural but has cost that explodes exactly when you least want it — zoomed
 * out, "visible" is an entire hemisphere, roughly a million texels. Casting a fixed grid of rays
 * *through the screen* costs the same at every zoom level, and it inherits the frustum, the aspect
 * ratio and back-face occlusion for free, because it literally is the screen.
 *
 * Three things would otherwise go wrong, and each has a guard here:
 *
 *   - **Flicker.** Raw min/max jitters as the sample grid slides over the surface, which would make
 *     the whole globe shimmer. Hence percentile clipping (one stray sample can't seize the scale)
 *     followed by exponential smoothing, so the scale settles like a camera's auto-exposure.
 *   - **Collapse.** Over open ocean the visible spread can be a fraction of a degree, and dividing
 *     by it amplifies noise into psychedelia. Hence a minimum span.
 *   - **Starvation.** Spin the globe until it is nearly off screen and almost no ray hits it; the
 *     handful that do are not a scale. Hence a minimum hit count, below which the last good window
 *     is kept.
 */

export interface TempWindow {
  lo: number;
  hi: number;
}

export interface Exposure {
  /**
   * Re-measures the visible field and eases the window toward it. Returns the smoothed window.
   *
   * With `landOnly`, ocean samples are dropped from the histogram — the mode for when the ocean is
   * not being coloured, so the scale describes what is actually on screen.
   */
  update(
    camera: THREE.PerspectiveCamera,
    month: number,
    dt: number,
    spec: FieldSpec,
    landOnly?: boolean,
  ): TempWindow;
  /**
   * Abandons the smoothed window and snaps to the next measurement.
   *
   * Called when the displayed quantity changes. Easing is right for a window that drifts as the
   * camera moves, but degrees and hours are not on a continuum: easing across would spend a quarter
   * of a second showing a window that is neither, and the legend would label it.
   */
  reset(spec: FieldSpec): void;
  readonly window: TempWindow;
}

/** 1344 rays. Cost is independent of zoom, so this is a flat per-frame budget. */
const SAMPLES_X = 48;
const SAMPLES_Y = 28;

/** Below this many hits the globe is basically off screen; keep the last good window. */
const MIN_HITS = 24;

/** Trim this fraction off each tail, so a few stray rays can't define the scale. */
const TAIL = 0.012;

/** Smoothing time constant, seconds. Long enough to feel settled, short enough to feel responsive. */
const TAU = 0.3;

/**
 * The most the window is allowed to travel per second, in field units.
 *
 * Exponential easing alone cannot fix a discontinuous target, because it moves fastest exactly when
 * the jump is largest. And the target really is discontinuous: the percentile is a threshold on a
 * cumulative count, so while Antarctica contributes fewer rays than the tail allows it is ignored
 * entirely, and the ray that tips it over moves the low end forty degrees in one frame. Everything
 * mid-ramp drops to the cold end at once, which is the white-to-deep-blue snap you get sliding the
 * pole into view.
 *
 * A speed limit bounds that by construction, whatever the histogram does. Small corrections are
 * nowhere near it and stay governed by TAU, so responsiveness is untouched; only the leaps are
 * turned into glides.
 */
const MAX_SLEW_PER_S = 26;

export function createExposure(field: Field): Exposure {
  // Temperature is already 8-bit quantised, so 256 bins are exact rather than an approximation —
  // the histogram costs nothing and gives percentiles for free.
  const hist = new Uint16Array(256);

  const dir = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const ll: LonLat = { lon: 0, lat: 0 };

  const window: TempWindow = { lo: 0, hi: 1 };
  const target: TempWindow = { lo: 0, hi: 1 };
  let settled = false;

  const reset = (spec: FieldSpec) => {
    window.lo = target.lo = spec.min;
    window.hi = target.hi = spec.max;
    settled = false;
  };

  const update = (
    camera: THREE.PerspectiveCamera,
    month: number,
    dt: number,
    spec: FieldSpec,
    landOnly = false,
  ): TempWindow => {
    const { min: tMin, max: tMax, minSpan } = spec;
    const span = tMax - tMin;
    hist.fill(0);
    let hits = 0;

    const origin = camera.position;
    // Ray/unit-sphere at the origin: |O + tD|² = 1 reduces to t² + 2(O·D)t + (O·O − 1) = 0.
    const c = origin.dot(origin) - 1;

    for (let iy = 0; iy < SAMPLES_Y; iy++) {
      const ndcY = ((iy + 0.5) / SAMPLES_Y) * 2 - 1;
      for (let ix = 0; ix < SAMPLES_X; ix++) {
        const ndcX = ((ix + 0.5) / SAMPLES_X) * 2 - 1;
        dir.set(ndcX, ndcY, 0.5).unproject(camera).sub(origin).normalize();

        const b = origin.dot(dir);
        const disc = b * b - c;
        if (disc <= 0) continue; // ray misses the globe
        const t = -b - Math.sqrt(disc); // near root: the hemisphere facing us
        if (t <= 0) continue;

        hit.copy(dir).multiplyScalar(t).add(origin);
        vec3ToLonLat(hit, ll);
        // Skipping ocean can starve the histogram completely — mid-Pacific there is no land in
        // frame at all — but that is exactly what MIN_HITS below already exists to survive.
        if (landOnly && !field.isLand(ll.lon, ll.lat, month)) continue;
        const bin = Math.round(spec.sampleByte(ll.lon, ll.lat, month));
        hist[bin < 0 ? 0 : bin > 255 ? 255 : bin]!++;
        hits++;
      }
    }

    if (hits >= MIN_HITS) {
      // Kept fractional, and the crossing interpolated inside its bin. On its own this only removes
      // the one-bin stair -- the leap across a sparse tail is in the statistic, not its resolution --
      // but it stops the window juddering by a quantisation step as rays drift between bins.
      const cut = hits * TAIL;

      let acc = 0;
      let loBin = 0;
      for (let i = 0; i < 256; i++) {
        const next = acc + hist[i]!;
        if (next > cut) {
          loBin = i + (hist[i]! > 0 ? (cut - acc) / hist[i]! : 0);
          break;
        }
        acc = next;
      }
      acc = 0;
      let hiBin = 255;
      for (let i = 255; i >= 0; i--) {
        const next = acc + hist[i]!;
        if (next > cut) {
          hiBin = i + 1 - (hist[i]! > 0 ? (cut - acc) / hist[i]! : 0);
          break;
        }
        acc = next;
      }

      let lo = tMin + (loBin / 255) * span;
      let hi = tMin + (hiBin / 255) * span;

      if (hi - lo < minSpan) {
        const mid = (lo + hi) / 2;
        lo = mid - minSpan / 2;
        hi = mid + minSpan / 2;
      }
      // Push back off the ends rather than letting the clamp quietly shrink the span again.
      if (hi > tMax) {
        hi = tMax;
        lo = Math.min(lo, hi - minSpan);
      }
      if (lo < tMin) {
        lo = tMin;
        hi = Math.max(hi, lo + minSpan);
      }

      target.lo = Math.max(lo, tMin);
      target.hi = Math.min(hi, tMax);
    }

    // Frame-rate independent easing, then a speed limit. Snap on the very first measurement so the
    // opening view is correct immediately instead of sliding into place.
    const k = settled ? 1 - Math.exp(-dt / TAU) : 1;
    const cap = settled ? MAX_SLEW_PER_S * dt : Infinity;
    const step = (from: number, to: number) => {
      const d = (to - from) * k;
      return from + (d > cap ? cap : d < -cap ? -cap : d);
    };
    window.lo = step(window.lo, target.lo);
    window.hi = step(window.hi, target.hi);
    settled = true;

    return window;
  };

  return { update, reset, window };
}
