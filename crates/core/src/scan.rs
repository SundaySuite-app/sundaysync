//! Scan and inventory — docs/PLAN.md §4.1 + §4.5.
//!
//! Walks the inputs, probes everything, sorts each file into "syncable" or "unsynced
//! with a reason", and groups the syncable ones into devices. This is the whole of
//! Phase 1, and the manifest it produces is what the `scan` CLI command prints.

use crate::device;
use crate::error::{Error, Result};
use crate::probe::{self, AudioStream, Probed, VideoStream};
use crate::progress::{CancelToken, Progress, ProgressSink, Stage};
use crate::result::{Device, Unsynced, UnsyncedReason, SCHEMA_VERSION};
use crate::sidecar::Sidecar;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Guards against a pathological directory tree. Card dumps nest a few levels
/// (`PRIVATE/M4ROOT/CLIP`); nothing legitimate goes deeper than this.
const MAX_DEPTH: usize = 32;

/// The output of a scan: what we found, and what we could not use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScanManifest {
    pub schema: u32,
    pub devices: Vec<Device>,
    /// Files that probed cleanly and carry audio — everything that can be synced.
    pub files: Vec<FileEntry>,
    /// Files that cannot be synced, each with a §5 reason. Reuses the `SyncResult` type
    /// so the reasons the UI must render are identical in both outputs.
    pub unsynced: Vec<Unsynced>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileEntry {
    pub file: PathBuf,
    pub device: String,
    pub duration_seconds: f64,
    pub format_name: String,
    pub audio: Option<AudioStream>,
    pub video: Option<VideoStream>,
    pub creation_time: Option<String>,
}

/// Probes every input and builds the inventory.
///
/// Returns [`Error::NoInput`] only when nothing at all was given. A run where every
/// single file is unreadable still succeeds, with all of them in `unsynced` — that is a
/// result the user needs to see, not an error (§7.5).
pub fn scan(
    inputs: &[PathBuf],
    sidecar: &Sidecar,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
) -> Result<ScanManifest> {
    if inputs.is_empty() {
        return Err(Error::NoInput);
    }

    progress.report(Progress {
        stage: Stage::Scanning,
        completed: 0,
        total: inputs.len(),
    });

    let (candidates, missing) = collect(inputs, cancel)?;

    let mut probed: Vec<Probed> = Vec::new();
    let mut unsynced: Vec<Unsynced> = missing;

    let total = candidates.len();
    for (i, path) in candidates.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        progress.report(Progress {
            stage: Stage::Probing,
            completed: i,
            total,
        });

        match probe::probe(sidecar, path) {
            // §4.1: no audio stream means nothing to correlate on.
            Ok(p) if !p.has_audio() => unsynced.push(Unsynced {
                file: path.clone(),
                reason: UnsyncedReason::NoAudio,
            }),
            Ok(p) => probed.push(p),
            Err(_) => unsynced.push(Unsynced {
                file: path.clone(),
                reason: UnsyncedReason::DecodeError,
            }),
        }
    }
    progress.report(Progress {
        stage: Stage::Probing,
        completed: total,
        total,
    });

    // Only syncable files get devices: a file with no audio can never be placed, so
    // giving it a lane in the UI would promise something the engine cannot deliver.
    //
    // The directory subset is computed here, where the filesystem is being read anyway,
    // and handed to `group` as data — see the note on `device::group`.
    let dropped_dirs: Vec<PathBuf> = inputs.iter().filter(|p| p.is_dir()).cloned().collect();
    let devices = device::group(&probed, &dropped_dirs);

    let mut files: Vec<FileEntry> = probed
        .into_iter()
        .map(|p| {
            let device = devices
                .iter()
                .find(|d| d.files.contains(&p.path))
                .map_or_else(String::new, |d| d.id.clone());
            FileEntry {
                device,
                file: p.path,
                duration_seconds: p.duration_seconds,
                format_name: p.format_name,
                creation_time: p.tags.get("creation_time").cloned(),
                audio: p.audio,
                video: p.video,
            }
        })
        .collect();

    files.sort_by(|a, b| a.file.cmp(&b.file));
    unsynced.sort_by(|a, b| a.file.cmp(&b.file));

    Ok(ScanManifest {
        schema: SCHEMA_VERSION,
        devices,
        files,
        unsynced,
    })
}

