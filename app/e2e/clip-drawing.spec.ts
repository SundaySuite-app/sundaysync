import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  resolveControlled,
  SETTLED_SETTINGS,
  waitForPending,
  waitForResult,
  controlled,
} from "./harness";
import {
  CLIP_DRAWING_MIN_PX,
  HAIRLINE_WIDTH_PX,
  LANE_MAX_PX,
  LANE_MIN_PX,
  laneHeightFor,
} from "../src/timeline/hop";
import { en } from "../src/i18n";

/**
 * V06-G2 (D-091) — a clip is a DRAWING, it does not cross its neighbour, and the lanes grow
 * into the room.
 *
 * The three claims here are the three the V06 self-critical review measured going the other
 * way, and each of them is the kind that reads as fine in a code diff and wrong in the hand:
 *
 *   1. **The anatomy.** v0.6.0-beta.3 drew every placed clip as a saturated `--green` block,
 *      so a device's row was one unbroken stripe and the waveform inside it — the only thing
 *      on screen that lets an operator judge a sync by eye — was a darker smudge of the same
 *      hue. The approved canvas draws an outline, a 10 % wash and the waveform stroked in the
 *      state's colour, in every state.
 *   2. **The overlap.** `.clip`'s `0 0.4rem` padding is 12.8 px on a `border-box` sheet, so a
 *      clip DECLARED 3 px wide was LAID OUT 12.8 px wide. At fit zoom on the owner's wedding
 *      309 of 340 adjacent pairs overlapped, and Playwright aiming at one clip measurably
 *      clicked another — which is the review's most damning finding, because it is not a
 *      matter of taste: the app was handing the operator the wrong file.
 *   3. **The room.** At a fixed 40 px pitch, 45–79 % of the stage was empty dark space on
 *      every drop the review looked at.
 *
 * The fixtures are pre-sync drops (a scan, no sync) wherever the claim allows it: the
 * pre-sync timeline draws EVERY file the card carries, which is the densest thing the app
 * ever puts on screen and the state the review's numbers were measured in. The claims that
 * are about the placed green or about the hop need an outcome and say so.
 */

const SPAN_SEC = 3 * 3600;
const SHOOT_START_MS = Date.parse("2026-08-09T09:00:00.000Z");

const startedAt = (offsetSeconds: number): string =>
  new Date(SHOOT_START_MS + offsetSeconds * 1000).toISOString();

/**
 * A card of `devices` cameras with `perDevice` clips each, evenly spread across a
 * three-hour service — the shape of the owner's wedding drop, parameterised so the same
 * builder can produce the two ends of the range the lane rule has to cover.
 */
function card(devices: number, perDevice: number, clipSec = 90): Record<string, unknown> {
  const spacing = perDevice > 1 ? (SPAN_SEC - clipSec) / (perDevice - 1) : 0;
  const deviceList: Record<string, unknown>[] = [];
  const files: Record<string, unknown>[] = [];
  for (let d = 0; d < devices; d += 1) {
    const id = `cam${d}`;
    const own: string[] = [];
    for (let c = 0; c < perDevice; c += 1) {
      const file = `/nas/${id}/c${d}_${String(c).padStart(3, "0")}.mp4`;
      own.push(file);
      files.push({
        file,
        device: id,
        duration_seconds: clipSec,
        format_name: "mov,mp4",
        audio: { codec: "aac", sample_rate: 48000, channels: 2 },
        video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
        creation_time: startedAt(c * spacing),
        date_tag: null,
        modified_time: null,
      });
    }
    deviceList.push({ id, label: `Camera ${d}`, kind: "video", files: own });
  }
  return { schema: 1, devices: deviceList, files, unsynced: [], skipped: [] };
}

/**
 * The owner's card, at the density the overlap is actually about: four cameras rolling
 * more or less continuously through a three-hour service. 480 clips, and — the number that
 * matters — a start-to-start spacing of ~6 px at fit zoom against a drawn width of ~4 px.
 * That is the regime where a 12.8 px laid-out box has to cross two of its neighbours.
 *
 * The DEVICE count is deliberately low here and high in `WEDDING` below, because the two
 * halves of D-091 pull on different numbers: the overlap is about clips per row, and the
 * lane pitch is about rows. One fixture cannot be extreme in both without being extreme in
 * neither.
 */
const DENSE_DEVICES = 4;
const DENSE_PER_DEVICE = 120;
const DENSE_CLIP_SEC = 60;
const DENSE_TOTAL = DENSE_DEVICES * DENSE_PER_DEVICE; // 480
const dense = () => card(DENSE_DEVICES, DENSE_PER_DEVICE, DENSE_CLIP_SEC);

