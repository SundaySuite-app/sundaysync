//! Device grouping — docs/PLAN.md §4.5.
//!
//! Cameras record sequentially, so knowing which clips came from the same body is what
//! lets §4.4 enforce the no-overlap invariant and what gives §9's result view one lane
//! per camera. Nothing downstream works properly without this.
//!
//! # Why the heuristics are applied per file, not per shoot
//!
//! §4.5 lists four heuristics "in priority order". They are evaluated per file with a
//! fallback chain rather than picking one strategy for the whole set, because a real
//! shoot is mixed: three cameras that write a model tag plus a Zoom recorder that writes
//! none is the *typical* case, not an edge case. A set-wide strategy would see "not
//! every file has metadata", fall back to filenames for everything, and lose the camera
//! identities it already had. Keys are namespaced by heuristic (`model:`, `name:`, …)
//! so two files can never collide across strategies.

use crate::probe::Probed;
use crate::result::{Device, DeviceKind};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Which heuristic identified a device. Encoded into the device id, so the UI can
/// recover the provenance and localise the label (see [`Grouping::label`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Source {
    Folder,
    Model,
    Filename,
    Signature,
}

impl Source {
    const fn prefix(self) -> &'static str {
        match self {
            Self::Folder => "folder",
            Self::Model => "model",
            Self::Filename => "name",
            Self::Signature => "sig",
        }
    }
}

struct Grouping {
    source: Source,
    /// The raw, human-meaningful part of the key — a folder name, a camera model.
    value: String,
}

impl Grouping {
    /// The user-facing label.
    ///
    /// Deliberately *not* prefixed: §4.5's example label is "Mappe: Balkong", but the
    /// engine must not hardcode Norwegian when §9 requires a bilingual (nb + en) UI.
    /// The bare value is emitted and the provenance is recoverable from the device id
    /// (`folder-balkong`), so the UI renders "Mappe: Balkong" or "Folder: Balkong" as
    /// appropriate. See docs/DECISIONS.md D-007.
    fn label(&self) -> String {
        self.value.clone()
    }

    fn id(&self) -> String {
        format!("{}-{}", self.source.prefix(), slug(&self.value))
    }
}

/// Groups probed files into devices.
///
/// `dropped_dirs` is the subset of the user's inputs that were folders — heuristic 1
/// only applies to those, and the file paths alone cannot tell us which roots the user
/// actually dropped.
///
/// Deliberately a pure function: it does not touch the filesystem. The caller already
/// established what was a directory while walking the inputs, and re-deriving it here
/// would make grouping depend on disk state that can change mid-run — and would make
/// this logic untestable without creating real directories for every case.
#[must_use]
pub fn group(files: &[Probed], dropped_dirs: &[PathBuf]) -> Vec<Device> {
    // BTreeMap keyed by id: grouping and ordering fall out deterministically (§3),
    // with no sort-after-the-fact step that could be forgotten.
    let mut by_id: BTreeMap<String, (Grouping, Vec<PathBuf>, bool)> = BTreeMap::new();

    for probed in files {
        let grouping = classify(probed, dropped_dirs);
        let id = grouping.id();
        let entry = by_id
            .entry(id)
            .or_insert_with(|| (grouping, Vec::new(), false));
        entry.1.push(probed.path.clone());
        // A device counts as video if *any* of its clips carries video: a camera that
        // also produced an audio-only file is still a camera.
        entry.2 |= probed.video.is_some();
    }

    by_id
        .into_iter()
        .map(|(id, (grouping, mut paths, has_video))| {
            paths.sort();
            Device {
                id,
                label: grouping.label(),
                kind: if has_video {
                    DeviceKind::Video
                } else {
                    DeviceKind::Audio
                },
                files: paths,
            }
        })
        .collect()
}

/// The §4.5 fallback chain, in the plan's stated priority order.
fn classify(probed: &Probed, dropped_dirs: &[PathBuf]) -> Grouping {
    if let Some(value) = folder_key(&probed.path, dropped_dirs) {
        return Grouping {
            source: Source::Folder,
            value,
        };
    }
    if let Some(value) = probed.device_model() {
        return Grouping {
            source: Source::Model,
            value,
        };
    }
    if let Some(value) = filename_prefix(&probed.path) {
        return Grouping {
            source: Source::Filename,
            value,
        };
    }
    Grouping {
        source: Source::Signature,
        value: signature(probed),
    }
}

