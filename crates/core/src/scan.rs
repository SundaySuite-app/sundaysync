//! Scan and inventory — docs/PLAN.md §4.1 + §4.5.
//!
//! Walks the inputs, probes everything, sorts each file into "syncable" or "unsynced
//! with a reason", and groups the syncable ones into devices. This is the whole of
//! Phase 1, and the manifest it produces is what the `scan` CLI command prints.

use crate::device;
use crate::error::{Error, Result};
use crate::probe::{self, AudioStream, Probed, VideoStream};
use crate::progress::{CancelToken, Progress, ProgressSink, Stage};
use crate::result::{Device, DeviceKind, Unsynced, UnsyncedReason, SCHEMA_VERSION};
use crate::sidecar::Sidecar;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Guards against a pathological directory tree. Card dumps nest a few levels
/// (`PRIVATE/M4ROOT/CLIP`); nothing legitimate goes deeper than this.
const MAX_DEPTH: usize = 32;

/// Total files a single scan will enumerate before it refuses to continue (S-8,
/// docs/DECISIONS.md D-032).
///
/// A real multi-camera church service is dozens of clips; a walk that reaches six figures
/// is a mis-drop — a home directory, a whole disk — not a shoot. Enumerating millions of
/// entries would exhaust memory and blow §7.4's responsiveness budget for a run that could
/// never produce a sensible timeline, so the honest outcome is a loud [`Error::TooManyFiles`]
/// naming the limit rather than a silent truncation that would violate §7.3's "every input
/// is accounted for". 100 000 is deliberately generous — orders of magnitude past any real
/// shoot — so it can only ever fire on an obvious mistake.
const MAX_FILES: usize = 100_000;

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
    scan_detailed(inputs, sidecar, None, progress, cancel).map(|(m, _)| m)
}

