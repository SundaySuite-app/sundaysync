//! The `SyncResult` wire contract — docs/PLAN.md §5.
//!
//! This is the stable boundary between engine, CLI, UI and exporter, and it is
//! versioned from day one via [`SCHEMA_VERSION`]. Changing the shape of anything here
//! is a breaking change for the FCPXML exporter (§6), the Tauri result view (§9) and
//! the v2 drift-correction contract (§4.6) simultaneously — treat it as irreversible
//! per docs/PLAN.md §0 and raise it with Richard rather than editing in passing.

use crate::rational::Rational;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Bumped only on a breaking change to the shapes in this module.
pub const SCHEMA_VERSION: u32 = 1;

/// The complete outcome of one sync run.
///
/// Field order here is the field order in the emitted JSON (serde preserves
/// declaration order), which is half of what makes the byte-equality determinism test
/// in §13.4 meaningful. The other half is [`SyncResult::sort_deterministically`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncResult {
    pub schema: u32,
    pub parameters: Parameters,
    /// `None` only when the run had no usable input at all — every other run picks a
    /// reference per §4.4 (longest audio duration, wav/flac preferred, path as final
    /// tiebreaker).
    pub reference: Option<Reference>,
    pub devices: Vec<Device>,
    pub placements: Vec<Placement>,
    pub unsynced: Vec<Unsynced>,
    pub sequence: Sequence,
    pub warnings: Vec<Warning>,
}

/// The engine parameters a result was produced under.
///
/// Recorded in the output because §8.2's accuracy gates are only meaningful relative to
/// the threshold in force, and because a diagnostics zip (§7.6) has to be interpretable
/// without knowing what the user had configured in advanced mode.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Parameters {
    pub analysis_rate: u32,
    pub min_psr: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reference {
    pub file: PathBuf,
    pub device: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    /// Human-facing, and deliberately allowed to be Norwegian ("Mappe: Balkong") —
    /// §4.5 derives it from whatever identified the device, including folder names the
    /// user chose.
    pub label: String,
    pub kind: DeviceKind,
    pub files: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Video,
    Audio,
}

/// One clip successfully placed on the timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub file: PathBuf,
    pub device: String,
    /// Offset of this clip's start relative to the reference's start.
    ///
    /// The engine works in analysis samples internally and converts exactly once, here
    /// at the boundary (§5). Negative values are legal: a camera may have been rolling
    /// before the recorder was armed.
    pub offset_seconds: f64,
    /// Normalised 0.0–1.0 quality score for the UI's green/yellow colouring (§9.4).
    /// Derived from `psr`; kept separate so the UI never has to know the PSR scale.
    pub confidence: f64,
    /// Raw peak-to-sidelobe ratio of the GCC-PHAT correlation (§4.3). This is the value
    /// compared against `MIN_PSR`, and the one worth reading in a diagnostics dump.
    pub psr: f64,
    /// Measured clock drift. `None` when the clip yielded fewer than the 3 segments
    /// §4.6 requires for a regression — short clips simply cannot support the estimate.
    pub drift_ppm: Option<f64>,
    pub projected_end_error_ms: Option<f64>,
    /// How this placement was reached. `["reference"]` for a direct match; a transitive
    /// placement (§4.4 pass 2) lists the intermediate clips, and its confidence is the
    /// minimum along the chain.
    pub chain: Vec<String>,
    pub warnings: Vec<Warning>,
}

/// One clip the engine refused to place.
///
/// Landing here is a *success* of the design, not a failure: §4.4 and §7.5 make
/// "honest failure over silent wrongness" the core product promise, so a clip below
/// threshold must end up in this list rather than being placed hopefully.
///
/// But "honest failure" is only honest if the failure can be read. Until the K corpus round
/// this struct was the whole story a refused clip told: a path and a word. On the
/// calibration baseline that word was `low_confidence` 166 times out of 180 files, and
/// nothing in the output distinguished "this clip is unrelated material" from "this clip
/// missed the bar by 0.4" — the two cases a user must act on completely differently, and
/// the two cases an owner needs separated before any threshold can be re-tuned with
/// numbers. [`RefusedEvidence`] carries the measurement that produced the refusal so both
/// questions are answerable from the JSON dump alone (D-098).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Unsynced {
    pub file: PathBuf,
    pub reason: UnsyncedReason,
    /// The best match that was found and rejected, when one was found at all.
    ///
    /// `None` for the reasons where no correlation was ever attempted ([`
    /// UnsyncedReason::NoAudio`], [`UnsyncedReason::DecodeError`]) and for a clip whose
    /// correlation returned nothing whatsoever.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<RefusedEvidence>,
}

