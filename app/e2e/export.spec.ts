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
  test("a successful export leaves its receipt in the strip, not over the room", async ({
    page,
  }) => {
    // V06-G3 (D-092 ⑤). The receipt used to be a three-line toast — «Exported 1 clip.» plus
    // the whole Resolve import instruction — floating over the top of the timeline. It is the
    // longest sentence the app ever says, it arrives at the exact moment the operator turns
    // back to the clips to check the run, and it covered them. A receipt is one line: the
    // thing happened, and here is what it is called. The instruction is a `title` on it and
    // lives in full in `docs/KNOWN_LIMITATIONS.md` («The import order, in full»), which is where an instruction belongs.
    await reachResult(page, {
      "plugin:dialog|save": "/Users/e2e/out/SundaySync.fcpxml",
      export_timeline: 1,
    });

    await page.getByRole("button", { name: en.exportButton }).click();

    const receipt = page.locator(".app__header .strip__receipt");
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText("SundaySync.fcpxml");
    await expect(receipt).toContainText(en.exportedShort);
    // Both things the strip cannot always finish saying survive in full, one hover away, on
    // the element that could not finish saying them: the file's whole name (it ellipsises at a
    // narrow window) and the Resolve import instruction (it never fitted a 44 px row at all).
    const title = await receipt.getAttribute("title");
    expect(title).toContain(en.exportHint);
    expect(title).toContain("SundaySync.fcpxml");

    // …and the receipt IS the control that opens the file: at 1024 the exported strip could
    // not hold both it and a separate «Vis i Finder», and the two were always one object.
    await expect(page.getByRole("button", { name: en.revealInFinder })).toHaveCount(1);
    await expect(receipt).toHaveAttribute(
      "aria-label",
      new RegExp(`${en.revealInFinder}$`),
    );

    // No toast at all on the happy path — the layer is for errors and notices now.
    await expect(page.locator(".toasts .banner")).toHaveCount(0);
  });

  test("the timeline's first row is not covered by anything the export said", async ({ page }) => {
    // The finding, expressed as the thing it broke: after an export, the top of the timeline
    // — the ruler and the first device's lane — must be exactly as reachable as before it.
    await reachResult(page, {
      "plugin:dialog|save": "/Users/e2e/out/SundaySync.fcpxml",
      export_timeline: 1,
    });
    const rulerBefore = (await page.locator(".timeline__ruler").boundingBox())!;

    await page.getByRole("button", { name: en.exportButton }).click();
    await expect(page.locator(".strip__receipt")).toBeVisible();

    // Nothing in the toast layer overlaps the ruler, because there is nothing in it.
    const overlaps = await page.evaluate(() => {
      const ruler = document.querySelector(".timeline__ruler")!.getBoundingClientRect();
      return Array.from(document.querySelectorAll(".toasts .banner"))
        .map((el) => el.getBoundingClientRect())
        .filter(
          (r) =>
            r.width > 0 &&
            r.height > 0 &&
            r.left < ruler.right &&
            r.right > ruler.left &&
            r.top < ruler.bottom &&
            r.bottom > ruler.top,
        ).length;
    });
    expect(overlaps).toBe(0);

    // The ruler has not moved either: a receipt on the strip is a receipt that costs the room
    // nothing.
    const rulerAfter = (await page.locator(".timeline__ruler").boundingBox())!;
    expect(rulerAfter.y).toBeCloseTo(rulerBefore.y, 0);
    expect(rulerAfter.height).toBeCloseTo(rulerBefore.height, 0);

    // And the journey the finding was found by: mark a clip right after exporting.
    await page.locator(".clip").first().click();
    await expect(page.locator(".preview__name")).toBeVisible();
  });

  test("an error toast is still opaque and still inert (D-082, V06-R3)", async ({ page }) => {
    // The toast layer did not go away — it carries what the app has to SAY when something
    // failed, and both of R3's findings about it are still claims about that layer:
    //
    // 1. it floats over the room, and a 10 %-alpha wash lets a timeline full of clips show
    //    through the sentence;
    // 2. D-082 turned pointer events off on the LAYER so a transparent rectangle could not eat
    //    a click, and the banner itself kept them — three lines of it over the top device rows
    //    meant a clip there could not be marked at all. Its ✕ turns them back on for itself.
    await reachResult(page, {
      "plugin:dialog|save": "/Users/e2e/out/SundaySync.fcpxml",
      export_timeline: fn(`() => { throw ${JSON.stringify(STALE_EXPORT_MSG)}; }`),
    });
    await page.getByRole("button", { name: en.exportButton }).click();
    const banner = page.locator(".banner--error");
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
