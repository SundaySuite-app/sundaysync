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

use crate::extract::worker_count;
use crate::request::ANALYSIS_RATE;
use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

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

/// Upper bound on the cached reference block spectra (Tier-1 P-1 memoisation).
///
/// §4.3 promises the reference transform is "computed once and cached"; [`RefSpectra`] is
/// where that invariant finally lives. The cache holds one reference's PHAT-normalised
/// block spectra, and this bounds how large it may grow before a call falls back to the
/// streaming path instead.
///
/// A church-service reference — the §10 target, 1.5–3 h — at the default 20 s segment /
/// 2²⁰ FFT is ~0.65–1.3 GB of spectra, which fits comfortably inside §7.7's 4 GB run
/// ceiling alongside the resident reference audio. A pathologically long reference
/// correlated against short *whole-clip* segments (each forcing its own, larger FFT size,
/// so the spectra are both recomputed and far bigger) would exceed this bound; those calls
/// stream one block at a time exactly as before, so the cache can never reintroduce the E4
/// §7.7 memory blow-up (D-034). See docs/DECISIONS.md D-038.
const REF_SPECTRA_BUDGET_BYTES: usize = 1_879_048_192; // 1.75 GiB

/// One reference's cached forward transform: its PHAT-normalised block spectra plus the
/// geometry they were computed under.
struct RefSpectra {
    /// BLAKE3 over the reference samples — the content identity that keys the cache. Two
    /// references alias here only if byte-identical, so a stale entry can never be served
    /// for different content (§7.5).
    hash: [u8; 32],
    /// The segment length that fixed the block geometry. Part of the key because two
    /// different segment lengths can share an FFT size `n` yet tile the reference
    /// differently (different `step`/`pad`), so `n` alone would alias them. The `step` and
    /// `padded_len` the blocks were tiled under are not stored: both are pure functions of
    /// `(reference.len(), seg_len)`, so a hit recomputes them identically.
    seg_len: usize,
    /// PHAT-normalised reference spectrum for each block, in ascending-`base` order. Block
    /// `i` covers `base = i * (n - seg_len + 1)`.
    blocks: Vec<Vec<Complex32>>,
}

/// Reusable FFT machinery.
///
/// Holds a planner so repeated correlations at the same size reuse their twiddle factors,
/// and — since E5/P-1 — the most recently used reference's block spectra, so §4.3's
/// "computed once and cached" reference transform is not recomputed for every segment of
/// every clip.
pub struct Correlator {
    planner: FftPlanner<f32>,
    /// The most recently used reference's cached block spectra (Tier-1 P-1). Single-entry:
    /// a new `(reference content, segment length)` key replaces the previous one, so at
    /// most one reference's spectra are ever resident. Purely a memoisation — a miss
    /// recomputes the identical values, so a result never depends on cache state (§13.4).
    ref_spectra: Option<RefSpectra>,
}

impl Default for Correlator {
    fn default() -> Self {
        Self {
            planner: FftPlanner::new(),
            ref_spectra: None,
        }
    }
}

impl std::fmt::Debug for Correlator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Correlator")
    }
}

/// BLAKE3 over the reference samples — the content identity that keys [`RefSpectra`].
///
/// Hashing the samples, rather than trusting a raw slice pointer (which a later allocation
/// could reuse for a *different* reference — a §7.5 silent-wrongness bug), means two
/// references share a cache entry only when they are byte-identical. That is the same
/// collision-freedom the on-disk cache already relies on (cache.rs / D-035). The samples
/// are fed in 16 KiB chunks through one reused scratch buffer, so no second full copy of
/// the reference is ever allocated and no `unsafe`/`bytemuck` cast is needed against the
/// crate's `unsafe_code = "forbid"`.
fn hash_reference(samples: &[f32]) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    let mut scratch = [0u8; 4096 * 4];
    for chunk in samples.chunks(4096) {
        let mut off = 0;
        for &s in chunk {
            scratch[off..off + 4].copy_from_slice(&s.to_le_bytes());
            off += 4;
        }
        hasher.update(&scratch[..off]);
    }
    *hasher.finalize().as_bytes()
}

