import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  controlled,
  emit,
  resolveControlled,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForPending,
} from "./harness";
import { en, stageLabel } from "../src/i18n";

/**
 * Drop → scan → «Kilder» (§9.1/§9.2, rewritten for V06-R2a's D-077/D-078).
 *
 * This is `sources.spec.ts` re-expressed, not replaced (D-085). Every claim it made is still
 * made here; what changed is where the app makes them. The sources panel is gone, and its
 * fourteen affordances are four places in the room:
 *
 *   - the **summary line on the strip** says how much was dropped, and IS the disclosure that
 *     opens the list — roots, device groups, one row per file;
 *   - the **problem chip** beside it opens what could not be used;
 *   - the **bottom slot's chips** carry what was skipped and what was removed;
 *   - the **inspector column** carries the three decisions about the one marked clip.
 *
 * `getByRole("region", { name: sourcesTitle })` still resolves — it names the strip's sources
 * cluster now — which is why ten other specs did not have to move.
 */

/** The strip's sources cluster: summary popover, problem chip, pre-analysis tick. */
function sources(page: Page) {
  return page.getByRole("region", { name: en.sourcesTitle });
}

/** Open «Kilder» — the summary line is the `<summary>` (D-077 #1/#4). */
async function openSources(page: Page) {
  await sources(page).locator(".popover--sources > summary").click();
  await expect(sources(page).locator(".popover--sources .popover__panel")).toBeVisible();
}

