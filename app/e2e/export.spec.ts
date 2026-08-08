import { test, expect } from "@playwright/test";
import { boot, BOOT_FIXTURES, fn, scanManifest, SETTLED_SETTINGS, syncOutcome } from "./harness";
import { en } from "../src/i18n";

// Export (§9.5) — including F6/D-036's defense-in-depth: the frontend already disables
// the export button while `phase.stale` is true, but `export_timeline` refuses
// independently if the sources it is handed no longer fingerprint-match the stored run.
// That backend refusal is what this file's last test proves reaches the operator as the
// SAME localized copy as any other engine error, not a raw Rust string.

/** The exact prefix `lib.rs`'s `STALE_EXPORT_MSG` starts every refusal with. */
const STALE_EXPORT_MSG =
  "the sources changed since this timeline was synced — run the sync again before exporting";

async function reachResult(page: import("@playwright/test").Page, extra: Record<string, unknown> = {}) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: scanManifest(),
      run_sync: syncOutcome(),
      ...extra,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await page.getByRole("button", { name: en.syncButton }).click();
  // Scoped to the result lanes, not a bare accessible-name match: SourcesView keeps
  // rendering alongside ResultView in the "result" phase, and its own "Use as
  // reference: C0001.MP4" button also contains that filename substring.
  await expect(page.locator(".clip", { hasText: "C0001.MP4" })).toBeVisible();
}

test.describe("export", () => {
  test("a successful export announces the clip count and offers Reveal in Finder", async ({
    page,
  }) => {
    await reachResult(page, {
      "plugin:dialog|save": "/Users/e2e/out/SundaySync.fcpxml",
      export_timeline: 1,
    });

    await page.getByRole("button", { name: en.exportButton }).click();

    const banner = page.locator(".banner");
    await expect(banner).toHaveClass(/banner--ok/);
    await expect(banner.locator("span").first()).toHaveText(`${en.exported(1)}. ${en.exportHint}`);
    await expect(page.getByRole("button", { name: en.revealInFinder })).toBeVisible();
  });

  test("cancelling the save dialog never calls export_timeline", async ({ page }) => {
    await reachResult(page, {
      "plugin:dialog|save": null,
      export_timeline: fn(`() => {
        window.__E2E_EXPORT_CALLED__ = true;
        return 0;
      }`),
    });

    await page.getByRole("button", { name: en.exportButton }).click();

    await expect(page.locator(".banner")).toBeHidden();
    expect(await page.evaluate(() => (window as any).__E2E_EXPORT_CALLED__)).toBeUndefined();
  });

  test("a stale-sources refusal from the backend shows the localized copy (F6/D-036)", async ({
    page,
  }) => {
    await reachResult(page, {
      "plugin:dialog|save": "/Users/e2e/out/SundaySync.fcpxml",
      export_timeline: fn(`() => { throw ${JSON.stringify(STALE_EXPORT_MSG)}; }`),
    });

    await page.getByRole("button", { name: en.exportButton }).click();

    const banner = page.locator(".banner");
    await expect(banner).toHaveClass(/banner--error/);
    await expect(banner.locator("span").first()).toHaveText(en.errStaleExport);
    // Never the raw backend string leaking through unlocalized.
    await expect(banner.locator("span").first()).not.toHaveText(STALE_EXPORT_MSG);
  });
});
