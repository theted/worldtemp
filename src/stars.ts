import * as THREE from 'three';

/**
 * A sparse starfield behind the globe. One draw call, ~1800 points.
 *
 * This sits behind a data visualisation, so it is deliberately restrained: most stars are dim, the
 * twinkle amplitude is low, and there is no motion fast enough to catch the eye while you are
 * reading the surface. It exists to stop the background reading as flat black and to give the limb
 * something to sit against.
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
    float alpha = smoothstep(0.5, 0.08, d);
    if (alpha <= 0.001) discard;

    float twinkle = 0.86 + 0.14 * sin(uTime * 0.6 + vPhase);
    fragColor = vec4(vColor * twinkle, alpha);
  }
`;

export interface Stars {
  points: THREE.Points;
  /** Advances the twinkle. */
  update(elapsed: number): void;
  setPixelRatio(ratio: number): void;
  dispose(): void;
}

export function createStars(count = 1800, radius = 60): Stars {
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

    // Skew brightness hard toward the dim end, so a handful of stars stand out and the rest recede.
    const brightness = 0.22 + 0.78 * Math.pow(Math.random(), 2.2);
    const tint = Math.random();
    for (let c = 0; c < 3; c++) {
      color[i * 3 + c] = (COOL[c]! + (WARM[c]! - COOL[c]!) * tint) * brightness;
    }

    size[i] = Math.random() < 0.06 ? 2.0 + Math.random() : 1.0 + Math.random() * 0.8;
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
    // Painted first with no depth interaction at all; the opaque globe simply covers them. This
    // sidesteps any depth-precision question at radius 60 and keeps the ordering trivial.
    depthTest: false,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.renderOrder = -1;
  points.frustumCulled = false; // the field surrounds the camera; its bounding sphere is useless here

  return {
    points,
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
