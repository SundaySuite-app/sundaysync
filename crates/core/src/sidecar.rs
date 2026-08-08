//! ffmpeg/ffprobe process isolation — docs/PLAN.md §4.1 and §7.2.
//!
//! Every byte of media the engine touches is decoded by a child process. That is the
//! whole of §7.2's crash-isolation promise: a file that segfaults a demuxer kills an
//! ffprobe process and lands in `unsynced` with `decode_error`, and the user's 8-hour
//! sync run keeps going. Linking libavformat in-process would trade that guarantee for
//! speed we do not need.
//!
//! # On determinism
//!
//! The timeout here reads a monotonic clock, which is the one place the engine is not a
//! pure function of its inputs: a machine under enough load could time out where a fast
//! one succeeds. That is inherent to §4.1's design and is the right trade — an
//! unbounded wait on a malformed file is a hang, and a hang is worse than a file
//! honestly reported as `decode_error`. Nothing else in the engine reads a clock.

use crate::error::{Error, Result};
use crate::progress::CancelToken;
use serde::Serialize;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// §4.1: "in a child process with a 30 s timeout".
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// How often `try_wait` is polled. Small enough to be invisible next to a typical
/// ~30 ms ffprobe run, large enough not to spin a core.
const POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Where a resolved [`Sidecar`] came from.
///
/// Provenance, not configuration: the UI says "innebygd" or names the system binary, and
/// a diagnostics bundle records which one actually ran. Deliberately **not** part of the
/// frozen §5 schema — it never enters `SyncResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SidecarSource {
    /// Shipped inside the application bundle (D-031). Resolved by the Tauri shell, which
    /// hands the pair down through [`crate::SyncRequest::sidecar`] — the engine itself
    /// stays Tauri-free (D-023).
    Bundled,
    /// Found on the user's machine, via `PATH` or one of [`fallback_candidates`].
    System,
}

/// Locations of the ffmpeg and ffprobe binaries.
///
/// Bare command names resolve through `PATH`, which is what a development checkout, the
/// CLI and CI all want. The desktop app instead constructs this with absolute paths to
/// the sidecars bundled next to the executable (D-031), via [`Sidecar::verified`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sidecar {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    /// Which of the two resolution routes produced these paths.
    pub source: SidecarSource,
}

impl Default for Sidecar {
    fn default() -> Self {
        Self {
            ffmpeg: PathBuf::from("ffmpeg"),
            ffprobe: PathBuf::from("ffprobe"),
            source: SidecarSource::System,
        }
    }
}

/// Directories searched when bare `ffmpeg`/`ffprobe` do not resolve, in priority order.
///
/// # Why this list exists at all
///
/// macOS hands a GUI application a minimal environment — `PATH` is
/// `/usr/bin:/bin:/usr/sbin:/sbin`, with none of the directories a shell's login profile
/// would have added. A Homebrew ffmpeg lives in `/opt/homebrew/bin` (Apple Silicon) or
/// `/usr/local/bin` (Intel), and MacPorts uses `/opt/local/bin`; none of them are visible
/// to a double-clicked `.app`. The v0.1.0 release reported "ffmpeg was not found" on the
/// owner's own machine, where ffmpeg was installed and worked perfectly from a terminal —
/// the development build had only ever seen the terminal's inherited `PATH`.
///
/// Order is homebrew-arm, homebrew-intel, MacPorts: most-likely first, and stable so the
/// resolution is reproducible rather than dependent on filesystem iteration order.
/// Unix-only; on Windows a bare-name lookup already covers the installers people use.
#[must_use]
pub fn fallback_candidates() -> Vec<PathBuf> {
    if cfg!(unix) {
        vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/local/bin"),
        ]
    } else {
        Vec::new()
    }
}

/// `<bin> -version` exits 0 — the cheapest proof this is a real, runnable executable for
/// this architecture, rather than a name that merely exists on disk.
fn runnable(bin: &Path) -> bool {
    Command::new(bin)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Bare name first (the `PATH` lookup), then each [`fallback_candidates`] directory.
fn resolve_one(name: &str) -> Option<PathBuf> {
    let bare = PathBuf::from(name);
    if runnable(&bare) {
        return Some(bare);
    }
    fallback_candidates()
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file() && runnable(candidate))
}

impl Sidecar {
    /// A pair of paths, taken on trust. Use [`Sidecar::verified`] when the caller wants
    /// the pair checked first.
    #[must_use]
    pub fn new(ffmpeg: PathBuf, ffprobe: PathBuf) -> Self {
        Self {
            ffmpeg,
            ffprobe,
            source: SidecarSource::System,
        }
    }

