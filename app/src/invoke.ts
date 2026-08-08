/**
 * A timeout around Tauri's `invoke` — F11 (frontend half) + F14.
 *
 * No `invoke` in the app had a timeout. Sync and scan carry their own cancel path, so a
 * user can always escape those; but a command with no cancel — `check_sidecar` above all,
 * which spawns `ffmpeg -version` — can wedge the UI forever if the backend hangs
 * (quarantine limbo, a bad FUSE mount). This races the call against a deadline and rejects
 * with a stable, distinguishable message on expiry so `errors.ts` can map it to a *notice*
 * (a timeout is recoverable — the user can retry — not a red crash).
 *
 * Deliberately does NOT abort the underlying backend work: Tauri's `invoke` has no cancel
 * token, and there is nothing safe to abort. It bounds how long the *UI* waits, freeing the
 * onboarding flow to recover. Do not wrap `run_sync`/`scan_inputs` in a short timeout — a
 * legitimate multi-hour sync would trip it; those keep their real cancel path instead.
 */

import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

/** Stable prefix the rejection carries, matched by `mapEngineError` (D-030). */
export const INVOKE_TIMEOUT = "invoke-timeout";

/** A sane default for a self-test probe like `check_sidecar`. */
export const DEFAULT_INVOKE_TIMEOUT_MS = 10_000;

export function invokeWithTimeout<T>(
  cmd: string,
  args?: InvokeArgs,
  ms: number = DEFAULT_INVOKE_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${INVOKE_TIMEOUT}: ${cmd} did not answer within ${ms} ms`));
    }, ms);

    invoke<T>(cmd, args).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
