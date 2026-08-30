# worldtemp

An interactive 3D globe of average monthly temperature. Scrub through the year and watch the
seasons move across the planet.

Everything is served from disk. Once the page has loaded there are no network requests at all.

```bash
npm install
npm run data     # one-off: downloads sources and bakes 12 PNGs (~46 MB down, a minute or so)
npm run dev
```

`npm run data` only needs running once — its output is committed, so a fresh clone can go straight
to `npm run dev`. Re-run it only to change resolution or the encoded range.

## Controls

| | |
|---|---|
| drag | rotate |
| scroll | zoom |
| hover | read the temperature under the cursor |
| slider / `←` `→` | scrub the year (hold `shift` for whole months) |
| `space` | play / pause |
| `r` | toggle the colour scale between relative and absolute |

## Data

| Layer | Source | Grid | Period | Quantity |
|---|---|---|---|---|
| Land | [WorldClim 2.1](https://www.worldclim.org/data/worldclim21.html) `tavg` 10′ | 2160 × 1080 | 1970–2000 | 2 m air temperature |
| Ocean | [NOAA OISST v2](https://psl.noaa.gov/data/gridded/data.noaa.oisst.v2.html) long-term mean | 360 × 180 | 1991–2020 | sea surface temperature |
| Borders | Natural Earth 110 m via [world-atlas](https://github.com/topojson/world-atlas) | — | — | public domain |

> Fick, S.E. and R.J. Hijmans, 2017. *WorldClim 2: new 1km spatial resolution climate surfaces for
> global land areas.* International Journal of Climatology 37 (12): 4302–4315.
>
> OISST data provided by NOAA PSL, Boulder, Colorado, USA, from https://psl.noaa.gov

**The globe blends two different measurements.** Weather-station climatology only exists over land;
the oceans are sea surface temperature from a different instrument and a different 30-year window.
This is what makes the whole sphere legible instead of half-grey, but it means a coastline is a
genuine discontinuity in *what is being measured*, not just in value. The hover readout always says
which of the two you are looking at.

The two masks turn out to tile the globe exactly — 34.64% land, 65.36% ocean, nothing left over.

## How it works

**Geography is free.** `THREE.SphereGeometry` parameterises its surface as
`x = −r·cos(φ)·sin(θ)`, `y = r·cos(θ)`, `z = r·sin(φ)·sin(θ)` — which *is* the equirectangular
projection. Substituting `u = (lon+180)/360` and `v = (90−lat)/180` makes a plain lon/lat raster
line up with the sphere's own UVs. There is no reprojection, no polygon rasterising, no
GeoJSON-to-region joining anywhere in this project. The convention is written down once in
[`src/geo.ts`](src/geo.ts) and shared by the shader, the borders, and the hover readout.

**Months are continuous.** `scripts/build-data.ts` bakes one PNG per month into a 12-layer
`DataArrayTexture`; the shader samples the two bracketing layers and mixes them, wrapping December
into January. That single `mix` is what makes the slider glide rather than step.

**Temperature is one 8-bit channel, on purpose.** The GPU bilinear-filters this texture. A 16-bit
value split across two channels filters *incorrectly* — interpolating a high byte across a step
boundary produces garbage. One 8-bit channel filters correctly, at the cost of 0.39 °C of
quantisation, which is invisible in a heat map. The green channel carries the land mask.

**The field is unlit.** No diffuse term touches the data. Shading a colour-mapped surface would make
one temperature read as two different colours depending on which way it faces, quietly breaking the
promise the legend makes. Depth comes from the silhouette, the borders, and a rim glow confined to
the limb.

**The legend cannot drift.** [`src/ramp.ts`](src/ramp.ts) defines the colour stops once and exports
them both as a GL lookup texture and as a CSS gradient. The renderer runs with output colour
conversion disabled, so the authored sRGB bytes reach the framebuffer untouched and the bar under
the globe is the same colour as the globe, not merely close to it.

**The scale follows the view.** In relative mode the ramp is windowed to the hottest and coldest
thing currently on screen, for the currently selected point in the year. Zoomed out over the whole
globe that barely matters; zoomed into the Sahara in July it is the difference between flat orange
and being able to see the Ahaggar massif, the Sahel gradient and the Canary upwelling.

[`src/exposure.ts`](src/exposure.ts) measures this by casting a fixed 48 × 28 grid of rays *through
the screen* rather than walking the data grid over the visible region. That choice is the whole
trick: screen-space sampling costs the same at every zoom level, where data-space iteration explodes
to a million texels exactly when you zoom out. It also inherits the frustum, the aspect ratio and
back-face occlusion for free, because it literally is the screen.

Three guards keep it from looking terrible, and each fixes something that genuinely went wrong
first: percentile clipping so one stray sample can't seize the scale, exponential smoothing so the
window settles like a camera's auto-exposure instead of strobing, and a minimum span so uniform
ocean doesn't get amplified into noise.

**Relative mode swaps the palette, deliberately.** Absolute mode is diverging (blue-white-red) because
0 °C is a real midpoint. A moving window has no meaningful midpoint, so it gets a *sequential* ramp
where lightness rises monotonically and no colour makes an absolute claim — otherwise a 30 °C Sahara
would render deep blue simply because it was the coolest thing in frame. The legend marks where 0 °C
falls whenever it lands inside the window, which hands back the one absolute reference the
sequential ramp gives up.

## Caveats

- **The scale bottoms out at −50 °C.** Monthly means on the Antarctic plateau reach about −68 °C and
  are clamped; the legend marks the low end `≤ −50` rather than hiding it. About 2.15% of all pixels
  across the year are affected, essentially all of them in Antarctica.
- **Readings are quantised to 0.39 °C**, so the tooltip's decimal is finer than the stored value.
  Invisible at full range, but stretching a narrow relative window over the whole ramp would expose
  it as terracing, so the shader dithers by a full quantisation step using interleaved gradient
  noise. Half a step only roughens the boundary between two plateaus; a full step makes their noise
  overlap, which is what actually lets the eye read a continuous gradient again.
- **In relative mode a colour is not comparable between views** — that is what "relative" means. The
  ramp change, the live numeric ticks and the 0 °C marker are all there to keep that legible; switch
  to absolute (`r`) whenever you need two views to mean the same thing.
- **This is climatology, not weather** — a 30-year average for each month, not any particular year.
- Requires WebGL 2 (`sampler2DArray`). The field texture is ~56 MB of VRAM.

## Layout

```
scripts/build-data.ts   fetch → composite → encode; asserts no holes, then spot-checks georeferencing
src/field.ts            decodes the PNGs once, feeding both the GPU texture and the hover sampler
src/geo.ts              the sphere/raster convention, in one place
src/exposure.ts         auto-exposure: what is the hottest and coldest thing on screen right now
src/globe.ts            scene, shader, camera framing, raycast hover
src/stars.ts            the starfield, one draw call
src/ramp.ts             both colour ramps — single source of truth for shader and legend
src/borders.ts          TopoJSON → great-circle-subdivided line segments
src/ui.ts               masthead, legend, transport, tooltip
```

`npm run data` finishes by checking known values (Sahara in July, Siberia in January, the equatorial
Pacific) against the composited field. These are georeferencing tests: a wrong longitude roll on the
ocean grid is invisible in summary statistics but lays the Pacific on top of Africa, and the checks
fail loudly when it does.
