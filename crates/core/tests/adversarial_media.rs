//! E4's adversarial media suite (docs/V02-PROGRAM.md) — hostile-but-not-malicious media,
//! the kind a crashed recorder, an interrupted transfer, or a careless rename actually
//! produces. `tests/accuracy.rs` proves the engine works on good audio; the security
//! tests in `crates/core/src/extract.rs` (`hostile_inputs_are_refused_by_extraction_not_
//! followed`) prove it refuses malicious *scripts* masquerading as media (S-1). This file
//! is the third leg: malformed-but-honest media must land in a defined §5 outcome bucket
//! — placed, or unsynced with a reason — and never panic, and never hang past the
//! per-file timeout.
//!
//! Every case is driven through the real `scan`/`Extractor`/`sync` path, exactly as a
//! dropped folder would be.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use sundaysync_core::{scan, Cache, CancelToken, Extractor, NoProgress, Sidecar, SyncRequest};
use sundaysync_fixturegen::{hostile, shoot, signal, wav};

/// No single case in this suite should take anywhere near this long. Generous next to
/// the engine's own 30 s probe / 30 min extract timeouts — the point is to prove nothing
/// hangs, not to race the engine's own bounds.
const CASE_BUDGET: Duration = Duration::from_secs(90);

/// The D-005 skip guard — see `tests/accuracy.rs` for the full rationale.
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

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir()
        .join("sundaysync-adversarial")
        // Per-process (V05-W5): see `stability.rs`'s `scratch` for why the pid is here.
        .join(format!("pid-{}", std::process::id()))
        .join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Runs `scan()` over one directory, asserting it neither panics nor runs past
/// [`CASE_BUDGET`], and returns the manifest for the caller to assert specifics on.
fn scan_within_budget(dir: &Path, sidecar: &Sidecar) -> scan::ScanManifest {
    let started = Instant::now();
    let manifest = scan::scan(
        &[dir.to_path_buf()],
        sidecar,
        &NoProgress,
        &CancelToken::new(),
    )
    .expect("scan must not hard-error on hostile-but-present files");
    assert!(
        started.elapsed() < CASE_BUDGET,
        "scan took {:?}, over the {:?} budget — looks like a hang",
        started.elapsed(),
        CASE_BUDGET
    );
    manifest
}

// ---- Truncated mid-atom MP4 -----------------------------------------------------------

#[test]
fn truncated_mp4_lands_in_a_defined_bucket_not_a_panic_or_hang() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("truncated-mp4");
    let path = dir.join("crashed-recorder.mp4");
    hostile::write_truncated_mp4(&path, 1, 3.0, 0.4, &sidecar.ffmpeg).expect("mux+truncate");
    assert!(
        std::fs::metadata(&path).unwrap().len() > 0,
        "cut must leave *some* bytes"
    );

    let manifest = scan_within_budget(&dir, &sidecar);
    // Either bucket is an acceptable, defined outcome — a moov-atom-missing MP4 usually
    // fails probe outright (decode_error), but ffmpeg's demuxer is tolerant enough that a
    // partial decode succeeding with no usable audio (no_audio) is not a bug either.
    // What must never happen: the file vanishing from both `files` and `unsynced` (§7.3),
    // or ending up somewhere neither list can express.
    let in_files = manifest.files.iter().any(|f| f.file == path);
    let in_unsynced = manifest.unsynced.iter().any(|u| u.file == path);
    assert!(
        in_files ^ in_unsynced,
        "truncated MP4 must land in exactly one bucket, got files={in_files} unsynced={in_unsynced}"
    );
}

// ---- Zero-length / empty stream file ---------------------------------------------------

#[test]
fn empty_file_is_refused_not_hung() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("empty-file");
    let path = dir.join("zero.mp4");
    hostile::write_empty(&path).unwrap();

    let manifest = scan_within_budget(&dir, &sidecar);
    assert!(
        manifest.files.is_empty(),
        "an empty file cannot carry audio"
    );
    let reason = manifest
        .unsynced
        .iter()
        .find(|u| u.file == path)
        .map(|u| u.reason);
    assert_eq!(
        reason,
        Some(sundaysync_core::UnsyncedReason::DecodeError),
        "an empty file must be a decode failure, not silently dropped"
    );
}

// ---- WAV header claiming far more than it holds ----------------------------------------