/// Expands the inputs into a deduplicated, sorted candidate list.
///
/// Returns the candidates plus `unsynced` entries for inputs that do not exist at all —
/// a mistyped path must be visible in the output rather than silently dropped, or §7.3's
/// "every input is accounted for" would quietly not hold.
fn collect(inputs: &[PathBuf], cancel: &CancelToken) -> Result<(Vec<PathBuf>, Vec<Unsynced>)> {
    let mut files = Vec::new();
    let mut missing = Vec::new();

    for input in inputs {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if input.is_dir() {
            walk(input, 0, &mut files, cancel)?;
        } else if input.is_file() {
            files.push(input.clone());
        } else {
            missing.push(Unsynced {
                file: input.clone(),
                reason: UnsyncedReason::DecodeError,
            });
        }
    }

    // Sorting before dedup gives a total order independent of directory iteration
    // order, which is not stable across filesystems (§3). Dedup catches a user who
    // dropped both a folder and a file inside it.
    files.sort();
    files.dedup();
    Ok((files, missing))
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>, cancel: &CancelToken) -> Result<()> {
    if depth >= MAX_DEPTH {
        return Ok(());
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    // An unreadable directory is skipped rather than fatal: one permission-denied
    // subfolder must not abort a scan of an otherwise fine card (§7.2).
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if is_hidden(&path) {
            continue;
        }
        // `symlink_metadata` does not follow links, so a symlink loop cannot trap the
        // walk. Linked-in media is rare enough that ignoring links is the safe default.
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk(&path, depth + 1, out, cancel)?;
        } else if meta.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

/// Skips dotfiles.
///
/// This is not extension filtering — §4.1 forbids that, and it is right to: renamed and
/// oddly-suffixed media is routine. This drops *hidden OS metadata*: `.DS_Store` and the
/// AppleDouble `._C0001.MP4` companions macOS scatters over every camera card. Probing
/// them would fill the unsynced list with noise that looks like real failures.
fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::NoProgress;
    use std::fs;

    /// A minimal valid PCM WAV, written by hand so fixture creation needs no ffmpeg.
    /// Only *reading* needs ffprobe, which keeps the skip surface as small as possible.
    fn write_wav(path: &Path, seconds: f64) {
        let rate = 8000u32;
        let samples = (rate as f64 * seconds) as u32;
        let data_len = samples * 2;
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data_len).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes()); // PCM
        w.extend_from_slice(&1u16.to_le_bytes()); // mono
        w.extend_from_slice(&rate.to_le_bytes());
        w.extend_from_slice(&(rate * 2).to_le_bytes());
        w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..samples {
            // A quiet ramp — non-silent, so nothing downstream can dismiss it as empty.
            let v = ((i % 256) as i16 - 128) * 64;
            w.extend_from_slice(&v.to_le_bytes());
        }
        fs::write(path, w).unwrap();
    }

    /// Scratch directory — no `tempfile` dependency needed, and the contents survive a
    /// failure for inspection. Cleared on entry rather than on exit so a failing test
    /// leaves its fixtures behind.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("sundaysync-tests").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Phase 1 tests need a real ffprobe. On ubuntu CI it is installed and
    /// `SUNDAYSYNC_REQUIRE_FFMPEG=1` turns a skip into a failure, so the skip path can
    /// never silently hide a regression on the platform that runs the full gate.
    /// See docs/DECISIONS.md D-005.
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

    #[test]
    fn empty_input_is_an_error() {
        let r = scan(&[], &Sidecar::default(), &NoProgress, &CancelToken::new());
        assert!(matches!(r, Err(Error::NoInput)));
    }

    #[test]
    fn hidden_os_metadata_is_skipped() {
        let dir = scratch("hidden");
        fs::write(dir.join(".DS_Store"), b"junk").unwrap();
        fs::write(dir.join("._C0001.MP4"), b"appledouble").unwrap();
        fs::write(dir.join("real.bin"), b"x").unwrap();
        let (found, _) = collect(&[dir], &CancelToken::new()).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("real.bin"));
    }

    #[test]
    fn a_nonexistent_input_is_reported_not_dropped() {
        let (found, missing) =
            collect(&[PathBuf::from("/no/such/file.mp4")], &CancelToken::new()).unwrap();
        assert!(found.is_empty());
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].reason, UnsyncedReason::DecodeError);
    }

    #[test]
    fn a_folder_and_a_file_inside_it_are_not_counted_twice() {
        let dir = scratch("dedup");
        let file = dir.join("a.bin");
        fs::write(&file, b"x").unwrap();
        let (found, _) = collect(&[dir.clone(), file], &CancelToken::new()).unwrap();
        assert_eq!(found.len(), 1);
    }

    /// Encodes a real silent-video, no-audio MP4. Needs ffmpeg itself, not just
    /// ffprobe — there is no way to hand-write one the way `write_wav` does.
    fn write_video_only(sidecar: &Sidecar, path: &Path) -> bool {
        crate::sidecar::run(
            &sidecar.ffmpeg,
            [
                "-v".as_ref(),
                "error".as_ref(),
                "-f".as_ref(),
                "lavfi".as_ref(),
                "-i".as_ref(),
                "testsrc=size=64x64:rate=25:duration=1".as_ref(),
                "-c:v".as_ref(),
                "libx264".as_ref(),
                "-pix_fmt".as_ref(),
                "yuv420p".as_ref(),
                "-an".as_ref(),
                "-y".as_ref(),
                path.as_os_str(),
            ],
            std::time::Duration::from_secs(60),
        )
        .is_ok()
    }

    #[test]
    fn broken_and_audioless_files_land_in_the_right_buckets() {
        // The Phase 1 acceptance criterion (§11), against real files rather than
        // synthesised ffprobe JSON.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("buckets");
        fs::write(dir.join("zero.mp4"), b"").unwrap();
        fs::write(dir.join("corrupt.mp4"), vec![0xABu8; 4096]).unwrap();
        write_wav(&dir.join("good.wav"), 1.0);
        let silent = dir.join("videoonly.mp4");
        let have_video = write_video_only(&sidecar, &silent);

        let m = scan(&[dir], &sidecar, &NoProgress, &CancelToken::new()).unwrap();

        assert_eq!(m.files.len(), 1, "only the wav is syncable");
        assert!(m.files[0].file.ends_with("good.wav"));

        let reason_for = |name: &str| {
            m.unsynced
                .iter()
                .find(|u| u.file.ends_with(name))
                .map(|u| u.reason)
        };
        assert_eq!(reason_for("zero.mp4"), Some(UnsyncedReason::DecodeError));
        assert_eq!(reason_for("corrupt.mp4"), Some(UnsyncedReason::DecodeError));

        if have_video {
            // A file that decodes perfectly but has nothing to correlate on is a
            // different failure from a broken one, and the UI must say so (§4.1).
            assert_eq!(
                reason_for("videoonly.mp4"),
                Some(UnsyncedReason::NoAudio),
                "a video-only file must be no_audio, not decode_error"
            );
        } else {
            eprintln!("SKIP: could not encode the video-only fixture (no libx264?)");
        }
    }

    #[test]
    fn every_input_is_accounted_for_exactly_once() {
        // §7.3, at the scan level.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("accounting");
        write_wav(&dir.join("ZOOM0001.WAV"), 1.0);
        write_wav(&dir.join("ZOOM0002.WAV"), 1.0);
        fs::write(dir.join("broken.mp4"), vec![0u8; 128]).unwrap();

        let m = scan(&[dir], &sidecar, &NoProgress, &CancelToken::new()).unwrap();
        assert_eq!(m.files.len() + m.unsynced.len(), 3);

        let mut seen: Vec<&PathBuf> = m
            .files
            .iter()
            .map(|f| &f.file)
            .chain(m.unsynced.iter().map(|u| &u.file))
            .collect();
        let before = seen.len();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), before, "a file appeared in both buckets");
    }

    #[test]
    fn scanning_the_same_tree_twice_gives_identical_output() {
        // §13.4 determinism, now against real filesystem iteration order.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("determinism");
        for n in 1..=4 {
            write_wav(&dir.join(format!("C000{n}.WAV")), 0.5);
        }
        let inputs = std::slice::from_ref(&dir);
        let a = scan(inputs, &sidecar, &NoProgress, &CancelToken::new()).unwrap();
        let b = scan(inputs, &sidecar, &NoProgress, &CancelToken::new()).unwrap();
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
    }

    #[test]
    fn real_files_group_into_devices() {
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("grouping");
        write_wav(&dir.join("C0001.WAV"), 0.5);
        write_wav(&dir.join("C0002.WAV"), 0.5);
        write_wav(&dir.join("ZOOM0001.WAV"), 0.5);

        let m = scan(&[dir], &sidecar, &NoProgress, &CancelToken::new()).unwrap();
        assert_eq!(m.devices.len(), 2);
        assert!(m.files.iter().all(|f| !f.device.is_empty()));
        let zoom = m.devices.iter().find(|d| d.id == "name-zoom").unwrap();
        assert_eq!(zoom.files.len(), 1);
    }

    #[test]
    fn cancellation_stops_the_scan() {
        let dir = scratch("cancel");
        write_wav(&dir.join("a.wav"), 0.2);
        let cancel = CancelToken::new();
        cancel.cancel();
        let r = scan(&[dir], &Sidecar::default(), &NoProgress, &cancel);
        assert!(matches!(r, Err(Error::Cancelled)));
    }
}
