import { test, expect, type Page } from "@playwright/test";
import { boot, BOOT_FIXTURES, fn, SETTLED_SETTINGS, waitForResult } from "./harness";
import { en } from "../src/i18n";
import { visibleClips } from "../src/timeline/geometry";
import { stackClips, type ClipSpan } from "../src/timeline/laneLayout";
import { META_CONCURRENCY } from "../src/timeline/waveformStore";

// V03-S7 QA — the scale/virtualization proof.
//
// `timeline.spec.ts` proves the timeline's JOURNEYS on a two-device, one-clip fixture.
// This file proves it does not fall over at the size a real multi-camera service
// actually is: several devices, dozens of clips, hours of material — and that the DOM
// stays small regardless, because `Track.tsx` only ever mounts what `visibleClips`
// (`src/timeline/geometry.ts`) says is in the window (plus its overscan buffer), not
// one node per placement.
//
// The proof does not re-implement that virtualization math from scratch: it IMPORTS the
// same pure `visibleClips`/`stackClips` the app renders with, feeds it the same fixture
// data the browser was booted with, and compares the result to what actually landed in
// the DOM. That is a check of the WIRING (does `TimelineView`/`Track` actually call this
// the way the geometry module expects), not a second copy of the geometry to keep in
// sync by hand.

// ---- Scenario: 6 devices, 302 placements, an exact 3-hour span -------------------------
//
// `visibleClips`'s overscan buffer (`geometry.ts`) is INDEX-based, not time-based: it
// keeps `buffer` array positions either side of the window, not `buffer` seconds. That
// makes the proof's fixture density matter — the same reasoning `Track.tsx`'s own
// comment gives for why virtualization exists at all ("a hundreds-of-clips result"). A
// handful of clips widely spaced across 3 hours (an early draft of this fixture used 10
// per device) makes 5 index positions of buffer cover MOST of the row's time span,
// mounting nearly everything regardless of zoom — technically correct, but not the
// "far below total" case worth proving. Sixty short clips per device, close together, is
// what an actual busy multi-camera service's device row looks like, and it is where the
// buffer is actually small relative to the row.
const SPAN_SEC = 3 * 3600; // 10 800 s
const CLIP_DUR_SEC = 90; // 1.5 min
const CLIPS_PER_DEVICE = 60;
// Evenly spaced so the LAST clip's end lands exactly on SPAN_SEC — real coverage of the
// whole session, not a cluster the virtualization proof could cheat by being lucky about.
const SPACING_SEC = (SPAN_SEC - CLIP_DUR_SEC) / (CLIPS_PER_DEVICE - 1);

const BUSY_DEVICE_IDS = ["dev0", "dev1", "dev2", "dev3", "dev4"];
const EMPTY_DEVICE_ID = "dev5";
/** dev0's very first clip — offset 0, so it anchors the timeline's origin at ms 0
 *  (`contentBounds`'s `originMs = min(0, earliest)`). Used only to reason about the
 *  origin; the zoom/pan calibration reference is `CALIBRATION_FILE` below. */
const ORIGIN_FILE = "/nas/dev0/c0_0.mp4";
/**
 * dev0's MIDDLE clip — near the centre of the 3-hour span. The deep-zoom tests anchor on
 * this clip rather than `ORIGIN_FILE`: every device's clip 0 starts at the same instant
 * (t=0), so `visibleClips`'s lowerBound-based buffer resolves to index 0 for EVERY row
 * whenever the visible window sits near the very start of the timeline — pulling in a
 * handful of "buffer" clips from every device regardless of how narrow the window is.
 * Anchoring mid-timeline instead means only devices with something genuinely nearby get
 * pulled in.
 */
const CALIBRATION_INDEX = Math.floor(CLIPS_PER_DEVICE / 2);
const CALIBRATION_FILE = `/nas/dev0/c0_${CALIBRATION_INDEX}.mp4`;
const CALIBRATION_START_SEC = CALIBRATION_INDEX * SPACING_SEC;

/**
 * The wall-clock the shoot's cards claim to have started at.
 *
 * Since V04-U3 (D-061) the timeline is mounted BEFORE a sync, laying the same files out by
 * their container `creation_time`. A card dump whose files all reported `null` there would
 * pile all 302 clips on top of each other at t=0 in the sources phase — technically what
 * the app should do with no timestamps, but not what a real camera card looks like, and
 * not the scale case this file is about. Giving each file the timestamp its own offset
 * implies makes the pre-sync layout realistic (and, incidentally, close to the solved one)
 * so this stays a proof about virtualization rather than about the degenerate pile.
 */
const SHOOT_START_MS = Date.parse("2026-08-09T09:00:00.000Z");
const startedAt = (offsetSeconds: number): string =>
  new Date(SHOOT_START_MS + offsetSeconds * 1000).toISOString();

interface Placement {
  file: string;
  device: string;
  offset_seconds: number;
  confidence: number;
  psr: number;
  drift_ppm: number | null;
  projected_end_error_ms: number | null;
  chain: string[];
  warnings: unknown[];
}

