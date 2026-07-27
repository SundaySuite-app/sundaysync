//! The §8.2 accuracy gates, measured against §8.1 synthetic fixtures.
//!
//! This is the file that decides whether SundaySync works. Everything else in the repo
//! is machinery for getting here: generate a shoot whose true offsets are known, run the
//! real extraction and correlation path over it, and check the answers.
//!
//! Per docs/PLAN.md §13.2, **these thresholds are not to be weakened to make CI pass.**
//! If a gate looks wrong, it goes to Richard.

// §7.1's ban on `unwrap`/`expect` protects the engine's production paths — a panic there
// takes down a user's sync run. This is a test harness: a failed fixture setup *should*
// abort loudly. clippy.toml's `allow-unwrap-in-tests` does not reach here, because it
// only recognises `#[cfg(test)]` modules and an integration test is its own crate.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use sundaysync_core::{
    correlate::Correlator, request::DEFAULT_MIN_PSR, Cache, CancelToken, Extractor, NoProgress,
    Sidecar,
};
use sundaysync_fixturegen::shoot::{self, Codec, Truth};

/// §8.2: "≥ 95 % of syncable clips within ±10 ms of truth".
const TOLERANCE_MS: f64 = 10.0;
const REQUIRED_WITHIN_TOLERANCE: f64 = 0.95;
/// §8.2: "100 % of placed clips within ±1 frame". The suites are 25 fps (PAL, which is
/// what these churches shoot), so one frame is 40 ms.
const FRAME_MS: f64 = 1000.0 / 25.0;

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
    let d = std::env::temp_dir().join("sundaysync-accuracy").join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// One clip's measured outcome.
struct Measured {
    file: String,
    codec: Codec,
    truth_ms: f64,
    measured_ms: f64,
    psr: f64,
    mad_ms: f64,
    uncorrelated: bool,
}

impl Measured {
    fn error_ms(&self) -> f64 {
        self.measured_ms - self.truth_ms
    }
}

/// Builds a suite, runs the real pipeline over it, and returns every measurement.
fn run_suite(tier: &str, seed: u64, sidecar: &Sidecar) -> Vec<Measured> {
    let root = scratch(&format!("{tier}-{seed}"));
    let spec = match tier {
        "quick" => shoot::quick_suite(seed),
        _ => shoot::full_suite(seed),
    };
    let dir = shoot::suite_dir(&root, &spec.name, seed);
    let mut truth = shoot::emit(&spec, &dir, &sidecar.ffmpeg).expect("emit fixtures");
    shoot::emit_uncorrelated(
        &mut truth,
        &dir,
        "unrelated",
        25.0,
        seed,
        Codec::Wav,
        &sidecar.ffmpeg,
    )
    .expect("emit uncorrelated");

    measure(&truth, &dir, sidecar)
}

fn measure(truth: &Truth, dir: &Path, sidecar: &Sidecar) -> Vec<Measured> {
    let paths: Vec<PathBuf> = truth.clips.iter().map(|c| dir.join(&c.file)).collect();
    let extractor = Extractor::new(sidecar.clone(), Cache::new(dir.join("cache")));
    let extracted = extractor
        .extract_all(&paths, &NoProgress, &CancelToken::new())
        .expect("extraction");

    // §4.4 picks the longest audio as reference; in these suites that is the recorder
    // feed, exactly as it would be in a real shoot.
    let (ref_idx, _) = extracted
        .iter()
        .enumerate()
        .filter_map(|(i, r)| r.as_ref().ok().map(|c| (i, c.samples)))
        .filter(|(i, _)| !truth.clips[*i].uncorrelated)
        .max_by_key(|(_, s)| *s)
        .expect("a reference");
    let reference = extracted[ref_idx]
        .as_ref()
        .expect("reference extracted")
        .load()
        .expect("reference audio");
    let ref_truth_ms = truth.clips[ref_idx].offset_seconds * 1000.0;

    let mut correlator = Correlator::new();
    let mut out = Vec::new();

    for (i, clip) in truth.clips.iter().enumerate() {
        if i == ref_idx {
            continue;
        }
        let Ok(cached) = &extracted[i] else {
            panic!("fixture {} failed to extract", clip.file);
        };
        let audio = cached.load().expect("clip audio");

        let Some(m) = correlator.match_clip(audio.samples(), reference.samples()) else {
            // No match at all is a legitimate outcome for the uncorrelated file; for a
            // real clip it is a failure the gate below will catch.
            out.push(Measured {
                file: clip.file.clone(),
                codec: clip.codec,
                truth_ms: f64::NAN,
                measured_ms: f64::NAN,
                psr: 0.0,
                mad_ms: f64::NAN,
                uncorrelated: clip.uncorrelated,
            });
            continue;
        };

        out.push(Measured {
            file: clip.file.clone(),
            codec: clip.codec,
            // Offsets are relative to the reference, so truth must be a difference too.
            truth_ms: clip.offset_seconds * 1000.0 - ref_truth_ms,
            measured_ms: m.offset_samples / f64::from(sundaysync_core::ANALYSIS_RATE) * 1000.0,
            psr: m.psr,
            mad_ms: m.mad_ms,
            uncorrelated: clip.uncorrelated,
        });
    }
    out
}

