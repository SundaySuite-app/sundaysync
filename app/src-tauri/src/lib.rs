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
/// Generic over the runtime (V03-S2) so a command that reports progress can also be
/// driven by `tauri::test`'s headless MockRuntime. The concrete `AppHandle` is
/// `AppHandle<Wry>`, and a command taking it is unregisterable in a mock handler — which
/// is exactly why `run_sync` has never had an end-to-end IPC test. Inference fills the
/// parameter in at both existing call sites; nothing about the shipped behaviour changes.
///
/// §10 asks for events throttled to 10 Hz, and doing it here rather than in the engine is
/// deliberate: the engine reports everything and does not second-guess its consumer, so
/// the CLI can still log every event (see `progress.rs`).
struct EventSink<R: tauri::Runtime> {
    app: AppHandle<R>,
    /// Which event channel this sink publishes on — `sync:progress` for the pipeline,
    /// `scan:progress` for the pre-sync preview, so the frontend can tell them apart.
    channel: &'static str,
    last: Mutex<std::time::Instant>,
    last_stage: Mutex<Option<Stage>>,
}

impl<R: tauri::Runtime> EventSink<R> {
    fn new(app: AppHandle<R>, channel: &'static str) -> Self {
        Self {
            app,
            channel,
            last: Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(1)),
            last_stage: Mutex::new(None),
        }
    }
}

impl<R: tauri::Runtime> ProgressSink for EventSink<R> {
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
    /// V03-S2 (D-052): waveform pyramids, keyed by cache-key hex — i.e. by *content
    /// identity*, so re-recording to the same filename invalidates the entry for free
    /// (the key already folds in size and mtime, §4.2).
    ///
    /// Memory-only and bounded. Nothing here is persisted: rebuilding is one streaming
    /// read of a file that is already local, and sidecar `.peaks` files on disk would
    /// need their own eviction story, their own staleness rules and their own place in
    /// the cache-size number the settings screen shows. D-052 records why that trade
    /// went this way.
    pyramids: Mutex<PyramidLru>,
}

/// Bounded, least-recently-used store of built pyramids.
///
/// A hand-rolled `Vec` rather than a crate: at [`PyramidLru::CAP`] entries the linear
/// scan is a few dozen pointer comparisons against a *disk read plus a full streaming
/// fold*, so the asymptotics that justify a real LRU crate are noise here — and a new
/// dependency has to clear `cargo deny`, the licence allow-list and the supply-chain
/// surface for the privilege.
///
/// Ordering is back-is-newest: `get` moves a hit to the back, `put` pushes to the back
/// and drops from the front.
#[derive(Debug, Default)]
struct PyramidLru {
    /// `(cache-key hex, pyramid)`, oldest first.
    entries: Vec<(String, Arc<sundaysync_core::Pyramid>)>,
}

impl PyramidLru {
    /// Clips kept resident. A pyramid is ~1 MB per audio-hour (2 bytes per 10 ms bin plus
    /// the halving ladder), so 64 typical clips is single-digit megabytes — irrelevant
    /// against §7.7's 4 GB ceiling, and comfortably more than the largest multicam shoot
    /// anyone scrolls through at once.
    const CAP: usize = 64;

    fn get(&mut self, key: &str) -> Option<Arc<sundaysync_core::Pyramid>> {
        let at = self.entries.iter().position(|(k, _)| k == key)?;
        let hit = self.entries.remove(at);
        let value = Arc::clone(&hit.1);
        self.entries.push(hit);
        Some(value)
    }

    fn put(&mut self, key: String, value: Arc<sundaysync_core::Pyramid>) {
        self.entries.retain(|(k, _)| k != &key);
        self.entries.push((key, value));
        // `while`, not `if`: CAP could be lowered by a later edit and a single-shot
        // trim would then leak the difference forever.
        while self.entries.len() > Self::CAP {
            self.entries.remove(0);
        }
    }