#[test]
fn wav_with_a_lying_header_is_bounded_and_lands_in_a_defined_bucket() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("lying-header");
    let path = dir.join("lying.wav");
    // 2 s of real audio, header claims 8 hours — §7.7's own example case.
    hostile::write_wav_lying_header(&path, 2, 2.0, 8.0 * 3600.0, 48_000).unwrap();

    let manifest = scan_within_budget(&dir, &sidecar);
    // A defined outcome either way: ffprobe/ffmpeg may honestly report the short real
    // duration and let it through as syncable audio, or refuse it — the property under
    // test is that this returns promptly and lands in exactly one bucket, not which one.
    let in_files = manifest.files.iter().any(|f| f.file == path);
    let in_unsynced = manifest.unsynced.iter().any(|u| u.file == path);
    assert!(in_files ^ in_unsynced, "must land in exactly one bucket");

    // If it was accepted as syncable, extraction must also complete within budget and
    // never claim to have produced 8 hours of audio from 2 real seconds.
    if in_files {
        let extractor = Extractor::new(sidecar, Cache::new(dir.join("cache")));
        let started = Instant::now();
        let out = extractor
            .extract_all(
                std::slice::from_ref(&path),
                &NoProgress,
                &CancelToken::new(),
            )
            .unwrap();
        assert!(
            started.elapsed() < CASE_BUDGET,
            "extraction hung on a lying header"
        );
        if let Ok(cached) = &out[0] {
            assert!(
                cached.duration_seconds() < 60.0,
                "extracted {}s from a 2s-real/8h-claimed file — the lie leaked through",
                cached.duration_seconds()
            );
        }
    }
}

// ---- Wrong-extension files: content wins, never the name --------------------------------

#[test]
fn wav_bytes_named_mp4_are_identified_by_content() {
    // §4.1: nothing is rejected by extension. A WAV mislabelled as a video container must
    // still be probed honestly and land in the syncable bucket.
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("wav-as-mp4");
    let path = dir.join("really-a-wav.mp4");
    hostile::write_wav_at_any_extension(&path, 3, 1.5, 48_000).unwrap();

    let manifest = scan_within_budget(&dir, &sidecar);
    assert!(
        manifest.files.iter().any(|f| f.file == path),
        "real WAV bytes must be accepted regardless of the .mp4 extension"
    );
}

#[test]
fn mp4_bytes_named_wav_are_identified_by_content() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("mp4-as-wav");
    let path = dir.join("really-a-video.wav");
    hostile::write_mp4_at_any_extension(&path, 4, 1.0, &sidecar.ffmpeg).unwrap();

    let manifest = scan_within_budget(&dir, &sidecar);
    // Either it is accepted as syncable (it does carry a real AAC audio stream) or it is
    // refused with a defined reason — what would be a bug is silent extension-based
    // filtering, which would show up as the file simply never being probed at all. Both
    // buckets prove that did not happen.
    let in_files = manifest.files.iter().any(|f| f.file == path);
    let in_unsynced = manifest.unsynced.iter().any(|u| u.file == path);
    assert!(in_files ^ in_unsynced, "must land in exactly one bucket");
}

// ---- Exotic sample rates ----------------------------------------------------------------

#[test]
fn exotic_sample_rates_extract_cleanly() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("exotic-rates");
    let mut paths = Vec::new();
    for (name, rate) in [
        ("r8k.wav", 8_000u32),
        ("r96k.wav", 96_000),
        ("r192k.wav", 192_000),
    ] {
        let path = dir.join(name);
        let audio = signal::generate_master(&mut sundaysync_fixturegen::Rng::new(5), 1.0, rate);
        wav::write_mono(&path, &audio, rate).unwrap();
        paths.push(path);
    }

    let manifest = scan_within_budget(&dir, &sidecar);
    assert_eq!(
        manifest.files.len(),
        paths.len(),
        "every exotic sample rate must probe as syncable audio"
    );

    let extractor = Extractor::new(sidecar, Cache::new(dir.join("cache")));
    let started = Instant::now();
    let out = extractor
        .extract_all(&paths, &NoProgress, &CancelToken::new())
        .unwrap();
    assert!(
        started.elapsed() < CASE_BUDGET,
        "extraction of exotic rates hung"
    );
    for (path, result) in paths.iter().zip(out.iter()) {
        assert!(
            result.is_ok(),
            "{} failed to extract: {:?}",
            path.display(),
            result.as_ref().err()
        );
        let cached = result.as_ref().unwrap();
        assert!(
            (cached.duration_seconds() - 1.0).abs() < 0.1,
            "{}: expected ~1s, got {}s",
            path.display(),
            cached.duration_seconds()
        );
    }
}

// ---- Exotic channel layouts --------------------------------------------------------------

