import { beforeEach, describe, expect, it, vi } from "vitest";

// Same shape as waveformStore.test.ts: mock the Tauri module so the test controls what "the
// backend" answers, hoisted so the mock factory can see the spy.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  cancelFramesExcept,
  fetchFrame,
  FRAME_HEIGHT_PX,
  frameTimeSeconds,
  hasFrame,
  isFrameInFlight,
  peekFrame,
  resetFrameCacheForTest,
} from "../timeline/frameStore";

const FILE_A = "/Users/e2e/shoot/CamA/C0001.MP4";
const FILE_B = "/Users/e2e/shoot/CamB/C0002.MP4";

/** A stand-in for the decoded bitmap. jsdom has no `createImageBitmap`, and what this
 *  module does with the result is hand it to a caller unchanged — so the identity is the
 *  only property worth asserting. */
const BITMAP = { width: 320, height: 180 } as unknown as ImageBitmap;

/** Some bytes that are not zero-length. Their content never matters here: the JPEG is
 *  decoded by the platform, and this module's job is which ANSWER it turns into. */
function jpegBytes(): ArrayBuffer {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
}

beforeEach(() => {
  invokeMock.mockReset();
  resetFrameCacheForTest();
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(BITMAP));
});

describe("frameTimeSeconds", () => {
  it("takes the frame 10 % in, so a black lead-in is not the preview", () => {
    expect(frameTimeSeconds(30)).toBe(3);
    expect(frameTimeSeconds(10)).toBe(1);
  });

  it("caps at 5 s — a 90-minute service previewed nine minutes in tells you nothing", () => {
    expect(frameTimeSeconds(3600)).toBe(5);
    expect(frameTimeSeconds(50)).toBe(5);
  });

  it("a missing or nonsensical duration grabs frame zero rather than a negative seek", () => {
    expect(frameTimeSeconds(0)).toBe(0);
    expect(frameTimeSeconds(-12)).toBe(0);
    expect(frameTimeSeconds(Number.NaN)).toBe(0);
    expect(frameTimeSeconds(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("fetchFrame", () => {
  it("asks video_frame for the computed time at the panel's height", async () => {
    invokeMock.mockResolvedValueOnce(jpegBytes());
    await fetchFrame(FILE_A, 30);
    expect(invokeMock).toHaveBeenCalledWith("video_frame", {
      file: FILE_A,
      atSeconds: 3,
      height: FRAME_HEIGHT_PX,
    });
  });

  // …and the height itself, as a number. The assertion above compares the constant with
  // itself and would survive any value at all — including one the shell refuses. V06-R1
  // (D-076) moved the still into the 300 px inspector column and doubled it to 320, which is
  // 2× the 151 px it is drawn at and still inside `lib.rs`'s `MAX_FRAME_HEIGHT` of 480. A
  // change past that ceiling would make every preview in the app fail with a range error,
  // which no other test in this file would notice.
  it("asks for a height the shell will accept", () => {
    expect(FRAME_HEIGHT_PX).toBe(320);
    expect(FRAME_HEIGHT_PX).toBeLessThanOrEqual(480);
  });

  it("dedupes concurrent calls for the same file into one ffmpeg spawn", async () => {
    let resolveInvoke!: (v: unknown) => void;
    invokeMock.mockReturnValueOnce(new Promise((r) => (resolveInvoke = r)));

    const a = fetchFrame(FILE_A, 30);
    const b = fetchFrame(FILE_A, 30);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);

    resolveInvoke(jpegBytes());
    expect(await a).toBe(BITMAP);
    expect(await b).toBe(BITMAP);
  });

  it("never asks twice for a file it has already seen", async () => {
    invokeMock.mockResolvedValueOnce(jpegBytes());
    expect(await fetchFrame(FILE_A, 30)).toBe(BITMAP);
    expect(await fetchFrame(FILE_A, 30)).toBe(BITMAP);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("different files never share an entry", async () => {
    const other = { width: 1, height: 1 } as unknown as ImageBitmap;
    invokeMock.mockResolvedValue(jpegBytes());
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValueOnce(BITMAP).mockResolvedValueOnce(other),
    );
    expect(await fetchFrame(FILE_A, 30)).toBe(BITMAP);
    expect(await fetchFrame(FILE_B, 30)).toBe(other);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  // D-069: `.WAV` and `.HEIC` exit 234 with ZERO bytes, and 32 of the owner's 386 files are
  // in that class. "No picture" is a success the panel renders calmly, and it is remembered
  // like any other answer — a card of WAVs must not re-spawn ffmpeg per click.
  it("an empty response is 'no picture', not an error, and is remembered", async () => {
    invokeMock.mockResolvedValueOnce(new ArrayBuffer(0));
    expect(await fetchFrame(FILE_A, 30)).toBeNull();
    // Never decoded: an empty buffer is answered by its byte length, not by a blob that
    // would have to fail.
    expect(createImageBitmap).not.toHaveBeenCalled();

    expect(await fetchFrame(FILE_A, 30)).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(hasFrame(FILE_A)).toBe(true);
    expect(peekFrame(FILE_A)).toBeNull();
  });

  it("a real failure resolves null rather than rejecting, and is remembered too", async () => {
    invokeMock.mockRejectedValueOnce("the preview of /x timed out after 20s");
    await expect(fetchFrame(FILE_A, 30)).resolves.toBeNull();

    await expect(fetchFrame(FILE_A, 30)).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1); // broken media does not re-spawn ffmpeg
  });

  // The one answer that says nothing about the FILE. Memoising it is the exact shape of the
  // bug D-064 was written for: a clip the operator clicked past once would show «ingen
  // bilde» for the rest of the session.
  it("a supersession is forgotten, so the next selection looks again", async () => {
    invokeMock.mockRejectedValueOnce("cancelled");
    await expect(fetchFrame(FILE_A, 30)).resolves.toBeNull();
    expect(hasFrame(FILE_A)).toBe(false);

    invokeMock.mockResolvedValueOnce(jpegBytes());
    expect(await fetchFrame(FILE_A, 30)).toBe(BITMAP);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(peekFrame(FILE_A)).toBe(BITMAP);
  });

  it("handles a supersession wrapped in an Error, like every other engine-prefix match", async () => {
    invokeMock.mockRejectedValueOnce(new Error("cancelled"));
    await expect(fetchFrame(FILE_A, 30)).resolves.toBeNull();
    expect(hasFrame(FILE_A)).toBe(false);
  });

  // ── V05-W5 sweep finding ─────────────────────────────────────────────────────────────
  //
  // The seam between two layers that are each correct on their own. The SHELL supersedes:
  // `video_frame` calls `install_thumbnail_cancel`, which cancels whatever token was there
  // before, so starting a grab kills every grab before it. The STORE dedupes: an entry that
  // has not settled is handed straight back to the next caller. Between them there is a
  // window — from the moment a newer grab starts until the older one's `cancelled`
  // rejection has crossed the IPC — in which the memo for the older file is a promise that
  // is already dead, and `fetchFrame` hands it out as if it were live.
  //
  // What the operator does to hit it: click clip A, click clip B, click back on A. Over SMB
  // a 4K frame takes ~4.4 s (D-069), so that window is seconds wide, not microseconds. The
  // panel then renders the supersession's `null` as «ingen bilde» — permanently, because
  // `PreviewFrame`'s effect is keyed on the file and will not run again — for a file with a
  // perfectly good picture in it. Exactly the shape D-070's own header warns about, one
  // layer further out than where it was guarded.
  it("never hands back a grab the shell has already superseded", async () => {
    let rejectA!: (e: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise((_res, rej) => (rejectA = rej)));
    const first = fetchFrame(FILE_A, 30);

    // The operator clicks B. This grab's own `install_thumbnail_cancel` has now killed A's
    // token in the shell; A's rejection is merely in flight.
    invokeMock.mockImplementationOnce(() => new Promise(() => {}));
    void fetchFrame(FILE_B, 30);

    // …and clicks straight back on A, before that rejection lands.
    invokeMock.mockImplementationOnce(() => Promise.resolve(jpegBytes()));
    const again = fetchFrame(FILE_A, 30);

    rejectA("cancelled");
    await expect(first).resolves.toBeNull(); // the dead one still answers its own caller
    expect(await again).toBe(BITMAP); // …but the new caller gets a real grab
    expect(peekFrame(FILE_A)).toBe(BITMAP);
    expect(hasFrame(FILE_A)).toBe(true);
  });

  it("a superseded grab's late answer never overwrites the memo of the one that replaced it", async () => {
    // The other order: the doomed grab happens to WIN its race with the cancel and comes
    // back with real bytes after a newer grab for the same file has already settled. The
    // newer answer is the one that describes the cache as it is now.
    let resolveA!: (v: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise((res) => (resolveA = res)));
    const doomed = fetchFrame(FILE_A, 30);

    invokeMock.mockImplementationOnce(() => new Promise(() => {}));
    void fetchFrame(FILE_B, 30);

    const fresh = { width: 1, height: 1 } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(fresh));
    invokeMock.mockImplementationOnce(() => Promise.resolve(jpegBytes()));
    expect(await fetchFrame(FILE_A, 30)).toBe(fresh);

    resolveA(jpegBytes());
    await doomed;
    expect(peekFrame(FILE_A)).toBe(fresh);
  });
});

describe("hasFrame / peekFrame", () => {
  it("say nothing until the grab settles — which is what keeps the panel honest", async () => {
    let resolveInvoke!: (v: unknown) => void;
    invokeMock.mockReturnValueOnce(new Promise((r) => (resolveInvoke = r)));

    const pending = fetchFrame(FILE_A, 30);
    expect(hasFrame(FILE_A)).toBe(false);
    expect(peekFrame(FILE_A)).toBeUndefined();
    expect(isFrameInFlight(FILE_A)).toBe(true);

    resolveInvoke(jpegBytes());
    await pending;
    expect(hasFrame(FILE_A)).toBe(true);
    expect(peekFrame(FILE_A)).toBe(BITMAP);
    expect(isFrameInFlight(FILE_A)).toBe(false);
  });
});

describe("cancelFramesExcept", () => {
  it("fires cancel_thumbnail for a grab the selection has moved past", () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "video_frame" ? new Promise(() => {}) : Promise.resolve(undefined),
    );

    void fetchFrame(FILE_A, 30);
    cancelFramesExcept(FILE_B);
    expect(invokeMock).toHaveBeenCalledWith("cancel_thumbnail");
  });

  // The whole reason this is phrased as "everything except". `StrictMode` mounts, unmounts
  // and remounts every effect, so the panel asks for the same file twice in a row; a
  // "cancel mine" call would throw the token of the grab it had just started, and the
  // remount would await it straight into a `cancelled` rejection — «ingen bilde» for a file
  // with a perfectly good picture in it.
  it("never cancels the grab for the file that is still selected", () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "video_frame" ? new Promise(() => {}) : Promise.resolve(undefined),
    );

    void fetchFrame(FILE_A, 30);
    cancelFramesExcept(FILE_A);
    cancelFramesExcept(FILE_A);
    expect(invokeMock).toHaveBeenCalledTimes(1); // the video_frame call, and nothing else
  });

  it("does nothing when nothing is running — there is no token to fire", async () => {
    invokeMock.mockResolvedValueOnce(jpegBytes());
    await fetchFrame(FILE_A, 30);
    invokeMock.mockClear();

    cancelFramesExcept(FILE_B);
    cancelFramesExcept(null);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fires once, not once per entry — the shell holds a single cancel token", () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "video_frame" ? new Promise(() => {}) : Promise.resolve(undefined),
    );
    void fetchFrame(FILE_A, 30);
    void fetchFrame(FILE_B, 30);
    invokeMock.mockClear();

    cancelFramesExcept(null);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("swallows a cancel that the backend refuses — nothing on screen depends on it", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "video_frame"
        ? new Promise(() => {})
        : Promise.reject(new Error("no Tauri backend in the browser tier")),
    );
    void fetchFrame(FILE_A, 30);
    expect(() => cancelFramesExcept(null)).not.toThrow();
    // Give the rejected promise a turn: an unhandled rejection here would fail the suite.
    await Promise.resolve();
  });
});
