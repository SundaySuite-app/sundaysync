//! Reference selection and global placement — docs/PLAN.md §4.4.
//!
//! Turns a pile of pairwise correlations into one timeline. The rules that matter are
//! all refusals: a clip below threshold is never placed, two clips from one camera may
//! never overlap, and a transitive placement is only as trustworthy as the weakest link
//! in its chain. §7.5 makes honest failure the product's core promise, and this is where
//! that promise is actually kept.

use crate::correlate::Correlator;
use crate::drift;
use crate::error::{Error, Result};
use crate::extract::{AnalysisAudio, CachedAudio};
use crate::probe::Probed;
use crate::progress::{CancelToken, Progress, ProgressSink, Stage};
use crate::request::ANALYSIS_RATE;
use crate::result::{Placement, Unsynced, UnsyncedReason, Warning};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// §4.4: a placement disagreeing with `creation_time` by more than this is flagged but
/// kept — correlation beats metadata, because camera clocks are routinely unset.
pub const METADATA_TOLERANCE_SECONDS: f64 = 600.0;

/// A file that probed cleanly, carries audio, and has been extracted.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub probed: Probed,
    pub device: String,
    pub audio: CachedAudio,
}

impl Candidate {
    fn path(&self) -> &Path {
        &self.probed.path
    }
}

/// A transitive match found in pass 2, before it becomes a `Placement`.
struct Transitive {
    offset_seconds: f64,
    psr: f64,
    confidence: f64,
    chain: Vec<String>,
    segments: Vec<crate::correlate::SegmentMatch>,
}

/// Everything placement decided.
#[derive(Debug, Clone, PartialEq)]
pub struct Placed {
    pub reference: Option<PathBuf>,
    pub placements: Vec<Placement>,
    pub unsynced: Vec<Unsynced>,
}

/// Maps a PSR onto the 0..1 confidence §5 exposes to the UI.
///
/// `1 - min_psr/psr`: zero exactly at the threshold, 0.5 at twice it, asymptotic to one.
/// Anchoring on the threshold rather than an absolute scale means the number keeps its
/// meaning if `MIN_PSR` is retuned — which D-015 says Phase 6 may well do.
#[must_use]
pub fn confidence_from_psr(psr: f64, min_psr: f64) -> f64 {
    if psr <= 0.0 || min_psr <= 0.0 || !psr.is_finite() {
        return 0.0;
    }
    (1.0 - min_psr / psr).clamp(0.0, 1.0)
}

/// §4.4 reference selection: longest audio, dedicated audio files preferred on ties,
/// path as the final tiebreaker.
///
/// In the target scenario this lands on the mixer or recorder feed essentially always —
/// it is the one device running for the whole service. The wav/flac preference breaks
/// ties toward the recorder rather than a camera when both ran the full length.
#[must_use]
pub fn select_reference<'a>(
    candidates: &'a [Candidate],
    override_path: Option<&Path>,
) -> Option<&'a Candidate> {
    if let Some(want) = override_path {
        // An explicit choice is honoured even if it is a poor one — advanced mode exists
        // for the cases the heuristic gets wrong.
        if let Some(c) = candidates.iter().find(|c| c.path() == want) {
            return Some(c);
        }
    }
    candidates.iter().max_by(|a, b| {
        a.audio
            .samples
            .cmp(&b.audio.samples)
            .then_with(|| is_dedicated_audio(a).cmp(&is_dedicated_audio(b)))
            // Reversed so the *smallest* path wins, keeping the choice stable and
            // independent of directory iteration order (§3).
            .then_with(|| b.path().cmp(a.path()))
    })
}

fn is_dedicated_audio(c: &Candidate) -> bool {
    c.probed.video.is_none()
}

