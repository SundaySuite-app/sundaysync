//! Typed errors — docs/PLAN.md §7.1, "All fallible paths return typed errors".
//!
//! Note what is *not* here: a variant for "a file failed to decode". A bad input file is
//! a normal, expected outcome that belongs in `SyncResult::unsynced` with a
//! [`crate::result::UnsyncedReason`], not an error that aborts the run (§7.2). `Error`
//! is reserved for conditions that make the *whole run* impossible.

use std::path::PathBuf;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    /// No inputs, or none that could be read at all.
    #[error("no input files were given")]
    NoInput,

    /// The ffmpeg/ffprobe sidecar could not be found or would not run. Fatal because
    /// every stage from §4.1 onward depends on it.
    #[error("ffmpeg sidecar unavailable: {0}")]
    SidecarUnavailable(String),

    #[error("failed to read {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// The user cancelled. Distinct from a failure: §7.4 requires cancel to return
    /// within 2 s leaving only reusable cache files behind, and the UI must be able to
    /// tell "you stopped this" apart from "this broke".
    #[error("cancelled")]
    Cancelled,

    /// An invariant in §7.3 was violated — a file was lost or double-reported. This is
    /// a bug in the engine, surfaced loudly rather than shipped as a wrong timeline.
    #[error("internal invariant violated: {0}")]
    Invariant(String),

    /// A single scan tried to enumerate more files than the scan ceiling allows (S-8,
    /// docs/DECISIONS.md D-032). Not a bug and not a broken file: a mis-drop — a home
    /// directory or a whole disk — that could never be a real multi-camera shoot.
    /// Refused loudly and named, rather than truncated, so §7.3's "every input is
    /// accounted for" is never quietly broken.
    #[error("too many files to scan (limit {limit}); this looks like a mis-selected folder")]
    TooManyFiles { limit: usize },

    /// `clear_cache` was pointed at a directory that is neither the engine's default cache
    /// nor one it stamped with its marker file (S-7, docs/DECISIONS.md D-032). Refused so
    /// a mis-configured cache path (D-013 lets the user pick any folder) can never delete
    /// files SundaySync did not write.
    #[error("refusing to clear {path}: not a SundaySync cache directory")]
    NotACacheDir { path: PathBuf },
}
