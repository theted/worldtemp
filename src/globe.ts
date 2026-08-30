import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Field } from './field';
import {
  makeRampTexture,
  paletteById,
  zeroPosition,
  DEFAULT_PALETTE_ID,
  type Palette,
} from './ramp';
import { loadCountries, type Countries } from './countries';
import { createLabels, type Labels } from './labels';
import { createStars } from './stars';
import { createExposure, type TempWindow } from './exposure';
import { lonLatToVec3, uvToLonLat } from './geo';

/**
 * The globe itself: an unlit, colour-mapped sphere, country outlines, names, and a starfield.
 *
 * Three things here are continuous rather than discrete, and all three matter to how it feels: the
 * month, the colour window, and the palette. Each is an eased parameter rather than a switch, so
 * scrubbing, zooming and changing palette all read as movement rather than as jump cuts.
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
  uniform sampler2D uRampA;
  uniform sampler2D uRampB;
  uniform float uRampBlend;
  uniform float uDivergingA;
  uniform float uDivergingB;
  uniform float uZero;
  uniform float uMonth;
  uniform float uMonths;
  uniform float uLo;
  uniform float uHi;
  uniform float uDither;
  uniform float uRelief;
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

  // Stretches each side of a diverging ramp independently so its midpoint lands on 0 C wherever
  // that falls in the current window. Without this, "white means freezing" would only be true when
  // the window happened to be symmetric about zero.
  float zeroSplit(float w) {
    return w < uZero
      ? (w / max(uZero, 1e-4)) * 0.5
      : 0.5 + ((w - uZero) / max(1.0 - uZero, 1e-4)) * 0.5;
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

    vec2 sa = texture(uField, vec3(uvT, i0)).rg;
    vec2 sb = texture(uField, vec3(uvT, i1)).rg;
    float t = mix(sa.r, sb.r, f);
    float land = mix(sa.g, sb.g, f);

    // Dither. Temperature is stored as one 8-bit channel, which is invisible across the full range
    // but becomes visible terracing once a narrow window is stretched over the whole ramp: the
    // field is smooth and slowly varying, so wide runs of neighbouring texels share a byte and
    // bilinear filtering has nothing to interpolate between.
    //
    // The amplitude is a full quantisation step, not half of one. Half a step only roughens the
    // boundary between two plateaus; a full step makes adjacent plateaus' noise overlap, which is
    // what actually lets the eye integrate them back into a continuous gradient.
    t += (ign(gl_FragCoord.xy) - 0.5) * uDither;

    // Window the value. Absolute mode is simply uLo = 0, uHi = 1, so there is no branch and no
    // second code path to keep in sync.
    float w = clamp((t - uLo) / max(uHi - uLo, 1e-4), 0.0, 1.0);
    float wSplit = zeroSplit(w);

    vec3 col = mix(
      texture(uRampA, vec2(mix(w, wSplit, uDivergingA), 0.5)).rgb,
      texture(uRampB, vec2(mix(w, wSplit, uDivergingB), 0.5)).rgb,
      uRampBlend
    );

    // --- land/sea relief -------------------------------------------------------------------
    // The land mask is bilinear-filtered like everything else, so it crosses 0.5 exactly at the
    // coastline and its screen-space gradient gives a constant-width shoreline at any zoom.
    //
    // This does modulate brightness over a colour-mapped field, which the unlit rule otherwise
    // forbids. It earns the exception on two counts: the modulation is tied to a fixed boundary
    // rather than to any value, and land and sea genuinely *are* different measurements here -- 2 m
    // air temperature against sea surface temperature -- so drawing the seam is honest rather than
    // decorative. It is also toggleable.
    float coastWidth = fwidth(land) * 1.6 + 1e-5;
    float coast = 1.0 - smoothstep(0.0, coastWidth, abs(land - 0.5));

    // Ocean sits very slightly recessed, so the eye reads land as the raised surface.
    col *= mix(1.0 - 0.06 * uRelief, 1.0, land);

    // A contrast-inverting shoreline: darkens where the ground is bright, lightens where it is
    // dark. A single fixed colour would disappear at one end of every ramp.
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    vec3 edge = mix(col + vec3(0.20), col * 0.62, step(0.5, luma));
    col = mix(col, edge, coast * 0.85 * uRelief);

    // Deliberately no diffuse term. Shading a colour-mapped surface would make one temperature
    // read as two different colours depending on which way it faces, quietly breaking the promise
    // the legend makes. Form comes from the silhouette, the borders, and this rim alone - and the
    // rim is confined to the very edge, where the surface is too foreshortened to read a value off.
    float rim = 1.0 - max(dot(normalize(vNormalW), normalize(vViewDir)), 0.0);
    col += vec3(0.20, 0.40, 0.72) * pow(rim, 3.5) * uRim;

    fragColor = vec4(col, 1.0);
  }
`;

/** Seconds for a mode or palette change to cross-fade. */
const MODE_TAU = 0.3;

