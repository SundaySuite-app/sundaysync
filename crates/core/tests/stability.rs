//! E4's cancellation storm (docs/V02-PROGRAM.md): cancel fired at random points across
//! ~100 runs of a modest shoot, asserting no leaked temp files, no cache corruption (a
//! subsequent clean run still succeeds), and §7.4's 2 s cancel-return bound.
//!
//! The RNG seed that picks each run's cancel delay is fixed, so a failure here always
//! reproduces from the seed printed at the top of the run — no need to re-roll a flaky
//! timing case to see it again.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sundaysync_core::{CancelToken, Error, NoProgress, Sidecar, SyncRequest};
use sundaysync_fixturegen::{shoot, signal, Rng};

/// §V02-PROGRAM E4: "~100 runs".
const RUNS: usize = 100;
/// Fixed so a failure always reproduces from this file alone.
const SEED: u64 = 0xC0FF_EE00_1234_5678;
/// §7.4's promise, with headroom against CI scheduling jitter across a 100-run storm —
/// the unit tests in `sidecar.rs` assert the bare 2 s bound on a single cancel; this
/// storm accepts up to 3 s per cancel so an occasionally-scheduled-late test thread does
/// not turn into a flaky CI failure while still catching a real regression (a real hang
/// is orders of magnitude past either bound).
const CANCEL_BOUND: Duration = Duration::from_secs(3);

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
    let d = std::env::temp_dir().join("sundaysync-stability").join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A deliberately tiny shoot — two short WAV devices, one clip each, well under the
/// §4.3 whole-clip correlation limit. The storm runs this end-to-end up to 100 times;
/// keeping it cheap is what makes that tractable in a normal test run rather than only a
/// nightly one.
fn tiny_shoot(seed: u64) -> shoot::ShootSpec {
    shoot::ShootSpec {
        name: "stability".into(),
        seed,
        duration_seconds: 10.0,
        devices: vec![
            shoot::DeviceSpec {
                id: "recorder".into(),
                codec: shoot::Codec::Wav,
                colour: signal::Colour {
                    gain_db: 0.0,
                    tilt: 0.0,
                    reverb: 0.05,
                    snr_db: Some(40.0),
                    drift_ppm: 0.0,
                },
                clips: vec![shoot::ClipSpec {
                    start_seconds: 0.0,
                    duration_seconds: 10.0,
                }],
            },
            shoot::DeviceSpec {
                id: "cam-a".into(),
                codec: shoot::Codec::Wav,
                colour: signal::Colour {
                    gain_db: -6.0,
                    tilt: -0.2,
                    reverb: 0.2,
                    snr_db: Some(20.0),
                    drift_ppm: 0.0,
                },
                clips: vec![shoot::ClipSpec {
                    start_seconds: 1.5,
                    duration_seconds: 7.0,
                }],
            },
        ],
    }
}

/// Every entry in the cache directory that is not a finished `.f32` entry or the
/// `.sundaysync-cache` marker — i.e. anything a crashed write-then-rename could have
/// left behind.
fn stray_cache_files(cache_dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return Vec::new();
    };
    entries
        .filter_map(std::result::Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != ".sundaysync-cache" && !n.ends_with(".f32"))
        .collect()
}