    /// Drops one entry — used when `regenerate_analysis` replaces the cache file it was
    /// built from, so the next read rebuilds instead of serving the old picture.
    fn evict(&mut self, key: &str) {
        self.entries.retain(|(k, _)| k != key);
    }
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

/// The cache directory a command should work in: the caller's chosen one (D-013 lets the
/// user point the setting anywhere), or the engine's default.
///
/// One helper rather than the five hand-rolled `match dir { … }` blocks this replaced.
/// They were identical, which is exactly why one of them drifting would never be noticed:
/// a waveform read and the sweep that evicts it resolving *different* directories is an
/// invisible bug that looks like "the waveform sometimes disappears".
fn resolve_cache_dir(dir: Option<PathBuf>) -> Result<PathBuf, String> {
    match dir {
        Some(d) => Ok(d),
        None => sundaysync_core::Cache::default_dir().map_err(|e| e.to_string()),
    }
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
    let dir = resolve_cache_dir(dir)?;
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
    let dir = resolve_cache_dir(dir)?;
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
    let dir = resolve_cache_dir(dir)?;
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
    let dir = resolve_cache_dir(dir)?;
    sundaysync_core::Cache::new(dir)
        .enforce_size_cap(max_bytes)
        .map(EvictionResult::from)
        .map_err(|e| e.to_string())
}

// ---- Waveforms (V03-S2, docs/DECISIONS.md D-052) ----------------------------------
//
// Three commands, and a hard rule between them: the two *read* commands
// (`waveform_meta`, `waveform_level`) never claim the D-046 activity slot, and
// `regenerate_analysis` always does.
//
// That asymmetry is the whole design. Drawing a timeline is a read of a file the sync
// already wrote — it spawns nothing, decodes nothing, and must stay possible while a
// sync is running, or every waveform on screen would blank the moment the user starts
// another job. Regenerating a cache entry, by contrast, spawns ffmpeg and writes into the
// cache, which is exactly the class of work D-046 exists to serialise against a run.
//
// The cost of the read commands not holding the slot is that a maintenance pass can
// delete a cache entry out from under one. That is handled where it happens rather than
// prevented: a vanished entry surfaces as [`CACHE_MISSING_PREFIX`], which is a *state*
// the UI can offer to fix, not a crash and not a generic IO error.

/// Stable prefix for "there is no analysis-cache entry for this clip (yet)".
///
/// Followed by the source media path. Matched by `errors.ts` the way every other stable
/// engine string is (D-030), because the UI's response is a button, not a red banner: the
/// cache is regenerable by definition, and the extractor that regenerates it is one
/// command away.
const CACHE_MISSING_PREFIX: &str = "cache_missing:";

/// One level of the ladder, as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WaveformLevelMeta {
    bin_samples: u32,
    bins: usize,
}

/// The shape of a clip's waveform, without any of the bytes.
///
/// Deliberately split from the data: the renderer needs to know how many bins exist at
/// which zoom *before* it decides which level to fetch, and shipping nine levels of
/// samples to answer "how long is this clip" would be the whole point of the pyramid
/// thrown away. Sample rate is not repeated here — it is already in the §5 contract as
/// `parameters.analysis_rate`, and two sources for one number is how they disagree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WaveformMeta {
    total_samples: u64,
    levels: Vec<WaveformLevelMeta>,
}

/// Builds, or returns from the LRU, the pyramid for one source file.
///
/// Keyed on [`sundaysync_core::CacheKey`] — content identity, not path — so the memo can
/// never serve the waveform of a previous take that happened to have the same filename.
///
/// Two failures are deliberately kept apart:
/// * the *source media* is unreadable → the engine's own `failed to read …`, which
///   `errors.ts` already localises;
/// * the *cache entry* is absent → [`CACHE_MISSING_PREFIX`], which means "not built yet".
fn pyramid_for(
    state: &AppState,
    file: &Path,
    cache_dir: Option<PathBuf>,
) -> Result<Arc<sundaysync_core::Pyramid>, String> {
    let dir = resolve_cache_dir(cache_dir)?;
    // Reads the media file's metadata — a missing *source* is not a missing cache entry,
    // and must not offer to regenerate something that cannot be regenerated.
    let key = sundaysync_core::CacheKey::for_file(file, sundaysync_core::ANALYSIS_RATE)
        .map_err(|e| e.to_string())?;

    if let Ok(mut lru) = lock_state(&state.pyramids, OnPoison::Recover) {
        if let Some(hit) = lru.get(key.as_str()) {
            return Ok(hit);
        }
    }

    let entry = sundaysync_core::Cache::new(dir).entry_path(&key);
    let pyramid = sundaysync_core::pyramid_from_cache_file(&entry).map_err(|e| {
        if e.is_not_found() {
            // The sweep, the size cap or Clear got here first — or this clip was never
            // synced. Same state, same affordance.
            format!("{CACHE_MISSING_PREFIX}{}", file.display())
        } else {
            e.to_string()
        }
    })?;

    let pyramid = Arc::new(pyramid);
    if let Ok(mut lru) = lock_state(&state.pyramids, OnPoison::Recover) {
        lru.put(key.as_str().to_string(), Arc::clone(&pyramid));
    }
    Ok(pyramid)
}

/// Shape of a clip's waveform. Read-only: does NOT claim the D-046 activity slot.
#[tauri::command(async)]
fn waveform_meta(
    state: State<'_, AppState>,
    file: PathBuf,
    cache_dir: Option<PathBuf>,
) -> Result<WaveformMeta, String> {
    let pyramid = pyramid_for(&state, &file, cache_dir)?;
    Ok(WaveformMeta {
        total_samples: pyramid.total_samples,
        levels: pyramid
            .levels
            .iter()
            .map(|l| WaveformLevelMeta {
                bin_samples: l.bin_samples,
                bins: l.bins(),
            })
            .collect(),
    })
}