function buildScenario() {
  const devices: Record<string, unknown>[] = [];
  const placements: Placement[] = [];
  const durations: Record<string, number> = {};
  const scanFiles: Record<string, unknown>[] = [];

  BUSY_DEVICE_IDS.forEach((id, d) => {
    const kind = d % 2 === 0 ? "video" : "audio";
    const files: string[] = [];
    for (let c = 0; c < CLIPS_PER_DEVICE; c += 1) {
      const ext = kind === "video" ? "mp4" : "wav";
      const file = `/nas/${id}/c${d}_${c}.${ext}`;
      const offset = c * SPACING_SEC;
      files.push(file);
      // Every 4th placement carries a credible drift measurement — a mix, not a special
      // case the timeline only has to survive once.
      const drifted = (d * CLIPS_PER_DEVICE + c) % 4 === 0;
      placements.push({
        file,
        device: id,
        offset_seconds: offset,
        confidence: 0.9,
        psr: 30 + (c % 5),
        drift_ppm: drifted ? 120 : null,
        projected_end_error_ms: drifted ? 180 : null,
        chain: [],
        warnings: [],
      });
      durations[file] = CLIP_DUR_SEC;
      scanFiles.push({
        file,
        device: id,
        duration_seconds: CLIP_DUR_SEC,
        format_name: kind === "video" ? "mov,mp4" : "wav",
        audio: { codec: kind === "video" ? "aac" : "pcm_s16le", sample_rate: 48000, channels: 2 },
        video: kind === "video" ? { codec: "h264", width: 1920, height: 1080, fps: "25/1" } : null,
        creation_time: startedAt(offset),
      });
    }
    devices.push({ id, label: `Device ${d}`, kind, files });
  });

  // A second sub-track on two devices — the multitrack-board exemption (D-050), which is
  // what forces `stackClips` to actually produce more than one row per device.
  for (const d of [0, 1]) {
    const id = `dev${d}`;
    const offset = 2 * SPACING_SEC + CLIP_DUR_SEC / 2;
    const file = `/nas/${id}/overlap${d}.mp4`;
    placements.push({
      file,
      device: id,
      offset_seconds: offset,
      confidence: 0.85,
      psr: 26,
      drift_ppm: null,
      projected_end_error_ms: null,
      chain: [],
      warnings: [],
    });
    durations[file] = CLIP_DUR_SEC;
    scanFiles.push({
      file,
      device: id,
      duration_seconds: CLIP_DUR_SEC,
      format_name: "mov,mp4",
      audio: { codec: "aac", sample_rate: 48000, channels: 2 },
      video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
      creation_time: startedAt(offset),
    });
    (devices[d].files as string[]).push(file);
  }

  devices.push({ id: EMPTY_DEVICE_ID, label: "Device 5", kind: "audio", files: [] });

  const unsynced = [
    { file: "/nas/dev2/bad-take.wav", reason: "low_confidence" },
    { file: "/nas/dev3/clash.mp4", reason: "device_overlap" },
  ];

  return { devices, placements, durations, scanFiles, unsynced };
}

const SCENARIO = buildScenario();
const TOTAL_PLACEMENTS = SCENARIO.placements.length; // 5 × 60 + 2 overlap clips = 302

/** Per-device stacked rows, in timeline-local ms — the exact input `Track.tsx` builds
 *  for `visibleClips`, computed here from the SAME fixture data the browser gets. */
function deviceRows(deviceId: string): ClipSpan[][] {
  const spans: ClipSpan[] = SCENARIO.placements
    .filter((p) => p.device === deviceId)
    .map((p) => {
      const startMs = p.offset_seconds * 1000;
      return { file: p.file, startMs, endMs: startMs + SCENARIO.durations[p.file] * 1000 };
    });
  return stackClips(spans);
}

/** What `Track.tsx` should mount for every device, given a visible window — the
 *  independently-computed expectation the DOM is checked against. */
function expectedMountedFiles(visStartMs: number, visEndMs: number): Set<string> {
  const out = new Set<string>();
  for (const id of BUSY_DEVICE_IDS) {
    for (const row of deviceRows(id)) {
      for (const { item } of visibleClips(row, visStartMs, visEndMs)) out.add(item.file);
    }
  }
  return out;
}

const TOTAL_SAMPLES = 12_000 * CLIP_DUR_SEC; // every placement shares one duration
const LEVELS_EXPR =
  `Array.from({ length: 13 }, (_, i) => { ` +
  `const binSamples = 120 * Math.pow(2, i); ` +
  `return { binSamples, bins: Math.ceil(${TOTAL_SAMPLES} / binSamples) }; })`;

/** Same pattern as `waveform.spec.ts`'s `waveformMetaOk`/`waveformLevelOk`, generalised
 *  to every file at once — every placement in this scenario shares one clip duration, so
 *  one pyramid shape answers every `waveform_meta`/`waveform_level` call regardless of
 *  which file it is for. */
