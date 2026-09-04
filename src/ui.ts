import type { Field } from './field';
import { OCEAN_MUTED_CSS, type Globe } from './globe';
import { monthToDayOfYear, monthToDateLabel, dateToMonth } from './calendar';
import { rampCss, blendedCss, zeroPosition, PALETTES, paletteById } from './ramp';
import { formatLonLat } from './geo';
import { sunTimes, formatClock, formatDuration } from './sun';

export { dateToMonth };

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
    <p data-sub class="mt-1.5 text-[11px] tracking-[0.1em] text-haze">average monthly temperature</p>
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
  // The page names what it is showing. Leaving "average monthly temperature" over a daylight globe
  // would be the masthead telling the same lie the legend is built to never tell.
  const mastheadSub = header.querySelector('[data-sub]');
  root.appendChild(header);

  // ------------------------------------------------------------------------------------------
  // hover readout
  // ------------------------------------------------------------------------------------------
  const tip = el(
    'div',
    'panel pointer-events-none absolute z-20 hidden rounded-md px-3 py-2 shadow-xl shadow-black/50',
  );
  const tipTemp = el('div', 'flex items-baseline gap-2');
  const tipSwatch = el(
    'span',
    'inline-block size-2.5 shrink-0 rounded-[2px] ring-1 ring-inset ring-white/15',
  );
  const tipValue = el('span', 'text-[17px] leading-none tabular-nums text-chalk');
  tipTemp.append(tipSwatch, tipValue);
  const tipKind = el('div', 'label mt-1.5');
  const tipCoords = el('div', 'mt-0.5 text-[10px] tabular-nums text-haze/70');

  // The sun block is ruled off: temperature is measured data, the sun times are computed geometry,
  // and the reader should be able to see at a glance that they come from different places.
  const tipSun = el('div', 'mt-2 border-t border-edge pt-2');
  const tipSunTimes = el('div', 'flex items-baseline gap-3 text-[11px] tabular-nums text-chalk/90');
  const tipRise = el('span');
  const tipSet = el('span');
  tipSunTimes.append(tipRise, tipSet);
  const tipDaylight = el('div', 'label mt-1');
  tipSun.append(tipSunTimes, tipDaylight);

  tip.append(tipTemp, tipKind, tipCoords, tipSun);
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

  // --- field + scale mode + layers button -------------------------------------------------------
  const modeBtnClass =
    'px-2 py-[3px] text-[9px] tracking-[0.16em] uppercase transition ' +
    'focus-visible:outline focus-visible:outline-1 focus-visible:outline-haze';
  const segmented = () =>
    el('div', 'flex divide-x divide-edge overflow-hidden rounded border border-edge');

  // Which quantity is drawn is a bigger decision than how it is scaled, so it sits leftmost, in the
  // same segmented shape rather than buried in the layers popover.
  const fields = segmented();
  const btnTemp = el('button', modeBtnClass, 'temp');
  const btnDay = el('button', modeBtnClass, 'daylight');
  btnTemp.type = 'button';
  btnDay.type = 'button';
  fields.append(btnTemp, btnDay);

  const modes = segmented();
  const btnAbs = el('button', modeBtnClass, 'absolute');
  const btnRel = el('button', modeBtnClass, 'relative');
  btnAbs.type = 'button';
  btnRel.type = 'button';
  modes.append(btnAbs, btnRel);

  // The console now carries only what is read continuously — what the colours mean, and when — so
  // the caption states the two facts the moved controls used to imply: which quantity, which scale.
  const legendCap = el('div', 'mb-1.5 flex items-center justify-between gap-3');
  const legendField = el('span', 'label');
  const legendNote = el('span', 'label');
  legendCap.append(legendField, legendNote);

  // --- settings panel ---------------------------------------------------------------------------
  const settings = el(
    'div',
    'panel pointer-events-auto absolute right-0 top-full mt-2 hidden w-[19.5rem] ' +
      'rounded-lg px-4 py-4 shadow-2xl shadow-black/70',
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
    { key: 'ocean', label: 'ocean' },
    { key: 'relief', label: 'relief' },
    { key: 'height', label: '3d' },
    { key: 'stars', label: 'stars' },
  ] as const;
  const layerBtns = layerDefs.map((d) => {
    const b = el('button', `${CHIP} ${CHIP_OFF}`, d.label);
    b.type = 'button';
    b.addEventListener('click', () => setLayer(d.key, !globe[d.key]));
    showRow.appendChild(b);
    return { key: d.key, el: b };
  });

  /** A titled block. Ruled off from the one above, so the groups read as groups. */
  const section = (title: string, body: HTMLElement) => {
    const wrap = el('div', 'mt-3.5 border-t border-edge/60 pt-3.5 first:mt-0 first:border-0 first:pt-0');
    wrap.append(el('div', 'label', title), body);
    return wrap;
  };
  const row = (child: HTMLElement) => {
    const r = el('div', 'mt-1.5 flex');
    r.appendChild(child);
    return r;
  };

  settings.append(
    section('field', row(fields)),
    section('scale', row(modes)),
    section('palette', paletteRow),
    section('layers', showRow),
  );

  // --- settings button, top right ---------------------------------------------------------------
  const ICON_COG = `<svg viewBox="0 0 24 24" class="size-[15px]" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33
      1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0
      1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0
      4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0
      0 0 10.09 3V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83
      2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>`;
  const gearClass = (open: boolean) =>
    'grid size-9 place-items-center rounded-full border border-edge transition ' +
    'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 ' +
    'focus-visible:outline-haze ' +
    (open ? 'bg-chalk/90 text-ink' : 'bg-ink/50 text-haze hover:text-chalk hover:bg-white/10');

  const btnGear = el('button', gearClass(false), ICON_COG);
  btnGear.type = 'button';
  btnGear.setAttribute('aria-label', 'settings');
  btnGear.setAttribute('aria-expanded', 'false');

  const gearWrap = el('div', 'pointer-events-auto absolute right-6 top-6 z-30 md:right-8 md:top-8');
  gearWrap.append(btnGear, settings);
  root.appendChild(gearWrap);

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

  const setField = (id: 'temperature' | 'daylight') => {
    globe.field = id;
    const day = id === 'daylight';
    btnTemp.className = `${modeBtnClass} ${day ? CHIP_OFF : CHIP_ON}`;
    btnDay.className = `${modeBtnClass} ${day ? CHIP_ON : CHIP_OFF}`;
    btnTemp.setAttribute('aria-pressed', String(!day));
    btnDay.setAttribute('aria-pressed', String(day));
    // One word, because the box under the date is 4.5rem wide and two would wrap.
    dateSub.textContent = day ? 'astronomy' : 'climatology';
    legendField.textContent = day ? 'hours of daylight' : 'temperature °C';
    if (mastheadSub) {
      mastheadSub.textContent = day ? 'hours of daylight' : 'average monthly temperature';
    }
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

  function setLayer(
    key: 'labels' | 'borders' | 'ocean' | 'relief' | 'height' | 'stars',
    on: boolean,
  ) {
    globe[key] = on;
    const b = layerBtns.find((x) => x.key === key);
    if (b) {
      b.el.className = `${CHIP} ${on ? CHIP_ON : CHIP_OFF}`;
      b.el.setAttribute('aria-pressed', String(on));
    }
  }

  const setSettingsOpen = (open: boolean) => {
    settings.classList.toggle('hidden', !open);
    btnGear.className = gearClass(open);
    btnGear.setAttribute('aria-expanded', String(open));
  };

  play.addEventListener('click', () => setPlaying(!playing));
  btnTemp.addEventListener('click', () => setField('temperature'));
  btnDay.addEventListener('click', () => setField('daylight'));
  btnAbs.addEventListener('click', () => setRelative(false));
  btnRel.addEventListener('click', () => setRelative(true));
  btnGear.addEventListener('click', (e) => {
    e.stopPropagation();
    setSettingsOpen(settings.classList.contains('hidden'));
  });
  settings.addEventListener('click', (e) => e.stopPropagation());
  // Anywhere else — including the globe — dismisses it.
  document.addEventListener('click', () => setSettingsOpen(false));

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
    } else if (e.key === 'o' || e.key === 'O') {
      setLayer('ocean', !globe.ocean);
    } else if (e.key === 'h' || e.key === 'H') {
      setLayer('height', !globe.height);
    } else if (e.key === 'd' || e.key === 'D') {
      setField(globe.field === 'daylight' ? 'temperature' : 'daylight');
    } else if (e.key === 'Escape') {
      setSettingsOpen(false);
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
    const spec = globe.spec;
    const zero = zeroPosition(lo, hi, spec.pivot);

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
    // midpoint on the reference value, so a line there would just restate what the white band says.
    const dominant = blend > 0.5 ? to : from;
    const showZero = dominant.kind === 'sequential' && zero > 0.02 && zero < 0.98;
    if (zeroLabel.textContent !== spec.pivotLabel) zeroLabel.textContent = spec.pivotLabel;
    const zeroOpacity = showZero ? '1' : '0';
    zeroMark.style.opacity = zeroOpacity;
    zeroLabel.style.opacity = zeroOpacity;
    if (showZero) {
      zeroMark.style.left = `${zero * 100}%`;
      zeroLabel.style.left = `${zero * 100}%`;
    }

    for (let i = 0; i < TICK_POS.length; i++) {
      const next = spec.tick(lo + (hi - lo) * TICK_POS[i]!, hi - lo);
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
    const sun = sunTimes(h.lat, monthToDayOfYear(globe.month, months));
    const spec = globe.spec;
    const daylightMode = spec.id === 'daylight';
    tip.classList.remove('hidden');

    // The headline is whichever quantity is being drawn; the other one keeps its place below, so
    // the readout answers both questions however the globe is coloured.
    const value = daylightMode ? sun.daylight : celsius;
    tipValue.textContent = spec.headline(value);
    tipKind.textContent = spec.kind(isLand);
    tipCoords.textContent = formatLonLat(h.lon, h.lat);

    const { lo, hi } = globe.window;
    const { from, to } = globe.palettePair;
    // The swatch's whole job is to tie the number to the pixel under the cursor, so when the ocean
    // is muted it has to show the mute rather than the colour the water would otherwise have had.
    // That holds for either field: muting the sea is a cartographic choice, not a claim about what
    // is measured there, so it applies to the daylight gradient exactly as it does to temperature.
    tipSwatch.style.background =
      !isLand && !globe.ocean
        ? OCEAN_MUTED_CSS
        : blendedCss(
            from,
            to,
            (value - lo) / (hi - lo),
            zeroPosition(lo, hi, spec.pivot),
            globe.rampBlend,
          );

    // Sun times track both the cursor's latitude and the scrubbed date, so sweeping north at a
    // fixed date and holding still while the year plays are two different, equally readable stories.
    if (sun.kind === 'normal') {
      tipRise.textContent = `↑ ${formatClock(sun.sunrise!)}`;
      tipSet.textContent = `↓ ${formatClock(sun.sunset!)}`;
    } else {
      // With no rise or set to print, the phrase carries the whole line.
      tipRise.textContent = sun.kind === 'midnight-sun' ? '↑ midnight sun' : '↓ polar night';
      tipSet.textContent = '';
    }
    // In daylight mode the duration has been promoted to the headline, so this line stops repeating
    // it and carries the temperature instead — the field the globe is no longer drawing.
    tipDaylight.textContent = daylightMode
      ? `${celsius.toFixed(1)} °C · ${isLand ? 'land' : 'ocean'}`
      : `${formatDuration(sun.daylight)} · local solar`;

    // Keep the card inside the viewport, flipping side and lifting it clear of the pointer.
    const w = tip.offsetWidth;
    const hgt = tip.offsetHeight;
    const left = px + 18 + w > innerWidth ? px - 18 - w : px + 18;
    const top = Math.min(Math.max(py - hgt / 2, 8), innerHeight - hgt - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  setPlaying(false);
  setField(globe.field);
  setRelative(globe.relative);
  setPalette(paletteById(globe.palette).id);
  for (const d of layerDefs) setLayer(d.key, globe[d.key]);
  setMonth(initialMonth ?? dateToMonth(new Date(), months));
  requestAnimationFrame(frame);
}
