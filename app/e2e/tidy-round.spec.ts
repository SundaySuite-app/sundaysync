import { test, expect, type Page } from "@playwright/test";
import {
  boot,
  BOOT_FIXTURES,
  fn,
  scanManifest,
  SETTLED_SETTINGS,
  syncOutcome,
  waitForResult,
} from "./harness";
import { en, nb } from "../src/i18n";

// The tidy-up round (R, docs/DECISIONS.md D-094). Three things the design review measured
// and this file pins, at BOTH sizes the app supports — 1280×800 and the 1024×600 floor
// `tauri.conf.json` declares (`minWidth`/`minHeight`).
//
// Each of these failed on main at 059616b before the fix; the numbers in the comments are
// what main actually produced.

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 600 },
];

/** Is `inner` fully inside `outer`, to the nearest pixel? */
async function contains(
  page: Page,
  outer: string,
  inner: ReturnType<Page["locator"]>,
): Promise<boolean> {
  const o = await page.locator(outer).boundingBox();
  const i = await inner.boundingBox();
  if (!o || !i) return false;
  return i.y >= o.y - 1 && i.y + i.height <= o.y + o.height + 1;
}

test.describe("the settings dialog fits the window it opens in", () => {
  for (const size of SIZES) {
    test(`at ${size.width}×${size.height} the body scrolls and the frame holds still`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await boot(page, { fixtures: BOOT_FIXTURES, settings: SETTLED_SETTINGS });
      await page.getByRole("button", { name: en.settings }).click();
      const dialog = page.getByRole("dialog", { name: en.settings });
      await expect(dialog).toBeVisible();

      // The dialog is inside the window at all. (True on main too — `max-height: 85vh`
      // already saw to that. It is the premise the rest of this test rests on.)
      const box = (await dialog.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);

      // The panel genuinely overflows: this is a scrolling test, not a "it happens to fit
      // today" test, and it must keep being one as the copy changes.
      const body = dialog.locator(".dialog__body");
      const overflow = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(overflow).toBeGreaterThan(0);

      // Reach the LAST control in the panel — the diagnostics button, at the bottom of a
      // panel that is roughly twice the height of the box holding it.
      const last = dialog.getByRole("button", { name: en.diagnostics });
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeVisible();
      expect(await contains(page, ".dialog", last)).toBe(true);

      // It was the BODY that moved, not the page. (`.dialog` used to be the scroller
      // itself; the page has never scrolled and must not start.)
      expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);

      // …and the frame did not go with it. THIS is what failed on main: with the whole
      // dialog scrolling, the absolutely-positioned ✕ and the heading were carried ~750 px
      // above the top of the SCREEN (measured at both sizes) the moment the operator
      // reached the bottom of the panel, leaving Escape as the only way out.
      const close = dialog.getByRole("button", { name: en.close });
      await expect(close).toBeVisible();
      expect(await contains(page, ".dialog", close)).toBe(true);
      const title = dialog.locator("h2");
      await expect(title).toBeVisible();
      expect(await contains(page, ".dialog", title)).toBe(true);

      // Every control is still there — trimming the prose must not have trimmed the panel.
      // (`settings.spec.ts` owns what each of them does.)
      for (const name of [en.language, en.minPsr, en.segmentCount, en.cacheCap]) {
        await expect(dialog.getByLabel(name)).toHaveCount(1);
      }
      for (const name of [en.driftCorrect, en.playbackDriftCorrect, en.betaChannelLabel]) {
        await expect(dialog.getByRole("checkbox", { name })).toHaveCount(1);
      }
      for (const name of [en.cachePick, en.updateCheck, en.showOnboarding, en.diagnostics]) {
        await expect(dialog.getByRole("button", { name })).toHaveCount(1);
      }
    });
  }
});

