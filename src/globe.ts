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
import type { Terrain } from './terrain';
import type { Elevation } from './elevation';
import { createExposure, type TempWindow } from './exposure';
import { fieldSpecs, type FieldId, type FieldSpec } from './fields';
import { monthToDayOfYear } from './calendar';
import { solarDeclination, SUNRISE_ZENITH_DEG } from './sun';
import { lonLatToVec3, vec3ToLonLat } from './geo';

/**
 * The globe itself: an unlit, colour-mapped sphere, country outlines, names, and a starfield.
 *
 * Three things here are continuous rather than discrete, and all three matter to how it feels: the
 * month, the colour window, and the palette. Each is an eased parameter rather than a switch, so
 * scrubbing, zooming and changing palette all read as movement rather than as jump cuts.
 */

/**
 * The flat ground the ocean falls back to when its colouring is switched off.
 *
 * Declared here in linear 0–1 so the shader and the hover swatch cannot drift: the GLSL literal is
 * interpolated from this array, and `OCEAN_MUTED_CSS` is the same numbers for the DOM. Chosen a
 * little above the page background rather than equal to it — matching `--color-ink` exactly would
 * dissolve the sphere's dark limb into space and lose the globe's form.
 */
export const OCEAN_MUTED: [number, number, number] = [0.059, 0.086, 0.118];

/**
 * How far the tallest ground rises above the sphere, as a fraction of its radius.
 *
 * Real relief is invisible at this scale and always has been on every globe ever made: Everest is
 * 8.8 km against a 6371 km radius, 0.14% — thinner than the varnish on a schoolroom globe. So the
 * question is not whether to exaggerate but by how much, and the honest answer is "until ranges
 * read and nothing else does".
 *
 * 0.035 is about 25x. At that gain the Himalaya, Andes, Rockies, Alps and the Antarctic dome stand
 * clear at the limb, while a 500 m plateau moves by a fifth of a percent of the radius and stays
 * the flat thing it is. Push it much past this and continents start to look like crumpled foil.
 */
const MAX_EXAGGERATION = 0.035;

/**
 * Whether the 3-D relief layer exists at all.
 *
 * Displacement needs vertices to displace, and a sphere carrying enough of them is a cost paid on
 * every frame whether or not the layer is switched on. Behind the flag the globe goes back to the
 * tessellation it had before, and the layer's control is not offered; in front of it the sphere is
 * 28x heavier. Kept as a flag rather than deleted because the feature works -- it is the standing
 * cost of being *able* to use it that wants more thought.
 */
export const RELIEF_3D_ENABLED = false;

/** Segments around and over the sphere. Displacement is the only thing that needs the fine grid. */
const SPHERE_SEGMENTS = RELIEF_3D_ENABLED ? [1024, 512] : [192, 96];

export const OCEAN_MUTED_CSS = `rgb(${OCEAN_MUTED.map((c) => Math.round(c * 255)).join(' ')})`;

