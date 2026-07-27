//! `sundaysync` — command-line front end.
//!
//! Deliberately thin: it parses arguments, calls `sundaysync_core::sync()`, and prints
//! the `SyncResult` as JSON. All behaviour lives in the engine so that what CI measures
//! is exactly what the Tauri app will run (docs/PLAN.md §3).
//!
//! **Phase 1.** `sync` and `scan` exist; `bench` arrives in Phase 6.

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;
use sundaysync_core::{
    scan, CancelToken, Error, NoProgress, Progress, ProgressSink, Sidecar, SyncRequest,
    DEFAULT_MIN_PSR,
};

#[derive(Parser, Debug)]
#[command(
    name = "sundaysync",
    version,
    about = "Synchronise multicamera media and export a timeline for DaVinci Resolve",
    long_about = None,
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Synchronise media files and print the resulting sync map as JSON.
    Sync {
        /// Files and/or folders. Folders are scanned recursively.
        #[arg(required = true, value_name = "PATH")]
        inputs: Vec<PathBuf>,

        /// Directory for the analysis-audio cache. Defaults to the OS cache location.
        #[arg(long, value_name = "DIR")]
        cache_dir: Option<PathBuf>,

        /// Force a specific file as the sync reference instead of auto-selecting it.
        #[arg(long, value_name = "FILE")]
        reference: Option<PathBuf>,

        /// Minimum peak-to-sidelobe ratio for a match to be accepted. Lowering this
        /// trades stability for coverage — clips below the threshold are reported as
        /// unsynced rather than placed speculatively.
        #[arg(long, default_value_t = DEFAULT_MIN_PSR, value_name = "RATIO")]
        min_psr: f64,

        /// Write an FCPXML timeline for DaVinci Resolve to this path, in addition to
        /// printing the sync map as JSON.
        #[arg(long, value_name = "FILE")]
        export: Option<PathBuf>,

        /// Project name recorded inside the exported FCPXML.
        #[arg(long, default_value = "SundaySync", value_name = "NAME")]
        project: String,

        /// Report progress to stderr. JSON still goes to stdout, so the output stays
        /// pipeable.
        #[arg(long, short)]
        verbose: bool,
    },

    /// Probe media and print the inventory — devices, files, and anything unusable —
    /// without correlating anything. Fast, and the quickest way to see how SundaySync
    /// interpreted a shoot.
    Scan {
        /// Files and/or folders. Folders are scanned recursively.
        #[arg(required = true, value_name = "PATH")]
        inputs: Vec<PathBuf>,

        /// Report progress to stderr.
        #[arg(long, short)]
        verbose: bool,
    },
}

/// Prints stage progress to stderr, leaving stdout clean for the JSON result.
struct StderrProgress;

impl ProgressSink for StderrProgress {
    fn report(&self, p: Progress) {
        eprintln!("[{:?}] {}/{}", p.stage, p.completed, p.total);
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let cancel = CancelToken::new();

    match cli.command {
        Command::Sync {
            inputs,
            cache_dir,
            reference,
            min_psr,
            export,
            project,
            verbose,
        } => {
            let request = SyncRequest {
                inputs,
                cache_dir,
                reference_override: reference,
                min_psr,
            };
            let outcome =
                sundaysync_core::sync_with_durations(&request, sink(verbose).as_ref(), &cancel);
            match outcome {
                Ok((result, durations)) => {
                    if let Some(path) = export {
                        match sundaysync_core::export_fcpxml(&result, &durations, &project) {
                            Ok(exported) => {
                                if let Err(e) = std::fs::write(&path, exported.xml) {
                                    eprintln!("error: could not write {}: {e}", path.display());
                                    return ExitCode::FAILURE;
                                }
                                eprintln!(
                                    "wrote {} ({} clips)",
                                    path.display(),
                                    exported.clips.len()
                                );
                            }
                            Err(e) => {
                                eprintln!("error: {e}");
                                return ExitCode::FAILURE;
                            }
                        }
                    }
                    emit(Ok(result))
                }
                Err(e) => emit::<sundaysync_core::SyncResult>(Err(e)),
            }
        }

        Command::Scan { inputs, verbose } => {
            // Resolved up front so a missing ffmpeg is one clear message, rather than
            // every file in the shoot failing with `decode_error` and the user
            // concluding their media is broken.
            let sidecar = match Sidecar::from_path() {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("error: {e}");
                    return ExitCode::FAILURE;
                }
            };
            emit(scan(&inputs, &sidecar, sink(verbose).as_ref(), &cancel))
        }
    }
}

fn sink(verbose: bool) -> Box<dyn ProgressSink> {
    if verbose {
        Box::new(StderrProgress)
    } else {
        Box::new(NoProgress)
    }
}

/// Prints a successful outcome as JSON on stdout, or a diagnostic on stderr.
fn emit<T: serde::Serialize>(outcome: sundaysync_core::Result<T>) -> ExitCode {
    match outcome {
        Ok(value) => match serde_json::to_string_pretty(&value) {
            Ok(json) => {
                println!("{json}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("error: could not serialise result: {e}");
                ExitCode::FAILURE
            }
        },
        // Cancellation is a user action, not a failure — but it still must not report
        // success, or a script could mistake a half-run for a complete one (§7.4).
        Err(Error::Cancelled) => {
            eprintln!("cancelled");
            ExitCode::from(130)
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn cli_definition_is_valid() {
        // clap's own consistency check: catches duplicate flags, bad defaults and
        // malformed help before they reach a user.
        Cli::command().debug_assert();
    }

    #[test]
    fn sync_requires_at_least_one_input() {
        assert!(Cli::try_parse_from(["sundaysync", "sync"]).is_err());
        assert!(Cli::try_parse_from(["sundaysync", "sync", "a.wav"]).is_ok());
    }

    #[test]
    fn min_psr_defaults_to_the_engine_constant() {
        // The CLI must not carry its own copy of the threshold — if these ever diverge,
        // a `--help` reader would be told a different default than the engine uses.
        let cli = Cli::try_parse_from(["sundaysync", "sync", "a.wav"]).unwrap();
        let Command::Sync { min_psr, .. } = cli.command else {
            panic!("expected the sync subcommand");
        };
        assert_eq!(min_psr, DEFAULT_MIN_PSR);
    }
}
