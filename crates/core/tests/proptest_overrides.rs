//! E4's proptest expansion (docs/V02-PROGRAM.md):
//!
//! 1. Random device-override maps against the §7.3 accounting invariant — every file the
//!    scan produced is still accounted for, exactly once, after
//!    [`sundaysync_core::scan::apply_device_overrides`] has moved an arbitrary subset of
//!    them between devices (including onto brand-new device ids, per D-028).
//! 2. Hostile path strings driven through the real `scan()` walk/collect/dedup path —
//!    unicode, control-adjacent punctuation, leading dashes and dots, very long names —
//!    asserting no panic and that accounting still holds.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use proptest::prelude::*;
use std::collections::BTreeMap;
use std::path::PathBuf;
use sundaysync_core::probe::AudioStream;
use sundaysync_core::scan::{self, FileEntry, ScanManifest};
use sundaysync_core::{CancelToken, Device, DeviceKind, NoProgress, Sidecar, SCHEMA_VERSION};

// ---- 1. Device-override accounting -----------------------------------------------------

/// Builds a manifest of `n` synthetic files, all initially grouped under one device
/// (`"cam-a"`) — the starting shape [`sundaysync_core::scan::scan_detailed`] would hand
/// `apply_device_overrides` before any override is applied.
fn manifest_with_files(n: usize) -> ScanManifest {
    let files: Vec<FileEntry> = (0..n)
        .map(|i| FileEntry {
            file: PathBuf::from(format!("/shoot/f{i:03}.wav")),
            device: "cam-a".into(),
            duration_seconds: 10.0 + i as f64,
            format_name: "wav".into(),
            audio: Some(AudioStream {
                codec: "pcm_s16le".into(),
                sample_rate: 48_000,
                channels: 1,
            }),
            video: None,
            creation_time: None,
        })
        .collect();
    let device = Device {
        id: "cam-a".into(),
        label: "A".into(),
        kind: DeviceKind::Audio,
        files: files.iter().map(|f| f.file.clone()).collect(),
    };
    ScanManifest {
        schema: SCHEMA_VERSION,
        devices: vec![device],
        files,
        unsynced: Vec::new(),
        skipped: Vec::new(),
    }
}

/// Every file in `manifest.files` appears in exactly one device's `files` list, and every
/// device's `files` list contains only files that exist in `manifest.files` — the §7.3
/// accounting invariant restated for the scan/device-grouping level, since
/// `apply_device_overrides` runs before `SyncResult` (and its own `accounts_for`) exists.
fn devices_account_for_every_file(manifest: &ScanManifest) -> Result<(), String> {
    let all_files: Vec<&PathBuf> = manifest.files.iter().map(|f| &f.file).collect();

    // Every file entry's `.device` must resolve to a device that really lists it.
    for entry in &manifest.files {
        if entry.device.is_empty() {
            return Err(format!("{} has no device at all", entry.file.display()));
        }
        let owner = manifest.devices.iter().find(|d| d.id == entry.device);
        match owner {
            None => {
                return Err(format!(
                    "{} claims device {:?}, which does not exist in manifest.devices",
                    entry.file.display(),
                    entry.device
                ))
            }
            Some(d) if !d.files.contains(&entry.file) => {
                return Err(format!(
                    "{} claims device {:?}, but that device's file list does not contain it",
                    entry.file.display(),
                    entry.device
                ))
            }
            Some(_) => {}
        }
    }

    // No device may reference a file that is not in `manifest.files`, or reference one
    // twice, and the union across all devices must equal `manifest.files` exactly.
    let mut seen: Vec<&PathBuf> = Vec::new();
    for device in &manifest.devices {
        let mut in_this_device: Vec<&PathBuf> = device.files.iter().collect();
        let before = in_this_device.len();
        in_this_device.sort();
        in_this_device.dedup();
        if in_this_device.len() != before {
            return Err(format!("device {} lists a file more than once", device.id));
        }
        for f in &device.files {
            if !all_files.contains(&f) {
                return Err(format!(
                    "device {} claims {}, which is not in manifest.files",
                    device.id,
                    f.display()
                ));
            }
        }
        seen.extend(device.files.iter());
    }
    let mut seen_sorted = seen.clone();
    seen_sorted.sort();
    seen_sorted.dedup();
    if seen_sorted.len() != seen.len() {
        return Err("a file is claimed by more than one device".into());
    }
    if seen.len() != manifest.files.len() {
        return Err(format!(
            "{} files claimed across devices, but manifest.files has {}",
            seen.len(),
            manifest.files.len()
        ));
    }
    Ok(())
}

