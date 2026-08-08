//! Scan and inventory — docs/PLAN.md §4.1 + §4.5.
//!
//! Walks the inputs, probes everything, sorts each file into "syncable" or "unsynced
//! with a reason", and groups the syncable ones into devices. This is the whole of
//! Phase 1, and the manifest it produces is what the `scan` CLI command prints.

use crate::device;
use crate::error::{Error, Result};
use crate::extract;
use crate::probe::{self, AudioStream, Probed, VideoStream};
use crate::progress::{CancelToken, Progress, ProgressSink, Stage};
use crate::result::{Device, DeviceKind, Unsynced, UnsyncedReason, SCHEMA_VERSION};
use crate::sidecar::Sidecar;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// How often the scan walk emits a progress tick, in files enumerated.
///
/// P-5: the walk used to emit nothing, so a 10 000-file folder sat at "0/1" the whole
/// time. It now reports a live running count. Throttled to one event per this many files
/// so a pathological (up to [`MAX_FILES`]) directory does not push 100 000 events through
/// the sink — the count is indicative, not a per-file audit (the probe stage counts every
/// file exactly once).
const SCAN_PROGRESS_STRIDE: usize = 128;

/// Guards against a pathological directory tree. Card dumps nest a few levels
/// (`PRIVATE/M4ROOT/CLIP`); nothing legitimate goes deeper than this.
const MAX_DEPTH: usize = 32;

/// Total files a single scan will enumerate before it refuses to continue (S-8,
/// docs/DECISIONS.md D-032).
///
/// A real multi-camera church service is dozens of clips; a walk that reaches six figures
/// is a mis-drop — a home directory, a whole disk — not a shoot. Enumerating millions of
/// entries would exhaust memory and blow §7.4's responsiveness budget for a run that could
/// never produce a sensible timeline, so the honest outcome is a loud [`Error::TooManyFiles`]
/// naming the limit rather than a silent truncation that would violate §7.3's "every input
/// is accounted for". 100 000 is deliberately generous — orders of magnitude past any real
/// shoot — so it can only ever fire on an obvious mistake.
const MAX_FILES: usize = 100_000;

/// The output of a scan: what we found, and what we could not use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScanManifest {
    pub schema: u32,
    pub devices: Vec<Device>,
    /// Files that probed cleanly and carry audio — everything that can be synced.
    pub files: Vec<FileEntry>,
    /// Files that cannot be synced, each with a §5 reason. Reuses the `SyncResult` type
    /// so the reasons the UI must render are identical in both outputs.
    pub unsynced: Vec<Unsynced>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileEntry {
    pub file: PathBuf,
    pub device: String,
    pub duration_seconds: f64,
    pub format_name: String,
    pub audio: Option<AudioStream>,
    pub video: Option<VideoStream>,
    pub creation_time: Option<String>,
}

/// Probes every input and builds the inventory.
///
/// Returns [`Error::NoInput`] only when nothing at all was given. A run where every
/// single file is unreadable still succeeds, with all of them in `unsynced` — that is a
/// result the user needs to see, not an error (§7.5).
pub fn scan(
    inputs: &[PathBuf],
    sidecar: &Sidecar,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
) -> Result<ScanManifest> {
    scan_detailed(inputs, sidecar, None, progress, cancel).map(|(m, _)| m)
}

/// As [`scan`], but also returns the raw [`Probed`] records.
///
/// The full pipeline needs them for §4.4's reference selection and metadata check, and
/// probing twice would double the ffprobe cost of every run for no benefit.
/// `exclude` is a directory the walk must not descend into — in practice the analysis
/// cache. Without it, pointing the cache inside a folder the user drops in makes the
/// second run scan its own `.f32` entries, fail to probe them, and report the user's
/// cache back to them as broken media. Found by the §13.4 determinism test, which is
/// exactly the sort of bug it exists to catch. See docs/DECISIONS.md D-020.
pub fn scan_detailed(
    inputs: &[PathBuf],
    sidecar: &Sidecar,
    exclude: Option<&Path>,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
) -> Result<(ScanManifest, Vec<Probed>)> {
    scan_detailed_workers(
        inputs,
        sidecar,
        exclude,
        extract::worker_count(),
        progress,
        cancel,
    )
}

