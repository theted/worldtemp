import * as THREE from 'three';
import { dataFetch } from './cache';

/**
 * The terrain raster: a hillshade and a coastline, at five times the temperature field's detail.
 *
 * Kept apart from `field.ts` because it answers a different question. The temperature layers are
 * *data* — twelve of them, sampled on the CPU as well as the GPU, and their bytes are quoted back
 * to the reader. This is one layer of scenery: it is never sampled on the CPU, never reported, and
 * only ever modulates how the surface already looks. Loading it separately is also what lets it be
 * a different size, which is the entire point — coastline detail has nothing to do with how finely
 * temperature is known, so it should not be paid for twelve times over.
 */

export interface Terrain {
  texture: THREE.DataTexture;
  width: number;
  height: number;
}

export async function loadTerrain(
  width: number,
  height: number,
  base = import.meta.env.BASE_URL,
): Promise<Terrain> {
  // Two single-channel files rather than one interleaved image. PNG predicts each byte from its
  // neighbour along the row, and a hillshade's fine texture is the hardest thing here to predict;
  // interleaving it with a mask and two constant channels put three unrelated bytes between every
  // pair the filter could have used and cost six times the size. Fetched together, so the extra
  // request costs a round trip rather than a round trip each.
  // Sequential, not concurrent. Each decode allocates a full RGBA ImageData for the raster -- four
  // bytes a pixel for one byte of payload -- and running the pair together doubles the peak for no
  // gain, since both are decoded on the same main thread anyway.
  const relief = await decodeGray(`${base}data/relief.png`, width, height);
  const mask = await decodeGray(`${base}data/landmask.png`, width, height);

  const packed = new Uint8Array(width * height * 2);
  for (let i = 0, n = width * height; i < n; i++) {
    packed[i * 2] = relief[i]!;
    packed[i * 2 + 1] = mask[i]!;
  }

  const texture = new THREE.DataTexture(packed, width, height, THREE.RGFormat);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Mipmaps matter more here than for the temperature field: this raster carries detail far finer
  // than a pixel when the globe is small on screen, and without them it would crawl with aliasing
  // as the camera moves. The temperature field is smooth enough not to need them.
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.wrapS = THREE.RepeatWrapping; // longitude is cyclic, as in field.ts
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;

  return { texture, width, height };
}

/** One grayscale PNG as a byte per pixel, taking the red channel of the decoded RGBA. */
export async function decodeGray(url: string, width: number, height: number): Promise<Uint8Array> {
  const res = await dataFetch(url);
  if (!res.ok) throw new Error(`${res.status} loading ${url} \u2014 run \`npm run data\``);
  const bitmap = await createImageBitmap(await res.blob());
  if (bitmap.width !== width || bitmap.height !== height) {
    throw new Error(`${url}: ${bitmap.width}\u00d7${bitmap.height}, expected ${width}\u00d7${height}`);
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;

  const out = new Uint8Array(width * height);
  for (let i = 0, n = width * height; i < n; i++) out[i] = rgba[i * 4]!;
  return out;
}
