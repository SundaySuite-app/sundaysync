import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  controlled,
  presyncScanManifest,
  resolveControlled,
  SETTLED_SETTINGS,
  waitForPending,
  waitForResult,
} from "./harness";
import { en } from "../src/i18n";
import { FIT_PADDING_PX, fitPxPerMs } from "../src/timeline/viewport";

// The hop (V04-U5 D-063 → V06 D-090) — «ting hopper litt rundt på tidslinjen og spretter på
// plassen hvor de skal være, for så å bli grønne».
//
// Two halves, and the split is deliberate.
//
//   - **Where it LANDS** is the part that matters and the part that must never be flaky,
//     so it is asserted under `reducedMotion: "reduce"`, where there is no animation at
//     all: the clips are simply at their solved positions, green, with nothing left on
//     them. That is also the accessibility claim — a reduced-motion operator gets the same
//     answer, immediately — and it is the assertion that would catch a FLIP that forgot to
//     clean up after itself.
//   - **That it MOVES** is asserted by watching the DOM change, via a MutationObserver
//     installed before the outcome lands. Never by sampling pixels mid-flight and never by
//     comparing screenshots of a tween: an animation frame is a time-dependent value, and a
//     test that asserts one is a test that fails on a slow CI box for no reason. What is
//     asserted is discrete and timing-free — a class was applied, a delta was written into a
//     custom property and then removed, a class came OFF at a landing, a ghost was inserted.
//
// D-090 replaced one 450 ms transition with one 800 ms keyframe animation per clip, each
// behind its own 0–250 ms delay, and moved the colour into the same event: a clip is BLUE
// (`clip--travelling`) for exactly as long as it is in the air, and green the instant its
// animation ends. Three things therefore became assertable that were not before, and all
// three are still discrete facts rather than instants:
//
//   - the delays DIFFER (the inline `--hop-delay` props are readable in flight), which is
//     what makes the landings a wave rather than one clack;
//   - the blue is a state with a beginning and an end — `clip--travelling` appears on every
//     clip and the count comes back to zero;
//   - `--travelling` coming OFF a clip is that clip going green, so the landing order is
//     observable per file without timing anything.
//
// The seeded PRNG (`timeline/hop.ts`) is what lets any of this be asserted at all: the same
// drop choreographs identically on every machine and every run.

const WAV = "/Users/e2e/shoot/ZOOM0001.WAV";
const CAM_A = "/Users/e2e/shoot/CamA/C0001.MP4";
const CAM_B = "/Users/e2e/shoot/CamB/C0002.MP4";

/** Durations, straight from `presyncScanManifest()`. */
const DURATIONS: Record<string, number> = { [WAV]: 3600, [CAM_A]: 1800, [CAM_B]: 1800 };

/**
 * Where the sync says each file really was, as `offset_seconds` — i.e. relative to the
 * reference, which is the WAV and therefore sits at 0 by construction.
 *
 * Camera A's NEGATIVE offset is the point of the fixture: a camera that rolled before the
 * reference drags `contentBounds`' origin off zero, which shifts every clip on the
 * timeline — including the reference, which would otherwise be at 0 both before and after
 * the sync and would have nothing to hop. A drop where one card started early is also just
 * what a multi-camera service looks like.
 */
const SOLVED: Record<string, number> = { [WAV]: 0, [CAM_A]: -60, [CAM_B]: 1900 };

const DEVICE_OF: Record<string, string> = { [WAV]: "rec", [CAM_A]: "cam-a", [CAM_B]: "cam-b" };

function placement(file: string) {
  return {
    file,
    device: DEVICE_OF[file],
    offset_seconds: SOLVED[file],
    confidence: 0.95,
    psr: 38.4,
    drift_ppm: null,
    projected_end_error_ms: null,
    chain: [],
    warnings: [],
  };
}

/**
 * A result over the same three files the pre-sync fixture drops.
 *
 * `omit` leaves one of them UNPLACED — it appears in `unsynced` instead, which is the case
 * the fade is for: the clip that was on the timeline before the sync has nowhere to hop to.
 */
