import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  controlled,
  resolveControlled,
  SETTLED_SETTINGS,
  waitForPending,
  waitForResult,
} from "./harness";
import { en } from "../src/i18n";

/**
 * «Finn klippet» — the two things the limitations doc promised twice (F, D-096).
 *
 *   1. **Picking a file in «Kilder» takes you to it.** The row has marked the clip since
 *      D-077 and the timeline stayed exactly where it was, so on a wedding-sized drop the
 *      operator got a full inspector describing a box that was three pixels wide and very
 *      often off screen entirely. The view travels now: it pans, it zooms if the clip is too
 *      narrow to look at, the tracks column scrolls, and the box says «here» once.
 *   2. **A device's unplaced files live in its own row.** They were a list behind the strip's
 *      problem chip and nothing else — «hvilket av de seks kameraene er problemet» could only
 *      be answered by reading filenames. They are numbered grey pills at the bottom of the
 *      device's own row now, and the shelf stays as the overview.
 *
 * Both halves fail on main, and they fail differently: (1) because the clip has no DOM node
 * at all after the view has been zoomed away from it, and (2) because `.track__unsynced` does
 * not exist.
 *
 * ## What is asserted about the MOVEMENT, and what is not
 *
 * The same split `hop.spec.ts` draws, for the same reason. **Where it lands** is measured —
 * boxes, in pixels, after the view has come to rest — and **that it travelled** is a discrete
 * DOM fact (`data-reveal` was set, then cleared), watched by a MutationObserver installed
 * before the click. Never a sampled tween: an animation frame is a time-dependent value and a
 * test that asserts one fails on a slow CI box for no reason.
 */

const BASE = "/Users/e2e/shoot";
/** The first file of the long card — where the view starts, and the clip a direct click
 *  must not move. */
const FIRST = `${BASE}/CamA/CLIP_0001.MP4`;
/** The take the journeys below go to: far enough away to be off screen, and not so far that
 *  the pan clamp has an opinion about it. */
const TARGET = `${BASE}/CamA/CLIP_0010.MP4`;
/** …and the very last one, where the clamp DOES have an opinion — see its own test. */
const LAST = `${BASE}/CamA/CLIP_0012.MP4`;

/**
 * One camera's card across a shooting day: twelve one-minute takes, half an hour apart.
 *
 * The shape is the point, and it is the owner's own drop in miniature. Six hours of span
 * means «Tilpass» draws every clip at two pixels — under `REVEAL_MIN_PX`, so a reveal has to
 * ZOOM as well as pan — and one notch of zoom in puts everything after the second take off
 * the right edge, where the virtualization window does not even give it a DOM node.
 */
function longDayManifest(): Record<string, unknown> {
  const start = Date.parse("2026-08-09T10:00:00.000Z");
  const files = Array.from({ length: 12 }, (_, i) => ({
    file: `${BASE}/CamA/CLIP_${String(i + 1).padStart(4, "0")}.MP4`,
    device: "cam-a",
    duration_seconds: 60,
    format_name: "mov,mp4",
    audio: { codec: "aac", sample_rate: 48000, channels: 2 },
    video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
    creation_time: new Date(start + i * 30 * 60 * 1000).toISOString(),
  }));
  return {
    schema: 1,
    devices: [
      {
        id: "cam-a",
        label: "Camera A",
        kind: "video",
        files: files.map((f) => f.file),
      },
    ],
    files,
    unsynced: [],
  };
}

/** The strip's sources cluster, and the list behind its summary line. */
function sources(page: Page) {
  return page.getByRole("region", { name: en.sourcesTitle });
}

async function pickFromKilder(page: Page, name: string) {
  await sources(page).locator(".popover--sources > summary").click();
  await sources(page).locator(".filerow--pick", { hasText: name }).click();
}

/** The lane column — the box every clip is drawn inside. The ruler row's own `track__lanes`
 *  is `#timeline-viewport`, which is the element the app itself measures for `widthPx`. */
async function laneWidth(page: Page): Promise<number> {
  return (await page.locator("#timeline-viewport").boundingBox())!.width;
}

