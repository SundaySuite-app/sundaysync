//! Analysis-audio cache — docs/PLAN.md §4.2.
//!
//! The cache is what makes re-syncing a shoot near-instant: decoding is by far the most
//! expensive stage (§10 calls a cold run "decode-bound"), and nothing about a file's
//! analysis audio changes between runs. Syncaila sells this as "accelerated re-sync";
//! we get it by keying on content identity and never decoding twice.
//!
//! Footprint is ~47 KB per second of audio (measured, not estimated — docs/DECISIONS.md
//! D-004), i.e. 1–2 % of the source media. An eight-hour shoot caches to well under a
//! gigabyte, which is why the UI can honestly describe this as a non-issue.

use crate::error::{Error, Result};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Identity of one cached extraction.
///
/// Hex-encoded BLAKE3 over the four things §4.2 names: absolute path, size, mtime, and
/// the analysis rate. Size and mtime together are the cheap stand-in for content
/// identity — hashing the media itself would cost as much as the decode we are trying
/// to avoid. Including the rate means changing `ANALYSIS_RATE` invalidates every entry
/// automatically instead of silently serving audio at the wrong sample rate.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey(String);

impl CacheKey {
    /// Derives the key by reading the file's metadata.
    ///
    /// Reading mtime is not a wall-clock read: it is a property of the input, so the
    /// engine stays a deterministic function of its inputs (§3).
    pub fn for_file(path: &Path, analysis_rate: u32) -> Result<Self> {
        let meta = std::fs::metadata(path).map_err(|source| Error::Io {
            path: path.to_path_buf(),
            source,
        })?;

        // Canonicalise so `./C0001.MP4` and `/abs/C0001.MP4` share one entry. Falls back
        // to the path as given if canonicalisation fails — a worse key is still a
        // correct one, since it only ever means a redundant decode.
        let abs = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());

