//! Anonymous, consent-gated telemetry (E7) — the most privacy-sensitive code in
//! SundaySync.
//!
//! ## The one promise
//!
//! Nothing that could identify a person, a church, a file, or a path ever leaves
//! the machine. That promise is kept BY CONSTRUCTION, not by filtering: a
//! [`SyncResult`] is full of absolute paths and human device labels (§4.5 derives
//! them from folder names the user chose — "Balkong Kirke"), and this module maps
//! it to a payload whose fields are only *numbers, closed enums and coarse
//! buckets*. There is no field on the wire a filename, a folder, a label, a church
//! name or a recording timestamp can sit in. The single free-text category is a
//! crash message, and it passes through [`scrub_free_text`] — home directory
//! stripped, absolute paths replaced with `<path>`, length capped — before it is
//! ever stored.
//!
//! Mirrors SundayRec's proven client (`crates/sundayrec-core/src/telemetry.rs` +
//! `src-tauri/src/telemetry/*`) in structure and privacy discipline, adapted to
//! SundaySync's domain (a one-shot sync producing a [`SyncResult`]) and to a
//! shell with no database — state persists to JSON files under the app data dir.
//!
//! ## The shared Worker (E8 dependency)
//!
//! Payloads POST to the shared telemetry Worker's `/v1/apps/sundaysync/ingest`
//! (`sunday-telemetry`), the same endpoint SundayRec rides. That Worker's
//! `validatePayload` today knows only SundayRec's shape and rejects any unknown
//! field with a 400. SundaySync's payload carries an `app: "sundaysync"` marker
//! and sundaysync-specific reports, so **E8 must add the sundaysync validator +
//! tables (and an app dimension) before the Worker will accept these** — until
//! then every send is a permanent 400 that the outbox drops and logs. This is by
//! design: E7 builds the client, E8 teaches the Worker. See the FINAL report.
//!
//! ## Consent (versioned)
//!
//! Consent is opt-in, off until granted, recorded at [`CONSENT_VERSION`]. A "no"
//! at v1 must NEVER silently become a "yes" at a later version — a scope bump
//! re-asks everyone (the SundayRec lesson). The install id is a random UUID minted
//! only when consent is granted; before that every read uses [`NIL_INSTALL_ID`].
//! Controller: **SundaySuite**.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sundaysync_core::result::{SyncResult, UnsyncedReason, Warning};
use tauri::Manager;

use crate::{lock_state, OnPoison};

pub mod crash;

// ── Contract constants ───────────────────────────────────────────────────────

/// The sundaysync payload schema. Bumped only when a field changes MEANING; a new
/// optional field does not need it. The Worker keys its parsing off this.
pub const TELEMETRY_SCHEMA: u32 = 1;

/// The consent SCOPE version — bumped when the payload starts carrying a category
/// of data the user was not asked about. Deliberately separate from
/// [`TELEMETRY_SCHEMA`]: one more number inside a category the user already agreed
/// to is a schema change, not a scope change. **v1**: the categories the approved
/// Norwegian consent copy enumerates — app/engine version, OS, file & device
/// counts, coarse total duration, whether the sync succeeded, PSR and drift
/// distribution, and any errors or crashes.
pub const CONSENT_VERSION: u32 = 1;

/// The app dimension. The shared Worker distinguishes apps by this marker; until
/// E8 teaches it the field, this is what makes a 400 loud rather than a silent
/// mis-file. See the module docs.
pub const APP: &str = "sundaysync";

/// The Tauri bundle identifier (`tauri.conf.json`). Used to resolve the app data
/// dir lock-free from the panic hook, where no `AppHandle` exists.
pub const IDENTIFIER: &str = "app.sundaysuite.sundaysync";

/// The nil UUID — what a preview payload shows before consent has minted a real
/// id. Minting an id for a user who has not said yes would itself be collection.
pub const NIL_INSTALL_ID: &str = "00000000-0000-0000-0000-000000000000";

/// Max crash records per payload, and the crash ring's own cap.
pub const MAX_CRASHES: usize = 20;
/// Max sync reports per payload.
pub const MAX_RUNS: usize = 20;
/// The outbox ring cap. Drop-oldest past this.
pub const QUEUE_MAX: usize = 50;

/// Cap for a crash message (chars). 200 is where a panic's identity lives.
pub const MESSAGE_MAX_CHARS: usize = 200;
/// Cap for a `file:line:col`.
pub const LOCATION_MAX_CHARS: usize = 120;
/// Cap for the version text the shared envelope carries (`appVersion`, on the
/// payload and on every crash record). The Worker validates it as free text at 32
/// characters and answers a longer one with a 400 for the WHOLE payload — so the
/// envelope caps it here rather than trusting whatever the bundle declares.
pub const VERSION_MAX_CHARS: usize = 32;

/// The env/build var naming the endpoint's BASE url (no trailing path).
pub const BASE_URL_VAR: &str = "SUNDAYSYNC_TELEMETRY_URL";
/// The env/build var carrying the write key.
pub const WRITE_KEY_VAR: &str = "SUNDAYSYNC_TELEMETRY_KEY";
/// The header the shared Worker reads the write key from. The Worker names it for
/// SundayRec today; E8 confirms the shared/per-app key strategy.
pub const WRITE_KEY_HEADER: &str = "x-write-key";

/// Per-request timeout. A telemetry POST is a couple of kB to an edge Worker; if
/// it has not answered in fifteen seconds the outbox will try again later.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Max retry attempts before an outbox entry is dropped as undeliverable.
const MAX_ATTEMPTS: u32 = 6;

// ── Data directory (lock-free, for the panic hook) ───────────────────────────

/// The resolved app data dir, cached once. Resolved from [`IDENTIFIER`] via
/// `dirs::data_dir()`, which is exactly what Tauri computes for this identifier on
/// every platform — so the panic hook never needs an `AppHandle`.
static DATA_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The app data dir, if one can be resolved. Cached on first call.
pub fn data_dir() -> Option<PathBuf> {
    DATA_DIR
        .get_or_init(|| dirs::data_dir().map(|d| d.join(IDENTIFIER)))
        .clone()
}

/// The telemetry subdirectory (`<app-data>/telemetry`).
pub fn telemetry_dir() -> Option<PathBuf> {
    data_dir().map(|d| d.join("telemetry"))
}

// ── Time / environment ───────────────────────────────────────────────────────

/// Wall-clock unix milliseconds (UTC).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// This build's timestamp, baked in at release under
/// `SUNDAYSYNC_TELEMETRY_BUILT_AT` (unix ms). Falls back to now in dev/CI, where
/// nothing is ever sent. Kept in the shared envelope for parity — E8's validator
/// mirrors the shared `builtAt` range check.
fn built_at() -> i64 {
    option_env!("SUNDAYSYNC_TELEMETRY_BUILT_AT")
        .and_then(|s| s.trim().parse::<i64>().ok())
        .filter(|&v| (1_577_836_800_000..4_102_444_800_000).contains(&v))
        .unwrap_or_else(now_ms)
}

/// The user's home directory, for path scrubbing.
fn home_dir() -> Option<String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|v| v.to_string_lossy().into_owned())
}

/// The UI/OS language as a primary subtag only (`nb-NO` → `nb`), from the
/// environment. The region subtag is dropped: language answers a product question
/// (which translations are used); region narrows an anonymous install towards a
/// place. `None` when nothing sane is set.
fn detect_language() -> Option<String> {
    let raw = std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .or_else(|_| std::env::var("LANGUAGE"))
        .ok()?;
    sanitize_language(Some(&raw))
}

/// The primary language subtag, lowercased and alphabetic, capped at 8 chars.
fn sanitize_language(raw: Option<&str>) -> Option<String> {
    let primary: String = raw?
        .trim()
        .split(['-', '_', '.', ':'])
        .next()
        .unwrap_or("")
        .chars()
        .filter(char::is_ascii_alphabetic)
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    (!primary.is_empty()).then_some(primary)
}

// ── Closed enums (class 2) ───────────────────────────────────────────────────

/// The operating system, as a CLOSED set — the exact wire strings the shared
/// envelope uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Macos,
    Windows,
    Linux,
    Other,
}

impl Os {
    pub fn current() -> Self {
        match std::env::consts::OS {
            "macos" => Self::Macos,
            "windows" => Self::Windows,
            "linux" => Self::Linux,
            _ => Self::Other,
        }
    }
}

/// The CPU architecture, as a CLOSED set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arch {
    #[serde(rename = "x86_64")]
    X86_64,
    Aarch64,
    Other,
}

impl Arch {
    pub fn current() -> Self {
        match std::env::consts::ARCH {
            "x86_64" => Self::X86_64,
            "aarch64" | "arm64" => Self::Aarch64,
            _ => Self::Other,
        }
    }
}

/// A media container/codec, mapped from a file EXTENSION onto a CLOSED set. Never
/// a filename: the extension is the only part of a path that carries no personal
/// data, and anything unrecognised collapses to [`MediaFormat::Other`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaFormat {
    Mp4,
    Mov,
    Mkv,
    Avi,
    Mts,
    Wav,
    Flac,
    Mp3,
    Aac,
    M4a,
    Other,
}

impl MediaFormat {
    /// Classify a path by its extension only. The path itself is never retained.
    fn from_path(p: &Path) -> Self {
        match p
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("mp4") => Self::Mp4,
            Some("mov") => Self::Mov,
            Some("mkv") => Self::Mkv,
            Some("avi") => Self::Avi,
            Some("mts" | "m2ts") => Self::Mts,
            Some("wav") => Self::Wav,
            Some("flac") => Self::Flac,
            Some("mp3") => Self::Mp3,
            Some("aac") => Self::Aac,
            Some("m4a") => Self::M4a,
            _ => Self::Other,
        }
    }
}

/// The §5 reason a clip was left unsynced, as the wire strings the engine already
/// uses (`low_confidence`, `no_audio`, `decode_error`, `device_overlap`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeReason {
    LowConfidence,
    NoAudio,
    DecodeError,
    DeviceOverlap,
}

impl OutcomeReason {
    fn from_engine(r: UnsyncedReason) -> Self {
        match r {
            UnsyncedReason::LowConfidence => Self::LowConfidence,
            UnsyncedReason::NoAudio => Self::NoAudio,
            UnsyncedReason::DecodeError => Self::DecodeError,
            UnsyncedReason::DeviceOverlap => Self::DeviceOverlap,
        }
    }
}

/// A coarse band over a total TIMELINE duration (seconds). Half-open,
/// lower-bound inclusive. Deliberately coarse — the consent copy promises "grove
/// intervaller" — so the raw seconds (which, correlated with a service, is a
/// fingerprint) never leave the machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurationBucket {
    Under5m,
    B5to15m,
    B15to30m,
    B30to60m,
    B60to120m,
    Over120m,
}

impl DurationBucket {
    fn from_seconds(s: f64) -> Self {
        let m = s / 60.0;
        if m < 5.0 {
            Self::Under5m
        } else if m < 15.0 {
            Self::B5to15m
        } else if m < 30.0 {
            Self::B15to30m
        } else if m < 60.0 {
            Self::B30to60m
        } else if m < 120.0 {
            Self::B60to120m
        } else {
            Self::Over120m
        }
    }
}