/// The real scan, with the probe-pool size as a parameter.
///
/// Production always passes [`extract::worker_count()`]; the `workers` seam exists so the
/// determinism test can prove a serial probe (`workers == 1`) and a parallel one produce a
/// byte-identical manifest (P-2, docs/DECISIONS.md D-041).
fn scan_detailed_workers(
    inputs: &[PathBuf],
    sidecar: &Sidecar,
    exclude: Option<&Path>,
    workers: usize,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
) -> Result<(ScanManifest, Vec<Probed>)> {
    if inputs.is_empty() {
        return Err(Error::NoInput);
    }

    progress.report(Progress {
        stage: Stage::Scanning,
        completed: 0,
        total: inputs.len(),
    });

    let (candidates, missing) = collect(inputs, exclude, progress, cancel)?;

    let mut probed: Vec<Probed> = Vec::new();
    let mut unsynced: Vec<Unsynced> = missing;

    // P-2: probe in parallel on the extract worker pool, then fold the results back in
    // candidate order. `probe_candidates` returns one outcome per candidate, indexed to
    // the (already sorted) candidate list, so the fold below — and therefore both `probed`
    // and `unsynced` — is identical to the old serial loop regardless of thread
    // scheduling. See docs/DECISIONS.md D-041.
    let outcomes = probe_candidates(sidecar, &candidates, workers, progress, cancel)?;
    for (path, outcome) in candidates.iter().zip(outcomes) {
        match outcome {
            // §4.1: no audio stream means nothing to correlate on.
            Ok(p) if !p.has_audio() => unsynced.push(Unsynced {
                file: path.clone(),
                reason: UnsyncedReason::NoAudio,
            }),
            Ok(p) => probed.push(p),
            // A cancelled probe is not a broken file — reporting it as `decode_error`
            // would slander the user's media for stopping the run.
            Err(probe::ProbeError::Cancelled) => return Err(Error::Cancelled),
            Err(_) => unsynced.push(Unsynced {
                file: path.clone(),
                reason: UnsyncedReason::DecodeError,
            }),
        }
    }
    let total = candidates.len();
    progress.report(Progress {
        stage: Stage::Probing,
        completed: total,
        total,
    });

    // Only syncable files get devices: a file with no audio can never be placed, so
    // giving it a lane in the UI would promise something the engine cannot deliver.
    //
    // The directory subset is computed here, where the filesystem is being read anyway,
    // and handed to `group` as data — see the note on `device::group`.
    let dropped_dirs: Vec<PathBuf> = inputs.iter().filter(|p| p.is_dir()).cloned().collect();
    let devices = device::group(&probed, &dropped_dirs);

    let probed_out = probed.clone();

    let mut files: Vec<FileEntry> = probed
        .into_iter()
        .map(|p| {
            let device = devices
                .iter()
                .find(|d| d.files.contains(&p.path))
                .map_or_else(String::new, |d| d.id.clone());
            FileEntry {
                device,
                file: p.path,
                duration_seconds: p.duration_seconds,
                format_name: p.format_name,
                creation_time: p.tags.get("creation_time").cloned(),
                audio: p.audio,
                video: p.video,
            }
        })
        .collect();

    files.sort_by(|a, b| a.file.cmp(&b.file));
    unsynced.sort_by(|a, b| a.file.cmp(&b.file));

    Ok((
        ScanManifest {
            schema: SCHEMA_VERSION,
            devices,
            files,
            unsynced,
        },
        probed_out,
    ))
}

/// §9 advanced re-grouping: moves files between devices in a scanned manifest.
///
/// A pure manifest rewrite — no filesystem access, no re-probe — so the UI can preview
/// the result instantly and the pipeline can apply it deterministically (the map is a
/// `BTreeMap`, and device/file ordering is re-derived by id afterwards).
///
/// Semantics (D-028):
/// - A key matching no scanned file is **ignored**: a stale override left after the user
///   removed an input must not abort a run.
/// - A target id the grouping never produced creates a fresh device. Its label is the
///   id's human part (text after the first `-`), matching how [`crate::device`] builds
///   ids; only reachable from the CLI/JSON side — the UI offers existing ids.
/// - Each touched device's `kind` is recomputed from its members ("any video ⇒ Video",
///   the same rule `device::group` applies), and devices left empty are dropped.
pub fn apply_device_overrides(
    manifest: &mut ScanManifest,
    overrides: &std::collections::BTreeMap<PathBuf, String>,
) {
    if overrides.is_empty() {
        return;
    }

    for (file, target_id) in overrides {
        // Only files the scan actually produced can move.
        let Some(entry) = manifest.files.iter_mut().find(|f| &f.file == file) else {
            continue;
        };
        if &entry.device == target_id {
            continue;
        }

        // Detach from the old device.
        if let Some(old) = manifest.devices.iter_mut().find(|d| d.id == entry.device) {
            old.files.retain(|f| f != file);
        }

        // Attach to the target, creating it if the id is new.
        if let Some(target) = manifest.devices.iter_mut().find(|d| &d.id == target_id) {
            target.files.push(file.clone());
        } else {
            let label = target_id
                .split_once('-')
                .map_or_else(|| target_id.clone(), |(_, rest)| rest.to_string());
            manifest.devices.push(Device {
                id: target_id.clone(),
                label,
                kind: DeviceKind::Audio, // recomputed below
                files: vec![file.clone()],
            });
        }
        entry.device = target_id.clone();
    }

    // Recompute kinds from membership, drop empties, restore the §5 orderings.
    let has_video = |device: &Device| {
        device.files.iter().any(|f| {
            manifest
                .files
                .iter()
                .find(|e| &e.file == f)
                .is_some_and(|e| e.video.is_some())
        })
    };
    let kinds: Vec<DeviceKind> = manifest
        .devices
        .iter()
        .map(|d| {
            if has_video(d) {
                DeviceKind::Video
            } else {
                DeviceKind::Audio
            }
        })
        .collect();
    for (device, kind) in manifest.devices.iter_mut().zip(kinds) {
        device.kind = kind;
    }
    manifest.devices.retain(|d| !d.files.is_empty());
    manifest.devices.sort_by(|a, b| a.id.cmp(&b.id));
    for device in &mut manifest.devices {
        device.files.sort();
    }
}

