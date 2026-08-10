import { expect, type Page } from "@playwright/test";
import { en } from "../src/i18n";

// The one way a spec boots the app.
//
// SundaySync has no fixture seam inside `app/src` (unlike SundayRec's
// `api-shim.ts`/`window.__SUNDAYREC_FIXTURES__`) — App.tsx calls
// `@tauri-apps/api/core`'s `invoke` and `@tauri-apps/api/event`'s `listen` directly, and
// `DropZone.tsx` calls `getCurrentWebview().onDragDropEvent(...)`. All three of those
// bottom out in exactly one place: `window.__TAURI_INTERNALS__` (see
// `node_modules/@tauri-apps/api/core.js`: `invoke()` calls
// `window.__TAURI_INTERNALS__.invoke(cmd, args, options)`, and `transformCallback()`
// calls `window.__TAURI_INTERNALS__.transformCallback(cb)`). Outside a real Tauri
// webview that object does not exist at all, so the harness supplies it — an
// `__TAURI_INTERNALS__` shim, not an app-level fixture seam.
//
// Two things happen inside that shim:
//   1. `invoke()` answers from a per-command fixture table (`Fixtures`), or rejects with
//      a stable, greppable message when a command has no fixture — the same shape a
//      forgotten mock produces in SundayRec, so a spec fails loud rather than hanging on
//      "…".
//   2. Event subscriptions (`plugin:event|listen`, which is what `listen()` AND
//      `getCurrentWebview().listen()`/`onDragDropEvent()` all funnel through — see
//      `node_modules/@tauri-apps/api/event.js` and `webview.js`'s `_handleTauriEvent`,
//      which only special-cases `tauri://created`/`tauri://error`, NOT drag-drop) are
//      recorded by event name. `emit()` below replays a payload to every handler
//      registered under that name, exactly the way the real webview's IPC would invoke
//      the callback Tauri stashed at `window['_' + id]` via `transformCallback`.
//
// `localStorage["sundaysync.settings.v1"]` is seeded the same way SundayRec seeds its
// settings key: settings are read synchronously at module load (`settings.ts`'s
// `let current: Settings = load();`), so they have to be in place before the app's
// module graph executes — i.e. in the `addInitScript`, not after `page.goto`.

/** The localStorage key `settings.ts` persists under (`KEY`). */
export const SETTINGS_KEY = "sundaysync.settings.v1";

/** A canned answer per Tauri command name: a value, or a function of the args. */
export type Fixtures = Record<string, unknown>;

/**
 * Serialise fixtures across the `addInitScript` boundary.
 *
 * Functions do not survive structured clone, so anything that needs to branch on the
 * invoke args (or hold a promise open — see `controlled()`) is passed as SOURCE and
 * rebuilt inside the page. Everything else is plain data and goes over untouched.
 */
const FN_MARKER = "__sundaysync_fn__";
const VOID_MARKER = "__sundaysync_void__";

/** Wrap a function SOURCE string so `boot` rebuilds it inside the page. */
export function fn(source: string): unknown {
  return { [FN_MARKER]: source };
}

/**
 * A fixture that answers with `undefined` — the void commands (`cancel_sync`,
 * `report_frontend_error`, `plugin:opener|reveal_item_in_dir`, …).
 *
 * Needed because a bare `undefined` does not survive the `addInitScript` argument
 * boundary: Playwright's serialiser DROPS undefined-valued object properties, so
 * `{ cancel_sync: undefined }` arrives as `{}` and the command falls through to the
 * "no backend" rejection instead of resolving quietly the way the real command does.
 */
export const VOID: unknown = { [VOID_MARKER]: true };

/**
 * A fixture whose promise the SPEC controls the settlement of — the seam
 * "sync progress + cancel" needs: `run_sync` must stay pending while the test fires
 * `sync:progress` events, then resolve or reject on command.
 *
 * Installs `window.__SUNDAYSYNC_PENDING__[name] = { resolve, reject }` the moment the
 * command is invoked, so `resolveControlled`/`rejectControlled` below can reach in from
 * the Node side once the spec has seen whatever it needed to (a progress event, a
 * button state, …).
 */
