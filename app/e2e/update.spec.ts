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

// D-095: the note the release shipped with. `latest.json` has carried a top-level `notes`
// field since the release-note mechanism landed (PR #68) — verified against the live beta
// feed — and until now nothing in the app ever read it: the operator was told a version
// number and asked to restart on faith.
test.describe("release notes in the update dialog (D-095)", () => {
  // Written the way the guard requires the real thing to be written: plain text, line
  // breaks as paragraphs, the thing that MOVED in the first sentence.
  const NOTE =
    "Blackout er flyttet fra Escape til Shift+B.\n\n" +
    "Eksport til Resolve tar med kameranavnet.";

  test("an offer with a note shows it, headed and with its line breaks intact", async ({
    page,
  }) => {
    await openSettings(page, {
      ...BOOT_FIXTURES,
      update_check: { phase: "available", version: "0.3.0", notes: NOTE },
    });

    await page.getByRole("button", { name: en.updateCheck }).click();
    await expect(page.getByText(en.updateAvailable("0.3.0"))).toBeVisible();

    const notes = page.getByRole("group", { name: en.updateNotesTitle });
    await expect(page.getByText(en.updateNotesTitle)).toBeVisible();
    await expect(notes).toBeVisible();
    // Both paragraphs, not just the first — `pre-line` keeps the blank line between them.
    await expect(notes).toContainText("Blackout er flyttet fra Escape til Shift+B.");
    await expect(notes).toContainText("Eksport til Resolve tar med kameranavnet.");
    expect(await notes.textContent()).toBe(NOTE);

    // Plain text BY CONTRACT: the note is inserted as text, never parsed. A note that
    // (against the guard) contained markup must reach the screen as characters.
    expect(await notes.evaluate((el) => el.children.length)).toBe(0);

    // The box scrolls, so a keyboard has to be able to reach it.
    await expect(notes).toHaveAttribute("tabindex", "0");
  });

  test("the note stays through download and restart — the moment it is actually read", async ({
    page,
  }) => {
    await openSettings(page, {
      ...BOOT_FIXTURES,
      update_check: { phase: "available", version: "0.3.0", notes: NOTE },
      update_download_install: fn(`(args) => new Promise((resolve) => {
        window.__SUNDAYSYNC_RESOLVE_DOWNLOAD__ = () =>
          resolve({ phase: "readyToInstall", version: "0.3.0", notes: ${JSON.stringify(NOTE)} });
      })`),
    });

    const notes = page.getByRole("group", { name: en.updateNotesTitle });
    await page.getByRole("button", { name: en.updateCheck }).click();
    await expect(notes).toBeVisible();

    await page.getByRole("button", { name: en.updateDownload("0.3.0") }).click();
    // Mid-download the phase is assembled in the renderer from the progress event, which
    // knows only version and percent — the note must not blink out for the duration.
    await emit(page, "update:progress", { version: "0.3.0", percent: 42 });
    await expect(page.getByText(en.updateDownloading(42))).toBeVisible();
    await expect(notes).toContainText("Blackout er flyttet");

    await page.evaluate(() => (window as any).__SUNDAYSYNC_RESOLVE_DOWNLOAD__());
    await expect(page.getByText(en.updateReady("0.3.0"))).toBeVisible();
    // "Restart now?" is the question the note answers.
    await expect(notes).toContainText("Blackout er flyttet");
  });

  test("an offer without a note shows nothing — no heading, no empty box", async ({ page }) => {
    // Every release built before the note mechanism. The field is simply absent.
    await openSettings(page, {
      ...BOOT_FIXTURES,
      update_check: { phase: "available", version: "0.3.0" },
    });

    await page.getByRole("button", { name: en.updateCheck }).click();
    await expect(page.getByText(en.updateAvailable("0.3.0"))).toBeVisible();
    await expect(page.getByText(en.updateNotesTitle)).toBeHidden();
    await expect(page.getByRole("group", { name: en.updateNotesTitle })).toHaveCount(0);
  });

  test("a blank note is the same as no note", async ({ page }) => {
    await openSettings(page, {
      ...BOOT_FIXTURES,
      update_check: { phase: "available", version: "0.3.0", notes: "  \n \n " },
    });

    await page.getByRole("button", { name: en.updateCheck }).click();
    await expect(page.getByText(en.updateAvailable("0.3.0"))).toBeVisible();
    await expect(page.getByRole("group", { name: en.updateNotesTitle })).toHaveCount(0);
  });

  test("a full-size note scrolls inside its own box and leaves the dialog where it was", async ({
    page,
  }) => {
    // The mechanism caps the note at 1000 bytes, so this is the worst case that can ever
    // reach the dialog — and the dialog is the one from D-094, whose FRAME must stay put
    // (a ✕ that leaves the screen was the bug that round fixed).
    const long = Array.from({ length: 34 }, (_, i) => `Linje ${i + 1} i et langt notat.`).join(
      "\n",
    );
    const bytes = new TextEncoder().encode(long).length;
    expect(bytes).toBeGreaterThan(900);
    expect(bytes).toBeLessThanOrEqual(1000); // the guard's ceiling — nothing bigger can arrive

    await page.setViewportSize({ width: 1024, height: 600 });
    await openSettings(page, {
      ...BOOT_FIXTURES,
      update_check: { phase: "available", version: "0.3.0", notes: long },
    });
    await page.getByRole("button", { name: en.updateCheck }).click();

    const notes = page.getByRole("group", { name: en.updateNotesTitle });
    await notes.scrollIntoViewIfNeeded();

    // The note is the one that scrolls, and it is capped well under a screenful.
    const box = await notes.evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
    }));
    expect(box.scroll).toBeGreaterThan(box.client);
    expect(box.client).toBeLessThan(220);

    // …and it stays inside the dialog's own scroller rather than stretching the frame.
    const dialog = page.getByRole("dialog", { name: en.settings });
    const frame = await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    });
    const viewport = page.viewportSize()!;
    expect(frame.top).toBeGreaterThanOrEqual(0);
    expect(frame.bottom).toBeLessThanOrEqual(viewport.height + 1);
    expect(frame.height).toBeLessThanOrEqual(viewport.height);

    // The ✕ is still on screen — D-094's actual failure mode, re-checked with the tallest
    // thing this panel can now contain sitting in the middle of it.
    const closeBox = await dialog.getByRole("button", { name: en.close }).boundingBox();
    expect(closeBox).not.toBeNull();
    expect(closeBox!.y).toBeGreaterThanOrEqual(0);
    expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(viewport.height);
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