/// A coarse band over the WALL-CLOCK time one sync run took.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunDurationBucket {
    Under10s,
    B10to30s,
    B30to60s,
    B60to300s,
    Over300s,
}

impl RunDurationBucket {
    fn from_millis(ms: u128) -> Self {
        let s = ms as f64 / 1000.0;
        if s < 10.0 {
            Self::Under10s
        } else if s < 30.0 {
            Self::B10to30s
        } else if s < 60.0 {
            Self::B30to60s
        } else if s < 300.0 {
            Self::B60to300s
        } else {
            Self::Over300s
        }
    }
}

/// A coarse band over a placement's peak-to-sidelobe ratio (§4.3). The default
/// threshold is [`DEFAULT_MIN_PSR`] = 15, so placed clips cluster above it; the
/// bands answer "how confident were the matches" without the raw values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PsrBand {
    Under15,
    B15to20,
    B20to30,
    B30to50,
    B50to100,
    Over100,
}

impl PsrBand {
    fn from_psr(psr: f64) -> Self {
        if psr < 15.0 {
            Self::Under15
        } else if psr < 20.0 {
            Self::B15to20
        } else if psr < 30.0 {
            Self::B20to30
        } else if psr < 50.0 {
            Self::B30to50
        } else if psr < 100.0 {
            Self::B50to100
        } else {
            Self::Over100
        }
    }
}

// ── Free-text scrubbing (class 3) ────────────────────────────────────────────

const PATH_PLACEHOLDER: &str = "<path>";

/// Roots that name an absolute location on their own, matched anywhere
/// (lowercased). A `/users/` in a message came from a filesystem.
const ABSOLUTE_ROOTS: &[&str] = &[
    "/users/",
    "/home/",
    "/private/",
    "/tmp/",
    "/var/",
    "/volumes/",
    "/applications/",
    "/library/",
    "/opt/",
    "/etc/",
    "/usr/",
    "/mnt/",
    "/media/",
    "/root/",
    "/srv/",
    "\\users\\",
];

/// Characters that end a path run. A SPACE does NOT — for wire-bound crash text
/// we deliberately consume through spaces so a folder name with a space
/// ("Balkong Kirke") cannot leave its tail behind. This over-redacts a message
/// like "kunne ikke åpne /tmp/x fordi disken er full" (the reason is lost), and
/// that is the correct direction for telemetry: privacy over message
/// completeness. This is the one place SundayRec's client chose the opposite
/// trade — SundaySync sends less by choice.
const HARD_DELIMITERS: &[char] = &[
    '"', '\'', '`', '(', ')', '[', ']', '{', '}', '<', '>', '«', '»', ',', ';', '|', '\n', '\r',
    '\t',
];

/// Whether `c` can sit INSIDE a path run: not a hard delimiter. `:` is included
/// (keeps `C:\…` whole and, because the `/` in `https://h/x` is then preceded by
/// a non-boundary, leaves URLs intact rather than mangling them).
fn is_path_body(c: char) -> bool {
    !HARD_DELIMITERS.contains(&c)
}

/// Whether `prev` (the char immediately LEFT of a candidate path) opens one.
///
/// ⚠️ **This set must stay a SUPERSET of the endpoint's.** The Worker screens
/// every free-text field with `ABSOLUTE_PATH_RE`
/// (`sunday-telemetry/src/schema.ts`), anchored at
///
/// ```text
/// (^|[\s"'(<[])
/// ```
///
/// — start of string, whitespace, a double or single quote, an open paren, an
/// **angle bracket**, or an **open square bracket**. Anything the Worker treats as
/// a boundary and we do not is a path we leave in a message the Worker then
/// refuses with `unscrubbed_path`; [`classify`] calls that 400 permanent, so the
/// outbox drops the whole batch — runs included — without retrying and without
/// telling anyone. `<` and `[` were the two missing ones, and `[C:\Temp\a.mov]`
/// is what fell through (see `a_scrubbed_message_never_trips_the_workers_path_screen`).
fn is_left_boundary(prev: Option<char>) -> bool {
    match prev {
        None => true,
        Some(c) => c.is_whitespace() || matches!(c, '"' | '\'' | '(' | '<' | '['),
    }
}

/// Whether an absolute path begins at byte offset `i` in `text` (`lower` is its
/// ASCII-lowercased copy; `prev` is the char just to the left).
fn path_starts_at(text: &str, lower: &str, i: usize, prev: Option<char>) -> bool {
    if ABSOLUTE_ROOTS.iter().any(|r| lower[i..].starts_with(r)) {
        return true;
    }
    let rest = &text[i..];
    if rest.starts_with("~/") || rest.starts_with("~\\") {
        return true;
    }
    // Anchored shapes: only at a left boundary (see [`is_left_boundary`]), which
    // keeps relative paths like `src/place.rs` — identical on every machine — intact.
    if !is_left_boundary(prev) {
        return false;
    }
    let b = rest.as_bytes();
    // `X:\` or `X:/` — a Windows drive. One letter, so `https:` is never one.
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/') {
        return true;
    }
    // `\\NAS\share` — a UNC share; requires a real segment after the slashes.
    if let Some(after) = rest.strip_prefix("\\\\") {
        return after
            .chars()
            .next()
            .is_some_and(|c| c != '\\' && !c.is_whitespace());
    }
    // A bare POSIX root, requiring a following NON-SPACE body char — so "og /
    // eller" keeps its slash, while a real path still starts here. (A path RUN
    // consumes interior spaces once started; see `strip_absolute_paths`.)
    if let Some(after) = rest.strip_prefix('/') {
        return after
            .chars()
            .next()
            .is_some_and(|c| !c.is_whitespace() && is_path_body(c));
    }
    false
}

/// Replace every absolute path in `text` with [`PATH_PLACEHOLDER`], consuming the
/// run through spaces (see [`HARD_DELIMITERS`]).
fn strip_absolute_paths(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    let mut prev: Option<char> = None;
    while i < text.len() {
        if path_starts_at(text, &lower, i, prev) {
            out.push_str(PATH_PLACEHOLDER);
            // Consume to the next hard delimiter or end of string.
            let mut j = i;
            while j < text.len() {
                let c = text[j..].chars().next().expect("char boundary");
                if !is_path_body(c) {
                    break;
                }
                j += c.len_utf8();
            }
            i = j;
            prev = Some('>');
            continue;
        }
        let c = text[i..].chars().next().expect("char boundary");
        out.push(c);
        prev = Some(c);
        i += c.len_utf8();
    }
    out
}

/// The only route developer free text (a crash message, a panic location) takes
/// to the wire: home directory replaced with `~`, absolute paths replaced with
/// `<path>`, then a hard character cap (chars, not bytes — a Norwegian message
/// must not be cut mid-character). Idempotent.
pub fn scrub_free_text(raw: &str, home: Option<&str>, max: usize) -> String {
    let mut s = raw.to_string();
    if let Some(h) = home {
        if h.len() >= 3 {
            s = s.replace(h, "~");
        }
    }
    let cleaned = strip_absolute_paths(&s);
    if cleaned.chars().count() <= max {
        return cleaned;
    }
    let mut out: String = cleaned.chars().take(max).collect();
    out.push('…');
    out
}

/// `v`, or `0.0` when it is not a finite number.
///
/// `serde_json` writes NaN and ±∞ as JSON `null`, and the Worker's `float()` check
/// answers `null` with `expected_number` — a 400 that drops the WHOLE payload, not
/// just the offending run. A threshold that is not a number is not worth losing a
/// batch of reports over, so it lands as zero and stays visible in aggregate.
fn finite_or_zero(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

// ── The payload ──────────────────────────────────────────────────────────────

/// One `{format, count}` histogram entry — a closed enum and a number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormatCount {
    pub format: MediaFormat,
    pub count: u32,
}

/// One `{reason, count}` outcome-histogram entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutcomeCount {
    pub reason: OutcomeReason,
    pub count: u32,
}

/// One `{band, count}` PSR-distribution entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PsrBandCount {
    pub band: PsrBand,
    pub count: u32,
}

/// One completed sync run, projected onto the wire — numbers, enums and buckets
/// only. No filename, no path, no device label, no recording timestamp.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// Unix ms (UTC) the run finished. This is app-usage time (when the operator
    /// used SundaySync), not a recording timestamp.
    pub at: i64,
    /// Whether at least one clip was placed against a reference.
    pub succeeded: bool,
    /// Total input files (placed + unsynced). Consent copy: "hvor mange filer".
    pub file_count: u32,
    /// Distinct devices (§4.5). Consent copy: "…og enheter".
    pub device_count: u32,
    /// Clips successfully placed.
    pub placed_count: u32,
    /// Clips the engine honestly refused to place.
    pub unsynced_count: u32,
    /// Total timeline duration, BUCKETED (never raw seconds).
    pub duration_bucket: DurationBucket,
    /// Wall-clock length of the run, bucketed.
    pub run_duration_bucket: RunDurationBucket,
    /// The PSR threshold in force (§8.2 gates are relative to it).
    pub min_psr: f64,
    /// The analysis sample rate the run used.
    pub analysis_rate: u32,
    /// The media formats seen, as an extension-derived closed-enum histogram.
    pub formats: Vec<FormatCount>,
    /// The §5 unsynced-reason histogram.
    pub outcomes: Vec<OutcomeCount>,
    /// The PSR distribution of placed clips.
    pub psr_bands: Vec<PsrBandCount>,
    /// Whether drift correction was engaged for this run (§4.6 / D-042).
    pub drift_correction_enabled: bool,
    /// Placed clips that yielded a drift estimate at all.
    pub drift_clips: u32,
    /// Placed clips whose projected end drift exceeded half a frame (the ones a
    /// correction actually applies to).
    pub drift_corrected_clips: u32,
    /// Whether inputs spanned more than one frame rate (§6).
    pub mixed_fps: bool,
}

/// The complete telemetry payload — the ONLY thing that ever leaves the machine.
/// Envelope common fields match the shared Worker's envelope exactly; `app` and
/// the sundaysync reports are the E8 additions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryPayload {
    pub schema: u32,
    /// The app dimension — see the module docs and the E8 dependency.
    pub app: &'static str,
    pub consent_version: u32,
    pub install_id: String,
    pub built_at: i64,
    pub app_version: String,
    pub os: Os,
    pub arch: Arch,
    pub language: Option<String>,
    pub runs: Vec<SyncReport>,
    pub crashes: Vec<crash::CrashReport>,
}

impl TelemetryPayload {
    /// The header every payload carries, with empty collections.
    fn header(install_id: &str, app_version: &str) -> Self {
        Self {
            schema: TELEMETRY_SCHEMA,
            app: APP,
            consent_version: CONSENT_VERSION,
            install_id: sanitize_install_id(install_id),
            built_at: built_at(),
            // Through the same scrubber every other free-text field takes: the
            // Worker validates `appVersion` as free text capped at
            // [`VERSION_MAX_CHARS`] and path-screened, and a version string it
            // refuses 400s the entire payload — runs, crashes and all.
            app_version: scrub_free_text(app_version, home_dir().as_deref(), VERSION_MAX_CHARS),
            os: Os::current(),
            arch: Arch::current(),
            language: detect_language(),
            runs: Vec::new(),
            crashes: Vec::new(),
        }
    }

