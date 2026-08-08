import { test, expect } from "@playwright/test";
import { boot, BOOT_FIXTURES, SETTINGS_KEY } from "./harness";
import { en } from "../src/i18n";

// The first-run wizard (Onboarding.tsx) — three steps, skippable, re-openable from
// Settings. `onboardingDone` gates it (see `App.tsx`'s
// `useState(() => !getSettings().onboardingDone)`), so every boot here seeds
// `onboardingDone: false` explicitly — the settled default every OTHER spec uses.
//
// `lang: "en"` is seeded on every boot in this file (not left to `detectLang()`) so the
// text assertions below do not depend on the host/CI browser's locale.

test.describe("onboarding", () => {
  test("shows on first run; a settled install does not", async ({ page }) => {
    await boot(page, {
      fixtures: BOOT_FIXTURES,
      settings: { onboardingDone: false, lang: "en" },
    });
    await expect(page.getByRole("dialog", { name: en.obTitle1 })).toBeVisible();

    await boot(page, {
      fixtures: BOOT_FIXTURES,
      settings: { onboardingDone: true, lang: "en" },
    });
    await expect(page.getByRole("dialog", { name: en.obTitle1 })).toBeHidden();
  });

  test("steps advance forward and back, and the dot count tracks the step", async ({ page }) => {
    await boot(page, {
      fixtures: BOOT_FIXTURES,
      settings: { onboardingDone: false, lang: "en" },
    });

    const dots = page.locator(".onboarding__dots");
    await expect(page.getByRole("heading", { name: en.obTitle1 })).toBeVisible();
    await expect(dots).toHaveAttribute("aria-label", en.obStep(1, 3));

    await page.getByRole("button", { name: en.obNext }).click();
    await expect(page.getByRole("heading", { name: en.obTitle2 })).toBeVisible();
    await expect(dots).toHaveAttribute("aria-label", en.obStep(2, 3));

    await page.getByRole("button", { name: en.obNext }).click();
    await expect(page.getByRole("heading", { name: en.obTitle3 })).toBeVisible();
    await expect(dots).toHaveAttribute("aria-label", en.obStep(3, 3));
    // Step 3 is a self-test of the bundled engine (`check_sidecar`) — a bundled result
    // shows the green line, not the "missing" fallback.
    await expect(page.locator(".onboarding__status--ok")).toContainText(en.obFfmpegBundled);

    await page.getByRole("button", { name: en.obBack }).click();
    await expect(page.getByRole("heading", { name: en.obTitle2 })).toBeVisible();
  });

  test("finishing on the last step persists onboardingDone and closes the wizard", async ({
    page,
  }) => {
    await boot(page, {
      fixtures: BOOT_FIXTURES,
      settings: { onboardingDone: false, lang: "en" },
    });
    await page.getByRole("button", { name: en.obNext }).click();
    await page.getByRole("button", { name: en.obNext }).click();
    await page.getByRole("button", { name: en.obDone }).click();

    await expect(page.getByRole("dialog", { name: en.obTitle1 })).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(
          (key) => JSON.parse(window.localStorage.getItem(key) || "{}").onboardingDone,
          SETTINGS_KEY,
        ),
      )
      .toBe(true);
  });

  test("skipping from step 1 also persists onboardingDone — it is not a lesser exit", async ({
    page,
  }) => {
    await boot(page, {
      fixtures: BOOT_FIXTURES,
      settings: { onboardingDone: false, lang: "en" },
    });
    await expect(page.getByRole("heading", { name: en.obTitle1 })).toBeVisible();

    // Scoped to the footer nav: the dialog's ✕ close button carries the SAME accessible
    // name (`closeLabel={t.obSkip}`), so an unscoped role query would match both.
    await page.locator(".onboarding__nav").getByRole("button", { name: en.obSkip }).click();

    await expect(page.getByRole("dialog", { name: en.obTitle1 })).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(
          (key) => JSON.parse(window.localStorage.getItem(key) || "{}").onboardingDone,
          SETTINGS_KEY,
        ),
      )
      .toBe(true);
  });

  test("re-openable from Settings, without re-running first run", async ({ page }) => {
    await boot(page, {
      fixtures: BOOT_FIXTURES,
      settings: { onboardingDone: true, lang: "en" },
    });
    await expect(page.getByRole("dialog", { name: en.obTitle1 })).toBeHidden();

    await page.getByRole("button", { name: en.settings }).click();
    await expect(page.getByRole("dialog", { name: en.settings })).toBeVisible();
    await page.getByRole("button", { name: en.showOnboarding }).click();

    await expect(page.getByRole("dialog", { name: en.obTitle1 })).toBeVisible();
    // Settings closed behind it rather than stacking two dialogs.
    await expect(page.getByRole("dialog", { name: en.settings })).toBeHidden();
  });
});
