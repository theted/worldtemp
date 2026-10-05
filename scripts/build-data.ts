/**
 * Bakes monthly average-temperature climatology into 12 PNGs the app serves locally.
 *
 * Three sources are composited onto one 2160x1080 equirectangular grid:
 *
 *   1. WorldClim 2.1 / CRU-TS 4.09 (2015-2024)  - 2 m air temperature, land, ~18 km
 *   2. WorldClim 2.1 `tavg` 10' (1970-2000)     - the same, for land tier 1 does not reach
 *   3. NOAA OISST v2.1 (2015-2024)              - sea surface temperature, ocean only, 0.25 deg
 *
 * Neither tier 1 nor tier 3 is distributed as a climatology: both are monthly *series*, so the
 * window below is averaged here, over the same years for both. That puts land and sea on one
 * period, and it means the period can be the most recent one the series reach rather than whatever
 * the publishers last baked. Tier 1 also lands on the output grid natively -- 10 arcmin is
 * 2160x1080 -- so nothing on land is resampled.
 *
 * Tier 2 exists because CRU-TS has no Antarctica. Left as a hole the dilation pass below would fill
 * the coldest place on Earth from its ocean neighbours, at about -1.8 C. Every pixel tier 1 covers
 * is also covered by tier 2, so the fallback reproduces the old land mask exactly and the build
 * asserts precisely that.
 *
 * The land and ocean masks are not quite complements: the Antarctic ice shelves are in neither, and
 * are filled by growing the sea in over them -- see the dilation pass below. The script asserts
 * zero unfilled pixels before writing, because a hole would render as a hard artifact.
 *
 * Downloads are cached in data/raw/ and gitignored; the derived PNGs are committed, so the app runs
 * after a clone with no network access at all.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fromArrayBuffer } from 'geotiff';
import { PNG } from 'pngjs';
import { feature } from 'topojson-client';
import type { GeometryObject, Topology } from 'topojson-specification';
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import { readOisstNormals } from './oisst.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data/raw');
const OUT = path.join(ROOT, 'public/data');
const GEO = path.join(ROOT, 'public/geo');

/** Output grid: WorldClim 10-arcmin native resolution, so the land tier needs no resampling. */
const W = 2160;
const H = 1080;
const MONTHS = 12;

/**
 * The terrain grid, at 2 arcmin: five times the linear detail of the temperature field.
 *
 * It is a separate, larger raster for a reason. What makes a coastline look wrong at full zoom is
 * not blur -- the shader draws a constant-width line whatever the magnification -- but the *contour
 * it traces*, which is the half-way crossing of a bilinear 10-arcmin mask and so a smoothly rounded
 * lobe rather than a coastline. Detail there has nothing to do with how finely temperature is
 * known, so it does not have to be bought at the temperature field's twelve layers.
 *
 * 4 arcmin: about 7 km, against the temperature field's 18. Two was better still and looked it, but
 * a raster that size is 58 megapixels the browser has to decode on its main thread before the globe
 * can appear, twice over, each through a full RGBA ImageData -- four bytes a pixel to carry one.
 * That is seconds of frozen tab for detail that only pays at the very end of the zoom range.
 *
 * Double these to go back to 2 arcmin, at 4x the VRAM and the startup cost; the build rescales
 * everything from the sources automatically.
 */
const REL_W = 5400;
const REL_H = 2700;

/**
 * Supersampling per axis when rasterising the coastline.
 *
 * A one-bit mask would put the 0.5 contour on a staircase of whole 2-arcmin cells. Sampling 4x4 and
 * averaging turns it into a coverage fraction, which locates the contour to about half an arcmin --
 * the difference between a coastline and a flight of steps.
 */
const COAST_SS = 4;

/**
 * The byte Natural Earth's shaded relief uses for ground with no slope.
 *
 * Also, usefully, the byte it uses for the ocean, which it clips out entirely. So relief read as a
 * *signed* offset from this value is naturally zero over flat land and zero over water, and the
 * hillshade needs no land mask of its own and cannot tint the sea. src/globe.ts interpolates this
 * same constant into the shader.
 */
const RELIEF_FLAT = 206;

/**
 * Elevation grid for the 3-D displacement, at 10 arcmin.
 *
 * Deliberately far coarser than the hillshade, because it is consumed by *vertices* rather than by
 * pixels and the sphere's own tessellation is coarser still. It is also a different question: the
 * hillshade has to survive being magnified tenfold at full zoom, while displacement only has to
 * bend a silhouette, and silhouettes are made of mountain ranges, not of individual peaks.
 */
const ELEV_W = 2160;
const ELEV_H = 1080;

/**
 * Metres spanned by the byte range.
 *
 * Everest is 8849, but this grid holds the *mean* over a 10-arcmin cell — about 340 km² — and no
 * such cell comes close. The build reports the observed maximum so the headroom stays honest.
 */
const ELEV_MAX_M = 9000;

/**
 * Encoding range, chosen to contain the data rather than to look tidy.
 *
 * A symmetric -50..50 clipped the Antarctic plateau (whose July means reach about -68 C) and wasted
 * the top tenth of the scale, since nowhere on Earth has a monthly mean near +50 C. These bounds
 * bracket the observed -68.5..40.2 with a little headroom, so nothing is clamped and the full ramp
 * is used. The build asserts this rather than trusting it -- see the range check below.
 *
 * The top was +40 until the window moved to 2015-2024, and the check is what caught it: a decade
 * of recent Julys put the hottest monthly mean on Earth at 40.2.
 */
const T_MIN = -70;
const T_MAX = 42;

/** NetCDF writes -9.96921e36 for absent cells; anything this large in magnitude is a sentinel. */
const SENTINEL = 1e30;
const isMissing = (v: number) => !Number.isFinite(v) || Math.abs(v) > SENTINEL;