/// One level's bins as raw bytes: interleaved `[peak, rms]` `u8` pairs.
///
/// Returns [`tauri::ipc::Response`], which Tauri answers over the custom-protocol IPC with
/// `Content-Type: application/octet-stream`; the bootstrap script's response switch then
/// takes `response.arrayBuffer()`, so `invoke()` resolves to an **`ArrayBuffer`** in the
/// webview. Verified against this repo's pinned versions — see D-052 for the evidence and
/// for what the base64 fallback would have cost.
///
/// Raw bytes rather than a JSON array matters at this size: an hour of level-0 bins is
/// 720 000 numbers, which as JSON is megabytes of text to serialise, parse and garbage-
/// collect on every zoom. As bytes it is one 720 KB buffer the canvas reads directly.
///
/// Read-only: does NOT claim the D-046 activity slot.
#[tauri::command(async)]
fn waveform_level(
    state: State<'_, AppState>,
    file: PathBuf,
    level: u32,
    cache_dir: Option<PathBuf>,
) -> Result<tauri::ipc::Response, String> {
    let pyramid = pyramid_for(&state, &file, cache_dir)?;
    let index = level as usize;
    let bins = pyramid.levels.get(index).ok_or_else(|| {
        format!(
            "no waveform level {level}; this clip has {}",
            pyramid.levels.len()
        )
    })?;
    Ok(tauri::ipc::Response::new(bins.interleaved()))
}

/// Re-extracts one file's analysis audio, repopulating the cache entry a waveform needs.
///
/// This is the affordance behind [`CACHE_MISSING_PREFIX`]. Unlike the two read commands it
/// **does** claim the D-046 slot as `Maintaining`: it spawns the ffmpeg sidecar and writes
/// into the cache directory, which is precisely the work that must not overlap a run. A
/// caller who asks during a sync gets the existing `busy: …` refusal.
///
/// The existing entry is removed first, so this genuinely regenerates rather than
/// no-opping on a cache hit — a "regenerate" button that silently does nothing when the
/// entry is present-but-corrupt would be worse than no button. Safe to do under the guard:
/// no sync can be reading the cache while we hold it.
#[tauri::command(async)]
fn regenerate_analysis<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    file: PathBuf,
    cache_dir: Option<PathBuf>,
) -> Result<(), String> {
    let _activity = ActivityGuard::begin(&state.activity, Activity::Maintaining)?;

    let sidecar = state.sidecar()?;
    let dir = resolve_cache_dir(cache_dir)?;
    let key = sundaysync_core::CacheKey::for_file(&file, sundaysync_core::ANALYSIS_RATE)
        .map_err(|e| e.to_string())?;

    // Drop the memo before the file, so a concurrent read can never repopulate the LRU
    // from the entry we are about to delete.
    if let Ok(mut lru) = lock_state(&state.pyramids, OnPoison::Recover) {
        lru.evict(key.as_str());
    }

    let cache = sundaysync_core::Cache::new(dir);
    let entry = cache.entry_path(&key);
    if let Err(e) = std::fs::remove_file(&entry) {
        // Already gone is the *expected* case — this command exists for it.
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("could not clear the stale cache entry: {e}"));
        }
    }

    // Progress on its own channel so a multi-minute re-extract of a three-hour service is
    // not a frozen button. Distinct from `sync:progress`, which the results view is bound
    // to and which must not flicker because a waveform is rebuilding.
    let sink = EventSink::new(app, "analysis:progress");
    let outcomes = sundaysync_core::Extractor::new(sidecar, cache)
        .extract_all(std::slice::from_ref(&file), &sink, &CancelToken::new())
        .map_err(|e| e.to_string())?;

    // §7.2: a file that will not decode is a normal outcome, not an engine error — but for
    // *this* command it is the whole answer, so it is reported rather than swallowed.
    match outcomes.into_iter().next() {
        Some(Ok(_)) => Ok(()),
        Some(Err(e)) => Err(format!("could not decode {}: {}", file.display(), e.reason)),
        None => Err(format!("nothing was extracted for {}", file.display())),
    }
}

// ---- Playback PCM windows (V03-S5, docs/DECISIONS.md D-055) -----------------------
//
// The playback engine's one shell command. Everything else about playback lives in the
// renderer (`app/src/audio/`), because the browser already owns a sample-accurate
// scheduler — Web Audio — and the only thing it lacks is the samples.
//
// Those samples already exist: the analysis cache holds every synced file as mono f32le
// at `ANALYSIS_RATE`, which is exactly what the correlator listened to when it decided
// where the clip belongs. Playing *that* is the honest thing to play — the operator hears
// what the engine heard. It also means playback needs no decode, no second extraction, no
// `asset://` protocol and no CSP hole: just a windowed read of a flat file of floats.
//
// Read-only, so — like the two waveform reads and for the same reason (D-046) — it does
// **not** claim the activity slot. Playback must keep working while a sync runs.

