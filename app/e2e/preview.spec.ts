import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  cancelThumbnailSpy,
  controlled,
  fn,
  presyncScanManifest,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  videoFrameCancellable,
  videoFrameNoPicture,
  frameCalls,
  resolveFrame,
  rejectControlled,
  resolveControlled,
  waitForPending,
  waitForResult,
  type Fixtures,
} from "./harness";
import { en } from "../src/i18n";

// The preview panel (V05-W4b, D-070) — one panel under the timeline showing the marked
// clip's frame, the file it is, and (after a sync) what the engine worked out about it.
// It replaces the clip-detail dialog.
//
// What is worth a browser here is exactly what a unit test cannot see: that the panel is on
// screen in every phase, that its box does not move when the selection changes, and that
// the three picture states (loading / a frame / no picture) reach the screen as three
// different calm things rather than as one broken image.

const WAV = "/Users/e2e/shoot/ZOOM0001.WAV";
const CAM_A = "/Users/e2e/shoot/CamA/C0001.MP4";
const CAM_B = "/Users/e2e/shoot/CamB/C0002.MP4";

/** Drop a folder and stop at the sources phase — no `run_sync` fixture, so a sync that
 *  somehow started would fail loudly rather than quietly. */
async function reachSources(page: Page, extra: Fixtures = {}) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: presyncScanManifest(),
      ...extra,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(page.locator(".clip")).toHaveCount(3);
}

async function reachResult(page: Page, extra: Fixtures = {}) {
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
  await waitForResult(page);
}

function preview(page: Page) {
  return page.locator(".preview");
}