/**
 * The years averaged into the land (tier 1) and ocean (tier 3) normals, inclusive.
 *
 * The latest ten years the land series reaches, rather than the 1991-2020 WMO normal. A 30-year
 * normal is centred 15 years before it ends, and in a warming climate that is a measurable error:
 * moving from 1970-2000 to 1991-2020 shifted the land by +0.61 C, Arctic land by nearly a degree,
 * and 1991-2020 is centred on 2005. A decade centred on 2020 describes the present far better --
 * moving to it shifted the land by a further +0.44 C, and Arctic land by +0.66.
 *
 * The cost is that ten years average away less weather than thirty -- one strong El Nino carries
 * three times the weight. That is the trade being made, deliberately; it is a two-line change to
 * undo, and both series reach back far enough for any window from 1982 on.
 */
const CLIM_FROM = 2015;
const CLIM_TO = 2024;

/** The land archives are published per decade; only those overlapping the window are fetched. */
const DECADES = [
  '1950-1959', '1960-1969', '1970-1979', '1980-1989',
  '1990-1999', '2000-2009', '2010-2019', '2020-2024',
] as const;

/**
 * CRU-TS publishes daily extremes rather than a mean, so tavg is (tmin + tmax) / 2 -- which is how
 * WorldClim 2.1 defines its own `tavg`, so tier 1 and tier 2 remain the same quantity.
 */
const HIST_VARS = ['tmin', 'tmax'] as const;

const histName = (v: string, decade: string) => `wc2.1_cruts4.09_10m_${v}_${decade}.zip`;
const histUrl = (v: string, decade: string) =>
  `https://geodata.ucdavis.edu/climate/worldclim/2_1/hist/cts4.09/${histName(v, decade)}`;

const SOURCES = {
  worldclim: {
    url: 'https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_tavg.zip',
    file: 'wc2.1_10m_tavg.zip',
  },
  // The whole monthly series, 2.2 GB. PSL's OPeNDAP server could subset it, and the old long-term
  // mean came from there, but it was down for maintenance when this moved; a plain file on their
  // download server is the sturdier dependency, and it is only fetched once.
  sst: {
    url: 'https://downloads.psl.noaa.gov/Datasets/noaa.oisst.v2.highres/sst.mon.mean.nc',
    file: 'sst.mon.mean.nc',
  },
  borders: {
    url: 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json',
    file: 'countries-110m.json',
  },
  // Grayscale hillshade at 1 arcmin, from downsampled SRTM Plus, clipped to Natural Earth's own
  // 1:10m coastline -- the same cartography the borders already come from.
  relief: {
    url: 'https://naciscdn.org/naturalearth/10m/raster/SR_HR.zip',
    file: 'SR_HR.zip',
  },
  // The coastline as polygons rather than pixels, so the mask can be rasterised at any resolution.
  land: {
    url: 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-10m.json',
    file: 'land-10m.json',
  },
  // Real elevation, which the hillshade is not: a shaded relief is already a derivative of height,
  // so displacing geometry by it would raise the lit side of every ridge and sink the shaded side.
  elevation: {
    url: 'https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif',
    file: 'etopo_60s_surface.tif',
  },
} as const;

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------
// fetching
// ---------------------------------------------------------------------------------------------

/**
 * Ensures `dest` exists, fetching it if not, and returns the path rather than the bytes.
 *
 * Split out from `download` for the large files -- the land archives and the 2.2 GB ocean series --
 * which their readers open from disk one at a time rather than holding resident.
 *
 * Streamed to a scratch name and renamed into place only once complete, so the download is never
 * held in memory and an interrupted one can never be mistaken for a cached one.
 */
async function ensure(url: string, dest: string): Promise<string> {
  try {
    const s = await stat(dest);
    if (s.size > 0) {
      console.log(`  cached  ${path.basename(dest)} (${mb(s.size)})`);
      return dest;
    }
  } catch {
    /* not cached yet */
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const name = path.basename(dest);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const progress = new Transform({
    transform: (chunk: Buffer, _enc, done) => {
      got += chunk.length;
      process.stdout.write(`  fetch   ${name} ${mb(got)}${total ? ` / ${mb(total)}` : ''}   \r`);
      done(null, chunk);
    },
  });
  const part = `${dest}.part`;
  const body = Readable.fromWeb(res.body as WebReadableStream);
  await pipeline(body, progress, createWriteStream(part));
  await rename(part, dest);
  console.log(`  fetch   ${name} -> ${mb(got)}                    `);
  return dest;
}

async function download(url: string, dest: string): Promise<Buffer> {
  return readFile(await ensure(url, dest));
}

// ---------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------

/** One GeoTIFF out of an archive, as a flat raster, verifying the grid matches our output. */
async function readEntry(zip: AdmZip, name: string): Promise<{ raster: Float32Array; nodata: number | null }> {
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`missing ${name} in archive`);
  const b = entry.getData();
  // Node hands back a Buffer over a pooled (possibly shared) allocation; copy into a plain
  // ArrayBuffer so geotiff gets an exclusive, correctly typed view.
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  const img = await (await fromArrayBuffer(ab)).getImage();
  if (img.getWidth() !== W || img.getHeight() !== H) {
    throw new Error(`${name}: ${img.getWidth()}x${img.getHeight()}, expected ${W}x${H}`);
  }
  const [raster] = await img.readRasters();
  return { raster: raster as Float32Array, nodata: img.getGDALNoData() };
}

/** Reads the 12 monthly GeoTIFFs out of the WorldClim 2.1 base zip. */
async function readWorldClim(zipBuf: Buffer): Promise<{ months: Float32Array[]; nodata: number }> {
  const zip = new AdmZip(zipBuf);
  const months: Float32Array[] = [];
  let nodata = -3.4e38;

  for (let m = 1; m <= MONTHS; m++) {
    const { raster, nodata: nd } = await readEntry(zip, `wc2.1_10m_tavg_${String(m).padStart(2, '0')}.tif`);
    if (nd !== null) nodata = nd;
    months.push(raster);
  }
  return { months, nodata };
}

/** The years of a `YYYY-YYYY` decade archive that fall inside the window. */
function yearsIn(decade: string): number[] {
  const [d0, d1] = decade.split('-').map(Number) as [number, number];
  const years: number[] = [];
  for (let y = Math.max(d0, CLIM_FROM); y <= Math.min(d1, CLIM_TO); y++) years.push(y);
  return years;
}

