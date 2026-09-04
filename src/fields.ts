import type { Field } from './field';
import { monthToDayOfYear } from './calendar';
import { dayLength, solarDeclination, formatDuration } from './sun';

/**
 * The two quantities the globe can draw, and every place they differ.
 *
 * Adding a second field to something built for one is where display code usually sprouts `if
 * (daylight)` branches in a dozen places — the shader, the legend ticks, the auto-exposure, the
 * hover readout. Collecting the differences into one descriptor keeps them countable: everything
 * below is something that genuinely differs between a temperature and a duration, and nothing else
 * in the app needs to know which of the two it is showing.
 *
 * The two are deliberately not the same *kind* of thing, and the descriptor says so. Temperature is
 * measured, quantised to 8 bits, and sampled from a texture. Day length is computed — exactly, and
 * from two numbers — so it needs no data, no dither and no interpolation.
 */

export type FieldId = 'temperature' | 'daylight';

export interface FieldSpec {
  id: FieldId;
  /** Chip label in the console. */
  label: string;
  /** The full-range window: what "absolute" means for this quantity. */
  min: number;
  max: number;
  /**
   * The value a diverging ramp welds its midpoint to.
   *
   * 0 °C for temperature, so thermal's white band draws the freezing line. 12 hours for daylight,
   * which is the equinox — the same claim ("this midpoint means something") about a different
   * quantity, and the reason the existing `zeroSplit` needed only a pivot argument to generalise.
   */
  pivot: number;
  /** How the pivot marker labels itself when a sequential palette gives up the reference. */
  pivotLabel: string;
  /** Never window tighter than this; below it, noise and quantisation start to dominate. */
  minSpan: number;
  /**
   * Legend tick text — must stay short, five of them share the bar's width.
   *
   * Takes the window's span as well as the value because the right precision depends on it: whole
   * hours are fine across a full year but collapse to "14h, 14h, 15h" once a relative window has
   * narrowed to a couple of hours, which tells the reader nothing.
   */
  tick(v: number, span: number): string;
  /** The hover readout's headline. */
  headline(v: number): string;
  /** What the headline is, for the line under it. */
  kind(isLand: boolean): string;
  /** Value at a point, 0–255, for the auto-exposure histogram. */
  sampleByte(lon: number, lat: number, month: number): number;
}

/** Rounded, with an explicit sign — a legend tick has to read as a temperature, not a count. */
function tempTick(v: number): string {
  const n = Math.round(v);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`;
}

export function fieldSpecs(field: Field, months: number): Record<FieldId, FieldSpec> {
  const { tMin, tMax } = field.meta;

  return {
    temperature: {
      id: 'temperature',
      label: 'temp',
      min: tMin,
      max: tMax,
      pivot: 0,
      pivotLabel: '0°',
      minSpan: 4,
      tick: (v) => tempTick(v),
      headline: (v) => `${v.toFixed(1)} °C`,
      kind: (isLand) => (isLand ? 'land · 2 m air' : 'ocean · sea surface'),
      sampleByte: (lon, lat, month) => field.sampleByte(lon, lat, month),
    },

    daylight: {
      id: 'daylight',
      label: 'daylight',
      min: 0,
      max: 24,
      pivot: 12,
      pivotLabel: '12h',
      // An hour is already a coarse slice of a 24-hour range; windowing tighter than that turns the
      // gentle latitude gradient near an equinox into banding.
      minSpan: 1,
      tick: (v, span) => (span < 6 ? `${v.toFixed(1)}h` : `${Math.round(v)}h`),
      headline: formatDuration,
      // Day length is a fact about the sky, not the surface, so it says the same over sea as land.
      kind: () => 'daylight · sunrise to sunset',
      // Declination is recomputed per sample rather than hoisted: the histogram runs 1344 rays a
      // frame and this is a dozen trig calls against a raycast, which is not where the time goes.
      sampleByte: (_lon, lat, month) =>
        (dayLength(lat, solarDeclination(monthToDayOfYear(month, months))) / 24) * 255,
    },
  };
}