    /// Resolves the binaries from the user's machine and verifies both actually run.
    ///
    /// Checked eagerly so a missing ffmpeg is one clear [`Error::SidecarUnavailable`]
    /// at startup, rather than every single input file failing with `decode_error` and
    /// the user concluding their whole shoot is corrupt.
    ///
    /// Resolution order per binary: the bare name (a `PATH` lookup), then each directory
    /// in [`fallback_candidates`]. The fallback exists because macOS gives a GUI app a
    /// minimal `PATH` that omits Homebrew — see that function's documentation for the
    /// full diagnosis.
    pub fn from_path() -> Result<Self> {
        // ffprobe first: it is the binary the very first stage (§4.1) needs, so a
        // half-installed toolchain names the part that would fail soonest.
        let ffprobe = resolve_one("ffprobe").ok_or_else(|| unavailable("ffprobe"))?;
        let ffmpeg = resolve_one("ffmpeg").ok_or_else(|| unavailable("ffmpeg"))?;
        Ok(Self {
            ffmpeg,
            ffprobe,
            source: SidecarSource::System,
        })
    }

    /// Verifies an explicitly supplied pair — how the desktop shell hands the engine the
    /// binaries bundled inside the application (D-031).
    ///
    /// Same `-version` check as [`Sidecar::from_path`], so a sidecar that was stripped by
    /// a quarantine tool, damaged in transit or built for the wrong architecture fails
    /// here with the offending path named, instead of at every input file.
    pub fn verified(ffmpeg: PathBuf, ffprobe: PathBuf) -> Result<Self> {
        for bin in [&ffprobe, &ffmpeg] {
            if !runnable(bin) {
                return Err(Error::SidecarUnavailable(format!(
                    "`{}` could not be run",
                    bin.display()
                )));
            }
        }
        Ok(Self {
            ffmpeg,
            ffprobe,
            source: SidecarSource::Bundled,
        })
    }

    /// True if both binaries are runnable. For tests that must skip without ffmpeg.
    #[must_use]
    pub fn is_available() -> bool {
        Self::from_path().is_ok()
    }
}

fn unavailable(name: &str) -> Error {
    let searched = fallback_candidates()
        .iter()
        .map(|d| d.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let where_looked = if searched.is_empty() {
        "PATH".to_string()
    } else {
        format!("PATH, {searched}")
    };
    Error::SidecarUnavailable(format!(
        "`{name}` could not be run — searched {where_looked}. Is ffmpeg installed?"
    ))
}

/// What a finished child process produced.
#[derive(Debug, Clone)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub success: bool,
}

/// Why a child process did not produce usable output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunFailure {
    /// The binary could not be spawned at all.
    Spawn(String),
    /// Exceeded the timeout and was killed.
    TimedOut,
    /// The user cancelled and the child was killed (§7.4).
    Cancelled,
    /// Ran, but exited non-zero.
    Failed { code: Option<i32>, stderr: String },
}

impl std::fmt::Display for RunFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(e) => write!(f, "could not spawn: {e}"),
            Self::TimedOut => write!(f, "timed out"),
            Self::Cancelled => write!(f, "cancelled"),
            Self::Failed { code, stderr } => {
                let first = stderr.lines().next().unwrap_or("").trim();
                match code {
                    Some(c) => write!(f, "exited with status {c}: {first}"),
                    None => write!(f, "killed by signal: {first}"),
                }
            }
        }
    }
}