/// Runs both placement passes and assembles the result.
#[allow(clippy::too_many_lines)]
pub fn place(
    candidates: &[Candidate],
    override_path: Option<&Path>,
    min_psr: f64,
    segment_count: usize,
    fps: f64,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
) -> Result<Placed> {
    let Some(reference) = select_reference(candidates, override_path) else {
        return Ok(Placed {
            reference: None,
            placements: Vec::new(),
            unsynced: Vec::new(),
        });
    };
    let ref_path = reference.path().to_path_buf();
    let ref_audio = reference.audio.load()?;

    let mut correlator = Correlator::new();
    let mut placements: Vec<Placement> = Vec::new();
    let mut unresolved: Vec<&Candidate> = Vec::new();

    // The reference defines the origin, so it is placed at zero by construction.
    placements.push(Placement {
        file: ref_path.clone(),
        device: reference.device.clone(),
        offset_seconds: 0.0,
        confidence: 1.0,
        psr: f64::INFINITY,
        drift_ppm: None,
        projected_end_error_ms: None,
        chain: Vec::new(),
        warnings: Vec::new(),
    });

    // ---- Pass 1: everything against the reference -------------------------------
    let total = candidates.len();
    for (i, candidate) in candidates.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        progress.report(Progress {
            stage: Stage::Correlating,
            completed: i,
            total,
        });
        if candidate.path() == ref_path {
            continue;
        }

        let audio = candidate.audio.load()?;
        match correlator.match_clip(audio.samples(), ref_audio.samples(), segment_count) {
            Some(m) if m.psr >= min_psr => {
                placements.push(build_placement(Resolved {
                    candidate,
                    offset_samples: m.offset_samples,
                    psr: m.psr,
                    confidence: confidence_from_psr(m.psr, min_psr),
                    chain: Vec::new(),
                    segments: &m.segments,
                    clip_samples: audio.len(),
                    fps,
                }));
            }
            _ => unresolved.push(candidate),
        }
    }

    // ---- Pass 2: transitive, against clips already on the timeline ---------------
    //
    // A camera at the back may share almost nothing with the desk feed but plenty with
    // the camera beside it. §4.4 tries the largest placed clips first and stops early on
    // a strong match, because a longer anchor gives more material to correlate against.
    if !unresolved.is_empty() {
        // P-6: index candidates by path once, so the anchor lookups below are O(1) instead
        // of a `candidates.iter().find()` per (clip, anchor) pair, and the sort's duration
        // comes from this index rather than a linear scan inside the comparator.
        let by_path: HashMap<&Path, &Candidate> =
            candidates.iter().map(|c| (c.path(), c)).collect();
        let duration =
            |path: &Path| -> f64 { by_path.get(path).map_or(0.0, |c| c.probed.duration_seconds) };

        let mut anchors: Vec<(PathBuf, f64, f64, Vec<String>)> = placements
            .iter()
            .map(|p| {
                (
                    p.file.clone(),
                    p.offset_seconds,
                    p.confidence,
                    p.chain.clone(),
                )
            })
            .collect();
        anchors.sort_by(|a, b| {
            duration(&b.0)
                .total_cmp(&duration(&a.0))
                .then_with(|| a.0.cmp(&b.0))
        });

        // P-6/F10: a per-run cache of anchor analysis audio, filled lazily on first use and
        // reused across every unresolved clip — so each distinct anchor's cache file is
        // read at most once here, not re-loaded on every (clip, anchor) pair as before.
        // The reference is deliberately *not* stored in it: it is already resident as
        // `ref_audio` and is reused by reference, so the dominant (and only very-long)
        // stream is never duplicated. Peak resident = reference + anchors actually touched
        // + one in-flight clip; the largest-first order with early-exit usually touches
        // only a few big anchors. See docs/DECISIONS.md D-034 for the memory argument.
        let mut anchor_cache: HashMap<PathBuf, AnalysisAudio> = HashMap::new();

        let still_unresolved: Vec<&Candidate> = unresolved.clone();
        unresolved.clear();

        for candidate in still_unresolved {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let audio = candidate.audio.load()?;
            let mut best: Option<Transitive> = None;

            for (anchor_path, anchor_offset, anchor_confidence, anchor_chain) in &anchors {
                if anchor_path == candidate.path() {
                    continue;
                }
                let anchor_samples: &[f32] = if anchor_path == &ref_path {
                    // The reference is already loaded once (above); reuse it in place.
                    ref_audio.samples()
                } else {
                    use std::collections::hash_map::Entry;
                    match anchor_cache.entry(anchor_path.clone()) {
                        Entry::Occupied(e) => e.into_mut().samples(),
                        Entry::Vacant(e) => {
                            let Some(anchor) = by_path.get(anchor_path.as_path()) else {
                                continue;
                            };
                            e.insert(anchor.audio.load()?).samples()
                        }
                    }
                };
                let Some(m) = correlator.match_clip(audio.samples(), anchor_samples, segment_count)
                else {
                    continue;
                };
                if m.psr < min_psr {
                    continue;
                }

                let mut chain = anchor_chain.clone();
                chain.push(anchor_path.to_string_lossy().into_owned());
                // §4.4: "A transitive placement's confidence is the minimum along its
                // chain." Uncertainty accumulates; it never washes out.
                let confidence = confidence_from_psr(m.psr, min_psr).min(*anchor_confidence);
                let offset = anchor_offset + m.offset_samples / f64::from(ANALYSIS_RATE);

                let strong = m.psr >= min_psr * 4.0;
                best = Some(Transitive {
                    offset_seconds: offset,
                    psr: m.psr,
                    confidence,
                    chain,
                    segments: m.segments.clone(),
                });
                if strong {
                    break; // early exit on a convincing match (§4.4)
                }
            }

            if let Some(t) = best {
                placements.push(build_placement(Resolved {
                    candidate,
                    offset_samples: t.offset_seconds * f64::from(ANALYSIS_RATE),
                    psr: t.psr,
                    confidence: t.confidence,
                    chain: t.chain,
                    segments: &t.segments,
                    clip_samples: audio.len(),
                    fps,
                }));
            } else {
                unresolved.push(candidate);
            }
        }
    }

    // ---- Everything still unmatched is refused, not guessed ----------------------
    let mut unsynced: Vec<Unsynced> = unresolved
        .iter()
        .map(|c| Unsynced {
            file: c.path().to_path_buf(),
            reason: UnsyncedReason::LowConfidence,
        })
        .collect();

    // ---- Same-device overlap (§4.4) ----------------------------------------------
    let evicted = evict_device_overlaps(&mut placements, candidates);
    unsynced.extend(evicted);

    // ---- Metadata sanity check (§4.4) --------------------------------------------
    annotate_metadata_mismatches(&mut placements, candidates, &ref_path);

    Ok(Placed {
        reference: Some(ref_path),
        placements,
        unsynced,
    })
}

