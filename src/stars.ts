import * as THREE from 'three';

/**
 * A sparse starfield behind the globe. One draw call, as many points as the amount control asks for.
 *
 * This sits behind a data visualisation, so the twinkle amplitude stays low and there is no motion
 * fast enough to catch the eye while you are reading the surface. Brightness is skewed toward the
 * dim end rather than flattened, so a handful of stars stand out and the rest recede — a uniformly
 * bright field reads as noise, not as sky.
 */

const VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aPhase;

  varying vec3 vColor;
  varying float vPhase;

  uniform float uPixelRatio;

  void main() {
    vColor = aColor;
    vPhase = aPhase;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // No size attenuation: these are meant to read as fixed pinpoints, not objects with distance.
    gl_PointSize = aSize * uPixelRatio;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;

  varying vec3 vColor;
  varying float vPhase;

  uniform float uTime;

  layout(location = 0) out vec4 fragColor;

  void main() {
    // Round the square point sprite off, with a soft edge so stars don't alias into pixels.
    float d = length(gl_PointCoord - 0.5);
    float alpha = smoothstep(0.5, 0.06, d);
    if (alpha <= 0.001) discard;

    float twinkle = 0.86 + 0.14 * sin(uTime * 0.6 + vPhase);
    fragColor = vec4(vColor * twinkle, alpha);
  }
`;

/**
 * The pool the amount control draws from. Stars are generated in random order, so any prefix of the
 * buffer is itself a uniform scatter: showing fewer is only a shorter draw range, with no rebuild and
 * no reshuffle, and the stars that stay are the same stars.
 *
 * The control is squared on its way to a count, because density is judged by area and the eye tells
 * a few hundred stars apart far better than it does ten thousand. Half-way lands on 2600, the field
 * this has always drawn.
 */
export const STAR_POOL = 10400;
export const STARS_DEFAULT_AMOUNT = 0.5;

/** Stars shown for an amount from 0 (none) to 1 (the whole pool). */
export const starCount = (amount: number) =>
  Math.round(STAR_POOL * Math.min(Math.max(amount, 0), 1) ** 2);

export interface Stars {
  points: THREE.Points;
  /** How many of the pool to draw, 0–1; see `starCount`. */
  setAmount(amount: number): void;
  /** Advances the twinkle. */
  update(elapsed: number): void;
  setPixelRatio(ratio: number): void;
  dispose(): void;
}

export function createStars(count = STAR_POOL, radius = 60): Stars {
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);

  // Two reference tints, cool and warm, so the field isn't a flat grey wash.
  const COOL: [number, number, number] = [0.62, 0.72, 1.0];
  const WARM: [number, number, number] = [1.0, 0.86, 0.7];

  for (let i = 0; i < count; i++) {
    // Uniform on the sphere. Picking latitude uniformly instead would pile stars up at the poles —
    // the area of a latitude band goes as cos(lat), so it is the *height* that must be uniform.
    const z = 1 - 2 * Math.random();
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const theta = 2 * Math.PI * Math.random();
    position[i * 3] = radius * r * Math.cos(theta);
    position[i * 3 + 1] = radius * z;
    position[i * 3 + 2] = radius * r * Math.sin(theta);

    // Skewed toward the dim end, but with a floor high enough that the faintest stars still read
    // against the page rather than vanishing into it.
    const brightness = 0.42 + 0.58 * Math.pow(Math.random(), 1.7);
    const tint = Math.random();
    for (let c = 0; c < 3; c++) {
      color[i * 3 + c] = (COOL[c]! + (WARM[c]! - COOL[c]!) * tint) * brightness;
    }

    size[i] = Math.random() < 0.1 ? 2.4 + Math.random() * 1.2 : 1.3 + Math.random() * 0.9;
    phase[i] = Math.random() * Math.PI * 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

  const uniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    // Depth-tested against the globe. They used not to be, on the idea that renderOrder paints them
    // first -- but renderOrder only sorts *within* three's opaque and blended lists, and the opaque
    // list always draws first. So every star in front of the globe's disc was added onto its
    // surface: lost over bright land, and over a dark sea exactly the specks that made the planet
    // look see-through. renderOrder still puts them first among blended things, which is what lets
    // the glass sea show them through itself.
    depthTest: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.renderOrder = -1;
  points.frustumCulled = false; // the field surrounds the camera; its bounding sphere is useless here

  return {
    points,
    setAmount: (amount) => {
      const n = starCount(amount);
      geometry.setDrawRange(0, n);
      points.visible = n > 0;
    },
    update: (elapsed) => {
      uniforms.uTime.value = elapsed;
    },
    setPixelRatio: (ratio) => {
      uniforms.uPixelRatio.value = ratio;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
