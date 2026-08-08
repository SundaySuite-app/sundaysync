import { test, expect } from "@playwright/test";
import { boot, BOOT_FIXTURES, emit, scanManifest, SETTLED_SETTINGS } from "./harness";
import { en } from "../src/i18n";

// Drop -> scan -> sources (§9.1/§9.2): the probe-only `scan_inputs` preview that shows
// what the app understood from a drop BEFORE any sync commits to it.

test.describe("drop, scan, sources", () => {
  test("choosing a folder scans it and renders the device summary before any sync", async ({
    page,
  }) => {
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, "plugin:dialog|open": ["/Users/e2e/shoot"], scan_inputs: scanManifest() },
      settings: SETTLED_SETTINGS,
    });

    await page.getByRole("button", { name: en.dropFolder }).click();

    const sources = page.getByRole("region", { name: en.sourcesTitle });
    await expect(sources).toBeVisible();
    await expect(sources.getByText(en.cameraCount(1))).toBeVisible();
    await expect(sources.getByText(en.recorderCount(1))).toBeVisible();
    await expect(sources.getByText(en.fileCount(2))).toBeVisible();
    // §9.2: the summary is BEFORE any sync — no "run_sync" fixture is even installed,
    // so this would blow up loudly (harness.ts's "no Tauri backend" rejection) if the
    // app tried to sync on its own.
    await expect(page.getByRole("button", { name: en.syncButton })).toBeVisible();
    await expect(sources.getByText(en.autoReference)).toBeVisible();

    // `.device-group__name` only, not a bare text match: `manifest.devices` is also
    // listed as `<option>`s in every row's "move to device" select, so "Camera A" and
    // "Zoom recorder" are NOT unique text on this page.
    const groupNames = sources.locator(".device-group__name");
    await expect(groupNames.filter({ hasText: "Zoom recorder" })).toBeVisible();
    await expect(groupNames.filter({ hasText: "Camera A" })).toBeVisible();
    await expect(sources.getByLabel(`${en.moveToDevice}: C0001.MP4`)).toBeVisible();
  });

  test("a real OS drag-drop populates sources the same way (onDragDropEvent)", async ({ page }) => {
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, scan_inputs: scanManifest() },
      settings: SETTLED_SETTINGS,
    });

    // Note: DropZone's switch only special-cases "over" (hover) and "drop"; "enter"
    // falls into the same `default` branch as "leave" and does NOT set the hover class.
    const dropzone = page.locator(".dropzone");
    await emit(page, "tauri://drag-over", { position: { x: 10, y: 10 } });
    await expect(dropzone).toHaveClass(/dropzone--over/);

    await emit(page, "tauri://drag-drop", {
      paths: ["/Users/e2e/shoot/CamA/C0001.MP4"],
      position: { x: 10, y: 10 },
    });

    await expect(dropzone).not.toHaveClass(/dropzone--over/);
    await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeVisible();
    await expect(page.getByText(en.fileCount(2))).toBeVisible();
  });

  test("a drag-leave without a drop clears the hover state and adds nothing", async ({ page }) => {
    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });

    const dropzone = page.locator(".dropzone");
    await emit(page, "tauri://drag-over", { position: { x: 5, y: 5 } });
    await expect(dropzone).toHaveClass(/dropzone--over/);

    await emit(page, "tauri://drag-leave", {});
    await expect(dropzone).not.toHaveClass(/dropzone--over/);
    // Still the empty state — nothing was dropped.
    await expect(page.getByRole("button", { name: en.dropAction })).toBeVisible();
    await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeHidden();
  });

  test("unusable files are reported honestly, not silently dropped", async ({ page }) => {
    const withProblem = scanManifest({
      unsynced: [{ file: "/Users/e2e/shoot/broken.mp4", reason: "decode_error" }],
    });
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, "plugin:dialog|open": ["/Users/e2e/shoot"], scan_inputs: withProblem },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();

    const sources = page.getByRole("region", { name: en.sourcesTitle });
    // The chip specifically: "1 problem file" also repeats verbatim in the unsynced
    // group's own meta line, so a bare text match is ambiguous.
    await expect(sources.locator(".chip.badge--problem")).toHaveText(en.problemCount(1));
    await expect(sources.getByText(en.unsyncedTitle)).toBeVisible();
    await expect(sources.getByText(en.reasonDecodeError)).toBeVisible();
    await expect(sources.getByText("broken.mp4")).toBeVisible();
  });

  test("removing the only root returns to the empty state", async ({ page }) => {
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, "plugin:dialog|open": ["/Users/e2e/shoot"], scan_inputs: scanManifest() },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeVisible();

    await page.locator(".roots .root button").click();

    await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeHidden();
    await expect(page.getByRole("button", { name: en.dropAction })).toBeVisible();
  });

  test("an override before any sync regroups the file, with nothing marked stale", async ({
    page,
  }) => {
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, "plugin:dialog|open": ["/Users/e2e/shoot"], scan_inputs: scanManifest() },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    const sources = page.getByRole("region", { name: en.sourcesTitle });
    await expect(sources).toBeVisible();

    // Move the camera file onto the recorder device — the §9.2 override overlay.
    await sources.getByLabel(`${en.moveToDevice}: C0001.MP4`).selectOption("rec");

    // The recorder group now shows 2 files; the camera group disappears (0 files left
    // in it is not rendered, per SourcesView's grouped.filter).
    await expect(sources.getByText(en.fileCount(2)).first()).toBeVisible();
    await expect(sources.locator(".device-group__name").filter({ hasText: "Camera A" })).toBeHidden();
    // No result exists yet, so there is nothing to mark stale — no such banner appears.
    await expect(page.getByText(en.staleResult)).toBeHidden();
  });
});
