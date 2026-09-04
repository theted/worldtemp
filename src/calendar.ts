/**
 * The month axis: how the scrubber's continuous position maps to a day of the year, and back.
 *
 * This lives apart from the UI because three different consumers need the same answer and must not
 * disagree: the date printed beside the slider, the sun times in the hover readout, and the solar
 * declination the shader uses to draw the daylight field. If any of them derived the day of year
 * on its own, the globe could show one date's daylight while the console claimed another's.
 */

/** Day-of-year of the 15th of each month, in a non-leap year. */
const MID_MONTH_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

/**
 * The continuous month position as a day of the year, 1–365.
 *
 * Monthly means describe a whole month, so the honest reading of "January" is its midpoint — which
 * makes month 0.5 land near 1 February, not 16 January. Interpolating between mid-month anchors is
 * what makes the scrub legible: the reader can see the globe is between two samples.
 */
export function monthToDayOfYear(month: number, months: number): number {
  const m = ((month % months) + months) % months;
  const i0 = Math.floor(m);
  const i1 = (i0 + 1) % months;
  const f = m - i0;

  const d0 = MID_MONTH_DOY[i0] ?? 15;
  let d1 = MID_MONTH_DOY[i1] ?? 15;
  if (d1 < d0) d1 += 365;

  return ((Math.round(d0 + (d1 - d0) * f) - 1) % 365) + 1;
}

/**
 * Renders the continuous month position as an approximate calendar date.
 *
 * Shares `monthToDayOfYear` with the sun times, so the sunrise shown under the cursor is always the
 * sunrise for the date printed beside the scrubber — the two cannot drift apart.
 */
export function monthToDateLabel(month: number, months: number, labels: string[]): string {
  const date = new Date(Date.UTC(2001, 0, 1)); // 2001 is not a leap year
  date.setUTCDate(monthToDayOfYear(month, months));
  return `${date.getUTCDate()} ${labels[date.getUTCMonth()] ?? ''}`;
}

/**
 * Today's date as a continuous month position — the inverse of `monthToDateLabel`.
 *
 * Opening on the current date rather than on January makes the globe show the season you are
 * actually in. Since a monthly mean is centred mid-month, a date in late August sits most of the
 * way from the August sample toward the September one, not at "August".
 */
export function dateToMonth(date: Date, months: number): number {
  const year = date.getUTCFullYear();
  const dayOfYear =
    Math.floor(
      (Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(year, 0, 1)) / 86400000,
    ) + 1;

  for (let i = 0; i < months; i++) {
    const d0 = MID_MONTH_DOY[i] ?? 15;
    let d1 = MID_MONTH_DOY[(i + 1) % months] ?? 15;
    if (d1 < d0) d1 += 365; // the December → January bracket wraps the year end
    const d = dayOfYear < d0 ? dayOfYear + 365 : dayOfYear;
    if (d >= d0 && d <= d1) return i + (d - d0) / (d1 - d0);
  }
  return 0;
}
