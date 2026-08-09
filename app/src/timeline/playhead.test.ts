// Adapted from SundayEdit (same owner) — src/features/timeline/playhead.test.ts; see docs/DECISIONS.md D-051.
/**
 * Shared playhead store — the bridge between the interactive timeline's
 * scrub/seek clock and consumers rendered outside it.
 *
 * `@testing-library/react` isn't a dependency of this app, so this ports the
 * source test's intent with a minimal manual harness instead of `renderHook`:
 * mount the hook via `react-dom/client` in jsdom, read its value off a probe
 * component. `vitest.config.ts` only globs `src/**\/*.test.ts`, so this stays
 * a `.ts` file (no JSX) and uses `createElement` directly.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

import { publishPlayheadMs, usePlayheadMs } from "./playhead";

function renderPlayheadHook(): {
  result: { current: number };
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const result: { current: number } = { current: NaN };
  // Definite-assignment: `act` below runs its callback synchronously, but
  // TS's control-flow analysis can't see through the callback boundary.
  let root!: Root;

  function Probe() {
    result.current = usePlayheadMs();
    return null;
  }

  act(() => {
    root = createRoot(container);
    root.render(createElement(Probe));
  });

  return {
    result,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("playhead store", () => {
  it("publishes the timeline playhead to hook subscribers", () => {
    const { result, unmount } = renderPlayheadHook();
    act(() => publishPlayheadMs(1234));
    expect(result.current).toBe(1234);
    act(() => publishPlayheadMs(0));
    expect(result.current).toBe(0);
    unmount();
  });

  it("late subscribers read the last published position", () => {
    act(() => publishPlayheadMs(5000));
    const { result, unmount } = renderPlayheadHook();
    expect(result.current).toBe(5000);
    unmount();
  });

  it("unsubscribes on unmount — no further re-renders, no leaked listeners", () => {
    const { result, unmount } = renderPlayheadHook();
    act(() => publishPlayheadMs(100));
    expect(result.current).toBe(100);
    unmount();
    // Publishing after unmount must not throw (dead listeners are dropped).
    act(() => publishPlayheadMs(200));
  });
});
