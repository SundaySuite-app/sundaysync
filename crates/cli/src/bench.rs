//! `sundaysync bench` — measure the engine against a corpus of real shoots (§8.3).
//!
//! The synthetic suite proves the engine works on audio we generated. This proves it works
//! on audio a church actually recorded, which is a different and harder claim: real rooms,
//! real congregations, real cameras with their own quirks. §8.3 makes a corpus regression
//! a release blocker, so this exits non-zero when a shoot fails its gates.
//!
//! # Corpus layout
//!
//! ```text
//! corpus/
//!   2026-03-15-morning/
//!     ZOOM0001.WAV
//!     C0001.MP4
//!     truth.json
//!   2026-04-02-easter/
//!     ...
//! ```
//!
//! `truth.json` is the same shape `fixturegen` emits, so a synthetic shoot can be dropped
//! straight into a corpus — including the E4 §7.7 "day" fixture from
//! `sundaysync_fixturegen::day`, which is just another shoot directory as far as this
//! command is concerned.
//!
//! # P-7: cold/warm, per-stage timing, peak RSS
//!
//! `docs/V02-PROGRAM.md`'s E2 backend backlog (P-7) found this command measuring only a
//! single wall-clock number with whatever cache state happened to be lying around —
//! useless for validating a performance or memory fix, since neither a cold-cache decode
//! cost nor a peak-memory figure could be told apart from a warm re-run. Every shoot is
//! now run twice per §10's own cold/warm framing: **cold** (the cache this command owns
//! is cleared first) and **warm** (immediately after, cache primed). Both passes are
//! timed per-stage via [`StageTimer`], and RSS is sampled throughout via [`RssSampler`] —
//! together the table this prints is what the §7.7 4 GB ceiling and the §10 timing
//! budgets are actually validated against.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};
use sundaysync_core::{Cache, CancelToken, Progress, ProgressSink, Stage, SyncRequest, SyncResult};

/// §8.2: ≥95 % of syncable clips within ±10 ms.
const TOLERANCE_MS: f64 = 10.0;
const REQUIRED_WITHIN_TOLERANCE: f64 = 0.95;

/// §7.7's promise, printed alongside every peak-RSS figure so a regression is visible at
/// a glance rather than requiring the reader to remember the budget.
const RSS_CEILING_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct Truth {
    #[serde(default)]
    clips: Vec<TruthClip>,
}

#[derive(Debug, Deserialize)]
struct TruthClip {
    file: String,
    /// True start in event time. Absent or null for a file that must not be placed.
    #[serde(default)]
    offset_seconds: Option<f64>,
    #[serde(default)]
    uncorrelated: bool,
}

/// One pass's timing/memory measurement, independent of accuracy.
struct PassStats {
    elapsed: Duration,
    /// Per-stage wall-clock, in the order stages were first seen (§3's pipeline order in
    /// practice, but not assumed — see [`StageTimer`]).
    stages: Vec<(Stage, Duration)>,
    /// `None` on a platform [`RssSampler`] cannot measure — reported as "n/a" rather than
    /// guessed, because a silent zero would look like a pass rather than an unmeasured
    /// gate.
    peak_rss_bytes: Option<u64>,
}

struct ShootReport {
    name: String,
    clips: usize,
    within_tolerance: usize,
    worst_error_ms: f64,
    false_placements: Vec<String>,
    missed: Vec<String>,
    wrongly_placed: Vec<String>,
    cold: PassStats,
    warm: PassStats,
}

impl ShootReport {
    fn passed(&self) -> bool {
        self.false_placements.is_empty()
            && self.wrongly_placed.is_empty()
            && self.missed.is_empty()
            && (self.clips == 0
                || self.within_tolerance as f64 / self.clips as f64 >= REQUIRED_WITHIN_TOLERANCE)
    }

