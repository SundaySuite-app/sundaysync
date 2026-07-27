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

    if !ppm.is_finite() || !projected_end_error_ms.is_finite() {
        return None;
    }

    Some(Drift {
        ppm,
        projected_end_error_ms,
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
    fn the_half_frame_warning_triggers_at_the_right_point() {
        // At 25 fps half a frame is 20 ms.
        let under = Drift {
            ppm: 10.0,
            projected_end_error_ms: 19.0,
        };
        let over = Drift {
            ppm: 10.0,
            projected_end_error_ms: 21.0,
        };
        assert!(!under.exceeds_half_frame(25.0));
        assert!(over.exceeds_half_frame(25.0));
        // Negative drift is just as visible as positive.
        let negative = Drift {
            ppm: -10.0,
            projected_end_error_ms: -21.0,
        };
        assert!(negative.exceeds_half_frame(25.0));
        // A nonsense frame rate must not panic or warn spuriously.
        assert!(!over.exceeds_half_frame(0.0));
    }
}
