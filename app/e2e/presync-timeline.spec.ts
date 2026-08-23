import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  controlled,
  PRESYNC_B_OFFSET_SEC,
  ladderScanManifest,
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

    // Pre-sync, and honest about it: not the placed green, because green is a claim the
    // engine has not made yet.
    //
    // V05-W4b (D-070) turned the second half of this assertion inside out, and the intent
    // survives the flip. It used to be `toBeDisabled()` — "there is no placement behind
    // this box, so there is nothing to open". What a click opens now is the preview panel,
    // whose subject is the FILE, and a file exists before any sync. So the clip is enabled,
    // and the honest version of "the engine has not spoken" is asserted where it actually
    // lives: the panel fills with the file's own facts and says NOT ONE WORD of sync
    // detail. That is a stronger test of the same thing — a disabled button could have
    // become enabled with the panel still inventing an offset, and this would catch it.
    for (const file of [WAV, CAM_A, CAM_B]) {
      await expect(clip(page, file)).toHaveClass(/clip--pre/);
      await expect(clip(page, file)).toBeEnabled();
    }

    await clip(page, CAM_A).click();
    const preview = page.locator(".preview");
    await expect(preview.locator(".preview__name")).toHaveText("C0001.MP4");
    await expect(preview.getByText(en.previewVideoStream("h264", 1920, 1080, "25/1"))).toBeVisible();
    await expect(preview.getByText(en.directMatch)).toHaveCount(0);
    await expect(preview.getByText(en.offsetLabel, { exact: true })).toHaveCount(0);

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

    // Same intent as before V05-W3 — a file the app cannot time must SAY so rather than
    // reading as "this began with the others" — but the sentence is now a legend built
    // from counts, because the drop divides into more than two cases (D-067).
    // One of the three files (the WAV) carries nothing at all: no container timestamp, no
    // date tag, no timestamp in its name, no mtime.
    //
    // V06-R2b (D-083): the legend moved into the 38 px slot, so the COUNTS are what is drawn
    // and the whole sentence is the element's `title`. Both are asserted — the numbers are
    // the claim, and the sentence is what makes them readable to someone who has not met
    // this app before, so losing either would be losing the legend.
    const legend = page.locator(".timeline__note").first();
    await expect(legend).toHaveText(
      en.presyncLegendShort({ placed: 2, estimated: 0, ordered: 1, offSession: 0 }),
    );
    await expect(legend).toHaveAttribute(
      "title",
      en.presyncLegend({ placed: 2, estimated: 0, ordered: 1, offSession: 0 }),
    );
    await expect(clip(page, WAV)).toHaveAttribute(
      "aria-label",
      new RegExp(en.presyncSourceNone),
    );
    // …and it is marked as laid out by order rather than by a clock (D-068).
    await expect(clip(page, WAV)).toHaveClass(/clip--seq/);
    // The timestamped ones read their own start instead, and are NOT marked as estimates:
    // a container stamp is the top rung.
    await expect(clip(page, CAM_B)).toHaveAttribute("aria-label", new RegExp(en.presyncStart));
    await expect(clip(page, CAM_B)).not.toHaveClass(/clip--est/);
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

    // V06-R2b (D-083): the meta sentence is in the slot's middle now, where it ellipsises at
    // a narrow window — so the assertion is on the `title` it carries for exactly that
    // reason. Same sentence, and this is the reading that cannot be defeated by a window
    // width.
    await expect(page.locator(".result__meta span").first()).toHaveAttribute(
      "title",
      en.presyncMetaNoClock,
    );
    const legend = page.locator(".timeline__note").first();
    await expect(legend).toHaveText(
      en.presyncLegendShort({ placed: 0, estimated: 0, ordered: 2, offSession: 0 }),
    );
    await expect(legend).toHaveAttribute(
      "title",
      en.presyncLegend({ placed: 0, estimated: 0, ordered: 2, offSession: 0 }),
    );
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

    // The dud does not define where zero is. Since D-071 it is not merely "unknown"
    // either: it HAS a timestamp, from another day, and the app names the day rather than
    // lumping it in with the WAV that carries nothing at all. Two files, two sentences.
    const notes = page.locator(".timeline__note");
    await expect(notes.first()).toHaveText(
      en.presyncLegendShort({ placed: 2, estimated: 0, ordered: 1, offSession: 1 }),
    );
    await expect(notes.first()).toHaveAttribute(
      "title",
      en.presyncLegend({ placed: 2, estimated: 0, ordered: 1, offSession: 1 }),
    );
    await expect(page.locator(".timeline__note--offsession")).toHaveText(
      en.presyncOffSession(1, ["1970-01-01"]),
    );
    await expect(clip(page, dud)).toHaveClass(/clip--offsession/);
    await expect(clip(page, dud)).toHaveAttribute(
      "aria-label",
      new RegExp(en.presyncOffSessionClip),
    );
    // …and nothing was removed: all four files are still on the timeline (D-071).
    await expect(page.locator(".clip")).toHaveCount(4);

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

    await expect(page.getByRole("group", { name: en.trackAria("Camera B") })).toBeVisible();
    // V06-R2a (D-077 #10): the reassign `<select>` is the inspector's, so the clip is marked
    // first. The claim is unchanged — the overlay must reach the timeline, not only a list —
    // and this is now the operator's actual gesture: point at the clip, then move it.
    await page.locator(`.clip[data-file="${CAM_B}"]`).click();
    await expect(page.locator(".preview__name")).toHaveText("C0002.MP4");
    await page.locator(".inspector").getByLabel(`${en.moveToDevice}: C0002.MP4`).selectOption("cam-a");

    // Camera B is empty now, so its track is gone — the same rule the groups apply —
    // and its clip has moved onto Camera A's track.
    await expect(page.getByRole("group", { name: en.trackAria("Camera B") })).toBeHidden();
    const camA = page.getByRole("group", { name: en.trackAria("Camera A") });
    await expect(camA.locator(`.clip[data-file="${CAM_B}"]`)).toBeVisible();
  });
});

