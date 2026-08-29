import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  emit,
  pcmWindow,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForResult,
} from "./harness";
import { en } from "../src/i18n";

/**
 * The seams V06 opened, and the four that turned out to be real (fresh-eyes review of
 * #47–#59).
 *
 * All four are the same shape the house calls a SEAM BUG: two layers each correct on its
 * own, disagreeing at the boundary between them, with a green suite on both sides.
 *
 *   1. **The portals vs. the timeline's key handler** (D-075/D-083). `Transport` and the
 *      warnings chip are rendered by `TimelineView` and *portalled* into the bottom slot and
 *      the top strip — which moves the pixels but NOT the React tree. A React event fired
 *      inside a portal propagates to the portal's ancestors *in the React tree*, so every
 *      keystroke on a control the operator sees on the strip or in the slot still reached
 *      `TimelineView`'s section-level `onKeyDown` — which claims Space, the arrows, Home,
 *      End, `+`, `-`, `0` and `f`, and `preventDefault()`s all of them. Pressing Space on ⏹
 *      therefore STARTED playback instead of stopping it, and pressing Space on the warnings
 *      chip started playback instead of opening the chip.
 *
 *   2. **The selection's pruning rule vs. «Kilder»** (D-070/D-075/D-077 #8). The rule is "the
 *      marked file must still be drawn on the timeline"; the list is "every file in the drop,
 *      by name, so you can find the one somebody mentioned". After a sync those two stop
 *      agreeing about exactly the files the operator most wants to look at: a file the engine
 *      REFUSED to place is in the list and is not on the timeline, so clicking its row marked
 *      it and un-marked it in the same commit.
 *
 *   3. **The project name's two readers.** The filename fell back when the field was empty;
 *      the name written INTO the FCPXML did not (the backend's `unwrap_or("SundaySync")` only
 *      catches an absent argument, never an empty or blank one).
 *
 *   4. **`waveformStore` vs. `state.prewarm`** (D-080). Two layers hold an opinion about "has
 *      this file been analysed?" — the store, which has the bytes, and the reducer's map,
 *      which the blue clip and the gutter's dot are drawn from. A hand-rebuild through the
 *      clip's own control told the store and not the reducer, so the clip drew its waveform
 *      while staying grey, over a dot that went on saying «the audio is not analysed».
 */

const SHOOT = "/Users/e2e/shoot";
const WAV = "/Users/e2e/shoot/ZOOM0001.WAV";
const CAM = "/Users/e2e/shoot/CamA/C0001.MP4";

function sources(page: Page) {
  return page.getByRole("region", { name: en.sourcesTitle });
}

function audio(page: Page) {
  return page.evaluate(
    () => (window as unknown as Record<string, any>).__SUNDAYSYNC_AUDIO__ ?? null,
  );
}

/** The stock outcome, with the reference WAV placed too — `place.rs` places it at 0, and a
 *  transport needs something on every device to be worth pressing. */
function outcomeBoth(over: Record<string, unknown> = {}) {
  const base = syncOutcome() as Record<string, any>;
  base.result.placements = [
    {
      file: WAV,
      device: "rec",
      offset_seconds: 0,
      confidence: 1,
      psr: 99,
      drift_ppm: null,
      projected_end_error_ms: null,
      chain: [],
      warnings: [],
    },
    ...base.result.placements,
  ];
  Object.assign(base.result, over);
  return base;
}

async function reachResult(page: Page, outcome: unknown, extra: Record<string, unknown> = {}) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      ...pcmWindow(),
      "plugin:dialog|open": [SHOOT],
      scan_inputs: scanManifest(),
      run_sync: outcome,
      ...extra,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await page.getByRole("button", { name: en.syncButton }).click();
  await waitForResult(page);
}

