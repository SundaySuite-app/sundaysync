import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  controlled,
  emit,
  fn,
  pcmWindow,
  presyncScanManifest,
  rejectControlled,
  resolveControlled,
  scanManifest,
  SETTINGS_KEY,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForPending,
  waitForResult,
  type Fixtures,
} from "./harness";
import { en, formatBytes, nb } from "../src/i18n";

/**
 * The control-by-control acceptance sweep of «Ett rom» (v0.6.0-beta.1).
 *
 * Every other spec in this suite is about a *journey* — drop a card, run a sync, read the
 * result — and each one presses the handful of controls its journey needs. This one is about
 * the **inventory**: every interactive thing the app can put on screen, in every phase, is
 * pressed here at least once, and what it is supposed to do is asserted as an OBSERVABLE
 * effect — a state change, a DOM change, or the arguments of the backend call it makes.
 *
 * It exists because "does every button work?" is a question with a finite answer, and the
 * only honest way to keep answering it after a redesign that moved every control in the app
 * is to write the enumeration down and run it. Where an assertion here duplicates one in a
 * journey spec that is deliberate: a sweep with holes in it is worth less than no sweep,
 * because it reads as coverage.
 *
 * ## What this tier can and cannot prove
 *
 * Chromium, with `window.__TAURI_INTERNALS__` supplied by `harness.ts`. So:
 *
 *   - **A control whose effect is a backend call is proved by the recorded call.** `spy()`
 *     below records the args of any command; asserting them IS the proof that the button
 *     reached the engine with the right request. What the engine then does is the Rust
 *     tier's business (`crates/`), not this one's.
 *   - **The native dialogs are not opened.** `plugin:dialog|open`/`|save` are commands like
 *     any other, and what is asserted is the OPTIONS the app asks for — `directory: true`
 *     for a folder chooser, the `.fcpxml` filter for the export — plus what the app does
 *     with the answer, cancellation included.
 *   - **Nothing here is heard.** The transport's effect is read off the engine's schedule
 *     mirror (`window.__SUNDAYSYNC_AUDIO__`), the same boundary `playback.spec.ts` draws.
 *   - **This is not the shipped webview.** The app runs in WKWebView (macOS) and WebView2
 *     (Windows); Chromium is the closest available stand-in. A control that works here can
 *     still meet a platform bug there, which is what the rig test is for.
 */

// ── Recording what a control actually asked the backend for ────────────────────────────
//
// The harness answers commands from a fixture table but does not record them. `spy()` wraps
// one command so every call's args land on `window.__E2E_CALLS__[cmd]`, in order, while
// still answering with whatever the journey needs — the same window-recording pattern
// `consentSetSpy` and `inspector-actions.spec.ts` already use, generalised so a sweep can
// point it at any command without a bespoke fixture per button.

/** `cmd` answered with `resultExpr` (a JS expression evaluated in the page), args recorded. */
function spy(cmd: string, resultExpr = "undefined"): Fixtures {
  return {
    [cmd]: fn(`(args) => {
      const w = window;
      w.__E2E_CALLS__ = w.__E2E_CALLS__ || {};
      const key = ${JSON.stringify(cmd)};
      (w.__E2E_CALLS__[key] = w.__E2E_CALLS__[key] || []).push(args === undefined ? null : args);
      return (${resultExpr});
    }`),
  };
}

/** Every call made to `cmd` so far, in order. */
async function calls(page: Page, cmd: string): Promise<Record<string, any>[]> {
  return page.evaluate(
    (c) => ((window as unknown as Record<string, any>).__E2E_CALLS__?.[c] ?? []) as unknown[],
    cmd,
  ) as Promise<Record<string, any>[]>;
}

/**
 * `plugin:dialog|open` answering a DIFFERENT thing each time it is asked, args recorded.
 *
 * Several sweeps need the chooser to answer one folder on the way in and something else on
 * the control actually under test — a second root, or a cancellation. The last answer repeats
 * for any further calls.
 */
function dialogOpenSequence(answers: unknown[]): Fixtures {
  return {
    "plugin:dialog|open": fn(`(args) => {
      const w = window;
      w.__E2E_CALLS__ = w.__E2E_CALLS__ || {};
      const key = "plugin:dialog|open";
      const log = (w.__E2E_CALLS__[key] = w.__E2E_CALLS__[key] || []);
      log.push(args === undefined ? null : args);
      const answers = ${JSON.stringify(answers)};
      const i = log.length - 1;
      return i < answers.length ? answers[i] : answers[answers.length - 1];
    }`),
  };
}

/** The single call `cmd` has received — fails loudly if it was called 0 or 2+ times. */
async function onlyCall(page: Page, cmd: string): Promise<Record<string, any>> {
  const all = await calls(page, cmd);
  expect(all, `${cmd} call count`).toHaveLength(1);
  return all[0];
}

const WAV = "/Users/e2e/shoot/ZOOM0001.WAV";
const CAM_A = "/Users/e2e/shoot/CamA/C0001.MP4";
const CAM_B = "/Users/e2e/shoot/CamB/C0002.MP4";
const SHOOT = "/Users/e2e/shoot";
const FCPXML = "/Users/e2e/out/SundaySync.fcpxml";

const sources = (page: Page) => page.getByRole("region", { name: en.sourcesTitle });
const inspector = (page: Page) => page.locator(".inspector");
const strip = (page: Page) => page.locator(".app__header");
const timeline = (page: Page) => page.locator(".timeline");

/** The width of a clip box, in CSS px — the observable every zoom/pan control moves. */
async function clipWidth(page: Page, file = CAM_A): Promise<number> {
  return page
    .locator(`.clip[data-file="${file}"]`)
    .evaluate((el) => el.getBoundingClientRect().width);
}

async function clipLeft(page: Page, file = CAM_A): Promise<number> {
  return page
    .locator(`.clip[data-file="${file}"]`)
    .evaluate((el) => el.getBoundingClientRect().x);
}

async function bootEmpty(page: Page, fixtures: Fixtures = {}): Promise<void> {
  await boot(page, {
    fixtures: { ...BOOT_FIXTURES, ...fixtures },
    settings: SETTLED_SETTINGS,
  });
}

/** Drop a folder through the chooser and land in the sources phase. */
async function reachSources(
  page: Page,
  fixtures: Fixtures = {},
  manifest: Record<string, unknown> = presyncScanManifest(),
): Promise<void> {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": [SHOOT],
      scan_inputs: manifest,
      ...fixtures,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(sources(page)).toBeVisible();
}

/** …and press Sync, landing on a settled result. */
async function reachResult(
  page: Page,
  fixtures: Fixtures = {},
  manifest: Record<string, unknown> = scanManifest(),
): Promise<void> {
  await reachSources(page, { run_sync: syncOutcome(), ...fixtures }, manifest);
  await page.getByRole("button", { name: en.syncButton }).click();
  await waitForResult(page);
}

/** Two devices with a placement each — what mute/solo needs to have two buses to move. */
function twoDeviceOutcome(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base = syncOutcome();
  const placement = (file: string, device: string, offset: number) => ({
    file,
    device,
    offset_seconds: offset,
    confidence: 0.95,
    psr: 38.4,
    drift_ppm: null,
    projected_end_error_ms: null,
    chain: [],
    warnings: [],
  });
  return {
    ...base,
    result: {
      ...(base.result as Record<string, unknown>),
      placements: [placement(WAV, "rec", 0), placement(CAM_A, "cam-a", 4.2)],
      ...over,
    },
  };
}

const audio = (page: Page) =>
  page.evaluate(() => (window as unknown as Record<string, any>).__SUNDAYSYNC_AUDIO__);

// ═══════════════════════════════════════════════════════════════════════════════════════
// EMPTY PHASE
// ═══════════════════════════════════════════════════════════════════════════════════════