/**
 * Averages the downscaled CRU-TS monthly series into monthly normals over the window.
 *
 * 240 rasters go in -- 10 years x 12 months x {tmin, tmax} -- and 12 come out. Both variables
 * accumulate into the *same* sum, which is what makes the result (mean tmin + mean tmax) / 2
 * without a second pass; it is only valid while every contributing pixel has both, so the count is
 * carried per pixel and asserted at the end rather than assumed.
 *
 * Missing data is NaN here, not the -3.4e38 sentinel the base archive uses.
 */
async function readNormals(paths: Map<string, string>): Promise<Float32Array[]> {
  // 720 GeoTIFF decodes take minutes, and they produce the same twelve rasters every time. The
  // result is cached beside the archives it came from -- gitignored, like them -- with the period
  // and grid in the filename so a change to either cannot silently reuse the wrong means.
  const cache = path.join(RAW, `normals_${CLIM_FROM}-${CLIM_TO}_${W}x${H}.f32`);
  const bytes = MONTHS * W * H * 4;
  try {
    const st = await stat(cache);
    if (st.size === bytes) {
      const buf = await readFile(cache);
      console.log(`  cached   ${path.basename(cache)} (${mb(st.size)})`);
      return Array.from({ length: MONTHS }, (_, m) =>
        new Float32Array(buf.buffer, buf.byteOffset + m * W * H * 4, W * H),
      );
    }
  } catch {
    /* not cached yet, or a stale size -- recompute */
  }

  const sum = Array.from({ length: MONTHS }, () => new Float32Array(W * H));
  const count = Array.from({ length: MONTHS }, () => new Uint8Array(W * H));
  const expect = (CLIM_TO - CLIM_FROM + 1) * HIST_VARS.length;
  let read = 0;

  for (const v of HIST_VARS) {
    for (const decade of DECADES) {
      const years = yearsIn(decade);
      if (years.length === 0) continue;
      const zip = new AdmZip(await readFile(paths.get(histName(v, decade))!));
      for (const year of years) {
        for (let m = 1; m <= MONTHS; m++) {
          const mm = String(m).padStart(2, '0');
          const { raster } = await readEntry(zip, `wc2.1_cruts4.09_10m_${v}_${year}-${mm}.tif`);
          const s = sum[m - 1]!;
          const c = count[m - 1]!;
          for (let i = 0; i < W * H; i++) {
            const t = raster[i]!;
            if (!Number.isFinite(t)) continue;
            s[i] += t;
            c[i]++;
          }
          read++;
        }
        process.stdout.write(`  normals  ${read}/${expect * MONTHS} rasters (${v} ${year})   \r`);
      }
    }
  }

  // A pixel present in some years but not others would silently average a shorter record against a
  // longer one, and tmin without its tmax would bias the mean by half the diurnal range. Neither is
  // visible in the output, so both are checked here instead.
  const months: Float32Array[] = [];
  let partial = 0;
  for (let m = 0; m < MONTHS; m++) {
    const s = sum[m]!;
    const c = count[m]!;
    const out = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (c[i] === expect) out[i] = s[i]! / expect;
      else {
        if (c[i]! > 0) partial++;
        out[i] = NaN;
      }
    }
    months.push(out);
  }
  if (partial > 0) {
    throw new Error(`${partial} pixel-months have an incomplete ${CLIM_FROM}-${CLIM_TO} record`);
  }
  console.log(`  normals  ${read} rasters -> 12 monthly means over ${CLIM_FROM}-${CLIM_TO}   `);
  const flat = new Float32Array(MONTHS * W * H);
  months.forEach((m, i) => flat.set(m, i * W * H));
  await writeFile(cache, Buffer.from(flat.buffer));
  return months;
}

/**
 * Natural Earth's 1-arcmin hillshade, box-averaged onto the terrain grid.
 *
 * Read in horizontal strips: the source is 21600x10800, which is 233 MB of samples, and there is no
 * reason to hold all of it to produce a raster a twentieth the size. An area mean rather than a
 * point sample, because throwing away three quarters of a hillshade's pixels turns its fine texture
 * into aliasing that no amount of bilinear filtering afterwards will remove.
 */
async function readRelief(zipBuf: Buffer): Promise<Uint8Array> {
  const entry = new AdmZip(zipBuf).getEntry('SR_HR.tif');
  if (!entry) throw new Error('missing SR_HR.tif in the shaded relief zip');
  const b = entry.getData();
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  const img = await (await fromArrayBuffer(ab)).getImage();

  const sw = img.getWidth();
  const sh = img.getHeight();
  if (sw % REL_W !== 0 || sh % REL_H !== 0) {
    throw new Error(`relief ${sw}x${sh} is not a whole multiple of ${REL_W}x${REL_H}`);
  }
  const div = sw / REL_W;
  if (sh / REL_H !== div) throw new Error(`relief aspect ${sw}x${sh} does not match the output grid`);

  const out = new Uint8Array(REL_W * REL_H);
  const strip = div * 64; // source rows per read, a whole number of output rows
  for (let y0 = 0; y0 < sh; y0 += strip) {
    const rows = Math.min(strip, sh - y0);
    const [raw] = await img.readRasters({ window: [0, y0, sw, y0 + rows] });
    const src = raw as Uint8Array;
    for (let oy = 0; oy < rows / div; oy++) {
      for (let ox = 0; ox < REL_W; ox++) {
        let sum = 0;
        for (let dy = 0; dy < div; dy++) {
          const base = (oy * div + dy) * sw + ox * div;
          for (let dx = 0; dx < div; dx++) sum += src[base + dx]!;
        }
        out[(y0 / div + oy) * REL_W + ox] = Math.round(sum / (div * div));
      }
    }
    process.stdout.write(`  relief   ${y0 + rows}/${sh} source rows\r`);
  }
  console.log(`  relief   ${sw}x${sh} -> ${REL_W}x${REL_H} (${(60 / (REL_W / 360)).toFixed(0)} arcmin)   `);
  return out;
}

