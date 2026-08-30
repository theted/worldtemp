import type { Field } from './field';
import type { Globe } from './globe';
import { rampCss, blendedCss, zeroPosition, PALETTES, paletteById } from './ramp';
import { formatLonLat } from './geo';

/**
 * Chrome around the globe: title, legend, scrubber, layers panel, and the hover readout.
 *
 * Every colour shown here comes from `ramp.ts`, the same module the shader samples, so the legend
 * is guaranteed to describe the picture rather than merely resemble it. That matters more now the
 * scale can move and the palette can change: with a relative window the legend's *numbers* are the
 * only thing telling you what a colour means.
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

const CHIP =
  'rounded border border-edge px-2 py-[3px] text-[9px] tracking-[0.16em] uppercase transition ' +
  'focus-visible:outline focus-visible:outline-1 focus-visible:outline-haze';
const CHIP_ON = 'bg-chalk/90 text-ink';
const CHIP_OFF = 'text-haze hover:bg-white/5';

export function mountUi(root: HTMLElement, globe: Globe, field: Field, initialMonth?: number) {
  const { meta } = field;
  const months = meta.months;

  // ------------------------------------------------------------------------------------------
  // masthead
  // ------------------------------------------------------------------------------------------
  const header = el(
    'header',
    'masthead pointer-events-none absolute left-0 top-0 z-10 p-6 md:p-8 select-none',
  );
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
  // bottom console
  // ------------------------------------------------------------------------------------------
  const console_ = el(
    'div',
    'absolute inset-x-0 bottom-0 z-10 flex justify-center p-4 md:p-6 pointer-events-none',
  );
  const panel = el(
    'div',
    'panel pointer-events-auto relative w-full max-w-xl rounded-lg px-5 py-4 shadow-2xl shadow-black/60',
  );

  // --- scale mode + layers button ---------------------------------------------------------------
  const modes = el('div', 'flex divide-x divide-edge overflow-hidden rounded border border-edge');
  const modeBtnClass =
    'px-2 py-[3px] text-[9px] tracking-[0.16em] uppercase transition ' +
    'focus-visible:outline focus-visible:outline-1 focus-visible:outline-haze';
  const btnAbs = el('button', modeBtnClass, 'absolute');
  const btnRel = el('button', modeBtnClass, 'relative');
  btnAbs.type = 'button';
  btnRel.type = 'button';
  modes.append(btnAbs, btnRel);

  const btnLayers = el('button', `${CHIP} ${CHIP_OFF}`, 'layers');
  btnLayers.type = 'button';
  btnLayers.setAttribute('aria-expanded', 'false');

  const controls = el('div', 'flex items-center gap-2');
  controls.append(modes, btnLayers);

  const legendCap = el('div', 'mb-1.5 flex items-center justify-between gap-3');
  const legendNote = el('span', 'label');
  legendCap.append(controls, legendNote);

  // --- layers popover ---------------------------------------------------------------------------
  const pop = el(
    'div',
    'panel absolute bottom-full left-0 mb-2 hidden w-[17.5rem] rounded-lg px-4 py-3.5 shadow-2xl shadow-black/70',
  );

  const paletteRow = el('div', 'mt-1.5 flex flex-wrap gap-1.5');
  const paletteBtns = PALETTES.map((p) => {
    const b = el('button', `${CHIP} ${CHIP_OFF}`, p.label);
    b.type = 'button';
    b.addEventListener('click', () => setPalette(p.id));
    paletteRow.appendChild(b);
    return { id: p.id, el: b };
  });

  const showRow = el('div', 'mt-1.5 flex flex-wrap gap-1.5');
  const layerDefs = [
    { key: 'labels', label: 'names' },
    { key: 'borders', label: 'borders' },
    { key: 'relief', label: 'relief' },
    { key: 'stars', label: 'stars' },
  ] as const;
  const layerBtns = layerDefs.map((d) => {
    const b = el('button', `${CHIP} ${CHIP_OFF}`, d.label);
    b.type = 'button';
    b.addEventListener('click', () => setLayer(d.key, !globe[d.key]));
    showRow.appendChild(b);
    return { key: d.key, el: b };
  });

  pop.append(
    el('div', 'label', 'palette'),
    paletteRow,
    el('div', 'label mt-3.5', 'show'),
    showRow,
  );

  // --- legend bar -------------------------------------------------------------------------------
  const legend = el('div', 'mb-4');
  const barWrap = el(
    'div',
    'relative h-2 w-full overflow-hidden rounded-[3px] ring-1 ring-inset ring-white/10',
  );
  const barFrom = el('div', 'absolute inset-0');
  const barTo = el('div', 'absolute inset-0');
  // `difference` blending keeps the 0 °C marker visible against every palette, light or dark.
  const zeroMark = el('div', 'absolute top-0 h-full w-px bg-white opacity-0 mix-blend-difference');
  zeroMark.title = '0 °C';
  barWrap.append(barFrom, barTo, zeroMark);

  const ticks = el('div', 'relative mt-1.5 h-3');
  const TICK_POS = [0, 0.25, 0.5, 0.75, 1];
  const tickEls = TICK_POS.map((pos) => {
    const t = el('span', 'absolute -translate-x-1/2 text-[9px] tabular-nums text-haze/70');
    t.style.left = `${pos * 100}%`;
    ticks.appendChild(t);
    return t;
  });
  const zeroLabel = el(
    'span',
    'absolute -translate-x-1/2 text-[9px] tabular-nums text-chalk/80 opacity-0 transition-opacity',
    '0°',
  );
  ticks.appendChild(zeroLabel);

  legend.append(legendCap, barWrap, ticks);

  // --- transport --------------------------------------------------------------------------------
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
  panel.append(pop, legend, transport);
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

  const setRelative = (on: boolean) => {
    globe.relative = on;
    btnAbs.className = `${modeBtnClass} ${on ? CHIP_OFF : CHIP_ON}`;
    btnRel.className = `${modeBtnClass} ${on ? CHIP_ON : CHIP_OFF}`;
    btnAbs.setAttribute('aria-pressed', String(!on));
    btnRel.setAttribute('aria-pressed', String(on));
    legendNote.textContent = on ? 'scaled to view' : 'full range';
  };

  function setPalette(id: string) {
    globe.palette = id;
    for (const b of paletteBtns) {
      b.el.className = `${CHIP} ${b.id === id ? CHIP_ON : CHIP_OFF}`;
      b.el.setAttribute('aria-pressed', String(b.id === id));
    }
  }

  function setLayer(key: 'labels' | 'borders' | 'relief' | 'stars', on: boolean) {
    globe[key] = on;
    const b = layerBtns.find((x) => x.key === key);
    if (b) {
      b.el.className = `${CHIP} ${on ? CHIP_ON : CHIP_OFF}`;
      b.el.setAttribute('aria-pressed', String(on));
    }
  }

  const setPopOpen = (open: boolean) => {
    pop.classList.toggle('hidden', !open);
    btnLayers.className = `${CHIP} ${open ? CHIP_ON : CHIP_OFF}`;
    btnLayers.setAttribute('aria-expanded', String(open));
  };

  play.addEventListener('click', () => setPlaying(!playing));
  btnAbs.addEventListener('click', () => setRelative(false));
  btnRel.addEventListener('click', () => setRelative(true));
  btnLayers.addEventListener('click', (e) => {
    e.stopPropagation();
    setPopOpen(pop.classList.contains('hidden'));
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  // Anywhere else — including the globe — dismisses it.
  document.addEventListener('click', () => setPopOpen(false));

  // Grabbing the scrubber is an unambiguous request to take manual control.
  scrub.addEventListener('pointerdown', () => setPlaying(false));
  scrub.addEventListener('input', () => setMonth(Number(scrub.value) / STEPS_PER_MONTH));

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.key !== ' ') return;
    if (e.key === ' ') {
      e.preventDefault();
      setPlaying(!playing);
    } else if (e.key === 'r' || e.key === 'R') {
      setRelative(!globe.relative);
    } else if (e.key === 'l' || e.key === 'L') {
      setLayer('labels', !globe.labels);
    } else if (e.key === 'b' || e.key === 'B') {
      setLayer('borders', !globe.borders);
    } else if (e.key === 'Escape') {
      setPopOpen(false);
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

  /**
   * Repaints the legend from the globe's current colour window and palette.
   *
   * Both the tick text and the two gradients are rewritten only when they actually change. The
   * window moves every frame while the camera does, and blindly reassigning a thirteen-stop
   * gradient string sixty times a second would be pure waste.
   */
  const tickText: string[] = TICK_POS.map(() => '');
  let lastFromId = '';
  let lastToId = '';
  let lastZero = -1;

  const paintLegend = () => {
    const { lo, hi } = globe.window;
    const blend = globe.rampBlend;
    const { from, to } = globe.palettePair;
    const zero = zeroPosition(lo, hi);

    // A diverging palette's stops are repositioned by where 0 °C falls, so the bar's white band
    // stays under freezing — which means the gradient has to be rebuilt as the window moves.
    if (from.id !== lastFromId || to.id !== lastToId || Math.abs(zero - lastZero) > 0.004) {
      barFrom.style.background = rampCss(from, zero);
      barTo.style.background = rampCss(to, zero);
      lastFromId = from.id;
      lastToId = to.id;
      lastZero = zero;
    }
    barTo.style.opacity = String(blend);

    // The marker only earns its place under a sequential palette. A diverging one already puts its
    // midpoint on freezing, so a line there would just restate what the white band says.
    const dominant = blend > 0.5 ? to : from;
    const showZero = dominant.kind === 'sequential' && zero > 0.02 && zero < 0.98;
    const zeroOpacity = showZero ? '1' : '0';
    zeroMark.style.opacity = zeroOpacity;
    zeroLabel.style.opacity = zeroOpacity;
    if (showZero) {
      zeroMark.style.left = `${zero * 100}%`;
      zeroLabel.style.left = `${zero * 100}%`;
    }

    for (let i = 0; i < TICK_POS.length; i++) {
      const value = lo + (hi - lo) * TICK_POS[i]!;
      const rounded = Math.round(value);
      const next = `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded)}`;
      if (next !== tickText[i]) {
        tickText[i] = next;
        tickEls[i]!.textContent = next;
      }
      // Yield to the 0 °C marker where they would print on top of each other — the marker carries
      // strictly more meaning than a rounded number a few degrees either side of it.
      tickEls[i]!.style.opacity = showZero && Math.abs(zero - TICK_POS[i]!) < 0.07 ? '0' : '1';
    }
  };

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    if (playing) setMonth(globe.month + (dt * months) / YEAR_SECONDS);

    paintLegend();

    const h = globe.hover;
    if (!h) {
      tip.classList.add('hidden');
      return;
    }
    const { celsius, isLand } = field.sampleAt(h.lon, h.lat, globe.month);
    tip.classList.remove('hidden');
    // The value stays absolute — only the swatch follows the window, so it matches the surface.
    tipValue.textContent = `${celsius.toFixed(1)} °C`;
    const { lo, hi } = globe.window;
    const { from, to } = globe.palettePair;
    tipSwatch.style.background = blendedCss(
      from,
      to,
      (celsius - lo) / (hi - lo),
      zeroPosition(lo, hi),
      globe.rampBlend,
    );
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
  setRelative(globe.relative);
  setPalette(paletteById(globe.palette).id);
  for (const d of layerDefs) setLayer(d.key, globe[d.key]);
  setMonth(initialMonth ?? dateToMonth(new Date(), months));
  requestAnimationFrame(frame);
}
