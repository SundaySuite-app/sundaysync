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

impl Error {
    /// Whether this is an [`Error::Io`] caused by the file simply not being there.
    ///
    /// Added for the waveform pyramid (docs/DECISIONS.md D-052), which reads analysis-cache
    /// entries the cache is free to evict behind its back — the 90-day sweep, the size cap
    /// and a user's Clear button all delete committed entries. "There is no cache entry for
    /// this clip yet" is a *state*, with a regenerate affordance, not a failure; "reading
    /// the entry blew up" is a failure. Without this the shell can only tell them apart by
    /// grepping a Display string, which is precisely the seam a reworded error slips
    /// through (see [[reference-seam-bugs]]).
    ///
    /// A helper rather than a new variant on purpose: the §5 result contract and every
    /// existing `Error::Io` construction site stay byte-identical, and callers that do not
    /// care about the distinction are unaffected.
    #[must_use]
    pub fn is_not_found(&self) -> bool {
        matches!(
            self,
            Error::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_found_is_distinguishable_from_every_other_io_failure() {
        let missing = Error::Io {
            path: PathBuf::from("/nope"),
            source: std::io::Error::from(std::io::ErrorKind::NotFound),
        };
        assert!(missing.is_not_found());

        // The failures that must NOT read as "not built yet" — offering to regenerate a
        // cache entry that exists but cannot be read would loop forever.
        let denied = Error::Io {
            path: PathBuf::from("/nope"),
            source: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        };
        assert!(!denied.is_not_found());
        assert!(!Error::Cancelled.is_not_found());
        assert!(!Error::NoInput.is_not_found());
    }
}
