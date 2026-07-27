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
/// PROVISIONAL. §4.3 requires this to be calibrated in Phase 3 against the synthetic
/// suite for zero false positives with under 5 % false negatives; the value here is the
/// plan's worked example, not a measured one. Do not treat it as tuned until Phase 3
/// records the calibration in docs/DECISIONS.md.
pub const DEFAULT_MIN_PSR: f64 = 5.0;

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