function hopOutcome(omit?: string) {
  const files = [WAV, CAM_A, CAM_B].filter((f) => f !== omit);
  return {
    result: {
      schema: 1,
      parameters: { analysis_rate: 12000, min_psr: 15 },
      reference: { file: WAV, device: "rec" },
      devices: [
        { id: "rec", label: "Zoom recorder", kind: "audio", files: [WAV] },
        { id: "cam-a", label: "Camera A", kind: "video", files: [CAM_A] },
        { id: "cam-b", label: "Camera B", kind: "video", files: [CAM_B] },
      ],
      placements: files.map(placement),
      unsynced: omit ? [{ file: omit, device: DEVICE_OF[omit], reason: "no_peak" }] : [],
      sequence: { fps: "25/1", duration_seconds: 3700 },
      warnings: [],
    },
    durations: DURATIONS,
  };
}

/** The files the run placed. */
function placed(omit?: string): string[] {
  return [WAV, CAM_A, CAM_B].filter((f) => f !== omit);
}

/** `contentBounds`' origin over those placements, in seconds: `min(0, earliest start)`. */
function originSec(omit?: string): number {
  return Math.min(0, ...placed(omit).map((f) => SOLVED[f]));
}

/** The result's own span, in ms — the same `contentBounds` the timeline fits to. */
function resultSpanMs(omit?: string): number {
  const latest = Math.max(...placed(omit).map((f) => SOLVED[f] + DURATIONS[f]));
  return (latest - originSec(omit)) * 1000;
}

/** Where a clip's left edge belongs on the timeline, in timeline-local ms. */
function localStartMs(file: string, omit?: string): number {
  return (SOLVED[file] - originSec(omit)) * 1000;
}

/** Drop the mixed-timestamp fixture, with `run_sync` parked so the spec decides when the
 *  outcome lands. */
async function reachSources(page: Page) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: presyncScanManifest(),
      run_sync: controlled("run_sync"),
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(page.locator(".clip")).toHaveCount(3);
}

/**
 * `hopOutcome(omit)`, but with every device the scan reported — including the fillers.
 *
 * §7.5 already says a device that synced nothing stays visible; stating it here keeps the
 * track column exactly as tall after the sync as before it, which is what lets the scrolled
 * ghost assertion compare two viewport positions rather than two different layouts.
 */
function outcomeOverAllDevices(omit: string): Record<string, unknown> {
  const outcome = hopOutcome(omit);
  const result = outcome.result as Record<string, unknown>;
  return {
    ...outcome,
    result: { ...result, devices: manifestWithFillerDevices(8).devices },
  };
}

/**
 * The three-device fixture plus `n` more devices, each with one untimed file.
 *
 * Only the height matters: eleven devices is 396 px of tracks, which overflows the
 * `max-height: 60vh` scroll box in a 560 px window. The extra files carry no timestamp, so
 * they lay out in filename order (D-068) and do not disturb the three the hop is about.
 */
function manifestWithFillerDevices(n: number): Record<string, unknown> {
  const base = presyncScanManifest();
  const devices = [...(base.devices as Record<string, unknown>[])];
  const files = [...(base.files as Record<string, unknown>[])];
  for (let i = 0; i < n; i++) {
    const id = `filler-${i}`;
    const file = `/Users/e2e/shoot/Filler${i}/TRACK.WAV`;
    devices.push({ id, label: `Filler ${i}`, kind: "audio", files: [file] });
    files.push({
      file,
      device: id,
      duration_seconds: 60,
      format_name: "wav",
      audio: { codec: "pcm_s16le", sample_rate: 48000, channels: 2 },
      video: null,
      creation_time: null,
    });
  }
  return { ...base, devices, files };
}

/**
 * Record what the timeline DOES, rather than what it looks like at some instant.
 *
 * `attributeOldValue` is the load-bearing option, for two facts that only exist in a value
 * the DOM has already overwritten by the time an observer callback runs:
 *
 *   - the FLIP deltas. The hop writes `--hop-dx`/`--hop-dy` and removes them again; the old
 *     `style` value is the only place the distance a clip was pushed back by still exists,
 *     and a hop whose deltas all came out zero would look identical from the outside without
 *     it (it would still add the classes, still end in the right place).
 *   - the LANDINGS. `clip--travelling` coming off a clip IS that clip going green (D-090),
 *     and it is visible only as "the old class list had it and the new one does not".
 */
