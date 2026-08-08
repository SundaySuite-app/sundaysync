//! E5 / P-1: the correlation-scaling fix — determinism oracle and timing.
//!
//! The finding (docs/V02-PROGRAM.md, E5 backlog P-1): `Correlator` cached only an
//! `FftPlanner`, so `find()` re-ran the whole overlap-save loop over the reference for
//! every segment of every clip, recomputing the reference's forward-FFT block spectra
//! ~48,000 times on a 3 h service. §4.3 promised that transform is "computed once and
//! cached"; Tier 1 implements exactly that.
//!
//! This file proves two things:
//!
//! 1. **Determinism (§13.2/§13.4).** The cached path must place clips *bit-identically* to
//!    the exhaustive path it replaces. `Correlator::match_clip_exhaustive` is the retained
//!    oracle; `accuracy_suite_places_identically_through_both_paths` runs the real §8.1
//!    fixtures through both and diffs every field of every `ClipMatch`.
//!
//! 2. **The win.** `correlation_scaling_benchmark` (`#[ignore]`d — it is a measurement, not
//!    a gate) times pass-1-style correlation with the cache on vs. off on a synthetic
//!    in-memory reference, and projects to the §10 3 h target.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::time::Instant;
use sundaysync_core::{
    correlate::{Correlator, SEGMENT_COUNT},
    Cache, CancelToken, Extractor, NoProgress, Sidecar, ANALYSIS_RATE,
};
use sundaysync_fixturegen::shoot::{self, Truth};

/// Mirrors accuracy.rs's D-005 skip guard.
fn require_ffmpeg() -> Option<Sidecar> {
    match Sidecar::from_path() {
        Ok(s) => Some(s),
        Err(e) => {
            assert!(
                std::env::var("SUNDAYSYNC_REQUIRE_FFMPEG").is_err(),
                "ffmpeg is required in this environment but was not found: {e}"
            );
            eprintln!("SKIP: ffmpeg unavailable ({e})");
            None
        }
    }
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir()
        .join("sundaysync-correlation-perf")
        .join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Deterministic broadband noise — the same generator the correlate unit tests use.
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

/// The strongest determinism oracle: build a real §8.1 shoot, extract it exactly as the
/// pipeline would, then correlate every clip against the reference through BOTH the cached
/// (`match_clip`) and exhaustive (`match_clip_exhaustive`) paths and assert the resulting
/// `ClipMatch`es are bit-for-bit equal. A cache that changed any placement — even by one
/// ULP — fails here.
#[test]
fn accuracy_suite_places_identically_through_both_paths() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };

    for (tier, seed) in [("quick", 1u64), ("quick", 7u64)] {
        let root = scratch(&format!("{tier}-{seed}"));
        let spec = shoot::quick_suite(seed);
        let dir = shoot::suite_dir(&root, &spec.name, seed);
        let truth: Truth = shoot::emit(&spec, &dir, &sidecar.ffmpeg).expect("emit fixtures");
        diff_paths(&truth, &dir, &sidecar);
    }
}

