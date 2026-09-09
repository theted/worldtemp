import type { Field } from './field';
import { OCEAN_MUTED_CSS, RELIEF_3D_ENABLED, type Globe } from './globe';
import { monthToDayOfYear, monthToDateLabel, dateToMonth } from './calendar';
import { rampCss, blendedCss, zeroPosition, PALETTES, paletteById } from './ramp';
import { formatLonLat } from './geo';
import { sunTimes, formatClock, formatDuration } from './sun';

export { dateToMonth };

/**
 * Chrome around the globe: title, legend, transport, settings popover, and the hover readout.
 *
 * Every colour shown here comes from `ramp.ts`, the same module the shader samples, so the legend
 * is guaranteed to describe the picture rather than merely resemble it. That matters more now the
 * scale can move and the palette can change: with a relative window the legend's *numbers* are the
 * only thing telling you what a colour means.
 *
 * The stateful controls — segmented groups, toggle pills, palette swatches — carry their state in
 * `aria-pressed` and let `style.css` do the painting. That keeps one fact in one place: there is no
 * class string to forget to update alongside the attribute, and the accessible state and the
 * visible state cannot drift apart.
 */

/** Seconds for playback to traverse the full year at 1×. */
const YEAR_SECONDS = 12;

/** Slider resolution: hundredths of a month, fine enough that scrubbing reads as continuous. */
const STEPS_PER_MONTH = 100;

/**
 * Playback speed runs on a log scale, ±2 octaves around 1×, so the slider spans a quarter speed to
 * quadruple and — the point of the exercise — puts 1× exactly in the middle. On a linear mapping
 * the neutral speed would sit a fifth of the way along and the whole upper half would be "faster
 * than you ever want"; here half and double are the same distance from centre, which is how rate
 * is actually perceived.
 */
const SPEED_STEPS = 100;
const SPEED_OCTAVES = 2;
const SPEED_MID = SPEED_STEPS / 2;
/** Slider units either side of centre that snap to exactly 1× — a detent you can feel. */
const SPEED_SNAP = 2;

const speedFromSlider = (v: number) => 2 ** (((v - SPEED_MID) / SPEED_MID) * SPEED_OCTAVES);
const sliderFromSpeed = (s: number) =>
  Math.round(SPEED_MID + (Math.log2(s) / SPEED_OCTAVES) * SPEED_MID);

const SPEED_MIN = speedFromSlider(0);
const SPEED_MAX = speedFromSlider(SPEED_STEPS);

/**
 * How long the chrome stays up after you stop reaching for it, and how far outside the panel
 * still counts as reaching. The margin is generous because the alternative — controls that
 * vanish while your hand is on the way to them — is far worse than ones that linger.
 */
const CHROME_HOLD_MS = 2600;
const REVEAL_MARGIN = 130;
/** Longer on arrival: the controls introduce themselves before withdrawing. */
const CHROME_INTRO_MS = 3600;

/** What `mountUi` hands back, so the caller can persist what the UI owns. */
export interface UiHandle {
  /** Current playback multiplier. */
  readonly speed: number;
}

export interface UiInitial {
  month?: number | undefined;
  speed?: number | undefined;
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

/** A button whose only state is `aria-pressed`; everything visual follows from that. */
function toggle(className: string, label: string, title?: string): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.setAttribute('aria-pressed', 'false');
  if (title) b.title = title;
  return b;
}

