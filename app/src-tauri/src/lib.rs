//! SundaySync desktop shell — docs/PLAN.md §9.
//!
//! Deliberately thin. Every decision worth testing lives in `sundaysync-core`, which has
//! no Tauri dependency and runs headlessly in CI (§3). This crate does three things:
//! move work off the UI thread, translate progress into events, and hand results to the
//! frontend as JSON.

mod telemetry;

use serde::Serialize;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use sundaysync_core::{
    export_fcpxml_with_options, sync_with_durations, CancelToken, ExportOptions, Progress,
    ProgressSink, Sidecar, SidecarSource, Stage, SyncRequest, SyncResult, DEFAULT_MIN_PSR,
};
use tauri::{AppHandle, Emitter, Manager, State};

/// Where the bundled ffmpeg/ffprobe live, if this build has them.
///
/// Tauri 2 places `externalBin` sidecars **next to the app executable** and strips the
/// target-triple suffix at bundle time, so `binaries/ffmpeg-aarch64-apple-darwin` in the
/// source tree becomes `SundaySync.app/Contents/MacOS/ffmpeg` in the product.
///
/// Returns `None` when they are simply not there, which is the normal `tauri dev` case —
/// nothing is fetched into `target/debug/`, and the PATH route covers development. Silent
/// on purpose: an error log for the expected case trains people to ignore the log.
fn bundled_pair() -> Option<(PathBuf, PathBuf)> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let ffmpeg = dir.join(format!("ffmpeg{ext}"));
    let ffprobe = dir.join(format!("ffprobe{ext}"));
    (ffmpeg.is_file() && ffprobe.is_file()).then_some((ffmpeg, ffprobe))
}

/// Resolution order, D-031: **bundled → PATH → the GUI-invisible fallback dirs.**
///
/// The last two are the engine's own [`Sidecar::from_path`]; only the first is the
/// shell's business, because only the shell knows where its own executable is (D-023
/// keeps the engine Tauri-free, so it cannot look).
fn resolve_sidecar() -> Result<Sidecar, String> {
    if let Some((ffmpeg, ffprobe)) = bundled_pair() {
        match Sidecar::verified(ffmpeg, ffprobe) {
            Ok(sidecar) => return Ok(sidecar),
            Err(e) => {
                // Present but unusable — quarantined, truncated, wrong architecture.
                // Worth saying out loud, unlike the absent case above.
                eprintln!("bundled ffmpeg is unusable ({e}); falling back to the system one");
            }
        }
    }
    Sidecar::from_path().map_err(|e| e.to_string())
}

/// Progress as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
struct ProgressEvent {
    stage: String,
    completed: usize,
    total: usize,
}

/// Bridges the engine's progress callback onto Tauri's event bus.
///
/// §10 asks for events throttled to 10 Hz, and doing it here rather than in the engine is
/// deliberate: the engine reports everything and does not second-guess its consumer, so
/// the CLI can still log every event (see `progress.rs`).
struct EventSink {
    app: AppHandle,
    /// Which event channel this sink publishes on — `sync:progress` for the pipeline,
    /// `scan:progress` for the pre-sync preview, so the frontend can tell them apart.
    channel: &'static str,
    last: Mutex<std::time::Instant>,
    last_stage: Mutex<Option<Stage>>,
}

impl EventSink {
    fn new(app: AppHandle, channel: &'static str) -> Self {
        Self {
            app,
            channel,
            last: Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(1)),
            last_stage: Mutex::new(None),
        }
    }
}

impl ProgressSink for EventSink {
    fn report(&self, p: Progress) {
        // Always let a stage change through, even inside the throttle window: the stage
        // name is what the user is reading, and dropping the transition would leave the
        // label stale until the next tick.
        let stage_changed = self
            .last_stage
            .lock()
            .map(|mut s| {
                let changed = *s != Some(p.stage);
                *s = Some(p.stage);
                changed
            })
            .unwrap_or(true);

        if !stage_changed {
            let Ok(mut last) = self.last.lock() else {
                return;
            };
            if last.elapsed() < std::time::Duration::from_millis(100) {
                return;
            }
            *last = std::time::Instant::now();
        }

        let _ = self.app.emit(
            self.channel,
            ProgressEvent {
                stage: format!("{:?}", p.stage),
                completed: p.completed,
                total: p.total,
            },
        );
    }
}

/// What a command does when it finds an [`AppState`] mutex poisoned by a prior panic
/// (docs/DECISIONS.md D-036). Every command acquires its locks through [`lock_state`] with
/// one of these, so poison behaviour is uniform instead of the F1 mix where `cancel_sync`
/// silently no-opped while `export_*` errored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OnPoison {
    /// Recover the guard via [`std::sync::PoisonError::into_inner`]. Safe for the cancel
    /// token slot, the scan-cancel slot and the sidecar cache: a torn `Option<_>` there
    /// still holds a value that is fine to read or replace, and — the F1 headline — the
    /// one safety control (Cancel) must never be silently disabled because some earlier
    /// thread happened to panic.
    Recover,
    /// Refuse with an error. Used for the `LastRun` slot, where a half-written result must
    /// never be handed to export as if it were a finished run.
    Reject,
}

/// The single lock-acquisition helper (D-036). See [`OnPoison`] for the policy.
pub(crate) fn lock_state<T>(
    slot: &Mutex<T>,
    on_poison: OnPoison,
) -> Result<MutexGuard<'_, T>, String> {
    match slot.lock() {
        Ok(guard) => Ok(guard),
        Err(poisoned) => match on_poison {
            OnPoison::Recover => Ok(poisoned.into_inner()),
            OnPoison::Reject => Err("internal state was poisoned".to_string()),
        },
    }
}

/// Message an export refusal starts with when the sources no longer match the stored run
/// (F6). A stable prefix so `errors.ts` can localise it (D-030) the way it does the
/// engine's own Display strings.
const STALE_EXPORT_MSG: &str =
    "the sources changed since this timeline was synced — run the sync again before exporting";

/// A cheap, deterministic fingerprint of everything that makes a sync result stale (F6):
/// the source set (order- and duplicate-independent), the manual device overrides, and the
/// chosen reference. Mirrors exactly the frontend's `stale` triggers (inputs / overrides /
/// reference — see `state.ts`), so a UI that shows a fresh result and a backend that agrees
/// it is fresh compute the same number.
///
/// `DefaultHasher` is fine here despite its "not stable across Rust versions" caveat: the
/// stored fingerprint and the one `export_timeline` compares it against are produced by the
/// *same* binary in the same session, never persisted or compared across builds.
fn inputs_fingerprint(
    inputs: &[PathBuf],
    overrides: &BTreeMap<PathBuf, String>,
    reference: Option<&Path>,
) -> u64 {
    let mut sorted: Vec<&PathBuf> = inputs.iter().collect();
    sorted.sort();
    sorted.dedup();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    sorted.hash(&mut hasher);
    overrides.hash(&mut hasher); // BTreeMap hashes its entries in key order — deterministic.
    reference.hash(&mut hasher);
    hasher.finish()
}

