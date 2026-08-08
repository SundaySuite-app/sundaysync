//! Clock-drift measurement — docs/PLAN.md §4.6.
//!
//! Two devices that agree perfectly at the start of a service can be a frame apart by the
//! end, because their sample clocks run at fractionally different rates. §4.6 measures
//! that in v1 and leaves correction to v2 — and this module's output *is* the v2 contract:
//! given `drift_ppm`, v2 only has to add a resampling step, with nothing upstream changing.

use crate::correlate::SegmentMatch;
use crate::request::ANALYSIS_RATE;

/// §4.6: "For each placed clip with ≥ 3 segments".
///
/// Two points always fit a line exactly, so a two-segment "measurement" would report
/// whatever noise happened to separate them with no way to tell. Three is the minimum
/// that can disagree with itself.
pub const MIN_SEGMENTS_FOR_DRIFT: usize = 3;

/// D-045: the largest |ppm| a real clock can plausibly drift.
///
/// Consumer quartz is specified in the tens of ppm and ages into the low hundreds at the
/// very worst; 500 gives that a comfortable margin. Anything beyond it is not a clock —
/// it is segments matching *different content* (an edited/produced mix used as the
/// reference, or sidelobe hits), fitted to a line that happens to have a slope. The E10
/// corpus produced −587,484 ppm this way: three orders of magnitude past this bound.
pub const MAX_CREDIBLE_DRIFT_PPM: f64 = 500.0;

/// D-045: how far segments may scatter around the fitted drift line, in milliseconds.
///
/// This is §4.3's `MAD_LIMIT_MS` idea applied *after* removing the linear clock
/// component: a genuinely drifting clip has segment offsets ON a line (so a raw MAD
/// around the median grows with clip length and would false-alarm — exactly why
/// `ClipMatch::consistent` was never a hard gate), while an edited mix or a set of
/// sidelobe hits scatters around any line you fit. Fifteen milliseconds of residual is
/// far more than clock physics or estimator noise can produce, and far less than the
/// seconds of scatter a cut produces.
pub const RESIDUAL_LIMIT_MS: f64 = 15.0;

/// The result of a drift regression.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Drift {
    /// Rate of change of the clip's offset, in parts per million.
    ///
    /// # Sign convention — v2 must not get this backwards
    ///
    /// This is `d(offset) / d(position in clip)`: how the clip's required offset changes
    /// as you move through it. **Positive means the clip needs a progressively later
    /// offset**, i.e. its own clock ran *fast* and it is running ahead.
    ///
    /// That is the opposite sign to "the recording is stretched by N ppm". A clip
    /// recorded on a clock running slow is physically *longer* than reality, so matching
    /// content appears progressively earlier in it, and the measured slope is negative.
    /// Verified against fixtures: injecting +40 ppm of stretch measures **−40.38 ppm**,
    /// and +60 measures −58.69.
    ///
    /// v2 corrects by resampling the clip by `1 / (1 + ppm * 1e-6)`. Applying `1 + ppm`
    /// instead would double the error rather than remove it, which is exactly the kind of
    /// mistake that looks fine until someone watches the end of a service.
    pub ppm: f64,
    /// How far off the clip's end is, given `ppm` over its length.
    pub projected_end_error_ms: f64,
    /// D-045: median absolute deviation of the segment offsets around the fitted line,
    /// in milliseconds. Zero for a perfect clock; small for real drift plus estimator
    /// noise; **seconds** when segments matched different content (an edited reference,
    /// sidelobe hits) and the "drift" is a line through scatter.
    pub residual_mad_ms: f64,
}

impl Drift {
    /// §4.6: warn when the projected end error exceeds half a frame.
    #[must_use]
    pub fn exceeds_half_frame(&self, fps: f64) -> bool {
        if fps <= 0.0 {
            return false;
        }
        self.projected_end_error_ms.abs() > (1000.0 / fps) / 2.0
    }