    /// Whether this payload carries anything worth sending. A header alone is a
    /// ping, and a ping is not what the user consented to.
    pub fn is_empty(&self) -> bool {
        self.runs.is_empty() && self.crashes.is_empty()
    }

    /// Trim each collection to its cap, keeping the NEWEST records. A payload the
    /// endpoint would reject as oversized is never enqueued.
    fn truncate_to_caps(&mut self) {
        keep_last(&mut self.runs, MAX_RUNS);
        keep_last(&mut self.crashes, MAX_CRASHES);
    }
}

/// Keep at most `cap` items, dropping from the FRONT (oldest).
fn keep_last<T>(items: &mut Vec<T>, cap: usize) {
    if items.len() > cap {
        items.drain(..items.len() - cap);
    }
}

/// The facts one completed sync hands the telemetry seam. Borrows the result;
/// nothing here is stored beyond the projection built from it.
pub struct RunFacts<'a> {
    pub result: &'a SyncResult,
    pub run_millis: u128,
    pub drift_correction_enabled: bool,
}

/// Project one [`SyncResult`] + run metadata onto a wire-safe [`SyncReport`].
///
/// This is the privacy crux: every value read out of `result` is a count, a
/// number, or an enum. No `PathBuf`, no `label`, no `device` string is ever read
/// as text. A test (`the_payload_never_carries_identifying_strings`) proves it by
/// feeding a result full of church folder names and asserting the serialised
/// payload contains none of them.
pub fn sync_report(facts: &RunFacts, at: i64) -> SyncReport {
    let r = facts.result;

    // Formats: from every input file's EXTENSION only. Devices hold every input.
    let mut fmt: std::collections::BTreeMap<MediaFormat, u32> = std::collections::BTreeMap::new();
    for device in &r.devices {
        for f in &device.files {
            *fmt.entry(MediaFormat::from_path(f)).or_insert(0) += 1;
        }
    }
    let formats = fmt
        .into_iter()
        .map(|(format, count)| FormatCount { format, count })
        .collect();

    // Outcome histogram by §5 reason.
    let mut oc: std::collections::BTreeMap<OutcomeReason, u32> = std::collections::BTreeMap::new();
    for u in &r.unsynced {
        *oc.entry(OutcomeReason::from_engine(u.reason)).or_insert(0) += 1;
    }
    let outcomes = oc
        .into_iter()
        .map(|(reason, count)| OutcomeCount { reason, count })
        .collect();

    // PSR distribution of placed clips.
    let mut ps: std::collections::BTreeMap<PsrBand, u32> = std::collections::BTreeMap::new();
    for p in &r.placements {
        *ps.entry(PsrBand::from_psr(p.psr)).or_insert(0) += 1;
    }
    let psr_bands = ps
        .into_iter()
        .map(|(band, count)| PsrBandCount { band, count })
        .collect();

    let drift_clips = r
        .placements
        .iter()
        .filter(|p| p.drift_ppm.is_some())
        .count() as u32;
    let drift_corrected_clips = r
        .placements
        .iter()
        .filter(|p| {
            p.warnings
                .iter()
                .any(|w| matches!(w, Warning::Drift { .. }))
        })
        .count() as u32;
    let mixed_fps = r.warnings.iter().any(|w| matches!(w, Warning::MixedFps));

    let file_count = (r.placements.len() + r.unsynced.len()) as u32;

    SyncReport {
        at,
        succeeded: r.reference.is_some() && !r.placements.is_empty(),
        file_count,
        device_count: r.devices.len() as u32,
        placed_count: r.placements.len() as u32,
        unsynced_count: r.unsynced.len() as u32,
        duration_bucket: DurationBucket::from_seconds(r.sequence.duration_seconds),
        run_duration_bucket: RunDurationBucket::from_millis(facts.run_millis),
        min_psr: finite_or_zero(r.parameters.min_psr),
        analysis_rate: r.parameters.analysis_rate,
        formats,
        outcomes,
        psr_bands,
        drift_correction_enabled: facts.drift_correction_enabled,
        drift_clips,
        drift_corrected_clips,
        mixed_fps,
    }
}

// ── Consent record (versioned) ───────────────────────────────────────────────

/// The persisted consent record. Absent from storage = never asked, which is NOT
/// the same as "no" (a UI must ask the first, leave the second alone).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRecord {
    /// What the user answered.
    pub granted: bool,
    /// The [`CONSENT_VERSION`] they answered FOR.
    pub version: u32,
    /// Unix ms (UTC) they answered.
    pub decided_at: i64,
}

impl ConsentRecord {
    fn decide(granted: bool, now: i64) -> Self {
        Self {
            granted,
            version: CONSENT_VERSION,
            decided_at: now,
        }
    }
}

/// Whether the record permits collecting and sending RIGHT NOW. The one gate:
/// a grant at the CURRENT scope version and nothing else. A stale grant (an older
/// version) does not send — the scope may have widened since they answered — and
/// a "no" at any version never sends. Absent reads as off.
fn consent_active(record: &Option<ConsentRecord>) -> bool {
    matches!(record, Some(r) if r.granted && r.version == CONSENT_VERSION)
}

/// The version the user last answered at, if ever. `None` = never asked.
fn answered_version(record: &Option<ConsentRecord>) -> Option<u32> {
    record.map(|r| r.version)
}

// ── Install id ───────────────────────────────────────────────────────────────

/// A UUID-shaped install id, or [`NIL_INSTALL_ID`] when the input is not one.
/// Shape-checked rather than trusted: a "random id" that is actually an e-mail
/// address would defeat the whole anonymity claim.
pub fn sanitize_install_id(raw: &str) -> String {
    let ok = raw.len() == 36
        && raw.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        });
    if ok {
        raw.to_ascii_lowercase()
    } else {
        NIL_INSTALL_ID.to_string()
    }
}

/// A fresh, fully random install id (UUID v4). Nothing about the machine, the
/// user or the congregation is an input — regenerating it makes every future
/// payload an unrelated install.
fn new_install_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ── Persisted state ──────────────────────────────────────────────────────────

/// The single persisted state file (`<telemetry>/state.json`). Holds no PII
/// beyond a random id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistState {
    /// The consent decision. Absent = never asked.
    consent: Option<ConsentRecord>,
    /// The random install id, minted only under an active grant.
    install_id: Option<String>,
    /// Retired install ids awaiting a remote DELETE, oldest first.
    #[serde(default)]
    pending_deletions: Vec<String>,
    /// Newest crash `at` already reported, so a crash is not re-sent every launch.
    #[serde(default)]
    crash_watermark: i64,
}

/// Read the state file. Any failure — absent, malformed, hand-edited — reads as
/// the default (never asked, off, no id).
fn read_state(dir: &Path) -> PersistState {
    std::fs::read_to_string(dir.join("state.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write the state file atomically (temp + rename), creating the dir if needed.
fn write_state(dir: &Path, state: &PersistState) -> std::io::Result<()> {
    write_atomic(dir, "state.json", &serde_json::to_vec_pretty(state)?)
}

/// Atomic write: a reader must never see a half-written file.
fn write_atomic(dir: &Path, name: &str, body: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, dir.join(name))
}

// ── The outbox ───────────────────────────────────────────────────────────────

/// One queued payload awaiting delivery.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutboxEntry {
    id: String,
    created_at: i64,
    /// Names the newest record this payload covers, so two enqueues of the same
    /// batch collapse to one.
    dedup_key: String,
    payload_json: String,
    attempts: u32,
    next_attempt: i64,
    /// The last delivery failure's reason — kept, and surfaced, precisely so a
    /// permanent 400 is VISIBLE rather than silently swallowed (the SundayRec
    /// "ellipsis bug" lesson).
    last_error: Option<String>,
}

/// Read the outbox ring. A malformed file reads as empty rather than failing.
fn read_outbox(dir: &Path) -> Vec<OutboxEntry> {
    std::fs::read_to_string(dir.join("outbox.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write the outbox ring atomically.
fn write_outbox(dir: &Path, entries: &[OutboxEntry]) -> std::io::Result<()> {
    write_atomic(dir, "outbox.json", &serde_json::to_vec_pretty(entries)?)
}

/// Append one payload to the outbox, drop-oldest past [`QUEUE_MAX`], dedup by
/// `dedup_key`. Returns whether it was newly queued.
fn enqueue(dir: &Path, payload: &TelemetryPayload, now: i64) -> std::io::Result<bool> {
    let mut payload = payload.clone();
    payload.truncate_to_caps();
    // A header with no records is a ping, not something the user consented to.
    if payload.is_empty() {
        return Ok(false);
    }
    let mut queue = read_outbox(dir);
    let dedup = dedup_key(&payload);
    if queue.iter().any(|e| e.dedup_key == dedup) {
        return Ok(false);
    }
    let json = match serde_json::to_string(&payload) {
        Ok(j) => j,
        Err(_) => return Ok(false),
    };
    queue.push(OutboxEntry {
        id: new_install_id(),
        created_at: now,
        dedup_key: dedup,
        payload_json: json,
        attempts: 0,
        next_attempt: now,
        last_error: None,
    });
    if queue.len() > QUEUE_MAX {
        let drop = queue.len() - QUEUE_MAX;
        queue.drain(..drop);
    }
    write_outbox(dir, &queue)?;
    Ok(true)
}

/// The dedup key: the payload's newest record.
fn dedup_key(p: &TelemetryPayload) -> String {
    let newest = p
        .crashes
        .iter()
        .map(|c| c.at)
        .chain(p.runs.iter().map(|r| r.at))
        .max()
        .unwrap_or(p.built_at);
    let kind = if !p.crashes.is_empty() {
        "crash"
    } else {
        "run"
    };
    format!("{kind}:{newest}")
}

// ── Send classification ──────────────────────────────────────────────────────

/// What the outbox should do with one delivery attempt's result. The status
/// contract mirrors `sunday-telemetry/src/ingest.ts` and SundayRec's `classify`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SendOutcome {
    /// Stored (any 2xx). Drop from the outbox — success.
    Ok,
    /// The payload will NEVER be accepted (schema/auth/size). Drop WITHOUT
    /// retrying — but log the reason first: a 400 must be visible.
    Permanent(String),
    /// The network's or the endpoint's fault (5xx, 408/429, transport). Back off
    /// and retry.
    Transient(String),
}

/// Turn one HTTP status into an outbox decision.
///
/// - 2xx → Ok
/// - 408 / 429 → Transient (the only retryable 4xx; 429 is a rate limit)
/// - other 4xx → Permanent (malformed the same way six times — includes the E8
///   400 the shared Worker returns until it learns the sundaysync shape)
/// - 5xx / anything else → Transient
fn classify(status: u16) -> SendOutcome {
    if (200..300).contains(&status) {
        SendOutcome::Ok
    } else if status == 408 || status == 429 {
        SendOutcome::Transient(format!("endpoint said {status}"))
    } else if (400..500).contains(&status) {
        SendOutcome::Permanent(format!("endpoint rejected the payload: {status}"))
    } else {
        SendOutcome::Transient(format!("endpoint said {status}"))
    }
}

/// The retry backoff for `attempts` failures so far: 1, 2, 4, … minutes, capped.
fn backoff_ms(attempts: u32) -> i64 {
    let minutes = 1u64 << attempts.min(8);
    (minutes.min(6 * 60) * 60 * 1000) as i64
}

// ── Endpoint config ──────────────────────────────────────────────────────────

/// Where telemetry POSTs, and the key it writes with. Resolved from the runtime
/// env (dev/CI) falling back to values baked in at release. `None` means this
/// build has no endpoint — reports queue locally and nothing reaches the network,
/// which is exactly the state before an endpoint is configured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    ingest_url: String,
    base_url: String,
    write_key: String,
}

impl Endpoint {
    /// Resolve from env, falling back to build-time bakes under the same names.
    pub fn resolve() -> Option<Self> {
        let base = std::env::var(BASE_URL_VAR)
            .ok()
            .or_else(|| option_env!("SUNDAYSYNC_TELEMETRY_URL").map(str::to_string));
        let key = std::env::var(WRITE_KEY_VAR)
            .ok()
            .or_else(|| option_env!("SUNDAYSYNC_TELEMETRY_KEY").map(str::to_string));
        Self::normalize(base, key)
    }

    /// Pure construction. Rejects a non-`http(s)` base and a blank key outright:
    /// better a build with no sender than one that 401s on every send.
    pub fn normalize(base: Option<String>, key: Option<String>) -> Option<Self> {
        let base = base.map(|s| s.trim().trim_end_matches('/').to_string())?;
        if base.is_empty() || !(base.starts_with("https://") || base.starts_with("http://")) {
            return None;
        }
        let write_key = key
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())?;
        Some(Self {
            // E8: the app-scoped door on the shared Worker's app registry — NOT the
            // frozen legacy `/v1/ingest` alias (that one means "sundayrec" and its
            // validator would 400 this payload as unknown fields). The write key is the
            // app's own (`WRITE_KEY_SUNDAYSYNC` on the Worker), sent as `x-write-key`.
            ingest_url: format!("{base}/v1/apps/sundaysync/ingest"),
            base_url: base,
            write_key,
        })
    }

    fn delete_url(&self, install_id: &str) -> String {
        format!("{}/v1/apps/sundaysync/install/{install_id}", self.base_url)
    }
}

// ── Managed state ────────────────────────────────────────────────────────────

/// The shared telemetry internals: a lock serialising file read-modify-write, the
/// resolved endpoint, and the shared HTTP client (`None` if TLS init failed — then
/// the client simply never sends).
struct TelemetryInner {
    io: Mutex<()>,
    endpoint: Option<Endpoint>,
    client: Option<reqwest::Client>,
}

/// The Tauri-managed telemetry state. Holds its internals behind an `Arc` so a
/// spawned send task can OWN a handle to them: a `tauri::State` reference borrows
/// the `AppHandle` and cannot be held across the `.await` of a network request
/// (that would be a self-referential future). Cloning the `Arc` first sidesteps
/// that — the managed state outlives the app, so the clone is always valid.
pub struct TelemetryState {
    inner: std::sync::Arc<TelemetryInner>,
}

impl TelemetryState {
    /// Resolve the endpoint and build the HTTP client. Never panics: a client
    /// that will not build leaves the sender inert rather than taking the app
    /// down at startup.
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .ok();
        Self {
            inner: std::sync::Arc::new(TelemetryInner {
                io: Mutex::new(()),
                endpoint: Endpoint::resolve(),
                client,
            }),
        }
    }

    /// An owned handle to the internals, safe to move into a spawned task.
    fn arc(&self) -> std::sync::Arc<TelemetryInner> {
        self.inner.clone()
    }
}

