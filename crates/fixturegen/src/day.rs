//! The E4 §7.7 "synthetic day" fixture — a long reference plus many shorter clips, sized
//! to reproduce the F10/P-3 memory finding (docs/V02-PROGRAM.md E4, docs/DECISIONS.md
//! D-032): `place.rs` loads the *entire* reference into a `Vec<f32>`, and a 20-hour
//! reference alone is ≈3.46 GB resident before anything else has allocated.
//!
//! # Why generation is index-based rather than one big buffer
//!
//! `shoot::emit` builds the whole master event in memory once and slices clips out of
//! it — fine for the minutes-long `quick`/`full` suites, but a 20-hour reference at
//! [`MASTER_RATE`] is billions of samples: materialising it here would spend gigabytes
//! in the *generator*, confounding the peak-RSS measurement this fixture exists to set
//! up honestly, and would also just be needlessly slow to generate.
//!
//! Instead every sample is a pure function of its **absolute index** — see
//! [`sample_at`] — so both the reference and each clip can be produced by evaluating the
//! same function at the appropriate offsets, streamed straight to disk in bounded chunks
//! via [`crate::wav::StreamingWavWriter`], and a clip is a genuine (not merely
//! same-shaped) slice of the reference's content: the engine's correlator can find it as
//! a real match, not just exercise the failure path on unrelated noise.
//!
//! Content is deliberately simpler than [`crate::signal::generate_master`] (a tonal bed
//! plus band-limited noise, no speech-burst/percussive-onset structure) — that structure
//! is stateful across samples in a way that would block the "any index, independently"
//! property this fixture depends on. It is still genuinely broadband (noise is
//! broadband by construction), which is what GCC-PHAT needs.

use crate::shoot::{Codec, EmitError, Truth, TruthClip};
use crate::signal::MASTER_RATE;
use crate::wav::StreamingWavWriter;
use std::f64::consts::TAU;
use std::path::Path;

/// Samples are written in chunks this large (~4 MB of `f32` at a time), keeping the
/// generator's own footprint irrelevant next to the gigabytes it is producing.
const CHUNK_SAMPLES: usize = 1 << 20;

/// One synthetic "day": a reference of `reference_hours`, plus `clip_count` shorter
/// clips scattered across it, all WAV (§7.7's target explicitly wants "mostly WAV" —
/// generation is cheap that way, and the adversarial suite already exercises the codec
/// spread).
#[derive(Debug, Clone, Copy)]
pub struct DaySpec {
    pub seed: u64,
    pub reference_hours: f64,
    pub clip_count: usize,
    pub clip_seconds_min: f64,
    pub clip_seconds_max: f64,
    /// Sample rate the fixture is generated *and* stored at.
    ///
    /// The engine only ever cares about the *duration* the analysis cache ends up
    /// holding — extraction decodes to `sundaysync_core::ANALYSIS_RATE` regardless of
    /// the source rate, so a source WAV already at that rate produces an identical
    /// resident buffer while costing far less disk and CPU to generate than a
    /// camera-realistic 48 kHz would. `full_day` still defaults to [`MASTER_RATE`] for
    /// anyone pointing real tooling (e.g. a from-scratch accuracy pass) at the corpus;
    /// `memory_probe` overrides it down for exactly this reason.
    pub rate: u32,
}

impl DaySpec {
    /// §7.7's literal target: a 20-hour reference and 200 files total (1 reference +
    /// 199 clips). This is the number `docs/V02-PROGRAM.md` names; generating and
    /// syncing it takes real time (tens of minutes to hours against today's engine —
    /// see P-1, correlation cost is linear in reference length and nothing is cached
    /// yet), so it is meant for a manual/nightly `sundaysync bench` run once the E5
    /// performance work lands, not for an always-run test.
    #[must_use]
    pub fn full_day(seed: u64) -> Self {
        Self {
            seed,
            reference_hours: 20.0,
            clip_count: 199,
            clip_seconds_min: 120.0,
            clip_seconds_max: 900.0,
            rate: MASTER_RATE,
        }
    }