    /// E6 / D-042: the factor a corrected clip's *timeline* span exceeds its *source* span.
    ///
    /// # Why this factor, and why not its reciprocal
    ///
    /// `ppm` is `d(offset)/d(position in clip)`, so the reference time a source position
    /// `p` should land at is `offset_0 + (1 + ppm·1e-6)·p` (position plus its required
    /// offset). A source span of length `L` therefore has to occupy `L·(1 + ppm·1e-6)` of
    /// timeline for its far end to land where the reference puts it. That timeline stretch
    /// is exactly the resample D-019 pins from the other side: source samples play back at
    /// `1 / (1 + ppm·1e-6)`, the reciprocal of this. Emitting the reciprocal here would move
    /// the end the wrong way and *double* the error — the mistake D-019 warns about, pinned
    /// by [`tests::correction_cancels_the_end_error_and_inversion_doubles_it`].
    #[must_use]
    pub fn timeline_stretch(&self) -> f64 {
        1.0 + self.ppm * 1e-6
    }

    /// D-045: is this measurement physically believable as a *clock*?
    ///
    /// Two independent checks, either of which unmasks a non-clock:
    /// - `|ppm|` beyond [`MAX_CREDIBLE_DRIFT_PPM`]: no real crystal drifts that fast, so
    ///   the slope is a line fitted through matches on different content.
    /// - residual beyond [`RESIDUAL_LIMIT_MS`]: even allowing an arbitrary linear clock,
    ///   the segments still disagree — they are not one rigid recording against another.
    ///
    /// The E10 corpus made this concrete: a produced (edited) mix used as the reference
    /// gave every segment a genuine match at a *different* offset. The regression dutifully
    /// reported −587,484 ppm, and v0.1-era code placed the clip with only a warning — then
    /// E6's drift correction stretched it by −59 %. A placement whose drift measurement is
    /// not credible is not a placement; the §7.5 promise (honest failure over silent
    /// wrongness) demands refusal, and [`crate::place`] now enforces exactly that.
    #[must_use]
    pub fn credible(&self) -> bool {
        self.ppm.abs() <= MAX_CREDIBLE_DRIFT_PPM && self.residual_mad_ms <= RESIDUAL_LIMIT_MS
    }

    /// E6 / D-042: how far to move a corrected clip's start, in seconds, to turn §4.3's
    /// *median* placement into a *start* placement.
    ///
    /// The correlator estimates the offset at the clip's midpoint (§4.3 takes the median),
    /// so the placement sits half a clip's drift away from where the clip's *first* sample
    /// belongs. The `<timeMap>` pivots on the clip start (`time="0s" value="0s"`), so the
    /// start must first be moved to the reference-correct position or the stretch pivots
    /// about the wrong point and both ends end up half a drift out. That half-drift is
    /// exactly `projected_end_error_ms / 2`; the exporter subtracts this from the median
    /// offset. See D-016 for the median-vs-start framing this resolves.
    #[must_use]
    pub fn start_reference_shift_seconds(&self) -> f64 {
        self.projected_end_error_ms / 2000.0
    }
}

