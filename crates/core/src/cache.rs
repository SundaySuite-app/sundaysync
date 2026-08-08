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

/// Marker file stamped into a cache directory so [`Cache::clear`] can tell a real cache
/// from a folder the user mis-pointed the setting at (S-7, docs/DECISIONS.md D-032). A
/// dotfile so the scan's `is_hidden` skips it and `clear`'s suffix filter spares it.
const CACHE_MARKER: &str = ".sundaysync-cache";

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

        Ok(Self::from_parts(
            &abs,
            meta.len(),
            mtime_nanos,
            analysis_rate,
        ))
    }

    /// Hashes the four identity fields into a key. Split out from [`CacheKey::for_file`]
    /// so the collision-freedom of the path encoding (F7) can be unit-tested on fabricated
    /// non-UTF-8 paths without a real file on disk.
    fn from_parts(abs: &Path, len: u64, mtime_nanos: u128, analysis_rate: u32) -> Self {
        let mut hasher = blake3::Hasher::new();
        hash_path(&mut hasher, abs);
        hasher.update(&len.to_le_bytes());
        hasher.update(&mtime_nanos.to_le_bytes());
        hasher.update(&analysis_rate.to_le_bytes());
        Self(hasher.finalize().to_hex().to_string())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Feeds a path's *raw* OS bytes into the hasher (F7, docs/DECISIONS.md D-035).
///
/// The earlier code hashed `to_string_lossy()`, which replaces every invalid byte with
/// `U+FFFD`. Two distinct non-UTF-8 paths differing only in their invalid bytes then
/// hashed to the same key and collided — the second file would be served the first's
/// cached audio, a silent-wrongness bug (§7.5). Hashing the lossless OS encoding removes
/// the collision: raw bytes on unix, UTF-16 code units on Windows. Changing the encoding
/// changes cache *filenames*, which only means a one-time cold re-decode — nothing on
/// disk or in the fixtures pins a specific `{hash}.f32` name.
fn hash_path(hasher: &mut blake3::Hasher, path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        hasher.update(path.as_os_str().as_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for unit in path.as_os_str().encode_wide() {
            hasher.update(&unit.to_le_bytes());
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        // No lossless OS-string accessor on this target; the lossy form is the best
        // available and still correct for all-UTF-8 paths, which these targets use.
        hasher.update(path.to_string_lossy().as_bytes());
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

    /// Total bytes of finished entries (`*.f32`). A missing directory is 0, not an error
    /// — an empty cache and an untouched one are the same thing to a settings screen.
    pub fn size_bytes(&self) -> Result<u64> {
        self.fold_entries(0u64, |acc, meta, name| {
            if name.ends_with(".f32") {
                acc + meta.len()
            } else {
                acc
            }
        })
    }

    /// Number of finished entries. Missing directory ⇒ 0.
    pub fn entry_count(&self) -> Result<usize> {
        self.fold_entries(
            0usize,
            |acc, _meta, name| {
                if name.ends_with(".f32") {
                    acc + 1
                } else {
                    acc
                }
            },
        )
    }

    /// Removes every entry *and* any stale `.tmp` scratch file, returning bytes freed.
    ///
    /// Deliberately leaves the directory itself and any foreign file alone — never
    /// delete what we did not write. Cheap insurance against a user pointing the cache
    /// setting at, say, their Documents folder (D-013's settings UI makes that possible).
    pub fn clear(&self) -> Result<u64> {
        // S-7: `dir` is caller-chosen (D-013's settings UI lets the user point it
        // anywhere). Before touching a *non-default* directory, require our own marker —
        // proof this really is a SundaySync cache and not, say, a Documents folder that
        // happens to hold a few `.tmp` files. The default dir is trusted unconditionally
        // (the engine created it), so its path stays frictionless. A directory that does
        // not exist is still a no-op, not a refusal.
        if !self.is_default_dir() && !self.has_marker() {
            if self.dir.exists() {
                return Err(Error::NotACacheDir {
                    path: self.dir.clone(),
                });
            }
            return Ok(0);
        }

        let mut freed = 0u64;
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(source) => {
                return Err(Error::Io {
                    path: self.dir.clone(),
                    source,
                })
            }
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let ours = name.ends_with(".f32") || name.ends_with(".tmp");
            if !ours {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            if std::fs::remove_file(entry.path()).is_ok() {
                freed += meta.len();
            }
        }
        Ok(freed)
    }

    /// Shared walk for the read-only statistics. Non-recursive on purpose: the cache
    /// writes a flat directory, and recursing would count whatever a user's misdirected
    /// cache path happens to contain.
    fn fold_entries<T>(&self, init: T, f: impl Fn(T, &std::fs::Metadata, &str) -> T) -> Result<T> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(init),
            Err(source) => {
                return Err(Error::Io {
                    path: self.dir.clone(),
                    source,
                })
            }
        };
        let mut acc = init;
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            acc = f(acc, &meta, &name);
        }
        Ok(acc)
    }

    pub fn ensure_dir(&self) -> Result<()> {
        std::fs::create_dir_all(&self.dir).map_err(|source| Error::Io {
            path: self.dir.clone(),
            source,
        })?;
        // S-7: stamp the dir as ours so `clear()` can later distinguish a real cache from
        // a mis-pointed folder. Best-effort: a marker we fail to write only ever costs a
        // refusal to auto-clear a *non-default* dir, never data — the default dir is
        // trusted without it.
        let marker = self.dir.join(CACHE_MARKER);
        if !marker.exists() {
            let _ = std::fs::write(&marker, b"SundaySync analysis-audio cache.\n");
        }
        Ok(())
    }

    /// Whether this cache points at the engine's own default location, which is trusted
    /// for [`Cache::clear`] without a marker (the engine created it).
    fn is_default_dir(&self) -> bool {
        let Ok(default) = Self::default_dir() else {
            return false;
        };
        if self.dir == default {
            return true;
        }
        // See through `.` segments and symlinks where both paths resolve.
        match (
            std::fs::canonicalize(&self.dir),
            std::fs::canonicalize(&default),
        ) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }

    /// Whether this directory carries the SundaySync cache marker (S-7).
    fn has_marker(&self) -> bool {
        self.dir.join(CACHE_MARKER).is_file()
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

    #[cfg(unix)]
    #[test]
    fn non_utf8_paths_differing_only_in_invalid_bytes_do_not_collide() {
        // F7: hashing `to_string_lossy()` mapped every invalid byte to U+FFFD, so two
        // distinct non-UTF-8 paths differing only there collided — the second file was
        // served the first's cached audio. Hashing the raw OS bytes keeps them distinct.
        // Tested through `from_parts` so no real (and possibly OS-rejected) non-UTF-8 file
        // has to exist; only the path encoding is under test here.
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let a = PathBuf::from(OsStr::from_bytes(b"/media/clip\xff.wav"));
        let b = PathBuf::from(OsStr::from_bytes(b"/media/clip\xfe.wav"));
        // Same lossy string (both bytes render as U+FFFD) — the old bug's precondition.
        assert_eq!(a.to_string_lossy(), b.to_string_lossy());

        let ka = CacheKey::from_parts(&a, 100, 7, ANALYSIS_RATE);
        let kb = CacheKey::from_parts(&b, 100, 7, ANALYSIS_RATE);
        assert_ne!(ka, kb, "distinct raw paths must hash to distinct keys");

        // And the encoding is still deterministic for one path.
        assert_eq!(ka, CacheKey::from_parts(&a, 100, 7, ANALYSIS_RATE));
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
    fn maintenance_on_a_missing_dir_is_zero_not_an_error() {
        let cache = Cache::new(PathBuf::from("/no/such/cache/dir"));
        assert_eq!(cache.size_bytes().unwrap(), 0);
        assert_eq!(cache.entry_count().unwrap(), 0);
        assert_eq!(cache.clear().unwrap(), 0);
    }

    #[test]
    fn maintenance_counts_clears_and_spares_foreign_files() {
        let dir = scratch("cache-maint");
        let cache = Cache::new(dir.join("cache"));
        cache.ensure_dir().unwrap();
        fs::write(cache.dir().join("a.f32"), [0u8; 100]).unwrap();
        fs::write(cache.dir().join("b.f32"), [0u8; 50]).unwrap();
        fs::write(cache.dir().join("stale.tmp"), [0u8; 30]).unwrap();
        // A file we did not write must never be deleted (D-013's settings UI lets the
        // user point the cache anywhere, including somewhere that matters).
        fs::write(cache.dir().join("readme.txt"), b"keep me").unwrap();

        assert_eq!(
            cache.entry_count().unwrap(),
            2,
            "tmp and foreign don't count"
        );
        assert_eq!(cache.size_bytes().unwrap(), 150, "entries only");

        let freed = cache.clear().unwrap();
        assert_eq!(freed, 180, "entries + stale tmp");
        assert_eq!(cache.entry_count().unwrap(), 0);
        assert!(
            cache.dir().join("readme.txt").exists(),
            "foreign file survived"
        );
        assert!(cache.dir().exists(), "the directory itself is kept");
    }

    #[test]
    fn the_default_dir_is_absolute_and_namespaced() {
        let dir = Cache::default_dir().unwrap();
        assert!(dir.is_absolute(), "{dir:?}");
        assert!(dir.ends_with("SundaySync/analysis"), "{dir:?}");
    }

    #[test]
    fn ensure_dir_stamps_the_marker() {
        // S-7: a cache the engine created must carry its marker.
        let dir = scratch("cache-marker");
        let cache = Cache::new(dir.join("cache"));
        cache.ensure_dir().unwrap();
        assert!(
            cache.dir().join(CACHE_MARKER).is_file(),
            "marker not written"
        );
        // A second ensure_dir must not error on the existing marker.
        cache.ensure_dir().unwrap();
    }

    #[test]
    fn clear_refuses_a_marker_less_non_default_directory() {
        // S-7: pointed at a folder we never stamped, `clear` must refuse and delete
        // nothing — the user may have chosen a directory that matters (D-013).
        let dir = scratch("cache-unmarked");
        // Build the dir by hand, NOT via ensure_dir, so there is no marker.
        let target = dir.join("mine");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep.f32"), [0u8; 40]).unwrap();
        fs::write(target.join("stale.tmp"), [0u8; 10]).unwrap();

        let cache = Cache::new(target.clone());
        let r = cache.clear();
        assert!(
            matches!(r, Err(Error::NotACacheDir { .. })),
            "expected a refusal, got {r:?}"
        );
        assert!(
            target.join("keep.f32").exists() && target.join("stale.tmp").exists(),
            "a refused clear must not delete anything"
        );
    }

    #[test]
    fn clear_succeeds_once_the_directory_is_marked() {
        // S-7: the same directory clears normally after the engine has stamped it.
        let dir = scratch("cache-marked");
        let cache = Cache::new(dir.join("cache"));
        cache.ensure_dir().unwrap(); // writes the marker
        fs::write(cache.dir().join("a.f32"), [0u8; 100]).unwrap();

        let freed = cache.clear().unwrap();
        assert_eq!(freed, 100);
        assert!(!cache.dir().join("a.f32").exists());
        // The marker itself is spared, so the dir stays a recognised cache.
        assert!(cache.dir().join(CACHE_MARKER).is_file());
    }

    #[test]
    fn a_missing_unmarked_dir_is_still_a_no_op_not_a_refusal() {
        // S-7 must not turn the "nothing to clear" case into an error.
        let cache = Cache::new(PathBuf::from("/no/such/unmarked/cache/dir"));
        assert_eq!(cache.clear().unwrap(), 0);
    }

    #[test]
    fn the_default_dir_is_trusted_without_a_marker() {
        // The frictionless path: the engine's own default location is a cache by
        // definition, so `clear` there never demands a marker. Pure check — no fs writes.
        let cache = Cache::new(Cache::default_dir().unwrap());
        assert!(cache.is_default_dir());
    }
}
