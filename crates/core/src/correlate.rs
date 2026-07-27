//! GCC-PHAT offset estimation — docs/PLAN.md §4.3.
//!
//! The engine's central primitive: given a clip's analysis audio and a reference's, find
//! where the clip sits inside the reference, and how much to believe it.
//!
//! # Why PHAT
//!
//! Plain cross-correlation compares *magnitudes*, so it is dominated by whatever is
//! loudest. A desk feed and a camera mic twenty metres back differ enormously in level,
//! EQ and reverb, and a plain correlator mostly measures those differences. The phase
//! transform divides every bin by its magnitude before correlating, discarding level and
//! spectral shape and keeping only phase — which is exactly the part the two recordings
//! genuinely share, because it encodes *when* things happened.
//!
//! # Overlap-save, and why the FFT is not one big transform
//!
//! The textbook formulation transforms clip and reference together, needing an FFT the
//! size of both. A three-hour reference at 12 kHz is 130 M samples, so that transform
//! would be a quarter-billion complex bins — gigabytes, against §7.7's 4 GB ceiling for
//! the *whole run*. Overlap-save instead slides a fixed-size transform over the
//! reference, so memory depends on the segment length and never on the shoot length.
//!
//! PHAT survives the split intact: normalising each spectrum to unit magnitude makes the
//! cross-spectrum unit-magnitude in every block, so blocks stay directly comparable and
//! a peak in block 9 means the same thing as a peak in block 0.

use crate::request::ANALYSIS_RATE;
use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;

/// §4.3: clips shorter than this are correlated whole.
pub const WHOLE_CLIP_LIMIT_SECONDS: f64 = 45.0;
/// §4.3: otherwise take this many segments...
pub const SEGMENT_COUNT: usize = 5;
/// Bounds for a user-supplied segment count (§9 advanced).
///
/// Two is the formula's floor (`segment_starts` divides by `count - 1`); fifteen is a
/// generosity ceiling — beyond it segments overlap heavily on any clip §4.3 would
/// segment at all, and each extra segment is a full FFT pass over the reference.
/// Requests outside the range are clamped at the pipeline boundary, not rejected.
pub const SEGMENT_COUNT_RANGE: std::ops::RangeInclusive<usize> = 2..=15;
/// ...of this length, spread across the clip.
pub const SEGMENT_SECONDS: f64 = 20.0;
/// §4.3: segment offsets disagreeing by more than this mark the clip inconsistent.
pub const MAD_LIMIT_MS: f64 = 15.0;

/// Bins quieter than this are treated as empty rather than normalised.
///
/// PHAT divides by magnitude, so a bin holding nothing but rounding error would be
/// amplified to full scale and contribute pure noise to the correlation. This matters
/// most in the zero-padding regions, which are exactly zero.
const PHAT_FLOOR: f32 = 1e-9;

/// One correlation result.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Match {
    /// Lag, in analysis samples, of the clip's start relative to the reference's.
    /// Negative means the clip began before the reference did — legal, and common when
    /// a camera was rolling before the recorder was armed.
    pub offset_samples: f64,
    /// Peak-to-sidelobe ratio: how far the winning peak stands above the correlation
    /// floor, in standard deviations. This is what `MIN_PSR` is compared against.
    pub psr: f64,
}

impl Match {
    #[must_use]
    pub fn offset_seconds(self) -> f64 {
        self.offset_samples / f64::from(ANALYSIS_RATE)
    }
}

/// One segment's contribution to a clip match.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SegmentMatch {
    /// Where this segment began inside the clip, in analysis samples. Paired with
    /// `offset_samples`, this is the (x, y) that §4.6's drift regression needs.
    pub start_in_clip: usize,
    pub offset_samples: f64,
    pub psr: f64,
}

/// A clip matched against a reference.
#[derive(Debug, Clone, PartialEq)]
pub struct ClipMatch {
    /// Median of the segment estimates (§4.3). Median rather than mean because one
    /// segment landing on a wrong peak must not drag the answer with it.
    pub offset_samples: f64,
    /// Combined confidence: the *lowest* segment PSR, not the average.
    ///
    /// A clip is only as trustworthy as its weakest evidence. Averaging would let four
    /// strong segments hide one that matched nothing, which is precisely the case where
    /// the clip should be refused (§7.5).
    pub psr: f64,
    pub segments: Vec<SegmentMatch>,
    /// Median absolute deviation of the segment offsets, in milliseconds.
    pub mad_ms: f64,
    /// False when `mad_ms` exceeds [`MAD_LIMIT_MS`] — a candidate for drift, or a bad
    /// match wearing a convincing disguise.
    pub consistent: bool,
}