async function watchTimeline(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const seen = {
      hopped: [] as string[],
      landed: [] as string[],
      deltas: [] as string[],
      ghosts: 0,
    };
    w.__HOP_SEEN__ = seen;
    const body = document.querySelector(".timeline__body");
    if (!body) throw new Error("no .timeline__body to observe");
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList") {
          for (const node of Array.from(record.addedNodes)) {
            if (node instanceof HTMLElement && node.classList.contains("clip--ghost")) {
              seen.ghosts += 1;
            }
          }
        }
        if (record.type !== "attributes" || !(record.target instanceof HTMLElement)) continue;
        const el = record.target;
        if (record.attributeName === "class") {
          const file = el.dataset.file ?? "";
          if (el.classList.contains("clip--hop")) seen.hopped.push(file);
          // Was blue, is not any more: the moment this clip turned green.
          if (
            (record.oldValue ?? "").includes("clip--travelling") &&
            !el.classList.contains("clip--travelling")
          ) {
            seen.landed.push(file);
          }
        }
        if (record.attributeName === "style" && record.oldValue) {
          seen.deltas.push(record.oldValue);
        }
      }
    });
    observer.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["class", "style"],
    });
  });
}

interface Seen {
  hopped: string[];
  landed: string[];
  deltas: string[];
  ghosts: number;
}

async function seen(page: Page): Promise<Seen> {
  return (await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__HOP_SEEN__,
  )) as Seen;
}

/** The largest distance any clip was pushed back by before it set off, in px. */
function largestDelta(styles: string[]): number {
  let largest = 0;
  for (const style of styles) {
    for (const match of style.matchAll(/--hop-d[xy]:\s*(-?[\d.]+)px/g)) {
      largest = Math.max(largest, Math.abs(Number(match[1])));
    }
  }
  return largest;
}

/** What every clip on screen is wearing right now — the whole assertable state of a clip
 *  mid-number, read in one round trip so the reads cannot straddle a landing. */
async function clipStates(page: Page) {
  return await page.$$eval(".clip[data-file]", (els) =>
    els.map((el) => {
      const node = el as HTMLElement;
      return {
        file: node.dataset.file ?? "",
        hop: node.classList.contains("clip--hop"),
        travelling: node.classList.contains("clip--travelling"),
        delay: node.style.getPropertyValue("--hop-delay"),
        dx: node.style.getPropertyValue("--hop-dx"),
        background: getComputedStyle(node).backgroundColor,
      };
    }),
  );
}

/** `--green` and `--blue` from `styles.css`, as the browser reports them. */
const GREEN = "rgb(34, 197, 94)";
const BLUE = "rgb(79, 142, 247)";

/** Nothing on any clip is left over from a hop: no classes, no custom properties. */
async function expectNothingLeftOnTheClips(page: Page) {
  await expect(page.locator(".clip--hop")).toHaveCount(0);
  await expect(page.locator(".clip--travelling")).toHaveCount(0);
  const leftovers = await page.$$eval(".clip", (els) =>
    els
      .map((el) => (el as HTMLElement).getAttribute("style") ?? "")
      .filter((style) => style.includes("--hop-") || style.includes("transform")),
  );
  expect(leftovers).toEqual([]);
}

