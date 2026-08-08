/**
 * Frontend error capture — pure payload shaping + rate limiting for `report_frontend_error`.
 *
 * Split out from App.tsx's `window.onerror`/`unhandledrejection` handlers so the logic
 * that actually matters is unit-testable without a DOM or a mocked `invoke`:
 *
 *  - `scrubPaths` — the consent copy promises "never filenames, folders, device names,
 *    or anything from your content". A JS stack trace can't leak media filenames, but it
 *    can easily contain the user's home directory path (`/Users/name/...`), which is
 *    exactly the kind of identifying detail the promise is about. Strip it before it ever
 *    reaches `reportFrontendError`.
 *  - `gateErrorReport` — a render loop that throws every frame must not flood the queue
 *    (or the backend) with thousands of reports. A same-error dedupe window plus a
 *    rolling rate cap keeps one bad render from becoming a telemetry incident of its own.
 */

export const MAX_MESSAGE_LENGTH = 500;
/** Repeat of the exact same error within this window is dropped as a duplicate. */
export const DEDUPE_WINDOW_MS = 30_000;
/** Rolling window the rate cap is measured over. */
export const RATE_WINDOW_MS = 60_000;
/** At most this many distinct reports are allowed per rolling window. */
export const RATE_MAX = 20;

// Windows patterns (with the drive letter) must run before the bare Unix pattern below —
// otherwise `/Users/...` inside `C:/Users/...` matches first and leaves a dangling `C:`.
const PATH_PATTERNS: RegExp[] = [
  /[A-Za-z]:\\Users\\[^\s'")\]]+/gi,
  /[A-Za-z]:\/Users\/[^\s'")\]]+/gi,
  /\/Users\/[^\s'")\]]+/gi,
  /\/home\/[^\s'")\]]+/gi,
];

/** Replaces anything that looks like a user/home-directory path with a `<path>` placeholder. */
export function scrubPaths(text: string): string {
  let out = text;
  for (const re of PATH_PATTERNS) {
    out = out.replace(re, "<path>");
  }
  return out;
}

export function truncateMessage(text: string, max: number = MAX_MESSAGE_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** Scrub + truncate + a non-empty fallback — the shape `report_frontend_error` receives. */
export function shapeErrorPayload(
  kind: string,
  rawMessage: string,
): { kind: string; message: string } {
  const message = truncateMessage(scrubPaths(rawMessage || "(no message)"));
  return { kind: kind.trim() || "error", message };
}

export function makeErrorKey(kind: string, message: string): string {
  return `${kind}:${message}`;
}

export interface ErrorGateState {
  /** Last-seen timestamp (ms) per dedupe key. */
  seen: Record<string, number>;
  /** Timestamps (ms) of reports allowed within the current rolling window. */
  windowHits: number[];
}

export const initialErrorGateState: ErrorGateState = { seen: {}, windowHits: [] };

/**
 * Decides whether a shaped (kind, message) pair should actually be sent, and returns the
 * next gate state. Pure — the caller supplies `now` so this is deterministic to test.
 */
export function gateErrorReport(
  state: ErrorGateState,
  kind: string,
  message: string,
  now: number,
): { allow: boolean; state: ErrorGateState } {
  const key = makeErrorKey(kind, message);
  const lastSeen = state.seen[key];
  if (lastSeen !== undefined && now - lastSeen < DEDUPE_WINDOW_MS) {
    return { allow: false, state };
  }

  const windowHits = state.windowHits.filter((t) => now - t < RATE_WINDOW_MS);
  if (windowHits.length >= RATE_MAX) {
    // Still record that we saw it — the window prune above must keep progressing even
    // while capped — but don't allow the send.
    return { allow: false, state: { ...state, windowHits } };
  }

  return {
    allow: true,
    state: {
      seen: { ...state.seen, [key]: now },
      windowHits: [...windowHits, now],
    },
  };
}