    /// The larger of the two passes' peaks — cold is typically the ceiling because
    /// nothing is cached yet, but this does not assume that, since a warm run still
    /// re-loads and re-correlates every candidate (only decoding is skipped).
    fn peak_rss_bytes(&self) -> Option<u64> {
        match (self.cold.peak_rss_bytes, self.warm.peak_rss_bytes) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) | (None, Some(a)) => Some(a),
            (None, None) => None,
        }
    }
}

pub fn run(
    corpus: &Path,
    cache_dir: Option<&Path>,
    min_psr: f64,
    cancel: &CancelToken,
) -> ExitCode {
    let shoots = match discover(corpus) {
        Ok(s) if s.is_empty() => {
            eprintln!(
                "no shoots found in {} — each shoot is a subdirectory containing a truth.json",
                corpus.display()
            );
            return ExitCode::FAILURE;
        }
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: could not read {}: {e}", corpus.display());
            return ExitCode::FAILURE;
        }
    };

    println!(
        "Benchmarking {} shoot(s) from {}\n",
        shoots.len(),
        corpus.display()
    );
    let mut reports = Vec::new();

    for shoot in shoots {
        match measure(&shoot, cache_dir, min_psr, cancel) {
            Ok(r) => {
                print_shoot(&r);
                reports.push(r);
            }
            Err(e) => {
                println!("  {}: ERROR — {e}", shoot.display());
                return ExitCode::FAILURE;
            }
        }
    }

    let total: usize = reports.iter().map(|r| r.clips).sum();
    let within: usize = reports.iter().map(|r| r.within_tolerance).sum();
    let worst = reports.iter().map(|r| r.worst_error_ms).fold(0.0, f64::max);
    let cold_time: f64 = reports.iter().map(|r| r.cold.elapsed.as_secs_f64()).sum();
    let warm_time: f64 = reports.iter().map(|r| r.warm.elapsed.as_secs_f64()).sum();
    let peak_rss = reports.iter().filter_map(ShootReport::peak_rss_bytes).max();
    let failed: Vec<&ShootReport> = reports.iter().filter(|r| !r.passed()).collect();

    println!("\n=== corpus summary ===");
    println!("shoots            : {}", reports.len());
    println!("clips             : {total}");
    if total > 0 {
        println!(
            "within ±{TOLERANCE_MS} ms  : {within}/{total} ({:.1}%)",
            100.0 * within as f64 / total as f64
        );
    }
    println!("worst error       : {worst:.2} ms");
    println!("total time (cold) : {cold_time:.1} s");
    println!("total time (warm) : {warm_time:.1} s");
    match peak_rss {
        Some(bytes) => println!(
            "peak RSS          : {} (ceiling {})",
            format_bytes(bytes),
            format_bytes(RSS_CEILING_BYTES)
        ),
        None => println!("peak RSS          : n/a (not measurable on this platform)"),
    }
    if peak_rss.is_some_and(|b| b > RSS_CEILING_BYTES) {
        println!("                    ⚠ OVER the §7.7 4 GB ceiling");
    }

    if failed.is_empty() {
        println!("\nPASS — every shoot meets the §8.2 gates");
        ExitCode::SUCCESS
    } else {
        println!("\nFAIL — {} shoot(s) below the gates:", failed.len());
        for r in failed {
            println!("  {}", r.name);
        }
        // §8.3: "Regression = release blocker."
        ExitCode::FAILURE
    }
}

fn discover(corpus: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(corpus)? {
        let path = entry?.path();
        if path.is_dir() && path.join("truth.json").is_file() {
            out.push(path);
        }
    }
    // Deterministic order so two benchmark runs are comparable line by line.
    out.sort();
    Ok(out)
}

