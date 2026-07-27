//! Analysis-audio extraction — docs/PLAN.md §4.2.
//!
//! Decodes each file's first audio stream to mono f32 PCM at [`ANALYSIS_RATE`], caching
//! the result so a re-sync never decodes twice.
//!
//! # Why extraction returns handles, not audio
//!
//! [`Extractor::extract_all`] populates the cache and hands back [`CachedAudio`]
//! handles; the samples are read on demand via [`CachedAudio::load`]. Returning the
//! audio itself would defeat §7.7's memory ceiling: analysis audio is ~47 KB/s, so a
//! twenty-hour day is roughly 3.4 GB — over the 4 GB RSS budget before the FFTs have
//! allocated anything. §4.3 correlates one clip against the reference at a time, so
//! that is all that ever needs to be resident.
//!
//! [`AnalysisAudio`] is deliberately opaque. It holds a `Vec<f32>` today; if Phase 3's
//! access pattern turns out to want the memory-mapping §7.7 mentions, that becomes an
//! implementation detail rather than an API break. See docs/DECISIONS.md D-012.

use crate::cache::{Cache, CacheKey};
use crate::error::{Error, Result};
use crate::progress::{CancelToken, Progress, ProgressSink, Stage};
use crate::request::ANALYSIS_RATE;
use crate::sidecar::{self, RunFailure, Sidecar};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

/// Safety valve for one decode.
///
/// Far longer than the 30 s probe timeout because this reads the whole file: a
/// three-hour service is minutes of honest work, not a hang. Sized so it can never fire
/// on legitimate media while still bounding a wedged ffmpeg. Cancellation, not this, is
/// what makes the UI responsive (§7.4).
pub const EXTRACT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// §4.2: "Parallel decode: `min(4, physical_cores)`".
///
/// Capped at 4 because decoding is I/O- and memory-bandwidth-bound well before it is
/// CPU-bound; more concurrent ffmpeg processes mostly contend for the same disk.
/// `available_parallelism` reports logical cores, so on an SMT machine this is a mild
/// over-estimate of physical ones — immaterial against a cap of 4.
#[must_use]
pub fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map_or(1, std::num::NonZeroUsize::get)
        .clamp(1, 4)
}

/// A populated cache entry: where the analysis audio lives, and how much of it there is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedAudio {
    pub source: PathBuf,
    pub cache_path: PathBuf,
    pub samples: usize,
}

impl CachedAudio {
    #[must_use]
    pub fn duration_seconds(&self) -> f64 {
        self.samples as f64 / f64::from(ANALYSIS_RATE)
    }

    /// Reads the samples into memory.
    pub fn load(&self) -> Result<AnalysisAudio> {
        let bytes = std::fs::read(&self.cache_path).map_err(|source| Error::Io {
            path: self.cache_path.clone(),
            source,
        })?;
        // ffmpeg's `f32le` is little-endian by definition, so this is correct on a
        // big-endian host too — `from_le_bytes` does the swap. A trailing partial frame
        // cannot occur from a completed write, and is ignored rather than trusted.
        let samples = bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        Ok(AnalysisAudio { samples })
    }
}

/// Mono f32 analysis audio at [`ANALYSIS_RATE`].
#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisAudio {
    samples: Vec<f32>,
}

impl AnalysisAudio {
    #[must_use]
    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.samples.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    #[must_use]
    pub fn duration_seconds(&self) -> f64 {
        self.samples.len() as f64 / f64::from(ANALYSIS_RATE)
    }
}

/// Why one file could not be extracted. Maps to `decode_error` in §5.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractError {
    pub source: PathBuf,
    pub reason: String,
}

/// Decodes analysis audio, with caching and bounded parallelism.
#[derive(Debug)]
pub struct Extractor {
    sidecar: Sidecar,
    cache: Cache,
    /// How many ffmpeg processes this extractor actually started.
    ///
    /// Instrumentation, not bookkeeping: §11's Phase 2 acceptance criterion is that
    /// "cache hits skip ffmpeg (verified by process count)", and asserting on a counter
    /// is the only way to prove a cache hit did not quietly decode anyway.
    decodes: AtomicUsize,
    /// Live and high-water decode concurrency.
    ///
    /// Also instrumentation: §11's other Phase 2 criterion is that "parallel decode
    /// saturates the file set", and the only way to show decodes genuinely *overlap* —
    /// rather than merely all completing — is to observe how many were in flight at
    /// once. A wall-clock comparison would be a flaky proxy for the same claim.
    in_flight: AtomicUsize,
    peak_in_flight: AtomicUsize,
    nonce: AtomicU64,
}

