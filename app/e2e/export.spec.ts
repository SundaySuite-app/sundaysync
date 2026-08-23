import { test, expect } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  fn,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForResult,
} from "./harness";
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
  // Since V04-U3 (D-061) `.clip` boxes exist from the sources phase on — the pre-sync
  // ones carry `clip--pre` — so their presence no longer means the
  // sync has finished. `waitForResult` gates on the result-only export bar.
  await waitForResult(page);
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

  test("the receipt is opaque and does not eat the timeline underneath it", async ({ page }) => {
    // V06-R3 pixel pass, two findings in one place — and one place is right, because they are
    // the same fact about the same rectangle.
    //
    // 1. It floats over the room (D-082), and `--green-bg` is a 10 %-alpha wash: correct for a
    //    banner in a page's flow, unreadable here, because what is behind a toast is not the
    //    page background but a timeline full of clips showing through the sentence. The export
    //    receipt is the longest thing this app ever says, so it is where this shows first.
    // 2. D-082 turned pointer events off on the LAYER so a transparent rectangle could not eat
    //    a click. The banner itself kept them — and it is three lines tall over the top device
    //    rows, so after an export the operator could not mark a clip there at all until they
    //    dismissed it. Its ✕ turns them back on for itself.
    await reachResult(page, {
      "plugin:dialog|save": "/Users/e2e/out/SundaySync.fcpxml",
      export_timeline: 1,
    });
    await page.getByRole("button", { name: en.exportButton }).click();
    const banner = page.locator(".banner--ok");
    await expect(banner).toBeVisible();

    // Opaque: no alpha channel left in the painted background.
    const bg = await banner.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, `banner background ${bg}`).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\s*\)/);

    // Inert: a hit test in the middle of the banner resolves to whatever is UNDERNEATH it.
    // Asked of the browser directly rather than inferred from two boxes overlapping — how
    // many lines this sentence wraps to, and therefore whether it reaches the first device
    // row, is a function of the platform's font metrics; whether it eats a press is not.
    const overBody = await banner.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return at !== null && el.contains(at);
    });
    expect(overBody).toBe(false);

    // …and the ✕ is the one thing in there that IS a control: it hit-tests to itself, and it
    // works.
    const overDismiss = await page.locator(".banner__dismiss").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return at !== null && el.contains(at);
    });
    expect(overDismiss).toBe(true);

    // The journey the finding was found by: mark a clip with the receipt still on screen.
    await page.locator(".clip").first().click();
    await expect(page.locator(".preview__name")).toBeVisible();

    await page.locator(".banner__dismiss").click();
    await expect(banner).toBeHidden();
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
