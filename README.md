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
| hover | read the temperature, and the sunrise/sunset, under the cursor |
| slider / `←` `→` | scrub the year (hold `shift` for whole months) |
| `space` | play / pause |
| `r` | toggle the colour scale between relative and absolute |
| `l` | toggle country labels |
| `b` | toggle country borders |
| `o` | toggle ocean colouring |
| `h` | toggle 3-D relief |
| `d` | switch between temperature and daylight |

Everything configurable lives behind the cog in the top-right corner: which **field** is drawn
(temp, the monthly climatology, or daylight, the hours between sunrise and sunset), which **scale**
(absolute or relative), which **palette**, and which **layers**. The console along the bottom keeps
only the two things you read continuously — what the colours mean, and when — and its caption states
the two facts the moved controls used to imply.

Seven palettes. Two are diverging, and only they claim their midpoint means something: **thermal**
welds white to 0 °C, **spectral** does the same with a pale straw but spends the difference on
green, cyan and amber. **Turbo** is the one to reach for when the question is "how many values can I
tell apart" — a full-spectrum ramp whose lightness, unlike `jet`, climbs monotonically, so it never
invents an edge where the data is smooth. **Magma**, **plasma** and **viridis** are the perceptually
uniform sequential set, and **mono** has no hue at all, which is the quickest way to tell a real
pattern from an artefact of the palette. Camera, month and every setting are kept in
`localStorage`, so a reload puts you back where you were.

It opens centred on Europe, at today's date. Because a monthly mean describes the middle of its
month, "today" is a position *between* two samples — 30 August sits about half way from the August
field toward the September one, and the readout says so.

## Data