test.describe("empty phase", () => {
  test("«Choose files» asks the OS for FILES, and what comes back is scanned", async ({
    page,
  }) => {
    await bootEmpty(page, {
      ...spy("plugin:dialog|open", JSON.stringify([CAM_A, WAV])),
      ...spy("scan_inputs", JSON.stringify(scanManifest())),
    });

    await page.getByRole("button", { name: en.dropAction }).click();

    // The request: a multi-select FILE picker — no `directory`.
    const dialog = await onlyCall(page, "plugin:dialog|open");
    expect(dialog.options).toMatchObject({ multiple: true });
    expect(dialog.options.directory).toBeFalsy();

    // …and the answer became the scan's inputs, verbatim.
    await expect(sources(page)).toBeVisible();
    expect((await onlyCall(page, "scan_inputs")).inputs).toEqual([CAM_A, WAV]);
  });

  test("«Choose folder» asks for a DIRECTORY", async ({ page }) => {
    await bootEmpty(page, {
      ...spy("plugin:dialog|open", JSON.stringify([SHOOT])),
      scan_inputs: scanManifest(),
    });

    await page.getByRole("button", { name: en.dropFolder }).click();

    expect((await onlyCall(page, "plugin:dialog|open")).options).toMatchObject({
      directory: true,
      multiple: true,
    });
    await expect(sources(page)).toBeVisible();
  });

  test("cancelling the chooser changes nothing at all", async ({ page }) => {
    await bootEmpty(page, {
      "plugin:dialog|open": null,
      ...spy("scan_inputs", JSON.stringify(scanManifest())),
    });

    await page.getByRole("button", { name: en.dropFolder }).click();
    await page.getByRole("button", { name: en.dropAction }).click();

    expect(await calls(page, "scan_inputs")).toHaveLength(0);
    await expect(page.locator(".empty")).toBeVisible();
    await expect(sources(page)).toBeHidden();
  });

  test("the drag-drop events: over marks the zone, drop scans, leave clears it", async ({
    page,
  }) => {
    await bootEmpty(page, { ...spy("scan_inputs", JSON.stringify(scanManifest())) });
    const zone = page.locator(".dropzone");

    await emit(page, "tauri://drag-over", { position: { x: 10, y: 10 } });
    await expect(zone).toHaveClass(/dropzone--over/);
    await emit(page, "tauri://drag-leave", {});
    await expect(zone).not.toHaveClass(/dropzone--over/);
    expect(await calls(page, "scan_inputs")).toHaveLength(0);

    await emit(page, "tauri://drag-over", { position: { x: 10, y: 10 } });
    await emit(page, "tauri://drag-drop", { paths: [SHOOT], position: { x: 10, y: 10 } });

    await expect(sources(page)).toBeVisible();
    expect((await onlyCall(page, "scan_inputs")).inputs).toEqual([SHOOT]);
    // The hover state is released by the drop itself, not left painted on the strip's zone.
    await expect(page.locator(".dropzone")).not.toHaveClass(/dropzone--over/);
  });

  test("a drop of NOTHING is not a drop", async ({ page }) => {
    await bootEmpty(page, { ...spy("scan_inputs", JSON.stringify(scanManifest())) });

    await emit(page, "tauri://drag-drop", { paths: [], position: { x: 1, y: 1 } });

    expect(await calls(page, "scan_inputs")).toHaveLength(0);
    await expect(page.locator(".empty")).toBeVisible();
  });

  test("the gear opens Settings, and its ✕ closes it again", async ({ page }) => {
    await bootEmpty(page);

    await strip(page).getByRole("button", { name: en.settings }).click();
    const dialog = page.getByRole("dialog", { name: en.settings });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: en.close }).click();
    await expect(dialog).toBeHidden();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ONBOARDING + CONSENT — the two dialogs the empty phase can open on its own
// ═══════════════════════════════════════════════════════════════════════════════════════

test.describe("onboarding dialog", () => {
  /** First run: `onboardingDone` unset, language still pinned so the strings are known. */
  const firstRun = { lang: "en" as const };

  test("every nav control moves the step, and the dots follow it", async ({ page }) => {
    await boot(page, { fixtures: BOOT_FIXTURES, settings: firstRun });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const activeDot = () => page.locator(".onboarding__dot--active");
    const current = () => page.locator('.onboarding__dot[aria-current="step"]');
    await expect(page.locator(".onboarding__dot")).toHaveCount(3);
    await expect(activeDot()).toHaveCount(1);
    await expect(page.getByRole("heading", { name: en.obTitle1 })).toBeVisible();
    // Step 1 has no Back — there is nowhere behind it.
    await expect(dialog.getByRole("button", { name: en.obBack })).toHaveCount(0);

    await dialog.getByRole("button", { name: en.obNext }).click();
    await expect(page.getByRole("heading", { name: en.obTitle2 })).toBeVisible();
    await expect(current()).toHaveCount(1);

    await dialog.getByRole("button", { name: en.obBack }).click();
    await expect(page.getByRole("heading", { name: en.obTitle1 })).toBeVisible();

    await dialog.getByRole("button", { name: en.obNext }).click();
    await dialog.getByRole("button", { name: en.obNext }).click();
    await expect(page.getByRole("heading", { name: en.obTitle3 })).toBeVisible();
    // Last step: Next has become the finishing button.
    await expect(dialog.getByRole("button", { name: en.obNext })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: en.obDone })).toBeVisible();
  });

  test("step 3 self-tests the engine, and «Check again» re-runs it", async ({ page }) => {
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        ...spy("check_sidecar", `(() => {
          if (!window.__E2E_SIDECAR_FIXED__) throw "ffmpeg sidecar unavailable: broken install";
          return { source: "bundled", path: "/Applications/SundaySync.app/ffmpeg" };
        })()`),
      },
      settings: firstRun,
    });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: en.obNext }).click();
    await dialog.getByRole("button", { name: en.obNext }).click();

    // The reject path: the missing-ffmpeg flow, with its own retry.
    await expect(page.getByText(en.obFfmpegMissing)).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__E2E_SIDECAR_FIXED__ = true;
    });
    await dialog.getByRole("button", { name: en.obCheckAgain }).click();
    await expect(page.getByText(en.obFfmpegBundled)).toBeVisible();
    await expect(page.getByText(en.obFfmpegMissing)).toBeHidden();
  });

  test("«Skip», «Get started» and the ✕ all close it and all persist the same flag", async ({
    page,
  }) => {
    // Three exits, one meaning — a skip is not a lesser exit (the dialog must not come back).
    // The ✕ carries the skip label too, so the two are told apart by their class, not by name.
    for (const exit of ["skip", "done", "close"] as const) {
      await boot(page, { fixtures: BOOT_FIXTURES, settings: firstRun });
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      if (exit === "done") {
        await dialog.getByRole("button", { name: en.obNext }).click();
        await dialog.getByRole("button", { name: en.obNext }).click();
        await dialog.getByRole("button", { name: en.obDone }).click();
      } else if (exit === "skip") {
        await dialog.locator(".onboarding__nav button.ghost").click();
      } else {
        await dialog.locator("button.dialog__close").click();
      }

      await expect(dialog, `exit: ${exit}`).toBeHidden();
      await expect
        .poll(() =>
          page.evaluate(
            (k) => JSON.parse(window.localStorage.getItem(k) || "{}").onboardingDone,
            SETTINGS_KEY,
          ),
        )
        .toBe(true);
    }
  });
});

