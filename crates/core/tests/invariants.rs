//! Property tests for the §7.3 invariants — docs/PLAN.md §8.4.
//!
//! Hand-written cases check the situations someone thought of. These check the ones
//! nobody did: proptest generates thousands of clip layouts, including the degenerate and
//! adversarial ones, and asserts the properties that must hold for *every* possible run.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use proptest::prelude::*;
use std::path::PathBuf;
use sundaysync_core::{
    place::confidence_from_psr, Placement, SyncResult, Unsynced, UnsyncedReason, Warning,
};

fn placement(file: &str, device: &str, offset: f64) -> Placement {
    Placement {
        file: PathBuf::from(file),
        device: device.into(),
        offset_seconds: offset,
        confidence: 0.9,
        psr: 50.0,
        drift_ppm: None,
        projected_end_error_ms: None,
        chain: Vec::new(),
        warnings: Vec::new(),
    }
}

fn result_with(placements: Vec<Placement>, unsynced: Vec<Unsynced>) -> SyncResult {
    SyncResult {
        schema: sundaysync_core::SCHEMA_VERSION,
        parameters: sundaysync_core::Parameters {
            analysis_rate: sundaysync_core::ANALYSIS_RATE,
            min_psr: sundaysync_core::DEFAULT_MIN_PSR,
        },
        reference: None,
        devices: Vec::new(),
        placements,
        unsynced,
        sequence: sundaysync_core::Sequence {
            fps: sundaysync_core::Rational::new(25, 1).unwrap(),
            duration_seconds: 0.0,
        },
        warnings: Vec::new(),
    }
}

