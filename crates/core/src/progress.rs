//! Progress reporting and cancellation — docs/PLAN.md §3 and §7.4.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Pipeline stages, in execution order (§3).
///
/// Reported rather than derived from a percentage because §9.3 shows the user stage
/// *names* ("Leser filer", "Analyserer lyd") alongside per-file ticks — a bare
/// percentage would be a regression against what PluralEyes already does well.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Scanning,
    Probing,
    Extracting,
    Correlating,
    Placing,
    MeasuringDrift,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub stage: Stage,
    pub completed: usize,
    pub total: usize,
}

/// Sink for progress events.
///
/// `Send + Sync` because the engine runs off the UI thread (§10) and fans work out
/// across ffmpeg child processes. The Tauri shell's implementation is responsible for
/// the 10 Hz throttle §10 requires — the engine reports every event and does not
/// second-guess how often the consumer wants to hear about it, which keeps the CLI able
/// to log all of them.
pub trait ProgressSink: Send + Sync {
    fn report(&self, progress: Progress);
}

/// A `ProgressSink` that discards everything — for tests and non-interactive runs.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoProgress;

impl ProgressSink for NoProgress {
    fn report(&self, _progress: Progress) {}
}

/// Cooperative cancellation.
///
/// §7.4 requires the token to be checked between every unit of work and cancel to
/// return within 2 s. `Relaxed` ordering is sufficient: the flag is a one-way latch and
/// we only need eventual visibility, not ordering against other memory.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_visible_through_clones() {
        // The engine hands clones to worker threads; cancelling the original must be
        // observed by all of them or §7.4's 2-second guarantee is unenforceable.
        let token = CancelToken::new();
        let clone = token.clone();
        assert!(!clone.is_cancelled());
        token.cancel();
        assert!(clone.is_cancelled());
    }
}
