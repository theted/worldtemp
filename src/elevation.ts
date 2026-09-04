import * as THREE from 'three';
import { decodeGray } from './terrain';

/**
 * Surface elevation, for bending the globe's geometry into something with mountains in it.
 *
 * A separate raster from the hillshade, and necessarily so: a shaded relief is already a
 * *derivative* of height — roughly how much a slope faces the light — so displacing geometry by it
 * would raise the lit flank of every ridge and sink the shaded one. Recovering height from a
 * hillshade means integrating a gradient field, which is ill-posed. This is the real thing, from
 * ETOPO.
 *
 * It is also far coarser than the hillshade, and that is not a compromise. The hillshade is read by
 * pixels and has to survive tenfold magnification; this is read by *vertices*, and the sphere's own
 * tessellation is coarser than the grid either way. Silhouettes are made of mountain ranges.
 */

export interface Elevation {
  texture: THREE.DataTexture;
  /**
   * Normalised height, 0–1, at a geographic point — the same number the vertex shader samples.
   *
   * Bilinear, to match the GPU's own filtering: the country outlines are lifted by this on the CPU
   * and would crawl against the surface under them if the two disagreed.
   */
  sampleAt(lon: number, lat: number): number;
}

export async function loadElevation(
  width: number,
  height: number,
  base = import.meta.env.BASE_URL,
): Promise<Elevation> {
  const gray = await decodeGray(`${base}data/elevation.png`, width, height);

  const texture = new THREE.DataTexture(gray, width, height, THREE.RedFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // No mipmaps: this is sampled in the vertex shader, where there is no screen-space derivative to
  // pick a level from, and a wrongly-chosen level would flatten mountains rather than blur them.
  texture.generateMipmaps = false;
  texture.wrapS = THREE.RepeatWrapping; // longitude is cyclic, as everywhere else
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;

  const sampleAt = (lon: number, lat: number): number => {
    const fx = ((lon + 180) / 360) * width - 0.5;
    const fy = ((90 - lat) / 180) * height - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const wx = fx - x0;
    const wy = fy - y0;
    const xa = ((x0 % width) + width) % width;
    const xb = (xa + 1) % width;
    const ya = Math.min(Math.max(y0, 0), height - 1);
    const yb = Math.min(Math.max(y0 + 1, 0), height - 1);
    const g = (y: number, x: number) => gray[y * width + x]! / 255;
    return (
      g(ya, xa) * (1 - wx) * (1 - wy) +
      g(ya, xb) * wx * (1 - wy) +
      g(yb, xa) * (1 - wx) * wy +
      g(yb, xb) * wx * wy
    );
  };

  return { texture, sampleAt };
}
