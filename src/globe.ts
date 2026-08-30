import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Field } from './field';
import { makeRampTexture, DIVERGING_STOPS, SEQUENTIAL_STOPS } from './ramp';
import { loadBorders } from './borders';
import { createStars } from './stars';
import { createExposure, type TempWindow } from './exposure';
import { uvToLonLat } from './geo';

/**
 * The globe itself: an unlit, colour-mapped sphere, a border overlay, and a starfield behind it.
 *
 * Two things are continuous rather than discrete here, and both matter to how it feels:
 *
 *   - **The month.** The shader reads the two bracketing monthly layers and mixes them, which is
 *     what lets the slider glide through the year instead of stepping twelve times.
 *   - **The scale mode.** Absolute and relative are the ends of a single eased parameter that drives
 *     the colour window *and* the ramp cross-fade together, so switching reads as one smooth move
 *     rather than a jump cut.
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
  uniform sampler2D uRampAbs;
  uniform sampler2D uRampRel;
  uniform float uRampBlend;
  uniform float uMonth;
  uniform float uMonths;
  uniform float uLo;
  uniform float uHi;
  uniform float uDither;
  uniform float uRim;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  // Under GLSL3 three keeps its varying defines but deliberately skips the usual
  // "#define gl_FragColor pc_fragColor" (WebGLProgram.js), so the output is declared here.
  layout(location = 0) out vec4 fragColor;

  // Interleaved gradient noise (Jimenez). Cheaper than a hash and, more to the point, far better
  // distributed over neighbouring pixels than white noise, so the same dither amplitude reads as
  // fine grain rather than as speckle.
  float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

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

    // Dither. Temperature is stored as one 8-bit channel, which is invisible across the full
    // -50..50 range but becomes visible terracing once a narrow window is stretched over the whole
    // ramp: the field is smooth and slowly varying, so wide runs of neighbouring texels share a
    // byte and bilinear filtering has nothing to interpolate between.
    //
    // The amplitude is a full quantisation step, not half of one. Half a step only roughens the
    // boundary between two plateaus; a full step makes adjacent plateaus' noise overlap, which is
    // what actually lets the eye integrate them back into a continuous gradient.
    t += (ign(gl_FragCoord.xy) - 0.5) * uDither;

    // Window the value. Absolute mode is simply uLo = 0, uHi = 1, so there is no branch and no
    // second code path to keep in sync.
    float w = clamp((t - uLo) / max(uHi - uLo, 1e-4), 0.0, 1.0);

    vec3 col = mix(
      texture(uRampAbs, vec2(w, 0.5)).rgb,
      texture(uRampRel, vec2(w, 0.5)).rgb,
      uRampBlend
    );

    // Deliberately no diffuse term. Shading a colour-mapped surface would make one temperature
    // read as two different colours depending on which way it faces, quietly breaking the promise
    // the legend makes. Form comes from the silhouette, the borders, and this rim alone - and the
    // rim is confined to the very edge, where the surface is too foreshortened to read a value off.
    float rim = 1.0 - max(dot(normalize(vNormalW), normalize(vViewDir)), 0.0);
    col += vec3(0.20, 0.40, 0.72) * pow(rim, 3.5) * uRim;

    fragColor = vec4(col, 1.0);
  }
`;

/** Seconds for a mode switch to cross-fade. */
const MODE_TAU = 0.3;

export interface Globe {
  /** Continuous position in the year, 0 = mid-January, wrapping at 12. */
  month: number;
  /** Whether the colour scale follows what is on screen (true) or stays pinned to −50…+50 °C. */
  relative: boolean;
  /** The colour window currently in force, in °C — what the legend must label. */
  readonly window: TempWindow;
  /** Eased 0→1 between absolute and relative, so the legend can cross-fade in step. */
  readonly rampBlend: number;
  /** Latest cursor position on the globe, or null when the pointer is off it. */
  readonly hover: { lon: number; lat: number } | null;
  dispose(): void;
}

export function createGlobe(container: HTMLElement, field: Field): Globe {
  const { tMin, tMax } = field.meta;
  const scene = new THREE.Scene();

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  const pixelRatio = Math.min(devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);
  // Output conversion off: the ramps hold authored sRGB bytes and reach the framebuffer untouched,
  // so the globe and the CSS legend are the same colours rather than merely similar ones. Nothing
  // is lost by skipping linear-space maths here, because nothing is lit.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x07090d, 1);
  renderer.domElement.className = 'block h-full w-full touch-none';
  container.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
  camera.position.set(2.6, 1.0, 0.9); // opens on West Africa, so land and ocean are both in frame

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.42;
  controls.enablePan = false;
  controls.minDistance = 1.25;
  controls.maxDistance = 6;
  controls.zoomSpeed = 0.7;

  const rampAbs = makeRampTexture(DIVERGING_STOPS);
  const rampRel = makeRampTexture(SEQUENTIAL_STOPS);

  const uniforms = {
    uField: { value: field.texture },
    uRampAbs: { value: rampAbs },
    uRampRel: { value: rampRel },
    uRampBlend: { value: 1 },
    uMonth: { value: 0 },
    uMonths: { value: field.meta.months },
    uLo: { value: 0 },
    uHi: { value: 1 },
    uDither: { value: 2 / 255 }, // full quantisation step, peak-to-peak
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

  const stars = createStars();
  stars.setPixelRatio(pixelRatio);
  scene.add(stars.points);

  let borders: THREE.LineSegments | null = null;
  loadBorders()
    .then((lines) => {
      borders = lines;
      scene.add(lines);
    })
    .catch((err) => console.error('borders failed to load', err));

  const exposure = createExposure(field);

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
  let last = performance.now();
  let elapsed = 0;
  let blend = 1; // eased mode parameter: 0 = absolute, 1 = relative
  const shown: TempWindow = { lo: tMin, hi: tMax };

  const api: Globe = {
    month: 0,
    relative: true,
    get window() {
      return shown;
    },
    get rampBlend() {
      return blend;
    },
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
      rampAbs.dispose();
      rampRel.dispose();
      stars.dispose();
      borders?.geometry.dispose();
      (borders?.material as THREE.Material | undefined)?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    // Clamped because requestAnimationFrame is suspended while the tab is backgrounded, and the
    // first frame back would otherwise arrive with a dt of many seconds.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    elapsed += dt;

    uniforms.uMonth.value = api.month;
    stars.update(elapsed);
    controls.update();

    const wantRelative = api.relative ? 1 : 0;
    blend += (wantRelative - blend) * (1 - Math.exp(-dt / MODE_TAU));

    // Skip the measurement only when relative mode is both off and fully faded out; keeping it
    // running the instant the toggle flips means the window is already converging as it fades in.
    if (blend > 0.001 || api.relative) {
      const measured = exposure.update(camera, api.month, dt);
      shown.lo = tMin + (measured.lo - tMin) * blend;
      shown.hi = tMax + (measured.hi - tMax) * blend;
    } else {
      shown.lo = tMin;
      shown.hi = tMax;
    }

    uniforms.uLo.value = (shown.lo - tMin) / (tMax - tMin);
    uniforms.uHi.value = (shown.hi - tMin) / (tMax - tMin);
    uniforms.uRampBlend.value = blend;

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
