import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  controlled,
  resolveControlled,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForPending,
  waitForResult,
} from "./harness";
import { en } from "../src/i18n";

/**
 * «Ett rom» — the stability contract of the V06-R1 shell (D-074/D-076/D-081/D-082).
 *
 * Every other spec in this suite asserts what the app SAYS. This one asserts what it does
 * not do: move. The whole v0.6 redesign rests on one promise the owner made in one sentence
 * — the app is a fixed room, and the five phases are five things happening inside it rather
 * than five pages — and that promise is only worth anything if it is measured, because the
 * failure mode is invisible in a screenshot and obvious in the hand. A strip that is 44 px in
 * four phases and 46 px in the fifth reads as correct in review and as a flinch in use.
 *
 * So the assertions here are boxes, in pixels, at two window sizes: the design's own
 * 1280×800 and the smallest window `tauri.conf.json` allows (1024×600). Two sizes because a
 * fixed-pixel layout that is only ever measured at its design size proves nothing about the
 * grid — it proves the numbers were typed in twice.
 *
 * What is measured, and why each one:
 *
 *   - **the strip, the slot, the inspector column** — the three edges of the room. If any of
 *     them is a function of what is inside it, everything else here is luck.
 *   - **the first `.track__gutter`** — the origin every clip on the timeline is drawn from.
 *     `Clip.tsx` positions in lane-column pixels, so the gutter's right edge IS x=0 for the
 *     entire timeline. A gutter that moved between phases would move every clip with it, and
 *     the hop's arithmetic (`timeline/hop.ts`) measures nothing and would be measuring from
 *     somewhere the clips no longer are.
 *   - **the band's 34 px** — the one drawn exception (D-082), asserted as an exact number in
 *     one direction only. An "exception" that turned out to be 33 or 36 px would mean the
 *     band is content-sized after all, which is the thing the shell exists to refuse.
 */

const CAM_A = "/Users/e2e/shoot/CamA/C0001.MP4";

/** The two window sizes the shell must be identical in: the design's, and the smallest the
 *  desktop window may be dragged to (`tauri.conf.json`'s `minWidth`/`minHeight`). */
const SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 600 },
];

/** Everything the room's own edges are, in one read. */
async function room(page: Page) {
  const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
  return {
    strip: await box(".app__header"),
    slot: await box(".slot"),
    inspector: await box(".inspector"),
    stage: await box(".stage"),
    gutter: await box(".track__gutter"),
  };
}

/** Same box, to the pixel. `toBeCloseTo(…, 0)` throughout: a browser can lay a border out at
 *  a fractional device pixel, and this is a spec about layout, not about subpixel rounding. */
function sameBox(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number },
) {
  expect(actual.x).toBeCloseTo(expected.x, 0);
  expect(actual.y).toBeCloseTo(expected.y, 0);
  expect(actual.width).toBeCloseTo(expected.width, 0);
  expect(actual.height).toBeCloseTo(expected.height, 0);
}

/** Drop a folder and land in the sources phase, with the sync held open by the spec. */
async function reachSources(
  page: Page,
  size: { width: number; height: number },
  extra: Record<string, unknown> = {},
) {
  await page.setViewportSize(size);
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: scanManifest(),
      run_sync: controlled("run_sync"),
      ...extra,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeVisible();
}