function waveformFixtures() {
  return {
    waveform_meta: fn(`(args) => ({ totalSamples: ${TOTAL_SAMPLES}, levels: ${LEVELS_EXPR} })`),
    waveform_level: fn(`(args) => {
      const levels = ${LEVELS_EXPR};
      const lvl = levels[args.level];
      const bytes = new Uint8Array(lvl.bins * 2);
      for (let i = 0; i < lvl.bins; i += 1) {
        bytes[i * 2] = 180;
        bytes[i * 2 + 1] = 100;
      }
      return bytes.buffer;
    }`),
  };
}

async function reachResult(page: Page): Promise<void> {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      ...waveformFixtures(),
      "plugin:dialog|open": ["/Volumes/nas/shoot"],
      scan_inputs: { schema: 1, devices: SCENARIO.devices, files: SCENARIO.scanFiles, unsynced: [] },
      run_sync: {
        result: {
          schema: 1,
          parameters: { analysis_rate: 12000, min_psr: 15 },
          reference: { file: ORIGIN_FILE, device: "dev0" },
          devices: SCENARIO.devices,
          placements: SCENARIO.placements,
          unsynced: SCENARIO.unsynced,
          sequence: { fps: "25/1", duration_seconds: SPAN_SEC },
          warnings: [],
        },
        durations: SCENARIO.durations,
      },
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

/** `title` is `Clip.tsx`'s basename — read off every currently-mounted clip so the DOM's
 *  actual membership can be compared against `expectedMountedFiles`'s prediction. */
async function mountedBasenames(page: Page): Promise<string[]> {
  return page.locator(".clip").evaluateAll((els) => els.map((el) => el.getAttribute("title") ?? ""));
}

function basename(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

const VIEWPORT = "#timeline-viewport";

/** Measures the CURRENT (pxPerMs, visStart) from rendered pixels alone, calibrated
 *  against `CALIBRATION_FILE` (timeline-local ms `CALIBRATION_START_SEC*1000` ..
 *  `+CLIP_DUR_SEC*1000`). This deliberately does NOT read any TimelineView-internal
 *  constant (zoom factors, the viewport element's own state, …) — it reads the same two
 *  numbers `msToX` would need, off the box the browser actually drew, so the assertions
 *  below hold regardless of how S6's polish work tunes those internals.
 *
 *  Requires `CALIBRATION_FILE`'s `.clip` to still be mounted — true throughout this file
 *  because every zoom/pan below is anchored on that clip's own on-screen position (see
 *  `zoomInAroundCalibrationClip`), which keeps it inside `visibleClips`'s window (or at
 *  worst its overscan buffer) regardless of how far the zoom goes. */
async function measureView(page: Page): Promise<{ pxPerMs: number; visStartMs: number; visEndMs: number }> {
  const vpBox = (await page.locator(VIEWPORT).boundingBox())!;
  const calBox = (await page.locator(".clip", { hasText: basename(CALIBRATION_FILE) }).boundingBox())!;
  const pxPerMs = calBox.width / (CLIP_DUR_SEC * 1000);
  const calStartMs = CALIBRATION_START_SEC * 1000;
  const leftRelPx = calBox.x - vpBox.x; // = msToX(calStartMs, view) = (calStartMs - scrollMs) * pxPerMs
  const visStartMs = calStartMs - leftRelPx / pxPerMs;
  const visEndMs = visStartMs + vpBox.width / pxPerMs;
  return { pxPerMs, visStartMs, visEndMs };
}

/**
 * Zooms in around `CALIBRATION_FILE`'s own on-screen centre, `notches` times, re-reading
 * that centre before every notch so the anchor tracks the clip as it grows — the anchor
 * that keeps it mounted (see `measureView`'s note) throughout the whole sweep, however
 * deep it goes, while genuinely narrowing the window around the middle of the timeline
 * rather than its very start (see `CALIBRATION_FILE`'s comment for why the start would
 * defeat the "far below total" proof).
 *
 * Dispatched straight at `.timeline__body`'s own listener (same technique as the
 * interaction-timing test below), rather than through Playwright's real mouse+keyboard
 * pipeline: at this page's size (six device tracks, a transport bar, an unsynced shelf)
 * the real pointer path proved unreliable in this environment — `page.mouse.wheel()`
 * after `keyboard.down("Control")` measurably did not register as a ctrl-wheel on the
 * page. Dispatching the WheelEvent directly is exactly what a real ctrl+scroll delivers
 * to this listener, and it is already proven to work by the burst-interaction test.
 */
async function zoomInAroundCalibrationClip(page: Page, notches: number): Promise<void> {
  const title = basename(CALIBRATION_FILE);
  await page.evaluate(
    ({ n, title }) => {
      const body = document.querySelector(".timeline__body") as HTMLElement;
      for (let i = 0; i < n; i += 1) {
        const clip = Array.from(document.querySelectorAll(".clip")).find(
          (el) => el.getAttribute("title") === title,
        ) as HTMLElement;
        const rect = clip.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        body.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: -120,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
          }),
        );
      }
    },
    { n: notches, title },
  );
}

