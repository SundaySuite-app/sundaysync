//! Shoot specification, emission, and ground truth — docs/PLAN.md §8.1.
//!
//! A shoot is one synthetic event: a master audio timeline, plus several devices that
//! each captured parts of it through their own colouring. Every emitted file records the
//! offset it was cut at, and that `truth.json` is what §8.2's accuracy gates measure
//! against.

use crate::rng::Rng;
use crate::signal::{self, Colour, MASTER_RATE};
use crate::wav;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Container/codec to emit.
///
/// The spread is not decoration — it is the direct mitigation for docs/DECISIONS.md
/// D-004. A 3.000 s AAC file decodes to 3.008 s because of encoder priming, and the
/// §8.2 gate is ±10 ms; a wav-only suite would pass green while the product mis-synced
/// every real camera. Every tier therefore spans lossless, lossy, and a long-GOP video
/// container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Codec {
    /// 16-bit PCM. The recorder/mixer feed, and the control case with no codec delay.
    Wav,
    /// FLAC — lossless, but still a real decoder path.
    Flac,
    /// Bare AAC in MP4. The D-004 case.
    Aac,
    /// H.264 video + AAC audio. What a camera actually writes.
    Mp4,
}

impl Codec {
    #[must_use]
    pub fn extension(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Aac => "m4a",
            Self::Mp4 => "mp4",
        }
    }

    #[must_use]
    pub fn is_lossless(self) -> bool {
        matches!(self, Self::Wav | Self::Flac)
    }
}

/// One recorded segment: where in the event it starts, and how long it runs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClipSpec {
    pub start_seconds: f64,
    pub duration_seconds: f64,
}

/// One recording device.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceSpec {
    pub id: String,
    pub codec: Codec,
    pub colour: Colour,
    /// Clips in event time. Non-overlapping, matching the §4.4 same-device invariant.
    pub clips: Vec<ClipSpec>,
}

/// A complete synthetic shoot.
#[derive(Debug, Clone, PartialEq)]
pub struct ShootSpec {
    pub name: String,
    pub seed: u64,
    pub duration_seconds: f64,
    pub devices: Vec<DeviceSpec>,
}

/// Ground truth for one emitted file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TruthClip {
    pub file: String,
    pub device: String,
    pub codec: Codec,
    /// True start in event time. The engine reports offsets relative to whichever file
    /// it picks as reference, so comparisons must be made on *differences* of these.
    ///
    /// `f64::NAN` for an `uncorrelated` file, which has no true start at all.
    /// `serde_json` writes a non-finite float as `null` but — asymmetrically — refuses
    /// to read `null` back into an `f64`, so a `truth.json` containing the §8.1
    /// no-correlation case could be *written* by this type and not *parsed* by it. That
    /// broke the contract this file's own module doc states (the emitted `truth.json` is
    /// "the same shape" every consumer reads) and would have failed the moment anything
    /// pointed `serde_json::from_str::<Truth>` at a `fixturegen`-produced corpus — which
    /// `crates/core/tests/concurrency.rs` already does, on shoots that happen not to
    /// carry the uncorrelated file yet. Reading `null` back as NaN closes it without
    /// changing the on-disk shape or any consumer's field type.
    #[serde(deserialize_with = "offset_or_nan")]
    pub offset_seconds: f64,
    pub duration_seconds: f64,
    pub drift_ppm: f64,
    pub snr_db: Option<f64>,
    /// True when the audio is unrelated to the event and must land in `unsynced`.
    pub uncorrelated: bool,
}

/// Reads `TruthClip::offset_seconds`, mapping the `null` a non-finite float serialises to
/// back onto `f64::NAN`. See that field's documentation for why it exists.
fn offset_or_nan<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<f64>::deserialize(deserializer)?.unwrap_or(f64::NAN))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Truth {
    pub name: String,
    pub seed: u64,
    pub master_rate: u32,
    pub duration_seconds: f64,
    pub clips: Vec<TruthClip>,
}

