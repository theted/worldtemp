import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Field } from './field';
import { makeRampTexture } from './ramp';
import { loadBorders } from './borders';
import { uvToLonLat } from './geo';

/**
 * The globe itself: an unlit, colour-mapped sphere plus a border overlay.
 *
 * The month is a continuous float, not an index. The shader reads the two bracketing monthly layers
 * and mixes them, which is what lets the slider glide through the year instead of stepping twelve
 * times — and it costs exactly one extra texture fetch.
 */

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;

  uniform sampler2DArray uField;
  uniform sampler2D uRamp;
  uniform float uMonth;
  uniform float uMonths;
  uniform float uRim;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  // Under GLSL3 three keeps its varying defines but deliberately skips the usual
  // "#define gl_FragColor pc_fragColor" (WebGLProgram.js), so the output is declared here.
  layout(location = 0) out vec4 fragColor;

  void main() {
    // The data's first row is 90 N, while the sphere's v = 0 is the south pole, so v is flipped
    // here rather than by reordering the array - the CPU sampler in field.ts stays north-first.
    vec2 uvT = vec2(vUv.x, 1.0 - vUv.y);

    // Continuous month: mix the two bracketing layers, wrapping December into January.
    float m = mod(uMonth, uMonths);
    float i0 = floor(m);
    float i1 = mod(i0 + 1.0, uMonths);
    float f = fract(m);

    float a = texture(uField, vec3(uvT, i0)).r;
    float b = texture(uField, vec3(uvT, i1)).r;
    float t = mix(a, b, f);

    vec3 col = texture(uRamp, vec2(t, 0.5)).rgb;

    // Deliberately no diffuse term. Shading a colour-mapped surface would make one temperature
    // read as two different colours depending on which way it faces, quietly breaking the promise
    // the legend makes. Form comes from the silhouette, the borders, and this rim alone - and the
    // rim is confined to the very edge, where the surface is too foreshortened to read a value off.
    float rim = 1.0 - max(dot(normalize(vNormalW), normalize(vViewDir)), 0.0);
    col += vec3(0.20, 0.40, 0.72) * pow(rim, 3.5) * uRim;

    fragColor = vec4(col, 1.0);
  }
`;

export interface Globe {
  /** Continuous position in the year, 0 = mid-January, wrapping at 12. */
  month: number;
  /** Latest cursor position on the globe, or null when the pointer is off it. */
  readonly hover: { lon: number; lat: number } | null;
  dispose(): void;
}

export function createGlobe(container: HTMLElement, field: Field): Globe {
  const scene = new THREE.Scene();

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  // Output conversion off: the ramp holds authored sRGB bytes and reaches the framebuffer
  // untouched, so the globe and the CSS legend are the same colours rather than merely similar
  // ones. Nothing is lost by skipping linear-space maths here, because nothing is lit.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x07090d, 1);
  renderer.domElement.className = 'block h-full w-full touch-none';
  container.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
  camera.position.set(2.6, 1.0, 0.9); // opens on West Africa, so land and ocean are both in frame

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.42;
  controls.enablePan = false;
  controls.minDistance = 1.25;
  controls.maxDistance = 6;
  controls.zoomSpeed = 0.7;

  const ramp = makeRampTexture();
  const uniforms = {
    uField: { value: field.texture },
    uRamp: { value: ramp },
    uMonth: { value: 0 },
    uMonths: { value: field.meta.months },
    uRim: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    // sampler2DArray and texture() need GLSL ES 3.0, which also means declaring the fragment
    // output explicitly -- see the note in FRAGMENT above.
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });

  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 96), material);
  scene.add(sphere);

  let borders: THREE.LineSegments | null = null;
  loadBorders()
    .then((lines) => {
      borders = lines;
      scene.add(lines);
    })
    .catch((err) => console.error('borders failed to load', err));

  // ---------------------------------------------------------------------------------------------
  // hover
  // ---------------------------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hover: { lon: number; lat: number } | null = null;
  let pointerActive = false;

  const onPointerMove = (e: PointerEvent) => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    pointerActive = true;
  };
  const onPointerLeave = () => {
    pointerActive = false;
    hover = null;
  };
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);

  // ---------------------------------------------------------------------------------------------
  // resize + loop
  // ---------------------------------------------------------------------------------------------
  /**
   * Pulls the camera back until the globe fits whichever axis is tighter.
   *
   * A fixed distance can't work: at 38° vertical the sphere overflows a short window entirely. This
   * solves for the distance at which a unit sphere subtends the narrower field of view, times a
   * margin that leaves the poles clear of the console below.
   */
  let framed = false;
  const frameGlobe = () => {
    const fovV = THREE.MathUtils.degToRad(camera.fov);
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
    camera.position.setLength(1 / Math.sin(Math.min(fovV, fovH) / 2) / 0.78);
  };

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Only on first layout — after that the distance belongs to the user's zoom.
    if (!framed) {
      frameGlobe();
      framed = true;
    }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  let raf = 0;

  const api: Globe = {
    month: 0,
    get hover() {
      return hover;
    },
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      controls.dispose();
      sphere.geometry.dispose();
      material.dispose();
      ramp.dispose();
      borders?.geometry.dispose();
      (borders?.material as THREE.Material | undefined)?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };

  const tick = () => {
    raf = requestAnimationFrame(tick);
    uniforms.uMonth.value = api.month;
    controls.update();

    if (pointerActive) {
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(sphere, false)[0];
      // uv comes straight from the parameterisation the shader samples, so the readout and the
      // picture can never disagree about which pixel is under the cursor.
      hover = hit?.uv ? uvToLonLat(hit.uv.x, hit.uv.y) : null;
    }

    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(tick);

  return api;
}