proptest! {
    /// The core deliverable: arbitrary override maps, including stale keys (D-028 says
    /// these are ignored) and targets that create brand-new devices, must never break the
    /// accounting invariant above and must never panic.
    #[test]
    fn overrides_never_break_device_accounting(
        n in 1usize..12,
        // Index into `0..n+2` so some entries target a real file and some are stale keys
        // past the end (D-028's "ignored" case) — both must be safe.
        moves in prop::collection::vec((0usize..14, 0usize..4), 0..20),
    ) {
        let mut manifest = manifest_with_files(n);
        let before_files: Vec<PathBuf> = manifest.files.iter().map(|f| f.file.clone()).collect();

        let target_pool = ["cam-a", "cam-b", "folder-new", "rec"];
        let mut overrides: BTreeMap<PathBuf, String> = BTreeMap::new();
        for (file_idx, target_idx) in moves {
            let path = PathBuf::from(format!("/shoot/f{file_idx:03}.wav"));
            overrides.insert(path, target_pool[target_idx].to_string());
        }

        scan::apply_device_overrides(&mut manifest, &overrides);

        // §7.3-at-the-scan-level: still every file, exactly once.
        prop_assert_eq!(
            manifest.files.iter().map(|f| f.file.clone()).collect::<Vec<_>>(),
            before_files,
            "apply_device_overrides must never add, drop, or reorder files"
        );
        prop_assert!(
            devices_account_for_every_file(&manifest).is_ok(),
            "{:?}",
            devices_account_for_every_file(&manifest).unwrap_err()
        );
    }

    /// A stale key — one matching no file the scan ever produced — must be a no-op, never
    /// a panic and never a phantom device.
    #[test]
    fn stale_override_keys_are_ignored(
        n in 1usize..8,
        stale_suffix in "[a-zA-Z0-9]{1,12}",
    ) {
        let mut manifest = manifest_with_files(n);
        let before = manifest.clone();

        let mut overrides = BTreeMap::new();
        overrides.insert(
            PathBuf::from(format!("/nowhere/{stale_suffix}.wav")),
            "cam-b".into(),
        );
        scan::apply_device_overrides(&mut manifest, &overrides);

        prop_assert_eq!(manifest, before, "a stale override key changed the manifest");
    }

    /// Re-applying the identical override map twice must be idempotent — §3's
    /// determinism extends to advanced-mode inputs, not just the correlation core.
    #[test]
    fn applying_overrides_twice_is_idempotent(
        n in 1usize..10,
        moves in prop::collection::vec((0usize..10, 0usize..3), 0..15),
    ) {
        let target_pool = ["cam-a", "cam-b", "folder-new"];
        let mut overrides: BTreeMap<PathBuf, String> = BTreeMap::new();
        for (file_idx, target_idx) in moves {
            overrides.insert(
                PathBuf::from(format!("/shoot/f{file_idx:03}.wav")),
                target_pool[target_idx].to_string(),
            );
        }

        let mut once = manifest_with_files(n);
        scan::apply_device_overrides(&mut once, &overrides);
        let mut twice = once.clone();
        scan::apply_device_overrides(&mut twice, &overrides);

        prop_assert_eq!(once, twice, "re-applying the same overrides changed the manifest");
    }
}

// ---- 2. Hostile path strings through the real scan() walk -------------------------------

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
        .join("sundaysync-proptest-paths")
        .join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Makes an arbitrary generated string safe to use as ONE path component on this OS