impl Truth {
    #[must_use]
    pub fn find(&self, file: &str) -> Option<&TruthClip> {
        self.clips.iter().find(|c| c.file == file)
    }
}

/// Errors from emitting a shoot.
#[derive(Debug)]
pub enum EmitError {
    Io(std::io::Error),
    Encode { file: String, detail: String },
    Json(serde_json::Error),
}

impl std::fmt::Display for EmitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "io: {e}"),
            Self::Encode { file, detail } => write!(f, "encoding {file}: {detail}"),
            Self::Json(e) => write!(f, "json: {e}"),
        }
    }
}

impl From<std::io::Error> for EmitError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// Generates the shoot into `dir`, returning the ground truth.
///
/// `ffmpeg` is the path to the encoder; only non-WAV codecs need it.
pub fn emit(spec: &ShootSpec, dir: &Path, ffmpeg: &Path) -> Result<Truth, EmitError> {
    std::fs::create_dir_all(dir)?;
    let mut rng = Rng::new(spec.seed);
    let master = signal::generate_master(&mut rng, spec.duration_seconds, MASTER_RATE);

    let mut clips = Vec::new();

    for device in &spec.devices {
        // Fork per device id, so adding or removing a device does not perturb what any
        // other device's audio looks like. Without this, every fixture in the suite
        // would shift the moment the spec gained one camera.
        let mut drng = Rng::new(spec.seed).fork(&device.id);

        for (i, clip) in device.clips.iter().enumerate() {
            let start = (clip.start_seconds * f64::from(MASTER_RATE)) as usize;
            let len = (clip.duration_seconds * f64::from(MASTER_RATE)) as usize;
            let end = (start + len).min(master.len());
            let slice: &[f32] = master.get(start..end).unwrap_or(&[]);

            let audio = signal::colour(slice, &device.colour, MASTER_RATE, &mut drng);
            let name = format!("{}_{:04}.{}", device.id, i + 1, device.codec.extension());
            write_clip(dir, &name, &audio, device.codec, ffmpeg)?;

            clips.push(TruthClip {
                file: name,
                device: device.id.clone(),
                codec: device.codec,
                offset_seconds: clip.start_seconds,
                duration_seconds: clip.duration_seconds,
                drift_ppm: device.colour.drift_ppm,
                snr_db: device.colour.snr_db,
                uncorrelated: false,
            });
        }
    }

    // Deterministic order regardless of spec ordering (§3).
    clips.sort_by(|a, b| a.file.cmp(&b.file));

    let truth = Truth {
        name: spec.name.clone(),
        seed: spec.seed,
        master_rate: MASTER_RATE,
        duration_seconds: spec.duration_seconds,
        clips,
    };
    let json = serde_json::to_string_pretty(&truth).map_err(EmitError::Json)?;
    std::fs::write(dir.join("truth.json"), json)?;
    Ok(truth)
}

/// Adds a file whose audio has nothing to do with the event.
///
/// §8.1 requires "files with no correlation at all (must land in unsynced)". This is the
/// single most important negative case in the suite: §8.2 demands **zero** false
/// placements, and a correlator that never says "I don't know" would pass every positive
/// test while being useless in production.
pub fn emit_uncorrelated(
    truth: &mut Truth,
    dir: &Path,
    name: &str,
    seconds: f64,
    seed: u64,
    codec: Codec,
    ffmpeg: &Path,
) -> Result<(), EmitError> {
    let mut rng = Rng::new(seed ^ 0xDEAD_BEEF);
    let audio = signal::generate_master(&mut rng, seconds, MASTER_RATE);
    let file = format!("{name}.{}", codec.extension());
    write_clip(dir, &file, &audio, codec, ffmpeg)?;

    truth.clips.push(TruthClip {
        file,
        device: "unrelated".into(),
        codec,
        offset_seconds: f64::NAN,
        duration_seconds: seconds,
        drift_ppm: 0.0,
        snr_db: None,
        uncorrelated: true,
    });
    truth.clips.sort_by(|a, b| a.file.cmp(&b.file));

    let json = serde_json::to_string_pretty(truth).map_err(EmitError::Json)?;
    std::fs::write(dir.join("truth.json"), json)?;
    Ok(())
}

