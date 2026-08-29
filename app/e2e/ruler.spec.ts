import { test, expect, type Page } from "@playwright/test";
import { boot, BOOT_FIXTURES, SETTLED_SETTINGS } from "./harness";
import { en } from "../src/i18n";

/**
 * The ruler at the zoom a whole shoot is looked at (V06-G3, D-092 ④/⑧).
 *
 * Two claims, one row.
 *
 * **④ The labels must not collide.** `tickIntervalMs` climbed a ladder that stopped at one
 * hour, and asked one flat question of every rung of it: is the step at least 80 px? On the
 * owner's own material — «Tilpass» over an 18-hour wedding day in a 736 px lane — one hour is
 * 41 px, no rung answered yes, and the function fell off the end of its list and returned the
 * hour anyway. Sixteen of the eighteen labels were then drawn on top of the one before them:
 * a ruler that is a smear rather than a scale, at exactly the zoom where knowing the time is
 * the reason to be looking. The step has to coarsen past an hour, and the question has to be
 * about the LABEL — `step_px ≥ label_width + 16` — because that is what actually collides.
 *
 * **⑧ Before a sync, the times are wall-clock.** The pre-sync layout positions clips by their
 * own recording timestamps, so t=0 IS a moment on a Tuesday and the ruler can say which one.
 * «14:30» is a thing the operator recognises about the day they filmed; «4:30:00» counted from
 * an origin the app chose is a number they have to do arithmetic on. After a sync the origin is
 * the engine's, not a clock, and the ruler goes back to elapsed time.
 *
 * The fixtures are local to this file on purpose: an 18-hour drop is this spec's business and
 * nothing else's.
 */

/** The wedding day, in miniature: a hairdresser at 08:00 and the last dance at 01:00. */
const DAY_START_ISO = "2026-08-15T06:00:00.000Z"; // 08:00 Europe/Oslo
const DAY_SPAN_HOURS = 18;

function longDayManifest(): Record<string, unknown> {
  const startMs = Date.parse(DAY_START_ISO);
  const files = [
    {
      file: "/Users/e2e/day/CamA/C0001.MP4",
      device: "cam-a",
      duration_seconds: 3600,
      format_name: "mov,mp4",
      audio: { codec: "aac", sample_rate: 48000, channels: 2 },
      video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
      creation_time: new Date(startMs).toISOString(),
    },
    {
      file: "/Users/e2e/day/CamB/C0002.MP4",
      device: "cam-b",
      duration_seconds: 3600,
      format_name: "mov,mp4",
      audio: { codec: "aac", sample_rate: 48000, channels: 2 },
      video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
      // The last hour of the span, so the drop is exactly DAY_SPAN_HOURS long.
      creation_time: new Date(startMs + (DAY_SPAN_HOURS - 1) * 3_600_000).toISOString(),
    },
  ];
  return {
    schema: 1,
    devices: [
      { id: "cam-a", label: "Camera A", kind: "video", files: [files[0].file] },
      { id: "cam-b", label: "Camera B", kind: "video", files: [files[1].file] },
    ],
    files,
    unsynced: [],
  };
}

async function reachLongDay(page: Page, extra: Record<string, unknown> = {}) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/day"],
      scan_inputs: longDayManifest(),
      ...extra,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(page.locator(".timeline__ruler")).toBeVisible();
  // «Tilpass» is the gesture that puts the whole day on screen — and the gesture the operator
  // reaches for first on a drop they have not seen yet.
  await page.getByRole("button", { name: en.zoomFitAria }).click();
}

/** Every drawn tick label's box, left to right. A tick with no text is a line, not a label. */
async function labelBoxes(page: Page) {
  return page.locator(".timeline__tick").evaluateAll((els) =>
    els
      .filter((el) => (el.textContent ?? "").trim().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { text: (el.textContent ?? "").trim(), left: r.left, right: r.right };
      })
      .sort((a, b) => a.left - b.left),
  );
}

test.describe("the ruler reads at any zoom", () => {
  test("no two labels overlap across a full shoot day", async ({ page }) => {
    await reachLongDay(page);

    const boxes = await labelBoxes(page);
    // Enough of them that this is a scale and not a lone number.
    expect(boxes.length).toBeGreaterThan(3);

    const collisions = boxes
      .map((b, i) => (i > 0 && b.left < boxes[i - 1].right ? `${boxes[i - 1].text} / ${b.text}` : null))
      .filter((c): c is string => c !== null);
    expect(collisions, `overlapping labels: ${collisions.join(", ")}`).toEqual([]);
  });

  test("no two labels overlap at any zoom step out from the fit", async ({ page }) => {
    // The ladder has to hold at every rung, not just at the one «Tilpass» happens to land on.
    await reachLongDay(page);
    for (let step = 0; step < 8; step++) {
      const boxes = await labelBoxes(page);
      const collisions = boxes
        .map((b, i) =>
          i > 0 && b.left < boxes[i - 1].right ? `${boxes[i - 1].text} / ${b.text}` : null,
        )
        .filter((c): c is string => c !== null);
      expect(collisions, `step ${step}: overlapping labels ${collisions.join(", ")}`).toEqual([]);
      await page.getByRole("button", { name: en.zoomIn }).click();
    }
  });

  test("before a sync the ruler is the day's own clock", async ({ page }) => {
    // D-092 ⑧. The drop starts at 08:00 local (`DAY_START_ISO`, Europe/Oslo per the
    // Playwright config), so the ruler's labels are wall times inside that day — not an
    // elapsed count from a zero the app picked.
    await reachLongDay(page);

    const boxes = await labelBoxes(page);
    for (const b of boxes) {
      expect(b.text, `tick label ${b.text}`).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
    // …and one of them is the hour the day starts at, give or take the tick spacing.
    expect(boxes.map((b) => b.text).join(" ")).toMatch(/\b(08|09|10):00\b/);
  });
});