fn diff_paths(truth: &Truth, dir: &Path, sidecar: &Sidecar) {
    let paths: Vec<PathBuf> = truth.clips.iter().map(|c| dir.join(&c.file)).collect();
    let extractor = Extractor::new(sidecar.clone(), Cache::new(dir.join("cache")));
    let extracted = extractor
        .extract_all(&paths, &NoProgress, &CancelToken::new())
        .expect("extraction");

    let (ref_idx, _) = extracted
        .iter()
        .enumerate()
        .filter_map(|(i, r)| r.as_ref().ok().map(|c| (i, c.samples)))
        .max_by_key(|(_, s)| *s)
        .expect("a reference");
    let reference = extracted[ref_idx]
        .as_ref()
        .expect("reference extracted")
        .load()
        .expect("reference audio");

    // One reused correlator for the cached path (as place() pass 1 does) and one for the
    // exhaustive path, so both see identical reuse patterns.
    let mut cached = Correlator::new();
    let mut exhaustive = Correlator::new();

    for (i, clip) in truth.clips.iter().enumerate() {
        if i == ref_idx {
            continue;
        }
        let audio = extracted[i]
            .as_ref()
            .expect("clip extracted")
            .load()
            .expect("clip audio");

        let a = cached.match_clip(audio.samples(), reference.samples(), SEGMENT_COUNT);
        let b =
            exhaustive.match_clip_exhaustive(audio.samples(), reference.samples(), SEGMENT_COUNT);

        match (a, b) {
            (Some(a), Some(b)) => {
                assert_eq!(
                    a.offset_samples.to_bits(),
                    b.offset_samples.to_bits(),
                    "{}: offset differs between cached and exhaustive paths",
                    clip.file
                );
                assert_eq!(
                    a.psr.to_bits(),
                    b.psr.to_bits(),
                    "{}: psr differs",
                    clip.file
                );
                assert_eq!(
                    a.mad_ms.to_bits(),
                    b.mad_ms.to_bits(),
                    "{}: mad differs",
                    clip.file
                );
                assert_eq!(
                    a.consistent, b.consistent,
                    "{}: consistency differs",
                    clip.file
                );
                assert_eq!(
                    a.segments.len(),
                    b.segments.len(),
                    "{}: segment count differs",
                    clip.file
                );
                for (sa, sb) in a.segments.iter().zip(b.segments.iter()) {
                    assert_eq!(sa.start_in_clip, sb.start_in_clip, "{}", clip.file);
                    assert_eq!(
                        sa.offset_samples.to_bits(),
                        sb.offset_samples.to_bits(),
                        "{}: segment offset differs",
                        clip.file
                    );
                    assert_eq!(
                        sa.psr.to_bits(),
                        sb.psr.to_bits(),
                        "{}: segment psr",
                        clip.file
                    );
                }
            }
            (a, b) => assert_eq!(
                a.is_some(),
                b.is_some(),
                "{}: one path matched and the other did not",
                clip.file
            ),
        }
    }
}

