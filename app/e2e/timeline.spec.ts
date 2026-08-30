import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForResult,
} from "./harness";
import { en } from "../src/i18n";

// The interactive result timeline (v0.3 S3, D-051) — §9.4's lanes rebuilt with a real
// zoom, sub-track stacking, a ruler and a playhead.
//
// These are journeys, not geometry unit tests: `src/timeline/{geometry,laneLayout,
// viewport}.ts` already prove the maths in isolation, so what is worth a browser is
// whether the maths reaches the screen — whether a device with nothing placed still
// gets a track, whether two overlapping clips get two rows instead of hiding each
// other, and whether zoom/pan actually move pixels.

/** Boot straight into the result phase with `outcome` as `run_sync`'s answer. */
async function reachResult(page: Page, outcome: Record<string, unknown> = syncOutcome()) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: scanManifest(),
      run_sync: outcome,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await page.getByRole("button", { name: en.syncButton }).click();
  // The timeline itself is mounted from the sources phase on (V04-U3, D-061), so waiting
  // for it no longer means the sync has finished — `waitForResult` gates on the
  // result-only export bar instead.
  await waitForResult(page);
}

/** The base fixture with `placements` replacing the single one, plus their durations. */
function outcomeWithPlacements(
  placements: Record<string, unknown>[],
  durations: Record<string, number> = {},
) {
  const base = syncOutcome();
  return {
    ...base,
    result: { ...(base.result as Record<string, unknown>), placements },
    durations: { ...(base.durations as Record<string, number>), ...durations },
  };
}

function placement(over: Record<string, unknown> = {}) {
  return {
    file: "/Users/e2e/shoot/CamA/C0001.MP4",
    device: "cam-a",
    offset_seconds: 4.2,
    confidence: 0.95,
    psr: 38.4,
    drift_ppm: null,
    projected_end_error_ms: null,
    chain: [],
    warnings: [],
    ...over,
  };
}

/** The clip button for `name`, scoped to the timeline (SourcesView also names files). */
function clipBox(page: Page, name = "C0001.MP4") {
  return page.locator(".clip", { hasText: name });
}

/** Zoom in `steps` notches with the cursor parked over the middle of the timeline —
 *  the precondition for anything about panning or the scrollbar, since neither has
 *  anywhere to go while the whole result fits on screen. */
async function zoomIn(page: Page, steps: number) {
  await hoverTimeline(page);
  await page.keyboard.down("Control");
  for (let i = 0; i < steps; i++) await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
}

/** Park the pointer over the middle of the timeline — wheel gestures go to whatever is
 *  under the cursor, and the page itself scrolls, so this is re-done rather than assumed. */
async function hoverTimeline(page: Page) {
  const body = page.locator(".timeline__body");
  await body.scrollIntoViewIfNeeded();
  const box = (await body.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 120));
}

/**
 * The scrollbar's trough and thumb boxes, with the scrollbar scrolled into view first.
 *
 * At the 1280×720 the config runs, a result view is taller than the viewport and the
 * scrollbar row sits below the fold — `page.mouse` takes raw viewport coordinates and does
 * not scroll for you, so reading a boundingBox without this gives coordinates no click can
 * ever reach, and every assertion about "nothing moved" passes for the wrong reason.
 */
async function scrollbarBoxes(page: Page) {
  const trough = page.locator(".timeline__scrollbar");
  await trough.scrollIntoViewIfNeeded();
  return {
    trough: (await trough.boundingBox())!,
    thumb: (await page.locator(".timeline__thumb").boundingBox())!,
  };
}