/// Heuristic 1 — the folder the user organised their card dumps into.
///
/// Uses the first subdirectory *below* a dropped folder, not the dropped folder itself:
/// dropping one `Opptak/` containing `Balkong/`, `Scene/` and `Zoom/` is the realistic
/// layout, and keying on the drop root would collapse all three into one device. Files
/// sitting directly in a dropped folder only group by it when several folders were
/// dropped — otherwise the key would be constant and tell us nothing.
fn folder_key(path: &Path, dropped_dirs: &[PathBuf]) -> Option<String> {
    for root in dropped_dirs {
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let mut components = rel.components();
        let first = components.next()?;
        return if components.next().is_some() {
            // At least one directory level between the root and the file.
            Some(first.as_os_str().to_string_lossy().into_owned())
        } else if dropped_dirs.len() > 1 {
            root.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .or_else(|| Some(root.to_string_lossy().into_owned()))
        } else {
            None
        };
    }
    None
}

/// Heuristic 3 — camera filename conventions.
///
/// Cameras name clips as a fixed prefix plus a counter: `C0012`, `DSC_0042`, `MVI_1234`,
/// `GX010023`, `ZOOM0001`. Stripping the trailing digit run recovers the prefix, which
/// is stable per camera model and often per body. Returns `None` when there is no
/// trailing counter, since an arbitrary name like `service-final` says nothing about
/// which device produced it.
fn filename_prefix(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy();
    let trimmed = stem.trim_end_matches(|c: char| c.is_ascii_digit());
    if trimmed.len() == stem.len() {
        return None; // no trailing counter
    }
    let prefix = trimmed.trim_end_matches(['_', '-', '.', ' ']);
    if prefix.is_empty() {
        return None; // an all-digits name carries no prefix
    }
    // Uppercased so `c0012` and `C0013` land on one device; cameras are not consistent
    // about case across firmware versions.
    Some(prefix.to_uppercase())
}

/// Heuristic 4 — last resort: files that look technically identical probably came from
/// the same device.
fn signature(probed: &Probed) -> String {
    match (&probed.video, &probed.audio) {
        (Some(v), _) => format!(
            "{} {}x{} {}",
            v.codec,
            v.width,
            v.height,
            v.fps.map_or_else(|| "?".to_string(), |f| f.to_string())
        ),
        (None, Some(a)) => format!("{} {} {}ch", a.codec, a.sample_rate, a.channels),
        (None, None) => "unknown".to_string(),
    }
}