/// The largest window one call may ask for: 180 000 samples = 15 s at
/// [`sundaysync_core::ANALYSIS_RATE`] = 720 KB of f32.
///
/// This is the renderer's chunk size (`app/src/audio/pcmPlan.ts`) expressed as a shell-side
/// *limit*, not a hint. Without it a hostile or buggy `invoke` could ask for a whole
/// three-hour service in one allocation — 130 MB memcopied through IPC — and the answer
/// would be an out-of-memory kill rather than an error. Refusing loudly is the D-032
/// trust-boundary posture applied to a size argument.
const MAX_WINDOW_SAMPLES: u32 = 180_000;

/// One window of a clip's analysis audio as raw `f32` little-endian bytes.
///
/// `start_sample` is an offset in *samples* from the start of the cache entry (i.e. from
/// the start of the source recording); `len_samples` is how many to read.
///
/// Returns [`tauri::ipc::Response`], which the webview resolves to an **`ArrayBuffer`** —
/// the same binary-IPC path `waveform_level` proved on these pinned Tauri versions (D-052);
/// `read_audio_window_answers_with_raw_bytes_not_json` below pins it again for this
/// command, because a silent fall back to JSON here would mean shipping every sample as
/// decimal text.
///
/// **A short read is a success, not an error.** Asking past the end of a clip is the normal
/// case at its last chunk, and an empty answer means "this clip has ended" — which is
/// precisely what the scheduler needs to know to stop scheduling it. Erroring would turn
/// the end of every clip into a failure.
///
/// A missing cache entry is reported with the [`CACHE_MISSING_PREFIX`] convention, so the
/// renderer can tell "not built yet" from "broken" exactly as the waveform path does.
#[tauri::command(async)]
fn read_audio_window(
    file: PathBuf,
    start_sample: u64,
    len_samples: u32,
    cache_dir: Option<PathBuf>,
) -> Result<tauri::ipc::Response, String> {
    if len_samples > MAX_WINDOW_SAMPLES {
        return Err(format!(
            "requested {len_samples} samples; the window limit is {MAX_WINDOW_SAMPLES}"
        ));
    }

    let dir = resolve_cache_dir(cache_dir)?;
    // Reads the *source* file's metadata: a vanished source is not a missing cache entry,
    // and must not offer to regenerate something that cannot be regenerated.
    let key = sundaysync_core::CacheKey::for_file(&file, sundaysync_core::ANALYSIS_RATE)
        .map_err(|e| e.to_string())?;
    let entry = sundaysync_core::Cache::new(dir).entry_path(&key);

    let mut f = std::fs::File::open(&entry).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{CACHE_MISSING_PREFIX}{}", file.display())
        } else {
            format!("failed to read {}: {e}", entry.display())
        }
    })?;

    // `start_sample` is renderer-supplied, so the byte offset is computed in u64 with a
    // checked multiply: a wrapped offset would seek to an arbitrary point in the file and
    // hand back plausible-looking garbage.
    let byte_offset = start_sample
        .checked_mul(4)
        .ok_or_else(|| format!("start sample {start_sample} is out of range"))?;

    use std::io::{Read, Seek, SeekFrom};
    // Seeking past the end is legal and leaves the cursor there; the read below then
    // returns zero bytes, which is the "this clip has ended" answer.
    f.seek(SeekFrom::Start(byte_offset))
        .map_err(|e| format!("failed to read {}: {e}", entry.display()))?;

    let want = len_samples as usize * 4;
    let mut buf = Vec::new();
    // `take` + `read_to_end` rather than a pre-zeroed `read_exact`: it costs one
    // allocation of exactly what is there, and it makes the short read at EOF the
    // ordinary path instead of an `UnexpectedEof` to special-case.
    f.take(want as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("failed to read {}: {e}", entry.display()))?;

    // Whole samples only. A cache entry truncated mid-float (a crash during extraction)
    // would otherwise hand the renderer a partial sample and be heard as a click.
    buf.truncate(buf.len() - buf.len() % 4);

    Ok(tauri::ipc::Response::new(buf))
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
            waveform_meta,
            waveform_level,
            regenerate_analysis,
            read_audio_window,
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

// ---- Waveform pipeline (V03-S2, D-052) --------------------------------------------