fn write_clip(
    dir: &Path,
    name: &str,
    audio: &[f32],
    codec: Codec,
    ffmpeg: &Path,
) -> Result<(), EmitError> {
    let target = dir.join(name);
    if codec == Codec::Wav {
        wav::write_mono(&target, audio, MASTER_RATE)?;
        return Ok(());
    }

    // Everything else goes through a WAV intermediate, so exactly one code path produces
    // the samples and the codecs differ only in how they are packaged.
    let temp = dir.join(format!("{name}.src.wav"));
    wav::write_mono(&temp, audio, MASTER_RATE)?;

    let mut args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-i".into(),
        temp.to_string_lossy().into_owned(),
    ];
    match codec {
        Codec::Wav => unreachable!(),
        Codec::Flac => args.extend(["-c:a".into(), "flac".into()]),
        Codec::Aac => args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]),
        Codec::Mp4 => {
            // A real camera file: long-GOP H.264 alongside the audio. Tiny frame size —
            // nothing reads the pictures, but the container and its interleaving are the
            // point.
            args.extend([
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=gray:size=128x72:rate=25".into(),
                "-shortest".into(),
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "ultrafast".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-g".into(),
                "50".into(),
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
            ]);
        }
    }
    args.push("-y".into());
    args.push(target.to_string_lossy().into_owned());

    let out = std::process::Command::new(ffmpeg)
        .args(&args)
        .output()
        .map_err(|e| EmitError::Encode {
            file: name.to_string(),
            detail: e.to_string(),
        })?;
    let _ = std::fs::remove_file(&temp);

    if !out.status.success() {
        return Err(EmitError::Encode {
            file: name.to_string(),
            detail: String::from_utf8_lossy(&out.stderr)
                .lines()
                .next()
                .unwrap_or("ffmpeg failed")
                .to_string(),
        });
    }
    Ok(())
}

// ---- Built-in suites ------------------------------------------------------------

/// The `quick` tier — seconds to build and run, on every CI push (§8.1).
///
/// Deliberately small but not easy: three devices with genuinely different colouring, a
/// camera that stops and restarts, one lossy and one lossless codec, and drift on one
/// device. If this passes, the engine works; if it is slow, CI stops being run.
#[must_use]
pub fn quick_suite(seed: u64) -> ShootSpec {
    ShootSpec {
        name: "quick".into(),
        seed,
        duration_seconds: 90.0,
        devices: vec![
            // The recorder feed: whole event, clean, lossless. Becomes the reference.
            DeviceSpec {
                id: "recorder".into(),
                codec: Codec::Wav,
                colour: Colour {
                    gain_db: 0.0,
                    tilt: 0.0,
                    reverb: 0.05,
                    snr_db: Some(45.0),
                    drift_ppm: 0.0,
                },
                clips: vec![ClipSpec {
                    start_seconds: 0.0,
                    duration_seconds: 90.0,
                }],
            },
            // A camera near the back: dark, reverberant, noisy — the hard case §4.3
            // exists for. Stops and restarts partway.
            DeviceSpec {
                id: "cam-balcony".into(),
                codec: Codec::Aac,
                colour: Colour {
                    gain_db: -9.0,
                    tilt: -0.5,
                    reverb: 0.55,
                    snr_db: Some(12.0),
                    drift_ppm: 0.0,
                },
                clips: vec![
                    ClipSpec {
                        start_seconds: 5.0,
                        duration_seconds: 35.0,
                    },
                    ClipSpec {
                        start_seconds: 48.0,
                        duration_seconds: 38.0,
                    },
                ],
            },
            // A close camera with a bright on-board mic and a drifting clock.
            DeviceSpec {
                id: "cam-stage".into(),
                codec: Codec::Flac,
                colour: Colour {
                    gain_db: -3.0,
                    tilt: 0.4,
                    reverb: 0.2,
                    snr_db: Some(24.0),
                    drift_ppm: 40.0,
                },
                clips: vec![ClipSpec {
                    start_seconds: 12.5,
                    duration_seconds: 60.0,
                }],
            },
        ],
    }
}

