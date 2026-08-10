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

/// The D-005 skip guard: no ffmpeg, no accuracy suite.
///
/// The trigger is `Sidecar::from_path()` failing, which since D-031 also searches
/// `/opt/homebrew/bin`, `/usr/local/bin` and `/opt/local/bin`. That changes what happens
/// on a *developer's* machine under the D-025 stripped-PATH check — these tests now RUN
/// there instead of skipping, which is strictly better: the variant was only ever a proxy
/// for CI. It changes nothing on the runners themselves. The macOS and Windows jobs
/// install no ffmpeg at all, and a Homebrew ffmpeg would have been on the runner's PATH
/// anyway (`/opt/homebrew/bin` is in it), so an empty PATH lookup there means an empty
/// fallback lookup too, and the suite still skips exactly as D-005 intends. The ubuntu
/// job sets `SUNDAYSYNC_REQUIRE_FFMPEG=1`, so a skip there is a hard failure regardless.
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

/// A clean scratch directory for one suite, scoped to this **process** (V05-W5).
///
/// See `stability.rs`'s `scratch` for the full reasoning. In short: the path used to be a
/// fixed shared location, so two `cargo test` processes (the D-025 gate runs the suite in
/// both PATH variants) wiped and rebuilt each other's fixtures under one another.
///
/// `measurements_are_reproducible` below builds the "quick-7" suite twice through this,
/// which means the second pass runs against a **cold** cache — that part is deliberate and
/// stays. Fixture emission was measured byte-identical across runs while chasing the flake,
/// so re-emitting is not itself a source of variance.
fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir()
        .join("sundaysync-accuracy")
        .join(format!("pid-{}", std::process::id()))
        .join(name);
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

        let Some(m) = correlator.match_clip(
            audio.samples(),
            reference.samples(),
            sundaysync_core::correlate::SEGMENT_COUNT,
        ) else {
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

/// §8.2: "Drift estimates within ±5 ppm of injected drift."
///
/// Asserted on the full tier only. Drift is a *slope*, so its precision depends on how
/// much offset change the regression can see across a clip; the full tier's 300–400 s
/// clips give 180–200 samples of change against ~1.5 samples of per-segment noise, while
/// a 60 s clip gives 19. See docs/DECISIONS.md D-019.
#[test]
#[ignore = "full tier: nightly and pre-release only (§8.1)"]
fn drift_is_measured_within_the_gate() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let root = scratch("drift-full");
    let seed = 1u64;
    let spec = shoot::full_suite(seed);
    let dir = shoot::suite_dir(&root, &spec.name, seed);
    let truth = shoot::emit(&spec, &dir, &sidecar.ffmpeg).expect("emit");

    let request = sundaysync_core::SyncRequest {
        cache_dir: Some(dir.join("cache")),
        ..sundaysync_core::SyncRequest::new(vec![dir.clone()])
    };
    let result = sundaysync_core::sync(&request, &NoProgress, &CancelToken::new()).expect("sync");

    println!("\n=== drift, full tier ===");
    let mut checked = 0;
    for p in &result.placements {
        let name = p.file.file_name().unwrap().to_str().unwrap();
        let Some(t) = truth.find(name) else { continue };
        if t.drift_ppm.abs() < 1.0 {
            continue;
        }
        let Some(measured) = p.drift_ppm else {
            continue;
        };
        println!(
            "  {name:<24} injected {:+6.1} ppm  measured {:+7.2} ppm",
            t.drift_ppm, measured
        );
        assert!(
            (measured.abs() - t.drift_ppm.abs()).abs() <= 5.0,
            "{name}: injected {:+.1} ppm, measured {:+.2} ppm — outside the ±5 ppm gate",
            t.drift_ppm,
            measured
        );
        checked += 1;
    }
    assert!(checked >= 2, "only {checked} drifting clips were checked");
}

