//! Native smoke mode — does the BUILT app actually launch and render? (D-093)
//!
//! Everything this repo verified about the frontend until now ran in headless Chromium
//! with the Tauri IPC mocked (`app/e2e/harness.ts`). The shipped app runs in **WKWebView**
//! on macOS and **WebView2** on Windows. Those are different engines, and a whole class of
//! defect lives only in them — the sibling app SundayEdit shipped a renderer that was 42×
//! slower in real WKWebView because the user-agent string lacks a `Safari` token, which is
//! invisible from Chromium by construction.
//!
//! Smoke mode is the deterministic gate for that gap. With `SUNDAYSYNC_SMOKE=1` the shell
//! arms a watchdog at startup; the frontend, once it has mounted, hands back what it can
//! only know from *inside the real webview* (its user agent, whether the root actually laid
//! out with a non-zero box, whether the stylesheet applied, and every error it caught during
//! boot). The shell prints that as one JSON line on stdout, writes it to
//! `SUNDAYSYNC_SMOKE_OUT` if set, and exits. No display scraping, no WebDriver, no polling
//! for a window title — the app itself says «I am up», or the watchdog says it never did.
//!
//! ## The guard
//!
//! Every entry point here is dead unless [`enabled`] returns true, and [`enabled`] accepts
//! exactly the string `"1"` — not `"true"`, not `"0"`, not an empty value. That last one is
//! deliberate: an empty environment variable is NOT an absent one, a distinction that has
//! already cost this suite a broken release workflow (`APPLE_ID: ''` did not disable
//! notarization). [`enabled_from`] is pure so the guard itself is unit-tested rather than
//! assumed.
//!
//! The one thing smoke mode costs a normal launch is a single fire-and-forget `invoke` from
//! the frontend after mount: the webview cannot read the shell's environment, so it always
//! offers the report and the shell decides whether anyone is listening. Off, `report` returns
//! before it touches anything — no file, no stdout, no exit, no thread.

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Turns smoke mode on. Exactly `"1"`.
pub const ENABLE_VAR: &str = "SUNDAYSYNC_SMOKE";
/// Where to write the report JSON. Optional; stdout always gets it too.
pub const OUT_VAR: &str = "SUNDAYSYNC_SMOKE_OUT";
/// How long to keep the window on screen after the report, so an external screenshot
/// tool has something to photograph. Milliseconds; default 0.
pub const HOLD_VAR: &str = "SUNDAYSYNC_SMOKE_HOLD_MS";
/// How long to wait for the frontend to report before declaring the launch failed.
pub const TIMEOUT_VAR: &str = "SUNDAYSYNC_SMOKE_TIMEOUT_MS";

/// The frontend never reported in time.
pub const EXIT_TIMEOUT: i32 = 2;
/// The report arrived but could not be written where it was asked to go.
pub const EXIT_WRITE_FAILED: i32 = 3;

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// After a successful report we ask Tauri to close cleanly. If the event loop is wedged
/// enough not to honour that, force the exit — the claim we are gating on (the app came up
/// and rendered) is already proven and written.
const EXIT_BACKSTOP: Duration = Duration::from_secs(20);

static STARTED: OnceLock<Instant> = OnceLock::new();
static REPORTED: AtomicBool = AtomicBool::new(false);

/// The guard, as a pure function of the raw environment value.
///
/// `None` (absent), `Some("")` (present but empty), and anything that is not exactly `"1"`
/// all mean OFF. See the module header for why empty is called out separately.
#[must_use]
pub fn enabled_from(raw: Option<&str>) -> bool {
    raw == Some("1")
}

/// Is smoke mode on for this process?
#[must_use]
pub fn enabled() -> bool {
    enabled_from(std::env::var(ENABLE_VAR).ok().as_deref())
}

fn millis_from(raw: Option<&str>, default: u64) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(default)
}

fn env_millis(var: &str, default: u64) -> u64 {
    millis_from(std::env::var(var).ok().as_deref(), default)
}

fn out_path() -> Option<PathBuf> {
    match std::env::var(OUT_VAR) {
        Ok(v) if !v.trim().is_empty() => Some(PathBuf::from(v)),
        _ => None,
    }
}