/// The `full` tier — minutes, run nightly and pre-release (§8.1).
///
/// Adds what `quick` cannot afford: longer files, four-plus devices, heavier start/stop
/// patterns, an MP4 camera file, near-silence, and worse SNRs.
#[must_use]
pub fn full_suite(seed: u64) -> ShootSpec {
    let mut spec = quick_suite(seed);
    spec.name = "full".into();
    spec.duration_seconds = 600.0;

    if let Some(d) = spec.devices.first_mut() {
        d.clips = vec![ClipSpec {
            start_seconds: 0.0,
            duration_seconds: 600.0,
        }];
    }
    if let Some(d) = spec.devices.get_mut(1) {
        d.clips = vec![
            ClipSpec {
                start_seconds: 8.0,
                duration_seconds: 180.0,
            },
            ClipSpec {
                start_seconds: 200.0,
                duration_seconds: 150.0,
            },
            ClipSpec {
                start_seconds: 360.0,
                duration_seconds: 220.0,
            },
        ];
    }
    if let Some(d) = spec.devices.get_mut(2) {
        d.clips = vec![ClipSpec {
            start_seconds: 30.0,
            duration_seconds: 400.0,
        }];
    }

    // A real camera container, badly placed in the room.
    spec.devices.push(DeviceSpec {
        id: "cam-wide".into(),
        codec: Codec::Mp4,
        colour: Colour {
            gain_db: -14.0,
            tilt: -0.3,
            reverb: 0.7,
            snr_db: Some(8.0),
            drift_ppm: -25.0,
        },
        clips: vec![
            ClipSpec {
                start_seconds: 15.0,
                duration_seconds: 280.0,
            },
            ClipSpec {
                start_seconds: 310.0,
                duration_seconds: 250.0,
            },
        ],
    });

    // A phone on a windowsill: quiet, distant, and the worst SNR in the suite.
    spec.devices.push(DeviceSpec {
        id: "cam-phone".into(),
        codec: Codec::Mp4,
        colour: Colour {
            gain_db: -22.0,
            tilt: 0.2,
            reverb: 0.8,
            snr_db: Some(4.0),
            drift_ppm: 60.0,
        },
        clips: vec![ClipSpec {
            start_seconds: 120.0,
            duration_seconds: 300.0,
        }],
    });

    spec
}