test.describe(`timeline scale (${TOTAL_PLACEMENTS} placements, 6 devices, 3-hour span)`, () => {
  // Six device tracks plus the transport and unsynced shelf push this page well past a
  // default 720px-tall viewport — real mouse coordinates for the wheel-zoom helpers below
  // must land ON the rendered timeline, not below the fold, so the viewport is sized to
  // fit the whole page without scrolling.
  test.use({ viewport: { width: 1280, height: 2400 } });

  test(`the fixture itself is the scale claim: 6 tracks, one empty, ${TOTAL_PLACEMENTS} placements, real overlaps`, async ({
    page,
  }) => {
    await reachResult(page);
    await expect(page.locator(".track:not(.track--ruler):not(.track--scrollbar)")).toHaveCount(6);
    const empty = page.getByRole("group", { name: en.trackAria("Device 5") });
    await expect(empty.getByText(en.emptyLane)).toBeVisible();
    // Both overlap devices really did get a second sub-track.
    await expect(
      page.getByRole("group", { name: en.trackAria("Device 0") }).getByRole("group", { name: en.subTrackAria(2) }),
    ).toBeVisible();
    expect(TOTAL_PLACEMENTS).toBeGreaterThanOrEqual(50);
    // The unsynced shelf actually carries the two entries the scenario planted — behind the
    // strip's problem chip since V06-R2a (D-079), so the chip's own count is asserted too.
    const problems = page
      .getByRole("region", { name: en.sourcesTitle })
      .locator(".popover--problems");
    await expect(problems.locator("> summary")).toHaveText(en.problemCount(2));
    await problems.locator("> summary").click();
    await expect(page.locator(".shelf__row")).toHaveCount(2);
  });

  test("at fit zoom every clip is legitimately on-screen (nothing hidden), and canvases follow the width rule", async ({
    page,
  }) => {
    await reachResult(page);
    // Fit zoom, by construction (`fitPxPerMs`), makes the visible window equal the WHOLE
    // content span — so every placement is genuinely inside the
    // virtualization window and mounting all of them is correct, not a virtualization
    // failure. The real proof (most clips off-screen, DOM far smaller than the total) is the
    // deep-zoom test below; this test guards the OTHER failure mode — a clip silently
    // missing at the zoom level an operator lands on first.
    const clips = page.locator(".clip");
    await expect(clips).toHaveCount(TOTAL_PLACEMENTS);

    // MIGRATED in V05-W5 (D-072). This used to read `.waveform__canvas` count ===
    // TOTAL_PLACEMENTS — one canvas per clip, unconditionally. That is no longer what the
    // app does or should do: at this zoom a clip is ~9 px wide, which is three to ten bars
    // of a waveform, and the canvas, its backing store, its per-pan draw and the
    // `waveform_meta` read behind it are all waste. The claim the old assertion was
    // actually making — "the canvas layer tracks the clips, one to one, rather than
    // drifting" — survives, stated against the rule that now governs it.
    const widths = await clips.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).getBoundingClientRect().width),
    );
    const roomy = widths.filter((w) => w >= 24).length; // MIN_WAVEFORM_PX
    await expect(page.locator(".waveform__canvas")).toHaveCount(roomy);
  });

  test("deep zoom mounts far fewer clips than exist, matching the virtualization window plus its overscan buffer", async ({
    page,
  }) => {
    await reachResult(page);
    await zoomInAroundCalibrationClip(page, 28);

    const { visStartMs, visEndMs } = await measureView(page);
    // A real narrowing happened — otherwise the rest of this test would be vacuous.
    expect(visEndMs - visStartMs).toBeLessThan(SPAN_SEC * 1000 * 0.2);

    const expected = expectedMountedFiles(visStartMs, visEndMs);
    const actualBasenames = await mountedBasenames(page);
    const actualCount = actualBasenames.length;

    // The concrete ceiling: the independently-computed `visibleClips` prediction, plus a
    // small margin for the sub-pixel imprecision in `measureView`'s own calibration (it
    // reads real rendered pixels, not exact internal state) — NOT a margin for anything
    // resembling "mount whatever is easiest". 10 devices/rows × a couple of boundary
    // clips is a generous, still-tiny allowance next to the total placement count.
    const ceiling = expected.size + 12;
    expect(actualCount).toBeLessThanOrEqual(ceiling);
    expect(actualCount).toBeGreaterThan(0); // the window is not so narrow it mounts nothing
    // …and it is a REAL reduction, not a rounding artefact.
    expect(actualCount).toBeLessThan(TOTAL_PLACEMENTS / 2);

    // Every one of `visibleClips`'s DEFINITE inclusions (true time-overlap, not just
    // overscan) actually made it into the DOM — the window shrank, but nothing that
    // should still be visible silently vanished.
    for (const file of expected) {
      expect(actualBasenames).toContain(basename(file));
    }

    // One canvas per mounted clip, still — the bound scales with what is mounted, not
    // with how many placements the result actually has.
    await expect(page.locator(".waveform__canvas")).toHaveCount(actualCount);
  });

  test("panning at deep zoom changes which clips are mounted", async ({ page }) => {
    await reachResult(page);
    await zoomInAroundCalibrationClip(page, 28);
    const before = new Set(await mountedBasenames(page));
    expect(before.size).toBeGreaterThan(0);

    // A large plain (non-ctrl) wheel scroll pans without resizing — same gesture
    // `timeline.spec.ts`'s pan test uses, just dispatched directly (see
    // `zoomInAroundCalibrationClip`'s comment) and repeated hard enough to cross most of a
    // 3-hour result at this zoom.
    await page.evaluate(() => {
      const body = document.querySelector(".timeline__body") as HTMLElement;
      const vp = document.querySelector("#timeline-viewport") as HTMLElement;
      const rect = vp.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      for (let i = 0; i < 40; i += 1) {
        body.dispatchEvent(
          new WheelEvent("wheel", { deltaX: 4000, bubbles: true, cancelable: true, clientX, clientY }),
        );
      }
    });

    await expect
      .poll(async () => {
        const now = new Set(await mountedBasenames(page));
        // Symmetric difference: something left, something new arrived.
        const changed = [...now].some((f) => !before.has(f)) || [...before].some((f) => !now.has(f));
        return changed;
      })
      .toBe(true);

    const after = new Set(await mountedBasenames(page));
    // Not just "different" — the mounted SET actually moved forward, not merely resized.
    const stayedResident = [...before].filter((f) => after.has(f));
    expect(stayedResident.length).toBeLessThan(before.size);
  });

  test("a burst of zoom/pan interactions stays pixel-coherent and settles back on fit ('0')", async ({ page }) => {
    await reachResult(page);
    await zoomInAroundCalibrationClip(page, 15);

    // Dispatched directly against the listening element (`.timeline__body`'s own
    // `addEventListener('wheel', …, { passive:false })`) rather than through
    // Playwright's real input pipeline — this is a redraw-storm canary, not a benchmark,
    // so the number that matters is wall time actually spent doing React work in
    // response to a burst of events, with automation/IPC overhead subtracted out. The
    // threshold below is deliberately generous (an order of magnitude over what this
    // should ever cost) so it never flakes on a loaded CI runner; it exists only to catch
    // a genuine pathological regression (e.g. an accidental O(n²) re-render per clip).
    const elapsedMs = await page.evaluate(() => {
      const body = document.querySelector(".timeline__body") as HTMLElement;
      const vp = document.querySelector("#timeline-viewport") as HTMLElement;
      const rect = vp.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const t0 = performance.now();
      for (let i = 0; i < 60; i += 1) {
        const zoom = i % 2 === 0;
        body.dispatchEvent(
          new WheelEvent("wheel", {
            deltaX: zoom ? 0 : 300,
            deltaY: zoom ? (i % 4 === 0 ? -120 : 120) : 0,
            ctrlKey: zoom,
            bubbles: true,
            cancelable: true,
            clientX: cx,
            clientY: cy,
          }),
        );
      }
      return performance.now() - t0;
    });

    // Generous on purpose — see the comment above. 60 synchronous wheel-driven
    // React re-renders over the virtualized clips finishing in seconds, not
    // milliseconds, is the actual regression this guards against.
    expect(elapsedMs).toBeLessThan(5000);

    // The view is left coherent: every mounted clip has finite, non-NaN geometry.
    const styles = await page.locator(".clip").evaluateAll((els) =>
      els.map((el) => ({
        left: (el as HTMLElement).style.left,
        width: (el as HTMLElement).style.width,
      })),
    );
    expect(styles.length).toBeGreaterThan(0);
    for (const s of styles) {
      expect(s.left).not.toContain("NaN");
      expect(s.width).not.toContain("NaN");
      expect(Number.isFinite(parseFloat(s.left))).toBe(true);
      expect(Number.isFinite(parseFloat(s.width))).toBe(true);
    }

    // Keyboard `0` (Fit) brings every placement back on screen, from wherever the burst
    // left the view.
    await page.locator(".timeline").focus();
    await page.keyboard.press("0");
    await expect(page.locator(".clip")).toHaveCount(TOTAL_PLACEMENTS);
  });
});

