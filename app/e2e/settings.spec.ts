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