#[test]
fn cancellation_storm_leaves_no_leaks_and_no_corruption() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };

    let dir = scratch("storm");
    let spec = tiny_shoot(1);
    let shoot_dir = shoot::suite_dir(&dir, &spec.name, spec.seed);
    let truth = shoot::emit(&spec, &shoot_dir, &sidecar.ffmpeg).expect("emit tiny shoot");
    let cache_dir = shoot_dir.join("cache");

    let request = SyncRequest {
        cache_dir: Some(cache_dir.clone()),
        sidecar: Some(sidecar.clone()),
        ..SyncRequest::new(vec![shoot_dir.clone()])
    };

    // Calibrate the cancel-delay window from one uncancelled baseline run, so the storm
    // spreads its 100 draws across "before it starts" through "well after it would have
    // finished" regardless of how fast or slow this machine happens to be.
    let baseline_started = Instant::now();
    let baseline = sundaysync_core::sync(&request, &NoProgress, &CancelToken::new())
        .expect("baseline run must succeed before the storm begins");
    let baseline_elapsed = baseline_started.elapsed();
    assert!(
        baseline.accounts_for(&[
            shoot_dir.join("truth.json"),
            shoot_dir.join(&truth.clips[0].file),
            shoot_dir.join(&truth.clips[1].file),
        ]),
        "baseline run must itself be correct before the storm can mean anything"
    );
    let max_delay = (baseline_elapsed * 2).max(Duration::from_millis(5));

    println!(
        "cancellation storm: seed={SEED:#x}, runs={RUNS}, baseline={baseline_elapsed:?}, \
         delay window=0..{max_delay:?}"
    );

    let mut rng = Rng::new(SEED);
    let mut cancelled_count = 0usize;
    let mut completed_count = 0usize;

    for i in 0..RUNS {
        let delay = Duration::from_secs_f64(rng.range(0.0, max_delay.as_secs_f64()));
        let cancel = CancelToken::new();

        let fired_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let canceller_flag = cancel.clone();
        let canceller_fired = fired_at.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(delay);
            let now = Instant::now();
            canceller_flag.cancel();
            *canceller_fired.lock().unwrap() = Some(now);
        });

        let result = sundaysync_core::sync(&request, &NoProgress, &cancel);
        let returned_at = Instant::now();
        canceller.join().expect("canceller thread must not panic");
        let fired_at = fired_at
            .lock()
            .unwrap()
            .expect("canceller always records a fire time");

        match &result {
            Ok(r) => {
                completed_count += 1;
                assert!(
                    r.accounts_for(&[
                        shoot_dir.join("truth.json"),
                        shoot_dir.join(&truth.clips[0].file),
                        shoot_dir.join(&truth.clips[1].file),
                    ]),
                    "run {i}: a completed run must still satisfy §7.3 accounting"
                );
            }
            Err(Error::Cancelled) => {
                cancelled_count += 1;
                // Only meaningful when the cancel demonstrably preceded the return —
                // always true here, since a cancel that fires strictly after `sync`
                // already returned Ok could not itself have produced `Err(Cancelled)`.
                if fired_at <= returned_at {
                    let bound = returned_at.duration_since(fired_at);
                    assert!(
                        bound < CANCEL_BOUND,
                        "run {i}: cancel took {bound:?} to be honoured, over the {CANCEL_BOUND:?} budget"
                    );
                }
            }
            Err(other) => panic!("run {i}: unexpected error, not a value outcome: {other}"),
        }

        let stray = stray_cache_files(&cache_dir);
        assert!(
            stray.is_empty(),
            "run {i} (delay {delay:?}, outcome {result:?}) left stray cache files: {stray:?}"
        );
    }

    println!(
        "cancellation storm finished: {completed_count} completed, {cancelled_count} cancelled \
         out of {RUNS}"
    );
    // The storm is only a meaningful test of cancellation if cancellation actually
    // happened sometimes — and only a meaningful test of "cancel doesn't just break
    // everything" if some runs also completed.
    assert!(
        cancelled_count > 0,
        "the delay window never produced a cancellation"
    );
    assert!(
        completed_count > 0,
        "the delay window never let a run complete"
    );

    // The real §7.4/§11 promise: after a storm of interruptions, the cache is still
    // usable — a final clean run must succeed and be fully correct, not merely "not
    // crash".
    let final_result = sundaysync_core::sync(&request, &NoProgress, &CancelToken::new())
        .expect("a clean run after the storm must still succeed");
    assert!(
        final_result.accounts_for(&[
            shoot_dir.join("truth.json"),
            shoot_dir.join(&truth.clips[0].file),
            shoot_dir.join(&truth.clips[1].file),
        ]),
        "post-storm run failed §7.3 accounting — the cache is corrupted"
    );
    assert_eq!(
        final_result.placements.len(),
        2,
        "post-storm run should place both clips — the reference at offset zero \
         plus cam-a's real match"
    );
}