/// Reusable FFT machinery.
///
/// Holds a planner so repeated correlations at the same size reuse their twiddle
/// factors, which is most of the setup cost.
pub struct Correlator {
    planner: FftPlanner<f32>,
}

impl Default for Correlator {
    fn default() -> Self {
        Self {
            planner: FftPlanner::new(),
        }
    }
}

impl std::fmt::Debug for Correlator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Correlator")
    }
}

impl Correlator {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Finds `segment` inside `reference`.
    ///
    /// Returns `None` when either side is empty or the correlation is degenerate — never
    /// a guess. §7.5's promise starts here.
    pub fn find(&mut self, segment: &[f32], reference: &[f32]) -> Option<Match> {
        let seg_len = segment.len();
        if seg_len == 0 || reference.is_empty() {
            return None;
        }

        // Four times the segment gives ~3 valid output lags per transform — a reasonable
        // trade between transform cost and the number of blocks.
        let n = (4 * seg_len).next_power_of_two().max(2);
        let step = n - seg_len + 1;

        let fft = self.planner.plan_fft_forward(n);
        let ifft = self.planner.plan_fft_inverse(n);

        // PHAT the segment once: unit magnitude, conjugated ready for correlation.
        let mut seg_spec: Vec<Complex32> = (0..n)
            .map(|i| Complex32::new(segment.get(i).copied().unwrap_or(0.0), 0.0))
            .collect();
        fft.process(&mut seg_spec);
        for bin in &mut seg_spec {
            let m = bin.norm();
            *bin = if m > PHAT_FLOOR {
                bin.conj() / m
            } else {
                Complex32::new(0.0, 0.0)
            };
        }

        // Pad both ends so every lag with any overlap is reachable: the clip may start
        // before the reference, or run past its end.
        let pad = seg_len - 1;
        let padded_len = reference.len() + 2 * pad;
        let at = |i: usize| -> f32 {
            if i < pad || i >= pad + reference.len() {
                0.0
            } else {
                reference[i - pad]
            }
        };

        let mut peak = Peak::default();
        let mut stats = Stats::default();
        let mut block = vec![Complex32::new(0.0, 0.0); n];

        let mut base = 0usize;
        while base < padded_len {
            for (k, slot) in block.iter_mut().enumerate() {
                let idx = base + k;
                *slot = Complex32::new(if idx < padded_len { at(idx) } else { 0.0 }, 0.0);
            }
            fft.process(&mut block);
            for bin in &mut block {
                let m = bin.norm();
                *bin = if m > PHAT_FLOOR {
                    *bin / m
                } else {
                    Complex32::new(0.0, 0.0)
                };
            }
            for (bin, s) in block.iter_mut().zip(seg_spec.iter()) {
                *bin *= *s;
            }
            ifft.process(&mut block);

            // Only lags whose whole segment fits inside this transform are free of
            // circular wraparound.
            let valid = step.min(padded_len.saturating_sub(base));
            for k in 0..valid {
                let g = base + k;
                if g + seg_len > padded_len {
                    break;
                }
                let v = block[k].re;
                stats.push(f64::from(v));
                peak.offer(g, v, &block, k);
            }
            base += step;
        }

        let (idx, refined) = peak.refine()?;
        let psr = stats.psr(f64::from(peak.value))?;

        Some(Match {
            // Undo the front padding to get a true signed lag.
            offset_samples: (idx as f64 + refined) - pad as f64,
            psr,
        })
    }

