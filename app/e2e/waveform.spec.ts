import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  fn,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForResult,
  type Fixtures,
} from "./harness";
import { en } from "../src/i18n";

// Per-clip waveforms (v0.3 S4, D-052): `WaveformCanvas.tsx` draws inside `Clip.tsx`'s
// `.clip__waveform` slot, and the cache-miss/busy affordances that stand in for it when
// the analysis cache has nothing (yet) to draw. `waveformDraw.ts`/`waveformStore.ts`
// already prove the geometry and the fetch/cache bookkeeping in isolation (vitest); what
// is worth a browser is whether the three states actually reach the screen and whether
// the regenerate control does what D-052 promises.

const FILE = "/Users/e2e/shoot/CamA/C0001.MP4";
// Matches `syncOutcome()`'s duration for this file (3550 s) at the fixed 12 kHz rate the
// whole pyramid is built at (crates/core/src/request.rs `ANALYSIS_RATE`) — kept in sync
// with the meta and level fixtures below so a requested level's bin count and its byte
// count always agree.
const TOTAL_SAMPLES = 12_000 * 3550;

/** The same 13-level, doubling-bin ladder shape `peaks.rs` builds (10 ms → 40.96 s; the
 *  bound is the renderer's, see D-056), as a JS source fragment — inlined into every
 *  `fn()` fixture below rather than shared through an import, because fixtures cross the
 *  `addInitScript` boundary as plain source text (see harness.ts's header) and cannot
 *  `import` anything. */
const LEVELS_EXPR =
  `Array.from({ length: 13 }, (_, i) => { ` +
  `const binSamples = 120 * Math.pow(2, i); ` +
  `return { binSamples, bins: Math.ceil(${TOTAL_SAMPLES} / binSamples) }; })`;

/** A healthy pyramid — resolves immediately, every level present. */
function waveformMetaOk(): unknown {
  return fn(`(args) => ({ totalSamples: ${TOTAL_SAMPLES}, levels: ${LEVELS_EXPR} })`);
}

/**
 * Rejects with `cache_missing:<file>` (D-052's affordance state) for as long as nothing has
 * rebuilt that file, and answers normally once `regenerate_analysis` has — read straight off
 * `regenerateSpyOk()`'s own record, so the two fixtures describe one consistent cache.
 *
 * **V05-W1 (D-064) migrated this from "reject the first call per file".** A call counter
 * was a stand-in for a cause, and the app now has a second, legitimate reason to read: a
 * finished sync drops every memo and every clip looks again (`invalidateAll`), because the
 * run just wrote the very analysis those clips were missing. Under a counter that
 * re-read silently consumed the "first" rejection, and a test about the REBUILD BUTTON
 * stopped ever seeing one. Keyed on the rebuild instead, the fixture says what a real cache
 * says — "there is nothing here until something puts something here" — and no longer cares
 * how many times it is asked.
 */
function waveformMetaMissingUntilRebuilt(): unknown {
  return fn(`(args) => {
    const rebuilt = window.__E2E_REGENERATE__ || [];
    if (!rebuilt.includes(args.file)) return Promise.reject("cache_missing:" + args.file);
    return { totalSamples: ${TOTAL_SAMPLES}, levels: ${LEVELS_EXPR} };
  }`);
}

/** Never has a cache entry — every call rejects. */
function waveformMetaAlwaysCacheMissing(): unknown {
  return fn(`(args) => Promise.reject("cache_missing:" + args.file)`);
}

/** Fails with something that is neither a cache miss nor a busy refusal (an IO blip, a
 *  sweep that raced the read) until the test says the blip has passed, then answers
 *  normally — the transient the `other` branch used to turn into a permanent, unclearable
 *  dead end (finding 7).
 *
 *  Migrated from "fail each file's first call" for the same reason as the fixture above
 *  (V05-W1, D-064): the post-sync re-read is now a real event, and a counter would have let
 *  it clear the blip before the test had asked its question. The test clears it explicitly,
 *  which is also a truer story — an IO blip passes when it passes, not on a fixed count. */
function waveformMetaIoBlipUntilCleared(): unknown {
  return fn(`(args) => {
    if (!window.__E2E_IO_CLEARED__) return Promise.reject("io: Resource temporarily unavailable");
    return { totalSamples: ${TOTAL_SAMPLES}, levels: ${LEVELS_EXPR} };
  }`);
}

/** Deterministic `[peak, rms]` `u8` bytes, sized to whichever level was actually asked
 *  for — `barGeometry` picks the level from the current zoom, so the fixture cannot
 *  assume which index it will see. */
function waveformLevelOk(): unknown {
  return fn(`(args) => {
    const levels = ${LEVELS_EXPR};
    const lvl = levels[args.level];
    const bytes = new Uint8Array(lvl.bins * 2);
    for (let i = 0; i < lvl.bins; i += 1) {
      bytes[i * 2] = 200;
      bytes[i * 2 + 1] = 120;
    }
    return bytes.buffer;
  }`);
}

/** Records every `regenerate_analysis` call onto `window.__E2E_REGENERATE__` (the same
 *  window-recording pattern `consentSetSpy` in harness.ts uses), resolving successfully —
 *  the D-052 happy path. */