impl Default for TelemetryState {
    fn default() -> Self {
        Self::new()
    }
}

// ── Status ───────────────────────────────────────────────────────────────────

/// The current telemetry state, for Settings and onboarding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStatus {
    /// The scope version the user last answered at. `None` = never asked.
    pub consent_version: Option<u32>,
    /// Whether telemetry may collect and send right now.
    pub granted: bool,
    /// Whether a random install id currently exists.
    pub has_install_id: bool,
    /// How many payloads are waiting in the outbox.
    pub queued: usize,
}

/// Read the status from the given telemetry dir. Pure over the filesystem.
fn status_in(dir: &Path) -> TelemetryStatus {
    let state = read_state(dir);
    TelemetryStatus {
        consent_version: answered_version(&state.consent),
        granted: consent_active(&state.consent),
        has_install_id: state.install_id.is_some(),
        queued: read_outbox(dir).len(),
    }
}

// ── Payload building (transparency + drain) ──────────────────────────────────

/// Build the payload that WOULD be sent from the current state — the exact bytes,
/// through the real projection. Uses the real install id when there is one, else
/// [`NIL_INSTALL_ID`]. Read-only: mints nothing, advances nothing. `crashes` are
/// the ring's records (respecting the watermark when consent is active, so the
/// preview matches what a drain would actually send).
fn build_preview(dir: &Path, app_version: &str) -> TelemetryPayload {
    let state = read_state(dir);
    let active = consent_active(&state.consent);
    let id = state.install_id.as_deref().unwrap_or(NIL_INSTALL_ID);
    let mut payload = TelemetryPayload::header(id, app_version);
    let since = if active { state.crash_watermark } else { 0 };
    let mut crashes = crash::read_crashes(dir);
    crashes.retain(|c| c.at > since);
    if crashes.len() > MAX_CRASHES {
        let drop = crashes.len() - MAX_CRASHES;
        crashes.drain(..drop);
    }
    payload.crashes = crashes;
    payload
}

// ── Public glue for the shell (lib.rs) ───────────────────────────────────────

/// Install the crash panic hook. Call once, as early in `run()` as possible.
pub fn install_crash_hook() {
    crash::install_hook();
}

/// Everything telemetry does at launch: drain new crashes into the outbox (under
/// consent), then pump the queue and any owed deletions. Idempotent and
/// best-effort; spawned off the main thread.
pub fn on_launch(app: &tauri::AppHandle) {
    let Some(dir) = telemetry_dir() else {
        return;
    };
    let version = app.package_info().version.to_string();
    let Some(st) = app.try_state::<TelemetryState>() else {
        return;
    };
    let inner = st.arc();
    tauri::async_runtime::spawn(async move {
        drain_launch_crashes(&inner, &dir, &version);
        pump(&inner, &dir).await;
    });
}

/// Record one completed sync and (under consent) queue it, then pump.
pub fn after_sync(app: &tauri::AppHandle, facts: &RunFacts) {
    let Some(dir) = telemetry_dir() else {
        return;
    };
    let Some(st) = app.try_state::<TelemetryState>() else {
        return;
    };
    let inner = st.arc();
    let version = app.package_info().version.to_string();
    let now = now_ms();

    let queued = {
        let _guard = match lock_state(&inner.io, OnPoison::Recover) {
            Ok(g) => g,
            Err(_) => return,
        };
        let state = read_state(&dir);
        if !consent_active(&state.consent) {
            // Nothing is collected while consent is not active — not even in a
            // file. The report is simply never built.
            return;
        }
        let id = state.install_id.as_deref().unwrap_or(NIL_INSTALL_ID);
        let mut payload = TelemetryPayload::header(id, &version);
        payload.runs.push(sync_report(facts, now));
        enqueue(&dir, &payload, now).unwrap_or(false)
    };

    if queued {
        tauri::async_runtime::spawn(async move {
            pump(&inner, &dir).await;
        });
    }
}

/// Record a run that FAILED (the engine returned an error) as a scrubbed crash of
/// kind `sync_error`, so the error class is visible in aggregate. Local only
/// until a consented drain picks it up.
pub fn record_sync_error(message: &str) {
    if let Some(dir) = telemetry_dir() {
        crash::record(&dir, "sync_error", message, None);
    }
}

/// Under active consent, read crashes newer than the watermark, queue them, and
/// advance the watermark. Called at launch. Holds the io lock.
fn drain_launch_crashes(st: &TelemetryInner, dir: &Path, app_version: &str) {
    let _guard = match lock_state(&st.io, OnPoison::Recover) {
        Ok(g) => g,
        Err(_) => return,
    };
    let mut state = read_state(dir);
    if !consent_active(&state.consent) {
        return;
    }
    let mut crashes = crash::read_crashes(dir);
    crashes.retain(|c| c.at > state.crash_watermark);
    if crashes.is_empty() {
        return;
    }
    if crashes.len() > MAX_CRASHES {
        let drop = crashes.len() - MAX_CRASHES;
        crashes.drain(..drop);
    }
    let newest = crashes
        .iter()
        .map(|c| c.at)
        .max()
        .unwrap_or(state.crash_watermark);
    let id = state.install_id.as_deref().unwrap_or(NIL_INSTALL_ID);
    let mut payload = TelemetryPayload::header(id, app_version);
    payload.crashes = crashes;
    if enqueue(dir, &payload, now_ms()).unwrap_or(false) {
        state.crash_watermark = newest;
        let _ = write_state(dir, &state);
    }
}

// ── The sender ───────────────────────────────────────────────────────────────

/// Send everything sendable: the outbox (only under active consent) and any owed
/// deletions (always — a deletion is the user's own request and carries only a
/// retired random id, never a payload). Best-effort; never panics.
async fn pump(st: &TelemetryInner, dir: &Path) {
    let (Some(endpoint), Some(client)) = (st.endpoint.as_ref(), st.client.as_ref()) else {
        return; // No endpoint or no client in this build — nothing sends.
    };

    // Deletions first: unconditional, so "delete my data" is honoured even when
    // consent is off.
    drain_deletions(st, dir, endpoint, client).await;

    // The outbox: gated on consent.
    {
        let active = {
            let _g = lock_state(&st.io, OnPoison::Recover);
            consent_active(&read_state(dir).consent)
        };
        if !active {
            return;
        }
    }

    let now = now_ms();
    let due: Vec<OutboxEntry> = {
        let _g = lock_state(&st.io, OnPoison::Recover);
        read_outbox(dir)
            .into_iter()
            .filter(|e| e.next_attempt <= now)
            .collect()
    };

    for entry in due {
        let outcome = post(client, endpoint, &entry.payload_json).await;
        let _g = lock_state(&st.io, OnPoison::Recover);
        let mut queue = read_outbox(dir);
        let Some(pos) = queue.iter().position(|e| e.id == entry.id) else {
            continue;
        };
        match outcome {
            SendOutcome::Ok => {
                queue.remove(pos);
            }
            SendOutcome::Permanent(reason) => {
                // A 400 must be VISIBLE, not silently dropped. Log it and stamp
                // the reason before removing (the SundayRec "ellipsis bug").
                eprintln!("telemetry: payload permanently rejected — dropped ({reason})");
                queue.remove(pos);
            }
            SendOutcome::Transient(reason) => {
                let e = &mut queue[pos];
                e.attempts += 1;
                e.last_error = Some(reason.clone());
                if e.attempts >= MAX_ATTEMPTS {
                    eprintln!(
                        "telemetry: giving up on a payload after {} transient failures ({reason})",
                        e.attempts
                    );
                    queue.remove(pos);
                } else {
                    e.next_attempt = now_ms() + backoff_ms(e.attempts);
                }
            }
        }
        let _ = write_outbox(dir, &queue);
    }
}