/// Runs a command to completion, killing it if it exceeds `timeout` or if `cancel` is
/// tripped.
///
/// stdout and stderr are drained on dedicated threads. This matters more than it looks:
/// polling `try_wait` while leaving the pipes unread deadlocks the moment a child
/// writes more than the OS pipe buffer, and a malformed file is exactly what makes
/// ffprobe verbose. The reader threads keep the pipes flowing so the timeout is the
/// only thing that can stop us.
///
/// # Why cancellation belongs here and not only in the caller
///
/// §7.4 requires cancel to return within 2 s. Checking the token *between* files is not
/// enough once Phase 2 starts decoding: extracting analysis audio from a two-hour
/// service takes far longer than two seconds, so a token checked only at file
/// boundaries would leave the user staring at an unresponsive Cancel button for the
/// rest of the decode. The child has to be killed mid-flight, which only this loop can
/// do.
pub fn run<I, S>(
    bin: &std::path::Path,
    args: I,
    timeout: Duration,
    cancel: &CancelToken,
) -> std::result::Result<Output, RunFailure>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| RunFailure::Spawn(e.to_string()))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || drain(stdout_pipe));
    let err_reader = std::thread::spawn(move || drain(stderr_pipe));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Stop::Exited(status),
            Ok(None) => {
                // Cancellation is checked first: when the user has asked to stop, that
                // is the honest reason to report even if the deadline also just passed.
                let stop = if cancel.is_cancelled() {
                    Some(Stop::Cancelled)
                } else if Instant::now() >= deadline {
                    Some(Stop::TimedOut)
                } else {
                    None
                };
                if let Some(stop) = stop {
                    // Best-effort kill, then reap so we never leave a zombie behind.
                    let _ = child.kill();
                    let _ = child.wait();
                    break stop;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(RunFailure::Spawn(e.to_string())),
        }
    };

    // On timeout OR cancellation, return WITHOUT joining the readers, and deliberately
    // drop the output.
    //
    // Killing the child does not necessarily close the pipes: if it spawned its own
    // children, they inherit the write ends and can hold them open indefinitely.
    // Joining here would then block for as long as the grandchild lives — reintroducing
    // exactly the unbounded wait the timeout exists to prevent, and breaking §7.4's
    // promise that cancel returns within 2 s.
    //
    // Caught by CI, not locally: Ubuntu's dash forks `sleep`, while macOS's sh execs it,
    // so the bug was invisible on the development machine.
    //
    // The detached threads are harmless — each is blocked on a read that ends when the
    // pipe finally closes, and then exits and drops its handle. The output is discarded
    // regardless, since a timed-out probe has nothing trustworthy to say.
    let status = match status {
        Stop::Exited(status) => status,
        Stop::TimedOut => return Err(RunFailure::TimedOut),
        Stop::Cancelled => return Err(RunFailure::Cancelled),
    };

    // The process exited on its own, so its pipes are closed and both joins return at
    // once. A panicking reader thread is treated as "no output" rather than propagated —
    // this path must not be able to take the run down (§7.2).
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).into_owned();

    if status.success() {
        Ok(Output {
            stdout,
            stderr,
            success: true,
        })
    } else {
        Err(RunFailure::Failed {
            code: status.code(),
            stderr,
        })
    }
}

/// Why the poll loop stopped watching the child.
enum Stop {
    Exited(std::process::ExitStatus),
    TimedOut,
    Cancelled,
}