test.describe("the portalled controls are the slot's and the strip's, not the timeline's", () => {
  test("Space on ⏹ stops — it does not start playback", async ({ page }) => {
    // The measured failure: `engine.stop()` never ran at all. `onKeyDown` matched `" "`,
    // called `engine.toggle()` and then `preventDefault()`, which is what suppresses a
    // `<button>`'s own Space activation — so the one key a stop button must answer to did
    // the opposite of stopping.
    await reachResult(page, outcomeBoth());

    const stop = page.getByRole("button", { name: en.stopPlayback });
    await stop.focus();
    await page.keyboard.press(" ");

    await expect.poll(async () => (await audio(page))?.playing ?? false).toBe(false);
  });

  test("Space on the warnings chip opens it, and plays nothing", async ({ page }) => {
    await reachResult(page, outcomeBoth({ warnings: [{ code: "mixed_fps" }] }));

    const chip = page.locator(".strip__status .popover--warnings");
    await expect(chip.locator("> summary")).toHaveText(en.warningsCount(1));

    await chip.locator("> summary").focus();
    await page.keyboard.press(" ");

    // The `<details>` is a disclosure and Space is how a keyboard opens one — the same key
    // that already opens the problem chip and «Kilder» six pixels to its left.
    await expect(chip.locator(".popover__panel")).toBeVisible();
    await expect(chip.locator(".popover__panel")).toContainText(en.mixedFps);
    await expect.poll(async () => (await audio(page))?.playing ?? false).toBe(false);
  });

  test("the arrow keys on a transport control do not drag the playhead", async ({ page }) => {
    // Same seam, quieter symptom: `ArrowRight` on a portalled control moved the playhead a
    // second and swallowed the key, so a keyboard user tabbing along the slot scrubbed the
    // timeline by accident.
    await reachResult(page, outcomeBoth());

    const clock = page.getByTestId("transport-time");
    const before = await clock.textContent();
    await page.getByRole("button", { name: en.stopPlayback }).focus();
    await page.keyboard.press("ArrowRight");

    await expect(clock).toHaveText(before ?? "");
  });

  test("…and the timeline's own keys are untouched", async ({ page }) => {
    // The guard is about WHERE the key came from, so everything inside the frame keeps
    // working: this is the assertion that the fix did not simply disable the shortcuts.
    await reachResult(page, outcomeBoth());

    await page.locator(".timeline").press(" ");
    await expect.poll(async () => (await audio(page))?.playing ?? false).toBe(true);
    await page.locator(".timeline").press(" ");
    await expect.poll(async () => (await audio(page))?.playing ?? false).toBe(false);
  });
});

test.describe("«Kilder» can open every file it lists", () => {
  test("a file the engine refused to place still opens in the inspector", async ({ page }) => {
    // The list is the app's only alphabetical index of the drop (D-077 #8), and «why did THIS
    // one not sync?» is the question it is most often opened for. The row marked the file and
    // the timeline's pruning effect un-marked it in the same commit, so the click did nothing
    // at all — no panel, no message.
    await reachResult(
      page,
      outcomeBoth({
        placements: [
          {
            file: WAV,
            device: "rec",
            offset_seconds: 0,
            confidence: 1,
            psr: 99,
            drift_ppm: null,
            projected_end_error_ms: null,
            chain: [],
            warnings: [],
          },
        ],
        unsynced: [{ file: CAM, reason: "low_confidence" }],
      }),
    );

    // It is genuinely not on the timeline — that half is right and stays right.
    await expect(page.locator(`.clip[data-file="${CAM}"]`)).toHaveCount(0);
    await expect(page.locator(".popover--problems > summary")).toHaveText(en.problemCount(1));

    await sources(page).locator(".popover--sources > summary").click();
    await sources(page).locator(".filerow--pick", { hasText: "C0001.MP4" }).click();

    // What the inspector has to say about it is exactly what it says about any file before a
    // sync: the picture, the file facts, and the three decisions — including the ✕ and the
    // «move to device» that is D-027's own advice for a clip that would not place.
    await expect(page.locator(".preview__name")).toHaveText("C0001.MP4");
    await expect(page.locator(".inspector").getByLabel(`${en.removeFile}: C0001.MP4`)).toBeVisible();
    // …and no engine detail, because there is none.
    await expect(page.locator(".preview__sync")).toBeEmpty();
  });

  test("a file the operator removed still empties the panel", async ({ page }) => {
    // The other half of the same rule, unchanged: a REMOVED file is out of the run and out of
    // the room, and the panel must not go on describing it.
    await reachResult(page, outcomeBoth());

    await page.locator(`.clip[data-file="${CAM}"]`).click();
    await expect(page.locator(".preview__name")).toHaveText("C0001.MP4");

    await page.locator(".inspector").getByLabel(`${en.removeFile}: C0001.MP4`).click();

    await expect(page.locator(`.clip[data-file="${CAM}"]`)).toHaveCount(0);
    // D-092 ⑥ — the empty state is a structure now; the sentence is its own element.
    await expect(page.locator(".preview__emptyline")).toHaveText(en.previewEmpty);
  });
});