/// (strips the two bytes that are structurally impossible in a filename — `/` and NUL —
/// and bounds the length), while keeping it as hostile as proptest made it otherwise:
/// unicode, punctuation, embedded spaces, control-adjacent characters. This is
/// deliberately *not* the same sanitisation `scan.rs` performs — it exists only so the
/// generated string can become a real file the OS will accept, not to pre-filter the
/// cases that matter.
///
/// Leading dots are also stripped, but for a different reason: `scan.rs`'s `is_hidden`
/// deliberately and correctly skips dotfiles (§4.1 — AppleDouble/`.DS_Store` noise), so a
/// generated name starting with `.` would never reach `files`/`unsynced` at all. That is
/// already covered by `scan.rs`'s own `hidden_os_metadata_is_skipped` unit test; this
/// property test's accounting invariant is about files the walk actually considers.
fn sanitise_component(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|c| *c != '/' && *c != '\0').collect();
    let bounded: String = cleaned.chars().take(120).collect();
    let bounded = bounded.trim_start_matches('.').to_string();
    if bounded.trim().is_empty() {
        "x".to_string()
    } else {
        bounded
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    /// Hostile filenames — unicode, leading dashes/dots, embedded whitespace, long names —
    /// dropped into a real directory and walked through the real `scan()`. Every one must
    /// be accounted for exactly once (§7.3 at the scan level) and the walk must never
    /// panic, regardless of how strange the name is.
    #[test]
    fn hostile_filenames_scan_without_panicking(
        raw_names in prop::collection::vec("\\PC{1,40}", 1..8),
    ) {
        let Some(sidecar) = require_ffmpeg() else {
            return Ok(());
        };
        let dir = scratch(&format!("case-{:x}", {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            raw_names.hash(&mut h);
            h.finish()
        }));

        // Sanitise, then de-duplicate by writing through a map — two generated strings
        // colliding on the same on-disk name after sanitisation is itself a legitimate
        // case (the dedup logic must handle it), not a test bug to avoid.
        let mut on_disk: BTreeMap<String, ()> = BTreeMap::new();
        for raw in &raw_names {
            let name = sanitise_component(raw);
            let path = dir.join(&name);
            // A name might still be rejected by this filesystem (e.g. reserved on some
            // platforms) — skip only that one file rather than failing the case, since
            // the property under test is scan()'s robustness, not this OS's naming rules.
            if std::fs::write(&path, b"not real media").is_ok() {
                on_disk.insert(name, ());
            }
        }
        prop_assume!(!on_disk.is_empty());

        let manifest = scan::scan(
            std::slice::from_ref(&dir),
            &sidecar,
            &NoProgress,
            &CancelToken::new(),
        );
        // The one non-negotiable property: no panic, ever, regardless of the name. A
        // `TooManyFiles` refusal would also be a defined outcome, but cannot occur here
        // since `on_disk.len()` is far under the S-8 ceiling.
        let manifest = manifest.expect("scan must not hard-error on hostile filenames");

        // §7.3 at the scan level: every file dropped in is accounted for exactly once.
        let accounted = manifest.files.len() + manifest.unsynced.len();
        prop_assert_eq!(
            accounted,
            on_disk.len(),
            "expected {} files accounted for, got {} (files={}, unsynced={})",
            on_disk.len(),
            accounted,
            manifest.files.len(),
            manifest.unsynced.len()
        );
        let mut reported: Vec<&PathBuf> = manifest
            .files
            .iter()
            .map(|f| &f.file)
            .chain(manifest.unsynced.iter().map(|u| &u.file))
            .collect();
        let before = reported.len();
        reported.sort();
        reported.dedup();
        prop_assert_eq!(before, reported.len(), "a hostile filename was reported twice");
    }
}

// ---- A characterised (non-property) edge case found while designing the above -----------

/// Not generated — a specific, deliberately constructed case: the SAME nonexistent path
/// passed twice as separate top-level inputs. `scan::collect`'s dedup
/// (`crates/core/src/scan.rs`) sorts and dedups the *found* files list, but the `missing`
/// list (inputs that are neither a file nor a directory) is built by pushing one
/// `Unsynced` per input with no dedup step. Two identical bad paths given twice therefore
/// produce two identical `Unsynced` entries in the manifest.
///
/// This is not a panic and not silent data loss — `scan()` itself has no accounting
/// invariant to violate (that check lives in `SyncResult::accounts_for`, one layer up,
/// in `sync()`) — but it is worth naming: a caller that fed the same bad path twice at
/// the top level (a duplicated CLI arg, a UI drag-and-drop bug) and then ran the full
/// `sync()` pipeline would hit `Error::Invariant("a file was lost or double-reported...")`
/// instead of a clean, informative refusal. Recorded here rather than filed as an
/// F-numbered finding since it is a minor, narrow edge case; a `missing.sort();
/// missing.dedup();` alongside the existing `files.dedup()` in `scan::collect` would
/// close it. Not fixed here: `crates/core/src/scan.rs` is out of this agent's ownership.
#[test]
fn duplicate_missing_top_level_inputs_are_not_deduplicated_todays_behaviour() {
    let Some(sidecar) = require_ffmpeg() else {
        return;
    };
    let dup = PathBuf::from("/no/such/sundaysync-duplicate-probe-path");
    let manifest = scan::scan(
        &[dup.clone(), dup.clone()],
        &sidecar,
        &NoProgress,
        &CancelToken::new(),
    )
    .expect("scan must not hard-error on a nonexistent path");

    let hits: usize = manifest.unsynced.iter().filter(|u| u.file == dup).count();
    // Documents today's behaviour rather than asserting it is correct. If this ever
    // starts failing because `scan::collect` gained a `missing.dedup()`, that is a
    // welcome fix — update this assertion to `assert_eq!(hits, 1)` when it does.
    assert_eq!(
        hits, 2,
        "if this is now 1, scan::collect's missing-list has been deduplicated — good, \
         update this test to assert that instead of documenting the old behaviour"
    );
}
