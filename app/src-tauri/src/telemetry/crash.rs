//! The Rust panic hook and the scrubbed crash ring (E7).
//!
//! ## The gap this closes
//!
//! A panic inside a `#[tauri::command]` unwinds into Tauri's IPC handler and the
//! invoke rejects; a panic in a spawned task vanishes with the dropped
//! `JoinHandle`. A macOS `.app` launched from Finder discards stderr, so even the
//! default hook's line goes nowhere. This hook writes a JSON record into a bounded
//! ring under `<app-data>/telemetry/crashes/`, and (under consent) the telemetry
//! drain projects those records onto the wire.
//!
//! ## Constraints the hook must respect
//!
//! It runs on an ARBITRARY thread, possibly while unwinding. So: no `AppHandle`
//! (the directory is resolved lock-free via [`super::telemetry_dir`], which caches
//! a `dirs`-derived path in a `OnceLock`); no lock this process holds elsewhere
//! (the ring's ordering comes from the filename, not shared state); and — the one
//! that is not negotiable — **it must not panic**.
//!
//! ⚠️ The `catch_unwind` in [`install_hook`] does NOT make that negotiable, and an
//! earlier version of this comment implied it did. The hook is called with the
//! runtime's panic count already at one, so a panic raised *inside* it takes the
//! count to two and std aborts the process on the spot ("panicked while processing
//! panic") — before any unwinding starts, which is what `catch_unwind` would need
//! to catch. It is kept as a cheap outer guard, but the actual guarantee is that
//! nothing in the body can panic: no `unwrap`, no `expect`, no indexing, no
//! arithmetic that can overflow. Every fallible step here is `let _ =` or
//! `unwrap_or_else` on purpose, and a new one must be too.
//!
//! ## Privacy
//!
//! Every record is scrubbed with [`super::scrub_free_text`] at WRITE time — home
//! directory stripped, absolute paths replaced with `<path>`, message capped — so
//! the file on disk is already wire-safe. Backtraces are NOT persisted: a
//! backtrace names every source file the stack walked through, which on a machine
//! built from source is `/Users/<name>/…` on every line; the record carries
//! `backtrace_present: bool` instead, which is enough to group crashes alongside
//! the message and location.

use std::panic::{AssertUnwindSafe, PanicHookInfo};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};

use super::{
    home_dir, now_ms, scrub_free_text, Os, LOCATION_MAX_CHARS, MAX_CRASHES, MESSAGE_MAX_CHARS,
    VERSION_MAX_CHARS,
};

/// The schema of a [`CrashReport`]. Bumped when a field changes meaning.
pub const RECORD_SCHEMA: u32 = 1;

/// Filename prefix for a crash record.
const CRASH_PREFIX: &str = "crash-";

/// Disambiguates two records written inside the same millisecond.
static SEQ: AtomicU32 = AtomicU32::new(0);

/// One crash-adjacent event, already wire-safe. This is BOTH the on-disk record
/// and the projection sent to the Worker — there is no separate local-only detail
/// to strip on the way out, because nothing sensitive was ever written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    /// [`RECORD_SCHEMA`] at write time.
    pub schema: u32,
    /// `"panic"` (the process hook), `"frontend"` (a renderer error), or
    /// `"sync_error"` (an engine run that returned an error). A closed vocabulary
    /// in practice, though stored as a string.
    pub kind: String,
    /// Unix ms (UTC) the record was written.
    pub at: i64,
    /// The app version that crashed.
    pub app_version: String,
    /// The OS that crashed.
    pub os: Os,
    /// The message: scrubbed, path-free, capped at [`MESSAGE_MAX_CHARS`].
    pub message: String,
    /// `file:line:col` for a panic — scrubbed, capped. `None` otherwise.
    pub location: Option<String>,
    /// Whether a backtrace existed on the user's machine. The backtrace itself is
    /// never sent — see the module docs.
    pub backtrace_present: bool,
}

/// The crash directory (`<telemetry>/crashes`), if one can be resolved.
fn crash_dir() -> Option<PathBuf> {
    super::telemetry_dir().map(|d| d.join("crashes"))
}

/// Install the panic hook. The previous (default) hook is kept and called after,
/// so a dev terminal's stderr line is unchanged — this ADDS a file.
pub fn install_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Best-effort, and see the module docs: this guard cannot catch a panic
        // raised inside `persist_panic` — std aborts first. The body is written
        // not to panic.
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| persist_panic(info)));
        previous(info);
    }));
}

/// Format and persist a panic. Best-effort throughout.
fn persist_panic(info: &PanicHookInfo<'_>) {
    let payload = info.payload();
    let raw_msg = payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<non-string panic payload>".to_string());
    let raw_loc = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
    // A backtrace is captured only to record its PRESENCE — it is never persisted.
    let has_backtrace = !matches!(
        std::backtrace::Backtrace::force_capture().status(),
        std::backtrace::BacktraceStatus::Disabled
    );

    let home = home_dir();
    let record = CrashReport {
        schema: RECORD_SCHEMA,
        kind: "panic".to_string(),
        at: now_ms(),
        app_version: scrub_free_text(
            env!("CARGO_PKG_VERSION"),
            home.as_deref(),
            VERSION_MAX_CHARS,
        ),
        os: Os::current(),
        message: scrub_free_text(&raw_msg, home.as_deref(), MESSAGE_MAX_CHARS),
        location: raw_loc.map(|l| scrub_free_text(&l, home.as_deref(), LOCATION_MAX_CHARS)),
        backtrace_present: has_backtrace,
    };

    if let Some(dir) = crash_dir() {
        let _ = write_record(&dir, &record);
    }
}

