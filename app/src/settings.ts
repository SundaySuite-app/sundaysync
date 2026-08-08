/**
 * Persisted settings — docs/PLAN.md §9: "Advanced settings persist per machine".
 *
 * SundayRec's proven pattern (D-029): one localStorage JSON key, merged over defaults on
 * load, debounced write. No tauri-plugin-store — these are UI-tier preferences, and the
 * suite already does it this way.
 *
 * Every engine-related field defaults to `null`, meaning "use the engine's default".
 * That is what keeps §9's promise that advanced settings never change simple-mode
 * behaviour: an untouched installation sends nothing but `null`s, and the Rust side
 * falls through to its own constants.
 */

import type { Lang } from "./i18n";

const KEY = "sundaysync.settings.v1";
const SAVE_DEBOUNCE_MS = 150;

export interface Settings {
  /** `null` = follow the OS language via `detectLang()`. */
  lang: Lang | null;
  /** `null` = the engine's calibrated `DEFAULT_MIN_PSR` (15, see D-015). */
  minPsr: number | null;
  /** `null` = the engine's `SEGMENT_COUNT` (5). */
  segmentCount: number | null;
  /** `null` = the OS cache location the engine picks itself. */
  cacheDir: string | null;
  /**
   * Optional cache size cap in megabytes (D-040). `null` = off (the default): the cache
   * grows and only the 90-day age sweep and manual "clear" bound it. A positive number
   * enforces a ceiling, evicting least-recently-used entries when exceeded.
   */
  cacheCapMb: number | null;
  /**
   * E6 (D-042): correct measured clock drift by writing a per-clip `<timeMap>` retime into
   * the FCPXML. On by default; the export only ever retimes clips whose drift exceeds half
   * a frame, so this is a safety valve, not a per-clip control.
   */
  correctDrift: boolean;
  onboardingDone: boolean;
}

export const DEFAULTS: Settings = {
  lang: null,
  minPsr: null,
  segmentCount: null,
  cacheDir: null,
  cacheCapMb: null,
  correctDrift: true,
  onboardingDone: false,
};

let current: Settings = load();
let timer: ReturnType<typeof setTimeout> | null = null;

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULTS };
    // Per-field validation: a corrupt or stale blob degrades field by field rather than
    // discarding every setting because one went bad.
    const p = parsed as Record<string, unknown>;
    return {
      lang: p.lang === "nb" || p.lang === "en" ? p.lang : null,
      minPsr: isPositiveNumber(p.minPsr) ? p.minPsr : null,
      segmentCount: isPositiveNumber(p.segmentCount) ? Math.round(p.segmentCount) : null,
      cacheDir: typeof p.cacheDir === "string" && p.cacheDir.length > 0 ? p.cacheDir : null,
      cacheCapMb: isPositiveNumber(p.cacheCapMb) ? Math.round(p.cacheCapMb) : null,
      // Defaults to on: only an explicit stored `false` disables it, so a fresh or corrupt
      // blob keeps drift correction (D-042's on-by-default).
      correctDrift: p.correctDrift !== false,
      onboardingDone: p.onboardingDone === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

export function getSettings(): Settings {
  return current;
}

/** Merge + debounced persist. Returns the merged settings for immediate use. */
export function saveSettings(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch };
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  return current;
}

/** Immediate write — for the moments that must not be lost to a debounce window,
 *  like finishing onboarding right before the user quits (SundayRec's `finish()`). */
export function saveSettingsNow(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch };
  flush();
  return current;
}

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage full or unavailable: settings become session-only, which is the least-bad
    // degradation — never crash the app over a preference.
  }
}

/**
 * Commit logic for the free-text minPsr field, extracted so it is testable.
 *
 * The old UI did `Number(v) || null`, which silently snapped both `0` and an empty
 * field back to the default. Here: empty means "engine default" (valid), while zero,
 * negatives and garbage are rejected as invalid input for the caller to flag.
 */
export function parseMinPsrInput(
  raw: string,
): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return { ok: false };
  return { ok: true, value: n };
}

/** Test hook: reload from storage (used after tests mutate localStorage directly). */
export function reloadSettingsForTest(): Settings {
  current = load();
  return current;
}