/**
 * Where the app DREW a clip, in the lane column's own pixels — or null when the file has no
 * box at all (the virtualization window never reached it).
 *
 * Read from the inline `left`/`width` the component writes rather than from a bounding box,
 * because `.track__lanes` has `overflow: hidden`: a clip drawn 4 000 px to the right of the
 * column is off screen in every sense that matters and still reports a rectangle. These two
 * numbers are the app's own claim about where the clip is.
 */
async function drawnBox(page: Page, file: string): Promise<{ left: number; width: number } | null> {
  const clip = page.locator(`.clip[data-file="${file}"]`);
  if ((await clip.count()) === 0) return null;
  return clip.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left),
    width: parseFloat((el as HTMLElement).style.width),
  }));
}

/** The claim the reveal makes: inside the column, with `REVEAL_EDGE_PX` of room either side,
 *  and wide enough to be a box rather than a tick. */
async function expectComfortablyVisible(page: Page, file: string) {
  const box = (await drawnBox(page, file))!;
  expect(box, `${file} has no box at all`).not.toBeNull();
  const width = await laneWidth(page);
  expect(box.left).toBeGreaterThanOrEqual(24);
  expect(box.left + box.width).toBeLessThanOrEqual(width - 24);
  expect(box.width).toBeGreaterThanOrEqual(48);
}

/** Count every time `data-reveal` is SET on the timeline, from before a click until after it.
 *  Discrete and timing-free: the attribute is the app's own "the view is moving under its own
 *  power" state, exactly as `data-hop` is for the hop. */
async function watchReveals(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__E2E_REVEALS__ = 0;
    const el = document.querySelector(".timeline")!;
    new MutationObserver(() => {
      if (el.hasAttribute("data-reveal")) {
        w.__E2E_REVEALS__ = ((w.__E2E_REVEALS__ as number) ?? 0) + 1;
      }
    }).observe(el, { attributes: true, attributeFilter: ["data-reveal"] });
  });
}

async function revealCount(page: Page): Promise<number> {
  return page.evaluate(
    () => ((window as unknown as Record<string, unknown>).__E2E_REVEALS__ as number) ?? 0,
  );
}

async function reachLongDay(page: Page) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": [`${BASE}/CamA`],
      scan_inputs: longDayManifest(),
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(sources(page)).toBeVisible();
  await expect(page.locator(".clip")).toHaveCount(12);
}

/**
 * Wind in on the start of the card, so the last take is somewhere off the right edge — which
 * is exactly where an operator looking closely at the beginning of a service is standing.
 *
 * `Home` on the focused scrollbar rather than a drag: the zoom buttons anchor on the middle
 * of the window, so six notches in leaves the view in the middle of the day with the ends
 * equally far away in both directions.
 */
async function zoomAwayFromTheEnd(page: Page) {
  const zoomIn = page.getByRole("button", { name: en.zoomIn });
  for (let i = 0; i < 6; i++) await zoomIn.click();
  await page.locator(".timeline__scrollbar").focus();
  await page.keyboard.press("Home");
  const box = await drawnBox(page, TARGET);
  const width = await laneWidth(page);
  // Either it has no node at all, or it is drawn well past the right edge of the column.
  // Both are «the operator cannot see it», which is the state this whole feature is about.
  expect(box === null || box.left > width, `the target is on screen at left=${box?.left}`).toBe(true);
}