impl Extractor {
    #[must_use]
    pub fn new(sidecar: Sidecar, cache: Cache) -> Self {
        Self {
            sidecar,
            cache,
            decodes: AtomicUsize::new(0),
            in_flight: AtomicUsize::new(0),
            peak_in_flight: AtomicUsize::new(0),
            nonce: AtomicU64::new(0),
        }
    }

    /// Number of ffmpeg decodes performed. A cache hit does not increment it.
    #[must_use]
    pub fn decode_count(&self) -> usize {
        self.decodes.load(Ordering::Relaxed)
    }

    /// The greatest number of ffmpeg decodes that were running simultaneously.
    #[must_use]
    pub fn peak_concurrency(&self) -> usize {
        self.peak_in_flight.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn cache(&self) -> &Cache {
        &self.cache
    }

    /// Extracts every path, in parallel, returning results aligned to the input order.
    ///
    /// Per-file failures are values, not errors: a file ffmpeg cannot decode belongs in
    /// `unsynced` with `decode_error`, and must not abort the run (§7.2). Only
    /// cancellation and a failure to create the cache directory are `Err`.
    pub fn extract_all(
        &self,
        paths: &[PathBuf],
        progress: &dyn ProgressSink,
        cancel: &CancelToken,
    ) -> Result<Vec<std::result::Result<CachedAudio, ExtractError>>> {
        self.cache.ensure_dir()?;
        let total = paths.len();

        // Indexed slots rather than a push-order queue: results must be aligned to the
        // input regardless of which worker finishes first, or output would depend on
        // thread scheduling and §13.4's byte-equality test would flap.
        //
        // One mutex over the whole vector, not one per slot: workers hold it only long
        // enough to store a finished result, which is nothing next to the ffmpeg run
        // that produced it.
        let slots: std::sync::Mutex<Vec<Option<std::result::Result<CachedAudio, ExtractError>>>> =
            std::sync::Mutex::new((0..total).map(|_| None).collect());

        let next = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);

        std::thread::scope(|scope| {
            for _ in 0..worker_count().min(total.max(1)) {
                scope.spawn(|| loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= total || cancel.is_cancelled() {
                        break;
                    }
                    let outcome = self.extract_one(&paths[i], cancel);
                    if let Ok(mut slots) = slots.lock() {
                        slots[i] = Some(outcome);
                    }
                    progress.report(Progress {
                        stage: Stage::Extracting,
                        completed: done.fetch_add(1, Ordering::Relaxed) + 1,
                        total,
                    });
                });
            }
        });

        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }

        slots
            .into_inner()
            .map_err(|_| Error::Invariant("extraction worker panicked".into()))?
            .into_iter()
            .enumerate()
            .map(|(i, slot)| {
                slot.ok_or_else(|| {
                    // Only reachable if a worker vanished without recording a result,
                    // which would silently drop a file and violate §7.3.
                    Error::Invariant(format!(
                        "no extraction result recorded for {}",
                        paths[i].display()
                    ))
                })
            })
            .collect()
    }

    /// Extracts one file, or returns the cached entry.
    fn extract_one(
        &self,
        path: &Path,
        cancel: &CancelToken,
    ) -> std::result::Result<CachedAudio, ExtractError> {
        let fail = |reason: String| ExtractError {
            source: path.to_path_buf(),
            reason,
        };

        let key = CacheKey::for_file(path, ANALYSIS_RATE).map_err(|e| fail(e.to_string()))?;
        let entry = self.cache.entry_path(&key);

        if self.cache.contains(&key) {
            let samples = std::fs::metadata(&entry).map_or(0, |m| m.len() as usize) / 4;
            return Ok(CachedAudio {
                source: path.to_path_buf(),
                cache_path: entry,
                samples,
            });
        }

        // Decode to a scratch file, then rename. §11's "interrupted extraction leaves no
        // corrupt cache entries" depends entirely on this: ffmpeg writing straight to
        // `entry` would leave a half-written file that `contains()` would happily serve
        // as truncated audio on the next run — silently syncing against a clip that
        // stops early, which is exactly the silent-wrongness §7.5 forbids.
        let nonce = self.nonce.fetch_add(1, Ordering::Relaxed);
        let temp = self.cache.temp_path(&key, nonce);

        self.decodes.fetch_add(1, Ordering::Relaxed);
        let live = self.in_flight.fetch_add(1, Ordering::Relaxed) + 1;
        self.peak_in_flight.fetch_max(live, Ordering::Relaxed);
        let result = sidecar::run(
            &self.sidecar.ffmpeg,
            [
                "-v".as_ref(),
                "error".as_ref(),
                "-i".as_ref(),
                path.as_os_str(),
                // §4.2 verbatim: first audio stream, mono, ANALYSIS_RATE, raw f32le.
                "-map".as_ref(),
                "0:a:0".as_ref(),
                "-ac".as_ref(),
                "1".as_ref(),
                "-ar".as_ref(),
                analysis_rate_arg().as_ref(),
                "-f".as_ref(),
                "f32le".as_ref(),
                "-y".as_ref(),
                temp.as_os_str(),
            ],
            EXTRACT_TIMEOUT,
            cancel,
        );
        self.in_flight.fetch_sub(1, Ordering::Relaxed);

        match result {
            Ok(_) => {}
            Err(e) => {
                // Leave nothing behind on any failure path, cancellation included —
                // §7.4 requires cancel to leave only *reusable* cache files.
                let _ = std::fs::remove_file(&temp);
                return Err(fail(match e {
                    RunFailure::Cancelled => "cancelled".into(),
                    other => other.to_string(),
                }));
            }
        }

        let len = match std::fs::metadata(&temp) {
            Ok(m) => m.len(),
            Err(e) => {
                let _ = std::fs::remove_file(&temp);
                return Err(fail(format!("ffmpeg produced no output: {e}")));
            }
        };
        if len == 0 {
            // ffmpeg can exit 0 having written nothing — e.g. a stream that decodes to
            // zero frames. An empty entry is worse than no entry.
            let _ = std::fs::remove_file(&temp);
            return Err(fail("ffmpeg produced an empty audio stream".into()));
        }

        std::fs::rename(&temp, &entry).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            fail(format!("could not commit cache entry: {e}"))
        })?;

        Ok(CachedAudio {
            source: path.to_path_buf(),
            cache_path: entry,
            samples: len as usize / 4,
        })
    }
}

