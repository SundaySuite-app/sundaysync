import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  controlled,
  emit,
  fn,
  rejectControlled,
  resolveControlled,
  presyncScanManifest,
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

// ── Blue = analysed (V06-R0, D-080) ─────────────────────────────────────────────────────
//
// The waveform appearing already said "this file is ready" — to anyone looking at THAT
// clip, zoomed in far enough for a waveform to be more than a smear. At the zoom a card
// dump is actually read at, a 3 px box has no waveform to notice and no room for a word,
// and the operator's question is about the whole drop rather than about one file: how far
// has this got? Grey → blue → green answers it at any zoom and from across the room.
//
// What these two prove is that the mark is per-FILE (the whole reason `prewarm:file` is a
// per-file event) and that it is not colour-only.
test.describe("a clip goes blue when its own analysis lands", () => {
  test("a clip turns blue the moment its own file is reported", async ({ page }) => {
    await reachSources(page, {
      ...prewarmHeld(),
      run_sync: syncOutcome(),
      waveform_meta: waveformMetaCacheMissingThenOk(),
      waveform_level: waveformLevelOk(),
    });
    await waitForPending(page, "prewarm_analysis");

    // Nothing has been reported yet: every box is the neutral pre-sync slate.
    await expect(clip(page, CAM_A)).toHaveClass(/clip--pre/);
    await expect(clip(page, CAM_A)).not.toHaveClass(/clip--analysed/);
    await expect(clip(page, WAV)).not.toHaveClass(/clip--analysed/);

    await emit(page, "prewarm:file", { file: CAM_A, ok: true });

    // One file, one clip. The other is still grey — a pass that turned the whole timeline
    // blue at the end would be the "all at once" behaviour D-062 replaced.
    await expect(clip(page, CAM_A)).toHaveClass(/clip--analysed/);
    await expect(clip(page, CAM_A)).toHaveClass(/clip--pre/);
    await expect(clip(page, WAV)).not.toHaveClass(/clip--analysed/);

    // A file that would not decode wrote nothing, so there is nothing to be blue about —
    // §7.2's "a bad file is a value": it goes back to the ordinary cache-missing state
    // (proved above), and it must not pick up the mark on the way.
    await emit(page, "prewarm:file", { file: WAV, ok: false });
    await expect(clip(page, WAV).getByRole("button", { name: en.waveformRegenerate })).toBeVisible();
    await expect(clip(page, WAV)).not.toHaveClass(/clip--analysed/);
    await expect(clip(page, CAM_A)).toHaveClass(/clip--analysed/);

    // And the moment the engine has placed them, blue has nothing left to say: every drawn
    // clip has been analysed, and a colour every box wears is not a colour. `sync/done`
    // empties the prewarm map and enters the result phase in ONE dispatch, so this is the
    // same commit that turns the boxes green — never a frame of one on the way to the
    // other.
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);
    await expect(page.locator(".clip--analysed")).toHaveCount(0);
    await expect(page.locator(".clip--pre")).toHaveCount(0);
  });

  test("the blue is in the accessible name too, not only in the pixels", async ({ page }) => {
    // §9.4's rule about the clip's name: a claim the app makes in colour is a claim it owes
    // in words. Appended to the pre-sync sentence rather than replacing it — where the
    // start came from is still the more important half.
    await reachSources(page, {
      ...prewarmHeld(),
      waveform_meta: waveformMetaCacheMissingThenOk(),
      waveform_level: waveformLevelOk(),
    });
    await waitForPending(page, "prewarm_analysis");

    // `scanManifest()`'s files carry no `creation_time`, so both clips are placed by
    // filename order and say so (D-068).
    const bare = `C0001.MP4, ${en.presyncSourceNone}`;
    await expect(clip(page, CAM_A)).toHaveAttribute("aria-label", bare);

    await emit(page, "prewarm:file", { file: CAM_A, ok: true });

    await expect(clip(page, CAM_A)).toHaveAttribute(
      "aria-label",
      `${bare} — ${en.presyncAnalysed}`,
    );
    await expect(clip(page, WAV)).toHaveAttribute(
      "aria-label",
      `ZOOM0001.WAV, ${en.presyncSourceNone}`,
    );
  });
});