fn measure(
    shoot: &Path,
    cache_dir: Option<&Path>,
    min_psr: f64,
    cancel: &CancelToken,
) -> Result<ShootReport, String> {
    let truth: Truth = serde_json::from_str(
        &std::fs::read_to_string(shoot.join("truth.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("truth.json: {e}"))?;

    // P-7: this command owns the cache directory it measures against, defaulting to a
    // throwaway one keyed by shoot name so two shoots in the same corpus run never share
    // (and so pollute) each other's "cold" number.
    let owned_cache_dir;
    let cache_dir: PathBuf = match cache_dir {
        Some(d) => d.to_path_buf(),
        None => {
            owned_cache_dir = std::env::temp_dir().join("sundaysync-bench-cache").join(
                shoot
                    .file_name()
                    .map_or_else(|| "shoot".into(), |n| n.to_string_lossy().into_owned()),
            );
            owned_cache_dir
        }
    };
    // The "cold" figure below is only cold if this actually emptied the cache. `clear`
    // refuses a directory it never stamped (S-7), and swallowing that turned a warm run
    // into a number labelled cold — the exact confusion P-7 exists to remove. Not fatal:
    // the accuracy comparison is unaffected, and a labelled-suspect timing beats no run.
    if let Err(e) = Cache::new(cache_dir.clone()).clear() {
        eprintln!(
            "warning: could not clear {} before the cold pass ({e}) — \
             the \"cold\" timing below is NOT cold",
            cache_dir.display()
        );
    }

    let request = SyncRequest {
        cache_dir: Some(cache_dir),
        min_psr,
        ..SyncRequest::new(vec![shoot.to_path_buf()])
    };

    let (cold_result, cold) = run_timed(&request, cancel)?;
    let (warm_result, warm) = run_timed(&request, cancel)?;

    let mut report = compare(shoot, &truth, &warm_result);
    report.cold = cold;
    report.warm = warm;
    // Determinism (§13.4) means either result would do for accuracy; keeping the
    // (already-computed) warm one is arbitrary but consistent.
    let _ = cold_result;
    Ok(report)
}

/// Runs one `sync()` pass with timing and RSS instrumentation attached.
fn run_timed(
    request: &SyncRequest,
    cancel: &CancelToken,
) -> Result<(SyncResult, PassStats), String> {
    let timer = StageTimer::new();
    let sampler = RssSampler::start();
    let started = Instant::now();
    let result = sundaysync_core::sync(request, &timer, cancel).map_err(|e| e.to_string())?;
    let elapsed = started.elapsed();
    // Close the stage timer FIRST. `StageTimer::finish` attributes everything since the
    // last stage transition to the stage still open, so anything done between `sync()`
    // returning and this call lands inside the final stage's bucket. Stopping the sampler
    // first put its thread shutdown there, which made the per-stage totals overstate the
    // last stage and exceed the `elapsed` printed beside them — a bench that lies about
    // its own measurement is worse than one that does not measure.
    let stages = timer.finish();
    let peak_rss_bytes = sampler.finish();
    Ok((
        result,
        PassStats {
            elapsed,
            stages,
            peak_rss_bytes,
        },
    ))
}

fn compare(shoot: &Path, truth: &Truth, result: &SyncResult) -> ShootReport {
    let name = shoot.file_name().map_or_else(
        || shoot.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );

    // Offsets are relative to whichever file the engine chose as reference, so truth must
    // be compared as a difference against that same file.
    let ref_truth = result
        .reference
        .as_ref()
        .and_then(|r| r.file.file_name())
        .and_then(|n| n.to_str())
        .and_then(|n| truth.clips.iter().find(|c| c.file == n))
        .and_then(|c| c.offset_seconds)
        .unwrap_or(0.0);

    let mut within_tolerance = 0;
    let mut clips = 0;
    let mut worst_error_ms: f64 = 0.0;
    let mut false_placements = Vec::new();
    let mut wrongly_placed = Vec::new();
    let mut missed = Vec::new();

    for clip in &truth.clips {
        let placed = result
            .placements
            .iter()
            .find(|p| p.file.file_name().is_some_and(|n| n == clip.file.as_str()));

        if clip.uncorrelated || clip.offset_seconds.is_none() {
            // A file with no relationship to the event must never be placed. This is the
            // gate that matters most (§7.5) — it is the difference between a tool that is
            // honest and one that always answers.
            if placed.is_some() {
                false_placements.push(clip.file.clone());
            }
            continue;
        }

        let Some(expected) = clip.offset_seconds else {
            continue;
        };
        let Some(p) = placed else {
            missed.push(clip.file.clone());
            continue;
        };

        clips += 1;
        let error_ms = (p.offset_seconds - (expected - ref_truth)) * 1000.0;
        worst_error_ms = worst_error_ms.max(error_ms.abs());
        if error_ms.abs() <= TOLERANCE_MS {
            within_tolerance += 1;
        }
        // One frame at the sequence rate is the "definitely wrong" line (§8.2).
        let frame_ms = 1000.0 / result.sequence.fps.as_f64().max(1.0);
        if error_ms.abs() > frame_ms {
            wrongly_placed.push(format!("{} ({error_ms:+.1} ms)", clip.file));
        }
    }

    ShootReport {
        name,
        clips,
        within_tolerance,
        worst_error_ms,
        false_placements,
        missed,
        wrongly_placed,
        // Filled in by `measure` — placeholders here keep this function focused on
        // accuracy comparison alone, as it was before P-7.
        cold: PassStats {
            elapsed: Duration::ZERO,
            stages: Vec::new(),
            peak_rss_bytes: None,
        },
        warm: PassStats {
            elapsed: Duration::ZERO,
            stages: Vec::new(),
            peak_rss_bytes: None,
        },
    }
}

fn print_shoot(r: &ShootReport) {
    let verdict = if r.passed() { "PASS" } else { "FAIL" };
    println!(
        "  {verdict}  {:<32} {}/{} within ±{TOLERANCE_MS} ms, worst {:.2} ms",
        r.name, r.within_tolerance, r.clips, r.worst_error_ms
    );
    println!(
        "          cold: {:>7.2}s  {}",
        r.cold.elapsed.as_secs_f64(),
        format_stages(&r.cold.stages)
    );
    println!(
        "          warm: {:>7.2}s  {}",
        r.warm.elapsed.as_secs_f64(),
        format_stages(&r.warm.stages)
    );
    match r.peak_rss_bytes() {
        Some(bytes) => {
            let over = if bytes > RSS_CEILING_BYTES {
                " ⚠ OVER the §7.7 4 GB ceiling"
            } else {
                ""
            };
            println!("          peak RSS: {}{over}", format_bytes(bytes));
        }
        None => println!("          peak RSS: n/a (not measurable on this platform)"),
    }
    for f in &r.false_placements {
        println!("          ! placed uncorrelated audio: {f}");
    }
    for f in &r.wrongly_placed {
        println!("          ! placed more than a frame out: {f}");
    }
    for f in &r.missed {
        println!("          ! not placed at all: {f}");
    }
}

fn format_stages(stages: &[(Stage, Duration)]) -> String {
    if stages.is_empty() {
        return "(no stage timing recorded)".to_string();
    }
    stages
        .iter()
        .map(|(stage, d)| format!("{stage:?} {:.2}s", d.as_secs_f64()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn format_bytes(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.2} GB", b / GB)
    } else {
        format!("{:.1} MB", b / MB)
    }
}

// ---- P-7: per-stage timing -----------------------------------------------------------

/// Wraps the engine's `Progress` events, timestamping every stage transition.
///
/// Nothing in `core` may read the wall clock (§3, determinism) — `Progress` carries a
/// stage and a completion count, never a timestamp — so per-stage timing has to be
/// reconstructed by whoever consumes the events, on the outside of the engine boundary.
/// This is exactly that: the first event for a new [`Stage`] closes the previous stage's
/// bucket and opens the new one.
struct StageTimer {
    state: std::sync::Mutex<StageTimerState>,
}

struct StageTimerState {
    current: Option<Stage>,
    since: Instant,
    /// Append-only, in first-seen order. A stage could in principle be revisited (the
    /// engine does not promise otherwise); durations are summed per stage in
    /// [`StageTimer::finish`] rather than assumed unique here.
    closed: Vec<(Stage, Duration)>,
}

impl StageTimer {
    fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(StageTimerState {
                current: None,
                since: Instant::now(),
                closed: Vec::new(),
            }),
        }
    }

    /// Closes out whatever stage was open and returns the per-stage total durations, in
    /// the order each stage was first seen.
    fn finish(self) -> Vec<(Stage, Duration)> {
        let mut state = match self.state.into_inner() {
            Ok(s) => s,
            // A poisoned lock means a reporting thread panicked mid-update; the timings
            // collected so far are still meaningful, so recover rather than losing them.
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(stage) = state.current.take() {
            let elapsed = state.since.elapsed();
            state.closed.push((stage, elapsed));
        }

        let mut order: Vec<Stage> = Vec::new();
        let mut totals: Vec<(Stage, Duration)> = Vec::new();
        for (stage, d) in state.closed {
            match order.iter().position(|s| *s == stage) {
                Some(idx) => totals[idx].1 += d,
                None => {
                    order.push(stage);
                    totals.push((stage, d));
                }
            }
        }
        totals
    }
}

impl ProgressSink for StageTimer {
    fn report(&self, p: Progress) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.current == Some(p.stage) {
            return;
        }
        let now = Instant::now();
        if let Some(prev) = state.current.take() {
            let since = state.since;
            state.closed.push((prev, now.duration_since(since)));
        }
        state.current = Some(p.stage);
        state.since = now;
    }
}

// ---- P-7: peak RSS sampling ------------------------------------------------------------

/// Samples this process's resident set size on a background thread while a measurement
/// runs, so `bench` can report the peak §7.7 promises to keep under 4 GB.
///
/// There is no portable, dependency-free "peak RSS so far" syscall, so this polls and
/// tracks its own running maximum; on Linux it additionally cross-checks against the
/// kernel's own `VmHWM`, which cannot miss a spike between polls the way sampling can.
/// Any other platform reports `None` rather than guessing — an unmeasurable platform must
/// read as "cannot assert", never as a silent pass.
struct RssSampler {
    peak_kb: std::sync::Arc<std::sync::atomic::AtomicU64>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

/// Gap between RSS samples. Fine enough to catch a spike, coarse enough that the `ps`
/// spawn on macOS costs nothing next to a decode.
const RSS_SAMPLE_INTERVAL: Duration = Duration::from_millis(100);

/// How responsively the sampler notices [`RssSampler::finish`]. The wait between samples
/// is served in slices this size rather than one long sleep: a single
/// `sleep(RSS_SAMPLE_INTERVAL)` made every `finish()` block for up to a full interval,
/// which is dead time inside the very measurement window `bench` is reporting — twice per
/// shoot, on every shoot in the corpus.
const RSS_STOP_SLICE: Duration = Duration::from_millis(5);

impl RssSampler {
    fn start() -> Self {
        let peak_kb = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(
            current_rss_kb().unwrap_or(0),
        ));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (p, s) = (peak_kb.clone(), stop.clone());
        let handle = std::thread::spawn(move || {
            while !s.load(std::sync::atomic::Ordering::Relaxed) {
                if let Some(kb) = current_rss_kb() {
                    p.fetch_max(kb, std::sync::atomic::Ordering::Relaxed);
                }
                let mut waited = Duration::ZERO;
                while waited < RSS_SAMPLE_INTERVAL && !s.load(std::sync::atomic::Ordering::Relaxed)
                {
                    std::thread::sleep(RSS_STOP_SLICE);
                    waited += RSS_STOP_SLICE;
                }
            }
        });
        Self {
            peak_kb,
            stop,
            handle: Some(handle),
        }
    }

    /// Stops sampling and returns the observed peak, in bytes.
    fn finish(mut self) -> Option<u64> {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        let polled = self.peak_kb.load(std::sync::atomic::Ordering::Relaxed);
        let hwm = kernel_peak_rss_kb().unwrap_or(0);
        let best = polled.max(hwm);
        if best == 0 {
            None
        } else {
            Some(best * 1024)
        }
    }
}

/// Current RSS in KiB, or `None` on a platform this module does not support.
#[cfg(target_os = "linux")]
fn current_rss_kb() -> Option<u64> {
    read_proc_status_field("VmRSS:")
}

#[cfg(target_os = "linux")]
fn kernel_peak_rss_kb() -> Option<u64> {
    // The kernel's own high-water mark — immune to the gap between polls that makes pure
    // sampling an underestimate.
    read_proc_status_field("VmHWM:")
}

#[cfg(target_os = "linux")]
fn read_proc_status_field(prefix: &str) -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix(prefix) {
            return rest.split_whitespace().next()?.parse().ok();
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn current_rss_kb() -> Option<u64> {
    // No cheap in-process "peak so far" call reachable without an extra dependency;
    // `ps` reads the same value the OS reports for Activity Monitor, at the cost of one
    // process spawn per sample.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_timer_attributes_time_to_the_right_stage() {
        let timer = StageTimer::new();
        timer.report(Progress {
            stage: Stage::Scanning,
            completed: 0,
            total: 1,
        });
        std::thread::sleep(Duration::from_millis(20));
        timer.report(Progress {
            stage: Stage::Extracting,
            completed: 0,
            total: 1,
        });
        std::thread::sleep(Duration::from_millis(20));
        let stages = timer.finish();

        assert_eq!(stages.len(), 2);
        assert_eq!(stages[0].0, Stage::Scanning);
        assert_eq!(stages[1].0, Stage::Extracting);
        assert!(stages[0].1 >= Duration::from_millis(15));
        assert!(stages[1].1 >= Duration::from_millis(15));
    }

    #[test]
    fn stage_timer_ignores_repeated_reports_of_the_same_stage() {
        let timer = StageTimer::new();
        for _ in 0..5 {
            timer.report(Progress {
                stage: Stage::Extracting,
                completed: 0,
                total: 5,
            });
        }
        let stages = timer.finish();
        assert_eq!(stages.len(), 1, "must not open a new bucket per tick");
    }

    #[test]
    fn stage_timer_with_no_events_returns_nothing() {
        let timer = StageTimer::new();
        assert!(timer.finish().is_empty());
    }

    #[test]
    fn rss_sampler_reports_a_positive_number_on_a_supported_platform() {
        let sampler = RssSampler::start();
        // Touch some memory so there is something to observe either way.
        let _v: Vec<u8> = vec![0u8; 8 * 1024 * 1024];
        std::thread::sleep(Duration::from_millis(150));
        match sampler.finish() {
            Some(bytes) => assert!(bytes > 0),
            None => eprintln!("SKIP: RSS not measurable on this platform"),
        }
    }

    #[test]
    fn stopping_the_rss_sampler_does_not_stall_the_measurement() {
        // P-7 honesty: `finish()` used to wait out a whole 100 ms sample interval, and
        // `run_timed` called it while the stage timer was still open — so that stall was
        // billed to whichever stage happened to be last. Both halves are fixed; this pins
        // the one that is observable. The bound is well under the 100 ms sleep the old
        // form always paid and well over the ~5 ms slice plus one `ps` spawn the new one
        // can cost.
        let sampler = RssSampler::start();
        std::thread::sleep(Duration::from_millis(20));
        let started = Instant::now();
        let _ = sampler.finish();
        assert!(
            started.elapsed() < Duration::from_millis(75),
            "sampler shutdown took {:?}, which lands inside the reported measurement",
            started.elapsed()
        );
    }

    #[test]
    fn format_bytes_switches_units_at_a_gigabyte() {
        assert!(format_bytes(500 * 1024 * 1024).ends_with("MB"));
        assert!(format_bytes(5 * 1024 * 1024 * 1024).ends_with("GB"));
    }
}
