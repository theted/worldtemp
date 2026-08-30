/**
 * Bakes monthly average-temperature climatology into 12 PNGs the app serves locally.
 *
 * Two sources are composited onto one 2160x1080 equirectangular grid:
 *
 *   1. WorldClim 2.1 `tavg` 10' (1970-2000)  - 2 m air temperature, land only, ~18 km
 *   2. NOAA OISST v2 LTM (1991-2020)         - sea surface temperature, ocean only, 1 deg
 *
 * These two masks turn out to be exact complements: measured over all 12 months, the land tier
 * claims 34.64% of pixels and the ocean tier the remaining 65.36%, with zero left over. A dilation
 * pass is kept as graceful degradation in case a future data revision shifts a coastline, and the
 * script asserts zero unfilled pixels before writing -- a hole would render as a hard artifact.
 *
 * Downloads are cached in data/raw/ and gitignored; the derived PNGs are committed, so the app runs
 * after a clone with no network access at all.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fromArrayBuffer } from 'geotiff';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data/raw');
const OUT = path.join(ROOT, 'public/data');
const GEO = path.join(ROOT, 'public/geo');

/** Output grid: WorldClim 10-arcmin native resolution, so the land tier needs no resampling. */
const W = 2160;
const H = 1080;
const MONTHS = 12;

/** Encoding range. Antarctic plateau means fall below this and are clamped; the legend says so. */
const T_MIN = -50;
const T_MAX = 50;

/** OPeNDAP writes -9.96921e36 for absent cells; anything this large in magnitude is a sentinel. */
const SENTINEL = 1e30;
const isMissing = (v: number) => !Number.isFinite(v) || Math.abs(v) > SENTINEL;

const SOURCES = {
  worldclim: {
    url: 'https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_tavg.zip',
    file: 'wc2.1_10m_tavg.zip',
  },
  sst: {
    url: 'https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.oisst.v2/sst.ltm.1991-2020.nc.ascii?sst',
    file: 'sst.ltm.ascii',
  },
  borders: {
    url: 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json',
    file: 'countries-110m.json',
  },
} as const;

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------
// fetching
// ---------------------------------------------------------------------------------------------