        let mtime_nanos = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());

        let mut hasher = blake3::Hasher::new();
        hasher.update(abs.to_string_lossy().as_bytes());
        hasher.update(&meta.len().to_le_bytes());
        hasher.update(&mtime_nanos.to_le_bytes());
        hasher.update(&analysis_rate.to_le_bytes());
        Ok(Self(hasher.finalize().to_hex().to_string()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The on-disk analysis-audio cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cache {
    dir: PathBuf,
}

impl Cache {
    #[must_use]
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// The OS cache location, plus our own subdirectory.
    ///
    /// §4.2 makes this overridable because temp-space complaints were among PluralEyes'
    /// top support issues. Resolved by hand rather than with the `dirs` crate: it is
    /// three platform branches, and a desktop app is better off with one fewer
    /// dependency tree than with a crate earning its keep on fifteen lines.
    pub fn default_dir() -> Result<PathBuf> {
        let base = if cfg!(windows) {
            std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
        } else if cfg!(target_os = "macos") {
            std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches"))
        } else {
            std::env::var_os("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        };
        base.map(|b| b.join("SundaySync").join("analysis"))
            .ok_or_else(|| {
                Error::SidecarUnavailable(
                    "could not determine a cache directory — set one explicitly".into(),
                )
            })
    }

    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where a finished entry lives.
    #[must_use]
    pub fn entry_path(&self, key: &CacheKey) -> PathBuf {
        self.dir.join(format!("{}.f32", key.as_str()))
    }

    /// A scratch path in the same directory, for the write-then-rename in
    /// [`crate::extract`].
    ///
    /// Same directory as the final entry because `rename` is only guaranteed atomic
    /// within one filesystem. The pid and counter keep two concurrent SundaySync
    /// processes — or two workers racing on the same file — from clobbering each other's
    /// scratch file.
    #[must_use]
    pub fn temp_path(&self, key: &CacheKey, nonce: u64) -> PathBuf {
        self.dir.join(format!(
            "{}.{}-{}.tmp",
            key.as_str(),
            std::process::id(),
            nonce
        ))
    }

    #[must_use]
    pub fn contains(&self, key: &CacheKey) -> bool {
        // A zero-length entry is treated as absent. It cannot be produced by our own
        // write-then-rename, but an out-of-space or force-killed *previous* version
        // could have left one, and serving it as "silent audio" would corrupt a sync
        // rather than fail it.
        std::fs::metadata(self.entry_path(key)).is_ok_and(|m| m.len() > 0)
    }

    pub fn ensure_dir(&self) -> Result<()> {
        std::fs::create_dir_all(&self.dir).map_err(|source| Error::Io {
            path: self.dir.clone(),
            source,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request::ANALYSIS_RATE;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("sundaysync-tests").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_same_file_yields_the_same_key() {
        let dir = scratch("cache-stable");
        let f = dir.join("a.wav");
        fs::write(&f, b"hello").unwrap();
        let a = CacheKey::for_file(&f, ANALYSIS_RATE).unwrap();
        let b = CacheKey::for_file(&f, ANALYSIS_RATE).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn a_relative_and_absolute_path_share_one_entry() {
        // Otherwise the same media dropped two ways would decode twice.
        let dir = scratch("cache-canon");
        let f = dir.join("a.wav");
        fs::write(&f, b"hello").unwrap();
        let via_abs = CacheKey::for_file(&f, ANALYSIS_RATE).unwrap();
        let via_dots = CacheKey::for_file(&dir.join(".").join("a.wav"), ANALYSIS_RATE).unwrap();
        assert_eq!(via_abs, via_dots);
    }

    #[test]
    fn changing_the_content_changes_the_key() {
        let dir = scratch("cache-content");
        let f = dir.join("a.wav");
        fs::write(&f, b"hello").unwrap();
        let before = CacheKey::for_file(&f, ANALYSIS_RATE).unwrap();
        fs::write(&f, b"hello world, a different length").unwrap();
        let after = CacheKey::for_file(&f, ANALYSIS_RATE).unwrap();
        assert_ne!(before, after, "size change must invalidate the entry");
    }

    #[test]
    fn changing_the_analysis_rate_invalidates_everything() {
        // The guard against silently serving audio at the wrong rate if ANALYSIS_RATE
        // is ever retuned.
        let dir = scratch("cache-rate");
        let f = dir.join("a.wav");
        fs::write(&f, b"hello").unwrap();
        let at_12k = CacheKey::for_file(&f, 12_000).unwrap();
        let at_16k = CacheKey::for_file(&f, 16_000).unwrap();
        assert_ne!(at_12k, at_16k);
    }

    #[test]
    fn a_missing_file_is_an_error_not_a_panic() {
        let r = CacheKey::for_file(Path::new("/no/such/file"), ANALYSIS_RATE);
        assert!(matches!(r, Err(Error::Io { .. })));
    }

    #[test]
    fn a_zero_length_entry_counts_as_absent() {
        // A truncated entry left by a force-killed older build must not be served as
        // silent audio — that would corrupt a sync rather than fail it.
        let dir = scratch("cache-empty");
        let f = dir.join("a.wav");
        fs::write(&f, b"hello").unwrap();
        let cache = Cache::new(dir.join("cache"));
        cache.ensure_dir().unwrap();
        let key = CacheKey::for_file(&f, ANALYSIS_RATE).unwrap();
        assert!(!cache.contains(&key));
        fs::write(cache.entry_path(&key), b"").unwrap();
        assert!(!cache.contains(&key), "empty entry must not count as a hit");
        fs::write(cache.entry_path(&key), [0u8; 4]).unwrap();
        assert!(cache.contains(&key));
    }

    #[test]
    fn temp_paths_are_unique_and_sit_beside_the_entry() {
        // `rename` is only atomic within one filesystem, so the scratch file must share
        // the entry's directory.
        let cache = Cache::new(PathBuf::from("/tmp/x"));
        let key = CacheKey("deadbeef".into());
        let a = cache.temp_path(&key, 1);
        let b = cache.temp_path(&key, 2);
        assert_ne!(a, b);
        assert_eq!(a.parent(), cache.entry_path(&key).parent());
    }

    #[test]
    fn the_default_dir_is_absolute_and_namespaced() {
        let dir = Cache::default_dir().unwrap();
        assert!(dir.is_absolute(), "{dir:?}");
        assert!(dir.ends_with("SundaySync/analysis"), "{dir:?}");
    }
}
