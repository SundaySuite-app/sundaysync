import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Result as AxeResult, NodeResult } from "axe-core";
import {
  boot,
  BOOT_FIXTURES,
  consentSetSpy,
  controlled,
  emit,
  fn,
  resolveControlled,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForPending,
  waitForResult,
  type Fixtures,
} from "./harness";
import { en } from "../src/i18n";

/**
 * The accessibility gate (A, D-097).
 *
 * ## Why this file exists
 *
 * `docs/KNOWN_LIMITATIONS.md` used to say that axe flags the clip's nested rebuild control.
 * It was written from reading the code: there was **no accessibility checker anywhere in this
 * repository**, so nothing had ever flagged anything, and a second violation — or a
 * thirtieth — would have been just as invisible. The tidy round (D-094) found the claim and
 * could not check it. This file is the check.
 *
 * It matters more here than the phrase "accessibility gate" usually implies. SundaySync is
 * driven from a keyboard, in a dark room at the back of a church, on whatever screen the
 * desk has: a timeline with shortcuts, four disclosure popovers, two modal dialogs and a
 * transport. Small grey text that is merely *quiet* on a designer's display is *gone* on a
 * ten-year-old projector-shared monitor at 30 % brightness.
 *
 * ## What it asserts
 *
 * Every state the harness can produce is scanned with axe at **WCAG 2.1 level A and AA**
 * (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`), and every violation must be zero — except
 * the handful in `EXCLUSIONS` below, each of which names the axe rule, the element, and the
 * reason. There is deliberately **no `disableRules()` anywhere in this file**: a blanket
 * disable would hide the next instance of the same rule on a different element, which is the
 * exact failure the imagined-limitation was an instance of.
 *
 * The scan is the whole document, not a subtree. `<body>` holds `#root` holds `<main
 * class="app">` and nothing else, so scanning the document costs nothing extra and buys the
 * page-level rules a subtree scan would silently skip (`html-has-lang` — App.tsx writes
 * `document.documentElement.lang` from the language setting, and a screen reader that
 * mispronounces every string is a real bug, not a pedantic one). Popovers and dialogs are
 * rendered inside `.app` too, so an open panel is inside the same scan as the room behind it.
 */

const CAM_A = "/Users/e2e/shoot/CamA/C0001.MP4";

/** WCAG 2.1 A + AA. Not `best-practice`: this is a gate, and it has to be one the app can
 *  actually hold at green on every commit. */
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * The exclusion list — the whole of it.
 *
 * Every entry is one rule on one identified element, with the reason it is not a bug (or
 * whose bug it is). A node is excluded only when the rule matches AND the element matches:
 * `within` is checked in the page with `closest()`, so it can only ever exempt nodes that
 * really are inside that container, and `html` matches the element's own markup. Nothing
 * here exempts a rule everywhere.
 */
interface Exclusion {
  /** The axe rule id. */
  rule: string;
  /** The element, in words — what a reader of the report needs to picture. */
  element: string;
  /** Only nodes inside this container (checked with `closest()` in the page). */
  within?: string;
  /** Only nodes whose own markup matches. */
  html?: RegExp;
  /** Only in these states. Omitted = every state. */
  states?: string[];
  /** Why this is not a bug, or whose it is. */
  why: string;
}

