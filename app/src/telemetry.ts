/**
 * Telemetry client — E7 CONSENT-UX.
 *
 * Thin wrappers around the Rust telemetry commands owned by the telemetry-core agent in
 * this same stage (`telemetry_status`, `set_telemetry_consent`, `telemetry_preview`,
 * `report_frontend_error`, `request_telemetry_deletion`). Every call here is defensive:
 * if the core hasn't merged into this worktree yet, the commands simply don't exist at
 * runtime, and every wrapper below fails soft (`null`/`false`/no-op) instead of throwing,
 * so the consent UI still renders and the app never crashes over a missing telemetry
 * backend.
 *
 * Consent itself is NOT mirrored into localStorage settings (see settings.ts) — the Rust
 * side is the one source of truth for "has this install decided, and what". Components
 * keep only a transient in-memory copy of the status for immediate UI feedback.
 */

import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout } from "./invoke";

export interface TelemetryStatus {
  /** `null` = this install has not yet answered the consent prompt. */
  consentVersion: number | null;
  granted: boolean;
  hasInstallId: boolean;
  queued: number;
}

/** The consent copy's version — matches the Rust side's "records consent at version 1". */
export const CONSENT_VERSION = 1;

/** A bound generous enough for a local IPC round-trip, tight enough not to strand a modal. */
const TELEMETRY_INVOKE_TIMEOUT_MS = 10_000;

export async function getTelemetryStatus(): Promise<TelemetryStatus | null> {
  try {
    return await invoke<TelemetryStatus>("telemetry_status");
  } catch {
    return null;
  }
}

export async function setTelemetryConsent(granted: boolean): Promise<TelemetryStatus | null> {
  try {
    return await invoke<TelemetryStatus>("set_telemetry_consent", { granted });
  } catch {
    return null;
  }
}

/** Pretty JSON of exactly what would be sent — backs the "see what we send" disclosure. */
export async function getTelemetryPreview(): Promise<string | null> {
  try {
    return await invokeWithTimeout<string>(
      "telemetry_preview",
      undefined,
      TELEMETRY_INVOKE_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
}

/** Returns whether the request was actually sent, so the caller can pick an honest notice. */
export async function requestTelemetryDeletion(): Promise<boolean> {
  try {
    await invokeWithTimeout<void>(
      "request_telemetry_deletion",
      undefined,
      TELEMETRY_INVOKE_TIMEOUT_MS,
    );
    return true;
  } catch {
    return false;
  }
}

/** Best-effort — an error reporter must never itself throw or reject. */
export async function reportFrontendError(kind: string, message: string): Promise<void> {
  try {
    await invoke("report_frontend_error", { kind, message });
  } catch {
    // Telemetry is opt-in and best-effort; a failed report is silently dropped, not
    // surfaced to the user and not retried (retrying error reporting is how you build a
    // second bug out of the first one).
  }
}
