//! Waveform peaks — a multi-resolution peak+RMS pyramid over the analysis cache.
//!
//! The interactive timeline (docs/V03-PROGRAM.md S2) needs to draw a waveform for every
//! clip, at every zoom level, without stuttering. The naive route is what most editors
//! do: shell out to ffmpeg once per zoom step and re-decode. We already have something
//! better sitting on disk.
//!
//! # Why the analysis cache is the right source
//!
//! [`crate::extract`] has already decoded every input to mono f32 PCM at
//! [`ANALYSIS_RATE`] and written it to the cache as a bare `.f32` file (§4.2). That is
//! *exactly* the signal the sync engine reasoned about, so a waveform drawn from it is
//! a picture of the data the offsets were computed from rather than a second,
//! independently-decoded approximation of it. It is also already local, already
//! contiguous, and already 12 kHz mono — one streaming read, no ffmpeg process, no
//! second decode of a 40 GB card dump.
//!
//! So: **zero ffmpeg spawns for waveforms.** A missing cache entry is not an error to
//! paper over — it is a first-class state the shell surfaces with a "regenerate"
//! affordance (docs/DECISIONS.md D-052), because the one thing that *can* repopulate it
//! is the extractor the sync pipeline already owns.
//!
//! # Shape of the pyramid
//!
//! [`Pyramid`] is a ladder of [`Level`]s. Level 0 bins 120 samples (10 ms at 12 kHz —
//! roughly one screen pixel at the tightest zoom anyone edits at); each coarser level
//! merges pairs, doubling the bin, until a bin covers ~40 s. Thirteen levels span 10 ms
//! to 40.96 s, which is every zoom the timeline allows — from "a syllable" to the
//! zoomed-all-the-way-out view of a multi-hour shoot. The bound is the *renderer's*, not
//! a musical one: see [`MAX_BIN_SECONDS`].
//!
//! Each bin carries two numbers, both quantized to `u8`:
//!
//! * **peak** — the largest absolute sample. Transients survive downsampling; an RMS-only
//!   waveform loses the drum hit that a human uses to eyeball alignment.
//! * **RMS** — root-mean-square energy. What loudness actually looks like.
//!
//! Drawing both (peak as the outline, RMS as a filled inner body) is the convention every
//! professional editor uses, and it is the one thing that makes a waveform readable at a
//! glance rather than a solid block.
//!
//! # Memory
//!
//! Two bytes per 10 ms bin is 200 B/s, i.e. ~720 KB per audio-hour for the base level.
//! Each level halves, so the whole ladder is a geometric series that converges to just
//! under 2× the base however deep it goes — ~1.44 MB per audio-hour, and the four levels
//! added past 2.56 s contribute ~0.4 % of that between them. An eight-hour shoot is
//! ~11.5 MB — nothing against §7.7's 4 GB ceiling, and small enough that the shell can
//! keep a handful of clips resident and simply recompute the rest.

use crate::error::{Error, Result};
use crate::request::ANALYSIS_RATE;
use std::path::Path;

/// Samples per level-0 bin: 10 ms at [`ANALYSIS_RATE`].
///
/// Chosen against the *display*, not the signal: at the tightest useful zoom a clip
/// occupies roughly one pixel per 10 ms, so a finer base level would be bytes nobody can
/// see. It is also an exact divisor of the 12 kHz rate, which keeps bin boundaries on
/// whole milliseconds and makes the test expectations below exact rather than approximate.
pub const BASE_BIN_SAMPLES: u32 = 120;

/// Coarsest bin a level is allowed to cover, in seconds.
///
/// Set by the *display*, not by musical meaning. The frontend picks the finest level with
/// at most 2 bins per device pixel (`app/src/timeline/waveformDraw.ts` `pickLevel`), so
/// the ladder has to reach a bin duration of `1 / (2 · minimum px-per-ms)` or the coarsest
/// level is still finer than the screen and the renderer builds thousands of `xs` entries
/// per clip per frame to paint a couple of hundred pixels. At the timeline's zoom floor
/// (`geometry.ts` `MIN_PX_PER_MS` = 0.00002 px/ms) that is 25 s, so the ladder runs to
/// 40.96 s — the first power-of-two step past it.
///
/// The old bound was 2.5 s, chosen against what a bin "means" rather than against the
/// zoom range, and it left a 3-hour clip drawing ~19 bins per pixel fully zoomed out (and
/// ~4 even at the default fit view of a normal service). Four extra levels cost almost
/// nothing: each level is half the size of the one below it, so levels 9–12 together add
/// under 0.4 % to the ladder — see the module's Memory note.
const MAX_BIN_SECONDS: f64 = 40.0;