const EXCLUSIONS: Exclusion[] = [
  {
    rule: "nested-interactive",
    element: "the clip's «Rebuild waveform» control, a role=button span inside the clip's own <button>",
    html: /class="[^"]*\bclip\b[^"]*"/,
    why:
      "D-054/D-055/D-065, and the trade is forced in both directions. The clip root must stay a " +
      "real <button>: the timeline tells a clip click from a background-pan gesture with " +
      "target.closest(\"button, …\"). A genuinely nested <button> is un-nested by the HTML " +
      "parser, which would break the DOM rather than merely fail a validator — so the rebuild " +
      "affordance is a role=button span with tabIndex, Enter/Space and aria-disabled. The " +
      "focus-visible audit for D-097 confirms it is a real tab stop with a visible ring, so the " +
      "practical cost is the flagged rule and not a lost control. THIS is the violation " +
      "KNOWN_LIMITATIONS claimed; it is now measured rather than imagined.",
  },
  {
    rule: "color-contrast",
    element: "the clip's own chrome — the filename and the waveform status drawn inside the box",
    html: /class="clip__(name|status)\b/,
    why:
      "DEFERRED to the timeline's owner, not accepted. A clip is a drawing: its ink is " +
      "`--clip-ink`, which changes with the clip's state (slate / blue / amber / green) and is " +
      "the same colour `drawWaveform` paints the bars in (clipChrome.ts, D-080). Re-inking the " +
      "chrome is a change to the timeline's colour language, measured against a 27 px box, and " +
      "belongs with whoever is holding `components/timeline/**`. Measured: `.clip__name` 2.57:1, " +
      "`.clip__status` 1.94–3.81:1 against the clip fills. TODO(timeline owner).",
  },
  {
    rule: "color-contrast",
    element: "the red «N problem files» chip on the strip",
    within: ".badge--problem",
    why:
      "DEFERRED to the conductor: it is a TOKEN decision, not a local one. `--red` (#ef4444) on " +
      "`--red-bg` over `--surface` composites to #271c2a and measures 4.34:1 — short of AA's " +
      "4.5:1 by 0.16, and short everywhere that pairing is used, not only here. The fix is a " +
      "lighter `--red` (e.g. #f87171 → 5.90:1) across the suite's shared token block, which is " +
      "not a change one track may make on its own. TODO(conductor).",
  },
  {
    rule: "color-contrast",
    element: "everything inside the sources cluster while a sync is running",
    within: ".strip__sources--busy",
    states: ["syncing"],
    why:
      "Not a bug: `.strip__sources--busy` is `opacity: .5` AND `pointer-events: none` — the " +
      "cluster is genuinely inactive while the engine runs, because an override or a removal " +
      "accepted now would silently belong to the NEXT run (D-061). WCAG 1.4.3 exempts inactive " +
      "user-interface components from the contrast minimum. The same text passes in every phase " +
      "where it is live.",
  },
  {
    rule: "color-contrast",
    element: "the timeline's ticks, gutter meta and zoom controls while a sync is running",
    within: ".timeline--busy",
    states: ["syncing"],
    why:
      "DEFERRED to the timeline's owner, and the honest reading is that this one is REAL. Unlike " +
      "the cluster above, `.timeline--busy` is dimmed but explicitly NOT inert (the CSS says so: " +
      "panning, zooming and marking all still work during a run), so the 1.4.3 exemption does not " +
      "apply. `opacity: .55` costs every caption in the view ~45 % of its contrast in the one " +
      "phase the operator is staring at it — measured 2.70:1 for text that reads 6.18:1 when the " +
      "class is off. The fix is a different way of saying «not an answer yet» (a wash, a border, a " +
      "smaller opacity step), which is a design change to D-061's dim. TODO(timeline owner).",
  },
  {
    rule: "label",
    element: "the read-only cache-folder field in Settings → Storage",
    within: ".settings",
    html: /readonly/,
    why:
      "DEFERRED to the settings owner. `SettingsPanel.tsx` renders `<input type=\"text\" readOnly " +
      "value={…} />` with no label of any kind, so a screen reader announces an unnamed edit " +
      "field showing a path. The fix is one `aria-label` in a file this track does not own. " +
      "TODO(settings owner).",
  },
];

/** A violation node, with the state it was found in, in one printable line. */
function describeNode(rule: AxeResult, node: NodeResult): string {
  const summary = (node.failureSummary ?? "").replace(/\s+/g, " ").trim();
  return `  · [${rule.id}] ${node.target.join(" ")}\n      ${summary}`;
}

/**
 * Run axe over the current document and assert nothing is left once `EXCLUSIONS` has had its
 * say. The failure message prints the rule, the element and axe's own explanation, so a
 * regression is actionable from the CI log alone.
 */
