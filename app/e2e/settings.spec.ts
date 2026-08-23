import { test, expect } from "@playwright/test";
import { boot, BOOT_FIXTURES, SETTINGS_KEY, SETTLED_SETTINGS } from "./harness";
import { en } from "../src/i18n";

// §9 advanced settings: every field persists to `localStorage["sundaysync.settings.v1"]`
// per-machine (D-029), and an untouched install behaves exactly like simple mode — so
// each test here checks BOTH the visible feedback and the actual storage write, not just
// "the checkbox looks checked" (a pure UI change would pass that too).

async function readSettings(page: import("@playwright/test").Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) || "{}"),
    SETTINGS_KEY,
  );
}

async function openSettings(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: en.settings }).click();
  await expect(page.getByRole("dialog", { name: en.settings })).toBeVisible();
}

test.describe("settings persistence", () => {
  test("language selection persists and updates the document language", async ({ page }) => {
    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });
    await openSettings(page);

    await page.getByLabel(en.language).selectOption("nb");

    await expect.poll(() => readSettings(page).then((s) => s.lang)).toBe("nb");
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("nb");
  });

  test("the match-threshold field commits on blur, and rejects invalid input", async ({
    page,
  }) => {
    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });
    await openSettings(page);

    const field = page.getByLabel(en.minPsr);
    await field.fill("20");
    await field.blur();
    await expect.poll(() => readSettings(page).then((s) => s.minPsr)).toBe(20);

    await field.fill("-5");
    await field.blur();
    await expect(page.getByText(en.minPsrInvalid)).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    // The bad input must not have overwritten the last good value.
    await expect.poll(() => readSettings(page).then((s) => s.minPsr)).toBe(20);
  });

  test("segment count persists", async ({ page }) => {
    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });
    await openSettings(page);

    await page.getByLabel(en.segmentCount).selectOption("7");
    await expect.poll(() => readSettings(page).then((s) => s.segmentCount)).toBe(7);
  });

  test("the drift-correction toggle persists (on by default, D-042)", async ({ page }) => {
    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });
    await openSettings(page);

    const toggle = page.getByRole("checkbox", { name: en.driftCorrect });
    await expect(toggle).toBeChecked();

    await toggle.uncheck();
    await expect.poll(() => readSettings(page).then((s) => s.correctDrift)).toBe(false);
  });

  test("the playback drift toggle persists and reaches the running engine (V03-S6)", async ({
    page,
  }) => {
    // S5 added the setting and the engine method; S6 added the control. Two separate
    // switches on purpose (D-055): correcting the export while listening uncorrected — or
    // the other way round — is a legitimate comparison to want, so unchecking this must
    // not touch `correctDrift`.
    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });
    await openSettings(page);

    const toggle = page.getByRole("checkbox", { name: en.playbackDriftCorrect });
    await expect(toggle).toBeChecked();

    await toggle.uncheck();
    await expect
      .poll(() => readSettings(page).then((s) => s.playbackDriftCorrected))
      .toBe(false);
    // The export's own switch is untouched.
    await expect(page.getByRole("checkbox", { name: en.driftCorrect })).toBeChecked();

    // (That the RUNNING engine picks the change up without a restart is proved in
    // playback.spec.ts, where there is a schedule to look at.)

    await toggle.check();
    await expect.poll(() => readSettings(page).then((s) => s.playbackDriftCorrected)).toBe(true);
  });

  test("a field--inline is the one-line row it names — in Settings and in the inspector", async ({
    page,
  }) => {
    // The modifier once sat ABOVE `.field` in the sheet and silently lost the cascade at
    // equal specificity: the cache-cap label stacked over its input as a column. The base
    // pair now sits below `.field`, so the row shape holds everywhere without per-context
    // specificity bumps. This pins the geometry, not the CSS text: label and input share
    // one horizontal band.
    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });
    await page.getByRole("button", { name: en.settings }).click();
    const row = page.locator(".settings .field--inline");
    const label = row.locator("> span").first();
    const input = row.getByLabel(en.cacheCap);
    const [lb, ib] = [await label.boundingBox(), await input.boundingBox()];
    expect(lb && ib).toBeTruthy();
    // One line: the two boxes overlap vertically (the label's band contains the input's
    // centre) and the input starts to the label's right — a column puts it below instead.
    expect(ib!.y + ib!.height / 2).toBeGreaterThan(lb!.y);
    expect(ib!.y + ib!.height / 2).toBeLessThan(lb!.y + lb!.height + 4);
    expect(ib!.x).toBeGreaterThan(lb!.x + lb!.width - 1);
  });

  test("the cache size cap enforces immediately and persists; clearing it turns the cap off", async ({
    page,
  }) => {
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, enforce_cache_cap: { entries: 0, bytes: 0 } },
      settings: SETTLED_SETTINGS,
    });
    await openSettings(page);

    const cap = page.getByLabel(en.cacheCap);
    await cap.fill("500");
    await cap.blur();
    await expect.poll(() => readSettings(page).then((s) => s.cacheCapMb)).toBe(500);

    await cap.fill("");
    await cap.blur();
    await expect.poll(() => readSettings(page).then((s) => s.cacheCapMb)).toBeNull();
  });

  test("values survive a full reload, not just a re-render", async ({ page }) => {
    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });
    await openSettings(page);

    await page.getByRole("checkbox", { name: en.driftCorrect }).uncheck();
    const field = page.getByLabel(en.minPsr);
    await field.fill("12");
    await field.blur();
    await expect.poll(() => readSettings(page).then((s) => s.correctDrift)).toBe(false);
    await expect.poll(() => readSettings(page).then((s) => s.minPsr)).toBe(12);

    await page.reload();
    await page.locator(".app__header h1").waitFor();
    await openSettings(page);

    await expect(page.getByRole("checkbox", { name: en.driftCorrect })).not.toBeChecked();
    await expect(page.getByLabel(en.minPsr)).toHaveValue("12");
  });
});