test.describe("timeline tracks", () => {
  test("every device gets a track, and the reference draws its own clip at zero", async ({
    page,
  }) => {
    await reachResult(page);

    await expect(page.locator(".track:not(.track--ruler):not(.track--scrollbar)")).toHaveCount(2);
    const reference = page.getByRole("group", { name: en.trackAria("Zoom recorder") });
    await expect(reference).toBeVisible();
    await expect(page.getByRole("group", { name: en.trackAria("Camera A") })).toBeVisible();

    // The reference device is marked — a ★ carrying «Referanse» as its accessible name
    // since R/D-094, so the device name gets the gutter's width. See gutter.spec.ts.
    await expect(reference.getByRole("img", { name: en.reference })).toBeVisible();

    // …and it has a CLIP, which until the V06-G2 review it never did in this suite. The
    // engine places the reference at zero by construction (`place.rs`: "The reference
    // defines the origin"), and `syncOutcome()` had simply never said so — so no browser
    // spec had ever rendered the reference row, and the row that the whole timeline's
    // vertical geometry is measured from was permanently the §7.5 empty case here.
    await expect(reference.locator(".clip")).toHaveCount(1);
    await expect(reference.getByText(en.emptyLane)).toHaveCount(0);
    // At zero: its left edge is the lane column's own origin, which is what "the reference
    // defines the origin" means on screen.
    const lane = (await page.locator("#timeline-viewport").boundingBox())!;
    const box = (await reference.locator(".clip").boundingBox())!;
    expect(box.x - lane.x).toBeLessThanOrEqual(1);
  });

  test("a device the run placed nothing on is still visible, and says so (§7.5)", async ({
    page,
  }) => {
    // The same claim the test above used to carry, moved to a fixture that actually
    // produces it (D-085: re-express, never delete). `outcomeWithPlacements` replaces the
    // placement list wholesale, so this outcome places cam-a and nothing else — the shape a
    // run has when the reference itself could not be laid out, and the shape §7.5 is about.
    await reachResult(page, outcomeWithPlacements([placement()]));

    const empty = page.getByRole("group", { name: en.trackAria("Zoom recorder") });
    await expect(empty.getByText(en.emptyLane)).toBeVisible();
    await expect(empty.locator(".clip")).toHaveCount(0);
    await expect(empty.getByRole("img", { name: en.reference })).toBeVisible();
  });

  test("two overlapping clips on one device stack into two sub-tracks", async ({ page }) => {
    await reachResult(
      page,
      outcomeWithPlacements(
        [
          placement({ file: "/Users/e2e/shoot/CamA/C0001.MP4", offset_seconds: 0 }),
          // Starts 60 s in while the first still has ~59 minutes to run — physically
          // impossible for one camera, but the multitrack-board exemption (D-050) lets
          // it through, and then it must not hide behind the first.
          placement({ file: "/Users/e2e/shoot/CamA/C0002.MP4", offset_seconds: 60 }),
        ],
        { "/Users/e2e/shoot/CamA/C0002.MP4": 3000 },
      ),
    );

    const camA = page.getByRole("group", { name: en.trackAria("Camera A") });
    await expect(camA.locator(".track__lane")).toHaveCount(2);
    await expect(camA.getByRole("group", { name: en.subTrackAria(1) })).toBeVisible();
    await expect(camA.getByRole("group", { name: en.subTrackAria(2) })).toBeVisible();

    // Each row holds exactly one of them, and the rows sit at different heights.
    const first = clipBox(page, "C0001.MP4");
    const second = clipBox(page, "C0002.MP4");
    const a = await first.boundingBox();
    const b = await second.boundingBox();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.y).toBeGreaterThan(a!.y);
    // …and the later one starts further right, which is the whole point of a timeline.
    expect(b!.x).toBeGreaterThan(a!.x);
  });

  test("the ruler is populated with timecode ticks", async ({ page }) => {
    await reachResult(page);
    const ticks = page.locator(".timeline__tick");
    expect(await ticks.count()).toBeGreaterThan(1);
    await expect(ticks.first()).toBeVisible();
    // Ticks read as a TIMECODE — never a bare millisecond count. Re-expressed in V06-R3
    // (D-085): the claim was written as `HH:MM:SS.mmm`, which was the mechanism rather than
    // the rule. `tickLabel` now drops the milliseconds whenever the chosen tick spacing is
    // a whole second or more, because at that spacing no two ticks could differ in them —
    // and the four characters they cost were what pushed the rightmost label off the end of
    // the lane. Both forms are asserted here, and the pure choice between them is pinned in
    // `geometry.test.ts`.
    await expect(ticks.first()).toHaveText(/^\d+(:\d{2})*:\d{2}(\.\d{3})?$/);
    // At this fixture's fit zoom the spacing really is seconds or more, so the shortened
    // form is the one on screen — otherwise the alternation above would pass vacuously.
    await expect(ticks.first()).not.toHaveText(/\.\d{3}$/);
    // …and the LAST tick is never a number cut off mid-digit: a label that would not fit
    // inside the lane is dropped and its line kept (V06-R3).
    const lane = (await page.locator("#timeline-viewport").boundingBox())!;
    const rights = await ticks.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().left + (el.textContent ?? "").length * 7 + 4),
    );
    for (const r of rights) expect(r).toBeLessThanOrEqual(lane.x + lane.width + 1);
  });
});