// ── The ladder, end to end (V05-W3, D-067/D-068/D-071) ─────────────────────────────────
//
// `ladderScanManifest()` is the owner's 386-file wedding in miniature: one file per rung,
// plus a dead recorder clock and a June drone folder. No unit test can make these claims —
// they are about what the operator sees on one screen when all five cases are in one drop.

test.describe("a drop with one file per rung of the recording-time ladder", () => {
  const F = "/Users/e2e/shoot";
  const FUJI = `${F}/FUJI/DSCF6408.MOV`;
  const F6 = `${F}/F6/260725_001.TAKE/260725_001_Tr1.WAV`;
  const MIKSER = `${F}/MIKSER/uirec-20260725_125533.wav`;
  const MTS = `${F}/JOHNNY/02106.MTS`;
  const MUSIC = `${F}/JOHNNY/MUSIC_01.WAV`;
  const F2 = `${F}/F2/200101_001.WAV`;
  const DRONE = `${F}/DRONE/DJI_0075.MP4`;

  async function reachLadder(page: Page) {
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": [F],
        scan_inputs: ladderScanManifest(),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(page.locator(".clip")).toHaveCount(7);
  }

  test("the legend counts all four cases, and they sum to every clip on screen", async ({
    page,
  }) => {
    await reachLadder(page);
    // One placed from a container stamp; three estimated (a BWF's date + clock, a
    // timestamp in a filename, an mtime minus its duration); one with no evidence at all;
    // two carrying stamps from other days. 1 + 3 + 1 + 2 = the seven clips above.
    const legend = page.locator(".timeline__note").first();
    await expect(legend).toHaveText(
      en.presyncLegendShort({ placed: 1, estimated: 3, ordered: 1, offSession: 2 }),
    );
    // …and the sentence that explains what each number MEANS is still there, one hover away
    // (D-083). The counts sum to the seven clips either way.
    await expect(legend).toHaveAttribute(
      "title",
      en.presyncLegend({ placed: 1, estimated: 3, ordered: 1, offSession: 2 }),
    );
  });

  test("the off-session line NAMES the dates, which is what makes it actionable", async ({
    page,
  }) => {
    await reachLadder(page);
    // «2 files are timestamped 2020-01-01 and 2023-06-13 …» — the owner recognises the
    // June drone folder instantly and would recognise nothing at all in "2 files".
    await expect(page.locator(".timeline__note--offsession")).toHaveText(
      en.presyncOffSession(2, ["2020-01-01", "2023-06-13"]),
    );
    // Named, never removed (D-071): both are still drawn, on their own devices.
    await expect(clip(page, F2)).toHaveClass(/clip--offsession/);
    await expect(clip(page, DRONE)).toHaveClass(/clip--offsession/);
  });

  test("each rung marks its clips as the kind of evidence they are", async ({ page }) => {
    await reachLadder(page);

    // The top rung is a measurement and is not marked as an estimate.
    await expect(clip(page, FUJI)).not.toHaveClass(/clip--est/);
    await expect(clip(page, FUJI)).toHaveAttribute("aria-label", new RegExp(en.presyncStart));

    // The three lower rungs are, and each says which one in words.
    for (const [file, words] of [
      [F6, en.presyncSourceBwf],
      [MIKSER, en.presyncSourceFilename],
      [MTS, en.presyncSourceModified],
    ] as const) {
      await expect(clip(page, file)).toHaveClass(/clip--est/);
      // `toContain` rather than a regex: these sentences contain `+` and `—`, and
      // `new RegExp(...)` on a translated string is a metacharacter waiting to happen.
      expect(await clip(page, file).getAttribute("aria-label")).toContain(words);
      expect(await clip(page, file).getAttribute("aria-label")).toContain(
        en.presyncStartEstimated,
      );
    }

    // And the file nothing could time claims an order, not a time.
    await expect(clip(page, MUSIC)).toHaveClass(/clip--seq/);
    await expect(clip(page, MUSIC)).toHaveAttribute(
      "aria-label",
      new RegExp(en.presyncSourceNone),
    );
  });

  test("the ladder puts the day in the right order across UTC and local sources", async ({
    page,
  }) => {
    await reachLadder(page);
    // The mixer's `125533` is 12:55 on the wall (10:55 UTC), the AVCHD camera's mtime puts
    // its clip at 11:42 UTC, the Zoom's `16:12:29` is 14:12 UTC, and the Fuji's stamp is
    // 20:41 UTC as written. Reading every source through one door would put the two
    // wall-clock devices two hours out and reorder the morning — this is the assertion
    // that catches it, in pixels.
    const x = async (file: string) => (await clip(page, file).boundingBox())!.x;
    expect(await x(MIKSER)).toBeLessThan(await x(MTS));
    expect(await x(MTS)).toBeLessThan(await x(F6));
    expect(await x(F6)).toBeLessThan(await x(FUJI));
  });

  test("a device laid out in order gets ONE lane, not one lane per file", async ({ page }) => {
    await reachLadder(page);
    // The 14-lane Zoom stack of the old layout: end-to-end clips do not overlap, so
    // `stackClips` returns a single row and the stack disappears as arithmetic.
    for (const label of ["AVCHD-kamera", "Zoom F2", "Drone"]) {
      const track = page.getByRole("group", { name: en.trackAria(label) });
      await expect(track.locator(".track__lane")).toHaveCount(1);
    }
    // …and the AVCHD camera's untimed take follows its placed clip rather than sitting on
    // top of it: same row, further right, no overlap.
    const placed = (await clip(page, MTS).boundingBox())!;
    const ordered = (await clip(page, MUSIC).boundingBox())!;
    expect(ordered.y).toBeCloseTo(placed.y, 0);
    expect(ordered.x).toBeGreaterThanOrEqual(placed.x + placed.width - 1);
  });

  test("the tracks scroll inside the frame instead of growing the room", async ({ page }) => {
    // Six devices is already more than fits comfortably; twelve is a real drop. The frame
    // had `overflow: hidden` and no height, so the BODY grew and pushed the sync button
    // off a laptop screen.
    //
    // W3 wrote that rule as `max-height: 60vh` on the scroller and asserted the number, which
    // was the best a block on a scrolling page could do: 60vh was a GUESS at how much of the
    // window the tracks may take, made by an element that could not see what was below it.
    // V06-R1 (D-074) gave the frame a definite height instead — the room's, less the strip,
    // the band, the slot and the bridge panel — so the property is no longer "the tracks are
    // capped at some fraction" but the thing the cap was standing in for: on a short window
    // the tracks OVERFLOW and scroll, and they end above the bottom slot rather than under
    // it. Asserted at a deliberately cruel 400 px, where the old page would have been three
    // screens tall.
    await page.setViewportSize({ width: 1280, height: 400 });
    await reachLadder(page);
    const scroller = page.locator(".timeline__scroll");
    const overflows = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(overflows).toBe(true);
    const box = (await scroller.boundingBox())!;
    const slot = (await page.locator(".slot").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(slot.y + 1);
    // The sync button is still reachable without scrolling anything to it — it is in the
    // strip, which is the whole point of the strip.
    await expect(page.getByRole("button", { name: en.syncButton })).toBeVisible();
    // …and the ruler stays put when the tracks are scrolled — it is the only thing on
    // screen that says what the horizontal axis means.
    const rulerBefore = (await page.locator(".track--ruler").boundingBox())!;
    await page.locator(".timeline__scroll").evaluate((el) => {
      el.scrollTop = 200;
    });
    const rulerAfter = (await page.locator(".track--ruler").boundingBox())!;
    expect(rulerAfter.y).toBeCloseTo(rulerBefore.y, 0);
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