// ---- Scenario: the metadata storm (V05-W5, D-072) --------------------------------------
//
// The owner's report, in a fixture: 400 clips land in one commit, every one of them mounts
// a `WaveformCanvas`, and every one of those used to call `waveform_meta` for its own file
// on its mount effect. The per-file dedup matched nothing — 400 distinct files — so 400
// `invoke`s crossed the IPC boundary at once, each of them rejecting `cache_missing`
// because no analysis existed yet.
//
// Two bounds are asserted here, and they are different claims:
//   - at the FITTED zoom of a 400-file drop nothing is asked at all, because no clip is
//     wide enough (`MIN_WAVEFORM_PX`) for a waveform to mean anything;
//   - once the operator zooms in far enough that waveforms ARE worth reading, the queue
//     caps what is outstanding at `META_CONCURRENCY`, so the storm cannot come back in the
//     one situation where the reads are legitimate.

const STORM_DEVICES = 4;
const STORM_PER_DEVICE = 100;
const STORM_TOTAL = STORM_DEVICES * STORM_PER_DEVICE; // 400
const STORM_SPACING_SEC = (SPAN_SEC - CLIP_DUR_SEC) / (STORM_PER_DEVICE - 1);

/** The cap `waveformStore.ts` enforces. Imported rather than repeated, so the assertion
 *  below cannot drift away from the constant it is about. */