/// Measures the P-1 win: pass-1-style correlation of many long clips against one reference,
/// cache on vs. off, with a projection to the §10 3 h / ~20-clip target. `#[ignore]`d
/// because it is a measurement (and allocates a multi-hundred-MB reference), not a gate.
///
/// Run: `cargo test -p sundaysync-core --test correlation_perf -- --ignored --nocapture`.
#[test]
#[ignore = "measurement, not a gate — run with --ignored --nocapture"]
fn correlation_scaling_benchmark() {
    let rate = ANALYSIS_RATE as usize;
    // A reference long enough to make the per-segment reference transform the dominant
    // cost, but short enough to run in a test session; the result is projected to 3 h.
    let ref_minutes = 12;
    let ref_len = ref_minutes * 60 * rate;
    let clip_count = 12;
    let clip_secs = 90; // > 45 s, so each clip is 5 segments (the P-1 hot case)
    let clip_len = clip_secs * rate;

    println!(
        "\n=== P-1 correlation scaling ===\nreference {ref_minutes} min ({ref_len} samples), \
         {clip_count} clips x {clip_secs}s ({SEGMENT_COUNT} segments each)"
    );

    let reference = noise(ref_len, 0xC0FFEE);
    // Clips are real slices of the reference at known lags, spread across it.
    let clips: Vec<Vec<f32>> = (0..clip_count)
        .map(|i| {
            let lag = (ref_len - clip_len) * i / clip_count;
            reference[lag..lag + clip_len].to_vec()
        })
        .collect();

    // Three public variants isolate the two independent wins:
    //   exhaustive+parallel = reference transform recomputed per segment (pre-P-1 kernel),
    //                         segments fanned out.
    //   cached+serial       = Tier 1 alone (reference transform memoised, one thread).
    //   cached+parallel     = the shipping path (Tier 1 + §4.3(c) segment fan-out).
    // Dividing the pair (exhaustive vs cached, at equal parallelism) isolates the Tier-1
    // memoisation factor; the pair (cached serial vs parallel) isolates the parallel factor.
    let time = |label: &str, elapsed: std::time::Duration| -> std::time::Duration {
        println!("  {label:<28} {elapsed:?}");
        elapsed
    };

    let bench = |select: u8| -> std::time::Duration {
        let mut c = Correlator::new();
        let started = Instant::now();
        for clip in &clips {
            let m = match select {
                0 => c.match_clip_exhaustive(clip, &reference, SEGMENT_COUNT),
                1 => c.match_clip_serial(clip, &reference, SEGMENT_COUNT),
                _ => c.match_clip(clip, &reference, SEGMENT_COUNT),
            };
            assert!(m.is_some(), "a clip failed to match");
        }
        started.elapsed()
    };

    let exhaustive = time("exhaustive+parallel", bench(0));
    let cached_serial = time("cached+serial (Tier 1)", bench(1));
    let cached_parallel = time("cached+parallel (shipping)", bench(2));

    // Tier-1 factor is measured at equal (parallel) parallelism: exhaustive+parallel vs
    // cached+parallel. Parallel factor is measured at equal (cached) memoisation:
    // cached+serial vs cached+parallel. Combined = product = serial-exhaustive vs shipping.
    let tier1 = exhaustive.as_secs_f64() / cached_parallel.as_secs_f64().max(1e-9);
    let par = cached_serial.as_secs_f64() / cached_parallel.as_secs_f64().max(1e-9);
    println!(
        "  Tier-1 memoisation: {tier1:.2}x  |  segment parallelism: {par:.2}x  |  combined: {:.2}x",
        tier1 * par
    );

    // Correlation cost is ~linear in reference length and clip count. Project the shipping
    // path to the §10 realistic (3 h / 20 clips) and stress (8 h / 100 clips) scenarios.
    // The "pre-P-1" reference is a serial-exhaustive equivalent: cached+serial scaled up by
    // the Tier-1 memoisation factor measured at equal (parallel) parallelism, which removes
    // the parallel speedup and leaves the pre-P-1 single-threaded kernel.
    //
    // IMPORTANT: the reference-spectra cache is byte-budgeted so it can never breach §7.7's
    // 4 GB ceiling. At the default 20 s segment / 2^20 FFT a reference's spectra are ~10.4
    // bytes/sample, so the ~1.75 GiB budget caps the cached regime at ~4 h. A reference past
    // that (e.g. the 8 h stress day, whose spectra alone would be ~3.6 GB) STREAMS, so its
    // shipping timing is the exhaustive-kernel-parallel path, not cached+parallel. The
    // projection reflects that: it uses cached+parallel only where the spectra fit.
    let spectra_bytes = |ref_h: f64| -> f64 {
        let r = ref_h * 3600.0 * rate as f64; // samples
        let seg = 20.0 * rate as f64;
        let n = (4.0 * seg).max(2.0).log2().ceil().exp2();
        let step = n - seg + 1.0;
        let padded = r + 2.0 * (seg - 1.0);
        (padded / step).ceil() * n * 8.0
    };
    let budget = 1_879_048_192.0_f64; // must track REF_SPECTRA_BUDGET_BYTES
    let serial_exhaustive_equiv = cached_serial.as_secs_f64() * tier1;
    let project = |secs: f64, ref_h: f64, clips_n: f64| -> f64 {
        let ref_scale = (ref_h * 3600.0 * rate as f64) / ref_len as f64;
        let clip_scale = clips_n / clip_count as f64;
        secs * ref_scale * clip_scale
    };
    for (h, n) in [(3.0, 20.0), (8.0, 100.0)] {
        let fits = spectra_bytes(h) <= budget;
        // Shipping uses cached+parallel when the spectra fit the budget; otherwise it streams
        // (exhaustive kernel), so parallelism is the only win — model that as exhaustive
        // scaled by the parallel factor, i.e. serial-exhaustive / par.
        let shipping = if fits {
            project(cached_parallel.as_secs_f64(), h, n)
        } else {
            project(serial_exhaustive_equiv / par, h, n)
        };
        println!(
            "  projected {h} h / {n:.0} clips:  pre-P-1 ~ {:.0} s  ->  shipping ~ {:.0} s  \
             (spectra {:.1} GB, {})",
            project(serial_exhaustive_equiv, h, n),
            shipping,
            spectra_bytes(h) / 1e9,
            if fits {
                "cached+parallel"
            } else {
                "streams+parallel"
            },
        );
    }
}
