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
    export_fcpxml, sync_with_durations, CancelToken, Progress, ProgressSink, Stage, SyncRequest,
    SyncResult, DEFAULT_MIN_PSR,
};
use tauri::{AppHandle, Emitter, Manager, State};

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
    last: Mutex<std::time::Instant>,
    last_stage: Mutex<Option<Stage>>,
}

impl EventSink {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
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
            "sync:progress",
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
    last: Arc<Mutex<Option<LastRun>>>,
}

#[derive(Debug, Clone, Serialize)]
struct SyncOutcome {
    result: SyncResult,
}

/// Runs a full sync. Blocking, so the frontend calls it off the UI thread.
#[tauri::command(async)]
fn run_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    inputs: Vec<PathBuf>,
    min_psr: Option<f64>,
    cache_dir: Option<PathBuf>,
    reference: Option<PathBuf>,
) -> Result<SyncOutcome, String> {
    let cancel = CancelToken::new();
    if let Ok(mut slot) = state.cancel.lock() {
        *slot = Some(cancel.clone());
    }

    let request = SyncRequest {
        inputs,
        cache_dir,
        reference_override: reference,
        min_psr: min_psr.unwrap_or(DEFAULT_MIN_PSR),
    };

    let sink = EventSink::new(app);
    let outcome = sync_with_durations(&request, &sink, &cancel);

    if let Ok(mut slot) = state.cancel.lock() {
        *slot = None;
    }

    match outcome {
        Ok((result, durations)) => {
            if let Ok(mut slot) = state.last.lock() {
                *slot = Some(LastRun {
                    result: result.clone(),
                    durations,
                });
            }
            Ok(SyncOutcome { result })
        }
        Err(e) => Err(e.to_string()),
    }
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

    let ffmpeg = sundaysync_core::Sidecar::from_path()
        .map(|s| format!("{} / {}", s.ffmpeg.display(), s.ffprobe.display()))
        .unwrap_or_else(|e| format!("unavailable: {e}"));

    let report = serde_json::json!({
        "app": env!("CARGO_PKG_VERSION"),
        "schema": sundaysync_core::SCHEMA_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "ffmpeg": ffmpeg,
        "default_min_psr": DEFAULT_MIN_PSR,
        "analysis_rate": sundaysync_core::ANALYSIS_RATE,
        "result": guard.as_ref().map(|l| &l.result),
    });

    std::fs::write(
        &path,
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Whether ffmpeg is reachable, so the UI can say so before the user drops 40 GB of media.
#[tauri::command]
fn check_sidecar() -> Result<String, String> {
    sundaysync_core::Sidecar::from_path()
        .map(|s| s.ffmpeg.display().to_string())
        .map_err(|e| e.to_string())
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
            app.manage(AppState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_sync,
            cancel_sync,
            export_timeline,
            export_diagnostics,
            check_sidecar,
            default_cache_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SundaySync");
}