/** …and the same wedding counted the other way: sixteen devices, which is what puts the
 *  lane pitch on its floor in a laptop-sized window. */
const WEDDING_DEVICES = 16;
const WEDDING_PER_DEVICE = 25;
const WEDDING_TOTAL = WEDDING_DEVICES * WEDDING_PER_DEVICE; // 400

/** …and its opposite: three files, three devices, a whole window to put them in. */
const TINY_DEVICES = 3;

async function drop(page: Page, scan: Record<string, unknown>, total: number): Promise<void> {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Volumes/nas/wedding"],
      scan_inputs: scan,
      // Nothing this file asserts is about the waveform's BYTES, and a fixture that
      // resolved them would put a canvas and a fetch behind every one of 400 clips.
      waveform_meta: { __e2e_reject: true },
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(page.locator(".clip")).toHaveCount(total);
}

/** Every drawn clip's box, grouped by the lane it is in — which is the only grouping the
 *  overlap question has: two clips in different lanes cannot overlap however close their
 *  starts are. Read in one round trip so no pan or resize can straddle the measurement. */
async function lanes(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".track__lane")).map((lane) => {
      const el = lane as HTMLElement;
      return {
        height: el.getBoundingClientRect().height,
        clips: Array.from(el.querySelectorAll(".clip")).map((c) => {
          const node = c as HTMLElement;
          const r = node.getBoundingClientRect();
          const s = getComputedStyle(node);
          return {
            file: node.dataset.file ?? "",
            x: r.x,
            width: r.width,
            height: r.height,
            hairline: node.classList.contains("clip--hairline"),
            declared: node.style.width,
            background: s.backgroundColor,
            border: s.borderTopColor,
            ink: s.getPropertyValue("--clip-ink").trim(),
            chrome: node.querySelector(".clip__chrome") !== null,
            slot: node.querySelector(".clip__waveform") !== null,
          };
        }),
      };
    }),
  );
}

/** Adjacent pairs whose boxes are drawn on top of one another, over the whole timeline.
 *  A 0.5 px tolerance, because a box's edges are laid out on fractional pixels and two
 *  boxes that abut exactly can measure as overlapping by a rounding error. */
function overlaps(rows: Awaited<ReturnType<typeof lanes>>) {
  let pairs = 0;
  let bad = 0;
  for (const lane of rows) {
    const sorted = [...lane.clips].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      pairs += 1;
      if (sorted[i].x + sorted[i].width > sorted[i + 1].x + 0.5) bad += 1;
    }
  }
  return { pairs, bad };
}