/// Lowercase, ASCII-alphanumeric-and-dash. Ids appear in JSON and in FCPXML, so they
/// must be stable and free of anything needing escaping.
fn slug(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last_dash = true; // suppresses a leading dash
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "unnamed".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{AudioStream, VideoStream};

    fn probed(path: &str) -> Probed {
        Probed {
            path: PathBuf::from(path),
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
                fps: crate::rational::Rational::new(25, 1),
            }),
            tags: BTreeMap::new(),
        }
    }

    fn with_model(path: &str, make: &str, model: &str) -> Probed {
        let mut p = probed(path);
        p.tags.insert("make".into(), make.into());
        p.tags.insert("model".into(), model.into());
        p
    }

    fn audio_only(path: &str) -> Probed {
        let mut p = probed(path);
        p.video = None;
        p.audio = Some(AudioStream {
            codec: "pcm_s16le".into(),
            sample_rate: 48_000,
            channels: 1,
        });
        p
    }

    #[test]
    fn filenames_cluster_by_camera_prefix() {
        let files = [
            probed("/x/C0001.MP4"),
            probed("/x/C0002.MP4"),
            probed("/x/DSC_0042.MOV"),
        ];
        let devices = group(&files, &[]);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].id, "name-c");
        assert_eq!(devices[0].files.len(), 2);
        assert_eq!(devices[1].id, "name-dsc");
    }

    #[test]
    fn known_camera_naming_conventions_are_recognised() {
        for (name, expect) in [
            ("C0012", Some("C")),
            ("DSC_0042", Some("DSC")),
            ("MVI_1234", Some("MVI")),
            ("GX010023", Some("GX")),
            ("ZOOM0001", Some("ZOOM")),
            ("c0013", Some("C")), // case-normalised
            ("service-final", None),
            ("0001", None), // all digits: no prefix to key on
        ] {
            let got = filename_prefix(Path::new(&format!("/x/{name}.mp4")));
            assert_eq!(got.as_deref(), expect, "for {name}");
        }
    }

    #[test]
    fn metadata_beats_filenames() {
        // §4.5 priority: two bodies of the same model write identically-named files, so
        // the model tag must win over the shared `C` prefix.
        let files = [
            with_model("/x/C0001.MP4", "Sony", "ILCE-7M4"),
            with_model("/y/C0001.MP4", "Canon", "EOS R5"),
        ];
        let devices = group(&files, &[]);
        assert_eq!(devices.len(), 2);
        assert!(devices.iter().any(|d| d.id == "model-sony-ilce-7m4"));
        assert!(devices.iter().any(|d| d.id == "model-canon-eos-r5"));
    }

    #[test]
    fn dropped_subfolders_win_over_everything() {
        // The user's own organisation is the strongest signal available.
        let root = PathBuf::from("/Opptak");
        let files = [
            with_model("/Opptak/Balkong/C0001.MP4", "Sony", "ILCE-7M4"),
            with_model("/Opptak/Scene/C0001.MP4", "Sony", "ILCE-7M4"),
        ];
        let devices = group(&files, &[root]);
        assert_eq!(
            devices.len(),
            2,
            "same model, different folders → 2 devices"
        );
        assert_eq!(devices[0].id, "folder-balkong");
        assert_eq!(
            devices[0].label, "Balkong",
            "label is bare; UI adds the prefix"
        );
        assert_eq!(devices[1].id, "folder-scene");
    }

    #[test]
    fn one_dropped_folder_with_loose_files_does_not_collapse_them() {
        // Keying on the drop root would put every camera on one device. The filename
        // heuristic must take over instead.
        let root = PathBuf::from("/Opptak");
        let files = [probed("/Opptak/C0001.MP4"), probed("/Opptak/DSC_0042.MOV")];
        let devices = group(&files, &[root]);
        assert_eq!(devices.len(), 2);
        assert!(devices.iter().all(|d| d.id.starts_with("name-")));
    }

    #[test]
    fn several_dropped_folders_group_loose_files_by_folder() {
        let a = PathBuf::from("/cards/A");
        let b = PathBuf::from("/cards/B");
        let files = [probed("/cards/A/C0001.MP4"), probed("/cards/B/C0001.MP4")];
        let devices = group(&files, &[a, b]);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].id, "folder-a");
        assert_eq!(devices[1].id, "folder-b");
    }

    #[test]
    fn a_mixed_shoot_keeps_camera_identity_and_still_groups_the_recorder() {
        // The realistic case, and the reason heuristics are per file: cameras carry
        // metadata, the Zoom does not. A set-wide strategy would lose the models.
        let files = [
            with_model("/x/C0001.MP4", "Sony", "ILCE-7M4"),
            with_model("/x/C0002.MP4", "Sony", "ILCE-7M4"),
            audio_only("/x/ZOOM0001.WAV"),
            audio_only("/x/ZOOM0002.WAV"),
        ];
        let devices = group(&files, &[]);
        assert_eq!(devices.len(), 2);
        let cam = devices
            .iter()
            .find(|d| d.id == "model-sony-ilce-7m4")
            .unwrap();
        assert_eq!(cam.kind, DeviceKind::Video);
        let rec = devices.iter().find(|d| d.id == "name-zoom").unwrap();
        assert_eq!(rec.kind, DeviceKind::Audio);
        assert_eq!(rec.files.len(), 2);
    }

    #[test]
    fn indistinguishable_files_fall_back_to_a_technical_signature() {
        let files = [probed("/x/take.mp4"), probed("/x/another.mp4")];
        let devices = group(&files, &[]);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "sig-h264-1920x1080-25-1");
    }

    #[test]
    fn grouping_is_deterministic_regardless_of_input_order() {
        // §3: identical inputs must produce identical output. Directory iteration order
        // is not stable across filesystems, so this cannot rely on the caller.
        let forward = [probed("/x/C0001.MP4"), probed("/x/DSC_0002.MOV")];
        let reversed = [probed("/x/DSC_0002.MOV"), probed("/x/C0001.MP4")];
        assert_eq!(group(&forward, &[]), group(&reversed, &[]));
    }

    #[test]
    fn slugs_stay_safe_for_json_and_xml() {
        assert_eq!(slug("Sony ILCE-7M4"), "sony-ilce-7m4");
        assert_eq!(slug("Kamera «Balkong»"), "kamera-balkong");
        assert_eq!(slug("  "), "unnamed");
        assert_eq!(slug("h264 1920x1080 25/1"), "h264-1920x1080-25-1");
    }
}
