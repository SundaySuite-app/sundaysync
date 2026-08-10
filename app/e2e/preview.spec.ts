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
  videoFrameNoPicture,
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
    await expect(preview(page)).toHaveText(en.previewEmpty);
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

  test("the panel's box does not move when a clip is selected", async ({ page }) => {
    // The reason the panel is always visible and a fixed height (D-070). If it appeared —
    // or grew — on selection it would push the timeline in the very instant the operator
    // clicked a three-pixel clip, and their next click would land on a different one. That
    // is a broken interaction, not an annoyance, so it is asserted in pixels.
    await reachSources(page);

    const empty = (await preview(page).boundingBox())!;
    const timelineBefore = (await page.locator(".timeline__frame").boundingBox())!;

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(preview(page).locator(".preview__name")).toHaveText("C0001.MP4");

    const filled = (await preview(page).boundingBox())!;
    expect(filled.height).toBeCloseTo(empty.height, 0);
    expect(filled.y).toBeCloseTo(empty.y, 0);

    // …and the thing above it did not move either, which is the property that actually
    // matters to the next click.
    const timelineAfter = (await page.locator(".timeline__frame").boundingBox())!;
    expect(timelineAfter.y).toBeCloseTo(timelineBefore.y, 0);
    expect(timelineAfter.height).toBeCloseTo(timelineBefore.height, 0);
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

    await page
      .getByRole("region", { name: en.sourcesTitle })
      .getByLabel(`${en.removeFile}: C0002.MP4`)
      .click();

    await expect(page.locator(`.clip[data-file="${CAM_B}"]`)).toHaveCount(0);
    await expect(preview(page)).toHaveText(en.previewEmpty);
  });
});