    /// A day sized to actually finish in a test run while still meaningfully stressing
    /// the F10 memory bug: a long reference (which is what drives resident memory, per
    /// the module doc) but few clips (which is what drives correlation *time*, per P-1 —
    /// cost is `O(reference_length × clips × segments)` with no caching yet). Generated
    /// at the engine's own analysis rate (see [`DaySpec::rate`]) rather than
    /// [`MASTER_RATE`], which cuts fixture disk/CPU cost by 4x for an identical resident
    /// analysis-audio size.
    ///
    /// This is *not* the 20 h/200-file figure §7.7 names — see the module doc and
    /// `docs/V02-PROGRAM.md` E4 for why the literal spec is deferred to a manual/nightly
    /// `bench` run. `reference_hours`/`clip_count` let a caller dial the size (the
    /// always-run gate in `crates/core/tests/memory_gate.rs` uses values chosen to
    /// plausibly exceed the 4 GB ceiling against the pre-fix engine without an
    /// impractical runtime).
    #[must_use]
    pub fn memory_probe(seed: u64, reference_hours: f64, clip_count: usize) -> Self {
        Self {
            seed,
            reference_hours,
            clip_count,
            clip_seconds_min: 60.0,
            clip_seconds_max: 300.0,
            rate: sundaysync_analysis_rate(),
        }
    }
}

/// The engine's analysis rate, duplicated as a literal rather than a dependency.
///
/// `fixturegen` deliberately does not depend on `sundaysync-core` (see Cargo.toml) so
/// that fixture generation can never inherit a bug from the engine it exists to test.
/// 12 kHz is `sundaysync_core::ANALYSIS_RATE`, pinned by that crate's own tests; if it
/// ever changes, [`DaySpec::memory_probe`]'s disk-size saving becomes an approximation
/// rather than an exact match, which only ever costs a slightly-off fixture size, never
/// correctness.
const fn sundaysync_analysis_rate() -> u32 {
    12_000
}

