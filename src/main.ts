import './style.css';
import { loadField } from './field';
import { createGlobe, type Globe } from './globe';
import { mountUi } from './ui';
import { loadState, saveState, todayStamp } from './persist';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

function fail(message: string, detail: unknown) {
  console.error(detail);
  root!.innerHTML = `
    <div class="grid h-full place-items-center p-8 text-center">
      <div class="max-w-md">
        <p class="text-[11px] tracking-[0.3em] text-haze">WORLDTEMP</p>
        <p class="mt-4 text-sm text-chalk">${message}</p>
        <p class="mt-2 text-[11px] text-haze">${String(detail)}</p>
      </div>
    </div>`;
}

/** How often the session state is written back, in ms. */
const SAVE_INTERVAL = 900;

/**
 * Mirrors the globe's state into localStorage.
 *
 * Polling on a timer rather than reacting to every change: the camera moves continuously while you
 * orbit, so there is no discrete "changed" moment to hook, and writing on every frame would be
 * absurd. A snapshot comparison keeps it to one write per actual change.
 */
function startPersisting(globe: Globe) {
  let lastSerialised = '';

  const snapshot = () => ({
    camera: globe.cameraPosition.toArray() as [number, number, number],
    month: globe.month,
    savedOn: todayStamp(),
    relative: globe.relative,
    palette: globe.palette,
    labels: globe.labels,
    borders: globe.borders,
    relief: globe.relief,
    stars: globe.stars,
  });

  const flush = () => {
    const state = snapshot();
    const serialised = JSON.stringify(state);
    if (serialised === lastSerialised) return;
    lastSerialised = serialised;
    saveState(state);
  };

  setInterval(flush, SAVE_INTERVAL);
  // pagehide fires on close and on mobile backgrounding, where an unload handler would not.
  addEventListener('pagehide', flush);
}

async function start() {
  // Decoding twelve 2160×1080 PNGs takes a moment; say so rather than showing an empty void.
  const splash = document.createElement('div');
  splash.className = 'grid h-full place-items-center';
  splash.innerHTML = `<p class="text-[10px] tracking-[0.3em] text-haze animate-pulse">LOADING CLIMATOLOGY</p>`;
  root!.appendChild(splash);

  const field = await loadField();
  splash.remove();

  const saved = loadState();
  const globe = createGlobe(root!, field, {
    camera: saved?.camera,
    relative: saved?.relative,
    palette: saved?.palette,
    labels: saved?.labels,
    borders: saved?.borders,
    relief: saved?.relief,
    stars: saved?.stars,
  });

  // A month scrubbed on an earlier day is stale — this is a climatology, and the natural entry
  // point is the season you are actually in. Reloading the same day keeps exactly where you were.
  const sameDay = saved?.savedOn === todayStamp();
  mountUi(root!, globe, field, sameDay ? saved?.month : undefined);

  startPersisting(globe);
}

start().catch((err) => fail('Could not start. Have you run `npm run data`?', err));