test.describe("playhead", () => {
  test("clicking the ruler moves the playhead line to that instant", async ({ page }) => {
    await reachResult(page);
    const line = page.locator(".timeline__playhead-line");
    const ruler = (await page.locator(".timeline__ruler").boundingBox())!;

    // Two thirds along the ruler.
    const targetX = ruler.x + ruler.width * 0.66;
    await page.mouse.click(targetX, ruler.y + ruler.height / 2);

    await expect.poll(async () => (await line.boundingBox())!.x).toBeGreaterThan(targetX - 3);
    expect((await line.boundingBox())!.x).toBeLessThan(targetX + 3);

    // …and dragging keeps it following the pointer, back the other way.
    await page.mouse.move(targetX, ruler.y + ruler.height / 2);
    await page.mouse.down();
    await page.mouse.move(ruler.x + ruler.width * 0.2, ruler.y + ruler.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await line.boundingBox())!.x).toBeLessThan(targetX);
  });
});

test.describe("zoom and pan", () => {
  test("ctrl+wheel zooms in around the cursor, widening the clip", async ({ page }) => {
    await reachResult(page);
    const clip = clipBox(page);
    const before = await clip.boundingBox();
    expect(before).not.toBeNull();

    const body = await page.locator(".timeline__body").boundingBox();
    await page.mouse.move(body!.x + body!.width / 2, body!.y + body!.height / 2);
    await page.keyboard.down("Control");
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");

    await expect
      .poll(async () => (await clip.boundingBox())!.width)
      .toBeGreaterThan(before!.width * 1.5);
  });

  test("a horizontal wheel pans, moving the clip without resizing it", async ({ page }) => {
    await reachResult(page);
    const clip = clipBox(page);
    await zoomIn(page, 6);

    const before = await clip.boundingBox();
    // A trackpad's sideways flick — a real `deltaX`, no modifier.
    await page.mouse.wheel(400, 0);

    await expect.poll(async () => (await clip.boundingBox())!.x).toBeLessThan(before!.x);
    // Panning is not zooming: the clip keeps its width.
    expect((await clip.boundingBox())!.width).toBeCloseTo(before!.width, 0);
  });

  test("shift+wheel pans too — the mouse-with-one-wheel convention", async ({ page }) => {
    await reachResult(page);
    const clip = clipBox(page);
    await zoomIn(page, 6);

    const before = await clip.boundingBox();
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 400);
    await page.keyboard.up("Shift");

    await expect.poll(async () => (await clip.boundingBox())!.x).toBeLessThan(before!.x);
  });

  test("a plain vertical wheel is not swallowed (finding 13)", async ({ page }) => {
    // The gesture the timeline owns is horizontal; a plain vertical wheel belongs to whatever
    // scroller is under it. It used to `preventDefault()` every wheel event before even
    // looking at the modifiers, and then pan on `deltaY` — so an innocent scroll silently
    // moved the timeline sideways instead of reaching anything.
    //
    // V06-R1 (D-074) changed WHERE such a wheel goes without changing whose it is. The app is
    // one fixed room now: `html, body { overflow: hidden }`, and every scrollable thing says
    // so for itself — the tracks inside the frame, the inspector column, the sources panel.
    // There is no document scroll left to observe, so the old "…and the page moved" line is
    // gone and `ett-rom.spec.ts` asserts the room's stillness directly. What is asserted here
    // is finding 13 itself, which never needed the page: the app does not claim the event
    // (`defaultPrevented === false`), and the timeline does not pan on it.
    await reachResult(page);
    await zoomIn(page, 6); // give panning somewhere to go, so a regression would show

    // Records whether the timeline's own (bubble-phase) listener consumed the event.
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__WHEEL_PREVENTED__ = null;
      window.addEventListener(
        "wheel",
        (e) => {
          (window as unknown as Record<string, unknown>).__WHEEL_PREVENTED__ = e.defaultPrevented;
        },
        { passive: true },
      );
    });
    const prevented = () =>
      page.evaluate(() => (window as unknown as Record<string, unknown>).__WHEEL_PREVENTED__);

    await page.evaluate(() => window.scrollTo(0, 0));
    await hoverTimeline(page);
    const clip = clipBox(page);
    const beforeX = (await clip.boundingBox())!.x;

    await page.mouse.wheel(0, 400);

    await expect.poll(prevented).toBe(false);
    // …and the timeline did not pan. Any change here would be the swallowed wheel turning
    // into a horizontal pan again.
    expect((await clip.boundingBox())!.x).toBeCloseTo(beforeX, 0);

    // The gesture the timeline DOES own is still prevented.
    await hoverTimeline(page);
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 120);
    await page.keyboard.up("Shift");
    await expect.poll(prevented).toBe(true);
  });

  test("keyboard: + zooms in, 0 and F fit the whole result back on screen", async ({ page }) => {
    await reachResult(page);
    const clip = clipBox(page);
    const fitted = (await clip.boundingBox())!.width;

    await page.locator(".timeline").focus();
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    await expect.poll(async () => (await clip.boundingBox())!.width).toBeGreaterThan(fitted);

    await page.keyboard.press("0");
    await expect.poll(async () => (await clip.boundingBox())!.width).toBeCloseTo(fitted, 0);

    // `F` is the same action under the name the Fit button carries (V03-S6).
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    await expect.poll(async () => (await clip.boundingBox())!.width).toBeGreaterThan(fitted);
    await page.keyboard.press("f");
    await expect.poll(async () => (await clip.boundingBox())!.width).toBeCloseTo(fitted, 0);
  });

  test("the scrollbar thumb shrinks as the visible window does", async ({ page }) => {
    await reachResult(page);
    const thumb = page.locator(".timeline__thumb");
    const full = (await thumb.boundingBox())!.width;

    await zoomIn(page, 8);

    await expect.poll(async () => (await thumb.boundingBox())!.width).toBeLessThan(full * 0.6);
    await expect(page.getByRole("scrollbar", { name: en.scrollbarAria })).toBeVisible();
  });
});