test.describe("the gutter shows the device name, not an ellipsis", () => {
  /** A recorder whose real-world name is longer than the gutter's word budget. */
  const LONG = "ZOOM H6 — Hovedmikser i menighetssalen";

  async function longNamedResult(page: Page) {
    const base = syncOutcome();
    const result = base.result as Record<string, unknown>;
    const devices = (result.devices as Record<string, unknown>[]).map((d) =>
      d.id === "rec" ? { ...d, label: LONG } : d,
    );
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e/shoot"],
        scan_inputs: scanManifest(),
        run_sync: { ...base, result: { ...result, devices } },
      },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.dropFolder }).click();
    await page.getByRole("button", { name: en.syncButton }).click();
    await waitForResult(page);
  }

  for (const size of SIZES) {
    test(`at ${size.width}×${size.height} a long name stays readable WITH the mark present`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await longNamedResult(page);

      const row = page.getByRole("group", { name: en.trackAria(LONG) });
      await expect(row).toBeVisible();

      // The mark is present and named. It is a ★ now, not the word — see Track.tsx.
      const mark = row.getByRole("img", { name: en.reference });
      await expect(mark).toHaveCount(1);
      await expect(row.locator(".badge--ref")).toHaveCount(1);

      // The name gets the room. Measured, both sizes, same fixture: main gave it **46.1 px**
      // and showed «ZOOM…»; it gives it **92.7 px** now. The badge's ~60 px of «Reference»
      // was winning because `.track__name` has `overflow: hidden` — automatic minimum size
      // 0 — while a `white-space: nowrap` badge has none, so the name was the only thing on
      // the line that could shrink, and it shrank to nothing. The bar is set between the two
      // numbers with room on both sides: this pins that the name outranks the mark, not the
      // exact pixel a font update could move.
      const name = row.locator(".track__name");
      const nameBox = (await name.boundingBox())!;
      expect(nameBox.width).toBeGreaterThan(85);

      // The same fact as a fraction of the name it is trying to show — 0.175 on main, 0.354
      // now. Independent of the gutter's own width, so it survives a re-tuned `--tl-gutter`.
      const shown = await name.evaluate((el) => el.clientWidth / el.scrollWidth);
      expect(shown).toBeGreaterThan(0.30);

      // Enough of it is actually legible to tell this device from another: the rendered
      // text reaches past the first word. (`scrollWidth > clientWidth` is still true — the
      // name IS longer than any gutter — so this asserts how much shows, not that all does.)


      // The mark sits on line one, beside the name — not folded into line two's footnote.
      const markBox = (await mark.boundingBox())!;
      expect(markBox.y + markBox.height / 2).toBeGreaterThan(nameBox.y);
      expect(markBox.y + markBox.height / 2).toBeLessThan(nameBox.y + nameBox.height + 2);
      // …and it did not push the name out of the gutter.
      const gutter = (await row.locator(".track__gutter").boundingBox())!;
      expect(markBox.x + markBox.width).toBeLessThanOrEqual(gutter.x + gutter.width + 1);
    });
  }
});

test.describe("engine rejections reach the operator in the operator's language", () => {
  async function openSettings(page: Page, fixtures: Record<string, unknown>) {
    await boot(page, {
      fixtures: { ...BOOT_FIXTURES, ...fixtures },
      settings: SETTLED_SETTINGS,
    });
    await page.getByRole("button", { name: en.settings }).click();
    await expect(page.getByRole("dialog", { name: en.settings })).toBeVisible();
  }

  test("a message the mapping knows renders its own sentence, with no English left", async ({
    page,
  }) => {
    // S-7/D-032: Clear pointed at a folder SundaySync never wrote. Reachable by anyone who
    // has used «Velg mappe» — and on main it read «Something went wrong: refusing to clear
    // /Users/e2e/elsewhere: not a SundaySync cache directory».
    await openSettings(page, {
      cache_status: { dir: "/Users/e2e/elsewhere", entries: 4, bytes: 1000 },
      clear_cache: fn(
        `() => { throw "refusing to clear /Users/e2e/elsewhere: not a SundaySync cache directory"; }`,
      ),
    });
    const dialog = page.getByRole("dialog", { name: en.settings });
    await dialog.getByRole("button", { name: en.cacheClear }).click();
    await dialog.getByRole("button", { name: en.cacheClear }).click();

    const banner = page.locator(".banner");
    await expect(banner).toContainText(en.errNotACacheDir("/Users/e2e/elsewhere"));
    await expect(banner).not.toContainText("not a SundaySync cache directory");
  });

  test("a message the mapping does NOT know keeps its frame, and never lands bare", async ({
    page,
  }) => {
    // §7.5's honesty rule for failures. The engine string is invented on purpose: the point
    // is what happens to one the app has never heard of, which is the case that must not
    // put naked English on screen.
    const raw = "no common audio: the recorder and the cameras share no overlapping sound";
    await openSettings(page, {
      cache_status: { dir: "/Users/e2e/cache", entries: 4, bytes: 1000 },
      clear_cache: fn(`() => { throw ${JSON.stringify(raw)}; }`),
    });
    const dialog = page.getByRole("dialog", { name: en.settings });
    await dialog.getByRole("button", { name: en.cacheClear }).click();
    await dialog.getByRole("button", { name: en.cacheClear }).click();

    const banner = page.locator(".banner");
    // The raw detail survives — throwing away the only fact there is helps nobody — but it
    // is quoted, inside a sentence in the UI's own language, and never alone. `toContainText`
    // over the WHOLE framed string is what makes "never bare" testable: a banner holding
    // only `raw` fails it.
    await expect(banner).toContainText(en.errUnknown(raw));
    await expect(banner).not.toHaveText(raw);
  });

  test("a scan refused for scale says which mistake it was, in Norwegian", async ({ page }) => {
    // D-032's mis-drop: a home directory or a whole disk. The most likely engine refusal an
    // operator produces by accident, and on main it read «Noe gikk galt: too many files to
    // scan (limit 20000); this looks like a mis-selected folder».
    await boot(page, {
      fixtures: {
        ...BOOT_FIXTURES,
        "plugin:dialog|open": ["/Users/e2e"],
        scan_inputs: fn(
          `() => { throw "too many files to scan (limit 20000); this looks like a mis-selected folder"; }`,
        ),
      },
      settings: { ...SETTLED_SETTINGS, lang: "nb" as const },
    });
    await page.getByRole("button", { name: nb.dropFolder }).click();

    const banner = page.locator(".banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("20000");
    await expect(banner).not.toContainText("mis-selected folder");
    await expect(banner).not.toContainText("too many files to scan");
  });
});