/// Probes every candidate concurrently, returning one outcome per candidate, aligned to
/// the input order.
///
/// P-2: probing used to be a serial loop while extraction ran `min(4, cores)` in parallel,
/// so a single file that took the full 30 s probe timeout stalled the whole scan with the
/// other cores idle. This reuses the exact bounded-parallelism shape of
/// [`crate::extract::Extractor::extract_all`]: indexed result slots (so output never
/// depends on which worker finishes first), an atomic work cursor, and `worker_count`
/// threads under a `thread::scope`.
///
/// Determinism (D-041): the returned vector is indexed by candidate position, so the
/// caller's fold rebuilds the manifest in the identical order the old serial loop did,
/// whatever the thread schedule. Cancellation is preserved — each worker checks the token
/// before taking work, an in-flight probe is cancelled through `probe`'s own token path
/// (§7.4), and a set cancel makes the whole call return [`Error::Cancelled`].
fn probe_candidates(
    sidecar: &Sidecar,
    candidates: &[PathBuf],
    workers: usize,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
) -> Result<Vec<std::result::Result<Probed, probe::ProbeError>>> {
    let total = candidates.len();
    if total == 0 {
        return Ok(Vec::new());
    }

    // Indexed slots, not a push-order queue: results must align to the (sorted) candidate
    // list regardless of completion order, or the manifest would depend on scheduling.
    let slots: Mutex<Vec<Option<std::result::Result<Probed, probe::ProbeError>>>> =
        Mutex::new((0..total).map(|_| None).collect());
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);

    std::thread::scope(|scope| {
        for _ in 0..workers.clamp(1, total) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= total || cancel.is_cancelled() {
                    break;
                }
                let outcome = probe::probe(sidecar, &candidates[i], cancel);
                if let Ok(mut slots) = slots.lock() {
                    slots[i] = Some(outcome);
                }
                progress.report(Progress {
                    stage: Stage::Probing,
                    completed: done.fetch_add(1, Ordering::Relaxed) + 1,
                    total,
                });
            });
        }
    });

    // A set token means some slots may be `None` (workers broke early); report it before
    // the unwrap below rather than surfacing a spurious "no probe result" invariant.
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }

    slots
        .into_inner()
        .map_err(|_| Error::Invariant("probe worker panicked".into()))?
        .into_iter()
        .enumerate()
        .map(|(i, slot)| {
            slot.ok_or_else(|| {
                // Only reachable if a worker vanished without recording a result, which
                // would silently drop a file and violate §7.3.
                Error::Invariant(format!(
                    "no probe result recorded for {}",
                    candidates[i].display()
                ))
            })
        })
        .collect()
}

/// Expands the inputs into a deduplicated, sorted candidate list.
///
/// Returns the candidates plus `unsynced` entries for inputs that do not exist at all —
/// a mistyped path must be visible in the output rather than silently dropped, or §7.3's
/// "every input is accounted for" would quietly not hold.
fn collect(
    inputs: &[PathBuf],
    exclude: Option<&Path>,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
) -> Result<(Vec<PathBuf>, Vec<Unsynced>)> {
    let mut files = Vec::new();
    let mut missing = Vec::new();
    // Resolved once, here, rather than per directory inside the walk.
    let exclude = Exclusion::new(exclude);

    for input in inputs {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if input.is_dir() {
            walk(input, 0, &exclude, &mut files, progress, cancel)?;
        } else if input.is_file() {
            files.push(input.clone());
        } else {
            missing.push(Unsynced {
                file: input.clone(),
                reason: UnsyncedReason::DecodeError,
            });
        }
    }

    // Sorting before dedup gives a total order independent of directory iteration
    // order, which is not stable across filesystems (§3). Dedup catches a user who
    // dropped both a folder and a file inside it.
    files.sort();
    files.dedup();
    Ok((files, missing))
}

/// The directory the walk must not descend into (D-020), resolved once.
///
/// # Why the raw path alone is not enough
///
/// The exclusion and the walk's own paths reach this comparison by different routes: the
/// exclusion is `request.cache_dir` or [`crate::cache::Cache::default_dir`] (assembled
/// from `$HOME`/`$LOCALAPPDATA`), while the walk builds its paths by descending from
/// whatever root the user dropped. A plain `==` therefore only holds when the two happen
/// to be spelled identically — a symlinked drop root, or a cache path typed with a `.`
/// segment, names the *same* directory under a different string, the exclusion misses,
/// and D-020's bug is back: the second run scans its own `.f32` entries, fails to probe
/// them, and reports the user's cache to them as broken media.
///
/// So identity, not spelling, decides. The exclusion is canonicalised once here, and the
/// (cheap) string comparison is tried first so the canonicalising `stat` on the walk's
/// side is only paid when it fails — and only ever per *directory*, never per file.
#[derive(Debug, Default)]
struct Exclusion {
    raw: Option<PathBuf>,
    real: Option<PathBuf>,
}

impl Exclusion {
    fn new(dir: Option<&Path>) -> Self {
        Self {
            raw: dir.map(Path::to_path_buf),
            real: dir.and_then(|d| std::fs::canonicalize(d).ok()),
        }
    }

    fn covers(&self, dir: &Path) -> bool {
        if self.raw.as_deref().is_some_and(|e| dir == e) {
            return true;
        }
        let Some(real) = self.real.as_deref() else {
            return false;
        };
        std::fs::canonicalize(dir).is_ok_and(|resolved| resolved == real)
    }
}

fn walk(
    dir: &Path,
    depth: usize,
    exclude: &Exclusion,
    out: &mut Vec<PathBuf>,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
) -> Result<()> {
    walk_capped(dir, depth, exclude, out, progress, cancel, MAX_FILES)
}