test.describe("a clip is a drawing (D-091)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("no clip is drawn across the next clip's start, at fit zoom on a 400-clip drop", async ({
    page,
  }) => {
    // The review's own measurement, inverted into an invariant. On main this fixture draws
    // its clips ~12.8 px wide at a start-to-start spacing of ~7 px, and the overwhelming
    // majority of adjacent pairs are therefore on top of one another — 309 of 340 on the
    // owner's real card. Here the count must be exactly zero, and the pair count is asserted
    // too so that a fixture which stopped producing dense rows could not pass by producing
    // no pairs at all.
    await drop(page, dense(), DENSE_TOTAL);
    const { pairs, bad } = overlaps(await lanes(page));
    expect(pairs).toBeGreaterThan(400);
    expect(bad).toBe(0);
  });

  test("the click lands on the clip it was aimed at", async ({ page }) => {
    // The half of the overlap that is not a matter of taste: when the boxes lie on top of
    // one another, the topmost one takes the click, and the operator who aimed at the third
    // clip of a row is shown the second. Aim at the CENTRE of clip #3's own box — the only
    // point anyone could reasonably be said to have aimed at — and require the inspector to
    // name clip #3.
    await drop(page, dense(), DENSE_TOTAL);

    const wanted = "/nas/cam0/c0_002.mp4";
    const box = (await page.locator(`.clip[data-file="${wanted}"]`).boundingBox())!;
    // The box really is a sliver at this zoom — if it were not, the test would be proving
    // nothing about the case the review found.
    expect(box.width).toBeLessThan(CLIP_DRAWING_MIN_PX);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.locator(".inspector .preview__name")).toHaveText("c0_002.mp4");
  });

  test("under the threshold a clip is a two-pixel tick, and still its state's colour", async ({
    page,
  }) => {
    await drop(page, dense(), DENSE_TOTAL);
    const rows = await lanes(page);
    const clips = rows.flatMap((l) => l.clips);
    const ticks = clips.filter((c) => c.hairline);

    // At this density every clip is a tick — which is the honest answer for a 90-second clip
    // in a three-hour timeline seven pixels wide, and the reason the tick has to be VISIBLE
    // rather than merely narrow.
    expect(ticks.length).toBe(clips.length);
    for (const tick of ticks) {
      // Declared two pixels, laid out two pixels. That equality is the whole fix: it is
      // what the 12.8 px of `border-box` padding used to break, silently, in the sheet.
      expect(tick.declared).toBe(`${HAIRLINE_WIDTH_PX}px`);
      expect(tick.width).toBeCloseTo(HAIRLINE_WIDTH_PX, 1);
      // Nothing inside it: the chrome layer is where the padding lives, and the waveform
      // slot would be a canvas element per clip for two pixels of picture.
      expect(tick.chrome).toBe(false);
      expect(tick.slot).toBe(false);
      // The full state colour rather than its 10 % wash — two pixels of a wash is nothing.
      // These are pre-sync, unanalysed files, so the state is «waiting» and its ink is
      // `--text2`.
      expect(tick.ink).toBe("#8899bb");
      expect(tick.background).toBe("rgb(136, 153, 187)");
    }
  });

  test("over the threshold a clip is an outline, a wash and a waveform — never a fill", async ({
    page,
  }) => {
    // Three devices, three clips: every box is hundreds of pixels wide, which is the case
    // the anatomy is actually looked at in.
    await drop(page, card(TINY_DEVICES, 1), TINY_DEVICES);
    const rows = await lanes(page);
    const clips = rows.flatMap((l) => l.clips);
    expect(clips.length).toBe(TINY_DEVICES);

    for (const clip of clips) {
      expect(clip.width).toBeGreaterThan(CLIP_DRAWING_MIN_PX);
      expect(clip.hairline).toBe(false);
      // The wash, not the colour: a 10 %-alpha background is the whole difference between a
      // drawing and the saturated block v0.6.0-beta.3 shipped. An opaque `rgb(...)` here
      // would be the regression.
      expect(clip.background).toBe("rgb(23, 32, 53)");
      expect(clip.border).toBe("rgb(38, 56, 96)");
      expect(clip.ink).toBe("#8899bb");
      expect(clip.chrome).toBe(true);
      expect(clip.slot).toBe(true);
    }

    // …and the ink really is what the canvas draws in: `.clip__waveform` sets the canvas's
    // `color` from `--clip-ink`, and `drawWaveform` reads exactly that property. Asserted
    // through the computed value rather than the token, because that is the number the draw
    // loop sees.
    const inkOnCanvas = await page.evaluate(
      () => getComputedStyle(document.querySelector(".clip__waveform")!).color,
    );
    expect(inkOnCanvas).toBe("rgb(136, 153, 187)");
  });
});

test.describe("the lanes grow into the room (D-091)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  /** How much of the stage the rows actually cover, and how much is empty dark. */
  async function stage(page: Page) {
    return page.evaluate(() => {
      const el = document.querySelector(".timeline__scroll") as HTMLElement;
      const ruler = parseFloat(getComputedStyle(el).getPropertyValue("--tl-ruler-h"));
      const available = el.clientHeight - ruler;
      const lanes = Array.from(document.querySelectorAll(".track__lane"));
      const used = lanes.reduce((n, l) => n + l.getBoundingClientRect().height, 0);
      return { available, used, rows: lanes.length, dead: 1 - Math.min(1, used / available) };
    });
  }

  test("three devices in a whole window take the tallest lane the rule allows", async ({
    page,
  }) => {
    await drop(page, card(TINY_DEVICES, 1), TINY_DEVICES);
    const s = await stage(page);
    expect(s.rows).toBe(TINY_DEVICES);
    // The stage is far taller than 3 × 90, so the answer is the ceiling — and the ceiling is
    // where it is on purpose: a lane of 200 px would be a panel, not a row (see LANE_MAX_PX).
    expect(laneHeightFor(s.rows, s.available)).toBe(LANE_MAX_PX);
    for (const lane of await lanes(page)) expect(lane.height).toBe(LANE_MAX_PX);
    // 40 → 90 is what the review's "45–79 % dead" becomes on this drop. It does not reach
    // zero and cannot: three rows and a 90 px ceiling is 270 px however tall the window is,
    // and the remaining emptiness is a question about how much of the ROOM the timeline
    // frame should claim when it has three rows in it — which is the grid's question, not
    // the lane's. What is asserted is the direction and the size of the step.
    expect(s.used).toBe(TINY_DEVICES * LANE_MAX_PX);
    expect(s.used).toBeGreaterThan(2 * TINY_DEVICES * LANE_MIN_PX);
  });

  test("sixteen devices fall back to the floor, and fill the room doing it", async ({ page }) => {
    await drop(page, card(WEDDING_DEVICES, WEDDING_PER_DEVICE), WEDDING_TOTAL);
    const s = await stage(page);
    expect(s.rows).toBe(WEDDING_DEVICES);
    expect(laneHeightFor(s.rows, s.available)).toBe(LANE_MIN_PX);
    for (const lane of await lanes(page)) expect(lane.height).toBe(LANE_MIN_PX);
    // Sixteen rows at the floor is more than the stage has, so the stage is full: the dead
    // space the review measured is gone entirely on this drop and the tracks scroll instead.
    expect(s.dead).toBe(0);
  });

  test("the pitch never makes the rows taller than the room they were measured in", async ({
    page,
  }) => {
    // The one way a per-render pitch could go wrong that a unit test cannot see: lanes that
    // grew past the stage would summon the vertical scrollbar, which changes the box being
    // measured, which changes the pitch. Walk the row count through the whole band and
    // require the invariant at every step.
    for (const devices of [1, 3, 6, 8, 12, WEDDING_DEVICES]) {
      await drop(page, card(devices, 2), devices * 2);
      const s = await stage(page);
      const lane = laneHeightFor(s.rows, s.available);
      expect(s.rows).toBe(devices);
      if (lane > LANE_MIN_PX) expect(s.rows * lane).toBeLessThanOrEqual(s.available);
      for (const l of await lanes(page)) expect(l.height).toBe(lane);
    }
  });
});