/// The last successful run, kept so export can happen without re-syncing.
struct LastRun {
    result: SyncResult,
    durations: BTreeMap<PathBuf, f64>,
    /// Fingerprint of the sources that produced this run ([`inputs_fingerprint`]). Export
    /// refuses when the caller's current sources hash to something else (F6).
    inputs_hash: u64,
    /// E6 (D-042): whether this run's export should apply drift correction. Captured at
    /// sync time so a later export uses the same setting the run was made under.
    correct_drift: bool,
}

/// Shared cancellation handle, so the UI's Cancel button can reach a run in flight.
#[derive(Default)]
struct AppState {
    cancel: Arc<Mutex<Option<CancelToken>>>,
    /// The pre-sync scan gets its own slot: a re-scan supersedes the previous one
    /// (the UI auto-scans on every input change), and cancelling a scan must never
    /// touch a sync in flight. The token is wrapped in its own `Arc` so a finishing scan
    /// can prove the slot still holds *its* token before clearing it (F3, `Arc::ptr_eq`).
    scan_cancel: Arc<Mutex<Option<Arc<CancelToken>>>>,
    last: Arc<Mutex<Option<LastRun>>>,
    /// The ffmpeg/ffprobe pair every command decodes with, resolved once at startup
    /// (D-031). `None` means resolution failed — a user who installs ffmpeg while the
    /// app is open gets a fresh attempt from `check_sidecar` without restarting.
    sidecar: Arc<Mutex<Option<Sidecar>>>,
    /// D-046 (night review B-9): cache maintenance and a running sync must not overlap.
    /// The eviction sweeps spare in-flight `.tmp` scratch files but can evict a
    /// COMMITTED entry the running sync has already checked `contains()` on — `place`
    /// then dies with an `Io` error naming a cache path, for media that is fine. One
    /// activity slot makes the two mutually exclusive; the loser gets an honest
    /// "busy" error instead of the engine getting a vanishing cache.
    activity: Arc<Mutex<Activity>>,
}

/// What the app is busy doing, for the D-046 mutual exclusion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Activity {
    #[default]
    Idle,
    Syncing,
    Maintaining,
}

/// RAII guard: holds the activity slot at `Syncing`/`Maintaining`, restores `Idle` on
/// drop — every early `?` return included.
struct ActivityGuard {
    slot: Arc<Mutex<Activity>>,
}

impl ActivityGuard {
    /// Claims the slot for `want`, or returns a stable, prefix-matchable error naming
    /// what the app is busy with (D-030 style: the frontend maps the prefix).
    fn begin(slot: &Arc<Mutex<Activity>>, want: Activity) -> Result<Self, String> {
        let mut guard = lock_state(slot, OnPoison::Recover)?;
        match *guard {
            Activity::Idle => {
                *guard = want;
                Ok(Self {
                    slot: Arc::clone(slot),
                })
            }
            Activity::Syncing => Err("busy: sync in progress".to_string()),
            Activity::Maintaining => Err("busy: cache maintenance in progress".to_string()),
        }
    }
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = lock_state(&self.slot, OnPoison::Recover) {
            *guard = Activity::Idle;
        }
    }
}

impl AppState {
    /// The stored sidecar, resolving and caching it if startup could not.
    fn sidecar(&self) -> Result<Sidecar, String> {
        if let Ok(slot) = lock_state(&self.sidecar, OnPoison::Recover) {
            if let Some(sidecar) = slot.as_ref() {
                return Ok(sidecar.clone());
            }
        }
        let resolved = resolve_sidecar()?;
        if let Ok(mut slot) = lock_state(&self.sidecar, OnPoison::Recover) {
            *slot = Some(resolved.clone());
        }
        Ok(resolved)
    }

    /// Installs the cancel token for a run about to start.
    fn set_cancel(&self, token: CancelToken) {
        if let Ok(mut slot) = lock_state(&self.cancel, OnPoison::Recover) {
            *slot = Some(token);
        }
    }

    /// Drops the cancel token once a run has finished (or failed).
    fn clear_cancel(&self) {
        if let Ok(mut slot) = lock_state(&self.cancel, OnPoison::Recover) {
            *slot = None;
        }
    }

    /// Fires the in-flight run's cancel token. F1: recovers a poisoned lock rather than
    /// silently no-opping — a poisoned `AppState` must not disable the one safety control.
    fn request_cancel(&self) {
        if let Ok(slot) = lock_state(&self.cancel, OnPoison::Recover) {
            if let Some(token) = slot.as_ref() {
                token.cancel();
            }
        }
    }

    /// Installs a fresh scan-cancel token, cancelling and superseding any previous scan.
    /// Returns the owning `Arc` so the caller can later prove ownership of the slot (F3).
    fn install_scan_cancel(&self) -> Arc<CancelToken> {
        let token = Arc::new(CancelToken::new());
        if let Ok(mut slot) = lock_state(&self.scan_cancel, OnPoison::Recover) {
            if let Some(previous) = slot.replace(token.clone()) {
                previous.cancel();
            }
        }
        token
    }

    /// Clears the scan-cancel slot **only if it still holds `mine`** (F3). Checking identity
    /// under the lock closes the TOCTOU window where a late-finishing scan cleared a newer
    /// scan's token and left the newer run uncancellable.
    fn clear_scan_cancel_if_ours(&self, mine: &Arc<CancelToken>) {
        if let Ok(mut slot) = lock_state(&self.scan_cancel, OnPoison::Recover) {
            if slot
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, mine))
            {
                *slot = None;
            }
        }
    }

    /// Stores a freshly completed run. Recovers a poisoned lock and overwrites wholesale
    /// (the old value is being replaced by good data anyway), then clears the poison so the
    /// [`OnPoison::Reject`] read path in export works again after a healthy sync.
    fn store_last(&self, run: LastRun) {
        if let Ok(mut slot) = lock_state(&self.last, OnPoison::Recover) {
            *slot = Some(run);
        }
        self.last.clear_poison();
    }

    /// Snapshot of the last run for export, guarded by the F6 inputs fingerprint. Errors
    /// cleanly on a poisoned lock (`Reject`), on an empty slot, or on a source mismatch.
    fn export_snapshot(
        &self,
        fingerprint: u64,
    ) -> Result<(SyncResult, BTreeMap<PathBuf, f64>, bool), String> {
        let guard = lock_state(&self.last, OnPoison::Reject)?;
        let last = guard
            .as_ref()
            .ok_or_else(|| "nothing has been synced yet".to_string())?;
        if last.inputs_hash != fingerprint {
            return Err(STALE_EXPORT_MSG.to_string());
        }
        Ok((
            last.result.clone(),
            last.durations.clone(),
            last.correct_drift,
        ))
    }
}