const STORM_CAP = META_CONCURRENCY;

function buildStormScan(): Record<string, unknown> {
  const devices: Record<string, unknown>[] = [];
  const files: Record<string, unknown>[] = [];
  for (let d = 0; d < STORM_DEVICES; d += 1) {
    const id = `storm${d}`;
    const kind = d % 2 === 0 ? "video" : "audio";
    const own: string[] = [];
    for (let c = 0; c < STORM_PER_DEVICE; c += 1) {
      const file = `/nas/${id}/s${d}_${String(c).padStart(3, "0")}.${kind === "video" ? "mp4" : "wav"}`;
      own.push(file);
      files.push({
        file,
        device: id,
        duration_seconds: CLIP_DUR_SEC,
        format_name: kind === "video" ? "mov,mp4" : "wav",
        audio: { codec: kind === "video" ? "aac" : "pcm_s16le", sample_rate: 48000, channels: 2 },
        video: kind === "video" ? { codec: "h264", width: 1920, height: 1080, fps: "25/1" } : null,
        creation_time: startedAt(c * STORM_SPACING_SEC),
        date_tag: null,
        modified_time: null,
      });
    }
    devices.push({ id, label: `Storm ${d}`, kind, files: own });
  }
  return { schema: 1, devices, files, unsynced: [], skipped: [] };
}

const STORM_SCAN = buildStormScan();

/**
 * A `waveform_meta` fixture that RECORDS — the harness's own arg-recording pattern
 * (`cancelThumbnailSpy`, `consentSetSpy`), extended to keep a peak-concurrency counter as
 * well as a call list.
 *
 * It settles on a timer rather than immediately, because a fixture that resolves inside the
 * same microtask can never have more than one call outstanding — the cap would read as
 * "honoured" no matter what the code did.
 */
function metaSpyFixtures() {
  return {
    waveform_meta: fn(`(args) => {
      const w = window;
      w.__E2E_META__ = w.__E2E_META__ || { calls: [], inFlight: 0, peak: 0 };
      const s = w.__E2E_META__;
      s.calls.push(args.file);
      s.inFlight += 1;
      if (s.inFlight > s.peak) s.peak = s.inFlight;
      return new Promise((resolve) => setTimeout(() => {
        s.inFlight -= 1;
        resolve({ totalSamples: ${TOTAL_SAMPLES}, levels: ${LEVELS_EXPR} });
      }, 10));
    }`),
    waveform_level: fn(`(args) => {
      const levels = ${LEVELS_EXPR};
      const lvl = levels[args.level];
      const bytes = new Uint8Array(lvl.bins * 2);
      for (let i = 0; i < lvl.bins; i += 1) { bytes[i * 2] = 180; bytes[i * 2 + 1] = 100; }
      return bytes.buffer;
    }`),
  };
}

interface MetaSpy {
  calls: string[];
  peak: number;
}

async function readMetaSpy(page: Page): Promise<MetaSpy> {
  return page.evaluate(() => {
    const s = (window as unknown as Record<string, MetaSpy | undefined>).__E2E_META__;
    return { calls: s?.calls ?? [], peak: s?.peak ?? 0 };
  });
}

/** Drop the 400-file card and settle on the pre-sync timeline — the exact moment the
 *  owner's screen filled with rebuild buttons. */
async function dropTheCard(page: Page): Promise<void> {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      ...metaSpyFixtures(),
      "plugin:dialog|open": ["/Volumes/nas/wedding"],
      scan_inputs: STORM_SCAN,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(page.locator(".clip")).toHaveCount(STORM_TOTAL);
}

/** A plain (non-ctrl) wheel pan, dispatched straight at the listening element — same
 *  technique, and same reason, as `zoomInAroundCalibrationClip`. */
async function panBy(page: Page, deltaX: number, times: number): Promise<void> {
  await page.evaluate(
    ({ deltaX, times }) => {
      const body = document.querySelector(".timeline__body") as HTMLElement;
      const vp = document.querySelector("#timeline-viewport") as HTMLElement;
      const rect = vp.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      for (let i = 0; i < times; i += 1) {
        body.dispatchEvent(
          new WheelEvent("wheel", { deltaX, bubbles: true, cancelable: true, clientX, clientY }),
        );
      }
    },
    { deltaX, times },
  );
}