test.describe("the preview panel", () => {
  test("is on screen before anything is selected, and says what to do", async ({ page }) => {
    await reachSources(page);
    await expect(preview(page)).toBeVisible();
    // V06-G3 (D-092 ⑥): the empty state is the filled state with the facts taken out — the
    // column's own label, the same 268×151 frame the still uses (dashed), the sentence, and
    // one line about what will be there. Asserted as its parts rather than as the panel's
    // whole text, which is now four elements rather than one.
    await expect(preview(page).locator(".preview__label")).toHaveText(en.previewSection);
    await expect(preview(page).locator(".preview__emptyline")).toHaveText(en.previewEmpty);
    await expect(preview(page).locator(".preview__emptyhint")).toHaveText(en.previewEmptyHint);
    await expect(preview(page).locator(".preview__frame--empty")).toBeVisible();
  });

  test("the empty frame is the same box the still lands in", async ({ page }) => {
    // The whole point of giving the empty state a frame (D-092 ⑥): marking a clip must change
    // what is IN the boxes, never where they are. A column that re-laid itself out on
    // selection is D-074's promise broken in the one place it was never measured.
    await reachSources(page);
    const empty = (await preview(page).locator(".preview__frame").boundingBox())!;
    const labelBefore = (await preview(page).locator(".preview__label").boundingBox())!;

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");

    const filled = (await preview(page).locator(".preview__frame").boundingBox())!;
    expect(filled.x).toBeCloseTo(empty.x, 0);
    expect(filled.y).toBeCloseTo(empty.y, 0);
    expect(filled.width).toBeCloseTo(empty.width, 0);
    expect(filled.height).toBeCloseTo(empty.height, 0);
    const labelAfter = (await preview(page).locator(".preview__label").boundingBox())!;
    expect(labelAfter.y).toBeCloseTo(labelBefore.y, 0);
  });

  test("selecting a clip BEFORE a sync shows its picture and its file facts, and no sync detail", async ({
    page,
  }) => {
    await reachSources(page);
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();

    // The file half comes from the scan manifest, which is already in hand — no sync
    // required, and no second IPC to fetch it.
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");
    await expect(preview(page).getByText(en.previewVideoStream("h264", 1920, 1080, "25/1"))).toBeVisible();
    await expect(
      preview(page).getByText(en.previewAudioStream("aac", 48000, 2)),
    ).toBeVisible();
    // The picture arrived: a real frame, not the "no picture" copy.
    await expect(preview(page).locator(".preview__canvas")).toBeVisible();
    await expect(preview(page).locator(".preview__frame")).toHaveAttribute("data-frame", "image");

    // …and NOT one word of sync detail, because the engine has not said anything yet.
    // Claiming a position, a confidence or a PSR here would be inventing an answer.
    await expect(preview(page).getByText(en.directMatch)).toHaveCount(0);
    await expect(preview(page).getByText(en.offsetLabel, { exact: true })).toHaveCount(0);
    await expect(preview(page).getByText(en.confidence, { exact: true })).toHaveCount(0);
  });

  test("the file's reconstructed start is shown with the rung it came from (D-067)", async ({
    page,
  }) => {
    await reachSources(page);

    // Camera A carries a real container `creation_time` — the top rung, a measurement, and
    // therefore NOT dressed up as an estimate.
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(preview(page).getByText(en.presyncSourceModified)).toHaveCount(0);
    await expect(preview(page).getByText(en.presyncSourceNone)).toHaveCount(0);

    // The WAV carries nothing at all — and the panel reuses W3's own sentence for that
    // rather than inventing a second way to say it.
    await page.locator(`.clip[data-file="${WAV}"]`).click();
    await expect(preview(page).getByText(en.presyncSourceNone)).toBeVisible();
  });

  test("selecting a clip AFTER a sync shows both halves", async ({ page }) => {
    await reachResult(page);
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();

    // File facts…
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");
    await expect(preview(page).getByText(en.previewVideoStream("h264", 1920, 1080, "25/1"))).toBeVisible();
    // …and the engine's answer, in ClipDetail's own words.
    await expect(preview(page).getByText("4.200 s")).toBeVisible();
    await expect(preview(page).getByText(en.directMatch)).toBeVisible();
    await expect(
      preview(page).getByText(en.psrVsThreshold("38.4", "15")),
    ).toBeVisible();
  });

  test("a file with no picture in it says so, calmly — it is not an error", async ({ page }) => {
    // D-069, measured: `.WAV` and `.HEIC` exit 234 with zero bytes, and 32 of the owner's
    // 386 files are in that class. A red banner on one file in twelve would be the app
    // lying about its own state.
    await reachSources(page, videoFrameNoPicture());
    await page.locator(`.clip[data-file="${WAV}"]`).click();

    await expect(preview(page).locator(".preview__frame")).toHaveAttribute("data-frame", "none");
    await expect(preview(page).getByText(en.previewNoImage)).toBeVisible();
    await expect(preview(page).locator("canvas")).toHaveCount(0);
    // The rest of the panel is unaffected: the file facts are still the point.
    await expect(preview(page).locator(".preview__name")).toHaveText("ZOOM0001.WAV");
    // Nothing anywhere on screen calls this a failure.
    await expect(page.locator(".banner--error")).toHaveCount(0);
  });

  test("while the frame is being fetched the panel says so", async ({ page }) => {
    // Not a theoretical state: measured at 4.4 s for an 816 MB DJI file over SMB (D-069).
    await reachSources(page, { video_frame: controlled("video_frame"), ...cancelThumbnailSpy() });
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();

    await waitForPending(page, "video_frame");
    await expect(preview(page).locator(".preview__frame")).toHaveAttribute("data-frame", "loading");
    await expect(preview(page).getByText(en.previewLoading)).toBeVisible();
    // The facts do not wait for the picture — they were in the manifest all along.
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");

    // An empty answer settles it into the calm "no picture" state, never into an error.
    // Resolved from inside the page: an `ArrayBuffer` does not survive the Node→page
    // argument boundary, and `resolveControlled` would hand the app a `{}`.
    await page.evaluate(() =>
      (window as unknown as Record<string, any>).__SUNDAYSYNC_PENDING__.video_frame.resolve(
        new ArrayBuffer(0),
      ),
    );
    await expect(preview(page).getByText(en.previewNoImage)).toBeVisible();
  });

  test("changing the selection mid-fetch cancels the grab nobody wants any more", async ({
    page,
  }) => {
    // `invoke` has no cancellation of its own (app/src/invoke.ts), so a superseded grab
    // holds one of the shell's two preview permits and a running ffmpeg until it finishes on
    // its own — seconds of it, over a share, in front of the frame the operator is actually
    // waiting for. `cancel_thumbnail` is the only thing that ends it.
    await reachSources(page, { video_frame: controlled("video_frame"), ...cancelThumbnailSpy() });

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await waitForPending(page, "video_frame");
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__E2E_CANCEL_THUMBNAIL__),
    ).toBeUndefined();

    await page.locator(`.clip[data-file="${CAM_B}"]`).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as Record<string, unknown>).__E2E_CANCEL_THUMBNAIL__),
      )
      .toBeGreaterThanOrEqual(1);
  });

  test("a clip whose frame is already known costs no second ffmpeg spawn", async ({ page }) => {
    // The memo is the whole reason `frameStore` exists: a card of 386 clips clicked through
    // twice must not decode 772 frames.
    await reachSources(page, {
      // A counting fixture. Answering with zero bytes keeps this about the CALL COUNT
      // rather than about decoding.
      video_frame: fn(`(args) => {
        window.__E2E_FRAMES__ = (window.__E2E_FRAMES__ || []).concat(args.file);
        return new ArrayBuffer(0);
      }`),
      ...cancelThumbnailSpy(),
    });

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");
    await page.locator(`.clip[data-file="${CAM_B}"]`).click();
    await expect(preview(page).locator(".preview__name")).toHaveText("C0002.MP4");
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");

    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__E2E_FRAMES__),
    ).toEqual([CAM_A, CAM_B]);
  });

  test("marking a clip does not move the timeline", async ({ page }) => {
    // D-070's rule, asserted in pixels: if the panel appeared — or grew — on selection it
    // would push the timeline in the very instant the operator clicked a three-pixel clip,
    // and their next click would land on a different one. A broken interaction, not an
    // annoyance.
    //
    // V06-R1 (D-076) keeps the rule and changes what enforces it. The panel used to be a
    // 180 px band UNDER the timeline, so the rule had to be spelled as "the panel is always
    // exactly 180 px tall" — a fixed height was the only way a box in the vertical stack
    // could promise not to shove what was above it. The panel is now the content of the
    // 300 px inspector COLUMN, which is a sibling of the stage rather than a block below it:
    // it can say as much or as little as it likes and the timeline cannot hear about it. So
    // the panel's own height is free (and does grow — an empty column is one sentence, a
    // filled one is a still frame plus two tables), and what is asserted is the thing the
    // rule was always about.
    await reachSources(page);

    const columnBefore = (await page.locator(".inspector").boundingBox())!;
    const timelineBefore = (await page.locator(".timeline__frame").boundingBox())!;
    const gutterBefore = (await page.locator(".track__gutter").first().boundingBox())!;

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");

    // The thing the next click depends on: the timeline's own box, to the pixel.
    const timelineAfter = (await page.locator(".timeline__frame").boundingBox())!;
    expect(timelineAfter.y).toBeCloseTo(timelineBefore.y, 0);
    expect(timelineAfter.x).toBeCloseTo(timelineBefore.x, 0);
    expect(timelineAfter.height).toBeCloseTo(timelineBefore.height, 0);
    expect(timelineAfter.width).toBeCloseTo(timelineBefore.width, 0);

    // …and neither the column that filled up nor the lane origin every clip is drawn from.
    const columnAfter = (await page.locator(".inspector").boundingBox())!;
    expect(columnAfter.x).toBeCloseTo(columnBefore.x, 0);
    expect(columnAfter.width).toBeCloseTo(columnBefore.width, 0);
    const gutterAfter = (await page.locator(".track__gutter").first().boundingBox())!;
    expect(gutterAfter.x).toBeCloseTo(gutterBefore.x, 0);
    expect(gutterAfter.width).toBeCloseTo(gutterBefore.width, 0);
  });

  test("a selection that stops existing clears itself rather than describing a ghost", async ({
    page,
  }) => {
    // Generalised from the old "close the dialog when the result goes away" rule (D-070): a
    // file path can go stale four ways, and all four are "is the marked file still drawn?".
    // Here it is D-062's per-file removal.
    await reachSources(page);
    await page.locator(`.clip[data-file="${CAM_B}"]`).click();
    await expect(preview(page).locator(".preview__name")).toHaveText("C0002.MP4");

    // V06-R2a (D-077 #11): the ✕ is the inspector's own now — which makes this scenario more
    // direct rather than less, because the control that removes the file is in the very panel
    // whose emptying is the claim.
    await page.locator(".inspector").getByLabel(`${en.removeFile}: C0002.MP4`).click();

    await expect(page.locator(`.clip[data-file="${CAM_B}"]`)).toHaveCount(0);
    await expect(preview(page).locator(".preview__emptyline")).toHaveText(en.previewEmpty);
    await expect(preview(page).locator(".preview__name")).toHaveCount(0);
  });
  // ── V05-W5 sweep: the shapes adjacent to the StrictMode bug W4b fixed ────────────────
  //
  // `cancelFramesExcept` was written for one of them (the double mount). These are its
  // neighbours, run against a `video_frame` fixture that supersedes the way the shell
  // actually does — a new grab cancels the previous token, and a cancelled run comes back
  // as `cancelled`.

  test("clicking away and straight back shows the picture, not «no image»", async ({ page }) => {
    // The bug this found. The shell had already killed A's grab when B started; the STORE
    // still handed A's dead promise to the next caller, whose `null` the panel rendered as
    // «ingen bilde» — permanently, because the effect is keyed on the file and never runs
    // again. Over SMB that window is seconds wide (D-069: 4.4 s for a 4K frame).
    await reachSources(page, videoFrameCancellable());

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(preview(page).getByText(en.previewLoading)).toBeVisible();

    await page.locator(`.clip[data-file="${CAM_B}"]`).click();
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");

    // The grab that is outstanding now is A's own second one — settle it and the picture
    // arrives.
    await resolveFrame(page);
    await expect(preview(page).locator(".preview__canvas")).toBeVisible();
    await expect(preview(page).getByText(en.previewNoImage)).toHaveCount(0);
    // Three grabs for two files: A (killed), B (killed), A again. Not one, and not a loop.
    expect(await frameCalls(page)).toEqual([CAM_A, CAM_B, CAM_A]);
  });

  test("selecting the same clip twice does not restart its grab", async ({ page }) => {
    await reachSources(page, videoFrameCancellable());
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await resolveFrame(page);
    await expect(preview(page).locator(".preview__canvas")).toBeVisible();
    expect(await frameCalls(page)).toEqual([CAM_A]);
  });

  test("a settled picture survives a trip through two other clips", async ({ page }) => {
    await reachSources(page, videoFrameCancellable());
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await resolveFrame(page);
    await expect(preview(page).locator(".preview__canvas")).toBeVisible();

    await page.locator(`.clip[data-file="${CAM_B}"]`).click();
    await page.locator(`.clip[data-file="${WAV}"]`).click();
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();

    // Straight back to the canvas with no «henter …» tick: the answer is memoised and is
    // read synchronously (`hasFrame`/`peekFrame`), so no second spawn and no flicker.
    await expect(preview(page).locator(".preview__canvas")).toBeVisible();
    await expect(preview(page).getByText(en.previewLoading)).toHaveCount(0);
    expect((await frameCalls(page)).filter((f) => f === CAM_A)).toEqual([CAM_A]);
  });

  test("the selection survives a sync and gains the engine's half", async ({ page }) => {
    // D-070's lifecycle, across the phase boundary that used to destroy the selection
    // entirely (the dialog was result-only). The marked file is the same file before and
    // after; what changes is that there is now something to say about it.
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: scanManifest(),
        run_sync: syncOutcome(),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");
    await expect(preview(page).getByText(en.offsetLabel)).toHaveCount(0);

    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);

    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");
    await expect(preview(page).getByText(en.offsetLabel)).toBeVisible();
  });

  test("a selection made DURING a sync can be read but not acted on", async ({ page }) => {
    // Looking is allowed in every phase (D-061); the reassign `<select>` is a decision, and
    // mid-run there is nothing it could change about the run in flight.
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: scanManifest(),
        run_sync: controlled("run_sync"),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");
    await expect(preview(page).locator("select")).toBeDisabled();

    await resolveControlled(page, "run_sync", syncOutcome());
    await waitForResult(page);
    await expect(preview(page).locator("select")).toBeEnabled();
  });

  test("a cancelled sync pulls the outcome and the panel stops claiming an offset", async ({
    page,
  }) => {
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: scanManifest(),
        run_sync: controlled("run_sync"),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await resolveControlled(page, "run_sync", syncOutcome());
    await waitForResult(page);

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(preview(page).getByText(en.offsetLabel)).toBeVisible();

    // A second run, cancelled: the stored outcome is gone, and so is every claim built on
    // it. The file is still on the timeline, so the selection itself survives.
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await rejectControlled(page, "run_sync", "cancelled");
    await expect(page.getByRole("button", { name: en.exportButton })).toHaveCount(0);
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");
    await expect(preview(page).getByText(en.offsetLabel)).toHaveCount(0);
  });
});
