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
use crate::result::{
    Device, DeviceKind, SkipReason, SkippedFile, Unsynced, UnsyncedReason, SCHEMA_VERSION,
};
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
/// docs/DECISIONS.md D-032). Counts *every* entry the walk takes a `PathBuf` for —
/// candidates and D-066 skips alike — because both are held in memory and the ceiling
/// exists to bound memory, not to bless a card that happens to be 99 % proxies.
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
    /// Files the walk deliberately did not probe, each with a reason (D-066).
    ///
    /// Sorted by path, like every other list here. Kept apart from `unsynced` because
    /// nothing is wrong with these files — see [`SkippedFile`].
    ///
    /// `#[serde(default)]` makes this an **additive** field: a manifest written before
    /// D-066 still deserialises, so `SCHEMA_VERSION` does not move. See D-066 for the
    /// full reasoning.
    #[serde(default)]
    pub skipped: Vec<SkippedFile>,
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
    /// The container's `date` tag, verbatim (V05-W3, D-067).
    ///
    /// On a BWF this is the other half of the timestamp: `date=2026-07-25` beside a
    /// `creation_time` of `16:12:29`. Absent on every container that writes a full ISO
    /// `creation_time`, which is why it is additive rather than a replacement.
    ///
    /// `#[serde(default)]`, additive in both directions — see D-067 for why
    /// `SCHEMA_VERSION` does not move.
    #[serde(default)]
    pub date_tag: Option<String>,
    /// The file's modification time, as ISO-8601 UTC to the second (V05-W3, D-067).
    ///
    /// From `std::fs::metadata` — no ffprobe call and no extra spawn, because it is not
    /// container metadata at all. It is the last rung of the recording-time ladder: on the
    /// owner's 136 AVCHD `.MTS` files there are **no container tags whatsoever**, and the
    /// mtime is the only clock left. Measured on that corpus, it is the **end** of the
    /// write (`02106` at 14:12:08 for a 30.7 s clip, `02107` at 14:12:58 for an 11 s one),
    /// so the frontend subtracts the duration; birth time is deliberately NOT read, since
    /// on those same files it is the date they were *copied* — a confident wrong answer.
    ///
    /// `None` when the metadata cannot be read or the platform has no mtime.
    ///
    /// `#[serde(default)]`, additive in both directions — see D-067.
    #[serde(default)]
    pub modified_time: Option<String>,
}

/// Whole-second ISO-8601 UTC (`1970-01-01T00:00:00Z`) for a Unix timestamp.
///
/// Hand-rolled rather than pulling in a date crate: `core` has five dependencies and each
/// one is a licence, a build and a supply chain the engine has to justify (§3). This is
/// Howard Hinnant's `civil_from_days`, which is exact for every representable day and has
/// no notion of a timezone to get wrong — the string this produces is UTC by construction,
/// which is precisely the contract `recordingTime.ts` reads it under.
fn iso8601_utc(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400);
    let secs_of_day = unix_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (h, m, s) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Days since the Unix epoch → `(year, month, day)`. Hinnant's algorithm, civil calendar.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    // Shift the era origin to 0000-03-01 so leap days land at the end of a year.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], March-based
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// A file's mtime as ISO-8601 UTC, or `None` when the filesystem will not say.
///
/// Takes a path and nothing else — no [`Sidecar`], no process, no ffprobe. That is not an
/// implementation detail: the whole point of this rung is that it costs a `stat` on files
/// where every container tag is missing, so a version that spawned anything would defeat
/// its own reason for existing.
fn modified_time_iso(path: &Path) -> Option<String> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let seconds = match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_secs()).ok()?,
        // Before 1970 — a clock wrong in the other direction, but still a fact about the
        // file. Truncated toward the epoch; sub-second precision is noise at this rung.
        Err(before) => i64::try_from(before.duration().as_secs())
            .ok()
            .map(|s| -s)?,
    };
    Some(iso8601_utc(seconds))
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

    let (candidates, missing, skipped) = collect(inputs, exclude, progress, cancel)?;

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
            // D-067: read the mtime here, where the path is still in hand and the
            // filesystem is already being touched, and before `p.path` is moved.
            let modified_time = modified_time_iso(&p.path);
            FileEntry {
                device,
                file: p.path,
                duration_seconds: p.duration_seconds,
                format_name: p.format_name,
                creation_time: p.tags.get("creation_time").cloned(),
                date_tag: p.tags.get("date").cloned(),
                modified_time,
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
            skipped,
        },
        probed_out,
    ))
}