async function download(url: string, dest: string): Promise<Buffer> {
  try {
    const s = await stat(dest);
    if (s.size > 0) {
      console.log(`  cached  ${path.basename(dest)} (${mb(s.size)})`);
      return readFile(dest);
    }
  } catch {
    /* not cached yet */
  }
  console.log(`  fetch   ${path.basename(dest)} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`          -> ${mb(buf.length)}`);
  return buf;
}

// ---------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------

/**
 * Reads an OPeNDAP `.ascii` 3-D grid into a flat array indexed [t][j][i].
 *
 * The body is one line per (time, latitude) row, prefixed `[t][j], ` and followed by `ni` comma
 * separated values. The file also appends the coordinate MAPS (time/lat/lon) after the grid; those
 * are 1-D and don't match the row prefix, so filtering on it skips them. Every expected row must
 * appear, which is what catches a truncated download.
 */
function parseOpendapGrid(text: string, nt: number, nj: number, ni: number): Float32Array {
  const out = new Float32Array(nt * nj * ni);
  const seen = new Uint8Array(nt * nj);
  const rowRe = /^\[(\d+)\]\[(\d+)\],\s*(.*)$/;

  for (const line of text.split('\n')) {
    const m = rowRe.exec(line);
    if (!m) continue;
    const t = Number(m[1]);
    const j = Number(m[2]);
    if (t >= nt || j >= nj) continue;
    const vals = m[3]!.split(',');
    if (vals.length !== ni) {
      throw new Error(`row [${t}][${j}]: ${vals.length} values, expected ${ni}`);
    }
    const base = (t * nj + j) * ni;
    for (let i = 0; i < ni; i++) out[base + i] = Number(vals[i]);
    seen[t * nj + j] = 1;
  }

  const absent = seen.reduce<number>((a, b) => a + (b ? 0 : 1), 0);
  if (absent > 0) {
    throw new Error(`OPeNDAP grid incomplete: ${absent}/${nt * nj} rows absent (bad download?)`);
  }
  return out;
}

/** Reads the 12 monthly GeoTIFFs out of the WorldClim zip, verifying the grid matches our output. */
async function readWorldClim(zipBuf: Buffer): Promise<{ months: Float32Array[]; nodata: number }> {
  const zip = new AdmZip(zipBuf);
  const months: Float32Array[] = [];
  let nodata = -3.4e38;

  for (let m = 1; m <= MONTHS; m++) {
    const name = `wc2.1_10m_tavg_${String(m).padStart(2, '0')}.tif`;
    const entry = zip.getEntry(name);
    if (!entry) throw new Error(`missing ${name} in WorldClim zip`);
    const b = entry.getData();
    // Node hands back a Buffer over a pooled (possibly shared) allocation; copy into a plain
    // ArrayBuffer so geotiff gets an exclusive, correctly typed view.
    const ab = new ArrayBuffer(b.byteLength);
    new Uint8Array(ab).set(b);
    const tiff = await fromArrayBuffer(ab);
    const img = await tiff.getImage();
    if (img.getWidth() !== W || img.getHeight() !== H) {
      throw new Error(`${name}: ${img.getWidth()}x${img.getHeight()}, expected ${W}x${H}`);
    }
    const nd = img.getGDALNoData();
    if (nd !== null) nodata = nd;
    const [raster] = await img.readRasters();
    months.push(raster as Float32Array);
  }
  return { months, nodata };
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
  await mkdir(RAW, { recursive: true });
  await mkdir(OUT, { recursive: true });
  await mkdir(GEO, { recursive: true });

  console.log('\nsources');
  const [wcBuf, sstTxt] = await Promise.all([
    download(SOURCES.worldclim.url, path.join(RAW, SOURCES.worldclim.file)),
    download(SOURCES.sst.url, path.join(RAW, SOURCES.sst.file)).then((b) => b.toString('utf8')),
    // written straight into public/geo for the border overlay
    download(SOURCES.borders.url, path.join(GEO, SOURCES.borders.file)),
  ]);

  console.log('\ndecode');
  const { months: wc, nodata } = await readWorldClim(wcBuf);
  console.log(`  worldclim  12 x ${W}x${H}  nodata=${nodata}`);

  // OISST: lon centres 0.5..359.5 measured eastward, lat centres 89.5..-89.5 north to south.
  // Latitude already runs the same direction as image rows; longitude does not, hence the shift.
  const SST_NI = 360;
  const SST_NJ = 180;
  const sst = parseOpendapGrid(sstTxt, MONTHS, SST_NJ, SST_NI);
  console.log(`  oisst      12 x ${SST_NI}x${SST_NJ}`);

  console.log('\ncomposite');
  const tally = { land: 0, ocean: 0, dilated: 0 };
  const fields: { temp: Float32Array; land: Uint8Array }[] = [];
  let globalMin = Infinity;
  let globalMax = -Infinity;
  let clampedLow = 0;

  for (let m = 0; m < MONTHS; m++) {
    const wcM = wc[m]!;
    const temp = new Float32Array(W * H);
    const land = new Uint8Array(W * H);
    const filled = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
      const lat = 90 - ((y + 0.5) * 180) / H;
      const sstFy = 89.5 - lat; // OISST row centres are 1 deg apart starting at 89.5

      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const lon = -180 + ((x + 0.5) * 360) / W;
        const lonE = ((lon % 360) + 360) % 360; // OISST indexes eastward from 0

        // land
        const v = wcM[idx]!;
        if (!isMissing(v) && v !== nodata) {
          temp[idx] = v;
          land[idx] = 255;
          filled[idx] = 1;
          tally.land++;
          continue;
        }

        // ocean
        const s = bilinear(
          (j, i) => sst[(m * SST_NJ + j) * SST_NI + i]!,
          SST_NI,
          SST_NJ,
          lonE - 0.5,
          sstFy,
        );
        if (Number.isFinite(s)) {
          temp[idx] = s;
          land[idx] = 0;
          filled[idx] = 1;
          tally.ocean++;
        }
      }
    }

    // Graceful degradation: if a future data revision moves a coastline, grow the field into the
    // gap from its neighbours. Averaging already-filled neighbours is continuous by construction,
    // so a healed fringe shows no seam. Currently a no-op -- the two masks tile the globe exactly.
    for (let pass = 0; pass < 12; pass++) {
      const todo: number[] = [];
      for (let i = 0; i < filled.length; i++) if (!filled[i]) todo.push(i);
      if (todo.length === 0) break;

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
            if (filled[nIdx]) {
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
      let grew = 0;
      for (let k = 0; k < todo.length; k++) {
        if (!grownOk[k]) continue;
        const idx = todo[k]!;
        temp[idx] = grownTemp[k]!;
        land[idx] = 0;
        filled[idx] = 1;
        grew++;
        tally.dilated++;
      }
      if (grew === 0) break;
    }

    let holes = 0;
    for (let i = 0; i < filled.length; i++) if (!filled[i]) holes++;
    if (holes > 0) throw new Error(`month ${m + 1}: ${holes} unfilled pixels remain`);

    for (let i = 0; i < temp.length; i++) {
      const t = temp[i]!;
      if (t < globalMin) globalMin = t;
      if (t > globalMax) globalMax = t;
      if (t < T_MIN) clampedLow++;
    }
    fields.push({ temp, land });
    process.stdout.write(`  month ${String(m + 1).padStart(2, '0')} ok\r`);
  }

  const total = W * H * MONTHS;
  const pct = (n: number) => `${((100 * n) / total).toFixed(2)}%`;
  console.log(
    `  tiers: worldclim ${pct(tally.land)}  oisst ${pct(tally.ocean)}  dilated ${tally.dilated} px`,
  );
  console.log(`  observed range ${globalMin.toFixed(2)}..${globalMax.toFixed(2)} degC`);
  console.log(`  clamped below ${T_MIN}: ${pct(clampedLow)} (Antarctic plateau)`);

  // -------------------------------------------------------------------------------------------
  // encode
  //
  // R = temperature, quantised to 8 bits across [-50, 50]. Deliberately NOT a 16-bit value split
  // across two channels: the GPU bilinear-filters this texture, and interpolating a high byte
  // across a step boundary produces garbage colours. One 8-bit channel filters correctly. The cost
  // is 0.39 degC of quantisation, invisible in a heat map.
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
    bytes += buf.length;
    process.stdout.write(`  ${name}  ${mb(buf.length)}          \r`);
  }
  console.log(`  12 PNGs, ${mb(bytes)} total                    `);

  const meta = {
    width: W,
    height: H,
    months: MONTHS,
    tMin: T_MIN,
    tMax: T_MAX,
    encoding: 'R = (T - tMin) / (tMax - tMin) * 255; G = land mask (255 land / 0 water)',
    quantisationC: round2((T_MAX - T_MIN) / 255),
    observed: { min: round2(globalMin), max: round2(globalMax) },
    monthLabels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    sources: [
      {
        layer: 'land',
        name: 'WorldClim 2.1 tavg 10′',
        period: '1970–2000',
        quantity: '2 m air temperature',
      },
      {
        layer: 'ocean',
        name: 'NOAA OISST v2 long-term mean',
        period: '1991–2020',
        quantity: 'sea surface temperature',
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
    ['South Pole, July', 0, -89, 6, -70, -50], // encoding floors this at -50
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
