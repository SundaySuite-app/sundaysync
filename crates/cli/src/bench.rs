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
//! straight into a corpus. For real footage the offsets are established once — run the
//! engine, verify or correct in Resolve, then freeze — exactly as §8.3 describes.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;
use sundaysync_core::{CancelToken, NoProgress, SyncRequest, SyncResult};

/// §8.2: ≥95 % of syncable clips within ±10 ms.
const TOLERANCE_MS: f64 = 10.0;
const REQUIRED_WITHIN_TOLERANCE: f64 = 0.95;

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

struct ShootReport {
    name: String,
    clips: usize,
    within_tolerance: usize,
    worst_error_ms: f64,
    false_placements: Vec<String>,
    missed: Vec<String>,
    wrongly_placed: Vec<String>,
    elapsed_seconds: f64,
}

impl ShootReport {
    fn passed(&self) -> bool {
        self.false_placements.is_empty()
            && self.wrongly_placed.is_empty()
            && self.missed.is_empty()
            && (self.clips == 0
                || self.within_tolerance as f64 / self.clips as f64 >= REQUIRED_WITHIN_TOLERANCE)
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
    let time: f64 = reports.iter().map(|r| r.elapsed_seconds).sum();
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
    println!("total time        : {time:.1} s");

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

    let request = SyncRequest {
        cache_dir: cache_dir.map(Path::to_path_buf),
        min_psr,
        ..SyncRequest::new(vec![shoot.to_path_buf()])
    };

    let started = Instant::now();
    let result = sundaysync_core::sync(&request, &NoProgress, cancel).map_err(|e| e.to_string())?;
    let elapsed_seconds = started.elapsed().as_secs_f64();

    Ok(compare(shoot, &truth, &result, elapsed_seconds))
}

fn compare(shoot: &Path, truth: &Truth, result: &SyncResult, elapsed_seconds: f64) -> ShootReport {
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
        elapsed_seconds,
    }
}

fn print_shoot(r: &ShootReport) {
    let verdict = if r.passed() { "PASS" } else { "FAIL" };
    println!(
        "  {verdict}  {:<32} {}/{} within ±{TOLERANCE_MS} ms, worst {:.2} ms, {:.1} s",
        r.name, r.within_tolerance, r.clips, r.worst_error_ms, r.elapsed_seconds
    );
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