/// What the webview knows about itself, and can only know from inside itself.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendReport {
    /// The single most valuable field here: WKWebView and WebView2 identify differently,
    /// and a UA-sniffing dependency that misreads one of them is the SundayEdit bug.
    pub user_agent: String,
    /// Did React actually attach something under `#root`?
    pub mounted: bool,
    /// Laid-out size of the root element. Mounted-but-zero-height is not rendered.
    pub root_width: f64,
    pub root_height: f64,
    /// Total elements in the document — a mounted-but-empty tree is not rendered either.
    pub element_count: u32,
    /// Computed `background-color` of `<body>`. Non-transparent proves the bundled
    /// stylesheet was fetched through the custom protocol and applied, which the CSP
    /// and the asset protocol both have to be right for.
    pub body_background: String,
    /// Everything `error` / `unhandledrejection` caught between the first line of the
    /// bundle and the moment we reported. Empty is the only acceptable value.
    pub boot_errors: Vec<String>,
    /// `performance.now()` at report time — how long the webview took to be usable.
    pub ready_ms: f64,
    pub device_pixel_ratio: f64,
    pub language: String,
}

/// The line the CI job reads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    smoke: &'static str,
    ok: bool,
    app_version: String,
    os: &'static str,
    arch: &'static str,
    /// The engine version as the *shell* sees it (WebKit build / WebView2 runtime),
    /// independent of anything the frontend claims.
    webview_version: String,
    elapsed_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    frontend: Option<FrontendReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

fn webview_version() -> String {
    tauri::webview_version().unwrap_or_else(|e| format!("unknown ({e})"))
}

fn elapsed_ms() -> u128 {
    STARTED.get().map_or(0, |t| t.elapsed().as_millis())
}

/// Print the envelope on stdout and, when asked, write it to a file.
///
/// Both, deliberately. Stdout is the human-readable trace in the job log; the file is what
/// the runner asserts on, and it survives the Windows release profile's
/// `windows_subsystem = "windows"` (no console attached → stdout goes nowhere).
/// Returns false when the file was requested and could not be written.
fn emit(envelope: &Envelope) -> bool {
    let line = serde_json::to_string(envelope)
        .unwrap_or_else(|e| format!(r#"{{"smoke":"broken","ok":false,"detail":"{e}"}}"#));
    println!("SUNDAYSYNC_SMOKE {line}");
    let _ = std::io::stdout().flush();

    let Some(path) = out_path() else {
        return true;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&path, format!("{line}\n")) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("smoke: could not write {}: {e}", path.display());
            false
        }
    }
}

/// Arm the watchdog. Call from `setup`; a no-op unless smoke mode is on.
///
/// The watchdog is the half that makes this a gate rather than a hope: a build that starts
/// its process, opens no window, and sits there forever is exactly the failure this round
/// exists to catch, and it produces no error of its own to observe.
pub fn arm() {
    if !enabled() {
        return;
    }
    let _ = STARTED.set(Instant::now());
    let timeout = Duration::from_millis(env_millis(TIMEOUT_VAR, DEFAULT_TIMEOUT_MS));
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        if REPORTED.load(Ordering::SeqCst) {
            return;
        }
        let envelope = Envelope {
            smoke: "timeout",
            ok: false,
            app_version: String::new(),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            webview_version: webview_version(),
            elapsed_ms: elapsed_ms(),
            frontend: None,
            detail: Some(format!(
                "the webview never reported ready within {} ms — the app launched but did not render",
                timeout.as_millis()
            )),
        };
        emit(&envelope);
        // Not `app.exit`: the point of this path is that the event loop may be the thing
        // that is stuck, and asking a stuck loop to close politely never returns.
        std::process::exit(EXIT_TIMEOUT);
    });
}