/**
 * ETOPO's surface elevation, area-averaged onto the displacement grid and encoded to a byte.
 *
 * Bathymetry is clamped away *before* averaging, not after. A coastal cell mixes -4000 m of shelf
 * with a few hundred metres of shore; averaged raw it comes out below sea level and the coast sinks
 * into the ocean it borders. Clamping each sample first asks the honest question for a land relief —
 * how high is the land here — and leaves the sea a clean sphere.
 */
async function readElevation(tifBuf: Buffer): Promise<{ data: Uint8Array; maxM: number }> {
  const ab = new ArrayBuffer(tifBuf.byteLength);
  new Uint8Array(ab).set(tifBuf);
  const img = await (await fromArrayBuffer(ab)).getImage();
  const sw = img.getWidth();
  const sh = img.getHeight();
  if (sw % ELEV_W !== 0 || sh % ELEV_H !== 0) {
    throw new Error(`elevation ${sw}x${sh} is not a whole multiple of ${ELEV_W}x${ELEV_H}`);
  }
  const div = sw / ELEV_W;
  if (sh / ELEV_H !== div) throw new Error(`elevation aspect ${sw}x${sh} does not match the grid`);

  const out = new Uint8Array(ELEV_W * ELEV_H);
  let maxM = 0;
  const strip = div * 32;
  for (let y0 = 0; y0 < sh; y0 += strip) {
    const rows = Math.min(strip, sh - y0);
    const [raw] = await img.readRasters({ window: [0, y0, sw, y0 + rows] });
    const src = raw as Int16Array | Float32Array;
    for (let oy = 0; oy < rows / div; oy++) {
      for (let ox = 0; ox < ELEV_W; ox++) {
        let sum = 0;
        for (let dy = 0; dy < div; dy++) {
          const base = (oy * div + dy) * sw + ox * div;
          for (let dx = 0; dx < div; dx++) {
            const v = src[base + dx]!;
            sum += Number.isFinite(v) && v > 0 ? v : 0;
          }
        }
        const m = sum / (div * div);
        if (m > maxM) maxM = m;
        out[(y0 / div + oy) * ELEV_W + ox] = Math.min(255, Math.round((m / ELEV_MAX_M) * 255));
      }
    }
    process.stdout.write(`  elev     ${y0 + rows}/${sh} source rows\r`);
  }
  console.log(
    `  elev     ${sw}x${sh} -> ${ELEV_W}x${ELEV_H}, peak cell mean ${maxM.toFixed(0)} m ` +
      `of ${ELEV_MAX_M} encoded   `,
  );
  if (maxM > ELEV_MAX_M) throw new Error(`elevation reaches ${maxM.toFixed(0)} m, above ELEV_MAX_M`);
  return { data: out, maxM };
}

/**
 * Rasterises the Natural Earth land polygons into a coverage mask on the terrain grid.
 *
 * A scanline fill with an active edge table, so the cost is proportional to the edges actually
 * crossing each row rather than to every edge for every row -- the difference between a second and
 * an hour at four hundred thousand vertices and twenty thousand scanlines.
 *
 * Filled by winding number rather than by parity. Even-odd is the tempting choice -- a hole is then
 * just another pair of crossings -- but it is only sound when the polygons are disjoint, and it puts
 * the burden of being disjoint on data nobody here controls. Winding counts each crossing with the
 * sign of the edge that made it, so an interior ring wound the other way subtracts, and two rings
 * that happen to overlap still read as inside rather than cancelling to a hole.
 */