export function controlled(name: string): unknown {
  return fn(`(args) => new Promise((resolve, reject) => {
    window.__SUNDAYSYNC_PENDING__ = window.__SUNDAYSYNC_PENDING__ || {};
    window.__SUNDAYSYNC_PENDING__[${JSON.stringify(name)}] = { resolve, reject, args };
  })`);
}

/** Waits until `controlled(name)` has actually been invoked (its promise is parked). */
export async function waitForPending(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    (n) => !!(window as unknown as Record<string, any>).__SUNDAYSYNC_PENDING__?.[n],
    name,
  );
}

/** Resolves a `controlled(name)` fixture's promise from the test side. */
export async function resolveControlled(page: Page, name: string, value: unknown): Promise<void> {
  await page.evaluate(
    ([n, v]) => (window as unknown as Record<string, any>).__SUNDAYSYNC_PENDING__[n as string].resolve(v),
    [name, value] as const,
  );
}

/**
 * Rejects a `controlled(name)` fixture's promise with a bare STRING from the test side —
 * matching real Tauri: a command returning `Result<T, String>` rejects `invoke()`'s
 * promise with the string itself, never an `Error` instance. `errors.ts`'s
 * `mapEngineError` matches those Rust `Display` strings by prefix (`raw.startsWith(...)`
 * — e.g. `"cancelled"`), so wrapping this in `new Error(...)` would silently break every
 * one of those checks (`String(new Error("cancelled"))` is `"Error: cancelled"`, which
 * does not start with `"cancelled"`).
 */
export async function rejectControlled(page: Page, name: string, message: string): Promise<void> {
  await page.evaluate(
    ([n, m]) =>
      (window as unknown as Record<string, any>).__SUNDAYSYNC_PENDING__[n as string].reject(m),
    [name, message] as const,
  );
}

/**
 * Fires a Tauri event to every handler currently subscribed under `name` — the harness's
 * hand on the "backend" side of `listen()`/`onDragDropEvent()`. Mirrors the payload shape
 * `event.js`'s `listen()` hands to a handler: `{ event, id, payload }`.
 */
export async function emit(page: Page, name: string, payload: unknown): Promise<void> {
  await page.evaluate(
    ([n, p]) => (window as unknown as Record<string, any>).__SUNDAYSYNC_EMIT__(n, p),
    [name, payload] as const,
  );
}

/**
 * Wait until the RESULT view is on screen.
 *
 * Since V04-U3 (D-061) the timeline is the main view: `.timeline__body`, `.clip` and the
 * ruler are all mounted from the sources phase onwards, so none of them means "the sync
 * has finished" any more. The export bar is result-only and is what actually distinguishes
 * the phases — every spec that used to gate on the timeline appearing now gates on this.
 */
export async function waitForResult(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: en.exportButton })).toBeVisible();
}

export interface BootOptions {
  /** Canned command answers. */
  fixtures?: Fixtures;
  /** Seeded settings, merged over `settings.ts`'s `DEFAULTS` by `load()`. */
  settings?: Record<string, unknown>;
}

let bootSeq = 0;

/**
 * Boot the renderer with fixtures + settings installed, and wait for the header — the
 * one element every phase renders — so a spec never races the first frame.
 */