proptest! {
    /// §7.3: every input file ends in exactly one of `placements` or `unsynced`.
    #[test]
    fn every_file_is_accounted_for_exactly_once(
        placed in prop::collection::vec(0usize..40, 0..20),
        refused in prop::collection::vec(0usize..40, 0..20),
    ) {
        // Partition a shared namespace so no file can appear in both buckets.
        let placed: Vec<usize> = { let mut v = placed; v.sort_unstable(); v.dedup(); v };
        let refused: Vec<usize> = {
            let mut v: Vec<usize> = refused.into_iter().filter(|x| !placed.contains(x)).collect();
            v.sort_unstable(); v.dedup(); v
        };

        let ps: Vec<Placement> = placed.iter()
            .map(|i| placement(&format!("/f{i}.mp4"), "cam", f64::from(*i as u32)))
            .collect();
        let us: Vec<Unsynced> = refused.iter()
            .map(|i| Unsynced { file: PathBuf::from(format!("/f{i}.mp4")), reason: UnsyncedReason::LowConfidence })
            .collect();

        let mut inputs: Vec<PathBuf> = placed.iter().chain(refused.iter())
            .map(|i| PathBuf::from(format!("/f{i}.mp4"))).collect();
        inputs.sort();

        let r = result_with(ps, us);
        prop_assert!(r.accounts_for(&inputs));
    }

    /// A file appearing in both buckets must always be caught.
    #[test]
    fn a_double_reported_file_is_always_detected(n in 1usize..15) {
        let ps: Vec<Placement> = (0..n)
            .map(|i| placement(&format!("/f{i}.mp4"), "cam", i as f64))
            .collect();
        // Report the first file as unsynced as well — a contradiction.
        let us = vec![Unsynced {
            file: PathBuf::from("/f0.mp4"),
            reason: UnsyncedReason::DecodeError,
        }];
        let inputs: Vec<PathBuf> = (0..n).map(|i| PathBuf::from(format!("/f{i}.mp4"))).collect();

        let r = result_with(ps, us);
        prop_assert!(!r.accounts_for(&inputs), "double-reported file slipped through");
    }

    /// §5: sorting is a total order, so it is idempotent and independent of input order.
    #[test]
    fn sorting_is_idempotent_and_order_independent(
        offsets in prop::collection::vec(-500.0f64..500.0, 1..25),
    ) {
        let make = |order: Box<dyn Iterator<Item = usize>>| {
            let ps: Vec<Placement> = order
                .map(|i| placement(&format!("/f{i}.mp4"), "cam", offsets[i]))
                .collect();
            let mut r = result_with(ps, Vec::new());
            r.sort_deterministically();
            r
        };
        let forward = make(Box::new(0..offsets.len()));
        let backward = make(Box::new((0..offsets.len()).rev()));
        prop_assert_eq!(&forward.placements, &backward.placements);

        // Sorting again changes nothing.
        let mut again = forward.clone();
        again.sort_deterministically();
        prop_assert_eq!(&forward.placements, &again.placements);
    }

    /// Sorted placements are non-decreasing in offset, with paths breaking ties.
    #[test]
    fn sorted_placements_are_monotonic(
        offsets in prop::collection::vec(-500.0f64..500.0, 2..30),
    ) {
        let ps: Vec<Placement> = offsets.iter().enumerate()
            .map(|(i, o)| placement(&format!("/f{i:03}.mp4"), "cam", *o))
            .collect();
        let mut r = result_with(ps, Vec::new());
        r.sort_deterministically();
        for w in r.placements.windows(2) {
            let ordered = w[0].offset_seconds < w[1].offset_seconds
                || (w[0].offset_seconds == w[1].offset_seconds && w[0].file <= w[1].file);
            prop_assert!(ordered, "{:?} before {:?}", w[0].offset_seconds, w[1].offset_seconds);
        }
    }

    /// §13.4: serialisation is deterministic for any result.
    #[test]
    fn serialisation_is_stable(
        offsets in prop::collection::vec(-1000.0f64..1000.0, 0..20),
    ) {
        let ps: Vec<Placement> = offsets.iter().enumerate()
            .map(|(i, o)| placement(&format!("/f{i}.mp4"), "cam", *o))
            .collect();
        let mut r = result_with(ps, Vec::new());
        r.sort_deterministically();
        let a = serde_json::to_string(&r).unwrap();
        let b = serde_json::to_string(&r).unwrap();
        prop_assert_eq!(a, b);
    }

    /// Confidence is a total, monotonic map into 0..=1 — the UI relies on both.
    #[test]
    fn confidence_is_bounded_and_monotonic(
        psr in 0.0f64..10_000.0,
        min_psr in 0.1f64..100.0,
    ) {
        let c = confidence_from_psr(psr, min_psr);
        prop_assert!((0.0..=1.0).contains(&c), "confidence {c} out of range");
        prop_assert!(c.is_finite());

        // More evidence never means less confidence.
        let more = confidence_from_psr(psr * 2.0, min_psr);
        prop_assert!(more >= c - 1e-12, "{more} < {c}");

        // Anything at or below the threshold is zero confidence.
        if psr <= min_psr {
            prop_assert_eq!(c, 0.0);
        }
    }

    /// A round-trip through JSON preserves the contract to well beyond any meaningful
    /// precision.
    ///
    /// Deliberately *not* asserting bit equality. `serde_json` serialises an f64
    /// correctly but its parser is not always correctly-rounded: measured over 200 000
    /// values in the ±5000 s range, 9.7 % come back differing by exactly one ULP — worst
    /// case 4.5e-13 s, or 0.45 picoseconds. That is eleven orders of magnitude below a
    /// video frame, and the engine never round-trips through JSON in the product path
    /// anyway (the FCPXML exporter reads the in-memory struct). §13.4's byte-equality
    /// check compares two engine runs, both serialising from memory, so it is unaffected.
    /// See docs/DECISIONS.md D-018.
    #[test]
    fn the_result_contract_round_trips(
        offset in -5000.0f64..5000.0,
        ppm in -500.0f64..500.0,
    ) {
        let mut p = placement("/a.mp4", "cam", offset);
        p.drift_ppm = Some(ppm);
        p.projected_end_error_ms = Some(ppm * 0.1);
        p.warnings.push(Warning::Drift { projected_end_error_ms: ppm * 0.1 });
        let r = result_with(vec![p], Vec::new());

        let json = serde_json::to_string(&r).unwrap();
        let back: SyncResult = serde_json::from_str(&json).unwrap();

        prop_assert_eq!(r.placements.len(), back.placements.len());
        let (a, b) = (&r.placements[0], &back.placements[0]);
        prop_assert_eq!(&a.file, &b.file);
        prop_assert_eq!(&a.device, &b.device);
        // A nanosecond is already absurdly tight for a product whose unit is the frame.
        prop_assert!((a.offset_seconds - b.offset_seconds).abs() < 1e-9);
        prop_assert!((a.drift_ppm.unwrap() - b.drift_ppm.unwrap()).abs() < 1e-9);
        prop_assert_eq!(a.warnings.len(), b.warnings.len());
    }
}