export function mountUi(
  root: HTMLElement,
  globe: Globe,
  field: Field,
  initial: UiInitial = {},
): UiHandle {
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
  const tip = el('div', 'panel pointer-events-none absolute z-20 hidden rounded-xl px-3 py-2.5');
  const tipTemp = el('div', 'flex items-baseline gap-2');
  const tipSwatch = el(
    'span',
    'inline-block size-2.5 shrink-0 rounded-[3px] ring-1 ring-inset ring-white/20',
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
  // settings popover
  // ------------------------------------------------------------------------------------------

  /**
   * A segmented control: mutually exclusive options with one indicator that slides between them.
   * The indicator is positioned from the pressed button's box, so the markup stays the source of
   * truth for both geometry and state.
   */
  const segmented = (
    defs: readonly { id: string; label: string; title?: string }[],
  ): { root: HTMLElement; btns: { id: string; el: HTMLButtonElement }[] } => {
    const wrap = el('div', 'seg');
    const thumb = el('div', 'seg__thumb');
    wrap.appendChild(thumb);
    const btns = defs.map((d) => {
      const b = toggle('seg__btn', d.label, d.title);
      wrap.appendChild(b);
      return { id: d.id, el: b };
    });
    return { root: wrap, btns };
  };

  const layoutSeg = (seg: HTMLElement) => {
    const thumb = seg.querySelector<HTMLElement>('.seg__thumb');
    const active = seg.querySelector<HTMLElement>('.seg__btn[aria-pressed="true"]');
    if (!thumb || !active) return;
    thumb.style.left = `${active.offsetLeft}px`;
    thumb.style.width = `${active.offsetWidth}px`;
  };

  // Which quantity is drawn is a bigger decision than how it is scaled, so it sits first.
  const fieldSeg = segmented([
    { id: 'temperature', label: 'temp', title: 'temperature  (D)' },
    { id: 'daylight', label: 'daylight', title: 'hours of daylight  (D)' },
  ]);
  const modeSeg = segmented([
    { id: 'absolute', label: 'absolute', title: 'pin the scale to the full range  (R)' },
    { id: 'relative', label: 'relative', title: 'scale to what is on screen  (R)' },
  ]);

  const settings = el(
    'div',
    'panel pop pointer-events-auto absolute right-0 top-full mt-2.5 w-[21rem] rounded-xl px-4 py-4',
  );
  settings.dataset.open = 'false';

  // Palettes show their own ramp. A row of words asks you to remember what "viridis" looks like;
  // a row of gradients simply tells you, using the very stops the shader will sample.
  const paletteRow = el('div', 'mt-2 grid grid-cols-4 gap-x-2.5 gap-y-3');
  const paletteBtns = PALETTES.map((p) => {
    const b = toggle('pal', '', p.label);
    b.innerHTML = `<span class="pal__bar"></span><span class="pal__name">${p.label}</span>`;
    const bar = b.querySelector<HTMLElement>('.pal__bar')!;
    // A diverging ramp is drawn about its own midpoint here: the swatch describes the palette,
    // not the current window, so pinning it to wherever 0 °C happens to fall would mislead.
    bar.style.background = rampCss(p, 0.5);
    b.addEventListener('click', () => setPalette(p.id));
    paletteRow.appendChild(b);
    return { id: p.id, el: b };
  });

  // Playback rate lives with the other settings: it is chosen once and then left alone, unlike the
  // scrubber beside it in the console, which is handled continuously.
  const speedRow = el('div', 'mt-2 flex items-center gap-3');
  const speedWrap = el('div', 'min-w-0 flex-1');
  const speedInput = el('input', 'scrub scrub--mini');
  speedInput.type = 'range';
  speedInput.min = '0';
  speedInput.max = String(SPEED_STEPS);
  speedInput.step = '1';
  speedInput.title = 'playback speed  ( [ and ] )';
  speedInput.setAttribute('aria-label', 'playback speed');
  speedWrap.appendChild(speedInput);
  const speedBig = el(
    'div',
    'w-[3.1rem] shrink-0 text-right text-[11px] leading-none tabular-nums text-chalk/90',
  );
  speedRow.append(speedWrap, speedBig);

  const showRow = el('div', 'mt-2 flex flex-wrap gap-1.5');
  // The 3-D layer is offered only when the sphere was actually built with the vertices to displace;
  // a control that cannot do anything is worse than no control.
  const layerDefs = (
    [
      { key: 'labels', label: 'names', title: 'country names  (L)' },
      { key: 'borders', label: 'borders', title: 'country borders  (B)' },
      { key: 'ocean', label: 'ocean', title: 'colour-map the sea  (O)' },
      { key: 'relief', label: 'relief', title: 'shaded relief' },
      ...(RELIEF_3D_ENABLED ? [{ key: 'height', label: '3d', title: 'displace by elevation  (H)' } as const] : []),
      { key: 'stars', label: 'stars', title: 'star field' },
    ] as const
  ).slice() as readonly {
    key: 'labels' | 'borders' | 'ocean' | 'relief' | 'height' | 'stars';
    label: string;
    title: string;
  }[];
  const layerBtns = layerDefs.map((d) => {
    const b = toggle('chip', d.label, d.title);
    b.addEventListener('click', () => setLayer(d.key, !globe[d.key]));
    showRow.appendChild(b);
    return { key: d.key, el: b };
  });

  /** A titled block. Ruled off from the one above, so the groups read as groups. */
  const section = (title: string, body: HTMLElement) => {
    const wrap = el('div', 'mt-4 border-t border-edge/60 pt-4 first:mt-0 first:border-0 first:pt-0');
    wrap.append(el('div', 'label', title), body);
    return wrap;
  };
  const row = (child: HTMLElement) => {
    const r = el('div', 'mt-2 flex');
    r.appendChild(child);
    return r;
  };

  settings.append(
    section('field', row(fieldSeg.root)),
    section('scale', row(modeSeg.root)),
    section('playback', speedRow),
    section('palette', paletteRow),
    section('layers', showRow),
  );

  // --- settings button, top right ---------------------------------------------------------------
  const ICON_COG = `<svg viewBox="0 0 24 24" class="size-[15px] transition-transform duration-300"
    style="transition-timing-function: var(--ease-ui)"
    fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33
      1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0
      1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0
      4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0
      0 0 10.09 3V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83
      2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>`;
  const gearClass = (open: boolean) =>
    'grid size-9 place-items-center rounded-full border backdrop-blur-md transition ' +
    'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 ' +
    'focus-visible:outline-haze ' +
    (open
      ? 'border-chalk/25 bg-chalk/[0.12] text-chalk [&>svg]:rotate-[60deg]'
      : 'border-edge bg-ink/45 text-haze hover:border-chalk/20 hover:bg-white/[0.07] hover:text-chalk');

  const btnGear = el('button', gearClass(false), ICON_COG);
  btnGear.type = 'button';
  btnGear.setAttribute('aria-label', 'settings');
  btnGear.setAttribute('aria-expanded', 'false');

  const gearWrap = el(
    'div',
    'chrome pointer-events-auto absolute right-6 top-6 z-30 md:right-8 md:top-8',
  );
  gearWrap.dataset.shown = 'true';
  // It withdraws upward, away from the globe, where the console withdraws downward.
  gearWrap.style.setProperty('--chrome-out', '-10px');
  gearWrap.append(btnGear, settings);
  root.appendChild(gearWrap);

  // ------------------------------------------------------------------------------------------
  // bottom console
  // ------------------------------------------------------------------------------------------
  const console_ = el(
    'div',
    'chrome absolute inset-x-0 bottom-0 z-10 flex justify-center p-4 md:p-6 pointer-events-none',
  );
  console_.dataset.shown = 'true';
  const panel = el(
    'div',
    'panel pointer-events-auto relative w-full max-w-xl rounded-2xl px-5 py-4',
  );

  // The console carries only what is read continuously — what the colours mean, and when — so the
  // caption states the two facts the settings popover would otherwise hide: quantity, and scale.
  const legendCap = el('div', 'mb-2 flex items-center justify-between gap-3');
  const legendField = el('span', 'label');
  const legendNote = el('span', 'label');
  legendCap.append(legendField, legendNote);

  // --- legend bar -------------------------------------------------------------------------------
  const legend = el('div', 'mb-4');
  const barWrap = el(
    'div',
    'relative h-2.5 w-full overflow-hidden rounded-full ring-1 ring-inset ring-white/15',
  );
  const barFrom = el('div', 'absolute inset-0');
  const barTo = el('div', 'absolute inset-0');
  // `difference` blending keeps the 0 °C marker visible against every palette, light or dark.
  const zeroMark = el('div', 'absolute top-0 h-full w-px bg-white opacity-0 mix-blend-difference');
  barWrap.append(barFrom, barTo, zeroMark);

  const ticks = el('div', 'relative mt-2 h-3');
  const TICK_POS = [0, 0.25, 0.5, 0.75, 1];
  const tickEls = TICK_POS.map((pos) => {
    const t = el(
      'span',
      'absolute -translate-x-1/2 text-[9px] tabular-nums text-haze/70 transition-opacity',
    );
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

  // The one filled element on the page. Everything else in the chrome is an outline or a hairline,
  // which leaves exactly one thing reading as *the* thing to press.
  const play = el(
    'button',
    'grid size-9 place-items-center rounded-full bg-chalk/90 text-ink transition ' +
      'hover:bg-chalk hover:shadow-[0_0_22px_-4px_rgba(219,227,236,0.75)] active:scale-95 ' +
      'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 ' +
      'focus-visible:outline-chalk',
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
  let speed = 1;
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

  /**
   * `fromSlider` says the input element already holds the value, so writing it back would fight
   * the pointer mid-drag on engines that clamp during input.
   */
  const setSpeed = (value: number, fromSlider = false) => {
    speed = Math.min(Math.max(value, SPEED_MIN), SPEED_MAX);
    // Always two decimals: the readout is an instrument, and a number that changes width as it
    // ticks is the one thing tabular figures exist to prevent.
    speedBig.textContent = `${speed.toFixed(2)}×`;
    if (!fromSlider) speedInput.value = String(sliderFromSpeed(speed));
  };

  const readSpeedSlider = () => {
    let v = Number(speedInput.value);
    // A detent at the centre: without it, landing on exactly 1× by dragging is luck.
    if (Math.abs(v - SPEED_MID) <= SPEED_SNAP) {
      v = SPEED_MID;
      speedInput.value = String(v);
    }
    setSpeed(speedFromSlider(v), true);
  };

  const nudgeSpeed = (steps: number) => {
    speedInput.value = String(Math.min(Math.max(Number(speedInput.value) + steps, 0), SPEED_STEPS));
    readSpeedSlider();
  };

  const setField = (id: 'temperature' | 'daylight') => {
    globe.field = id;
    const day = id === 'daylight';
    for (const b of fieldSeg.btns) b.el.setAttribute('aria-pressed', String(b.id === id));
    layoutSeg(fieldSeg.root);
    // One word, because the box under the date is 4.5rem wide and two would wrap.
    dateSub.textContent = day ? 'astronomy' : 'climatology';
    legendField.textContent = day ? 'hours of daylight' : 'temperature °C';
    if (mastheadSub) {
      mastheadSub.textContent = day ? 'hours of daylight' : 'average monthly temperature';
    }
  };

  const setRelative = (on: boolean) => {
    globe.relative = on;
    const id = on ? 'relative' : 'absolute';
    for (const b of modeSeg.btns) b.el.setAttribute('aria-pressed', String(b.id === id));
    layoutSeg(modeSeg.root);
    legendNote.textContent = on ? 'scaled to view' : 'full range';
  };

  function setPalette(id: string) {
    globe.palette = id;
    for (const b of paletteBtns) b.el.setAttribute('aria-pressed', String(b.id === id));
  }

  function setLayer(
    key: 'labels' | 'borders' | 'ocean' | 'relief' | 'height' | 'stars',
    on: boolean,
  ) {
    globe[key] = on;
    layerBtns.find((x) => x.key === key)?.el.setAttribute('aria-pressed', String(on));
  }

  const setSettingsOpen = (open: boolean) => {
    settings.dataset.open = String(open);
    btnGear.className = gearClass(open);
    btnGear.setAttribute('aria-expanded', String(open));
  };

  play.addEventListener('click', () => setPlaying(!playing));
  for (const b of fieldSeg.btns) {
    b.el.addEventListener('click', () => setField(b.id as 'temperature' | 'daylight'));
  }
  for (const b of modeSeg.btns) {
    b.el.addEventListener('click', () => setRelative(b.id === 'relative'));
  }
  btnGear.addEventListener('click', (e) => {
    e.stopPropagation();
    setSettingsOpen(settings.dataset.open !== 'true');
  });
  settings.addEventListener('click', (e) => e.stopPropagation());
  // Anywhere else — including the globe — dismisses it.
  document.addEventListener('click', () => setSettingsOpen(false));

  // Grabbing the scrubber is an unambiguous request to take manual control.
  scrub.addEventListener('pointerdown', () => setPlaying(false));
  scrub.addEventListener('input', () => setMonth(Number(scrub.value) / STEPS_PER_MONTH));
  speedInput.addEventListener('input', readSpeedSlider);

  // The segmented indicators are measured from live layout, so they have to be re-measured whenever
  // that layout could have changed. Metrics-driven positioning is the price of a sliding thumb.
  const layoutSegs = () => {
    layoutSeg(fieldSeg.root);
    layoutSeg(modeSeg.root);
  };
  window.addEventListener('resize', layoutSegs);
  document.fonts?.ready.then(layoutSegs).catch(() => {});

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.key !== ' ') return;
    // Every shortcut below changes something the console displays. Showing it is how the
    // keyboard user sees that the key landed.
    nudgeChrome();
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
    } else if (RELIEF_3D_ENABLED && (e.key === 'h' || e.key === 'H')) {
      setLayer('height', !globe.height);
    } else if (e.key === 'd' || e.key === 'D') {
      setField(globe.field === 'daylight' ? 'temperature' : 'daylight');
    } else if (e.key === '[') {
      nudgeSpeed(-5);
    } else if (e.key === ']') {
      nudgeSpeed(5);
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

  // ------------------------------------------------------------------------------------------
  // the chrome withdraws
  // ------------------------------------------------------------------------------------------

  /**
   * Whether the pointer is close enough to an element to count as reaching for it.
   *
   * Deliberately geometric rather than `:hover`. Hover would need the panel hit-testable to be
   * detected, and a hit-testable panel is exactly what must not exist while it is invisible — it
   * would eat every globe drag across the bottom of the window. A rect stays measurable at zero
   * opacity, so this reads the same either way.
   */
  const reaching = (node: HTMLElement) => {
    const r = node.getBoundingClientRect();
    return (
      px >= r.left - REVEAL_MARGIN &&
      px <= r.right + REVEAL_MARGIN &&
      py >= r.top - REVEAL_MARGIN &&
      py <= r.bottom + REVEAL_MARGIN
    );
  };

  let chromeShown = true;
  let holdUntil = performance.now() + CHROME_INTRO_MS;
  /** Any deliberate act — a tap, a keypress — puts the controls back up for a while. */
  const nudgeChrome = () => {
    holdUntil = performance.now() + CHROME_HOLD_MS;
  };
  root.addEventListener('pointerdown', nudgeChrome);

  const updateChrome = (now: number) => {
    const focus = document.activeElement;
    const shown =
      settings.dataset.open === 'true' ||
      now < holdUntil ||
      // Keyboard users never move the pointer, so focus alone has to be able to hold it open.
      (focus instanceof HTMLElement && (console_.contains(focus) || gearWrap.contains(focus))) ||
      reaching(panel) ||
      reaching(btnGear);
    if (shown === chromeShown) return;
    chromeShown = shown;
    console_.dataset.shown = String(shown);
    gearWrap.dataset.shown = String(shown);
  };

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
    if (playing) setMonth(globe.month + (dt * months * speed) / YEAR_SECONDS);

    updateChrome(now);
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
  setSpeed(initial.speed ?? 1);
  setField(globe.field);
  setRelative(globe.relative);
  setPalette(paletteById(globe.palette).id);
  for (const d of layerDefs) setLayer(d.key, globe[d.key]);
  setMonth(initial.month ?? dateToMonth(new Date(), months));
  requestAnimationFrame(frame);

  return {
    get speed() {
      return speed;
    },
  };
}
