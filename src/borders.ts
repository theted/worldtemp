import * as THREE from 'three';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { FeatureCollection, Polygon, MultiPolygon, Position } from 'geojson';
import { lonLatToVec3 } from './geo';

/**
 * Coastlines and country borders, drawn as lines just above the sphere.
 *
 * A pure heat map is beautiful and completely disorienting — without outlines it's genuinely hard
 * to tell the Sahara from central Australia. Natural Earth's 110 m countries file is 105 KB, which
 * buys back all of that orientation for almost nothing.
 *
 * It also earns its keep as a test: because these lines are built from the projection convention in
 * `geo.ts` while the field is sampled by the shader's own UVs, any error in that convention shows up
 * instantly as borders floating off the coast.
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

export async function loadBorders(base = import.meta.env.BASE_URL): Promise<THREE.LineSegments> {
  const res = await fetch(`${base}geo/countries-110m.json`);
  if (!res.ok) throw new Error(`${res.status} loading country borders`);
  const topo = (await res.json()) as Topology<{ countries: GeometryCollection }>;
  const fc = feature(topo, topo.objects.countries) as FeatureCollection<Polygon | MultiPolygon>;

  const positions: number[] = [];
  for (const f of fc.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) addRing(ring, positions);
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
  return lines;
}
