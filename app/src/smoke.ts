/**
 * What the app can only say about itself from inside the REAL webview — D-093.
 *
 * Every automated check on this frontend until now ran in headless Chromium with the Tauri
 * IPC mocked (`app/e2e/harness.ts`). The shipped app runs in WKWebView on macOS and WebView2
 * on Windows, and defects that live only in those engines have reached a Sunday Suite owner
 * before: SundayEdit shipped a renderer 42× slower in real WKWebView because its UA string
 * carries no `Safari` token — a fact Chromium cannot express.
 *
 * This module is the frontend half of the native smoke gate. Two responsibilities, both
 * deliberately tiny:
 *
 *  1. **Capture boot errors from the first line of the bundle.** The `error` /
 *     `unhandledrejection` listeners App.tsx installs live in an effect, so they only exist
 *     once React has already mounted — precisely the window in which an engine-specific
 *     module-evaluation failure would happen and go unseen. This module is imported first in
 *     `main.tsx` for that reason, and the order is load-bearing: ES modules evaluate in
 *     import order, so these listeners are attached before `App.tsx` is evaluated.
 *  2. **Offer one report to the shell after first paint.** The webview cannot read the
 *     shell's environment and therefore cannot know whether smoke mode is on, so it always
 *     offers; `smoke.rs` answers only under `SUNDAYSYNC_SMOKE=1` and returns immediately
 *     otherwise. Fire-and-forget, fully caught: nothing in the app awaits it, and a rejection
 *     (the e2e harness has no fixture for this command; a browser has no Tauri at all) is
 *     swallowed rather than becoming an unhandled rejection of its own.
 */

import { invoke } from "@tauri-apps/api/core";

/** A render loop that throws every frame must not grow an unbounded array. */
export const MAX_BOOT_ERRORS = 20;

const bootErrors: string[] = [];

/** Records one boot-time failure. Exported for the unit test; not for app use. */
export function recordBootError(kind: string, message: string): void {
  if (bootErrors.length >= MAX_BOOT_ERRORS) return;
  bootErrors.push(`${kind}: ${message || "(no message)"}`);
}

/** Everything caught since the bundle started evaluating. */
export function bootErrorsSoFar(): string[] {
  return [...bootErrors];
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("error", (event: ErrorEvent) => {
    recordBootError("error", event.message ?? String(event.error ?? ""));
  });
  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    recordBootError(
      "unhandledrejection",
      reason instanceof Error ? reason.message : String(reason),
    );
  });
}

/** The payload `smoke.rs`'s `FrontendReport` deserialises. */
export interface SmokeReport {
  userAgent: string;
  mounted: boolean;
  rootWidth: number;
  rootHeight: number;
  elementCount: number;
  bodyBackground: string;
  bootErrors: string[];
  readyMs: number;
  devicePixelRatio: number;
  language: string;
}

/**
 * Read the facts the shell cannot see.
 *
 * `mounted` alone is a weak claim — React attaches an empty `<div>` just as happily as the
 * whole app — so the report also carries the root's laid-out box (a zero-height root is not
 * a rendered one), the element count, and `<body>`'s computed background. That last one is
 * the cheapest available proof that the bundled stylesheet was actually fetched through
 * Tauri's asset protocol and applied, which the CSP and the custom protocol both have to be
 * right for and neither of which Chromium exercises.
 */
export function collectSmokeReport(doc: Document = document, win: Window = window): SmokeReport {
  const root = doc.getElementById("root");
  const rect = root?.getBoundingClientRect();
  let bodyBackground = "";
  try {
    bodyBackground = win.getComputedStyle(doc.body).backgroundColor || "";
  } catch {
    bodyBackground = "(unavailable)";
  }

  return {
    userAgent: win.navigator?.userAgent ?? "",
    mounted: (root?.childElementCount ?? 0) > 0,
    rootWidth: rect?.width ?? 0,
    rootHeight: rect?.height ?? 0,
    elementCount: doc.querySelectorAll("*").length,
    bodyBackground,
    bootErrors: bootErrorsSoFar(),
    readyMs: typeof win.performance?.now === "function" ? win.performance.now() : 0,
    devicePixelRatio: win.devicePixelRatio ?? 1,
    language: win.navigator?.language ?? "",
  };
}

/**
 * Offer the report to the shell after first paint.
 *
 * Two frames, not zero: a report taken in the same task as `render()` would measure a root
 * that has not been laid out yet and would call a perfectly healthy app zero-height. Called
 * BEFORE `render()` in `main.tsx` on purpose — if the first render throws, the frame
 * callback still runs and the shell gets `mounted: false` plus the actual error, instead of
 * silence and a watchdog timeout that says nothing about why.
 */
export function scheduleSmokeReport(win: Window = window): void {
  const send = (): void => {
    try {
      void invoke("smoke_report", { report: collectSmokeReport() }).catch(() => {
        /* no shell listening, or no shell at all */
      });
    } catch {
      /* @tauri-apps/api throws synchronously outside a Tauri webview */
    }
  };
  if (typeof win.requestAnimationFrame === "function") {
    win.requestAnimationFrame(() => win.requestAnimationFrame(send));
  } else {
    win.setTimeout(send, 0);
  }
}
