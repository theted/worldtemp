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
| `l` | toggle country labels |
| `b` | toggle country borders |

The **layers** button in the console opens palette selection (thermal, magma, viridis, mono) and
per-layer switches for names, borders, relief and stars. Camera, month and every setting are kept in
`localStorage`, so a reload puts you back where you were.

It opens centred on Europe, at today's date. Because a monthly mean describes the middle of its
month, "today" is a position *between* two samples — 30 August sits about half way from the August
field toward the September one, and the readout says so.

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
boundary produces garbage. One 8-bit channel filters correctly, at the cost of 0.43 °C of
quantisation, which is invisible in a heat map. The green channel carries the land mask.

**The encoded range is chosen to contain the data, not to look tidy.** −70…+40 °C brackets the
observed −68.5…+39.6. A symmetric −50…+50 looks neater and was wrong twice over: it clipped the
Antarctic plateau flat, and wasted the top tenth of every ramp on temperatures the Earth does not
have. The build asserts the bounds hold rather than clamping silently.

**The field is unlit.** No diffuse term touches the data. Shading a colour-mapped surface would make
one temperature read as two different colours depending on which way it faces, quietly breaking the
promise the legend makes. Depth comes from the silhouette, the borders, and a rim glow confined to
the limb.

**The legend cannot drift.** [`src/ramp.ts`](src/ramp.ts) defines the colour stops once and exports
them both as a GL lookup texture and as a CSS gradient. The renderer runs with output colour
conversion disabled, so the authored sRGB bytes reach the framebuffer untouched and the bar under
the globe is the same colour as the globe, not merely close to it.

**Land and sea are told apart by the mask, not by an extra asset.** The land mask has always been in
the texture's green channel; the shader now uses it to recess the ocean very slightly and to derive
a shoreline where the filtered mask crosses 0.5, at a width held constant in screen space by
`fwidth`. Turn country borders off and every coastline is still there. This is the one place
brightness is modulated over a colour-mapped surface, and it earns the exception twice: the
modulation is tied to a fixed boundary rather than to any value, and land and sea genuinely *are*
different measurements here, so drawing the seam is honest rather than decorative.

**Borders are real quads, not GL lines.** `LineBasicMaterial` cannot help: WebGL's `lineWidth` is
capped at 1 by every desktop driver, which is why the outlines used to vanish against a bright
surface. `LineSegments2` builds each segment as an instanced quad, so width is genuine and
resolution-independent — and it is cheap here, because the whole world is only 11,307 segments.
They are drawn twice, a dark wider pass under a bright narrower one, so a single line colour stays
legible over a ramp running from near-black violet to pale gold.

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

**Country names are DOM text, not geometry.** Real text rendering stays crisp at every zoom,
inherits the page font, and needs no glyph atlas, no SDF shader and no committed font file — which
matters when the app has to work with no network at all. The cost is that every visible label is
positioned by hand each frame, so [`src/labels.ts`](src/labels.ts) keeps that work off the layout
path: widths are measured exactly once at construction, and the frame loop only ever writes
`transform` and `opacity`.

Which names show is decided per frame — cull anything past the horizon, drop anything whose country
is too small on screen to be worth naming, then place the rest largest-first, skipping any that
would collide with one already placed. That ordering is what makes zooming feel right: small
countries appear as they grow past the threshold instead of fighting their neighbours for room.
Anchors come from an area-weighted centroid computed *on the sphere* — in lon/lat, Russia and Fiji
average their two halves into the middle of the wrong ocean.

**Diverging and sequential ramps are not interchangeable.** A diverging ramp claims its midpoint
means something; here that is 0 °C. A sequential ramp only claims low-to-high, which is the honest
choice for a window that floats with the view — otherwise a 30 °C Sahara renders deep blue simply
for being the coolest thing in frame. Thermal is diverging; magma, viridis and mono are sequential.

**Diverging ramps stay pinned to freezing.** Naively, white sits at the midpoint of whatever range
is in force, which is 0 °C only by coincidence — and never, now that the encoding runs −70…+40. So
the shader stretches each half of a diverging ramp independently about the position of 0 °C in the
current window (`zeroSplit`). White lands on freezing whatever the window, and when the window
doesn't straddle zero at all it degrades to a single half of the ramp, which is the right picture
for an all-warm view. The legend bar applies the identical remap to its CSS stops, so the white band
sits under the 0 °C tick rather than near it. Under a *sequential* palette the legend draws an
explicit 0 °C marker instead, handing back the reference the ramp gives up.

## Caveats

- **Readings are quantised to 0.43 °C**, so the tooltip's decimal is finer than the stored value.
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
src/countries.ts        TopoJSON → border lines and label anchors, from one fetch and one parse
src/labels.ts           country names: project, cull, declutter, place
src/persist.ts          camera and settings in localStorage, with every access guarded
src/ui.ts               masthead, legend, transport, tooltip
```

`npm run data` finishes by checking known values (Sahara in July, Siberia in January, the equatorial
Pacific) against the composited field. These are georeferencing tests: a wrong longitude roll on the
ocean grid is invisible in summary statistics but lays the Pacific on top of Africa, and the checks
fail loudly when it does.