fn drain<R: Read>(pipe: Option<R>) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_end(&mut buf);
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn fallback_candidates_are_the_gui_invisible_dirs_in_priority_order() {
        // Asserted as a pure function rather than through `from_path`, because CI has
        // none of these directories and the machine that has them has ffmpeg on PATH
        // anyway — neither environment can observe the ordering by behaviour alone.
        let dirs = fallback_candidates();
        if cfg!(unix) {
            assert_eq!(
                dirs,
                vec![
                    PathBuf::from("/opt/homebrew/bin"),
                    PathBuf::from("/usr/local/bin"),
                    PathBuf::from("/opt/local/bin"),
                ],
                "homebrew-arm, homebrew-intel, MacPorts — most likely first, and stable"
            );
        } else {
            assert!(dirs.is_empty(), "the GUI-PATH gap is a unix phenomenon");
        }
    }

    #[test]
    fn verified_rejects_paths_that_do_not_run() {
        let err = Sidecar::verified(
            PathBuf::from("/definitely/not/a/real/ffmpeg"),
            PathBuf::from("/definitely/not/a/real/ffprobe"),
        )
        .unwrap_err();
        // The failing path is named: a bundled sidecar that did not survive packaging
        // must be diagnosable from the message alone.
        assert!(
            err.to_string().contains("/definitely/not/a/real/ffprobe"),
            "expected the offending path in the error, got: {err}"
        );
    }

    #[test]
    fn verified_marks_its_pair_bundled_and_from_path_marks_system() {
        // `/bin/sh -version` is not a thing, so this uses whatever real binaries the
        // machine has; skip where there are none, exactly like the accuracy harness.
        let Ok(system) = Sidecar::from_path() else {
            eprintln!("SKIP: no ffmpeg on this machine");
            return;
        };
        assert_eq!(system.source, SidecarSource::System);

        let bundled = Sidecar::verified(system.ffmpeg.clone(), system.ffprobe.clone()).unwrap();
        assert_eq!(bundled.source, SidecarSource::Bundled);
        assert_eq!(bundled.ffmpeg, system.ffmpeg);
    }

    #[test]
    fn source_serialises_as_the_lowercase_word_the_ui_switches_on() {
        assert_eq!(
            serde_json::to_string(&SidecarSource::Bundled).unwrap(),
            "\"bundled\""
        );
        assert_eq!(
            serde_json::to_string(&SidecarSource::System).unwrap(),
            "\"system\""
        );
    }

    #[test]
    fn missing_binary_is_a_spawn_failure_not_a_panic() {
        let r = run(
            Path::new("definitely-not-a-real-binary-xyz"),
            ["--version"],
            PROBE_TIMEOUT,
            &CancelToken::new(),
        );
        assert!(matches!(r, Err(RunFailure::Spawn(_))));
    }

    #[cfg(unix)]
    #[test]
    fn a_hung_child_is_killed_at_the_timeout() {
        // The core §7.2 guarantee: a process that never exits must not hang the run.
        let start = Instant::now();
        let r = run(
            Path::new("/bin/sh"),
            ["-c", "sleep 30"],
            Duration::from_millis(150),
            &CancelToken::new(),
        );
        assert_eq!(r.unwrap_err(), RunFailure::TimedOut);
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "timeout did not fire promptly: {:?}",
            start.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_grandchild_holding_the_pipe_cannot_extend_the_timeout() {
        // Regression test for a bug CI caught and the development machine could not:
        // killing the child does not close the pipes if it spawned children of its own,
        // and joining the reader threads then blocks for as long as the grandchild
        // lives. The original version of this returned after 30 s despite a 150 ms
        // timeout.
        //
        // `sleep 300 & wait` forces the fork on every shell — Ubuntu's dash forked
        // anyway, but macOS's sh execs, which is exactly why the bug hid locally.
        let start = Instant::now();
        let r = run(
            Path::new("/bin/sh"),
            ["-c", "sleep 300 & wait"],
            Duration::from_millis(150),
            &CancelToken::new(),
        );
        assert_eq!(r.unwrap_err(), RunFailure::TimedOut);
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "a surviving grandchild extended the timeout to {:?} — \
             run() must not join the reader threads on the timeout path",
            start.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_outruns_the_pipe_buffer_still_completes() {
        // Regression guard for the deadlock this module's reader threads exist to
        // prevent: without them, a child writing past the ~64 KB pipe buffer blocks
        // forever while we poll try_wait.
        let r = run(
            Path::new("/bin/sh"),
            ["-c", "yes 0123456789ABCDEF | head -c 400000"],
            Duration::from_secs(20),
            &CancelToken::new(),
        )
        .unwrap();
        assert!(r.success);
        assert_eq!(r.stdout.len(), 400_000);
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_kills_a_running_child_promptly() {
        // §7.4: cancel must return within 2 s. Once Phase 2 started decoding, checking
        // the token only between files was no longer enough — a two-hour service takes
        // far longer than two seconds to extract, so the child must die mid-flight.
        let cancel = CancelToken::new();
        let flag = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            flag.cancel();
        });

        let start = Instant::now();
        let r = run(
            Path::new("/bin/sh"),
            ["-c", "sleep 300"],
            // A timeout far beyond the test's patience, so a pass can only mean
            // cancellation stopped it — not that the deadline quietly did.
            Duration::from_secs(600),
            &cancel,
        );
        assert_eq!(r.unwrap_err(), RunFailure::Cancelled);
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "cancel took {:?}, over the §7.4 budget",
            start.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_is_reported_ahead_of_a_simultaneous_timeout() {
        // When the user pressed Cancel, "cancelled" is the honest reason to show, even
        // if the deadline lapsed in the same instant.
        let cancel = CancelToken::new();
        cancel.cancel();
        let r = run(
            Path::new("/bin/sh"),
            ["-c", "sleep 300"],
            Duration::from_millis(0),
            &cancel,
        );
        assert_eq!(r.unwrap_err(), RunFailure::Cancelled);
    }

    #[cfg(unix)]
    #[test]
    fn non_zero_exit_is_reported_with_stderr() {
        let r = run(
            Path::new("/bin/sh"),
            ["-c", "echo trouble >&2; exit 3"],
            Duration::from_secs(10),
            &CancelToken::new(),
        );
        match r.unwrap_err() {
            RunFailure::Failed { code, stderr } => {
                assert_eq!(code, Some(3));
                assert!(stderr.contains("trouble"));
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}
