/**
 * Sunrise, sunset and day length for a latitude and a day of the year.
 *
 * Reported in **local mean solar time** — the clock you would get by putting noon where the sun is
 * actually highest. That is a deliberate choice over civil time. A Stockholm sunrise "at 03:30" in
 * June says more about Sweden sitting an hour west of its own timezone, plus another hour of summer
 * time, than about the sky; strip both away and the number describes the place. It also means no
 * timezone database has to be shipped, and — pleasingly — no longitude is needed at all: the
 * geometry below depends only on latitude and the sun's declination.
 *
 * The declination and equation-of-time fits are Spencer's (1971) Fourier series, the same pair the
 * NOAA solar calculator uses. They are good to roughly 0.2° and half a minute respectively, which
 * is far inside the honesty budget of a readout built on *monthly mean* temperatures.
 */

const DEG = Math.PI / 180;

/**
 * Zenith angle of the sun's centre at the moment we call sunrise: 90.833°, not 90°.
 *
 * Two corrections push it past the geometric horizon. Atmospheric refraction lifts the sun's image
 * by about 34 arcminutes, so it is already visible while still geometrically below; and sunrise is
 * the first sight of the *upper limb*, another 16 arcminutes of semi-diameter. Together, 50′.
 */
export const SUNRISE_ZENITH_DEG = 90.833;
const SUNRISE_ZENITH = SUNRISE_ZENITH_DEG * DEG;

export type DayKind = 'normal' | 'midnight-sun' | 'polar-night';

export interface SunTimes {
  /** Local mean solar time of sunrise, in hours after midnight; null when the sun never rises. */
  sunrise: number | null;
  /** Local mean solar time of sunset, in hours after midnight; null when the sun never sets. */
  sunset: number | null;
  /** Hours between sunrise and sunset: 0 through a polar night, 24 under the midnight sun. */
  daylight: number;
  kind: DayKind;
}

/**
 * Cosine of the hour angle at which the sun reaches the sunrise zenith.
 *
 * The single place this formula is written down, because its two callers want opposite things from
 * it. `sunTimes` needs the out-of-range cases *preserved*: no solution means the sun's daily circle
 * never crosses the horizon, which is precisely how a polar night is detected. `dayLength` wants
 * them clamped, since 0 and 24 hours are the right answers there and it has no phrase to print.
 *
 * The denominator is floored rather than left to divide by zero at the poles, where cos(phi)
 * vanishes: the numerator's sign then carries the answer to the correct extreme on its own.
 */
function cosHourAngle(latDeg: number, declination: number): number {
  const phi = latDeg * DEG;
  return (
    (Math.cos(SUNRISE_ZENITH) - Math.sin(phi) * Math.sin(declination)) /
    Math.max(Math.cos(phi) * Math.cos(declination), 1e-6)
  );
}

/**
 * Hours between sunrise and sunset — the branchless twin of `sunTimes().daylight`.
 *
 * Takes a declination rather than a day of the year because it runs per sample over a whole
 * hemisphere, and the declination is constant across all of them. The globe's fragment shader
 * computes this identically; see FRAGMENT in globe.ts, which interpolates the same zenith constant.
 */
export function dayLength(latDeg: number, declination: number): number {
  const c = Math.min(Math.max(cosHourAngle(latDeg, declination), -1), 1);
  return (24 / Math.PI) * Math.acos(c);
}

/** The sun's declination in radians for a day of the year — the shader's `uDecl`. */
export function solarDeclination(dayOfYear: number): number {
  return solarGeometry(dayOfYear).declination;
}

/**
 * The sun's declination and the equation of time for a day, evaluated at local noon.
 *
 * Both are functions of one angle: how far round its orbit the Earth is. Declination is why there
 * are seasons at all — it is the latitude the sun stands overhead, swinging ±23.44° across the
 * year. The equation of time is the gap between the sundial and a uniform clock, produced by the
 * orbit's eccentricity and the tilt together; it is what makes the analemma a figure of eight.
 */
function solarGeometry(dayOfYear: number) {
  // NOAA's fractional year, in radians, at the middle of the day (its (hour − 12)/24 term is zero).
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const [c1, s1] = [Math.cos(g), Math.sin(g)];
  const [c2, s2] = [Math.cos(2 * g), Math.sin(2 * g)];
  const [c3, s3] = [Math.cos(3 * g), Math.sin(3 * g)];

  const declination =
    0.006918 -
    0.399912 * c1 +
    0.070257 * s1 -
    0.006758 * c2 +
    0.000907 * s2 -
    0.002697 * c3 +
    0.00148 * s3;

  // 229.18 converts radians of hour angle to minutes of time (1440 min / 2π).
  const equationOfTime =
    229.18 * (0.000075 + 0.001868 * c1 - 0.032077 * s1 - 0.014615 * c2 - 0.040849 * s2);

  return { declination, equationOfTime };
}

/** Sunrise, sunset and day length at a latitude on a given day of the year (1–365). */
export function sunTimes(lat: number, dayOfYear: number): SunTimes {
  const { declination: dec, equationOfTime: eot } = solarGeometry(dayOfYear);

  // Solar noon drifts around 12:00 by the equation of time: when the sundial runs ahead of the
  // clock the sun peaks early, so the correction is subtracted.
  const noon = 12 - eot / 60;

  // Where the sun's daily circle never crosses the horizon there is no solution, and that *is* the
  // polar case. Written negated so a NaN would fall into the polar-night branch rather than slip
  // through into acos() and poison the times.
  const cosHa = cosHourAngle(lat, dec);
  if (!(cosHa < 1)) {
    return { sunrise: null, sunset: null, daylight: 0, kind: 'polar-night' };
  }
  if (cosHa <= -1) {
    return { sunrise: null, sunset: null, daylight: 24, kind: 'midnight-sun' };
  }

  const halfDay = Math.acos(cosHa) / DEG / 15; // degrees of hour angle → hours, at 15°/h
  return {
    sunrise: wrapDay(noon - halfDay),
    sunset: wrapDay(noon + halfDay),
    daylight: halfDay * 2,
    kind: 'normal',
  };
}

/** Folds an hour-of-day back into [0, 24) — near the polar circles a time can fall off either end. */
function wrapDay(hours: number): number {
  return ((hours % 24) + 24) % 24;
}

/** An hour-of-day as 24-hour clock time: 5.7 → "05:42". */
export function formatClock(hours: number): string {
  let m = Math.round(wrapDay(hours) * 60);
  if (m === 1440) m = 0; // rounding up from 23:59:40 must land on midnight, not 24:00
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** A span of hours as "14h 16m", the way a day length reads. */
export function formatDuration(hours: number): string {
  const m = Math.round(hours * 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