| Layer | Source | Grid | Period | Quantity |
|---|---|---|---|---|
| Land | [WorldClim 2.1 / CRU-TS 4.09](https://www.worldclim.org/data/monthlywth.html) 10′, averaged here | 2160 × 1080 | 1991–2020 | 2 m air temperature |
| Antarctica | [WorldClim 2.1](https://www.worldclim.org/data/worldclim21.html) `tavg` 10′ | 2160 × 1080 | 1970–2000 | 2 m air temperature |
| Ocean | [NOAA OISST v2](https://psl.noaa.gov/data/gridded/data.noaa.oisst.v2.html) long-term mean | 360 × 180 | 1991–2020 | sea surface temperature |
| Relief | [Natural Earth shaded relief](https://www.naturalearthdata.com/downloads/10m-shaded-relief/10m-shaded-relief-basic/) 1:10m, from SRTM Plus | 10800 × 5400 | — | hillshade |
| Coastline | [Natural Earth land](https://github.com/topojson/world-atlas) 1:10m, rasterised here | 10800 × 5400 | — | land coverage |

The two terrain rasters are written as separate single-channel PNGs rather than one interleaved
image, which is worth about 40% of the size — 11.2 MB against 19. PNG predicts each byte from its
neighbour along the row, and a hillshade's fine texture is the hardest thing here to predict, so
putting three unrelated bytes between every pair the filter could have used costs real space.

Writing them costs one non-obvious line. pngjs always allocates four bytes per pixel whatever colour
type its constructor is handed, so a buffer filled one byte per pixel is read four at a time unless
the *write* options say `inputColorType: 0`. Getting that wrong produces a file of the right
dimensions, the right colour type and a thoroughly plausible size, containing almost entirely 255 —
which reads as "all land", so the coastline vanishes, the hillshade flattens and the ocean toggle
stops doing anything, in silence. The build now reads both rasters back and checks that the Atlantic
and Pacific are water, the Sahara is land and open ocean is flat, because file size is not content.

| Borders | Natural Earth 110 m via [world-atlas](https://github.com/topojson/world-atlas) | — | — | public domain |

> Fick, S.E. and R.J. Hijmans, 2017. *WorldClim 2: new 1km spatial resolution climate surfaces for
> global land areas.* International Journal of Climatology 37 (12): 4302–4315.
>
> OISST data provided by NOAA PSL, Boulder, Colorado, USA, from https://psl.noaa.gov

**The globe blends two different measurements.** Weather-station climatology only exists over land;
the oceans are sea surface temperature from a different instrument. This is what makes the whole
sphere legible instead of half-grey, but it means a coastline is a genuine discontinuity in *what is
being measured*, not just in value. The hover readout always says which of the two you are looking
at. The two masks tile the globe exactly — 34.64% land, 65.36% ocean, nothing left over.

**Land and ocean are on the same 30 years.** They were not always: the land layer used to be
WorldClim 2.1's 1970–2000 climatology against an ocean of 1991–2020, so the two halves of the sphere
described different decades. WorldClim publishes no newer *climatology*, but it does publish a
monthly *series* — CRU-TS 4.09 downscaled and bias-corrected against WorldClim 2.1, from 1950 to
2024 — so `npm run data` now averages the 30 years of the current WMO normal period itself. The
spatial detail still comes from WorldClim 2.1; what CRU supplies is the shift onto a recent period.

**Except Antarctica, which CRU-TS does not cover.** 97% of the pixels the series is missing are south
of 60° S, and the gap cannot simply be left: the dilation pass below would fill the coldest place on
Earth from its ocean neighbours at about −1.8 °C, and `T_MIN = −70` exists precisely because of the
Antarctic plateau. So those pixels keep the 1970–2000 field, and the masthead names it as its own
tier rather than quietly averaging two periods under one label. The remaining 3% is a scatter of
islands too small for CRU's 0.5° grid to resolve.

This is safe because the newer series is a strict *subset* of the old one — every pixel it covers,
WorldClim 2.1 covers too — so the fallback reproduces the old land mask exactly. The build asserts
that directly: new-tier plus fallback must equal the 1970–2000 land count, and a future revision
that grew the series past its old bounds would fail the build rather than move a coastline.

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

**The second field is computed, not stored.** Day length is `24/π · acos(cos H)`, where `cos H`
depends on nothing but latitude and the sun's declination — so [`src/fields.ts`](src/fields.ts)
adds a whole second layer to the globe without a byte of new data, a download or a build step. The
fragment shader derives it from its own `vUv.y` and one uniform; the same formula in
[`src/sun.ts`](src/sun.ts) feeds the hover readout and the auto-exposure histogram, sharing its
zenith constant with the GLSL by interpolation so the two cannot drift.

The polar cases, which cost `sunTimes` three branches, cost the field none. `sunTimes` must tell a
polar night from a midnight sun because it has a phrase to print; a field only wants hours, and
`clamp(cosH, -1, 1)` sends both to exactly the right end — 0 and 24. So the Arctic Circle draws
itself, as the latitude where the gradient reaches the top of the ramp and flattens.

**Which is why `zeroSplit` takes a pivot.** A diverging ramp claims its midpoint means something,
and day length has a reference every bit as real as freezing: 12 hours, the equinox. Pinning the
ramp's midpoint to it is the identical operation, so thermal's white band now welds itself to the
equinox in daylight mode exactly as it welds to 0 °C in temperature mode — and degrades the same
way, spending a single half of the ramp on a June view where nothing visible is under 12 hours.

Everything else in the globe eases, but the field switch does not. The month, the colour window and
the palette are all continuous, so cross-fading them reads as movement. A temperature morphing into
a duration would pass through values that are neither, under a legend labelling them in one unit or
the other — so the switch is a cut, and the auto-exposure is told to snap rather than ease across.

**Terrain is a second raster, five times finer, and that is the point.** What looks wrong about a
coastline at full zoom is not blur. The shader draws it as the half-way crossing of a bilinear mask
and sizes the line with `fwidth`, a screen-space derivative, so the line stays one or two pixels
wide however far you zoom in. What degrades is the *contour it traces*: at 10 arcmin the half-way
crossing of the temperature field's own mask is a smoothly rounded lobe, so Norway's fjords read as
soft scallops. `controls.minDistance` puts about 1 arcmin under a pixel at full zoom, against a
10-arcmin grid — a tenfold magnification of the data cell, which is exactly what you see.

Coastline detail has nothing to do with how finely temperature is known, though, so it need not be
bought at the temperature field's twelve layers. [`src/terrain.ts`](src/terrain.ts) loads one extra
2-arcmin raster carrying a hillshade and a land coverage mask, and the shader takes the shoreline,
the land/sea brightness step and the ocean mute from that instead. The temperature mask still
decides which *measurement* the readout reports, because that genuinely is a 10-arcmin fact; the
terrain raster decides only what is drawn.

**The hillshade needs no land mask, by luck.** Natural Earth clips its shaded relief to the
coastline and leaves the ocean at 206 — the same byte it uses for level ground. So reading the
hillshade as a *signed* offset from 206 gives exactly zero over water and zero over flat land, and
something non-zero only where there is relief to show. There is no way for it to tint the sea, and
no mask is required to stop it.

The mask is rasterised rather than sampled, from the same Natural Earth land polygons the borders
come from — so the shoreline and the country outlines are finally derived from one source. A
scanline fill with an active edge table keeps the cost proportional to the edges crossing each row
rather than to every edge for every row. It is sampled 4 × 4 per output cell, because a one-bit mask
would put the contour on a staircase of whole 2-arcmin cells; coverage fractions locate it to about
half an arcmin.

**Two things go wrong at the antimeridian, and a parity check cannot see either.** world-atlas does
not cut its polygons at ±180, so eleven segments in the 1:10m land layer step straight across it —
`179.698` to `-180.000` — and each maps to an edge spanning the entire raster, injecting one crossing
at a meaningless x. The crossing *count* stays even, so the fill still satisfies even-odd; only the
position is nonsense. It shows up as full-width stripes at exactly the latitudes of those segments:
−84.3 (Antarctica), 65–71 (Chukotka and Wrangel Island) and −16.5…−17.0 (Fiji, which straddles 180°
and breaks naive renderers constantly). Unwrapping each ring relative to its previous vertex removes
the jump; the ring then reaches a fraction of a degree past the seam, which a wrapped span fill
absorbs, the raster being a cylinder.

The second is Antarctica, and it is not an artefact at all. Its ring genuinely encircles the pole —
15,209 points running from −180 the whole way round to +180 and never returning — so unwrapped it is
an open curve, and filling an open curve is meaningless whatever rule you use. Closing it down
through the south pole makes it a polygon again, and the fill then covers the continent instead of
striping the latitudes its coast happens to sit at. It is the only such ring in the dataset, and the
build reports how many it closed so a future revision that adds one cannot pass unnoticed.

**Filled by winding number, not parity.** Even-odd is the tempting rule — a hole becomes just another
pair of crossings — but it is only sound when the polygons are disjoint, which puts the burden of
being disjoint on data nobody here controls. Winding counts each crossing with the sign of the edge
that made it, so an interior ring wound the other way subtracts and two rings that happen to overlap
still read as inside rather than cancelling into a hole.

**Shading a colour-mapped surface is a real cost, not a free win.** Everything above about the unlit
sphere still holds: brightness that varies with the ground makes one temperature read as two shades
on a mountainside, which is precisely what the no-diffuse rule exists to prevent. Relief earns its
exception by being tied to the ground rather than to any value, and by sitting behind the **relief**
toggle — turn it off and the surface is once again a pure function of what is measured.

**The globe can be bent into three dimensions, and the hillshade cannot do it.** A shaded relief is
already a *derivative* of height — roughly how much a slope faces the light — so displacing geometry
by it would raise the lit flank of every ridge and sink the shaded one. `h` uses real elevation
instead, from [ETOPO 2022](https://www.ncei.noaa.gov/products/etopo-global-relief-model), at 10
arcmin: coarse next to the hillshade, and deliberately so, because it is consumed by *vertices* and
silhouettes are made of mountain ranges rather than individual peaks.

Everest is 8.8 km against a 6371 km radius — 0.14%, thinner than the varnish on a schoolroom globe —
so the question is not whether to exaggerate but by how much. At about 25× the Himalaya, Andes,
Rockies, Alps and the Antarctic dome stand clear at the limb while a 500 m plateau stays the flat
thing it is.

Two things fall out of the sphere being unlit. Tessellation went from 192 × 96 to 1024 × 512 without
touching the shading budget, because flat-shaded quads are only visible where lighting reads a
per-face normal, and nothing here is lit. And the displaced vertices keep their original normals for
the same reason: deriving true ones would cost three texture fetches per vertex to light a surface
with no diffuse term. The country outlines *do* have to climb with the ground, though — otherwise a
raised Himalaya simply swallows the borders drawn across it, which loses the very thing that makes
the map readable.

**Switching the ocean off rescales the map, not just the pixels.** With `o` the sea is muted to a
flat ground and the land field reads on its own. Doing only that would disappoint, though: in
relative mode the colour window is set by an auto-exposure histogram over everything on screen, so
the ocean's narrow, warm range would go on owning the scale even while invisible, and the land would
stay squeezed into the slice of ramp it had before. So the sampler drops ocean hits in this mode
too. Over Europe in September the window goes from −2…+34 °C to −21…+36 °C — the same land, spread
over the whole ramp instead of two thirds of it.

That change can starve the histogram completely, since mid-Pacific there is no land in frame at all.
It needs no new guard: the existing minimum hit count, there for when the globe is spun almost off
screen, already holds the last good window rather than inventing one from four samples.

**The auto-exposure has a speed limit, because its target is discontinuous.** The colour window is
set from a percentile of the visible field, and a percentile is a threshold on a cumulative count:
while Antarctica contributes fewer rays than the tail allows it is ignored entirely, and the one ray
that tips it over moves the low end forty degrees in a single frame. Everything mid-ramp drops to
the cold end at once — the white-to-deep-blue snap you get sliding the pole into view.

Easing cannot fix that, because exponential easing moves fastest exactly when the jump is largest.
So the window is additionally capped at a fixed travel per second. Ordinary corrections are nowhere
near the cap and stay governed by the time constant, and only the leaps become glides.

**Sun times are in local solar time, not civil time.** The tooltip's second block is the other half
of why a place is the temperature it is: [`src/sun.ts`](src/sun.ts) computes sunrise, sunset and day
length for the cursor's latitude on the scrubbed date. It reports the clock you would get by putting
noon where the sun is actually highest, because a Stockholm sunrise "at 03:30" in June says more
about Sweden sitting an hour west of its own timezone, plus another hour of summer time, than about
the sky. Stripping both away leaves a number that describes the *place* — and, conveniently, needs
no timezone database and no longitude at all, since the geometry depends only on latitude and the
sun's declination.

Two details separate this from naïve spherical trigonometry. Sunrise is taken at a zenith of 90.833°
rather than 90°, because refraction lifts the sun's image about 34′ and you see the upper limb
16′ before the centre; and the equation of time — the ±16-minute gap between sundial and clock that
draws the analemma — is applied, so solar noon drifts through the year instead of being pinned to
12:00. Where the sun's daily circle never meets the horizon there is no solution at all, and that
absence *is* the polar case: the readout says "midnight sun" or "polar night" rather than inventing
a time. The day of year comes from the same `monthToDayOfYear` the scrubber's date label uses, so
the sunrise under the cursor is always the sunrise for the date printed beside the slider.

## Caveats

- **Readings are quantised to 0.43 °C**, so the tooltip's decimal is finer than the stored value.
  Invisible at full range, but stretching a narrow relative window over the whole ramp would expose
  it as terracing, so the shader dithers by a full quantisation step using interleaved gradient
  noise. Half a step only roughens the boundary between two plateaus; a full step makes their noise
  overlap, which is what actually lets the eye read a continuous gradient again.
- **In relative mode a colour is not comparable between views** — that is what "relative" means. The
  ramp change, the live numeric ticks and the 0 °C marker are all there to keep that legible; switch
  to absolute (`r`) whenever you need two views to mean the same thing.
- **Sunrise and sunset are given in local solar time**, so they will not match a local clock:
  subtract the longitude's offset from your timezone, and an hour more under summer time. Day length
  is the timezone-free figure, and is exact to the minute for the date shown.
- **The land layer moved by +0.61 °C on average** when it went from 1970–2000 to 1991–2020, with a
  clear Arctic-amplification gradient: +0.94 °C over land at 60–80° N against +0.32 °C in the
  southern tropics. 85% of land pixels changed by under 1 °C. The 294 pixel-months that moved more
  than 8 °C are almost all winter values on small islands in the Canadian Arctic Archipelago, where
  CRU's 0.5° interpolation has very little station data to work from — reported here rather than
  smoothed away.
- **This is climatology, not weather** — a 30-year average for each month, not any particular year.
- **Lakes follow Natural Earth's land layer.** The Great Lakes and the Caspian are inside it, so
  they draw as land — which happens to be what the climate field says too, since WorldClim covers
  both and OISST covers neither. The alternative would have the readout announce `land · 2 m air`
  over a pixel drawn and muted as sea.
- **The drawn coastline and the reported measurement disagree by up to a cell.** The shoreline is
  now 2-arcmin and the temperature mask is still 10-arcmin, so within roughly 9 km of a coast the
  readout can say `ocean · sea surface` over a pixel drawn as land. Halving `REL_W`/`REL_H` in
  `scripts/build-data.ts` trades detail back for consistency; raising them costs VRAM.
- **Reloads are free after the first.** The ~18 MB of rasters go into Cache Storage under a name
  taken from a digest of every file the build wrote, which `npm run data` stamps into `meta.json`.
  Rebuilding the data therefore invalidates the cache by construction rather than by convention, and
  a stale raster cannot be served alongside a fresh manifest because the two are the same fact.
  `meta.json` is never cached, since it carries the key.
- Requires WebGL 2 (`sampler2DArray`). The temperature field is ~56 MB of VRAM and the terrain
  raster another ~117 MB, both fixed regardless of zoom. On disk the terrain is 11.2 MB, most of it
  the hillshade. Both levers are one constant each in `scripts/build-data.ts`: halving `REL_W`/
  `REL_H` gives 4 arcmin for 2.7 MB and 29 MB of VRAM, and quantising the shade to 64 levels saves
  a further 30% with no visible change, since it is decoration rather than data.

## Layout

```
scripts/build-data.ts   fetch → average → composite → encode; asserts the land mask, then georeferencing
src/field.ts            decodes the PNGs once, feeding both the GPU texture and the hover sampler
src/terrain.ts          the hillshade and coastline raster — scenery, never sampled on the CPU
src/geo.ts              the sphere/raster convention, in one place
src/calendar.ts         the month axis: scrubber position ↔ day of the year, in one place
src/sun.ts              sunrise, sunset and day length, in local solar time
src/fields.ts           the two drawable quantities, and every place they differ
src/exposure.ts         auto-exposure: what is the hottest and coldest thing on screen right now
src/globe.ts            scene, shader, camera framing, raycast hover
src/stars.ts            the starfield, one draw call
src/ramp.ts             both colour ramps — single source of truth for shader and legend
src/countries.ts        TopoJSON → border lines and label anchors, from one fetch and one parse
src/labels.ts           country names: project, cull, declutter, place
src/elevation.ts        real heights, for displacement — the hillshade is a derivative, not a height
src/cache.ts            the rasters in Cache Storage, keyed by a digest of the build that wrote them
src/persist.ts          camera and settings in localStorage, with every access guarded
src/ui.ts               masthead, legend, transport, tooltip
```

`npm run data` finishes by checking known values (Sahara in July, Siberia in January, the equatorial
Pacific) against the composited field. These are georeferencing tests: a wrong longitude roll on the
ocean grid is invisible in summary statistics but lays the Pacific on top of Africa, and the checks
fail loudly when it does.