impl Unsynced {
    /// A refusal with no measurement behind it — the file never reached the correlator.
    #[must_use]
    pub fn new(file: PathBuf, reason: UnsyncedReason) -> Self {
        Self {
            file,
            reason,
            evidence: None,
        }
    }
}

/// What the engine actually measured before saying no.
///
/// The point of `required_psr` is that SundaySync's PSR bar is not one number: §4.3
/// correlates a clip shorter than
/// [`crate::correlate::WHOLE_CLIP_LIMIT_SECONDS`] whole, which gives it one segment,
/// which routes it to the strict [`crate::place::NO_DRIFT_EVIDENCE_PSR_FACTOR`] bar —
/// `5/3 × min_psr`, i.e. 25 at the default, not the 15 the user set and the docs quote.
/// Reporting the bar next to the score is what makes that visible without reading the
/// source (D-098).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RefusedEvidence {
    /// Peak-to-sidelobe ratio of the rejected match (§4.3 scores a segmented match by its
    /// *weakest* segment, so this is a minimum, not an average).
    pub psr: f64,
    /// Where the rejected match would have placed the clip, in sequence seconds. Reported
    /// so a refusal that is nonetheless *at the right place* is recognisable as a
    /// too-tight bar rather than a wrong match.
    pub offset_seconds: f64,
    /// How many segments the match had. Below
    /// [`crate::drift::MIN_SEGMENTS_FOR_DRIFT`] there is no drift evidence to grade on,
    /// which is what selects the strict bar.
    pub segments: usize,
    /// The PSR this match had to clear. `None` means no PSR would have been enough: the
    /// match had segments enough to check a clock and the check failed, which §7.5 refuses
    /// outright.
    pub required_psr: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnsyncedReason {
    /// No match at or above `MIN_PSR`, in either placement pass.
    LowConfidence,
    /// ffprobe found no audio stream — nothing to correlate on (§4.1).
    NoAudio,
    /// ffprobe or ffmpeg failed or timed out on this file. Isolated to a child process,
    /// so it can never take the run down (§7.2).
    DecodeError,
    /// Placed, but it overlapped another clip from the same device, which cameras
    /// cannot physically do (§4.4). The lower-confidence clip of the pair lands here.
    DeviceOverlap,
}

/// One file the scan deliberately never probed.
///
/// Not an [`Unsynced`], and the distinction is the whole point: an `Unsynced` file was
/// *tried* and could not be used, so it belongs on the red shelf. A `SkippedFile` was
/// never a candidate — nothing went wrong, and reporting it as a failure would invent a
/// problem out of a camera doing exactly what cameras do (D-066).
///
/// It lives beside [`Unsynced`] rather than in `scan.rs` for the same reason `Unsynced`
/// does: both are shapes the UI has to render, and one module owning every wire type the
/// UI reads is what keeps the hand-written TS mirror in `app/src/types.ts` in one place.
/// It is **not** part of §5's `SyncResult` — a skipped file was never in the run, so it
/// has nothing to say about the timeline, and adding it there would put it inside the
/// §7.3 accounting that only covers files the engine actually handled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedFile {
    pub file: PathBuf,
    pub reason: SkipReason,
}

/// Why the scan walked past a file (D-066).
///
/// Two members, not one, because the justifications do not generalise to each other and
/// the operator reads them differently — see the two constants in `scan.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// A camera's own companion to a sibling recording — a low-resolution proxy or an
    /// index file. A duplicate by construction (`scan::SIDECAR_EXTENSIONS`).
    Sidecar,
    /// A photograph. Real media, simply not correlatable: there is no audio to match on
    /// (`scan::STILL_IMAGE_EXTENSIONS`).
    StillImage,
}