/** Where the globe is facing on a first visit: central Europe, tilted to keep the Med in frame. */
const OPENING_LON = 15;
const OPENING_LAT = 45;

/**
 * How much of the narrower field of view the globe fills on load.
 *
 * Below 1 the sphere sits inside the frame with margin; nudging it up pulls the camera in, which is
 * what makes the opening view read as "looking at Europe" rather than "looking at a planet".
 */
const OPENING_FILL = 0.92;

export interface Globe {
  /** Continuous position in the year, 0 = mid-January, wrapping at 12. */
  month: number;
  /** Whether the colour scale follows what is on screen, or stays pinned to the full range. */
  relative: boolean;
  /** Active palette id; changes cross-fade. */
  palette: string;
  labels: boolean;
  borders: boolean;
  /** Land/sea relief and the derived coastline. */
  relief: boolean;
  stars: boolean;
  /** The colour window currently in force, in °C — what the legend must label. */
  readonly window: TempWindow;
  /** Eased 0→1 across a palette change, so the legend can cross-fade in step. */
  readonly rampBlend: number;
  /** The two palettes currently being cross-faded between. */
  readonly palettePair: { from: Palette; to: Palette };
  /** Latest cursor position on the globe, or null when the pointer is off it. */
  readonly hover: { lon: number; lat: number } | null;
  /** Camera position, for persistence. */
  readonly cameraPosition: THREE.Vector3;
  dispose(): void;
}

export interface GlobeOptions {
  /** Restored camera position; when given, the opening framing is skipped. */
  camera?: [number, number, number] | undefined;
  relative?: boolean | undefined;
  palette?: string | undefined;
  labels?: boolean | undefined;
  borders?: boolean | undefined;
  relief?: boolean | undefined;
  stars?: boolean | undefined;
}

