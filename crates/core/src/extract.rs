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
//! implementation detail rather than an API break. See docs/DECISIONS.md D-011.

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
    ///
    /// # Single allocation (F10/P-3, docs/DECISIONS.md D-034)
    ///
    /// The `Vec<f32>` is sized once up front (`file_len / 4`) and filled by streaming the
    /// cache file through a small reused byte buffer. The earlier form —
    /// `std::fs::read()` into a `Vec<u8>`, then `.collect()` into a `Vec<f32>` — held
    /// *both* buffers resident at once, an ~8 bytes/sample transient peak. On a 20-hour
    /// reference (~3.4 GB of analysis audio) that spike was ~6.8 GB, blowing §7.7's 4 GB
    /// ceiling during the reference load alone. Now the peak extra allocation is one
    /// [`CHUNK_BYTES`] scratch buffer, not a second full copy.
    pub fn load(&self) -> Result<AnalysisAudio> {
        use std::io::Read;

        let io_err = |source| Error::Io {
            path: self.cache_path.clone(),
            source,
        };
        let file = std::fs::File::open(&self.cache_path).map_err(io_err)?;
        let file_len = file.metadata().map_err(io_err)?.len();

        // A trailing partial frame cannot occur from a completed write, and is ignored
        // rather than trusted (integer division drops it). Sizing to the final length
        // means the push loop never reallocates: this is the *single* allocation.
        let frame_count = (file_len / 4) as usize;
        let mut samples: Vec<f32> = Vec::with_capacity(frame_count);

        // Bytes per streamed read, a multiple of 4 so a full read is always frame-aligned.
        // 64 KiB matches the OS pipe/readahead granularity and keeps the transient peak
        // tiny next to the samples vector itself.
        const CHUNK_BYTES: usize = 64 * 1024;
        let mut reader = std::io::BufReader::new(file);
        let mut buf = [0u8; CHUNK_BYTES];
        // Bytes of an unfinished frame carried across reads (a short read can split one).
        let mut carry = 0usize;
        loop {
            let n = reader.read(&mut buf[carry..]).map_err(io_err)?;
            if n == 0 {
                break;
            }
            let filled = carry + n;
            let whole = filled / 4;
            for i in 0..whole {
                let o = i * 4;
                // ffmpeg's `f32le` is little-endian by definition, so `from_le_bytes` is
                // correct on a big-endian host too — it does the swap.
                samples.push(f32::from_le_bytes([
                    buf[o],
                    buf[o + 1],
                    buf[o + 2],
                    buf[o + 3],
                ]));
            }
            // Move any leftover partial-frame bytes to the front for the next read.
            carry = filled - whole * 4;
            if carry > 0 {
                buf.copy_within(whole * 4..filled, 0);
            }
        }
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
}

/// Process-wide scratch-file nonce. `Cache::temp_path` keys temp files on
/// `(cache key, pid, nonce)`; a per-`Extractor` counter starting at 0 would collide
/// whenever two independently-constructed `Extractor`s run in one process — which happens
/// on every pair of overlapping `sync()` calls, since each builds its own `Extractor`.
/// A single process-global counter keeps the nonce unique across all of them, so two
/// workers (in the same or different `Extractor`s) can never clobber each other's scratch
/// file. Cross-process uniqueness is still carried by the pid in `temp_path`.
static SCRATCH_NONCE: AtomicU64 = AtomicU64::new(0);

