import * as THREE from 'three';

/**
 * The one place the sphere's geometry convention is written down.
 *
 * `THREE.SphereGeometry` (with the default `phiStart = 0`) parameterises its surface as
 *
 *     x = −r·cos(φ)·sin(θ)      φ = u · 2π          uv.x = u
 *     y =  r·cos(θ)             θ = v · π           uv.y = 1 − v
 *     z =  r·sin(φ)·sin(θ)
 *
 * which is *exactly* the equirectangular projection. That is the whole reason this project needs no
 * projection code: substituting u = (lon + 180)/360 and v = (90 − lat)/180 makes a plain lon/lat
 * raster line up with the sphere's own UVs, with no reprojection and no resampling.
 *
 * Both directions live here so the border overlay and the hover readout can't drift apart from the
 * shader — if this convention is ever wrong, the borders visibly float off the coastlines.
 */

/** Geographic coordinates to a point on a sphere of the given radius. */
export function lonLatToVec3(lon: number, lat: number, radius: number, out = new THREE.Vector3()) {
  const phi = ((lon + 180) * Math.PI) / 180;
  const theta = ((90 - lat) * Math.PI) / 180;
  const s = Math.sin(theta);
  return out.set(-radius * Math.cos(phi) * s, radius * Math.cos(theta), radius * Math.sin(phi) * s);
}

export interface LonLat {
  lon: number;
  lat: number;
}

/**
 * Sphere UV back to geographic coordinates.
 *
 * Raycasting hands us `intersection.uv` directly, so the hover readout inverts the same
 * parameterisation the shader samples rather than re-deriving anything from the 3-D position.
 */
export function uvToLonLat(u: number, v: number): LonLat {
  return { lon: u * 360 - 180, lat: v * 180 - 90 };
}

/**
 * A point on the unit sphere back to geographic coordinates — the exact inverse of
 * `lonLatToVec3`.
 *
 * Used by the auto-exposure sampler, which intersects rays with the sphere analytically and so has
 * a position rather than a UV. Writes into `out` because it runs a thousand-odd times per frame and
 * allocating that many short-lived objects would hand the collector needless work.
 */
export function vec3ToLonLat(p: THREE.Vector3, out: LonLat = { lon: 0, lat: 0 }): LonLat {
  out.lat = 90 - (Math.acos(Math.min(Math.max(p.y, -1), 1)) * 180) / Math.PI;
  let phi = Math.atan2(p.z, -p.x);
  if (phi < 0) phi += Math.PI * 2;
  out.lon = (phi * 180) / Math.PI - 180;
  return out;
}

/** Formats a coordinate the way an atlas would: 59.3° N, 18.1° E. */
export function formatLonLat(lon: number, lat: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}° ${ns}, ${Math.abs(lon).toFixed(1)}° ${ew}`;
}
