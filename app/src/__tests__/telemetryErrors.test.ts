import { describe, expect, it } from "vitest";
import {
  DEDUPE_WINDOW_MS,
  gateErrorReport,
  initialErrorGateState,
  MAX_MESSAGE_LENGTH,
  RATE_MAX,
  RATE_WINDOW_MS,
  scrubPaths,
  shapeErrorPayload,
  truncateMessage,
} from "../telemetryErrors";

describe("scrubPaths — the consent copy's 'never filenames/folders' promise", () => {
  it("replaces a macOS home-directory path with a placeholder", () => {
    expect(scrubPaths("ENOENT: /Users/richard/Documents/service.mov not found")).toBe(
      "ENOENT: <path> not found",
    );
  });

  it("replaces a Linux home-directory path", () => {
    expect(scrubPaths("failed to open /home/richard/media/cam1.mp4")).toBe(
      "failed to open <path>",
    );
  });

  it("replaces Windows-style user paths in both slash directions", () => {
    expect(scrubPaths("C:\\Users\\richard\\Videos\\a.mp4 is locked")).toBe(
      "<path> is locked",
    );
    expect(scrubPaths("C:/Users/richard/Videos/a.mp4 is locked")).toBe("<path> is locked");
  });

  it("leaves ordinary text untouched", () => {
    expect(scrubPaths("TypeError: cannot read properties of undefined")).toBe(
      "TypeError: cannot read properties of undefined",
    );
  });

  it("scrubs every path occurrence, not just the first", () => {
    const raw = "/Users/richard/a.mp4 and /Users/richard/b.mp4 both failed";
    expect(scrubPaths(raw)).toBe("<path> and <path> both failed");
  });
});

describe("truncateMessage", () => {
  it("leaves short messages alone", () => {
    expect(truncateMessage("short")).toBe("short");
  });

  it("caps long messages at the max length with an ellipsis", () => {
    const long = "x".repeat(MAX_MESSAGE_LENGTH + 50);
    const out = truncateMessage(long);
    expect(out.length).toBe(MAX_MESSAGE_LENGTH + 1); // +1 for the ellipsis char
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("shapeErrorPayload", () => {
  it("scrubs and truncates in one pass", () => {
    const { kind, message } = shapeErrorPayload("error", "boom at /Users/richard/x.mov");
    expect(kind).toBe("error");
    expect(message).toBe("boom at <path>");
  });

  it("falls back to a placeholder for an empty message", () => {
    expect(shapeErrorPayload("error", "").message).toBe("(no message)");
  });

  it("falls back to a default kind for an empty/whitespace kind", () => {
    expect(shapeErrorPayload("   ", "x").kind).toBe("error");
  });
});

describe("gateErrorReport — dedupe + rate cap", () => {
  it("allows the first occurrence of an error", () => {
    const { allow } = gateErrorReport(initialErrorGateState, "error", "boom", 0);
    expect(allow).toBe(true);
  });

  it("suppresses an identical repeat within the dedupe window", () => {
    const first = gateErrorReport(initialErrorGateState, "error", "boom", 0);
    const second = gateErrorReport(first.state, "error", "boom", DEDUPE_WINDOW_MS - 1);
    expect(second.allow).toBe(false);
  });

  it("allows the same error again once the dedupe window has passed", () => {
    const first = gateErrorReport(initialErrorGateState, "error", "boom", 0);
    const second = gateErrorReport(first.state, "error", "boom", DEDUPE_WINDOW_MS + 1);
    expect(second.allow).toBe(true);
  });

  it("treats different kinds/messages as distinct — no cross-suppression", () => {
    const first = gateErrorReport(initialErrorGateState, "error", "boom", 0);
    const second = gateErrorReport(first.state, "unhandledrejection", "boom", 0);
    expect(second.allow).toBe(true);
  });

  it("caps the number of distinct reports allowed within the rolling rate window", () => {
    let state = initialErrorGateState;
    let allowedCount = 0;
    for (let i = 0; i < RATE_MAX + 5; i++) {
      const result = gateErrorReport(state, "error", `distinct-${i}`, 0);
      state = result.state;
      if (result.allow) allowedCount++;
    }
    expect(allowedCount).toBe(RATE_MAX);
  });

  it("lets the rate cap recover once the window rolls forward", () => {
    let state = initialErrorGateState;
    for (let i = 0; i < RATE_MAX; i++) {
      state = gateErrorReport(state, "error", `distinct-${i}`, 0).state;
    }
    // Capped at t=0.
    expect(gateErrorReport(state, "error", "distinct-overflow", 0).allow).toBe(false);
    // Past the rate window, the old hits have aged out and a new report is allowed again.
    expect(gateErrorReport(state, "error", "distinct-overflow", RATE_WINDOW_MS + 1).allow).toBe(
      true,
    );
  });
});