/// How many levels [`pyramid_from_cache_file`] builds: 10 ms doubling to 40.96 s.
///
/// A consequence of [`BASE_BIN_SAMPLES`], [`ANALYSIS_RATE`] and [`MAX_BIN_SECONDS`], not an
/// independent knob — stated as a constant only so callers (and the shell's wire-shape
/// test) can name it instead of hard-coding a number they do not own.
/// `the_ladder_spans_ten_milliseconds_to_forty_seconds` holds the two in agreement.
pub const LEVEL_COUNT: usize = 13;

/// Bytes per `f32le` frame in a cache file.
const FRAME_BYTES: usize = 4;

/// Bytes per streamed read. A multiple of [`FRAME_BYTES`] so a full read is always
/// frame-aligned, and 64 KiB to match the OS readahead granularity — the same figure and
/// the same reasoning as [`crate::extract::CachedAudio::load`], whose streaming shape this
/// deliberately copies. Nothing here ever holds the whole file (D-034).
const CHUNK_BYTES: usize = 64 * 1024;

/// One resolution of the ladder.
///
/// `peak` and `rms` are always the same length — one entry per bin — and are quantized
/// linearly to `u8` (`round(value * 255)`, clamped). Linear rather than logarithmic on
/// purpose: at 1/255 resolution a dB curve spends most of its range on noise nobody is
/// looking at, and the frontend can apply any display curve it likes to a linear number
/// but cannot recover linearity from a lossy log one. D-052 records the S4 review point
/// for switching RMS to a perceptual curve if the drawn result disagrees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Level {
    /// How many source samples one bin of this level covers.
    pub bin_samples: u32,
    /// Absolute peak per bin, quantized to `u8`.
    pub peak: Vec<u8>,
    /// RMS energy per bin, quantized to `u8`.
    pub rms: Vec<u8>,
}

impl Level {
    /// Number of bins at this level.
    #[must_use]
    pub fn bins(&self) -> usize {
        self.peak.len()
    }

    /// Interleaved `[peak, rms]` pairs — the wire form the shell hands the frontend as
    /// raw bytes.
    ///
    /// Interleaved rather than two arrays because the renderer walks bins in order and
    /// wants both numbers together: one sequential pass over one buffer, no second
    /// index, no second allocation on the JS side.
    #[must_use]
    pub fn interleaved(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.peak.len() * 2);
        for (p, r) in self.peak.iter().zip(&self.rms) {
            out.push(*p);
            out.push(*r);
        }
        out
    }
}

/// A whole clip's waveform, at every zoom level.
///
/// `levels[0]` is the finest ([`BASE_BIN_SAMPLES`]); each subsequent level doubles
/// `bin_samples`. The ladder length does not depend on the clip's duration, so a level
/// index means the same zoom for every clip — a short clip simply has few bins at the
/// coarse end rather than a missing level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pyramid {
    /// Samples in the source cache file, at [`ANALYSIS_RATE`].
    pub total_samples: u64,
    pub levels: Vec<Level>,
}

impl Pyramid {
    /// Duration of the source audio in seconds.
    #[must_use]
    pub fn duration_seconds(&self) -> f64 {
        self.total_samples as f64 / f64::from(ANALYSIS_RATE)
    }
}

/// Un-quantized accumulator for one level, kept in float until the very end.
///
/// The merge chain is nine levels deep. Quantizing at each step and merging the `u8`s
/// would compound the rounding nine times — a 1/255 error at level 0 becomes a visible
/// step at level 8. Merging floats and quantizing exactly once bounds the total error at
/// half a quantum for every level.
#[derive(Debug)]
struct FloatLevel {
    bin_samples: u32,
    peak: Vec<f32>,
    /// Mean of the squared samples in the bin. `sqrt` of this is the RMS; keeping the
    /// *mean square* rather than the RMS is what makes the pairwise merge a weighted
    /// average instead of a root-of-sum-of-squares dance.
    mean_square: Vec<f32>,
    /// How many source samples each bin's `mean_square` was averaged over.
    ///
    /// Almost always `bin_samples`, but the *last* bin of every level is short whenever
    /// the clip does not divide evenly (`base_level` divides the trailing bin by what it
    /// actually holds, and every merge inherits that). Without this, `merge_pairs` would
    /// average a full child against a nearly-empty one as if they were equal — 120 silent
    /// samples followed by 30 at full scale has a true RMS of √(30/150) = 0.447, and the
    /// unweighted mean gives √((0 + 1)/2) = 0.707, 58 % high. One bin per level, always
    /// at the clip's end, which is precisely where a user is checking whether a camera
    /// ran out before the others.
    weight: Vec<f64>,
}

impl FloatLevel {
    /// Quantizes to the shipped `u8` form. The only rounding in the whole pipeline.
    fn quantize(&self) -> Level {
        Level {
            bin_samples: self.bin_samples,
            peak: self.peak.iter().copied().map(quantize).collect(),
            rms: self
                .mean_square
                .iter()
                .map(|ms| quantize(ms.max(0.0).sqrt()))
                .collect(),
        }
    }
}