    /// Matches a whole clip using the §4.3 segmentation rules.
    ///
    /// `segment_count` is the §9 advanced knob; pass [`SEGMENT_COUNT`] for the default
    /// behaviour. Callers are expected to have clamped it to [`SEGMENT_COUNT_RANGE`].
    pub fn match_clip(
        &mut self,
        clip: &[f32],
        reference: &[f32],
        segment_count: usize,
    ) -> Option<ClipMatch> {
        let starts = segment_starts(clip.len(), segment_count);
        let seg_len = segment_length(clip.len());

        let mut segments = Vec::new();
        for start in starts {
            let end = (start + seg_len).min(clip.len());
            let slice = clip.get(start..end)?;
            if let Some(m) = self.find(slice, reference) {
                segments.push(SegmentMatch {
                    start_in_clip: start,
                    // The segment's own lag includes where it sits inside the clip;
                    // subtracting recovers the clip's offset, so all segments become
                    // estimates of the same quantity.
                    offset_samples: m.offset_samples - start as f64,
                    psr: m.psr,
                });
            }
        }
        if segments.is_empty() {
            return None;
        }

        let mut offsets: Vec<f64> = segments.iter().map(|s| s.offset_samples).collect();
        let offset = median(&mut offsets);

        let mut deviations: Vec<f64> = segments
            .iter()
            .map(|s| (s.offset_samples - offset).abs())
            .collect();
        let mad_samples = median(&mut deviations);
        let mad_ms = mad_samples / f64::from(ANALYSIS_RATE) * 1000.0;

        let psr = segments.iter().map(|s| s.psr).fold(f64::INFINITY, f64::min);

        Some(ClipMatch {
            offset_samples: offset,
            psr,
            mad_ms,
            consistent: mad_ms <= MAD_LIMIT_MS,
            segments,
        })
    }
}

/// §4.3: whole clip under the limit, otherwise fixed-length segments.
#[must_use]
pub fn segment_length(clip_samples: usize) -> usize {
    let limit = (WHOLE_CLIP_LIMIT_SECONDS * f64::from(ANALYSIS_RATE)) as usize;
    if clip_samples <= limit {
        clip_samples
    } else {
        ((SEGMENT_SECONDS * f64::from(ANALYSIS_RATE)) as usize).min(clip_samples)
    }
}

/// Segment start positions, "spread evenly across A (always including one near the start
/// and one near the end)" (§4.3).
///
/// `count` below 2 is treated as 2 — the formula divides by `count - 1`, and a single
/// mid-clip segment would silently drop the start/end coverage §4.3 requires.
#[must_use]
pub fn segment_starts(clip_samples: usize, count: usize) -> Vec<usize> {
    let seg = segment_length(clip_samples);
    if seg >= clip_samples {
        return vec![0];
    }
    let count = count.max(2);
    let span = clip_samples - seg;
    (0..count).map(|i| span * i / (count - 1)).collect()
}

fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    if values.len().is_multiple_of(2) {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    }
}

/// Running mean/variance of the correlation surface.
///
/// The peak's own bins are left in. They are three samples out of millions, so their
/// effect on the floor statistics is far below the precision anyone reads a PSR to, and
/// excluding them would cost a second pass over the whole surface.
#[derive(Default)]
struct Stats {
    n: u64,
    sum: f64,
    sum_sq: f64,
}

impl Stats {
    fn push(&mut self, v: f64) {
        self.n += 1;
        self.sum += v;
        self.sum_sq += v * v;
    }

    fn psr(&self, peak: f64) -> Option<f64> {
        if self.n < 8 {
            return None;
        }
        let n = self.n as f64;
        let mean = self.sum / n;
        let var = (self.sum_sq / n - mean * mean).max(0.0);
        let sd = var.sqrt();
        if sd <= f64::EPSILON {
            // A perfectly flat surface carries no information; reporting a huge PSR
            // would turn "nothing here" into false confidence.
            return None;
        }
        Some((peak - mean) / sd)
    }
}

/// Tracks the winning lag plus its immediate neighbours, for sub-sample interpolation.
#[derive(Default)]
struct Peak {
    index: usize,
    value: f32,
    left: f32,
    right: f32,
    found: bool,
}

impl Peak {
    fn offer(&mut self, global: usize, value: f32, block: &[Complex32], k: usize) {
        if self.found && value <= self.value {
            return;
        }
        self.found = true;
        self.index = global;
        self.value = value;
        self.left = if k > 0 { block[k - 1].re } else { value };
        self.right = if k + 1 < block.len() {
            block[k + 1].re
        } else {
            value
        };
    }