/// Where a suite's fixtures live, keyed by tier and seed so tiers cannot collide.
#[must_use]
pub fn suite_dir(root: &Path, name: &str, seed: u64) -> PathBuf {
    root.join(format!("{name}-{seed:016x}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_truth_json_carrying_the_uncorrelated_case_round_trips() {
        // The §8.1 no-correlation file has no true start, recorded as NaN — which
        // `serde_json` writes as `null` and refuses to read back into an `f64`. Every
        // `truth.json` the `fixturegen` binary emits carries exactly that clip, so
        // without the field's `deserialize_with` this type could write a corpus it could
        // not then read. `concurrency.rs` parses `shoot::Truth` from disk today.
        let truth = Truth {
            name: "quick".into(),
            seed: 1,
            master_rate: MASTER_RATE,
            duration_seconds: 90.0,
            clips: vec![
                TruthClip {
                    file: "recorder_0001.wav".into(),
                    device: "recorder".into(),
                    codec: Codec::Wav,
                    offset_seconds: 0.0,
                    duration_seconds: 90.0,
                    drift_ppm: 0.0,
                    snr_db: Some(45.0),
                    uncorrelated: false,
                },
                TruthClip {
                    file: "unrelated.wav".into(),
                    device: "unrelated".into(),
                    codec: Codec::Wav,
                    offset_seconds: f64::NAN,
                    duration_seconds: 25.0,
                    drift_ppm: 0.0,
                    snr_db: None,
                    uncorrelated: true,
                },
            ],
        };

        let json = serde_json::to_string_pretty(&truth).unwrap();
        assert!(
            json.contains("\"offset_seconds\": null"),
            "the on-disk shape must not change: {json}"
        );
        let back: Truth = serde_json::from_str(&json).expect("truth.json must parse back");

        assert_eq!(back.clips.len(), 2);
        assert_eq!(back.clips[0].offset_seconds, 0.0);
        assert!(
            back.clips[1].offset_seconds.is_nan(),
            "the uncorrelated clip's absent offset must read back as NaN"
        );
        assert!(back.clips[1].uncorrelated);
    }

    #[test]
    fn quick_suite_is_shaped_for_the_hard_cases() {
        let s = quick_suite(1);
        assert!(s.devices.len() >= 3);

        // D-004: the suite must span codecs, or per-codec decoder delay passes CI unseen.
        let codecs: std::collections::BTreeSet<_> = s.devices.iter().map(|d| d.codec).collect();
        assert!(codecs.len() >= 3, "too few codecs: {codecs:?}");
        assert!(codecs.iter().any(|c| c.is_lossless()));
        assert!(codecs.iter().any(|c| !c.is_lossless()));

        // At least one device that stops and restarts, one that drifts, one that is
        // genuinely hard to hear.
        assert!(s.devices.iter().any(|d| d.clips.len() > 1));
        assert!(s.devices.iter().any(|d| d.colour.drift_ppm.abs() > 0.0));
        assert!(s
            .devices
            .iter()
            .any(|d| d.colour.snr_db.is_some_and(|x| x <= 15.0)));
    }

    #[test]
    fn full_suite_is_a_superset_of_the_quick_one() {
        let q = quick_suite(1);
        let f = full_suite(1);
        assert!(f.duration_seconds > q.duration_seconds);
        assert!(f.devices.len() > q.devices.len());
        assert!(f.devices.iter().any(|d| d.codec == Codec::Mp4));
        // §8.1 asks for worse ambience in the full tier.
        let worst = f
            .devices
            .iter()
            .filter_map(|d| d.colour.snr_db)
            .fold(f64::INFINITY, f64::min);
        assert!(worst <= 5.0, "worst SNR only {worst} dB");
    }

    #[test]
    fn no_device_records_overlapping_clips() {
        // §4.4's same-device invariant: cameras record sequentially. A spec that
        // violated it would make the engine's overlap rejection look like a bug.
        for spec in [quick_suite(1), full_suite(1)] {
            for d in &spec.devices {
                let mut sorted = d.clips.clone();
                sorted.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
                for w in sorted.windows(2) {
                    let end = w[0].start_seconds + w[0].duration_seconds;
                    assert!(
                        end <= w[1].start_seconds,
                        "{} overlaps itself at {end}",
                        d.id
                    );
                }
            }
        }
    }

    #[test]
    fn every_clip_fits_inside_the_event() {
        for spec in [quick_suite(1), full_suite(1)] {
            for d in &spec.devices {
                for c in &d.clips {
                    assert!(
                        c.start_seconds + c.duration_seconds <= spec.duration_seconds + 1e-9,
                        "{} runs past the end of the event",
                        d.id
                    );
                }
            }
        }
    }

    #[test]
    fn the_reference_candidate_is_the_longest_file() {
        // §4.4 picks the longest audio as reference, preferring wav. The suites are
        // built so that lands on the recorder feed, as it would in a real shoot.
        for spec in [quick_suite(1), full_suite(1)] {
            let longest = spec
                .devices
                .iter()
                .flat_map(|d| d.clips.iter().map(move |c| (d, c.duration_seconds)))
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(d, _)| d.id.clone());
            assert_eq!(longest.as_deref(), Some("recorder"));
        }
    }
}