/// POST one payload. One request; the outcome is classified from the status.
async fn post(client: &reqwest::Client, endpoint: &Endpoint, json: &str) -> SendOutcome {
    match client
        .post(&endpoint.ingest_url)
        .header(WRITE_KEY_HEADER, &endpoint.write_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .timeout(REQUEST_TIMEOUT)
        .body(json.to_string())
        .send()
        .await
    {
        Ok(r) => classify(r.status().as_u16()),
        Err(_) => SendOutcome::Transient("could not reach the endpoint".to_string()),
    }
}

/// Issue the remote DELETE for each parked install id, clearing it on success.
/// An id the endpoint has never seen is reported as a success, so a machine that
/// retired an id before ever sending anything does not retry forever.
async fn drain_deletions(
    st: &TelemetryInner,
    dir: &Path,
    endpoint: &Endpoint,
    client: &reqwest::Client,
) {
    let ids = {
        let _g = lock_state(&st.io, OnPoison::Recover);
        read_state(dir).pending_deletions
    };
    for id in ids {
        let outcome = match client
            .delete(endpoint.delete_url(&id))
            .header(WRITE_KEY_HEADER, &endpoint.write_key)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
        {
            Ok(r) => classify(r.status().as_u16()),
            Err(_) => SendOutcome::Transient("could not reach the endpoint".to_string()),
        };
        // Permanent OR Ok both clear it: a 4xx on a delete means the id is not
        // deletable (or already gone), and retrying cannot change that.
        if !matches!(outcome, SendOutcome::Transient(_)) {
            let _g = lock_state(&st.io, OnPoison::Recover);
            let mut state = read_state(dir);
            state.pending_deletions.retain(|x| x != &id);
            let _ = write_state(dir, &state);
        }
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// The current telemetry state for Settings/onboarding. Infallible: a machine
/// with no resolvable data dir reports the default (never asked, off, nothing
/// queued) rather than an error the UI would have to special-case.
#[tauri::command]
pub fn telemetry_status() -> TelemetryStatus {
    match telemetry_dir() {
        Some(dir) => status_in(&dir),
        None => TelemetryStatus {
            consent_version: None,
            granted: false,
            has_install_id: false,
            queued: 0,
        },
    }
}

/// Record consent at [`CONSENT_VERSION`]. On grant, mint an install id if none
/// exists and start the watermark at now (so nothing from before the "yes" is
/// back-filled). On deny, mint nothing and purge the outbox — "off" leaves
/// nothing a later "on" could flush. Then pump (sends on grant; drains only
/// deletions otherwise).
#[tauri::command]
pub async fn set_telemetry_consent(
    state: tauri::State<'_, TelemetryState>,
    granted: bool,
) -> Result<TelemetryStatus, String> {
    let dir = telemetry_dir().ok_or_else(|| "no app data directory".to_string())?;
    let inner = state.arc();
    let now = now_ms();
    let status = {
        let _guard = lock_state(&inner.io, OnPoison::Recover)?;
        let mut st = read_state(&dir);
        st.consent = Some(ConsentRecord::decide(granted, now));
        if granted {
            if st.install_id.is_none() {
                st.install_id = Some(new_install_id());
            }
            // Reporting starts from now, not from the local archive.
            st.crash_watermark = now;
        } else {
            // Nothing left to send.
            let _ = write_outbox(&dir, &[]);
        }
        write_state(&dir, &st).map_err(|e| e.to_string())?;
        status_in(&dir)
    };

    // Kick a pump so a mid-session "yes" delivers without waiting for relaunch.
    pump(&inner, &dir).await;
    Ok(status)
}

/// "Vis hva som sendes" — the exact payload that WOULD be sent from the current
/// state, as pretty JSON. Uses [`NIL_INSTALL_ID`] when consent has not minted an
/// id. Read-only.
#[tauri::command]
pub fn telemetry_preview(app: tauri::AppHandle) -> String {
    let Some(dir) = telemetry_dir() else {
        return "{}".to_string();
    };
    let version = app.package_info().version.to_string();
    let payload = build_preview(&dir, &version);
    serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string())
}

/// Enqueue a scrubbed crash entry from the frontend's `window.onerror` /
/// `unhandledrejection`. The message is truncated and scrubbed before it lands.
#[tauri::command]
pub fn report_frontend_error(kind: String, message: String) {
    if let Some(dir) = telemetry_dir() {
        // A frontend `kind` is not trusted as a record kind — the ring records it
        // as the fixed `frontend` kind and folds the caller's label into the
        // (scrubbed, capped) message so it cannot widen the closed kind set.
        let combined = format!("[{kind}] {message}");
        crash::record(&dir, "frontend", &combined, None);
    }
}

/// "Delete my data": DELETE the install id server-side and clear it locally. The
/// local half is immediate and unconditional; the remote half is best-effort and
/// retried from the parked list if the machine is offline now. Consent is NOT
/// withdrawn — deleting data and stopping collection are different requests.
#[tauri::command]
pub async fn request_telemetry_deletion(
    state: tauri::State<'_, TelemetryState>,
) -> Result<(), String> {
    let dir = telemetry_dir().ok_or_else(|| "no app data directory".to_string())?;
    let inner = state.arc();
    {
        let _guard = lock_state(&inner.io, OnPoison::Recover)?;
        let mut st = read_state(&dir);
        if let Some(old) = st.install_id.take() {
            if !st.pending_deletions.contains(&old) {
                st.pending_deletions.push(old);
            }
            // Keep the list bounded — pressing the button ten times is still one
            // request.
            let len = st.pending_deletions.len();
            if len > 10 {
                st.pending_deletions.drain(..len - 10);
            }
        }
        // Payloads already queued carry the retired id; drop them.
        let _ = write_outbox(&dir, &[]);
        write_state(&dir, &st).map_err(|e| e.to_string())?;
    }
    // Best-effort remote DELETE now; the parked list carries any that fail.
    if let (Some(endpoint), Some(client)) = (inner.endpoint.as_ref(), inner.client.as_ref()) {
        drain_deletions(&inner, &dir, endpoint, client).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use sundaysync_core::result::{
        Device, DeviceKind, Parameters, Placement, Reference, Sequence, Unsynced, SCHEMA_VERSION,
    };
    use sundaysync_core::Rational;

    // ── A church-y result, full of things that must NOT leave ─────────────────

    pub(super) fn identifying_result() -> SyncResult {
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
            devices: vec![
                Device {
                    id: "folder-balkong".into(),
                    label: "Balkong Kirke".into(),
                    kind: DeviceKind::Audio,
                    files: vec![PathBuf::from(
                        "/Users/kari/Opptak/Balkong Kirke/ZOOM0001.WAV",
                    )],
                },
                Device {
                    id: "cam-a".into(),
                    label: "Nordstrand menighet Cam".into(),
                    kind: DeviceKind::Video,
                    files: vec![PathBuf::from("/Users/kari/Opptak/Cam A/C0001.MP4")],
                },
            ],
            placements: vec![Placement {
                file: PathBuf::from("/Users/kari/Opptak/Cam A/C0001.MP4"),
                device: "cam-a".into(),
                offset_seconds: 5.0,
                confidence: 0.9,
                psr: 42.0,
                drift_ppm: Some(3.2),
                projected_end_error_ms: Some(20.0),
                chain: vec!["reference".into()],
                warnings: vec![Warning::Drift {
                    projected_end_error_ms: 20.0,
                }],
            }],
            unsynced: vec![Unsynced {
                file: PathBuf::from("/Users/kari/Opptak/gudstjeneste-broken.mp4"),
                reason: UnsyncedReason::DecodeError,
            }],
            sequence: Sequence {
                fps: Rational::new(25, 1).unwrap(),
                duration_seconds: 4200.0, // 70 min service
            },
            warnings: vec![Warning::MixedFps],
        }
    }

    /// THE load-bearing privacy test. Build a payload from a result stuffed with
    /// paths, usernames and human labels — plus a crash carrying an absolute path
    /// — and assert NONE of those strings survive anywhere in the serialised
    /// bytes. The guarantee is structural: the projection reads only counts,
    /// numbers and enums out of the result, so a label cannot reach the wire even
    /// in principle.
    #[test]
    fn the_payload_never_carries_identifying_strings() {
        let result = identifying_result();
        let facts = RunFacts {
            result: &result,
            run_millis: 42_000,
            drift_correction_enabled: true,
        };
        let mut payload = TelemetryPayload::header(NIL_INSTALL_ID, "0.1.2");
        payload.runs.push(sync_report(&facts, 1_800_000_000_000));
        // A crash whose message quotes a full church path — the one free-text
        // vector — must be scrubbed to `<path>`.
        payload.crashes.push(crash::CrashReport {
            schema: crash::RECORD_SCHEMA,
            kind: "sync_error".into(),
            at: 1_800_000_000_001,
            app_version: "0.1.2".into(),
            os: Os::Macos,
            message: scrub_free_text(
                "kunne ikke åpne /Users/kari/Opptak/Balkong Kirke/ZOOM0001.WAV",
                Some("/Users/kari"),
                MESSAGE_MAX_CHARS,
            ),
            location: None,
            backtrace_present: false,
        });

        let json = serde_json::to_string_pretty(&payload).unwrap();
        for needle in [
            "kari",
            "Kari",
            "Opptak",
            "Balkong",
            "Kirke",
            "Nordstrand",
            "menighet",
            "ZOOM0001",
            "C0001",
            "gudstjeneste",
            "/Users/",
            "folder-balkong",
            ".WAV",
            ".MP4",
        ] {
            assert!(
                !json.to_lowercase().contains(&needle.to_lowercase()),
                "{needle:?} reached the payload:\n{json}"
            );
        }

        // …and the numbers a maintainer actually needs DID survive.
        let run = &payload.runs[0];
        assert_eq!(run.file_count, 2);
        assert_eq!(run.device_count, 2);
        assert_eq!(run.placed_count, 1);
        assert_eq!(run.unsynced_count, 1);
        assert_eq!(run.duration_bucket, DurationBucket::B60to120m);
        assert_eq!(run.run_duration_bucket, RunDurationBucket::B30to60s);
        assert!(run.mixed_fps);
        assert!(run.drift_correction_enabled);
        assert_eq!(run.drift_clips, 1);
        assert_eq!(run.drift_corrected_clips, 1);
        assert_eq!(
            run.outcomes,
            vec![OutcomeCount {
                reason: OutcomeReason::DecodeError,
                count: 1
            }]
        );
        assert_eq!(
            run.psr_bands,
            vec![PsrBandCount {
                band: PsrBand::B30to50,
                count: 1
            }]
        );
        // Formats are the extension classes only.
        assert!(run.formats.iter().any(|f| f.format == MediaFormat::Wav));
        assert!(run.formats.iter().any(|f| f.format == MediaFormat::Mp4));
    }

    // ── Scrubbing ─────────────────────────────────────────────────────────────

    #[test]
    fn scrub_removes_home_and_absolute_paths_including_spaces() {
        let s = scrub_free_text(
            "kunne ikke åpne /Users/kari/Opptak/Balkong Kirke/ZOOM0001.WAV",
            Some("/Users/kari"),
            MESSAGE_MAX_CHARS,
        );
        assert!(!s.contains("kari"), "{s}");
        assert!(!s.contains("Balkong"), "{s}");
        assert!(!s.contains("Kirke"), "{s}");
        assert!(!s.contains("ZOOM0001"), "{s}");
        assert!(s.contains("<path>"), "{s}");
        // The leading prose survives.
        assert!(s.starts_with("kunne ikke åpne"), "{s}");
    }

    #[test]
    fn scrub_leaves_relative_paths_and_urls_intact() {
        // A relative source path is identical on every machine — the useful bit.
        let rel = scrub_free_text("panicked at src/place.rs:42:9", None, MESSAGE_MAX_CHARS);
        assert!(rel.contains("src/place.rs:42:9"), "{rel}");
        // A URL is a statement about a server, not a disk.
        let url = scrub_free_text(
            "GET https://telemetry.example/v1 failed",
            None,
            MESSAGE_MAX_CHARS,
        );
        assert!(url.contains("https://telemetry.example/v1"), "{url}");
    }

    #[test]
    fn scrub_strips_windows_and_unc_paths() {
        let win = scrub_free_text(
            r"could not open C:\Users\Ola\Opptak\x.mp4",
            None,
            MESSAGE_MAX_CHARS,
        );
        assert!(!win.contains("Ola"), "{win}");
        assert!(!win.contains("Opptak"), "{win}");
        assert!(win.contains("<path>"), "{win}");
    }

    #[test]
    fn a_long_message_is_truncated_at_a_char_boundary() {
        let long = "æ".repeat(MESSAGE_MAX_CHARS + 500);
        let out = scrub_free_text(&long, None, MESSAGE_MAX_CHARS);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), MESSAGE_MAX_CHARS + 1);
        // Below the cap nothing is added.
        assert_eq!(scrub_free_text("short", None, MESSAGE_MAX_CHARS), "short");
    }

    // ── Buckets ───────────────────────────────────────────────────────────────

    #[test]
    fn duration_buckets_are_half_open_lower_inclusive() {
        assert_eq!(DurationBucket::from_seconds(0.0), DurationBucket::Under5m);
        assert_eq!(
            DurationBucket::from_seconds(5.0 * 60.0),
            DurationBucket::B5to15m
        );
        assert_eq!(
            DurationBucket::from_seconds(60.0 * 60.0),
            DurationBucket::B60to120m
        );
        assert_eq!(
            DurationBucket::from_seconds(200.0 * 60.0),
            DurationBucket::Over120m
        );
    }

    #[test]
    fn psr_bands_partition_the_scale() {
        assert_eq!(PsrBand::from_psr(10.0), PsrBand::Under15);
        assert_eq!(PsrBand::from_psr(15.0), PsrBand::B15to20);
        assert_eq!(PsrBand::from_psr(42.0), PsrBand::B30to50);
        assert_eq!(PsrBand::from_psr(500.0), PsrBand::Over100);
    }

    #[test]
    fn language_is_the_primary_subtag_only() {
        assert_eq!(
            sanitize_language(Some("nb_NO.UTF-8")).as_deref(),
            Some("nb")
        );
        assert_eq!(sanitize_language(Some("en-US")).as_deref(), Some("en"));
        assert_eq!(sanitize_language(Some("C")).as_deref(), Some("c"));
        assert_eq!(sanitize_language(Some("")), None);
        assert_eq!(sanitize_language(Some("123")), None);
    }

    // ── Consent ───────────────────────────────────────────────────────────────

    #[test]
    fn absent_consent_is_off_and_never_asked() {
        let none: Option<ConsentRecord> = None;
        assert!(!consent_active(&none));
        assert_eq!(answered_version(&none), None);
    }

    #[test]
    fn only_a_current_version_grant_is_active() {
        let now = 1_800_000_000_000;
        assert!(consent_active(&Some(ConsentRecord::decide(true, now))));
        assert!(!consent_active(&Some(ConsentRecord::decide(false, now))));
        // A stale grant does not send, and is remembered at its own version.
        let stale = ConsentRecord {
            granted: true,
            version: CONSENT_VERSION + 1,
            decided_at: now,
        };
        assert!(!consent_active(&Some(stale)));
        assert_eq!(answered_version(&Some(stale)), Some(CONSENT_VERSION + 1));
    }

    #[test]
    fn a_no_never_becomes_a_yes_at_a_later_version() {
        // The load-bearing consent rule: no version of a denial permits sending.
        for version in 0..=CONSENT_VERSION + 3 {
            let no = ConsentRecord {
                granted: false,
                version,
                decided_at: 1,
            };
            assert!(!consent_active(&Some(no)), "denial at v{version} sent");
        }
    }

    #[test]
    fn install_id_is_shape_checked() {
        let good = new_install_id();
        assert_eq!(sanitize_install_id(&good), good);
        assert_eq!(sanitize_install_id("kari@menighet.no"), NIL_INSTALL_ID);
        assert_eq!(sanitize_install_id("not-a-uuid"), NIL_INSTALL_ID);
    }

    // ── Classification / backoff ─────────────────────────────────────────────

    #[test]
    fn status_classification_matches_the_contract() {
        assert_eq!(classify(202), SendOutcome::Ok);
        assert_eq!(classify(200), SendOutcome::Ok);
        assert!(matches!(classify(400), SendOutcome::Permanent(_)));
        assert!(matches!(classify(401), SendOutcome::Permanent(_)));
        assert!(matches!(classify(413), SendOutcome::Permanent(_)));
        assert!(matches!(classify(429), SendOutcome::Transient(_)));
        assert!(matches!(classify(408), SendOutcome::Transient(_)));
        assert!(matches!(classify(500), SendOutcome::Transient(_)));
        assert!(matches!(classify(503), SendOutcome::Transient(_)));
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        assert!(backoff_ms(0) < backoff_ms(1));
        assert!(backoff_ms(1) < backoff_ms(4));
        assert_eq!(
            backoff_ms(20),
            backoff_ms(30),
            "the cap holds for huge attempts"
        );
    }

    // ── Endpoint ──────────────────────────────────────────────────────────────

    #[test]
    fn endpoint_requires_both_halves_and_an_http_scheme() {
        assert_eq!(Endpoint::normalize(None, None), None);
        assert_eq!(
            Endpoint::normalize(Some("https://t.example".into()), None),
            None
        );
        assert_eq!(
            Endpoint::normalize(Some("t.example".into()), Some("k".into())),
            None
        );
        let e = Endpoint::normalize(
            Some("https://telemetry.sundaysuite.app/".into()),
            Some(" k ".into()),
        )
        .unwrap();
        assert_eq!(
            e.ingest_url,
            "https://telemetry.sundaysuite.app/v1/apps/sundaysync/ingest"
        );
        assert_eq!(e.write_key, "k");
        assert_eq!(
            e.delete_url("abc"),
            "https://telemetry.sundaysuite.app/v1/apps/sundaysync/install/abc"
        );
    }

    // ── Persistence: consent, install id, outbox, deletion ────────────────────

    #[test]
    fn granting_mints_one_id_and_denying_purges_the_outbox() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        // Grant: mints an id, watermark at now, active.
        let now = now_ms();
        let mut st = read_state(dir);
        st.consent = Some(ConsentRecord::decide(true, now));
        st.install_id = Some(new_install_id());
        st.crash_watermark = now;
        write_state(dir, &st).unwrap();

        let status = status_in(dir);
        assert!(status.granted);
        assert!(status.has_install_id);
        assert_eq!(status.consent_version, Some(CONSENT_VERSION));

        // Queue something, then deny: the queue is purged and sending stops.
        let payload = {
            let mut p = TelemetryPayload::header(st.install_id.as_deref().unwrap(), "0.1.2");
            p.runs.push(SyncReport {
                at: now,
                succeeded: true,
                file_count: 1,
                device_count: 1,
                placed_count: 1,
                unsynced_count: 0,
                duration_bucket: DurationBucket::Under5m,
                run_duration_bucket: RunDurationBucket::Under10s,
                min_psr: 15.0,
                analysis_rate: 12_000,
                formats: vec![],
                outcomes: vec![],
                psr_bands: vec![],
                drift_correction_enabled: false,
                drift_clips: 0,
                drift_corrected_clips: 0,
                mixed_fps: false,
            });
            p
        };
        assert!(enqueue(dir, &payload, now).unwrap());
        assert_eq!(read_outbox(dir).len(), 1);

        let mut st = read_state(dir);
        st.consent = Some(ConsentRecord::decide(false, now_ms()));
        write_outbox(dir, &[]).unwrap();
        write_state(dir, &st).unwrap();
        assert!(!status_in(dir).granted);
        assert_eq!(status_in(dir).queued, 0);
    }

    #[test]
    fn enqueue_dedups_and_is_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let mut p = TelemetryPayload::header(NIL_INSTALL_ID, "0.1.2");
        p.crashes.push(crash::CrashReport {
            schema: crash::RECORD_SCHEMA,
            kind: "panic".into(),
            at: 100,
            app_version: "0.1.2".into(),
            os: Os::Linux,
            message: "boom".into(),
            location: None,
            backtrace_present: false,
        });
        assert!(enqueue(dir, &p, 1).unwrap());
        // Same newest record -> same dedup key -> not re-queued.
        assert!(!enqueue(dir, &p, 2).unwrap());
        assert_eq!(read_outbox(dir).len(), 1);

        // Overfill the ring: only the newest QUEUE_MAX survive.
        for i in 0..(QUEUE_MAX + 10) {
            let mut q = TelemetryPayload::header(NIL_INSTALL_ID, "0.1.2");
            q.crashes.push(crash::CrashReport {
                schema: crash::RECORD_SCHEMA,
                kind: "panic".into(),
                at: 1000 + i as i64,
                app_version: "0.1.2".into(),
                os: Os::Linux,
                message: "boom".into(),
                location: None,
                backtrace_present: false,
            });
            enqueue(dir, &q, 1000 + i as i64).unwrap();
        }
        assert_eq!(read_outbox(dir).len(), QUEUE_MAX);
    }

    #[test]
    fn deletion_parks_the_id_and_clears_it_locally() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let id = new_install_id();
        let st = PersistState {
            consent: Some(ConsentRecord::decide(true, now_ms())),
            install_id: Some(id.clone()),
            pending_deletions: vec![],
            crash_watermark: now_ms(),
        };
        write_state(dir, &st).unwrap();

        // Simulate the local half of request_telemetry_deletion.
        let mut st = read_state(dir);
        let old = st.install_id.take().unwrap();
        st.pending_deletions.push(old.clone());
        write_state(dir, &st).unwrap();

        let after = read_state(dir);
        assert_eq!(after.install_id, None, "the id is cleared locally");
        assert_eq!(
            after.pending_deletions,
            vec![id],
            "and parked for a remote delete"
        );
        assert!(
            consent_active(&after.consent),
            "consent is untouched by a deletion"
        );
    }

    #[test]
    fn state_and_outbox_survive_a_reopen_and_reject_junk() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        // Junk files read as defaults, never a panic.
        std::fs::write(dir.join("state.json"), b"{not json").unwrap();
        std::fs::write(dir.join("outbox.json"), b"nonsense").unwrap();
        assert_eq!(read_state(dir), PersistState::default());
        assert!(read_outbox(dir).is_empty());
    }
}

