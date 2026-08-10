import { expect, test, type Page } from "@playwright/test";
import { en } from "../src/i18n";
import type { AudioHook } from "../src/audio/scheduler";
import {
  ANALYSIS_RATE,
  CHUNK_SAMPLES,
  computeSchedule,
  type PlacedClip,
} from "../src/audio/schedulePlan";
import {
  boot,
  BOOT_FIXTURES,
  fn,
  pcmWindow,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
} from "./harness";

// Playback (V03-S5, D-055) — hearing that the sync is right, before exporting.
//
// ## What a browser can and cannot prove here
//
// Playwright cannot hear. What it *can* do is read the exact numbers handed to
// `AudioBufferSourceNode.start()`, which the engine mirrors onto
// `window.__SUNDAYSYNC_AUDIO__` on every mutation. That is the honest boundary of this
// tier: **the schedule is asserted here; the acoustics are a manual smoke test** (two
// real files, one delayed — correct sounds phasey and doubled, wrong sounds like an
// echo) and the S7 listening protocol.
//
// Asserting the schedule is not a consolation prize. Every failure this stage could
// plausibly have — a wrong offset delta, an inverted drift rate, a stale schedule after
// a seek, a solo that mutes the wrong bus — is a wrong number in that mirror, and every
// one of them is caught below.

declare global {
  interface Window {
    /** Spec-local gate: every parked `read_audio_window` resolver (see `gatedPcm`). */
    __PCM_GATE__?: (() => void)[];
  }
}

const REC = "/Users/e2e/shoot/ZOOM0001.WAV";
const CAM = "/Users/e2e/shoot/CamA/C0001.MP4";