test.describe("the scrollbar (findings 5 and 14)", () => {
  test("grabbing the thumb by its left edge does not jump the timeline", async ({ page }) => {
    // Finding 5: `offsetFrac` is the thumb's LEFT edge, but the pointer fraction was fed
    // to the CENTRE-seeking mapping, and the same handler ran whether the press landed on
    // the thumb or on empty trough. Pressing the thumb's left edge therefore threw the
    // view half a visible window backwards before the drag had moved a pixel — measured
    // as roughly a third of the trough at this zoom.
    await reachResult(page);
    await zoomIn(page, 8);

    const { thumb: before } = await scrollbarBoxes(page);
    const thumb = page.locator(".timeline__thumb");

    await page.mouse.move(before.x + 1, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    expect((await thumb.boundingBox())!.x).toBeCloseTo(before.x, 0);

    // …and by its right edge, which used to throw the view half a window the other way.
    const right = (await thumb.boundingBox())!;
    await page.mouse.move(right.x + right.width - 1, right.y + right.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    expect((await thumb.boundingBox())!.x).toBeCloseTo(right.x, 0);
  });

  test("dragging the thumb keeps it under the pointer", async ({ page }) => {
    await reachResult(page);
    await zoomIn(page, 8);

    const { thumb: before } = await scrollbarBoxes(page);
    const thumb = page.locator(".timeline__thumb");

    // Grab near the left edge and drag right by a known distance: the thumb must move by
    // that same distance, not by "wherever centring puts it".
    const grabX = before.x + 2;
    const y = before.y + before.height / 2;
    await page.mouse.move(grabX, y);
    await page.mouse.down();
    await page.mouse.move(grabX + 60, y, { steps: 6 });
    await page.mouse.up();

    await expect.poll(async () => (await thumb.boundingBox())!.x).toBeCloseTo(before.x + 60, 0);
  });

  test("pressing empty trough still jumps the view there", async ({ page }) => {
    // The other half of the fix: click-to-jump must survive. Only a press ON the thumb
    // becomes a grab.
    await reachResult(page);
    await zoomIn(page, 8);

    const { trough, thumb: before } = await scrollbarBoxes(page);
    const thumb = page.locator(".timeline__thumb");

    await page.mouse.click(trough.x + trough.width * 0.9, trough.y + trough.height / 2);
    await expect.poll(async () => (await thumb.boundingBox())!.x).toBeGreaterThan(before.x + 20);
  });

  test("it is focusable, keyboard-operable, and reports a value that reaches 100", async ({
    page,
  }) => {
    // Finding 14: `role="scrollbar"` with no tab stop, no key handling and an
    // `aria-valuenow` capped at (1 − thumbFrac)·100 announced itself to a screen reader
    // and then could neither be reached nor read correctly.
    await reachResult(page);
    await zoomIn(page, 8);

    const bar = page.getByRole("scrollbar", { name: en.scrollbarAria });
    await bar.focus();
    await expect(bar).toBeFocused();
    // Zooming anchors on the cursor, so the view starts mid-timeline; Home is the
    // keyboard's own way back and the baseline for what follows.
    await bar.press("Home");
    await expect(bar).toHaveAttribute("aria-valuenow", "0");

    await bar.press("ArrowRight");
    await expect.poll(async () => Number(await bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0);

    await bar.press("End");
    await expect(bar).toHaveAttribute("aria-valuenow", "100");

    await bar.press("Home");
    await expect(bar).toHaveAttribute("aria-valuenow", "0");

    // The keys the scrollbar handles must not ALSO drive the section's playhead — that is
    // what `stopPropagation` is for. Asserted on the CLOCK, not on the line's pixel
    // position: scrolling moves the line across the screen without moving it in time,
    // which is the correct behaviour and would make a pixel assertion fail for the right
    // reason and pass for the wrong one.
    const time = page.getByTestId("transport-time");
    await expect(time).toHaveText("00:00.000");
    await bar.press("ArrowRight");
    await bar.press("End");
    await bar.press("Home");
    await expect(time).toHaveText("00:00.000");
  });
});

test.describe("playhead keyboard (V03-S6)", () => {
  test("arrows nudge the playhead a second at a time, Home returns to the start", async ({
    page,
  }) => {
    await reachResult(page);
    const time = page.getByTestId("transport-time");
    await expect(time).toHaveText("00:00.000");

    await page.locator(".timeline").focus();
    await page.keyboard.press("ArrowRight");
    await expect(time).toHaveText("00:01.000");
    await page.keyboard.press("ArrowRight");
    await expect(time).toHaveText("00:02.000");

    // Shift is the ten-second stride.
    await page.keyboard.press("Shift+ArrowRight");
    await expect(time).toHaveText("00:12.000");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(time).toHaveText("00:02.000");

    // Never before the start, however hard you lean on it.
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(time).toHaveText("00:00.000");

    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Home");
    await expect(time).toHaveText("00:00.000");
  });

  test("the clip under the playhead is marked aria-current", async ({ page }) => {
    // `usePlayheadInsideSpan` existed for exactly this and had no caller until S6.
    await reachResult(page);
    const clip = clipBox(page);
    await expect(clip).not.toHaveAttribute("aria-current", /.*/);

    // The fixture's clip runs 4.2 s → 3554.2 s; a minute in is comfortably inside it.
    await page.locator(".timeline").focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(clip).toHaveAttribute("aria-current", "time");

    await page.keyboard.press("Home");
    await expect(clip).not.toHaveAttribute("aria-current", /.*/);
  });

  test("the keys do not fire while a control owns them", async ({ page }) => {
    // The volume slider lives inside the timeline section, so its arrow keys bubble
    // straight into the playhead handler unless the tag guard catches them.
    await reachResult(page);
    const time = page.getByTestId("transport-time");
    await page.getByLabel(en.volumeAria).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(time).toHaveText("00:00.000");
  });
});

test.describe("a clip whose duration the outcome does not carry (finding 15)", () => {
  test("says so instead of drawing a silent zero-length sliver", async ({ page }) => {
    const base = syncOutcome();
    await reachResult(page, {
      ...base,
      // The placement is there; its `durations` entry is not — the hole this is about.
      durations: { "/Users/e2e/shoot/ZOOM0001.WAV": 3600 },
    });

    // Addressed by `data-file`, not by its text: since D-065 a clip only draws its name
    // when there is room for a name, and this one is the 3 px sliver the whole test is
    // about. What it says it says in `aria-label` and `title` — asserted right below, and
    // the point of the test — not in three pixels of ellipsis.
    const clip = page.locator(`.clip[data-file="/Users/e2e/shoot/CamA/C0001.MP4"]`);
    await expect(clip).toHaveClass(/clip--nodur/);
    await expect(clip).toHaveAttribute("aria-label", new RegExp(en.clipDurationUnknown));
    await expect(clip).toHaveAttribute("title", new RegExp(en.clipDurationUnknown));
    // Still a clip: clicking it still shows what the app knows about it — in the preview
    // panel since V05-W4b (D-070) rather than in a dialog. A three-pixel sliver is the
    // hardest thing on the timeline to hit, and it staying selectable is the point.
    await clip.click();
    await expect(page.locator(".preview__name")).toHaveText("C0001.MP4");
  });
});

test.describe("clip detail and the unsynced shelf", () => {
  test("clicking a clip shows its detail with the offset to the millisecond", async ({
    page,
  }) => {
    await reachResult(page);
    await clipBox(page).click();

    // V05-W4b (D-070): the detail moved from a dialog into the always-present panel. The
    // assertion is deliberately the SAME two numbers — those strings are §9.4's, the owner
    // reads them every run, and this stage moved them rather than rewording them.
    const preview = page.locator(".preview");
    await expect(preview.locator(".preview__name")).toHaveText("C0001.MP4");
    // 4.2 s in the fixture, rendered at 3 dp — the precision the engine actually has.
    await expect(preview.getByText("4.200 s")).toBeVisible();
    await expect(preview.getByText(en.directMatch)).toBeVisible();
  });

  test("reassigning from the shelf marks the result stale and dims the timeline", async ({
    page,
  }) => {
    const base = syncOutcome();
    await reachResult(page, {
      ...base,
      result: {
        ...(base.result as Record<string, unknown>),
        placements: [],
        unsynced: [{ file: "/Users/e2e/shoot/CamA/C0001.MP4", reason: "device_overlap" }],
      },
    });

    const timeline = page.locator("section.timeline");
    await expect(timeline).not.toHaveClass(/result--stale/);
    // V06-R2a (D-079): the shelf hangs off the strip's problem chip now, so the reason is one
    // click away rather than under the timeline. Reported, not hidden — the chip carries the
    // count, and this asserts both halves.
    const problems = page
      .getByRole("region", { name: en.sourcesTitle })
      .locator(".popover--problems");
    await expect(problems.locator("> summary")).toHaveText(en.problemCount(1));
    await problems.locator("> summary").click();
    await expect(page.getByText(en.reasonDeviceOverlap)).toBeVisible();

    await page.locator(".shelf").getByLabel(`${en.moveToDevice}: C0001.MP4`).selectOption("rec");

    // The override reached the reducer: the result is stale, and it LOOKS stale.
    await expect(timeline).toHaveClass(/result--stale/);
    await expect(page.getByText(en.staleResult)).toBeVisible();
    await expect(page.getByRole("button", { name: en.exportButton })).toBeDisabled();
  });
});