/// A non-fatal finding, attached either to one placement or to the run as a whole.
///
/// Modelled as a typed enum rather than free text so the UI can localise it (nb + en,
/// §9) and tests can assert on it, instead of matching English substrings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Warning {
    /// The placement disagrees with the file's `creation_time` by more than the 10
    /// minutes §4.4 tolerates. The placement is kept — correlation beats metadata,
    /// which is routinely wrong on cameras with an unset clock — but it is flagged.
    MetadataMismatch { delta_seconds: f64 },
    /// Inputs span more than one frame rate (§6). Each asset keeps its own format; the
    /// sequence takes the most common one.
    MixedFps,
    /// Residual from snapping a video clip boundary to the sequence frame grid (§6).
    /// Always under half a frame; recorded so sub-frame accuracy claims stay auditable.
    FrameSnapResidual { residual_ms: f64 },
    /// Projected end-of-clip drift exceeds half a frame (§4.6). v1 reports; v2 corrects.
    Drift { projected_end_error_ms: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sequence {
    pub fps: Rational,
    pub duration_seconds: f64,
}

impl SyncResult {
    /// Applies the total orderings §5 mandates.
    ///
    /// Determinism is a test, not an aspiration (§13.4): the same inputs must produce
    /// byte-identical JSON. Every tiebreaker bottoms out in the file path, which is the
    /// only field guaranteed unique across a run — sorting by offset alone would leave
    /// two clips that genuinely start together in HashMap-iteration order.
    pub fn sort_deterministically(&mut self) {
        self.devices.sort_by(|a, b| a.id.cmp(&b.id));
        for device in &mut self.devices {
            device.files.sort();
        }
        self.placements.sort_by(|a, b| {
            a.offset_seconds
                .total_cmp(&b.offset_seconds)
                .then_with(|| a.file.cmp(&b.file))
        });
        self.unsynced.sort_by(|a, b| a.file.cmp(&b.file));
    }

    /// Every input file appears exactly once across `placements` + `unsynced` (§7.3).
    ///
    /// Exposed as a real method rather than a bare `debug_assert!` so the property tests
    /// in Phase 4 can assert it directly on arbitrary generated layouts, and so a
    /// release build can check it too if we ever want to.
    #[must_use]
    pub fn accounts_for(&self, inputs: &[PathBuf]) -> bool {
        let mut seen: Vec<&PathBuf> = self
            .placements
            .iter()
            .map(|p| &p.file)
            .chain(self.unsynced.iter().map(|u| &u.file))
            .collect();
        let before = seen.len();
        seen.sort();
        seen.dedup();
        if seen.len() != before {
            return false; // a file was reported twice
        }
        let mut expected: Vec<&PathBuf> = inputs.iter().collect();
        expected.sort();
        expected.dedup();
        seen == expected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placement(file: &str, offset: f64) -> Placement {
        Placement {
            file: PathBuf::from(file),
            device: "cam-a".into(),
            offset_seconds: offset,
            confidence: 0.9,
            psr: 11.2,
            drift_ppm: None,
            projected_end_error_ms: None,
            chain: vec!["reference".into()],
            warnings: vec![],
        }
    }

    #[test]
    fn sorting_breaks_offset_ties_by_path() {
        let mut r = SyncResult {
            schema: SCHEMA_VERSION,
            parameters: Parameters {
                analysis_rate: 12_000,
                min_psr: 5.0,
            },
            reference: None,
            devices: vec![],
            placements: vec![placement("/z.mp4", 1.0), placement("/a.mp4", 1.0)],
            unsynced: vec![],
            sequence: Sequence {
                fps: Rational::new(25, 1).unwrap(),
                duration_seconds: 0.0,
            },
            warnings: vec![],
        };
        r.sort_deterministically();
        assert_eq!(r.placements[0].file, PathBuf::from("/a.mp4"));
    }

    #[test]
    fn accounting_catches_lost_and_duplicated_files() {
        let inputs = vec![PathBuf::from("/a.mp4"), PathBuf::from("/b.mp4")];
        let mut r = SyncResult {
            schema: SCHEMA_VERSION,
            parameters: Parameters {
                analysis_rate: 12_000,
                min_psr: 5.0,
            },
            reference: None,
            devices: vec![],
            placements: vec![placement("/a.mp4", 0.0)],
            unsynced: vec![Unsynced {
                file: PathBuf::from("/b.mp4"),
                reason: UnsyncedReason::NoAudio,
                evidence: None,
            }],
            sequence: Sequence {
                fps: Rational::new(25, 1).unwrap(),
                duration_seconds: 0.0,
            },
            warnings: vec![],
        };
        assert!(r.accounts_for(&inputs));

        // A file that fell out of the pipeline entirely.
        r.unsynced.clear();
        assert!(!r.accounts_for(&inputs));

        // A file reported in both buckets.
        r.unsynced.push(Unsynced {
            file: PathBuf::from("/a.mp4"),
            reason: UnsyncedReason::NoAudio,
            evidence: None,
        });
        r.unsynced.push(Unsynced {
            file: PathBuf::from("/b.mp4"),
            reason: UnsyncedReason::NoAudio,
            evidence: None,
        });
        assert!(!r.accounts_for(&inputs));
    }

    #[test]
    fn refusal_evidence_is_additive_in_both_directions() {
        // D-098 adds a field to the §5 wire contract, which the module header rightly
        // treats as a serious act. It stays at `SCHEMA_VERSION` 1 because it is additive
        // *both* ways, and this pins both — the same shape `scan.rs` uses for the manifest.

        // Old JSON (no `evidence`) still reads: `#[serde(default)]` supplies `None`.
        let old = r#"{"file":"/x/a.MP4","reason":"low_confidence"}"#;
        let u: Unsynced = serde_json::from_str(old).unwrap();
        assert_eq!(u.reason, UnsyncedReason::LowConfidence);
        assert!(u.evidence.is_none());

        // A refusal with no measurement omits the key entirely, so a run that gained
        // nothing to say produces byte-identical output to before (§13.4 determinism).
        let json = serde_json::to_string(&Unsynced::new(
            PathBuf::from("/x/a.MP4"),
            UnsyncedReason::NoAudio,
        ))
        .unwrap();
        assert_eq!(json, r#"{"file":"/x/a.MP4","reason":"no_audio"}"#);

        // New JSON still reads under a consumer that predates the field.
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct OldUnsynced {
            file: PathBuf,
            reason: UnsyncedReason,
        }
        let with_evidence = Unsynced {
            file: PathBuf::from("/x/b.MTS"),
            reason: UnsyncedReason::LowConfidence,
            evidence: Some(RefusedEvidence {
                psr: 19.4,
                offset_seconds: 1234.5,
                segments: 1,
                required_psr: Some(25.0),
            }),
        };
        let json = serde_json::to_string(&with_evidence).unwrap();
        let old_reader: OldUnsynced = serde_json::from_str(&json).unwrap();
        assert_eq!(old_reader.reason, UnsyncedReason::LowConfidence);

        // And it round-trips through the new one unchanged.
        assert_eq!(
            serde_json::from_str::<Unsynced>(&json).unwrap(),
            with_evidence
        );

        // `required_psr: None` is a distinct, meaningful state — "no PSR would have been
        // enough" — and must survive the trip rather than collapsing into absence.
        let incredible = Unsynced {
            file: PathBuf::from("/x/c.MTS"),
            reason: UnsyncedReason::LowConfidence,
            evidence: Some(RefusedEvidence {
                psr: 15.2,
                offset_seconds: 42.0,
                segments: 5,
                required_psr: None,
            }),
        };
        let round = serde_json::to_string(&incredible).unwrap();
        assert_eq!(
            serde_json::from_str::<Unsynced>(&round).unwrap(),
            incredible
        );
    }

    #[test]
    fn warnings_serialise_with_a_stable_code_tag() {
        // The UI localises on `code`, so this string is part of the contract.
        let json = serde_json::to_string(&Warning::MetadataMismatch {
            delta_seconds: 720.0,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"code":"metadata_mismatch","delta_seconds":720.0}"#
        );
    }

    #[test]
    fn skip_reasons_serialise_as_the_ui_spells_them() {
        // D-066: `app/src/types.ts` mirrors these two strings by hand, and the sources
        // panel switches on them — the same contract `unsynced_reasons_match_the_plan_
        // spelling` below pins for the red shelf.
        let as_str = |r: SkipReason| serde_json::to_string(&r).unwrap();
        assert_eq!(as_str(SkipReason::Sidecar), "\"sidecar\"");
        assert_eq!(as_str(SkipReason::StillImage), "\"still_image\"");
    }

    #[test]
    fn unsynced_reasons_match_the_plan_spelling() {
        // §5 lists these four strings verbatim; the UI and the docs both quote them.
        let as_str = |r: UnsyncedReason| serde_json::to_string(&r).unwrap();
        assert_eq!(as_str(UnsyncedReason::LowConfidence), "\"low_confidence\"");
        assert_eq!(as_str(UnsyncedReason::NoAudio), "\"no_audio\"");
        assert_eq!(as_str(UnsyncedReason::DecodeError), "\"decode_error\"");
        assert_eq!(as_str(UnsyncedReason::DeviceOverlap), "\"device_overlap\"");
    }
}