function placement(over: Record<string, unknown> = {}) {
  return {
    file: CAM,
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

/**
 * Two devices whose clips overlap: the reference at 0 (the engine places it there by
 * construction) and a camera 4.2 s later. That 4.2 s is the number every timing
 * assertion below is really about.
 */
function twoDeviceOutcome(camOver: Record<string, unknown> = {}) {
  const base = syncOutcome();
  return {
    ...base,
    result: {
      ...(base.result as Record<string, unknown>),
      placements: [
        placement({ file: REC, device: "rec", offset_seconds: 0, psr: 99 }),
        placement(camOver),
      ],
    },
  };
}

async function reachResult(page: Page, outcome: Record<string, unknown>, extra = pcmWindow()) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: scanManifest(),
      run_sync: outcome,
      ...extra,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await page.getByRole("button", { name: en.syncButton }).click();
  await expect(page.locator(".timeline__body")).toBeVisible();
}

const playButton = (page: Page) => page.getByRole("button", { name: en.play });

/** Press play and wait until the engine says it is actually playing. */
async function startPlaying(page: Page) {
  await playButton(page).click();
  await page.waitForFunction(() => window.__SUNDAYSYNC_AUDIO__?.playing === true);
}

const hook = (page: Page) =>
  page.evaluate(() => window.__SUNDAYSYNC_AUDIO__ as AudioHook);

/** The first scheduled chunk of `file`. */
function firstChunk(h: AudioHook, file: string) {
  const entry = h.scheduled.find((e) => e.file === file);
  if (!entry) throw new Error(`nothing scheduled for ${file}: ${JSON.stringify(h.scheduled)}`);
  return entry;
}

/** 15 s at the analysis rate — one chunk (`schedulePlan.CHUNK_SAMPLES`). */
const CHUNK_SEC = 15;

/**
 * The timeline second at which `file`'s source sample 0 is heard, recovered from whatever
 * chunk happens to be scheduled.
 *
 * Working back to the clip's origin rather than comparing two chunk-0 entries is what
 * makes the same assertion usable after a seek, when the playhead is an hour in and chunk
 * 0 is long gone: `timelineTime = start + sourcePosition / rate`, so
 * `start = timelineTime − sourcePosition / rate`, and the difference of two clips' starts
 * is exactly the delta of their §5 offsets.
 */
function clipOriginSec(h: AudioHook, file: string): number {
  const e = firstChunk(h, file);
  const sourcePositionSec = e.chunkIndex * CHUNK_SEC + e.offset;
  return h.playStartSec + e.whenOffset - sourcePositionSec / e.rate;
}

test("play schedules both devices exactly their offset apart", async ({ page }) => {
  // THE assertion of this stage. If this delta is wrong by a millisecond the operator
  // hears an echo and concludes the engine cannot sync — so it is checked against the
  // placement's own `offset_seconds`, not against a recorded number.
  await reachResult(page, twoDeviceOutcome());
  await startPlaying(page);

  const h = await hook(page);
  expect(h.playing).toBe(true);
  expect(h.buffering).toBe(false);
  expect(h.scheduled.length).toBeGreaterThan(0);

  const rec = firstChunk(h, REC);
  const cam = firstChunk(h, CAM);
  // Both were scheduled against one captured base, so the difference of their absolute
  // start instants IS the placement offset — no clock, no drift, no rounding.
  expect(cam.when - rec.when).toBeCloseTo(4.2, 6);
  expect(cam.whenOffset - rec.whenOffset).toBeCloseTo(4.2, 6);
  expect(clipOriginSec(h, CAM) - clipOriginSec(h, REC)).toBeCloseTo(4.2, 6);
  // Both start at the top of their buffers at t=0, at unity rate.
  expect(rec.chunkIndex).toBe(0);
  expect(cam.chunkIndex).toBe(0);
  expect(rec.offset).toBeCloseTo(0, 9);
  expect(cam.offset).toBeCloseTo(0, 9);
  expect(rec.rate).toBe(1);
  expect(cam.rate).toBe(1);
});

test("a drifting clip plays at the corrected rate, in the direction that cancels the drift", async ({
  page,
}) => {
  // +300 ppm over a 3550 s camera is 1065 ms of end error — 53 frames at 25 fps, well
  // past the exporter's half-frame gate, so playback must correct it too.
  const outcome = twoDeviceOutcome({ drift_ppm: 300, projected_end_error_ms: 1065 });
  await reachResult(page, outcome);
  await startPlaying(page);

  const h = await hook(page);
  const cam = firstChunk(h, CAM);

  // rate = 1/(1 + ppm·1e-6): the clip's clock ran fast, so it plays back slower. The
  // inverted sign (1 + ppm·1e-6 ≈ 1.0003) would be > 1 and double the error.
  expect(cam.rate).toBeCloseTo(1 / 1.0003, 9);
  expect(cam.rate).toBeLessThan(1);
  // The reference is never corrected.
  expect(firstChunk(h, REC).rate).toBe(1);

  // The start moved by half the projected end error (§4.3 places on the median), so the
  // corrected clip begins 532.5 ms EARLIER than its stored offset.
  expect(clipOriginSec(h, CAM) - clipOriginSec(h, REC)).toBeCloseTo(4.2 - 1.065 / 2, 6);
});

test("drift correction turned off puts every source back at rate 1", async ({ page }) => {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: scanManifest(),
      run_sync: twoDeviceOutcome({ drift_ppm: 300, projected_end_error_ms: 1065 }),
      ...pcmWindow(),
    },
    settings: { ...SETTLED_SETTINGS, playbackDriftCorrected: false },
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await page.getByRole("button", { name: en.syncButton }).click();
  await expect(page.locator(".timeline__body")).toBeVisible();
  await startPlaying(page);

  const h = await hook(page);
  for (const entry of h.scheduled) expect(entry.rate).toBe(1);
  expect(clipOriginSec(h, CAM) - clipOriginSec(h, REC)).toBeCloseTo(4.2, 6);
});

test("seeking during playback bumps the generation and rebuilds from the new position", async ({
  page,
}) => {
  await reachResult(page, twoDeviceOutcome());
  await startPlaying(page);
  const before = await hook(page);
  expect(before.playStartSec).toBeCloseTo(0, 6);

  // A click on the ruler is the operator's seek.
  const ruler = page.locator(".timeline__ruler");
  const box = (await ruler.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);

  // Everything scheduled against the old base is invalid, so the generation moves…
  await page.waitForFunction(
    (g) => (window.__SUNDAYSYNC_AUDIO__?.generation ?? 0) > g,
    before.generation,
  );
  // …and playback resumes from where the playhead now stands.
  await page.waitForFunction(() => window.__SUNDAYSYNC_AUDIO__?.playing === true);
  const after = await hook(page);
  expect(after.playStartSec).toBeGreaterThan(1);
  expect(after.generation).toBeGreaterThan(before.generation);
  // The schedule was rebuilt from the new position, not carried over — and the clips are
  // still exactly their offset apart there.
  expect(firstChunk(after, REC).chunkIndex).toBeGreaterThan(0);
  expect(clipOriginSec(after, CAM) - clipOriginSec(after, REC)).toBeCloseTo(4.2, 4);
});