export async function boot(page: Page, opts: BootOptions = {}): Promise<void> {
  const payload = {
    fixtures: opts.fixtures ?? {},
    settings: opts.settings ?? null,
    key: SETTINGS_KEY,
    marker: FN_MARKER,
    voidMarker: VOID_MARKER,
    // An init script runs on EVERY navigation in the context, including `page.reload()`.
    // Re-seeding settings there would silently overwrite whatever the app just
    // persisted — i.e. it would make every "does this survive a reload?" assertion a
    // test of the seed instead of the app. So settings are seeded exactly once per
    // `boot()` call, tracked by its own sentinel; a reload then keeps what the app wrote.
    seedOnce: `__e2e_seeded_${++bootSeq}`,
  };

  await page.addInitScript((p) => {
    const w = window as unknown as Record<string, unknown>;

    // ── The non-IPC half of the Tauri runtime ────────────────────────────────────────
    //
    // Fresh on every real navigation (a `page.reload()` wipes `window` entirely, same as
    // a real reload would), so this only needs a re-entrancy guard within one document's
    // lifetime, not across the whole test.
    if (!w.__TAURI_INTERNALS__) {
      let nextCallbackId = 1;
      let nextEventId = 1;
      /** event name -> the set of transformCallback ids subscribed to it. */
      const eventListeners = new Map<string, Set<number>>();
      /** eventId (returned to the caller of `plugin:event|listen`) -> what to remove. */
      const subscriptions = new Map<number, { event: string; handler: number }>();

      w.__TAURI_INTERNALS__ = {
        transformCallback(cb: (payload: unknown) => void) {
          const id = nextCallbackId++;
          (w as Record<string, unknown>)[`_${id}`] = cb;
          return id;
        },
        unregisterCallback(id: number) {
          delete (w as Record<string, unknown>)[`_${id}`];
        },
        invoke(cmd: string, args: unknown) {
          if (cmd === "plugin:event|listen") {
            const { event, handler } = args as { event: string; handler: number };
            let set = eventListeners.get(event);
            if (!set) {
              set = new Set();
              eventListeners.set(event, set);
            }
            set.add(handler);
            const eventId = nextEventId++;
            subscriptions.set(eventId, { event, handler });
            return Promise.resolve(eventId);
          }
          if (cmd === "plugin:event|unlisten") {
            const { eventId } = args as { eventId: number };
            const sub = subscriptions.get(eventId);
            if (sub) {
              eventListeners.get(sub.event)?.delete(sub.handler);
              subscriptions.delete(eventId);
            }
            return Promise.resolve(undefined);
          }

          const map = (w.__SUNDAYSYNC_FIXTURES__ ?? {}) as Record<string, unknown>;
          if (cmd in map) {
            try {
              const value = map[cmd];
              const result = typeof value === "function" ? value(args) : value;
              return Promise.resolve(result);
            } catch (e) {
              return Promise.reject(e);
            }
          }
          // No fixture: fail LOUD and distinguishably, rather than hanging the caller on
          // an unresolved promise that looks like a stuck screen.
          return Promise.reject(new Error(`no Tauri backend in the browser tier: ${cmd}`));
        },
        // Real Tauri hands back an `asset://`/`http://asset.localhost` URL. Nothing in
        // SundaySync's UI renders one as media, so this only has to be a harmless string.
        convertFileSrc(filePath: string, protocol = "asset") {
          return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
        },
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
      };

      // The harness's hand on the "backend" side of every `listen()`/`onDragDropEvent()`
      // subscription — see `emit()` above.
      (w as Record<string, unknown>).__SUNDAYSYNC_EMIT__ = (name: string, evPayload: unknown) => {
        const ids = eventListeners.get(name);
        if (!ids) return;
        for (const id of ids) {
          const cb = (w as Record<string, unknown>)[`_${id}`] as
            | ((payload: unknown) => void)
            | undefined;
          cb?.({ event: name, id, payload: evPayload });
        }
      };
    }

    const map: Record<string, unknown> = {};
    for (const [cmd, value] of Object.entries(p.fixtures)) {
      // Revive at install time (SundayRec's pattern): a `fn()` marker becomes a real
      // function once, here, rather than being reconstructed on every single invoke.
      if (value && typeof value === "object" && p.marker in (value as object)) {
        map[cmd] = new Function(`return (${(value as Record<string, unknown>)[p.marker]})`)();
      } else if (value && typeof value === "object" && p.voidMarker in (value as object)) {
        map[cmd] = () => undefined;
      } else {
        map[cmd] = value;
      }
    }
    // Fixtures ARE re-installed on every navigation: they stand in for a backend, and a
    // backend does not disappear because the page reloaded.
    w.__SUNDAYSYNC_FIXTURES__ = map;

    if (window.localStorage.getItem(p.seedOnce)) return;
    window.localStorage.setItem(p.seedOnce, "1");
    if (p.settings) window.localStorage.setItem(p.key, JSON.stringify(p.settings));
    else window.localStorage.removeItem(p.key);
  }, payload);

  await page.goto("/");
  // The header renders unconditionally on every phase (empty/scanning/sources/syncing/
  // result), so waiting on it is the renderer's own "I have painted" signal — there is
  // no `?goto=`/`window.showPage` equivalent in this app to poll instead.
  await page.locator(".app__header h1").waitFor();
}

