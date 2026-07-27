//! SundaySync engine.
//!
//! One public entry point — [`sync`] — behind which the whole pipeline from
//! docs/PLAN.md §3 lives:
//!
//! ```text
//! scan → probe → group by device → extract analysis audio → pairwise GCC-PHAT
//!      → global placement → drift measurement → SyncResult
//! ```
//!
//! The CLI and (from Phase 7) the Tauri shell are both thin callers of this function.
//! Nothing here knows about a GUI, and nothing here reads the wall clock: the engine is
//! a deterministic function of its inputs, which is what makes the byte-equality test in
//! §13.4 possible.
//!
//! # Status
//!
//! **Phase 1.** Scan, probe and device grouping are implemented — see [`scan`]. The
//! correlation stages behind [`sync`] are not, so `sync` still returns an empty,
//! well-formed result. See docs/STATUS.md.

pub mod device;
pub mod error;
pub mod probe;
pub mod progress;
pub mod rational;
pub mod request;
pub mod result;
pub mod scan;
pub mod sidecar;

pub use error::{Error, Result};
pub use probe::{AudioStream, Probed, VideoStream};
pub use progress::{CancelToken, NoProgress, Progress, ProgressSink, Stage};
pub use rational::Rational;
pub use request::{SyncRequest, ANALYSIS_RATE, DEFAULT_MIN_PSR};
pub use result::{
    Device, DeviceKind, Parameters, Placement, Reference, Sequence, SyncResult, Unsynced,
    UnsyncedReason, Warning, SCHEMA_VERSION,
};
pub use scan::{scan, FileEntry, ScanManifest};
pub use sidecar::Sidecar;

/// Fallback sequence frame rate when no video input established one (§6).
///
/// 25 fps is the PAL/European broadcast rate, which is what the Norwegian churches this
/// is built for actually shoot. It applies only to audio-only runs; any video input
/// overrides it with the most common camera format.
const FALLBACK_FPS: (u32, u32) = (25, 1);

/// Synchronise a set of media files.
///
/// Returns [`Error::Cancelled`] if `cancel` is tripped, and [`Error::NoInput`] if there
/// is nothing to work on. Individual unreadable files are *not* errors — they come back
/// in [`SyncResult::unsynced`] (§7.2).
///
/// # Phase 0 stub
///
/// Returns an empty result. The signature, the contract and the invariants are real;
/// the pipeline is not. Phases 1–4 fill it in.
pub fn sync(
    request: &SyncRequest,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
) -> Result<SyncResult> {
    if request.inputs.is_empty() {
        return Err(Error::NoInput);
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }

    progress.report(Progress {
        stage: Stage::Scanning,
        completed: 0,
        total: request.inputs.len(),
    });

    // Total by construction: §7.1 forbids `expect` here, and FALLBACK_FPS is a non-zero
    // compile-time constant, so the fallback arm is unreachable in practice.
    let fps = Rational::new(FALLBACK_FPS.0, FALLBACK_FPS.1).unwrap_or(Rational::ONE);

    let mut result = SyncResult {
        schema: SCHEMA_VERSION,
        parameters: request.parameters(),
        reference: None,
        devices: Vec::new(),
        placements: Vec::new(),
        unsynced: Vec::new(),
        sequence: Sequence {
            fps,
            duration_seconds: 0.0,
        },
        warnings: Vec::new(),
    };
    result.sort_deterministically();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn req() -> SyncRequest {
        SyncRequest::new(vec![PathBuf::from("/tmp/a.wav")])
    }

    #[test]
    fn empty_input_is_an_error_not_an_empty_result() {
        let r = sync(&SyncRequest::new(vec![]), &NoProgress, &CancelToken::new());
        assert!(matches!(r, Err(Error::NoInput)));
    }

    #[test]
    fn a_pre_cancelled_token_stops_immediately() {
        let cancel = CancelToken::new();
        cancel.cancel();
        let r = sync(&req(), &NoProgress, &cancel);
        assert!(matches!(r, Err(Error::Cancelled)));
    }

    #[test]
    fn stub_emits_a_well_formed_schema_v1_result() {
        let r = sync(&req(), &NoProgress, &CancelToken::new()).unwrap();
        assert_eq!(r.schema, SCHEMA_VERSION);
        assert_eq!(r.parameters.analysis_rate, ANALYSIS_RATE);
        assert_eq!(r.parameters.min_psr, DEFAULT_MIN_PSR);
        assert_eq!(r.sequence.fps.to_string(), "25/1");
    }

    #[test]
    fn output_is_byte_identical_across_runs() {
        // §13.4: determinism is a test, not an aspiration. This assertion is trivial
        // against the Phase 0 stub — it is here so it is already wired up and cannot be
        // "forgotten" when Phase 3 makes it load-bearing.
        let a = sync(&req(), &NoProgress, &CancelToken::new()).unwrap();
        let b = sync(&req(), &NoProgress, &CancelToken::new()).unwrap();
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
    }

    #[test]
    fn progress_reaches_the_sink() {
        use std::sync::Mutex;
        struct Recorder(Mutex<Vec<Progress>>);
        impl ProgressSink for Recorder {
            fn report(&self, p: Progress) {
                if let Ok(mut v) = self.0.lock() {
                    v.push(p);
                }
            }
        }
        let rec = Recorder(Mutex::new(Vec::new()));
        sync(&req(), &rec, &CancelToken::new()).unwrap();
        let seen = rec.0.lock().unwrap();
        assert_eq!(seen.first().map(|p| p.stage), Some(Stage::Scanning));
    }
}
