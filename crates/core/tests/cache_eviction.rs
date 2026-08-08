//! P-4 / D-013 cache eviction, exercised through the public `Cache` API the conductor
//! wires the shell against (app-start sweep + the off-by-default Settings size cap).
//!
//! These use no ffmpeg — they write `.f32` files by hand and backdate their mtimes, which
//! is all eviction reads (mtime, never atime — see `Cache::sweep_older_than`).

// Integration tests are their own crate, so clippy.toml's allow-unwrap-in-tests does not
// reach here; the engine's §7.1 ban is for production paths, not this harness.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sundaysync_core::{Cache, Evicted};

/// The cache marker `ensure_dir` stamps (a private const in the engine; mirrored here so
/// the test can assert it is never evicted).
const CACHE_MARKER: &str = ".sundaysync-cache";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join("sundaysync-tests")
        .join("evict-it")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Writes a finished cache entry of `len` bytes with an mtime `secs_ago` in the past.
fn entry(cache: &Cache, name: &str, len: usize, secs_ago: u64) {
    let path = cache.dir().join(name);
    fs::write(&path, vec![0u8; len]).unwrap();
    let when = SystemTime::now() - Duration::from_secs(secs_ago);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

fn exists(dir: &Path, name: &str) -> bool {
    dir.join(name).exists()
}

#[test]
fn app_start_90_day_sweep_removes_only_the_stale_entries() {
    // The conductor's default: a 90-day age sweep on app start. Regenerable cache, so this
    // is non-destructive — a swept file simply cold-decodes if that shoot is re-synced.
    let cache = Cache::new(scratch("sweep-default"));
    cache.ensure_dir().unwrap();

    entry(&cache, "ancient.f32", 200, 200 * 86_400);
    entry(&cache, "old.f32", 50, 91 * 86_400);
    entry(&cache, "recent.f32", 10, 3 * 86_400);
    // An in-flight extraction's scratch file, old by mtime — must never be touched.
    entry(&cache, "inflight.tmp", 999, 500 * 86_400);

    let evicted = cache
        .sweep_older_than(Duration::from_secs(90 * 86_400))
        .unwrap();

    assert_eq!(evicted.entries, 2);
    assert_eq!(evicted.bytes, 250);
    assert!(!exists(cache.dir(), "ancient.f32"));
    assert!(!exists(cache.dir(), "old.f32"));
    assert!(exists(cache.dir(), "recent.f32"), "young entry kept");
    assert!(
        exists(cache.dir(), "inflight.tmp"),
        "a live .tmp scratch file is never swept"
    );
    assert!(
        exists(cache.dir(), CACHE_MARKER),
        "the marker is never evicted"
    );
}

#[test]
fn a_sweep_that_removes_nothing_is_not_an_error() {
    let cache = Cache::new(scratch("sweep-noop"));
    cache.ensure_dir().unwrap();
    entry(&cache, "fresh.f32", 100, 60);
    let evicted = cache
        .sweep_older_than(Duration::from_secs(90 * 86_400))
        .unwrap();
    assert_eq!(evicted, Evicted::default());
    assert!(evicted.is_empty());
    assert!(exists(cache.dir(), "fresh.f32"));
}

#[test]
fn the_size_cap_evicts_oldest_first_until_within_budget() {
    // The Settings size cap (off by default; the conductor passes the chosen byte budget).
    let cache = Cache::new(scratch("cap"));
    cache.ensure_dir().unwrap();
    entry(&cache, "oldest.f32", 100, 4000);
    entry(&cache, "mid.f32", 100, 3000);
    entry(&cache, "newest.f32", 100, 1000);

    // 300 total, cap 150 → drop the two oldest to reach 100.
    let evicted = cache.enforce_size_cap(150).unwrap();
    assert_eq!(evicted.entries, 2);
    assert_eq!(evicted.bytes, 200);
    assert!(!exists(cache.dir(), "oldest.f32"));
    assert!(!exists(cache.dir(), "mid.f32"));
    assert!(exists(cache.dir(), "newest.f32"));
    assert!(cache.size_bytes().unwrap() <= 150);
}

#[test]
fn eviction_refuses_a_directory_it_never_stamped() {
    // D-013 lets the user point the cache anywhere. A directory without the marker (and not
    // the engine default) must be refused, deleting nothing — it could be their Documents.
    let dir = scratch("unmarked");
    let target = dir.join("mine");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("keep.f32"), vec![0u8; 40]).unwrap();

    let cache = Cache::new(target.clone());
    assert!(cache.sweep_older_than(Duration::from_secs(1)).is_err());
    assert!(cache.enforce_size_cap(0).is_err());
    assert!(target.join("keep.f32").exists(), "nothing was deleted");
}
