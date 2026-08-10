//! E4's two-instance concurrency test (docs/V02-PROGRAM.md): two engines sharing one
//! cache dir simultaneously. The write-then-rename design in `crates/core/src/extract.rs`
//! (each worker decodes to its own scratch file, then renames onto the shared
//! content-keyed `.f32` entry) is supposed to make this safe by construction — this
//! proves it, for the scenario the design actually targets.
//!
//! # A finding surfaced and fixed in E4: same-process instances
//!
//! `Cache::temp_path` (`crates/core/src/cache.rs`) names a scratch file from
//! `(cache key, process::id(), nonce)`. This test suite surfaced a real gap: the nonce
//! used to be a per-[`Extractor`] counter starting at 0, so two separate `Extractor`
//! instances constructed in the *same* OS process (identical `process::id()`) collided on
//! the Nth file's `<key>.<pid>-<nonce>.tmp` scratch path — one worker's `fs::rename` moved
//! the shared temp out from under the other's still-running ffmpeg, which then failed its
//! `fs::metadata` check with a spurious `decode_error` on a perfectly good file. Distinct
//! from F9 (Windows' non-atomic-overwrite `rename`): it reproduced on POSIX too.
//!
//! Fixed in E4 (D-037): the nonce is now a single process-global `AtomicU64`
//! (`SCRATCH_NONCE` in `crates/core/src/extract.rs`), unique across every `Extractor` in
//! the process, so two same-process instances can never share a scratch path. The pid in
//! `temp_path` still carries cross-process uniqueness.
//! [`two_extractors_in_one_process_do_not_collide_on_temp_names`] proves it below.
//!
//! This mattered in practice, not just in theory: `sync_with_durations` constructs a
//! *fresh* `Extractor` on every call (`crates/core/src/lib.rs`), so two overlapping
//! `sync()` calls in one running app — a re-sync fired before the first finishes, for
//! instance — hit exactly this path.
//!
//! # What this file actually gates on
//!
//! The two non-ignored tests below drive genuinely separate OS **processes** (this test
//! binary re-execs itself via `std::env::current_exe()`, filtered to one hidden worker
//! test) sharing one cache dir — the scenario `Cache::temp_path`'s doc comment actually
//! promises, and the one that matches how two independent SundaySync launches would
//! collide in practice.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use sundaysync_core::{Cache, CancelToken, Extractor, NoProgress, Sidecar, SyncRequest};
use sundaysync_fixturegen::shoot;

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
        .join("sundaysync-concurrency")
        // Per-process (V05-W5): see `stability.rs`'s `scratch` for why the pid is here.
        .join(format!("pid-{}", std::process::id()))
        .join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A small multi-device shoot — enough files (5) that two instances racing over them have
/// a real chance of colliding on the same entry mid-decode, without paying minutes of
/// correlation cost this file does not need.
fn small_shoot(seed: u64) -> shoot::ShootSpec {
    let mut spec = shoot::quick_suite(seed);
    spec.name = "concurrency".into();
    spec
}

/// Every entry in the cache directory that is not a finished `.f32` entry or the
/// `.sundaysync-cache` marker.
fn stray_cache_files(cache_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return Vec::new();
    };
    entries
        .filter_map(std::result::Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != ".sundaysync-cache" && !n.ends_with(".f32"))
        .collect()
}

// ---- Hidden re-exec worker -------------------------------------------------------------