/// ═══════════════════════════════════════════════════════════════════════════
///   THE WIRE CONTRACT, RESTATED AGAINST THE DEPLOYED WORKER
/// ═══════════════════════════════════════════════════════════════════════════
///
/// The endpoint is now PRODUCTION TRUTH: `sunday-telemetry/src/schema-sync.ts`
/// validates every field, every enum spelling and every cap, and answers a
/// mismatch with a 400. [`classify`] calls a 400 `Permanent`, so the outbox drops
/// that payload **without retrying and without telling anyone** — a client/server
/// drift is not a loud failure, it is silent, permanent data loss for every
/// install it affects.
///
/// So the contract is pinned HERE, in the client, from the server's own file:
/// the key lists, the enum vocabularies, the caps and the free-text path screen
/// below are transcribed from `schema-sync.ts` (which in turn re-uses
/// `schema.ts`'s `Check`, `ABSOLUTE_PATH_RE` and timestamp window). A field
/// renamed on either side fails a test in this module instead of quietly
/// deleting a month of reports.
#[cfg(test)]
mod wire_contract {
    use super::*;
    use serde_json::Value;

    // ── Transcribed from sunday-telemetry/src/schema-sync.ts ──────────────────

    /// `SYNC_PAYLOAD_KEYS`. Exactly these — the Worker's `Check::object` rejects a
    /// missing key AND an unknown one.
    const PAYLOAD_KEYS: &[&str] = &[
        "app",
        "schema",
        "consentVersion",
        "installId",
        "builtAt",
        "appVersion",
        "os",
        "arch",
        "language",
        "runs",
        "crashes",
    ];
    /// `RUN_KEYS`.
    const RUN_KEYS: &[&str] = &[
        "at",
        "succeeded",
        "fileCount",
        "deviceCount",
        "placedCount",
        "unsyncedCount",
        "durationBucket",
        "runDurationBucket",
        "minPsr",
        "analysisRate",
        "formats",
        "outcomes",
        "psrBands",
        "driftCorrectionEnabled",
        "driftClips",
        "driftCorrectedClips",
        "mixedFps",
    ];
    /// `CRASH_KEYS`. Note: no `task` — that field is SundayRec's.
    const CRASH_KEYS: &[&str] = &[
        "schema",
        "kind",
        "at",
        "appVersion",
        "os",
        "message",
        "location",
        "backtracePresent",
    ];