#[derive(Debug, Clone, Serialize)]
struct SyncOutcome {
    result: SyncResult,
    /// Per-file duration in seconds. Forwarding this is what gives the result view
    /// real proportional clip widths instead of the gap-to-next-clip guess the first
    /// build shipped with. Serialises as `{ "/abs/path": 123.4 }`.
    durations: BTreeMap<PathBuf, f64>,
}

/// The frontend's sync request, exactly as `invoke("run_sync", …)` sends it.
///
/// One struct argument rather than eight parameters: Tauri deserialises it from the
/// same camelCased object either way, and clippy is right that eight positional
/// arguments is how call sites quietly transpose two of them.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunSyncArgs {
    inputs: Vec<PathBuf>,
    #[serde(default)]
    min_psr: Option<f64>,
    #[serde(default)]
    cache_dir: Option<PathBuf>,
    #[serde(default)]
    reference: Option<PathBuf>,
    #[serde(default)]
    device_overrides: Option<BTreeMap<PathBuf, String>>,
    #[serde(default)]
    segment_count: Option<usize>,
    /// E6 (D-042): drift correction. `None` uses the engine default (on). The export
    /// emits a `<timeMap>` only for clips whose drift exceeds half a frame, so this
    /// governs whether that correction is applied at all.
    #[serde(default)]
    correct_drift: Option<bool>,
}

/// Runs a full sync. Blocking, so the frontend calls it off the UI thread.
#[tauri::command(async)]
fn run_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    args: RunSyncArgs,
) -> Result<SyncOutcome, String> {
    // D-046: claim the activity slot first — a maintenance conflict should surface
    // before any state is touched. The guard restores Idle on every return path.
    let _activity = ActivityGuard::begin(&state.activity, Activity::Syncing)?;

    // Resolved before the token is installed: a missing ffmpeg should not leave a cancel
    // handle pointing at a run that never started.
    let sidecar = state.sidecar()?;

    let cancel = CancelToken::new();
    state.set_cancel(cancel.clone());

    let defaults = SyncRequest::new(Vec::new());
    let request = SyncRequest {
        inputs: args.inputs,
        cache_dir: args.cache_dir,
        reference_override: args.reference,
        // Night review (A, out-of-area): an unvalidated min_psr is the acceptance
        // gate's off switch — a negative value admits EVERY clip at zero confidence,
        // and NaN refuses everything silently. Only a positive finite value is a
        // threshold; anything else falls back to the calibrated default (D-015).
        min_psr: args
            .min_psr
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(DEFAULT_MIN_PSR),
        device_overrides: args.device_overrides.unwrap_or_default(),
        segment_count: args.segment_count.unwrap_or(defaults.segment_count),
        correct_drift: args.correct_drift.unwrap_or(defaults.correct_drift),
        sidecar: Some(sidecar),
    };

    // F6: the fingerprint of the sources that produced this run, stored with the result so
    // export can refuse a mismatched later request. Computed before the request is moved.
    let inputs_hash = inputs_fingerprint(
        &request.inputs,
        &request.device_overrides,
        request.reference_override.as_deref(),
    );

    let correct_drift = request.correct_drift;
    let sink = EventSink::new(app.clone(), "sync:progress");
    let started = std::time::Instant::now();
    let outcome = sync_with_durations(&request, &sink, &cancel);
    let run_millis = started.elapsed().as_millis();

    state.clear_cancel();

    match outcome {
        Ok((result, durations)) => {
            state.store_last(LastRun {
                result: result.clone(),
                durations: durations.clone(),
                inputs_hash,
                correct_drift,
            });
            // E7: record this completed run as anonymous, bucketed telemetry
            // (queued and sent only under active consent).
            telemetry::after_sync(
                &app,
                &telemetry::RunFacts {
                    result: &result,
                    run_millis,
                    drift_correction_enabled: correct_drift,
                },
            );
            Ok(SyncOutcome { result, durations })
        }
        Err(e) => {
            // E7: a failed run is an error class worth counting — scrubbed, local
            // until a consented drain picks it up.
            telemetry::record_sync_error(&e.to_string());
            Err(e.to_string())
        }
    }
}

/// Probe-only preview of a set of inputs — devices, files with metadata, and anything
/// unusable — without decoding a single sample. This is what lets the sources view show
/// the §9.2 device summary *before* the user commits to a sync.
///
/// A new call supersedes any scan still running (the UI re-scans on every input
/// change); the superseded call returns `cancelled`, which the frontend ignores unless
/// it belongs to the latest request.
#[tauri::command(async)]
fn scan_inputs(
    app: AppHandle,
    state: State<'_, AppState>,
    inputs: Vec<PathBuf>,
    cache_dir: Option<PathBuf>,
) -> Result<sundaysync_core::ScanManifest, String> {
    let sidecar = state.sidecar()?;

    let cancel = state.install_scan_cancel();

    // Exclude the cache exactly as the pipeline does (D-020) — a user-configured cache
    // inside a dropped folder must not appear as broken media in the preview either.
    let exclude = cache_dir.or_else(|| sundaysync_core::Cache::default_dir().ok());

    let sink = EventSink::new(app, "scan:progress");
    let outcome =
        sundaysync_core::scan::scan_detailed(&inputs, &sidecar, exclude.as_deref(), &sink, &cancel);

    // F3: clear the slot only if it still holds OUR token, checked under the lock via
    // `Arc::ptr_eq`. A newer scan may already have replaced it; clearing that would orphan
    // the newer run's cancel button and leave it uncancellable.
    state.clear_scan_cancel_if_ours(&cancel);

    outcome
        .map(|(manifest, _)| manifest)
        .map_err(|e| e.to_string())
}

/// Cache statistics for the settings screen (D-013: the cache grows ~169 MB per
/// audio-hour and nothing evicts it — the user deserves to see the number).
#[derive(Debug, Clone, Serialize)]
struct CacheStatus {
    dir: PathBuf,
    entries: usize,
    bytes: u64,
}

