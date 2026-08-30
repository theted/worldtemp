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

## Caveats

- **The scale bottoms out at −50 °C.** Monthly means on the Antarctic plateau reach about −68 °C and
  are clamped; the legend marks the low end `≤ −50` rather than hiding it. About 2.15% of all pixels
  across the year are affected, essentially all of them in Antarctica.
- **Readings are quantised to 0.39 °C**, so the tooltip's decimal is finer than the stored value.
- **This is climatology, not weather** — a 30-year average for each month, not any particular year.
- Requires WebGL 2 (`sampler2DArray`). The field texture is ~56 MB of VRAM.

## Layout

```
scripts/build-data.ts   fetch → composite → encode; asserts no holes, then spot-checks georeferencing
src/field.ts            decodes the PNGs once, feeding both the GPU texture and the hover sampler
src/geo.ts              the sphere/raster convention, in one place
src/globe.ts            scene, shader, camera framing, raycast hover
src/ramp.ts             colour ramp — single source of truth for shader and legend
src/borders.ts          TopoJSON → great-circle-subdivided line segments
src/ui.ts               masthead, legend, transport, tooltip
```

`npm run data` finishes by checking known values (Sahara in July, Siberia in January, the equatorial
Pacific) against the composited field. These are georeferencing tests: a wrong longitude roll on the
ocean grid is invisible in summary statistics but lays the Pacific on top of Africa, and the checks
fail loudly when it does.
