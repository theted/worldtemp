import * as THREE from 'three';
import type { Field } from './field';
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
  /** Re-measures the visible field and eases the window toward it. Returns the smoothed window. */
  update(camera: THREE.PerspectiveCamera, month: number, dt: number): TempWindow;
  readonly window: TempWindow;
}

/** 1344 rays. Cost is independent of zoom, so this is a flat per-frame budget. */
const SAMPLES_X = 48;
const SAMPLES_Y = 28;

/** Below this many hits the globe is basically off screen; keep the last good window. */
const MIN_HITS = 24;

/** Trim this fraction off each tail, so a single outlier can't define the scale. */
const TAIL = 0.005;

/** Never window tighter than this, or 8-bit quantisation and noise start to dominate. */
const MIN_SPAN_C = 4;

/** Smoothing time constant, seconds. Long enough to feel settled, short enough to feel responsive. */
const TAU = 0.22;

export function createExposure(field: Field): Exposure {
  const { tMin, tMax } = field.meta;
  const span = tMax - tMin;

  // The data is already 8-bit quantised, so 256 bins are exact rather than an approximation —
  // the histogram costs nothing and gives percentiles for free.
  const hist = new Uint16Array(256);

  const dir = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const ll: LonLat = { lon: 0, lat: 0 };

  const window: TempWindow = { lo: tMin, hi: tMax };
  const target: TempWindow = { lo: tMin, hi: tMax };
  let settled = false;

  const update = (camera: THREE.PerspectiveCamera, month: number, dt: number): TempWindow => {
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
        const bin = Math.round(field.sampleByte(ll.lon, ll.lat, month));
        hist[bin < 0 ? 0 : bin > 255 ? 255 : bin]!++;
        hits++;
      }
    }

    if (hits >= MIN_HITS) {
      const cut = Math.floor(hits * TAIL);

      let acc = 0;
      let loBin = 0;
      for (let i = 0; i < 256; i++) {
        acc += hist[i]!;
        if (acc > cut) {
          loBin = i;
          break;
        }
      }
      acc = 0;
      let hiBin = 255;
      for (let i = 255; i >= 0; i--) {
        acc += hist[i]!;
        if (acc > cut) {
          hiBin = i;
          break;
        }
      }

      let lo = tMin + (loBin / 255) * span;
      let hi = tMin + (hiBin / 255) * span;

      if (hi - lo < MIN_SPAN_C) {
        const mid = (lo + hi) / 2;
        lo = mid - MIN_SPAN_C / 2;
        hi = mid + MIN_SPAN_C / 2;
      }
      // Push back off the ends rather than letting the clamp quietly shrink the span again.
      if (hi > tMax) {
        hi = tMax;
        lo = Math.min(lo, hi - MIN_SPAN_C);
      }
      if (lo < tMin) {
        lo = tMin;
        hi = Math.max(hi, lo + MIN_SPAN_C);
      }

      target.lo = Math.max(lo, tMin);
      target.hi = Math.min(hi, tMax);
    }

    // Frame-rate independent easing. Snap on the very first measurement so the opening view is
    // correct immediately instead of sliding into place.
    const k = settled ? 1 - Math.exp(-dt / TAU) : 1;
    window.lo += (target.lo - window.lo) * k;
    window.hi += (target.hi - window.hi) * k;
    settled = true;

    return window;
  };

  return { update, window };
}
