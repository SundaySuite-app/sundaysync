//! `fixturegen` — generates a synthetic test shoot into a directory.
//!
//! Usage:
//!   fixturegen <quick|full> <out-dir> [seed]
//!
//! Deterministic: the same tier and seed always produce byte-identical media and an
//! identical `truth.json` (§8.1).

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use sundaysync_fixturegen::shoot::{self, Codec};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (tier, out) = match args.as_slice() {
        [tier, out, ..] => (tier.as_str(), PathBuf::from(out)),
        _ => {
            eprintln!("usage: fixturegen <quick|full> <out-dir> [seed]");
            return ExitCode::FAILURE;
        }
    };
    // A fixed default so `fixturegen quick out/` is reproducible without ceremony.
    let seed: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0x5EED);

    let spec = match tier {
        "quick" => shoot::quick_suite(seed),
        "full" => shoot::full_suite(seed),
        other => {
            eprintln!("unknown tier `{other}` (expected quick or full)");
            return ExitCode::FAILURE;
        }
    };

    let dir = shoot::suite_dir(&out, &spec.name, seed);
    let ffmpeg = Path::new("ffmpeg");
    let mut truth = match shoot::emit(&spec, &dir, ffmpeg) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    // §8.1: at least one file with no relationship to the event at all.
    if let Err(e) = shoot::emit_uncorrelated(
        &mut truth,
        &dir,
        "unrelated",
        25.0,
        seed,
        Codec::Wav,
        ffmpeg,
    ) {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }

    println!("{} clips -> {}", truth.clips.len(), dir.display());
    ExitCode::SUCCESS
}