/// The real walk, with the file ceiling as a parameter so a test can drive the S-8 limit
/// without materialising 100 000 files. Production always calls it with [`MAX_FILES`].
fn walk_capped(
    dir: &Path,
    depth: usize,
    exclude: &Exclusion,
    out: &mut Vec<PathBuf>,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
    max_files: usize,
) -> Result<()> {
    if exclude.covers(dir) {
        return Ok(());
    }
    if depth >= MAX_DEPTH {
        return Ok(());
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    // An unreadable directory is skipped rather than fatal: one permission-denied
    // subfolder must not abort a scan of an otherwise fine card (§7.2).
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        // S-8: check cancel *inside* the entry loop, not only per-directory. A single
        // directory holding millions of entries would otherwise run to completion before
        // the per-directory check above could fire again, leaving Cancel dead for the
        // whole drain (§7.4). A wedged network-mount `read_dir`/`metadata` syscall is
        // still uninterruptible — that is inherent to std::fs and documented here, not
        // fixed: only the syscall returning can unblock this loop.
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        // S-8: refuse a pathological width/total rather than enumerating unboundedly.
        // Checked before the push so `out` never exceeds the ceiling.
        if out.len() >= max_files {
            return Err(Error::TooManyFiles { limit: max_files });
        }
        // Both skip tests read the file NAME alone, so they are made before `entry.path()`
        // builds the full path: on a camera card the AppleDouble `._*` companions macOS
        // scatters everywhere can be half the entries, and none of them needs a joined
        // `PathBuf` allocated just to be thrown away.
        let name = entry.file_name();
        let name = Path::new(&name);
        if is_hidden(name) || is_proxy_sidecar(name) {
            continue;
        }
        // `DirEntry::file_type` does not follow links, so a symlink loop cannot trap the
        // walk — a symlink is neither `is_dir` nor `is_file` here and is therefore skipped
        // outright. Linked-in media is rare enough that ignoring links is the safe default.
        //
        // `file_type()` rather than `metadata()`: both answer this question and neither
        // follows links, but the kind is already in the directory entry `read_dir` handed
        // back on Linux and macOS, so this is the same answer for one fewer `lstat` per
        // entry — up to [`MAX_FILES`] syscalls saved on a pathological tree.
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            let path = entry.path();
            walk_capped(&path, depth + 1, exclude, out, progress, cancel, max_files)?;
        } else if kind.is_file() {
            let path = entry.path();
            out.push(path);
            // P-5: emit a live running count so a large tree no longer sits at "0/1" for
            // the whole walk. The total is unknown mid-walk, so `completed == total` is a
            // rising indeterminate count (docs/DECISIONS.md P-5 note). Throttled by
            // `SCAN_PROGRESS_STRIDE` so a huge directory does not flood the sink.
            if out.len().is_multiple_of(SCAN_PROGRESS_STRIDE) {
                progress.report(Progress {
                    stage: Stage::Scanning,
                    completed: out.len(),
                    total: out.len(),
                });
            }
        }
    }
    Ok(())
}

/// Skips dotfiles.
///
/// This is not extension filtering — §4.1 forbids that, and it is right to: renamed and
/// oddly-suffixed media is routine. This drops *hidden OS metadata*: `.DS_Store` and the
/// AppleDouble `._C0001.MP4` companions macOS scatters over every camera card. Probing
/// them would fill the unsynced list with noise that looks like real failures.
fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

