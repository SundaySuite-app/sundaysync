import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  fn,
  presyncScanManifest,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForResult,
  type Fixtures,
} from "./harness";
import { en } from "../src/i18n";

/**
 * The three decisions about one clip, and where they land (V06-R2a, D-077 #9/#10/#11).
 *
 * This is `removal.spec.ts` re-expressed (D-085). Its three claims are unchanged and every one
 * of them is still made here:
 *
 *   1. taking a file out actually takes it out of everything the operator can see — the
 *      timeline, the groups, the counts;
 *   2. it reaches the RUN, which is a different thing entirely: the exclusion travels to
 *      `run_sync` and `export_timeline` as `excludeFiles`, because the engine re-walks every
 *      folder it is handed and would otherwise find the file again (D-060);
 *   3. there is a way back — a removal with no undo turns one misclick into re-dropping the
 *      whole card.
 *
 * What moved is the control. The star, the device `<select>` and the ✕ were on every row of a
 * list 386 rows long; they are on the marked clip in the inspector column now, which means the
 * gesture is «point at the clip, then decide» rather than «find the row, then decide». The way
 * back is a chip in the bottom slot, and the problem rows keep their own ✕ inside the problem
 * popover — "om de kan leses eller ikke" is still one wish, not two.
 */

const WAV = "/Users/e2e/shoot/ZOOM0001.WAV";
const CAM_A = "/Users/e2e/shoot/CamA/C0001.MP4";
const CAM_B = "/Users/e2e/shoot/CamB/C0002.MP4";
const BROKEN = "/Users/e2e/shoot/broken.mp4";

/** Records the args of every `run_sync` on `window.__E2E_SYNC_ARGS__` (the same
 *  window-recording pattern `consentSetSpy` uses), answering with a real outcome. */
function runSyncSpy(outcome: Record<string, unknown>): Fixtures {
  return {
    run_sync: fn(`(args) => {
      window.__E2E_SYNC_ARGS__ = args.args;
      return ${JSON.stringify(outcome)};
    }`),
  };
}

/** The same for `export_timeline`, whose exclusions feed the F6 fingerprint (D-060). */
function exportSpy(): Fixtures {
  return {
    "plugin:dialog|save": "/Users/e2e/out/SundaySync.fcpxml",
    export_timeline: fn(`(args) => {
      window.__E2E_EXPORT_ARGS__ = args;
      return 1;
    }`),
  };
}

async function recorded(page: Page, key: string): Promise<Record<string, unknown>> {
  return (await page.evaluate(
    (k) => (window as unknown as Record<string, unknown>)[k],
    key,
  )) as Record<string, unknown>;
}

function sources(page: Page) {
  return page.getByRole("region", { name: en.sourcesTitle });
}

function inspector(page: Page) {
  return page.locator(".inspector");
}

async function reachSources(page: Page, fixtures: Fixtures = {}, manifest = presyncScanManifest()) {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: manifest,
      ...fixtures,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(sources(page)).toBeVisible();
}

/** Mark a clip by clicking it on the timeline — the shortest route to the action row, and the
 *  one the operator takes. (The «Kilder» panel's file rows do the same thing by name.) */
async function mark(page: Page, file: string, name: string) {
  await page.locator(`.clip[data-file="${file}"]`).click();
  await expect(inspector(page).locator(".preview__name")).toHaveText(name);
}

async function openSources(page: Page) {
  await sources(page).locator(".popover--sources > summary").click();
  await expect(sources(page).locator(".popover--sources .popover__panel")).toBeVisible();
}

