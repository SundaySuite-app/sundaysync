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

// Per-file removal (V04-U4, D-062) — the owner's ask, verbatim: "det må være mulig å
// fjerne filer som er lagt til på en enkel måte, om de kan leses eller ikke."
//
// Three claims no unit test can make:
//   1. A ✕ on a row actually takes the file out of everything the operator can see — the
//      timeline, the device groups, the counts.
//   2. It takes it out of the RUN, which is a different thing entirely: the exclusion has
//      to reach `run_sync` and `export_timeline` as `excludeFiles`, because the engine
//      re-walks every folder it is handed and would otherwise find the file again
//      (D-060). This file asserts the recorded invoke args, not the screen.
//   3. There is a way back. A removal with no undo turns one misclick into re-dropping
//      the whole card.

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
  await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeVisible();
}

function sourcesPanel(page: Page) {
  return page.getByRole("region", { name: en.sourcesTitle });
}

/** The ✕ on the row for `name`. Scoped to the panel so it can never match the roots' own
 *  remove button, which is a different control with a different label. */
function removeControl(page: Page, name: string) {
  return sourcesPanel(page).getByLabel(`${en.removeFile}: ${name}`);
}

test.describe("removing a readable file", () => {
  test("it leaves the timeline, the device groups and the counts", async ({ page }) => {
    await reachSources(page);
    await expect(page.locator(".clip")).toHaveCount(3);
    await expect(sourcesPanel(page).locator(".chips .chip", { hasText: en.fileCount(3) })).toBeVisible();

    await removeControl(page, "C0002.MP4").click();

    // The clip is gone from the timeline…
    await expect(page.locator(`.clip[data-file="${CAM_B}"]`)).toHaveCount(0);
    await expect(page.locator(".clip")).toHaveCount(2);
    // …its (now empty) device track with it, exactly as an override that empties a device
    // already does…
    await expect(page.getByRole("group", { name: en.trackAria("Camera B") })).toBeHidden();
    await expect(
      sourcesPanel(page).locator(".device-group__name").filter({ hasText: "Camera B" }),
    ).toBeHidden();
    // …and the chip counts what is left, not what was dropped.
    await expect(sourcesPanel(page).locator(".chips .chip", { hasText: en.fileCount(2) })).toBeVisible();
  });

  test("the way back: the removed group restores it everywhere", async ({ page }) => {
    await reachSources(page);
    await removeControl(page, "C0002.MP4").click();

    const removed = sourcesPanel(page).locator(".device-group--removed");
    // Collapsed like the problem group — a footnote, with its count on the summary.
    await expect(removed.getByText(en.removedTitle(1))).toBeVisible();
    await removed.locator("summary").click();
    await expect(removed.getByText("C0002.MP4")).toBeVisible();

    await removed.getByLabel(`${en.restoreFile}: C0002.MP4`).click();

    await expect(page.locator(`.clip[data-file="${CAM_B}"]`)).toHaveCount(1);
    await expect(page.getByRole("group", { name: en.trackAria("Camera B") })).toBeVisible();
    await expect(sourcesPanel(page).locator(".chips .chip", { hasText: en.fileCount(3) })).toBeVisible();
    // Nothing removed any more, so the group itself is gone.
    await expect(sourcesPanel(page).locator(".device-group--removed")).toHaveCount(0);
  });

  test("removing the reference file gives the choice back to the engine", async ({ page }) => {
    await reachSources(page, runSyncSpy(syncOutcome()));

    await sourcesPanel(page).getByLabel(`${en.makeReference}: ZOOM0001.WAV`).click();
    await expect(sourcesPanel(page).getByText(en.autoReference)).toBeHidden();

    await removeControl(page, "ZOOM0001.WAV").click();

    // The star went with the file. Anything else would have the run naming a reference the
    // engine was told to skip — and the engine picking its own instead, silently.
    await expect(sourcesPanel(page).getByText(en.autoReference)).toBeVisible();
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);
    const args = await recorded(page, "__E2E_SYNC_ARGS__");
    expect(args.reference).toBeNull();
    expect(args.excludeFiles).toEqual([WAV]);
  });
});

test.describe("removing a file that could not be read", () => {
  test("the ✕ is on the problem rows too, and the row leaves the group", async ({ page }) => {
    // "om de kan leses eller ikke" — the operator does not sort the drop into removable
    // and non-removable. The lens-cap take and the file that would not decode are one wish.
    const withProblem = scanManifest({
      unsynced: [{ file: BROKEN, reason: "decode_error" }],
    });
    await reachSources(page, {}, withProblem);

    const group = sourcesPanel(page).locator(".device-group--problems").first();
    await group.locator("summary").click();
    await expect(group.getByText("broken.mp4")).toBeVisible();

    await removeControl(page, "broken.mp4").click();

    // No problem files left: the group and its chip both go.
    await expect(sourcesPanel(page).locator(".chip.badge--problem")).toHaveCount(0);
    // …but the file is not lost — it is listed as removed, reason and all, with an undo.
    const removed = sourcesPanel(page).locator(".device-group--removed");
    await removed.locator("summary").click();
    await expect(removed.getByText("broken.mp4")).toBeVisible();
    await expect(removed.getByText(en.reasonDecodeError)).toBeVisible();
  });
});

test.describe("the removal reaches the engine, not just the screen", () => {
  test("run_sync is told which files to leave out", async ({ page }) => {
    await reachSources(page, runSyncSpy(syncOutcome()));
    await removeControl(page, "C0002.MP4").click();

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
    await removeControl(page, "C0002.MP4").click();
    await expect(page.getByText(en.staleResult)).toBeVisible();
    await expect(page.getByRole("button", { name: en.exportButton })).toBeDisabled();

    await page.getByRole("button", { name: en.resyncButton }).click();
    await expect(page.getByRole("button", { name: en.exportButton })).toBeEnabled();
    await page.getByRole("button", { name: en.exportButton }).click();

    await expect
      .poll(async () => (await recorded(page, "__E2E_EXPORT_ARGS__"))?.excludeFiles)
      .toEqual([CAM_B]);
  });
});

test.describe("the result view's unsynced shelf", () => {
  test("a shelf row can be removed as well as reassigned", async ({ page }) => {
    // The row the operator is most likely to want gone — "this one never works, stop
    // telling me". Before D-062 the only way to act on it was to re-drop the folder.
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

    const shelf = page.locator(".shelf");
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