/// D-045 (closes D-009's open question): skips low-resolution proxy sidecars.
///
/// GoPro and Insta360 cameras write a small `.lrv` preview file NEXT TO every original —
/// the E10 corpus's Insta360 X paired `VID_…_00_007.insv` with `LRV_…_11_007.lrv`, and
/// GoPros pair `GX010042.MP4` with `GL010042.LRV`. The proxy carries the SAME audio as
/// its original, so scanning both puts duplicate, time-overlapping content on one device;
/// §4.4's overlap eviction then has to arbitrate a fight the user never meant to start,
/// and D-009's "ghost device" is the same file family surfacing twice.
///
/// This is a deliberate, narrow exception to §4.1's no-extension-filtering rule and is
/// classified like the dotfile skip above: `.lrv` is not "media we doubt", it is a
/// *duplicate by construction* of a sibling original. A user who genuinely wants to sync
/// a bare `.lrv` (original lost) can still pass the FILE explicitly — only the recursive
/// folder walk skips it, exactly as it treats hidden files.
fn is_proxy_sidecar(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("lrv"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::NoProgress;
    use std::fs;

    /// A minimal valid PCM WAV, written by hand so fixture creation needs no ffmpeg.
    /// Only *reading* needs ffprobe, which keeps the skip surface as small as possible.
    fn write_wav(path: &Path, seconds: f64) {
        let rate = 8000u32;
        let samples = (rate as f64 * seconds) as u32;
        let data_len = samples * 2;
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data_len).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes()); // PCM
        w.extend_from_slice(&1u16.to_le_bytes()); // mono
        w.extend_from_slice(&rate.to_le_bytes());
        w.extend_from_slice(&(rate * 2).to_le_bytes());
        w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..samples {
            // A quiet ramp — non-silent, so nothing downstream can dismiss it as empty.
            let v = ((i % 256) as i16 - 128) * 64;
            w.extend_from_slice(&v.to_le_bytes());
        }
        fs::write(path, w).unwrap();
    }

    /// Scratch directory — no `tempfile` dependency needed, and the contents survive a
    /// failure for inspection. Cleared on entry rather than on exit so a failing test
    /// leaves its fixtures behind.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("sundaysync-tests").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Phase 1 tests need a real ffprobe. On ubuntu CI it is installed and
    /// `SUNDAYSYNC_REQUIRE_FFMPEG=1` turns a skip into a failure, so the skip path can
    /// never silently hide a regression on the platform that runs the full gate.
    /// See docs/DECISIONS.md D-005.
    fn require_ffprobe() -> Option<Sidecar> {
        match Sidecar::from_path() {
            Ok(s) => Some(s),
            Err(e) => {
                assert!(
                    std::env::var("SUNDAYSYNC_REQUIRE_FFMPEG").is_err(),
                    "ffmpeg is required in this environment but was not found: {e}"
                );
                eprintln!("SKIP: ffprobe unavailable ({e})");
                None
            }
        }
    }

    #[test]
    fn empty_input_is_an_error() {
        let r = scan(&[], &Sidecar::default(), &NoProgress, &CancelToken::new());
        assert!(matches!(r, Err(Error::NoInput)));
    }

    #[test]
    fn hidden_os_metadata_is_skipped() {
        let dir = scratch("hidden");
        fs::write(dir.join(".DS_Store"), b"junk").unwrap();
        fs::write(dir.join("._C0001.MP4"), b"appledouble").unwrap();
        fs::write(dir.join("real.bin"), b"x").unwrap();
        let (found, _) = collect(&[dir], None, &NoProgress, &CancelToken::new()).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("real.bin"));
    }

    #[test]
    fn lrv_proxy_sidecars_are_skipped_by_the_walk_but_honoured_explicitly() {
        // D-045 / D-009: the E10 corpus's Insta360 wrote LRV_….lrv proxies beside every
        // VID_….insv original — same audio twice on one device. The walk skips the proxy
        // (either case), but a user who passes the FILE explicitly is trusted with it.
        let dir = scratch("lrv");
        fs::write(dir.join("VID_20260405_110428_00_007.insv"), b"original").unwrap();
        fs::write(dir.join("LRV_20260405_110428_11_007.lrv"), b"proxy").unwrap();
        fs::write(dir.join("UPPER.LRV"), b"proxy too").unwrap();
        let (found, _) = collect(
            std::slice::from_ref(&dir),
            None,
            &NoProgress,
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(
            found.len(),
            1,
            "only the original survives the walk: {found:?}"
        );
        assert!(found[0].ends_with("VID_20260405_110428_00_007.insv"));

        let explicit = dir.join("LRV_20260405_110428_11_007.lrv");
        let (found, _) = collect(
            std::slice::from_ref(&explicit),
            None,
            &NoProgress,
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(
            found,
            vec![explicit],
            "an explicit file is never second-guessed"
        );
    }

    #[test]
    fn the_cache_is_excluded_by_identity_not_by_spelling() {
        // D-020: the exclusion and the walk's own paths arrive from different routes —
        // the cache dir is assembled from `$HOME` or typed by the user, the walk's path is
        // built by descending from the dropped root — so they can name the same directory
        // with different strings. A plain `==` missed that, the cache was scanned as
        // media, and the second run reported the user's own `.f32` entries back to them as
        // broken files.
        //
        // The differing spelling here is a `..` segment, which is portable and which
        // `Path`'s own comparison genuinely does not see through — unlike a `.` segment,
        // which `Path::components` normalises away, so `==` handles that case already.
        let dir = scratch("scan-exclude-spelling");
        fs::write(dir.join("real.bin"), b"x").unwrap();
        let cache = dir.join("cache");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("deadbeef.f32"), [0u8; 8]).unwrap();

        let differently_spelled = dir.join("cache").join("..").join("cache");
        assert_ne!(
            differently_spelled, cache,
            "the two spellings must really differ, or this test proves nothing"
        );
        let (found, _) = collect(
            std::slice::from_ref(&dir),
            Some(&differently_spelled),
            &NoProgress,
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(
            found.len(),
            1,
            "the cache must be excluded however it is spelled: {found:?}"
        );
        assert!(found[0].ends_with("real.bin"));
    }

    #[cfg(unix)]
    #[test]
    fn the_cache_is_excluded_when_the_walk_reaches_it_through_a_symlink() {
        // The same D-020 hole, in the form a user actually hits: media on an external
        // drive reached through a symlinked shortcut, with the cache configured under its
        // real path.
        let dir = scratch("scan-exclude-symlink");
        let real = dir.join("media");
        let cache = real.join("cache");
        fs::create_dir_all(&cache).unwrap();
        fs::write(real.join("real.bin"), b"x").unwrap();
        fs::write(cache.join("deadbeef.f32"), [0u8; 8]).unwrap();
        let link = dir.join("shortcut");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let (found, _) = collect(
            std::slice::from_ref(&link),
            Some(&cache),
            &NoProgress,
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(
            found.len(),
            1,
            "the cache is the same directory whichever way the walk got there: {found:?}"
        );
        assert!(found[0].ends_with("real.bin"));
    }

    #[cfg(unix)]
    #[test]
    fn the_walk_does_not_follow_symlinks() {
        // Pins the property the entry-kind test carries: links are classified without
        // being followed, so a symlink loop cannot trap the walk and linked-in media is
        // ignored rather than silently duplicated. Previously asserted only in a comment.
        let dir = scratch("scan-symlinks");
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(dir.join("real.bin"), b"x").unwrap();
        fs::write(sub.join("nested.bin"), b"x").unwrap();
        std::os::unix::fs::symlink(dir.join("real.bin"), dir.join("link-to-file")).unwrap();
        // A link back to the walk's own root: following it would recurse forever.
        std::os::unix::fs::symlink(&dir, dir.join("loop")).unwrap();

        let (found, _) = collect(&[dir], None, &NoProgress, &CancelToken::new()).unwrap();
        let names: Vec<String> = found
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect();
        // Sorted by full path, so the root's own file precedes the subdirectory's.
        assert_eq!(names, vec!["real.bin", "nested.bin"], "got {found:?}");
    }

    #[test]
    fn a_nonexistent_input_is_reported_not_dropped() {
        let (found, missing) = collect(
            &[PathBuf::from("/no/such/file.mp4")],
            None,
            &NoProgress,
            &CancelToken::new(),
        )
        .unwrap();
        assert!(found.is_empty());
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].reason, UnsyncedReason::DecodeError);
    }

    #[test]
    fn a_folder_and_a_file_inside_it_are_not_counted_twice() {
        let dir = scratch("dedup");
        let file = dir.join("a.bin");
        fs::write(&file, b"x").unwrap();
        let (found, _) =
            collect(&[dir.clone(), file], None, &NoProgress, &CancelToken::new()).unwrap();
        assert_eq!(found.len(), 1);
    }

    /// Encodes a real silent-video, no-audio MP4. Needs ffmpeg itself, not just
    /// ffprobe — there is no way to hand-write one the way `write_wav` does.
    fn write_video_only(sidecar: &Sidecar, path: &Path) -> bool {
        crate::sidecar::run(
            &sidecar.ffmpeg,
            [
                "-v".as_ref(),
                "error".as_ref(),
                "-f".as_ref(),
                "lavfi".as_ref(),
                "-i".as_ref(),
                "testsrc=size=64x64:rate=25:duration=1".as_ref(),
                "-c:v".as_ref(),
                "libx264".as_ref(),
                "-pix_fmt".as_ref(),
                "yuv420p".as_ref(),
                "-an".as_ref(),
                "-y".as_ref(),
                path.as_os_str(),
            ],
            std::time::Duration::from_secs(60),
            &CancelToken::new(),
        )
        .is_ok()
    }

    #[test]
    fn broken_and_audioless_files_land_in_the_right_buckets() {
        // The Phase 1 acceptance criterion (§11), against real files rather than
        // synthesised ffprobe JSON.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("buckets");
        fs::write(dir.join("zero.mp4"), b"").unwrap();
        fs::write(dir.join("corrupt.mp4"), vec![0xABu8; 4096]).unwrap();
        write_wav(&dir.join("good.wav"), 1.0);
        let silent = dir.join("videoonly.mp4");
        let have_video = write_video_only(&sidecar, &silent);

        let m = scan(&[dir], &sidecar, &NoProgress, &CancelToken::new()).unwrap();

        assert_eq!(m.files.len(), 1, "only the wav is syncable");
        assert!(m.files[0].file.ends_with("good.wav"));

        let reason_for = |name: &str| {
            m.unsynced
                .iter()
                .find(|u| u.file.ends_with(name))
                .map(|u| u.reason)
        };
        assert_eq!(reason_for("zero.mp4"), Some(UnsyncedReason::DecodeError));
        assert_eq!(reason_for("corrupt.mp4"), Some(UnsyncedReason::DecodeError));

        if have_video {
            // A file that decodes perfectly but has nothing to correlate on is a
            // different failure from a broken one, and the UI must say so (§4.1).
            assert_eq!(
                reason_for("videoonly.mp4"),
                Some(UnsyncedReason::NoAudio),
                "a video-only file must be no_audio, not decode_error"
            );
        } else {
            eprintln!("SKIP: could not encode the video-only fixture (no libx264?)");
        }
    }

    #[test]
    fn every_input_is_accounted_for_exactly_once() {
        // §7.3, at the scan level.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("accounting");
        write_wav(&dir.join("ZOOM0001.WAV"), 1.0);
        write_wav(&dir.join("ZOOM0002.WAV"), 1.0);
        fs::write(dir.join("broken.mp4"), vec![0u8; 128]).unwrap();

        let m = scan(&[dir], &sidecar, &NoProgress, &CancelToken::new()).unwrap();
        assert_eq!(m.files.len() + m.unsynced.len(), 3);

        let mut seen: Vec<&PathBuf> = m
            .files
            .iter()
            .map(|f| &f.file)
            .chain(m.unsynced.iter().map(|u| &u.file))
            .collect();
        let before = seen.len();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), before, "a file appeared in both buckets");
    }

    #[test]
    fn scanning_the_same_tree_twice_gives_identical_output() {
        // §13.4 determinism, now against real filesystem iteration order.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("determinism");
        for n in 1..=4 {
            write_wav(&dir.join(format!("C000{n}.WAV")), 0.5);
        }
        let inputs = std::slice::from_ref(&dir);
        let a = scan(inputs, &sidecar, &NoProgress, &CancelToken::new()).unwrap();
        let b = scan(inputs, &sidecar, &NoProgress, &CancelToken::new()).unwrap();
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
    }

    #[test]
    fn parallel_and_serial_probing_produce_an_identical_manifest() {
        // P-2/D-041: the whole point of parallel probing is that it changes only the wall
        // clock, never the result. Probing with one worker is the old serial path; probing
        // with eight is maximally parallel. Both must yield a byte-identical manifest AND an
        // identical raw `Probed` vector, whatever the thread schedule.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("parallel-determinism");
        // A mixed shoot: several syncable clips plus files that land in `unsynced`, so the
        // fold across both buckets is exercised, not just the happy path.
        for n in 1..=8 {
            write_wav(&dir.join(format!("C000{n}.WAV")), 0.4);
        }
        fs::write(dir.join("broken.mp4"), vec![0u8; 256]).unwrap();
        fs::write(dir.join("empty.mp4"), b"").unwrap();
        let inputs = std::slice::from_ref(&dir);

        let (serial, serial_probed) =
            scan_detailed_workers(inputs, &sidecar, None, 1, &NoProgress, &CancelToken::new())
                .unwrap();
        let (parallel, parallel_probed) =
            scan_detailed_workers(inputs, &sidecar, None, 8, &NoProgress, &CancelToken::new())
                .unwrap();

        assert!(
            serial.files.len() >= 8,
            "the syncable clips must have probed"
        );
        assert_eq!(
            serde_json::to_string(&serial).unwrap(),
            serde_json::to_string(&parallel).unwrap(),
            "serial and parallel manifests must be byte-identical"
        );
        assert_eq!(
            serial_probed, parallel_probed,
            "the raw Probed records must match in order too"
        );
    }

    #[test]
    fn a_cancelled_parallel_probe_stops_and_reports_cancelled() {
        // P-2: cancellation must survive the move to the worker pool. A token tripped
        // before probing means no probe result is required, and the call returns Cancelled
        // rather than a spurious "no probe result" invariant.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("parallel-cancel");
        for n in 1..=6 {
            write_wav(&dir.join(format!("C000{n}.WAV")), 0.3);
        }
        let (candidates, _) = collect(
            std::slice::from_ref(&dir),
            None,
            &NoProgress,
            &CancelToken::new(),
        )
        .unwrap();
        let cancel = CancelToken::new();
        cancel.cancel();
        let r = probe_candidates(&sidecar, &candidates, 4, &NoProgress, &cancel);
        assert!(matches!(r, Err(Error::Cancelled)), "got {r:?}");
    }

    #[test]
    fn the_scan_walk_emits_a_rising_file_count() {
        // P-5: the walk used to emit nothing, so a big folder sat at "0/1" the whole time.
        // With more than one stride's worth of files it must now report `Scanning` ticks
        // whose count climbs. No ffprobe needed — this is the walk, not the probe.
        use std::sync::Mutex as StdMutex;
        struct Rec(StdMutex<Vec<Progress>>);
        impl ProgressSink for Rec {
            fn report(&self, p: Progress) {
                if let Ok(mut v) = self.0.lock() {
                    v.push(p);
                }
            }
        }

        let dir = scratch("scan-walk-progress");
        let n = SCAN_PROGRESS_STRIDE * 2 + 5;
        for i in 0..n {
            fs::write(dir.join(format!("f{i:05}.bin")), b"x").unwrap();
        }
        let rec = Rec(StdMutex::new(Vec::new()));
        let (found, _) = collect(&[dir], None, &rec, &CancelToken::new()).unwrap();
        assert_eq!(found.len(), n);

        let scanning: Vec<usize> = rec
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.stage == Stage::Scanning)
            .map(|p| p.completed)
            .collect();
        assert!(
            scanning.len() >= 2,
            "expected several scanning ticks, got {scanning:?}"
        );
        assert!(
            scanning.windows(2).all(|w| w[1] > w[0]),
            "the reported count must rise: {scanning:?}"
        );
        assert!(
            scanning.iter().all(|&c| c > 0),
            "no scanning tick should report zero once files are found"
        );
    }

    #[test]
    fn real_files_group_into_devices() {
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("grouping");
        write_wav(&dir.join("C0001.WAV"), 0.5);
        write_wav(&dir.join("C0002.WAV"), 0.5);
        write_wav(&dir.join("ZOOM0001.WAV"), 0.5);

        let m = scan(&[dir], &sidecar, &NoProgress, &CancelToken::new()).unwrap();
        assert_eq!(m.devices.len(), 2);
        assert!(m.files.iter().all(|f| !f.device.is_empty()));
        let zoom = m.devices.iter().find(|d| d.id == "name-zoom").unwrap();
        assert_eq!(zoom.files.len(), 1);
    }

    fn manifest_for_overrides() -> ScanManifest {
        use crate::probe::{AudioStream, VideoStream};
        use crate::rational::Rational;
        let video = |path: &str| FileEntry {
            file: PathBuf::from(path),
            device: String::new(),
            duration_seconds: 60.0,
            format_name: "mov,mp4".into(),
            audio: Some(AudioStream {
                codec: "aac".into(),
                sample_rate: 48_000,
                channels: 2,
            }),
            video: Some(VideoStream {
                codec: "h264".into(),
                width: 1920,
                height: 1080,
                fps: Rational::new(25, 1),
            }),
            creation_time: None,
        };
        let audio = |path: &str| FileEntry {
            video: None,
            audio: Some(AudioStream {
                codec: "pcm_s16le".into(),
                sample_rate: 48_000,
                channels: 1,
            }),
            ..video(path)
        };
        let mut a = video("/x/C0001.MP4");
        a.device = "cam-a".into();
        let mut b = video("/x/C0002.MP4");
        b.device = "cam-a".into();
        let mut z = audio("/x/ZOOM0001.WAV");
        z.device = "rec".into();
        ScanManifest {
            schema: SCHEMA_VERSION,
            devices: vec![
                Device {
                    id: "cam-a".into(),
                    label: "A".into(),
                    kind: DeviceKind::Video,
                    files: vec![PathBuf::from("/x/C0001.MP4"), PathBuf::from("/x/C0002.MP4")],
                },
                Device {
                    id: "rec".into(),
                    label: "Zoom".into(),
                    kind: DeviceKind::Audio,
                    files: vec![PathBuf::from("/x/ZOOM0001.WAV")],
                },
            ],
            files: vec![a, b, z],
            unsynced: vec![],
        }
    }

    #[test]
    fn overrides_move_files_and_recompute_kind() {
        let mut m = manifest_for_overrides();
        let mut ov = std::collections::BTreeMap::new();
        // Move a VIDEO file into the audio-only recorder device: the device must flip
        // to Video ("any video ⇒ Video"), and cam-a keeps its other clip.
        ov.insert(PathBuf::from("/x/C0002.MP4"), "rec".to_string());
        apply_device_overrides(&mut m, &ov);

        let rec = m.devices.iter().find(|d| d.id == "rec").unwrap();
        assert_eq!(rec.files.len(), 2);
        assert_eq!(rec.kind, DeviceKind::Video, "video member flips the kind");
        let cam = m.devices.iter().find(|d| d.id == "cam-a").unwrap();
        assert_eq!(cam.files, vec![PathBuf::from("/x/C0001.MP4")]);
        let entry = m
            .files
            .iter()
            .find(|f| f.file.ends_with("C0002.MP4"))
            .unwrap();
        assert_eq!(entry.device, "rec");
    }

    #[test]
    fn overrides_drop_emptied_devices_and_create_new_ones() {
        let mut m = manifest_for_overrides();
        let mut ov = std::collections::BTreeMap::new();
        ov.insert(
            PathBuf::from("/x/ZOOM0001.WAV"),
            "folder-balkong".to_string(),
        );
        apply_device_overrides(&mut m, &ov);

        assert!(
            !m.devices.iter().any(|d| d.id == "rec"),
            "emptied device dropped"
        );
        let created = m.devices.iter().find(|d| d.id == "folder-balkong").unwrap();
        assert_eq!(created.label, "balkong", "label is the id's human part");
        assert_eq!(created.kind, DeviceKind::Audio);
    }

    #[test]
    fn stale_and_noop_overrides_are_ignored() {
        let mut m = manifest_for_overrides();
        let before = m.clone();
        let mut ov = std::collections::BTreeMap::new();
        ov.insert(PathBuf::from("/gone/removed.mp4"), "rec".to_string()); // stale key
        ov.insert(PathBuf::from("/x/C0001.MP4"), "cam-a".to_string()); // already there
        apply_device_overrides(&mut m, &ov);
        assert_eq!(m, before, "stale and no-op overrides must change nothing");

        // And the empty map is the untouched fast path.
        apply_device_overrides(&mut m, &std::collections::BTreeMap::new());
        assert_eq!(m, before);
    }

    #[test]
    fn overrides_are_deterministic_and_keep_the_orderings() {
        let mut a = manifest_for_overrides();
        let mut b = manifest_for_overrides();
        let mut ov = std::collections::BTreeMap::new();
        ov.insert(PathBuf::from("/x/C0001.MP4"), "rec".to_string());
        ov.insert(PathBuf::from("/x/C0002.MP4"), "rec".to_string());
        apply_device_overrides(&mut a, &ov);
        apply_device_overrides(&mut b, &ov);
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
        assert!(
            a.devices.windows(2).all(|w| w[0].id < w[1].id),
            "sorted by id"
        );
    }

    #[test]
    fn scan_manifest_serde_spelling_is_stable() {
        // The TS mirror in app/src/types.ts is hand-written against these names; this
        // assertion is what keeps the two from drifting (same pattern as result.rs).
        let m = manifest_for_overrides();
        let json = serde_json::to_value(&m).unwrap();
        let entry = &json["files"][0];
        for key in [
            "file",
            "device",
            "duration_seconds",
            "format_name",
            "audio",
            "video",
            "creation_time",
        ] {
            assert!(entry.get(key).is_some(), "missing key {key}");
        }
        assert!(entry["audio"].get("sample_rate").is_some());
        assert!(entry["video"].get("fps").is_some());
    }

    #[test]
    fn cancellation_stops_the_scan() {
        let dir = scratch("cancel");
        write_wav(&dir.join("a.wav"), 0.2);
        let cancel = CancelToken::new();
        cancel.cancel();
        let r = scan(&[dir], &Sidecar::default(), &NoProgress, &cancel);
        assert!(matches!(r, Err(Error::Cancelled)));
    }

    #[test]
    fn the_file_ceiling_triggers_and_names_the_limit() {
        // S-8: a directory wider than the ceiling is refused loudly, not truncated. Driven
        // through `walk_capped` with a tiny limit so the test need not create 100 000
        // files — production wires the same code to MAX_FILES.
        let dir = scratch("scan-ceiling");
        for n in 0..25 {
            fs::write(dir.join(format!("f{n}.bin")), b"x").unwrap();
        }
        let mut out = Vec::new();
        let r = walk_capped(
            &dir,
            0,
            &Exclusion::default(),
            &mut out,
            &NoProgress,
            &CancelToken::new(),
            10,
        );
        assert!(
            matches!(r, Err(Error::TooManyFiles { limit: 10 })),
            "expected a named ceiling error, got {r:?}"
        );
        assert!(
            out.len() <= 10,
            "the ceiling must bound `out`, found {}",
            out.len()
        );
    }

    #[test]
    fn a_scan_under_the_ceiling_is_unaffected() {
        // The guard must not trip on a normal shoot: exactly-at-limit is fine, over is not.
        let dir = scratch("scan-under-ceiling");
        for n in 0..8 {
            fs::write(dir.join(format!("f{n}.bin")), b"x").unwrap();
        }
        let mut out = Vec::new();
        let r = walk_capped(
            &dir,
            0,
            &Exclusion::default(),
            &mut out,
            &NoProgress,
            &CancelToken::new(),
            100,
        );
        assert!(r.is_ok(), "a small tree must scan cleanly, got {r:?}");
        assert_eq!(out.len(), 8);
    }

    #[test]
    fn cancel_interrupts_a_large_single_directory_mid_loop() {
        // S-8: the in-loop cancel check must interrupt the drain of one huge directory,
        // not only the gaps between directories. This specifically guards the check inside
        // the entry loop: the per-directory check at the top of `walk_capped` runs exactly
        // once for a single flat directory, so with the in-loop check removed a concurrent
        // cancel would be ignored until the whole directory had drained — which is the
        // failure this asserts against.
        //
        // Deterministic, not timing-raced: the earlier version slept 2 ms before cancelling
        // and a fast disk drained the directory first, so `walk` finished Ok before the flag
        // was ever set. Here the flag is raised with no artificial delay while the walk runs,
        // and the entry count is large enough that the loop cannot complete before the raise
        // is observed (each entry costs a `metadata` syscall). If the OS is loaded enough to
        // delay the canceller thread, the walk is slowed by the same load, so the ordering
        // holds regardless of absolute speed.
        let dir = scratch("scan-cancel-midloop");
        for n in 0..20_000 {
            fs::write(dir.join(format!("f{n}.bin")), b"x").unwrap();
        }
        let cancel = CancelToken::new();
        let flag = cancel.clone();
        let handle = std::thread::spawn(move || flag.cancel());
        let start = std::time::Instant::now();
        let mut out = Vec::new();
        let r = walk_capped(
            &dir,
            0,
            &Exclusion::default(),
            &mut out,
            &NoProgress,
            &cancel,
            MAX_FILES,
        );
        handle.join().unwrap();
        assert!(
            matches!(r, Err(Error::Cancelled)),
            "a cancel during the drain must stop the walk, got {r:?} after {} entries",
            out.len()
        );
        assert!(
            out.len() < 20_000,
            "the walk drained the whole directory instead of stopping early: {} entries",
            out.len()
        );
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "cancel did not return promptly: {:?}",
            start.elapsed()
        );
    }
}