test.describe("removing the marked clip", () => {
  test("the ✕ in the inspector takes it out of the timeline, the groups and the counts", async ({
    page,
  }) => {
    await reachSources(page);
    await expect(page.locator(".clip")).toHaveCount(3);
    await expect(sources(page).locator(".strip__summary")).toContainText(en.fileCount(3));

    await mark(page, CAM_B, "C0002.MP4");
    await inspector(page).getByLabel(`${en.removeFile}: C0002.MP4`).click();

    // The clip is gone from the timeline…
    await expect(page.locator(`.clip[data-file="${CAM_B}"]`)).toHaveCount(0);
    await expect(page.locator(".clip")).toHaveCount(2);
    // …its (now empty) device track with it, exactly as an override that empties a device
    // already does…
    await expect(page.getByRole("group", { name: en.trackAria("Camera B") })).toBeHidden();
    // …the strip counts what is left, not what was dropped…
    await expect(sources(page).locator(".strip__summary")).toContainText(en.fileCount(2));
    // …and the list behind it agrees.
    await openSources(page);
    await expect(
      sources(page).locator(".device-group__name").filter({ hasText: "Camera B" }),
    ).toHaveCount(0);
    await expect(sources(page).getByText("C0002.MP4")).toHaveCount(0);
  });

  test("the way back: the slot's «Fjernet» chip restores it everywhere", async ({ page }) => {
    await reachSources(page);
    await mark(page, CAM_B, "C0002.MP4");
    await inspector(page).getByLabel(`${en.removeFile}: C0002.MP4`).click();

    // D-077 #13: a chip on the bottom slot, shut — a footnote, with its count on the summary.
    const removed = page.locator(".slot__removed");
    await expect(removed.getByText(en.removedTitle(1))).toBeVisible();
    await expect(removed.getByText("C0002.MP4")).toBeHidden();

    await removed.locator("> summary").click();
    await expect(removed.getByText("C0002.MP4")).toBeVisible();
    await removed.getByLabel(`${en.restoreFile}: C0002.MP4`).click();

    await expect(page.locator(`.clip[data-file="${CAM_B}"]`)).toHaveCount(1);
    await expect(page.getByRole("group", { name: en.trackAria("Camera B") })).toBeVisible();
    await expect(sources(page).locator(".strip__summary")).toContainText(en.fileCount(3));
    // Nothing removed any more, so the chip itself is gone.
    await expect(page.locator(".slot__removed")).toHaveCount(0);
  });

  test("the ✕ is disabled while a sync runs, because there is no run left to change", async ({
    page,
  }) => {
    // The gate the panel put on its whole block (D-061), on the controls that replaced it.
    // Looking is still allowed — the picture and the facts stay readable — but a removal
    // accepted now would silently belong to the NEXT run, not the one being watched.
    await reachSources(page, {
      run_sync: fn(`() => new Promise(() => {})`),
    });
    await mark(page, CAM_B, "C0002.MP4");
    await page.getByRole("button", { name: en.syncButton }).click();
    await expect(page.locator(".band")).toBeVisible();

    await expect(inspector(page).getByLabel(`${en.removeFile}: C0002.MP4`)).toBeDisabled();
    await expect(inspector(page).getByLabel(`${en.makeReference}: C0002.MP4`)).toBeDisabled();
    await expect(inspector(page).getByLabel(`${en.moveToDevice}: C0002.MP4`)).toBeDisabled();
    await expect(sources(page)).toHaveAttribute("aria-busy", "true");
  });
});

test.describe("the reference star", () => {
  test("starring a clip retires the auto-reference line, and un-starring brings it back", async ({
    page,
  }) => {
    await reachSources(page);
    const auto = page.locator(".slot").getByText(en.autoReference);
    await expect(auto).toBeVisible();

    await mark(page, WAV, "ZOOM0001.WAV");
    const star = inspector(page).getByLabel(`${en.makeReference}: ZOOM0001.WAV`);
    await expect(star).toHaveAttribute("aria-pressed", "false");

    await star.click();

    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect(star).toHaveClass(/refbtn--active/);
    await expect(auto).toBeHidden();

    // The same control toggles it off — the operator can hand the choice back.
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await expect(auto).toBeVisible();
  });

  test("removing the reference file gives the choice back to the engine", async ({ page }) => {
    await reachSources(page, runSyncSpy(syncOutcome()));

    await mark(page, WAV, "ZOOM0001.WAV");
    await inspector(page).getByLabel(`${en.makeReference}: ZOOM0001.WAV`).click();
    await expect(page.locator(".slot").getByText(en.autoReference)).toBeHidden();

    await inspector(page).getByLabel(`${en.removeFile}: ZOOM0001.WAV`).click();

    // The star went with the file. Anything else would have the run naming a reference the
    // engine was told to skip — and the engine picking its own instead, silently.
    await expect(page.locator(".slot").getByText(en.autoReference)).toBeVisible();
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);
    const args = await recorded(page, "__E2E_SYNC_ARGS__");
    expect(args.reference).toBeNull();
    expect(args.excludeFiles).toEqual([WAV]);
  });
});

test.describe("removing a file that could not be read", () => {
  test("the ✕ is on the problem rows too, and the row leaves the popover", async ({ page }) => {
    // "om de kan leses eller ikke" — the operator does not sort the drop into removable and
    // non-removable. The lens-cap take and the file that would not decode are one wish. A
    // problem file has no clip to mark, so its ✕ stays on its own row (D-077 #12).
    const withProblem = scanManifest({ unsynced: [{ file: BROKEN, reason: "decode_error" }] });
    await reachSources(page, {}, withProblem);

    const problems = sources(page).locator(".popover--problems");
    await problems.locator("> summary").click();
    await expect(problems.getByText("broken.mp4")).toBeVisible();

    await problems.getByLabel(`${en.removeFile}: broken.mp4`).click();

    // No problem files left: the chip and its popover both go.
    await expect(sources(page).locator(".popover--problems")).toHaveCount(0);
    // …but the file is not lost — it is listed as removed, reason and all, with an undo.
    const removed = page.locator(".slot__removed");
    await removed.locator("> summary").click();
    await expect(removed.getByText("broken.mp4")).toBeVisible();
    await expect(removed.getByText(en.reasonDecodeError)).toBeVisible();
  });
});