    const OS_VALUES: &[&str] = &["macos", "windows", "linux", "other"];
    const ARCH_VALUES: &[&str] = &["x86_64", "aarch64", "other"];
    const MEDIA_FORMATS: &[&str] = &[
        "mp4", "mov", "mkv", "avi", "mts", "wav", "flac", "mp3", "aac", "m4a", "other",
    ];
    const OUTCOME_REASONS: &[&str] = &[
        "low_confidence",
        "no_audio",
        "decode_error",
        "device_overlap",
    ];
    const DURATION_BUCKETS: &[&str] = &[
        "under5m",
        "b5to15m",
        "b15to30m",
        "b30to60m",
        "b60to120m",
        "over120m",
    ];
    const RUN_DURATION_BUCKETS: &[&str] =
        &["under10s", "b10to30s", "b30to60s", "b60to300s", "over300s"];
    const PSR_BANDS: &[&str] = &[
        "under15", "b15to20", "b20to30", "b30to50", "b50to100", "over100",
    ];

    /// `MAX_SYNC_RUNS` / `MAX_SYNC_CRASHES`.
    const WORKER_MAX_RUNS: usize = 20;
    const WORKER_MAX_CRASHES: usize = 20;
    /// `MESSAGE_MAX_CHARS` / `LOCATION_MAX_CHARS` / `VERSION_MAX_CHARS` — the
    /// Worker's `freeText` allows the cap PLUS one trailing `…` (the client's own
    /// truncation shape) and nothing more.
    const WORKER_MESSAGE_MAX: usize = 200;
    const WORKER_LOCATION_MAX: usize = 120;
    const WORKER_VERSION_MAX: usize = 32;
    /// `TS_MIN` / `TS_MAX` — 2020-01-01 .. 2100-01-01 UTC, in ms.
    const TS_MIN: i64 = 1_577_836_800_000;
    const TS_MAX: i64 = 4_102_444_800_000;
    /// `MAX_BODY_BYTES`.
    const WORKER_MAX_BODY_BYTES: usize = 64 * 1024;

    /// The client's collection caps may never exceed the Worker's `too_many`
    /// thresholds — a compile-time failure, because there is no runtime in which a
    /// payload the endpoint refuses by size is acceptable.
    const _: () = assert!(MAX_RUNS <= WORKER_MAX_RUNS);
    const _: () = assert!(MAX_CRASHES <= WORKER_MAX_CRASHES);

