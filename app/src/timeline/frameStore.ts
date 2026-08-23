/**
 * One still frame per file, for the preview panel — V05-W4b (D-070), over W4a's
 * `video_frame` command (D-069).
 *
 * Structurally this is `sundayedit/src/features/media/thumbnails.ts`: a promise-memo keyed
 * on the file, at most one grab per file per session, and the 10 %-into-the-clip frame time
 * that dodges black lead-ins. What is deliberately NOT lifted is its tail. SundayEdit writes
 * a JPEG to its cache dir and hands back a `convertFileSrc()` URL; SundaySync has neither an
 * asset protocol nor a temp-file lifetime, and D-069 chose the shape that needs neither — the
 * bytes come back over the same binary IPC path `waveform_level` (D-052) and
 * `read_audio_window` (D-055) already use, become an `ImageBitmap`, and are drawn onto a
 * canvas. Nothing is written to disk.
 *
 * React-free, like `waveformStore.ts` and for the same reason: the part worth getting right
 * — never spawning ffmpeg twice for one file, and remembering the difference between "there
 * is no picture in this file" and "we were interrupted" — is bookkeeping, and bookkeeping is
 * easiest to test without a component tree around it.
 *
 * ## Three answers, not two
 *
 * - **a bitmap** — there was a frame.
 * - **`null`, remembered** — there is no picture in this file, or ffmpeg could not produce
 *   one. Measured (D-069): `.WAV` and `.HEIC` exit 234 with **zero bytes**, and 32 of the
 *   owner's 386 files are in that class. That is a normal outcome for about one file in
 *   twelve, so it is memoised exactly like a success: a card full of WAVs must not re-spawn
 *   ffmpeg every time the operator clicks one of them.
 * - **`null`, forgotten** — the grab was superseded (`cancel_thumbnail` fired while it was in
 *   flight). This is the one answer that says nothing about the file, so it must not be
 *   cached: memoising it would mean a clip the operator clicked past once shows «ingen bilde»
 *   for the rest of the session, which is exactly the shape of the bug D-064 was written for.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * How tall a preview frame is asked for, in pixels.
 *
 * The inspector's canvas is 151 px tall since V06-R1 (D-076) — a 300 px column has room for
 * a still you can actually judge, where the old 180 px band under the timeline had room for
 * a thumbnail. So this doubles with it: roughly 2× the drawn height for a retina screen, and
 * still inside the shell's `MAX_FRAME_HEIGHT` of 480. Measured in `lib.rs`: frames at the
 * old 160 came back at 6–11 KB, three orders of magnitude under the 2 MiB ceiling, and a
 * 2× linear increase is ~4× the pixels — tens of KB, nowhere near it.
 */
export const FRAME_HEIGHT_PX = 320;

/** Where in a clip the frame is grabbed: 10 % in, capped at 5 s. */
const FRAME_FRACTION = 0.1;
const FRAME_CAP_SECONDS = 5;

/**
 * The frame time for a clip of `durationSeconds`, in seconds.
 *
 * Lifted verbatim in intent from SundayEdit's `thumbTimeMs`: ten percent in dodges the black
 * lead-in a camera writes while its sensor settles, and the cap keeps a 90-minute service
 * from being previewed nine minutes in, where nothing distinguishes one camera from another.
 * A file with no (or a nonsensical) duration is grabbed at zero, which is the only honest
 * guess available.
 */
export function frameTimeSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(durationSeconds * FRAME_FRACTION, FRAME_CAP_SECONDS);
}

/** In-flight-or-settled grab per file. A settled entry is never re-invoked. */
const frames = new Map<string, Promise<ImageBitmap | null>>();

/** Settled values, so a consumer can render a known answer WITHOUT a loading tick. A
 *  `Promise` cannot be read synchronously, and a panel that flashed «henter …» for one
 *  microtask every time the operator re-selected a clip it had already seen would be
 *  reporting work that is not happening. */
const settled = new Map<string, ImageBitmap | null>();

/**
 * Files whose grab is still running, and WHICH grab owns each one.
 *
 * A `Set<string>` until V05-W5, and the promise is the half that was missing: every write
 * to the bookkeeping below is guarded by "is this still my entry?", the same identity check
 * the shell's own `clear_thumbnail_cancel_if_ours` performs on the cancel slot (F3). Two
 * grabs for one file can genuinely overlap — the operator clicks away and straight back —
 * and without the guard the older one's late settlement cleared the newer one's marker and
 * suppressed its memoised answer.
 */
const inFlight = new Map<string, Promise<ImageBitmap | null>>();

/** Has this file already been answered? Then {@link fetchFrame} costs no IPC. */
export function hasFrame(file: string): boolean {
  return settled.has(file);
}

/** The settled answer for `file`, or `undefined` if there is not one yet. */
export function peekFrame(file: string): ImageBitmap | null | undefined {
  return settled.get(file);
}

/** Is a grab for `file` running right now? */
export function isFrameInFlight(file: string): boolean {
  return inFlight.has(file);
}

/**
 * The still frame for `file`, grabbing it on first use.
 *
 * Resolves `null` when there is no picture — see the file header. Never rejects: every
 * caller of this is a panel drawing a thumbnail, and there is nothing a rejection could tell
 * it that `null` does not.
 */