#[tauri::command]
fn cache_status(dir: Option<PathBuf>) -> Result<CacheStatus, String> {
    let dir = match dir {
        Some(d) => d,
        None => sundaysync_core::Cache::default_dir().map_err(|e| e.to_string())?,
    };
    let cache = sundaysync_core::Cache::new(dir.clone());
    Ok(CacheStatus {
        dir,
        entries: cache.entry_count().map_err(|e| e.to_string())?,
        bytes: cache.size_bytes().map_err(|e| e.to_string())?,
    })
}

/// Clears the analysis cache, returning bytes freed. Foreign files are spared — the
/// engine never deletes what it did not write.
#[tauri::command]
fn clear_cache(state: State<'_, AppState>, dir: Option<PathBuf>) -> Result<u64, String> {
    // D-046: clearing evicts committed entries a running sync may be about to load.
    let _activity = ActivityGuard::begin(&state.activity, Activity::Maintaining)?;
    let dir = match dir {
        Some(d) => d,
        None => sundaysync_core::Cache::default_dir().map_err(|e| e.to_string())?,
    };
    sundaysync_core::Cache::new(dir)
        .clear()
        .map_err(|e| e.to_string())
}

/// Result of a cache eviction pass, for the settings screen (D-040).
#[derive(Debug, Clone, Serialize)]
struct EvictionResult {
    entries: usize,
    bytes: u64,
}

impl From<sundaysync_core::Evicted> for EvictionResult {
    fn from(e: sundaysync_core::Evicted) -> Self {
        Self {
            entries: e.entries,
            bytes: e.bytes,
        }
    }
}

/// D-040: cache entries untouched longer than this are swept on app start. The analysis
/// cache is regenerable, so age eviction is non-destructive — a swept shoot cold-decodes
/// if it is ever re-synced. Ninety days is the conductor-approved default.
const DEFAULT_SWEEP_AGE: std::time::Duration = std::time::Duration::from_secs(90 * 24 * 60 * 60);

/// Sweeps cache entries older than `max_age_days` (90 when omitted). D-040. Exposed to the
/// settings screen so the user can trigger it and see the freed number; the same sweep
/// also runs automatically at startup.
#[tauri::command]
fn sweep_cache(
    state: State<'_, AppState>,
    dir: Option<PathBuf>,
    max_age_days: Option<u64>,
) -> Result<EvictionResult, String> {
    let _activity = ActivityGuard::begin(&state.activity, Activity::Maintaining)?;
    let dir = match dir {
        Some(d) => d,
        None => sundaysync_core::Cache::default_dir().map_err(|e| e.to_string())?,
    };
    let age = max_age_days.map_or(DEFAULT_SWEEP_AGE, |d| {
        std::time::Duration::from_secs(d * 24 * 60 * 60)
    });
    sundaysync_core::Cache::new(dir)
        .sweep_older_than(age)
        .map(EvictionResult::from)
        .map_err(|e| e.to_string())
}

/// Evicts least-recently-modified entries until the cache is under `max_bytes` (D-040).
/// Only called when the user has enabled the size cap in Settings — it is off by default.
#[tauri::command]
fn enforce_cache_cap(
    state: State<'_, AppState>,
    dir: Option<PathBuf>,
    max_bytes: u64,
) -> Result<EvictionResult, String> {
    let _activity = ActivityGuard::begin(&state.activity, Activity::Maintaining)?;
    let dir = match dir {
        Some(d) => d,
        None => sundaysync_core::Cache::default_dir().map_err(|e| e.to_string())?,
    };
    sundaysync_core::Cache::new(dir)
        .enforce_size_cap(max_bytes)
        .map(EvictionResult::from)
        .map_err(|e| e.to_string())
}

/// §7.4: cancel must take effect within 2 s. The engine kills in-flight ffmpeg children,
/// so this returns immediately and the run unwinds on its own.
#[tauri::command]
fn cancel_sync(state: State<'_, AppState>) {
    // F1: routed through the poison-recovering helper so a poisoned `AppState` — a prior
    // thread panicking mid-update — can no longer silently disable Cancel.
    state.request_cancel();
}

/// Validates a frontend-supplied export path before the engine writes to it (S-5,
/// docs/DECISIONS.md D-032).
///
/// **IPC arguments are trust-boundary data.** The frontend is normally driven by the OS
/// save dialog, but that dialog is a convention, not an enforced guard — a malformed or
/// hostile `invoke` can pass any path, and the export commands do a raw `fs::write` on it.
/// This is the defense-in-depth behind the CSP (S-4): reject a target that is an existing
/// directory (the write would otherwise fail confusingly), and — where an extension is
/// required — reject a target that lacks it, so `export_timeline` cannot be steered into
/// overwriting an unrelated file that merely happens to be writable.
fn validate_export_path(path: &Path, required_ext: Option<&str>) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("no export path was given".into());
    }
    if path.is_dir() {
        return Err(format!(
            "{} is a directory, not a file to write",
            path.display()
        ));
    }
    if let Some(ext) = required_ext {
        let ok = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case(ext));
        if !ok {
            return Err(format!("the export path must end in .{ext}"));
        }
    }
    Ok(())
}

