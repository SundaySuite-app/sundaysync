//! SundaySync desktop shell — docs/PLAN.md §9.
//!
//! Deliberately thin. Every decision worth testing lives in `sundaysync-core`, which has
//! no Tauri dependency and runs headlessly in CI (§3). This crate does three things:
//! move work off the UI thread, translate progress into events, and hand results to the
//! frontend as JSON.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use sundaysync_core::{
    export_fcpxml, sync_with_durations, CancelToken, Progress, ProgressSink, Sidecar,
    SidecarSource, Stage, SyncRequest, SyncResult, DEFAULT_MIN_PSR,
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

/// The last successful run, kept so export can happen without re-syncing.
struct LastRun {
    result: SyncResult,
    durations: BTreeMap<PathBuf, f64>,
}

/// Shared cancellation handle, so the UI's Cancel button can reach a run in flight.
#[derive(Default)]
struct AppState {
    cancel: Arc<Mutex<Option<CancelToken>>>,
    /// The pre-sync scan gets its own slot: a re-scan supersedes the previous one
    /// (the UI auto-scans on every input change), and cancelling a scan must never
    /// touch a sync in flight.
    scan_cancel: Arc<Mutex<Option<CancelToken>>>,
    last: Arc<Mutex<Option<LastRun>>>,
    /// The ffmpeg/ffprobe pair every command decodes with, resolved once at startup
    /// (D-031). `None` means resolution failed — a user who installs ffmpeg while the
    /// app is open gets a fresh attempt from `check_sidecar` without restarting.
    sidecar: Arc<Mutex<Option<Sidecar>>>,
}