test.describe("consent card", () => {
  const undecided = {
    telemetry_status: { consentVersion: null, granted: false, hasInstallId: true, queued: 0 },
  };

  test("«Yes» and «No thanks» each record their own answer and close the card", async ({
    page,
  }) => {
    for (const [label, granted] of [
      [en.consentAccept, true],
      [en.consentDecline, false],
    ] as const) {
      await boot(page, {
        fixtures: {
          ...BOOT_FIXTURES,
          ...undecided,
          ...spy(
            "set_telemetry_consent",
            `{ consentVersion: 1, granted: !!args.granted, hasInstallId: true, queued: 0 }`,
          ),
        },
        settings: SETTLED_SETTINGS,
      });
      const card = page.getByRole("dialog", { name: en.consentTitle });
      await expect(card).toBeVisible();

      await card.getByRole("button", { name: label }).click();

      await expect(card).toBeHidden();
      expect((await onlyCall(page, "set_telemetry_consent")).granted).toBe(granted);
    }
  });

  test("dismissing it records NOTHING — undecided is a state, not a no", async ({ page }) => {
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        ...undecided,
        ...spy("set_telemetry_consent", "{ consentVersion: 1, granted: false, hasInstallId: true, queued: 0 }"),
      },
      settings: SETTLED_SETTINGS,
    });
    const card = page.getByRole("dialog", { name: en.consentTitle });
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: en.close }).click();
    await expect(card).toBeHidden();
    expect(await calls(page, "set_telemetry_consent")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// SCANNING
// ═══════════════════════════════════════════════════════════════════════════════════════

test.describe("scanning phase", () => {
  test("the band reports the scan, and the gear still works underneath it", async ({ page }) => {
    await bootEmpty(page, {
      "plugin:dialog|open": [SHOOT],
      scan_inputs: controlled("scan_inputs"),
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await waitForPending(page, "scan_inputs");

    // Indeterminate until the backend says otherwise…
    await expect(page.locator(".band")).toBeVisible();
    await expect(page.locator(".band")).toContainText(en.scanningInputs);
    // …then the stage and the fraction it reports.
    await emit(page, "scan:progress", { stage: "Probing", completed: 3, total: 9 });
    await expect(page.locator(".band")).toContainText(en.stageProbing);
    await expect(page.locator(".band")).toContainText("3");

    // Nothing about a running scan disables the one control the strip still owns.
    await strip(page).getByRole("button", { name: en.settings }).click();
    await expect(page.getByRole("dialog", { name: en.settings })).toBeVisible();
    await page.keyboard.press("Escape");

    await resolveControlled(page, "scan_inputs", scanManifest());
    await expect(sources(page)).toBeVisible();
    await expect(page.locator(".band")).toBeHidden();
  });

  test("a second drop mid-scan supersedes the first — the late answer is ignored", async ({
    page,
  }) => {
    await bootEmpty(page, {
      "plugin:dialog|open": [SHOOT],
      // Every scan parks; the spec settles them in the order it chooses.
      scan_inputs: fn(`(args) => new Promise((resolve, reject) => {
        const w = window;
        w.__E2E_SCANS__ = w.__E2E_SCANS__ || [];
        w.__E2E_SCANS__.push({ inputs: args.inputs, resolve, reject });
      })`),
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await page.waitForFunction(
      () => ((window as unknown as Record<string, any>).__E2E_SCANS__ ?? []).length === 1,
    );

    // A second drop arrives while the first is still walking the card.
    await emit(page, "tauri://drag-drop", { paths: ["/Users/e2e/other"], position: { x: 1, y: 1 } });
    await page.waitForFunction(
      () => ((window as unknown as Record<string, any>).__E2E_SCANS__ ?? []).length === 2,
    );
    const second = await page.evaluate(
      () => (window as unknown as Record<string, any>).__E2E_SCANS__[1].inputs,
    );
    expect(second).toEqual([SHOOT, "/Users/e2e/other"]);

    // The SECOND lands first, and then the first answers late.
    await page.evaluate((m) => {
      (window as unknown as Record<string, any>).__E2E_SCANS__[1].resolve(m);
    }, presyncScanManifest());
    await expect(sources(page)).toBeVisible();
    await expect(page.locator(".clip")).toHaveCount(3);

    await page.evaluate((m) => {
      (window as unknown as Record<string, any>).__E2E_SCANS__[0].resolve(m);
    }, scanManifest());
    // Still the newer drop's three clips: the superseded answer cannot clobber it.
    await expect(page.locator(".clip")).toHaveCount(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// SOURCES — the strip cluster
// ═══════════════════════════════════════════════════════════════════════════════════════

test.describe("sources: the strip", () => {
  test("the compact «Add» pair asks for the same two things the empty state does", async ({
    page,
  }) => {
    await reachSources(page, dialogOpenSequence([[SHOOT], null]));
    const add = strip(page).locator(".dropzone--compact");
    await expect(add).toBeVisible();

    await add.getByRole("button", { name: en.dropFolder }).click();
    await add.getByRole("button", { name: en.dropAction }).click();

    // Call 0 is the one that got us here; 1 and 2 are the compact pair.
    const all = await calls(page, "plugin:dialog|open");
    expect(all).toHaveLength(3);
    expect(all[1].options).toMatchObject({ directory: true, multiple: true });
    expect(all[2].options).toMatchObject({ multiple: true });
    expect(all[2].options.directory).toBeFalsy();
  });

  test("the summary opens the sources popover, and a root's ✕ re-scans without it", async ({
    page,
  }) => {
    await reachSources(page, {
      ...spy("scan_inputs", JSON.stringify(presyncScanManifest())),
      ...dialogOpenSequence([[SHOOT], ["/Users/e2e/second"]]),
    });
    // A second root, so removing one leaves something behind.
    await strip(page).locator(".dropzone--compact").getByRole("button", { name: en.dropFolder }).click();
    await expect.poll(async () => (await calls(page, "scan_inputs")).length).toBe(2);

    await sources(page).locator(".popover--sources > summary").click();
    const panel = sources(page).locator(".popover--sources .popover__panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".root")).toHaveCount(2);

    await panel.getByLabel(`${en.removeRoot}: second`).click();

    // A removal is an input change, so it re-scans — with the survivor alone.
    await expect.poll(async () => (await calls(page, "scan_inputs")).length).toBe(3);
    const scans = await calls(page, "scan_inputs");
    const last = scans[scans.length - 1];
    expect(last.inputs).toEqual([SHOOT]);
    await expect(sources(page)).toBeVisible();
  });

  test("«Clear all» empties the room, and «Remove» on the last root does too", async ({
    page,
  }) => {
    await reachSources(page, dialogOpenSequence([[SHOOT], ["/Users/e2e/second"]]));
    await strip(page).locator(".dropzone--compact").getByRole("button", { name: en.dropFolder }).click();
    await expect(sources(page).locator(".popover--sources")).toBeVisible();
    await sources(page).locator(".popover--sources > summary").click();

    await sources(page).getByRole("button", { name: en.clearAll }).click();
    await expect(sources(page)).toBeHidden();
    await expect(page.locator(".empty")).toBeVisible();

    // …and the single-root case takes the same road via the ✕.
    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(sources(page)).toBeVisible();
    await sources(page).locator(".popover--sources > summary").click();
    await sources(page).getByLabel(`${en.removeRoot}: second`).click();
    await expect(page.locator(".empty")).toBeVisible();
  });

  test("a file row marks that clip and shuts the panel behind it", async ({ page }) => {
    await reachSources(page);
    await sources(page).locator(".popover--sources > summary").click();

    await sources(page).locator(".filerow--pick", { hasText: "C0002.MP4" }).click();

    await expect(inspector(page).locator(".preview__name")).toHaveText("C0002.MP4");
    await expect(sources(page).locator(".popover--sources .popover__panel")).toBeHidden();
  });

  test("the problem chip lists what could not be read, and each ✕ takes its file out", async ({
    page,
  }) => {
    const broken = "/Users/e2e/shoot/broken.mp4";
    const silent = "/Users/e2e/shoot/silent.mp4";
    await reachSources(page, {}, {
      ...presyncScanManifest(),
      unsynced: [
        { file: broken, reason: "decode_error" },
        { file: silent, reason: "no_audio" },
      ],
    });

    const chip = sources(page).locator(".popover--problems");
    await expect(chip.locator("summary")).toContainText(en.problemCount(2));
    await chip.locator("> summary").click();
    await expect(chip.locator(".filerow--problem")).toHaveCount(2);
    await expect(chip).toContainText(en.reasonDecodeError);

    await chip.getByLabel(`${en.removeFile}: broken.mp4`).click();
    await expect(chip.locator(".filerow--problem")).toHaveCount(1);
    await expect(chip.locator("summary")).toContainText(en.problemCount(1));

    await chip.getByLabel(`${en.removeFile}: silent.mp4`).click();
    // Nothing left to say: the chip is not a permanent «0 problems».
    await expect(sources(page).locator(".popover--problems")).toHaveCount(0);
  });

  test("the pre-analysis tick is its own quiet line, not the progress bar", async ({ page }) => {
    await reachSources(page, { prewarm_analysis: controlled("prewarm_analysis") });

    await emit(page, "prewarm:progress", { completed: 2, total: 7 });
    await expect(sources(page).locator(".prewarm")).toHaveText(en.prewarmProgress(2, 7));
    await expect(page.locator(".band")).toBeHidden();

    await emit(page, "prewarm:progress", { completed: 7, total: 7 });
    await expect(sources(page).locator(".prewarm")).toHaveText(en.prewarmProgress(7, 7));
  });

  test("«Sync» sends the whole request: sources, settings and every operator decision", async ({
    page,
  }) => {
    await reachSources(page, {
      ...spy("run_sync", JSON.stringify(syncOutcome())),
      "plugin:dialog|save": null,
    });

    // Three decisions first, so the request has something of each to carry.
    await page.locator(`.clip[data-file="${WAV}"]`).click();
    await inspector(page).getByLabel(`${en.makeReference}: ZOOM0001.WAV`).click();
    await page.locator(`.clip[data-file="${CAM_B}"]`).click();
    await inspector(page).getByLabel(`${en.moveToDevice}: C0002.MP4`).selectOption("cam-a");
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await inspector(page).getByLabel(`${en.removeFile}: C0001.MP4`).click();

    await page.getByRole("button", { name: en.syncButton }).click();

    const args = (await onlyCall(page, "run_sync")).args;
    expect(args.inputs).toEqual([SHOOT]);
    expect(args.reference).toBe(WAV);
    expect(args.deviceOverrides).toEqual({ [CAM_B]: "cam-a" });
    expect(args.excludeFiles).toEqual([CAM_A]);
    // An untouched install sends nulls, not invented defaults (D-029: simple mode is the
    // whole surface until settings are opened).
    expect(args.minPsr).toBeNull();
    expect(args.segmentCount).toBeNull();
    expect(args.cacheDir).toBeNull();
    expect(args.correctDrift).toBe(true);
  });

  test("what Settings changes travels with the next Sync", async ({ page }) => {
    await reachSources(page, spy("run_sync", JSON.stringify(syncOutcome())));

    await strip(page).getByRole("button", { name: en.settings }).click();
    const dialog = page.getByRole("dialog", { name: en.settings });
    await dialog.getByLabel(en.minPsr).fill("22");
    await dialog.getByLabel(en.minPsr).blur();
    await dialog.getByLabel(en.segmentCount).selectOption("9");
    await dialog.getByRole("checkbox", { name: en.driftCorrect }).uncheck();
    await dialog.getByRole("button", { name: en.close }).click();

    await page.getByRole("button", { name: en.syncButton }).click();

    const args = (await onlyCall(page, "run_sync")).args;
    expect(args.minPsr).toBe(22);
    expect(args.segmentCount).toBe(9);
    expect(args.correctDrift).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// SOURCES — the timeline's own controls
// ═══════════════════════════════════════════════════════════════════════════════════════

test.describe("sources: the timeline", () => {
  test("the three zoom buttons in the ruler's gutter each do what they say", async ({ page }) => {
    await reachSources(page);
    const fitted = await clipWidth(page);

    await timeline(page).getByRole("button", { name: en.zoomIn }).click();
    const zoomedIn = await clipWidth(page);
    expect(zoomedIn).toBeGreaterThan(fitted);

    await timeline(page).getByRole("button", { name: en.zoomOut }).click();
    expect(await clipWidth(page)).toBeLessThan(zoomedIn);

    await timeline(page).getByRole("button", { name: en.zoomIn }).click();
    await timeline(page).getByRole("button", { name: en.zoomIn }).click();
    await timeline(page).getByRole("button", { name: en.zoomFitAria }).click();
    expect(await clipWidth(page)).toBeCloseTo(fitted, 0);
  });

  test("the ruler seeks on press and keeps seeking while dragged — before any sync", async ({
    page,
  }) => {
    await reachSources(page);
    // Pre-sync there is no playhead LINE (nothing to play), but the playhead itself moves and
    // the clip it stands inside says so — `aria-current="time"`, the one observable the
    // pre-sync timeline offers for it.
    const ruler = page.locator(".timeline__ruler");
    const box = (await ruler.boundingBox())!;

    // Camera A runs 0–1800 s of a 3600 s timeline, Camera B 600–2400 s — so 5 % is inside
    // A and outside B, and 60 % is the other way round.
    await page.mouse.move(box.x + box.width * 0.05, box.y + box.height / 2);
    await page.mouse.down();
    await expect(page.locator(`.clip[data-file="${CAM_A}"]`)).toHaveAttribute(
      "aria-current",
      "time",
    );
    await expect(page.locator(`.clip[data-file="${CAM_B}"]`)).not.toHaveAttribute(
      "aria-current",
      "time",
    );

    // Drag on into the later camera's clip: the playhead follows the pointer.
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.mouse.up();
    await expect(page.locator(`.clip[data-file="${CAM_B}"]`)).toHaveAttribute(
      "aria-current",
      "time",
    );
    await expect(page.locator(`.clip[data-file="${CAM_A}"]`)).not.toHaveAttribute(
      "aria-current",
      "time",
    );
  });

  test("the scrollbar: thumb drag, trough press, and the keyboard", async ({ page }) => {
    await reachSources(page);
    // Zoom in far enough that there is something to scroll.
    for (let i = 0; i < 4; i += 1) {
      await timeline(page).getByRole("button", { name: en.zoomIn }).click();
    }
    const bar = page.getByRole("scrollbar", { name: en.scrollbarAria });
    const value = () => bar.getAttribute("aria-valuenow").then(Number);
    // Zooming anchors on the middle, so the view starts mid-timeline; Home is the baseline.
    await bar.focus();
    await bar.press("Home");
    expect(await value()).toBe(0);

    // Trough press, to the right of the thumb: the window jumps there.
    const trough = (await bar.boundingBox())!;
    await page.mouse.click(trough.x + trough.width * 0.8, trough.y + trough.height / 2);
    const afterTrough = await value();
    expect(afterTrough).toBeGreaterThan(0);

    // Thumb drag back to the left edge.
    const thumb = (await page.locator(".timeline__thumb").boundingBox())!;
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
    await page.mouse.down();
    await page.mouse.move(trough.x, thumb.y + thumb.height / 2, { steps: 6 });
    await page.mouse.up();
    expect(await value()).toBeLessThan(afterTrough);

    // Keyboard, on the focused scrollbar (finding 14).
    await bar.focus();
    await bar.press("End");
    expect(await value()).toBe(100);
    await bar.press("Home");
    expect(await value()).toBe(0);
    await bar.press("ArrowRight");
    const afterArrow = await value();
    expect(afterArrow).toBeGreaterThan(0);
    await bar.press("ArrowLeft");
    expect(await value()).toBeLessThan(afterArrow);
    await bar.press("PageDown");
    expect(await value()).toBeGreaterThan(0);
  });

  test("wheel gestures: ctrl zooms, shift and deltaX pan, a plain wheel is not ours", async ({
    page,
  }) => {
    await reachSources(page);
    const body = page.locator(".timeline__body");
    await body.hover();

    const fitted = await clipWidth(page);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    await expect.poll(() => clipWidth(page)).toBeGreaterThan(fitted);

    const before = await clipLeft(page);
    await page.mouse.wheel(150, 0);
    await expect.poll(() => clipLeft(page)).toBeLessThan(before);

    const afterPan = await clipLeft(page);
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, -150);
    await page.keyboard.up("Shift");
    await expect.poll(() => clipLeft(page)).toBeGreaterThan(afterPan);

    // A plain vertical wheel is left to the page (finding 13): it must not pan.
    const settled = await clipLeft(page);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(50);
    expect(await clipLeft(page)).toBeCloseTo(settled, 0);
  });

  test("dragging the background pans the view", async ({ page }) => {
    await reachSources(page);
    for (let i = 0; i < 3; i += 1) {
      await timeline(page).getByRole("button", { name: en.zoomIn }).click();
    }
    const before = await clipLeft(page);

    // Press on an EMPTY part of a lane, never on a clip: since D-070 a clip is a control and
    // a press on one selects rather than pans. Which pixels are empty depends on the zoom, so
    // the point is found by asking the browser rather than guessed from a bounding box.
    const from = await page.locator(".timeline__body").evaluate((body) => {
      const r = body.getBoundingClientRect();
      const y = r.y + r.height - 12;
      for (let x = r.x + r.width - 8; x > r.x + 40; x -= 12) {
        const at = document.elementFromPoint(x, y);
        if (at && !at.closest(".clip") && !at.closest(".timeline__ruler")) return { x, y };
      }
      return null;
    });
    expect(from, "no empty pixel to start a pan from").not.toBeNull();
    await page.mouse.move(from!.x, from!.y);
    await page.mouse.down();
    await page.mouse.move(from!.x - 100, from!.y, { steps: 8 });
    await page.mouse.up();

    await expect.poll(() => clipLeft(page)).toBeLessThan(before);
  });

  test("the timeline's keys: +, −, 0, F, the arrows, Home and End", async ({ page }) => {
    await reachSources(page);
    const fitted = await clipWidth(page);

    await timeline(page).press("+");
    const zoomed = await clipWidth(page);
    expect(zoomed).toBeGreaterThan(fitted);
    await timeline(page).press("-");
    expect(await clipWidth(page)).toBeLessThan(zoomed);

    await timeline(page).press("+");
    await timeline(page).press("0");
    expect(await clipWidth(page)).toBeCloseTo(fitted, 0);
    await timeline(page).press("+");
    await timeline(page).press("f");
    expect(await clipWidth(page)).toBeCloseTo(fitted, 0);

    // The playhead keys, read off the clip it lands in. Home and End park it exactly ON the
    // ends of the content, and `usePlayheadInsideSpan` is strict — so both edges are the
    // «inside nothing» case, and the arrows are what put it inside something.
    await timeline(page).press("Home");
    await expect(page.locator('.clip[aria-current="time"]')).toHaveCount(0);
    await timeline(page).press("ArrowRight");
    await timeline(page).press("ArrowRight");
    await expect(page.locator(`.clip[data-file="${CAM_A}"]`)).toHaveAttribute(
      "aria-current",
      "time",
    );
    // Shift is the ten-second stride, and it moves the playhead further than a plain press.
    await timeline(page).press("Shift+ArrowRight");
    await timeline(page).press("End");
    await expect(page.locator('.clip[aria-current="time"]')).toHaveCount(0);
  });

  test("Space before a sync is a no-op, not a silent failure to play", async ({ page }) => {
    // There is no schedule yet — `PlaybackEngine.play` returns immediately with no clips —
    // and the transport is not on screen at all. Asserted so a future change that starts an
    // AudioContext here has to say so out loud.
    await reachSources(page, pcmWindow());
    await expect(page.getByRole("group", { name: en.transportAria })).toHaveCount(0);

    await timeline(page).press(" ");
    await page.waitForTimeout(100);

    expect(await audio(page)).toBeUndefined();
    await expect(page.locator(".timeline__overlay")).toHaveCount(0);
  });

  test("a clip click marks it; the mix buttons do not exist before a sync", async ({ page }) => {
    await reachSources(page);
    await expect(inspector(page).locator(".preview__empty")).toBeVisible();

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(inspector(page).locator(".preview__name")).toHaveText("C0001.MP4");

    // `showMix` is result-only: there is no schedule to mute (D-061).
    await expect(page.locator(".track__mix")).toHaveCount(0);
    await expect(page.getByRole("button", { name: en.muteDevice("Camera A") })).toHaveCount(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// SOURCES — the inspector column and the bottom slot
// ═══════════════════════════════════════════════════════════════════════════════════════

test.describe("sources: the inspector's three decisions", () => {
  test("★ stars and un-stars, moving the badge and the auto-reference promise with it", async ({
    page,
  }) => {
    await reachSources(page);
    // V06-G3 (D-092): the promise is a glyph and two words in the slot now, with the whole
    // sentence on its `title`. Both halves are asserted — a short form whose long form had
    // quietly gone would be a claim the app stopped making.
    const auto = page.locator(".slot__auto");
    await expect(auto).toHaveText(en.autoReferenceShort);
    await expect(auto).toHaveAttribute("title", en.autoReference);

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    const star = inspector(page).getByLabel(`${en.makeReference}: C0001.MP4`);
    await star.click();

    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect(auto).toBeHidden();
    const camA = page.getByRole("group", { name: en.trackAria("Camera A") });
    await expect(camA.getByRole("img", { name: en.reference })).toBeVisible();
    await expect(page.locator(".badge--ref")).toHaveCount(1);

    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".badge--ref")).toHaveCount(0);
    await expect(auto).toHaveText(en.autoReferenceShort);
  });

  test("the device select regroups the clip onto the other device's track", async ({ page }) => {
    await reachSources(page);
    await expect(page.getByRole("group", { name: en.trackAria("Camera B") })).toBeVisible();

    await page.locator(`.clip[data-file="${CAM_B}"]`).click();
    await inspector(page).getByLabel(`${en.moveToDevice}: C0002.MP4`).selectOption("cam-a");

    // The clip is on Camera A's row now, and Camera B — emptied by the overlay — is gone.
    const camA = page.getByRole("group", { name: en.trackAria("Camera A") });
    await expect(camA.locator(`.clip[data-file="${CAM_B}"]`)).toBeVisible();
    await expect(page.getByRole("group", { name: en.trackAria("Camera B") })).toHaveCount(0);
    await expect(sources(page).locator(".strip__summary")).toContainText(en.deviceCount(2));
    // The select keeps saying where the file is now, rather than snapping back.
    await expect(inspector(page).getByLabel(`${en.moveToDevice}: C0002.MP4`)).toHaveValue("cam-a");
  });

  test("✕ removes, the slot's «Removed» chip counts it, and «Undo» puts it back", async ({
    page,
  }) => {
    await reachSources(page);
    await expect(page.locator(".clip")).toHaveCount(3);

    await page.locator(`.clip[data-file="${CAM_B}"]`).click();
    await inspector(page).getByLabel(`${en.removeFile}: C0002.MP4`).click();

    await expect(page.locator(".clip")).toHaveCount(2);
    await expect(sources(page).locator(".strip__summary")).toContainText(en.fileCount(2));
    const removed = page.locator(".slot__removed");
    await expect(removed.locator("summary")).toContainText(en.removedTitle(1));
    // The marked clip is gone, so the inspector stops describing it.
    await expect(inspector(page).locator(".preview__empty")).toBeVisible();

    await removed.locator("> summary").click();
    await removed.getByLabel(`${en.restoreFile}: C0002.MP4`).click();

    await expect(page.locator(".clip")).toHaveCount(3);
    await expect(page.locator(".slot__removed")).toHaveCount(0);
  });

  test("the «skipped» chip opens the list of what the walk never looked at", async ({ page }) => {
    await reachSources(page, {}, {
      ...presyncScanManifest(),
      skipped: [
        { file: "/Users/e2e/shoot/CamA/C0001.XML", reason: "sidecar" },
        { file: "/Users/e2e/shoot/CamA/DSC0001.JPG", reason: "still_image" },
      ],
    });

    const chip = page.locator(".slot__skipped");
    await expect(chip.locator("summary")).toContainText(en.skippedSummary(1, 1));
    await chip.locator("> summary").click();
    await expect(chip.locator(".filerow--skipped")).toHaveCount(2);
    await expect(chip).toContainText("C0001.XML");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// SYNCING
// ═══════════════════════════════════════════════════════════════════════════════════════

test.describe("syncing phase", () => {
  async function reachSyncing(page: Page, extra: Fixtures = {}): Promise<void> {
    await reachSources(page, { run_sync: controlled("run_sync"), ...extra }, scanManifest());
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
  }

  test("the band shows the run, and «Cancel» calls cancel_sync exactly once", async ({ page }) => {
    await reachSyncing(page, spy("cancel_sync"));

    await emit(page, "sync:progress", { stage: "Correlating", completed: 2, total: 5 });
    await expect(page.locator(".band")).toContainText(en.stageCorrelating);

    const cancel = page.locator(".band").getByRole("button", { name: en.cancel });
    await cancel.click();

    expect(await calls(page, "cancel_sync")).toHaveLength(1);
    // While the request is in flight the button says so and refuses a second press.
    await expect(page.locator(".band").getByRole("button", { name: en.cancelling })).toBeDisabled();
  });

  test("a cancelled run lands back on the sources with a notice, never a red banner", async ({
    page,
  }) => {
    await reachSyncing(page, spy("cancel_sync"));
    await page.locator(".band").getByRole("button", { name: en.cancel }).click();
    await rejectControlled(page, "run_sync", "cancelled");

    await expect(page.getByRole("button", { name: en.syncButton })).toBeVisible();
    const banner = page.locator(".banner");
    await expect(banner).toHaveClass(/banner--info/);
    await expect(banner).toContainText(en.noticeCancelled);
    await expect(page.locator(".banner--error")).toHaveCount(0);
    // The band is gone with the run, and no pre-analysis line is left ticking behind it.
    await expect(page.locator(".band")).toBeHidden();
    await expect(page.locator(".prewarm")).toHaveCount(0);
  });

  test("the sources cluster is readable and inert; the inspector's decisions are disabled", async ({
    page,
  }) => {
    await reachSyncing(page);
    // Mark a clip BEFORE the run so the inspector has something to disable.
    await expect(sources(page)).toHaveAttribute("aria-busy", "true");
    await expect(sources(page)).toHaveClass(/strip__sources--busy/);
    const inert = await sources(page).evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(inert).toBe("none");
    // …and still readable: the summary line is right there, it is only not a control.
    await expect(sources(page).locator(".strip__summary")).toContainText(en.fileCount(2));

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(inspector(page).locator(".preview__name")).toHaveText("C0001.MP4");
    await expect(inspector(page).getByLabel(`${en.makeReference}: C0001.MP4`)).toBeDisabled();
    await expect(inspector(page).getByLabel(`${en.moveToDevice}: C0001.MP4`)).toBeDisabled();
    await expect(inspector(page).getByLabel(`${en.removeFile}: C0001.MP4`)).toBeDisabled();
  });

  test("looking still works mid-sync: the timeline dims but zoom, pan and keys are live", async ({
    page,
  }) => {
    // The deliberate shape (styles.css, `.timeline--busy`): dimmed, NOT inert. D-061's rule
    // is that *looking* works in every phase, and the keyboard never stopped working here —
    // so making the mouse disagree with it was the bug, not the fix.
    await reachSyncing(page);
    await expect(timeline(page)).toHaveClass(/timeline--busy/);
    const fitted = await clipWidth(page);

    await timeline(page).getByRole("button", { name: en.zoomIn }).click();
    expect(await clipWidth(page)).toBeGreaterThan(fitted);
    await timeline(page).press("0");
    expect(await clipWidth(page)).toBeCloseTo(fitted, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════════════════════════════════════

test.describe("result: the strip", () => {
  test("Export asks for a path, sends the run, and then offers «Reveal in Finder»", async ({
    page,
  }) => {
    await reachResult(page, {
      ...spy("plugin:dialog|save", JSON.stringify(FCPXML)),
      ...spy("export_timeline", "3"),
      ...spy("plugin:opener|reveal_item_in_dir"),
    });

    // The project name travels with the export, so it is set first.
    const name = strip(page).getByLabel(en.projectName);
    await expect(name).toHaveValue("SundaySync");
    await name.fill("Gudstjeneste 2026-08-23");

    await expect(page.getByRole("button", { name: en.revealInFinder })).toHaveCount(0);
    await page.getByRole("button", { name: en.exportButton }).click();

    const save = (await onlyCall(page, "plugin:dialog|save")).options;
    expect(save.defaultPath).toBe("Gudstjeneste 2026-08-23.fcpxml");
    expect(save.filters).toEqual([{ name: "FCPXML", extensions: ["fcpxml"] }]);

    const args = await onlyCall(page, "export_timeline");
    expect(args.path).toBe(FCPXML);
    expect(args.project).toBe("Gudstjeneste 2026-08-23");
    expect(args.inputs).toEqual([SHOOT]);
    expect(args.excludeFiles).toBeNull();

    // V06-G3 (D-092 ⑤): the receipt is a line in the strip, not a toast over the timeline.
    // It names the FILE, which is what the operator will look for in Resolve; the count and
    // the Resolve import instruction are the `title` and `docs/KNOWN_LIMITATIONS.md` respectively.
    const receipt = page.locator(".app__header .strip__receipt");
    await expect(receipt).toContainText(en.exportedShort);
    // The name of the file that was actually WRITTEN — i.e. the path the save dialog came
    // back with, not the project name that seeded its default. The two are the same on the
    // happy path and are not the same when the operator renames the file in the dialog, and
    // it is the written one the operator will go looking for in Resolve.
    await expect(receipt).toContainText("SundaySync.fcpxml");
    await expect(page.locator(".toasts .banner")).toHaveCount(0);

    await page.getByRole("button", { name: en.revealInFinder }).click();
    expect((await onlyCall(page, "plugin:opener|reveal_item_in_dir")).paths).toEqual([FCPXML]);
  });

  test("a slash in the project name cannot become a path separator", async ({ page }) => {
    await reachResult(page, {
      ...spy("plugin:dialog|save", "null"),
      ...spy("export_timeline", "1"),
    });
    await strip(page).getByLabel(en.projectName).fill("22/12: kveld");

    await page.getByRole("button", { name: en.exportButton }).click();

    expect((await onlyCall(page, "plugin:dialog|save")).options.defaultPath).toBe(
      "22-12- kveld.fcpxml",
    );
    // The save was cancelled, so nothing was written and nothing is claimed.
    expect(await calls(page, "export_timeline")).toHaveLength(0);
    await expect(page.locator(".banner")).toBeHidden();
    await expect(page.getByRole("button", { name: en.revealInFinder })).toHaveCount(0);
  });

  test("«Sync again» runs the engine a second time and clears a stale result", async ({
    page,
  }) => {
    await reachResult(page, spy("run_sync", JSON.stringify(syncOutcome())));
    await expect(page.locator(".slot__stale")).toHaveCount(0);
    await expect(page.getByRole("button", { name: en.exportButton })).toBeEnabled();

    // A decision after the run makes what is on screen a run of a different set of sources.
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await inspector(page).getByLabel(`${en.moveToDevice}: C0001.MP4`).selectOption("rec");
    await expect(page.locator(".slot__stale")).toHaveText(en.staleResult);
    await expect(page.getByRole("button", { name: en.exportButton })).toBeDisabled();

    await page.getByRole("button", { name: en.resyncButton }).click();
    await waitForResult(page);

    expect(await calls(page, "run_sync")).toHaveLength(2);
    expect((await calls(page, "run_sync"))[1].args.deviceOverrides).toEqual({ [CAM_A]: "rec" });
    await expect(page.locator(".slot__stale")).toHaveCount(0);
    await expect(page.getByRole("button", { name: en.exportButton })).toBeEnabled();
  });

  test("typing in the project name does not zoom, fit or play", async ({ page }) => {
    // The field sits on the strip, outside the timeline section — so the section's key
    // handler never sees it. Asserted rather than reasoned about: `f`, `+`, `0` and Space are
    // four of this app's own shortcuts and they are also four ordinary characters.
    await reachResult(page, pcmWindow());
    const fitted = await clipWidth(page);

    const name = strip(page).getByLabel(en.projectName);
    await name.click();
    await name.fill("");
    await name.pressSequentially("f+0 sø 25", { delay: 10 });

    await expect(name).toHaveValue("f+0 sø 25");
    expect(await clipWidth(page)).toBeCloseTo(fitted, 0);
    await expect.poll(async () => (await audio(page))?.playing ?? false).toBe(false);
  });
});

test.describe("result: the timeline and the gutter", () => {
  test("the reference badge names the device the engine chose", async ({ page }) => {
    await reachResult(page);
    const rec = page.getByRole("group", { name: en.trackAria("Zoom recorder") });
    await expect(rec.getByRole("img", { name: en.reference })).toBeVisible();
    await expect(page.locator(".badge--ref")).toHaveCount(1);
  });

  test("M and S move the real gains, and mute beats solo", async ({ page }) => {
    await reachResult(page, { run_sync: twoDeviceOutcome(), ...pcmWindow() });

    const mute = page.getByRole("button", { name: en.muteDevice("Camera A") });
    const solo = page.getByRole("button", { name: en.soloDevice("Zoom recorder") });
    await expect(mute).toHaveAttribute("aria-pressed", "false");

    await mute.click();
    await expect(page.getByRole("button", { name: en.unmuteDevice("Camera A") })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect.poll(async () => (await audio(page)).deviceGains["cam-a"]).toBe(0);
    expect((await audio(page)).deviceGains["rec"]).toBe(1);

    // Solo the OTHER device: the unsoloed one goes quiet too.
    await solo.click();
    await expect.poll(async () => (await audio(page)).deviceGains["rec"]).toBe(1);
    expect((await audio(page)).deviceGains["cam-a"]).toBe(0);

    // Solo the muted device as well — mute still wins.
    await page.getByRole("button", { name: en.soloDevice("Camera A") }).click();
    await expect.poll(async () => (await audio(page)).deviceGains["cam-a"]).toBe(0);

    // …and un-muting it now lets the solo through.
    await page.getByRole("button", { name: en.unmuteDevice("Camera A") }).click();
    await expect.poll(async () => (await audio(page)).deviceGains["cam-a"]).toBe(1);
  });

  test("solo is hidden when there is only one device to solo", async ({ page }) => {
    const single = syncOutcome();
    (single.result as Record<string, unknown>).devices = [
      { id: "cam-a", label: "Camera A", kind: "video", files: [CAM_A] },
    ];
    await reachResult(page, { run_sync: single });

    await expect(page.getByRole("button", { name: en.muteDevice("Camera A") })).toBeVisible();
    await expect(page.getByRole("button", { name: en.soloDevice("Camera A") })).toHaveCount(0);
  });

  test("clicking a clip after the sync shows the engine's own answer for it", async ({ page }) => {
    await reachResult(page);
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();

    await expect(inspector(page).locator(".preview__name")).toHaveText("C0001.MP4");
    await expect(inspector(page).locator(".preview__sync")).toContainText(en.offsetLabel);
    await expect(inspector(page).locator(".preview__sync")).toContainText("4.200");
  });

  test("the warnings chip lists what the run wants to say about itself", async ({ page }) => {
    const withWarnings = syncOutcome();
    (withWarnings.result as Record<string, unknown>).warnings = [
      { code: "mixed_fps" },
      { code: "frame_snap_residual", residual_ms: 3 },
    ];
    await reachResult(page, { run_sync: withWarnings });

    const chip = strip(page).locator(".popover--warnings");
    await expect(chip.locator("summary")).toContainText(en.warningsCount(2));
    await chip.locator("> summary").click();
    await expect(chip.locator(".warnrow")).toHaveCount(2);
    await expect(chip).toContainText(en.mixedFps);
  });

  test("the problem popover's shelf can reassign a clip or take it out", async ({ page }) => {
    const shelved = syncOutcome();
    (shelved.result as Record<string, unknown>).unsynced = [
      { file: CAM_A, reason: "device_overlap" },
    ];
    await reachResult(page, { run_sync: shelved });

    const chip = sources(page).locator(".popover--problems");
    await expect(chip.locator("summary")).toContainText(en.problemCount(1));
    await chip.locator("> summary").click();
    await expect(chip.locator(".shelf__row")).toHaveCount(1);

    // The fix that helps: move it and sync again (D-027) — which marks the result stale.
    await chip.locator(".shelf__row select").selectOption("rec");
    await expect(page.locator(".slot__stale")).toHaveText(en.staleResult);

    await chip.getByLabel(`${en.removeFile}: C0001.MP4`).click();
    await expect(sources(page).locator(".popover--problems")).toHaveCount(0);
  });
});

test.describe("result: the transport", () => {
  test("play, pause, stop, the clock and the volume slider", async ({ page }) => {
    await reachResult(page, { run_sync: twoDeviceOutcome(), ...pcmWindow() });
    const transport = page.getByRole("group", { name: en.transportAria });
    await expect(transport).toBeVisible();

    await transport.getByRole("button", { name: en.play }).click();
    await page.waitForFunction(
      () => (window as unknown as Record<string, any>).__SUNDAYSYNC_AUDIO__?.playing === true,
    );
    // A schedule was really built for the clips on screen.
    expect((await audio(page)).scheduled.length).toBeGreaterThan(0);

    // Let the clock actually run before pausing it, or «stop returns to zero» is vacuous.
    await expect
      .poll(() => page.locator('[data-testid="transport-time"]').textContent())
      .not.toBe("00:00.000");
    await transport.getByRole("button", { name: en.pause }).click();
    await page.waitForFunction(
      () => (window as unknown as Record<string, any>).__SUNDAYSYNC_AUDIO__?.playing === false,
    );
    // Paused, it holds its position rather than rewinding.
    await expect(page.locator('[data-testid="transport-time"]')).not.toHaveText("00:00.000");

    await transport.getByRole("button", { name: en.stopPlayback }).click();
    await expect(page.locator('[data-testid="transport-time"]')).toHaveText("00:00.000");

    const volume = transport.getByLabel(en.volumeAria);
    await volume.fill("0.4");
    await expect.poll(async () => (await audio(page)).masterGain).toBeCloseTo(0.4, 2);
  });

  test("Space toggles the transport once there is something to play", async ({ page }) => {
    await reachResult(page, { run_sync: twoDeviceOutcome(), ...pcmWindow() });

    await timeline(page).press(" ");
    await page.waitForFunction(
      () => (window as unknown as Record<string, any>).__SUNDAYSYNC_AUDIO__?.playing === true,
    );
    await timeline(page).press(" ");
    await page.waitForFunction(
      () => (window as unknown as Record<string, any>).__SUNDAYSYNC_AUDIO__?.playing === false,
    );
  });

  test("«Loading audio …» is shown while the windows are in flight", async ({ page }) => {
    const gated = {
      read_audio_window: fn(`(args) => new Promise((resolve) => {
        window.__E2E_PCM_GATE__ = window.__E2E_PCM_GATE__ || [];
        window.__E2E_PCM_GATE__.push(() => resolve(new Float32Array(args.lenSamples).buffer));
      })`),
    };
    await reachResult(page, { run_sync: twoDeviceOutcome(), ...gated });

    await page.getByRole("button", { name: en.play }).click();
    await expect(page.getByText(en.buffering)).toBeVisible();
    // The one button is the pause affordance already — pressing play twice must not double up.
    await expect(page.getByRole("button", { name: en.pause })).toBeVisible();

    await page.evaluate(() =>
      ((window as unknown as Record<string, any>).__E2E_PCM_GATE__ ?? []).forEach((r: () => void) =>
        r(),
      ),
    );
    await page.waitForFunction(
      () => (window as unknown as Record<string, any>).__SUNDAYSYNC_AUDIO__?.playing === true,
    );
    await expect(page.getByText(en.buffering)).toBeHidden();
  });

  test("seeking on the ruler while playing rebuilds the schedule", async ({ page }) => {
    await reachResult(page, { run_sync: twoDeviceOutcome(), ...pcmWindow() });
    await page.getByRole("button", { name: en.play }).click();
    await page.waitForFunction(
      () => (window as unknown as Record<string, any>).__SUNDAYSYNC_AUDIO__?.playing === true,
    );
    const before = (await audio(page)).generation;

    const ruler = (await page.locator(".timeline__ruler").boundingBox())!;
    await page.mouse.click(ruler.x + ruler.width * 0.5, ruler.y + ruler.height / 2);

    await expect.poll(async () => (await audio(page)).generation).toBeGreaterThan(before);
    await page.waitForFunction(
      (g) => ((window as unknown as Record<string, any>).__SUNDAYSYNC_AUDIO__?.playing === true) &&
        (window as unknown as Record<string, any>).__SUNDAYSYNC_AUDIO__.generation > g,
      before,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// SETTINGS DIALOG
// ═══════════════════════════════════════════════════════════════════════════════════════

test.describe("settings dialog", () => {
  async function openSettings(page: Page, fixtures: Fixtures = {}): Promise<void> {
    await bootEmpty(page, fixtures);
    await strip(page).getByRole("button", { name: en.settings }).click();
    await expect(page.getByRole("dialog", { name: en.settings })).toBeVisible();
  }

  const readSettings = (page: Page) =>
    page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) || "{}"), SETTINGS_KEY);

  test("the language select changes the whole UI while it is open", async ({ page }) => {
    await openSettings(page);

    await page.getByLabel(en.language).selectOption("nb");

    await expect(page.getByRole("dialog", { name: nb.settings })).toBeVisible();
    await expect(page.getByText(nb.minPsr)).toBeVisible();
    await expect.poll(() => readSettings(page).then((s) => s.lang)).toBe("nb");
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("nb");

    // …and back, from the Norwegian label.
    await page.getByLabel(nb.language).selectOption("en");
    await expect(page.getByRole("dialog", { name: en.settings })).toBeVisible();
  });

  test("«Auto» hands the language back to the system", async ({ page }) => {
    await openSettings(page);
    await page.getByLabel(en.language).selectOption("");
    await expect.poll(() => readSettings(page).then((s) => s.lang)).toBeNull();
  });

  test("the four engine fields commit and persist", async ({ page }) => {
    await openSettings(page);
    const dialog = page.getByRole("dialog", { name: en.settings });

    const psr = dialog.getByLabel(en.minPsr);
    await psr.fill("18");
    await psr.press("Enter");
    await expect.poll(() => readSettings(page).then((s) => s.minPsr)).toBe(18);
    // A bad value is refused and the last good one survives.
    await psr.fill("nope");
    await psr.blur();
    await expect(dialog.getByText(en.minPsrInvalid)).toBeVisible();
    await expect(psr).toHaveAttribute("aria-invalid", "true");
    await expect.poll(() => readSettings(page).then((s) => s.minPsr)).toBe(18);

    await dialog.getByLabel(en.segmentCount).selectOption("3");
    await expect.poll(() => readSettings(page).then((s) => s.segmentCount)).toBe(3);
    await dialog.getByLabel(en.segmentCount).selectOption("");
    await expect.poll(() => readSettings(page).then((s) => s.segmentCount)).toBeNull();

    await dialog.getByRole("checkbox", { name: en.driftCorrect }).uncheck();
    await expect.poll(() => readSettings(page).then((s) => s.correctDrift)).toBe(false);

    await dialog.getByRole("checkbox", { name: en.playbackDriftCorrect }).uncheck();
    await expect.poll(() => readSettings(page).then((s) => s.playbackDriftCorrected)).toBe(false);
    // The two switches are deliberately independent (D-055).
    await expect(dialog.getByRole("checkbox", { name: en.driftCorrect })).not.toBeChecked();
  });

  test("the cache section: the folder, the picker, the cap and the two-step clear", async ({
    page,
  }) => {
    await openSettings(page, {
      cache_status: { dir: "/Users/e2e/Library/Caches/SundaySync", entries: 12, bytes: 3_400_000 },
      ...spy("plugin:dialog|open", JSON.stringify("/Volumes/Scratch/cache")),
      ...spy("clear_cache", "3400000"),
      ...spy("enforce_cache_cap", "{ entries: 2, bytes: 1000 }"),
    });
    const dialog = page.getByRole("dialog", { name: en.settings });

    await expect(dialog).toContainText(en.cacheUsage(12, formatBytes(3_400_000)));

    // Choosing a folder: a directory picker, and the choice is persisted.
    await dialog.getByRole("button", { name: en.cachePick }).click();
    expect((await onlyCall(page, "plugin:dialog|open")).options).toMatchObject({
      directory: true,
      multiple: false,
    });
    await expect.poll(() => readSettings(page).then((s) => s.cacheDir)).toBe(
      "/Volumes/Scratch/cache",
    );

    // The cap is enforced there and then, not at the next launch.
    const cap = dialog.getByLabel(en.cacheCap);
    await cap.fill("250");
    await cap.blur();
    expect(await onlyCall(page, "enforce_cache_cap")).toMatchObject({
      dir: "/Volumes/Scratch/cache",
      maxBytes: 250 * 1024 * 1024,
    });
    await expect(page.locator(".banner")).toContainText(en.cacheEvicted(2, formatBytes(1000)));

    // Clearing asks first, can be backed out of, and only then calls the command.
    await dialog.getByRole("button", { name: en.cacheClear }).click();
    await expect(dialog).toContainText(en.cacheClearConfirm);
    await dialog.getByRole("button", { name: en.cancel }).click();
    expect(await calls(page, "clear_cache")).toHaveLength(0);

    await dialog.getByRole("button", { name: en.cacheClear }).click();
    await dialog.getByRole("button", { name: en.cacheClear }).click();
    expect((await onlyCall(page, "clear_cache")).dir).toBe("/Volumes/Scratch/cache");
    await expect(page.locator(".banner--ok")).toContainText(en.cacheCleared(formatBytes(3_400_000)));
  });

  test("«Clear cache» is unavailable when there is nothing in it", async ({ page }) => {
    await openSettings(page, {
      cache_status: { dir: "/Users/e2e/Library/Caches/SundaySync", entries: 0, bytes: 0 },
    });
    await expect(
      page.getByRole("dialog", { name: en.settings }).getByRole("button", { name: en.cacheClear }),
    ).toBeDisabled();
  });

  test("a refused command is reported in the app's own words, not as a raw Rust string", async ({
    page,
  }) => {
    // Both of this panel's own failure paths, because they had the same bug: `String(e)`
    // straight into the banner. The D-046 activity guard is the one an operator actually
    // meets — the shell refuses cache maintenance while a sync holds the slot.
    await openSettings(page, {
      cache_status: { dir: "/Users/e2e/cache", entries: 4, bytes: 1000 },
      clear_cache: fn(`() => { throw "busy: sync in progress"; }`),
      "plugin:dialog|save": "/Users/e2e/out/diag.json",
      export_diagnostics: fn(`() => { throw "failed to read /Users/e2e/out: Permission denied"; }`),
    });
    const dialog = page.getByRole("dialog", { name: en.settings });
    await dialog.getByRole("button", { name: en.cacheClear }).click();
    await dialog.getByRole("button", { name: en.cacheClear }).click();

    const banner = page.locator(".banner");
    // Localised, like every other engine error the operator can meet (D-030) — an
    // unrecognised message keeps its raw text (§7.5), inside a sentence that says what it is.
    // R/D-094: this one used to read «Something went wrong: busy: sync in progress» —
    // framed, but English, and crash-shaped for a condition that clears itself. It has its
    // own sentence now, and an INFO banner: a wait is not a failure.
    await expect(banner).toContainText(en.errBusySync);
    await expect(banner).not.toContainText("busy: sync in progress");
    await expect(banner).toHaveClass(/banner--info/);

    // A recognised one is replaced outright by the sentence the dictionary has for it. (The
    // banner is a single slot, so the second notice takes the first one's place.)
    await dialog.getByRole("button", { name: en.diagnostics }).click();
    await expect(banner).toContainText(en.errIo("/Users/e2e/out"));
    await expect(banner).toHaveClass(/banner--error/);
  });

  test("what Settings says back is read OVER the modal — the owner's call (D-089)", async ({
    page,
  }) => {
    // Decided by the owner (D-089): the five banners a Settings control answers with —
    // clear cache, the cap's eviction count, «Delete my data», «Export diagnostics», the
    // telemetry unavailable notice — are painted ABOVE the dialog backdrop (`.toasts` at
    // z-index 50 over the scrim's 40), so the receipt is read the moment it is earned,
    // with the dialog still open. The sweep first recorded the opposite; this is the
    // deliberate change it asked for.
    await openSettings(page, {
      cache_status: { dir: "/Users/e2e/cache", entries: 4, bytes: 1000 },
      ...spy("clear_cache", "1000"),
    });
    const dialog = page.getByRole("dialog", { name: en.settings });
    await dialog.getByRole("button", { name: en.cacheClear }).click();
    await dialog.getByRole("button", { name: en.cacheClear }).click();
    await expect(page.locator(".banner--ok")).toContainText(en.cacheCleared(formatBytes(1000)));

    // The banner really is over the scrim — while the dialog is still open. The banner's
    // BODY is deliberately click-through (`.toasts` pointer-events choreography), which
    // `elementFromPoint` honours, so the honest probe is the one part that takes the
    // pointer: the dismiss. A hit test at its middle must land on it, not the backdrop —
    // that proves both paint order and that the receipt can be dismissed without closing
    // the dialog first.
    await expect(page.getByRole("dialog", { name: en.settings })).toBeVisible();
    const onTop = await page
      .locator(".banner--ok .banner__dismiss")
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return at instanceof HTMLElement && (el === at || el.contains(at));
      });
    expect(onTop).toBe(true);

    // Closing the dialog afterwards neither hides nor duplicates the receipt.
    await dialog.getByRole("button", { name: en.close }).click();
    await expect(page.getByRole("dialog", { name: en.settings })).toBeHidden();
    await expect(page.locator(".banner--ok")).toBeVisible();
    await expect(page.locator(".banner--ok")).toHaveCount(1);
  });

  test("the telemetry block: the toggle, the preview, the consent text and the deletion", async ({
    page,
  }) => {
    await openSettings(page, {
      telemetry_status: { consentVersion: 1, granted: false, hasInstallId: true, queued: 2 },
      ...spy(
        "set_telemetry_consent",
        "{ consentVersion: 1, granted: !!args.granted, hasInstallId: true, queued: 2 }",
      ),
      telemetry_preview: '{"app":"sundaysync","event":"sync_completed"}',
      ...spy("request_telemetry_deletion", "true"),
    });
    const dialog = page.getByRole("dialog", { name: en.settings });

    const toggle = dialog.getByRole("checkbox", { name: en.telemetryToggleLabel });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    expect((await onlyCall(page, "set_telemetry_consent")).granted).toBe(true);
    await expect(toggle).toBeChecked();

    await dialog.getByRole("button", { name: en.telemetryShowPreview }).click();
    const preview = page.getByRole("dialog", { name: en.telemetryPreviewTitle });
    await expect(preview).toContainText("sync_completed");
    await preview.getByRole("button", { name: en.close }).click();
    await expect(preview).toBeHidden();

    // Deletion is two-step, and the first step can be backed out of.
    await dialog.getByRole("button", { name: en.telemetryDelete }).click();
    await expect(dialog).toContainText(en.telemetryDeleteConfirm);
    await dialog.getByRole("button", { name: en.cancel }).click();
    expect(await calls(page, "request_telemetry_deletion")).toHaveLength(0);

    await dialog.getByRole("button", { name: en.telemetryDelete }).click();
    await dialog.getByRole("button", { name: en.telemetryDelete }).click();
    expect(await calls(page, "request_telemetry_deletion")).toHaveLength(1);
    await expect(page.locator(".banner--ok")).toContainText(en.telemetryDeleted);
  });

  test("«Show the consent text again» closes Settings rather than stacking a second modal", async ({
    page,
  }) => {
    await openSettings(page);
    await page
      .getByRole("dialog", { name: en.settings })
      .getByRole("button", { name: en.telemetryShowConsent })
      .click();

    await expect(page.getByRole("dialog", { name: en.settings })).toBeHidden();
    await expect(page.getByRole("dialog", { name: en.consentTitle })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
  });

  test("the system block: the beta ring, the check, the download and the restart", async ({
    page,
  }) => {
    await openSettings(page, {
      ...spy("update_check", '{ phase: "available", version: "0.6.1" }'),
      ...spy("update_download_install", '{ phase: "readyToInstall", version: "0.6.1" }'),
    });
    const dialog = page.getByRole("dialog", { name: en.settings });

    const beta = dialog.getByRole("checkbox", { name: en.betaChannelLabel });
    await beta.check();
    await expect.poll(() => readSettings(page).then((s) => s.betaChannel)).toBe(true);

    await dialog.getByRole("button", { name: en.updateCheck }).click();
    await expect(dialog).toContainText(en.updateAvailable("0.6.1"));
    // (Call 0 is App's own quiet on-launch check, which never downloads anything.)
    const checks = await calls(page, "update_check");
    expect(checks[checks.length - 1].beta).toBe(true);

    await dialog.getByRole("button", { name: en.updateDownload("0.6.1") }).click();
    await expect(dialog).toContainText(en.updateReady("0.6.1"));
    await expect(dialog.getByRole("button", { name: en.updateRestart })).toBeVisible();
  });

  test("«Show the introduction again» reopens onboarding without re-running first run", async ({
    page,
  }) => {
    await openSettings(page);
    await page
      .getByRole("dialog", { name: en.settings })
      .getByRole("button", { name: en.showOnboarding })
      .click();

    await expect(page.getByRole("dialog", { name: en.settings })).toBeHidden();
    await expect(page.getByRole("heading", { name: en.obTitle1 })).toBeVisible();
  });

  test("«Export diagnostics» asks for a JSON path and writes there", async ({ page }) => {
    await openSettings(page, {
      ...spy("plugin:dialog|save", JSON.stringify("/Users/e2e/out/diag.json")),
      ...spy("export_diagnostics"),
    });
    await page
      .getByRole("dialog", { name: en.settings })
      .getByRole("button", { name: en.diagnostics })
      .click();

    expect((await onlyCall(page, "plugin:dialog|save")).options).toMatchObject({
      defaultPath: "sundaysync-diagnostics.json",
    });
    expect((await onlyCall(page, "export_diagnostics")).path).toBe("/Users/e2e/out/diag.json");
    await expect(page.locator(".banner--ok")).toContainText(en.diagnosticsSaved);
  });

  test("it closes three ways — ✕, Escape and the backdrop — and each gives the focus back", async ({
    page,
  }) => {
    // `Dialog.tsx`'s own contract, in one sentence: «Escape and backdrop close, and focus
    // returns to the opener on close.» All three exits are held to it.
    for (const how of ["close", "escape", "backdrop"] as const) {
      await openSettings(page);
      const dialog = page.getByRole("dialog", { name: en.settings });

      if (how === "close") await dialog.getByRole("button", { name: en.close }).click();
      else if (how === "escape") await page.keyboard.press("Escape");
      else {
        const box = (await page.locator(".dialog-backdrop").boundingBox())!;
        await page.mouse.click(box.x + 4, box.y + 4);
      }

      await expect(dialog, `closing by ${how}`).toBeHidden();
      // …and the focus comes back to the control that opened it.
      await expect(
        strip(page).getByRole("button", { name: en.settings }),
        `focus after closing by ${how}`,
      ).toBeFocused();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// BANNERS, TOASTS AND POPOVER MECHANICS
// ═══════════════════════════════════════════════════════════════════════════════════════

test.describe("banners and popovers", () => {
  test("a failing scan says so, and the ✕ dismisses the banner", async ({ page }) => {
    await bootEmpty(page, {
      "plugin:dialog|open": [SHOOT],
      scan_inputs: fn(`() => { throw "failed to read /Users/e2e/shoot: No such file"; }`),
    });
    await page.getByRole("button", { name: en.dropFolder }).click();

    const banner = page.locator(".banner");
    await expect(banner).toHaveClass(/banner--error/);
    await expect(banner).toContainText(en.errIo(SHOOT));

    await page.locator(".banner__dismiss").click();
    await expect(banner).toBeHidden();
  });

  test("a banner floats over the stage — the timeline does not move under it", async ({
    page,
  }) => {
    // Driven by a FAILED export since V06-G3 (D-092 ⑤): a successful one no longer says
    // anything in the toast layer at all — its receipt is a line in the strip. What the layer
    // still carries is what the app has to SAY when something went wrong, and the claim being
    // measured here is about the layer, not about which message is in it.
    await reachResult(page, {
      ...spy("plugin:dialog|save", JSON.stringify(FCPXML)),
      export_timeline: fn(`() => { throw "io error: /Users/e2e/out is read-only"; }`),
    });
    const before = (await page.locator(".timeline__frame").boundingBox())!;

    await page.getByRole("button", { name: en.exportButton }).click();
    await expect(page.locator(".banner--error")).toBeVisible();

    const during = (await page.locator(".timeline__frame").boundingBox())!;
    expect(during.y).toBeCloseTo(before.y, 0);
    expect(during.height).toBeCloseTo(before.height, 0);

    await page.locator(".banner__dismiss").click();
    const after = (await page.locator(".timeline__frame").boundingBox())!;
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  test("Escape closes a popover and gives the summary its focus back", async ({ page }) => {
    await reachSources(page);
    const summary = sources(page).locator(".popover--sources > summary");
    await summary.click();
    await expect(sources(page).locator(".popover--sources .popover__panel")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(sources(page).locator(".popover--sources .popover__panel")).toBeHidden();
    await expect(summary).toBeFocused();
  });

  test("a press outside closes it; a press inside it does not", async ({ page }) => {
    await reachSources(page);
    const panel = sources(page).locator(".popover--sources .popover__panel");
    await sources(page).locator(".popover--sources > summary").click();
    await expect(panel).toBeVisible();

    await panel.locator(".device-group__head").first().click();
    await expect(panel).toBeVisible();

    await page.locator(".stage").click({ position: { x: 5, y: 5 } });
    await expect(panel).toBeHidden();
  });

  test("opening one popover closes the other — by mouse and by keyboard", async ({ page }) => {
    await reachSources(page, {}, {
      ...presyncScanManifest(),
      unsynced: [{ file: "/Users/e2e/shoot/broken.mp4", reason: "decode_error" }],
    });
    const sourcesPanel = sources(page).locator(".popover--sources .popover__panel");
    const problemPanel = sources(page).locator(".popover--problems .popover__panel");

    await sources(page).locator(".popover--sources > summary").click();
    await expect(sourcesPanel).toBeVisible();
    await sources(page).locator(".popover--problems > summary").click();
    await expect(problemPanel).toBeVisible();
    await expect(sourcesPanel).toBeHidden();

    // The keyboard route: two summaries are tab stops precisely so they can be used this way.
    await sources(page).locator(".popover--sources > summary").press("Enter");
    await expect(sourcesPanel).toBeVisible();
    await expect(problemPanel).toBeHidden();
  });

  test("a popover open when the phase changes stays open, over a room that did not move", async ({
    page,
  }) => {
    // Nothing closes a `<details>` on a phase change, and nothing needs to: the panel floats
    // over the stage (D-078) and its content is derived from the same manifest either side of
    // the transition. Asserted so a change of mind here is a deliberate one.
    await reachSources(page, { run_sync: controlled("run_sync") }, scanManifest());
    const panel = sources(page).locator(".popover--sources .popover__panel");
    await sources(page).locator(".popover--sources > summary").click();
    await expect(panel).toBeVisible();
    const frame = (await page.locator(".timeline__frame").boundingBox())!;

    // Pressed by KEYBOARD: a mouse press on the Sync button is a press outside the popover
    // and would dismiss it on its own, which would prove nothing about the phase change.
    const sync = page.getByRole("button", { name: en.syncButton });
    await sync.focus();
    await sync.press("Enter");
    await waitForPending(page, "run_sync");
    await expect(panel).toBeVisible();
    await resolveControlled(page, "run_sync", syncOutcome());
    await waitForResult(page);

    await expect(panel).toBeVisible();
    // …and it is still dismissible, by the two routes that do not go through the cluster
    // (which is inert while a sync runs).
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    const after = (await page.locator(".timeline__frame").boundingBox())!;
    expect(after.x).toBeCloseTo(frame.x, 0);
    expect(after.width).toBeCloseTo(frame.width, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// THE SMALLEST WINDOW — every control still reachable at 1024×600
// ═══════════════════════════════════════════════════════════════════════════════════════

test.describe("at the smallest window the app allows (1024×600)", () => {
  test.use({ viewport: { width: 1024, height: 600 } });

  test("the strip's and the slot's controls all hit-test to themselves", async ({ page }) => {
    await reachResult(page, { run_sync: twoDeviceOutcome(), ...pcmWindow() });

    // Nothing overflows the room sideways — the whole point of the strip's ellipsising.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${overflow} px of horizontal overflow`).toBeLessThanOrEqual(1);

    const reachable = async (locator: ReturnType<Page["locator"]>) =>
      locator.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return at !== null && (el.contains(at) || at.contains(el));
      });

    for (const control of [
      page.getByRole("button", { name: en.settings }),
      page.getByRole("button", { name: en.exportButton }),
      page.getByRole("button", { name: en.resyncButton }),
      strip(page).getByLabel(en.projectName),
      sources(page).locator(".popover--sources > summary"),
      page.getByRole("button", { name: en.play }),
      page.getByRole("button", { name: en.stopPlayback }),
      page.getByRole("button", { name: en.zoomFitAria }),
    ]) {
      expect(await reachable(control), await control.evaluate((el) => el.outerHTML)).toBe(true);
    }

    // …and the two that are easiest to lose to a cramped row still work when pressed.
    await page.getByRole("button", { name: en.zoomFitAria }).click();
    await sources(page).locator(".popover--sources > summary").click();
    await expect(sources(page).locator(".popover--sources .popover__panel")).toBeVisible();
  });
});