/// V04-U2 (D-060): removes files the user took out of the run from a scanned manifest.
///
/// A pure manifest rewrite, like [`apply_device_overrides`] beside it — no filesystem
/// access, no re-probe — so the UI can preview the result instantly and the pipeline can
/// apply it deterministically.
///
/// Semantics, deliberately the same contract as [`apply_device_overrides`]:
/// - **Exact-path match, no canonicalisation.** The UI echoes scan output straight back,
///   so the path the scan reported is the path that matches.
/// - A path matching nothing is **ignored** — a stale exclusion left after the user
///   removed an input must not abort a run (D-028's rule).
/// - Both buckets are cleared: an excluded file leaves `files` *and* `unsynced`. Excluding
///   is "this is not part of the run", not "this failed" — leaving it on the unsynced
///   shelf would report a problem the user just resolved.
/// - A device left with no files is dropped, so an emptied camera stops occupying a lane.
///
/// The §7.3 accounting invariant in [`crate::sync_with_durations`] is computed *after*
/// this runs, over the reduced manifest, so an excluded file is not "lost" — it was never
/// an input to the run.
pub fn apply_exclusions(manifest: &mut ScanManifest, exclude: &[PathBuf]) {
    if exclude.is_empty() {
        return;
    }

    let excluded: std::collections::BTreeSet<&PathBuf> = exclude.iter().collect();

    manifest.files.retain(|f| !excluded.contains(&f.file));
    manifest.unsynced.retain(|u| !excluded.contains(&u.file));
    for device in &mut manifest.devices {
        device.files.retain(|f| !excluded.contains(f));
    }
    manifest.devices.retain(|d| !d.files.is_empty());
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

/// What one walk produced: the files worth probing, and the ones it walked past.
///
/// Carried as a struct rather than two `&mut Vec` parameters so the recursion signature
/// stays readable and the two lists cannot be handed to `walk_capped` the wrong way round.
#[derive(Debug, Default)]
struct Walked {
    files: Vec<PathBuf>,
    /// D-066: files the walk classified and never probed. Not failures — see
    /// [`SkippedFile`].
    skipped: Vec<SkippedFile>,
}

impl Walked {
    /// Everything the walk is holding a `PathBuf` for. What the S-8 ceiling bounds.
    fn enumerated(&self) -> usize {
        self.files.len() + self.skipped.len()
    }
}

/// Expands the inputs into a deduplicated, sorted candidate list.
///
/// Returns the candidates, `unsynced` entries for inputs that do not exist at all — a
/// mistyped path must be visible in the output rather than silently dropped, or §7.3's
/// "every input is accounted for" would quietly not hold — and the D-066 skips the walk
/// classified on the way past.
fn collect(
    inputs: &[PathBuf],
    exclude: Option<&Path>,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
) -> Result<(Vec<PathBuf>, Vec<Unsynced>, Vec<SkippedFile>)> {
    let mut walked = Walked::default();
    let mut missing = Vec::new();
    // Resolved once, here, rather than per directory inside the walk.
    let exclude = Exclusion::new(exclude);

    for input in inputs {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if input.is_dir() {
            walk(input, 0, &exclude, &mut walked, progress, cancel)?;
        } else if input.is_file() {
            // D-066/D-045: an explicitly passed file is never second-guessed — not for a
            // `.lrv`, not for a `.LRF`, not for a `.HEIC`. Only the recursive walk
            // classifies, exactly as it is only the walk that hides dotfiles.
            walked.files.push(input.clone());
        } else {
            missing.push(Unsynced {
                file: input.clone(),
                reason: UnsyncedReason::DecodeError,
            });
        }
    }

    let Walked {
        mut files,
        mut skipped,
    } = walked;
    // Sorting before dedup gives a total order independent of directory iteration
    // order, which is not stable across filesystems (§3). Dedup catches a user who
    // dropped both a folder and a file inside it.
    files.sort();
    files.dedup();
    // The same total order for the skip list, for the same reason: §13.4 demands
    // byte-identical JSON from identical inputs, and this list is now in that JSON.
    skipped.sort_by(|a, b| a.file.cmp(&b.file));
    skipped.dedup_by(|a, b| a.file == b.file);
    Ok((files, missing, skipped))
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
    out: &mut Walked,
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
    out: &mut Walked,
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
        if out.enumerated() >= max_files {
            return Err(Error::TooManyFiles { limit: max_files });
        }
        // The dotfile test reads the file NAME alone, so it is made before `entry.path()`
        // builds the full path and before any syscall: on a camera card the AppleDouble
        // `._*` companions macOS scatters everywhere can be half the entries, and none of
        // them needs a joined `PathBuf` allocated just to be thrown away.
        let name = entry.file_name();
        let name = Path::new(&name);
        if is_hidden(name) {
            continue;
        }
        // D-066's classes are decided on the name too, but the answer is only *acted on*
        // below, once the entry's kind is known: a skip has to be reported, and a
        // directory that happens to end in `.lrv` is not a file the operator lost.
        let skip = skip_reason(name);
        // `DirEntry::file_type` does not follow links, so a symlink loop cannot trap the
        // walk — a symlink is neither `is_dir` nor `is_file` here and is therefore skipped
        // outright. Linked-in media is rare enough that ignoring links is the safe default.
        //
        // `file_type()` rather than `metadata()`: both answer this question and neither
        // follows links, but the kind is already in the directory entry `read_dir` handed
        // back on Linux and macOS, so this is the same answer for one fewer `lstat` per
        // entry — up to [`MAX_FILES`] syscalls saved on a pathological tree.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if let Some(reason) = skip {
            // Only a real file is worth a line in the manifest. A *directory* so named is
            // passed over unreported and undescended, exactly as it was before D-066.
            if kind.is_file() {
                out.skipped.push(SkippedFile {
                    file: entry.path(),
                    reason,
                });
            }
            continue;
        }
        if kind.is_dir() {
            let path = entry.path();
            walk_capped(&path, depth + 1, exclude, out, progress, cancel, max_files)?;
        } else if kind.is_file() {
            let path = entry.path();
            out.files.push(path);
            // P-5: emit a live running count so a large tree no longer sits at "0/1" for
            // the whole walk. The total is unknown mid-walk, so `completed == total` is a
            // rising indeterminate count (docs/DECISIONS.md P-5 note). Throttled by
            // `SCAN_PROGRESS_STRIDE` so a huge directory does not flood the sink.
            if out.files.len().is_multiple_of(SCAN_PROGRESS_STRIDE) {
                progress.report(Progress {
                    stage: Stage::Scanning,
                    completed: out.files.len(),
                    total: out.files.len(),
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

/// The closed set of camera-sidecar extensions the walk skips (D-045, extended by
/// D-050 after three corpora confirmed each member, and by D-066 for `.lrf`): files that
/// *describe* a sibling recording rather than being one. `.lrv` (GoPro/Insta360 low-res
/// proxy — duplicate audio), `.lrf` (the same thing under DJI's spelling), `.thm`
/// (GoPro/DSLR thumbnail JPEGs), and the AVCHD index family (`.cpi`/`.bdm`/`.mpl`/
/// `.tdt`/`.tid`) that litters every `PRIVATE/` card dump and showed up as nine spurious
/// `decode_error`s on the first 2013 corpus.
///
/// `.lrf` came from the owner's 386-file wedding: `01_FILM/DRONE/` held **8 `.LRF`
/// files** — five sitting 1:1 beside their originals (`DJI_0075.LRF`, 123 MB, next to
/// `DJI_0075.MP4`, 817 MB) and three orphans (`DJI_0080–0082.LRF`) whose MP4s were not in
/// the folder at all. Every one of them was being ingested as real footage, which is
/// D-045's fight handed to §4.4 all over again — and the orphans are worse than the pairs,
/// because there is no original for the overlap eviction to prefer.
///
/// This is a deliberate, narrow exception to §4.1's no-extension-filtering rule and is
/// classified like the dotfile skip above: a sidecar is not "media we doubt", it is a
/// *duplicate by construction* of a sibling original. A user who genuinely wants to sync
/// a bare `.lrv` or `.LRF` (original lost — three of the drone's were) can still pass the
/// FILE explicitly; only the recursive folder walk skips it, exactly as it treats hidden
/// files.
const SIDECAR_EXTENSIONS: [&str; 8] = ["lrv", "lrf", "thm", "cpi", "bdm", "mpl", "tdt", "tid"];

/// D-066: photographs, which the walk skips **before probing them**.
///
/// A separate constant from [`SIDECAR_EXTENSIONS`] with a separate reason, because the two
/// justifications do not generalise to each other and merging them would let a future
/// reader extend one list on the other's argument. A sidecar is a *duplicate by
/// construction* — its content is already in the run under another name. A still is not a
/// duplicate of anything and nothing is wrong with it; it is simply **not correlatable
/// media**: there is no audio to match on, so it can never be placed on a timeline no
/// matter how the engine improves.
///
/// Before this, the walk probed them: the owner's `01_FILM/STEINAR/IMG_4164.HEIC` cost an
/// ffprobe, came back with no audio stream, and landed on the red unsynced shelf — which
/// reads to an operator as *an error about a photo*. On a card dump of raws that is one
/// child process per file to produce a shelf full of `decode_error`, which is noise dressed
/// as an error. The skip is therefore made on the name, before the probe pool ever sees it.
///
/// Members are the still formats that turn up beside video on a real card: Apple's
/// `heic`/`heif`, the ordinary web set, and the raw formats of the manufacturers whose
/// cameras also shoot the video in these folders (`dng`, Canon `cr2`/`cr3`, Nikon `nef`,
/// Sony `arw`, Fuji `raf`, Olympus `orf`, Panasonic `rw2`). Same explicit-pass exemption as
/// the sidecars: pass the FILE and it is honoured, however little sense that makes.
const STILL_IMAGE_EXTENSIONS: [&str; 18] = [
    "heic", "heif", "jpg", "jpeg", "png", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2",
    "tif", "tiff", "webp", "bmp", "gif",
];

/// Classifies one directory entry's NAME into a D-066 skip class, or `None` to probe it.
///
/// Extensions are matched case-insensitively: the drone writes `.LRF`, macOS writes
/// `.heic`, and a card that has been through Windows can carry either.
fn skip_reason(path: &Path) -> Option<SkipReason> {
    let ext = path.extension().and_then(|e| e.to_str())?;
    let has = |set: &[&str]| set.iter().any(|s| ext.eq_ignore_ascii_case(s));
    if has(&SIDECAR_EXTENSIONS) {
        Some(SkipReason::Sidecar)
    } else if has(&STILL_IMAGE_EXTENSIONS) {
        Some(SkipReason::StillImage)
    } else {
        None
    }
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
        let (found, _, _) = collect(&[dir], None, &NoProgress, &CancelToken::new()).unwrap();
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
        // D-050: the AVCHD index family and GoPro thumbnails, straight from the corpora.
        for junk in [
            "GX010123.THM",
            "00000.CPI",
            "INDEX.BDM",
            "00000.MPL",
            "THUMB.TDT",
            "THUMB.TID",
        ] {
            fs::write(dir.join(junk), b"sidecar").unwrap();
        }
        let (found, _, skipped) = collect(
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
        // D-066: skipping is no longer silent. Every one of them is reported as a sidecar.
        assert_eq!(
            skipped.len(),
            8,
            "every sidecar is accounted for: {skipped:?}"
        );
        assert!(skipped.iter().all(|s| s.reason == SkipReason::Sidecar));

        let explicit = dir.join("LRV_20260405_110428_11_007.lrv");
        let (found, _, skipped) = collect(
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
        assert!(
            skipped.is_empty(),
            "an honoured file is not also reported as skipped"
        );
    }

    // ---- D-066: DJI proxies and still images --------------------------------------

    #[test]
    fn dji_lrf_proxies_are_skipped_paired_or_orphaned_and_reported() {
        // The exact shape measured on the owner's wedding: `01_FILM/DRONE/` held five
        // `.LRF` proxies sitting 1:1 beside their `.MP4` originals, and three orphans whose
        // MP4s were not in the folder at all. Before D-066 all eight were ingested as real
        // footage and handed to §4.4's overlap eviction.
        let dir = scratch("d066-lrf");
        for n in 75..=79 {
            fs::write(dir.join(format!("DJI_00{n}.MP4")), b"original").unwrap();
            fs::write(dir.join(format!("DJI_00{n}.LRF")), b"proxy").unwrap();
        }
        for n in 80..=82 {
            fs::write(dir.join(format!("DJI_00{n}.LRF")), b"orphan proxy").unwrap();
        }
        // Case-insensitive: a card that has been through another tool can carry either.
        fs::write(dir.join("DJI_0083.lrf"), b"lowercase proxy").unwrap();

        let (found, _, skipped) = collect(&[dir], None, &NoProgress, &CancelToken::new()).unwrap();

        assert_eq!(found.len(), 5, "only the five originals survive: {found:?}");
        assert!(found
            .iter()
            .all(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp4"))));
        assert_eq!(
            skipped.len(),
            9,
            "the orphans count too — nothing vanishes: {skipped:?}"
        );
        assert!(skipped.iter().all(|s| s.reason == SkipReason::Sidecar));
        assert!(
            skipped.iter().any(|s| s.file.ends_with("DJI_0080.LRF")),
            "an orphaned proxy is skipped and reported like any other"
        );
        assert!(
            skipped.iter().any(|s| s.file.ends_with("DJI_0083.lrf")),
            "lowercase `.lrf` is the same extension"
        );
    }

    #[test]
    fn a_still_image_of_each_family_is_skipped_before_it_is_ever_probed() {
        // `01_FILM/STEINAR/IMG_4164.HEIC` used to cost an ffprobe, come back with no audio
        // stream and land on the red unsynced shelf — an error message about a photograph.
        // One member per family the constant covers, in the case each writes.
        let dir = scratch("d066-stills");
        let stills = [
            "IMG_4164.HEIC",
            "IMG_4165.heif",
            "DSC0001.JPG",
            "DSC0002.jpeg",
            "grab.png",
            "A001.DNG",
            "IMG_0001.CR2",
            "IMG_0002.CR3",
            "DSC_0003.NEF",
            "DSC00004.ARW",
            "DSCF0005.RAF",
            "P1000006.ORF",
            "P1000007.RW2",
            "scan.tif",
            "scan2.TIFF",
            "web.webp",
            "old.bmp",
            "anim.gif",
        ];
        for name in stills {
            fs::write(dir.join(name), b"not media we can correlate").unwrap();
        }
        fs::write(dir.join("C0001.MP4"), b"real footage").unwrap();

        let (found, _, skipped) = collect(&[dir], None, &NoProgress, &CancelToken::new()).unwrap();

        assert_eq!(found.len(), 1, "the video is the only candidate: {found:?}");
        assert!(found[0].ends_with("C0001.MP4"));
        assert_eq!(skipped.len(), stills.len());
        assert!(
            skipped.iter().all(|s| s.reason == SkipReason::StillImage),
            "a photo is not a sidecar — the two reasons carry different arguments: {skipped:?}"
        );
    }

    #[test]
    fn an_explicitly_passed_still_is_honoured_like_an_explicitly_passed_proxy() {
        // The same exemption D-045 granted, for the same reason: the walk guesses, the user
        // does not. A file the operator named is theirs to name, however little sense it
        // makes — the probe will report `no_audio` and the shelf will say so honestly.
        let dir = scratch("d066-explicit");
        let heic = dir.join("IMG_4164.HEIC");
        let lrf = dir.join("DJI_0080.LRF");
        fs::write(&heic, b"photo").unwrap();
        fs::write(&lrf, b"proxy").unwrap();

        let (found, _, skipped) = collect(
            &[heic.clone(), lrf.clone()],
            None,
            &NoProgress,
            &CancelToken::new(),
        )
        .unwrap();

        assert_eq!(found, vec![lrf, heic], "sorted, and both honoured");
        assert!(skipped.is_empty());
    }

    #[test]
    fn a_mixed_folder_counts_each_class_separately() {
        // What the sources panel's one quiet line is counting. A drop with both classes in
        // it must produce both counts, and must not let one class borrow the other's reason.
        let dir = scratch("d066-mixed");
        fs::write(dir.join("C0001.MP4"), b"footage").unwrap();
        fs::write(dir.join("ZOOM0001.WAV"), b"audio").unwrap();
        fs::write(dir.join("DJI_0075.LRF"), b"proxy").unwrap();
        fs::write(dir.join("GX010042.LRV"), b"proxy").unwrap();
        fs::write(dir.join("GX010042.THM"), b"thumb").unwrap();
        fs::write(dir.join("IMG_4164.HEIC"), b"photo").unwrap();
        fs::write(dir.join(".DS_Store"), b"junk").unwrap();

        let (found, _, skipped) = collect(&[dir], None, &NoProgress, &CancelToken::new()).unwrap();

        assert_eq!(found.len(), 2, "the two real recordings: {found:?}");
        let sidecars = skipped
            .iter()
            .filter(|s| s.reason == SkipReason::Sidecar)
            .count();
        let stills = skipped
            .iter()
            .filter(|s| s.reason == SkipReason::StillImage)
            .count();
        assert_eq!((sidecars, stills), (3, 1), "got {skipped:?}");
        assert!(
            skipped.windows(2).all(|w| w[0].file < w[1].file),
            "the list is sorted by path like every other list in the manifest"
        );
        assert!(
            !skipped.iter().any(|s| s.file.ends_with(".DS_Store")),
            "hidden OS metadata stays invisible: it is not the operator's file, so \
             counting it would be noise, not honesty"
        );
    }

    #[test]
    fn a_directory_named_like_a_skip_class_is_not_reported_as_a_skipped_file() {
        // The classes are about files. A folder called `PHOTOS.HEIC` is not a photograph
        // the operator lost, and putting it on the skipped list would be a lie about a
        // directory. (It is still not descended, exactly as before D-066.)
        let dir = scratch("d066-dir-named");
        fs::create_dir_all(dir.join("PHOTOS.HEIC")).unwrap();
        fs::write(dir.join("PHOTOS.HEIC").join("inside.mp4"), b"x").unwrap();
        fs::write(dir.join("C0001.MP4"), b"footage").unwrap();

        let (found, _, skipped) = collect(&[dir], None, &NoProgress, &CancelToken::new()).unwrap();

        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].ends_with("C0001.MP4"));
        assert!(skipped.is_empty(), "got {skipped:?}");
    }

    #[test]
    fn a_scan_reports_its_skips_in_the_manifest() {
        // End to end through `scan`, not just `collect`: the field has to reach the JSON
        // the CLI prints and the UI reads, and it has to stay out of `unsynced` — nothing
        // is wrong with these files, and the red shelf is for things that are.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("d066-manifest");
        write_wav(&dir.join("ZOOM0001.WAV"), 0.5);
        fs::write(dir.join("DJI_0075.LRF"), b"proxy").unwrap();
        fs::write(dir.join("IMG_4164.HEIC"), b"photo").unwrap();

        let m = scan(&[dir], &sidecar, &NoProgress, &CancelToken::new()).unwrap();

        assert_eq!(m.files.len(), 1);
        assert!(m.unsynced.is_empty(), "got {:?}", m.unsynced);
        assert_eq!(m.skipped.len(), 2);
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["skipped"][0]["reason"], "sidecar");
        assert_eq!(json["skipped"][1]["reason"], "still_image");
    }

    #[test]
    fn a_manifest_written_before_the_skip_list_existed_still_deserialises() {
        // Why `SCHEMA_VERSION` does not move (D-066): `skipped` is additive, so v1 JSON
        // from any earlier build reads back as an empty list rather than a parse error.
        // If this ever stops holding, the field has become breaking and the version must.
        let json = r#"{"schema":1,"devices":[],"files":[],"unsynced":[]}"#;
        let m: ScanManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.schema, SCHEMA_VERSION);
        assert!(m.skipped.is_empty());
    }

    #[test]
    fn a_file_entry_written_before_the_time_ladder_existed_still_deserialises() {
        // D-067 applies D-066's test to its own two fields: `date_tag` and `modified_time`
        // are `#[serde(default)]`, so a manifest from any earlier build reads back with
        // both absent rather than failing — which is what keeps `SCHEMA_VERSION` at 1.
        let json = r#"{"schema":1,"devices":[],"unsynced":[],"files":[
            {"file":"/x/a.MP4","device":"cam-a","duration_seconds":1.0,
             "format_name":"mov,mp4","audio":null,"video":null,"creation_time":null}]}"#;
        let m: ScanManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.files.len(), 1);
        assert_eq!(m.files[0].date_tag, None);
        assert_eq!(m.files[0].modified_time, None);
    }

    #[test]
    fn a_new_manifest_still_reads_under_a_reader_that_ignores_the_new_fields() {
        // The other direction of "additive". Nothing here sets `deny_unknown_fields`, so an
        // older consumer of the scan JSON sees exactly the manifest it always did. Modelled
        // by deserialising into a struct that predates the two fields.
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct OldEntry {
            file: PathBuf,
            device: String,
            duration_seconds: f64,
            creation_time: Option<String>,
        }
        let mut m = manifest_for_overrides();
        m.files[0].date_tag = Some("2026-07-25".into());
        m.files[0].modified_time = Some("2026-07-25T14:12:08Z".into());
        let json = serde_json::to_string(&m).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let old: OldEntry = serde_json::from_value(value["files"][0].clone()).unwrap();
        assert_eq!(old.creation_time, None);
    }

    #[test]
    fn iso8601_utc_is_exact_at_the_days_that_break_naive_arithmetic() {
        // The epoch, a leap day, the century that is NOT a leap year (1900) and the one
        // that IS (2000), and a time before 1970 — the five places a hand-rolled civil
        // calendar goes wrong.
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(1), "1970-01-01T00:00:01Z");
        assert_eq!(iso8601_utc(-1), "1969-12-31T23:59:59Z");
        assert_eq!(iso8601_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601_utc(-2_208_988_800), "1900-01-01T00:00:00Z");
        // The measured mtime of the owner's `02106.MTS`: 2026-07-25T14:12:08 in CEST, and
        // therefore 12:12:08 in the UTC this function is contractually in.
        assert_eq!(iso8601_utc(1_784_981_528), "2026-07-25T12:12:08Z");
    }

    #[test]
    fn the_mtime_rung_is_a_stat_and_nothing_else() {
        // D-067: this rung exists because 136 of the owner's files carry no container tags
        // at all, so it must not cost a spawn. The signature is the assertion — there is no
        // `Sidecar` to hand it — and this pins the shape of what it answers.
        let dir = scratch("mtime-rung");
        let path = dir.join("not-media.txt");
        fs::write(&path, b"ffprobe would reject this").unwrap();
        let iso = modified_time_iso(&path).expect("a file that exists has an mtime");
        assert!(
            regex_lite_iso(&iso),
            "expected ISO-8601 UTC to the second, got {iso}"
        );
        assert_eq!(modified_time_iso(&dir.join("absent.txt")), None);
    }

    /// `YYYY-MM-DDTHH:MM:SSZ`, checked by shape — `core` has no regex dependency and is
    /// not about to grow one for a test.
    fn regex_lite_iso(s: &str) -> bool {
        let b = s.as_bytes();
        b.len() == 20
            && b[4] == b'-'
            && b[7] == b'-'
            && b[10] == b'T'
            && b[13] == b':'
            && b[16] == b':'
            && b[19] == b'Z'
            && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]
                .iter()
                .all(|&i| b[i].is_ascii_digit())
    }

    #[test]
    fn a_real_scan_carries_the_mtime_and_leaves_the_date_tag_alone() {
        // End to end: the two fields are populated by the scan itself, not merely present
        // on the struct. A generated WAV has no `date` tag, so `date_tag` is None — and
        // that is the honest answer, not a hole.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("scan-time-ladder");
        write_wav(&dir.join("C0001.WAV"), 0.5);
        let m = scan(&[dir], &sidecar, &NoProgress, &CancelToken::new()).unwrap();
        let entry = &m.files[0];
        assert!(
            entry.modified_time.as_deref().is_some_and(regex_lite_iso),
            "the scan must carry an ISO mtime, got {:?}",
            entry.modified_time
        );
        assert_eq!(entry.date_tag, None);
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
        let (found, _, _) = collect(
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

        let (found, _, _) = collect(
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

        let (found, _, _) = collect(&[dir], None, &NoProgress, &CancelToken::new()).unwrap();
        let names: Vec<String> = found
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect();
        // Sorted by full path, so the root's own file precedes the subdirectory's.
        assert_eq!(names, vec!["real.bin", "nested.bin"], "got {found:?}");
    }

    #[test]
    fn a_nonexistent_input_is_reported_not_dropped() {
        let (found, missing, _) = collect(
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
        let (found, _, _) =
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
        let (candidates, _, _) = collect(
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
        let (found, _, _) = collect(&[dir], None, &rec, &CancelToken::new()).unwrap();
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
            date_tag: None,
            modified_time: None,
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
            skipped: vec![],
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

    // ---- D-060: per-file exclusion --------------------------------------------------

    /// The override fixture plus a file on the unsynced shelf, which is the second bucket
    /// an exclusion has to empty.
    fn manifest_for_exclusions() -> ScanManifest {
        let mut m = manifest_for_overrides();
        m.unsynced.push(Unsynced {
            file: PathBuf::from("/x/broken.mp4"),
            reason: UnsyncedReason::DecodeError,
        });
        m
    }

    #[test]
    fn exclusion_removes_the_file_from_files_and_from_its_device() {
        let mut m = manifest_for_exclusions();
        apply_exclusions(&mut m, &[PathBuf::from("/x/C0001.MP4")]);

        assert!(
            !m.files.iter().any(|f| f.file.ends_with("C0001.MP4")),
            "an excluded file must not remain syncable"
        );
        let cam = m.devices.iter().find(|d| d.id == "cam-a").unwrap();
        assert_eq!(
            cam.files,
            vec![PathBuf::from("/x/C0002.MP4")],
            "and must not remain listed on its device"
        );
        // Everything else is untouched.
        assert_eq!(m.files.len(), 2);
        assert_eq!(m.unsynced.len(), 1);
    }

    #[test]
    fn exclusion_also_clears_the_unsynced_shelf() {
        // Excluding is "not part of this run", not "this failed": a file the user took out
        // must stop being reported as a problem, or the shelf would show a complaint about
        // material the run no longer contains.
        let mut m = manifest_for_exclusions();
        apply_exclusions(&mut m, &[PathBuf::from("/x/broken.mp4")]);

        assert!(m.unsynced.is_empty(), "the excluded failure must be gone");
        assert_eq!(m.files.len(), 3, "syncable files are untouched");
    }

    #[test]
    fn excluding_a_device_completely_drops_the_device() {
        let mut m = manifest_for_exclusions();
        apply_exclusions(&mut m, &[PathBuf::from("/x/ZOOM0001.WAV")]);

        assert!(
            !m.devices.iter().any(|d| d.id == "rec"),
            "a device left with no files must not keep a lane in the UI"
        );
        assert!(m.devices.iter().any(|d| d.id == "cam-a"));
    }

    #[test]
    fn a_stale_exclusion_is_ignored_and_an_empty_list_is_a_no_op() {
        // Same contract as `apply_device_overrides` (D-028): a path the scan never produced
        // — the user removed the input, or the folder moved — must not abort the run.
        let mut m = manifest_for_exclusions();
        let before = m.clone();

        apply_exclusions(&mut m, &[PathBuf::from("/gone/removed.mp4")]);
        assert_eq!(m, before, "a stale exclusion must change nothing");

        apply_exclusions(&mut m, &[]);
        assert_eq!(m, before, "the empty list is the untouched fast path");
    }

    #[test]
    fn exclusions_and_overrides_compose_in_pipeline_order() {
        // The pipeline excludes first, then re-groups (see `sync_with_durations`): an
        // override naming an excluded file is thereby a stale key, and ignored — which is
        // the honest outcome, since the file is not in the run to move.
        let mut m = manifest_for_exclusions();
        apply_exclusions(&mut m, &[PathBuf::from("/x/C0001.MP4")]);
        let mut ov = std::collections::BTreeMap::new();
        ov.insert(PathBuf::from("/x/C0001.MP4"), "rec".to_string());
        apply_device_overrides(&mut m, &ov);

        assert!(!m.files.iter().any(|f| f.file.ends_with("C0001.MP4")));
        let rec = m.devices.iter().find(|d| d.id == "rec").unwrap();
        assert_eq!(rec.files, vec![PathBuf::from("/x/ZOOM0001.WAV")]);
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
            // D-067's two rungs. Always written, like `skipped` — the `#[serde(default)]`
            // is about reading an older manifest, not about writing this one.
            "date_tag",
            "modified_time",
        ] {
            assert!(entry.get(key).is_some(), "missing key {key}");
        }
        assert!(entry["audio"].get("sample_rate").is_some());
        assert!(entry["video"].get("fps").is_some());
        // D-066's list is part of that same mirror, and it is always emitted — the
        // `#[serde(default)]` is about *reading* an older manifest, not about writing.
        assert!(
            json.get("skipped").is_some(),
            "the skip list is always written"
        );
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
        let mut out = Walked::default();
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
            out.files.len() <= 10,
            "the ceiling must bound `out`, found {}",
            out.files.len()
        );
    }

    #[test]
    fn a_scan_under_the_ceiling_is_unaffected() {
        // The guard must not trip on a normal shoot: exactly-at-limit is fine, over is not.
        let dir = scratch("scan-under-ceiling");
        for n in 0..8 {
            fs::write(dir.join(format!("f{n}.bin")), b"x").unwrap();
        }
        let mut out = Walked::default();
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
        assert_eq!(out.files.len(), 8);
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
        let mut out = Walked::default();
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
            out.files.len()
        );
        assert!(
            out.files.len() < 20_000,
            "the walk drained the whole directory instead of stopping early: {} entries",
            out.files.len()
        );
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "cancel did not return promptly: {:?}",
            start.elapsed()
        );
    }
}
