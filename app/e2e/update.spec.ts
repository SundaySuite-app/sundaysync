import { test, expect } from "@playwright/test";
import { boot, BOOT_FIXTURES, emit, fn, SETTLED_SETTINGS, type Fixtures } from "./harness";
import { en } from "../src/i18n";

// The in-app updater (E9, D-044): check → available → download (live `update:progress`) →
// readyToInstall → restart, plus the beta-ring toggle's consent re-surface interplay
// (SettingsPanel's `toggleBeta`). None of this had e2e coverage before — the settings
// panel's update section was reachable only by reading the code.

async function openSettings(page: import("@playwright/test").Page, fixtures: Fixtures) {
  await boot(page, { fixtures, settings: SETTLED_SETTINGS });
  await page.getByRole("button", { name: en.settings }).click();
  await expect(page.getByRole("dialog", { name: en.settings })).toBeVisible();
}

test.describe("update check + download", () => {
  test("up to date: the check reports it and offers no download button", async ({ page }) => {
    await openSettings(page, { ...BOOT_FIXTURES, update_check: { phase: "upToDate" } });

    await page.getByRole("button", { name: en.updateCheck }).click();
    await expect(page.getByText(en.updateUpToDate)).toBeVisible();
    await expect(page.getByRole("button", { name: /Download and install/ })).toBeHidden();
  });

  test("an available update offers Download; live progress then Restart", async ({ page }) => {
    await openSettings(page, {
      ...BOOT_FIXTURES,
      update_check: { phase: "available", version: "0.3.0" },
      update_download_install: fn(`(args) => new Promise((resolve) => {
        window.__SUNDAYSYNC_RESOLVE_DOWNLOAD__ = () =>
          resolve({ phase: "readyToInstall", version: "0.3.0" });
      })`),
    });

    await page.getByRole("button", { name: en.updateCheck }).click();
    await expect(page.getByText(en.updateAvailable("0.3.0"))).toBeVisible();

    const downloadBtn = page.getByRole("button", { name: en.updateDownload("0.3.0") });
    await expect(downloadBtn).toBeVisible();
    await downloadBtn.click();

    // The live percent arrives via the `update:progress` event, not the command's
    // return value (update.ts's `subscribeProgress`) — prove the event actually drives
    // the same status line `checkForUpdate`'s terminal phases render into.
    await emit(page, "update:progress", { version: "0.3.0", percent: 42 });
    await expect(page.getByText(en.updateDownloading(42))).toBeVisible();

    await page.evaluate(() => (window as any).__SUNDAYSYNC_RESOLVE_DOWNLOAD__());
    await expect(page.getByText(en.updateReady("0.3.0"))).toBeVisible();
    await expect(page.getByRole("button", { name: en.updateRestart })).toBeVisible();
  });

  test("a failed download surfaces the error, and re-checking lets the operator retry", async ({
    page,
  }) => {
    await openSettings(page, {
      ...BOOT_FIXTURES,
      update_check: { phase: "available", version: "0.3.0" },
      update_download_install: fn(`() => Promise.reject("network unreachable")`),
    });

    await page.getByRole("button", { name: en.updateCheck }).click();
    await page.getByRole("button", { name: en.updateDownload("0.3.0") }).click();

    await expect(page.getByText(en.updateError("network unreachable"))).toBeVisible();
    // The failure is not a wedge: Download disappeared with the "available" phase, but
    // Check for updates is still there and enabled — the operator's way back in.
    const checkBtn = page.getByRole("button", { name: en.updateCheck });
    await expect(checkBtn).toBeEnabled();

    await checkBtn.click();
    await expect(page.getByText(en.updateAvailable("0.3.0"))).toBeVisible();
    await expect(page.getByRole("button", { name: en.updateDownload("0.3.0") })).toBeVisible();
  });
});

test.describe("beta ring ↔ consent re-surface", () => {
  test("turning on beta re-opens consent for an undecided install", async ({ page }) => {
    // `consentVersion: null` means "undecided", so the card already auto-opens on boot
    // (App.tsx's own mount effect) — dismiss it without deciding (Escape, same as the
    // backdrop/✕: `onDismiss` records nothing) to reach the realistic "undecided but not
    // currently showing" state `toggleBeta`'s re-surface exists for.
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        telemetry_status: { consentVersion: null, granted: false, hasInstallId: false, queued: 0 },
      },
      settings: SETTLED_SETTINGS,
    });
    await expect(page.getByRole("dialog", { name: en.consentTitle })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: en.consentTitle })).toBeHidden();

    await page.getByRole("button", { name: en.settings }).click();
    await expect(page.getByRole("dialog", { name: en.settings })).toBeVisible();

    // `.click()`, not `.check()`: the click unmounts the checkbox's own dialog
    // (Settings closes as part of the fix), so `.check()`'s post-click "is it now
    // checked" actionability re-query on a now-detached element would hang instead of
    // reporting the state change it just caused.
    await page.getByRole("checkbox", { name: en.betaChannelLabel }).click();

    // Exactly one modal at a time: Settings hands off to Consent, it does not stack a
    // second `role="dialog"` on top of itself (two competing focus traps/Escape handlers).
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: en.settings })).toBeHidden();
    await expect(page.getByRole("dialog", { name: en.consentTitle })).toBeVisible();
  });

  test("turning on beta does not re-nag an install that already decided", async ({ page }) => {
    await openSettings(page, {
      ...BOOT_FIXTURES,
      telemetry_status: { consentVersion: 1, granted: false, hasInstallId: true, queued: 0 },
    });

    await page.getByRole("checkbox", { name: en.betaChannelLabel }).check();

    await expect(page.getByRole("dialog", { name: en.settings })).toBeVisible();
    await expect(page.getByRole("dialog", { name: en.consentTitle })).toBeHidden();
  });
});