fn report(tier: &str, seed: u64, rows: &[Measured]) {
    println!("\n=== {tier} suite, seed {seed} ===");
    println!(
        "{:<24} {:5} {:>11} {:>11} {:>10} {:>8} {:>7}",
        "file", "codec", "truth ms", "measured ms", "error ms", "psr", "mad ms"
    );
    for r in rows {
        if r.uncorrelated {
            println!(
                "{:<24} {:5} {:>11} {:>11} {:>10} {:>8.1} {:>7.1}   <- must be refused",
                r.file,
                format!("{:?}", r.codec),
                "-",
                "-",
                "-",
                r.psr,
                r.mad_ms
            );
        } else {
            println!(
                "{:<24} {:5} {:>11.1} {:>11.1} {:>10.2} {:>8.1} {:>7.2}",
                r.file,
                format!("{:?}", r.codec),
                r.truth_ms,
                r.measured_ms,
                r.error_ms(),
                r.psr,
                r.mad_ms
            );
        }
    }
}

#[test]
fn quick_suite_meets_the_accuracy_gates() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let rows = run_suite("quick", 1, &sidecar);
    report("quick", 1, &rows);
    assert_gates(&rows);
}

/// The §8.2 gates, applied to one suite's measurements.
fn assert_gates(rows: &[Measured]) {
    let real: Vec<&Measured> = rows.iter().filter(|r| !r.uncorrelated).collect();
    assert!(!real.is_empty(), "no syncable clips measured");

    // Gate 1 — zero false placements. The most important one: §8.2 and §7.5 both make
    // "never place a clip wrongly" the product's core promise, and a single violation
    // here is worse than any number of honest failures.
    let placed: Vec<&&Measured> = real.iter().filter(|r| r.psr >= DEFAULT_MIN_PSR).collect();
    let false_placements: Vec<_> = placed
        .iter()
        .filter(|r| r.error_ms().abs() > FRAME_MS)
        .collect();
    assert!(
        false_placements.is_empty(),
        "FALSE PLACEMENTS (placed but off by more than one frame): {:?}",
        false_placements
            .iter()
            .map(|r| (&r.file, r.error_ms(), r.psr))
            .collect::<Vec<_>>()
    );

    // Gate 2 — an uncorrelated file must never be placed. A correlator that always
    // answers would sail through every positive test above while being useless.
    for r in rows.iter().filter(|r| r.uncorrelated) {
        assert!(
            r.psr < DEFAULT_MIN_PSR,
            "unrelated audio scored psr {:.1}, at or above the {DEFAULT_MIN_PSR} threshold — \
             it would have been placed",
            r.psr
        );
    }

    // Gate 3 — ≥95 % of syncable clips within ±10 ms.
    let within = real
        .iter()
        .filter(|r| r.error_ms().abs() <= TOLERANCE_MS)
        .count();
    let fraction = within as f64 / real.len() as f64;
    assert!(
        fraction >= REQUIRED_WITHIN_TOLERANCE,
        "only {within}/{} clips within ±{TOLERANCE_MS} ms ({:.0}%), need {:.0}%",
        real.len(),
        fraction * 100.0,
        REQUIRED_WITHIN_TOLERANCE * 100.0
    );

    // Gate 4 — every syncable clip must be found at all.
    for r in &real {
        assert!(
            r.psr >= DEFAULT_MIN_PSR,
            "{} was not placed (psr {:.1} < {DEFAULT_MIN_PSR}) — a false negative",
            r.file,
            r.psr
        );
    }
}

/// The `full` tier — §8.1's "minutes, nightly + pre-release".
///
/// Marked `#[ignore]` so it stays out of the per-push gate and runs via
/// `cargo test -- --ignored`, which is what the nightly workflow does. It carries the
/// cases `quick` cannot afford: a 10-minute event, five devices, an MP4 camera file, a
/// phone at 4 dB SNR under heavy reverb, and drift in both directions.
#[test]
#[ignore = "full tier: nightly and pre-release only (§8.1)"]
fn full_suite_meets_the_accuracy_gates() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let rows = run_suite("full", 1, &sidecar);
    report("full", 1, &rows);
    assert_gates(&rows);
}

/// Determinism at the level that matters: the same fixtures must measure identically.
#[test]
fn measurements_are_reproducible() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let a = run_suite("quick", 7, &sidecar);
    let b = run_suite("quick", 7, &sidecar);
    assert_eq!(a.len(), b.len());
    for (x, y) in a.iter().zip(b.iter()) {
        assert_eq!(x.file, y.file);
        assert_eq!(
            x.measured_ms.to_bits(),
            y.measured_ms.to_bits(),
            "{} drifted between runs",
            x.file
        );
        assert_eq!(x.psr.to_bits(), y.psr.to_bits());
    }
}

/// D-004's regression guard, promoted to a first-class test.
///
/// Per-codec decoder delay would show as a *constant bias per codec* rather than random
/// error — the failure mode that looks like a plausible result. Asserting the mean error
/// per codec catches it where a global tolerance would not.
#[test]
fn no_codec_carries_a_systematic_offset() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let rows = run_suite("quick", 3, &sidecar);
    report("codec-bias", 3, &rows);

    let mut by_codec: std::collections::BTreeMap<String, Vec<f64>> = Default::default();
    for r in rows.iter().filter(|r| !r.uncorrelated) {
        by_codec
            .entry(format!("{:?}", r.codec))
            .or_default()
            .push(r.error_ms());
    }

    for (codec, errors) in &by_codec {
        let mean = errors.iter().sum::<f64>() / errors.len() as f64;
        println!(
            "  {codec:5}: mean error {mean:+.2} ms over {} clips",
            errors.len()
        );
        assert!(
            mean.abs() <= TOLERANCE_MS,
            "{codec} shows a systematic {mean:+.2} ms bias — see docs/DECISIONS.md D-004"
        );
    }
}
