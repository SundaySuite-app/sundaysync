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
  /**
   * D-067. The container's `date` tag, verbatim — the other half of a BWF's timestamp
   * (`date=2026-07-25` beside a `creation_time` of `16:12:29`). Optional here for the same
   * reason it is `#[serde(default)]` in Rust: the field is additive in both directions, so
   * a manifest written before D-067 is still a valid v1 manifest.
   */
  date_tag?: string | null;
  /**
   * D-067. The file's mtime as ISO-8601 UTC, from `std::fs::metadata` — the last rung of
   * the recording-time ladder, and the only clock on a container that carries no tags at
   * all. It is the **end** of the write; `timeline/recordingTime.ts` subtracts the
   * duration. Additive, like `date_tag`.
   */
  modified_time?: string | null;
}

/**
 * Why the scan walked past a file without probing it (D-066). Mirrors `SkipReason` in
 * `crates/core/src/result.rs`; the two strings are pinned there by
 * `skip_reasons_serialise_as_the_ui_spells_them`.
 */
export type SkipReason = "sidecar" | "still_image";

/**
 * A file the scan never tried — NOT an {@link Unsynced}. An `Unsynced` file was probed
 * and could not be used, so it belongs on the red shelf; a `SkippedFile` was never a
 * candidate, and nothing is wrong with it.
 */
export interface SkippedFile {
  file: string;
  reason: SkipReason;
}

export interface ScanManifest {
  schema: number;
  devices: Device[];
  files: FileEntry[];
  unsynced: Unsynced[];
  /**
   * D-066. Optional here for the same reason it is `#[serde(default)]` in Rust: the
   * field is additive, so a manifest produced before D-066 is still a valid v1 manifest
   * and simply has no list. The engine always writes it; readers must not assume so.
   */
  skipped?: SkippedFile[];
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

/**
 * One rung of a clip's waveform ladder — mirrors the shell's `WaveformLevelMeta`
 * (`app/src-tauri/src/lib.rs`). `bins` is how many `[peak, rms]` pairs
 * `invoke("waveform_level")` will return for this level.
 */
export interface WaveformLevelMeta {
  binSamples: number;
  bins: number;
}

/**
 * Shape of a clip's waveform, from `invoke("waveform_meta", { file, cacheDir })` —
 * mirrors the shell's `WaveformMeta`. Thirteen levels, finest first, each bin twice the
 * previous; `levels[0].binSamples` is 120 (10 ms at the analysis rate).
 *
 * There is no sample rate here on purpose: it is already in the §5 contract as
 * `SyncResult.parameters.analysis_rate`, and two sources for one number is how they
 * come to disagree.
 *
 * The *data* does not come through JSON. `invoke("waveform_level", { file, level,
 * cacheDir })` resolves to an **`ArrayBuffer`** of interleaved `[peak, rms]` `u8`
 * pairs — `2 * bins` bytes — because the shell answers it with `tauri::ipc::Response`
 * (verified on the pinned Tauri versions; docs/DECISIONS.md D-052).
 */
export interface WaveformMeta {
  totalSamples: number;
  levels: WaveformLevelMeta[];
}

export function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}
