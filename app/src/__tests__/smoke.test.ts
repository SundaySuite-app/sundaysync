/**
 * The frontend half of the native smoke gate — D-093.
 *
 * These assertions are about the SHAPE of the claim the webview makes about itself. The
 * claim itself can only be checked on a real WKWebView/WebView2 runner (`.github/workflows/
 * native-smoke.yml`); what is testable here is that the report is honest about a DOM that
 * has not rendered, that boot errors are captured and capped, and that nothing in the path
 * can throw into a normal launch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  bootErrorsSoFar,
  collectSmokeReport,
  MAX_BOOT_ERRORS,
  recordBootError,
  scheduleSmokeReport,
} from "../smoke";

describe("collectSmokeReport", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reports mounted=false and a zero box when nothing rendered", () => {
    document.body.innerHTML = `<div id="root"></div>`;
    const report = collectSmokeReport(document, window);
    expect(report.mounted).toBe(false);
    expect(report.rootHeight).toBe(0);
  });

  it("reports mounted once the root has children", () => {
    document.body.innerHTML = `<div id="root"><main><h1>SundaySync</h1></main></div>`;
    const report = collectSmokeReport(document, window);
    expect(report.mounted).toBe(true);
    expect(report.elementCount).toBeGreaterThan(0);
  });

  it("survives a missing root rather than throwing into boot", () => {
    expect(() => collectSmokeReport(document, window)).not.toThrow();
    expect(collectSmokeReport(document, window).mounted).toBe(false);
  });

  it("carries the user agent — the single field the whole gate exists for", () => {
    const report = collectSmokeReport(document, window);
    expect(report.userAgent).toBe(window.navigator.userAgent);
  });
});

// The capture buffer is module state and there is only one of it, so these run in order:
// the cap test fills it and must come last.
describe("boot error capture", () => {
  it("keeps kind and message", () => {
    recordBootError("error", "x.at is not a function");
    const captured = bootErrorsSoFar();
    expect(captured[captured.length - 1]).toBe("error: x.at is not a function");
  });

  it("gives an empty message a placeholder rather than a bare prefix", () => {
    recordBootError("error", "");
    expect(bootErrorsSoFar().join("|")).toContain("(no message)");
  });

  it("never grows without bound", () => {
    const before = bootErrorsSoFar().length;
    for (let i = 0; i < MAX_BOOT_ERRORS + 10; i += 1) recordBootError("error", `loop ${i}`);
    expect(bootErrorsSoFar().length).toBe(MAX_BOOT_ERRORS);
    expect(bootErrorsSoFar().length).toBeGreaterThanOrEqual(before);
  });
});

describe("scheduleSmokeReport", () => {
  // The one cost smoke mode imposes on a NORMAL launch is this call. It must not be able to
  // throw, whatever the environment: no Tauri at all (a browser), a Tauri that rejects the
  // command (the e2e harness has no fixture for it), or no rAF.
  it("does not throw when there is no Tauri to talk to", () => {
    expect(() => scheduleSmokeReport(window)).not.toThrow();
  });

  it("falls back to a timeout when the window has no requestAnimationFrame", () => {
    const setTimeoutSpy = vi.fn();
    const fake = {
      setTimeout: setTimeoutSpy,
      navigator: window.navigator,
      performance: window.performance,
      devicePixelRatio: 1,
    } as unknown as Window;
    expect(() => scheduleSmokeReport(fake)).not.toThrow();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("waits two frames so the root has been laid out before it is measured", () => {
    const frames: FrameRequestCallback[] = [];
    const fake = {
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        frames.push(cb);
        return frames.length;
      },
    } as unknown as Window;
    scheduleSmokeReport(fake);
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(frames).toHaveLength(2);
  });
});