impl AppState {
    /// The stored sidecar, resolving and caching it if startup could not.
    fn sidecar(&self) -> Result<Sidecar, String> {
        if let Ok(slot) = self.sidecar.lock() {
            if let Some(sidecar) = slot.as_ref() {
                return Ok(sidecar.clone());
            }
        }
        let resolved = resolve_sidecar()?;
        if let Ok(mut slot) = self.sidecar.lock() {
            *slot = Some(resolved.clone());
        }
        Ok(resolved)
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
}

/// Runs a full sync. Blocking, so the frontend calls it off the UI thread.
#[tauri::command(async)]
fn run_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    args: RunSyncArgs,
) -> Result<SyncOutcome, String> {
    // Resolved before the token is installed: a missing ffmpeg should not leave a cancel
    // handle pointing at a run that never started.
    let sidecar = state.sidecar()?;

    let cancel = CancelToken::new();
    if let Ok(mut slot) = state.cancel.lock() {
        *slot = Some(cancel.clone());
    }

    let defaults = SyncRequest::new(Vec::new());
    let request = SyncRequest {
        inputs: args.inputs,
        cache_dir: args.cache_dir,
        reference_override: args.reference,
        min_psr: args.min_psr.unwrap_or(DEFAULT_MIN_PSR),
        device_overrides: args.device_overrides.unwrap_or_default(),
        segment_count: args.segment_count.unwrap_or(defaults.segment_count),
        sidecar: Some(sidecar),
    };

    let sink = EventSink::new(app, "sync:progress");
    let outcome = sync_with_durations(&request, &sink, &cancel);

    if let Ok(mut slot) = state.cancel.lock() {
        *slot = None;
    }

    match outcome {
        Ok((result, durations)) => {
            if let Ok(mut slot) = state.last.lock() {
                *slot = Some(LastRun {
                    result: result.clone(),
                    durations: durations.clone(),
                });
            }
            Ok(SyncOutcome { result, durations })
        }
        Err(e) => Err(e.to_string()),
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

    let cancel = CancelToken::new();
    if let Ok(mut slot) = state.scan_cancel.lock() {
        if let Some(previous) = slot.replace(cancel.clone()) {
            previous.cancel();
        }
    }

    // Exclude the cache exactly as the pipeline does (D-020) — a user-configured cache
    // inside a dropped folder must not appear as broken media in the preview either.
    let exclude = cache_dir.or_else(|| sundaysync_core::Cache::default_dir().ok());

    let sink = EventSink::new(app, "scan:progress");
    let outcome =
        sundaysync_core::scan::scan_detailed(&inputs, &sidecar, exclude.as_deref(), &sink, &cancel);

    // Clear the slot only if it still holds OUR token: a newer scan may already have
    // installed its own, and clearing that would orphan its cancel button. Our token
    // being cancelled is exactly the signal that we were superseded.
    if !cancel.is_cancelled() {
        if let Ok(mut slot) = state.scan_cancel.lock() {
            *slot = None;
        }
    }

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
fn clear_cache(dir: Option<PathBuf>) -> Result<u64, String> {
    let dir = match dir {
        Some(d) => d,
        None => sundaysync_core::Cache::default_dir().map_err(|e| e.to_string())?,
    };
    sundaysync_core::Cache::new(dir)
        .clear()
        .map_err(|e| e.to_string())
}

/// §7.4: cancel must take effect within 2 s. The engine kills in-flight ffmpeg children,
/// so this returns immediately and the run unwinds on its own.
#[tauri::command]
fn cancel_sync(state: State<'_, AppState>) {
    if let Ok(slot) = state.cancel.lock() {
        if let Some(token) = slot.as_ref() {
            token.cancel();
        }
    }
}

/// Writes the FCPXML for the most recent successful sync.
#[tauri::command]
fn export_timeline(
    state: State<'_, AppState>,
    path: PathBuf,
    project: Option<String>,
) -> Result<usize, String> {
    let guard = state
        .last
        .lock()
        .map_err(|_| "internal state was poisoned".to_string())?;
    let Some(last) = guard.as_ref() else {
        return Err("nothing has been synced yet".into());
    };
    let export = export_fcpxml(
        &last.result,
        &last.durations,
        project.as_deref().unwrap_or("SundaySync"),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(&path, export.xml).map_err(|e| e.to_string())?;
    Ok(export.clips.len())
}

/// §7.6: a diagnostics bundle with no media in it.
///
/// Writes the `SyncResult` and environment details as one JSON file. Deliberately not a
/// zip and deliberately media-free — a support bundle someone hesitates to send is worth
/// nothing, so there must be nothing in it to hesitate about.
#[tauri::command]
fn export_diagnostics(state: State<'_, AppState>, path: PathBuf) -> Result<(), String> {
    let guard = state
        .last
        .lock()
        .map_err(|_| "internal state was poisoned".to_string())?;

    let (ffmpeg, ffmpeg_source) = match state.sidecar() {
        Ok(s) => (
            format!("{} / {}", s.ffmpeg.display(), s.ffprobe.display()),
            source_word(s.source).to_string(),
        ),
        Err(e) => (format!("unavailable: {e}"), "none".to_string()),
    };

    let report = serde_json::json!({
        "app": env!("CARGO_PKG_VERSION"),
        "schema": sundaysync_core::SCHEMA_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "ffmpeg": ffmpeg,
        "ffmpeg_source": ffmpeg_source,
        "default_min_psr": DEFAULT_MIN_PSR,
        "default_segment_count": sundaysync_core::correlate::SEGMENT_COUNT,
        "analysis_rate": sundaysync_core::ANALYSIS_RATE,
        "result": guard.as_ref().map(|l| &l.result),
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
    if let Ok(mut slot) = state.sidecar.lock() {
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

/// # Panics
/// Only if Tauri itself cannot start, which is not a recoverable condition.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Resolved once, eagerly: the first sync should not pay for two `-version`
            // spawns, and a failure here is not fatal — the state stays empty and every
            // command (plus onboarding's re-check) tries again on demand.
            let state = AppState::default();
            match resolve_sidecar() {
                Ok(sidecar) => {
                    if let Ok(mut slot) = state.sidecar.lock() {
                        *slot = Some(sidecar);
                    }
                }
                Err(e) => eprintln!("ffmpeg could not be resolved at startup: {e}"),
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_sync,
            cancel_sync,
            scan_inputs,
            cache_status,
            clear_cache,
            export_timeline,
            export_diagnostics,
            check_sidecar,
            default_cache_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SundaySync");
}