test.describe("the hop still lands pixel-true at a grown lane height (D-091)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("clips land exactly one grown lane apart after the sync", async ({ page }) => {
    // D-083's hazard, in the form the per-render pitch creates: `Track` draws the lanes and
    // `clipBoxes` sums the pitch for the hop's y-arithmetic, and if the two ever disagreed
    // every clip below the first device would fly to a row it is not in — with no error
    // anywhere. The lanes here are 90 px, not the 40 the old constant stated, so a
    // `clipBoxes` still summing a constant would be wrong by 50 px per row and this
    // assertion would catch it.
    const scan = card(TINY_DEVICES, 1);
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Volumes/nas/wedding"],
        scan_inputs: scan,
        waveform_meta: { __e2e_reject: true },
        run_sync: controlled("run_sync"),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(page.locator(".clip")).toHaveCount(TINY_DEVICES);

    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await resolveControlled(page, "run_sync", solved(scan));
    await waitForResult(page);
    await expect(page.locator(".clip--travelling")).toHaveCount(0);

    const rows = await lanes(page);
    expect(rows).toHaveLength(TINY_DEVICES);
    for (const lane of rows) expect(lane.height).toBe(LANE_MAX_PX);

    // Every clip has come to rest inside its own lane — nothing left mid-flight, nothing
    // landed on a neighbouring row.
    const tops = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".track__lane")).map((lane) => {
        const laneRect = lane.getBoundingClientRect();
        const clip = lane.querySelector(".clip")!.getBoundingClientRect();
        return { dy: clip.y - laneRect.y, dh: laneRect.height - clip.height };
      }),
    );
    // `CLIP_INSET_PX` (3) inside the lane's own 1 px top hairline, at every pitch.
    for (const t of tops) {
      expect(t.dy).toBeCloseTo(4, 0);
      expect(t.dh).toBeCloseTo(7, 0);
    }
  });
});

/** An outcome that places every file of `scan` on its own device, the reference at zero. */
function solved(scan: Record<string, unknown>): Record<string, unknown> {
  const devices = scan.devices as { id: string; label: string; kind: string; files: string[] }[];
  const files = scan.files as { file: string; device: string; duration_seconds: number }[];
  const reference = files[0];
  const durations: Record<string, number> = {};
  for (const f of files) durations[f.file] = f.duration_seconds;
  return {
    result: {
      schema: 1,
      parameters: { analysis_rate: 12000, min_psr: 15 },
      reference: { file: reference.file, device: reference.device },
      devices,
      placements: files.map((f, i) => ({
        file: f.file,
        device: f.device,
        offset_seconds: i === 0 ? 0 : i * 12.5,
        confidence: 0.95,
        psr: i === 0 ? null : 38.4,
        drift_ppm: null,
        projected_end_error_ms: null,
        chain: [],
        warnings: [],
      })),
      unsynced: [],
      sequence: { fps: "25/1", duration_seconds: 90 + files.length * 12.5 },
      warnings: [],
    },
    durations,
  };
}
