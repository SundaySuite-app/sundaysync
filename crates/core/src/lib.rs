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
//! **Phase 2.** Scan, probe, device grouping and analysis-audio extraction with
//! caching are implemented — see [`scan`] and [`Extractor`]. The correlation stages
//! behind [`sync`] are not, so `sync` still returns an empty, well-formed result.
//! See docs/STATUS.md.

pub mod cache;
pub mod correlate;
pub mod device;
pub mod drift;
pub mod error;
pub mod extract;
pub mod place;
pub mod probe;
pub mod progress;
pub mod rational;
pub mod request;
pub mod result;
pub mod scan;
pub mod sidecar;

pub use cache::{Cache, CacheKey};
pub use correlate::{ClipMatch, Correlator, Match, SegmentMatch};
pub use drift::Drift;
pub use error::{Error, Result};
pub use extract::{AnalysisAudio, CachedAudio, ExtractError, Extractor};
pub use place::{Candidate, Placed};
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
use std::path::PathBuf;

/// Fallback sequence frame rate when no video input established one (§6).
///
/// 25 fps is the PAL/European broadcast rate, which is what the Norwegian churches this
/// is built for actually shoot. It applies only to audio-only runs; any video input
/// overrides it with the most common camera format.
const FALLBACK_FPS: (u32, u32) = (25, 1);

/// Synchronise a set of media files.
///
/// Runs the whole §3 pipeline: scan and probe, group devices, extract analysis audio,
/// correlate, place, and measure drift.
///
/// Returns [`Error::Cancelled`] if `cancel` is tripped and [`Error::NoInput`] if there is
/// nothing to work on. Individual unreadable or unmatchable files are *not* errors — they
/// come back in [`SyncResult::unsynced`] with a reason (§7.2, §7.5).
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

    let sidecar = Sidecar::from_path()?;

    // Resolved before scanning so the walk can skip it: a cache placed inside a dropped
    // folder would otherwise be scanned as media on the next run (D-020).
    let cache_dir = match &request.cache_dir {
        Some(dir) => dir.clone(),
        None => cache::Cache::default_dir()?,
    };
    let (manifest, probed) = scan::scan_detailed(
        &request.inputs,
        &sidecar,
        Some(&cache_dir),
        progress,
        cancel,
    )?;
    let extractor = extract::Extractor::new(sidecar, cache::Cache::new(cache_dir));

    let syncable: Vec<PathBuf> = manifest.files.iter().map(|f| f.file.clone()).collect();
    let extracted = extractor.extract_all(&syncable, progress, cancel)?;

    let mut unsynced = manifest.unsynced.clone();
    let mut candidates = Vec::new();

    for (entry, outcome) in manifest.files.iter().zip(extracted) {
        match outcome {
            Ok(audio) => {
                let Some(p) = probed.iter().find(|p| p.path == entry.file) else {
                    // Every entry in `files` came from `probed`, so this cannot happen
                    // without a bug — and §7.3 says a lost file must be loud, not silent.
                    return Err(Error::Invariant(format!(
                        "no probe record for {}",
                        entry.file.display()
                    )));
                };
                candidates.push(place::Candidate {
                    probed: p.clone(),
                    device: entry.device.clone(),
                    audio,
                });
            }
            // A file that probed fine but would not decode is still a decode failure.
            Err(_) => unsynced.push(Unsynced {
                file: entry.file.clone(),
                reason: UnsyncedReason::DecodeError,
            }),
        }
    }

    let (fps, mixed_fps) = sequence_fps(&candidates);
    progress.report(Progress {
        stage: Stage::Placing,
        completed: 0,
        total: candidates.len(),
    });

    let placed = place::place(
        &candidates,
        request.reference_override.as_deref(),
        request.min_psr,
        fps.as_f64(),
        progress,
        cancel,
    )?;

    unsynced.extend(placed.unsynced);

    let mut warnings = Vec::new();
    if mixed_fps {
        warnings.push(Warning::MixedFps);
    }

    let duration_seconds = timeline_duration(&placed.placements, &candidates);

    let mut result = SyncResult {
        schema: SCHEMA_VERSION,
        parameters: request.parameters(),
        reference: placed.reference.as_ref().and_then(|path| {
            candidates
                .iter()
                .find(|c| &c.probed.path == path)
                .map(|c| Reference {
                    file: path.clone(),
                    device: c.device.clone(),
                })
        }),
        devices: manifest.devices,
        placements: placed.placements,
        unsynced,
        sequence: Sequence {
            fps,
            duration_seconds,
        },
        warnings,
    };
    result.sort_deterministically();

    // §7.3: every input file lands in exactly one bucket. Checked rather than assumed,
    // because a silently dropped clip is the one failure a user cannot see.
    let all_inputs: Vec<PathBuf> = manifest
        .files
        .iter()
        .map(|f| f.file.clone())
        .chain(result.unsynced.iter().map(|u| u.file.clone()))
        .collect();
    let mut expected: Vec<PathBuf> = all_inputs;
    expected.sort();
    expected.dedup();
    if !result.accounts_for(&expected) {
        return Err(Error::Invariant(
            "a file was lost or double-reported during placement".into(),
        ));
    }

    Ok(result)
}

/// §6: the sequence takes the most common camera frame rate; mixed input is allowed but
/// flagged. Audio-only runs fall back to [`FALLBACK_FPS`].
fn sequence_fps(candidates: &[place::Candidate]) -> (Rational, bool) {
    let mut counts: std::collections::BTreeMap<Rational, usize> = std::collections::BTreeMap::new();
    for c in candidates {
        if let Some(fps) = c.probed.video.as_ref().and_then(|v| v.fps) {
            *counts.entry(fps).or_insert(0) += 1;
        }
    }
    let mixed = counts.len() > 1;
    let chosen = counts
        .iter()
        // Most common wins; the rational itself breaks ties so the choice is stable.
        .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(fps, _)| *fps)
        .unwrap_or_else(|| Rational::new(FALLBACK_FPS.0, FALLBACK_FPS.1).unwrap_or(Rational::ONE));
    (chosen, mixed)
}

/// From the earliest clip start to the latest clip end.
fn timeline_duration(placements: &[Placement], candidates: &[place::Candidate]) -> f64 {
    let mut start = f64::INFINITY;
    let mut end = f64::NEG_INFINITY;
    for p in placements {
        let dur = candidates
            .iter()
            .find(|c| c.probed.path == p.file)
            .map_or(0.0, |c| c.probed.duration_seconds);
        start = start.min(p.offset_seconds);
        end = end.max(p.offset_seconds + dur);
    }
    if start.is_finite() && end.is_finite() {
        (end - start).max(0.0)
    } else {
        0.0
    }
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