test.describe("drop, scan, sources", () => {
  test("choosing a folder scans it and says what was dropped before any sync", async ({
    page,
  }) => {
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, "plugin:dialog|open": ["/Users/e2e/shoot"], scan_inputs: scanManifest() },
      settings: SETTLED_SETTINGS,
    });

    await page.getByRole("button", { name: en.dropFolder }).click();

    await expect(sources(page)).toBeVisible();
    // D-077 #3/#4: the camera/recorder chips are gone — one line has room for one claim, and
    // the split between the two kinds of device is in the list one click behind it and in the
    // timeline's own gutter icons. What the line says is «N files · M devices».
    await expect(sources(page).locator(".strip__summary")).toContainText(en.fileCount(2));
    await expect(sources(page).locator(".strip__summary")).toContainText(en.deviceCount(2));
    // §9.2: the summary is BEFORE any sync — no "run_sync" fixture is even installed, so this
    // would blow up loudly (harness.ts's "no Tauri backend" rejection) if the app synced on
    // its own.
    await expect(page.getByRole("button", { name: en.syncButton })).toBeVisible();
    // D-077 #7: the auto-reference promise is a quiet line in the bottom slot now.
    await expect(page.locator(".slot").getByText(en.autoReference)).toBeVisible();

    await openSources(page);

    // `.device-group__name` only, not a bare text match: `manifest.devices` is also listed as
    // `<option>`s in the inspector's "move to device" select, so "Camera A" and "Zoom
    // recorder" are NOT unique text on this page.
    const groupNames = sources(page).locator(".device-group__name");
    await expect(groupNames.filter({ hasText: "Zoom recorder" })).toBeVisible();
    await expect(groupNames.filter({ hasText: "Camera A" })).toBeVisible();
    // D-077 #8: the file list survives, because on a 386-clip drop a clip is three pixels wide
    // and finding one file BY NAME is the one thing the timeline cannot do.
    await expect(sources(page).getByText("C0001.MP4")).toBeVisible();
    await expect(sources(page).getByText("ZOOM0001.WAV")).toBeVisible();
    // The roots that were dropped, each with its own ✕ (D-077 #1).
    await expect(sources(page).locator(".roots .root button")).toHaveCount(1);
  });

  test("a file row marks the clip and closes the panel (D-077 #8)", async ({ page }) => {
    // The row is a button now, and what it does is the errand the list exists for: find the
    // file by name, look at it. The three per-file controls it used to carry are on the ONE
    // marked clip in the inspector instead.
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, "plugin:dialog|open": ["/Users/e2e/shoot"], scan_inputs: scanManifest() },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await openSources(page);

    await sources(page).locator(".filerow--pick", { hasText: "C0001.MP4" }).click();

    await expect(page.locator(".preview__name")).toHaveText("C0001.MP4");
    // Left open, the panel would cover the column the click just filled.
    await expect(sources(page).locator(".popover--sources .popover__panel")).toBeHidden();
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
    await expect(sources(page)).toBeVisible();
    // The summary line specifically. "2 files" is also a substring of the timeline's own
    // "2 files have no recording time …" note (D-061), so a page-wide text match is ambiguous
    // — and this assertion was always about the count the app leads with.
    await expect(sources(page).locator(".strip__summary")).toContainText(en.fileCount(2));
  });

  test("a drag-leave without a drop clears the hover state and adds nothing", async ({ page }) => {
    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });

    const dropzone = page.locator(".dropzone");
    await emit(page, "tauri://drag-over", { position: { x: 5, y: 5 } });
    await expect(dropzone).toHaveClass(/dropzone--over/);

    await emit(page, "tauri://drag-leave", {});
    await expect(dropzone).not.toHaveClass(/dropzone--over/);
    // Still the empty state — nothing was dropped, so there is no cluster on the strip at all.
    await expect(page.getByRole("button", { name: en.dropAction })).toBeVisible();
    await expect(sources(page)).toBeHidden();
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

    // The chip is the summary of its own popover now (D-077 #5/#12), so the count is on the
    // strip and the list is one click away — reported, not hidden. The test asserts both.
    const problems = sources(page).locator(".popover--problems");
    await expect(problems.locator("> summary")).toHaveText(en.problemCount(1));
    await expect(problems.getByText(en.reasonDecodeError)).toBeHidden();

    await problems.locator("> summary").click();

    await expect(problems.getByText(en.unsyncedTitle)).toBeVisible();
    await expect(problems.getByText(en.reasonDecodeError)).toBeVisible();
    await expect(problems.getByText("broken.mp4")).toBeVisible();
    // And the ✕ is on a problem row exactly as it is on a readable one — "om de kan leses
    // eller ikke" (D-062).
    await expect(problems.getByLabel(`${en.removeFile}: broken.mp4`)).toBeVisible();
  });

  test("files the scan walked past are counted, not vanished (D-066)", async ({ page }) => {
    // The drone folder from the owner's wedding, in miniature: a `.LRF` proxy beside its
    // original, an orphaned one, and the `IMG_4164.HEIC` that used to reach the red shelf
    // as an "error" about a photograph.
    const withSkips = scanManifest({
      skipped: [
        { file: "/Users/e2e/shoot/DRONE/DJI_0075.LRF", reason: "sidecar" },
        { file: "/Users/e2e/shoot/DRONE/DJI_0080.LRF", reason: "sidecar" },
        { file: "/Users/e2e/shoot/STEINAR/IMG_4164.HEIC", reason: "still_image" },
      ],
    });
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, "plugin:dialog|open": ["/Users/e2e/shoot"], scan_inputs: withSkips },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();

    // D-077 #14: a chip in the bottom slot. The line is visible while the list is folded —
    // that is the whole point of it.
    const skipped = page.locator(".slot__skipped");
    await expect(skipped.getByText(en.skippedSummary(2, 1))).toBeVisible();
    await expect(skipped.getByText("IMG_4164.HEIC")).toBeHidden();
    // And it is NOT the red shelf: nothing failed, so no problem chip appears.
    await expect(sources(page).locator(".popover--problems")).toHaveCount(0);

    await skipped.locator("> summary").click();

    await expect(skipped.getByText("DJI_0075.LRF")).toBeVisible();
    await expect(skipped.getByText("IMG_4164.HEIC")).toBeVisible();
    // The badges specifically: "still image" is also a substring of the summary line above,
    // so a bare text match inside the popover is ambiguous by construction.
    const badges = skipped.locator(".filerow--skipped .badge");
    await expect(badges.filter({ hasText: en.skippedReason("still_image") })).toHaveCount(1);
    await expect(badges.filter({ hasText: en.skippedReason("sidecar") })).toHaveCount(2);
  });

  test("nothing skipped means no skipped chip at all (D-066)", async ({ page }) => {
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, "plugin:dialog|open": ["/Users/e2e/shoot"], scan_inputs: scanManifest() },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();

    await expect(sources(page)).toBeVisible();
    // An empty (or absent) list must say nothing — a permanent "0 files were skipped" would be
    // a line the operator reads past on every clean drop.
    await expect(page.locator(".slot__skipped")).toHaveCount(0);
  });

  test("removing the only root returns to the empty state", async ({ page }) => {
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, "plugin:dialog|open": ["/Users/e2e/shoot"], scan_inputs: scanManifest() },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(sources(page)).toBeVisible();
    await openSources(page);

    await page.locator(".roots .root button").click();

    await expect(sources(page)).toBeHidden();
    await expect(page.getByRole("button", { name: en.dropAction })).toBeVisible();
  });

  test("«Tøm alt» clears every root at once (D-077 #2)", async ({ page }) => {
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot/CamA", "/Users/e2e/shoot/CamB"],
        scan_inputs: scanManifest(),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await openSources(page);
    // Two roots, so the control that clears all of them is there at all.
    await expect(sources(page).locator(".roots .root")).toHaveCount(2);

    await sources(page).getByRole("button", { name: en.clearAll }).click();

    await expect(sources(page)).toBeHidden();
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
    await expect(sources(page)).toBeVisible();

    // D-077 #10: the override is the inspector's, so the file has to be marked first — which
    // is the honest shape of the decision. "Move THIS file" needs a this.
    await openSources(page);
    await sources(page).locator(".filerow--pick", { hasText: "C0001.MP4" }).click();
    await page.locator(".inspector").getByLabel(`${en.moveToDevice}: C0001.MP4`).selectOption("rec");

    // The strip agrees at once: still two files, but one device now.
    await expect(sources(page).locator(".strip__summary")).toContainText(en.deviceCount(1));

    await openSources(page);
    // The recorder group has both files; the camera group disappears (a device emptied by the
    // overlay is not rendered — the same rule the engine applies).
    await expect(
      sources(page).locator(".device-group").filter({ hasText: "Zoom recorder" }).locator(".device-group__meta"),
    ).toContainText(en.fileCount(2));
    await expect(
      sources(page).locator(".device-group__name").filter({ hasText: "Camera A" }),
    ).toHaveCount(0);
    // No result exists yet, so there is nothing to mark stale — no such notice appears.
    await expect(page.getByText(en.staleResult)).toBeHidden();
  });
});