#[test]
fn exotic_channel_layouts_extract_cleanly() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("exotic-channels");
    let mut paths = Vec::new();
    // Mono is the suite's default everywhere else; this covers 5.1 and 7.1.
    for (name, channels) in [
        ("mono.wav", 1u16),
        ("surround51.wav", 6),
        ("surround71.wav", 8),
    ] {
        let path = dir.join(name);
        hostile::write_multichannel_wav(&path, 6, 1.0, 48_000, channels).unwrap();
        paths.push(path);
    }

    let manifest = scan_within_budget(&dir, &sidecar);
    assert_eq!(
        manifest.files.len(),
        paths.len(),
        "every channel layout must probe as syncable audio"
    );

    let extractor = Extractor::new(sidecar, Cache::new(dir.join("cache")));
    let started = Instant::now();
    let out = extractor
        .extract_all(&paths, &NoProgress, &CancelToken::new())
        .unwrap();
    assert!(
        started.elapsed() < CASE_BUDGET,
        "extraction of exotic channel layouts hung"
    );
    for (path, result) in paths.iter().zip(out.iter()) {
        assert!(
            result.is_ok(),
            "{} failed to extract: {:?}",
            path.display(),
            result.as_ref().err()
        );
        // §4.2: extraction downmixes to mono regardless of the source's channel count.
        let audio = result.as_ref().unwrap().load().unwrap();
        assert!(
            audio.samples().iter().any(|s| s.abs() > 0.01),
            "{}: downmixed audio must not be silent",
            path.display()
        );
    }
}

// ---- Garbage bytes at a media extension (reuses the committed hostile corpus) ------------

#[test]
fn garbage_bytes_are_a_decode_error_not_a_panic() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("garbage");
    let path = dir.join("noise.mp4");
    hostile::write_garbage(&path, 9, 4096).unwrap();

    let manifest = scan_within_budget(&dir, &sidecar);
    assert!(manifest.files.is_empty());
    assert_eq!(
        manifest.unsynced.first().map(|u| u.reason),
        Some(sundaysync_core::UnsyncedReason::DecodeError)
    );
}

// ---- The whole battery, mixed into one real shoot ----------------------------------------

/// The capstone: every case above, dropped alongside a genuinely syncable shoot, run
/// through the real top-level `sync()` in one pass — proving the pipeline as a whole
/// tolerates a folder that mixes good media with every hostile case here, not just that
/// each case is individually survivable in isolation.
#[test]
fn the_full_battery_runs_alongside_a_real_shoot_without_panicking_or_hanging() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dir = scratch("full-battery");

    // A real, genuinely syncable shoot, so the run has something legitimate to place —
    // proving hostile files alongside good ones don't derail the good ones either.
    let spec = shoot::quick_suite(21);
    let shoot_dir = shoot::suite_dir(&dir, &spec.name, 21);
    let truth = shoot::emit(&spec, &shoot_dir, &sidecar.ffmpeg).expect("emit real shoot");

    // Every adversarial case, dropped into the same directory.
    hostile::write_empty(&shoot_dir.join("h-empty.mp4")).unwrap();
    hostile::write_garbage(&shoot_dir.join("h-garbage.mov"), 1, 2048).unwrap();
    hostile::write_wav_lying_header(&shoot_dir.join("h-lying.wav"), 2, 1.0, 3600.0, 48_000)
        .unwrap();
    hostile::write_wav_at_any_extension(&shoot_dir.join("h-wav-as-mp4.mp4"), 3, 1.0, 48_000)
        .unwrap();
    hostile::write_multichannel_wav(&shoot_dir.join("h-surround.wav"), 4, 1.0, 48_000, 6).unwrap();
    hostile::write_truncated_mp4(
        &shoot_dir.join("h-truncated.mp4"),
        5,
        2.0,
        0.5,
        &sidecar.ffmpeg,
    )
    .expect("mux+truncate");

    let request = SyncRequest {
        cache_dir: Some(shoot_dir.join("cache")),
        ..SyncRequest::new(vec![shoot_dir.clone()])
    };

    let started = Instant::now();
    let result = sundaysync_core::sync(&request, &NoProgress, &CancelToken::new())
        .expect("a folder full of hostile-but-honest files must not abort the whole run");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(5 * 60),
        "the full battery took {elapsed:?} — looks like something hung"
    );

    // §7.3: every file in the directory — real media, `truth.json`, and every hostile
    // fixture — is accounted for exactly once.
    let mut inputs: Vec<PathBuf> = std::fs::read_dir(&shoot_dir)
        .unwrap()
        .filter_map(std::result::Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && !p.starts_with(shoot_dir.join("cache")))
        .collect();
    inputs.sort();
    assert!(
        result.accounts_for(&inputs),
        "a file was lost or double-reported with hostile media in the mix"
    );

    // None of the hostile files correlate with the real event, so none may be placed.
    let placed_names: Vec<String> = result
        .placements
        .iter()
        .map(|p| p.file.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    for hostile_name in [
        "h-empty.mp4",
        "h-garbage.mov",
        "h-lying.wav",
        "h-wav-as-mp4.mp4",
        "h-surround.wav",
        "h-truncated.mp4",
    ] {
        assert!(
            !placed_names.iter().any(|n| n == hostile_name),
            "{hostile_name} has no relationship to the real event and must never be placed"
        );
    }

    // And the real shoot's genuine clips still placed correctly — hostile neighbours must
    // not derail them.
    for clip in truth.clips.iter().filter(|c| !c.uncorrelated) {
        assert!(
            placed_names.contains(&clip.file),
            "{} should still have placed with hostile files in the same folder",
            clip.file
        );
    }
}
