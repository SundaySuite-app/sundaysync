import { defineConfig, devices } from "@playwright/test";

// The BROWSER tier (E10) — mirrors SundayRec's `e2e/` harness (see e2e/harness.ts for
// the design rationale). Deliberately separate from `npm run test` (vitest, jsdom-only,
// see vitest.config.ts) and from `npm run build`/`typecheck`: this drives the real
// renderer in a real browser with the Tauri IPC layer mocked, no Rust shell involved.
//
// ## Why this is possible at all
//
// `App.tsx` calls `@tauri-apps/api/core`'s `invoke` and `@tauri-apps/api/event`'s
// `listen` directly (there is no fixture seam inside `app/src`, unlike SundayRec's
// `api-shim.ts`) — but both of those, and `getCurrentWebview()`'s drag-drop listener in
// `DropZone.tsx`, bottom out in `window.__TAURI_INTERNALS__`, which simply does not
// exist outside a real Tauri webview. `e2e/harness.ts`'s `boot()` supplies that object
// before any app module runs (via `addInitScript`), backed by a per-test fixture table
// — so a real journey test costs a browser and nothing else: no Tauri, no ffmpeg, no
// Rust process, no device.
//
// ## What this tier is and is not
//
// It is not a second unit gate — `npm run test` already covers the pure logic
// (`state.ts`'s reducer, `errors.ts`, `telemetryErrors.ts`, `settings.ts`). These are UI
// journeys: boot the app, drive it the way an operator would, assert what they would
// see. Every assertion is web-first (`expect(locator).toBeVisible()`/`.toHaveText()`),
// never a fixed sleep — sleeping is the one thing guaranteed to be both slow and flaky.
export default defineConfig({
  testDir: "./e2e",

  // A journey is boot + a handful of interactions. 30 s is roomy for that and still
  // short enough that a genuine hang fails the run instead of stalling it.
  timeout: 30_000,
  expect: { timeout: 10_000 },

  fullyParallel: true,
  // A `.only` left in a spec silently shrinks the suite; on CI that must fail instead.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  // One project. The shipped renderer only ever runs inside WKWebView (macOS) or
  // WebView2 (Windows), neither of which is Chromium-in-Playwright anyway — a
  // cross-browser matrix would triple the runtime to test engines nobody ships.
  // Chromium is the closest available stand-in and the fastest.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // Playwright starts Vite itself (the same dev server `npm run dev` starts —
  // `vite.config.ts` pins port 1420 for exactly this reason), so `npx playwright test`
  // is the whole command; no "remember to start the dev server first".
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