// ── The popovers' own mechanics (V06-R2a, D-078) ───────────────────────────────────────
//
// Four disclosures share one hook, and the two behaviours it adds are the two `<details>` has
// no opinion about. Everything else — tab stop, Enter/Space, the announced open state — is the
// element's own, which is the entire reason these are `<details>` and not a hand-rolled menu.
test.describe("popover dismissal", () => {
  async function reachSources(page: Page) {
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, "plugin:dialog|open": ["/Users/e2e/shoot"], scan_inputs: scanManifest() },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(sources(page)).toBeVisible();
  }

  test("Escape closes it and puts the focus back on the control that opened it", async ({
    page,
  }) => {
    await reachSources(page);
    await openSources(page);

    await page.keyboard.press("Escape");

    await expect(sources(page).locator(".popover--sources .popover__panel")).toBeHidden();
    // The next Tab continues from the summary, not from the top of the document.
    await expect(sources(page).locator(".popover--sources > summary")).toBeFocused();
  });

  test("a press outside closes it; a press inside does not", async ({ page }) => {
    await reachSources(page);
    await openSources(page);

    // Inside: the panel's own padding, which is not a control.
    await sources(page).locator(".popover--sources .popover__panel").click({ position: { x: 4, y: 4 } });
    await expect(sources(page).locator(".popover--sources .popover__panel")).toBeVisible();

    await page.locator(".timeline").click({ position: { x: 5, y: 5 } });
    await expect(sources(page).locator(".popover--sources .popover__panel")).toBeHidden();
  });

  test("opening one closes the other — two panels never cover each other", async ({ page }) => {
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: scanManifest({
          unsynced: [{ file: "/Users/e2e/shoot/broken.mp4", reason: "decode_error" }],
        }),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await openSources(page);

    await sources(page).locator(".popover--problems > summary").click();

    await expect(sources(page).locator(".popover--problems .popover__panel")).toBeVisible();
    await expect(sources(page).locator(".popover--sources .popover__panel")).toBeHidden();
  });

  test("the keyboard opens it, walks it and closes it — the disclosure is the browser's", async ({
    page,
  }) => {
    // D-078's whole argument for `<details>`: four popovers, none of which re-implements
    // keyboard behaviour. The summary is a tab stop, Enter opens it, the contents are in the
    // tab order behind it, and `usePopoverDismiss` adds only the two things the element has no
    // opinion about.
    await reachSources(page);

    await sources(page).locator(".popover--sources > summary").focus();
    await page.keyboard.press("Enter");
    await expect(sources(page).locator(".popover--sources .popover__panel")).toBeVisible();

    // The first control inside the panel is the next tab stop — the root's own ✕.
    await page.keyboard.press("Tab");
    await expect(page.locator(".roots .root button")).toBeFocused();
    // …and the file rows are behind it, so the whole list is reachable without a pointer.
    await page.keyboard.press("Tab");
    await expect(sources(page).locator(".filerow--pick").first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".preview__name")).toHaveText("ZOOM0001.WAV");
    await expect(sources(page).locator(".popover--sources .popover__panel")).toBeHidden();
  });

  test("a `<select>` inside a panel does not count as a press outside it", async ({ page }) => {
    // The `composedPath()` half of D-078. A native `<select>` draws its options in the
    // browser's own popup layer rather than as descendants of the element, so a dismissal
    // written with `contains(event.target)` closes the panel under the operator's hand
    // mid-choice — in the one interaction the shelf's popover exists to support.
    const base = syncOutcome();
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: scanManifest(),
        run_sync: {
          ...base,
          result: {
            ...(base.result as Record<string, unknown>),
            placements: [],
            unsynced: [{ file: "/Users/e2e/shoot/CamA/C0001.MP4", reason: "device_overlap" }],
          },
        },
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await page.getByRole("button", { name: en.syncButton }).click();
    await expect(page.getByRole("button", { name: en.exportButton })).toBeVisible();

    const problems = sources(page).locator(".popover--problems");
    await problems.locator("> summary").click();
    const select = problems.getByLabel(`${en.moveToDevice}: C0001.MP4`);
    await expect(select).toBeVisible();

    // Pressing the control itself, and then choosing from it, both leave the panel open.
    await select.click();
    await expect(problems.locator(".popover__panel")).toBeVisible();
    await select.selectOption("rec");
    await expect(problems.locator(".popover__panel")).toBeVisible();
    await expect(page.getByText(en.staleResult)).toBeVisible();
  });

  test("a popover overlays the room — opening one moves no box in it", async ({ page }) => {
    // D-078's whole reason for being a layer rather than a block. The room is fixed (D-074),
    // so a list that took space when it opened would move the material the operator is reading
    // — which is the thing the bridge panel did for the whole of R1 and what R2a is for.
    await reachSources(page);
    const box = async (selector: string) =>
      (await page.locator(selector).first().boundingBox())!;
    const before = {
      strip: await box(".app__header"),
      slot: await box(".slot"),
      inspector: await box(".inspector"),
      stage: await box(".stage"),
      frame: await box(".timeline__frame"),
      gutter: await box(".track__gutter"),
    };

    await openSources(page);

    for (const [selector, expected] of [
      [".app__header", before.strip],
      [".slot", before.slot],
      [".inspector", before.inspector],
      [".stage", before.stage],
      [".timeline__frame", before.frame],
      [".track__gutter", before.gutter],
    ] as const) {
      const actual = await box(selector);
      expect(actual.x).toBeCloseTo(expected.x, 0);
      expect(actual.y).toBeCloseTo(expected.y, 0);
      expect(actual.width).toBeCloseTo(expected.width, 0);
      expect(actual.height).toBeCloseTo(expected.height, 0);
    }
  });
});