/** The known-good pre-sync drop (`presyncScanManifest`: two cameras with real container
 *  stamps ten minutes apart and a recorder WAV with none — so `clip--seq`, D-068) plus one
 *  stray file stamped a day that is not this session's (`clip--offsession`, D-071). Between
 *  them the three files wear every provenance mark a pre-sync clip can wear. */
const PLAIN = "/Users/e2e/shoot/CamA/C0001.MP4";
const NOCLOCK = "/Users/e2e/shoot/ZOOM0001.WAV";
const STRAY = "/Users/e2e/shoot/CamC/C0003.MP4";

function provenanceManifest(): Record<string, unknown> {
  const base = presyncScanManifest();
  return {
    ...base,
    devices: [
      ...(base.devices as Record<string, unknown>[]),
      { id: "cam-c", label: "Camera C", kind: "video", files: [STRAY] },
    ],
    files: [
      ...(base.files as Record<string, unknown>[]),
      {
        file: STRAY,
        device: "cam-c",
        duration_seconds: 1800,
        format_name: "mov,mp4",
        audio: { codec: "aac", sample_rate: 48000, channels: 2 },
        video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
        creation_time: "1970-01-01T00:00:00.000Z",
      },
    ],
  };
}

async function boxStyle(page: Page, file: string) {
  return page.evaluate((f) => {
    const s = getComputedStyle(document.querySelector(`.clip[data-file="${f}"]`)!);
    return {
      background: s.backgroundColor,
      color: s.color,
      borderColor: s.borderTopColor,
      borderStyle: s.borderTopStyle,
      borderLeftWidth: s.borderLeftWidth,
    };
  }, file);
}

test.describe("the blue and the provenance marks divide the box between them", () => {
  test("the fill and the ink turn blue; the edge keeps saying where the position came from", async ({
    page,
  }) => {
    // The bug this exists for: `clip--seq` and `clip--offsession` set a fill and an ink of
    // their own, so a rule that relied on source order alone left a clip with NO recording
    // time grey however far its analysis had got — silently excluding the very drops D-068
    // is about, and (worse) leaving `--text3` bars on a blue box everywhere it did apply.
    // The ink is what `drawWaveform` paints the waveform in, so this is legibility, not
    // decoration.
    await reachSources(page, {
      ...prewarmHeld(),
      scan_inputs: provenanceManifest(),
      waveform_meta: waveformMetaCacheMissingThenOk(),
      waveform_level: waveformLevelOk(),
    });
    await waitForPending(page, "prewarm_analysis");
    await expect(clip(page, NOCLOCK)).toHaveClass(/clip--seq/);
    await expect(clip(page, STRAY)).toHaveClass(/clip--offsession/);

    const strayBefore = await boxStyle(page, STRAY);
    for (const f of [PLAIN, NOCLOCK, STRAY]) await emit(page, "prewarm:file", { file: f, ok: true });
    await expect(clip(page, NOCLOCK)).toHaveClass(/clip--analysed/);

    const BLUE_WASH = "rgba(79, 142, 247, 0.32)";
    const BLUE_INK = "rgb(219, 231, 255)";
    for (const f of [PLAIN, NOCLOCK, STRAY]) {
      const s = await boxStyle(page, f);
      expect(s.background, `${f} fill`).toBe(BLUE_WASH);
      expect(s.color, `${f} ink`).toBe(BLUE_INK);
    }

    // …and every edge still says exactly what it said before the analysis landed: the
    // stray file's amber dashed border (D-071) and the clockless one's thickened leading
    // edge (D-068) are claims about the POSITION, which nothing here has changed.
    const stray = await boxStyle(page, STRAY);
    expect(stray.borderColor).toBe(strayBefore.borderColor);
    expect(stray.borderStyle).toBe("dashed");
    expect((await boxStyle(page, NOCLOCK)).borderLeftWidth).toBe("3px");
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