test.describe("the clips hop into place when the sync lands", () => {
  test.describe("reduced motion", () => {
    // `reducedMotion` is a browser-context option in Playwright 1.62, not a top-level test
    // option any more — it has to travel through `contextOptions` or it is silently not a
    // known key at all.
    test.use({ contextOptions: { reducedMotion: "reduce" } });

    test("lands on the solved positions immediately, with nothing left on the clips", async ({
      page,
    }) => {
      await reachSources(page);
      await watchTimeline(page);
      await page.getByRole("button", { name: en.syncButton }).click();
      await waitForPending(page, "run_sync");
      await resolveControlled(page, "run_sync", hopOutcome());
      await waitForResult(page);

      // Nothing animated, so nothing may be mid-animation — or wearing the leftovers of
      // one. This is the assertion that catches a hop which set an offset it could not then
      // animate away (which is precisely what would happen if the reduced-motion gate were
      // on the CSS alone: `styles.css` kills the animation, the offset stays).
      await expect(page.locator(".timeline")).not.toHaveAttribute("data-hop", /.*/);
      await expect(page.locator(".clip--ghost")).toHaveCount(0);
      await expectNothingLeftOnTheClips(page);

      // D-090: and the colour landed with the layout. `clip--travelling` is the blue a clip
      // wears while it is in the air, and a reduced-motion operator's clips were never in
      // the air — so the blue must never have existed, not merely have been cleaned up. A
      // gate that ran the sequence and only skipped the movement would paint every clip blue
      // for 800 ms and then turn it green, which is an animation, and is the one thing this
      // context has asked not to be shown.
      expect((await seen(page)).hopped).toEqual([]);
      for (const clip of await clipStates(page)) {
        expect(clip.travelling).toBe(false);
        expect(clip.background).toBe(GREEN);
      }

      // And the layout IS the solved one: each clip's left edge is its own
      // `offset_seconds` under the result's fit zoom, measured from the lane column's
      // origin. `fitPxPerMs` is imported from the app rather than re-derived, so this is a
      // check of the wiring, not a second copy of the arithmetic.
      const lane = page.locator("#timeline-viewport");
      const laneBox = (await lane.boundingBox())!;
      const widthPx = await lane.evaluate((el) => el.clientWidth);
      const pxPerMs = fitPxPerMs(resultSpanMs(), widthPx, FIT_PADDING_PX);

      for (const file of [WAV, CAM_A, CAM_B]) {
        const box = (await page.locator(`.clip[data-file="${file}"]`).boundingBox())!;
        expect(box.x - laneBox.x).toBeCloseTo(localStartMs(file) * pxPerMs, 0);
      }
    });

    test("a clip the run could not place simply is not there — no ghost is left behind", async ({
      page,
    }) => {
      await reachSources(page);
      await watchTimeline(page);
      await page.getByRole("button", { name: en.syncButton }).click();
      await waitForPending(page, "run_sync");
      await resolveControlled(page, "run_sync", hopOutcome(CAM_B));
      await waitForResult(page);

      await expect(page.locator(`.clip[data-file="${CAM_B}"]`)).toHaveCount(0);
      await expect(page.locator(".clip--ghost")).toHaveCount(0);
      expect((await seen(page)).ghosts).toBe(0);
      // It reappears where a file that would not sync belongs: the shelf — which since
      // V06-R2a (D-079) hangs off the strip's problem chip rather than under the timeline.
      await page
        .getByRole("region", { name: en.sourcesTitle })
        .locator(".popover--problems > summary")
        .click();
      await expect(page.getByText(en.unsyncedTitle)).toBeVisible();
    });
  });

  test("every surviving clip joins the number, and starts from where it used to be", async ({
    page,
  }) => {
    await reachSources(page);
    await watchTimeline(page);
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");

    // Camera B is the big traveller: its card claimed +600 s and the audio says +1900 s.
    await resolveControlled(page, "run_sync", hopOutcome());
    await waitForResult(page);

    const observed = await seen(page);
    // ── Re-expressed for D-090, and the change is a decision rather than a repair ──────
    //
    // v0.4 asserted that the clip which did NOT move was absent from this set: a zero delta
    // meant no transition, so there was nothing for it to sit through. Camera A is that
    // clip — it is the anchor of both layouts (the earliest creation stamp before the sync,
    // the earliest offset after it) and so is at timeline zero either way.
    //
    // It joins now, and that is the owner's number: «ting hopper litt rundt på tidslinjen».
    // A clip that stood perfectly still and was already green while the other two shuffled
    // and landed would not read as "this one happened not to move", it would read as the one
    // that failed. What it does instead is shuffle in place and go green with the rest — its
    // delta is zero, which the next assertion states directly, and its wander is not.
    expect(new Set(observed.hopped)).toEqual(new Set([WAV, CAM_A, CAM_B]));
    // …and the two that DID move were genuinely pushed back first. A FLIP whose deltas all
    // came out zero would still add the classes and still end in the right place; only the
    // offset it started from can tell the difference.
    expect(largestDelta(observed.deltas)).toBeGreaterThan(20);

    // Every clip went green, exactly once, by its own landing rather than by a sweep at the
    // end (D-090). This is the observable half of «for så å bli grønne».
    expect(new Set(observed.landed)).toEqual(new Set([WAV, CAM_A, CAM_B]));
    expect(observed.landed).toHaveLength(3);

    // The sequence cleans up after itself: no animations left running, no custom properties,
    // no leftover class on the section.
    await expectNothingLeftOnTheClips(page);
    await expect(page.locator(".timeline")).not.toHaveClass(/timeline--hopping/);
    for (const clip of await clipStates(page)) expect(clip.background).toBe(GREEN);
  });

  test("the clips travel BLUE and land green, each on its own delay", async ({ page }) => {
    // The three owner choices of D-090, caught in flight. Read in ONE round trip a few
    // milliseconds after the outcome lands — no clip can have finished by then (the shortest
    // possible number is 800 ms) — so this is a statement about a state, not about an
    // instant of an animation.
    await reachSources(page);
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await resolveControlled(page, "run_sync", hopOutcome());
    await expect(page.locator(".clip--travelling").first()).toBeAttached();

    const inFlight = await clipStates(page);
    expect(inFlight).toHaveLength(3);
    for (const clip of inFlight) {
      // Blue, and blue because of the travelling class rather than by accident: the placed
      // green is the default for every one of these clips and this is what overrides it.
      expect(clip.hop).toBe(true);
      expect(clip.travelling).toBe(true);
      expect(clip.background).toBe(BLUE);
      // Each carries its own delay, inside the window the band's hold is sized from.
      const delayMs = Number(clip.delay.replace("ms", ""));
      expect(delayMs).toBeGreaterThanOrEqual(0);
      expect(delayMs).toBeLessThanOrEqual(250);
    }
    // A wave, not a queue: if every clip started together the landings would be one clack
    // and the green would arrive as a single flash. Two distinct delays is the weakest form
    // of the claim that survives a fixture of only three clips.
    expect(new Set(inFlight.map((c) => c.delay)).size).toBeGreaterThan(1);
    // The clip that did not move has a zero delta and takes part anyway (see above).
    expect(inFlight.find((c) => c.file === CAM_A)!.dx).toBe("0px");
    expect(inFlight.find((c) => c.file === CAM_B)!.dx).not.toBe("0px");

    // And it ends: the blue is a state with an end, not a repaint.
    await waitForResult(page);
    await expect(page.locator(".clip--travelling")).toHaveCount(0);
    for (const clip of await clipStates(page)) expect(clip.background).toBe(GREEN);
  });

  test("a clip that lost its place fades out instead of blinking away", async ({ page }) => {
    await reachSources(page);
    await watchTimeline(page);
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await resolveControlled(page, "run_sync", hopOutcome(CAM_B));

    // D-090 gave the fade a head start to wait out: the survivors spend the first 280 ms of
    // the number milling about, and a clip that vanished before they had finished doing so
    // was gone before anyone had a reason to look at it. Asserted as the DECLARED delay,
    // which is a discrete fact, rather than by sampling the ghost's opacity at some instant,
    // which is not.
    const ghost = page.locator(`.clip--ghost[data-file="${CAM_B}"]`);
    await expect(ghost).toBeAttached();
    expect(await ghost.evaluate((el) => getComputedStyle(el).animationDelay)).toBe("0.15s");

    await waitForResult(page);
    const observed = await seen(page);
    expect(observed.ghosts).toBe(1);
    // The ghost is scenery and is gone by the time the timeline comes to rest.
    await expect(page.locator(".clip--ghost")).toHaveCount(0);
  });

  test("a gesture takes the view back: panning mid-hop drops every clip on its true position", async ({
    page,
  }) => {
    await reachSources(page);
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await resolveControlled(page, "run_sync", hopOutcome());

    // Catch it in flight, then take the timeline. Waiting for the class rather than for a
    // duration is what keeps this from being a race with a timer.
    await expect(page.locator(".clip--hop").first()).toBeAttached();
    await expect(page.locator(".clip--travelling").first()).toBeAttached();
    const body = page.locator(".timeline__body");
    const box = (await body.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 120));
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 300);
    await page.keyboard.up("Shift");

    // Cancelled on the spot — not merely finished early.
    await expect(page.locator(".timeline")).not.toHaveAttribute("data-hop", /.*/);
    await expectNothingLeftOnTheClips(page);
    // D-090: and the colour goes with it. A cancelled number is a finished number as far as
    // the answer is concerned — the engine placed these files, whether or not the operator
    // watched them arrive — so every clip is green in the frame the gesture landed in, not
    // left blue waiting for an animation that will never end.
    for (const clip of await clipStates(page)) {
      expect(clip.travelling).toBe(false);
      expect(clip.background).toBe(GREEN);
    }

    // And the view stays where the operator left it: the interrupted fit does not creep
    // back afterwards.
    const settled = (await page.locator(`.clip[data-file="${CAM_A}"]`).boundingBox())!.x;
    await page.waitForTimeout(600);
    expect((await page.locator(`.clip[data-file="${CAM_A}"]`).boundingBox())!.x).toBeCloseTo(
      settled,
      0,
    );
  });

  // ── R5: the hop with the tracks SCROLLED (V05-W3) ────────────────────────────────────
  //
  // The vertical safety net wraps the tracks in a scrolling box, which changes the
  // containing block every absolutely-positioned overlay in the timeline resolves against
  // — the fade ghosts included. A ghost placed by arithmetic that did not account for the
  // scroll offset would be drawn `scrollTop` pixels away from the clip it stands in for,
  // and every existing hop assertion would still pass, because they all run at scroll 0.
  test("a fade ghost lands on its clip's box even when the tracks are scrolled", async ({
    page,
  }) => {
    // A tall drop in a short window, so there is genuinely something to scroll: the three
    // fixture devices plus eight more, which is an ordinary church rig and exactly the
    // shape the safety net exists for.
    // V06-R1 (D-074): the room is fixed and the timeline takes what is left of it, so a
    // "tall drop in a short window" is 400 px now — at 560 the eleven tracks would still
    // overflow, but with little enough margin that the test would be measuring the layout's
    // spare change rather than the ghost's arithmetic.
    await page.setViewportSize({ width: 1280, height: 400 });
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: manifestWithFillerDevices(8),
        run_sync: controlled("run_sync"),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(page.locator(".clip")).toHaveCount(11);

    const scroller = page.locator(".timeline__scroll");
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const scrolled = await scroller.evaluate((el) => el.scrollTop);
    expect(scrolled).toBeGreaterThan(0);

    // Where Camera B's box is right now, measured against the SCROLLED track column rather
    // than against the viewport. The column's own top is the right frame of reference here:
    // the note above the frame is a pre-sync line and disappears when the result lands, so
    // viewport coordinates would be comparing two different page layouts. What R5 is about
    // is narrower and this is exactly it — does the ghost land on the clip's box inside the
    // scrolled column, or `scrollTop` pixels away from it?
    const inColumn = async (locator: ReturnType<Page["locator"]>) => {
      const box = (await locator.boundingBox())!;
      const body = (await page.locator(".timeline__body").boundingBox())!;
      return { x: box.x - body.x, y: box.y - body.y };
    };
    const before = await inColumn(page.locator(`.clip[data-file="${CAM_B}"]`));

    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    // Camera B is left unplaced, so it is the clip that fades. The result carries the SAME
    // device list as the scan, so the track column keeps its height and the scroll offset
    // stays where the operator put it.
    await resolveControlled(page, "run_sync", outcomeOverAllDevices(CAM_B));

    const ghost = page.locator(`.clip--ghost[data-file="${CAM_B}"]`);
    await expect(ghost).toBeAttached();
    // Still genuinely scrolled — otherwise everything below is vacuous. Not the SAME number
    // any more, and honestly so: V06-R2a took the unsynced shelf out from under the timeline
    // (D-079) and the pre-sync legend goes when the result lands, so the frame is taller in
    // the result phase and the browser clamps a scroll that was at the old maximum. What this
    // test is about survives that untouched, because `inColumn` measures against
    // `.timeline__body` — which moves WITH the scroll — rather than against the viewport.
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const after = await inColumn(ghost);
    // A ghost layer that did not scroll with the tracks would be off by `scrollTop`, and
    // every other hop assertion in this file would still pass, because they all run at
    // scroll 0.
    expect(after.y).toBeCloseTo(before.y, 0);
    expect(after.x).toBeCloseTo(before.x, 0);

    // …and it still cleans up after itself.
    await waitForResult(page);
    await expect(page.locator(".clip--ghost")).toHaveCount(0);
  });
});
