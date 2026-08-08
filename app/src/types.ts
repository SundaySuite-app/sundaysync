/**
 * The §5 `SyncResult` contract plus the scan-manifest shapes, as TypeScript.
 *
 * Hand-written to mirror `crates/core/src/result.rs` and `crates/core/src/scan.rs`.
 * The serde spellings there are asserted in Rust tests
 * (`scan_manifest_serde_spelling_is_stable`, `unsynced_reasons_match_the_plan_spelling`),
 * so the two sides cannot drift without a test failing on the Rust side.
 */

export type DeviceKind = "video" | "audio";

export type UnsyncedReason =
  | "low_confidence"
  | "no_audio"
  | "decode_error"
  | "device_overlap";

export type Warning =
  | { code: "metadata_mismatch"; delta_seconds: number }
  | { code: "mixed_fps" }
  | { code: "frame_snap_residual"; residual_ms: number }
  | { code: "drift"; projected_end_error_ms: number };

export interface Device {
  id: string;
  label: string;
  kind: DeviceKind;
  files: string[];
}

export interface Placement {
  file: string;
  device: string;
  offset_seconds: number;
  confidence: number;
  psr: number;
  drift_ppm: number | null;
  projected_end_error_ms: number | null;
  chain: string[];
  warnings: Warning[];
}

export interface Unsynced {
  file: string;
  reason: UnsyncedReason;
}

export interface SyncResult {
  schema: number;
  parameters: { analysis_rate: number; min_psr: number };
  reference: { file: string; device: string } | null;
  devices: Device[];
  placements: Placement[];
  unsynced: Unsynced[];
  sequence: { fps: string; duration_seconds: number };
  warnings: Warning[];
}

export interface ProgressEvent {
  stage: string;
  completed: number;
  total: number;
}

// ---- Scan manifest (crates/core/src/scan.rs) --------------------------------------

export interface AudioStream {
  codec: string;
  sample_rate: number;
  channels: number;
}

export interface VideoStream {
  codec: string;
  width: number;
  height: number;
  /** `Rational` serialises as the string "25/1"; degenerate rates are null. */
  fps: string | null;
}

export interface FileEntry {
  file: string;
  device: string;
  duration_seconds: number;
  format_name: string;
  audio: AudioStream | null;
  video: VideoStream | null;
  creation_time: string | null;
}

export interface ScanManifest {
  schema: number;
  devices: Device[];
  files: FileEntry[];
  unsynced: Unsynced[];
}

// ---- Shell command payloads (app/src-tauri/src/lib.rs) ----------------------------

export interface SyncOutcome {
  result: SyncResult;
  /** Per-file duration in seconds — what gives the result view real clip widths. */
  durations: Record<string, number>;
}

export interface CacheStatus {
  dir: string;
  entries: number;
  bytes: number;
}

/**
 * Mirrors the shell's `SidecarStatus` struct (`app/src-tauri/src/lib.rs`) — the resolved
 * shape of `invoke("check_sidecar")` now that ffmpeg is bundled with the app. Rejects
 * with an error string instead when neither the bundled binary nor anything on PATH
 * works.
 */
export interface SidecarStatus {
  source: "bundled" | "system";
  path: string;
}

export function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}
