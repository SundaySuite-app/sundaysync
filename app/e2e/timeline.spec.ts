import { test, expect, type Page } from "@playwright/test";
import { boot, BOOT_FIXTURES, scanManifest, SETTLED_SETTINGS, syncOutcome } from "./harness";
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
  await expect(page.locator(".timeline__body")).toBeVisible();
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

test.describe("timeline tracks", () => {
  test("every device gets a track, including one with nothing placed (§7.5)", async ({
    page,
  }) => {
    await reachResult(page);

    // The fixture places one clip on cam-a and nothing on rec.
    await expect(page.locator(".track:not(.track--ruler):not(.track--scrollbar)")).toHaveCount(2);
    await expect(page.getByRole("group", { name: en.trackAria("Zoom recorder") })).toBeVisible();
    await expect(page.getByRole("group", { name: en.trackAria("Camera A") })).toBeVisible();

    // The empty one says so rather than looking like a rendering failure.
    const empty = page.getByRole("group", { name: en.trackAria("Zoom recorder") });
    await expect(empty.getByText(en.emptyLane)).toBeVisible();
    await expect(empty.locator(".clip")).toHaveCount(0);

    // The reference device is badged.
    await expect(empty.getByText(en.reference)).toBeVisible();
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
    // Ticks read as HH:MM:SS.mmm / MM:SS.mmm — never a bare millisecond count.
    await expect(ticks.first()).toHaveText(/^\d+(:\d{2})*:\d{2}\.\d{3}$/);
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

  test("a plain wheel pans, moving the clip without resizing it", async ({ page }) => {
    await reachResult(page);
    const clip = clipBox(page);
    const body = await page.locator(".timeline__body").boundingBox();
    await page.mouse.move(body!.x + body!.width / 2, body!.y + body!.height / 2);

    // Panning only has room once we are zoomed past fit.
    await page.keyboard.down("Control");
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");

    const before = await clip.boundingBox();
    await page.mouse.wheel(0, 400);

    await expect.poll(async () => (await clip.boundingBox())!.x).toBeLessThan(before!.x);
    // Panning is not zooming: the clip keeps its width.
    expect((await clip.boundingBox())!.width).toBeCloseTo(before!.width, 0);
  });

  test("keyboard: + zooms in, 0 fits the whole result back on screen", async ({ page }) => {
    await reachResult(page);
    const clip = clipBox(page);
    const fitted = (await clip.boundingBox())!.width;

    await page.locator(".timeline").focus();
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    await expect.poll(async () => (await clip.boundingBox())!.width).toBeGreaterThan(fitted);

    await page.keyboard.press("0");
    await expect.poll(async () => (await clip.boundingBox())!.width).toBeCloseTo(fitted, 0);
  });

  test("the scrollbar thumb shrinks as the visible window does", async ({ page }) => {
    await reachResult(page);
    const thumb = page.locator(".timeline__thumb");
    const full = (await thumb.boundingBox())!.width;

    const body = await page.locator(".timeline__body").boundingBox();
    await page.mouse.move(body!.x + body!.width / 2, body!.y + body!.height / 2);
    await page.keyboard.down("Control");
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");

    await expect.poll(async () => (await thumb.boundingBox())!.width).toBeLessThan(full * 0.6);
    await expect(page.getByRole("scrollbar", { name: en.scrollbarAria })).toBeVisible();
  });
});

test.describe("clip detail and the unsynced shelf", () => {
  test("clicking a clip opens its detail with the offset to the millisecond", async ({
    page,
  }) => {
    await reachResult(page);
    await clipBox(page).click();

    const dialog = page.getByRole("dialog", { name: "C0001.MP4" });
    await expect(dialog).toBeVisible();
    // 4.2 s in the fixture, rendered at 3 dp — the precision the engine actually has.
    await expect(dialog.getByText("4.200 s")).toBeVisible();
    await expect(dialog.getByText(en.directMatch)).toBeVisible();
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
    await expect(page.getByText(en.reasonDeviceOverlap)).toBeVisible();

    await page.locator(".shelf").getByLabel(`${en.moveToDevice}: C0001.MP4`).selectOption("rec");

    // The override reached the reducer: the result is stale, and it LOOKS stale.
    await expect(timeline).toHaveClass(/result--stale/);
    await expect(page.getByText(en.staleResult)).toBeVisible();
    await expect(page.getByRole("button", { name: en.exportButton })).toBeDisabled();
  });
});