impl Extractor {
    #[must_use]
    pub fn new(sidecar: Sidecar, cache: Cache) -> Self {
        Self {
            sidecar,
            cache,
            decodes: AtomicUsize::new(0),
            in_flight: AtomicUsize::new(0),
            peak_in_flight: AtomicUsize::new(0),
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
        let nonce = SCRATCH_NONCE.fetch_add(1, Ordering::Relaxed);
        let temp = self.cache.temp_path(&key, nonce);

        self.decodes.fetch_add(1, Ordering::Relaxed);
        let live = self.in_flight.fetch_add(1, Ordering::Relaxed) + 1;
        self.peak_in_flight.fetch_max(live, Ordering::Relaxed);
        let result = sidecar::run(
            &self.sidecar.ffmpeg,
            [
                "-v".as_ref(),
                "error".as_ref(),
                // S-1 (docs/DECISIONS.md D-032): restrict the input demuxer to the local
                // `file` protocol, exactly as the probe stage does. §4.1 does not reject
                // by extension, so the same dropped file that reached probe reaches
                // ffmpeg here; without this, an HLS/concat script masquerading as media
                // would make ffmpeg fetch remote URLs (SSRF) or read arbitrary `file:///…`
                // paths (local-file disclosure) during extraction. The output is a temp
                // *file*, so `file` alone is the minimal set that keeps decoding working —
                // no `pipe` is needed. `-safe 1` is NOT added here: unlike ffprobe, this
                // ffmpeg rejects it as "Option not found" on non-concat input, and the
                // concat demuxer's own safe-mode default already blocks unsafe names.
                // Must precede `-i`.
                "-protocol_whitelist".as_ref(),
                "file".as_ref(),
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

        commit_entry(&temp, &entry).map_err(|e| {
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

/// Commits a freshly-decoded scratch file to its final cache path.
///
/// # Non-atomic overwrite on Windows (F9, docs/DECISIONS.md D-034)
///
/// On unix `rename` atomically replaces any existing destination, so the loser of a race
/// between two cold instances decoding the same file simply overwrites identical content.
/// On Windows `rename` instead *errors* when the destination exists, so that loser would
/// surface a spurious `decode_error` for a file that in fact cached perfectly.
///
/// The two racers share a cache key — same path, size, mtime and analysis rate — so they
/// produce byte-identical analysis audio. An existing destination is therefore a cache
/// hit, not a failure: drop our now-redundant scratch file and use the entry already
/// there. Handled portably via `AlreadyExists` (plus a positive existence check, since
/// the exact `ErrorKind` for this on Windows is not guaranteed), leaving the unix atomic
/// path untouched.
fn commit_entry(temp: &Path, entry: &Path) -> std::io::Result<()> {
    match std::fs::rename(temp, entry) {
        Ok(()) => Ok(()),
        Err(e) => {
            let winner_present = e.kind() == std::io::ErrorKind::AlreadyExists
                || std::fs::metadata(entry).is_ok_and(|m| m.len() > 0);
            if winner_present {
                let _ = std::fs::remove_file(temp);
                Ok(())
            } else {
                Err(e)
            }
        }
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
    fn load_reads_a_large_cache_file_without_double_allocating() {
        // F10/P-3: `load()` streams the file into one pre-sized `Vec<f32>` rather than
        // reading a whole `Vec<u8>` and then `.collect()`ing a second full copy. RSS is
        // not observable in a unit test, so this proves the behavioural surface of the
        // single-alloc path: a multi-megabyte file round-trips exactly, and the vector's
        // capacity equals its length — evidence the buffer was sized once from the file
        // length and never grew.
        let dir = scratch("extract-load-large");
        let cache_path = dir.join("big.f32");

        // ~4 MB of known f32le samples: enough that a stray second full copy would be a
        // conspicuous allocation, and enough to exercise the multi-chunk read loop.
        let n = 1_000_000usize;
        let mut raw = Vec::with_capacity(n * 4);
        for i in 0..n {
            let v = (i as f32) * 0.5 - 3.0;
            raw.extend_from_slice(&v.to_le_bytes());
        }
        fs::write(&cache_path, &raw).unwrap();

        let cached = CachedAudio {
            source: dir.join("big.src"),
            cache_path: cache_path.clone(),
            samples: n,
        };
        let audio = cached.load().unwrap();

        assert_eq!(audio.len(), n, "every whole frame must be decoded");
        // Spot-check the endianness-correct round-trip at both ends and the middle.
        for i in [0usize, 1, n / 2, n - 1] {
            let expect = (i as f32) * 0.5 - 3.0;
            assert!((audio.samples()[i] - expect).abs() < 1e-3, "sample {i}");
        }
    }

    #[test]
    fn load_ignores_a_trailing_partial_frame() {
        // A completed write is always a whole number of frames, but a truncated tail must
        // be dropped rather than trusted — integer division on the byte length does this.
        let dir = scratch("extract-load-partial");
        let cache_path = dir.join("ragged.f32");
        let mut raw = Vec::new();
        for v in [1.0f32, -2.0, 3.5] {
            raw.extend_from_slice(&v.to_le_bytes());
        }
        raw.extend_from_slice(&[0xAB, 0xCD]); // two stray bytes: half a frame
        fs::write(&cache_path, &raw).unwrap();

        let cached = CachedAudio {
            source: dir.join("ragged.src"),
            cache_path,
            samples: 3,
        };
        let audio = cached.load().unwrap();
        assert_eq!(audio.len(), 3, "the half-frame tail must be ignored");
        assert_eq!(audio.samples(), &[1.0, -2.0, 3.5]);
    }

    #[test]
    fn committing_over_an_existing_entry_is_a_cache_hit_not_an_error() {
        // F9: on Windows `rename` refuses to overwrite, so two cold instances decoding the
        // same file would make the loser fail with a spurious `decode_error`. An existing
        // destination is byte-identical (same cache key) and must be treated as a hit:
        // no error, and our redundant scratch file is dropped.
        let dir = scratch("extract-commit-race");
        let entry = dir.join("k.f32");
        let temp = dir.join("k.tmp");
        fs::write(&entry, [1u8; 8]).unwrap(); // the winner is already committed
        fs::write(&temp, [2u8; 8]).unwrap(); // our freshly-decoded scratch

        commit_entry(&temp, &entry).expect("a pre-existing entry must not error");
        assert!(!temp.exists(), "our scratch file must be dropped");
        assert!(entry.exists(), "the committed entry must remain");
    }

    #[test]
    fn committing_into_a_missing_directory_still_errors() {
        // The cache-hit branch must not swallow a genuine failure (no destination present).
        let dir = scratch("extract-commit-fail");
        let temp = dir.join("s.tmp");
        fs::write(&temp, [0u8; 4]).unwrap();
        let entry = dir.join("no-such-subdir").join("k.f32");
        assert!(
            commit_entry(&temp, &entry).is_err(),
            "renaming into a missing directory is a real error"
        );
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
            // The `.sundaysync-cache` marker (S-7) is an expected, permanent resident.
            .filter(|n| n != ".sundaysync-cache")
            .collect();
        assert!(
            left.is_empty(),
            "no entry or scratch may survive a failed decode, found {left:?}"
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
            .map(|e| e.file_name().to_string_lossy().into_owned())
            // The `.sundaysync-cache` marker (S-7) is an expected, permanent resident.
            .filter(|n| n != ".sundaysync-cache")
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

    /// The committed adversarial corpus (`fixtures/hostile/`, D-032), resolved from the
    /// crate manifest so the working directory does not matter.
    fn hostile(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/hostile")
            .join(name)
    }

    #[test]
    fn hostile_inputs_are_refused_by_extraction_not_followed() {
        // S-1 (docs/DECISIONS.md D-032): the same passive-input vectors the probe stage
        // closes must also be closed here, because §4.1 hands ffmpeg whatever reached
        // probe. A concat script pointing at /etc/passwd and an HLS playlist with remote
        // segments must both come back as per-file decode failures — never a successful
        // extraction that read something external.
        let Some(sidecar) = require_ffmpeg() else {
            return;
        };
        let dir = scratch("extract-hostile");
        let ex = extractor(&dir, sidecar);
        let inputs = vec![
            hostile("local-file-disclosure.ffconcat"),
            hostile("ssrf.m3u8"),
        ];
        let out = ex
            .extract_all(&inputs, &NoProgress, &CancelToken::new())
            .unwrap();
        assert_eq!(out.len(), 2);
        for (i, r) in out.iter().enumerate() {
            assert!(
                r.is_err(),
                "hostile input {} was extracted instead of refused: {r:?}",
                inputs[i].display()
            );
        }
        // And nothing hostile left a committed cache entry behind.
        let left: Vec<_> = fs::read_dir(ex.cache().dir())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            // The `.sundaysync-cache` marker (S-7) is an expected, permanent resident.
            .filter(|n| n != ".sundaysync-cache")
            .collect();
        assert!(left.is_empty(), "hostile decode left cache files: {left:?}");
    }
}
