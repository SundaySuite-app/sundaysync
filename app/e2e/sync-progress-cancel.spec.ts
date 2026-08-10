import { test, expect } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  controlled,
  emit,
  rejectControlled,
  resolveControlled,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForPending,
  waitForResult,
} from "./harness";
import { en, stageLabel } from "../src/i18n";

// Sync progress + cancel-as-notice (D-030): `run_sync` is held open by `controlled()` so
// the spec can drive `sync:progress` events into it exactly like the Rust `EventSink`
// would, and — the load-bearing claim — a user-requested cancel must land as a neutral
// NOTICE banner, never the red "something broke" one.

async function reachSyncing(page: import("@playwright/test").Page) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: scanManifest(),
      run_sync: controlled("run_sync"),
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeVisible();
  await page.getByRole("button", { name: en.syncButton }).click();
  await waitForPending(page, "run_sync");
}

test.describe("sync progress", () => {
  test("progress events drive the stage label and the completed/total fraction", async ({
    page,
  }) => {
    await reachSyncing(page);

    // Before any event: indeterminate, generic "Syncing" label.
    await expect(page.locator(".progress__label")).toHaveText(en.syncing);
    await expect(page.locator(".progress__fill--indeterminate")).toBeVisible();

    await emit(page, "sync:progress", { stage: "Correlating", completed: 2, total: 5 });

    await expect(page.locator(".progress__label")).toContainText(stageLabel(en, "Correlating"));
    await expect(page.locator(".progress__label")).toContainText("2/5");
    const bar = page.getByRole("progressbar");
    await expect(bar).toHaveAttribute("aria-valuenow", "2");
    await expect(bar).toHaveAttribute("aria-valuemax", "5");
  });

  test("resolving the pending sync lands on the result view", async ({ page }) => {
    await reachSyncing(page);
    await emit(page, "sync:progress", { stage: "Placing", completed: 5, total: 5 });
    await resolveControlled(page, "run_sync", syncOutcome());

    // The result view specifically: since V04-U3 (D-061) the timeline and its `.clip`
    // boxes are already on screen during `syncing`, so the export bar is what actually
    // says the phase changed. The placed clip is then asserted to be a PLACED one —
    // enabled and no longer carrying the pre-sync class.
    await waitForResult(page);
    const clip = page.locator(".clip", { hasText: "C0001.MP4" });
    await expect(clip).toBeVisible();
    await expect(clip).not.toHaveClass(/clip--pre/);
    await expect(clip).toBeEnabled();
    await expect(page.getByRole("button", { name: en.cancel })).toBeHidden();
  });
});

test.describe("cancel", () => {
  test("cancelling calls cancel_sync and disables the button while it takes effect", async ({
    page,
  }) => {
    await reachSyncing(page);
    const cancelBtn = page.getByRole("button", { name: en.cancel });
    await cancelBtn.click();

    await expect(page.getByRole("button", { name: en.cancelling })).toBeDisabled();
  });

  test("a cancelled run surfaces as a NOTICE, never the red error banner (D-030)", async ({
    page,
  }) => {
    await reachSyncing(page);
    await page.getByRole("button", { name: en.cancel }).click();

    // The Rust engine's cancellation Display string is exactly "cancelled" — errors.ts
    // matches it by prefix and maps it to a notice.
    await rejectControlled(page, "run_sync", "cancelled");

    // The dismiss (✕) button lives inside the same `<p class="banner">`, so the text
    // assertion targets the message span specifically, not the paragraph's full text.
    const banner = page.locator(".banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveClass(/banner--info/);
    await expect(banner).not.toHaveClass(/banner--error/);
    await expect(banner.locator("span").first()).toHaveText(en.noticeCancelled);
    await expect(banner).not.toHaveAttribute("role", "alert");

    // Cancel is recoverable — the operator is back on the sources view, sync button
    // reads its normal label again, not stuck mid-run.
    await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeVisible();
    await expect(page.getByRole("button", { name: en.syncButton })).toBeEnabled();
  });

  test("a genuine engine failure (not a cancel) surfaces as a red error banner", async ({
    page,
  }) => {
    await reachSyncing(page);
    // The engine's stable Display prefix for a missing/broken ffmpeg — errors.ts maps
    // it to the (very different, very much NOT a notice) sidecar error copy.
    await rejectControlled(page, "run_sync", "ffmpeg sidecar unavailable: exit status 1");

    const banner = page.locator(".banner");
    await expect(banner).toHaveClass(/banner--error/);
    await expect(banner).toHaveAttribute("role", "alert");
    await expect(banner.locator("span").first()).toHaveText(en.errSidecar);
  });
});