async function expectAccessible(page: Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();

  const left: string[] = [];
  for (const rule of results.violations) {
    for (const node of rule.nodes) {
      const selector = node.target.join(" ");
      let excused = false;
      for (const ex of EXCLUSIONS) {
        if (ex.rule !== rule.id) continue;
        if (ex.states && !ex.states.includes(state)) continue;
        if (ex.html && !ex.html.test(node.html)) continue;
        if (ex.within) {
          // Checked in the page, against the live element: an exclusion can only ever excuse a
          // node that really is inside the container it names.
          const inside = await page.evaluate(
            ([sel, within]) => !!document.querySelector(sel)?.closest(within),
            [selector, ex.within] as const,
          );
          if (!inside) continue;
        }
        excused = true;
        break;
      }
      if (!excused) left.push(describeNode(rule, node));
    }
  }

  expect(
    left,
    `axe found WCAG 2.1 A/AA violations in «${state}» that are not on the curated exclusion ` +
      `list in e2e/a11y.spec.ts (D-097). Fix the element, or add an entry that names the rule, ` +
      `the element and WHY:\n${left.join("\n")}\n`,
  ).toEqual([]);
}

/** A drop with something wrong in it and something skipped, so the problem chip and both slot
 *  chips exist to be opened — the three popovers a clean drop never shows. */
const PROBLEM_MANIFEST = scanManifest({
  unsynced: [{ file: "/Users/e2e/shoot/broken.mp4", reason: "decode_error" }],
  skipped: [{ file: "/Users/e2e/shoot/IMG_0001.HEIC", reason: "still_image" }],
});

async function reachSources(page: Page, extra: Fixtures = {}): Promise<void> {
  await boot(page, {
    fixtures: {
      ...BOOT_FIXTURES,
      "plugin:dialog|open": ["/Users/e2e/shoot"],
      scan_inputs: PROBLEM_MANIFEST,
      ...extra,
    },
    settings: SETTLED_SETTINGS,
  });
  await page.getByRole("button", { name: en.dropFolder }).click();
  await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeVisible();
}

/** Open one `<details>` popover, scan with the panel up, and close it again. */
async function scanWithPopover(page: Page, selector: string, state: string): Promise<void> {
  const popover = page.locator(selector);
  await popover.locator("> summary").click();
  await expect(popover.locator(".popover__panel")).toBeVisible();
  await expectAccessible(page, state);
  await page.keyboard.press("Escape");
  await expect(popover.locator(".popover__panel")).toBeHidden();
}

/**
 * The half of keyboard access axe cannot see: tab through the state and require every stop to
 * paint something. `:focus-visible` is one declaration at the top of `styles.css` and a handful
 * of local overrides, and the way it breaks is silent — one component sets `outline: none` to
 * tidy a border and its control becomes invisible to anyone driving the app from the keyboard,
 * which, in a dark room with a laptop on a stack of hymn books, is how this app is driven.
 *
 * A "ring" is an outline OR a box-shadow, because the app uses both: the tokened
 * `:focus-visible` outline everywhere, and a shadow on the controls that sit flush against a
 * border. Requiring the outline specifically would fail the ones that are visibly fine.
 *
 * `minStops` is the count MEASURED for that state, and it is the second assertion this
 * function makes: an empty `ringless` list is also what a walk that found three of
 * twenty-six controls returns, so without a floor the interesting half of the test could rot
 * to nothing and stay green. A track that legitimately removes a control lowers the number
 * here on purpose; one that removes a control by accident finds out.
 */
async function walkTabStops(page: Page, state: string, minStops: number): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    // Reset Chromium's sequential-focus navigation starting point, or the walk resumes
    // from wherever the last click left focus and never sees the head of the order.
    const r = document.createRange();
    r.setStart(document.body, 0);
    r.collapse(true);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  });
  const seen: string[] = [];
  const ringless: string[] = [];
  let wraps = 0;
  // Consecutive stops that were nothing new. A dialog's focus TRAP never leaves the document,
  // so it never wraps, and without this the walk spends its whole 120-press budget going round
  // a ring of eleven controls it has already measured — the two dialog walks were the slowest
  // thing in the file for no information at all.
  let sinceNew = 0;
  for (let i = 0; i < 120; i += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return {
        key: `${el.tagName.toLowerCase()}.${typeof el.className === "string" ? el.className : ""}|${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}`,
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        boxShadow: cs.boxShadow,
      };
    });
    // Focus left the document into the browser's own chrome; the next Tab re-enters at
    // the top. That is a wrap, not the end — and it is the only way to see the head of
    // the order when the walk started mid-document.
    if (stop === null) {
      wraps += 1;
      if (wraps > 1) break;
      continue;
    }
    if (seen.includes(stop.key)) {
      if (wraps > 0) break;
      sinceNew += 1;
      // A whole lap with nothing new: the order is closed and every stop in it is measured.
      if (sinceNew > seen.length) break;
      continue;
    }
    sinceNew = 0;
    seen.push(stop.key);
    const noOutline = stop.outlineStyle === "none" || parseFloat(stop.outlineWidth) === 0;
    if (noOutline && stop.boxShadow === "none") ringless.push(stop.key);
  }
  // A walk that found nothing is a walk that proved nothing — and it is what this test looks
  // like when a selector rots, so it has to be a failure rather than a silent pass.
  expect(
    seen.length,
    `${state}: the tab walk found ${seen.length} stops, fewer than the ${minStops} this state has`,
  ).toBeGreaterThanOrEqual(minStops);
  expect(
    ringless,
    `${state}: these tab stops have neither an outline nor a box-shadow when focused ` +
      `by keyboard — a keyboard user cannot see where they are`,
  ).toEqual([]);
}