fn analysis_rate_arg() -> String {
    ANALYSIS_RATE.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::NoProgress;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("sundaysync-tests").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A hand-written PCM WAV — creating fixtures needs no ffmpeg, only reading them does.
    fn write_wav(path: &Path, seconds: f64, freq: f64) {
        let rate = 8000u32;
        let samples = (f64::from(rate) * seconds) as u32;
        let data_len = samples * 2;
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data_len).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&rate.to_le_bytes());
        w.extend_from_slice(&(rate * 2).to_le_bytes());
        w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..samples {
            let t = f64::from(i) / f64::from(rate);
            let v = (t * freq * std::f64::consts::TAU).sin() * 12000.0;
            w.extend_from_slice(&(v as i16).to_le_bytes());
        }
        fs::write(path, w).unwrap();
    }

    fn require_ffmpeg() -> Option<Sidecar> {
        match Sidecar::from_path() {
            Ok(s) => Some(s),
            Err(e) => {
                assert!(
                    std::env::var("SUNDAYSYNC_REQUIRE_FFMPEG").is_err(),
                    "ffmpeg is required in this environment but was not found: {e}"
                );
                eprintln!("SKIP: ffmpeg unavailable ({e})");
                None
            }
        }
    }

    fn extractor(dir: &Path, sidecar: Sidecar) -> Extractor {
        Extractor::new(sidecar, Cache::new(dir.join("cache")))
    }

    #[test]
    fn worker_count_is_between_one_and_four() {
        let n = worker_count();
        assert!((1..=4).contains(&n), "got {n}");
    }

    #[test]
    fn extracts_audio_at_the_analysis_rate() {
        let Some(sidecar) = require_ffmpeg() else {
            return;
        };
        let dir = scratch("extract-basic");
        let src = dir.join("a.wav");
        write_wav(&src, 2.0, 440.0);

        let ex = extractor(&dir, sidecar);
        let out = ex
            .extract_all(std::slice::from_ref(&src), &NoProgress, &CancelToken::new())
            .unwrap();
        let cached = out[0].as_ref().unwrap();

        // 2 s at 12 kHz. Tolerance absorbs codec priming — the D-004 effect, which for
        // PCM should be nil but is not worth asserting to the sample here.
        let expected = 2.0 * f64::from(ANALYSIS_RATE);
        assert!(
            (cached.samples as f64 - expected).abs() < expected * 0.02,
            "got {} samples, expected ~{expected}",
            cached.samples
        );
        assert!((cached.duration_seconds() - 2.0).abs() < 0.05);

        let audio = cached.load().unwrap();
        assert_eq!(audio.len(), cached.samples);
        assert!(!audio.is_empty());
        // A 440 Hz tone must not decode to silence.
        assert!(audio.samples().iter().any(|s| s.abs() > 0.01));
    }

    #[test]
    fn a_cache_hit_does_not_run_ffmpeg() {
        // §11 Phase 2 acceptance criterion, asserted on the process count.
        let Some(sidecar) = require_ffmpeg() else {
            return;
        };
        let dir = scratch("extract-cachehit");
        let src = dir.join("a.wav");
        write_wav(&src, 0.5, 300.0);

        let one = std::slice::from_ref(&src);
        let ex = extractor(&dir, sidecar.clone());
        ex.extract_all(one, &NoProgress, &CancelToken::new())
            .unwrap();
        assert_eq!(ex.decode_count(), 1, "first run must decode");

        ex.extract_all(one, &NoProgress, &CancelToken::new())
            .unwrap();
        assert_eq!(ex.decode_count(), 1, "second run must be a pure cache hit");

        // A fresh extractor over the same cache dir must also hit.
        let ex2 = extractor(&dir, sidecar);
        let out = ex2
            .extract_all(one, &NoProgress, &CancelToken::new())
            .unwrap();
        assert_eq!(ex2.decode_count(), 0, "cache must survive a new extractor");
        assert!(out[0].is_ok());
    }

    #[test]
    fn touching_the_source_invalidates_the_entry() {
        let Some(sidecar) = require_ffmpeg() else {
            return;
        };
        let dir = scratch("extract-invalidate");
        let src = dir.join("a.wav");
        write_wav(&src, 0.5, 300.0);

        let one = std::slice::from_ref(&src);
        let ex = extractor(&dir, sidecar);
        ex.extract_all(one, &NoProgress, &CancelToken::new())
            .unwrap();
        assert_eq!(ex.decode_count(), 1);

        // Re-record: same path, different content and length.
        write_wav(&src, 0.8, 300.0);
        ex.extract_all(one, &NoProgress, &CancelToken::new())
            .unwrap();
        assert_eq!(ex.decode_count(), 2, "changed media must re-decode");
    }

    #[test]
    fn an_undecodable_file_is_a_value_not_an_error() {
        // §7.2: one bad file must never abort the run.
        let Some(sidecar) = require_ffmpeg() else {
            return;
        };
        let dir = scratch("extract-bad");
        let good = dir.join("good.wav");
        write_wav(&good, 0.4, 200.0);
        let bad = dir.join("bad.mp4");
        fs::write(&bad, vec![0xAB; 2048]).unwrap();

        let ex = extractor(&dir, sidecar);
        let out = ex
            .extract_all(
                &[good.clone(), bad.clone()],
                &NoProgress,
                &CancelToken::new(),
            )
            .unwrap();

        assert!(out[0].is_ok(), "the good file must still succeed");
        assert!(out[1].is_err());
        assert_eq!(out[1].as_ref().unwrap_err().source, bad);
    }

    #[test]
    fn a_failed_extraction_leaves_no_cache_entry_and_no_scratch_file() {
        // §11: "interrupted extraction leaves no corrupt cache entries".
        let Some(sidecar) = require_ffmpeg() else {
            return;
        };
        let dir = scratch("extract-nocorrupt");
        let bad = dir.join("bad.mp4");
        fs::write(&bad, vec![0xAB; 2048]).unwrap();

        let ex = extractor(&dir, sidecar);
        let out = ex
            .extract_all(&[bad], &NoProgress, &CancelToken::new())
            .unwrap();
        assert!(out[0].is_err());

        let left: Vec<_> = fs::read_dir(ex.cache().dir())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            left.is_empty(),
            "cache dir must be empty after a failed decode, found {left:?}"
        );
    }

    #[test]
    fn results_are_aligned_to_the_input_order() {
        // Parallel workers finish out of order; the output must not.
        let Some(sidecar) = require_ffmpeg() else {
            return;
        };
        let dir = scratch("extract-order");
        let mut paths = Vec::new();
        for n in 0..6 {
            let p = dir.join(format!("f{n}.wav"));
            // Descending lengths, so later inputs finish first.
            write_wav(&p, 1.2 - f64::from(n) * 0.15, 200.0 + f64::from(n) * 50.0);
            paths.push(p);
        }

        let ex = extractor(&dir, sidecar);
        let out = ex
            .extract_all(&paths, &NoProgress, &CancelToken::new())
            .unwrap();

        assert_eq!(out.len(), paths.len());
        for (i, r) in out.iter().enumerate() {
            assert_eq!(r.as_ref().unwrap().source, paths[i], "slot {i} misaligned");
        }
    }

    #[test]
    fn all_files_are_extracted_in_parallel() {
        // §11: "parallel decode saturates the file set". Every input gets a result, the
        // set decodes exactly once, and — the part worth proving — decodes actually
        // overlap rather than merely all finishing.
        let Some(sidecar) = require_ffmpeg() else {
            return;
        };
        let dir = scratch("extract-parallel");
        let mut paths = Vec::new();
        for n in 0..16 {
            let p = dir.join(format!("p{n}.wav"));
            // Long enough that a decode outlives the scheduling of its neighbours;
            // short enough to keep the suite quick.
            write_wav(&p, 4.0, 200.0 + f64::from(n) * 40.0);
            paths.push(p);
        }

        let ex = extractor(&dir, sidecar);
        let out = ex
            .extract_all(&paths, &NoProgress, &CancelToken::new())
            .unwrap();
        assert_eq!(out.len(), 16);
        assert!(out.iter().all(std::result::Result::is_ok));
        assert_eq!(ex.decode_count(), 16);

        assert!(
            ex.peak_concurrency() <= worker_count(),
            "must never exceed the §4.2 cap: peak {} > {}",
            ex.peak_concurrency(),
            worker_count()
        );
        if worker_count() > 1 {
            assert!(
                ex.peak_concurrency() > 1,
                "decodes never overlapped (peak {}), so the pool is not parallel",
                ex.peak_concurrency()
            );
        } else {
            eprintln!("SKIP: single-core runner, cannot observe overlap");
        }
    }

    #[test]
    fn progress_counts_every_file_exactly_once() {
        let Some(sidecar) = require_ffmpeg() else {
            return;
        };
        use std::sync::Mutex;
        struct Rec(Mutex<Vec<Progress>>);
        impl ProgressSink for Rec {
            fn report(&self, p: Progress) {
                if let Ok(mut v) = self.0.lock() {
                    v.push(p);
                }
            }
        }

        let dir = scratch("extract-progress");
        let mut paths = Vec::new();
        for n in 0..5 {
            let p = dir.join(format!("q{n}.wav"));
            write_wav(&p, 0.3, 300.0);
            paths.push(p);
        }

        let ex = extractor(&dir, sidecar);
        let rec = Rec(Mutex::new(Vec::new()));
        ex.extract_all(&paths, &rec, &CancelToken::new()).unwrap();

        let seen = rec.0.lock().unwrap();
        assert_eq!(seen.len(), 5);
        assert!(seen.iter().all(|p| p.stage == Stage::Extracting));
        let mut completed: Vec<usize> = seen.iter().map(|p| p.completed).collect();
        completed.sort_unstable();
        assert_eq!(completed, vec![1, 2, 3, 4, 5], "counter must not repeat");
    }

    #[test]
    fn a_pre_cancelled_run_returns_cancelled_and_writes_nothing() {
        let Some(sidecar) = require_ffmpeg() else {
            return;
        };
        let dir = scratch("extract-cancel");
        let src = dir.join("a.wav");
        write_wav(&src, 0.5, 300.0);

        let cancel = CancelToken::new();
        cancel.cancel();
        let ex = extractor(&dir, sidecar);
        let r = ex.extract_all(&[src], &NoProgress, &cancel);

        assert!(matches!(r, Err(Error::Cancelled)));
        assert_eq!(ex.decode_count(), 0, "cancelled before any ffmpeg started");
        let left: Vec<_> = fs::read_dir(ex.cache().dir())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .collect();
        assert!(left.is_empty(), "§7.4: leave only reusable cache files");
    }

    #[test]
    fn an_empty_input_list_is_not_an_error() {
        let dir = scratch("extract-empty");
        let ex = extractor(&dir, Sidecar::default());
        let out = ex
            .extract_all(&[], &NoProgress, &CancelToken::new())
            .unwrap();
        assert!(out.is_empty());
    }
}