/// As [`scan`], but also returns the raw [`Probed`] records.
///
/// The full pipeline needs them for §4.4's reference selection and metadata check, and
/// probing twice would double the ffprobe cost of every run for no benefit.
/// `exclude` is a directory the walk must not descend into — in practice the analysis
/// cache. Without it, pointing the cache inside a folder the user drops in makes the
/// second run scan its own `.f32` entries, fail to probe them, and report the user's
/// cache back to them as broken media. Found by the §13.4 determinism test, which is
/// exactly the sort of bug it exists to catch. See docs/DECISIONS.md D-020.
pub fn scan_detailed(
    inputs: &[PathBuf],
    sidecar: &Sidecar,
    exclude: Option<&Path>,
    progress: &dyn ProgressSink,
    cancel: &CancelToken,
) -> Result<(ScanManifest, Vec<Probed>)> {
    if inputs.is_empty() {
        return Err(Error::NoInput);
    }

    progress.report(Progress {
        stage: Stage::Scanning,
        completed: 0,
        total: inputs.len(),
    });

    let (candidates, missing) = collect(inputs, exclude, cancel)?;

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

        match probe::probe(sidecar, path, cancel) {
            // §4.1: no audio stream means nothing to correlate on.
            Ok(p) if !p.has_audio() => unsynced.push(Unsynced {
                file: path.clone(),
                reason: UnsyncedReason::NoAudio,
            }),
            Ok(p) => probed.push(p),
            // A cancelled probe is not a broken file — reporting it as `decode_error`
            // would slander the user's media for stopping the run.
            Err(probe::ProbeError::Cancelled) => return Err(Error::Cancelled),
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

    let probed_out = probed.clone();

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

    Ok((
        ScanManifest {
            schema: SCHEMA_VERSION,
            devices,
            files,
            unsynced,
        },
        probed_out,
    ))
}

/// §9 advanced re-grouping: moves files between devices in a scanned manifest.
///
/// A pure manifest rewrite — no filesystem access, no re-probe — so the UI can preview
/// the result instantly and the pipeline can apply it deterministically (the map is a
/// `BTreeMap`, and device/file ordering is re-derived by id afterwards).
///
/// Semantics (D-028):
/// - A key matching no scanned file is **ignored**: a stale override left after the user
///   removed an input must not abort a run.
/// - A target id the grouping never produced creates a fresh device. Its label is the
///   id's human part (text after the first `-`), matching how [`crate::device`] builds
///   ids; only reachable from the CLI/JSON side — the UI offers existing ids.
/// - Each touched device's `kind` is recomputed from its members ("any video ⇒ Video",
///   the same rule `device::group` applies), and devices left empty are dropped.
pub fn apply_device_overrides(
    manifest: &mut ScanManifest,
    overrides: &std::collections::BTreeMap<PathBuf, String>,
) {
    if overrides.is_empty() {
        return;
    }

    for (file, target_id) in overrides {
        // Only files the scan actually produced can move.
        let Some(entry) = manifest.files.iter_mut().find(|f| &f.file == file) else {
            continue;
        };
        if &entry.device == target_id {
            continue;
        }

        // Detach from the old device.
        if let Some(old) = manifest.devices.iter_mut().find(|d| d.id == entry.device) {
            old.files.retain(|f| f != file);
        }

        // Attach to the target, creating it if the id is new.
        if let Some(target) = manifest.devices.iter_mut().find(|d| &d.id == target_id) {
            target.files.push(file.clone());
        } else {
            let label = target_id
                .split_once('-')
                .map_or_else(|| target_id.clone(), |(_, rest)| rest.to_string());
            manifest.devices.push(Device {
                id: target_id.clone(),
                label,
                kind: DeviceKind::Audio, // recomputed below
                files: vec![file.clone()],
            });
        }
        entry.device = target_id.clone();
    }

    // Recompute kinds from membership, drop empties, restore the §5 orderings.
    let has_video = |device: &Device| {
        device.files.iter().any(|f| {
            manifest
                .files
                .iter()
                .find(|e| &e.file == f)
                .is_some_and(|e| e.video.is_some())
        })
    };
    let kinds: Vec<DeviceKind> = manifest
        .devices
        .iter()
        .map(|d| {
            if has_video(d) {
                DeviceKind::Video
            } else {
                DeviceKind::Audio
            }
        })
        .collect();
    for (device, kind) in manifest.devices.iter_mut().zip(kinds) {
        device.kind = kind;
    }
    manifest.devices.retain(|d| !d.files.is_empty());
    manifest.devices.sort_by(|a, b| a.id.cmp(&b.id));
    for device in &mut manifest.devices {
        device.files.sort();
    }
}

/// Expands the inputs into a deduplicated, sorted candidate list.
///
/// Returns the candidates plus `unsynced` entries for inputs that do not exist at all —
/// a mistyped path must be visible in the output rather than silently dropped, or §7.3's
/// "every input is accounted for" would quietly not hold.
fn collect(
    inputs: &[PathBuf],
    exclude: Option<&Path>,
    cancel: &CancelToken,
) -> Result<(Vec<PathBuf>, Vec<Unsynced>)> {
    let mut files = Vec::new();
    let mut missing = Vec::new();

    for input in inputs {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if input.is_dir() {
            walk(input, 0, exclude, &mut files, cancel)?;
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

fn walk(
    dir: &Path,
    depth: usize,
    exclude: Option<&Path>,
    out: &mut Vec<PathBuf>,
    cancel: &CancelToken,
) -> Result<()> {
    walk_capped(dir, depth, exclude, out, cancel, MAX_FILES)
}

/// The real walk, with the file ceiling as a parameter so a test can drive the S-8 limit
/// without materialising 100 000 files. Production always calls it with [`MAX_FILES`].
fn walk_capped(
    dir: &Path,
    depth: usize,
    exclude: Option<&Path>,
    out: &mut Vec<PathBuf>,
    cancel: &CancelToken,
    max_files: usize,
) -> Result<()> {
    if exclude.is_some_and(|e| dir == e) {
        return Ok(());
    }
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
        // S-8: check cancel *inside* the entry loop, not only per-directory. A single
        // directory holding millions of entries would otherwise run to completion before
        // the per-directory check above could fire again, leaving Cancel dead for the
        // whole drain (§7.4). A wedged network-mount `read_dir`/`metadata` syscall is
        // still uninterruptible — that is inherent to std::fs and documented here, not
        // fixed: only the syscall returning can unblock this loop.
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        // S-8: refuse a pathological width/total rather than enumerating unboundedly.
        // Checked before the push so `out` never exceeds the ceiling.
        if out.len() >= max_files {
            return Err(Error::TooManyFiles { limit: max_files });
        }
        let path = entry.path();
        if is_hidden(&path) {
            continue;
        }
        // `symlink_metadata` does not follow links, so a symlink loop cannot trap the
        // walk. Linked-in media is rare enough that ignoring links is the safe default.
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk_capped(&path, depth + 1, exclude, out, cancel, max_files)?;
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
        let (found, _) = collect(&[dir], None, &CancelToken::new()).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("real.bin"));
    }

    #[test]
    fn a_nonexistent_input_is_reported_not_dropped() {
        let (found, missing) = collect(
            &[PathBuf::from("/no/such/file.mp4")],
            None,
            &CancelToken::new(),
        )
        .unwrap();
        assert!(found.is_empty());
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].reason, UnsyncedReason::DecodeError);
    }

    #[test]
    fn a_folder_and_a_file_inside_it_are_not_counted_twice() {
        let dir = scratch("dedup");
        let file = dir.join("a.bin");
        fs::write(&file, b"x").unwrap();
        let (found, _) = collect(&[dir.clone(), file], None, &CancelToken::new()).unwrap();
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
            &CancelToken::new(),
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

    fn manifest_for_overrides() -> ScanManifest {
        use crate::probe::{AudioStream, VideoStream};
        use crate::rational::Rational;
        let video = |path: &str| FileEntry {
            file: PathBuf::from(path),
            device: String::new(),
            duration_seconds: 60.0,
            format_name: "mov,mp4".into(),
            audio: Some(AudioStream {
                codec: "aac".into(),
                sample_rate: 48_000,
                channels: 2,
            }),
            video: Some(VideoStream {
                codec: "h264".into(),
                width: 1920,
                height: 1080,
                fps: Rational::new(25, 1),
            }),
            creation_time: None,
        };
        let audio = |path: &str| FileEntry {
            video: None,
            audio: Some(AudioStream {
                codec: "pcm_s16le".into(),
                sample_rate: 48_000,
                channels: 1,
            }),
            ..video(path)
        };
        let mut a = video("/x/C0001.MP4");
        a.device = "cam-a".into();
        let mut b = video("/x/C0002.MP4");
        b.device = "cam-a".into();
        let mut z = audio("/x/ZOOM0001.WAV");
        z.device = "rec".into();
        ScanManifest {
            schema: SCHEMA_VERSION,
            devices: vec![
                Device {
                    id: "cam-a".into(),
                    label: "A".into(),
                    kind: DeviceKind::Video,
                    files: vec![PathBuf::from("/x/C0001.MP4"), PathBuf::from("/x/C0002.MP4")],
                },
                Device {
                    id: "rec".into(),
                    label: "Zoom".into(),
                    kind: DeviceKind::Audio,
                    files: vec![PathBuf::from("/x/ZOOM0001.WAV")],
                },
            ],
            files: vec![a, b, z],
            unsynced: vec![],
        }
    }

    #[test]
    fn overrides_move_files_and_recompute_kind() {
        let mut m = manifest_for_overrides();
        let mut ov = std::collections::BTreeMap::new();
        // Move a VIDEO file into the audio-only recorder device: the device must flip
        // to Video ("any video ⇒ Video"), and cam-a keeps its other clip.
        ov.insert(PathBuf::from("/x/C0002.MP4"), "rec".to_string());
        apply_device_overrides(&mut m, &ov);

        let rec = m.devices.iter().find(|d| d.id == "rec").unwrap();
        assert_eq!(rec.files.len(), 2);
        assert_eq!(rec.kind, DeviceKind::Video, "video member flips the kind");
        let cam = m.devices.iter().find(|d| d.id == "cam-a").unwrap();
        assert_eq!(cam.files, vec![PathBuf::from("/x/C0001.MP4")]);
        let entry = m
            .files
            .iter()
            .find(|f| f.file.ends_with("C0002.MP4"))
            .unwrap();
        assert_eq!(entry.device, "rec");
    }

    #[test]
    fn overrides_drop_emptied_devices_and_create_new_ones() {
        let mut m = manifest_for_overrides();
        let mut ov = std::collections::BTreeMap::new();
        ov.insert(
            PathBuf::from("/x/ZOOM0001.WAV"),
            "folder-balkong".to_string(),
        );
        apply_device_overrides(&mut m, &ov);

        assert!(
            !m.devices.iter().any(|d| d.id == "rec"),
            "emptied device dropped"
        );
        let created = m.devices.iter().find(|d| d.id == "folder-balkong").unwrap();
        assert_eq!(created.label, "balkong", "label is the id's human part");
        assert_eq!(created.kind, DeviceKind::Audio);
    }

    #[test]
    fn stale_and_noop_overrides_are_ignored() {
        let mut m = manifest_for_overrides();
        let before = m.clone();
        let mut ov = std::collections::BTreeMap::new();
        ov.insert(PathBuf::from("/gone/removed.mp4"), "rec".to_string()); // stale key
        ov.insert(PathBuf::from("/x/C0001.MP4"), "cam-a".to_string()); // already there
        apply_device_overrides(&mut m, &ov);
        assert_eq!(m, before, "stale and no-op overrides must change nothing");

        // And the empty map is the untouched fast path.
        apply_device_overrides(&mut m, &std::collections::BTreeMap::new());
        assert_eq!(m, before);
    }

    #[test]
    fn overrides_are_deterministic_and_keep_the_orderings() {
        let mut a = manifest_for_overrides();
        let mut b = manifest_for_overrides();
        let mut ov = std::collections::BTreeMap::new();
        ov.insert(PathBuf::from("/x/C0001.MP4"), "rec".to_string());
        ov.insert(PathBuf::from("/x/C0002.MP4"), "rec".to_string());
        apply_device_overrides(&mut a, &ov);
        apply_device_overrides(&mut b, &ov);
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
        assert!(
            a.devices.windows(2).all(|w| w[0].id < w[1].id),
            "sorted by id"
        );
    }

    #[test]
    fn scan_manifest_serde_spelling_is_stable() {
        // The TS mirror in app/src/types.ts is hand-written against these names; this
        // assertion is what keeps the two from drifting (same pattern as result.rs).
        let m = manifest_for_overrides();
        let json = serde_json::to_value(&m).unwrap();
        let entry = &json["files"][0];
        for key in [
            "file",
            "device",
            "duration_seconds",
            "format_name",
            "audio",
            "video",
            "creation_time",
        ] {
            assert!(entry.get(key).is_some(), "missing key {key}");
        }
        assert!(entry["audio"].get("sample_rate").is_some());
        assert!(entry["video"].get("fps").is_some());
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

    #[test]
    fn the_file_ceiling_triggers_and_names_the_limit() {
        // S-8: a directory wider than the ceiling is refused loudly, not truncated. Driven
        // through `walk_capped` with a tiny limit so the test need not create 100 000
        // files — production wires the same code to MAX_FILES.
        let dir = scratch("scan-ceiling");
        for n in 0..25 {
            fs::write(dir.join(format!("f{n}.bin")), b"x").unwrap();
        }
        let mut out = Vec::new();
        let r = walk_capped(&dir, 0, None, &mut out, &CancelToken::new(), 10);
        assert!(
            matches!(r, Err(Error::TooManyFiles { limit: 10 })),
            "expected a named ceiling error, got {r:?}"
        );
        assert!(
            out.len() <= 10,
            "the ceiling must bound `out`, found {}",
            out.len()
        );
    }

    #[test]
    fn a_scan_under_the_ceiling_is_unaffected() {
        // The guard must not trip on a normal shoot: exactly-at-limit is fine, over is not.
        let dir = scratch("scan-under-ceiling");
        for n in 0..8 {
            fs::write(dir.join(format!("f{n}.bin")), b"x").unwrap();
        }
        let mut out = Vec::new();
        let r = walk_capped(&dir, 0, None, &mut out, &CancelToken::new(), 100);
        assert!(r.is_ok(), "a small tree must scan cleanly, got {r:?}");
        assert_eq!(out.len(), 8);
    }

    #[test]
    fn cancel_interrupts_a_large_single_directory_mid_loop() {
        // S-8: the in-loop cancel check must interrupt the drain of one huge directory,
        // not only the gaps between directories. This specifically guards the check inside
        // the entry loop: the per-directory check at the top of `walk_capped` runs exactly
        // once for a single flat directory, so with the in-loop check removed a concurrent
        // cancel would be ignored until the whole directory had drained — which is the
        // failure this asserts against.
        //
        // Deterministic, not timing-raced: the earlier version slept 2 ms before cancelling
        // and a fast disk drained the directory first, so `walk` finished Ok before the flag
        // was ever set. Here the flag is raised with no artificial delay while the walk runs,
        // and the entry count is large enough that the loop cannot complete before the raise
        // is observed (each entry costs a `metadata` syscall). If the OS is loaded enough to
        // delay the canceller thread, the walk is slowed by the same load, so the ordering
        // holds regardless of absolute speed.
        let dir = scratch("scan-cancel-midloop");
        for n in 0..20_000 {
            fs::write(dir.join(format!("f{n}.bin")), b"x").unwrap();
        }
        let cancel = CancelToken::new();
        let flag = cancel.clone();
        let handle = std::thread::spawn(move || flag.cancel());
        let start = std::time::Instant::now();
        let mut out = Vec::new();
        let r = walk_capped(&dir, 0, None, &mut out, &cancel, MAX_FILES);
        handle.join().unwrap();
        assert!(
            matches!(r, Err(Error::Cancelled)),
            "a cancel during the drain must stop the walk, got {r:?} after {} entries",
            out.len()
        );
        assert!(
            out.len() < 20_000,
            "the walk drained the whole directory instead of stopping early: {} entries",
            out.len()
        );
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "cancel did not return promptly: {:?}",
            start.elapsed()
        );
    }
}