    /// Parabolic interpolation through the peak and its neighbours.
    ///
    /// At 12 kHz one sample is 0.083 ms, so integer precision already beats a video
    /// frame by two orders of magnitude (§4.3). This is cheap insurance, and it is what
    /// makes the drift regression in §4.6 able to see a few ppm at all.
    fn refine(&self) -> Option<(usize, f64)> {
        if !self.found {
            return None;
        }
        let (l, c, r) = (
            f64::from(self.left),
            f64::from(self.value),
            f64::from(self.right),
        );
        let denom = l - 2.0 * c + r;
        let delta = if denom.abs() < f64::EPSILON {
            0.0
        } else {
            0.5 * (l - r) / denom
        };
        // A well-formed peak cannot be more than half a sample from its maximum bin;
        // anything larger means the neighbours were not part of the same peak.
        Some((self.index, delta.clamp(-0.5, 0.5)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic broadband noise — the signal type GCC-PHAT is built for.
    fn noise(n: usize, seed: u64) -> Vec<f32> {
        let mut s = seed | 1;
        (0..n)
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                (s >> 11) as f32 / (1u64 << 53) as f32 * 2.0 - 1.0
            })
            .collect()
    }

    #[test]
    fn finds_a_known_positive_lag_exactly() {
        let reference = noise(60_000, 1);
        let lag = 12_345usize;
        let clip = &reference[lag..lag + 20_000];
        let m = Correlator::new().find(clip, &reference).unwrap();
        assert!(
            (m.offset_samples - lag as f64).abs() < 0.5,
            "got {}, expected {lag}",
            m.offset_samples
        );
        assert!(m.psr > 10.0, "psr {}", m.psr);
    }

    #[test]
    fn finds_a_negative_lag() {
        // The camera was rolling before the recorder was armed — legal, and the padding
        // on both ends exists precisely so this is reachable.
        let full = noise(50_000, 2);
        let clip = &full[0..20_000];
        let reference = &full[5_000..];
        let m = Correlator::new().find(clip, reference).unwrap();
        assert!(
            (m.offset_samples + 5_000.0).abs() < 0.5,
            "got {}, expected -5000",
            m.offset_samples
        );
    }

    #[test]
    fn a_lag_of_zero_is_found() {
        let reference = noise(40_000, 3);
        let m = Correlator::new()
            .find(&reference[0..15_000], &reference)
            .unwrap();
        assert!(m.offset_samples.abs() < 0.5, "got {}", m.offset_samples);
    }

    #[test]
    fn survives_gain_difference_and_noise() {
        // The §4.3 premise: level and noise must not move the answer.
        let reference = noise(60_000, 4);
        let lag = 20_000usize;
        let dirt = noise(20_000, 99);
        let clip: Vec<f32> = reference[lag..lag + 20_000]
            .iter()
            .zip(dirt.iter())
            .map(|(s, d)| s * 0.05 + d * 0.05)
            .collect();
        let m = Correlator::new().find(&clip, &reference).unwrap();
        assert!(
            (m.offset_samples - lag as f64).abs() < 2.0,
            "got {}, expected {lag}",
            m.offset_samples
        );
    }

    #[test]
    fn unrelated_audio_scores_far_below_a_real_match() {
        // The separation that makes MIN_PSR possible at all. §8.2 demands zero false
        // placements, which is only achievable if these two populations do not overlap.
        let reference = noise(60_000, 5);
        let real = Correlator::new()
            .find(&reference[10_000..30_000], &reference)
            .unwrap();
        let fake = Correlator::new()
            .find(&noise(20_000, 777), &reference)
            .unwrap();
        assert!(
            real.psr > fake.psr * 2.0,
            "real {} vs unrelated {} — too close to separate",
            real.psr,
            fake.psr
        );
    }

    #[test]
    fn sub_sample_interpolation_beats_integer_precision() {
        // Resample by a half-sample shift and check the estimate lands between bins.
        let reference = noise(40_000, 6);
        let lag = 10_000usize;
        let clip: Vec<f32> = (0..15_000)
            .map(|i| {
                let a = reference[lag + i];
                let b = reference[lag + i + 1];
                (a + b) * 0.5
            })
            .collect();
        let m = Correlator::new().find(&clip, &reference).unwrap();
        let err = m.offset_samples - (lag as f64 + 0.5);
        assert!(
            err.abs() < 0.35,
            "got {}, expected ~{}",
            m.offset_samples,
            lag as f64 + 0.5
        );
    }

    #[test]
    fn degenerate_inputs_return_none_rather_than_guessing() {
        let mut c = Correlator::new();
        assert!(c.find(&[], &noise(1000, 7)).is_none());
        assert!(c.find(&noise(100, 7), &[]).is_none());
        // Digital silence has no phase information at all.
        assert!(c.find(&vec![0.0; 4096], &vec![0.0; 8192]).is_none());
    }

    #[test]
    fn segmentation_follows_the_plan() {
        let rate = ANALYSIS_RATE as usize;
        // Under 45 s: one whole-clip segment.
        let short = 30 * rate;
        assert_eq!(segment_length(short), short);
        assert_eq!(segment_starts(short, SEGMENT_COUNT), vec![0]);

        // Over 45 s: five 20 s segments, first at the start and last at the end.
        let long = 120 * rate;
        assert_eq!(segment_length(long), 20 * rate);
        let starts = segment_starts(long, SEGMENT_COUNT);
        assert_eq!(starts.len(), SEGMENT_COUNT);
        assert_eq!(starts[0], 0);
        assert_eq!(starts[SEGMENT_COUNT - 1], long - 20 * rate);
        assert!(starts.windows(2).all(|w| w[0] < w[1]), "must be increasing");
    }

    #[test]
    fn segment_count_is_configurable_and_spans_the_clip() {
        // §9 advanced: more segments, same coverage guarantee — first at the start,
        // last at the end, strictly increasing.
        let rate = ANALYSIS_RATE as usize;
        let long = 120 * rate;
        for count in [2, 7, 15] {
            let starts = segment_starts(long, count);
            assert_eq!(starts.len(), count, "count {count}");
            assert_eq!(starts[0], 0);
            assert_eq!(starts[count - 1], long - 20 * rate);
            assert!(starts.windows(2).all(|w| w[0] < w[1]), "count {count}");
        }
        // Below the floor is treated as the floor, not a panic or a lone segment.
        assert_eq!(segment_starts(long, 0).len(), 2);
        assert_eq!(segment_starts(long, 1).len(), 2);
    }

    #[test]
    fn match_clip_honours_the_segment_count() {
        let rate = ANALYSIS_RATE as usize;
        let reference = noise(100 * rate, 21);
        let lag = 4 * rate;
        let clip = &reference[lag..lag + 60 * rate];
        let m = Correlator::new().match_clip(clip, &reference, 3).unwrap();
        assert_eq!(m.segments.len(), 3);
        assert!((m.offset_samples - lag as f64).abs() < 2.0);
    }

    #[test]
    fn match_clip_agrees_across_segments_on_clean_audio() {
        let rate = ANALYSIS_RATE as usize;
        let reference = noise(200 * rate / 2, 8); // 100 s
        let lag = 7 * rate;
        let clip = &reference[lag..lag + 60 * rate];
        let m = Correlator::new()
            .match_clip(clip, &reference, SEGMENT_COUNT)
            .unwrap();

        assert_eq!(m.segments.len(), SEGMENT_COUNT);
        assert!(
            (m.offset_samples - lag as f64).abs() < 2.0,
            "got {}, expected {lag}",
            m.offset_samples
        );
        assert!(m.consistent, "mad {} ms", m.mad_ms);
        assert!(m.mad_ms < 1.0, "mad {} ms", m.mad_ms);
    }

    #[test]
    fn clip_psr_takes_the_weakest_segment_not_the_average() {
        // A clip is only as good as its worst evidence: averaging would let strong
        // segments mask one that matched nothing.
        let rate = ANALYSIS_RATE as usize;
        let reference = noise(100 * rate, 9);
        let lag = 5 * rate;
        let mut clip = reference[lag..lag + 60 * rate].to_vec();
        // Destroy the final segment.
        let tail = clip.len() - 20 * rate;
        let junk = noise(clip.len() - tail, 4242);
        clip[tail..].copy_from_slice(&junk);

        let m = Correlator::new()
            .match_clip(&clip, &reference, SEGMENT_COUNT)
            .unwrap();
        let worst = m
            .segments
            .iter()
            .map(|s| s.psr)
            .fold(f64::INFINITY, f64::min);
        assert!((m.psr - worst).abs() < 1e-9, "psr must be the minimum");
        let mean = m.segments.iter().map(|s| s.psr).sum::<f64>() / m.segments.len() as f64;
        assert!(m.psr < mean, "minimum must be below the mean here");
    }

    #[test]
    fn correlation_is_deterministic() {
        // §13.4 — the FFT path must give bit-identical answers run to run.
        let reference = noise(50_000, 10);
        let clip = &reference[3_000..23_000];
        let a = Correlator::new().find(clip, &reference).unwrap();
        let b = Correlator::new().find(clip, &reference).unwrap();
        assert_eq!(a.offset_samples.to_bits(), b.offset_samples.to_bits());
        assert_eq!(a.psr.to_bits(), b.psr.to_bits());
    }
}