/// Least-squares fit of measured offset against position within the clip.
///
/// Returns `None` below [`MIN_SEGMENTS_FOR_DRIFT`], or when every segment landed at the
/// same position (a degenerate fit). Returning `None` rather than zero matters: "not
/// measured" and "measured as zero" are different claims, and only the second should ever
/// let the UI tell a user their clocks are fine.
#[must_use]
pub fn measure(segments: &[SegmentMatch], clip_samples: usize) -> Option<Drift> {
    if segments.len() < MIN_SEGMENTS_FOR_DRIFT {
        return None;
    }

    let n = segments.len() as f64;
    let xs: Vec<f64> = segments.iter().map(|s| s.start_in_clip as f64).collect();
    let ys: Vec<f64> = segments.iter().map(|s| s.offset_samples).collect();

    let mean_x = xs.iter().sum::<f64>() / n;
    let mean_y = ys.iter().sum::<f64>() / n;

    let mut sxx = 0.0;
    let mut sxy = 0.0;
    for (x, y) in xs.iter().zip(ys.iter()) {
        sxx += (x - mean_x) * (x - mean_x);
        sxy += (x - mean_x) * (y - mean_y);
    }
    if sxx <= f64::EPSILON {
        return None;
    }

    // Slope is samples of offset per sample of clip position — already dimensionless,
    // which is what makes the conversion to ppm a bare scaling.
    let slope = sxy / sxx;
    let ppm = slope * 1e6;

    let projected_end_error_ms = slope * clip_samples as f64 / f64::from(ANALYSIS_RATE) * 1000.0;

    // D-045: residual scatter around the fitted line. Median absolute deviation rather
    // than RMS for the same reason §4.3 takes the median of offsets — one outlier segment
    // must register, not be averaged away (nor dominate quadratically).
    let intercept = mean_y - slope * mean_x;
    let mut deviations: Vec<f64> = xs
        .iter()
        .zip(ys.iter())
        .map(|(x, y)| (y - (intercept + slope * x)).abs())
        .collect();
    deviations.sort_by(f64::total_cmp);
    let residual_samples = deviations[deviations.len() / 2];
    let residual_mad_ms = residual_samples / f64::from(ANALYSIS_RATE) * 1000.0;

    if !ppm.is_finite() || !projected_end_error_ms.is_finite() || !residual_mad_ms.is_finite() {
        return None;
    }

    Some(Drift {
        ppm,
        projected_end_error_ms,
        residual_mad_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segments(offsets: &[(usize, f64)]) -> Vec<SegmentMatch> {
        offsets
            .iter()
            .map(|(start, off)| SegmentMatch {
                start_in_clip: *start,
                offset_samples: *off,
                psr: 50.0,
            })
            .collect()
    }

    #[test]
    fn a_clip_with_no_drift_measures_zero() {
        let segs = segments(&[(0, 100.0), (1000, 100.0), (2000, 100.0), (3000, 100.0)]);
        let d = measure(&segs, 4000).unwrap();
        assert!(d.ppm.abs() < 1e-9, "ppm {}", d.ppm);
        assert!(d.projected_end_error_ms.abs() < 1e-9);
    }

    #[test]
    fn a_known_drift_is_recovered_within_the_gate() {
        // §8.2: "Drift estimates within ±5 ppm of injected drift."
        for injected in [10.0, 40.0, -25.0, 60.0, 250.0] {
            let clip = 60 * ANALYSIS_RATE as usize; // 60 s
            let slope = injected * 1e-6;
            let segs: Vec<SegmentMatch> = (0..5)
                .map(|i| {
                    let start = i * clip / 5;
                    SegmentMatch {
                        start_in_clip: start,
                        offset_samples: 500.0 + slope * start as f64,
                        psr: 50.0,
                    }
                })
                .collect();
            let d = measure(&segs, clip).unwrap();
            assert!(
                (d.ppm - injected).abs() < 5.0,
                "injected {injected} ppm, measured {:.2}",
                d.ppm
            );
        }
    }

    #[test]
    fn the_projected_end_error_matches_drift_times_length() {
        // 40 ppm over 400 s is 16 ms by construction — the relationship the UI warning
        // and the v2 correction both depend on.
        let clip = 400 * ANALYSIS_RATE as usize;
        let slope = 40e-6;
        let segs: Vec<SegmentMatch> = (0..5)
            .map(|i| {
                let start = i * clip / 5;
                SegmentMatch {
                    start_in_clip: start,
                    offset_samples: slope * start as f64,
                    psr: 50.0,
                }
            })
            .collect();
        let d = measure(&segs, clip).unwrap();
        assert!(
            (d.projected_end_error_ms - 16.0).abs() < 0.1,
            "got {} ms",
            d.projected_end_error_ms
        );
    }

    #[test]
    fn too_few_segments_is_none_not_zero() {
        // "Not measured" and "measured as zero" are different claims and must not be
        // conflated — only the latter may tell a user their clocks are fine.
        assert!(measure(&segments(&[(0, 0.0)]), 1000).is_none());
        assert!(measure(&segments(&[(0, 0.0), (500, 1.0)]), 1000).is_none());
        assert!(measure(&segments(&[(0, 0.0), (500, 1.0), (999, 2.0)]), 1000).is_some());
    }

    #[test]
    fn segments_all_at_one_position_cannot_support_a_fit() {
        let segs = segments(&[(100, 0.0), (100, 5.0), (100, -5.0)]);
        assert!(measure(&segs, 1000).is_none());
    }

    #[test]
    fn noise_does_not_swamp_a_real_slope() {
        // Segment estimates carry sub-sample noise; the regression must still see the
        // trend rather than chasing it.
        let clip = 300 * ANALYSIS_RATE as usize;
        let slope = 50e-6;
        let wobble = [0.4f64, -0.3, 0.2, -0.4, 0.3];
        let segs: Vec<SegmentMatch> = (0..5)
            .map(|i| {
                let start = i * clip / 5;
                SegmentMatch {
                    start_in_clip: start,
                    offset_samples: slope * start as f64 + wobble[i],
                    psr: 50.0,
                }
            })
            .collect();
        let d = measure(&segs, clip).unwrap();
        assert!((d.ppm - 50.0).abs() < 5.0, "measured {:.2} ppm", d.ppm);
    }

    #[test]
    fn correction_cancels_the_end_error_and_inversion_doubles_it() {
        // The D-019 sign trap, proven rather than eyeballed. Ground truth comes from this
        // module's own definition of `ppm` (`d(offset)/d(position)`): a source position `p`
        // belongs at reference time `offset_0 + (1 + ppm·1e-6)·p`. Nothing here depends on
        // the ambiguous "stretched by N ppm" framing — only on what `measure` produces.
        //
        // Both signs of drift, and the two real full-tier measurements from D-019, are
        // exercised. If `timeline_stretch` were inverted the corrected end would move the
        // wrong way and the error would roughly double instead of vanishing.
        let l = 400.0_f64; // source length, seconds
        let offset_0 = 3.0_f64; // reference time of the clip's first sample
        for ppm in [40.0_f64, -40.0, -58.69, 24.75] {
            let slope = ppm * 1e-6;
            let d = Drift {
                ppm,
                projected_end_error_ms: slope * l * 1000.0,
                residual_mad_ms: 0.0,
            };

            // Reference-correct timeline position of the source END.
            let ideal_end = offset_0 + (1.0 + slope) * l;
            // §4.3 places on the median, i.e. the offset at the midpoint.
            let median_offset = offset_0 + slope * l / 2.0;
            // The full end-to-end drift this clip carries.
            let full_drift = (slope * l).abs();

            // Correction: re-reference the start, then stretch the span.
            let corrected_start = median_offset - d.start_reference_shift_seconds();
            let corrected_end = corrected_start + l * d.timeline_stretch();
            let corrected_err = (corrected_end - ideal_end).abs();

            // Uncorrected, start-anchored 1:1 — the D-016 framing. This is a full drift out.
            let uncorrected_end = corrected_start + l;
            let uncorrected_err = (uncorrected_end - ideal_end).abs();

            // The inverted ratio: the exact bug D-019 warns about — end moves the wrong way,
            // ending up ~twice the drift out instead of on target.
            let inverted_end = corrected_start + l / d.timeline_stretch();
            let inverted_err = (inverted_end - ideal_end).abs();

            assert!(
                corrected_err < 1e-9,
                "ppm {ppm}: corrected end still {corrected_err:.6} s out"
            );
            assert!(
                (uncorrected_err - full_drift).abs() < 1e-9,
                "ppm {ppm}: uncorrected end should be one full drift ({full_drift:.6} s) out, was {uncorrected_err:.6} s"
            );
            assert!(
                inverted_err > 1.8 * full_drift,
                "ppm {ppm}: inverting the ratio must roughly double the error, got {inverted_err:.6} s vs one drift {full_drift:.6} s"
            );
        }
    }

    #[test]
    fn scattered_segments_are_not_a_credible_clock() {
        // D-045, the E10 corpus failure shape: each segment genuinely matched *somewhere*
        // (an edited mix contains the clip's audio several cuts apart), so the offsets are
        // seconds apart and the regression reports an absurd slope. Both prongs of
        // `credible()` must fire on this.
        let clip = 3600 * ANALYSIS_RATE as usize; // a long service camera
        let offsets_s = [-68.0, -12.5, 33.0, -95.2, 7.7]; // seconds, scattered by cuts
        let segs: Vec<SegmentMatch> = offsets_s
            .iter()
            .enumerate()
            .map(|(i, off)| SegmentMatch {
                start_in_clip: i * clip / 5,
                offset_samples: off * f64::from(ANALYSIS_RATE),
                psr: 16.0, // each individually over MIN_PSR — exactly the trap
            })
            .collect();
        let d = measure(&segs, clip).unwrap();
        assert!(
            !d.credible(),
            "scatter must not be credible: ppm {:.0}, residual {:.1} ms",
            d.ppm,
            d.residual_mad_ms
        );
        assert!(
            d.residual_mad_ms > RESIDUAL_LIMIT_MS,
            "residual {:.1} ms should dwarf the limit",
            d.residual_mad_ms
        );
    }

    #[test]
    fn an_absurd_slope_on_a_perfect_line_is_not_credible_either() {
        // The other prong: offsets exactly ON a line (zero residual) whose slope no clock
        // could produce. A perfectly linear artefact must still be refused.
        let clip = 600 * ANALYSIS_RATE as usize;
        let slope = -0.5; // −500,000 ppm — the corpus measured −587,484
        let segs: Vec<SegmentMatch> = (0..5)
            .map(|i| {
                let start = i * clip / 5;
                SegmentMatch {
                    start_in_clip: start,
                    offset_samples: slope * start as f64,
                    psr: 16.0,
                }
            })
            .collect();
        let d = measure(&segs, clip).unwrap();
        assert!(d.residual_mad_ms < 1e-6, "line has no residual");
        assert!(!d.credible(), "|{:.0}| ppm cannot be a clock", d.ppm);
    }

    #[test]
    fn genuine_drift_with_estimator_noise_stays_credible() {
        // The gate must not eat D-016's legitimate case: a long clip on a real
        // slow/fast clock, with sub-sample estimator wobble. This is the exact shape
        // `ClipMatch::consistent` would have false-alarmed on (raw MAD around the median
        // grows with length), which is why the gate fits the line first.
        let clip = 5400 * ANALYSIS_RATE as usize; // 90 min at 40 ppm = 216 ms end-to-end
        let slope = 40e-6;
        let wobble = [0.4f64, -0.3, 0.2, -0.4, 0.3];
        let segs: Vec<SegmentMatch> = (0..5)
            .map(|i| {
                let start = i * clip / 5;
                SegmentMatch {
                    start_in_clip: start,
                    offset_samples: slope * start as f64 + wobble[i],
                    psr: 50.0,
                }
            })
            .collect();
        let d = measure(&segs, clip).unwrap();
        assert!((d.ppm - 40.0).abs() < 5.0, "measured {:.2} ppm", d.ppm);
        assert!(
            d.residual_mad_ms < 1.0,
            "wobble is sub-ms: {:.3}",
            d.residual_mad_ms
        );
        assert!(d.credible(), "a real drifting clock must pass the gate");
    }

    #[test]
    fn the_half_frame_warning_triggers_at_the_right_point() {
        // At 25 fps half a frame is 20 ms.
        let under = Drift {
            ppm: 10.0,
            projected_end_error_ms: 19.0,
            residual_mad_ms: 0.0,
        };
        let over = Drift {
            ppm: 10.0,
            projected_end_error_ms: 21.0,
            residual_mad_ms: 0.0,
        };
        assert!(!under.exceeds_half_frame(25.0));
        assert!(over.exceeds_half_frame(25.0));
        // Negative drift is just as visible as positive.
        let negative = Drift {
            ppm: -10.0,
            projected_end_error_ms: -21.0,
            residual_mad_ms: 0.0,
        };
        assert!(negative.exceeds_half_frame(25.0));
        // A nonsense frame rate must not panic or warn spuriously.
        assert!(!over.exceeds_half_frame(0.0));
    }
}