export function fetchFrame(file: string, durationSeconds: number): Promise<ImageBitmap | null> {
  const cached = frames.get(file);
  if (cached) return cached;

  // ── V05-W5 sweep: everything already running is dead, so stop memoising it ───────────
  //
  // The shell supersedes on its own: `video_frame` opens with `install_thumbnail_cancel`,
  // which cancels whatever token was installed before it (`lib.rs`). Starting the grab
  // below therefore kills every grab that is currently in flight — that is a fact about
  // the backend, not a possibility.
  //
  // The memo has to say the same thing at the same moment. Until this, a doomed entry sat
  // in `frames` until its own `cancelled` rejection had crossed the IPC, and `fetchFrame`
  // handed it straight back to anyone who asked for that file in the meantime — a window
  // seconds wide over SMB (D-069: 4.4 s for a 4K frame). The caller then got the
  // supersession's `null`, which says nothing about the file, and `PreviewPanel` rendered
  // it as «ingen bilde» for good: its effect is keyed on the file and never runs again.
  // Click A, click B, click back on A — and the picture was gone for the session.
  //
  // Forgetting them here rather than when their rejections arrive closes the window
  // entirely. Their promises still settle and still answer whoever was already awaiting
  // them; they simply stop being the app's answer ABOUT those files.
  for (const doomed of [...inFlight.keys()]) {
    if (doomed === file) continue;
    frames.delete(doomed);
    inFlight.delete(doomed);
  }

  const grab = (async (): Promise<ImageBitmap | null> => {
    const bytes = await invoke<ArrayBuffer>("video_frame", {
      file,
      atSeconds: frameTimeSeconds(durationSeconds),
      height: FRAME_HEIGHT_PX,
    });
    // D-069's contract: an EMPTY response is the success that means "no picture". Read as a
    // byte length, never as a parsed error string.
    if (bytes.byteLength === 0) return null;
    return await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  })()
    .catch((e: unknown) => {
      // A supersession says nothing about the file — forget it so the next selection looks
      // again. Everything else (a timeout, an unreadable file, a blown ceiling) is a fact
      // about this file, and stands.
      //
      // Guarded by identity since V05-W5: by the time a doomed grab's rejection arrives,
      // a NEWER grab for the same file may already own the entry, and deleting it here
      // would throw away a perfectly good in-flight (or already settled) answer on the
      // strength of an older grab's death.
      if (isSupersession(e) && frames.get(file) === grab) frames.delete(file);
      return null;
    })
    .then((value) => {
      // Same guard, both writes. A grab that finishes late must not clear the marker of
      // the grab that replaced it — `cancelFramesExcept` reads this Map to decide what is
      // worth stopping, and a cleared marker means a running ffmpeg nobody can end.
      if (inFlight.get(file) === grab) inFlight.delete(file);
      // Only remember what is still the memo's own answer: a superseded grab loses its
      // entry (above, or to the newer grab that replaced it), and writing its `null` here
      // would put back the very fact that forgetting the entry was meant to forget.
      if (frames.get(file) === grab) settled.set(file, value);
      return value;
    });

  frames.set(file, grab);
  inFlight.set(file, grab);
  return grab;
}

/**
 * Stops any in-flight grab that is **not** for `file` — the selection has moved on.
 *
 * Not a convenience. `invoke` has no cancellation of its own (`app/src/invoke.ts`), so a
 * frame nobody wants any more holds one of the shell's two preview permits and a running
 * ffmpeg until it finishes on its own — over SMB, for seconds (D-069: 4.4 s on an 816 MB
 * DJI file). `cancel_thumbnail` is the only thing that can end it.
 *
 * ## Why it is phrased as "everything except", and not "cancel this one"
 *
 * The obvious shape — the panel's effect cancelling its own grab in its cleanup — cancels
 * the grab it just started. `main.tsx` renders under `React.StrictMode`, which mounts,
 * unmounts and remounts every effect in development: the cleanup fires for the file that is
 * still selected, the token is thrown, and the remount finds the memo entry already in
 * flight and simply awaits it — into a `cancelled` rejection. The panel then shows «ingen
 * bilde» for a file that has a perfectly good picture in it. (The e2e caught exactly this.)
 *
 * Asking for the *other* files instead makes the operation idempotent: called twice for the
 * same selection it is a no-op both times, and it says what is actually meant — whatever is
 * running for a clip nobody is looking at any more should stop.
 *
 * One call is enough however many entries there are: the shell holds a single cancel token
 * (`install_thumbnail_cancel`), and a second call would fire an already-fired token.
 *
 * Fire-and-forget in both directions: the command returns nothing, and a rejection here (no
 * backend, in the browser tier) is not a condition anything on screen should react to.
 */
export function cancelFramesExcept(file: string | null): void {
  for (const other of inFlight.keys()) {
    if (other === file) continue;
    void invoke("cancel_thumbnail").catch(() => {});
    return;
  }
}

/** The shell's word for a superseded or cancelled run — the same one `scan_inputs` and
 *  `prewarm_analysis` return, matched the way `errors.ts` matches every stable engine
 *  prefix (D-030). */
function isSupersession(e: unknown): boolean {
  return (e instanceof Error ? e.message : String(e)).startsWith("cancelled");
}

/** Test hook — the maps are module-level by design (see the file header), so without this
 *  a later test's call for the same path would be answered from an earlier test's memo
 *  instead of hitting the mock. Mirrors `resetWaveformCachesForTest`. */
export function resetFrameCacheForTest(): void {
  frames.clear();
  settled.clear();
  inFlight.clear();
}
