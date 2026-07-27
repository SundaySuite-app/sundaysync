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
use std::ffi::OsStr;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// §4.1: "in a child process with a 30 s timeout".
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// How often `try_wait` is polled. Small enough to be invisible next to a typical
/// ~30 ms ffprobe run, large enough not to spin a core.
const POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Locations of the ffmpeg and ffprobe binaries.
///
/// Bare command names resolve through `PATH`, which is what a development checkout and
/// CI both want. Phase 7 will construct this with absolute paths to the bundled
/// per-platform sidecars instead (§10) — hence the explicit constructor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sidecar {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Default for Sidecar {
    fn default() -> Self {
        Self {
            ffmpeg: PathBuf::from("ffmpeg"),
            ffprobe: PathBuf::from("ffprobe"),
        }
    }
}

impl Sidecar {
    #[must_use]
    pub fn new(ffmpeg: PathBuf, ffprobe: PathBuf) -> Self {
        Self { ffmpeg, ffprobe }
    }

    /// Resolves the binaries from `PATH` and verifies both actually run.
    ///
    /// Checked eagerly so a missing ffmpeg is one clear [`Error::SidecarUnavailable`]
    /// at startup, rather than every single input file failing with `decode_error` and
    /// the user concluding their whole shoot is corrupt.
    pub fn from_path() -> Result<Self> {
        let sidecar = Self::default();
        for bin in [&sidecar.ffprobe, &sidecar.ffmpeg] {
            let ok = Command::new(bin)
                .arg("-version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok {
                return Err(Error::SidecarUnavailable(format!(
                    "`{}` could not be run — is ffmpeg installed and on PATH?",
                    bin.display()
                )));
            }
        }
        Ok(sidecar)
    }

    /// True if both binaries are runnable. For tests that must skip without ffmpeg.
    #[must_use]
    pub fn is_available() -> bool {
        Self::from_path().is_ok()
    }
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
    /// Ran, but exited non-zero.
    Failed { code: Option<i32>, stderr: String },
}

impl std::fmt::Display for RunFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(e) => write!(f, "could not spawn: {e}"),
            Self::TimedOut => write!(f, "timed out"),
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

/// Runs a command to completion, killing it if it exceeds `timeout`.
///
/// stdout and stderr are drained on dedicated threads. This matters more than it looks:
/// polling `try_wait` while leaving the pipes unread deadlocks the moment a child
/// writes more than the OS pipe buffer, and a malformed file is exactly what makes
/// ffprobe verbose. The reader threads keep the pipes flowing so the timeout is the
/// only thing that can stop us.
pub fn run<I, S>(
    bin: &std::path::Path,
    args: I,
    timeout: Duration,
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
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    // Best-effort kill, then reap so we never leave a zombie behind.
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(RunFailure::Spawn(e.to_string())),
        }
    };

    // The pipes close when the child dies, so both readers terminate either way. A
    // panicking reader thread is treated as "no output" rather than propagated — this
    // path must not be able to take the run down (§7.2).
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).into_owned();

    match status {
        None => Err(RunFailure::TimedOut),
        Some(status) if status.success() => Ok(Output {
            stdout,
            stderr,
            success: true,
        }),
        Some(status) => Err(RunFailure::Failed {
            code: status.code(),
            stderr,
        }),
    }
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
    fn missing_binary_is_a_spawn_failure_not_a_panic() {
        let r = run(
            Path::new("definitely-not-a-real-binary-xyz"),
            ["--version"],
            PROBE_TIMEOUT,
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
    fn a_child_that_outruns_the_pipe_buffer_still_completes() {
        // Regression guard for the deadlock this module's reader threads exist to
        // prevent: without them, a child writing past the ~64 KB pipe buffer blocks
        // forever while we poll try_wait.
        let r = run(
            Path::new("/bin/sh"),
            ["-c", "yes 0123456789ABCDEF | head -c 400000"],
            Duration::from_secs(20),
        )
        .unwrap();
        assert!(r.success);
        assert_eq!(r.stdout.len(), 400_000);
    }

    #[cfg(unix)]
    #[test]
    fn non_zero_exit_is_reported_with_stderr() {
        let r = run(
            Path::new("/bin/sh"),
            ["-c", "echo trouble >&2; exit 3"],
            Duration::from_secs(10),
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
