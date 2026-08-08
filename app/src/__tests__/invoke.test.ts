import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wrapper races the real Tauri `invoke`; mock the module so the test controls how long
// "the backend" takes. `hoisted` so the mock factory can see the spy.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { mapEngineError } from "../errors";
import { nb } from "../i18n";
import { INVOKE_TIMEOUT, invokeWithTimeout } from "../invoke";

describe("invokeWithTimeout (F11/F14)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with a distinguishable timeout error when the backend hangs past the bound", async () => {
    // A backend that never resolves — the exact wedge F11 describes (ffmpeg -version hung).
    invokeMock.mockReturnValue(new Promise(() => {}));

    const call = invokeWithTimeout("check_sidecar", undefined, 10_000);
    const assertion = expect(call).rejects.toThrow(INVOKE_TIMEOUT);

    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("maps the timeout error to a recoverable NOTICE, not a red crash", async () => {
    invokeMock.mockReturnValue(new Promise(() => {}));
    const call = invokeWithTimeout("check_sidecar", undefined, 5_000).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(5_000);
    const err = await call;

    const mapped = mapEngineError(String(err), nb);
    expect(mapped.kind).toBe("notice");
    expect(mapped.text).toBe(nb.noticeTimeout);
  });

  it("resolves with the value when the backend answers before the bound", async () => {
    invokeMock.mockResolvedValue(42);

    const call = invokeWithTimeout<number>("cache_status", undefined, 10_000);
    // Let the resolved promise settle; the timer must never fire.
    await vi.advanceTimersByTimeAsync(0);

    await expect(call).resolves.toBe(42);
  });

  it("does not reject after a late timer once the call already resolved", async () => {
    invokeMock.mockResolvedValue("ok");

    const call = invokeWithTimeout<string>("cache_status", undefined, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(call).resolves.toBe("ok");

    // Advancing past the deadline must be a no-op — the timer was cleared on resolve, so
    // the already-settled promise stays resolved and no unhandled rejection is produced.
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(call).resolves.toBe("ok");
  });
});