test("mute silences one device's bus and solo silences the others", async ({ page }) => {
  await reachResult(page, twoDeviceOutcome());
  await startPlaying(page);

  await page.getByRole("button", { name: en.muteDevice("Camera A") }).click();
  await expect
    .poll(async () => (await hook(page)).deviceGains["cam-a"])
    .toBe(0);
  expect((await hook(page)).deviceGains["rec"]).toBe(1);

  // Un-mute, then solo the recorder: everything else drops out.
  await page.getByRole("button", { name: en.unmuteDevice("Camera A") }).click();
  await page.getByRole("button", { name: en.soloDevice("Zoom recorder") }).click();
  await expect
    .poll(async () => (await hook(page)).deviceGains["cam-a"])
    .toBe(0);
  expect((await hook(page)).deviceGains["rec"]).toBe(1);

  // Mute beats solo: a soloed device that is also muted stays silent.
  await page.getByRole("button", { name: en.muteDevice("Zoom recorder") }).click();
  await expect
    .poll(async () => (await hook(page)).deviceGains["rec"])
    .toBe(0);
});

test("buffering is shown while the first windows are in flight, then playback starts", async ({
  page,
}) => {
  // A gated backend: every read parks its resolver until the spec releases them, which is
  // what a cold NAS looks like from the renderer's side.
  const gated = {
    read_audio_window: fn(`(args) => new Promise((resolve) => {
      window.__PCM_GATE__ = window.__PCM_GATE__ || [];
      window.__PCM_GATE__.push(() => resolve(new Float32Array(args.lenSamples).buffer));
    })`),
  };
  await reachResult(page, twoDeviceOutcome(), gated);

  await playButton(page).click();
  await expect(page.getByText(en.buffering)).toBeVisible();
  await page.waitForFunction(() => window.__SUNDAYSYNC_AUDIO__?.buffering === true);
  expect((await hook(page)).playing).toBe(false);

  await page.evaluate(() => (window.__PCM_GATE__ ?? []).forEach((release) => release()));
  await page.waitForFunction(() => window.__SUNDAYSYNC_AUDIO__?.playing === true);
  await expect(page.getByText(en.buffering)).toBeHidden();
});

test("Space toggles playback without disturbing the zoom keys", async ({ page }) => {
  await reachResult(page, twoDeviceOutcome());

  await page.locator(".timeline").press(" ");
  await page.waitForFunction(() => window.__SUNDAYSYNC_AUDIO__?.playing === true);

  await page.locator(".timeline").press(" ");
  await page.waitForFunction(() => window.__SUNDAYSYNC_AUDIO__?.playing === false);

  // The pre-existing zoom bindings still work — Space was added last on purpose.
  const width = () => page.locator(".clip").first().evaluate((el) => el.getBoundingClientRect().width);
  const before = await width();
  await page.locator(".timeline").press("+");
  await expect.poll(width).toBeGreaterThan(before);
});

test("a clip whose cache entry is gone is dropped, and the rest keeps playing", async ({
  page,
}) => {
  // §7.5's honesty rule applied to audio: one unplayable clip is named, not fatal.
  const partial = {
    read_audio_window: fn(`(args) => {
      if (args.file.indexOf("C0001.MP4") !== -1) {
        // Real Tauri rejects with a bare string, not an Error (see harness.ts).
        return Promise.reject("cache_missing:" + args.file);
      }
      return new Float32Array(args.lenSamples).buffer;
    }`),
  };
  await reachResult(page, twoDeviceOutcome(), partial);
  await startPlaying(page);

  await expect.poll(async () => (await hook(page)).deadFiles).toEqual([CAM]);
  const h = await hook(page);
  expect(h.scheduled.some((e) => e.file === CAM)).toBe(false);
  expect(h.scheduled.some((e) => e.file === REC)).toBe(true);
  await expect(page.getByText(en.playbackUnavailable(1))).toBeVisible();
});

