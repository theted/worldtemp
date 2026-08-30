import type { Field } from './field';
import type { Globe } from './globe';
import { rampCss, cssForTemp } from './ramp';
import { formatLonLat } from './geo';

/**
 * Chrome around the globe: title, legend, scrubber, and the hover readout.
 *
 * Every colour shown here comes from `ramp.ts`, the same module the shader samples, so the legend
 * is guaranteed to describe the picture rather than merely resemble it.
 */

/** Seconds for playback to traverse the full year. */
const YEAR_SECONDS = 12;

/** Slider resolution: hundredths of a month, fine enough that scrubbing reads as continuous. */
const STEPS_PER_MONTH = 100;

/** Day-of-year of the 15th of each month, in a non-leap year. */
const MID_MONTH_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

/**
 * Renders the continuous month position as an approximate calendar date.
 *
 * Monthly means describe a whole month, so the honest reading of "January" is its midpoint — which
 * makes month 0.5 land near 1 February, not 16 January. Showing a date rather than a month name is
 * what makes the interpolation legible: the reader can see the globe is between two samples.
 */
function monthToDateLabel(month: number, months: number, labels: string[]): string {
  const m = ((month % months) + months) % months;
  const i0 = Math.floor(m);
  const i1 = (i0 + 1) % months;
  const f = m - i0;

  const d0 = MID_MONTH_DOY[i0] ?? 15;
  let d1 = MID_MONTH_DOY[i1] ?? 15;
  if (d1 < d0) d1 += 365;

  const doy = ((Math.round(d0 + (d1 - d0) * f) - 1) % 365) + 1;
  const date = new Date(Date.UTC(2001, 0, 1)); // 2001 is not a leap year
  date.setUTCDate(doy);
  return `${date.getUTCDate()} ${labels[date.getUTCMonth()] ?? ''}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  html = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

export function mountUi(root: HTMLElement, globe: Globe, field: Field) {
  const { meta } = field;
  const months = meta.months;

  // ------------------------------------------------------------------------------------------
  // masthead
  // ------------------------------------------------------------------------------------------
  const header = el('header', 'pointer-events-none absolute left-0 top-0 p-6 md:p-8 select-none');
  header.innerHTML = `
    <h1 class="text-[13px] tracking-[0.42em] text-chalk">WORLDTEMP</h1>
    <p class="mt-1.5 text-[11px] tracking-[0.1em] text-haze">average monthly temperature</p>
    <div class="mt-5 h-px w-16 bg-edge"></div>
    <dl class="mt-4 space-y-1.5 text-[10px] leading-relaxed text-haze/85">
      ${meta.sources
        .map(
          (s) => `<div>
            <dt class="inline text-haze/60">${s.layer}</dt>
            <dd class="inline">&nbsp;· ${s.name} <span class="text-haze/60">${s.period}</span></dd>
          </div>`,
        )
        .join('')}
    </dl>`;
  root.appendChild(header);

  // ------------------------------------------------------------------------------------------
  // hover readout
  // ------------------------------------------------------------------------------------------
  const tip = el(
    'div',
    'panel pointer-events-none absolute z-20 hidden rounded-md px-3 py-2 shadow-xl shadow-black/50',
  );
  const tipTemp = el('div', 'flex items-baseline gap-2');
  const tipSwatch = el('span', 'inline-block size-2.5 shrink-0 rounded-[2px]');
  const tipValue = el('span', 'text-[17px] leading-none tabular-nums text-chalk');
  tipTemp.append(tipSwatch, tipValue);
  const tipKind = el('div', 'label mt-1.5');
  const tipCoords = el('div', 'mt-0.5 text-[10px] tabular-nums text-haze/70');
  tip.append(tipTemp, tipKind, tipCoords);
  root.appendChild(tip);

  // ------------------------------------------------------------------------------------------
  // bottom console: legend above, transport below
  // ------------------------------------------------------------------------------------------
  const console_ = el(
    'div',
    'absolute inset-x-0 bottom-0 flex justify-center p-4 md:p-6 pointer-events-none',
  );
  const panel = el(
    'div',
    'panel pointer-events-auto w-full max-w-xl rounded-lg px-5 py-4 shadow-2xl shadow-black/60',
  );

  // legend -------------------------------------------------------------------------------------
  const legend = el('div', 'mb-4');
  const bar = el('div', 'h-2 w-full rounded-[3px] ring-1 ring-inset ring-white/10');
  bar.style.background = rampCss();
  const ticks = el('div', 'relative mt-1.5 h-3');
  // The low end is labelled with an inequality because Antarctic plateau means genuinely go below
  // the encoded floor (observed minimum is about -68 C) and are clamped.
  const tickDefs: [number, string][] = [
    [0, `≤ ${meta.tMin}`],
    [0.25, '−25'],
    [0.5, '0'],
    [0.75, '+25'],
    [1, `+${meta.tMax}`],
  ];
  for (const [pos, text] of tickDefs) {
    const t = el('span', 'absolute -translate-x-1/2 text-[9px] tabular-nums text-haze/70', text);
    t.style.left = `${pos * 100}%`;
    ticks.appendChild(t);
  }
  const legendCap = el('div', 'label mb-1.5 flex justify-between');
  legendCap.innerHTML = `<span>degrees celsius</span><span class="text-haze/50">±${meta.quantisationC}° steps</span>`;
  legend.append(legendCap, bar, ticks);

  // transport ----------------------------------------------------------------------------------
  const transport = el('div', 'flex items-center gap-4');

  const play = el(
    'button',
    'grid size-9 shrink-0 place-items-center rounded-full border border-edge bg-white/[0.04] ' +
      'text-chalk transition hover:bg-white/10 focus-visible:outline focus-visible:outline-1 ' +
      'focus-visible:outline-offset-2 focus-visible:outline-haze',
  );
  play.type = 'button';

  const ICON_PLAY = `<svg viewBox="0 0 16 16" class="size-3.5 translate-x-px" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>`;
  const ICON_PAUSE = `<svg viewBox="0 0 16 16" class="size-3.5" fill="currentColor"><rect x="4" y="2.5" width="3" height="11" rx="1"/><rect x="9" y="2.5" width="3" height="11" rx="1"/></svg>`;

  const scrubWrap = el('div', 'min-w-0 flex-1');
  const scrub = el('input', 'scrub');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.max = String(months * STEPS_PER_MONTH);
  scrub.step = '1';
  scrub.value = '0';
  scrub.setAttribute('aria-label', 'month of year');

  const monthMarks = el('div', 'relative mt-0.5 h-3');
  for (let i = 0; i < months; i++) {
    const mark = el(
      'span',
      'absolute -translate-x-1/2 text-[9px] text-haze/45',
      meta.monthLabels[i]?.[0] ?? '',
    );
    mark.style.left = `${(i / months) * 100}%`;
    monthMarks.appendChild(mark);
  }
  scrubWrap.append(scrub, monthMarks);

  const dateOut = el('div', 'w-[4.5rem] shrink-0 text-right');
  const dateBig = el('div', 'text-[15px] leading-none tabular-nums text-chalk');
  const dateSub = el('div', 'label mt-1', 'climatology');
  dateOut.append(dateBig, dateSub);

  transport.append(play, scrubWrap, dateOut);
  panel.append(legend, transport);
  console_.appendChild(panel);
  root.appendChild(console_);

  // ------------------------------------------------------------------------------------------
  // behaviour
  // ------------------------------------------------------------------------------------------
  let playing = false;
  let last = performance.now();

  const setMonth = (m: number) => {
    const wrapped = ((m % months) + months) % months;
    globe.month = wrapped;
    scrub.value = String(Math.round(wrapped * STEPS_PER_MONTH));
    dateBig.textContent = monthToDateLabel(wrapped, months, meta.monthLabels);
  };

  const setPlaying = (on: boolean) => {
    playing = on;
    play.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
    play.setAttribute('aria-label', on ? 'pause' : 'play');
    last = performance.now();
  };

  play.addEventListener('click', () => setPlaying(!playing));
  // Grabbing the scrubber is an unambiguous request to take manual control.
  scrub.addEventListener('pointerdown', () => setPlaying(false));
  scrub.addEventListener('input', () => setMonth(Number(scrub.value) / STEPS_PER_MONTH));

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.key !== ' ') return;
    if (e.key === ' ') {
      e.preventDefault();
      setPlaying(!playing);
    } else if (e.key === 'ArrowRight') {
      setPlaying(false);
      setMonth(globe.month + (e.shiftKey ? 1 : 0.25));
    } else if (e.key === 'ArrowLeft') {
      setPlaying(false);
      setMonth(globe.month - (e.shiftKey ? 1 : 0.25));
    }
  });

  // Pointer position is tracked here rather than in the globe so the tooltip can be placed in page
  // coordinates; the globe reports only *what* is under the cursor, not where the cursor is.
  let px = 0;
  let py = 0;
  root.addEventListener('pointermove', (e) => {
    px = e.clientX;
    py = e.clientY;
  });

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    if (playing) setMonth(globe.month + (dt * months) / YEAR_SECONDS);

    const h = globe.hover;
    if (!h) {
      tip.classList.add('hidden');
      return;
    }
    const { celsius, isLand } = field.sampleAt(h.lon, h.lat, globe.month);
    tip.classList.remove('hidden');
    tipValue.textContent = `${celsius.toFixed(1)} °C`;
    tipSwatch.style.background = cssForTemp(celsius, meta.tMin, meta.tMax);
    tipKind.textContent = isLand ? 'land · 2 m air' : 'ocean · sea surface';
    tipCoords.textContent = formatLonLat(h.lon, h.lat);

    // Keep the card inside the viewport, flipping side and lifting it clear of the pointer.
    const w = tip.offsetWidth;
    const hgt = tip.offsetHeight;
    const left = px + 18 + w > innerWidth ? px - 18 - w : px + 18;
    const top = Math.min(Math.max(py - hgt / 2, 8), innerHeight - hgt - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  setPlaying(false);
  setMonth(0);
  requestAnimationFrame(frame);
}
