import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  controlled,
  PRESYNC_B_OFFSET_SEC,
  presyncScanManifest,
  resolveControlled,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForPending,
  waitForResult,
} from "./harness";
import { en } from "../src/i18n";

// The timeline as the MAIN view (V04-U3, D-061).
//
// Three claims, none of which any unit test can make:
//   1. Dropped files are on the timeline immediately, positioned by their own container
//      timestamps, and marked as the guesses they are.
//   2. A file with no timestamp is placed at the start AND said so in words, rather than
//      silently reading as "these all began together".
//   3. The timeline stays MOUNTED across sources → syncing → result. That is the
//      structural precondition for the later stage where clips animate from their
//      metadata guess to the solved placement: a view that unmounted could only cut.

/** Drop the mixed-timestamp fixture and land on the sources phase. */
async function reachSources(page: Page, fixtures: Record<string, unknown> = {}) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: presyncScanManifest(),
      ...fixtures,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeVisible();
}

/** A clip box addressed by the file it stands for — the identity that survives the sync. */
function clip(page: Page, file: string) {
  return page.locator(`.clip[data-file="${file}"]`);
}

const WAV = "/Users/e2e/shoot/ZOOM0001.WAV";
const CAM_A = "/Users/e2e/shoot/CamA/C0001.MP4";
const CAM_B = "/Users/e2e/shoot/CamB/C0002.MP4";