/**
 * Settings that suppress first-run and the (unrelated) telemetry consent prompt, and
 * pin the language so a spec's text assertions do not depend on the host's locale
 * (`detectLang()` reads `navigator.language`, which Playwright/CI may set to anything).
 *
 * Every spec except onboarding.spec.ts wants this.
 */
export const SETTLED_SETTINGS = { onboardingDone: true, lang: "en" as const };

/**
 * The commands several screens touch on mount, answered with something harmless.
 * Spread this and override the handful a given journey is actually about.
 */
export const BOOT_FIXTURES: Fixtures = {
  check_sidecar: { source: "bundled", path: "/Applications/SundaySync.app/Contents/MacOS/ffmpeg" },
  cache_status: { dir: "/Users/e2e/Library/Caches/SundaySync", entries: 0, bytes: 0 },
  "plugin:dialog|open": null,
  "plugin:dialog|save": null,
  "plugin:opener|reveal_item_in_dir": VOID,
  cancel_sync: VOID,
  // `consentVersion` non-null means "already answered" — keeps the one-time
  // ConsentCard from popping up unbidden in specs that are not about consent.
  telemetry_status: { consentVersion: 1, granted: false, hasInstallId: true, queued: 0 },
};

/**
 * A deterministic `read_audio_window` (V03-S5, D-055).
 *
 * Answers every window with exactly `lenSamples` floats of a sine derived from the
 * absolute sample index, so the buffer a spec gets back is a pure function of what it
 * asked for — and never empty, which would be read as "this clip has ended".
 *
 * Real Tauri resolves this command to an `ArrayBuffer` (the shell answers with
 * `tauri::ipc::Response`); returning `.buffer` here keeps the browser tier on the same
 * shape the app will meet in production.
 */
export function pcmWindow(): Fixtures {
  return {
    read_audio_window: fn(`(args) => {
      const len = args.lenSamples;
      const out = new Float32Array(len);
      for (let i = 0; i < len; i += 1) out[i] = Math.sin((args.startSample + i) / 400);
      return out.buffer;
    }`),
  };
}

/**
 * Records every `set_telemetry_consent` call the page makes onto
 * `window.__E2E_CONSENT__`, so a spec can assert what the ANSWER was — not just that a
 * dialog advanced — while still answering with a realistic `TelemetryStatus`.
 */
export function consentSetSpy(): Fixtures {
  return {
    set_telemetry_consent: fn(`(args) => {
      window.__E2E_CONSENT__ = window.__E2E_CONSENT__ || [];
      window.__E2E_CONSENT__.push(args.granted);
      return {
        consentVersion: 1,
        granted: !!args.granted,
        hasInstallId: true,
        queued: 0,
      };
    }`),
  };
}

// ---- Sample domain data -------------------------------------------------------------
// Matches crates/core/src/{result,scan}.rs via app/src/types.ts (hand-mirrored there;
// asserted stable on the Rust side by scan_manifest_serde_spelling_is_stable and
// unsynced_reasons_match_the_plan_spelling).

export function scanManifest(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema: 1,
    devices: [
      { id: "rec", label: "Zoom recorder", kind: "audio", files: ["/Users/e2e/shoot/ZOOM0001.WAV"] },
      { id: "cam-a", label: "Camera A", kind: "video", files: ["/Users/e2e/shoot/CamA/C0001.MP4"] },
    ],
    files: [
      {
        file: "/Users/e2e/shoot/ZOOM0001.WAV",
        device: "rec",
        duration_seconds: 3600,
        format_name: "wav",
        audio: { codec: "pcm_s16le", sample_rate: 48000, channels: 2 },
        video: null,
        creation_time: null,
      },
      {
        file: "/Users/e2e/shoot/CamA/C0001.MP4",
        device: "cam-a",
        duration_seconds: 3550,
        format_name: "mov,mp4",
        audio: { codec: "aac", sample_rate: 48000, channels: 2 },
        video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
        creation_time: null,
      },
    ],
    unsynced: [],
    ...over,
  };
}

