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
}
