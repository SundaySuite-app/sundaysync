import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  controlled,
  emit,
  fn,
  rejectControlled,
  resolveControlled,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForPending,
  waitForResult,
  type Fixtures,
} from "./harness";
import { en } from "../src/i18n";

// Background pre-analysis, wired to the UI (V04-U4, D-062; engine D-059) — the owner's
// ask: "programmet kan også begynne å analysere audio med en gang filene blir lagt inn
// slik at det ikke tar så lang tid i selve syncen."
//
// The backend has been able to do this since U2 and nothing called it. What a browser
// proves that the Rust tests cannot:
//   1. The pass is actually started off the back of a scan, with the scanned files.
//   2. It is genuinely fire-and-forget. A `busy:` refusal is EXPECTED (D-046) and must
//      leave no mark at all — no banner, no error state, no stuck clip.
//   3. A clip's waveform appears the moment ITS file is reported, not after the lot.
//   4. Pressing Sync mid-pass is instant. The backend preempts the prewarm (D-059,
//      `run_sync_preempts_a_running_prewarm`); the frontend must not be waiting on the
//      prewarm's promise before it lets the sync start, and the abandoned pass's
//      "cancelled" rejection must stay as invisible as a busy one.

const WAV = "/Users/e2e/shoot/ZOOM0001.WAV";
const CAM_A = "/Users/e2e/shoot/CamA/C0001.MP4";

/** Matches `scanManifest()`'s longest duration at the fixed 12 kHz analysis rate — see
 *  waveform.spec.ts's header for why the ladder is inlined as source text. */
const TOTAL_SAMPLES = 12_000 * 3600;
const LEVELS_EXPR =
  `Array.from({ length: 13 }, (_, i) => { ` +
  `const binSamples = 120 * Math.pow(2, i); ` +
  `return { binSamples, bins: Math.ceil(${TOTAL_SAMPLES} / binSamples) }; })`;

/** A cache that has nothing for a file until the pre-analysis has written it: the first
 *  read per file is a `cache_missing`, every later one succeeds. Exactly what a clip that
 *  mounted before its turn in the queue meets. */
function waveformMetaCacheMissingThenOk(): unknown {
  return fn(`(() => {
    const seen = new Set();
    return (args) => {
      if (!seen.has(args.file)) {
        seen.add(args.file);
        return Promise.reject("cache_missing:" + args.file);
      }
      return { totalSamples: ${TOTAL_SAMPLES}, levels: ${LEVELS_EXPR} };
    };
  })()`);
}

/** Never written at all — the state a clip is left in when the pass never reaches it. */
function waveformMetaAlwaysCacheMissing(): unknown {
  return fn(`(args) => Promise.reject("cache_missing:" + args.file)`);
}

/** Empty until the run writes it (V05-W1, D-064): `cache_missing` for as long as
 *  `__E2E_ANALYSIS_WRITTEN__` is unset, and a real pyramid afterwards. What a sync actually
 *  does to a cold cache — it extracts the analysis audio for every file in the run — and
 *  therefore the state a clip must be able to notice without being reloaded. */
function waveformMetaWrittenByTheRun(): unknown {
  return fn(`(args) => {
    if (!window.__E2E_ANALYSIS_WRITTEN__) return Promise.reject("cache_missing:" + args.file);
    return { totalSamples: ${TOTAL_SAMPLES}, levels: ${LEVELS_EXPR} };
  }`);
}

/** A barrier that guarantees any promise settlement already queued has been processed AND
 *  React has rendered whatever it caused — two frames, no arbitrary timeout. Needed only
 *  where the assertion is that something did NOT appear: `toHaveCount(0)` is true before a
 *  regression has had a chance to happen, which is exactly how the storm below went
 *  unnoticed by a suite that already covered this flow. */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

function waveformLevelOk(): unknown {
  return fn(`(args) => {
    const levels = ${LEVELS_EXPR};
    const lvl = levels[args.level];
    const bytes = new Uint8Array(lvl.bins * 2);
    for (let i = 0; i < lvl.bins; i += 1) {
      bytes[i * 2] = 200;
      bytes[i * 2 + 1] = 120;
    }
    return bytes.buffer;
  }`);
}

/** Records the args of every `prewarm_analysis`, and keeps the pass OPEN — the state the
 *  app is in for the whole time the operator is reading the sources list. */
