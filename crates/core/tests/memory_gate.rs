//! E4's §7.7 memory gate (docs/V02-PROGRAM.md): PROVE < 4 GB peak RSS on a long-reference
//! synthetic day, not merely promise it.
//!
//! # This test is expected to fail until the engine agent's memory fix lands
//!
//! F10/P-3 (`docs/V02-PROGRAM.md`'s E2 stability/backend backlog) found that `place.rs`
//! loads the *entire* reference into a `Vec<f32>` and that `extract.rs`'s `load()`
//! transiently double-allocates (a `Vec<u8>` of the raw cache bytes stays alive while the
//! `Vec<f32>` it is converted into is built alongside it) — together enough to blow the
//! §7.7 4 GB ceiling on a reference anywhere near the 20 h target. That fix is being
//! written by a different agent in a different worktree and is **not present here**, so
//! this gate is `#[ignore]`d: it is written correctly against the real 4 GB bound (never
//! weakened) and is meant to be run manually — `cargo test --test memory_gate -- --ignored
//! --nocapture` — both now (where it is expected to fail, and by how much is worth
//! recording) and again once the fix is merged (where it must pass).
//!
//! # Why this is a long reference with FEW clips, not the literal 20 h/200 files
//!
//! `sundaysync_fixturegen::day::DaySpec::full_day` is the literal §7.7 target (20 h, 200
//! files) and is what `sundaysync bench` should be pointed at once E5's correlation
//! performance fix (P-1: cost is `O(reference_length × clips × segments)`, nothing
//! cached yet) makes that tractable to run in a normal test session. Today it is not —
//! by P-1's own measured baseline (3 h reference, 30 clips, ~8 min of pass-1 correlation
//! alone), the full spec would take on the order of hours. This gate instead isolates the
//! MEMORY dimension: `Extractor::load()`'s double-allocation is a function of the
//! reference's length alone, so a long reference with few, short (`<45 s`, so each
//! correlates as a single whole-clip pass rather than 5 segments — `WHOLE_CLIP_LIMIT_
//! SECONDS`) clips reproduces the memory finding without paying the correlation-time cost
//! §7.7's literal 200-file figure would. See `sundaysync_fixturegen::day`'s module doc for
//! the same reasoning applied to the fixture generator itself (index-based, bounded-memory
//! generation, so the generator's own footprint never confounds this measurement).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use sundaysync_core::{CancelToken, NoProgress, Sidecar, SyncRequest};
use sundaysync_fixturegen::DaySpec;

/// §7.7's promise, verbatim.
const RSS_CEILING_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Long enough that `Extractor::load()`'s transient double-allocation on the reference
/// alone (`2 × reference_seconds × ANALYSIS_RATE × 4 bytes`) exceeds the 4 GB ceiling by
/// itself: at 12 kHz that crossover is ~11.6 h, so 14 h gives comfortable margin without
/// needlessly inflating fixture size/generation time. See the module doc for why this is
/// not the literal 20 h target.
const REFERENCE_HOURS: f64 = 14.0;
/// Few, and short — see the module doc's "Why this is a long reference with FEW clips"
/// section. Each is well under `WHOLE_CLIP_LIMIT_SECONDS` (45 s), so pass 1 correlates
/// each as a single whole-clip pass rather than 5 segments.
const CLIP_COUNT: usize = 4;
const CLIP_SECONDS_MIN: f64 = 15.0;
const CLIP_SECONDS_MAX: f64 = 40.0;
const SEED: u64 = 0x7DA7_5EED;

fn require_ffmpeg() -> Option<Sidecar> {
    match Sidecar::from_path() {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("SKIP: ffmpeg unavailable ({e})");
            None
        }
    }
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir()
        .join("sundaysync-memory-gate")
        .join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

// ---- Peak RSS sampling (deliberately self-contained — see note below) -------------------
//
// This duplicates `crates/cli/src/bench.rs`'s `RssSampler` rather than sharing it: that
// type lives in `sundaysync-cli`, which depends on `sundaysync-core`, so `core`'s own
// tests cannot depend back on it without a cyclic dependency. ~40 lines of platform-
// guarded polling was cheaper than restructuring either crate's dependency graph for a
// test-only helper. Keep the two in sync if the sampling strategy ever changes.