/// Not a test in the usual sense: an ordinary `cargo test` run sees
/// `SUNDAYSYNC_WORKER_MODE` unset and returns immediately, a trivial pass. [`spawn_worker`]
/// launches this SAME compiled test binary as a genuinely separate OS process via
/// `std::env::current_exe()`, filtered with `--exact` to run only this test — which is
/// what gives the two racing instances distinct pids, the scenario `Cache::temp_path`
/// actually targets.
#[test]
fn concurrency_worker_process() {
    let Ok(mode) = std::env::var("SUNDAYSYNC_WORKER_MODE") else {
        return;
    };
    let shoot_dir = PathBuf::from(
        std::env::var("SUNDAYSYNC_WORKER_SHOOT_DIR").expect("SUNDAYSYNC_WORKER_SHOOT_DIR"),
    );
    let cache_dir = PathBuf::from(
        std::env::var("SUNDAYSYNC_WORKER_CACHE_DIR").expect("SUNDAYSYNC_WORKER_CACHE_DIR"),
    );
    // Resolved independently in this process rather than passed down — proving nothing
    // about resolution depends on inheriting a parent's already-verified `Sidecar`, and
    // matching how a real second app launch would start up.
    let sidecar = Sidecar::from_path().expect("ffmpeg must be on PATH in the worker too");

    match mode.as_str() {
        "extract" => {
            let truth: shoot::Truth = serde_json::from_str(
                &std::fs::read_to_string(shoot_dir.join("truth.json")).expect("read truth.json"),
            )
            .expect("parse truth.json");
            let paths: Vec<PathBuf> = truth
                .clips
                .iter()
                .map(|c| shoot_dir.join(&c.file))
                .collect();
            let extractor = Extractor::new(sidecar, Cache::new(cache_dir));
            match extractor.extract_all(&paths, &NoProgress, &CancelToken::new()) {
                Ok(results) if results.iter().all(std::result::Result::is_ok) => {
                    let samples: Vec<usize> = results
                        .into_iter()
                        .map(|r| r.unwrap_or_else(|_| unreachable!()).samples)
                        .collect();
                    println!(
                        "WORKER_RESULT::OK::{}",
                        serde_json::to_string(&samples).expect("serialise samples")
                    );
                }
                Ok(results) => {
                    let errs: Vec<String> = results
                        .into_iter()
                        .filter_map(std::result::Result::err)
                        .map(|e| format!("{e:?}"))
                        .collect();
                    println!("WORKER_RESULT::ERR::{}", errs.join("; "));
                }
                Err(e) => println!("WORKER_RESULT::ERR::{e}"),
            }
        }
        "sync" => {
            // §7.3 accounting is checked HERE, in-process, rather than by round-tripping
            // the result through JSON in the parent: `psr` is `f64::INFINITY` for the
            // reference's own placement (place.rs — it is placed "by construction", not
            // by correlation), and `serde_json` serialises a
            // non-finite f64 as `null` but — asymmetrically — refuses to *deserialise*
            // `null` back into an `f64`. That is a fact about the wire format, not
            // something to work around by weakening the check.
            let mut inputs: Vec<PathBuf> = std::fs::read_dir(&shoot_dir)
                .expect("read shoot dir")
                .filter_map(std::result::Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect();
            inputs.sort();

            let request = SyncRequest {
                cache_dir: Some(cache_dir),
                sidecar: Some(sidecar),
                ..SyncRequest::new(vec![shoot_dir])
            };
            match sundaysync_core::sync(&request, &NoProgress, &CancelToken::new()) {
                Ok(result) => {
                    println!("WORKER_ACCOUNTS_FOR::{}", result.accounts_for(&inputs));
                    println!(
                        "WORKER_RESULT::OK::{}",
                        serde_json::to_string(&result).expect("serialise result")
                    );
                }
                Err(e) => println!("WORKER_RESULT::ERR::{e}"),
            }
        }
        other => panic!("unknown SUNDAYSYNC_WORKER_MODE {other}"),
    }
}

fn spawn_worker(mode: &str, shoot_dir: &Path, cache_dir: &Path) -> Child {
    Command::new(std::env::current_exe().expect("current test binary path"))
        .args(["concurrency_worker_process", "--exact", "--nocapture"])
        .env("SUNDAYSYNC_WORKER_MODE", mode)
        .env("SUNDAYSYNC_WORKER_SHOOT_DIR", shoot_dir)
        .env("SUNDAYSYNC_WORKER_CACHE_DIR", cache_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn worker subprocess")
}

fn worker_output(child: Child) -> std::process::Output {
    child.wait_with_output().expect("wait for worker")
}

/// Pulls the `WORKER_RESULT::` line out of a worker's stdout — the harness's own
/// "running 1 test" / "test ... ok" chatter is present alongside it even under
/// `--nocapture` (which only stops *test-body* output from being swallowed; the
/// harness's own status lines are unaffected), so this scans rather than assumes a
/// single-line stdout.
fn worker_result(output: &std::process::Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("WORKER_RESULT::OK::") {
            return Ok(rest.to_string());
        }
        if let Some(rest) = line.strip_prefix("WORKER_RESULT::ERR::") {
            return Err(rest.to_string());
        }
    }
    Err(format!(
        "worker produced no result line (exit {:?}); stdout={stdout:?} stderr={:?}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    ))
}

/// Pulls a `WORKER_ACCOUNTS_FOR::<bool>` line out of a worker's stdout, if present.
fn worker_accounts_for(output: &std::process::Output) -> Option<bool> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find_map(|l| l.strip_prefix("WORKER_ACCOUNTS_FOR::"))
        .and_then(|v| v.parse().ok())
}

// ---- The real gate: separate processes --------------------------------------------------

#[test]
fn two_extractors_in_separate_processes_share_one_cache_dir_safely() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("extractor-process-race");
    let spec = small_shoot(41);
    let shoot_dir = shoot::suite_dir(&dir, &spec.name, spec.seed);
    let truth = shoot::emit(&spec, &shoot_dir, &sidecar.ffmpeg).expect("emit shoot");
    let cache_dir = dir.join("shared-cache");

    // Both children are spawned before either is waited on, so their ffmpeg decodes
    // genuinely overlap rather than merely running back to back.
    let child_a = spawn_worker("extract", &shoot_dir, &cache_dir);
    let child_b = spawn_worker("extract", &shoot_dir, &cache_dir);

    let out_a = worker_output(child_a);
    let out_b = worker_output(child_b);
    let a = worker_result(&out_a).expect("worker A must succeed");
    let b = worker_result(&out_b).expect("worker B must succeed");
    let samples_a: Vec<usize> = serde_json::from_str(&a).expect("worker A: valid JSON");
    let samples_b: Vec<usize> = serde_json::from_str(&b).expect("worker B: valid JSON");

    assert_eq!(samples_a.len(), truth.clips.len());
    assert_eq!(
        samples_a, samples_b,
        "two separate processes disagreed on decoded sample counts for the same shared cache"
    );

    // §11's "interrupted extraction leaves no corrupt cache entries" extended to a real
    // cross-process race: whichever process's rename lost must not have left a `.tmp`
    // scratch file behind.
    let stray = stray_cache_files(&cache_dir);
    assert!(
        stray.is_empty(),
        "the cross-process race left stray cache files: {stray:?}"
    );
}

#[test]
fn two_full_sync_runs_in_separate_processes_agree() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("sync-process-race");
    let spec = small_shoot(43);
    let shoot_dir = shoot::suite_dir(&dir, &spec.name, spec.seed);
    shoot::emit(&spec, &shoot_dir, &sidecar.ffmpeg).expect("emit shoot");
    let cache_dir = dir.join("shared-cache");

    let child_a = spawn_worker("sync", &shoot_dir, &cache_dir);
    let child_b = spawn_worker("sync", &shoot_dir, &cache_dir);

    let out_a = worker_output(child_a);
    let out_b = worker_output(child_b);
    let a = worker_result(&out_a).expect("run A must succeed");
    let b = worker_result(&out_b).expect("run B must succeed");

    // §13.4 determinism, now under a genuine cross-process race rather than two
    // sequential calls: the engine is a pure function of its inputs, so two concurrent
    // `sync()` processes over the same shoot must still agree byte for byte. Compared as
    // opaque strings — see the worker's own comment on why round-tripping `SyncResult`
    // back through `serde_json::from_str` here would fail on the reference's non-finite
    // `psr` (`f64::INFINITY`) regardless of
    // whether the two runs agree.
    assert_eq!(
        a, b,
        "two racing sync() processes over the same shoot diverged"
    );

    // §7.3 accounting was checked inside each worker process, against its own live
    // `SyncResult`, for exactly that reason.
    assert_eq!(
        worker_accounts_for(&out_a),
        Some(true),
        "worker A failed §7.3 accounting under the cross-process race"
    );
    assert_eq!(
        worker_accounts_for(&out_b),
        Some(true),
        "worker B failed §7.3 accounting under the cross-process race"
    );

    let stray = stray_cache_files(&cache_dir);
    assert!(
        stray.is_empty(),
        "the cross-process sync race left stray cache files: {stray:?}"
    );

    // The cache the race left behind must still be usable — the real §7.4/§11 promise.
    let request = SyncRequest {
        cache_dir: Some(cache_dir),
        sidecar: Some(sidecar),
        ..SyncRequest::new(vec![shoot_dir])
    };
    let again = sundaysync_core::sync(&request, &NoProgress, &CancelToken::new())
        .expect("a follow-up run against the raced cache must still succeed");
    assert_eq!(serde_json::to_string(&again).unwrap(), a);
}