test.describe("accessibility (WCAG 2.1 A/AA)", () => {
  test("the room: empty, sources, every popover, and a marked clip", async ({ page }) => {
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: PROBLEM_MANIFEST,
      },
      settings: SETTLED_SETTINGS,
    });
    await expectAccessible(page, "empty");

    await page.getByRole("button", { name: en.dropFolder }).click();
    await expect(page.getByRole("region", { name: en.sourcesTitle })).toBeVisible();
    await expectAccessible(page, "sources");

    // All four disclosures, each scanned OPEN — a panel that is only ever scanned shut is a
    // panel that has never been scanned. The removed chip needs something removed first, so
    // the marked-clip state below comes before it.
    await scanWithPopover(page, ".popover--sources", "sources + «Kilder» open");
    await scanWithPopover(page, ".popover--problems", "sources + problems open");
    await scanWithPopover(page, ".slot__skipped", "sources + skipped chip open");

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(page.locator(".preview__name")).toHaveText("C0001.MP4");
    await expectAccessible(page, "sources + a marked clip");

    await page.locator(".inspector").getByLabel(`${en.removeFile}: C0001.MP4`).click();
    await scanWithPopover(page, ".slot__removed", "sources + removed chip open");
  });

  test("syncing, with the band up and a stage reported", async ({ page }) => {
    await reachSources(page, { run_sync: controlled("run_sync") });
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await emit(page, "sync:progress", { stage: "Correlating", completed: 2, total: 5 });
    await expect(page.locator(".progress__label")).toContainText("2/5");
    await expectAccessible(page, "syncing");
  });

  test("result, a marked clip, the export receipt, and an error toast", async ({ page }) => {
    await reachSources(page, {
      run_sync: controlled("run_sync"),
      "plugin:dialog|save": "/Users/e2e/out/x.fcpxml",
      export_timeline: 1,
    });
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForPending(page, "run_sync");
    await resolveControlled(page, "run_sync", syncOutcome());
    await waitForResult(page);
    await expectAccessible(page, "result");

    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(page.locator(".preview__name")).toHaveText("C0001.MP4");
    await expectAccessible(page, "result + a marked clip");

    // The receipt (D-092 ⑤) — a button whose accessible name ends in «Vis i Finder».
    await page.getByRole("button", { name: en.exportButton }).click();
    await expect(page.getByRole("button", { name: en.revealInFinder })).toBeVisible();
    await expectAccessible(page, "result + export receipt");
  });

  test("an error toast, over the room it does not move", async ({ page }) => {
    await reachSources(page, {
      run_sync: syncOutcome(),
      "plugin:dialog|save": "/Users/e2e/out/x.fcpxml",
      export_timeline: fn(`() => Promise.reject("io: no space left on device")`),
    });
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);
    await page.getByRole("button", { name: en.exportButton }).click();
    await expect(page.locator(".banner--error")).toBeVisible();
    await expectAccessible(page, "result + error toast");
  });

  test("the rebuild affordance — the one nested control, measured at last", async ({ page }) => {
    // The state KNOWN_LIMITATIONS was written about and nobody had ever produced: a clip whose
    // analysis cache is empty offers «Bygg bølgeform på nytt» inside its own <button>. Without
    // this fixture the affordance never renders, so `nested-interactive` never fires and the
    // exclusion above would be a rule nothing exercises — an exclusion for a violation that
    // does not happen is worse than none, because it reads as coverage.
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: scanManifest(),
        run_sync: syncOutcome(),
        waveform_meta: fn(`(args) => Promise.reject("cache_missing:" + args.file)`),
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);
    await expect(
      page.getByRole("button", { name: en.waveformRegenerate }).first(),
    ).toBeVisible();
    await expectAccessible(page, "result + the rebuild affordance");
  });

  test("every tab stop shows a focus ring — the room", async ({ page }) => {
    // Walked in the two states with the most stops: the result phase (strip, timeline, gutter
    // mix buttons, clips, transport, inspector, slot — 26 stops) and the settings dialog,
    // whose focus trap makes it the one place the walk is a CYCLE rather than a line.
    await reachSources(page, { run_sync: syncOutcome() });
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);
    await page.locator(`.clip[data-file="${CAM_A}"]`).click();
    await expect(page.locator(".preview__name")).toHaveText("C0001.MP4");
    await walkTabStops(page, "result + a marked clip", 26);

    await page.getByRole("button", { name: en.settings }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await walkTabStops(page, "settings dialog", 11);
  });

  test("every tab stop shows a focus ring — the first three screens", async ({ page }) => {
    // The three screens an operator meets before there is anything to sync: the consent card,
    // the onboarding, and the empty room. Between them they are the whole of `ConsentCard`,
    // `Onboarding`, `DropZone`, `EmptyState` and the strip — few stops each, and for that
    // reason the easiest place for a missing ring to go unnoticed for a whole release.
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        telemetry_status: { consentVersion: null, granted: false, hasInstallId: false, queued: 0 },
        ...consentSetSpy(),
      },
      settings: SETTLED_SETTINGS,
    });
    await expect(page.getByRole("dialog", { name: en.consentTitle })).toBeVisible();
    await walkTabStops(page, "consent card", 3);

    await boot(page, { fixtures: BOOT_FIXTURES, settings: { onboardingDone: false, lang: "en" } });
    await expect(page.getByRole("dialog", { name: en.obTitle1 })).toBeVisible();
    await walkTabStops(page, "onboarding step 1", 3);

    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });
    await expect(page.getByRole("button", { name: en.dropFolder })).toBeVisible();
    await walkTabStops(page, "empty", 3);
  });

  test("the dialogs: settings, onboarding, consent", async ({ page }) => {
    await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });
    await page.getByRole("button", { name: en.settings }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectAccessible(page, "settings dialog");

    await boot(page, {
      fixtures: BOOT_FIXTURES,
      settings: { onboardingDone: false, lang: "en" },
    });
    await expect(page.getByRole("dialog", { name: en.obTitle1 })).toBeVisible();
    await expectAccessible(page, "onboarding step 1");
    await page.getByRole("button", { name: en.obNext }).click();
    await page.getByRole("button", { name: en.obNext }).click();
    await expect(page.getByRole("heading", { name: en.obTitle3 })).toBeVisible();
    await expectAccessible(page, "onboarding step 3");

    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        telemetry_status: { consentVersion: null, granted: false, hasInstallId: false, queued: 0 },
        ...consentSetSpy(),
      },
      settings: SETTLED_SETTINGS,
    });
    await expect(page.getByRole("dialog", { name: en.consentTitle })).toBeVisible();
    await expectAccessible(page, "consent card");
  });

  test("settings with an update offered, and the release note it came with", async ({ page }) => {
    // Settings has a SECOND shape, and it is the one an operator sees twenty minutes before a
    // service: an offered version, and the note that came with it (D-095). Scanning only the
    // resting dialog would have missed it — and did: the note's heading landed painted in
    // `--text3` one commit before this gate did, which is exactly the "a second violation
    // would be just as invisible" this file exists to end.
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        update_check: {
          phase: "available",
          version: "0.9.9",
          notes: "Blackout er flyttet fra Escape til Shift+B.\nEksport tar med kameranavnet.",
        },
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.settings }).click();
    await page.getByRole("button", { name: en.updateCheck }).click();
    await expect(page.getByRole("group", { name: en.updateNotesTitle })).toBeVisible();
    await expectAccessible(page, "settings dialog + an update with a release note");
  });
});
