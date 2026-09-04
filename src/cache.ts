/**
 * A generation-keyed cache for the baked rasters, so a reload costs no download.
 *
 * The app fetches about 19 MB of PNG on every start, and none of it changes between reloads — only
 * between *builds*. The Cache Storage API is the right shelf for that: unlike `localStorage` it
 * holds `Response` objects, so a hit skips the network and hands `createImageBitmap` exactly what
 * the network would have.
 *
 * Cache-busting is by construction rather than by convention. `npm run data` hashes every raster it
 * writes and stamps the digest into `meta.json`; the cache is named after that digest, and any
 * other generation is deleted the moment a new one opens. So rebuilding the data invalidates the
 * cache automatically, and it is impossible to serve a stale raster alongside a fresh `meta.json` —
 * the two are the same fact. `meta.json` itself is deliberately never cached, because it is what
 * carries the key.
 */

const PREFIX = 'worldtemp-data-';

let store: Cache | null = null;

/** Opens the cache for this build and drops every older one. Returns whether caching is on. */
export async function initDataCache(version: string): Promise<boolean> {
  // Cache Storage needs a secure context; it is simply absent over plain http on a LAN address.
  if (typeof caches === 'undefined' || !version) return false;
  try {
    const name = PREFIX + version;
    const stale = (await caches.keys()).filter((n) => n.startsWith(PREFIX) && n !== name);
    await Promise.all(stale.map((n) => caches.delete(n)));
    store = await caches.open(name);
    return true;
  } catch {
    // A private window, a full disk, or a browser with storage disabled. Not worth failing over.
    return false;
  }
}

/** Fetches through the cache when there is one, and straight from the network when there is not. */
export async function dataFetch(url: string): Promise<Response> {
  if (!store) return fetch(url);
  try {
    const hit = await store.match(url);
    if (hit) return hit;
    const res = await fetch(url);
    // Cloned before the body is read, and only stored when the fetch actually succeeded — caching a
    // 404 would survive the fix that made it a 200.
    if (res.ok) await store.put(url, res.clone());
    return res;
  } catch {
    return fetch(url);
  }
}
