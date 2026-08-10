import { test, expect } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForResult,
} from "./harness";
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
  // Since V04-U3 (D-061) `.clip` boxes exist from the sources phase on — the pre-sync
  // ones carry `clip--pre` — so their presence no longer means the
  // sync has finished. `waitForResult` gates on the result-only export bar.
  await waitForResult(page);
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
    // V05-W4b (D-070): the reassign `<select>` moved with the rest of the clip detail into
    // the preview panel. Same control, same label, same consequence — and there is no
    // dialog to dismiss afterwards, so the operator can reassign a second clip by clicking
    // it, which is the whole reason the dialog went.
    const preview = page.locator(".preview");
    await expect(preview.locator(".preview__name")).toHaveText("C0001.MP4");
    await preview.getByLabel(en.moveToDevice).selectOption("rec");

    // The panel stays, and now describes the clip in its new home.
    await expect(preview.getByLabel(en.moveToDevice)).toHaveValue("rec");

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
