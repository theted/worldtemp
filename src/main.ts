import './style.css';
import { loadField } from './field';
import { createGlobe } from './globe';
import { mountUi } from './ui';

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

async function start() {
  // Decoding twelve 2160×1080 PNGs takes a moment; say so rather than showing an empty void.
  const splash = document.createElement('div');
  splash.className = 'grid h-full place-items-center';
  splash.innerHTML = `<p class="text-[10px] tracking-[0.3em] text-haze animate-pulse">LOADING CLIMATOLOGY</p>`;
  root!.appendChild(splash);

  const field = await loadField();
  splash.remove();

  const globe = createGlobe(root!, field);
  mountUi(root!, globe, field);
}

start().catch((err) => fail('Could not start. Have you run `npm run data`?', err));
