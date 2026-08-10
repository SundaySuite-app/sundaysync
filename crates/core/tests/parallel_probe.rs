//! P-2 parallel probing, at the public `scan` boundary.
//!
//! The authoritative serial-vs-parallel byte-equality proof lives inside `scan.rs` (it
//! needs the private worker seam). This companion checks the property that ships: the
//! parallel probe stage that `scan()` now runs is deterministic under real thread
//! scheduling — two scans of the same multi-file shoot are byte-identical — and every
//! input is still accounted for exactly once when good and bad files are mixed.

// Integration tests are their own crate, so clippy.toml's allow-unwrap-in-tests does not
// reach here; the engine's §7.1 ban is for production paths, not this harness.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use sundaysync_core::{scan, CancelToken, NoProgress, Sidecar};

/// The D-005 skip guard: no ffprobe, no probe suite. On the ubuntu gate
/// `SUNDAYSYNC_REQUIRE_FFMPEG=1` turns a skip into a failure so it can never silently rot.
fn require_ffprobe() -> Option<Sidecar> {
    match Sidecar::from_path() {
        Ok(s) => Some(s),
        Err(e) => {
            assert!(
                std::env::var("SUNDAYSYNC_REQUIRE_FFMPEG").is_err(),
                "ffmpeg is required in this environment but was not found: {e}"
            );
            eprintln!("SKIP: ffprobe unavailable ({e})");
            None
        }
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join("sundaysync-tests")
        .join("parallel-probe-it")
        // Per-process (V05-W5): see `stability.rs`'s `scratch` for why the pid is here.
        .join(format!("pid-{}", std::process::id()))
        .join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A hand-written PCM WAV, so making fixtures needs no ffmpeg (only reading them does).
fn write_wav(path: &Path, seconds: f64) {
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
        let v = ((i % 256) as i16 - 128) * 64;
        w.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, w).unwrap();
}

#[test]
fn a_parallel_scan_is_deterministic_and_accounts_for_every_file() {
    let Some(sidecar) = require_ffprobe() else {
        return;
    };
    let dir = scratch("mixed-shoot");
    // Enough clips that several probe workers genuinely overlap, plus files that must land
    // in `unsynced`, so both fold branches run under the parallel path.
    for n in 0..12 {
        write_wav(&dir.join(format!("C{n:04}.WAV")), 0.4);
    }
    std::fs::write(dir.join("broken.mp4"), vec![0u8; 512]).unwrap();
    std::fs::write(dir.join("empty.mp4"), b"").unwrap();

    let inputs = std::slice::from_ref(&dir);
    let a = scan(inputs, &sidecar, &NoProgress, &CancelToken::new()).unwrap();
    let b = scan(inputs, &sidecar, &NoProgress, &CancelToken::new()).unwrap();

    assert_eq!(
        serde_json::to_string(&a).unwrap(),
        serde_json::to_string(&b).unwrap(),
        "two parallel scans of one tree must be byte-identical"
    );
    assert_eq!(a.files.len(), 12, "all syncable clips probed");

    // §7.3: every input file lands in exactly one bucket.
    let mut seen: Vec<&PathBuf> = a
        .files
        .iter()
        .map(|f| &f.file)
        .chain(a.unsynced.iter().map(|u| &u.file))
        .collect();
    let before = seen.len();
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), before, "no file double-counted");
    assert_eq!(a.files.len() + a.unsynced.len(), 14);
}