/// Record a non-panic crash-adjacent event (a frontend error, a failed sync) into
/// the same ring. `message` and `location` are scrubbed here.
pub fn record(telemetry_dir: &Path, kind: &str, message: &str, location: Option<&str>) {
    let home = home_dir();
    let record = CrashReport {
        schema: RECORD_SCHEMA,
        kind: kind.to_string(),
        at: now_ms(),
        app_version: scrub_free_text(
            env!("CARGO_PKG_VERSION"),
            home.as_deref(),
            VERSION_MAX_CHARS,
        ),
        os: Os::current(),
        message: scrub_free_text(message, home.as_deref(), MESSAGE_MAX_CHARS),
        location: location.map(|l| scrub_free_text(l, home.as_deref(), LOCATION_MAX_CHARS)),
        backtrace_present: false,
    };
    let _ = write_record(&telemetry_dir.join("crashes"), &record);
}

/// Write one record atomically and prune the ring back to [`MAX_CRASHES`].
///
/// Through the shared [`super::write_atomic`] rather than a second copy of
/// tmp-write-rename: [`SEQ`] restarts at zero in every process, so a private copy
/// staging through `{name}.tmp` let two app instances collide on one staging path
/// the same way `state.json.tmp` did. One writer is enough to own the file name;
/// the shared helper is what makes the staging name a writer's own.
fn write_record(dir: &Path, record: &CrashReport) -> std::io::Result<()> {
    let name = record_filename(unix_millis(), SEQ.fetch_add(1, Ordering::Relaxed));
    let body = serde_json::to_vec_pretty(record)
        .unwrap_or_else(|_| b"{\"schema\":1,\"kind\":\"panic\"}".to_vec());
    super::write_atomic(dir, &name, &body)?;
    prune_ring(dir);
    Ok(())
}

/// The filename for a record. Zero-padded so a lexicographic sort IS chronological
/// order — that is what lets [`prune_ring`] pick victims without stat-ing anything.
fn record_filename(millis: u128, seq: u32) -> String {
    format!("{CRASH_PREFIX}{millis:015}-{seq:04}.json")
}

/// Delete the oldest records until at most [`MAX_CRASHES`] remain. Best-effort.
fn prune_ring(dir: &Path) {
    let mut names = record_names(dir);
    names.sort();
    if names.len() > MAX_CRASHES {
        for victim in &names[..names.len() - MAX_CRASHES] {
            let _ = std::fs::remove_file(dir.join(victim));
        }
    }
}

/// The record filenames in `dir`.
fn record_names(dir: &Path) -> Vec<String> {
    match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(CRASH_PREFIX) && n.ends_with(".json"))
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Read every crash record back, newest LAST. `telemetry_dir` is the telemetry
/// directory (the ring lives in its `crashes` subdir).
pub fn read_crashes(telemetry_dir: &Path) -> Vec<CrashReport> {
    let dir = telemetry_dir.join("crashes");
    let mut names = record_names(&dir);
    names.sort();
    names
        .iter()
        .filter_map(|n| std::fs::read_to_string(dir.join(n)).ok())
        .filter_map(|s| serde_json::from_str::<CrashReport>(&s).ok())
        .collect()
}

/// Wall-clock milliseconds — takes no lock this process holds anywhere else,
/// which is what makes it safe inside the hook.
fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_filenames_sort_chronologically() {
        // Zero-padding is the whole point: without it "999" sorts after "1000".
        let mut names = vec![
            record_filename(1_000, 0),
            record_filename(999, 0),
            record_filename(1_000, 1),
        ];
        names.sort();
        assert_eq!(
            names,
            vec![
                record_filename(999, 0),
                record_filename(1_000, 0),
                record_filename(1_000, 1),
            ]
        );
    }

    #[test]
    fn the_ring_caps_and_keeps_the_newest() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        for i in 0..(MAX_CRASHES + 7) {
            record(dir, "sync_error", &format!("failure {i}"), None);
        }
        let kept = read_crashes(dir);
        assert_eq!(kept.len(), MAX_CRASHES);
        // Newest last.
        assert_eq!(
            kept.last().unwrap().message,
            format!("failure {}", MAX_CRASHES + 6)
        );
        // No temp files survive an atomic write.
        let leftovers = std::fs::read_dir(dir.join("crashes"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn recorded_messages_are_scrubbed_at_write_time() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        record(
            dir,
            "sync_error",
            "could not open /Users/ola/Opptak/x.wav",
            None,
        );
        let recs = read_crashes(dir);
        assert_eq!(recs.len(), 1);
        assert!(!recs[0].message.contains("ola"), "{:?}", recs[0].message);
        assert!(!recs[0].message.contains("Opptak"), "{:?}", recs[0].message);
        assert!(recs[0].message.contains("<path>"));
        assert_eq!(recs[0].kind, "sync_error");
    }

    #[test]
    fn an_absent_directory_reads_as_no_records() {
        assert!(read_crashes(Path::new("/definitely/not/a/dir")).is_empty());
    }
}
