import { test, expect } from "@playwright/test";
import { boot, BOOT_FIXTURES, consentSetSpy, fn, SETTLED_SETTINGS, type Fixtures } from "./harness";
import { en } from "../src/i18n";

// The telemetry consent surface (E7): the one-time `ConsentCard` prompt, driven by
// `telemetry_status().consentVersion === null`, plus its re-openable twin in Settings —
// the toggle, the "show what we send" preview, and "delete my data".

const UNDECIDED: Fixtures = {
  ...BOOT_FIXTURES,
  telemetry_status: { consentVersion: null, granted: false, hasInstallId: false, queued: 0 },
};

test.describe("consent card", () => {
  test("appears when this install has not answered yet", async ({ page }) => {
    await boot(page, { fixtures: { ...UNDECIDED, ...consentSetSpy() }, settings: SETTLED_SETTINGS });
    await expect(page.getByRole("dialog", { name: en.consentTitle })).toBeVisible();
    await expect(page.getByText(en.consentIntro)).toBeVisible();
  });

  test("does not appear once this install has already decided", async ({ page }) => {
    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });
    await expect(page.getByRole("dialog", { name: en.consentTitle })).toBeHidden();
  });

  test("«Yes, happy to help» grants consent and dismisses the card", async ({ page }) => {
    await boot(page, { fixtures: { ...UNDECIDED, ...consentSetSpy() }, settings: SETTLED_SETTINGS });
    await page.getByRole("button", { name: en.consentAccept }).click();

    await expect
      .poll(() => page.evaluate(() => (window as any).__E2E_CONSENT__))
      .toEqual([true]);
    await expect(page.getByRole("dialog", { name: en.consentTitle })).toBeHidden();
  });

  test("«No thanks» declines and dismisses the card just the same", async ({ page }) => {
    await boot(page, { fixtures: { ...UNDECIDED, ...consentSetSpy() }, settings: SETTLED_SETTINGS });
    await page.getByRole("button", { name: en.consentDecline }).click();

    await expect
      .poll(() => page.evaluate(() => (window as any).__E2E_CONSENT__))
      .toEqual([false]);
    await expect(page.getByRole("dialog", { name: en.consentTitle })).toBeHidden();
  });
});

test.describe("telemetry settings section", () => {
  async function openSettings(page: import("@playwright/test").Page, fixtures: Fixtures) {
    await boot(page, { fixtures, settings: SETTLED_SETTINGS });
    await page.getByRole("button", { name: en.settings }).click();
    await expect(page.getByRole("dialog", { name: en.settings })).toBeVisible();
  }

  test("the toggle reflects the backend and writes back to it", async ({ page }) => {
    await openSettings(page, {
      ...BOOT_FIXTURES,
      ...consentSetSpy(),
      telemetry_status: { consentVersion: 1, granted: true, hasInstallId: true, queued: 3 },
    });

    // Scoped to the telemetry section specifically, not a bare text match: "Off" (the
    // status word) is also a case-insensitive substring of the drift-toggle-style hints
    // elsewhere on the panel ("Off until you turn it on…", "…turn it off.").
    const telemetrySection = page.locator(".field", { hasText: en.telemetryTitle });
    const status = telemetrySection.locator("small.subtle");

    const toggle = page.getByRole("checkbox", { name: en.telemetryToggleLabel });
    await expect(toggle).toBeChecked();
    await expect(status).toHaveText(en.telemetryStatus(true, 3));

    await toggle.click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__E2E_CONSENT__))
      .toEqual([false]);
    await expect(status).toHaveText(en.telemetryStatus(false, 0));
  });

  test("«Show what we send» renders the preview payload", async ({ page }) => {
    const payload = JSON.stringify({ installId: "e2e-install", counters: [] }, null, 2);
    await openSettings(page, {
      ...BOOT_FIXTURES,
      telemetry_status: { consentVersion: 1, granted: true, hasInstallId: true, queued: 0 },
      telemetry_preview: payload,
    });

    await page.getByRole("button", { name: en.telemetryShowPreview }).click();
    const modal = page.getByRole("dialog", { name: en.telemetryPreviewTitle });
    await expect(modal).toBeVisible();
    await expect(modal.locator("pre")).toHaveText(payload);
  });

  test("a failing preview command fails soft to the empty-state copy", async ({ page }) => {
    await openSettings(page, {
      ...BOOT_FIXTURES,
      telemetry_status: { consentVersion: 1, granted: true, hasInstallId: true, queued: 0 },
      // `getTelemetryPreview` swallows any rejection and resolves `null` — the card
      // shows the same "nothing yet" copy as a genuinely empty queue, never a stuck
      // "Loading …".
      telemetry_preview: fn(`() => { throw "preview unavailable" }`),
    });

    await page.getByRole("button", { name: en.telemetryShowPreview }).click();
    const modal = page.getByRole("dialog", { name: en.telemetryPreviewTitle });
    await expect(modal.locator("pre")).toHaveText(en.telemetryPreviewEmpty);
  });

  test("«Delete my data» asks for confirmation, then calls the deletion command", async ({
    page,
  }) => {
    await openSettings(page, {
      ...BOOT_FIXTURES,
      telemetry_status: { consentVersion: 1, granted: true, hasInstallId: true, queued: 0 },
      request_telemetry_deletion: fn(`() => {
        window.__E2E_DELETE_CALLED__ = true;
        return undefined;
      }`),
    });

    await page.getByRole("button", { name: en.telemetryDelete }).click();
    await expect(page.getByText(en.telemetryDeleteConfirm)).toBeVisible();

    // Confirming re-uses the same accessible name on the "danger" button — scope to the
    // row so the click lands on the confirm action, not the (already-replaced) opener.
    await page
      .getByText(en.telemetryDeleteConfirm)
      .locator("..")
      .getByRole("button", { name: en.telemetryDelete })
      .click();

    await expect.poll(() => page.evaluate(() => (window as any).__E2E_DELETE_CALLED__)).toBe(true);
    await expect(page.getByText(en.telemetryDeleted)).toBeVisible();
  });
});