/** The earliest recording time in `presyncScanManifest()` — the pre-sync timeline's t=0. */
export const PRESYNC_ORIGIN_ISO = "2026-08-09T10:00:00.000Z";
/** How much later `CamB/C0002.MP4` started, in seconds. */
export const PRESYNC_B_OFFSET_SEC = 600;

/**
 * A drop the pre-sync timeline (V04-U3, D-061) has something to say about: two camera
 * files whose containers carry a real `creation_time` ten minutes apart, and a recorder
 * WAV that carries none at all.
 *
 * The mix is the point. Two stamps are needed for an offset to exist — with only one
 * timestamped file, that file IS the origin and sits at zero — and the untimed WAV is what
 * the "N files have no recording time" note is about.
 */
export function presyncScanManifest(): Record<string, unknown> {
  const laterIso = new Date(
    Date.parse(PRESYNC_ORIGIN_ISO) + PRESYNC_B_OFFSET_SEC * 1000,
  ).toISOString();
  return {
    schema: 1,
    devices: [
      { id: "rec", label: "Zoom recorder", kind: "audio", files: ["/Users/e2e/shoot/ZOOM0001.WAV"] },
      { id: "cam-a", label: "Camera A", kind: "video", files: ["/Users/e2e/shoot/CamA/C0001.MP4"] },
      { id: "cam-b", label: "Camera B", kind: "video", files: ["/Users/e2e/shoot/CamB/C0002.MP4"] },
    ],
    files: [
      {
        file: "/Users/e2e/shoot/ZOOM0001.WAV",
        device: "rec",
        duration_seconds: 3600,
        format_name: "wav",
        audio: { codec: "pcm_s16le", sample_rate: 48000, channels: 2 },
        video: null,
        creation_time: null,
      },
      {
        file: "/Users/e2e/shoot/CamA/C0001.MP4",
        device: "cam-a",
        duration_seconds: 1800,
        format_name: "mov,mp4",
        audio: { codec: "aac", sample_rate: 48000, channels: 2 },
        video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
        creation_time: PRESYNC_ORIGIN_ISO,
      },
      {
        file: "/Users/e2e/shoot/CamB/C0002.MP4",
        device: "cam-b",
        duration_seconds: 1800,
        format_name: "mov,mp4",
        audio: { codec: "aac", sample_rate: 48000, channels: 2 },
        video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
        creation_time: laterIso,
      },
    ],
    unsynced: [],
  };
}

export function syncOutcome(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    result: {
      schema: 1,
      parameters: { analysis_rate: 12000, min_psr: 15 },
      reference: { file: "/Users/e2e/shoot/ZOOM0001.WAV", device: "rec" },
      devices: [
        { id: "rec", label: "Zoom recorder", kind: "audio", files: ["/Users/e2e/shoot/ZOOM0001.WAV"] },
        { id: "cam-a", label: "Camera A", kind: "video", files: ["/Users/e2e/shoot/CamA/C0001.MP4"] },
      ],
      placements: [
        {
          file: "/Users/e2e/shoot/CamA/C0001.MP4",
          device: "cam-a",
          offset_seconds: 4.2,
          confidence: 0.95,
          psr: 38.4,
          drift_ppm: null,
          projected_end_error_ms: null,
          chain: [],
          warnings: [],
        },
      ],
      unsynced: [],
      sequence: { fps: "25/1", duration_seconds: 3600 },
      warnings: [],
    },
    durations: {
      "/Users/e2e/shoot/ZOOM0001.WAV": 3600,
      "/Users/e2e/shoot/CamA/C0001.MP4": 3550,
    },
    ...over,
  };
}
