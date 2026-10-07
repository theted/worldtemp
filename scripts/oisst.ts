/**
 * NOAA OISST v2.1 monthly means, averaged over a run of whole years into twelve monthly normals.
 *
 * v2.1 is the 0.25-degree daily analysis that replaced OISST v2 in 2020, when v2's own inputs were
 * discontinued and its 1-degree weekly product stopped. PSL publishes its monthly means as a single
 * NetCDF-4 file from September 1981 to last month, appended in place, so the same file serves any
 * window -- which is the point: the ocean can then be averaged over exactly the years the land is.
 *
 * NetCDF-4 is HDF5 underneath, and h5wasm's Node build reads it straight off the disk, so only the
 * months the window needs are ever decoded: about 60 ms each, against two gigabytes on disk.
 */

import h5wasm, { type File } from 'h5wasm/node';

/** A regular lon/lat grid of twelve monthly means. */
export interface SstNormals {
  /** One raster per calendar month, south row first, NaN wherever there is no sea. */
  months: Float32Array[];
  ni: number;
  nj: number;
  /** Centre of cell (0, 0), in degrees east (0..360) and north. */
  lon0: number;
  lat0: number;
  /** Cell size in degrees, the same on both axes. */
  step: number;
}

const MONTHS = 12;
const DAY_MS = 86_400_000;

/** `time` counts days from here. */
const EPOCH = Date.UTC(1800, 0, 1);

/** A calendar month as one integer, `year * 12 + month`, so a window is a contiguous range. */
const monthKey = (days: number) => {
  const d = new Date(EPOCH + days * DAY_MS);
  return d.getUTCFullYear() * MONTHS + d.getUTCMonth();
};

const dataset = (f: File, name: string) => {
  const d = f.get(name);
  if (!(d instanceof h5wasm.Dataset)) throw new Error(`OISST: no '${name}' dataset`);
  return d;
};

/**
 * The axis's first centre and spacing, after checking it really is evenly spaced.
 *
 * The composite samples the grid by arithmetic rather than by searching the coordinates, so an
 * axis that was not regular would put every value in the wrong place without any error at all.
 */
const regularAxis = (name: string, v: Float32Array) => {
  const step = v[1]! - v[0]!;
  const off = v.findIndex((x, i) => Math.abs(x - (v[0]! + i * step)) > 1e-3);
  if (off >= 0) throw new Error(`OISST ${name} is not evenly spaced at index ${off}`);
  return { first: v[0]!, step };
};

/** Twelve monthly means over the whole years `from`..`to`, failing if the file does not reach. */
export const readOisstNormals = async (
  file: string,
  from: number,
  to: number,
): Promise<SstNormals> => {
  await h5wasm.ready;
  const f = new h5wasm.File(file, 'r');
  try {
    const sst = dataset(f, 'sst');
    const [, nj, ni] = sst.shape as [number, number, number];
    const lat = regularAxis('lat', dataset(f, 'lat').value as Float32Array);
    const lon = regularAxis('lon', dataset(f, 'lon').value as Float32Array);
    if (Math.abs(lat.step - lon.step) > 1e-6) throw new Error('OISST cells are not square');

    const missing = (sst.attrs.missing_value?.value as Float32Array | undefined)?.[0];
    const time = dataset(f, 'time').value as Float64Array;
    const index = new Map(Array.from(time, (days, t) => [monthKey(days), t]));

    const years = to - from + 1;
    const sum = Array.from({ length: MONTHS }, () => new Float32Array(ni * nj));
    const count = Array.from({ length: MONTHS }, () => new Uint8Array(ni * nj));

    for (let year = from; year <= to; year++) {
      for (let m = 0; m < MONTHS; m++) {
        const t = index.get(year * MONTHS + m);
        if (t === undefined) {
          const ym = `${year}-${String(m + 1).padStart(2, '0')}`;
          throw new Error(`OISST has no ${ym}; the file ends earlier`);
        }
        const raster = sst.slice([[t, t + 1], [], []]) as Float32Array;
        const s = sum[m]!;
        const c = count[m]!;
        raster.forEach((v, i) => {
          if (v === missing || !Number.isFinite(v)) return;
          s[i] += v;
          c[i]++;
        });
      }
      const done = (year - from + 1) * MONTHS;
      process.stdout.write(`  oisst    ${done}/${years * MONTHS} months (${year})   \r`);
    }

    // OISST keeps one land mask for its whole record, so a cell is sea in every month or in none.
    // One that is not would be averaged over fewer years than its neighbours, silently.
    let partial = 0;
    const months = sum.map((s, m) =>
      s.map((v, i) => {
        const n = count[m]![i]!;
        if (n === years) return v / years;
        if (n > 0) partial++;
        return NaN;
      }),
    );
    if (partial > 0) {
      throw new Error(`${partial} OISST cell-months have an incomplete ${from}-${to} record`);
    }

    console.log(
      `  oisst    ${years * MONTHS} months -> 12 monthly means over ${from}-${to}, ${ni}x${nj}   `,
    );
    return { months, ni, nj, lon0: lon.first, lat0: lat.first, step: lat.step };
  } finally {
    f.close();
  }
};