const VERTEX = /* glsl */ `
  uniform sampler2D uElev;
  uniform float uExag;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  void main() {
    vUv = uv;
    // The sphere has unit radius, so each vertex position *is* its own outward normal and
    // displacement is a scalar on the vector itself. The v flip matches the fragment shader's:
    // the raster's first row is 90 N while the sphere's v = 0 is the south pole.
    //
    // Note the surface normal is deliberately left alone. Nothing here is lit, so a normal that
    // still points straight out costs nothing visually -- only the rim term reads it, and the rim
    // lives at the silhouette where the displacement is a fraction of a degree of arc. Deriving
    // true normals would mean three texture fetches per vertex to light a surface that has no
    // diffuse term to light.
    float h = texture(uElev, vec2(uv.x, 1.0 - uv.y)).r;
    vec4 worldPos = modelMatrix * vec4(position * (1.0 + h * uExag), 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;

  uniform sampler2DArray uField;
  uniform sampler2D uTerrain;
  uniform float uReliefFlat;
  uniform float uReliefScale;
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
  uniform float uOcean;
  uniform float uDaylight;
  uniform float uDecl;
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

  const float PI = 3.141592653589793;

  // Hours between sunrise and sunset at a latitude, given the sun's declination.
  //
  // The branchless twin of dayLength() in sun.ts, sharing its zenith constant by interpolation so
  // the two cannot drift. The clamp is what removes the polar branches: where the sun's daily
  // circle never meets the horizon there is no hour angle, and 0 and 24 hours are exactly the right
  // answers at the two ends. The denominator is floored so the poles, where cos(phi) vanishes,
  // divide to a large signed number rather than to NaN.
  float dayLength(float lat) {
    float phi = radians(lat);
    float c = (cos(radians(${SUNRISE_ZENITH_DEG})) - sin(phi) * sin(uDecl))
            / max(cos(phi) * cos(uDecl), 1e-6);
    return (24.0 / PI) * acos(clamp(c, -1.0, 1.0));
  }

  // Stretches each side of a diverging ramp independently so its midpoint lands on the field's
  // reference value -- 0 C, or 12 hours -- wherever that falls in the current window. Without this,
  // "white means freezing" would only be true when the window happened to be symmetric about it.
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

    // The second field. It is computed, not sampled: day length falls out of the fragment's own
    // latitude and one uniform, so it needs no texture, no download and none of the dither above --
    // there is nothing quantised about it to hide. vUv.y runs south to north, matching uvToLonLat.
    //
    // Switched rather than cross-faded. Every other parameter here eases because it is genuinely
    // continuous, but a temperature morphing into a duration would pass through values that are
    // neither, under a legend labelling them in one unit or the other.
    t = mix(t, dayLength(vUv.y * 180.0 - 90.0) / 24.0, uDaylight);

    // Window the value. Absolute mode is simply uLo = 0, uHi = 1, so there is no branch and no
    // second code path to keep in sync.
    float w = clamp((t - uLo) / max(uHi - uLo, 1e-4), 0.0, 1.0);
    float wSplit = zeroSplit(w);

    vec3 col = mix(
      texture(uRampA, vec2(mix(w, wSplit, uDivergingA), 0.5)).rgb,
      texture(uRampB, vec2(mix(w, wSplit, uDivergingB), 0.5)).rgb,
      uRampBlend
    );

    // --- terrain ---------------------------------------------------------------------------
    // Coastline and hillshade both come from the terrain raster rather than from the temperature
    // field's own mask, which is five times coarser. What looked wrong at full zoom was never the
    // line's width -- fwidth keeps that constant -- but the contour it traced: the half-way
    // crossing of a 10-arcmin mask is a rounded lobe, not a fjord.
    //
    // The temperature field's own mask above still decides which *measurement* is reported, since
    // that genuinely is a 10-arcmin fact. This decides only what is drawn.
    vec2 terr = texture(uTerrain, uvT).rg;
    float coastMask = terr.g;

    // Signed about the hillshade's flat value, which Natural Earth also uses for the ocean it clips
    // away -- so this is zero over water and zero over level ground, and non-zero only where there
    // is relief to show. No mask is needed to keep it off the sea.
    //
    // Normalised by the measured swing rather than by the headroom above flat. Level ground sits at
    // 206 of 255, so the lit side has a sixth of the room the shaded side has; dividing by the lit
    // side would send deep shadow past -2 and clip the surface under it to black.
    float shade = clamp((terr.r - uReliefFlat) / uReliefScale, -1.0, 1.0);

    // Muting the sea to a flat ground is not merely cosmetic: with the ocean hidden the auto-
    // exposure histogram drops ocean samples too, so the ramp is spent entirely on the land field.
    // Applied before the shading below, so the coastline still draws over the flat water.
    col = mix(mix(vec3(${OCEAN_MUTED.join(', ')}), col, coastMask), col, uOcean);

    // The shading modulates brightness over a colour-mapped field, which the unlit rule otherwise
    // forbids, and here it is a real cost: a slope makes one temperature read as two shades. It
    // earns the exception by being tied to the ground rather than to any value, and by living
    // behind a toggle -- turn relief off and the surface is a pure function of what is measured.
    float coastWidth = fwidth(coastMask) * 1.6 + 1e-5;
    float coast = 1.0 - smoothstep(0.0, coastWidth, abs(coastMask - 0.5));

    // Ocean sits very slightly recessed, so the eye reads land as the raised surface.
    col *= mix(1.0 - 0.06 * uRelief, 1.0, coastMask);

    // The hillshade itself. Kept well under the coastline's contrast: it is there to give the eye
    // a sense of ground, not to compete with the quantity the globe exists to show.
    col *= 1.0 + shade * 0.50 * uRelief;

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
  /** Which quantity the surface draws. */
  field: FieldId;
  /** The active field's descriptor — what the legend and the readout must label. */
  readonly spec: FieldSpec;
  /** Whether the colour scale follows what is on screen, or stays pinned to the full range. */
  relative: boolean;
  /** Active palette id; changes cross-fade. */
  palette: string;
  labels: boolean;
  borders: boolean;
  /** Land/sea relief and the derived coastline. */
  relief: boolean;
  /** Whether the ocean is colour-mapped at all, or muted to a flat ground. */
  ocean: boolean;
  /** Whether the surface is displaced by real elevation. */
  height: boolean;
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
  ocean?: boolean | undefined;
  stars?: boolean | undefined;
  height?: boolean | undefined;
  field?: FieldId | undefined;
}

export function createGlobe(
  container: HTMLElement,
  field: Field,
  terrain: Terrain,
  elevation: Elevation,
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
    uTerrain: { value: terrain.texture },
    uElev: { value: elevation.texture },
    uExag: { value: 0 },
    uReliefFlat: { value: field.meta.terrain.flat / 255 },
    uReliefScale: { value: field.meta.terrain.scale / 255 },
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
    uOcean: { value: options.ocean === false ? 0 : 1 },
    uDaylight: { value: options.field === 'daylight' ? 1 : 0 },
    uDecl: { value: 0 },
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

  // 192x96 is ample for a sphere that stays a sphere. Displacement needs vertices to displace, and
  // at 1024x512 a quad spans about 20 arcmin -- finer than the elevation grid it samples, and
  // enough to bend a mountain range. Faceting is not the constraint it would normally be: with no
  // diffuse term, flat-shaded quads are invisible everywhere except the silhouette.
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, SPHERE_SEGMENTS[0], SPHERE_SEGMENTS[1]),
    material,
  );
  scene.add(sphere);

  const stars = createStars();
  stars.setPixelRatio(pixelRatio);
  scene.add(stars.points);

  let countries: Countries | null = null;
  let labels: Labels | null = null;
  loadCountries(elevation.sampleAt)
    .then((loaded) => {
      countries = loaded;
      loaded.setExaggeration(uniforms.uExag.value);
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
  const hitPoint = new THREE.Vector3();
  const hoverLonLat = { lon: 0, lat: 0 };
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
  const specs = fieldSpecs(field, field.meta.months);
  let spec = specs[options.field === 'daylight' ? 'daylight' : 'temperature'];
  let paletteBlend = 1; // eased 0→1 from paletteFrom to paletteTo
  const shown: TempWindow = { lo: spec.min, hi: spec.max };
  exposure.reset(spec);

  const api: Globe = {
    month: 0,
    field: spec.id,
    get spec() {
      return spec;
    },
    relative: options.relative ?? true,
    palette: paletteTo.id,
    labels: options.labels ?? true,
    borders: options.borders ?? true,
    relief: options.relief ?? true,
    ocean: options.ocean ?? true,
    height: RELIEF_3D_ENABLED ? (options.height ?? false) : false,
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

    // A field change is discrete: swap the descriptor and let the auto-exposure snap rather than
    // ease, so the legend never labels a window that is half degrees and half hours.
    if (api.field !== spec.id) {
      spec = specs[api.field] ?? specs.temperature;
      api.field = spec.id;
      uniforms.uDaylight.value = spec.id === 'daylight' ? 1 : 0;
      exposure.reset(spec);
      shown.lo = spec.min;
      shown.hi = spec.max;
    }

    uniforms.uMonth.value = api.month;
    uniforms.uDecl.value = solarDeclination(monthToDayOfYear(api.month, field.meta.months));
    uniforms.uRelief.value += ((api.relief ? 1 : 0) - uniforms.uRelief.value) * ease;
    uniforms.uOcean.value += ((api.ocean ? 1 : 0) - uniforms.uOcean.value) * ease;
    uniforms.uExag.value += ((api.height ? MAX_EXAGGERATION : 0) - uniforms.uExag.value) * ease;
    // The outlines have to climb with the ground, or a raised Himalaya swallows the borders across
    // it. Only while the displacement is actually moving; `setExaggeration` no-ops once settled.
    countries?.setExaggeration(uniforms.uExag.value);
    stars.points.visible = api.stars;
    stars.update(elapsed);
    if (countries) countries.lines.visible = api.borders;
    controls.update();

    modeBlend += ((api.relative ? 1 : 0) - modeBlend) * ease;

    // Skip the measurement only when relative mode is both off and fully faded out; keeping it
    // running the instant the toggle flips means the window is already converging as it fades in.
    if (modeBlend > 0.001 || api.relative) {
      const measured = exposure.update(camera, api.month, dt, spec, !api.ocean);
      shown.lo = spec.min + (measured.lo - spec.min) * modeBlend;
      shown.hi = spec.max + (measured.hi - spec.max) * modeBlend;
    } else {
      shown.lo = spec.min;
      shown.hi = spec.max;
    }

    const fullSpan = spec.max - spec.min;
    uniforms.uLo.value = (shown.lo - spec.min) / fullSpan;
    uniforms.uHi.value = (shown.hi - spec.min) / fullSpan;
    uniforms.uZero.value = zeroPosition(shown.lo, shown.hi, spec.pivot);

    labels?.update(camera, viewW, viewH, api.labels);

    if (pointerActive) {
      // Intersected analytically rather than against the mesh. `intersectObject` tests every
      // triangle -- there is no BVH on a plain Mesh -- so it cost a few thousand tests a frame at
      // the old tessellation and over a million at the new one, for a shape whose intersection is
      // a quadratic. Same maths as the auto-exposure sampler, and exact rather than tessellated.
      raycaster.setFromCamera(pointer, camera);
      const o = raycaster.ray.origin;
      const d = raycaster.ray.direction;
      const b = o.dot(d);
      const disc = b * b - (o.dot(o) - 1);
      const t = disc > 0 ? -b - Math.sqrt(disc) : -1; // near root: the hemisphere facing us
      if (t > 0) {
        hover = vec3ToLonLat(hitPoint.copy(d).multiplyScalar(t).add(o), hoverLonLat);
      } else {
        hover = null;
      }
    }

    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(tick);

  return api;
}