/// Writes the FCPXML for the most recent successful sync.
///
/// F6: the frontend already hides export behind `phase.stale`, but that is a UI convention,
/// not a guard — a hostile or buggy `invoke` could export a previous run's timeline after
/// the sources changed. The caller passes its *current* sources; we refuse if they no longer
/// fingerprint to the run that is stored. `inputs`/`reference`/`overrides` mirror the same
/// three staleness triggers the frontend tracks (`state.ts`).
#[tauri::command]
fn export_timeline(
    state: State<'_, AppState>,
    path: PathBuf,
    project: Option<String>,
    inputs: Vec<PathBuf>,
    reference: Option<PathBuf>,
    device_overrides: Option<BTreeMap<PathBuf, String>>,
) -> Result<usize, String> {
    // S-5: the path is untrusted IPC input — validate before writing.
    validate_export_path(&path, Some("fcpxml"))?;

    let fingerprint = inputs_fingerprint(
        &inputs,
        &device_overrides.unwrap_or_default(),
        reference.as_deref(),
    );
    let (result, durations, correct_drift) = state.export_snapshot(fingerprint)?;

    let export = export_fcpxml_with_options(
        &result,
        &durations,
        project.as_deref().unwrap_or("SundaySync"),
        ExportOptions { correct_drift },
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(&path, export.xml).map_err(|e| e.to_string())?;
    Ok(export.clips.len())
}

/// Reduces a [`SyncResult`] to a support-safe form (S-6, docs/DECISIONS.md D-032).
///
/// The raw result leaks three kinds of personal data the E7 telemetry rule forbids
/// ("never filenames/paths/labels"): every `file` is an absolute path (→ the macOS
/// username under `/Users/…`), and every device `label` is a human name §4.5 may have
/// derived from a folder — often the church or service. This collapses each path to its
/// bare filename and drops each label to its neutral id (e.g. `folder-balkong`, the
/// non-PII handle §4.5/D-028 already use). The numbers a support reply actually needs —
/// offsets, confidences, PSR, drift, reasons — are untouched.
fn scrub_result(result: &SyncResult) -> SyncResult {
    fn base(p: &Path) -> PathBuf {
        p.file_name()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("<clip>"))
    }
    let mut r = result.clone();
    if let Some(reference) = r.reference.as_mut() {
        reference.file = base(&reference.file);
    }
    for device in &mut r.devices {
        device.label = device.id.clone();
        for f in &mut device.files {
            *f = base(f);
        }
    }
    for p in &mut r.placements {
        p.file = base(&p.file);
    }
    for u in &mut r.unsynced {
        u.file = base(&u.file);
    }
    r
}

/// §7.6: a diagnostics bundle safe to hand to support.
///
/// Writes the run's shape and this machine's environment as one JSON file — no media, and
/// (S-6) no personal identifiers. Every absolute path is reduced to a bare filename by
/// [`scrub_result`], every device's human label is dropped to its id, and the ffmpeg
/// binary's absolute path — which on a bundled build embeds the macOS username — is
/// omitted, leaving only whether it was the bundled or the system one. Deliberately not a
/// zip: a support bundle someone hesitates to send is worth nothing, so there is nothing
/// in it to hesitate about.
#[tauri::command]
fn export_diagnostics(state: State<'_, AppState>, path: PathBuf) -> Result<(), String> {
    // S-5: the path is untrusted IPC input — validate before writing.
    validate_export_path(&path, None)?;

    let guard = lock_state(&state.last, OnPoison::Reject)?;

    // S-6: source only. The absolute ffmpeg/ffprobe paths are dropped — a bundled build's
    // path runs through the user's home directory and would leak the username.
    let ffmpeg_source = match state.sidecar() {
        Ok(s) => source_word(s.source).to_string(),
        Err(_) => "none".to_string(),
    };

    let report = serde_json::json!({
        "app": env!("CARGO_PKG_VERSION"),
        "schema": sundaysync_core::SCHEMA_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "ffmpeg_source": ffmpeg_source,
        "default_min_psr": DEFAULT_MIN_PSR,
        "default_segment_count": sundaysync_core::correlate::SEGMENT_COUNT,
        "analysis_rate": sundaysync_core::ANALYSIS_RATE,
        "result": guard.as_ref().map(|l| scrub_result(&l.result)),
    });

    std::fs::write(
        &path,
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// What the onboarding self-test reports: which ffmpeg is in use, and from where.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarStatus {
    /// `"bundled"` or `"system"`.
    source: String,
    /// Absolute path to the ffmpeg binary, so the honest answer is showable.
    path: String,
}

fn source_word(source: SidecarSource) -> &'static str {
    match source {
        SidecarSource::Bundled => "bundled",
        SidecarSource::System => "system",
    }
}

/// Whether ffmpeg is reachable, so the UI can say so before the user drops 40 GB of media.
///
/// **Re-resolves on every call** rather than reading the cached value: onboarding's "check
/// again" button exists precisely for the user who installs ffmpeg while the app is open,
/// and a cached failure would make that button lie. The freshly resolved pair replaces
/// what the state holds, so the next sync uses what the check just proved.
#[tauri::command]
fn check_sidecar(state: State<'_, AppState>) -> Result<SidecarStatus, String> {
    let resolved = resolve_sidecar()?;
    if let Ok(mut slot) = lock_state(&state.sidecar, OnPoison::Recover) {
        *slot = Some(resolved.clone());
    }
    Ok(SidecarStatus {
        source: source_word(resolved.source).to_string(),
        path: resolved.ffmpeg.display().to_string(),
    })
}

/// The engine's default cache location, for advanced mode to display.
#[tauri::command]
fn default_cache_dir() -> Result<PathBuf, String> {
    sundaysync_core::Cache::default_dir().map_err(|e| e.to_string())
}

// ── E9: in-app auto-updater (docs/V02-PROGRAM.md E9) ────────────────────────
//
// Mirrors SundayRec's proven updater, adapted to SundaySync's DB-free world: the
// release channel is not read from a database here. The frontend owns the
// `betaChannel` setting (localStorage, see settings.ts) and passes `beta` on every
// call, so this layer stays a thin, stateless bridge over `tauri-plugin-updater`.
// Terminal states are returned directly; the transient "checking"/"downloading"
// UI states the renderer drives itself (it listens to `update:progress` for the
// live download percent), matching how the sync pipeline already reports progress.

/// Base URL of the Sunday Suite update feed.
///
/// `option_env!` reads the environment at COMPILE time: the value baked in when the
/// binary was built is the only one it will ever use. A plain release ships the
/// production Worker; a build aimed at the local E2E ring sets `SUNDAYSYNC_UPDATE_BASE`
/// at build time. Setting it in the *running* app does nothing — this has caught
/// people on the sibling app before, which is why it says so out loud.
fn update_base() -> &'static str {
    option_env!("SUNDAYSYNC_UPDATE_BASE").unwrap_or("https://updates.sundaysuite.app")
}

/// The feed URL for one ring: `{base}/v1/update/sundaysync/{stable|beta}`.
///
/// PRIVACY (mirrors SundayRec exactly): the path carries no `{{current_version}}`,
/// target or arch — nothing about this install leaks in the URL. It is the
/// **app-scoped** route (`/sundaysync/…`), deliberately NOT SundayRec's frozen
/// `/v1/update/{channel}` alias.
fn channel_feed_url(base: &str, beta: bool) -> String {
    let channel = if beta { "beta" } else { "stable" };
    format!("{base}/v1/update/sundaysync/{channel}")
}

/// Clamped download percentage for the progress event. `total == 0` (the server
/// sent no `Content-Length`) reads as 0 rather than dividing by zero.
fn update_percent(downloaded: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    (downloaded.saturating_mul(100) / total).min(100) as u8
}