/// E6 / D-042: the drift-correction END-alignment gate.
///
/// The §8.2 drift *measurement* gate above proves the engine knows the ppm; this proves the
/// exporter then puts the clip's far end where the reference wants it. CI has no Resolve, so
/// this asserts on the engine's own emitted `<timeMap>`: apply its ratio to the clip's
/// source end and check the timeline time it lands at.
///
/// A 40 ppm / 400 s clip carries 16 ms of end drift — the D-016 case. Uncorrected that is
/// well outside the ±10 ms gate; corrected it must fall inside it. Both signs of drift are
/// exercised, and the D-019 inversion (which would *double* the error) is shown failing, so
/// the test proves the correction did the work rather than the tolerance being loose.
///
/// `#[ignore]` to sit with the other full-tier drift work; run via `-- --ignored`. It needs
/// no ffmpeg — it drives the real `export_fcpxml` over a constructed result.
#[test]
#[ignore = "full tier: drift correction END-alignment (E6 / D-042)"]
fn drift_correction_lands_the_clip_end_within_the_gate() {
    use sundaysync_core::{
        export_fcpxml, export_fcpxml_with_options, Device, DeviceKind, ExportOptions, Parameters,
        Placement, Rational, Reference, Sequence, SyncResult, SCHEMA_VERSION,
    };

    // 40 ppm / 400 s. Half a frame at 50 fps is 10 ms, so 16 ms of drift is past the gate
    // and the clip is corrected — the same physics as a long church-camera clip, at a frame
    // rate that makes the half-frame rule bite for a case the plan calls out by name.
    let source_seconds = 400.0_f64;
    let fps = Rational::new(50, 1).unwrap();

    let build = |ppm: f64| -> (SyncResult, std::collections::BTreeMap<PathBuf, f64>) {
        let err_ms = ppm * 1e-6 * source_seconds * 1000.0;
        let mut durations = std::collections::BTreeMap::new();
        durations.insert(PathBuf::from("/m/rec.wav"), source_seconds + 20.0);
        durations.insert(PathBuf::from("/m/cam.mp4"), source_seconds);
        let result = SyncResult {
            schema: SCHEMA_VERSION,
            parameters: Parameters {
                analysis_rate: 12_000,
                min_psr: DEFAULT_MIN_PSR,
            },
            reference: Some(Reference {
                file: PathBuf::from("/m/rec.wav"),
                device: "rec".into(),
            }),
            devices: vec![
                Device {
                    id: "rec".into(),
                    label: "Rec".into(),
                    kind: DeviceKind::Audio,
                    files: vec![PathBuf::from("/m/rec.wav")],
                },
                Device {
                    id: "cam".into(),
                    label: "Cam".into(),
                    kind: DeviceKind::Video,
                    files: vec![PathBuf::from("/m/cam.mp4")],
                },
            ],
            placements: vec![
                Placement {
                    file: PathBuf::from("/m/rec.wav"),
                    device: "rec".into(),
                    offset_seconds: 0.0,
                    confidence: 1.0,
                    psr: f64::INFINITY,
                    drift_ppm: None,
                    projected_end_error_ms: None,
                    chain: vec![],
                    warnings: vec![],
                },
                Placement {
                    file: PathBuf::from("/m/cam.mp4"),
                    device: "cam".into(),
                    // Median placement, offset at the clip midpoint (§4.3).
                    offset_seconds: 30.0,
                    confidence: 0.9,
                    psr: 50.0,
                    drift_ppm: Some(ppm),
                    projected_end_error_ms: Some(err_ms),
                    chain: vec![],
                    warnings: vec![],
                },
            ],
            unsynced: vec![],
            sequence: Sequence {
                fps,
                duration_seconds: source_seconds + 20.0,
            },
            warnings: vec![],
        };
        (result, durations)
    };

    const TB: f64 = 48_000.0;
    println!("\n=== drift correction END-alignment (E6 / D-042) ===");
    // A clip recorded on a slow clock measures negative ppm (D-019); the positive case is a
    // fast clock. Both must correct to the same place.
    for ppm in [-40.0_f64, 40.0] {
        let (result, durations) = build(ppm);
        let e = export_fcpxml(&result, &durations, "Drift").unwrap();
        let cam = e
            .clips
            .iter()
            .find(|c| c.file.ends_with("cam.mp4"))
            .unwrap();
        let tm = cam
            .time_map
            .unwrap_or_else(|| panic!("ppm {ppm}: a 16 ms clip past half a frame must be retimed"));

        // The clip start on the timeline (offset is in the sequence's 50-fps timebase).
        let start_s = cam.offset_ticks as f64 / f64::from(fps.num());
        // `ppm` is d(offset)/d(position): source position p belongs at reference time
        // start + (1 + ppm·1e-6)·p, with the start already re-referenced by the exporter.
        let ideal_end = start_s + (1.0 + ppm * 1e-6) * source_seconds;

        let corrected_end = start_s + tm.timeline_end_ticks as f64 / TB;
        let uncorrected_end = start_s + tm.source_end_ticks as f64 / TB; // a 1:1 export
        let inverted_end = start_s
            + tm.source_end_ticks as f64 / TB
                * (tm.source_end_ticks as f64 / tm.timeline_end_ticks as f64);

        let corrected_err_ms = (corrected_end - ideal_end) * 1000.0;
        let uncorrected_err_ms = (uncorrected_end - ideal_end) * 1000.0;
        let inverted_err_ms = (inverted_end - ideal_end) * 1000.0;

        println!(
            "  ppm {ppm:+6.1}: uncorrected end {uncorrected_err_ms:+7.2} ms, \
             corrected {corrected_err_ms:+7.2} ms, inverted {inverted_err_ms:+7.2} ms"
        );

        // The whole point: correction pulls the end inside ±10 ms (in fact to ~0).
        assert!(
            corrected_err_ms.abs() <= TOLERANCE_MS,
            "ppm {ppm}: corrected end {corrected_err_ms:.2} ms outside ±{TOLERANCE_MS} ms"
        );
        // Proof the tolerance did not do the work: uncorrected is a clear ~16 ms out.
        assert!(
            uncorrected_err_ms.abs() > TOLERANCE_MS,
            "ppm {ppm}: uncorrected end only {uncorrected_err_ms:.2} ms out — nothing was proven"
        );
        // Proof the sign is right (D-019): inverting the ratio roughly doubles the error.
        assert!(
            inverted_err_ms.abs() > 1.5 * uncorrected_err_ms.abs(),
            "ppm {ppm}: inverted ratio {inverted_err_ms:.2} ms should dwarf uncorrected {uncorrected_err_ms:.2} ms"
        );
    }

    // The toggle off reproduces v1 exactly: no retime at all, even past the gate.
    let (result, durations) = build(-40.0);
    let off = export_fcpxml_with_options(
        &result,
        &durations,
        "Drift",
        ExportOptions {
            correct_drift: false,
        },
    )
    .unwrap();
    assert!(
        !off.xml.contains("<timeMap>"),
        "toggle off still retimed a clip"
    );
    println!("  toggle off: no <timeMap> emitted (v1 output)");
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

// ---- Full pipeline (Phase 4) ------------------------------------------------------

/// The whole engine, end to end, over a synthetic shoot.
///
/// Everything above measures the correlator in isolation. This runs the real
/// `sync()` — scan, probe, group, extract, correlate, place, drift — and checks the
/// §8.2 gates plus the §7.3 invariant on the actual `SyncResult` a user would get.
#[test]
fn the_full_pipeline_places_a_synthetic_shoot_correctly() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let root = scratch("pipeline");
    let seed = 11u64;
    let spec = shoot::quick_suite(seed);
    let dir = shoot::suite_dir(&root, &spec.name, seed);
    let mut truth = shoot::emit(&spec, &dir, &sidecar.ffmpeg).expect("emit");
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

    let request = sundaysync_core::SyncRequest {
        cache_dir: Some(dir.join("cache")),
        ..sundaysync_core::SyncRequest::new(vec![dir.clone()])
    };
    let result = sundaysync_core::sync(&request, &NoProgress, &CancelToken::new()).expect("sync");

    println!("\n=== full pipeline ===");
    println!(
        "reference: {:?}",
        result.reference.as_ref().map(|r| &r.file)
    );
    for p in &result.placements {
        println!(
            "  placed   {:<24} off={:9.3}s conf={:.2} drift={:?} warn={}",
            p.file.file_name().unwrap().to_string_lossy(),
            p.offset_seconds,
            p.confidence,
            p.drift_ppm.map(|d| (d * 10.0).round() / 10.0),
            p.warnings.len()
        );
    }
    for u in &result.unsynced {
        println!(
            "  refused  {:<24} {:?}",
            u.file.file_name().unwrap().to_string_lossy(),
            u.reason
        );
    }

    // §4.4: the recorder feed is the longest file, so it must be the reference.
    let reference = result.reference.as_ref().expect("a reference was chosen");
    assert!(
        reference.file.to_string_lossy().contains("recorder"),
        "expected the recorder feed as reference, got {:?}",
        reference.file
    );

    // Every real clip placed, uncorrelated audio refused.
    let placed_names: Vec<String> = result
        .placements
        .iter()
        .map(|p| p.file.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    for clip in truth.clips.iter().filter(|c| !c.uncorrelated) {
        assert!(
            placed_names.contains(&clip.file),
            "{} was not placed",
            clip.file
        );
    }
    assert!(
        !placed_names.iter().any(|n| n.starts_with("unrelated")),
        "uncorrelated audio was placed on the timeline"
    );
    assert!(
        result
            .unsynced
            .iter()
            .any(|u| u.file.to_string_lossy().contains("unrelated")),
        "the uncorrelated file should appear in unsynced"
    );

    // Offsets are relative to the reference, and must match truth.
    let ref_truth = truth
        .find(reference.file.file_name().unwrap().to_str().unwrap())
        .expect("reference truth")
        .offset_seconds;
    for p in &result.placements {
        let name = p.file.file_name().unwrap().to_str().unwrap();
        let Some(t) = truth.find(name) else { continue };
        if t.uncorrelated {
            continue;
        }
        let expected = t.offset_seconds - ref_truth;
        let error_ms = (p.offset_seconds - expected) * 1000.0;
        assert!(
            error_ms.abs() <= FRAME_MS,
            "{name} placed {error_ms:.2} ms out, beyond one frame"
        );
    }

    // §4.6: the drifting device reports drift, and the clean ones do not report much.
    let drifting = result
        .placements
        .iter()
        .find(|p| p.file.to_string_lossy().contains("cam-stage"))
        .expect("cam-stage placed");
    let ppm = drifting
        .drift_ppm
        .expect("drift measured on a 5-segment clip");
    // Magnitude is checked loosely here and precisely in the full tier. A 60 s clip gives
    // the regression only ~19 samples of offset change across its whole span, so the
    // slope is inherently noisy; the full tier's 300–400 s clips give 180–200 samples and
    // support §8.2's ±5 ppm gate properly. See docs/DECISIONS.md D-019.
    assert!(
        ppm.abs() > 10.0 && ppm.abs() < 90.0,
        "cam-stage was built with 40 ppm drift, measured {ppm:.1}"
    );

    // §7.3: nothing lost, nothing double-reported.
    //
    // The expected set is every file in the directory, not just the media: `truth.json`
    // was handed over too, and the engine correctly refuses it as a decode error.
    // Accounting covers whatever the user actually dropped in.
    let mut inputs: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(std::result::Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    inputs.sort();
    assert!(
        result.accounts_for(&inputs),
        "a file was lost or double-reported"
    );

    // §13.4: byte-identical across runs, now over the whole pipeline.
    let again = sundaysync_core::sync(&request, &NoProgress, &CancelToken::new()).expect("sync");
    assert_eq!(
        serde_json::to_string(&result).unwrap(),
        serde_json::to_string(&again).unwrap(),
        "the pipeline is not deterministic"
    );
}

/// §9 advanced: a device override flows through the whole pipeline — the moved clip
/// lands under its new device in the result, the §7.3 accounting still holds, and the
/// run stays deterministic.
#[test]
fn device_overrides_flow_through_the_full_pipeline() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let root = scratch("override-pipeline");
    let seed = 13u64;
    let spec = shoot::quick_suite(seed);
    let dir = shoot::suite_dir(&root, &spec.name, seed);
    shoot::emit(&spec, &dir, &sidecar.ffmpeg).expect("emit");

    // Baseline: find which device the balcony camera's first clip grouped under.
    let base_request = sundaysync_core::SyncRequest {
        cache_dir: Some(dir.join("cache")),
        ..sundaysync_core::SyncRequest::new(vec![dir.clone()])
    };
    let base =
        sundaysync_core::sync(&base_request, &NoProgress, &CancelToken::new()).expect("sync");
    let moved_file = base
        .placements
        .iter()
        .find(|p| p.file.to_string_lossy().contains("cam-balcony_0001"))
        .expect("balcony clip placed")
        .file
        .clone();
    let target_device = base
        .placements
        .iter()
        .find(|p| p.file.to_string_lossy().contains("cam-stage"))
        .expect("stage clip placed")
        .device
        .clone();

    // Move the balcony clip onto the stage camera's device and re-run (warm cache).
    let mut request = base_request.clone();
    request
        .device_overrides
        .insert(moved_file.clone(), target_device.clone());
    let result = sundaysync_core::sync(&request, &NoProgress, &CancelToken::new()).expect("sync");

    let moved = result
        .placements
        .iter()
        .find(|p| p.file == moved_file)
        .expect("moved clip still placed");
    assert_eq!(moved.device, target_device, "override did not take");
    let device = result
        .devices
        .iter()
        .find(|d| d.id == target_device)
        .expect("target device exists");
    assert!(device.files.contains(&moved_file));

    // §7.3 accounting still holds over the overridden run.
    let mut inputs: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(std::result::Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    inputs.sort();
    assert!(result.accounts_for(&inputs));

    // Determinism holds with overrides in play (§3).
    let again = sundaysync_core::sync(&request, &NoProgress, &CancelToken::new()).expect("sync");
    assert_eq!(
        serde_json::to_string(&result).unwrap(),
        serde_json::to_string(&again).unwrap()
    );
}