for (const size of SIZES) {
  test.describe(`the room at ${size.width}×${size.height}`, () => {
    test("the strip, the slot and the inspector column are the shell, not the content", async ({
      page,
    }) => {
      await reachSources(page, size);
      const { strip, slot, inspector } = await room(page);

      // Row one: 44 px, full width, at the top.
      expect(strip.height).toBeCloseTo(44, 0);
      expect(strip.y).toBeCloseTo(0, 0);
      expect(strip.width).toBeCloseTo(size.width, 0);

      // Row four: 38 px, hard against the bottom of the window. This is the assertion that
      // the room is the WINDOW and not merely a tall box — a document that had grown would
      // put the slot below the fold and nothing else here would notice.
      expect(slot.height).toBeCloseTo(38, 0);
      expect(slot.y + slot.height).toBeCloseTo(size.height, 0);

      // The right column: 300 px, spanning rows two through four — i.e. from the bottom of
      // the strip to the bottom of the window, whether or not the band is there.
      expect(inspector.width).toBeCloseTo(300, 0);
      expect(inspector.x + inspector.width).toBeCloseTo(size.width, 0);
      expect(inspector.y).toBeCloseTo(strip.height, 0);
      expect(inspector.height).toBeCloseTo(size.height - strip.height, 0);

      // …and the document itself does not scroll. Everything that scrolls in this app says so
      // for itself; the room does not.
      const overflowed = await page.evaluate(
        () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
      );
      expect(overflowed).toBe(false);
    });

    test("nothing in the room moves across sources → syncing → result", async ({ page }) => {
      await reachSources(page, size);
      const sources = await room(page);
      const frameAtSources = (await page.locator(".timeline__frame").boundingBox())!;

      // ---- syncing: the band, and ONLY the band -------------------------------------
      await page.getByRole("button", { name: en.syncButton }).click();
      await waitForPending(page, "run_sync");
      await expect(page.locator(".band")).toBeVisible();

      const syncing = await room(page);
      sameBox(syncing.strip, sources.strip);
      sameBox(syncing.slot, sources.slot);
      sameBox(syncing.inspector, sources.inspector);
      // The gutter is the timeline's x-origin: it may go DOWN with the band, never sideways.
      expect(syncing.gutter.x).toBeCloseTo(sources.gutter.x, 0);
      expect(syncing.gutter.width).toBeCloseTo(sources.gutter.width, 0);

      // The one drawn exception, as an exact number in one direction.
      expect((await page.locator(".band").boundingBox())!.height).toBeCloseTo(34, 0);
      expect(syncing.stage.y).toBeCloseTo(sources.stage.y + 34, 0);
      expect(syncing.stage.height).toBeCloseTo(sources.stage.height - 34, 0);
      const frameWhileSyncing = (await page.locator(".timeline__frame").boundingBox())!;
      expect(frameWhileSyncing.y).toBeCloseTo(frameAtSources.y + 34, 0);

      // ---- result: the band goes only once the clips have stopped moving --------------
      await resolveControlled(page, "run_sync", syncOutcome());
      await waitForResult(page);
      // D-082's hold: the band survives the hop and leaves with it, so the room does not jump
      // 34 px in the same frame the clips travel. By the time `data-hop` has cleared, both are
      // over — asserted as an absence, which is auto-retrying and therefore not a race.
      await expect(page.locator(".band")).toHaveCount(0);

      const result = await room(page);
      sameBox(result.strip, sources.strip);
      sameBox(result.slot, sources.slot);
      sameBox(result.inspector, sources.inspector);
      sameBox(result.stage, sources.stage);
      expect(result.gutter.x).toBeCloseTo(sources.gutter.x, 0);
      expect(result.gutter.width).toBeCloseTo(sources.gutter.width, 0);

      // The timeline's own top edge is back where it was. Its FRAME is a few pixels higher
      // than it was in the sources phase, and honestly so: the pre-sync legend (D-067) is a
      // line about provisional positions and there are no provisional positions any more, so
      // it is gone. That line still sits above the frame in R1 — relocating it out of the
      // stack is R2b's job — and it is content, not shell: the room did not move, the
      // sentence inside it did.
      const timelineAtResult = (await page.locator(".timeline").boundingBox())!;
      expect(timelineAtResult.y).toBeCloseTo(sources.stage.y + 8, 0);

      // Nothing has been pushed under the slot at either window size.
      const scroll = (await page.locator(".timeline__scroll").boundingBox())!;
      expect(scroll.y + scroll.height).toBeLessThanOrEqual(result.slot.y + 1);
    });

    test("the band is held through the hop, so the room and the clips never move at once", async ({
      page,
    }) => {
      // D-082, sampled per frame rather than asserted at one instant.
      //
      // `syncing` → `result` removes the band and starts the clips hopping in the SAME
      // commit. Two movements at once, and one of them is the moment the whole app is built
      // around: the clips travelling from where the cameras' clocks claimed they were to
      // where the audio says they actually were. A timeline that ALSO jumped 34 px upwards in
      // that frame would make the hop unreadable — the eye cannot tell a clip that moved from
      // a clip the room moved under.
      //
      // The property is "at no point while the hop is running is the band gone", which is a
      // statement about every frame in a ~750 ms window, so it is checked on every frame. A
      // one-shot assertion would pass by luck on a fast machine and fail by luck on a slow
      // one.
      await reachSources(page, size);
      await page.getByRole("button", { name: en.syncButton }).click();
      await waitForPending(page, "run_sync");

      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const samples: { hop: boolean; band: boolean }[] = [];
        w.__E2E_BAND_SAMPLES__ = samples;
        const tick = () => {
          samples.push({
            hop: document.querySelector(".timeline[data-hop]") !== null,
            band: document.querySelector(".band") !== null,
          });
          if (samples.length < 400) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      await resolveControlled(page, "run_sync", syncOutcome());
      await waitForResult(page);
      await expect(page.locator(".band")).toHaveCount(0);

      const samples = await page.evaluate(
        () =>
          (window as unknown as Record<string, unknown>).__E2E_BAND_SAMPLES__ as {
            hop: boolean;
            band: boolean;
          }[],
      );
      // The hop really happened (a fixture that never hopped would make the rest vacuous)…
      expect(samples.some((s) => s.hop)).toBe(true);
      // …and the band was there for every frame of it.
      expect(samples.filter((s) => s.hop && !s.band)).toEqual([]);
      // …and it did leave afterwards, rather than being held forever.
      expect(samples.some((s) => !s.hop && !s.band)).toBe(true);
    });

    test("marking a clip fills the inspector and moves nothing", async ({ page }) => {
      await reachSources(page, size);
      const before = await room(page);
      const frameBefore = (await page.locator(".timeline__frame").boundingBox())!;
      await expect(page.getByText(en.previewEmpty)).toBeVisible();

      await page.locator(`.clip[data-file="${CAM_A}"]`).click();
      await expect(page.locator(".preview__name")).toHaveText("C0001.MP4");

      const after = await room(page);
      sameBox(after.strip, before.strip);
      sameBox(after.slot, before.slot);
      sameBox(after.inspector, before.inspector);
      sameBox(after.stage, before.stage);
      sameBox(after.gutter, before.gutter);
      sameBox((await page.locator(".timeline__frame").boundingBox())!, frameBefore);
    });

    test("an error banner floats over the stage instead of pushing it", async ({ page }) => {
      // Banners used to be a row between the header and everything else, so an export that
      // failed — or an update notice arriving on its own — shoved the timeline down by the
      // height of a sentence, mid-run, under the operator's hand. They are a layer now
      // (D-082). The banner still has to be readable and dismissable; what it may not do is
      // take space from anything.
      await reachSources(page, size, {
        "plugin:dialog|save": "/Users/e2e/out/timeline.fcpxml",
        export_timeline: {
          __sundaysync_fn__: `() => { throw "engine exploded"; }`,
        },
      });
      await page.getByRole("button", { name: en.syncButton }).click();
      await waitForPending(page, "run_sync");
      await resolveControlled(page, "run_sync", syncOutcome());
      await waitForResult(page);
      await expect(page.locator(".band")).toHaveCount(0);

      const before = await room(page);
      const frameBefore = (await page.locator(".timeline__frame").boundingBox())!;

      await page.getByRole("button", { name: en.exportButton }).click();
      const banner = page.locator(".banner--error");
      await expect(banner).toBeVisible();

      const after = await room(page);
      sameBox(after.strip, before.strip);
      sameBox(after.slot, before.slot);
      sameBox(after.inspector, before.inspector);
      sameBox(after.stage, before.stage);
      sameBox(after.gutter, before.gutter);
      sameBox((await page.locator(".timeline__frame").boundingBox())!, frameBefore);

      // …and it is genuinely on top of the stage, not squeezed in beside it.
      const box = (await banner.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(before.stage.y);
      expect(box.x + box.width).toBeLessThanOrEqual(before.stage.x + before.stage.width + 1);
    });
  });
}