/// The update phases the renderer renders. Serialised tagged so the frontend gets a
/// discriminated union (`{ phase: "available", version: "0.2.0" }`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
enum UpdateStatus {
    /// This build is current — includes the 204/paused-ring "nothing promoted" case.
    UpToDate,
    /// A newer signed release is offered on the chosen ring.
    Available { version: String },
    /// Downloaded + staged; the app must relaunch to apply it.
    ReadyToInstall { version: String },
    /// The check or download failed (network, signature, feed). Carries a message.
    Error { message: String },
}

/// Download-progress payload for the `update:progress` event.
#[derive(Debug, Clone, Serialize)]
struct UpdateProgress {
    version: String,
    percent: u8,
}

/// An updater pointed at exactly one ring's feed.
///
/// The endpoint is set here, at run time, rather than taken from `tauri.conf.json`:
/// the ring is a per-machine setting and the config is baked into the bundle, so a
/// config-only feed could never follow the beta toggle. There is deliberately **no
/// fallback to any other feed** when the Worker is unreachable — the one scenario the
/// Worker exists for is "stop serving this version to everyone", and a client that
/// quietly asked elsewhere would fetch precisely the build the kill-switch was pulled
/// for. A check that cannot reach the Worker surfaces as a failed check.
fn build_updater(app: &AppHandle, beta: bool) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;

    let feed = channel_feed_url(update_base(), beta);
    let url = tauri::Url::parse(&feed).map_err(|e| format!("update feed url {feed}: {e}"))?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("updater endpoint {feed}: {e}"))?
        .build()
        .map_err(|e| format!("updater init: {e}"))
}

/// Check the chosen ring for a newer signed release.
///
/// Dev builds short-circuit to `upToDate` so a developer never sees a feed error from
/// `tauri dev` (there is no signed release to update to). The plugin's `check()` does
/// the semver comparison itself and only yields `Some` when the feed is genuinely
/// newer; a 204 (nothing promoted, or a paused ring — the kill-switch) becomes
/// `Ok(None)`, i.e. "nothing to update to", not an error the user has to interpret.
#[tauri::command]
async fn update_check(app: AppHandle, beta: bool) -> Result<UpdateStatus, String> {
    if cfg!(debug_assertions) {
        return Ok(UpdateStatus::UpToDate);
    }
    let updater = build_updater(&app, beta)?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateStatus::Available {
            version: update.version.clone(),
        }),
        Ok(None) => Ok(UpdateStatus::UpToDate),
        Err(e) => Ok(UpdateStatus::Error {
            message: e.to_string(),
        }),
    }
}

/// Download + install the pending update, emitting `update:progress` as the bytes
/// stream in, and leave the status at `readyToInstall`. The renderer then offers
/// "restart & install" (`update_relaunch`).
///
/// The ring is re-resolved from the passed `beta` rather than carried over from the
/// check: the user may have toggled the channel between the check and the click, and
/// the download must come from the ring they are on NOW.
#[tauri::command]
async fn update_download_install(app: AppHandle, beta: bool) -> Result<UpdateStatus, String> {
    use std::sync::atomic::{AtomicU64, Ordering};

    if cfg!(debug_assertions) {
        return Ok(UpdateStatus::UpToDate);
    }
    let updater = build_updater(&app, beta)?;
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return Ok(UpdateStatus::UpToDate),
        Err(e) => {
            return Ok(UpdateStatus::Error {
                message: e.to_string(),
            })
        }
    };

    let version = update.version.clone();
    // `on_download` is `Fn` (not `FnMut`), so the running total lives in an atomic.
    let downloaded = Arc::new(AtomicU64::new(0));
    let app_for_progress = app.clone();
    let ver_for_progress = version.clone();
    let result = update
        .download_and_install(
            move |chunk_len, content_length| {
                let total = content_length.unwrap_or(0);
                let so_far =
                    downloaded.fetch_add(chunk_len as u64, Ordering::SeqCst) + chunk_len as u64;
                let _ = app_for_progress.emit(
                    "update:progress",
                    UpdateProgress {
                        version: ver_for_progress.clone(),
                        percent: update_percent(so_far, total),
                    },
                );
            },
            || {},
        )
        .await;

    match result {
        Ok(()) => Ok(UpdateStatus::ReadyToInstall { version }),
        Err(e) => Ok(UpdateStatus::Error {
            message: e.to_string(),
        }),
    }
}

/// Relaunch the app so a staged update takes effect.
///
/// On macOS `app.restart()` does not actually restart (rig-verified on the sibling
/// app: the bundle is replaced but the old process keeps running), so a detached
/// helper re-opens the updated bundle once we exit via the normal path. Every other
/// platform uses `app.restart()`.
#[tauri::command]
fn update_relaunch(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        // current_exe = <bundle>.app/Contents/MacOS/<bin> → the .app is 3 up.
        let bundle = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.ancestors().nth(3).map(PathBuf::from))
            .filter(|p| p.extension().is_some_and(|e| e == "app"));
        if let Some(bundle) = bundle {
            let quoted = format!("'{}'", bundle.to_string_lossy().replace('\'', r"'\''"));
            let script = format!("sleep 0.7; open -n {quoted}");
            if std::process::Command::new("/bin/sh")
                .args(["-c", &script])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .is_ok()
            {
                app.exit(0);
                return;
            }
            // Helper spawn failed — fall through to restart() (worse odds, not none).
        }
    }
    app.restart();
}

#[cfg(test)]
mod update_tests {
    use super::*;

    #[test]
    fn feed_url_is_app_scoped_and_leaks_nothing() {
        let base = "https://updates.sundaysuite.app";
        assert_eq!(
            channel_feed_url(base, false),
            "https://updates.sundaysuite.app/v1/update/sundaysync/stable"
        );
        assert_eq!(
            channel_feed_url(base, true),
            "https://updates.sundaysuite.app/v1/update/sundaysync/beta"
        );
        // Privacy: no version/target/arch placeholders in the path (SundayRec parity).
        for beta in [false, true] {
            let url = channel_feed_url(base, beta);
            assert!(!url.contains("{{"));
            assert!(!url.contains("current_version"));
            assert!(!url.contains("target"));
            assert!(!url.contains("arch"));
            // App-scoped route, not the frozen `/v1/update/{channel}` alias.
            assert!(url.contains("/v1/update/sundaysync/"));
        }
    }

    #[test]
    fn update_base_defaults_to_the_worker() {
        // No `SUNDAYSYNC_UPDATE_BASE` is baked into a test build, so this pins what a
        // plain build ships: the Worker, never a GitHub feed.
        assert_eq!(update_base(), "https://updates.sundaysuite.app");
        assert!(!update_base().contains("github.com"));
    }

