/**
 * The §5 `SyncResult` contract, as TypeScript.
 *
 * Hand-written to mirror `crates/core/src/result.rs`. The serde spellings there are
 * asserted in Rust tests, so the two cannot drift without a test failing on the Rust side.
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

export function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}