test.describe("clips appear on the timeline before any sync", () => {
  test("every dropped file gets a pre-sync clip, positioned by its creation time", async ({
    page,
  }) => {
    await reachSources(page);

    // No sync has run — no `run_sync` fixture is even installed, so an app that tried
    // would fail loudly (harness.ts's "no Tauri backend" rejection) rather than quietly.
    await expect(page.getByRole("button", { name: en.syncButton })).toBeVisible();
    await expect(page.locator(".timeline__body")).toBeVisible();
    await expect(page.locator(".clip")).toHaveCount(3);

    // Pre-sync, and honest about it: not the placed green, and not clickable, because
    // there is no placement behind it to open.
    for (const file of [WAV, CAM_A, CAM_B]) {
      await expect(clip(page, file)).toHaveClass(/clip--pre/);
      await expect(clip(page, file)).toBeDisabled();
    }

    // Camera A is the earliest stamp, so it anchors t=0; the WAV has no stamp at all and
    // sits at the same place; Camera B rolled ten minutes later and is drawn to the right
    // of both. Pixels, not internals — this is what the operator actually sees.
    const [a, b, wav] = [
      (await clip(page, CAM_A).boundingBox())!,
      (await clip(page, CAM_B).boundingBox())!,
      (await clip(page, WAV).boundingBox())!,
    ];
    expect(b.x).toBeGreaterThan(a.x + 10);
    expect(wav.x).toBeCloseTo(a.x, 0);

    // …and by roughly the right amount: 600 s of a 2400 s span (the WAV's hour is the
    // longest thing on the timeline) is a quarter of the fitted width, give or take the
    // fit padding. Loose on purpose — the exact zoom is `fitPxPerMs`'s business.
    const laneWidth = (await page.locator("#timeline-viewport").boundingBox())!.width;
    const expectedX = a.x + (PRESYNC_B_OFFSET_SEC / 3600) * laneWidth;
    expect(Math.abs(b.x - expectedX)).toBeLessThan(laneWidth * 0.05);
  });

  test("a file with no recording time says so instead of pretending", async ({ page }) => {
    await reachSources(page);

    // One of the three files (the WAV) has no container timestamp.
    await expect(page.locator(".timeline__note")).toHaveText(en.presyncUnknownStart(1));
    await expect(clip(page, WAV)).toHaveAttribute(
      "aria-label",
      new RegExp(en.presyncStartUnknown),
    );
    // The timestamped ones read their own start instead.
    await expect(clip(page, CAM_B)).toHaveAttribute("aria-label", new RegExp(en.presyncStart));
  });

  // ── V04-U5 QA: honesty about the clocks themselves ───────────────────────────────────
  test("with nothing but untimed files it does not claim positions from timestamps", async ({
    page,
  }) => {
    // A folder of field-recorder WAVs is an ordinary drop, and not one file in it carries a
    // container timestamp. The meta line above the timeline used to read "Provisional
    // positions from the files' own timestamps" over a pile of clips at zero that had been
    // positioned by nothing at all.
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        // `scanManifest()`'s two files both carry `creation_time: null`.
        scan_inputs: scanManifest(),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(page.locator(".clip")).toHaveCount(2);

    await expect(page.locator(".result__meta span").first()).toHaveText(en.presyncMetaNoClock);
    await expect(page.locator(".timeline__note")).toHaveText(en.presyncUnknownStart(2));
  });

  test("one dead camera clock does not push the whole shoot off the screen", async ({
    page,
  }) => {
    // A flat battery leaves a camera reporting 1970-01-01, and it writes that as
    // confidently as any other date. Believing it set the drop's origin fifty-six years
    // early: `fitPxPerMs` clamped out, and the real footage sat off the right edge of a
    // twelve-hour window with nothing on screen saying why.
    const dud = "/Users/e2e/shoot/CamC/C0003.MP4";
    const base = presyncScanManifest();
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: {
          ...base,
          devices: [
            ...(base.devices as Record<string, unknown>[]),
            { id: "cam-c", label: "Camera C", kind: "video", files: [dud] },
          ],
          files: [
            ...(base.files as Record<string, unknown>[]),
            {
              file: dud,
              device: "cam-c",
              duration_seconds: 1800,
              format_name: "mov,mp4",
              audio: { codec: "aac", sample_rate: 48000, channels: 2 },
              video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
              creation_time: "1970-01-01T00:00:00.000Z",
            },
          ],
        },
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(page.locator(".clip")).toHaveCount(4);

    // The dud is treated as a file with no usable time: it joins the WAV at the start and
    // is counted in the note, rather than defining where zero is.
    await expect(page.locator(".timeline__note")).toHaveText(en.presyncUnknownStart(2));
    await expect(clip(page, dud)).toHaveAttribute(
      "aria-label",
      new RegExp(en.presyncStartUnknown),
    );

    // And the two cards that DO agree keep their real ten-minute separation, on screen,
    // at a readable width — the whole point of the gate.
    const lane = (await page.locator("#timeline-viewport").boundingBox())!;
    const a = (await clip(page, CAM_A).boundingBox())!;
    const b = (await clip(page, CAM_B).boundingBox())!;
    expect(a.x).toBeCloseTo(lane.x, 0);
    expect(b.x - a.x).toBeGreaterThan(lane.width * 0.1);
    expect(b.x + b.width).toBeLessThanOrEqual(lane.x + lane.width + 1);
  });

  test("moving a file to another device moves its clip too", async ({ page }) => {
    // The panel and the timeline are two views of ONE decision (D-027/D-028) — if the
    // override overlay only reached the list, they would disagree in front of the user.
    await reachSources(page);
    const sources = page.getByRole("region", { name: en.sourcesTitle });

    await expect(page.getByRole("group", { name: en.trackAria("Camera B") })).toBeVisible();
    await sources.getByLabel(`${en.moveToDevice}: C0002.MP4`).selectOption("cam-a");

    // Camera B is empty now, so its track is gone — the same rule the panel applies —
    // and its clip has moved onto Camera A's track.
    await expect(page.getByRole("group", { name: en.trackAria("Camera B") })).toBeHidden();
    const camA = page.getByRole("group", { name: en.trackAria("Camera A") });
    await expect(camA.locator(`.clip[data-file="${CAM_B}"]`)).toBeVisible();
  });
});