function prewarmHeld(): Fixtures {
  return {
    prewarm_analysis: fn(`(args) => {
      window.__E2E_PREWARM_ARGS__ = args;
      return new Promise((resolve, reject) => {
        window.__SUNDAYSYNC_PENDING__ = window.__SUNDAYSYNC_PENDING__ || {};
        window.__SUNDAYSYNC_PENDING__["prewarm_analysis"] = { resolve, reject, args };
      });
    }`),
  };
}

/** Counts `cancel_prewarm` calls. */
function cancelPrewarmSpy(): Fixtures {
  return {
    cancel_prewarm: fn(`() => {
      window.__E2E_CANCEL_PREWARM__ = (window.__E2E_CANCEL_PREWARM__ || 0) + 1;
      return undefined;
    }`),
  };
}

async function reachSources(page: Page, fixtures: Fixtures = {}) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: scanManifest(),
      ...fixtures,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeVisible();
}

function clip(page: Page, file: string) {
  return page.locator(`.clip[data-file="${file}"]`);
}

test.describe("the pass starts on its own", () => {
  test("a finished scan hands its files straight to prewarm_analysis", async ({ page }) => {
    await reachSources(page, prewarmHeld());

    await expect
      .poll(async () =>
        page.evaluate(() => (window as unknown as Record<string, any>).__E2E_PREWARM_ARGS__),
      )
      .toEqual({ files: [WAV, CAM_A], cacheDir: null });
  });

  // V04-U5 QA. `prewarm_analysis` takes the D-046 activity slot with the ordinary guard,
  // so only a `run_sync` can take it away (D-059) — which meant a SECOND folder dropped
  // mid-pass had its own pass refused `busy:` and silently swallowed. The new drop then got
  // no background analysis at all, while the abandoned pass carried on reading the old
  // folder off the NAS. Nothing on either side of that seam was wrong on its own.
  test("a second drop stops the pass running against the first", async ({ page }) => {
    await reachSources(page, { ...prewarmHeld(), ...cancelPrewarmSpy() });
    await waitForPending(page, "prewarm_analysis");
    expect(
      await page.evaluate(() => (window as unknown as Record<string, any>).__E2E_CANCEL_PREWARM__),
    ).toBeUndefined();

    // A second folder goes in. The scan for it has not finished yet — the cancel must not
    // wait for that, or the old pass keeps the slot right through the probe and the new
    // pass arrives to find it taken.
    await page.getByRole("button", { name: en.dropFolder }).click();

    await expect
      .poll(async () =>
        page.evaluate(() => (window as unknown as Record<string, any>).__E2E_CANCEL_PREWARM__),
      )
      .toBe(1);
  });

  test("clearing the sources stops it", async ({ page }) => {
    // The pass is speculative work on a drop that no longer exists. Leaving it running
    // would keep decoding a card the operator has just put away.
    await reachSources(page, { ...prewarmHeld(), ...cancelPrewarmSpy() });
    await waitForPending(page, "prewarm_analysis");

    await page.locator(".roots .root button").click();
    await expect(page.getByRole("button", { name: en.dropAction })).toBeVisible();

    await expect
      .poll(async () =>
        page.evaluate(() => (window as unknown as Record<string, any>).__E2E_CANCEL_PREWARM__),
      )
      .toBe(1);
  });
});