function regenerateSpyOk(): Fixtures {
  return {
    regenerate_analysis: fn(`(args) => {
      window.__E2E_REGENERATE__ = window.__E2E_REGENERATE__ || [];
      window.__E2E_REGENERATE__.push(args.file);
      return undefined;
    }`),
  };
}

/** The D-046 activity-guard refusal a regenerate hits while a sync (or another
 *  maintenance pass) already holds the slot. */
function regenerateBusy(): Fixtures {
  return { regenerate_analysis: fn(`(args) => Promise.reject("busy: sync in progress")`) };
}

async function reachResult(page: Page, waveformFixtures: Fixtures) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: scanManifest(),
      run_sync: syncOutcome(),
      ...waveformFixtures,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await page.getByRole("button", { name: en.syncButton }).click();
  // The timeline itself is mounted from the sources phase on (V04-U3, D-061), so waiting
  // for it no longer means the sync has finished — `waitForResult` gates on the
  // result-only export bar instead.
  await waitForResult(page);
}

/** The one placed clip's `.clip` box — scoped so `.clip__waveform`/regenerate-control
 *  queries never accidentally match anything outside it. */
function clipBox(page: Page) {
  return page.locator(".clip", { hasText: "C0001.MP4" });
}

test.describe("per-clip waveforms (v0.3 S4)", () => {
  test("a resolvable clip mounts a canvas inside its .clip__waveform slot", async ({ page }) => {
    await reachResult(page, { waveform_meta: waveformMetaOk(), waveform_level: waveformLevelOk() });

    const slot = clipBox(page).locator(".clip__waveform");
    await expect(slot).toBeVisible();
    await expect(slot.locator("canvas")).toBeVisible();
    // No error affordance for a healthy pyramid.
    await expect(clipBox(page).getByText(en.waveformUnavailable)).toHaveCount(0);
  });

  test("a cache-miss clip shows the regenerate control, not a canvas", async ({ page }) => {
    await reachResult(page, {
      waveform_meta: waveformMetaAlwaysCacheMissing(),
      waveform_level: waveformLevelOk(),
    });

    await expect(clipBox(page).getByRole("button", { name: en.waveformRegenerate })).toBeVisible();
    await expect(clipBox(page).locator(".clip__waveform canvas")).toHaveCount(0);
  });

  test("clicking regenerate calls regenerate_analysis and, once it succeeds, the canvas draws", async ({
    page,
  }) => {
    await reachResult(page, {
      waveform_meta: waveformMetaMissingUntilRebuilt(),
      waveform_level: waveformLevelOk(),
      ...regenerateSpyOk(),
    });

    const regenerate = clipBox(page).getByRole("button", { name: en.waveformRegenerate });
    await expect(regenerate).toBeVisible();

    await regenerate.click();

    // regenerate_analysis really was invoked, with the clip's own file.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__E2E_REGENERATE__))
      .toEqual([FILE]);

    // The cache-miss button is gone and a canvas has taken its place — no reload needed;
    // `invalidate()` + a fresh `fetchWaveformMeta` (the fixture's second, succeeding call)
    // drove it.
    await expect(regenerate).toHaveCount(0);
    await expect(clipBox(page).locator(".clip__waveform canvas")).toBeVisible();
  });

  test("clicking regenerate does not also select the clip", async ({ page }) => {
    // The regenerate control sits inside the clip's own clickable box (Clip.tsx's
    // `<button>`) — without `stopPropagation` this click would bubble and also fire
    // `onSelect`.
    //
    // V05-W4b (D-070) migrated the assertion, not the intent. There is no dialog to stay
    // hidden any more; what must not happen is that the preview panel CHANGES. So the panel
    // is checked before and after: still the empty state, still no file facts, still nobody
    // asked for a picture. (A "the dialog is hidden" assertion would silently pass forever
    // once dialogs stopped existing; this one cannot.)
    await reachResult(page, {
      waveform_meta: waveformMetaMissingUntilRebuilt(),
      waveform_level: waveformLevelOk(),
      ...regenerateSpyOk(),
    });

    const preview = page.locator(".preview");
    await expect(preview).toHaveText(en.previewEmpty);

    await clipBox(page).getByRole("button", { name: en.waveformRegenerate }).click();

    // The rebuild really happened — otherwise this would pass by the click missing entirely.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__E2E_REGENERATE__))
      .toEqual([FILE]);
    await expect(preview).toHaveText(en.previewEmpty);
    await expect(preview.locator(".preview__frame")).toHaveCount(0);
  });

  test("a D-046 busy refusal surfaces inline, retryable, distinct from the cache-miss copy", async ({
    page,
  }) => {
    await reachResult(page, {
      waveform_meta: waveformMetaAlwaysCacheMissing(),
      waveform_level: waveformLevelOk(),
      ...regenerateBusy(),
    });

    const regenerate = clipBox(page).getByRole("button", { name: en.waveformRegenerate });
    await expect(regenerate).toBeVisible();
    await regenerate.click();

    // Relabelled with the app's OWN busy copy — not the engine's raw English refusal
    // dressed up as a crash by `errUnknown` (finding 6). The raw detail is still there,
    // in the title, for anyone who needs it.
    const busyLabel = en.waveformBusy;
    const busy = clipBox(page).getByRole("button", { name: busyLabel });
    await expect(busy).toBeVisible();
    await expect(busy).not.toHaveAttribute("aria-disabled", "true");
    await expect(busy).toHaveAttribute("title", /busy: sync in progress/);
    await expect(clipBox(page).getByText(en.errUnknown("busy: sync in progress"))).toHaveCount(0);

    // Retrying is the same action, still available — not a dead end.
    await busy.click();
    await expect(clipBox(page).getByRole("button", { name: busyLabel })).toBeVisible();
  });

  test("a transient error is not a dead end — a zoom change brings the waveform back", async ({
    page,
  }) => {
    // Finding 7: the draw effect is gated on `!error` and only a fresh `loadMeta` cleared
    // it — reachable on a file change or a regenerate, neither of which this branch
    // offers. One transient failure therefore killed that clip's waveform for the rest of
    // the session. Recovery is now automatic on a material zoom change.
    await reachResult(page, {
      waveform_meta: waveformMetaIoBlipUntilCleared(),
      waveform_level: waveformLevelOk(),
      ...regenerateSpyOk(),
    });

    const status = clipBox(page).locator(".waveform__status");
    await expect(status).toHaveText(en.waveformUnavailable);
    // The raw engine detail is kept, on hover — never swallowed (§7.5).
    await expect(status).toHaveAttribute("title", /Resource temporarily unavailable/);
    await expect(clipBox(page).locator(".clip__waveform canvas")).toHaveCount(0);

    // The blip passes. Nothing tells the app so — that is the point: the clip is holding a
    // rejection and would hold it forever if a zoom change did not send it back to look.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__E2E_IO_CLEARED__ = true;
    });

    // Zoom until the quantized zoom bucket changes (BUTTON_FACTOR is 1.4, so at most a
    // few clicks) — no reload, no re-sync.
    const zoomIn = page.getByRole("button", { name: en.zoomIn });
    for (let i = 0; i < 4; i++) {
      await zoomIn.click();
      if ((await clipBox(page).locator(".clip__waveform canvas").count()) > 0) break;
    }
    await expect(clipBox(page).locator(".clip__waveform canvas")).toBeVisible();
    await expect(status).toHaveCount(0);

    // Recovery re-READS; it must never have re-extracted the source media behind the
    // user's back.
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__E2E_REGENERATE__),
    ).toBeUndefined();
  });

  test("the name and the status share one row instead of being drawn on top of each other", async ({
    page,
  }) => {
    // V05-W1, D-065 — the owner's screenshot, in geometry. `.clip__name` and the rebuild
    // control used to be independently positioned children of the same box: the name in
    // normal flow with an inline `translateX`, the control absolutely centred over the
    // whole clip with a `z-index` the name did not have. At any width they overlapped; at a
    // 386-file wedding's width they were both illegible and the control could not be aimed
    // at. They are flex siblings in one row now, and a row cannot overlap itself.
    await reachResult(page, {
      waveform_meta: waveformMetaAlwaysCacheMissing(),
      waveform_level: waveformLevelOk(),
    });

    const nameBox = (await clipBox(page).locator(".clip__name").boundingBox())!;
    const controlBox = (await clipBox(page)
      .getByRole("button", { name: en.waveformRegenerate })
      .boundingBox())!;
    const clip = (await clipBox(page).boundingBox())!;

    // Disjoint horizontally, in that order, with the gap between them.
    expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(controlBox.x);
    // Both inside the clip box — nothing spills out of a box that is `overflow: hidden`
    // only because the stylesheet remembers to be.
    expect(nameBox.x).toBeGreaterThanOrEqual(clip.x - 0.5);
    expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(clip.x + clip.width + 0.5);
    // And one line, not two: `CLIP_HEIGHT_PX` is 27 and the row must never wrap.
    expect(nameBox.height).toBeLessThan(clip.height);
    expect(nameBox.y).toBeGreaterThanOrEqual(clip.y - 0.5);
  });

  test("an unreadable clip can still be selected — the status line is not a click target", async ({
    page,
  }) => {
    // The reason the `other` branch is a plain span and not a `role="button"`:
    // `.clip__waveform` is centred and fills the clip, so a control here would sit
    // exactly where the user aims to click the clip and would swallow that click.
    await reachResult(page, {
      waveform_meta: fn(`(args) => Promise.reject("io: Resource temporarily unavailable")`),
      waveform_level: waveformLevelOk(),
    });

    await expect(clipBox(page).locator(".waveform__status")).toBeVisible();
    await clipBox(page).click();
    // Same intent, new surface (V05-W4b, D-070): "selected" is what the preview panel shows,
    // and the panel naming this very file is the proof the click reached the clip rather
    // than being swallowed by the status line lying on top of it.
    await expect(page.locator(".preview__name")).toHaveText("C0001.MP4");
  });
});
