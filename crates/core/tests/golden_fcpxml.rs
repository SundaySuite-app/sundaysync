//! Golden FCPXML tests — docs/PLAN.md §8.4: "fixed `SyncResult` in ⇒ byte-identical XML out."
//!
//! A golden file is the cheapest possible guard against an exporter change nobody meant
//! to make. If this fails, either the change was deliberate (update the golden and say so
//! in the commit) or it was not — and the second case is exactly what this exists to catch.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use sundaysync_core::{
    export_fcpxml, Device, DeviceKind, Parameters, Placement, Rational, Reference, Sequence,
    SyncResult, SCHEMA_VERSION,
};

/// A deliberately awkward shoot: a negative offset, a space and a Norwegian letter in a
/// filename, two cameras and a recorder, and an NTSC-family frame rate.
fn fixed_result() -> (SyncResult, BTreeMap<PathBuf, f64>) {
    let files = [
        ("/opptak/Lyd/ZOOM0001.WAV", "rec", 0.0, 600.0),
        ("/opptak/Balkong/C0001.MP4", "cam-a", 12.5, 300.0),
        ("/opptak/Scene/DSC 0042.MOV", "cam-b", -3.25, 280.0),
    ];

    let mut durations = BTreeMap::new();
    let mut placements = Vec::new();
    for (path, device, offset, dur) in files {
        durations.insert(PathBuf::from(path), dur);
        placements.push(Placement {
            file: PathBuf::from(path),
            device: device.into(),
            offset_seconds: offset,
            confidence: 0.9,
            psr: 42.0,
            drift_ppm: Some(-12.5),
            projected_end_error_ms: Some(3.75),
            chain: Vec::new(),
            warnings: Vec::new(),
        });
    }

    let result = SyncResult {
        schema: SCHEMA_VERSION,
        parameters: Parameters {
            analysis_rate: 12_000,
            min_psr: 15.0,
        },
        reference: Some(Reference {
            file: PathBuf::from("/opptak/Lyd/ZOOM0001.WAV"),
            device: "rec".into(),
        }),
        devices: vec![
            Device {
                id: "rec".into(),
                label: "Lyd".into(),
                kind: DeviceKind::Audio,
                files: vec![PathBuf::from("/opptak/Lyd/ZOOM0001.WAV")],
            },
            Device {
                id: "cam-a".into(),
                label: "Balkong".into(),
                kind: DeviceKind::Video,
                files: vec![PathBuf::from("/opptak/Balkong/C0001.MP4")],
            },
            Device {
                id: "cam-b".into(),
                label: "Scene".into(),
                kind: DeviceKind::Video,
                files: vec![PathBuf::from("/opptak/Scene/DSC 0042.MOV")],
            },
        ],
        placements,
        unsynced: Vec::new(),
        sequence: Sequence {
            fps: Rational::new(30_000, 1001).unwrap(),
            duration_seconds: 603.25,
        },
        warnings: Vec::new(),
    };
    (result, durations)
}

#[test]
fn the_exporter_output_matches_the_golden_file() {
    let (result, durations) = fixed_result();
    let export = export_fcpxml(&result, &durations, "Gudstjeneste").unwrap();

    let golden_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/timeline.fcpxml");

    // `UPDATE_GOLDEN=1 cargo test` re-records, so a deliberate change is one command
    // rather than a hand-edit anyone might get subtly wrong.
    if std::env::var("UPDATE_GOLDEN").is_ok() || !golden_path.exists() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).unwrap();
        std::fs::write(&golden_path, &export.xml).unwrap();
        eprintln!("recorded golden file at {}", golden_path.display());
        return;
    }

    let expected = std::fs::read_to_string(&golden_path).unwrap();
    if expected != export.xml {
        for (i, (a, b)) in expected.lines().zip(export.xml.lines()).enumerate() {
            if a != b {
                eprintln!(
                    "first difference at line {}:\n  golden: {a}\n  actual: {b}",
                    i + 1
                );
                break;
            }
        }
    }
    assert_eq!(
        expected, export.xml,
        "exporter output changed; re-record with UPDATE_GOLDEN=1 if that was intended"
    );
}

#[test]
fn ntsc_timing_in_the_golden_file_is_exact() {
    // The property the golden file is really protecting: 29.97 fps must never become a
    // decimal anywhere in the document.
    let (result, durations) = fixed_result();
    let xml = export_fcpxml(&result, &durations, "Gudstjeneste")
        .unwrap()
        .xml;
    assert!(xml.contains(r#"frameDuration="1001/30000s""#));
    assert!(
        !xml.contains("29.97"),
        "a decimal frame rate leaked into the file"
    );
    assert!(
        !xml.contains("0.0333"),
        "a decimal frame duration leaked in"
    );
}
