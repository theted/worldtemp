import * as THREE from 'three';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { FeatureCollection, Polygon, MultiPolygon, Position } from 'geojson';
import { lonLatToVec3 } from './geo';

/**
 * The country vector layer: outlines to draw, and anchors to hang names off.
 *
 * Both come out of a single fetch and a single parse of Natural Earth's 110 m countries file
 * (105 KB, public domain), which already carries `properties.name` for all 177 features — so
 * labelling costs no extra data and no extra request.
 *
 * A pure heat map is beautiful and completely disorienting: without outlines it is genuinely hard
 * to tell the Sahara from central Australia. The outlines also double as a test — because they are
 * built from the projection convention in `geo.ts` while the field is sampled by the shader's own
 * UVs, any error in that convention shows up instantly as borders floating off the coast.
 */

/** Lines sit fractionally proud of the surface so they aren't swallowed by depth precision. */
const RADIUS = 1.0015;

/**
 * Maximum angular gap, in degrees, between successive vertices.
 *
 * Natural Earth stores long straight runs — some political borders are a single segment spanning
 * tens of degrees. On a plane that's fine; on a sphere the straight chord between two such vertices
 * cuts *through* the globe and vanishes behind it. Subdividing keeps every segment hugging the
 * surface.
 */
const MAX_STEP_DEG = 1.5;

/** Natural Earth already abbreviates ("Dem. Rep. Congo", "Bosnia and Herz."); this one it doesn't. */
const SHORT_NAMES: Record<string, string> = {
  'United States of America': 'United States',
};

export interface CountryAnchor {
  name: string;
  /** Unit vector at the country's area-weighted centre. */
  position: THREE.Vector3;
  /** Angular radius in radians: how much of the sphere the country spans, for label priority. */
  radius: number;
}

export interface Countries {
  lines: THREE.LineSegments;
  anchors: CountryAnchor[];
}

// -----------------------------------------------------------------------------------------------
// outlines
// -----------------------------------------------------------------------------------------------

function addRing(ring: Position[], target: number[]) {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  for (let i = 0; i < ring.length - 1; i++) {
    const [lon0, lat0] = ring[i] as [number, number];
    const [lon1, lat1] = ring[i + 1] as [number, number];

    // Longitude difference taken the short way round, so a segment crossing the antimeridian is
    // subdivided across the seam instead of being dragged the long way around the planet.
    let dLon = lon1 - lon0;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    const dLat = lat1 - lat0;

    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dLon), Math.abs(dLat)) / MAX_STEP_DEG));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      lonLatToVec3(lon0 + dLon * t0, lat0 + dLat * t0, RADIUS, a);
      lonLatToVec3(lon0 + dLon * t1, lat0 + dLat * t1, RADIUS, b);
      target.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
}

// -----------------------------------------------------------------------------------------------
// label anchors
// -----------------------------------------------------------------------------------------------

/**
 * Area-weighted centre of one ring, computed on the sphere rather than in lon/lat.
 *
 * Working in 3-D matters for two reasons. It makes the antimeridian a non-event — Russia and Fiji
 * would otherwise average their eastern and western halves into the middle of the wrong ocean — and
 * weighting each triangle of the fan by its area stops the result being dragged toward whichever
 * part of the outline happens to be most densely sampled, which for most countries is the coast.
 */
function ringCentre(
  ring: Position[],
): { centre: THREE.Vector3; area: number; radius: number } | null {
  if (ring.length < 4) return null;

  const v = ring.map(([lon, lat]) => lonLatToVec3(lon as number, lat as number, 1));
  const v0 = v[0]!;
  const centre = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let area = 0;

  for (let i = 1; i < v.length - 1; i++) {
    const a = v[i]!;
    const b = v[i + 1]!;
    const tri = cross.crossVectors(e1.subVectors(a, v0), e2.subVectors(b, v0)).length() * 0.5;
    if (tri <= 0) continue;
    area += tri;
    centre.x += ((v0.x + a.x + b.x) / 3) * tri;
    centre.y += ((v0.y + a.y + b.y) / 3) * tri;
    centre.z += ((v0.z + a.z + b.z) / 3) * tri;
  }
  if (area <= 0) return null;
  centre.divideScalar(area).normalize();

  let radius = 0;
  for (const p of v) {
    const ang = Math.acos(Math.min(Math.max(centre.dot(p), -1), 1));
    if (ang > radius) radius = ang;
  }
  return { centre, area, radius };
}

/**
 * One anchor per country, placed on its largest landmass.
 *
 * Largest-only rather than area-weighted across every polygon: averaging France with French Guiana,
 * or Norway with Svalbard, puts the label in the sea.
 */
function anchorFor(name: string, geometry: Polygon | MultiPolygon): CountryAnchor | null {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let best: { centre: THREE.Vector3; area: number; radius: number } | null = null;

  for (const poly of polys) {
    const outer = poly[0];
    if (!outer) continue;
    const c = ringCentre(outer);
    if (c && (!best || c.area > best.area)) best = c;
  }
  if (!best) return null;

  return { name: SHORT_NAMES[name] ?? name, position: best.centre, radius: best.radius };
}

// -----------------------------------------------------------------------------------------------

export async function loadCountries(base = import.meta.env.BASE_URL): Promise<Countries> {
  const res = await fetch(`${base}geo/countries-110m.json`);
  if (!res.ok) throw new Error(`${res.status} loading country borders`);
  const topo = (await res.json()) as Topology<{ countries: GeometryCollection }>;
  const fc = feature(topo, topo.objects.countries) as FeatureCollection<Polygon | MultiPolygon>;

  const positions: number[] = [];
  const anchors: CountryAnchor[] = [];

  for (const f of fc.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) addRing(ring, positions);

    const name = (f.properties as { name?: string } | null)?.name;
    if (name) {
      const anchor = anchorFor(name, f.geometry);
      if (anchor) anchors.push(anchor);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const material = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.3,
    depthWrite: false, // depth *test* stays on, so the far hemisphere's borders hide behind the globe
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = 1;

  return { lines, anchors };
}