#[cfg(test)]
mod waveform_tests {
    use super::*;
    use sundaysync_core::{CacheKey, ANALYSIS_RATE};
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    /// A media file (contents irrelevant — the cache key is path+size+mtime+rate) plus a
    /// fabricated analysis-cache entry for it, under the name the engine would have used.
    ///
    /// This is what lets the shell's waveform path be tested with no ffmpeg and no real
    /// media: the seam between "the extractor wrote this" and "the pyramid reads it" is a
    /// filename, and a test that writes that filename exercises the same code a real run
    /// would (D-025 — these tests must pass on the ffmpeg-less runners).
    struct Fixture {
        _dir: tempfile::TempDir,
        media: PathBuf,
        cache_dir: PathBuf,
        key: CacheKey,
    }

    fn fixture(samples: &[f32]) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let media = dir.path().join("C0001.MP4");
        std::fs::write(
            &media,
            b"not really a movie, but it has a size and an mtime",
        )
        .unwrap();

        let cache_dir = dir.path().join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();

        let key = CacheKey::for_file(&media, ANALYSIS_RATE).unwrap();
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        std::fs::write(cache_dir.join(format!("{}.f32", key.as_str())), &bytes).unwrap();

        Fixture {
            _dir: dir,
            media,
            cache_dir,
            key,
        }
    }

    /// A headless app with `state` managed and every cache-reading command registered —
    /// the three waveform ones (V03-S2) and playback's window read (V03-S5). They share
    /// this module because they share the fixture: one fabricated cache entry.
    fn app_with(state: AppState) -> tauri::App<tauri::test::MockRuntime> {
        mock_builder()
            .manage(state)
            .invoke_handler(tauri::generate_handler![
                waveform_meta,
                waveform_level,
                regenerate_analysis,
                read_audio_window
            ])
            .build(mock_context(noop_assets()))
            .expect("the mock app must build")
    }

    fn request(cmd: &str, payload: serde_json::Value) -> InvokeRequest {
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::Json(payload),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    // ---- The risk gate: does raw-bytes IPC actually arrive as bytes? ---------------

    #[test]
    fn waveform_level_answers_with_raw_bytes_not_json() {
        // D-052's load-bearing assumption. `tauri::ipc::Response` must produce an
        // `InvokeResponseBody::Raw`, because that is what makes the webview's IPC
        // bootstrap take the `application/octet-stream` branch and resolve `invoke()` to
        // an ArrayBuffer. If this ever comes back `Json`, the frontend silently receives
        // an object where it expects a buffer — and the fallback (base64 in a JSON field,
        // +33 % on every zoom) would be needed instead.
        //
        // This is the whole pipeline, not a unit: the real `generate_handler!` dispatch,
        // the real argument deserialisation, the real `IpcResponse` conversion.
        let f = fixture(&vec![0.5f32; 480]);
        let app = app_with(AppState::default());
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let response = get_ipc_response(
            &webview,
            request(
                "waveform_level",
                serde_json::json!({
                    "file": f.media,
                    "level": 0,
                    "cacheDir": f.cache_dir,
                }),
            ),
        )
        .expect("the command must succeed");

        let InvokeResponseBody::Raw(bytes) = response else {
            panic!("waveform_level answered with JSON — D-052's binary IPC assumption is broken");
        };

        // 480 samples / 120 = 4 bins, interleaved [peak, rms] → 8 bytes, all ≈0.5.
        assert_eq!(
            bytes.len(),
            8,
            "expected 4 interleaved pairs, got {bytes:?}"
        );
        let expected = (0.5f32 * 255.0).round() as u8;
        for b in &bytes {
            assert!(
                b.abs_diff(expected) <= 1,
                "unexpected byte {b} in {bytes:?}"
            );
        }
    }

    #[test]
    fn waveform_meta_answers_with_json_in_the_camel_case_the_frontend_reads() {
        // The other half of the pair: meta is deliberately JSON (it is nine small
        // numbers), and its spelling is a contract with `types.ts`.
        let f = fixture(&vec![0.25f32; 12_000]);
        let app = app_with(AppState::default());
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let response = get_ipc_response(
            &webview,
            request(
                "waveform_meta",
                serde_json::json!({ "file": f.media, "cacheDir": f.cache_dir }),
            ),
        )
        .expect("the command must succeed");

        let value: serde_json::Value = response.deserialize().unwrap();
        assert_eq!(value["totalSamples"], 12_000);
        let levels = value["levels"].as_array().unwrap();
        assert_eq!(levels.len(), 9);
        assert_eq!(levels[0]["binSamples"], 120);
        assert_eq!(levels[0]["bins"], 100);
        assert_eq!(levels[1]["binSamples"], 240);
        assert_eq!(levels[1]["bins"], 50);
        // snake_case must not leak — the frontend reads camelCase.
        assert!(value.get("total_samples").is_none(), "{value}");
    }

    // ---- Cache-miss classification -------------------------------------------------

    #[test]
    fn a_missing_cache_entry_is_reported_with_the_regenerable_prefix() {
        // D-052: "not built yet" is a state with a button, not a failure. The prefix is
        // what lets `errors.ts` tell them apart, and it names the SOURCE file — the thing
        // the user recognises and the argument `regenerate_analysis` takes.
        let f = fixture(&[0.1, 0.2, 0.3]);
        std::fs::remove_file(f.cache_dir.join(format!("{}.f32", f.key.as_str()))).unwrap();

        let state = AppState::default();
        let err = pyramid_for(&state, &f.media, Some(f.cache_dir.clone())).unwrap_err();

        assert!(err.starts_with(CACHE_MISSING_PREFIX), "unexpected: {err}");
        assert!(
            err.contains("C0001.MP4"),
            "the prefix must name the clip: {err}"
        );
    }

    #[test]
    fn a_missing_source_file_is_not_reported_as_a_missing_cache_entry() {
        // The seam that matters: a clip the user deleted cannot be regenerated, so it must
        // NOT get the regenerate affordance. Offering one would loop the user forever.
        let f = fixture(&[0.1, 0.2]);
        let gone = f.cache_dir.join("never-existed.mov");

        let state = AppState::default();
        let err = pyramid_for(&state, &gone, Some(f.cache_dir.clone())).unwrap_err();

        assert!(!err.starts_with(CACHE_MISSING_PREFIX), "unexpected: {err}");
        // Falls through to the engine's own string, which `errors.ts` already localises.
        assert!(err.starts_with("failed to read "), "unexpected: {err}");
    }

    #[test]
    fn a_cache_entry_evicted_after_it_was_read_still_serves_from_memory() {
        // D-046's price for keeping the read commands off the activity slot: a sweep can
        // delete an entry mid-session. A pyramid already in the LRU must keep drawing —
        // blanking a waveform because a background sweep ran would look like a bug.
        let f = fixture(&vec![0.9f32; 2400]);
        let state = AppState::default();

        let first = pyramid_for(&state, &f.media, Some(f.cache_dir.clone())).unwrap();
        std::fs::remove_file(f.cache_dir.join(format!("{}.f32", f.key.as_str()))).unwrap();

        let second = pyramid_for(&state, &f.media, Some(f.cache_dir.clone()))
            .expect("a resident pyramid must survive its cache entry being evicted");
        assert_eq!(first, second);
    }

    // ---- The LRU -------------------------------------------------------------------

    fn stub_pyramid(total: u64) -> Arc<sundaysync_core::Pyramid> {
        Arc::new(sundaysync_core::Pyramid {
            total_samples: total,
            levels: Vec::new(),
        })
    }

    #[test]
    fn the_lru_evicts_the_least_recently_used_entry_first() {
        let mut lru = PyramidLru::default();
        for i in 0..PyramidLru::CAP as u64 {
            lru.put(format!("key{i}"), stub_pyramid(i));
        }
        assert_eq!(lru.entries.len(), PyramidLru::CAP);

        // Touch the oldest — that must make it the newest, and spare it from the next
        // eviction. A cache that evicts what the user is actively looking at is worse
        // than no cache: it rebuilds the one clip that is on screen, every time.
        assert!(lru.get("key0").is_some());

        lru.put("fresh".into(), stub_pyramid(999));
        assert_eq!(lru.entries.len(), PyramidLru::CAP);
        assert!(lru.get("key0").is_some(), "the touched entry was evicted");
        assert!(lru.get("key1").is_none(), "the true LRU entry survived");
        assert!(lru.get("fresh").is_some());
    }

    #[test]
    fn re_putting_a_key_replaces_rather_than_duplicates_it() {
        let mut lru = PyramidLru::default();
        lru.put("k".into(), stub_pyramid(1));
        lru.put("k".into(), stub_pyramid(2));
        assert_eq!(lru.entries.len(), 1);
        assert_eq!(lru.get("k").unwrap().total_samples, 2);
    }

    #[test]
    fn evict_drops_only_the_named_key() {
        let mut lru = PyramidLru::default();
        lru.put("a".into(), stub_pyramid(1));
        lru.put("b".into(), stub_pyramid(2));
        lru.evict("a");
        assert!(lru.get("a").is_none());
        assert!(lru.get("b").is_some());
    }

    #[test]
    fn the_lru_is_keyed_on_content_identity_so_a_re_recorded_take_invalidates() {
        // The key folds in size and mtime (§4.2), so overwriting a clip with a different
        // take must not serve the old waveform — even though the path is identical.
        let f = fixture(&vec![0.5f32; 1200]);
        let state = AppState::default();
        let before = pyramid_for(&state, &f.media, Some(f.cache_dir.clone())).unwrap();

        // A new take at the same path: different size, and a fabricated cache entry with
        // twice the audio under the NEW key.
        std::fs::write(
            &f.media,
            b"a different take entirely, of a different length",
        )
        .unwrap();
        let new_key = CacheKey::for_file(&f.media, ANALYSIS_RATE).unwrap();
        assert_ne!(new_key.as_str(), f.key.as_str(), "the key must have moved");
        let bytes: Vec<u8> = vec![0.5f32; 2400]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        std::fs::write(
            f.cache_dir.join(format!("{}.f32", new_key.as_str())),
            &bytes,
        )
        .unwrap();

        let after = pyramid_for(&state, &f.media, Some(f.cache_dir.clone())).unwrap();
        assert_eq!(before.total_samples, 1200);
        assert_eq!(after.total_samples, 2400, "a stale waveform was served");
    }

    // ---- D-046: who claims the activity slot, and who must not ---------------------

    #[test]
    fn regenerate_analysis_is_refused_while_a_sync_is_running() {
        // D-046: regeneration spawns ffmpeg and writes the cache, so it is `Maintaining`
        // and must lose to a run in flight. The guard is claimed before the sidecar is
        // resolved, so this needs no ffmpeg — which is the point on the D-005 runners.
        let state = AppState::default();
        let activity = Arc::clone(&state.activity);
        let app = app_with(state);
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let _running = ActivityGuard::begin(&activity, Activity::Syncing).unwrap();

        let err = get_ipc_response(
            &webview,
            request(
                "regenerate_analysis",
                serde_json::json!({ "file": "/nonexistent/clip.mov" }),
            ),
        )
        .expect_err("regeneration must be refused during a sync");

        assert_eq!(err, serde_json::json!("busy: sync in progress"), "{err}");
    }

    #[test]
    fn reading_a_waveform_is_allowed_while_a_sync_is_running() {
        // The other side of the same rule, and the reason the read commands are exempt: a
        // timeline must keep drawing during a sync. If `waveform_meta` ever grew an
        // `ActivityGuard`, every waveform on screen would go blank the moment the user
        // pressed Sync — and this test is what would catch it.
        let f = fixture(&vec![0.3f32; 3600]);
        let state = AppState::default();
        let activity = Arc::clone(&state.activity);
        let app = app_with(state);
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let _running = ActivityGuard::begin(&activity, Activity::Syncing).unwrap();

        let response = get_ipc_response(
            &webview,
            request(
                "waveform_meta",
                serde_json::json!({ "file": f.media, "cacheDir": f.cache_dir }),
            ),
        )
        .expect("a read-only waveform must not be blocked by a running sync");
        let value: serde_json::Value = response.deserialize().unwrap();
        assert_eq!(value["totalSamples"], 3600);
    }

    #[test]
    fn an_out_of_range_level_is_refused_by_name() {
        let f = fixture(&vec![0.5f32; 480]);
        let app = app_with(AppState::default());
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let err = get_ipc_response(
            &webview,
            request(
                "waveform_level",
                serde_json::json!({ "file": f.media, "level": 99, "cacheDir": f.cache_dir }),
            ),
        )
        .expect_err("level 99 does not exist");
        assert!(
            err.as_str()
                .unwrap_or_default()
                .contains("no waveform level"),
            "{err}"
        );
    }

    #[test]
    fn the_cache_dir_helper_prefers_the_callers_choice_over_the_default() {
        // D-013 lets the user point the cache anywhere; every command must honour the
        // same choice, or a waveform read and the sweep that evicts it would disagree.
        let chosen = PathBuf::from("/tmp/somewhere-the-user-picked");
        assert_eq!(
            resolve_cache_dir(Some(chosen.clone())).unwrap(),
            chosen,
            "the caller's cache directory was ignored"
        );
    }

    // ---- Playback windows (V03-S5, D-055) ------------------------------------------
    //
    // Same fixture, different question: not "what shape is this clip" but "give me these
    // exact samples". The scheduler's whole correctness claim rests on the bytes coming
    // back being the bytes at that offset, so these tests read a ramp and check values,
    // not just lengths.

    /// The sample values a fixture window came back as.
    fn decode(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }

    fn window(
        f: &Fixture,
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        start: u64,
        len: u32,
    ) -> Result<Vec<u8>, String> {
        match get_ipc_response(
            webview,
            request(
                "read_audio_window",
                serde_json::json!({
                    "file": f.media,
                    "startSample": start,
                    "lenSamples": len,
                    "cacheDir": f.cache_dir,
                }),
            ),
        ) {
            Ok(InvokeResponseBody::Raw(bytes)) => Ok(bytes),
            Ok(InvokeResponseBody::Json(j)) => {
                panic!("read_audio_window answered with JSON ({j}) — D-055's binary IPC assumption is broken")
            }
            Err(e) => Err(e.as_str().unwrap_or_default().to_string()),
        }
    }

    #[test]
    fn a_window_is_the_exact_samples_at_that_offset_as_raw_bytes() {
        // A ramp, so a mis-seek cannot look like a hit: every sample is its own index.
        let samples: Vec<f32> = (0..1000).map(|i| i as f32).collect();
        let f = fixture(&samples);
        let app = app_with(AppState::default());
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let bytes = window(&f, &webview, 250, 100).expect("the command must succeed");
        assert_eq!(bytes.len(), 400, "expected 100 f32 samples");
        let got = decode(&bytes);
        let want: Vec<f32> = (250..350).map(|i| i as f32).collect();
        assert_eq!(got, want, "the window came from the wrong offset");
    }

    #[test]
    fn a_window_that_runs_off_the_end_returns_what_exists_and_then_nothing() {
        // The last chunk of every clip takes this path, and past the end is what tells the
        // scheduler the clip has ended. Neither is an error.
        let samples: Vec<f32> = (0..1000).map(|i| i as f32).collect();
        let f = fixture(&samples);
        let app = app_with(AppState::default());
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let tail = window(&f, &webview, 900, 500).expect("a short read is a success");
        assert_eq!(decode(&tail).len(), 100, "expected the last 100 samples");
        assert_eq!(decode(&tail)[0], 900.0);

        let past = window(&f, &webview, 1000, 500).expect("reading past EOF is a success");
        assert!(
            past.is_empty(),
            "expected nothing past the end, got {past:?}"
        );

        let far = window(&f, &webview, 9_999_999, 500).expect("far past EOF too");
        assert!(far.is_empty(), "expected nothing far past the end");
    }

    #[test]
    fn a_truncated_entry_never_yields_a_partial_sample() {
        // A crash mid-extraction can leave a trailing fragment. Handing three bytes of a
        // float to the renderer would be heard as a click; the read drops the remainder.
        let dir = tempfile::tempdir().unwrap();
        let media = dir.path().join("C0002.MP4");
        std::fs::write(&media, b"size and mtime").unwrap();
        let cache_dir = dir.path().join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let key = CacheKey::for_file(&media, ANALYSIS_RATE).unwrap();
        // Two whole samples plus three stray bytes.
        let mut bytes: Vec<u8> = 1.0f32.to_le_bytes().to_vec();
        bytes.extend_from_slice(&2.0f32.to_le_bytes());
        bytes.extend_from_slice(&[0xAA, 0xBB, 0xCC]);
        std::fs::write(cache_dir.join(format!("{}.f32", key.as_str())), &bytes).unwrap();

        let f = Fixture {
            _dir: dir,
            media,
            cache_dir,
            key,
        };
        let app = app_with(AppState::default());
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let got = window(&f, &webview, 0, 100).expect("the command must succeed");
        assert_eq!(decode(&got), vec![1.0, 2.0], "a partial sample leaked out");
    }

    #[test]
    fn a_missing_cache_entry_is_the_same_state_the_waveform_path_reports() {
        // One convention for "not built yet" across every cache reader (D-052), so
        // `errors.ts` needs no second matcher and the UI can offer the same affordance.
        let samples = vec![0.1f32; 100];
        let f = fixture(&samples);
        std::fs::remove_file(f.cache_dir.join(format!("{}.f32", f.key.as_str()))).unwrap();

        let app = app_with(AppState::default());
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let err = window(&f, &webview, 0, 100).expect_err("the entry is gone");
        assert!(
            err.starts_with(CACHE_MISSING_PREFIX),
            "expected a cache_missing refusal, got {err}"
        );
    }

    #[test]
    fn a_window_past_the_limit_is_refused_before_anything_is_allocated() {
        // D-032's posture applied to a size argument: the answer to "give me three hours
        // in one call" is a sentence, not an out-of-memory kill.
        let f = fixture(&[0.0f32; 10]);
        let app = app_with(AppState::default());
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let err = window(&f, &webview, 0, MAX_WINDOW_SAMPLES + 1)
            .expect_err("an oversized window must be refused");
        assert!(err.contains("window limit"), "{err}");

        // …and the limit itself is allowed, or the renderer's chunk size would be one
        // sample too large forever.
        window(&f, &webview, 0, MAX_WINDOW_SAMPLES).expect("the limit itself is legal");
    }

    #[test]
    fn reading_a_playback_window_is_allowed_while_a_sync_is_running() {
        // The D-046 asymmetry, restated for playback: pausing the audio because a second
        // sync started would be a bug, not a safety property.
        let f = fixture(&vec![0.3f32; 100]);
        let state = AppState::default();
        let activity = Arc::clone(&state.activity);
        let app = app_with(state);
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let _running = ActivityGuard::begin(&activity, Activity::Syncing).unwrap();

        window(&f, &webview, 0, 100)
            .expect("a read-only playback window must not be blocked by a running sync");
    }
}