/// Everything needed to turn a match into a §5 `Placement`.
struct Resolved<'a> {
    candidate: &'a Candidate,
    offset_samples: f64,
    psr: f64,
    confidence: f64,
    chain: Vec<String>,
    segments: &'a [crate::correlate::SegmentMatch],
    clip_samples: usize,
    fps: f64,
}

fn build_placement(r: Resolved<'_>) -> Placement {
    let Resolved {
        candidate,
        offset_samples,
        psr,
        confidence,
        chain,
        segments,
        clip_samples,
        fps,
    } = r;
    let mut warnings = Vec::new();
    let measured = drift::measure(segments, clip_samples);

    if let Some(d) = measured {
        if d.exceeds_half_frame(fps) {
            warnings.push(Warning::Drift {
                projected_end_error_ms: d.projected_end_error_ms,
            });
        }
    }
    Placement {
        file: candidate.path().to_path_buf(),
        device: candidate.device.clone(),
        offset_seconds: offset_samples / f64::from(ANALYSIS_RATE),
        confidence,
        psr,
        drift_ppm: measured.map(|d| d.ppm),
        projected_end_error_ms: measured.map(|d| d.projected_end_error_ms),
        chain,
        warnings,
    }
}

/// §4.4: "clips from one device must not overlap in time (cameras record sequentially).
/// An overlap forces the lower-confidence clip to `unsynced`."
///
/// This is a physical impossibility check, and it is one of the few places the engine can
/// *know* it made a mistake rather than merely being unsure.
fn evict_device_overlaps(
    placements: &mut Vec<Placement>,
    candidates: &[Candidate],
) -> Vec<Unsynced> {
    // P-6: one O(1) duration index, so the end-time lookups below are not a linear scan of
    // `candidates` per compared pair.
    let duration: HashMap<&Path, f64> = candidates
        .iter()
        .map(|c| (c.path(), c.probed.duration_seconds))
        .collect();
    let duration_of = |path: &Path| -> f64 { duration.get(path).copied().unwrap_or(0.0) };

    let mut by_device: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, p) in placements.iter().enumerate() {
        by_device.entry(p.device.clone()).or_default().push(i);
    }

    let mut evict: Vec<usize> = Vec::new();
    for indices in by_device.values() {
        let mut sorted = indices.clone();
        // Deterministic order: by offset, then path.
        sorted.sort_by(|a, b| {
            placements[*a]
                .offset_seconds
                .total_cmp(&placements[*b].offset_seconds)
                .then_with(|| placements[*a].file.cmp(&placements[*b].file))
        });

        for w in sorted.windows(2) {
            let (first, second) = (w[0], w[1]);
            if evict.contains(&first) || evict.contains(&second) {
                continue;
            }
            let end = placements[first].offset_seconds + duration_of(&placements[first].file);
            if end > placements[second].offset_seconds {
                // Drop the one we believe less. Ties break on path so the outcome does
                // not depend on iteration order.
                let loser = if placements[first].confidence < placements[second].confidence {
                    first
                } else if placements[second].confidence < placements[first].confidence {
                    second
                } else if placements[first].file > placements[second].file {
                    first
                } else {
                    second
                };
                evict.push(loser);
            }
        }
    }

    evict.sort_unstable();
    evict.dedup();
    let mut out = Vec::new();
    for i in evict.into_iter().rev() {
        let p = placements.remove(i);
        out.push(Unsynced {
            file: p.file,
            reason: UnsyncedReason::DeviceOverlap,
        });
    }
    out
}