test.describe("«Kilder» finds the clip", () => {
  test("picking a file off the list brings its clip into view, wide enough to look at", async ({
    page,
  }) => {
    await reachLongDay(page);
    await zoomAwayFromTheEnd(page);

    await pickFromKilder(page, "CLIP_0010.MP4");
    await expect(page.locator(".timeline")).not.toHaveAttribute("data-reveal", /.*/);

    // It exists at all, which on main it does not: the virtualization window never reached
    // it, so the row the operator clicked marked a file with no box anywhere on screen.
    const clip = page.locator(`.clip[data-file="${TARGET}"]`);
    await expect(clip).toBeVisible();

    // Inside the column, with room to spare on both sides, and wide enough to be a clip
    // rather than a tick — «comfortably visible» is the claim, and a box flush against the
    // frame reads as cut off rather than as found.
    await expectComfortablyVisible(page, TARGET);

    // The inspector is on the same file — the two halves of «find it by name» are one gesture.
    await expect(page.locator(".preview__name")).toHaveText("CLIP_0010.MP4");
    // …and the box says so: the marked clip wears the gold ring, which is the half of the
    // errand that was missing even when the clip happened to be on screen.
    await expect(clip).toHaveClass(/clip--selected/);
  });

  test("a clip too narrow to look at is zoomed to, not merely panned to", async ({ page }) => {
    // «Tilpass» over a six-hour card draws every take at ~2 px. Panning to a 2 px tick among
    // 2 px ticks answers «where is it?» with «somewhere in that stripe».
    await reachLongDay(page);
    await page.getByRole("button", { name: en.zoomFitAria }).click();
    const before = (await drawnBox(page, TARGET))!;
    expect(before.width).toBeLessThan(24);

    await pickFromKilder(page, "CLIP_0010.MP4");
    await expect(page.locator(".timeline")).not.toHaveAttribute("data-reveal", /.*/);

    await expectComfortablyVisible(page, TARGET);
    // Centred, near enough: its middle is in the middle third of the column. A region rather
    // than a pixel, because `clampScroll` is allowed to have the last word at the ends of the
    // content and the clip drawn here is the last one there is.
    const after = (await drawnBox(page, TARGET))!;
    const width = await laneWidth(page);
    const middle = after.left + after.width / 2;
    expect(middle).toBeGreaterThan(width / 3);
    expect(middle).toBeLessThan((width * 2) / 3);
  });

  test("the view TRAVELS there — it does not cut", async ({ page }) => {
    await reachLongDay(page);
    await zoomAwayFromTheEnd(page);
    await watchReveals(page);

    await pickFromKilder(page, "CLIP_0010.MP4");

    // The attribute went on (the app is moving the view under its own power) and came off
    // again (it has arrived). Both are discrete facts; neither is a sampled frame.
    await expect.poll(() => revealCount(page)).toBeGreaterThan(0);
    await expect(page.locator(".timeline")).not.toHaveAttribute("data-reveal", /.*/);
    await expect(page.locator(`.clip[data-file="${TARGET}"]`)).toBeVisible();
  });

  test("the last clip of the day lands against the end, never past it", async ({ page }) => {
    // Where the pan clamp has the last word. Nothing may scroll beyond the content (that is
    // `clampScroll`, and every gesture in this view obeys it), so the final take cannot have
    // its full breathing room on the right — it ends flush with the frame. What must still
    // hold is the whole of it being inside the column and wide enough to look at: «as close
    // to comfortable as the end of the timeline allows» is the honest promise, and a reveal
    // that scrolled past the content to keep its padding would be inventing timeline.
    await reachLongDay(page);
    await zoomAwayFromTheEnd(page);

    await pickFromKilder(page, "CLIP_0012.MP4");
    await expect(page.locator(".timeline")).not.toHaveAttribute("data-reveal", /.*/);

    const box = (await drawnBox(page, LAST))!;
    const width = await laneWidth(page);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.left + box.width).toBeLessThanOrEqual(width + 1);
    expect(box.width).toBeGreaterThanOrEqual(48);
  });

  test("clicking a clip moves nothing — the reveal is «Kilder»'s and nobody else's", async ({
    page,
  }) => {
    // The rule, and the reason for it: the operator is already looking at the box they
    // clicked, so a timeline that panned under that click would move the one thing their eye
    // is on. Only a file chosen BY NAME, from a list, with no idea where it is, is worth a
    // journey.
    await reachLongDay(page);
    await zoomAwayFromTheEnd(page);
    await watchReveals(page);

    const first = page.locator(`.clip[data-file="${FIRST}"]`);
    const before = (await drawnBox(page, FIRST))!;
    await first.click();

    await expect(page.locator(".preview__name")).toHaveText("CLIP_0001.MP4");
    expect(await revealCount(page)).toBe(0);
    const after = (await drawnBox(page, FIRST))!;
    // Same box, to the pixel: the view's zoom and pan are both untouched.
    expect(after.left).toBeCloseTo(before.left, 0);
    expect(after.width).toBeCloseTo(before.width, 0);
  });

  test("the tracks column scrolls to the device's own row, and nothing else scrolls", async ({
    page,
  }) => {
    // The vertical half. `scrollIntoView` is forbidden here — it scrolls every scrollable
    // ancestor, which is the suite's own scar from the sibling app where «keep this row
    // visible» moved the whole page on every move — so what is asserted is both halves of
    // that: the tracks column moved, and nothing containing it did.
    await page.setViewportSize({ width: 1024, height: 600 });
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": [`${BASE}`],
        scan_inputs: manyDeviceManifest(12),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(page.locator(".track:not(.track--ruler):not(.track--scrollbar)")).toHaveCount(12);

    const scroller = page.locator(".timeline__scroll");
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    // There is genuinely something to scroll, or everything below is vacuous.
    const scrollable = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(scrollable).toBeGreaterThan(0);

    await pickFromKilder(page, "DEV12.MP4");

    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // The row is inside the visible part of the column — under the sticky ruler, not behind it.
    const box = await scroller.boundingBox();
    const row = await page
      .locator(".track", { has: page.locator(`.clip[data-file="${BASE}/DEV12/DEV12.MP4"]`) })
      .boundingBox();
    expect(row!.y).toBeGreaterThanOrEqual(box!.y);
    expect(row!.y + row!.height).toBeLessThanOrEqual(box!.y + box!.height + 1);
    // …and the document did not move: exactly one box was scrolled, because exactly one was
    // named.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test.describe("reduced motion", () => {
    test.use({ contextOptions: { reducedMotion: "reduce" } });

    test("the clip is simply THERE, with no travel to wait for", async ({ page }) => {
      await reachLongDay(page);
      await zoomAwayFromTheEnd(page);
      await watchReveals(page);

      await pickFromKilder(page, "CLIP_0010.MP4");

      // No attribute, ever: there is nothing moving, so there is nothing to say is moving.
      // The gate is in JS rather than in the sheet for the same reason the hop's is — an
      // animation the sheet refuses to run leaves the thing driving it waiting for an end
      // that never comes.
      await expect(page.locator(`.clip[data-file="${TARGET}"]`)).toBeVisible();
      expect(await revealCount(page)).toBe(0);
      await expect(page.locator(".timeline")).not.toHaveAttribute("data-reveal", /.*/);
      await expectComfortablyVisible(page, TARGET);
    });
  });
});