export function createGlobe(
  container: HTMLElement,
  field: Field,
  options: GlobeOptions = {},
): Globe {
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
  let framed = false;
  if (options.camera) {
    camera.position.fromArray(options.camera);
    framed = true; // a restored view is the user's, not ours to re-fit
  } else {
    // Only the direction matters here; frameGlobe sets the distance once the viewport is known.
    lonLatToVec3(OPENING_LON, OPENING_LAT, 1, camera.position);
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.42;
  controls.enablePan = false;
  controls.minDistance = 1.25;
  controls.maxDistance = 6;
  controls.zoomSpeed = 0.7;

  // Palette textures are built once and kept; switching is a cross-fade between two of them.
  const rampTextures = new Map<string, THREE.DataTexture>();
  const rampFor = (p: Palette) => {
    let tex = rampTextures.get(p.id);
    if (!tex) {
      tex = makeRampTexture(p.stops);
      rampTextures.set(p.id, tex);
    }
    return tex;
  };

  let paletteFrom = paletteById(options.palette ?? DEFAULT_PALETTE_ID);
  let paletteTo = paletteFrom;

  const uniforms = {
    uField: { value: field.texture },
    uRampA: { value: rampFor(paletteFrom) },
    uRampB: { value: rampFor(paletteTo) },
    uRampBlend: { value: 1 },
    uDivergingA: { value: paletteFrom.kind === 'diverging' ? 1 : 0 },
    uDivergingB: { value: paletteTo.kind === 'diverging' ? 1 : 0 },
    uZero: { value: zeroPosition(tMin, tMax) },
    uMonth: { value: 0 },
    uMonths: { value: field.meta.months },
    uLo: { value: 0 },
    uHi: { value: 1 },
    uDither: { value: 2 / 255 }, // full quantisation step, peak-to-peak
    uRelief: { value: options.relief === false ? 0 : 1 },
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

  let countries: Countries | null = null;
  let labels: Labels | null = null;
  loadCountries()
    .then((loaded) => {
      countries = loaded;
      loaded.setResolution(viewW * pixelRatio, viewH * pixelRatio);
      scene.add(loaded.lines);
      labels = createLabels(container, loaded.anchors);
    })
    .catch((err) => console.error('country layer failed to load', err));

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
  let viewW = 1;
  let viewH = 1;

  /**
   * Pulls the camera back until the globe fits whichever axis is tighter.
   *
   * A fixed distance can't work: at 38° vertical the sphere overflows a short window entirely. This
   * solves for the distance at which a unit sphere subtends the narrower field of view, times a
   * margin that leaves the poles clear of the console below.
   */
  const frameGlobe = () => {
    const fovV = THREE.MathUtils.degToRad(camera.fov);
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
    camera.position.setLength(1 / Math.sin(Math.min(fovV, fovH) / 2) / OPENING_FILL);
  };

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    if (w === 0 || h === 0) return;
    // Cached so the label layer can project into screen space without reading layout each frame.
    viewW = w;
    viewH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Screen-space line width needs drawing-buffer pixels, not CSS pixels.
    countries?.setResolution(w * pixelRatio, h * pixelRatio);
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
  let modeBlend = options.relative === false ? 0 : 1; // eased: 0 = absolute, 1 = relative
  let paletteBlend = 1; // eased 0→1 from paletteFrom to paletteTo
  const shown: TempWindow = { lo: tMin, hi: tMax };

  const api: Globe = {
    month: 0,
    relative: options.relative ?? true,
    palette: paletteTo.id,
    labels: options.labels ?? true,
    borders: options.borders ?? true,
    relief: options.relief ?? true,
    stars: options.stars ?? true,
    get window() {
      return shown;
    },
    get rampBlend() {
      return paletteBlend;
    },
    get palettePair() {
      return { from: paletteFrom, to: paletteTo };
    },
    get hover() {
      return hover;
    },
    get cameraPosition() {
      return camera.position;
    },
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      controls.dispose();
      sphere.geometry.dispose();
      material.dispose();
      for (const tex of rampTextures.values()) tex.dispose();
      stars.dispose();
      labels?.dispose();
      countries?.dispose();
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
    const ease = 1 - Math.exp(-dt / MODE_TAU);

    // Palette changes start a fresh cross-fade from whatever is currently on screen.
    if (api.palette !== paletteTo.id) {
      paletteFrom = paletteBlend >= 1 ? paletteTo : paletteFrom;
      paletteTo = paletteById(api.palette);
      uniforms.uRampA.value = rampFor(paletteFrom);
      uniforms.uRampB.value = rampFor(paletteTo);
      uniforms.uDivergingA.value = paletteFrom.kind === 'diverging' ? 1 : 0;
      uniforms.uDivergingB.value = paletteTo.kind === 'diverging' ? 1 : 0;
      paletteBlend = 0;
    }
    paletteBlend = Math.min(1, paletteBlend + ease * (1 - paletteBlend) + dt * 0.35);
    uniforms.uRampBlend.value = paletteBlend;

    uniforms.uMonth.value = api.month;
    uniforms.uRelief.value += ((api.relief ? 1 : 0) - uniforms.uRelief.value) * ease;
    stars.points.visible = api.stars;
    stars.update(elapsed);
    if (countries) countries.lines.visible = api.borders;
    controls.update();

    modeBlend += ((api.relative ? 1 : 0) - modeBlend) * ease;

    // Skip the measurement only when relative mode is both off and fully faded out; keeping it
    // running the instant the toggle flips means the window is already converging as it fades in.
    if (modeBlend > 0.001 || api.relative) {
      const measured = exposure.update(camera, api.month, dt);
      shown.lo = tMin + (measured.lo - tMin) * modeBlend;
      shown.hi = tMax + (measured.hi - tMax) * modeBlend;
    } else {
      shown.lo = tMin;
      shown.hi = tMax;
    }

    uniforms.uLo.value = (shown.lo - tMin) / (tMax - tMin);
    uniforms.uHi.value = (shown.hi - tMin) / (tMax - tMin);
    uniforms.uZero.value = zeroPosition(shown.lo, shown.hi);

    labels?.update(camera, viewW, viewH, api.labels);

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
