//! The input side of the single `sync()` entry point — docs/PLAN.md §3.

use crate::result::Parameters;
use crate::sidecar::Sidecar;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Internal analysis sample rate (§4.2).
///
/// 12 kHz keeps speech and music transients while keeping the FFTs cheap. One sample is
/// 0.083 ms, so integer-sample precision already beats one video frame by two orders of
/// magnitude — the parabolic interpolation in §4.3 is insurance, not necessity. This is
/// an internal constant and is never exposed in simple mode.
pub const ANALYSIS_RATE: u32 = 12_000;

/// Default accept threshold on the GCC-PHAT peak-to-sidelobe ratio (§4.3).
///
/// **Calibrated in Phase 3**, as §4.3 requires, against the §8.1 synthetic suite: five
/// shoots (four `quick` seeds plus one `full`), 16 syncable clips and 10 deliberately
/// uncorrelated files, spanning WAV, FLAC, AAC and MP4.
///
/// | | |
/// | --- | --- |
/// | Lowest PSR on a real match | **30.9** |
/// | Highest PSR on unrelated audio | **9.2** |
/// | Separation | 3.4x |
///
/// 15.0 sits roughly at the geometric midpoint (16.9): 1.6x above the worst false
/// positive observed and 2.1x below the weakest true positive. The plan's worked example
/// of 5.0 was *below* the noise floor — unrelated audio scored 5.5–9.2 — and would have
/// placed pure noise on the timeline.
///
/// Deliberately erring high. §7.5 makes "honest failure over silent wrongness" the
/// product's core promise, so the asymmetry is intentional: a false negative puts a clip
/// on the unsynced shelf where the user can see and fix it, while a false positive
/// silently corrupts a timeline. §8.2 allows up to 5 % false negatives and zero false
/// positives, and this threshold spends that budget in the right direction.
///
/// **Must be re-validated against the real corpus in Phase 6** (§8.3). Synthetic
/// material cannot prove a threshold for real rooms.
pub const DEFAULT_MIN_PSR: f64 = 15.0;

/// Everything one sync run needs.
///
/// `SyncRequest` is deliberately *not* part of the frozen §5 schema — `SCHEMA_VERSION`
/// covers `SyncResult` only — so it can grow as the UI needs it to (D-028).
#[derive(Debug, Clone, PartialEq)]
pub struct SyncRequest {
    /// Files and/or folders. Folders are walked recursively (§4.1); nothing is rejected
    /// by extension, only by probe failure.
    pub inputs: Vec<PathBuf>,
    /// Overrides the OS cache location for the analysis-PCM cache (§4.2). PluralEyes'
    /// top support complaints were about temp space, so this is user-settable.
    pub cache_dir: Option<PathBuf>,
    /// Forces the reference track instead of the §4.4 heuristic. Advanced mode only.
    pub reference_override: Option<PathBuf>,
    pub min_psr: f64,
    /// §9 advanced: move files to another device before placement.
    ///
    /// Keyed by the exact path the scan reported — no canonicalisation, because the UI
    /// echoes scan output straight back. A key matching no scanned file is ignored: a
    /// stale override left over after the user removed an input must not abort a run
    /// (D-028). A target id the grouping never produced creates a fresh device.
    pub device_overrides: BTreeMap<PathBuf, String>,
    /// §9 advanced: correlation segment count. Clamped to
    /// [`crate::correlate::SEGMENT_COUNT_RANGE`] at the pipeline boundary, so a wild
    /// value from a config file degrades to the nearest sane one instead of erroring.
    pub segment_count: usize,
    /// The ffmpeg/ffprobe pair to decode with. `None` means "resolve from this machine"
    /// via [`Sidecar::from_path`], which is what the CLI and the tests want.
    ///
    /// The desktop shell fills this in with the binaries bundled inside the application
    /// (D-031). Passing them through the request is what keeps the engine Tauri-free
    /// (D-023): resolving an app-relative path is the shell's job, and the engine only
    /// ever sees two verified paths.
    pub sidecar: Option<Sidecar>,
    /// §4.6 / E6: correct measured clock drift on export by emitting a per-clip
    /// `<timeMap>` (D-042).
    ///
    /// **Default `true`**: correction is on, and applies only to clips whose measured
    /// drift exceeds half a frame ([`crate::Drift::exceeds_half_frame`]) — a clip already
    /// inside half a frame is left untouched. Setting this `false` is the user-facing
    /// "off" switch the UI exposes: no clip is ever retimed and the export is byte-for-byte
    /// what v1 produced.
    ///
    /// The engine measures drift regardless of this flag; it governs *export* only, so the
    /// shell reads it back at export time and passes it to
    /// [`crate::fcpxml::export_with_options`]. It is deliberately not part of the frozen §5
    /// `SyncResult` schema.
    pub correct_drift: bool,
}

impl SyncRequest {
    #[must_use]
    pub fn new(inputs: Vec<PathBuf>) -> Self {
        Self {
            inputs,
            cache_dir: None,
            reference_override: None,
            min_psr: DEFAULT_MIN_PSR,
            device_overrides: BTreeMap::new(),
            segment_count: crate::correlate::SEGMENT_COUNT,
            sidecar: None,
            correct_drift: true,
        }
    }

    /// The parameter block echoed back into `SyncResult` (§5).
    #[must_use]
    pub fn parameters(&self) -> Parameters {
        Parameters {
            analysis_rate: ANALYSIS_RATE,
            min_psr: self.min_psr,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drift_correction_is_on_by_default() {
        // E6 contract: the toggle defaults ON so the "trustworthy long clips" behaviour is
        // what a user gets without touching advanced mode. The UI's switch turns it off.
        assert!(SyncRequest::new(vec![]).correct_drift);
    }
}