/// Linear `[0, 1] → [0, 255]`, clamped.
///
/// Values above 1.0 are real — inter-sample overs and clipped sources both produce them —
/// and are pinned to 255 rather than wrapped, because a waveform that folds a hot peak
/// back down to silence is worse than one that says "as loud as this can draw". A
/// non-finite sample (which ffmpeg should never emit, but a truncated or corrupted cache
/// file can) reads as silence rather than poisoning the bin.
fn quantize(v: f32) -> u8 {
    if !v.is_finite() {
        return 0;
    }
    // `clamp` before the cast: `as u8` saturates in Rust, but being explicit keeps the
    // intent readable and the NaN case above is what actually needed handling.
    (v * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Builds the full pyramid for one analysis-cache entry.
///
/// Streams the `.f32` file — mono `f32le` PCM at [`ANALYSIS_RATE`], as written by
/// [`crate::extract::Extractor`] — in frame-aligned [`CHUNK_BYTES`] chunks, never holding
/// more than one chunk plus the (much smaller) output ladder. A trailing partial frame is
/// ignored, exactly as `CachedAudio::load` ignores it: it cannot occur from a completed
/// write, so trusting it would mean trusting three bytes of a torn one. A trailing partial
/// *bin* is kept — the last 3 ms of a clip is real audio and dropping it would leave a
/// visible notch at the end of every waveform.
///
/// # Errors
///
/// [`Error::Io`] if the file cannot be opened or read. A missing entry — the cache was
/// swept, capped, or cleared between the shell's `contains()` check and this read — is an
/// `Io` error whose source kind is `NotFound`; callers classify it with
/// [`Error::is_not_found`] and offer to regenerate rather than showing a failure.
pub fn pyramid_from_cache_file(path: &Path) -> Result<Pyramid> {
    let base = base_level(path)?;
    let total_samples = base.0;
    let mut levels = vec![base.1];

    // Thirteen levels: 120 samples (10 ms) doubling to 491 520 (40.96 s). The bound is on
    // the bin *duration*, not the level count, so changing ANALYSIS_RATE or
    // BASE_BIN_SAMPLES keeps the ladder covering the same span of zooms rather than
    // silently re-scaling it.
    let max_bin = MAX_BIN_SECONDS * f64::from(ANALYSIS_RATE);
    while f64::from(
        levels
            .last()
            .map_or(u32::MAX, |l: &FloatLevel| l.bin_samples),
    ) < max_bin
    {
        let Some(previous) = levels.last() else {
            break;
        };
        let next = merge_pairs(previous);
        levels.push(next);
    }

    Ok(Pyramid {
        total_samples,
        levels: levels.iter().map(FloatLevel::quantize).collect(),
    })
}

/// Streams the cache file into the finest level, returning the sample count with it.
fn base_level(path: &Path) -> Result<(u64, FloatLevel)> {
    use std::io::Read;

    let io_err = |source| Error::Io {
        path: path.to_path_buf(),
        source,
    };
    let file = std::fs::File::open(path).map_err(io_err)?;
    let file_len = file.metadata().map_err(io_err)?.len();

    // Sized once from the file length so the push loops never reallocate — the same
    // single-allocation discipline as `CachedAudio::load` (D-034), applied to an output
    // that is ~600× smaller than the input rather than the same size as it.
    let total_frames = file_len / FRAME_BYTES as u64;
    let bin = u64::from(BASE_BIN_SAMPLES);
    let expected_bins = total_frames.div_ceil(bin) as usize;

    let mut peak: Vec<f32> = Vec::with_capacity(expected_bins);
    let mut mean_square: Vec<f32> = Vec::with_capacity(expected_bins);
    let mut weight: Vec<f64> = Vec::with_capacity(expected_bins);

    // The bin being filled. `sum_sq` is f64: 120 squared f32s is well within f32's range,
    // but the accumulator is free to widen and a silent precision loss in the quietest
    // bins is exactly the kind of thing nobody would ever notice was wrong.
    let mut fill: u32 = 0;
    let mut bin_peak: f32 = 0.0;
    let mut sum_sq: f64 = 0.0;
    let mut total_samples: u64 = 0;

    let mut reader = std::io::BufReader::new(file);
    let mut buf = [0u8; CHUNK_BYTES];
    // Bytes of an unfinished frame carried across reads (a short read can split one).
    let mut carry = 0usize;
    loop {
        let n = reader.read(&mut buf[carry..]).map_err(io_err)?;
        if n == 0 {
            break;
        }
        let filled = carry + n;
        let whole = filled / FRAME_BYTES;
        for i in 0..whole {
            let o = i * FRAME_BYTES;
            // ffmpeg's `f32le` is little-endian by definition, so `from_le_bytes` is
            // correct on a big-endian host too — it does the swap.
            let s = f32::from_le_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]);
            // A non-finite sample cannot come from a completed ffmpeg write, but it can
            // come from a torn or truncated one, and `f32::max` propagates NaN through
            // the whole rest of the bin. Treated as silence at the point it enters.
            let a = if s.is_finite() { s.abs() } else { 0.0 };

            if a > bin_peak {
                bin_peak = a;
            }
            sum_sq += f64::from(a) * f64::from(a);
            fill += 1;
            total_samples += 1;

            if fill == BASE_BIN_SAMPLES {
                peak.push(bin_peak);
                mean_square.push((sum_sq / f64::from(fill)) as f32);
                weight.push(f64::from(fill));
                fill = 0;
                bin_peak = 0.0;
                sum_sq = 0.0;
            }
        }
        // Move any leftover partial-frame bytes to the front for the next read.
        carry = filled - whole * FRAME_BYTES;
        if carry > 0 {
            buf.copy_within(whole * FRAME_BYTES..filled, 0);
        }
    }

    // The trailing partial bin. Divided by what it actually holds, not by the nominal bin
    // size — averaging 30 samples over 120 would draw the end of every clip fading out.
    if fill > 0 {
        peak.push(bin_peak);
        mean_square.push((sum_sq / f64::from(fill)) as f32);
        weight.push(f64::from(fill));
    }

    Ok((
        total_samples,
        FloatLevel {
            bin_samples: BASE_BIN_SAMPLES,
            peak,
            mean_square,
            weight,
        },
    ))
}