// ── R2c: the unplaced files live in their device's row ───────────────────────────────────

const CAM_FILES = [1, 2, 3, 4].map((i) => `${BASE}/CamA/TAKE_${i}.MP4`);
const WAV = `${BASE}/ZOOM0001.WAV`;

/** Two devices: a recorder with one file, and a camera with four. */
function unsyncedScanManifest(): Record<string, unknown> {
  const media = (file: string, device: string, video: boolean) => ({
    file,
    device,
    duration_seconds: 600,
    format_name: video ? "mov,mp4" : "wav",
    audio: { codec: video ? "aac" : "pcm_s16le", sample_rate: 48000, channels: 2 },
    video: video ? { codec: "h264", width: 1920, height: 1080, fps: "25/1" } : null,
    creation_time: null,
  });
  return {
    schema: 1,
    devices: [
      { id: "rec", label: "Zoom recorder", kind: "audio", files: [WAV] },
      { id: "cam-a", label: "Camera A", kind: "video", files: CAM_FILES },
    ],
    files: [media(WAV, "rec", false), ...CAM_FILES.map((f) => media(f, "cam-a", true))],
    unsynced: [],
  };
}

/** …and a run that places the recorder and the camera's first take, and refuses the other
 *  three. Three because the pills are NUMBERED, and one pill cannot show that. */
