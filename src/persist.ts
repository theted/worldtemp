/**
 * Session state kept in localStorage: where the camera is, and how the globe is configured.
 *
 * Every read and write is wrapped, because `localStorage` does not merely return null when it is
 * unavailable — accessing it *throws* in a private window or with site data blocked, and a throw
 * during startup would take the whole app down for a convenience feature.
 */

const KEY = 'worldtemp.state.v1';

export interface SavedState {
  /** Camera position in world space; the orbit target is always the origin. */
  camera: [number, number, number];
  /** Continuous month, 0 = mid-January. */
  month: number;
  /** ISO date the state was written, so a stale month can be refreshed. */
  savedOn: string;
  relative: boolean;
  palette: string;
  labels: boolean;
  borders: boolean;
  relief: boolean;
  ocean: boolean;
  stars: boolean;
  height: boolean;
  field: 'temperature' | 'daylight';
}

const isFiniteTriple = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

export function loadState(): Partial<SavedState> | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedState>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    // A malformed camera would strand the view somewhere unrecoverable, so drop just that field
    // rather than the whole state.
    if (!isFiniteTriple(parsed.camera)) delete parsed.camera;
    if (typeof parsed.month !== 'number' || !Number.isFinite(parsed.month)) delete parsed.month;
    return parsed;
  } catch {
    return null;
  }
}

export function saveState(state: SavedState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private window, quota, or site data blocked — persistence is a nicety, not a requirement */
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* as above */
  }
}

/** Today, as `YYYY-MM-DD`. */
export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