// ---- Regression for the E4 same-process nonce fix (D-037) --------------------------------

#[test]
fn two_extractors_in_one_process_do_not_collide_on_temp_names() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("extractor-thread-race");
    let spec = small_shoot(47);
    let shoot_dir = shoot::suite_dir(&dir, &spec.name, spec.seed);
    let truth = shoot::emit(&spec, &shoot_dir, &sidecar.ffmpeg).expect("emit shoot");
    let cache_dir = dir.join("shared-cache");
    let paths: Vec<PathBuf> = truth
        .clips
        .iter()
        .map(|c| shoot_dir.join(&c.file))
        .collect();

    let extractor_a = Extractor::new(sidecar.clone(), Cache::new(cache_dir.clone()));
    let extractor_b = Extractor::new(sidecar, Cache::new(cache_dir.clone()));

    let (result_a, result_b) = std::thread::scope(|scope| {
        let pa = &paths;
        let pb = &paths;
        let handle_a =
            scope.spawn(|| extractor_a.extract_all(pa, &NoProgress, &CancelToken::new()));
        let handle_b =
            scope.spawn(|| extractor_b.extract_all(pb, &NoProgress, &CancelToken::new()));
        (
            handle_a.join().expect("worker A must not panic"),
            handle_b.join().expect("worker B must not panic"),
        )
    });

    let out_a = result_a.expect("extractor A must not hard-error");
    let out_b = result_b.expect("extractor B must not hard-error");
    for (i, path) in paths.iter().enumerate() {
        assert!(
            out_a[i].is_ok(),
            "A failed on {}: {:?}",
            path.display(),
            out_a[i].as_ref().err()
        );
        assert!(
            out_b[i].is_ok(),
            "B failed on {}: {:?}",
            path.display(),
            out_b[i].as_ref().err()
        );
    }
}