function unsyncedOutcome(): Record<string, unknown> {
  return {
    result: {
      schema: 1,
      parameters: { analysis_rate: 12000, min_psr: 15 },
      reference: { file: WAV, device: "rec" },
      devices: [
        { id: "rec", label: "Zoom recorder", kind: "audio", files: [WAV] },
        { id: "cam-a", label: "Camera A", kind: "video", files: CAM_FILES },
      ],
      placements: [
        {
          file: WAV,
          device: "rec",
          offset_seconds: 0,
          confidence: 1,
          psr: null,
          drift_ppm: null,
          projected_end_error_ms: null,
          chain: [],
          warnings: [],
        },
        {
          file: CAM_FILES[0],
          device: "cam-a",
          offset_seconds: 12.5,
          confidence: 0.95,
          psr: 38.4,
          drift_ppm: null,
          projected_end_error_ms: null,
          chain: [],
          warnings: [],
        },
      ],
      unsynced: [
        { file: CAM_FILES[1], reason: "low_confidence" },
        { file: CAM_FILES[2], reason: "no_audio" },
        { file: CAM_FILES[3], reason: "device_overlap" },
      ],
      sequence: { fps: "25/1", duration_seconds: 610 },
      warnings: [],
    },
    durations: Object.fromEntries([WAV, ...CAM_FILES].map((f) => [f, 600])),
  };
}

/** The `.track` of one device, by the accessible name its gutter carries. */
function track(page: Page, device: string) {
  return page.getByRole("group", { name: en.trackAria(device) });
}