struct RssSampler {
    peak_kb: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl RssSampler {
    fn start() -> Self {
        let peak_kb = Arc::new(AtomicU64::new(current_rss_kb().unwrap_or(0)));
        let stop = Arc::new(AtomicBool::new(false));
        let (p, s) = (peak_kb.clone(), stop.clone());
        let handle = std::thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                if let Some(kb) = current_rss_kb() {
                    p.fetch_max(kb, Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        Self {
            peak_kb,
            stop,
            handle: Some(handle),
        }
    }

    fn finish(mut self) -> Option<u64> {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        let polled = self.peak_kb.load(Ordering::Relaxed);
        let hwm = kernel_peak_rss_kb().unwrap_or(0);
        let best = polled.max(hwm);
        if best == 0 {
            None
        } else {
            Some(best * 1024)
        }
    }
}

#[cfg(target_os = "linux")]
fn read_proc_status_field(prefix: &str) -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix(prefix) {
            return rest.trim().split_whitespace().next()?.parse().ok();
        }
    }
    None
}
#[cfg(target_os = "linux")]
fn current_rss_kb() -> Option<u64> {
    read_proc_status_field("VmRSS:")
}
#[cfg(target_os = "linux")]
fn kernel_peak_rss_kb() -> Option<u64> {
    read_proc_status_field("VmHWM:")
}

#[cfg(target_os = "macos")]
fn current_rss_kb() -> Option<u64> {
    let pid = std::process::id();
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}
#[cfg(target_os = "macos")]
fn kernel_peak_rss_kb() -> Option<u64> {
    None
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn current_rss_kb() -> Option<u64> {
    None
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn kernel_peak_rss_kb() -> Option<u64> {
    None
}

fn format_bytes(bytes: u64) -> String {
    let gb = bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    format!("{gb:.3} GB")
}

// ---- The gate -----------------------------------------------------------------------------

#[test]
#[ignore = "E4 §7.7 memory gate — heavy (generates a multi-GB fixture) and, before the \
            engine agent's F10/P-3 memory fix lands in this worktree, EXPECTED TO FAIL. \
            Run manually: cargo test -p sundaysync-core --test memory_gate -- --ignored \
            --nocapture. See this file's module doc."]
fn peak_rss_stays_under_the_7_7_ceiling() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };

    let dir = scratch("gate");
    let mut spec = DaySpec::memory_probe(SEED, REFERENCE_HOURS, CLIP_COUNT);
    spec.clip_seconds_min = CLIP_SECONDS_MIN;
    spec.clip_seconds_max = CLIP_SECONDS_MAX;

    println!(
        "generating fixture: {REFERENCE_HOURS} h reference, {CLIP_COUNT} clips \
         ({CLIP_SECONDS_MIN}-{CLIP_SECONDS_MAX} s each) at {} Hz…",
        spec.rate
    );
    let gen_started = Instant::now();
    sundaysync_fixturegen::day::emit_day(&spec, &dir).expect("emit day fixture");
    println!("fixture generated in {:?}", gen_started.elapsed());

    let request = SyncRequest {
        cache_dir: Some(dir.join("cache")),
        sidecar: Some(sidecar),
        ..SyncRequest::new(vec![dir.clone()])
    };

    let sampler = RssSampler::start();
    let started = Instant::now();
    let result = sundaysync_core::sync(&request, &NoProgress, &CancelToken::new());
    let elapsed = started.elapsed();
    let peak = sampler.finish();

    let result = result.expect("sync must complete (even if it blows the memory budget)");
    println!(
        "sync finished in {elapsed:?}: {} placements, {} unsynced",
        result.placements.len(),
        result.unsynced.len()
    );

    match peak {
        Some(bytes) => {
            println!(
                "peak RSS: {} (ceiling {})",
                format_bytes(bytes),
                format_bytes(RSS_CEILING_BYTES)
            );
            assert!(
                bytes < RSS_CEILING_BYTES,
                "§7.7 VIOLATED: peak RSS {} exceeds the {} ceiling — expected pre-fix \
                 (F10/P-3); re-run once the engine agent's memory fix is merged",
                format_bytes(bytes),
                format_bytes(RSS_CEILING_BYTES)
            );
        }
        None => panic!(
            "could not measure RSS on this platform — the gate cannot assert anything, \
             which must not be reported as a pass"
        ),
    }
}