test.describe("the timeline stays mounted through the sync", () => {
  // V04-U5 QA. D-061's rule is that *looking* — ruler, zoom, pan, scrollbar — works in
  // every phase, and the keyboard's own +/−/0 handler has always obeyed it. The dimming
  // class carried `pointer-events: none` as well, so the mouse did not: the one phase where
  // the operator is most likely to be staring at the clips was the one phase where they
  // could not move them under the eye. Two halves of one view, disagreeing.
  test("it can still be zoomed and panned with a mouse while the sync runs", async ({
    page,
  }) => {
    await reachSources(page, { run_sync: controlled("run_sync") });
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await expect(page.locator("section.timeline")).toHaveClass(/timeline--busy/);

    const before = (await clip(page, CAM_B).boundingBox())!;
    await page.getByRole("button", { name: en.zoomIn }).click();
    await expect.poll(async () => (await clip(page, CAM_B).boundingBox())!.width).toBeGreaterThan(
      before.width,
    );

    const zoomed = (await clip(page, CAM_B).boundingBox())!;
    const body = (await page.locator(".timeline__body").boundingBox())!;
    await page.mouse.move(body.x + body.width / 2, body.y + Math.min(body.height / 2, 120));
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 300);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await clip(page, CAM_B).boundingBox())!.x).toBeLessThan(
      zoomed.x,
    );
  });

  test("the clips survive sources → syncing → result without a remount", async ({ page }) => {
    await reachSources(page, { run_sync: controlled("run_sync") });

    // Tag the live DOM nodes. If the timeline (or a clip) is unmounted and rebuilt at any
    // point, the tag goes with it — which is exactly the regression this guards.
    const tagged = async () =>
      page.evaluate(() => {
        const section = document.querySelector("section.timeline") as HTMLElement | null;
        if (section) section.dataset.e2eMountTag = "sources";
        for (const el of document.querySelectorAll<HTMLElement>(".clip")) {
          el.dataset.e2eMountTag = el.getAttribute("data-file") ?? "";
        }
      });
    await tagged();

    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");

    // Mid-run: the progress bar and its cancel are on screen, and the clips are STILL
    // there — dimmed and inert, not replaced by a spinner on an empty screen.
    await expect(page.locator(".progress__label")).toHaveText(en.syncing);
    await expect(page.getByRole("button", { name: en.cancel })).toBeVisible();
    await expect(page.locator("section.timeline")).toHaveClass(/timeline--busy/);
    await expect(page.locator(".clip")).toHaveCount(3);
    await expect(page.locator("section.timeline")).toHaveAttribute(
      "data-e2e-mount-tag",
      "sources",
    );
    await expect(clip(page, CAM_A)).toHaveAttribute("data-e2e-mount-tag", CAM_A);

    await resolveControlled(page, "run_sync", presyncOutcome());
    await waitForResult(page);

    // The result swapped in around the SAME section and the SAME clip node: the placed
    // clip is the pre-sync clip, now green, enabled and at its solved position.
    await expect(page.locator("section.timeline")).toHaveAttribute(
      "data-e2e-mount-tag",
      "sources",
    );
    const placed = clip(page, CAM_A);
    await expect(placed).toHaveAttribute("data-e2e-mount-tag", CAM_A);
    await expect(placed).not.toHaveClass(/clip--pre/);
    await expect(placed).toBeEnabled();
  });
});

/** `syncOutcome()`'s single placement, restated for this file's three-device fixture. */
function presyncOutcome(): Record<string, unknown> {
  const base = syncOutcome();
  const result = base.result as Record<string, unknown>;
  return {
    result: {
      ...result,
      devices: (presyncScanManifest().devices as Record<string, unknown>[]).map((d) => d),
      placements: [
        {
          file: CAM_A,
          device: "cam-a",
          offset_seconds: 4.2,
          confidence: 0.95,
          psr: 38.4,
          drift_ppm: null,
          projected_end_error_ms: null,
          chain: [],
          warnings: [],
        },
      ],
    },
    durations: { [WAV]: 3600, [CAM_A]: 1800, [CAM_B]: 1800 },
  };
}
