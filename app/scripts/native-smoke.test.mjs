/**
 * The native-smoke verdict, tested as a pure function — D-093.
 *
 * A CI gate whose pass/fail logic is only ever exercised on the runner is a gate you cannot
 * trust: the failure mode of a mistake in it is a GREEN job, which is worse than no job at
 * all. So every rule the runner enforces is asserted here, including the ones that only
 * matter on a platform this test does not run on.
 */

import { describe, expect, it } from "vitest";

import { defaultBinary, MIN_ELEMENT_COUNT, validateSmoke } from "./native-smoke.mjs";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

function ready(overrides = {}, frontend = {}) {
  return {
    smoke: "ready",
    ok: true,
    appVersion: "0.6.0-beta.4",
    os: "macos",
    arch: "aarch64",
    webviewVersion: "605.1.15",
    elapsedMs: 900,
    frontend: {
      userAgent: MAC_UA,
      mounted: true,
      rootWidth: 1280,
      rootHeight: 800,
      elementCount: 240,
      bodyBackground: "rgb(17, 17, 20)",
      bootErrors: [],
      readyMs: 412,
      devicePixelRatio: 2,
      language: "nb",
      ...frontend,
    },
    ...overrides,
  };
}

describe("validateSmoke", () => {
  it("passes a healthy macOS launch", () => {
    const v = validateSmoke(ready(), "darwin", 0);
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.notes.join(" ")).toContain("WKWebView");
  });

  it("passes a healthy Windows launch", () => {
    const v = validateSmoke(ready({ os: "windows" }, { userAgent: WIN_UA }), "win32", 0);
    expect(v.failures).toEqual([]);
    expect(v.notes.join(" ")).toContain("WebView2");
  });

  it("fails when no report was produced at all", () => {
    expect(validateSmoke(null, "darwin", 0).ok).toBe(false);
  });

  it("fails on the watchdog timeout — launched but never rendered", () => {
    const v = validateSmoke(
      { smoke: "timeout", ok: false, detail: "never reported" },
      "darwin",
      2,
    );
    expect(v.ok).toBe(false);
    expect(v.failures.join(" ")).toContain("never reported ready");
  });

  it("fails on a non-zero exit even when the report looks fine", () => {
    const v = validateSmoke(ready(), "darwin", 3);
    expect(v.ok).toBe(false);
    expect(v.failures.join(" ")).toContain("exited 3");
  });

  it("fails when React never mounted", () => {
    const v = validateSmoke(ready({}, { mounted: false }), "darwin", 0);
    expect(v.failures.join(" ")).toContain("never mounted");
  });

  // Mounted is a weak claim on its own: an empty <div> mounts too.
  it("fails when the root mounted but has no laid-out box", () => {
    const v = validateSmoke(ready({}, { rootHeight: 0 }), "darwin", 0);
    expect(v.failures.join(" ")).toContain("not rendered");
  });

  it("fails when the document is a shell rather than the app", () => {
    const v = validateSmoke(ready({}, { elementCount: MIN_ELEMENT_COUNT - 1 }), "darwin", 0);
    expect(v.failures.join(" ")).toContain("did not build its tree");
  });

  it("fails when the bundled stylesheet never applied", () => {
    for (const bg of ["", "rgba(0, 0, 0, 0)", "transparent", "(unavailable)"]) {
      const v = validateSmoke(ready({}, { bodyBackground: bg }), "darwin", 0);
      expect(v.failures.join(" "), bg).toContain("stylesheet never applied");
    }
  });

  // The whole point of the round: a JS error that only WebView2 or WKWebView produces.
  it("fails on any error caught during boot", () => {
    const v = validateSmoke(
      ready({}, { bootErrors: ["error: x.at is not a function"] }),
      "darwin",
      0,
    );
    expect(v.ok).toBe(false);
    expect(v.failures.join(" ")).toContain("x.at is not a function");
  });

  // The SundayEdit precedent, inverted: if the UA says Chrome on macOS then whatever we
  // just measured was not WKWebView, and every conclusion drawn from it is void.
  it("fails when macOS reports a Chromium user agent", () => {
    const v = validateSmoke(ready({}, { userAgent: WIN_UA }), "darwin", 0);
    expect(v.ok).toBe(false);
    expect(v.failures.join(" ")).toContain("NOT WKWebView");
  });

  it("fails when Windows reports a non-WebView2 user agent", () => {
    const v = validateSmoke(ready({}, { userAgent: MAC_UA }), "win32", 0);
    expect(v.ok).toBe(false);
    expect(v.failures.join(" ")).toContain("does not look like WebView2");
  });

  // WKWebView carries no `Safari` token — the exact fact behind the SundayEdit bug. The
  // gate must not quietly require one, or macOS would fail for the wrong reason forever.
  it("does not require a Safari token on macOS", () => {
    expect(MAC_UA).not.toContain("Safari");
    expect(validateSmoke(ready(), "darwin", 0).ok).toBe(true);
  });

  // The first check in this repo that runs the app AS BUNDLED, so it is also the first that
  // can see D-031's «ffmpeg travels inside the app» claim fail.
  it("fails when the bundled app cannot find its own ffmpeg", () => {
    const v = validateSmoke(
      ready(),
      "darwin",
      0,
      "ffmpeg could not be resolved at startup: no such file\n",
    );
    expect(v.ok).toBe(false);
    expect(v.failures.join(" ")).toContain("D-031");
  });

  it("ignores unrelated chatter on stdout", () => {
    expect(validateSmoke(ready(), "darwin", 0, "cache sweep: removed 3 entries\n").ok).toBe(true);
  });

  it("fails when the frontend section is missing entirely", () => {
    const v = validateSmoke({ smoke: "ready", ok: true }, "darwin", 0);
    expect(v.failures.join(" ")).toContain("never spoke");
  });
});

describe("defaultBinary", () => {
  it("launches the raw exe on Windows — that is exactly what NSIS ships", () => {
    expect(defaultBinary("win32", "/t")).toContain("sundaysync-app.exe");
  });

  it("launches the .app bundle on macOS, not the bare binary", () => {
    expect(defaultBinary("darwin", "/t").replace(/\\/g, "/")).toContain(
      "bundle/macos/SundaySync.app/Contents/MacOS",
    );
  });
});
