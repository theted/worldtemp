import * as THREE from 'three';

/**
 * Loads the baked monthly temperature field.
 *
 * The 12 PNGs are decoded exactly once and the resulting bytes serve two consumers: a
 * `DataArrayTexture` for the shader, and a CPU-side copy for the hover readout. Sharing one decode
 * is not just a saving — it means the number reported under the cursor is read from the same bytes
 * the GPU is drawing, so the readout cannot drift from the picture.
 */

export interface Meta {
  width: number;
  height: number;
  months: number;
  tMin: number;
  tMax: number;
  quantisationC: number;
  observed: { min: number; max: number };
  monthLabels: string[];
  sources: { layer: string; name: string; period: string; quantity: string }[];
}

export interface Reading {
  celsius: number;
  isLand: boolean;
}

export interface Field {
  meta: Meta;
  texture: THREE.DataArrayTexture;
  /** Bilinear sample at a geographic point, blended across the continuous month. */
  sampleAt(lon: number, lat: number, month: number): Reading;
  /**
   * The raw encoded temperature byte (0–255), nearest-neighbour, blended across the month.
   *
   * Feeds the auto-exposure histogram. Nearest rather than bilinear because it is both cheaper and
   * the more honest input to a histogram — interpolation would invent values that aren't in the
   * data and smear the extremes the window is trying to find.
   */
  sampleByte(lon: number, lat: number, month: number): number;
}

async function decodeLayer(url: string, w: number, h: number): Promise<Uint8ClampedArray> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} loading ${url}`);
  const bitmap = await createImageBitmap(await res.blob());
  if (bitmap.width !== w || bitmap.height !== h) {
    throw new Error(`${url}: ${bitmap.width}×${bitmap.height}, expected ${w}×${h}`);
  }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, w, h).data;
}

export async function loadField(base = import.meta.env.BASE_URL): Promise<Field> {
  const metaRes = await fetch(`${base}data/meta.json`);
  if (!metaRes.ok) throw new Error('meta.json missing — run `npm run data`');
  const meta = (await metaRes.json()) as Meta;
  const { width: W, height: H, months: M } = meta;

  const layers = await Promise.all(
    Array.from({ length: M }, (_, i) =>
      decodeLayer(`${base}data/tavg_${String(i + 1).padStart(2, '0')}.png`, W, H),
    ),
  );

  // Two channels per texel: R = temperature, G = land mask. Dropping B and A here is what keeps
  // this at ~56 MB of VRAM instead of ~112 MB.
  const packed = new Uint8Array(W * H * M * 2);
  for (let m = 0; m < M; m++) {
    const src = layers[m]!;
    const dst = m * W * H * 2;
    for (let i = 0, n = W * H; i < n; i++) {
      packed[dst + i * 2] = src[i * 4]!;
      packed[dst + i * 2 + 1] = src[i * 4 + 1]!;
    }
  }

  const texture = new THREE.DataArrayTexture(packed, W, H, M);
  texture.format = THREE.RGFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Longitude is cyclic: repeat wrapping lets the shader interpolate across the ±180° seam instead
  // of clamping into a visible stripe down the Pacific.
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace; // this is data, not colour
  texture.needsUpdate = true;

  const span = meta.tMax - meta.tMin;

  /** Bilinear read of one month layer, matching what the GPU's own filtering produces. */
  const readMonth = (m: number, fx: number, fy: number): { t: number; land: number } => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const wx = fx - x0;
    const wy = fy - y0;
    const xa = ((x0 % W) + W) % W;
    const xb = (xa + 1) % W;
    const ya = Math.min(Math.max(y0, 0), H - 1);
    const yb = Math.min(Math.max(y0 + 1, 0), H - 1);
    const base = m * W * H * 2;
    const at = (y: number, x: number) => base + (y * W + x) * 2;

    const ia = at(ya, xa);
    const ib = at(ya, xb);
    const ic = at(yb, xa);
    const id = at(yb, xb);
    const wa = (1 - wx) * (1 - wy);
    const wb = wx * (1 - wy);
    const wc = (1 - wx) * wy;
    const wd = wx * wy;

    return {
      t: packed[ia]! * wa + packed[ib]! * wb + packed[ic]! * wc + packed[id]! * wd,
      // nearest for the mask: a blended land/sea flag would be meaningless
      land: packed[at(wy < 0.5 ? ya : yb, wx < 0.5 ? xa : xb) + 1]!,
    };
  };

  const sampleAt = (lon: number, lat: number, month: number): Reading => {
    const fx = ((lon + 180) / 360) * W - 0.5;
    const fy = ((90 - lat) / 180) * H - 0.5;
    const m = ((month % M) + M) % M;
    const m0 = Math.floor(m);
    const m1 = (m0 + 1) % M;
    const f = m - m0;
    const a = readMonth(m0, fx, fy);
    const b = readMonth(m1, fx, fy);
    const q = a.t + (b.t - a.t) * f;
    return {
      celsius: meta.tMin + (q / 255) * span,
      isLand: (f < 0.5 ? a.land : b.land) > 127,
    };
  };

  /** Nearest-neighbour byte read from one month layer. */
  const byteAt = (m: number, fx: number, fy: number): number => {
    const x = ((Math.round(fx) % W) + W) % W;
    const y = Math.min(Math.max(Math.round(fy), 0), H - 1);
    return packed[(m * W * H + y * W + x) * 2]!;
  };

  const sampleByte = (lon: number, lat: number, month: number): number => {
    const fx = ((lon + 180) / 360) * W - 0.5;
    const fy = ((90 - lat) / 180) * H - 0.5;
    const m = ((month % M) + M) % M;
    const m0 = Math.floor(m);
    const m1 = (m0 + 1) % M;
    const f = m - m0;
    const a = byteAt(m0, fx, fy);
    return a + (byteAt(m1, fx, fy) - a) * f;
  };

  return { meta, texture, sampleAt, sampleByte };
}