test.describe("the removal reaches the engine, not just the screen", () => {
  test("run_sync is told which files to leave out", async ({ page }) => {
    await reachSources(page, runSyncSpy(syncOutcome()));
    await mark(page, CAM_B, "C0002.MP4");
    await inspector(page).getByLabel(`${en.removeFile}: C0002.MP4`).click();

    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);

    // D-060: the shell cannot enforce this by trimming `inputs` — `sync` re-walks every
    // folder it is given, and would find the file again.
    const args = await recorded(page, "__E2E_SYNC_ARGS__");
    expect(args.excludeFiles).toEqual([CAM_B]);
    expect(args.inputs).toEqual(["/Users/e2e/shoot"]);
  });

  test("with nothing removed the field is null, not an empty list", async ({ page }) => {
    // Absent and empty mean the same thing to the backend (`#[serde(default)]`), and a
    // frontend that never sends the field must behave exactly as it did before D-060.
    await reachSources(page, runSyncSpy(syncOutcome()));
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);

    const args = await recorded(page, "__E2E_SYNC_ARGS__");
    expect(args.excludeFiles).toBeNull();
  });

  test("export_timeline is told too — the F6 fingerprint depends on it", async ({ page }) => {
    await reachSources(page, { ...runSyncSpy(syncOutcome()), ...exportSpy() });
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);

    // Removing AFTER the sync makes the result stale, so this export goes through the
    // re-sync first — which is the honest path, and the one that proves the exclusion is
    // carried all the way to the export call.
    //
    // The PLACED clip, not Camera B: post-sync the timeline draws what the run placed, and the
    // inspector describes the marked clip. `syncOutcome()` places only C0001.MP4, so it is the
    // only clip there is to point at — which is exactly the operator's situation too.
    await mark(page, CAM_A, "C0001.MP4");
    await inspector(page).getByLabel(`${en.removeFile}: C0001.MP4`).click();
    await expect(page.getByText(en.staleResult)).toBeVisible();
    await expect(page.getByRole("button", { name: en.exportButton })).toBeDisabled();

    await page.getByRole("button", { name: en.resyncButton }).click();
    await expect(page.getByRole("button", { name: en.exportButton })).toBeEnabled();
    await page.getByRole("button", { name: en.exportButton }).click();

    await expect
      .poll(async () => (await recorded(page, "__E2E_EXPORT_ARGS__"))?.excludeFiles)
      .toEqual([CAM_A]);
  });
});

test.describe("the unsynced shelf, now inside the problem popover (D-079)", () => {
  test("a shelf row can be removed as well as reassigned", async ({ page }) => {
    // The row the operator is most likely to want gone — "this one never works, stop telling
    // me". Before D-062 the only way to act on it was to re-drop the folder; before D-079 the
    // shelf was a red box under the timeline, which is a row the fixed room does not have.
    const base = syncOutcome();
    const outcomeWithUnsynced = {
      ...base,
      result: {
        ...(base.result as Record<string, unknown>),
        placements: [],
        unsynced: [{ file: CAM_A, reason: "low_confidence" }],
      },
    };
    await reachSources(page, runSyncSpy(outcomeWithUnsynced), scanManifest());
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);

    // The chip counts what the ENGINE refused as well as what the scan did — from where the
    // operator stands they are one question, and a chip that went quiet the moment a run
    // produced something to say would be the worst possible time for it to.
    const problems = sources(page).locator(".popover--problems");
    await expect(problems.locator("> summary")).toHaveText(en.problemCount(1));
    await problems.locator("> summary").click();
    const shelf = problems.locator(".shelf");
    await expect(shelf).toBeVisible();

    await shelf.getByLabel(`${en.removeFile}: C0001.MP4`).click();

    // The shelf empties, and the removal is a source change like any other.
    await expect(page.locator(".shelf")).toHaveCount(0);
    await expect(page.getByText(en.staleResult)).toBeVisible();

    await page.getByRole("button", { name: en.resyncButton }).click();
    await expect
      .poll(async () => (await recorded(page, "__E2E_SYNC_ARGS__")).excludeFiles)
      .toEqual([CAM_A]);
  });
});