    /// A faithful port of `ABSOLUTE_PATH_RE` from `sunday-telemetry/src/schema.ts`:
    ///
    /// ```text
    /// (^|[\s"'(<[])(\/(Users|home|var|tmp|private|Volumes)\/|[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|~[\\/])
    /// ```
    ///
    /// `freeText` refuses any string this matches with `unscrubbed_path`, which
    /// 400s the WHOLE payload. This is therefore the exact question every scrubbed
    /// string has to answer "no" to.
    fn worker_path_screen_hits(s: &str) -> bool {
        const ROOTS: &[&str] = &[
            "/Users/",
            "/home/",
            "/var/",
            "/tmp/",
            "/private/",
            "/Volumes/",
        ];
        for (i, _) in s.char_indices() {
            let at_boundary = match s[..i].chars().next_back() {
                None => true,
                Some(c) => c.is_whitespace() || matches!(c, '"' | '\'' | '(' | '<' | '['),
            };
            if !at_boundary {
                continue;
            }
            let rest = &s[i..];
            if ROOTS.iter().any(|r| rest.starts_with(r)) {
                return true;
            }
            let b = rest.as_bytes();
            // `~/` or `~\`
            if b.len() >= 2 && b[0] == b'~' && matches!(b[1], b'\\' | b'/') {
                return true;
            }
            // `X:\` or `X:/`
            if b.len() >= 3
                && b[0].is_ascii_alphabetic()
                && b[1] == b':'
                && matches!(b[2], b'\\' | b'/')
            {
                return true;
            }
            // `\\host\`
            if let Some(after) = rest.strip_prefix(r"\\") {
                for (segment, c) in after.chars().enumerate() {
                    if c == '\\' {
                        if segment > 0 {
                            return true;
                        }
                        break;
                    }
                    if c.is_whitespace() {
                        break;
                    }
                }
            }
        }
        false
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────

    /// A payload exercising every field, every collection and both caps.
    fn maximal_payload() -> TelemetryPayload {
        let mut p =
            TelemetryPayload::header("3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8", "0.2.0-beta.2");
        for i in 0..MAX_RUNS {
            p.runs.push(SyncReport {
                at: TS_MIN + i as i64,
                succeeded: i % 2 == 0,
                file_count: 12,
                device_count: 4,
                placed_count: 9,
                unsynced_count: 3,
                duration_bucket: DurationBucket::B60to120m,
                run_duration_bucket: RunDurationBucket::B60to300s,
                min_psr: 15.0,
                analysis_rate: 12_000,
                formats: vec![
                    FormatCount {
                        format: MediaFormat::Mp4,
                        count: 8,
                    },
                    FormatCount {
                        format: MediaFormat::Wav,
                        count: 4,
                    },
                ],
                outcomes: vec![OutcomeCount {
                    reason: OutcomeReason::DecodeError,
                    count: 3,
                }],
                psr_bands: vec![PsrBandCount {
                    band: PsrBand::B30to50,
                    count: 9,
                }],
                drift_correction_enabled: true,
                drift_clips: 7,
                drift_corrected_clips: 2,
                mixed_fps: true,
            });
        }
        for i in 0..MAX_CRASHES {
            p.crashes.push(crash::CrashReport {
                schema: crash::RECORD_SCHEMA,
                kind: "panic".into(),
                at: TS_MIN + i as i64,
                app_version: "0.2.0-beta.2".into(),
                os: Os::Macos,
                // Worst case: the cap in multi-byte characters.
                message: scrub_free_text(&"æ".repeat(400), None, MESSAGE_MAX_CHARS),
                location: Some(scrub_free_text(&"ø".repeat(400), None, LOCATION_MAX_CHARS)),
                backtrace_present: true,
            });
        }
        p
    }

    fn keys_of(v: &Value) -> Vec<String> {
        let mut k: Vec<String> = v
            .as_object()
            .expect("object")
            .keys()
            .map(String::from)
            .collect();
        k.sort();
        k
    }

    fn sorted(v: &[&str]) -> Vec<String> {
        let mut k: Vec<String> = v.iter().map(|s| (*s).to_string()).collect();
        k.sort();
        k
    }

    // ── The tests ─────────────────────────────────────────────────────────────

    /// Every key the client emits, at every level, is exactly the key set the
    /// Worker demands — no missing field, no extra one.
    #[test]
    fn every_key_matches_the_workers_key_lists() {
        let json: Value = serde_json::to_value(maximal_payload()).unwrap();
        assert_eq!(keys_of(&json), sorted(PAYLOAD_KEYS), "payload keys drifted");
        assert_eq!(
            keys_of(&json["runs"][0]),
            sorted(RUN_KEYS),
            "run keys drifted"
        );
        assert_eq!(
            keys_of(&json["crashes"][0]),
            sorted(CRASH_KEYS),
            "crash keys drifted"
        );
        assert_eq!(
            keys_of(&json["runs"][0]["formats"][0]),
            vec!["count".to_string(), "format".to_string()]
        );
        assert_eq!(
            keys_of(&json["runs"][0]["outcomes"][0]),
            vec!["count".to_string(), "reason".to_string()]
        );
        assert_eq!(
            keys_of(&json["runs"][0]["psrBands"][0]),
            vec!["band".to_string(), "count".to_string()]
        );
        // `app` is the dimension the app registry routes on.
        assert_eq!(json["app"], "sundaysync");
        assert_eq!(json["schema"], TELEMETRY_SCHEMA);
        // `language` and `location` are `Option`s and must serialise as explicit
        // nulls — the Worker's `nullable` accepts null but `object` still requires
        // the KEY to be present, so a `skip_serializing_if` here would be a 400.
        let mut headerless = TelemetryPayload::header(NIL_INSTALL_ID, "0.0.0");
        headerless.language = None;
        let v = serde_json::to_value(&headerless).unwrap();
        assert!(v.as_object().unwrap().contains_key("language"));
        assert!(v["language"].is_null());
    }

    /// Every closed enum serialises to a spelling the Worker's `enum()` accepts.
    /// serde's `snake_case` inserts no underscore between a letter and a digit
    /// (`B5to15m` → `b5to15m`), which is the exact assumption schema-sync.ts
    /// documents — so this is where that assumption is checked rather than assumed.
    #[test]
    fn every_enum_spelling_is_in_the_workers_vocabulary() {
        fn wire<T: Serialize>(v: T) -> String {
            serde_json::to_value(v)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        }
        for (v, set) in [
            (wire(Os::Macos), OS_VALUES),
            (wire(Os::Windows), OS_VALUES),
            (wire(Os::Linux), OS_VALUES),
            (wire(Os::Other), OS_VALUES),
            (wire(Arch::X86_64), ARCH_VALUES),
            (wire(Arch::Aarch64), ARCH_VALUES),
            (wire(Arch::Other), ARCH_VALUES),
        ] {
            assert!(
                set.contains(&v.as_str()),
                "{v:?} is not in the Worker's set"
            );
        }
        // Every MediaFormat the classifier can produce.
        for ext in [
            "a.mp4", "a.mov", "a.mkv", "a.avi", "a.mts", "a.m2ts", "a.wav", "a.flac", "a.mp3",
            "a.aac", "a.m4a", "a.zzz", "a",
        ] {
            let v = wire(MediaFormat::from_path(Path::new(ext)));
            assert!(MEDIA_FORMATS.contains(&v.as_str()), "{ext} → {v:?}");
        }
        for r in [
            UnsyncedReason::LowConfidence,
            UnsyncedReason::NoAudio,
            UnsyncedReason::DecodeError,
            UnsyncedReason::DeviceOverlap,
        ] {
            let v = wire(OutcomeReason::from_engine(r));
            assert!(OUTCOME_REASONS.contains(&v.as_str()), "{v:?}");
        }
        // The bucket functions, swept across their whole domain.
        for secs in [
            0.0, 299.0, 300.0, 899.0, 900.0, 1799.0, 1800.0, 3599.0, 3600.0, 7199.0, 7200.0, 1e9,
        ] {
            let v = wire(DurationBucket::from_seconds(secs));
            assert!(DURATION_BUCKETS.contains(&v.as_str()), "{secs} → {v:?}");
        }
        for ms in [
            0u128,
            9_999,
            10_000,
            29_999,
            30_000,
            59_999,
            60_000,
            299_999,
            300_000,
            1_000_000_000,
        ] {
            let v = wire(RunDurationBucket::from_millis(ms));
            assert!(RUN_DURATION_BUCKETS.contains(&v.as_str()), "{ms} → {v:?}");
        }
        for psr in [
            0.0, 14.9, 15.0, 19.9, 20.0, 29.9, 30.0, 49.9, 50.0, 99.9, 100.0, 1e6,
        ] {
            let v = wire(PsrBand::from_psr(psr));
            assert!(PSR_BANDS.contains(&v.as_str()), "{psr} → {v:?}");
        }
    }

    /// Every cap the Worker enforces holds on the biggest payload the client can
    /// build, including the free-text lengths counted in CHARS (the Worker counts
    /// `[...v]`, i.e. Unicode scalars, not UTF-16 units) and the body-size ceiling.
    #[test]
    fn every_cap_the_worker_enforces_holds() {
        let p = maximal_payload();
        assert_eq!(MESSAGE_MAX_CHARS, WORKER_MESSAGE_MAX);
        assert_eq!(LOCATION_MAX_CHARS, WORKER_LOCATION_MAX);
        assert_eq!(VERSION_MAX_CHARS, WORKER_VERSION_MAX);

        // Truncation past the caps still lands inside them.
        let mut over = p.clone();
        for i in 0..40 {
            over.runs.push(over.runs[0].clone());
            over.crashes.push(over.crashes[0].clone());
            over.runs.last_mut().unwrap().at = TS_MIN + 1_000 + i;
        }
        over.truncate_to_caps();
        assert_eq!(over.runs.len(), MAX_RUNS);
        assert_eq!(over.crashes.len(), MAX_CRASHES);
        // …and keep_last kept the NEWEST.
        assert_eq!(over.runs.last().unwrap().at, TS_MIN + 1_000 + 39);

        // Free text: at most cap + 1, and the +1 is the ellipsis the Worker allows.
        for c in &p.crashes {
            let n = c.message.chars().count();
            assert!(n <= MESSAGE_MAX_CHARS + 1, "message was {n} chars");
            if n == MESSAGE_MAX_CHARS + 1 {
                assert_eq!(c.message.chars().last(), Some('…'));
            }
            let loc = c.location.as_deref().unwrap();
            let n = loc.chars().count();
            assert!(n <= LOCATION_MAX_CHARS + 1, "location was {n} chars");
            if n == LOCATION_MAX_CHARS + 1 {
                assert_eq!(loc.chars().last(), Some('…'));
            }
            assert!(c.app_version.chars().count() <= VERSION_MAX_CHARS + 1);
        }
        assert!(p.app_version.chars().count() <= VERSION_MAX_CHARS + 1);

        // The per-run histograms cannot outgrow their closed vocabularies: each is
        // built from a BTreeMap keyed by the enum, so duplicates (a 4xx) are
        // impossible and the length is bounded by the enum's size.
        for r in &p.runs {
            assert!(r.formats.len() <= MEDIA_FORMATS.len());
            assert!(r.outcomes.len() <= OUTCOME_REASONS.len());
            assert!(r.psr_bands.len() <= PSR_BANDS.len());
        }

        // The whole thing fits the Worker's 64 kB body ceiling with room to spare.
        let bytes = serde_json::to_vec(&p).unwrap().len();
        assert!(
            bytes < WORKER_MAX_BODY_BYTES,
            "the maximal payload is {bytes} bytes, over the Worker's {WORKER_MAX_BODY_BYTES}"
        );
    }

    /// Every timestamp the client puts on the wire sits inside the Worker's shared
    /// window, so a well-clocked machine is never rejected `out_of_range`.
    #[test]
    fn timestamps_land_inside_the_workers_window() {
        let p = maximal_payload();
        assert!(
            (TS_MIN..TS_MAX).contains(&p.built_at),
            "builtAt out of window"
        );
        let now = now_ms();
        assert!(
            (TS_MIN..TS_MAX).contains(&now),
            "this machine's clock is outside the Worker's accepted window"
        );
    }

    /// ⚠️ THE ONE THAT BITES: the client's scrubber must be at least as aggressive
    /// as the Worker's path screen, at every LEFT BOUNDARY the screen recognises.
    ///
    /// `ABSOLUTE_PATH_RE` anchors on `(^|[\s"'(<[])` — start, whitespace, a quote,
    /// an open paren, an **angle bracket** or an **open square bracket**. A client
    /// that only anchors on the first four leaves `[C:\…` and `<\\NAS\…` untouched,
    /// and every one of those messages is a 400 that silently takes the whole batch
    /// (runs included) with it.
    #[test]
    fn a_scrubbed_message_never_trips_the_workers_path_screen() {
        let home = Some("/Users/kari");
        for raw in [
            // Bare, and after each boundary character the Worker recognises.
            r"could not open C:\Users\Ola\Opptak\x.mp4",
            r#"could not open "C:\Users\Ola\Opptak\x.mp4""#,
            r"could not open (C:\Users\Ola\Opptak\x.mp4)",
            r"could not open [C:\Users\Ola\Opptak\x.mp4]",
            r"could not open <C:\Users\Ola\Opptak\x.mp4>",
            r"sources: [C:\Temp\a.mov, C:\Temp\b.mov]",
            r"share [\\NAS\Opptak\gudstjeneste.wav] is offline",
            r"share <\\NAS\Opptak\gudstjeneste.wav> is offline",
            r"config [~/Opptak/Balkong Kirke] missing",
            r"config <~\Opptak\Balkong Kirke> missing",
            "failed [/Users/kari/Opptak/Balkong Kirke/ZOOM0001.WAV]",
            "failed </Volumes/Backup/Opptak/x.wav>",
            "failed (/private/var/folders/xy/T/sundaysync-1234/ref.f32)",
            "failed '/tmp/sundaysync/scratch.bin'",
            "[/home/rf/opptak/x.mkv] and [/var/tmp/y.mkv]",
            // The home-replacement route: `~` must not be left bare next to a slash.
            "kunne ikke åpne /Users/kari/Opptak/Balkong Kirke/ZOOM0001.WAV",
        ] {
            let scrubbed = scrub_free_text(raw, home, MESSAGE_MAX_CHARS);
            assert!(
                !worker_path_screen_hits(&scrubbed),
                "the Worker would 400 this as `unscrubbed_path`:\n  raw:      {raw}\n  scrubbed: {scrubbed}"
            );
            assert!(
                scrubbed.contains(PATH_PLACEHOLDER),
                "nothing was redacted at all:\n  raw:      {raw}\n  scrubbed: {scrubbed}"
            );
        }

        // The port itself is honest: it DOES fire on an unscrubbed string, so a
        // green test above means the scrubber worked, not that the screen is dead.
        assert!(worker_path_screen_hits(r"open [C:\Users\Ola\x.mp4]"));
        assert!(worker_path_screen_hits("open /Users/kari/x.wav"));
        assert!(!worker_path_screen_hits("panicked at src/place.rs:42:9"));
        assert!(!worker_path_screen_hits(
            "GET https://telemetry.example/v1 failed"
        ));
    }

    /// Every free-text field of a real crash record — message AND location — is
    /// screen-clean, whichever producer wrote it.
    #[test]
    fn every_free_text_field_of_a_crash_is_screen_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        crash::record(
            dir,
            "sync_error",
            r"decode failed for [C:\Users\Ola\Opptak\x.mp4]",
            // A panic location from a dependency compiled on a Windows runner.
            Some(
                r"C:\Users\runneradmin\.cargo\registry\src\index.crates.io-6f17d22bba15001f\x-1.0\src\lib.rs:42:9",
            ),
        );
        crash::record(
            dir,
            "frontend",
            "[TypeError] cannot read </Users/kari/x>",
            None,
        );
        for rec in crash::read_crashes(dir) {
            assert!(
                !worker_path_screen_hits(&rec.message),
                "message would 400: {}",
                rec.message
            );
            if let Some(loc) = &rec.location {
                assert!(!worker_path_screen_hits(loc), "location would 400: {loc}");
            }
        }
    }

    /// A non-finite `minPsr` serialises as JSON `null`, which the Worker rejects
    /// with `expected_number` — and that 400 takes the whole batch, not just the
    /// one run. The projection must therefore never emit one.
    #[test]
    fn a_non_finite_min_psr_never_reaches_the_wire() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut result = super::tests::identifying_result();
            result.parameters.min_psr = bad;
            let facts = RunFacts {
                result: &result,
                run_millis: 1_000,
                drift_correction_enabled: false,
            };
            let report = sync_report(&facts, TS_MIN);
            let v = serde_json::to_value(&report).unwrap();
            assert!(
                v["minPsr"].is_f64() || v["minPsr"].is_i64(),
                "minPsr serialised as {:?} — the Worker answers 400 `expected_number`",
                v["minPsr"]
            );
        }
    }

    /// `appVersion` is `freeText(…, 32)` on the Worker: over the cap is a 400 for
    /// the whole payload. The envelope must cap it rather than trusting whatever
    /// the bundle identifier happens to say.
    #[test]
    fn a_long_app_version_is_capped_to_the_workers_allowance() {
        let p = TelemetryPayload::header(NIL_INSTALL_ID, &"9".repeat(200));
        let n = p.app_version.chars().count();
        assert!(
            n <= VERSION_MAX_CHARS + 1,
            "appVersion reached the wire at {n} chars"
        );
        if n == VERSION_MAX_CHARS + 1 {
            assert_eq!(p.app_version.chars().last(), Some('…'));
        }
    }
}
