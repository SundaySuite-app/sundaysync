//! The input side of the single `sync()` entry point — docs/PLAN.md §3.

use crate::result::Parameters;
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
}

impl SyncRequest {
    #[must_use]
    pub fn new(inputs: Vec<PathBuf>) -> Self {
        Self {
            inputs,
            cache_dir: None,
            reference_override: None,
            min_psr: DEFAULT_MIN_PSR,
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