/// Scans one inverse-transformed block for lags free of circular wraparound, folding them
/// into the running peak and floor statistics. Identical for the cached and streaming
/// paths, which is what keeps the two bit-for-bit equal.
fn scan_block(
    base: usize,
    block: &[Complex32],
    seg_len: usize,
    padded_len: usize,
    step: usize,
    peak: &mut Peak,
    stats: &mut Stats,
) {
    // Only lags whose whole segment fits inside this transform are free of circular
    // wraparound.
    let valid = step.min(padded_len.saturating_sub(base));
    for k in 0..valid {
        let g = base + k;
        if g + seg_len > padded_len {
            break;
        }
        let v = block[k].re;
        stats.push(f64::from(v));
        peak.offer(g, v, block, k);
    }
}

/// The per-segment correlation kernel, shared by every entry point so the cached,
/// streaming and parallel paths can never diverge.
///
/// With `spectra: Some`, the reference's PHAT-normalised block spectra are reused (Tier 1
/// P-1); with `None`, each block is recomputed from `reference` on the fly (streaming).
/// The arithmetic and its order are identical either way — the cached blocks are exactly
/// what the streaming path computes just before multiplying by the segment — so the two are
/// bit-for-bit equal by construction. Takes `&self`-free borrows only, so it is safe to
/// call concurrently for independent segments (§4.3(c)).
#[allow(clippy::too_many_arguments)]
fn correlate_segment(
    segment: &[f32],
    reference: &[f32],
    fft: &Arc<dyn Fft<f32>>,
    ifft: &Arc<dyn Fft<f32>>,
    spectra: Option<&[Vec<Complex32>]>,
    n: usize,
    seg_len: usize,
    step: usize,
    pad: usize,
    padded_len: usize,
) -> Option<Match> {
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

    let mut peak = Peak::default();
    let mut stats = Stats::default();
    let mut work = vec![Complex32::new(0.0, 0.0); n];

    match spectra {
        // Cached: only the per-block multiply and inverse transform remain — the reference's
        // forward transform, the dominant cost, is skipped (§4.3's "computed once").
        Some(blocks) => {
            for (bi, block) in blocks.iter().enumerate() {
                let base = bi * step;
                work.copy_from_slice(block);
                for (w, s) in work.iter_mut().zip(seg_spec.iter()) {
                    *w *= *s;
                }
                ifft.process(&mut work);
                scan_block(
                    base, &work, seg_len, padded_len, step, &mut peak, &mut stats,
                );
            }
        }
        // Streaming: recompute each reference block's PHAT spectrum, one block resident at a
        // time. Memory is independent of the reference length.
        None => {
            let at = |i: usize| -> f32 {
                if i < pad || i >= pad + reference.len() {
                    0.0
                } else {
                    reference[i - pad]
                }
            };
            let mut base = 0usize;
            while base < padded_len {
                for (k, slot) in work.iter_mut().enumerate() {
                    let idx = base + k;
                    *slot = Complex32::new(if idx < padded_len { at(idx) } else { 0.0 }, 0.0);
                }
                fft.process(&mut work);
                for bin in &mut work {
                    let m = bin.norm();
                    *bin = if m > PHAT_FLOOR {
                        *bin / m
                    } else {
                        Complex32::new(0.0, 0.0)
                    };
                }
                for (w, s) in work.iter_mut().zip(seg_spec.iter()) {
                    *w *= *s;
                }
                ifft.process(&mut work);
                scan_block(
                    base, &work, seg_len, padded_len, step, &mut peak, &mut stats,
                );
                base += step;
            }
        }
    }

    let (idx, refined) = peak.refine()?;
    let psr = stats.psr(f64::from(peak.value))?;

    Some(Match {
        // Undo the front padding to get a true signed lag.
        offset_samples: (idx as f64 + refined) - pad as f64,
        psr,
    })
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
        let hash = hash_reference(reference);
        self.correlate(segment, reference, &hash, true)
    }

    /// The exhaustive (uncached) correlation path, kept as the determinism oracle for the
    /// Tier-1 cache (P-1): it recomputes the reference transform every call, so a test can
    /// diff it against [`find`](Self::find) and prove the cache is bit-identical. Not used
    /// by the shipping pipeline.
    #[doc(hidden)]
    pub fn find_exhaustive(&mut self, segment: &[f32], reference: &[f32]) -> Option<Match> {
        let hash = hash_reference(reference);
        self.correlate(segment, reference, &hash, false)
    }

    /// The single-segment correlation entry, shared by [`find`](Self::find) and
    /// [`find_exhaustive`](Self::find_exhaustive).
    ///
    /// `hash` is the reference's content identity, computed once by the caller so a
    /// multi-segment match hashes the reference once rather than once per segment. With
    /// `allow_cache`, the reference block spectra are memoised in `self.ref_spectra` (keyed
    /// by `hash` and the segment length) and reused; without it, every block is recomputed.
    fn correlate(
        &mut self,
        segment: &[f32],
        reference: &[f32],
        hash: &[u8; 32],
        allow_cache: bool,
    ) -> Option<Match> {
        let seg_len = segment.len();
        if seg_len == 0 || reference.is_empty() {
            return None;
        }

        // Four times the segment gives ~3 valid output lags per transform — a reasonable
        // trade between transform cost and the number of blocks.
        let n = (4 * seg_len).next_power_of_two().max(2);
        let step = n - seg_len + 1;
        // Pad both ends so every lag with any overlap is reachable: the clip may start
        // before the reference, or run past its end.
        let pad = seg_len - 1;
        let padded_len = reference.len() + 2 * pad;

        let fft = self.planner.plan_fft_forward(n);
        let ifft = self.planner.plan_fft_inverse(n);

        let cached =
            allow_cache && self.ensure_reference_spectra(reference, seg_len, n, hash, &fft);
        let spectra = if cached {
            self.ref_spectra.as_ref().map(|rc| rc.blocks.as_slice())
        } else {
            None
        };
        correlate_segment(
            segment, reference, &fft, &ifft, spectra, n, seg_len, step, pad, padded_len,
        )
    }

    /// Ensures `self.ref_spectra` holds the PHAT-normalised block spectra for this
    /// `(reference, seg_len)`, returning whether the cache may be used.
    ///
    /// A hit (matching content hash and segment length) is free. A miss computes the
    /// spectra — but only if they fit inside [`REF_SPECTRA_BUDGET_BYTES`]; when they would
    /// not, the existing entry (for some other, in-budget reference) is left untouched and
    /// `false` is returned so the caller streams instead. Either way at most one
    /// reference's spectra are resident.
    fn ensure_reference_spectra(
        &mut self,
        reference: &[f32],
        seg_len: usize,
        n: usize,
        hash: &[u8; 32],
        fft: &Arc<dyn Fft<f32>>,
    ) -> bool {
        if let Some(rc) = self.ref_spectra.as_ref() {
            if rc.seg_len == seg_len && &rc.hash == hash {
                return true;
            }
        }

        let step = n - seg_len + 1;
        let pad = seg_len - 1;
        let padded_len = reference.len() + 2 * pad;
        let count = padded_len.div_ceil(step);
        let bytes = count
            .saturating_mul(n)
            .saturating_mul(std::mem::size_of::<Complex32>());
        if bytes > REF_SPECTRA_BUDGET_BYTES {
            return false;
        }

        let at = |i: usize| -> f32 {
            if i < pad || i >= pad + reference.len() {
                0.0
            } else {
                reference[i - pad]
            }
        };
        let mut blocks: Vec<Vec<Complex32>> = Vec::with_capacity(count);
        let mut base = 0usize;
        while base < padded_len {
            let mut block = vec![Complex32::new(0.0, 0.0); n];
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
            blocks.push(block);
            base += step;
        }

        self.ref_spectra = Some(RefSpectra {
            hash: *hash,
            seg_len,
            blocks,
        });
        true
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
        self.match_clip_impl(clip, reference, segment_count, true, true)
    }

    /// The exhaustive (uncached) whole-clip match, kept as the determinism oracle for the
    /// Tier-1 reference-spectra cache (P-1). Not used by the shipping pipeline; a test
    /// diffs it against [`match_clip`](Self::match_clip) to prove the cache changes no
    /// placement. See docs/DECISIONS.md D-038.
    #[doc(hidden)]
    pub fn match_clip_exhaustive(
        &mut self,
        clip: &[f32],
        reference: &[f32],
        segment_count: usize,
    ) -> Option<ClipMatch> {
        self.match_clip_impl(clip, reference, segment_count, false, true)
    }

    /// The serial (single-threaded) cached whole-clip match, kept so a test can prove the
    /// parallel segment fan-out (§4.3(c)) places clips bit-identically to the serial path.
    /// Not used by the shipping pipeline.
    #[doc(hidden)]
    pub fn match_clip_serial(
        &mut self,
        clip: &[f32],
        reference: &[f32],
        segment_count: usize,
    ) -> Option<ClipMatch> {
        self.match_clip_impl(clip, reference, segment_count, true, false)
    }

    fn match_clip_impl(
        &mut self,
        clip: &[f32],
        reference: &[f32],
        segment_count: usize,
        allow_cache: bool,
        parallel: bool,
    ) -> Option<ClipMatch> {
        let starts = segment_starts(clip.len(), segment_count);
        let seg_len = segment_length(clip.len());
        if seg_len == 0 || reference.is_empty() {
            return None;
        }
        let n = (4 * seg_len).next_power_of_two().max(2);
        let step = n - seg_len + 1;
        let pad = seg_len - 1;
        let padded_len = reference.len() + 2 * pad;
        // Hash the reference once for the whole clip, not once per segment: every segment
        // correlates against the same reference, so they share the one cache key.
        let hash = hash_reference(reference);

        let fft = self.planner.plan_fft_forward(n);
        let ifft = self.planner.plan_fft_inverse(n);
        let cached =
            allow_cache && self.ensure_reference_spectra(reference, seg_len, n, &hash, &fft);
        let spectra = if cached {
            self.ref_spectra.as_ref().map(|rc| rc.blocks.as_slice())
        } else {
            None
        };

        // One correlation per segment. The segments are independent and share the reference
        // spectra read-only, so they fan out across the extract worker pool (§4.3(c)). Each
        // result is written to its own indexed slot and the slots are assembled in order,
        // so the placement is identical to the serial path regardless of how the threads
        // interleave (§13.4).
        let one = |start: usize| -> Option<SegmentMatch> {
            let end = (start + seg_len).min(clip.len());
            let slice = clip.get(start..end)?;
            correlate_segment(
                slice, reference, &fft, &ifft, spectra, n, seg_len, step, pad, padded_len,
            )
            .map(|m| SegmentMatch {
                start_in_clip: start,
                // The segment's own lag includes where it sits inside the clip; subtracting
                // recovers the clip's offset, so all segments become estimates of the same
                // quantity.
                offset_samples: m.offset_samples - start as f64,
                psr: m.psr,
            })
        };

        let mut slots: Vec<Option<SegmentMatch>> = starts.iter().map(|_| None).collect();
        let workers = worker_count().min(starts.len());
        if !parallel || workers <= 1 {
            for (slot, &start) in slots.iter_mut().zip(starts.iter()) {
                *slot = one(start);
            }
        } else {
            let chunk = starts.len().div_ceil(workers);
            let one = &one;
            std::thread::scope(|scope| {
                for (out_chunk, start_chunk) in slots.chunks_mut(chunk).zip(starts.chunks(chunk)) {
                    scope.spawn(move || {
                        for (slot, &start) in out_chunk.iter_mut().zip(start_chunk.iter()) {
                            *slot = one(start);
                        }
                    });
                }
            });
        }
        let segments: Vec<SegmentMatch> = slots.into_iter().flatten().collect();
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

    /// P-1 Tier 1: the memoised path must equal the exhaustive path bit-for-bit, on the
    /// full range of lag signs and edge positions the padding exists to reach.
    #[test]
    fn cached_path_is_bit_identical_to_exhaustive() {
        let reference = noise(80_000, 11);
        // Positive, zero, negative, and both extreme ends of the reference.
        let cases: [(usize, i64, usize); 6] = [
            (12_345, 0, 20_000), // interior positive lag
            (0, 0, 20_000),      // lag exactly zero
            (0, 5_000, 20_000),  // clip begins before the reference (negative lag)
            (60_000, 0, 20_000), // clip runs to the reference's end
            (0, 20_000, 25_000), // deeply negative: half the clip precedes the reference
            (55_000, 0, 25_001), // clip overruns the end; odd length
        ];
        for (start, pre, len) in cases {
            // Build a clip that may begin `pre` samples before the reference start.
            let take = len.min(reference.len().saturating_sub(start));
            let clip: Vec<f32> = if pre > 0 {
                // Prepend `pre` samples of the reference tail so the true lag is negative.
                let mut v: Vec<f32> = reference[reference.len() - pre as usize..].to_vec();
                v.extend_from_slice(&reference[start..start + take]);
                v
            } else {
                reference[start..start + take].to_vec()
            };

            let cached = Correlator::new().find(&clip, &reference);
            let exhaustive = Correlator::new().find_exhaustive(&clip, &reference);
            match (cached, exhaustive) {
                (Some(a), Some(b)) => {
                    assert_eq!(
                        a.offset_samples.to_bits(),
                        b.offset_samples.to_bits(),
                        "offset differs for start={start} pre={pre} len={len}"
                    );
                    assert_eq!(
                        a.psr.to_bits(),
                        b.psr.to_bits(),
                        "psr differs for start={start} pre={pre} len={len}"
                    );
                }
                (a, b) => assert_eq!(
                    a.is_some(),
                    b.is_some(),
                    "None/Some disagreement for start={start} pre={pre} len={len}"
                ),
            }
        }
    }

    /// The cache must survive reuse across clips against one reference: a correlator reused
    /// for many clips (as `place()` does in pass 1) must give the same answers as a fresh
    /// correlator per clip.
    #[test]
    fn cache_reuse_across_clips_matches_a_fresh_correlator() {
        let reference = noise(200_000, 12);
        let mut reused = Correlator::new();
        for &lag in &[3_000usize, 40_000, 90_000, 3_000, 150_000] {
            let clip = &reference[lag..lag + 20_000];
            let fresh = Correlator::new().find(clip, &reference);
            let via_reuse = reused.find(clip, &reference);
            let (fresh, via_reuse) = (fresh.unwrap(), via_reuse.unwrap());
            assert_eq!(
                fresh.offset_samples.to_bits(),
                via_reuse.offset_samples.to_bits()
            );
            assert_eq!(fresh.psr.to_bits(), via_reuse.psr.to_bits());
        }
    }

    /// Switching reference between calls must not serve a stale cache: interleaving two
    /// different references on one correlator must match fresh correlators.
    #[test]
    fn switching_reference_never_serves_a_stale_cache() {
        let ref_a = noise(120_000, 13);
        let ref_b = noise(120_000, 14);
        let clip_a = &ref_a[10_000..30_000];
        let clip_b = &ref_b[20_000..40_000];
        let mut c = Correlator::new();
        // A, B, A, B — every switch invalidates the single-entry cache.
        for _ in 0..2 {
            let a = c.find(clip_a, &ref_a).unwrap();
            let fa = Correlator::new().find(clip_a, &ref_a).unwrap();
            assert_eq!(a.offset_samples.to_bits(), fa.offset_samples.to_bits());
            let b = c.find(clip_b, &ref_b).unwrap();
            let fb = Correlator::new().find(clip_b, &ref_b).unwrap();
            assert_eq!(b.offset_samples.to_bits(), fb.offset_samples.to_bits());
        }
    }

    /// `match_clip` and `match_clip_exhaustive` must produce identical `ClipMatch`es —
    /// the oracle the integration accuracy diff relies on, in miniature.
    #[test]
    fn match_clip_cached_equals_exhaustive() {
        let rate = ANALYSIS_RATE as usize;
        let reference = noise(120 * rate, 15);
        let lag = 7 * rate;
        let clip = &reference[lag..lag + 60 * rate];
        let cached = Correlator::new()
            .match_clip(clip, &reference, SEGMENT_COUNT)
            .unwrap();
        let exhaustive = Correlator::new()
            .match_clip_exhaustive(clip, &reference, SEGMENT_COUNT)
            .unwrap();
        assert_eq!(
            cached.offset_samples.to_bits(),
            exhaustive.offset_samples.to_bits()
        );
        assert_eq!(cached.psr.to_bits(), exhaustive.psr.to_bits());
        assert_eq!(cached.mad_ms.to_bits(), exhaustive.mad_ms.to_bits());
        assert_eq!(cached.segments.len(), exhaustive.segments.len());
        for (a, b) in cached.segments.iter().zip(exhaustive.segments.iter()) {
            assert_eq!(a.offset_samples.to_bits(), b.offset_samples.to_bits());
            assert_eq!(a.psr.to_bits(), b.psr.to_bits());
        }
    }

    /// §4.3(c): the parallel segment fan-out must place clips bit-identically to the serial
    /// path. Segments are independent (each has its own peak/floor statistics), so the
    /// result cannot depend on thread scheduling — this pins that.
    #[test]
    fn parallel_segments_match_serial() {
        let rate = ANALYSIS_RATE as usize;
        let reference = noise(150 * rate, 16);
        for (lag, count) in [(7 * rate, SEGMENT_COUNT), (3 * rate, 9), (40 * rate, 2)] {
            let clip = &reference[lag..lag + 80 * rate];
            let par = Correlator::new()
                .match_clip(clip, &reference, count)
                .unwrap();
            let ser = Correlator::new()
                .match_clip_serial(clip, &reference, count)
                .unwrap();
            assert_eq!(par.offset_samples.to_bits(), ser.offset_samples.to_bits());
            assert_eq!(par.psr.to_bits(), ser.psr.to_bits());
            assert_eq!(par.mad_ms.to_bits(), ser.mad_ms.to_bits());
            assert_eq!(par.segments.len(), ser.segments.len());
            for (a, b) in par.segments.iter().zip(ser.segments.iter()) {
                assert_eq!(a.start_in_clip, b.start_in_clip);
                assert_eq!(a.offset_samples.to_bits(), b.offset_samples.to_bits());
                assert_eq!(a.psr.to_bits(), b.psr.to_bits());
            }
        }
    }

    /// §7.5: a non-finite sample must never become a placement.
    ///
    /// This is load-bearing and easy to break by accident. A NaN or infinity anywhere in
    /// the input poisons the whole transform — one bad sample makes every bin of that FFT
    /// non-finite — and what saves us is that `m > PHAT_FLOOR` is *false* for NaN, so the
    /// bin is zeroed rather than normalised. Rewrite that test as `!(m <= PHAT_FLOOR)`, or
    /// add a `.is_finite()` short-circuit on the wrong side, and NaN sails through instead:
    /// `Peak::offer` would accept it (`value <= self.value` is false for NaN, so NaN always
    /// wins the peak), `Stats::psr` would return `Some(NaN)`, and the result would be a
    /// clip placed at a NaN offset with a NaN score. Only `place::admissible`'s comparison
    /// direction stands between that and the timeline.
    #[test]
    fn a_non_finite_sample_never_produces_a_match() {
        let reference = noise(40_000, 31);
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut clip = reference[1_000..21_000].to_vec();
            clip[5] = bad;
            let m = Correlator::new().find(&clip, &reference);
            assert!(m.is_none(), "a {bad} in the clip produced {m:?}");

            let m = Correlator::new().match_clip(&clip, &reference, SEGMENT_COUNT);
            assert!(
                m.is_none(),
                "a {bad} in the clip matched a whole clip: {m:?}"
            );

            let mut poisoned = reference.clone();
            poisoned[100] = bad;
            let m = Correlator::new().find(&reference[1_000..21_000], &poisoned);
            assert!(m.is_none(), "a {bad} in the reference produced {m:?}");
        }
    }

    /// Whatever a match *is*, both of its numbers are real numbers. The gate downstream
    /// compares them against thresholds, and every one of those comparisons is only safe
    /// because this holds.
    #[test]
    fn a_match_that_exists_always_carries_finite_numbers() {
        let reference = noise(60_000, 32);
        for (start, len) in [(0usize, 20_000usize), (12_345, 20_000), (40_000, 20_000)] {
            let m = Correlator::new()
                .find(&reference[start..start + len], &reference)
                .unwrap();
            assert!(m.offset_samples.is_finite(), "offset {}", m.offset_samples);
            assert!(m.psr.is_finite(), "psr {}", m.psr);
        }
        // Unrelated audio still scores *something* finite rather than a NaN.
        let m = Correlator::new()
            .find(&noise(20_000, 777), &reference)
            .unwrap();
        assert!(m.offset_samples.is_finite() && m.psr.is_finite(), "{m:?}");
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