function rasteriseLand(topo: Topology): Uint8Array {
  // world-atlas wraps its single MultiPolygon in a GeometryCollection, so `feature` hands back a
  // FeatureCollection rather than a Feature. Flattened here rather than assumed, because either
  // shape is legal TopoJSON and the difference is one undefined property deep.
  const fc = feature(topo, topo.objects.land as GeometryObject) as
    | Feature<Polygon | MultiPolygon>
    | FeatureCollection<Polygon | MultiPolygon>;
  const features = fc.type === 'FeatureCollection' ? fc.features : [fc];

  const polygons: Position[][][] = [];
  for (const f of features) {
    const g = f.geometry;
    if (g.type === 'Polygon') polygons.push(g.coordinates);
    else for (const poly of g.coordinates) polygons.push(poly);
  }
  if (polygons.length === 0) throw new Error('no land polygons in the coastline topology');

  const SW = REL_W * COAST_SS;
  const SH = REL_H * COAST_SS;

  // Edges bucketed by the first scanline they can cross, so each is touched only while it is live.
  interface Edge { yTop: number; yBot: number; x: number; dxdy: number; dir: number }
  const buckets: Edge[][] = Array.from({ length: SH }, () => []);
  let edges = 0;

  const addEdge = (lon0: number, lat0: number, lon1: number, lat1: number) => {
    const ax = ((lon0 + 180) / 360) * SW;
    const ay = ((90 - lat0) / 180) * SH;
    const bx = ((lon1 + 180) / 360) * SW;
    const by = ((90 - lat1) / 180) * SH;
    if (ay === by) return; // horizontal edges contribute no crossings
    // Which way the edge runs is the whole basis of the winding rule, so it is captured before the
    // endpoints are sorted into scanline order and the direction would be lost.
    const dir = ay < by ? 1 : -1;
    const [xTop, yTop, xBot, yBot] = ay < by ? [ax, ay, bx, by] : [bx, by, ax, ay];
    const first = Math.max(0, Math.ceil(yTop - 0.5));
    if (first >= SH) return;
    buckets[first]!.push({ yTop, yBot, x: xTop, dxdy: (xBot - xTop) / (yBot - yTop), dir });
    edges++;
  };

  /**
   * A ring with continuous longitudes, closed through the pole if it encircles one.
   *
   * Two things go wrong at the antimeridian, and both are invisible to a parity check because the
   * crossing *count* stays even -- only the x it lands at is nonsense. They show up as full-width
   * stripes through the raster and nowhere else.
   *
   * The first is that world-atlas does not cut its polygons at +-180, so a handful of segments step
   * straight across (179.698 to -180.000) and become edges spanning the whole raster. Unwrapping
   * each ring relative to its previous vertex removes the jump; the ring then pokes a fraction of a
   * degree past the seam, which the wrapped span fill below absorbs.
   *
   * The second is Antarctica, and it is not a wrapping artefact at all. Its ring genuinely encircles
   * the pole -- 15209 points running from -180 all the way round to +180 and never returning -- so
   * unwrapped it is an open curve, not a polygon, and an even-odd fill of an open curve is
   * meaningless. Closing it down through the south pole makes it a polygon again, and the fill then
   * covers the continent instead of striping the latitudes its coast happens to sit at.
   */
  const prepareRing = (ring: Position[]): Position[] => {
    const [lon0, lat0] = ring[0] as [number, number];
    const out: Position[] = [[lon0, lat0]];
    let prev = lon0;
    for (let i = 1; i < ring.length; i++) {
      const [raw, lat] = ring[i] as [number, number];
      let lon = raw;
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
      out.push([lon, lat]);
      prev = lon;
    }
    if (Math.abs(prev - lon0) > 180) {
      const pole = lat0 < 0 ? -90 : 90;
      out.push([prev, pole], [lon0, pole], [lon0, lat0]);
      encircling++;
    }
    return out;
  };

  let encircling = 0;
  for (const rings of polygons) {
    for (const ring of rings) {
      const r = prepareRing(ring);
      for (let i = 0; i < r.length - 1; i++) {
        const [lonA, latA] = r[i] as [number, number];
        const [lonB, latB] = r[i + 1] as [number, number];
        addEdge(lonA, latA, lonB, latB);
      }
    }
  }

  const out = new Uint8Array(REL_W * REL_H);
  const cover = new Int32Array(REL_W);
  const full = COAST_SS * COAST_SS;
  let active: Edge[] = [];
  const xs: { x: number; dir: number }[] = [];

  for (let sy = 0; sy < SH; sy++) {
    const yc = sy + 0.5;
    if (buckets[sy]!.length) active = active.concat(buckets[sy]!);
    if (active.length) active = active.filter((e) => e.yBot > yc);

    xs.length = 0;
    for (const e of active) {
      if (e.yTop <= yc && e.yBot > yc) xs.push({ x: e.x + (yc - e.yTop) * e.dxdy, dir: e.dir });
    }
    xs.sort((a, b) => a.x - b.x);

    // Inside is where the accumulated winding is non-zero; a span runs from where it leaves zero to
    // where it returns. Sample at pixel centres, matching where the crossings were evaluated, and
    // wrap: unwrapping leaves a few rings reaching a fraction of a degree past the seam, and the
    // raster is a cylinder, so a span that runs off one edge belongs on the other.
    let winding = 0;
    let spanFrom = 0;
    for (const c of xs) {
      const was = winding;
      winding += c.dir;
      if (was === 0 && winding !== 0) spanFrom = c.x;
      else if (was !== 0 && winding === 0) {
        const from = Math.ceil(spanFrom - 0.5);
        const to = Math.floor(c.x - 0.5);
        for (let sx = from; sx <= to; sx++) cover[((((sx % SW) + SW) % SW) / COAST_SS) | 0]!++;
      }
    }

    if (sy % COAST_SS === COAST_SS - 1) {
      const oy = (sy / COAST_SS) | 0;
      const row = oy * REL_W;
      for (let ox = 0; ox < REL_W; ox++) {
        out[row + ox] = Math.round((cover[ox]! / full) * 255);
        cover[ox] = 0;
      }
      if (oy % 256 === 0) process.stdout.write(`  coast    ${oy}/${REL_H} rows\r`);
    }
  }

  let land = 0;
  for (let i = 0; i < out.length; i++) if (out[i]! > 127) land++;
  console.log(
    `  coast    ${edges} edges -> ${REL_W}x${REL_H} at ${COAST_SS}x${COAST_SS} samples, ` +
      `${((100 * land) / out.length).toFixed(2)}% land, ${encircling} ring(s) closed at a pole   `,
  );
  return out;
}

// ---------------------------------------------------------------------------------------------
// resampling
// ---------------------------------------------------------------------------------------------

/**
 * Bilinear sample of a lon/lat grid, ignoring missing corners.
 *
 * Re-normalising over only the valid corners means values bleed *outward* across a data boundary
 * rather than being dragged toward the sentinel. For the ocean layer that is exactly what we want:
 * it carries sea surface temperature right up to the coast instead of fading into a dark rim.
 */
