import { test, expect } from "@playwright/test";
import { boot, BOOT_FIXTURES, scanManifest, SETTLED_SETTINGS, syncOutcome } from "./harness";
import { en } from "../src/i18n";

// §9's re-assign flow: reassigning a clip's device AFTER a sync has produced a result
// must mark that result stale — the "you are looking at an outcome that no longer
// matches what you told the app" signal (D-027/D-028), never a silent re-grouping.

async function reachResult(page: import("@playwright/test").Page) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: scanManifest(),
      run_sync: syncOutcome(),
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeVisible();
  await page.getByRole("button", { name: en.syncButton }).click();
  // Scoped to the result lanes, not a bare accessible-name match: SourcesView keeps
  // rendering alongside ResultView in the "result" phase, and its own "Use as
  // reference: C0001.MP4" button also contains that filename substring.
  await expect(page.locator(".clip", { hasText: "C0001.MP4" })).toBeVisible();
}

test.describe("override after sync marks the result stale", () => {
  test("a fresh result is not stale: export is enabled, no warning banner", async ({ page }) => {
    await reachResult(page);
    await expect(page.getByText(en.staleResult)).toBeHidden();
    await expect(page.getByRole("button", { name: en.exportButton })).toBeEnabled();
  });

  test("reassigning the placed clip's device marks the result stale", async ({ page }) => {
    await reachResult(page);

    await page.locator(".clip", { hasText: "C0001.MP4" }).click();
    const dialog = page.getByRole("dialog", { name: "C0001.MP4" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(en.moveToDevice).selectOption("rec");

    // The dialog closes itself right after the reassignment (ResultView's onChange
    // calls `onOverride` then `onClose`).
    await expect(dialog).toBeHidden();

    await expect(page.getByText(en.staleResult)).toBeVisible();
    await expect(page.getByRole("button", { name: en.exportButton })).toBeDisabled();
    // The primary action still reads "Sync again" — that label is a property of being
    // in the result phase at all, not new here, but the cached-analysis hint is the
    // part of the promise this scenario is actually about (D-027): a re-assign should
    // not force a cold re-decode.
    await expect(page.getByText(en.resyncHint)).toBeVisible();
  });

  test("reassigning via the unsynced shelf's own selector also marks it stale", async ({
    page,
  }) => {
    const base = syncOutcome();
    const outcomeWithUnsynced = {
      ...base,
      result: {
        ...(base.result as Record<string, unknown>),
        placements: [],
        unsynced: [{ file: "/Users/e2e/shoot/CamA/C0001.MP4", reason: "low_confidence" }],
      },
    };
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: scanManifest(),
        run_sync: outcomeWithUnsynced,
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await page.getByRole("button", { name: en.syncButton }).click();

    const shelf = page.locator(".shelf");
    await expect(shelf).toBeVisible();
    await expect(page.getByText(en.staleResult)).toBeHidden();

    await shelf.getByLabel(`${en.moveToDevice}: C0001.MP4`).selectOption("cam-a");

    await expect(page.getByText(en.staleResult)).toBeVisible();
    await expect(page.getByRole("button", { name: en.exportButton })).toBeDisabled();
  });
});