test.describe("it is fire-and-forget", () => {
  test("a busy refusal leaves no mark anywhere", async ({ page }) => {
    // D-046's refusal is the EXPECTED answer when a cache sweep or a sync already holds
    // the slot, and prewarming is an optimisation — the sync does the same extraction
    // itself. Anything on screen here would be the app apologising for a non-event.
    await reachSources(page, {
      prewarm_analysis: fn(`(args) => Promise.reject("busy: cache maintenance in progress")`),
      waveform_meta: waveformMetaAlwaysCacheMissing(),
      waveform_level: waveformLevelOk(),
    });

    await expect(page.locator(".banner")).toHaveCount(0);
    await expect(page.getByText(en.errUnknown("busy: cache maintenance in progress"))).toHaveCount(0);
    // And no clip is left waiting on a pass that never ran: the ordinary cache-miss
    // affordance is back, which is the right offer once nothing is going to write it.
    await expect(
      clip(page, CAM_A).getByRole("button", { name: en.waveformRegenerate }),
    ).toBeVisible();
    await expect(clip(page, CAM_A).getByText(en.waveformAnalysing)).toHaveCount(0);
  });

  test("pressing Sync mid-pass starts the sync at once, and the abandoned pass is silent", async ({
    page,
  }) => {
    // The frontend half of D-059's preemption. The engine takes the slot off the prewarm
    // (proved in `run_sync_preempts_a_running_prewarm`); what a browser proves is that
    // the UI never waits for the prewarm to let go, and that the "cancelled" the
    // superseded pass rejects with is not shown to anyone.
    await reachSources(page, {
      ...prewarmHeld(),
      run_sync: controlled("run_sync"),
      waveform_meta: waveformMetaAlwaysCacheMissing(),
      waveform_level: waveformLevelOk(),
    });
    await waitForPending(page, "prewarm_analysis");

    await page.getByRole("button", { name: en.syncButton }).click();
    // No cancel_prewarm handshake, no wait: `run_sync` is in flight while the prewarm's
    // promise is still open.
    await waitForPending(page, "run_sync");
    await expect(page.locator(".progress__label")).toHaveText(en.syncing);

    // ── THE regression (V05-W1, D-064) ──────────────────────────────────────────────
    //
    // This test existed and passed while the owner's 386-file wedding showed a «Bygg
    // bølgeform på nytt» button on every single clip, because "silent" was only ever
    // checked as "no banner". The pass is preempted; its promise REJECTS with the engine's
    // cancellation; `.catch(() => {})` swallowed that and `.then(…)` still reported the
    // pass as finished — so every file still pending was declared `failed`, and `failed`
    // falls straight through to the cache-missing branch. A rebuild control on all 386,
    // offering an action that could only earn a busy refusal, for work the sync in front of
    // it was already doing.
    //
    // What the clips must say while the run analyses them is what is true: they are being
    // analysed.
    await expect(clip(page, CAM_A).getByText(en.waveformAnalysing)).toBeVisible();
    await expect(clip(page, WAV).getByText(en.waveformAnalysing)).toBeVisible();
    await expect(page.locator(".waveform__regenerate")).toHaveCount(0);

    // Now the preempted pass unwinds, exactly as the engine makes it — and its dying words
    // change nothing, because a cancelled pass has no verdict to hand down.
    await rejectControlled(page, "prewarm_analysis", "cancelled");
    await settleFrames(page);
    await expect(page.locator(".banner")).toHaveCount(0);
    await expect(page.locator(".waveform__regenerate")).toHaveCount(0);
    await expect(clip(page, CAM_A).getByText(en.waveformAnalysing)).toBeVisible();

    await resolveControlled(page, "run_sync", syncOutcome());
    await waitForResult(page);
    await expect(page.locator(".banner")).toHaveCount(0);
  });

  test("a busy refusal mid-sync leaves the clips saying they are being analysed", async ({
    page,
  }) => {
    // The other shape of the same ending: the operator presses Sync in the window between
    // the scan landing and the prewarm effect firing, so `prewarm_analysis` never runs at
    // all — the D-046 guard refuses it outright. Nothing was pre-analysed and nothing
    // failed; the sync is doing the work. A refusal is not a verdict either.
    await reachSources(page, {
      prewarm_analysis: fn(`(args) => Promise.reject("busy: sync in progress")`),
      run_sync: controlled("run_sync"),
      waveform_meta: waveformMetaAlwaysCacheMissing(),
      waveform_level: waveformLevelOk(),
    });

    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await settleFrames(page);

    await expect(clip(page, CAM_A).getByText(en.waveformAnalysing)).toBeVisible();
    await expect(page.locator(".waveform__regenerate")).toHaveCount(0);
  });
});

