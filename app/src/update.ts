/**
 * In-app auto-updater client — E9 (docs/V02-PROGRAM.md E9), mirrors SundayRec's shape.
 *
 * Thin wrappers over the Rust updater commands in `lib.rs` (`update_check`,
 * `update_download_install`, `update_relaunch`). Every call passes the `beta` flag read
 * from the per-machine `betaChannel` setting, so the check hits the right ring
 * (`.../v1/update/sundaysync/{stable|beta}`) — the channel lives in localStorage, not a
 * database, so the frontend is the one that tells the backend which ring to poll.
 *
 * The backend returns only the terminal states (`upToDate` / `available` /
 * `readyToInstall` / `error`); the transient "checking" and "downloading" states are the
 * renderer's to drive — it sets "checking" before awaiting `checkForUpdate`, and listens
 * to the `update:progress` event for the live download percent while `downloadAndInstall`
 * runs. Every wrapper fails soft: a build without the commands (or a hung IPC) resolves to
 * an `error` phase rather than throwing, so the Settings panel never crashes over updates.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** The terminal + transient phases the Settings panel renders. */
export type UpdateStatus =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "upToDate" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "readyToInstall"; version: string }
  | { phase: "error"; message: string };

/** Payload of the `update:progress` event the backend emits while downloading. */
export interface UpdateProgress {
  version: string;
  percent: number;
}

/** A generous IPC bound — a feed round-trip and a signature verify, not a media job. */
const CHECK_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not answer within ${ms} ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Check the chosen ring. Never throws — a failure becomes an `error` phase. */
export async function checkForUpdate(beta: boolean): Promise<UpdateStatus> {
  try {
    return await withTimeout(
      invoke<UpdateStatus>("update_check", { beta }),
      CHECK_TIMEOUT_MS,
      "update_check",
    );
  } catch (e) {
    return { phase: "error", message: String(e) };
  }
}

/**
 * Download + install the pending update from the chosen ring. Resolves to
 * `readyToInstall` on success. The live percent arrives via `subscribeProgress`, not the
 * return value. No timeout: a large installer over a slow line can legitimately take
 * minutes, and there is a visible progress bar the whole time.
 */
export async function downloadAndInstall(beta: boolean): Promise<UpdateStatus> {
  try {
    return await invoke<UpdateStatus>("update_download_install", { beta });
  } catch (e) {
    return { phase: "error", message: String(e) };
  }
}

/** Relaunch to apply a staged update. Best-effort — the app is about to exit anyway. */
export async function relaunchForUpdate(): Promise<void> {
  try {
    await invoke("update_relaunch");
  } catch {
    // The relaunch either exits the process (nothing left to report to) or fails, in
    // which case the staged update simply applies on the user's next manual restart.
  }
}

/** Subscribe to download-progress events. Returns an unsubscribe function. */
export async function subscribeProgress(
  onProgress: (p: UpdateProgress) => void,
): Promise<UnlistenFn> {
  return listen<UpdateProgress>("update:progress", (e) => onProgress(e.payload));
}