/// The frontend reported. A no-op unless smoke mode is on — see the module header.
pub fn report(app: &tauri::AppHandle, frontend: FrontendReport) {
    if !enabled() {
        return;
    }
    if REPORTED.swap(true, Ordering::SeqCst) {
        // React StrictMode double-invokes effects in development; one report is the truth.
        return;
    }

    let ok = frontend.mounted && frontend.boot_errors.is_empty();
    let envelope = Envelope {
        smoke: "ready",
        ok,
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        webview_version: webview_version(),
        elapsed_ms: elapsed_ms(),
        frontend: Some(frontend),
        detail: None,
    };
    let written = emit(&envelope);

    let hold = Duration::from_millis(env_millis(HOLD_VAR, 0));
    let code = if !written {
        EXIT_WRITE_FAILED
    } else {
        // The *verdict* is the runner's job, not ours: this process exits 0 whenever it
        // managed to say what happened. A `false` ok with a clean exit is a job failure
        // in the runner, which can then explain WHICH claim failed instead of leaving a
        // bare exit code behind.
        0
    };
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(hold);
        handle.exit(code);
        std::thread::sleep(EXIT_BACKSTOP);
        eprintln!("smoke: clean exit did not complete within {EXIT_BACKSTOP:?}; forcing");
        std::process::exit(code);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // The guard is the whole safety story for shipping this code in a release build, so it
    // is tested as a value rather than trusted as a read-through.
    #[test]
    fn only_the_exact_string_one_enables_smoke_mode() {
        assert!(enabled_from(Some("1")));

        assert!(!enabled_from(None), "absent");
        assert!(!enabled_from(Some("")), "present but EMPTY is not present");
        assert!(!enabled_from(Some("0")));
        assert!(!enabled_from(Some("true")));
        assert!(!enabled_from(Some("yes")));
        assert!(!enabled_from(Some(" 1")));
        assert!(!enabled_from(Some("1 ")));
        assert!(!enabled_from(Some("11")));
    }

    #[test]
    fn millis_fall_back_rather_than_panicking_on_junk() {
        assert_eq!(millis_from(Some("2500"), 9), 2500);
        assert_eq!(millis_from(Some("  2500  "), 9), 2500);
        assert_eq!(millis_from(None, 9), 9);
        assert_eq!(millis_from(Some(""), 9), 9);
        assert_eq!(millis_from(Some("soon"), 9), 9);
        assert_eq!(millis_from(Some("-1"), 9), 9);
    }

    #[test]
    fn the_envelope_carries_every_field_the_runner_asserts_on() {
        let envelope = Envelope {
            smoke: "ready",
            ok: true,
            app_version: "0.0.0-test".into(),
            os: "macos",
            arch: "aarch64",
            webview_version: "605.1.15".into(),
            elapsed_ms: 1234,
            frontend: Some(FrontendReport {
                user_agent: "Mozilla/5.0 … AppleWebKit/605.1.15".into(),
                mounted: true,
                root_width: 1280.0,
                root_height: 800.0,
                element_count: 240,
                body_background: "rgb(17, 17, 20)".into(),
                boot_errors: vec![],
                ready_ms: 412.5,
                device_pixel_ratio: 2.0,
                language: "nb".into(),
            }),
            detail: None,
        };
        let json: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&envelope).expect("serialises"))
                .expect("round-trips");

        assert_eq!(json["smoke"], "ready");
        assert_eq!(json["ok"], true);
        assert_eq!(json["appVersion"], "0.0.0-test");
        assert_eq!(json["webviewVersion"], "605.1.15");
        assert_eq!(json["frontend"]["mounted"], true);
        assert_eq!(json["frontend"]["elementCount"], 240);
        assert_eq!(json["frontend"]["bodyBackground"], "rgb(17, 17, 20)");
        assert!(json["frontend"]["bootErrors"].as_array().is_some());
        // camelCase across the IPC boundary, like every other payload in this shell.
        assert!(json.get("app_version").is_none());
        // A successful report carries no `detail`; the timeout path is where that appears.
        assert!(json.get("detail").is_none());
    }

    #[test]
    fn a_timeout_envelope_says_what_did_not_happen() {
        let envelope = Envelope {
            smoke: "timeout",
            ok: false,
            app_version: String::new(),
            os: "windows",
            arch: "x86_64",
            webview_version: "141.0.0.0".into(),
            elapsed_ms: 120_000,
            frontend: None,
            detail: Some("the webview never reported ready".into()),
        };
        let json: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&envelope).expect("serialises"))
                .expect("round-trips");
        assert_eq!(json["smoke"], "timeout");
        assert_eq!(json["ok"], false);
        assert!(json.get("frontend").is_none());
        assert!(json["detail"].as_str().is_some());
    }

    #[test]
    fn the_frontend_report_deserialises_from_the_camel_case_the_webview_sends() {
        let raw = r#"{
            "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Edg/141.0.0.0",
            "mounted": true,
            "rootWidth": 1280,
            "rootHeight": 800,
            "elementCount": 240,
            "bodyBackground": "rgb(17, 17, 20)",
            "bootErrors": ["error: boom"],
            "readyMs": 412.5,
            "devicePixelRatio": 1,
            "language": "en-US"
        }"#;
        let report: FrontendReport = serde_json::from_str(raw).expect("parses");
        assert!(report.user_agent.contains("Edg/"));
        assert!(report.mounted);
        assert_eq!(report.element_count, 240);
        assert_eq!(report.boot_errors, vec!["error: boom".to_string()]);
    }
}