test.describe(`the metadata storm (${STORM_TOTAL} clips, D-072)`, () => {
  test.use({ viewport: { width: 1280, height: 2000 } });

  test("400 clips land in one commit and the shell is asked a BOUNDED number of times", async ({
    page,
  }) => {
    await dropTheCard(page);
    // Give any deferred work every chance to happen: the queue is idle-scheduled, so an
    // assertion taken on the next tick would pass for the wrong reason.
    await page.waitForTimeout(1500);

    const spy = await readMetaSpy(page);
    // The bound. 400 clips, and the number of `waveform_meta` calls does not scale with
    // them — at this zoom every clip is ~9 px wide, which is not a waveform.
    expect(spy.calls.length).toBeLessThanOrEqual(STORM_CAP * 2);
    expect(spy.peak).toBeLessThanOrEqual(STORM_CAP);

    // …and the reason is stated, not inferred: no clip is wide enough, and none of them
    // carries a canvas either. The IPC, the element and the draw are one decision.
    const widths = await page
      .locator(".clip")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).getBoundingClientRect().width));
    expect(Math.max(...widths)).toBeLessThan(24); // MIN_WAVEFORM_PX
    await expect(page.locator(".waveform__canvas")).toHaveCount(0);
    // And nothing offers to rebuild anything — D-064's other half, at this scale.
    await expect(page.locator(".waveform__regenerate")).toHaveCount(0);
  });

  test("panning does not produce a second storm", async ({ page }) => {
    await dropTheCard(page);
    await page.waitForTimeout(1000);
    const before = (await readMetaSpy(page)).calls.length;

    // Hard enough to cross most of a three-hour timeline, and repeatedly — every pointer
    // move of a real drag is one of these, and each one recycles the virtualization window.
    await panBy(page, 2000, 60);
    await panBy(page, -2000, 60);
    await page.waitForTimeout(1500);

    const after = (await readMetaSpy(page)).calls.length;
    expect(after - before).toBeLessThanOrEqual(STORM_CAP);
  });

  test("the measurement behind D-072's memo note: a pan moves EVERY mounted clip", async ({
    page,
  }) => {
    await dropTheCard(page);
    // Zoomed in first, because at FIT zoom the visible window already equals the whole
    // content span and `clampScroll` refuses to move it — a pan that cannot pan measures
    // nothing. Four notches is enough to make the view scrollable while leaving most of
    // the drop mounted, so this stays a measurement over hundreds of clips.
    await page.evaluate(() => {
      const body = document.querySelector(".timeline__body") as HTMLElement;
      const vp = document.querySelector("#timeline-viewport") as HTMLElement;
      const rect = vp.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      for (let i = 0; i < 4; i += 1) {
        body.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: -120,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
          }),
        );
      }
    });

    const before = await page.locator(".clip").evaluateAll((els) =>
      els.map((el) => ({
        file: el.getAttribute("data-file") ?? "",
        left: (el as HTMLElement).style.left,
      })),
    );
    expect(before.length).toBeGreaterThan(50);

    await panBy(page, 200, 1);

    const after = new Map(
      (
        await page.locator(".clip").evaluateAll((els) =>
          els.map((el) => [el.getAttribute("data-file") ?? "", (el as HTMLElement).style.left] as const),
        )
      ).map(([file, left]) => [file, left]),
    );

    // Not "most" — every single clip that is still mounted. `Clip`'s `left` is
    // `msToX(startMs, view)` and a pan changes `view.scrollMs`, so a `memo` around `Clip`
    // can skip nothing: its props really did all change. Off-screen clips are not mounted
    // at all (`Track` renders only `visibleClips`), so there is no third population for the
    // memo to help either. That is D-072's third finding, measured rather than argued.
    const stillMounted = before.filter((c) => after.has(c.file));
    expect(stillMounted.length).toBeGreaterThan(50);
    const unchanged = stillMounted.filter((c) => after.get(c.file) === c.left);
    expect(unchanged.map((c) => c.file)).toEqual([]);
  });

  test("at the fitted zoom of 400 clips no box shows two texts, at any width", async ({ page }) => {
    // D-065 × the real zoom the owner lands on. Not a unit-tested threshold — the rendered
    // boxes, measured. A clip may show a name, or a status, or neither; what it may never
    // do is draw two things over each other, which is exactly what the screenshot showed.
    await dropTheCard(page);
    const overlaps = await page.locator(".clip").evaluateAll((els) =>
      els
        .map((el) => {
          const name = el.querySelector(".clip__name");
          const status = el.querySelector(".clip__status");
          if (!name || !status) return null;
          const a = name.getBoundingClientRect();
          const b = status.getBoundingClientRect();
          const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          return overlap > 0.5 ? (el.getAttribute("data-file") ?? "?") : null;
        })
        .filter((f) => f !== null),
    );
    expect(overlaps).toEqual([]);

    // …and nothing spills out of its own box either.
    const spills = await page.locator(".clip").evaluateAll((els) =>
      els
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return Array.from(el.querySelectorAll(".clip__name, .clip__status")).some((child) => {
            const c = child.getBoundingClientRect();
            return c.left < box.left - 0.5 || c.right > box.right + 0.5;
          });
        })
        .map((el) => el.getAttribute("data-file") ?? "?"),
    );
    expect(spills).toEqual([]);
  });

  test("the icon-form rebuild control is still a real target once a clip can hold one", async ({
    page,
  }) => {
    // The other half of D-065's rationing: a control that shrinks to a glyph must still be
    // aimable and still carry its whole sentence to a screen reader. Measured on a clip
    // between NAME_AND_ICON_MIN_PX and NAME_AND_TEXT_MIN_PX, where the icon form lives.
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Volumes/nas/wedding"],
        scan_inputs: STORM_SCAN,
        waveform_meta: fn(`(args) => Promise.reject("cache_missing:" + args.file)`),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(page.locator(".clip")).toHaveCount(STORM_TOTAL);

    // Zoom one notch at a time until a clip lands in the icon band. Adaptive rather than a
    // fixed count on purpose: the band is `STATUS_ICON_MIN_PX`…`NAME_AND_TEXT_MIN_PX` and
    // where a given notch puts a 90-second clip depends on the viewport, so a hardcoded
    // number would be a test that passes on one screen size and not another.
    const zoomOneNotch = () =>
      page.evaluate(() => {
        const body = document.querySelector(".timeline__body") as HTMLElement;
        const vp = document.querySelector("#timeline-viewport") as HTMLElement;
        const rect = vp.getBoundingClientRect();
        body.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: -120,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        );
      });

    const icon = page.locator(".clip__status--icon").first();
    for (let i = 0; i < 24 && (await icon.count()) === 0; i += 1) {
      await zoomOneNotch();
      await page.waitForTimeout(250); // the queue is idle-scheduled (D-072)
    }
    await expect(icon).toBeVisible();
    const box = (await icon.boundingBox())!;
    // Aimable: a target with real area, not a hairline.
    expect(box.width).toBeGreaterThanOrEqual(8);
    expect(box.height).toBeGreaterThanOrEqual(8);
    // Only the PIXELS are rationed — the accessible name is the whole sentence.
    await expect(icon).toHaveAttribute("aria-label", en.waveformRegenerate);
    await expect(icon).toHaveRole("button");

    // …and it can actually be pressed. Aimed at an icon whose box is genuinely inside the
    // lanes column: a clip scrolled partly off the left edge is CLIPPED by
    // `.track__lane`'s `overflow: hidden`, but its layout rect still reaches under the
    // device gutter, so a click at that rect's centre lands on the gutter's own icon. That
    // is an artefact of aiming at a layout rect rather than at what is painted — the app
    // is behaving correctly — so the assertion aims where the operator would.
    const gutterRight = await page
      .locator(".track__gutter")
      .first()
      .evaluate((el) => el.getBoundingClientRect().right);
    const clickable = await page
      .locator(".clip__status--icon")
      .evaluateAll(
        (els, right) =>
          els.findIndex((el) => el.getBoundingClientRect().left > right + 4),
        gutterRight,
      );
    expect(clickable).toBeGreaterThanOrEqual(0);
    await page.locator(".clip__status--icon").nth(clickable).click();
  });

  test("zoomed in far enough for waveforms to mean something, the queue caps the reads", async ({
    page,
  }) => {
    await dropTheCard(page);
    await page.waitForTimeout(500);

    // Zoom until the clips are genuinely wide. Anchored on the viewport centre; the
    // assertion below is about the CAP, not about which clips are on screen.
    await page.evaluate(() => {
      const body = document.querySelector(".timeline__body") as HTMLElement;
      const vp = document.querySelector("#timeline-viewport") as HTMLElement;
      const rect = vp.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      for (let i = 0; i < 12; i += 1) {
        body.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: -120,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
          }),
        );
      }
    });
    await page.waitForTimeout(1500);

    const widths = await page
      .locator(".clip")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).getBoundingClientRect().width));
    // The zoom really did take the clips past the threshold — otherwise the rest is vacuous.
    expect(Math.max(...widths)).toBeGreaterThanOrEqual(24);

    const spy = await readMetaSpy(page);
    // Reads DO happen now — the threshold defers work, it does not refuse it forever.
    expect(spy.calls.length).toBeGreaterThan(0);
    // …and never more than the cap at once, which is the queue's whole job.
    expect(spy.peak).toBeLessThanOrEqual(STORM_CAP);
    // Each canvas that exists belongs to a clip wide enough to hold one.
    const canvases = await page.locator(".waveform__canvas").count();
    expect(canvases).toBeLessThanOrEqual(widths.filter((w) => w >= 24).length);
  });
});