function bilinear(
  get: (j: number, i: number) => number,
  ni: number,
  nj: number,
  fx: number,
  fy: number,
): number {
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const wx = fx - i0;
  const wy = fy - j0;

  const ia = ((i0 % ni) + ni) % ni; // longitude wraps
  const ib = (ia + 1) % ni;
  const ja = Math.min(Math.max(j0, 0), nj - 1); // latitude clamps at the poles
  const jb = Math.min(Math.max(j0 + 1, 0), nj - 1);

  let sum = 0;
  let wsum = 0;
  const add = (j: number, i: number, w: number) => {
    if (w <= 0) return;
    const v = get(j, i);
    if (isMissing(v)) return;
    sum += w * v;
    wsum += w;
  };
  add(ja, ia, (1 - wx) * (1 - wy));
  add(ja, ib, wx * (1 - wy));
  add(jb, ia, (1 - wx) * wy);
  add(jb, ib, wx * wy);

  return wsum > 0 ? sum / wsum : NaN;
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

async function main() {
  /*
   * Digest of everything this build writes, stamped into meta.json and used by the browser to name
   * its raster cache. Content-addressed rather than a timestamp, so an identical rebuild keeps the
   * client's cache warm and any real change invalidates it without anyone having to remember to.
   */
  const stamp = createHash('sha256');

  await mkdir(RAW, { recursive: true });
  await mkdir(OUT, { recursive: true });
  await mkdir(GEO, { recursive: true });

  console.log('\nsources');
  const [wcBuf] = await Promise.all([
    download(SOURCES.worldclim.url, path.join(RAW, SOURCES.worldclim.file)),
    // written straight into public/geo for the border overlay
    download(SOURCES.borders.url, path.join(GEO, SOURCES.borders.file)),
  ]);
  stamp.update(await readFile(path.join(GEO, SOURCES.borders.file)));
  const reliefBuf = await download(SOURCES.relief.url, path.join(RAW, SOURCES.relief.file));
  const landBuf = await download(SOURCES.land.url, path.join(RAW, SOURCES.land.file));
  const elevBuf = await download(SOURCES.elevation.url, path.join(RAW, SOURCES.elevation.file));
  const sstPath = await ensure(SOURCES.sst.url, path.join(RAW, SOURCES.sst.file));

  // Sequential, and to disk rather than to memory: this is 400 MB across four archives, and
  // fetching them concurrently would hold every response buffer at once to save wall time on a
  // step that only ever runs once.
  const histPaths = new Map<string, string>();
  for (const v of HIST_VARS) {
    for (const decade of DECADES) {
      if (yearsIn(decade).length === 0) continue;
      const name = histName(v, decade);
      histPaths.set(name, await ensure(histUrl(v, decade), path.join(RAW, name)));
    }
  }

  console.log('\ndecode');
  const { months: wc, nodata } = await readWorldClim(wcBuf);
  console.log(`  worldclim  12 x ${W}x${H}  nodata=${nodata}`);
  const normals = await readNormals(histPaths);

  // OISST: lon centres 0.125..359.875 measured eastward, lat centres -89.875..89.875 south to
  // north. Neither runs the way image rows and columns do, so the composite maps pixels onto it.
  const sst = await readOisstNormals(sstPath, CLIM_FROM, CLIM_TO);

  console.log('\nterrain');
  const relief = await readRelief(reliefBuf);

  /*
   * How far the hillshade swings either side of flat ground -- measured, not assumed.
   *
   * The two sides are wildly unequal: Natural Earth puts level ground at 206, so a lit slope has
   * only 49 bytes of headroom while a shaded one has 143 to fall through. Normalising by the
   * highlight side, which is the tempting reading of "the range above flat", sends deep shadow to
   * nearly -3 and drives the surface under it to black. The larger side is the one that has to fit,
   * and downsampling averages the extremes in, so it is cheaper to measure than to reason about.
   */
  let reliefLo = 255;
  let reliefHi = 0;
  for (let i = 0; i < relief.length; i++) {
    const v = relief[i]!;
    if (v < reliefLo) reliefLo = v;
    if (v > reliefHi) reliefHi = v;
  }
  const { data: elevation, maxM: elevMaxM } = await readElevation(elevBuf);

  const reliefScale = Math.max(RELIEF_FLAT - reliefLo, reliefHi - RELIEF_FLAT);
  console.log(
    `  shade    ${reliefLo}..${reliefHi}, flat ${RELIEF_FLAT}, ` +
      `normalising by ${reliefScale} (${RELIEF_FLAT - reliefLo} below / ${reliefHi - RELIEF_FLAT} above)`,
  );
  const coast = rasteriseLand(JSON.parse(landBuf.toString('utf8')) as Topology);

  {
    // Two single-channel files rather than one interleaved image, which is worth six times the size
    // here. PNG predicts each byte from its neighbour along the row, and a hillshade's fine texture
    // is the hardest thing in this project to predict; interleaving it with a mask and two constant
    // channels puts three unrelated bytes between each pair it could have used, and the filter stops
    // paying for itself. The same two rasters written separately compress to under a fifth.
    let bytes = 0;
    for (const [name, data, w, h] of [
      ['relief.png', relief, REL_W, REL_H],
      ['landmask.png', coast, REL_W, REL_H],
      ['elevation.png', elevation, ELEV_W, ELEV_H],
    ] as const) {
      const png = new PNG({ width: w, height: h });
      for (let i = 0; i < w * h; i++) png.data[i] = data[i]!;
      // `inputColorType` is what says how `png.data` is laid out, and it is not optional here: the
      // constructor always allocates four bytes per pixel whatever colour type it is handed, so a
      // buffer filled one byte per pixel is read four bytes at a time unless this says otherwise.
      // The result still compresses to about the size a real hillshade would, which is exactly why
      // checking the file size is not checking the file.
      const buf = PNG.sync.write(png, {
        deflateLevel: 9,
        filterType: -1,
        colorType: 0,
        inputColorType: 0,
      });
      await writeFile(path.join(OUT, name), buf);
      stamp.update(buf);
      bytes += buf.length;
      console.log(`  ${name.padEnd(13)} ${mb(buf.length)}`);
    }

    // Read the rasters back and check known points, because everything above this line can be
    // wrong in a way that still produces a plausible file: the coastline vanishes, the hillshade
    // flattens and the ocean toggle stops working, all silently, all from one packing mistake.
    for (const [name, checks] of [
      ['relief.png', [['mid Atlantic', -40, 30, RELIEF_FLAT, RELIEF_FLAT]]],
      ['landmask.png', [
        ['mid Atlantic', -40, 30, 0, 8],
        ['Sahara', 10, 24, 247, 255],
        ['mid Pacific', -150, 0, 0, 8],
      ]],
      // Sea level at sea, and the Himalaya unmistakably the highest thing on the grid.
      ['elevation.png', [
        ['mid Atlantic', -40, 30, 0, 0],
        ['Netherlands', 5.5, 52.2, 0, 6],
        ['Himalaya', 86.9, 28.5, 100, 220],
        ['Altiplano', -68, -20, 80, 190],
      ]],
    ] as const) {
      const img = PNG.sync.read(await readFile(path.join(OUT, name)));
      for (const [where, lon, lat, lo, hi] of checks) {
        const x = Math.floor(((lon + 180) / 360) * img.width);
        const y = Math.floor(((90 - lat) / 180) * img.height);
        const v = img.data[(y * img.width + x) * 4]!;
        if (v < lo || v > hi) {
          throw new Error(`${name} at ${where}: ${v}, expected ${lo}..${hi} — bad channel packing?`);
        }
      }
      console.log(`  ${name.padEnd(13)} round-trip ok (${checks.length} point${checks.length > 1 ? 's' : ''})`);
    }
    console.log(`  terrain      ${mb(bytes)} on disk, ${mb(REL_W * REL_H * 2)} of VRAM`);
  }

  console.log('\ncomposite');
  const tally = { land: 0, fallback: 0, ocean: 0, grownSea: 0, grownLand: 0, baseLand: 0 };
  const fields: { temp: Float32Array; land: Uint8Array }[] = [];
  let globalMin = Infinity;
  let globalMax = -Infinity;

  for (let m = 0; m < MONTHS; m++) {
    const wcM = wc[m]!;
    const sstM = sst.months[m]!;
    const temp = new Float32Array(W * H);
    const land = new Uint8Array(W * H);
    const filled = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
      const lat = 90 - ((y + 0.5) * 180) / H;
      const sstFy = (lat - sst.lat0) / sst.step;

      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const lon = -180 + ((x + 0.5) * 360) / W;
        const lonE = ((lon % 360) + 360) % 360; // OISST indexes eastward from 0
        const sstFx = (lonE - sst.lon0) / sst.step;

        // land, over the window, where the downscaled CRU series reaches
        const vNew = normals[m]![idx]!;
        const vOld = wcM[idx]!;
        const haveOld = !isMissing(vOld) && vOld !== nodata;
        if (haveOld) tally.baseLand++;

        if (Number.isFinite(vNew)) {
          temp[idx] = vNew;
          land[idx] = 255;
          filled[idx] = 1;
          tally.land++;
          continue;
        }
        // ...and 1970-2000 where it does not, which is Antarctica plus a scatter of small islands
        if (haveOld) {
          temp[idx] = vOld;
          land[idx] = 255;
          filled[idx] = 1;
          tally.fallback++;
          continue;
        }

        // ocean
        const s = bilinear((j, i) => sstM[j * sst.ni + i]!, sst.ni, sst.nj, sstFx, sstFy);
        if (Number.isFinite(s)) {
          temp[idx] = s;
          land[idx] = 0;
          filled[idx] = 1;
          tally.ocean++;
        }
      }
    }

    // Water neither layer measures, filled from whatever surrounds it. Almost all of it is
    // Antarctic ice shelf -- Filchner-Ronne alone is 11 thousand pixels -- which CRU-TS and
    // WorldClim leave out as not being land, and OISST v2.1's quarter-degree mask leaves out as not
    // being open sea. The 1-degree v2 grid was too coarse to tell, and so drew them as sea at the
    // -1.8 C of water under ice; growing the sea inward reproduces exactly that.
    //
    // Each gap is grown from one layer only, which is the point. Averaging both would invent a
    // gradient from -1.8 to -30 that is neither sea surface nor air, under a readout claiming it
    // was one of them. So the sea goes first, and only the pockets it cannot reach -- lakes and
    // estuaries the land layer happens to omit, Maracaibo the largest at 22 pixels -- are then
    // grown from the land around them, and reported as land. Averaging already-filled neighbours
    // is continuous by construction, so neither shows a seam, and passes run until the front
    // stalls rather than to a fixed count, since a shelf hundreds of kilometres deep is that many
    // pixels from open water.
    const grow = (from: 0 | 255) => {
      let todo: number[] = [];
      for (let i = 0; i < filled.length; i++) if (!filled[i]) todo.push(i);
      let grown = 0;
      while (todo.length > 0) {
        const grownTemp = new Float32Array(todo.length);
        const grownOk = new Uint8Array(todo.length);
        for (let k = 0; k < todo.length; k++) {
          const idx = todo[k]!;
          const y = (idx / W) | 0;
          const x = idx % W;
          let sum = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nIdx = yy * W + ((((x + dx) % W) + W) % W);
              if (filled[nIdx] && land[nIdx] === from) {
                sum += temp[nIdx]!;
                n++;
              }
            }
          }
          if (n > 0) {
            grownTemp[k] = sum / n;
            grownOk[k] = 1;
          }
        }
        // Applied only after the whole pass is computed, so a pixel filled this pass does not feed
        // a neighbour in the same one and the front advances evenly in every direction.
        todo.forEach((idx, k) => {
          if (!grownOk[k]) return;
          temp[idx] = grownTemp[k]!;
          land[idx] = from;
          filled[idx] = 1;
          grown++;
        });
        const left = todo.filter((_, k) => !grownOk[k]);
        if (left.length === todo.length) break;
        todo = left;
      }
      return grown;
    };
    tally.grownSea += grow(0);
    tally.grownLand += grow(255);

    let holes = 0;
    for (let i = 0; i < filled.length; i++) if (!filled[i]) holes++;
    if (holes > 0) throw new Error(`month ${m + 1}: ${holes} unfilled pixels remain`);

    for (let i = 0; i < temp.length; i++) {
      const t = temp[i]!;
      if (t < globalMin) globalMin = t;
      if (t > globalMax) globalMax = t;
    }
    fields.push({ temp, land });
    process.stdout.write(`  month ${String(m + 1).padStart(2, '0')} ok\r`);
  }

  const total = W * H * MONTHS;
  const pct = (n: number) => `${((100 * n) / total).toFixed(2)}%`;
  console.log(
    `  tiers: cruts ${pct(tally.land)}  wc2.1 ${pct(tally.fallback)}  ` +
      `oisst ${pct(tally.ocean)}  ` +
      `grown from sea ${tally.grownSea / MONTHS} px, from land ${tally.grownLand / MONTHS} px`,
  );
  // The whole point of the fallback is that the land mask does not move: every pixel the 1970-2000
  // climatology called land is still land, just possibly from the other tier. If this ever fails,
  // the newer series has grown past the old one and the fallback is no longer a strict subset.
  if (tally.land + tally.fallback !== tally.baseLand) {
    throw new Error(
      `land mask moved: ${tally.land} + ${tally.fallback} from tiers, ` +
        `but the 1970-2000 climatology has ${tally.baseLand}`,
    );
  }
  console.log(`  observed range ${globalMin.toFixed(2)}..${globalMax.toFixed(2)} degC`);
  // Silent clamping is the kind of thing nobody notices until a whole continent reads as one flat
  // colour, so fail loudly instead and make widening the constants a deliberate act.
  if (globalMin < T_MIN || globalMax > T_MAX) {
    throw new Error(
      `data spans ${globalMin.toFixed(2)}..${globalMax.toFixed(2)} but the encoding covers ` +
        `${T_MIN}..${T_MAX} - widen T_MIN/T_MAX rather than clamping`,
    );
  }
  console.log(`  encoding ${T_MIN}..${T_MAX} degC, step ${((T_MAX - T_MIN) / 255).toFixed(3)} - nothing clamped`);

  // -------------------------------------------------------------------------------------------
  // encode
  //
  // R = temperature, quantised to 8 bits across [T_MIN, T_MAX]. Deliberately NOT a 16-bit value
  // split across two channels: the GPU bilinear-filters this texture, and interpolating a high byte
  // across a step boundary produces garbage colours. One 8-bit channel filters correctly. The cost
  // is 0.44 degC of quantisation, invisible in a heat map.
  // G = land mask, so the shader and the hover readout can tell air temp from sea surface temp.
  // -------------------------------------------------------------------------------------------
  console.log('\nencode');
  let bytes = 0;
  for (let m = 0; m < MONTHS; m++) {
    const { temp, land } = fields[m]!;
    const png = new PNG({ width: W, height: H });
    for (let i = 0; i < W * H; i++) {
      const t = Math.min(Math.max(temp[i]!, T_MIN), T_MAX);
      const o = i * 4;
      png.data[o] = Math.round(((t - T_MIN) / (T_MAX - T_MIN)) * 255);
      png.data[o + 1] = land[i]!;
      png.data[o + 2] = 0;
      png.data[o + 3] = 255;
    }
    const buf = PNG.sync.write(png, { deflateLevel: 9, filterType: -1 });
    const name = `tavg_${String(m + 1).padStart(2, '0')}.png`;
    await writeFile(path.join(OUT, name), buf);
    stamp.update(buf);
    bytes += buf.length;
    process.stdout.write(`  ${name}  ${mb(buf.length)}          \r`);
  }
  console.log(`  12 PNGs, ${mb(bytes)} total                    `);

  const period = `${CLIM_FROM}–${CLIM_TO}`;
  const meta = {
    width: W,
    height: H,
    months: MONTHS,
    terrain: { width: REL_W, height: REL_H, flat: RELIEF_FLAT, scale: reliefScale },
    elevation: { width: ELEV_W, height: ELEV_H, maxMetres: ELEV_MAX_M, peakMetres: round2(elevMaxM) },
    tMin: T_MIN,
    tMax: T_MAX,
    encoding: 'R = (T - tMin) / (tMax - tMin) * 255; G = land mask (255 land / 0 water)',
    version: stamp.digest('hex').slice(0, 16),
    quantisationC: round2((T_MAX - T_MIN) / 255),
    observed: { min: round2(globalMin), max: round2(globalMax) },
    monthLabels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    sources: [
      {
        layer: 'land',
        name: 'WorldClim 2.1 / CRU-TS 4.09',
        period,
        quantity: '2 m air temperature',
      },
      {
        layer: 'antarctica',
        name: 'WorldClim 2.1 tavg 10′',
        period: '1970–2000',
        quantity: '2 m air temperature',
      },
      {
        layer: 'ocean',
        name: 'NOAA OISST v2.1',
        period,
        quantity: 'sea surface temperature',
      },
      {
        layer: 'relief',
        name: 'Natural Earth shaded relief 10m',
        period: 'SRTM Plus',
        quantity: 'hillshade and coastline',
      },
      {
        layer: 'height',
        name: 'NOAA ETOPO 2022 60″',
        period: '2022',
        quantity: 'surface elevation',
      },
    ],
  };
  await writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));

  // -------------------------------------------------------------------------------------------
  // spot checks - a wrong longitude roll would lay the Pacific over Africa, and these catch it
  // -------------------------------------------------------------------------------------------
  console.log('\nspot checks (degC, pre-clamp)');
  const sample = (m: number, lon: number, lat: number) => {
    const x = Math.min(W - 1, Math.floor(((lon + 180) / 360) * W));
    const y = Math.min(H - 1, Math.floor(((90 - lat) / 180) * H));
    const f = fields[m]!;
    return { t: f.temp[y * W + x]!, land: f.land[y * W + x] === 255 };
  };
  const checks: [string, number, number, number, number, number][] = [
    // name, lon, lat, month (0-based), expected low, expected high
    ['Sahara, July', 2, 25, 6, 30, 42],
    ['Amazon, July', -60, -3, 6, 22, 30],
    ['Siberia (Yakutsk), Jan', 129.7, 62, 0, -50, -30],
    ['South Pole, July', 0, -89, 6, -70, -50],
    ['mid Atlantic 20N, Jan', -30, 20, 0, 18, 26],
    ['equatorial Pacific, Jan', -140, 0, 0, 22, 30],
    ['North Sea, Jan', 3, 56, 0, 2, 10],
    ['Stockholm, July', 18, 59.3, 6, 12, 22],
  ];
  let failed = 0;
  for (const [name, lon, lat, m, lo, hi] of checks) {
    const { t, land } = sample(m, lon, lat);
    const ok = t >= lo && t <= hi;
    if (!ok) failed++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(26)} ${t.toFixed(1).padStart(6)}  ` +
        `(${land ? 'land' : 'water'}, expected ${lo}..${hi})`,
    );
  }
  if (failed > 0) throw new Error(`${failed} spot check(s) failed - georeferencing is wrong`);
  console.log('\nall checks passed\n');
}

main().catch((err) => {
  console.error('\nbuild-data failed:', err);
  process.exit(1);
});