/// §4.4's metadata sanity check. The placement is kept; only a warning is attached.
fn annotate_metadata_mismatches(
    placements: &mut [Placement],
    candidates: &[Candidate],
    ref_path: &Path,
) {
    let Some(ref_time) = candidates
        .iter()
        .find(|c| c.path() == ref_path)
        .and_then(|c| c.probed.creation_time())
        .and_then(parse_iso8601_epoch)
    else {
        return;
    };

    for p in placements.iter_mut() {
        if p.file == ref_path {
            continue;
        }
        let Some(clip_time) = candidates
            .iter()
            .find(|c| c.path() == p.file)
            .and_then(|c| c.probed.creation_time())
            .and_then(parse_iso8601_epoch)
        else {
            continue;
        };
        let expected = clip_time - ref_time;
        let delta = p.offset_seconds - expected;
        if delta.abs() > METADATA_TOLERANCE_SECONDS {
            p.warnings.push(Warning::MetadataMismatch {
                delta_seconds: delta,
            });
        }
    }
}

/// Parses `2026-07-27T10:00:00.000000Z` to Unix seconds.
///
/// Hand-rolled rather than adding `chrono` for one field: this is the only date in the
/// engine, it is only ever used for a ±10-minute sanity check, and a desktop app is
/// better off with one fewer dependency tree. Uses Howard Hinnant's days-from-civil
/// algorithm, which is exact for the proleptic Gregorian calendar.
#[must_use]
pub fn parse_iso8601_epoch(s: &str) -> Option<f64> {
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { s.get(from..to)?.parse().ok() };

    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;

    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }

    // Fractional seconds, when present. Ignored beyond parsing: a ±10-minute check has
    // no use for microseconds.
    let fraction = if bytes.get(19) == Some(&b'.') {
        let digits: String = s[20..].chars().take_while(char::is_ascii_digit).collect();
        format!("0.{digits}").parse::<f64>().unwrap_or(0.0)
    } else {
        0.0
    };

    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3600 + minute * 60 + second) as f64 + fraction)
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{AudioStream, VideoStream};
    use crate::rational::Rational;
    use std::collections::BTreeMap;

    fn candidate(path: &str, device: &str, seconds: f64, video: bool) -> Candidate {
        let samples = (seconds * f64::from(ANALYSIS_RATE)) as usize;
        Candidate {
            probed: Probed {
                path: PathBuf::from(path),
                duration_seconds: seconds,
                format_name: "test".into(),
                audio: Some(AudioStream {
                    codec: "pcm".into(),
                    sample_rate: 48_000,
                    channels: 1,
                }),
                video: video.then(|| VideoStream {
                    codec: "h264".into(),
                    width: 1920,
                    height: 1080,
                    fps: Rational::new(25, 1),
                }),
                tags: BTreeMap::new(),
            },
            device: device.into(),
            audio: CachedAudio {
                source: PathBuf::from(path),
                cache_path: PathBuf::from(path),
                samples,
            },
        }
    }

    #[test]
    fn the_reference_is_the_longest_file() {
        let c = vec![
            candidate("/a.mp4", "cam", 100.0, true),
            candidate("/b.wav", "rec", 300.0, false),
            candidate("/c.mp4", "cam2", 200.0, true),
        ];
        assert_eq!(
            select_reference(&c, None).unwrap().path(),
            Path::new("/b.wav")
        );
    }

    #[test]
    fn ties_prefer_a_dedicated_audio_file() {
        // The mixer feed and a camera both ran the whole service; §4.4 wants the feed.
        let c = vec![
            candidate("/cam.mp4", "cam", 300.0, true),
            candidate("/rec.wav", "rec", 300.0, false),
        ];
        assert_eq!(
            select_reference(&c, None).unwrap().path(),
            Path::new("/rec.wav")
        );
    }

    #[test]
    fn ties_fall_back_to_path_order_deterministically() {
        let c = vec![
            candidate("/z.wav", "a", 300.0, false),
            candidate("/a.wav", "b", 300.0, false),
        ];
        assert_eq!(
            select_reference(&c, None).unwrap().path(),
            Path::new("/a.wav")
        );
        // Reversed input must not change the answer.
        let reversed: Vec<Candidate> = c.into_iter().rev().collect();
        assert_eq!(
            select_reference(&reversed, None).unwrap().path(),
            Path::new("/a.wav")
        );
    }

    #[test]
    fn an_override_wins_even_over_a_better_candidate() {
        let c = vec![
            candidate("/long.wav", "rec", 300.0, false),
            candidate("/short.mp4", "cam", 10.0, true),
        ];
        let chosen = select_reference(&c, Some(Path::new("/short.mp4"))).unwrap();
        assert_eq!(chosen.path(), Path::new("/short.mp4"));
    }

    #[test]
    fn an_override_naming_an_absent_file_falls_back_to_the_heuristic() {
        let c = vec![candidate("/a.wav", "rec", 50.0, false)];
        let chosen = select_reference(&c, Some(Path::new("/missing.wav"))).unwrap();
        assert_eq!(chosen.path(), Path::new("/a.wav"));
    }

    #[test]
    fn confidence_is_anchored_on_the_threshold() {
        assert_eq!(confidence_from_psr(15.0, 15.0), 0.0);
        assert!((confidence_from_psr(30.0, 15.0) - 0.5).abs() < 1e-9);
        assert!(confidence_from_psr(500.0, 15.0) > 0.95);
        // Below threshold clamps rather than going negative.
        assert_eq!(confidence_from_psr(5.0, 15.0), 0.0);
        assert_eq!(confidence_from_psr(f64::NAN, 15.0), 0.0);
        assert_eq!(confidence_from_psr(-1.0, 15.0), 0.0);
    }

    fn placement(file: &str, device: &str, offset: f64, confidence: f64) -> Placement {
        Placement {
            file: PathBuf::from(file),
            device: device.into(),
            offset_seconds: offset,
            confidence,
            psr: 50.0,
            drift_ppm: None,
            projected_end_error_ms: None,
            chain: Vec::new(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn overlapping_clips_from_one_device_evict_the_weaker() {
        // A camera cannot record two clips at once; one of these is wrong.
        let candidates = vec![
            candidate("/a.mp4", "cam", 60.0, true),
            candidate("/b.mp4", "cam", 60.0, true),
        ];
        let mut placements = vec![
            placement("/a.mp4", "cam", 0.0, 0.9),
            placement("/b.mp4", "cam", 30.0, 0.4), // starts before /a ends
        ];
        let evicted = evict_device_overlaps(&mut placements, &candidates);
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].file, PathBuf::from("/b.mp4"));
        assert_eq!(evicted[0].reason, UnsyncedReason::DeviceOverlap);
        assert_eq!(placements.len(), 1);
    }

    #[test]
    fn clips_from_different_devices_may_overlap_freely() {
        // Two cameras filming the same moment is the entire point of the product.
        let candidates = vec![
            candidate("/a.mp4", "cam-1", 60.0, true),
            candidate("/b.mp4", "cam-2", 60.0, true),
        ];
        let mut placements = vec![
            placement("/a.mp4", "cam-1", 0.0, 0.9),
            placement("/b.mp4", "cam-2", 0.0, 0.9),
        ];
        assert!(evict_device_overlaps(&mut placements, &candidates).is_empty());
        assert_eq!(placements.len(), 2);
    }

    #[test]
    fn sequential_clips_from_one_device_are_fine() {
        let candidates = vec![
            candidate("/a.mp4", "cam", 30.0, true),
            candidate("/b.mp4", "cam", 30.0, true),
        ];
        let mut placements = vec![
            placement("/a.mp4", "cam", 0.0, 0.9),
            placement("/b.mp4", "cam", 30.0, 0.9), // starts exactly as /a ends
        ];
        assert!(evict_device_overlaps(&mut placements, &candidates).is_empty());
    }

    #[test]
    fn overlap_eviction_is_deterministic_when_confidence_ties() {
        let candidates = vec![
            candidate("/a.mp4", "cam", 60.0, true),
            candidate("/b.mp4", "cam", 60.0, true),
        ];
        let run = || {
            let mut p = vec![
                placement("/a.mp4", "cam", 0.0, 0.7),
                placement("/b.mp4", "cam", 10.0, 0.7),
            ];
            let e = evict_device_overlaps(&mut p, &candidates);
            e[0].file.clone()
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn metadata_disagreement_warns_but_keeps_the_placement() {
        // Correlation beats metadata: an unset camera clock must not veto a good sync.
        let mut a = candidate("/ref.wav", "rec", 300.0, false);
        a.probed
            .tags
            .insert("creation_time".into(), "2026-07-27T10:00:00.000000Z".into());
        let mut b = candidate("/cam.mp4", "cam", 100.0, true);
        b.probed
            .tags
            .insert("creation_time".into(), "2026-07-27T13:00:00.000000Z".into());
        let candidates = vec![a, b];

        // Metadata says +3 h; correlation says +5 s.
        let mut placements = vec![
            placement("/ref.wav", "rec", 0.0, 1.0),
            placement("/cam.mp4", "cam", 5.0, 0.9),
        ];
        annotate_metadata_mismatches(&mut placements, &candidates, Path::new("/ref.wav"));

        assert_eq!(placements.len(), 2, "placement must be kept");
        assert!(matches!(
            placements[1].warnings.first(),
            Some(Warning::MetadataMismatch { .. })
        ));
    }

    #[test]
    fn metadata_agreement_produces_no_warning() {
        let mut a = candidate("/ref.wav", "rec", 300.0, false);
        a.probed
            .tags
            .insert("creation_time".into(), "2026-07-27T10:00:00Z".into());
        let mut b = candidate("/cam.mp4", "cam", 100.0, true);
        b.probed
            .tags
            .insert("creation_time".into(), "2026-07-27T10:01:00Z".into());
        let candidates = vec![a, b];

        let mut placements = vec![
            placement("/ref.wav", "rec", 0.0, 1.0),
            placement("/cam.mp4", "cam", 60.0, 0.9),
        ];
        annotate_metadata_mismatches(&mut placements, &candidates, Path::new("/ref.wav"));
        assert!(placements[1].warnings.is_empty());
    }

    #[test]
    fn missing_metadata_is_simply_not_checked() {
        let candidates = vec![
            candidate("/ref.wav", "rec", 300.0, false),
            candidate("/cam.mp4", "cam", 100.0, true),
        ];
        let mut placements = vec![
            placement("/ref.wav", "rec", 0.0, 1.0),
            placement("/cam.mp4", "cam", 9999.0, 0.9),
        ];
        annotate_metadata_mismatches(&mut placements, &candidates, Path::new("/ref.wav"));
        assert!(placements[1].warnings.is_empty());
    }

    #[test]
    fn iso8601_parsing_matches_known_epochs() {
        assert_eq!(parse_iso8601_epoch("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(
            parse_iso8601_epoch("2000-01-01T00:00:00Z"),
            Some(946_684_800.0)
        );
        assert_eq!(
            parse_iso8601_epoch("2026-07-27T00:00:00Z"),
            Some(1_785_110_400.0)
        );
        // Leap day, the classic off-by-one in hand-rolled date code.
        assert_eq!(
            parse_iso8601_epoch("2024-02-29T12:00:00Z"),
            Some(1_709_208_000.0)
        );
        // Fractional seconds parse but do not disturb the whole part.
        let frac = parse_iso8601_epoch("1970-01-01T00:00:01.500000Z").unwrap();
        assert!((frac - 1.5).abs() < 1e-9);
    }

    #[test]
    fn malformed_timestamps_are_none_not_a_panic() {
        for bad in [
            "",
            "not a date",
            "2026-13-01T00:00:00Z",
            "2026-07-32T00:00:00Z",
            "2026-07-27T25:00:00Z",
            "2026-07",
        ] {
            assert_eq!(parse_iso8601_epoch(bad), None, "{bad}");
        }
    }
}