/// A pure function of (seed, rate, absolute sample index) — the property that lets a
/// clip be generated as a genuine slice of the reference without materialising or
/// replaying anything before it.
///
/// `splitmix64`-derived, like [`crate::rng::Rng`]'s seeding, but keyed on the index
/// itself rather than call order, so evaluating index 5 and then index 3 gives the same
/// answer as the reverse order — an ordinary sequential RNG cannot offer that.
fn hash_u64(mut x: u64) -> u64 {
    x ^= x >> 30;
    x = x.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

/// Standard-normal draw for absolute index `i`, independent of every other index.
fn indexed_normal(seed: u64, i: u64) -> f64 {
    let a = hash_u64(seed ^ i.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let b = hash_u64(a);
    let u1 = ((a >> 11) as f64 * (1.0 / 9_007_199_254_740_992.0)).max(f64::MIN_POSITIVE);
    let u2 = (b >> 11) as f64 * (1.0 / 9_007_199_254_740_992.0);
    (-2.0 * u1.ln()).sqrt() * (TAU * u2).cos()
}

/// Five detuned tonal partials, drawn once from the seed — the same construction as
/// `signal::tonal_bed`'s voices, kept small and cheap to recompute per call.
fn voices(seed: u64) -> [(f64, f64, f64); 5] {
    let mut out = [(0.0, 0.0, 0.0); 5];
    for (i, slot) in out.iter_mut().enumerate() {
        // Same three-way splitmix64 draw `Rng::new` uses, keyed so each voice is
        // independent of the others and of the noise stream above.
        let base_bits = hash_u64(seed ^ ((i as u64) << 32) ^ 0x1);
        let amp_bits = hash_u64(seed ^ ((i as u64) << 32) ^ 0x2);
        let phase_bits = hash_u64(seed ^ ((i as u64) << 32) ^ 0x3);
        let unit = |b: u64| (b >> 11) as f64 * (1.0 / 9_007_199_254_740_992.0);
        let base = (80.0 + unit(base_bits) * 180.0) * (i as f64 + 1.0);
        let amp = 0.03 + unit(amp_bits) * 0.07;
        let phase = unit(phase_bits) * TAU;
        *slot = (base, amp, phase);
    }
    out
}

/// The broadband value at absolute sample index `i`, for a stream generated at `rate`.
fn sample_at(seed: u64, voices: &[(f64, f64, f64); 5], rate_f: f64, i: u64) -> f32 {
    let t = i as f64 / rate_f;
    let mut v = 0.0;
    for (freq, amp, phase) in voices {
        let f = freq * (1.0 + 0.002 * (t * 0.7).sin());
        v += amp * (TAU * f * t + phase).sin();
    }
    // A little band-limiting on the indexed noise (averaging two adjacent draws) keeps
    // it from sounding like pure hiss, while staying O(1) and index-local.
    let n0 = indexed_normal(seed, i);
    let n1 = indexed_normal(seed, i.wrapping_add(1));
    v += (n0 + n1) * 0.5 * 0.35;
    (v * 0.6) as f32
}

/// Streams `count` samples starting at absolute index `start` into `writer`, in bounded
/// chunks.
fn stream_into(
    writer: &mut StreamingWavWriter,
    seed: u64,
    voices: &[(f64, f64, f64); 5],
    rate_f: f64,
    start: u64,
    count: usize,
) -> std::io::Result<()> {
    let mut buf = vec![0.0f32; CHUNK_SAMPLES.min(count.max(1))];
    let mut done = 0usize;
    while done < count {
        let this = buf.len().min(count - done);
        for (k, slot) in buf.iter_mut().take(this).enumerate() {
            *slot = sample_at(seed, voices, rate_f, start + (done + k) as u64);
        }
        writer.write_chunk(&buf[..this])?;
        done += this;
    }
    Ok(())
}

/// Emits the day into `dir`: `reference.wav` plus `clip_NNNN.wav`, and a `truth.json` in
/// the same shape [`crate::shoot::emit`] produces, so the same `bench`/measurement code
/// can read either.
///
/// Every clip is a genuine slice of the reference (see the module doc), so this is not
/// only a volume fixture — a correlator run over it can actually place clips, which lets
/// the §7.7 memory gate exercise the real pass-1/pass-2 code paths rather than only the
/// early-refusal ones.
pub fn emit_day(spec: &DaySpec, dir: &Path) -> Result<Truth, EmitError> {
    std::fs::create_dir_all(dir)?;
    let rate_f = f64::from(spec.rate);
    let voices = voices(spec.seed);

    let ref_seconds = spec.reference_hours * 3600.0;
    let ref_samples = (ref_seconds * rate_f) as usize;
    let ref_path = dir.join("reference.wav");
    let mut ref_writer = StreamingWavWriter::create(&ref_path, ref_samples, spec.rate)?;
    stream_into(&mut ref_writer, spec.seed, &voices, rate_f, 0, ref_samples)?;
    ref_writer.finish()?;

    let mut clips = vec![TruthClip {
        file: "reference.wav".into(),
        device: "recorder".into(),
        codec: Codec::Wav,
        offset_seconds: 0.0,
        duration_seconds: ref_seconds,
        drift_ppm: 0.0,
        snr_db: None,
        uncorrelated: false,
    }];

    // A small, deterministic PRNG for clip placement only (start time, length, device)
    // — separate from the per-sample content generator above, whose determinism
    // property is index-purity, not call-order.
    //
    // `clip_seconds_max` is clamped to a fraction of the reference: a clip must fit
    // inside the reference it is a slice of. `spec.clip_seconds_max` is tuned for
    // hours-scale references (`full_day`); a small test-scale `memory_probe` reference
    // would otherwise let the draw exceed the whole reference length.
    let mut placement_rng = crate::rng::Rng::new(spec.seed).fork("day-clip-placement");
    let clip_upper = spec.clip_seconds_max.min((ref_seconds * 0.9).max(1.0));
    let clip_lower = spec.clip_seconds_min.min(clip_upper).max(0.1);
    for i in 0..spec.clip_count {
        let clip_seconds = if clip_upper > clip_lower {
            placement_rng.range(clip_lower, clip_upper)
        } else {
            clip_upper
        };
        let latest_start = (ref_seconds - clip_seconds).max(0.0);
        let start_seconds = if latest_start > 0.0 {
            placement_rng.range(0.0, latest_start)
        } else {
            0.0
        };
        let clip_samples = (clip_seconds * rate_f) as usize;
        let start_index = (start_seconds * rate_f) as u64;

        let name = format!("clip_{i:04}.wav");
        let path = dir.join(&name);
        let mut writer = StreamingWavWriter::create(&path, clip_samples, spec.rate)?;
        stream_into(
            &mut writer,
            spec.seed,
            &voices,
            rate_f,
            start_index,
            clip_samples,
        )?;
        writer.finish()?;

        // A handful of device lanes rather than one, so placement/grouping is exercised
        // the way a real multi-camera day would — but few enough that a same-device
        // overlap (two clips scattered onto the same lane by chance) is an expected,
        // handled outcome (`device_overlap`, §5) rather than something the test needs to
        // avoid.
        let device = format!("cam-{}", i % 4);
        clips.push(TruthClip {
            file: name,
            device,
            codec: Codec::Wav,
            offset_seconds: start_seconds,
            duration_seconds: clip_seconds,
            drift_ppm: 0.0,
            snr_db: None,
            uncorrelated: false,
        });
    }

    clips.sort_by(|a, b| a.file.cmp(&b.file));
    let truth = Truth {
        name: "day".into(),
        seed: spec.seed,
        master_rate: spec.rate,
        duration_seconds: ref_seconds,
        clips,
    };
    let json = serde_json::to_string_pretty(&truth).map_err(EmitError::Json)?;
    std::fs::write(dir.join("truth.json"), json)?;
    Ok(truth)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join("sundaysync-tests").join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sample_at_is_a_pure_function_of_its_index() {
        // The property the whole module depends on: evaluating out of order gives the
        // same answer, so a clip can be generated as a slice without replaying anything
        // before it.
        let v = voices(7);
        let a = sample_at(7, &v, 12_000.0, 500_000);
        let b = sample_at(7, &v, 12_000.0, 500_000);
        assert_eq!(a, b);
        // And evaluating neighbours first must not perturb it.
        let _ = sample_at(7, &v, 12_000.0, 1);
        let _ = sample_at(7, &v, 12_000.0, 999_999);
        let c = sample_at(7, &v, 12_000.0, 500_000);
        assert_eq!(a, c);
    }

    #[test]
    fn an_emitted_clip_is_byte_identical_to_the_reference_at_its_truth_offset() {
        // The property that matters in practice, checked at the file level rather than
        // through the generator function directly: a real correlator run against these
        // files must be able to find a genuine match, not merely same-shaped noise.
        let dir = scratch("day-slice-check");
        let spec = DaySpec::memory_probe(1, 0.02, 3);
        let truth = emit_day(&spec, &dir).unwrap();

        let ref_bytes = std::fs::read(dir.join("reference.wav")).unwrap();
        for clip in truth.clips.iter().filter(|c| c.file != "reference.wav") {
            let clip_bytes = std::fs::read(dir.join(&clip.file)).unwrap();
            let start_sample = (clip.offset_seconds * f64::from(spec.rate)) as usize;
            let start_byte = 44 + start_sample * 2;
            let clip_data = &clip_bytes[44..];
            let ref_slice = &ref_bytes[start_byte..start_byte + clip_data.len()];
            assert_eq!(
                clip_data, ref_slice,
                "{} is not a byte-identical slice of the reference at its truth offset",
                clip.file
            );
        }
    }

    #[test]
    fn emit_day_produces_the_right_file_count_and_truth() {
        let dir = scratch("day-basic");
        let spec = DaySpec::memory_probe(1, 0.02, 3); // ~72 s reference, 3 clips — fast
        let truth = emit_day(&spec, &dir).unwrap();

        assert_eq!(truth.clips.len(), 4, "1 reference + 3 clips");
        assert!(dir.join("reference.wav").is_file());
        assert!(dir.join("clip_0000.wav").is_file());
        assert!(dir.join("clip_0002.wav").is_file());
        assert!(dir.join("truth.json").is_file());

        let ref_bytes = std::fs::read(dir.join("reference.wav")).unwrap();
        assert_eq!(&ref_bytes[0..4], b"RIFF");
    }

    #[test]
    fn emit_day_is_deterministic() {
        let seed = 5;
        let spec = DaySpec::memory_probe(seed, 0.01, 2);
        let a = scratch("day-det-a");
        let b = scratch("day-det-b");
        let ta = emit_day(&spec, &a).unwrap();
        let tb = emit_day(&spec, &b).unwrap();
        assert_eq!(
            serde_json::to_string(&ta).unwrap(),
            serde_json::to_string(&tb).unwrap()
        );
        assert_eq!(
            std::fs::read(a.join("reference.wav")).unwrap(),
            std::fs::read(b.join("reference.wav")).unwrap()
        );
    }

    #[test]
    fn full_day_matches_the_7_7_target() {
        let spec = DaySpec::full_day(1);
        assert_eq!(spec.reference_hours, 20.0);
        assert_eq!(spec.clip_count, 199, "1 reference + 199 clips = 200 files");
    }
}