test.describe("the project name is one name", () => {
  test("a blank field exports as SundaySync rather than as nothing", async ({ page }) => {
    await reachResult(page, outcomeBoth());
    await page.evaluate(() => {
      const w = window as unknown as Record<string, any>;
      w.__CALLS__ = { save: [], export: [] };
      const map = w.__SUNDAYSYNC_FIXTURES__;
      map["plugin:dialog|save"] = (args: unknown) => {
        w.__CALLS__.save.push(args);
        return "/Users/e2e/out/timeline.fcpxml";
      };
      map["export_timeline"] = (args: unknown) => {
        w.__CALLS__.export.push(args);
        return 2;
      };
    });

    // Whitespace is not a name, and the field can hold it: the FCPXML was written with
    // `<project name="   ">` and the save dialog offered «   .fcpxml».
    await page.getByLabel(en.projectName).fill("   ");
    await page.getByRole("button", { name: en.exportButton }).click();
    // D-092 ⑤: an export's answer is the strip's receipt, not a toast.
    await expect(page.locator(".strip__receipt")).toBeVisible();

    const calls = await page.evaluate(() => (window as unknown as Record<string, any>).__CALLS__);
    expect(calls.export[0].project).toBe("SundaySync");
    expect(calls.save[0].options.defaultPath).toBe("SundaySync.fcpxml");
  });

  test("a name the operator typed travels verbatim", async ({ page }) => {
    // The fallback may not become a trim of what somebody meant to type.
    await reachResult(page, outcomeBoth());
    await page.evaluate(() => {
      const w = window as unknown as Record<string, any>;
      w.__CALLS__ = { export: [] };
      const map = w.__SUNDAYSYNC_FIXTURES__;
      map["plugin:dialog|save"] = () => "/Users/e2e/out/timeline.fcpxml";
      map["export_timeline"] = (args: unknown) => {
        w.__CALLS__.export.push(args);
        return 2;
      };
    });

    await page.getByLabel(en.projectName).fill("Gudstjeneste 23. august");
    await page.getByRole("button", { name: en.exportButton }).click();
    await expect(page.locator(".strip__receipt")).toBeVisible();

    const calls = await page.evaluate(() => (window as unknown as Record<string, any>).__CALLS__);
    expect(calls.export[0].project).toBe("Gudstjeneste 23. august");
  });
});

test.describe("a rebuilt analysis is an analysed file", () => {
  test("regenerating one clip by hand turns it blue and moves its device's dot", async ({
    page,
  }) => {
    // D-080's blue is «the bytes this clip's waveform is drawn from exist» — and after a
    // successful `regenerate_analysis` they do. Measured before the fix: the canvas drew,
    // and the clip stayed `clip clip--pre clip--seq` over a `track__dot--failed` that still
    // read «Lyden er ikke analysert». The app contradicting itself in one glance, on the one
    // control the operator reaches for when a card would not read.
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, "plugin:dialog|open": [SHOOT], scan_inputs: scanManifest() },
      settings: SETTLED_SETTINGS,
    });
    await page.evaluate(() => {
      const w = window as unknown as Record<string, any>;
      w.__READY__ = new Set<string>();
      const map = w.__SUNDAYSYNC_FIXTURES__;
      map["waveform_meta"] = (args: { file: string }) =>
        w.__READY__.has(args.file)
          ? {
              schema: 1,
              duration_seconds: 100,
              sample_rate: 12000,
              levels: [{ level: 0, bins: 200, bin_ms: 500 }],
            }
          : Promise.reject("cache_missing: no analysis for this file");
      map["waveform_level"] = () => new Uint8Array(400).buffer;
      map["regenerate_analysis"] = (args: { file: string }) => {
        w.__READY__.add(args.file);
        return undefined;
      };
    });

    await page.getByRole("button", { name: en.dropFolder }).click();
    // The pass could not read the camera file, and did read the recorder's.
    await emit(page, "prewarm:file", { file: CAM, ok: false });
    await emit(page, "prewarm:file", { file: WAV, ok: true });

    const clip = page.locator(`.clip[data-file="${CAM}"]`);
    const camDot = page
      .getByRole("group", { name: en.trackAria("Camera A") })
      .locator(".track__dot");
    await expect(clip).not.toHaveClass(/clip--analysed/);
    await expect(camDot).toHaveAttribute("aria-label", en.trackAnalysisFailed);

    await clip.locator(".waveform__regenerate").click({ force: true });

    // The bytes are there — the canvas proves it — so the colour has to say so too.
    await expect(clip.locator("canvas")).toBeVisible();
    await expect(clip).toHaveClass(/clip--analysed/);
    await expect(camDot).toHaveAttribute("aria-label", en.trackAnalysed);
    // …and the recorder, which was never touched, is exactly where it was.
    await expect(
      page.getByRole("group", { name: en.trackAria("Zoom recorder") }).locator(".track__dot"),
    ).toHaveAttribute("aria-label", en.trackAnalysed);
  });
});
