import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  controlled,
  emit,
  fn,
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
const WAV = "/Users/e2e/shoot/ZOOM0001.WAV";

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

/** `#rrggbb` as the `rgb(r, g, b)` a computed style reports. */
function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
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

      // The timeline's own top edge is back where it was…
      const timelineAtResult = (await page.locator(".timeline").boundingBox())!;
      expect(timelineAtResult.y).toBeCloseTo(sources.stage.y + 8, 0);

      // …and so is its FRAME, to the pixel — which it was NOT in R1. There, the pre-sync
      // legend (D-067) sat above the frame and vanished with the sync, so the frame's top
      // edge stood a few pixels higher in the result phase than in the sources phase. That
      // was an honest deviation while the legend still lived in the stack, and R2b is the
      // stage that ends it: the legend, the meta sentence, the warnings and the zoom have
      // all left, and `.timeline` now contains one child. Nothing renders above
      // `.timeline__frame`, so the frame starts at the top of the stage in EVERY phase.
      const frameAtResult = (await page.locator(".timeline__frame").boundingBox())!;
      sameBox(frameAtResult, frameAtSources);

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
        const samples: { hop: boolean; band: boolean; travelling: number }[] = [];
        w.__E2E_BAND_SAMPLES__ = samples;
        const tick = () => {
          samples.push({
            hop: document.querySelector(".timeline[data-hop]") !== null,
            band: document.querySelector(".band") !== null,
            // V06 (D-090): how many clips are still in the air. `data-hop` covers the whole
            // sequence including the view's own fit afterwards; this is the number itself,
            // and it is the half the operator is actually watching.
            travelling: document.querySelectorAll(".clip--travelling").length,
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
            travelling: number;
          }[],
      );
      // The hop really happened (a fixture that never hopped would make the rest vacuous)…
      expect(samples.some((s) => s.hop)).toBe(true);
      // …and the band was there for every frame of it.
      expect(samples.filter((s) => s.hop && !s.band)).toEqual([]);
      // …and it did leave afterwards, rather than being held forever.
      expect(samples.some((s) => !s.hop && !s.band)).toBe(true);

      // D-090 lengthened the number from ~450 ms to ~1.05 s, so the hold had to grow with
      // it — and the constant it is sized from (`HOP_TOTAL_MS`) is now shared, precisely so
      // that it does. Stated over the clips themselves rather than over `data-hop`: not one
      // frame in which a clip was still travelling may be a frame in which the band had
      // already gone, or the room shifts 34 px under a clip that is still moving.
      expect(samples.some((s) => s.travelling > 0)).toBe(true);
      expect(samples.filter((s) => s.travelling > 0 && !s.band)).toEqual([]);
      // NOT asserted here: that the count comes down in STEPS. It is the right claim and it
      // is the wave, but this fixture is three clips, and three seeded delays can fall
      // inside one 16 ms frame — which would make the assertion a coin toss on a busy CI
      // box, and a spec that fails by luck is worse than no spec. The wave is asserted where
      // it is deterministic instead: `hop.spec.ts` reads the `--hop-delay` each clip is
      // actually carrying and requires them to differ.
    });

    test("the gutter is the device's home: two lines, and the zoom in the ruler's cell", async ({
      page,
    }) => {
      // V06-R2b (D-083). Two claims about the same column, both of them geometric because
      // both of them are the kind of thing that reads as correct in review and wrong in the
      // hand: the identity line and the count/length/dot line must BOTH be inside the
      // gutter's box (a second line that overflowed a 40 px lane would be clipped, not
      // wrapped, and the fact would simply be missing), and the zoom must be inside the
      // gutter COLUMN rather than merely near it.
      await reachSources(page, size);

      const gutter = page.getByRole("group", { name: en.trackAria("Camera A") }).locator(".track__gutter");
      const ident = gutter.locator(".track__ident");
      const meta = gutter.locator(".track__meta");
      await expect(ident.locator(".track__name")).toHaveText("Camera A");
      await expect(meta).toContainText(en.fileCount(1));

      const [gutterBox, identBox, metaBox] = await Promise.all([
        gutter.boundingBox(),
        ident.boundingBox(),
        meta.boundingBox(),
      ]);
      // Two lines, in order, both wholly inside the gutter — at 11/12 px type inside a
      // single-lane track, which is the tightest case there is.
      expect(metaBox!.y).toBeGreaterThanOrEqual(identBox!.y + identBox!.height - 1);
      expect(identBox!.y).toBeGreaterThanOrEqual(gutterBox!.y - 1);
      expect(metaBox!.y + metaBox!.height).toBeLessThanOrEqual(gutterBox!.y + gutterBox!.height + 1);

      // The zoom sits in the RULER row's gutter cell — the empty one, left of the ruler.
      const rulerGutter = (await page.locator(".track--ruler .track__gutter").boundingBox())!;
      for (const name of [en.zoomOut, en.zoomIn, en.zoomFitAria]) {
        const box = (await page.getByRole("button", { name }).boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(rulerGutter.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(rulerGutter.x + rulerGutter.width + 1);
        expect(box.y).toBeGreaterThanOrEqual(rulerGutter.y - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(rulerGutter.y + rulerGutter.height + 1);
      }
      // …and it still WORKS from there, which is the half a box check cannot see.
      const before = (await page.locator(`.clip[data-file="${CAM_A}"]`).boundingBox())!;
      await page.getByRole("button", { name: en.zoomIn }).click();
      const after = (await page.locator(`.clip[data-file="${CAM_A}"]`).boundingBox())!;
      expect(after.width).toBeGreaterThan(before.width);
    });

    test("the gutter's dot goes grey → blue → green as the row's own files land", async ({
      page,
    }) => {
      // The dot is the row's answer to "how far has this device got", and it is a claim
      // about EVERY file on the row at once (D-083). So the transition is driven one file at
      // a time: the drop has two devices of one file each, and the first `prewarm:file` may
      // turn exactly one dot blue.
      await reachSources(page, size, {
        prewarm_analysis: fn(`(args) => {
          window.__SUNDAYSYNC_PENDING__ = window.__SUNDAYSYNC_PENDING__ || {};
          return new Promise((resolve, reject) => {
            window.__SUNDAYSYNC_PENDING__["prewarm_analysis"] = { resolve, reject, args };
          });
        }`),
      });
      const dot = (device: string) =>
        page.getByRole("group", { name: en.trackAria(device) }).locator(".track__dot");
      await waitForPending(page, "prewarm_analysis");

      // Nothing analysed: both rows grey, and the dot says so in words too — the colour is
      // never the only carrier of the claim.
      await expect(dot("Camera A")).toHaveClass(/track__dot--pending/);
      await expect(dot("Zoom recorder")).toHaveClass(/track__dot--pending/);
      await expect(dot("Camera A")).toHaveAttribute("aria-label", en.trackAnalysing);

      // One file lands. Its device turns blue; the other does not.
      await emit(page, "prewarm:file", { file: CAM_A, ok: true });
      await expect(dot("Camera A")).toHaveClass(/track__dot--ready/);
      await expect(dot("Camera A")).toHaveAttribute("aria-label", en.trackAnalysed);
      await expect(dot("Zoom recorder")).toHaveClass(/track__dot--pending/);

      await emit(page, "prewarm:file", { file: WAV, ok: true });
      await expect(dot("Zoom recorder")).toHaveClass(/track__dot--ready/);

      // …and the sync's answer replaces the analysis's: green, on every row it placed.
      await page.getByRole("button", { name: en.syncButton }).click();
      await waitForPending(page, "run_sync");
      await resolveControlled(page, "run_sync", syncOutcome());
      await waitForResult(page);
      await expect(dot("Camera A")).toHaveClass(/track__dot--placed/);
      await expect(dot("Camera A")).toHaveAttribute("aria-label", en.trackPlaced);
    });

    test("a row the pass finished with and could not read stops saying it is working", async ({
      page,
    }) => {
      // V06-R3 sweep. D-083 folded `failed` into `pending` — right about the COLOUR (the
      // vocabulary is three colours and a fourth would make it four) and wrong about the
      // WORDS: the dot went on saying «Analyserer lyden» about a row whose pass had ended,
      // forever. That is the app waiting for something that already happened, on the one
      // element whose whole job is answering «hvor langt er denne enheten kommet?».
      //
      // Driven on the case that produces it: a whole card the analysis could not read.
      await reachSources(page, size, {
        prewarm_analysis: fn(`(args) => {
          window.__SUNDAYSYNC_PENDING__ = window.__SUNDAYSYNC_PENDING__ || {};
          return new Promise((resolve, reject) => {
            window.__SUNDAYSYNC_PENDING__["prewarm_analysis"] = { resolve, reject, args };
          });
        }`),
      });
      const dot = (device: string) =>
        page.getByRole("group", { name: en.trackAria(device) }).locator(".track__dot");
      await waitForPending(page, "prewarm_analysis");
      await expect(dot("Camera A")).toHaveAttribute("aria-label", en.trackAnalysing);

      await emit(page, "prewarm:file", { file: CAM_A, ok: false });
      await expect(dot("Camera A")).toHaveClass(/track__dot--failed/);
      await expect(dot("Camera A")).toHaveAttribute("aria-label", en.trackAnalysisFailed);
      // Grey, exactly as before: a different sentence, not a fourth colour.
      const grey = await page.evaluate(
        () => getComputedStyle(document.documentElement).getPropertyValue("--text4").trim(),
      );
      await expect(dot("Camera A")).toHaveCSS("background-color", hexToRgb(grey));

      // …and the OTHER row, which the pass has genuinely not reached, still says it is
      // working. «Ferdig, og det gikk ikke» and «ikke ferdig» are two different answers.
      await expect(dot("Zoom recorder")).toHaveAttribute("aria-label", en.trackAnalysing);
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

    test("«Kilder» stays openable in every phase, exported included", async ({ page }) => {
      // V06-G3 (D-092 ⑦). R3 left the strip's narrow-window behaviour deliberately undecided
      // — «a stated order of what it gives up first … is a design decision, not a number» —
      // and undecided meant flex resolved it by proportion. At 1024 in the exported phase the
      // row carries the wordmark, «Legg til», the cluster, the receipt, the project field,
      // «Vis i Finder», «Synk på nytt», «Eksporter» and the gear, and the summary line — which
      // is not a label but the CONTROL that opens the whole file list — was squeezed to
      // nothing. The one affordance on the strip that hides something behind it was the first
      // thing to disappear.
      //
      // The order is decided now, against the name field: the project input shrinks first (to
      // 90 px, with a placeholder and an `aria-label` so it is still identifiable), and the
      // summary keeps a floor that always shows «N filer». This asserts the promise, not the
      // numbers: in every phase the opener is visible, wide enough to hit, and opens.
      await reachSources(page, size, {
        scan_inputs: scanManifest({
          unsynced: [{ file: "/Users/e2e/shoot/broken.mp4", reason: "decode_error" }],
          skipped: [{ file: "/Users/e2e/shoot/IMG_0001.HEIC", reason: "still_image" }],
        }),
        "plugin:dialog|save": "/Users/e2e/out/x.fcpxml",
        export_timeline: 1,
      });

      const opener = page.locator(".strip__sources .popover--sources > summary");
      const panel = page.locator(".strip__sources .popover--sources .popover__panel");

      const openable = async (phase: string) => {
        await expect(opener, phase).toBeVisible();
        const box = (await opener.boundingBox())!;
        // Wide enough to be a target and to still be saying something. `en.fileCount(2)` is
        // «2 files»; a control narrower than that is a control that has stopped being one.
        expect(box.width, `${phase}: opener is ${box.width}px wide`).toBeGreaterThan(44);
        // …and the hit test in the middle of it reaches the summary itself, rather than
        // whatever has been drawn over it.
        const hits = await opener.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return at !== null && (el === at || el.contains(at));
        });
        expect(hits, `${phase}: something else is on top of the opener`).toBe(true);
        await opener.click();
        await expect(panel, phase).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(panel, phase).toBeHidden();
      };

      await openable("sources");

      await page.getByRole("button", { name: en.syncButton }).click();
      await waitForPending(page, "run_sync");
      await resolveControlled(page, "run_sync", syncOutcome());
      await waitForResult(page);
      await openable("result");

      await page.getByRole("button", { name: en.exportButton }).click();
      await expect(page.getByRole("button", { name: en.revealInFinder })).toBeVisible();
      await openable("exported");
    });

    test("every popover overlays the room — opening one moves nothing", async ({ page }) => {
      // V06-R2a (D-078). The sources panel used to take 40 % of the stage under the timeline;
      // what replaced it is four disclosures whose panels are LAYERS. That is the whole reason
      // they are layers: a list that took space when it opened would move the material the
      // operator is reading, in a room built to promise that nothing does.
      //
      // All four are opened in turn, at both window sizes, against one set of boxes — a
      // popover that pushed only at 1024×600 is exactly the failure this file exists for.
      await reachSources(page, size, {
        scan_inputs: scanManifest({
          unsynced: [{ file: "/Users/e2e/shoot/broken.mp4", reason: "decode_error" }],
          skipped: [{ file: "/Users/e2e/shoot/IMG_0001.HEIC", reason: "still_image" }],
        }),
      });
      // Something removed, so the slot's «Fjernet» chip exists to be opened.
      await page.locator(`.clip[data-file="${CAM_A}"]`).click();
      await expect(page.locator(".preview__name")).toHaveText("C0001.MP4");
      await page.locator(".inspector").getByLabel(`${en.removeFile}: C0001.MP4`).click();

      const before = await room(page);
      const frameBefore = (await page.locator(".timeline__frame").boundingBox())!;

      for (const selector of [
        ".popover--sources",
        ".popover--problems",
        ".slot__removed",
        ".slot__skipped",
      ]) {
        const popover = page.locator(selector);
        await popover.locator("> summary").click();
        await expect(popover.locator(".popover__panel")).toBeVisible();

        const after = await room(page);
        sameBox(after.strip, before.strip);
        sameBox(after.slot, before.slot);
        sameBox(after.inspector, before.inspector);
        sameBox(after.stage, before.stage);
        sameBox(after.gutter, before.gutter);
        sameBox((await page.locator(".timeline__frame").boundingBox())!, frameBefore);

        await page.keyboard.press("Escape");
        await expect(popover.locator(".popover__panel")).toBeHidden();
      }
    });

    test("only one popover is ever open — including when they are opened by keyboard", async ({
      page,
    }) => {
      // V06-R3 sweep. The pointer case was covered by construction: pressing a second summary
      // is a press OUTSIDE the first, and `usePopoverDismiss` closes on that. The keyboard
      // case was not — and the four summaries are tab stops precisely so they can be used
      // that way (D-078's whole argument for `<details>`). Tab, Enter, Tab, Enter left two
      // panels open at once, overlapping each other on top of the room they float over.
      await reachSources(page, size, {
        scan_inputs: scanManifest({
          unsynced: [{ file: "/Users/e2e/shoot/broken.mp4", reason: "decode_error" }],
        }),
      });
      const sources = page.locator(".popover--sources");
      const problems = page.locator(".popover--problems");
      // `locator.press` rather than `focus()` + `keyboard.press`: it focuses and presses as
      // one actionability-checked step, so a re-render landing between the two cannot send the
      // Enter to `document.body` and leave the disclosure closed. `open` is read as the DOM
      // PROPERTY, which is what `<details>` actually toggles.
      await sources.locator("> summary").press("Enter");
      await expect(sources).toHaveJSProperty("open", true);

      await problems.locator("> summary").press("Enter");
      await expect(problems).toHaveJSProperty("open", true);
      await expect(sources).toHaveJSProperty("open", false);

      // …and the same holds the other way round, and by pointer.
      await sources.locator("> summary").click();
      await expect(sources).toHaveJSProperty("open", true);
      await expect(problems).toHaveJSProperty("open", false);
    });

    test("nothing in the strip or the slot is ever drawn on top of anything else", async ({
      page,
    }) => {
      // V06-R3 pixel pass. Both rows are one line of flex with more to carry at 1024 than
      // they have room for, and both had items that could not shrink inside containers that
      // could: the strip's two chips were drawn under the project-name field, and the slot's
      // «1 stillbilde ble hoppet over» covered the first four words of the stale notice.
      // Every claim here still has its whole self on a `title`; what it must not do is be
      // painted over.
      //
      // Measured in the state that produces the most content at once: a result with problems
      // AND warnings AND a skipped file AND an export behind it AND stale sources.
      await reachSources(page, size, {
        scan_inputs: scanManifest({
          unsynced: [{ file: "/Users/e2e/shoot/broken.mp4", reason: "decode_error" }],
          skipped: [{ file: "/Users/e2e/shoot/IMG_0001.HEIC", reason: "still_image" }],
        }),
        "plugin:dialog|save": "/Users/e2e/out/x.fcpxml",
        export_timeline: 1,
      });
      await page.getByRole("button", { name: en.syncButton }).click();
      await waitForPending(page, "run_sync");
      await resolveControlled(
        page,
        "run_sync",
        syncOutcome({
          result: {
            ...(syncOutcome().result as Record<string, unknown>),
            warnings: [{ code: "mixed_fps" }],
          },
        }),
      );
      await waitForResult(page);
      await page.getByRole("button", { name: en.exportButton }).click();
      await expect(page.getByRole("button", { name: en.revealInFinder })).toBeVisible();
      // The export's answer is a line ON this row now (D-092 ⑤) rather than a toast to
      // dismiss — which makes the strip one item busier here than it was, and is exactly why
      // this measurement is worth having.
      await expect(page.locator(".strip__receipt")).toBeVisible();
      // …and make the result stale, which is what puts a fourth thing in the slot.
      await page.locator(`.clip[data-file="${CAM_A}"]`).click();
      await page.locator(".inspector__actions select").selectOption("rec");
      await expect(page.locator(".slot__stale")).toBeVisible();

      for (const row of [".app__header", ".slot"]) {
        const boxes = await page.locator(`${row} > *`).evaluateAll((els) =>
          els
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { cls: el.className || el.tagName, left: r.left, right: r.right };
            })
            // A zero-width portal target that has nothing in it is not an item on the row.
            .filter((b) => b.right - b.left > 0.5),
        );
        for (let i = 1; i < boxes.length; i++) {
          expect(
            boxes[i].left,
            `${row}: ${boxes[i].cls} starts inside ${boxes[i - 1].cls}`,
          ).toBeGreaterThanOrEqual(boxes[i - 1].right - 0.5);
        }
        // …and the row itself does not overflow the window.
        const own = (await page.locator(row).boundingBox())!;
        if (boxes.length > 0) {
          expect(boxes[boxes.length - 1].right).toBeLessThanOrEqual(own.x + own.width + 0.5);
        }
      }

      // The cluster inside the strip is the same claim one level down: its own children were
      // the ones that overflowed it.
      const cluster = await page.locator(".strip__sources > *").evaluateAll((els) =>
        els
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { cls: el.className || el.tagName, left: r.left, right: r.right };
          })
          .filter((b) => b.right - b.left > 0.5),
      );
      for (let i = 1; i < cluster.length; i++) {
        expect(
          cluster[i].left,
          `strip__sources: ${cluster[i].cls} starts inside ${cluster[i - 1].cls}`,
        ).toBeGreaterThanOrEqual(cluster[i - 1].right - 0.5);
      }
      // …and the cluster's last child does not reach the next thing on the strip. Deliberately
      // NOT "inside the cluster's own box": at 1024 the cluster is genuinely handed less than
      // its own children's minimum widths (a `<summary>` cannot draw itself narrower than
      // `.chip`'s padding), so it overflows its box by a few pixels, and how many depends on
      // the platform's font metrics. What must be true either way is that the overflow lands
      // in the 12 px gap and touches nothing — which is the rule, where containment was a
      // proxy for it.
      const nextAfterCluster = await page.evaluate(() => {
        const cl = document.querySelector(".strip__sources") as HTMLElement;
        const sib = cl.nextElementSibling;
        return sib ? sib.getBoundingClientRect().left : null;
      });
      if (cluster.length > 0 && nextAfterCluster !== null) {
        expect(cluster[cluster.length - 1].right).toBeLessThanOrEqual(nextAfterCluster + 0.5);
      }
    });

    test("the result's warnings are a chip on the strip, not banners over the timeline", async ({
      page,
    }) => {
      // V06-R2b (D-083). `result.warnings` used to be one `<p class="banner banner--warn">`
      // per warning, stacked between the strip and the frame — the exact shape D-082 took out
      // of the room everywhere else, still in it here because nothing had moved the timeline's
      // own header yet. A two-warning run therefore pushed the frame down by two lines in the
      // same instant the clips hopped.
      await reachSources(page, size);
      const frameBefore = (await page.locator(".timeline__frame").boundingBox())!;
      const before = await room(page);

      await page.getByRole("button", { name: en.syncButton }).click();
      await waitForPending(page, "run_sync");
      const base = syncOutcome();
      await resolveControlled(page, "run_sync", {
        ...base,
        result: {
          ...(base.result as Record<string, unknown>),
          warnings: [{ code: "mixed_fps" }, { code: "drift", projected_end_error_ms: 120 }],
        },
      });
      await waitForResult(page);
      await expect(page.locator(".band")).toHaveCount(0);

      // The count is on the strip, beside the problem chip — one place for "is anything
      // wrong?" — and nothing is above the frame.
      const chip = page.locator(".popover--warnings");
      await expect(chip.locator("> summary")).toHaveText(en.warningsCount(2));
      await expect(page.locator(".banner--warn")).toHaveCount(0);
      sameBox((await page.locator(".timeline__frame").boundingBox())!, frameBefore);

      // …and the sentences themselves are one click away, on a layer, moving nothing.
      await chip.locator("> summary").click();
      await expect(chip.locator(".popover__panel")).toContainText(en.mixedFps);
      await expect(chip.locator(".popover__panel")).toContainText(en.drift(120));
      const after = await room(page);
      sameBox(after.strip, before.strip);
      sameBox(after.slot, before.slot);
      sameBox(after.stage, before.stage);
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