/// Halves the resolution: each output bin merges two input bins.
///
/// Peak is the max of the children — the loudest transient survives all the way up the
/// ladder, which is the entire reason peak is stored separately from RMS. Mean-square is
/// the **sample-weighted** mean of the children's mean-squares, `Σ(wᵢ·msᵢ) / Σwᵢ`, so
/// `sqrt` of it is the true RMS over the union of the children's samples at every level.
/// The weights matter for exactly one bin per level — the last one, where a short
/// trailing child would otherwise be averaged as if it were as long as its sibling; see
/// [`FloatLevel::weight`] for the worked example.
///
/// An odd bin count leaves one childless parent, which simply inherits its single child
/// rather than being averaged against a phantom silent one — the alternative halves the
/// last bin's energy and puts a fade at the end of every waveform at every other zoom.
///
/// # Attribution
///
/// The per-bucket "absolute peak + root-mean-square" pair, and the choice to carry both
/// rather than one, are adapted from Clypra's `compute_waveform_buckets`
/// (`src-tauri/src/commands/media.rs`), MIT-licensed — see `THIRD-PARTY-NOTICES` at the
/// repo root and docs/DECISIONS.md D-053. What is *not* from Clypra is everything that
/// makes this usable on a service-length recording: they compute a single fixed bucket
/// count over a fully-resident `&[f32]` decoded by a fresh ffmpeg spawn per zoom level;
/// this streams a cache the sync already wrote, once, into a whole ladder.
fn merge_pairs(previous: &FloatLevel) -> FloatLevel {
    let out_bins = previous.peak.len().div_ceil(2);
    let mut peak = Vec::with_capacity(out_bins);
    let mut mean_square = Vec::with_capacity(out_bins);
    let mut weight = Vec::with_capacity(out_bins);

    // `chunks(2)` rather than indexed pairs: it cannot run off the end, and it yields the
    // odd tail as a one-element chunk, which is exactly the "inherit the single child"
    // rule stated above — the divisor is the chunk's total weight, never a hard 2.
    for ((peaks, squares), weights) in previous
        .peak
        .chunks(2)
        .zip(previous.mean_square.chunks(2))
        .zip(previous.weight.chunks(2))
        .take(out_bins)
    {
        peak.push(peaks.iter().copied().fold(0.0f32, f32::max));
        let total: f64 = weights.iter().sum();
        let energy: f64 = squares
            .iter()
            .zip(weights)
            .map(|(ms, w)| f64::from(*ms) * w)
            .sum();
        // A zero-weight chunk cannot occur (`base_level` never pushes a bin it did not
        // fill), but dividing by it would poison the whole level with NaN, so it reads as
        // silence instead.
        mean_square.push(if total > 0.0 {
            (energy / total) as f32
        } else {
            0.0
        });
        weight.push(total);
    }

    FloatLevel {
        // Saturating so a hypothetical ladder deep enough to overflow would stop growing
        // rather than wrap to a tiny bin — unreachable at thirteen levels, but `* 2` on a
        // public field is not the place to rely on "unreachable".
        bin_samples: previous.bin_samples.saturating_mul(2),
        peak,
        mean_square,
        weight,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Writes `samples` as `f32le` into a temp file and returns its path (and the dir,
    /// which must outlive it).
    fn cache_file(samples: &[f32]) -> (tempdir::Dir, std::path::PathBuf) {
        let dir = tempdir::Dir::make();
        let path = dir.path().join("entry.f32");
        let mut bytes = Vec::with_capacity(samples.len() * 4);
        for s in samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        write_bytes(&path, &bytes);
        (dir, path)
    }

    fn write_bytes(path: &Path, bytes: &[u8]) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(bytes).unwrap();
        f.flush().unwrap();
    }

    /// A minimal temp directory, removed on drop. `tempfile` is a dev-dependency of the
    /// *shell*, not of `core`, and D-052 is not worth a new dependency in the engine.
    /// Uniqueness is (pid, counter): the counter separates tests inside one binary, the
    /// pid separates the binaries a `cargo test --workspace` runs concurrently.
    mod tempdir {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU64, Ordering};

        static COUNTER: AtomicU64 = AtomicU64::new(0);

        #[derive(Debug)]
        pub struct Dir(PathBuf);

        impl Dir {
            pub fn make() -> Self {
                let n = COUNTER.fetch_add(1, Ordering::Relaxed);
                let p = std::env::temp_dir()
                    .join(format!("sundaysync-peaks-{}-{n}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                Self(p)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    /// The quantized value a level should carry for an exact float amplitude.
    fn q(v: f32) -> u8 {
        (v * 255.0).round().clamp(0.0, 255.0) as u8
    }

    #[test]
    fn a_constant_amplitude_gives_the_same_peak_and_rms_everywhere() {
        // A DC-ish square at 0.5: every bin's peak IS 0.5 and its RMS IS 0.5, at every
        // level, because merging equal bins cannot change either. This is the case that
        // catches an off-by-one in the merge just as surely as a wrong divisor.
        let samples = vec![0.5f32; BASE_BIN_SAMPLES as usize * 8];
        let (_dir, path) = cache_file(&samples);
        let p = pyramid_from_cache_file(&path).unwrap();

        assert_eq!(p.total_samples, samples.len() as u64);
        for level in &p.levels {
            for (i, (&peak, &rms)) in level.peak.iter().zip(&level.rms).enumerate() {
                assert!(
                    peak.abs_diff(q(0.5)) <= 1,
                    "level bin {i} peak {peak} (bin_samples {})",
                    level.bin_samples
                );
                assert!(
                    rms.abs_diff(q(0.5)) <= 1,
                    "level bin {i} rms {rms} (bin_samples {})",
                    level.bin_samples
                );
            }
        }
    }

    #[test]
    fn an_impulse_survives_every_level_as_peak_but_decays_as_rms() {
        // The whole reason peak is stored alongside RMS: one full-scale sample in an
        // otherwise silent clip must still be visible at the coarsest zoom. RMS, by
        // contrast, is *supposed* to wash it out — that is what "energy" means.
        let mut samples = vec![0.0f32; BASE_BIN_SAMPLES as usize * 4];
        samples[5] = 1.0;
        let (_dir, path) = cache_file(&samples);
        let p = pyramid_from_cache_file(&path).unwrap();

        for level in &p.levels {
            assert_eq!(
                level.peak.first().copied(),
                Some(255),
                "the impulse vanished at bin_samples {}",
                level.bin_samples
            );
        }
        // Level 0: one sample of 1.0 in 120 → rms = sqrt(1/120) ≈ 0.0913 → 23.
        assert!(p.levels[0].rms[0].abs_diff(q((1.0f32 / 120.0).sqrt())) <= 1);
        // Level 1 merges it with a silent bin → mean square halves, rms /= sqrt(2).
        assert!(p.levels[1].rms[0].abs_diff(q((1.0f32 / 240.0).sqrt())) <= 1);
        // Every other level-0 bin is pure silence, in both channels.
        assert!(p.levels[0].peak[1..].iter().all(|&v| v == 0));
        assert!(p.levels[0].rms[1..].iter().all(|&v| v == 0));
    }

    #[test]
    fn a_full_scale_sine_has_the_textbook_peak_and_rms() {
        // RMS of a sine is amplitude/√2 — the one waveform whose expected numbers can be
        // stated from theory rather than from re-running the implementation. 100 Hz at
        // 12 kHz is 120 samples per cycle, i.e. exactly one whole cycle per level-0 bin,
        // so every bin is a complete period and the identity holds bin-by-bin.
        let n = BASE_BIN_SAMPLES as usize * 16;
        let samples: Vec<f32> = (0..n)
            .map(|i| {
                let phase = std::f64::consts::TAU * (i as f64) / f64::from(BASE_BIN_SAMPLES);
                (0.8 * phase.sin()) as f32
            })
            .collect();
        let (_dir, path) = cache_file(&samples);
        let p = pyramid_from_cache_file(&path).unwrap();

        let expected_rms = q(0.8 / std::f32::consts::SQRT_2);
        for (i, &rms) in p.levels[0].rms.iter().enumerate() {
            assert!(
                rms.abs_diff(expected_rms) <= 1,
                "bin {i}: rms {rms}, expected ~{expected_rms}"
            );
        }
        // The peak of a 120-sample cycle sampled on the grid lands just under 0.8 (the
        // grid misses the crest); within a quantum of it.
        let expected_peak = q(0.8);
        for &peak in &p.levels[0].peak {
            assert!(
                peak.abs_diff(expected_peak) <= 1,
                "peak {peak}, expected ~{expected_peak}"
            );
        }
    }

    #[test]
    fn an_empty_file_gives_an_empty_but_complete_ladder() {
        // A zero-length cache entry is a real state (an interrupted write that still
        // committed). It must not be an error, and it must not shorten the ladder — a
        // level index means the same zoom for every clip, however short.
        let (_dir, path) = cache_file(&[]);
        let p = pyramid_from_cache_file(&path).unwrap();

        assert_eq!(p.total_samples, 0);
        assert_eq!(p.duration_seconds(), 0.0);
        assert_eq!(p.levels.len(), LEVEL_COUNT);
        assert!(p.levels.iter().all(|l| l.bins() == 0));
    }

    #[test]
    fn the_ladder_spans_ten_milliseconds_to_forty_seconds() {
        let (_dir, path) = cache_file(&vec![0.1f32; 1000]);
        let p = pyramid_from_cache_file(&path).unwrap();

        assert_eq!(p.levels.len(), LEVEL_COUNT);
        assert_eq!(p.levels[0].bin_samples, BASE_BIN_SAMPLES);
        for pair in p.levels.windows(2) {
            assert_eq!(pair[1].bin_samples, pair[0].bin_samples * 2);
        }
        let last = p.levels.len() - 1;
        // Coarsest bin covers ≥ MAX_BIN_SECONDS, and the one below it does not — the
        // ladder stops at the first level that reaches the bound, never one short and
        // never one over.
        let coarsest = f64::from(p.levels[last].bin_samples) / f64::from(ANALYSIS_RATE);
        assert!(
            coarsest >= MAX_BIN_SECONDS,
            "coarsest bin only {coarsest} s"
        );
        let previous = f64::from(p.levels[last - 1].bin_samples) / f64::from(ANALYSIS_RATE);
        assert!(
            previous < MAX_BIN_SECONDS,
            "level {} already {previous} s",
            last - 1
        );
    }

    #[test]
    fn the_ladder_reaches_the_renderers_coarsest_useful_bin() {
        // Finding 11: the frontend picks the finest level with ≤ 2 bins per DEVICE pixel
        // (waveformDraw.ts `pickLevel`/`MAX_BINS_PER_PX`). At the timeline's zoom floor
        // (geometry.ts MIN_PX_PER_MS = 0.00002 px/ms) a bin has to last 1 / (2 · 0.00002)
        // = 25 000 ms before one bar covers half a pixel; a ladder that stops short of
        // that leaves the renderer cramming bins nobody can see. Stated here, in the
        // engine that owns the ladder, because raising MAX_BIN_SECONDS is the fix and
        // lowering it again is the regression.
        const MIN_PX_PER_MS: f64 = 0.00002;
        const MAX_BINS_PER_PX: f64 = 2.0;
        let needed_ms = 1.0 / (MAX_BINS_PER_PX * MIN_PX_PER_MS);

        let (_dir, path) = cache_file(&vec![0.1f32; 1000]);
        let p = pyramid_from_cache_file(&path).unwrap();
        let coarsest_ms =
            f64::from(p.levels.last().unwrap().bin_samples) / f64::from(ANALYSIS_RATE) * 1000.0;
        assert!(
            coarsest_ms >= needed_ms,
            "coarsest bin {coarsest_ms} ms — the renderer needs ≥ {needed_ms} ms at the zoom floor"
        );
    }

    #[test]
    fn a_trailing_partial_frame_is_ignored_and_a_trailing_partial_bin_is_kept() {
        // Two different partials, two different rules. Three stray bytes are a torn write
        // and are dropped; 30 real samples at the end of a clip are audio and are kept,
        // averaged over the 30 they contain rather than the 120 the bin nominally holds.
        let dir = tempdir::Dir::make();
        let path = dir.path().join("partial.f32");

        let samples = vec![0.5f32; BASE_BIN_SAMPLES as usize + 30];
        let mut bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        bytes.extend_from_slice(&[0xff, 0xff, 0xff]); // three bytes of a fourth frame
        write_bytes(&path, &bytes);

        let p = pyramid_from_cache_file(&path).unwrap();

        // The dangling 0xffffff never became a sample.
        assert_eq!(p.total_samples, samples.len() as u64);
        assert_eq!(p.levels[0].bins(), 2);
        // The short bin is not faded: 30 samples of 0.5 read as 0.5, not 0.5·√(30/120).
        assert!(
            p.levels[0].rms[1].abs_diff(q(0.5)) <= 1,
            "{:?}",
            p.levels[0]
        );
        assert!(p.levels[0].peak[1].abs_diff(q(0.5)) <= 1);
    }

    #[test]
    fn a_coarse_bin_merges_exactly_the_two_below_it() {
        // The merge invariant, stated on values chosen so a swapped pair or an off-by-one
        // index cannot coincidentally produce the right answer: four bins at four
        // different amplitudes.
        let b = BASE_BIN_SAMPLES as usize;
        let mut samples = Vec::new();
        for amp in [0.2f32, 0.8, 0.4, 0.6] {
            samples.resize(samples.len() + b, amp);
        }
        let (_dir, path) = cache_file(&samples);
        let p = pyramid_from_cache_file(&path).unwrap();

        assert_eq!(p.levels[0].peak, vec![q(0.2), q(0.8), q(0.4), q(0.6)]);
        // Level 1 peak = max of each pair.
        assert_eq!(p.levels[1].peak, vec![q(0.8), q(0.6)]);
        // Level 1 rms = sqrt(mean of the two mean-squares).
        let ms = |x: f32, y: f32| ((x * x + y * y) / 2.0).sqrt();
        assert!(p.levels[1].rms[0].abs_diff(q(ms(0.2, 0.8))) <= 1);
        assert!(p.levels[1].rms[1].abs_diff(q(ms(0.4, 0.6))) <= 1);
        // Level 2 folds all four.
        assert_eq!(p.levels[2].peak, vec![q(0.8)]);
        let all_four = ((0.04f32 + 0.64 + 0.16 + 0.36) / 4.0).sqrt();
        assert!(p.levels[2].rms[0].abs_diff(q(all_four)) <= 1);
    }

    #[test]
    fn an_odd_bin_count_carries_the_last_child_up_unaveraged() {
        // Three level-0 bins → two level-1 bins, the second of which has one child. It
        // must inherit that child, not average it against a phantom silent sibling —
        // otherwise the tail of every waveform fades at every other zoom level.
        let b = BASE_BIN_SAMPLES as usize;
        let mut samples = Vec::new();
        for amp in [0.2f32, 0.4, 0.9] {
            samples.resize(samples.len() + b, amp);
        }
        let (_dir, path) = cache_file(&samples);
        let p = pyramid_from_cache_file(&path).unwrap();

        assert_eq!(p.levels[0].bins(), 3);
        assert_eq!(p.levels[1].bins(), 2);
        assert_eq!(p.levels[1].peak[1], q(0.9), "the odd child was diluted");
        assert!(p.levels[1].rms[1].abs_diff(q(0.9)) <= 1);
    }

    #[test]
    fn a_short_trailing_bin_is_weighted_by_what_it_holds_when_it_is_merged_up() {
        // The trailing-partial rule has to survive the merge, not just the base level.
        // 120 silent samples then 30 at full scale: the true RMS over all 150 is
        // sqrt(30/150) = 0.447. Averaging the two bins' mean-squares as equals — which is
        // what an unweighted `sum / n` does — gives sqrt((0 + 1)/2) = 0.707, 58 % high,
        // once per level and always at the clip's end.
        let mut samples = vec![0.0f32; BASE_BIN_SAMPLES as usize];
        samples.resize(BASE_BIN_SAMPLES as usize + 30, 1.0);
        let (_dir, path) = cache_file(&samples);
        let p = pyramid_from_cache_file(&path).unwrap();

        assert_eq!(p.levels[0].bins(), 2);
        assert_eq!(p.levels[0].rms[0], 0);
        assert!(p.levels[0].rms[1].abs_diff(q(1.0)) <= 1);

        let truth = q((30.0f32 / 150.0).sqrt()); // 0.4472 -> 114
        let unweighted = q((1.0f32 / 2.0).sqrt()); // 0.7071 -> 180
        assert_ne!(
            truth, unweighted,
            "the fixture must be able to tell them apart"
        );
        assert!(
            p.levels[1].rms[0].abs_diff(truth) <= 1,
            "level 1 rms {} — expected ~{truth} (unweighted would give ~{unweighted})",
            p.levels[1].rms[0]
        );
        // And it stays right all the way up: every coarser level is the same 150 samples.
        for (i, level) in p.levels.iter().enumerate().skip(1) {
            assert!(
                level.rms[0].abs_diff(truth) <= 1,
                "level {i} rms {} — expected ~{truth}",
                level.rms[0]
            );
        }
        // Peak is unaffected: the full-scale tail survives every merge. (At level 0 it is
        // still the second bin; from level 1 up the two have been folded together.)
        assert_eq!(p.levels[0].peak[1], 255);
        assert!(p.levels.iter().skip(1).all(|l| l.peak[0] == 255));
    }

    #[test]
    fn a_full_final_bin_merges_exactly_as_before_the_weights_existed() {
        // The other half of the weighting contract: when every bin is full, weights are
        // all equal and the merge must be the plain mean it always was. 120 silent then
        // 120 at full scale -> sqrt(1/2).
        let b = BASE_BIN_SAMPLES as usize;
        let mut samples = vec![0.0f32; b];
        samples.resize(2 * b, 1.0);
        let (_dir, path) = cache_file(&samples);
        let p = pyramid_from_cache_file(&path).unwrap();

        assert!(p.levels[1].rms[0].abs_diff(q((0.5f32).sqrt())) <= 1);
    }

    #[test]
    fn two_runs_over_the_same_file_are_byte_identical() {
        // §3 determinism, applied to the waveform: the same cache entry must always draw
        // the same picture, or a re-opened project would show a subtly different timeline.
        let samples: Vec<f32> = (0..5000).map(|i| ((i % 97) as f32 / 97.0) - 0.5).collect();
        let (_dir, path) = cache_file(&samples);

        let a = pyramid_from_cache_file(&path).unwrap();
        let b = pyramid_from_cache_file(&path).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn a_chunk_boundary_does_not_split_a_bin_wrongly() {
        // CHUNK_BYTES is 16 384 frames — not a multiple of 120 — so bins straddle read
        // boundaries. A file several chunks long with a per-bin-distinct amplitude proves
        // the carry logic never drops or double-counts a sample across a read.
        let b = BASE_BIN_SAMPLES as usize;
        let bins = 500; // ~3.7 chunks
        let mut samples = Vec::with_capacity(bins * b);
        for i in 0..bins {
            let amp = (i % 200) as f32 / 200.0;
            samples.resize(samples.len() + b, amp);
        }
        let (_dir, path) = cache_file(&samples);
        let p = pyramid_from_cache_file(&path).unwrap();

        assert_eq!(p.total_samples, (bins * b) as u64);
        assert_eq!(p.levels[0].bins(), bins);
        for i in 0..bins {
            let expected = q((i % 200) as f32 / 200.0);
            assert!(
                p.levels[0].peak[i].abs_diff(expected) <= 1,
                "bin {i}: {} vs {expected}",
                p.levels[0].peak[i]
            );
        }
    }

    #[test]
    fn a_missing_entry_is_a_not_found_io_error_the_shell_can_classify() {
        // D-052: the cache is swept, capped and cleared behind the timeline's back. "The
        // waveform is not built yet" must be distinguishable from "reading it failed", or
        // the shell cannot tell a regenerate affordance from a real error.
        let dir = tempdir::Dir::make();
        let missing = dir.path().join("nope.f32");

        let err = pyramid_from_cache_file(&missing).unwrap_err();
        assert!(err.is_not_found(), "not classifiable as missing: {err}");
        // And an entry that exists is not classified as missing.
        let (_d2, present) = cache_file(&[0.1, 0.2]);
        assert!(pyramid_from_cache_file(&present).is_ok());
    }

    #[test]
    fn a_directory_is_an_io_error_but_not_a_missing_entry() {
        // The other half of the classification: `is_not_found` must not be a stand-in for
        // "any IO problem", or a permissions failure would silently offer to regenerate a
        // cache that is actually fine.
        let dir = tempdir::Dir::make();
        let err = pyramid_from_cache_file(dir.path()).unwrap_err();
        assert!(!err.is_not_found(), "a directory read reported as missing");
    }

    #[test]
    fn interleaving_pairs_peak_with_rms_in_bin_order() {
        let level = Level {
            bin_samples: 120,
            peak: vec![1, 3, 5],
            rms: vec![2, 4, 6],
        };
        assert_eq!(level.interleaved(), vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(level.bins(), 3);
    }

    #[test]
    fn hot_and_non_finite_samples_clamp_instead_of_wrapping() {
        // Inter-sample overs are real, and a torn cache write can hold anything. Neither
        // may wrap a peak round to silence.
        let b = BASE_BIN_SAMPLES as usize;
        let mut samples = vec![2.5f32; b];
        samples.resize(2 * b, f32::NAN);
        let (_dir, path) = cache_file(&samples);
        let p = pyramid_from_cache_file(&path).unwrap();

        assert_eq!(p.levels[0].peak[0], 255, "a hot peak must pin, not wrap");
        assert_eq!(p.levels[0].peak[1], 0, "NaN must read as silence");
        assert_eq!(p.levels[0].rms[1], 0);
    }

    #[test]
    fn a_short_clip_still_has_every_level_with_at_least_one_bin() {
        // A 40 ms clip has fewer level-0 bins than the ladder has levels. The coarse end
        // must be one bin, never zero — a level the frontend can index but not draw is a
        // blank waveform for a clip that plainly has audio.
        let (_dir, path) = cache_file(&vec![0.7f32; 480]);
        let p = pyramid_from_cache_file(&path).unwrap();

        assert_eq!(p.levels[0].bins(), 4);
        assert!(p.levels.iter().all(|l| l.bins() >= 1));
        let coarsest = p.levels.last().unwrap();
        assert_eq!(coarsest.bins(), 1);
        assert!(coarsest.peak[0].abs_diff(q(0.7)) <= 1);
    }
}