// `scan_inputs`'s own `EventSink` (channel `scan:progress`, lib.rs) reports real stage +
// completed/total ticks during the probe, exactly like `run_sync`'s `sync:progress` does
// — but nothing in the renderer listened for it: the scanning phase showed a static
// spinner no matter how far into a large card dump the backend actually was.
test.describe("scan progress", () => {
  async function reachScanning(page: import("@playwright/test").Page) {
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: controlled("scan_inputs"),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await waitForPending(page, "scan_inputs");
  }

  test("progress events drive the stage label and the completed/total fraction", async ({
    page,
  }) => {
    await reachScanning(page);

    // Before any event: indeterminate, the scanning-specific idle label — not the
    // generic "Syncing" one `ProgressBar` falls back to for `run_sync`.
    await expect(page.locator(".progress__label")).toHaveText(en.scanningInputs);
    await expect(page.locator(".progress__fill--indeterminate")).toBeVisible();

    await emit(page, "scan:progress", { stage: "Probing", completed: 3, total: 8 });

    await expect(page.locator(".progress__label")).toContainText(stageLabel(en, "Probing"));
    await expect(page.locator(".progress__label")).toContainText("3/8");
    const bar = page.getByRole("progressbar");
    await expect(bar).toHaveAttribute("aria-valuenow", "3");
    await expect(bar).toHaveAttribute("aria-valuemax", "8");
  });

  test("resolving the pending scan lands on the sources view", async ({ page }) => {
    await reachScanning(page);
    await emit(page, "scan:progress", { stage: "Probing", completed: 8, total: 8 });
    await resolveControlled(page, "scan_inputs", scanManifest());

    await expect(sources(page)).toBeVisible();
  });
});
