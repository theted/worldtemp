import * as THREE from 'three';
import type { CountryAnchor } from './countries';

/**
 * Country names, drawn as DOM text over the canvas.
 *
 * DOM rather than in-scene geometry: real text rendering stays crisp at every zoom, inherits the
 * page's font and styling, and needs no glyph atlas, no SDF shader and no committed font file —
 * which matters here, because the app must keep working with no network at all.
 *
 * The cost of that choice is that every visible label has to be positioned by hand each frame, so
 * the work is kept off the layout path: widths are measured exactly once at construction, and the
 * per-frame loop only ever writes `transform` and `opacity`, both of which the compositor can
 * handle without a reflow.
 */

/** Below this on-screen radius a country is too small for its name to mean anything. */
const MIN_PIXEL_RADIUS = 18;

/** Hard cap, so a wide view can't turn into a wall of text. */
const MAX_VISIBLE = 44;

const PAD_X = 7;
const PAD_Y = 3;

interface Slot {
  anchor: CountryAnchor;
  el: HTMLSpanElement;
  w: number;
  h: number;
  shown: boolean;
  x: number;
  y: number;
  priority: number;
  lastPlaced: number;
}

export interface Labels {
  update(
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    enabled: boolean,
  ): void;
  dispose(): void;
}

export function createLabels(container: HTMLElement, anchors: CountryAnchor[]): Labels {
  const layer = document.createElement('div');
  layer.className = 'pointer-events-none absolute inset-0 overflow-hidden';
  container.appendChild(layer);

  const slots: Slot[] = anchors.map((anchor) => {
    const el = document.createElement('span');
    el.className = 'country-label';
    el.textContent = anchor.name;
    layer.appendChild(el);
    return { anchor, el, w: 0, h: 0, shown: false, x: 0, y: 0, priority: 0, lastPlaced: -1 };
  });

  // One batched layout read. Label text and font size never change, so their boxes never change
  // either — measuring here means the frame loop never has to touch offsetWidth, which would force
  // a synchronous reflow every time it did.
  for (const s of slots) {
    s.w = s.el.offsetWidth;
    s.h = s.el.offsetHeight;
  }

  const projected = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const candidates: Slot[] = [];
  const placed: Slot[] = [];
  let frameId = 0;
  let wasEnabled = true;

  const hide = (s: Slot) => {
    if (!s.shown) return;
    s.el.style.opacity = '0';
    s.shown = false;
  };

  const update = (
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    enabled: boolean,
  ) => {
    if (!enabled) {
      if (wasEnabled) {
        for (const s of slots) hide(s);
        wasEnabled = false;
      }
      return;
    }
    wasEnabled = true;
    frameId++;

    // Vector3.project reads camera.matrixWorldInverse, which the renderer only refreshes inside
    // render(). Labels are positioned before that, so without this they would trail the camera by a
    // frame -- and on the very first frame project against a matrix that was never computed at all.
    camera.updateMatrixWorld();

    const camDist = camera.position.length();
    camDir.copy(camera.position).divideScalar(camDist);
    // Everything past the horizon faces away. The extra margin also drops labels sitting *on* the
    // limb, where the surface is so foreshortened that a name would span half a continent.
    const horizon = 1 / camDist + 0.06;
    // Pixels per radian of arc at unit distance; divided by range below to get apparent size.
    const scale = height / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);

    candidates.length = 0;
    for (const s of slots) {
      const { position, radius } = s.anchor;
      if (position.dot(camDir) < horizon) continue;

      const pixelRadius = (radius * scale) / camera.position.distanceTo(position);
      if (pixelRadius < MIN_PIXEL_RADIUS) continue;

      projected.copy(position).project(camera);
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      if (x < -60 || x > width + 60 || y < -20 || y > height + 20) continue;

      s.x = x;
      s.y = y;
      s.priority = pixelRadius;
      candidates.push(s);
    }

    // Biggest first, so when two labels collide the one that survives is the one naming more of
    // what you can see. This is also what makes zooming feel right: small countries appear as they
    // grow past the threshold, rather than fighting their neighbours for space.
    candidates.sort((a, b) => b.priority - a.priority);

    placed.length = 0;
    for (const s of candidates) {
      if (placed.length >= MAX_VISIBLE) break;
      let clash = false;
      for (const q of placed) {
        if (
          Math.abs(s.x - q.x) * 2 < s.w + q.w + PAD_X * 2 &&
          Math.abs(s.y - q.y) * 2 < s.h + q.h + PAD_Y * 2
        ) {
          clash = true;
          break;
        }
      }
      if (clash) continue;

      placed.push(s);
      s.lastPlaced = frameId;
      s.el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -50%)`;
      if (!s.shown) {
        s.el.style.opacity = '1';
        s.shown = true;
      }
    }

    for (const s of slots) if (s.shown && s.lastPlaced !== frameId) hide(s);
  };

  return {
    update,
    dispose: () => layer.remove(),
  };
}