test("stop returns the playhead to the start", async ({ page }) => {
  await reachResult(page, twoDeviceOutcome());
  await startPlaying(page);
  await expect.poll(() => page.locator('[data-testid="transport-time"]').textContent()).not.toBe(
    "00:00.000",
  );

  await page.getByRole("button", { name: en.stopPlayback }).click();
  await page.waitForFunction(() => window.__SUNDAYSYNC_AUDIO__?.playing === false);
  await expect(page.locator('[data-testid="transport-time"]')).toHaveText("00:00.000");
});

test("the scheduled sources really do render in sync, sample for sample", async ({ page }) => {
  // The closest a headless run can get to listening. Everything above asserts the
  // *numbers* in the schedule; this takes the real `computeSchedule` output, builds the
  // graph the way `scheduler.ts` builds it, and renders it through an
  // `OfflineAudioContext` — then measures where the sound actually landed.
  //
  // Each clip carries an impulse every second. Correct scheduling puts the two trains
  // exactly `offset` apart in the rendered buffer; the echo bug this whole stage exists
  // to catch (>20 ms, i.e. >240 samples at 12 kHz) would be unmissable here. The chunk
  // seam is covered too: the clips are 30 s, so everything past 15 s comes from chunk 1.
  await page.goto("/");

  const clips: PlacedClip[] = [
    { file: "/a.wav", device: "rec", startSec: 0, durationSec: 30, driftPpm: null, projectedEndErrorMs: null },
    { file: "/b.wav", device: "cam", startSec: 2, durationSec: 30, driftPpm: null, projectedEndErrorMs: null },
  ];
  const schedule = computeSchedule(clips, 0, { has: () => true }, {
    driftCorrected: true,
    horizonAheadSec: 60,
  });
  expect(schedule.filter((e) => e.file === "/a.wav")).toHaveLength(2); // two chunks

  const impulses = await page.evaluate(
    async ({ entries, rate, chunkSamples }) => {
      const ctx = new OfflineAudioContext(2, rate * 35, rate);
      // One channel per device, exactly like the per-device gain buses.
      const merger = ctx.createChannelMerger(2);
      merger.connect(ctx.destination);

      for (const e of entries) {
        // A pulse on every whole second of the SOURCE, so its position in the render is
        // a direct readout of where the scheduler put it.
        const buf = ctx.createBuffer(1, chunkSamples, rate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < chunkSamples; i += 1) {
          if ((e.chunkIndex * chunkSamples + i) % rate === 0) data[i] = 1;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = e.rate;
        src.connect(merger, 0, e.file === "/a.wav" ? 0 : 1);
        src.start(e.whenOffsetSec, e.sourceOffsetSec, e.sourceDurationSec);
      }

      const rendered = await ctx.startRendering();
      const found: number[][] = [];
      for (let ch = 0; ch < 2; ch += 1) {
        const data = rendered.getChannelData(ch);
        const hits: number[] = [];
        for (let i = 0; i < data.length; i += 1) if (data[i] > 0.5) hits.push(i);
        found.push(hits);
      }
      return found;
    },
    { entries: schedule, rate: ANALYSIS_RATE, chunkSamples: CHUNK_SAMPLES },
  );

  const [a, b] = impulses;
  expect(a.length).toBeGreaterThanOrEqual(30);
  expect(b.length).toBeGreaterThanOrEqual(30);
  // Sample-exact, at the start, across the chunk seam, and at the end.
  for (const n of [0, 5, 14, 15, 16, 29]) {
    expect(a[n]).toBe(n * ANALYSIS_RATE);
    expect(b[n] - a[n]).toBe(2 * ANALYSIS_RATE);
  }
});

test("the transport says what the audio actually is", async ({ page }) => {
  // Expectation-setting is a feature here: 12 kHz mono analysis audio sounds wrong to
  // someone expecting a mix, and a user who thinks the audio is broken stops trusting
  // the sync it is there to prove.
  await reachResult(page, twoDeviceOutcome());
  await expect(page.getByText(en.playbackQualityNote)).toBeVisible();
});