test.describe("the run is the analysis, and the clips read it when it lands", () => {
  test("the waveforms the sync built appear without a reload", async ({ page }) => {
    // The owner's second sentence: "even after the sync finished, no waveforms appeared."
    // Not a separate feature — the same bug's tail. The prewarm map was never cleared and
    // `WaveformCanvas`'s only re-read trigger was `pending → ready`, so every clip went on
    // replaying the `cache_missing` rejection it had cached before the run — the run that
    // had just written the very entries it was rejecting for.
    await reachSources(page, {
      ...prewarmHeld(),
      run_sync: controlled("run_sync"),
      waveform_meta: waveformMetaWrittenByTheRun(),
      waveform_level: waveformLevelOk(),
    });
    await waitForPending(page, "prewarm_analysis");
    // Cold cache: nothing to draw, and the clip says so in the only way that is true while
    // a pass is on it.
    await expect(clip(page, CAM_A).getByText(en.waveformAnalysing)).toBeVisible();

    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await rejectControlled(page, "prewarm_analysis", "cancelled");

    // The run does what a run does: it extracts every file's analysis into the cache.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__E2E_ANALYSIS_WRITTEN__ = true;
    });
    await resolveControlled(page, "run_sync", syncOutcome());
    await waitForResult(page);

    // And every clip goes back and looks, exactly once. No reload, no re-sync, nothing to
    // press.
    await expect(clip(page, CAM_A).locator(".clip__waveform canvas")).toBeVisible();
    await expect(page.locator(".waveform__regenerate")).toHaveCount(0);
    await expect(clip(page, CAM_A).getByText(en.waveformAnalysing)).toHaveCount(0);
  });
});

test.describe("waveforms arrive one file at a time", () => {
  test("a clip waits without offering a rebuild, then draws when its file is reported", async ({
    page,
  }) => {
    await reachSources(page, {
      ...prewarmHeld(),
      waveform_meta: waveformMetaCacheMissingThenOk(),
      waveform_level: waveformLevelOk(),
    });
    await waitForPending(page, "prewarm_analysis");

    // While the pass has this file: a status, not an offer. `regenerate_analysis` does not
    // preempt a prewarm (D-059), so the button could only earn a busy refusal — and the
    // bytes it would rebuild are being written right now.
    const waiting = clip(page, CAM_A);
    await expect(waiting.getByText(en.waveformAnalysing)).toBeVisible();
    await expect(waiting.getByRole("button", { name: en.waveformRegenerate })).toHaveCount(0);
    await expect(waiting.locator(".clip__waveform canvas")).toHaveCount(0);

    // One file finishes. Its clip re-reads and draws; the other is still waiting, which is
    // the whole point of a per-file event rather than one at the end.
    await emit(page, "prewarm:file", { file: CAM_A, ok: true });

    await expect(clip(page, CAM_A).locator(".clip__waveform canvas")).toBeVisible();
    await expect(clip(page, CAM_A).getByText(en.waveformAnalysing)).toHaveCount(0);
    await expect(clip(page, WAV).getByText(en.waveformAnalysing)).toBeVisible();
  });

  test("a file that would not decode gets the rebuild control back", async ({ page }) => {
    await reachSources(page, {
      ...prewarmHeld(),
      waveform_meta: waveformMetaAlwaysCacheMissing(),
      waveform_level: waveformLevelOk(),
    });
    await waitForPending(page, "prewarm_analysis");
    await expect(clip(page, CAM_A).getByText(en.waveformAnalysing)).toBeVisible();

    await emit(page, "prewarm:file", { file: CAM_A, ok: false });

    // §7.2: a bad file is a value, not a failure of the pass. It stops being a wait and
    // becomes the ordinary cache-missing state, where a rebuild IS the right offer.
    await expect(
      clip(page, CAM_A).getByRole("button", { name: en.waveformRegenerate }),
    ).toBeVisible();
  });
});

test.describe("the aggregate tick is quiet and separate", () => {
  test("prewarm:progress drives its own line, never the scan/sync progress bar", async ({
    page,
  }) => {
    await reachSources(page, prewarmHeld());
    await waitForPending(page, "prewarm_analysis");

    await emit(page, "prewarm:progress", { stage: "Extracting", completed: 1, total: 2 });

    const panel = page.getByRole("region", { name: en.sourcesTitle });
    await expect(panel.locator(".prewarm")).toHaveText(en.prewarmProgress(1, 2));
    // The ProgressBar belongs to things the operator is WAITING for. Dressing speculative
    // background work as one of those would say the app is busy when it is not.
    await expect(page.locator(".progress__label")).toHaveCount(0);
    await expect(page.getByRole("progressbar")).toHaveCount(0);

    await emit(page, "prewarm:progress", { stage: "Extracting", completed: 2, total: 2 });
    await expect(panel.locator(".prewarm")).toHaveText(en.prewarmProgress(2, 2));

    // When the pass ends the line goes away entirely — it is not a summary, it is a tick.
    await resolveControlled(page, "prewarm_analysis", undefined);
    await expect(panel.locator(".prewarm")).toHaveCount(0);
  });
});
