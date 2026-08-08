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
    let seed = match parse_seed(args.get(2)) {
        Ok(seed) => seed,
        Err(bad) => {
            eprintln!("error: `{bad}` is not a seed (expected a whole number, 0..2^64)");
            return ExitCode::FAILURE;
        }
    };

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

/// The default seed, so `fixturegen quick out/` is reproducible without ceremony.
const DEFAULT_SEED: u64 = 0x5EED;

/// Reads the optional seed argument, returning the offending text if it is not a seed.
///
/// The earlier form was `args.get(2).and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_SEED)`,
/// which silently swallowed a typo: `fixturegen quick out/ 1e6` generated the
/// *default*-seeded suite, into a directory named after the default seed, with no hint
/// that the seed asked for had been discarded. §8.1's whole premise is that a fixture is
/// reproducible from its seed, so a seed the user typed and did not get is exactly the
/// kind of quiet wrongness this suite exists to rule out. An unusable seed is now a loud
/// refusal; an absent one still means the default.
fn parse_seed(arg: Option<&String>) -> Result<u64, &str> {
    match arg {
        None => Ok(DEFAULT_SEED),
        Some(text) => text.parse().map_err(|_| text.as_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_seed_is_the_default_and_a_bad_one_is_refused() {
        assert_eq!(parse_seed(None), Ok(DEFAULT_SEED));
        assert_eq!(parse_seed(Some(&"42".to_string())), Ok(42));
        assert_eq!(
            parse_seed(Some(&u64::MAX.to_string())),
            Ok(u64::MAX),
            "the whole seed space must be reachable"
        );
        for bad in ["1e6", "0x5EED", "-1", "", "12.5", "18446744073709551616"] {
            assert_eq!(
                parse_seed(Some(&bad.to_string())),
                Err(bad),
                "`{bad}` must be refused, not silently replaced by the default"
            );
        }
    }
}