test.describe("the unplaced files live in their device's row (R2c)", () => {
  async function reachResultWithRefusals(page: Page) {
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": [BASE],
        scan_inputs: unsyncedScanManifest(),
        run_sync: unsyncedOutcome(),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);
  }

  test("three refusals are three numbered pills in that camera's row", async ({ page }) => {
    await reachResultWithRefusals(page);

    const pills = track(page, "Camera A").locator(".pill--unsynced");
    await expect(pills).toHaveCount(3);
    // Numbered, in filename order — the number is what makes «hvilket kamera er problemet»
    // answerable at a glance, and an order the app assigns has to be one the operator can
    // predict (`naturalSort`, the same comparison an untimed card is laid out in).
    await expect(pills).toHaveText(["1", "2", "3"]);
    // The number alone says nothing, so the whole sentence rides on the control: which file,
    // and why it was refused — the same words the problem popover prints.
    await expect(pills.nth(0)).toHaveAttribute("aria-label", `TAKE_2.MP4 — ${en.reasonLowConfidence}`);
    await expect(pills.nth(1)).toHaveAttribute("aria-label", `TAKE_3.MP4 — ${en.reasonNoAudio}`);
    await expect(pills.nth(2)).toHaveAttribute("aria-label", `TAKE_4.MP4 — ${en.reasonDeviceOverlap}`);
    await expect(pills.nth(0)).toHaveAttribute("title", `TAKE_2.MP4 — ${en.reasonLowConfidence}`);
    // The row has its own name, and it is not «Underspor»: nothing in it is a position in
    // time, so it must not announce itself as another lane.
    await expect(
      track(page, "Camera A").getByRole("group", { name: en.unsyncedRowAria("Camera A") }),
    ).toBeVisible();
  });

  test("a device that placed everything has no strip at all", async ({ page }) => {
    await reachResultWithRefusals(page);
    // The recorder's row is untouched — an empty strip on every clean device would be a row
    // of nothing the eye has to learn to ignore.
    await expect(track(page, "Zoom recorder").locator(".track__unsynced")).toHaveCount(0);
    await expect(page.locator(".track__unsynced")).toHaveCount(1);
  });

  test("the shelf stays: the popover is the overview, the pills are the row", async ({ page }) => {
    await reachResultWithRefusals(page);
    // D-079's list is not replaced by D-096's pills. It is the complete list (a strip 700 px
    // wide cannot hold forty), it carries the bulk affordances, and it is where the SCAN's
    // own refusals live — files that never reached a device row at all.
    const problems = sources(page).locator(".popover--problems");
    await expect(problems.locator("> summary")).toHaveText(en.problemCount(3));
    await problems.locator("> summary").click();
    await expect(problems.locator(".shelf__row")).toHaveCount(3);
  });

  test("a pill marks its file, and the inspector says what the run made of it", async ({
    page,
  }) => {
    await reachResultWithRefusals(page);

    await track(page, "Camera A").locator(".pill--unsynced").nth(1).click();

    await expect(page.locator(".preview__name")).toHaveText("TAKE_3.MP4");
    // The refusal itself, in the sync half. Until F it stood empty for an unplaced file: the
    // run knew why and the inspector the operator opened BY clicking the file did not say.
    await expect(page.locator(".preview__unsynced")).toHaveText(
      `${en.unsyncedTitle}: ${en.reasonNoAudio}`,
    );
    // …and the two decisions D-027 says are the fix are right there, as they are for any
    // other marked file.
    await expect(page.locator(".inspector").getByLabel(`${en.moveToDevice}: TAKE_3.MP4`)).toBeVisible();
    await expect(page.locator(".inspector").getByLabel(`${en.removeFile}: TAKE_3.MP4`)).toBeVisible();
    // The pill wears the same gold as a selected clip — one word for «denne».
    await expect(track(page, "Camera A").locator(".pill--unsynced").nth(1)).toHaveClass(
      /pill--selected/,
    );
  });

  test("removing one from the inspector takes its pill out and renumbers the rest", async ({
    page,
  }) => {
    await reachResultWithRefusals(page);
    const pills = track(page, "Camera A").locator(".pill--unsynced");

    await pills.nth(1).click();
    await page.locator(".inspector").getByLabel(`${en.removeFile}: TAKE_3.MP4`).click();

    await expect(pills).toHaveCount(2);
    await expect(pills).toHaveText(["1", "2"]);
    await expect(pills.nth(1)).toHaveAttribute(
      "aria-label",
      `TAKE_4.MP4 — ${en.reasonDeviceOverlap}`,
    );
    // The chip agrees, because both are counted from the same list minus the same removals.
    await expect(sources(page).locator(".popover--problems > summary")).toHaveText(
      en.problemCount(2),
    );
  });

  test("the strip is inside the tracks, so the room does not move when it appears", async ({
    page,
  }) => {
    // «Ett rom» (D-074), for the one thing R2c adds to the timeline. The strip is a row INSIDE
    // the scrolling tracks column, so the shell's own boxes — and the frame the whole
    // timeline is drawn in — must be identical either side of a sync that produced three
    // refusals. `ett-rom.spec.ts` asserts this for a clean run; this is the same claim for a
    // run that draws the new row.
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": [BASE],
        scan_inputs: unsyncedScanManifest(),
        run_sync: controlled("run_sync"),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(sources(page)).toBeVisible();

    const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    const before = {
      strip: await box(".app__header"),
      slot: await box(".slot"),
      inspector: await box(".inspector"),
      stage: await box(".stage"),
      frame: await box(".timeline__frame"),
      gutter: await box(".track__gutter"),
    };

    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await resolveControlled(page, "run_sync", unsyncedOutcome());
    await waitForResult(page);
    await expect(page.locator(".track__unsynced")).toHaveCount(1);

    for (const [selector, expected] of [
      [".app__header", before.strip],
      [".slot", before.slot],
      [".inspector", before.inspector],
      [".stage", before.stage],
      [".timeline__frame", before.frame],
    ] as const) {
      const actual = await box(selector);
      expect(actual.x, selector).toBeCloseTo(expected.x, 0);
      expect(actual.y, selector).toBeCloseTo(expected.y, 0);
      expect(actual.width, selector).toBeCloseTo(expected.width, 0);
      expect(actual.height, selector).toBeCloseTo(expected.height, 0);
    }
    // The gutter is the timeline's x-origin and may not move sideways either.
    const gutter = await box(".track__gutter");
    expect(gutter.x).toBeCloseTo(before.gutter.x, 0);
    expect(gutter.width).toBeCloseTo(before.gutter.width, 0);
  });
});

/** N devices, one placed file each — a rig tall enough that the tracks column has to scroll. */
function manyDeviceManifest(n: number): Record<string, unknown> {
  const start = Date.parse("2026-08-09T10:00:00.000Z");
  const files = Array.from({ length: n }, (_, i) => ({
    file: `${BASE}/DEV${i + 1}/DEV${i + 1}.MP4`,
    device: `dev-${i + 1}`,
    duration_seconds: 600,
    format_name: "mov,mp4",
    audio: { codec: "aac", sample_rate: 48000, channels: 2 },
    video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
    creation_time: new Date(start + i * 60_000).toISOString(),
  }));
  return {
    schema: 1,
    devices: files.map((f, i) => ({
      id: `dev-${i + 1}`,
      label: `Device ${i + 1}`,
      kind: "video",
      files: [f.file],
    })),
    files,
    unsynced: [],
  };
}