    #[test]
    fn percent_is_clamped_and_zero_safe() {
        assert_eq!(update_percent(0, 0), 0);
        assert_eq!(update_percent(50, 0), 0);
        assert_eq!(update_percent(0, 100), 0);
        assert_eq!(update_percent(50, 100), 50);
        assert_eq!(update_percent(100, 100), 100);
        // A server that over-reports never pushes the bar past 100.
        assert_eq!(update_percent(150, 100), 100);
    }
}

/// # Panics
/// Only if Tauri itself cannot start, which is not a recoverable condition.
pub fn run() {
    // E7: arm the crash panic hook as early as possible, before any plugin setup,
    // so a panic during startup already leaves a scrubbed record on disk.
    telemetry::install_crash_hook();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // E9: the in-app auto-updater. Its endpoint is overridden per-ring at run
        // time (see `build_updater`), but the plugin still needs registering so the
        // updater builder + signature check are available.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(telemetry::TelemetryState::new())
        .setup(|app| {
            // Resolved once, eagerly: the first sync should not pay for two `-version`
            // spawns, and a failure here is not fatal — the state stays empty and every
            // command (plus onboarding's re-check) tries again on demand.
            let state = AppState::default();
            match resolve_sidecar() {
                Ok(sidecar) => {
                    if let Ok(mut slot) = lock_state(&state.sidecar, OnPoison::Recover) {
                        *slot = Some(sidecar);
                    }
                }
                Err(e) => eprintln!("ffmpeg could not be resolved at startup: {e}"),
            }
            let activity = Arc::clone(&state.activity);
            app.manage(state);

            // D-040: age-based sweep on app start (90 days, on by default). Off the main
            // thread so a large cache never delays the window, and non-fatal — a swept
            // entry simply cold-decodes if that shoot ever returns. D-046: the sweep
            // claims the activity slot like every other maintenance pass, so a sync the
            // user starts during it is refused honestly (and vice versa) instead of the
            // engine seeing its cache vanish mid-run.
            std::thread::spawn(move || {
                let Ok(_guard) = ActivityGuard::begin(&activity, Activity::Maintaining) else {
                    eprintln!("startup cache sweep skipped: app is busy");
                    return;
                };
                let Ok(dir) = sundaysync_core::Cache::default_dir() else {
                    return;
                };
                match sundaysync_core::Cache::new(dir).sweep_older_than(DEFAULT_SWEEP_AGE) {
                    Ok(ev) if !ev.is_empty() => {
                        eprintln!(
                            "cache sweep: removed {} entries ({} bytes)",
                            ev.entries, ev.bytes
                        );
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("cache sweep skipped: {e}"),
                }
            });

            // E7: drain any crashes from the last run into the outbox (under
            // consent) and pump the queue + owed deletions. Off the main thread.
            telemetry::on_launch(&app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_sync,
            cancel_sync,
            scan_inputs,
            cache_status,
            clear_cache,
            sweep_cache,
            enforce_cache_cap,
            export_timeline,
            export_diagnostics,
            check_sidecar,
            default_cache_dir,
            update_check,
            update_download_install,
            update_relaunch,
            telemetry::telemetry_status,
            telemetry::set_telemetry_consent,
            telemetry::telemetry_preview,
            telemetry::report_frontend_error,
            telemetry::request_telemetry_deletion,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SundaySync");
}

#[cfg(test)]
mod tests {
    use super::*;
    use sundaysync_core::{
        Device, DeviceKind, Parameters, Placement, Rational, Reference, Sequence, Unsynced,
        UnsyncedReason, SCHEMA_VERSION,
    };

    fn sample_result() -> SyncResult {
        SyncResult {
            schema: SCHEMA_VERSION,
            parameters: Parameters {
                analysis_rate: 12_000,
                min_psr: 15.0,
            },
            reference: Some(Reference {
                file: PathBuf::from("/Users/kari/Opptak/Balkong Kirke/ZOOM0001.WAV"),
                device: "rec".into(),
            }),
            devices: vec![Device {
                id: "folder-balkong".into(),
                label: "Balkong Kirke".into(),
                kind: DeviceKind::Audio,
                files: vec![PathBuf::from(
                    "/Users/kari/Opptak/Balkong Kirke/ZOOM0001.WAV",
                )],
            }],
            placements: vec![Placement {
                file: PathBuf::from("/Users/kari/Opptak/Cam A/C0001.MP4"),
                device: "cam-a".into(),
                offset_seconds: 5.0,
                confidence: 0.9,
                psr: 42.0,
                drift_ppm: None,
                projected_end_error_ms: None,
                chain: vec!["reference".into()],
                warnings: vec![],
            }],
            unsynced: vec![Unsynced {
                file: PathBuf::from("/Users/kari/Opptak/broken.mp4"),
                reason: UnsyncedReason::DecodeError,
            }],
            sequence: Sequence {
                fps: Rational::new(25, 1).unwrap(),
                duration_seconds: 92.0,
            },
            warnings: vec![],
        }
    }

    #[test]
    fn scrub_removes_paths_usernames_and_labels() {
        // S-6: the scrubbed report must carry no absolute path, no `/Users/…` (macOS
        // username), and no human device label — only basenames, ids and numbers.
        let scrubbed = scrub_result(&sample_result());
        let json = serde_json::to_string_pretty(&scrubbed).unwrap();

        assert!(!json.contains("/Users/"), "leaked a home path: {json}");
        // No original absolute path (nor its parent folders) survives. The only `/` left
        // in the document is the frame-rate rational (e.g. "25/1"), which is not a path.
        assert!(
            !json.contains("Opptak"),
            "leaked a directory component: {json}"
        );
        assert!(
            !json.contains("Balkong Kirke/") && !json.contains("Cam A/"),
            "an absolute path component survived: {json}"
        );
        assert!(
            !json.contains("Balkong Kirke"),
            "leaked a device label: {json}"
        );

        // Basenames and neutral ids are what remains — enough to reason about a run.
        assert!(json.contains("ZOOM0001.WAV"));
        assert!(json.contains("C0001.MP4"));
        assert!(json.contains("folder-balkong"));
        // The label was redacted to the id, not merely dropped.
        assert!(json.contains(r#""label": "folder-balkong""#), "{json}");
        // Numbers a support reply needs are untouched.
        assert!(json.contains("42.0"));
    }

    #[test]
    fn scrub_is_idempotent_on_already_bare_names() {
        let mut r = sample_result();
        r.placements[0].file = PathBuf::from("C0001.MP4");
        let scrubbed = scrub_result(&r);
        assert_eq!(scrubbed.placements[0].file, PathBuf::from("C0001.MP4"));
    }

    #[test]
    fn export_path_validation_rejects_directories() {
        // S-5: an existing directory is never a valid write target.
        let dir = std::env::temp_dir();
        assert!(validate_export_path(&dir, None).is_err());
        assert!(validate_export_path(&dir, Some("fcpxml")).is_err());
    }

    #[test]
    fn export_path_validation_enforces_the_extension() {
        // S-5: export_timeline must not be steered into overwriting a non-.fcpxml file.
        let base = std::env::temp_dir();
        assert!(validate_export_path(&base.join("timeline.mov"), Some("fcpxml")).is_err());
        assert!(validate_export_path(&base.join("timeline.fcpxml"), Some("fcpxml")).is_ok());
        // Case-insensitive, and diagnostics (no required ext) accepts a plain file path.
        assert!(validate_export_path(&base.join("TIMELINE.FCPXML"), Some("fcpxml")).is_ok());
        assert!(validate_export_path(&base.join("diag.json"), None).is_ok());
    }

    #[test]
    fn export_path_validation_rejects_an_empty_path() {
        assert!(validate_export_path(Path::new(""), None).is_err());
    }

    /// Poisons `slot` by panicking while its guard is held, the way a real mid-update panic
    /// would. Returns with the mutex left poisoned.
    fn poison<T: Send + 'static>(slot: &Arc<Mutex<T>>) {
        let m = Arc::clone(slot);
        let _ = std::thread::spawn(move || {
            let _guard = m.lock().unwrap();
            panic!("deliberately poisoning the mutex for a test");
        })
        .join();
        assert!(slot.is_poisoned(), "the slot should be poisoned now");
    }

    fn last_run(inputs_hash: u64) -> LastRun {
        LastRun {
            result: sample_result(),
            durations: BTreeMap::new(),
            inputs_hash,
            correct_drift: true,
        }
    }

    #[test]
    fn cancel_still_fires_when_the_cancel_lock_is_poisoned() {
        // F1: the one safety control must survive a poisoned AppState. Before the fix,
        // `cancel_sync` took `if let Ok(slot) = lock()` and silently did nothing here.
        let state = AppState::default();
        let token = CancelToken::new();
        state.set_cancel(token.clone());

        poison(&state.cancel);

        state.request_cancel();
        assert!(
            token.is_cancelled(),
            "cancel must fire even through a poisoned lock"
        );
    }

    #[test]
    fn export_snapshot_errors_cleanly_on_a_poisoned_last() {
        // F1: the LastRun slot is the unsafe-to-recover one — a torn result must not be
        // exported. It errors instead of panicking or handing back half-written state.
        let state = AppState::default();
        state.store_last(last_run(7));
        poison(&state.last);

        let err = state.export_snapshot(7).unwrap_err();
        assert!(err.contains("poisoned"), "unexpected error: {err}");
    }

    #[test]
    fn scan_cancel_clear_respects_token_identity() {
        // F3: an old scan finishing late must not clear a newer scan's cancel slot.
        let state = AppState::default();
        let old = state.install_scan_cancel();
        let new = state.install_scan_cancel();

        // Installing the newer token supersedes (cancels) the old one.
        assert!(
            old.is_cancelled(),
            "the superseded scan should be cancelled"
        );
        assert!(!new.is_cancelled(), "the newest scan must not be cancelled");

        // The old scan tries to clean up after itself — it must NOT touch the newer token.
        state.clear_scan_cancel_if_ours(&old);
        {
            let slot = state.scan_cancel.lock().unwrap();
            let current = slot.as_ref().expect("the newer token must survive");
            assert!(
                Arc::ptr_eq(current, &new),
                "the newer scan's cancel token was wrongly cleared — it is now uncancellable"
            );
        }

        // The rightful owner can still clear it.
        state.clear_scan_cancel_if_ours(&new);
        assert!(state.scan_cancel.lock().unwrap().is_none());
    }

    #[test]
    fn export_snapshot_gates_on_the_inputs_fingerprint() {
        // F6: export succeeds for the sources that produced the run, and refuses once they
        // change — even for a caller that bypasses the UI's `phase.stale` gate.
        let state = AppState::default();
        let inputs = vec![PathBuf::from("/a/1.mp4"), PathBuf::from("/a/2.mp4")];
        let overrides = BTreeMap::new();
        let hash = inputs_fingerprint(&inputs, &overrides, None);
        state.store_last(last_run(hash));

        assert!(
            state.export_snapshot(hash).is_ok(),
            "matching inputs export"
        );

        let changed = inputs_fingerprint(&[PathBuf::from("/a/1.mp4")], &overrides, None);
        assert_ne!(hash, changed);
        let err = state.export_snapshot(changed).unwrap_err();
        assert!(err.contains("sources changed"), "unexpected error: {err}");
    }

    #[test]
    fn inputs_fingerprint_is_order_and_duplicate_independent() {
        // The frontend dedups via a Set and does not promise an order; the fingerprint must
        // agree regardless so a mere reshuffle never reads as "sources changed".
        let overrides = BTreeMap::new();
        let a = inputs_fingerprint(
            &[PathBuf::from("/a/1.mp4"), PathBuf::from("/a/2.mp4")],
            &overrides,
            None,
        );
        let b = inputs_fingerprint(
            &[
                PathBuf::from("/a/2.mp4"),
                PathBuf::from("/a/1.mp4"),
                PathBuf::from("/a/1.mp4"),
            ],
            &overrides,
            None,
        );
        assert_eq!(a, b);

        // But a different reference, or a different override, does change it.
        let mut overrides2 = BTreeMap::new();
        overrides2.insert(PathBuf::from("/a/1.mp4"), "cam-b".to_string());
        assert_ne!(
            a,
            inputs_fingerprint(
                &[PathBuf::from("/a/1.mp4"), PathBuf::from("/a/2.mp4")],
                &overrides2,
                None,
            )
        );
        assert_ne!(
            a,
            inputs_fingerprint(
                &[PathBuf::from("/a/1.mp4"), PathBuf::from("/a/2.mp4")],
                &overrides,
                Some(Path::new("/a/1.mp4")),
            )
        );
    }

    #[test]
    fn export_snapshot_reports_an_empty_slot() {
        let state = AppState::default();
        let err = state.export_snapshot(0).unwrap_err();
        assert!(err.contains("nothing has been synced"), "unexpected: {err}");
    }
}
