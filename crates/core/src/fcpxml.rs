//! FCPXML export for DaVinci Resolve — docs/PLAN.md §6.
//!
//! Produces one `.fcpxml` referencing the media in place. Nothing is ever copied, moved
//! or re-encoded: the file is a description of *where things go*, and Resolve does the
//! editing (§2).
//!
//! # Time is rational, everywhere
//!
//! FCPXML expresses every time as `num/den s`. That is not a formatting preference — it
//! is the only way to be exact at NTSC rates, where a frame is `1001/30000` of a second
//! and no finite decimal will do. Every duration and offset here is built from integer
//! arithmetic on a chosen timebase, and `f64` never touches a value that ends up in the
//! file.

use crate::drift::Drift;
use crate::result::{DeviceKind, SyncResult};
use std::collections::BTreeMap;
use std::path::Path;

/// The FCPXML version targeted. 1.10 is broadly supported by current Resolve releases.
pub const FCPXML_VERSION: &str = "1.10";

/// Timebase for audio-only positions, in ticks per second.
///
/// 48 000 is a common audio rate and divides evenly into the sample positions the engine
/// works with, so audio can be placed with sub-frame precision as §6 asks. Whether
/// Resolve *honours* that or quantises to frames on import is an open question — see
/// docs/KNOWN_LIMITATIONS.md.
pub const AUDIO_TIMEBASE: u32 = 48_000;

/// How a clip's position was rounded, so §6's residual can be reported.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SnapResidual {
    pub residual_ms: f64,
}

/// Export-time behaviour toggles that are not part of the §5 `SyncResult` contract.
///
/// Kept separate from `SyncResult` on purpose: the schema is frozen (§0), while these are
/// UI-driven run switches. The shell reads them off the [`crate::SyncRequest`] it already
/// holds and passes them here at export time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportOptions {
    /// E6 / D-042: emit a `<timeMap>` on clips whose measured drift exceeds half a frame,
    /// correcting the clock drift D-016 flags. `false` reproduces v1 output exactly.
    pub correct_drift: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        // Matches `SyncRequest::correct_drift`: on by default (D-042).
        Self {
            correct_drift: true,
        }
    }
}

/// The retime a corrected clip carries (E6 / D-042).
///
/// A `<timeMap>` mapping the clip's timeline span onto its source span. Both endpoints are
/// integer ticks over [`AUDIO_TIMEBASE`], deliberately *not* frame-aligned: the D-022 spike
/// proved Resolve preserves a sub-frame `<timept>` exactly (a +250 ppm map round-tripped as
/// `12003/200s`), and it is the ratio, not the cosmetic frame-quantised clip boundary, that
/// drives the audio resample.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeMap {
    /// Timeline end of the clip, i.e. `source_end_ticks × (1 + ppm·1e-6)`, rounded to the
    /// nearest audio tick. The source plays back at the reciprocal rate (D-019).
    pub timeline_end_ticks: i64,
    /// Source end of the clip — its true recorded length in audio ticks.
    pub source_end_ticks: i64,
}

/// One exported clip's placement on the timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportedClip {
    pub file: std::path::PathBuf,
    pub lane: i32,
    pub offset_ticks: i64,
    pub duration_ticks: i64,
    pub residual: Option<SnapResidual>,
    /// `Some` when this clip was drift-corrected (E6 / D-042). The reference clip and any
    /// clip within half a frame of true carry `None` and export exactly as in v1.
    pub time_map: Option<TimeMap>,
}

/// The outcome of an export.
#[derive(Debug, Clone, PartialEq)]
pub struct Export {
    pub xml: String,
    pub clips: Vec<ExportedClip>,
}

/// Errors that can stop an export.
#[derive(Debug)]
pub enum ExportError {
    /// Nothing was placed, so there is no timeline to describe.
    Empty,
    Xml(String),
}

impl std::fmt::Display for ExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => write!(f, "no clips were placed, so there is nothing to export"),
            Self::Xml(e) => write!(f, "could not write XML: {e}"),
        }
    }
}

/// Renders a `SyncResult` as FCPXML with the default [`ExportOptions`] (drift correction
/// on, D-042).
///
/// `durations` supplies each file's length in seconds — the engine knows these from the
/// probe stage, and the exporter needs them to size clips without re-reading the media.
pub fn export(
    result: &SyncResult,
    durations: &BTreeMap<std::path::PathBuf, f64>,
    project_name: &str,
) -> Result<Export, ExportError> {
    export_with_options(result, durations, project_name, ExportOptions::default())
}

/// Renders a `SyncResult` as FCPXML under explicit [`ExportOptions`].
///
/// The shell calls this with `ExportOptions { correct_drift: request.correct_drift }` so the
/// UI's drift toggle reaches the exporter; the three-argument [`export`] is the same call
/// with the default (correction on).
pub fn export_with_options(
    result: &SyncResult,
    durations: &BTreeMap<std::path::PathBuf, f64>,
    project_name: &str,
    options: ExportOptions,
) -> Result<Export, ExportError> {
    if result.placements.is_empty() {
        return Err(ExportError::Empty);
    }

    let fps = result.sequence.fps;
    let fps_f64 = fps.as_f64();
    // The sequence timebase is the frame rate: every video position is an integer number
    // of frames, which is what keeps `frameDuration` and every offset exactly consistent.
    let timebase = fps.num();
    let frame_ticks = i64::from(fps.den());

    // E6: a clip's drift correction — if any — decides where its *start* belongs, so it has
    // to be known before the origin is chosen. `None` means "export as v1 did".
    let correction_of = |p: &crate::result::Placement| -> Option<Drift> {
        if !options.correct_drift {
            return None;
        }
        let (Some(ppm), Some(err)) = (p.drift_ppm, p.projected_end_error_ms) else {
            return None;
        };
        let d = Drift {
            ppm,
            projected_end_error_ms: err,
            // Not carried in §5 (and not needed here): D-045's gate refuses any placement
            // whose residual exceeded the limit, so a placement that reaches the exporter
            // is credible by construction. Zero is a statement, not a guess.
            residual_mad_ms: 0.0,
        };
        // Only clips past half a frame are corrected; the reference carries no drift and so
        // is never touched. A clip already inside half a frame is left exactly as v1.
        d.exceeds_half_frame(fps_f64).then_some(d)
    };

    // The reference-correct start of a clip: its stored offset for an uncorrected clip, or
    // the median offset re-referenced to the clip start (D-042) for a corrected one.
    let effective_start = |p: &crate::result::Placement| -> f64 {
        match correction_of(p) {
            Some(d) => p.offset_seconds - d.start_reference_shift_seconds(),
            None => p.offset_seconds,
        }
    };

    // §6 places clips relative to a timeline that starts at zero, but offsets are
    // relative to the reference and may be negative — a camera rolling before the
    // recorder was armed. Shift the whole timeline so the earliest clip lands at 0.
    // A corrected clip's *shifted* start is what counts here, so the shift can never push
    // an offset below zero.
    let origin = result
        .placements
        .iter()
        .map(&effective_start)
        .fold(f64::INFINITY, f64::min);
    let origin = if origin.is_finite() { origin } else { 0.0 };

    // ---- Lane assignment (§6) ----------------------------------------------------
    //
    // Video devices take positive lanes, audio negative, with the reference feed on -1.
    // Resolve reads this layout as separate tracks, which is the whole point: one lane
    // per camera is what makes the result editable rather than merely correct.
    let mut video_lane = 0i32;
    let mut audio_lane = 0i32;
    let mut lanes: BTreeMap<String, i32> = BTreeMap::new();

    let reference_device = result.reference.as_ref().map(|r| r.device.clone());
    if let Some(dev) = &reference_device {
        audio_lane -= 1;
        lanes.insert(dev.clone(), audio_lane);
    }
    for device in &result.devices {
        if lanes.contains_key(&device.id) {
            continue;
        }
        let lane = match device.kind {
            DeviceKind::Video => {
                video_lane += 1;
                video_lane
            }
            DeviceKind::Audio => {
                audio_lane -= 1;
                audio_lane
            }
        };
        lanes.insert(device.id.clone(), lane);
    }

    // ---- Clip geometry -----------------------------------------------------------
    let mut clips: Vec<ExportedClip> = Vec::new();
    let mut timeline_end_ticks = 0i64;

    for p in &result.placements {
        let source_seconds = durations.get(&p.file).copied().unwrap_or(0.0);
        let correction = correction_of(p);
        // A corrected clip occupies `stretch` times its source length on the timeline
        // (D-042); an uncorrected clip occupies it 1:1.
        let stretch = correction.map_or(1.0, |d| d.timeline_stretch());
        let position = effective_start(p) - origin;

        // Snap the start to the frame grid and record what the snap cost (§6). For a
        // corrected clip the snapped value is the *re-referenced* start, so the clip's
        // first sample sits where the reference puts it.
        let exact_frames = position * f64::from(timebase) / f64::from(fps.den());
        let frames = exact_frames.round();
        let residual_ms =
            (frames - exact_frames) * (1000.0 * f64::from(fps.den()) / f64::from(timebase));

        let offset_ticks = (frames as i64) * frame_ticks;
        // The clip's *timeline* length is the stretched span; frame-aligned like every
        // other duration in the document (D-021). The `<timeMap>` below carries the exact
        // sub-frame ratio the resample actually uses.
        let timeline_seconds = source_seconds * stretch;
        let duration_frames =
            (timeline_seconds * f64::from(timebase) / f64::from(fps.den())).ceil() as i64;
        let duration_ticks = duration_frames.max(1) * frame_ticks;

        // The retime endpoints, in exact audio ticks (D-042). Rounding to the nearest
        // 1/48000 s costs at most ~10 µs — four orders of magnitude below the ±10 ms gate,
        // and dwarfed by the ≥ half-a-frame drift that made the clip eligible at all.
        let time_map = correction.map(|d| TimeMap {
            timeline_end_ticks: (source_seconds * d.timeline_stretch() * f64::from(AUDIO_TIMEBASE))
                .round() as i64,
            source_end_ticks: (source_seconds * f64::from(AUDIO_TIMEBASE)).round() as i64,
        });

        timeline_end_ticks = timeline_end_ticks.max(offset_ticks + duration_ticks);

        clips.push(ExportedClip {
            file: p.file.clone(),
            lane: lanes.get(&p.device).copied().unwrap_or(0),
            offset_ticks,
            duration_ticks,
            // Sub-millisecond residuals are noise from float rounding, not a real snap.
            residual: (residual_ms.abs() > 0.001).then_some(SnapResidual { residual_ms }),
            time_map,
        });
    }

    clips.sort_by(|a, b| {
        a.offset_ticks
            .cmp(&b.offset_ticks)
            .then_with(|| b.lane.cmp(&a.lane))
            .then_with(|| a.file.cmp(&b.file))
    });

    let xml = render(
        result,
        &clips,
        durations,
        timebase,
        timeline_end_ticks,
        project_name,
    );

    Ok(Export { xml, clips })
}

/// Writes the document.
///
/// Built as a plain string rather than through an XML writer library. The golden tests
/// §8.4 requires compare bytes, and hand-writing keeps element order, attribute order and
/// indentation fixed rather than at the mercy of a library's formatting choices. The
/// escaping this needs is five characters, handled by [`escape`].
fn render(
    result: &SyncResult,
    clips: &[ExportedClip],
    durations: &BTreeMap<std::path::PathBuf, f64>,
    timebase: u32,
    timeline_end_ticks: i64,
    project_name: &str,
) -> String {
    use std::fmt::Write as _;

    let fps = result.sequence.fps;
    let frame_duration = format!("{}/{}s", fps.den(), fps.num());
    let mut s = String::new();

    let _ = writeln!(s, r#"<?xml version="1.0" encoding="UTF-8"?>"#);
    let _ = writeln!(s, "<!DOCTYPE fcpxml>");
    let _ = writeln!(s, r#"<fcpxml version="{FCPXML_VERSION}">"#);
    let _ = writeln!(s, "  <resources>");
    // A single sequence format. Per-asset geometry is not carried in `SyncResult`, so
    // §6's per-format-per-geometry rule is only partly honoured — see D-021.
    let _ = writeln!(
        s,
        r#"    <format id="r0" name="SundaySyncFormat" frameDuration="{frame_duration}" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>"#
    );

    for (i, clip) in clips.iter().enumerate() {
        // Asset durations are frame-aligned too. FCPXML times that are not whole
        // multiples of the frame duration are a common source of importers rejecting or
        // silently rounding a document, and there is nothing to gain from sub-frame
        // precision on an asset's total length.
        let dur = durations.get(&clip.file).copied().unwrap_or(0.0);
        let frame_ticks = i64::from(result.sequence.fps.den());
        let dur_frames =
            (dur * f64::from(timebase) / f64::from(result.sequence.fps.den())).ceil() as i64;
        let dur_ticks = dur_frames.max(1) * frame_ticks;
        let name = clip
            .file
            .file_stem()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        let has_video = i32::from(clip.lane > 0);
        let _ = writeln!(
            s,
            r#"    <asset id="a{i}" name="{}" start="0s" duration="{dur_ticks}/{timebase}s" hasVideo="{has_video}" hasAudio="1" audioSources="1" format="r0">"#,
            escape(&name)
        );
        let _ = writeln!(
            s,
            r#"      <media-rep kind="original-media" src="{}"/>"#,
            file_url(&clip.file)
        );
        let _ = writeln!(s, "    </asset>");
    }
    let _ = writeln!(s, "  </resources>");

    let _ = writeln!(s, "  <library>");
    let _ = writeln!(s, r#"    <event name="SundaySync">"#);
    let _ = writeln!(s, r#"      <project name="{}">"#, escape(project_name));
    let _ = writeln!(
        s,
        r#"        <sequence format="r0" duration="{timeline_end_ticks}/{timebase}s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">"#
    );
    let _ = writeln!(s, "          <spine>");
    // §6: a full-length gap forms the primary storyline and every clip hangs off it as a
    // connected clip. That is what lets clips sit on independent lanes instead of being
    // forced into one sequential track.
    let _ = writeln!(
        s,
        r#"            <gap name="SundaySync Timeline" offset="0s" duration="{timeline_end_ticks}/{timebase}s" start="0s">"#
    );
    for (i, clip) in clips.iter().enumerate() {
        let name = clip
            .file
            .file_stem()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        // An uncorrected clip is self-closing exactly as in v1; a corrected clip opens so it
        // can carry its `<timeMap>` child (E6 / D-042). The `<timept>` times are audio ticks,
        // deliberately a different, finer timebase than the frame-aligned offset/duration —
        // FCPXML times are independent rationals and Resolve keeps the sub-frame ones exact.
        match clip.time_map {
            None => {
                let _ = writeln!(
                    s,
                    r#"              <asset-clip ref="a{i}" lane="{}" offset="{}/{timebase}s" name="{}" duration="{}/{timebase}s" start="0s" format="r0"/>"#,
                    clip.lane,
                    clip.offset_ticks,
                    escape(&name),
                    clip.duration_ticks
                );
            }
            Some(tm) => {
                let _ = writeln!(
                    s,
                    r#"              <asset-clip ref="a{i}" lane="{}" offset="{}/{timebase}s" name="{}" duration="{}/{timebase}s" start="0s" format="r0">"#,
                    clip.lane,
                    clip.offset_ticks,
                    escape(&name),
                    clip.duration_ticks
                );
                let _ = writeln!(s, "                <timeMap>");
                let _ = writeln!(
                    s,
                    r#"                  <timept time="0s" value="0s" interp="linear"/>"#
                );
                let _ = writeln!(
                    s,
                    r#"                  <timept time="{}/{AUDIO_TIMEBASE}s" value="{}/{AUDIO_TIMEBASE}s" interp="linear"/>"#,
                    tm.timeline_end_ticks, tm.source_end_ticks
                );
                let _ = writeln!(s, "                </timeMap>");
                let _ = writeln!(s, "              </asset-clip>");
            }
        }
    }
    let _ = writeln!(s, "            </gap>");
    let _ = writeln!(s, "          </spine>");
    let _ = writeln!(s, "        </sequence>");
    let _ = writeln!(s, "      </project>");
    let _ = writeln!(s, "    </event>");
    let _ = writeln!(s, "  </library>");
    let _ = writeln!(s, "</fcpxml>");
    s
}

/// Percent-encodes a path into a `file://` URL (§6).
///
/// Church media is full of spaces and Norwegian letters; an unencoded URL would produce a
/// file Resolve silently fails to relink. Only the unreserved set of RFC 3986 is left
/// alone, plus `/` as the path separator.
#[must_use]
pub fn file_url(path: &Path) -> String {
    let mut out = String::from("file://");
    let s = path.to_string_lossy();
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Escapes a string for inclusion in an XML attribute value (§6; S-3 / D-032).
///
/// Two jobs. First, the five XML metacharacters are escaped so a filename can never break
/// out of the attribute it sits in — the injection guard, unchanged and load-bearing.
///
/// Second, XML-illegal control characters are stripped. XML 1.0 permits only tab, newline
/// and carriage return below U+0020; every other C0 control (`0x00–0x08`, `0x0B`, `0x0C`,
/// `0x0E–0x1F`) is forbidden *even as a numeric character reference*, so a single bell or
/// NUL in a filename would otherwise yield a non-well-formed document Resolve rejects
/// wholesale — the silent wrongness §7.5 forbids. Those bytes are dropped. The three legal
/// whitespace controls are normalised to a plain space, matching how a parser flattens
/// them inside an attribute value anyway, so a tab or newline in a name cannot introduce a
/// line break into the attribute.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Legal-but-whitespace controls: normalise to a space.
            '\t' | '\n' | '\r' => out.push(' '),
            // XML-illegal C0 controls: not representable at all — drop them.
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rational::Rational;
    use crate::result::{Device, Parameters, Placement, Reference, Sequence, SCHEMA_VERSION};
    use std::path::PathBuf;

    fn sample() -> (SyncResult, BTreeMap<PathBuf, f64>) {
        let mut durations = BTreeMap::new();
        durations.insert(PathBuf::from("/media/rec.wav"), 90.0);
        durations.insert(PathBuf::from("/media/cam a.mp4"), 35.0);
        durations.insert(PathBuf::from("/media/cam-b.mp4"), 40.0);

        let result = SyncResult {
            schema: SCHEMA_VERSION,
            parameters: Parameters {
                analysis_rate: 12_000,
                min_psr: 15.0,
            },
            reference: Some(Reference {
                file: PathBuf::from("/media/rec.wav"),
                device: "rec".into(),
            }),
            devices: vec![
                Device {
                    id: "rec".into(),
                    label: "Zoom".into(),
                    kind: DeviceKind::Audio,
                    files: vec![PathBuf::from("/media/rec.wav")],
                },
                Device {
                    id: "cam-a".into(),
                    label: "A".into(),
                    kind: DeviceKind::Video,
                    files: vec![PathBuf::from("/media/cam a.mp4")],
                },
                Device {
                    id: "cam-b".into(),
                    label: "B".into(),
                    kind: DeviceKind::Video,
                    files: vec![PathBuf::from("/media/cam-b.mp4")],
                },
            ],
            placements: vec![
                Placement {
                    file: PathBuf::from("/media/rec.wav"),
                    device: "rec".into(),
                    offset_seconds: 0.0,
                    confidence: 1.0,
                    psr: f64::INFINITY,
                    drift_ppm: None,
                    projected_end_error_ms: None,
                    chain: vec![],
                    warnings: vec![],
                },
                Placement {
                    file: PathBuf::from("/media/cam a.mp4"),
                    device: "cam-a".into(),
                    offset_seconds: 5.0,
                    confidence: 0.9,
                    psr: 50.0,
                    drift_ppm: None,
                    projected_end_error_ms: None,
                    chain: vec![],
                    warnings: vec![],
                },
                Placement {
                    file: PathBuf::from("/media/cam-b.mp4"),
                    device: "cam-b".into(),
                    offset_seconds: -2.0,
                    confidence: 0.8,
                    psr: 40.0,
                    drift_ppm: None,
                    projected_end_error_ms: None,
                    chain: vec![],
                    warnings: vec![],
                },
            ],
            unsynced: vec![],
            sequence: Sequence {
                fps: Rational::new(25, 1).unwrap(),
                duration_seconds: 92.0,
            },
            warnings: vec![],
        };
        (result, durations)
    }

    #[test]
    fn produces_well_formed_xml_with_the_expected_skeleton() {
        let (r, d) = sample();
        let e = export(&r, &d, "Service").unwrap();

        assert!(e
            .xml
            .starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(e.xml.contains("<!DOCTYPE fcpxml>"));
        assert!(e.xml.contains(r#"<fcpxml version="1.10">"#));
        for tag in [
            "<resources>",
            "<format",
            "<asset ",
            "<media-rep",
            "<library>",
            "<event ",
            "<project ",
            "<sequence ",
            "<spine>",
            "<gap ",
            "<asset-clip ",
        ] {
            assert!(e.xml.contains(tag), "missing {tag}");
        }
        // Every opened element is closed.
        for (open, close) in [
            ("<resources>", "</resources>"),
            ("<library>", "</library>"),
            ("<spine>", "</spine>"),
        ] {
            assert_eq!(
                e.xml.matches(open).count(),
                e.xml.matches(close).count(),
                "{open}"
            );
        }
    }

    #[test]
    fn the_timeline_starts_at_zero_even_with_a_negative_offset() {
        // A camera rolling before the recorder was armed produces a negative offset;
        // FCPXML has no notion of negative timeline positions.
        let (r, d) = sample();
        let e = export(&r, &d, "Service").unwrap();
        assert!(e.clips.iter().all(|c| c.offset_ticks >= 0), "{:?}", e.clips);
        assert_eq!(e.clips.iter().map(|c| c.offset_ticks).min(), Some(0));

        // The clip that was at -2 s must now be the origin, and the reference 2 s in.
        let rec = e
            .clips
            .iter()
            .find(|c| c.file.ends_with("rec.wav"))
            .unwrap();
        // At 25 fps, 2 s is 50 frames; ticks are in the sequence timebase (25), so the
        // written offset reads 50/25s.
        assert_eq!(rec.offset_ticks, 50);
        assert!(
            e.xml.contains(r#"offset="50/25s""#),
            "the reference should sit exactly 2 s in"
        );
    }

    #[test]
    fn frame_durations_are_exact_rationals() {
        // 25 fps -> 1/25s. The NTSC case is the one that matters and is checked below.
        let (r, d) = sample();
        let e = export(&r, &d, "Service").unwrap();
        assert!(
            e.xml.contains(r#"frameDuration="1/25s""#),
            "{}",
            &e.xml[..400]
        );
    }

    #[test]
    fn ntsc_rates_stay_exact() {
        // The whole reason times are rational: 29.97 is 30000/1001, and no decimal
        // representation of it is correct.
        let (mut r, d) = sample();
        r.sequence.fps = Rational::new(30_000, 1001).unwrap();
        let e = export(&r, &d, "Service").unwrap();
        assert!(
            e.xml.contains(r#"frameDuration="1001/30000s""#),
            "NTSC frame duration was not exact"
        );
    }

    #[test]
    fn devices_get_their_own_lanes_with_the_reference_on_minus_one() {
        let (r, d) = sample();
        let e = export(&r, &d, "Service").unwrap();
        let lane_of = |needle: &str| {
            e.clips
                .iter()
                .find(|c| c.file.to_string_lossy().contains(needle))
                .unwrap()
                .lane
        };
        assert_eq!(
            lane_of("rec.wav"),
            -1,
            "the reference feed belongs on lane -1"
        );
        assert!(lane_of("cam a") > 0, "video belongs on a positive lane");
        assert!(lane_of("cam-b") > 0);
        assert_ne!(lane_of("cam a"), lane_of("cam-b"), "one lane per camera");
    }

    #[test]
    fn paths_are_percent_encoded() {
        // Spaces and Norwegian letters are routine in church media, and an unencoded URL
        // produces a file Resolve silently fails to relink.
        assert_eq!(file_url(Path::new("/a/b c.mp4")), "file:///a/b%20c.mp4");
        let nordic = file_url(Path::new("/opptak/Blåveis Ø/C0001.MP4"));
        assert!(
            nordic.starts_with("file:///opptak/Bl%C3%A5veis%20%C3%98/"),
            "{nordic}"
        );
        assert!(!nordic.contains(' '));

        let (r, d) = sample();
        let e = export(&r, &d, "Service").unwrap();
        assert!(
            e.xml.contains("cam%20a.mp4"),
            "space was not encoded in the URL"
        );
    }

    #[test]
    fn xml_special_characters_are_escaped() {
        let (mut r, mut d) = sample();
        let odd = PathBuf::from("/media/Ben & Jerry's <cam>.mp4");
        r.placements[1].file = odd.clone();
        d.insert(odd, 35.0);
        let e = export(&r, &d, "Bob & Alice").unwrap();
        assert!(e.xml.contains("&amp;"), "ampersand not escaped");
        assert!(
            !e.xml.contains("Jerry's <cam>"),
            "raw markup leaked into the file"
        );
    }

    #[test]
    fn the_five_injection_chars_are_escaped_and_nothing_breaks_out() {
        // S-3: the injection guard is unchanged and must stay load-bearing. All five XML
        // metacharacters map to their entities; no raw metacharacter from the name leaks.
        let escaped = escape("a & b < c > d \" e ' f");
        assert_eq!(escaped, "a &amp; b &lt; c &gt; d &quot; e &apos; f");
        // The raw forms are gone (the entity ampersands are the only `&` left).
        assert!(!escaped.contains('<'));
        assert!(!escaped.contains('>'));
        assert!(!escaped.contains('"'));
        assert!(!escaped.contains('\''));
    }

    #[test]
    fn illegal_control_characters_are_stripped_from_the_escaper() {
        // S-3: a bell or NUL in a filename must not survive into the document — XML 1.0
        // forbids these bytes even as a numeric reference, so one of them would make
        // Resolve reject the whole file (silent wrongness, §7.5).
        let out = escape("bell\x07nul\x00vt\x0bff\x0cesc\x1bok");
        // No raw C0 control byte survives at all.
        assert!(
            !out.chars().any(|c| (c as u32) < 0x20),
            "an illegal control byte survived escaping: {out:?}"
        );
        // The surrounding text is intact — the chars were dropped, not the words.
        assert_eq!(out, "bellnulvtffescok");
    }

    #[test]
    fn legal_whitespace_controls_normalise_to_spaces() {
        // Tab/newline/CR are legal in XML but are flattened inside an attribute value; we
        // normalise them so a name cannot smuggle a line break into an attribute.
        let out = escape("a\tb\nc\rd");
        assert_eq!(out, "a b c d");
        assert!(!out.contains('\t') && !out.contains('\n') && !out.contains('\r'));
    }

    #[test]
    fn a_control_char_filename_yields_a_document_with_no_raw_control_bytes() {
        // The integration form of S-3: a placement whose filename mixes the five
        // injection chars with illegal control chars must still render a document that
        // carries no raw control byte anywhere — the property an XML parser checks first.
        let (mut r, mut d) = sample();
        let nasty = PathBuf::from("/media/ring\x07ing & <danger>\x00\x1f.mp4");
        r.placements[1].file = nasty.clone();
        d.insert(nasty, 35.0);
        let e = export(&r, &d, "Bell\x07 & Whistle\x00").unwrap();

        // Only the three legal whitespace controls may appear in a well-formed document;
        // the writer itself emits `\n` between lines, which is legal.
        let stray: Vec<u32> = e
            .xml
            .chars()
            .map(|c| c as u32)
            .filter(|&b| b < 0x20 && b != 0x09 && b != 0x0a && b != 0x0d)
            .collect();
        assert!(
            stray.is_empty(),
            "illegal control bytes reached the document: {stray:?}"
        );
        // And the markup from the name did not break out.
        assert!(!e.xml.contains("<danger>"));
        assert!(e.xml.contains("&amp;"));
    }

    #[test]
    fn an_empty_result_is_an_error_not_an_empty_timeline() {
        let (mut r, d) = sample();
        r.placements.clear();
        assert!(matches!(export(&r, &d, "x"), Err(ExportError::Empty)));
    }

    #[test]
    fn export_is_deterministic() {
        // §13.4 extends to the exporter: the same result must produce the same file.
        let (r, d) = sample();
        let a = export(&r, &d, "Service").unwrap();
        let b = export(&r, &d, "Service").unwrap();
        assert_eq!(a.xml, b.xml);
    }

    #[test]
    fn clips_are_exported_whole() {
        // §6: "Clips are exported whole (start = 0, full duration). No trims in v1."
        let (r, d) = sample();
        let e = export(&r, &d, "Service").unwrap();
        assert!(e.xml.matches(r#"start="0s""#).count() >= e.clips.len());
        for clip in &e.clips {
            assert!(clip.duration_ticks > 0);
        }
    }

    /// A recorder plus one long camera carrying a chosen drift. `ppm`/`err` land straight
    /// onto the camera's `Placement`, exactly as the engine would after `drift::measure`.
    fn drifting_sample(ppm: f64, source_seconds: f64) -> (SyncResult, BTreeMap<PathBuf, f64>) {
        let err_ms = ppm * 1e-6 * source_seconds * 1000.0;
        let mut durations = BTreeMap::new();
        durations.insert(PathBuf::from("/media/rec.wav"), source_seconds + 10.0);
        durations.insert(PathBuf::from("/media/cam.mp4"), source_seconds);

        let result = SyncResult {
            schema: SCHEMA_VERSION,
            parameters: Parameters {
                analysis_rate: 12_000,
                min_psr: 15.0,
            },
            reference: Some(Reference {
                file: PathBuf::from("/media/rec.wav"),
                device: "rec".into(),
            }),
            devices: vec![
                Device {
                    id: "rec".into(),
                    label: "Zoom".into(),
                    kind: DeviceKind::Audio,
                    files: vec![PathBuf::from("/media/rec.wav")],
                },
                Device {
                    id: "cam".into(),
                    label: "A".into(),
                    kind: DeviceKind::Video,
                    files: vec![PathBuf::from("/media/cam.mp4")],
                },
            ],
            placements: vec![
                Placement {
                    file: PathBuf::from("/media/rec.wav"),
                    device: "rec".into(),
                    offset_seconds: 0.0,
                    confidence: 1.0,
                    psr: f64::INFINITY,
                    drift_ppm: None,
                    projected_end_error_ms: None,
                    chain: vec![],
                    warnings: vec![],
                },
                Placement {
                    file: PathBuf::from("/media/cam.mp4"),
                    device: "cam".into(),
                    offset_seconds: 20.0,
                    confidence: 0.9,
                    psr: 50.0,
                    drift_ppm: Some(ppm),
                    projected_end_error_ms: Some(err_ms),
                    chain: vec![],
                    warnings: vec![],
                },
            ],
            unsynced: vec![],
            sequence: Sequence {
                fps: Rational::new(25, 1).unwrap(),
                duration_seconds: source_seconds + 10.0,
            },
            warnings: vec![],
        };
        (result, durations)
    }

    #[test]
    fn a_clip_past_half_a_frame_gets_a_timemap_and_a_small_drift_does_not() {
        // 100 ppm over 400 s is 40 ms of end error — twice the 20 ms half-frame at 25 fps,
        // so it is corrected. The reference (no drift) and a hypothetical small-drift clip
        // are not.
        let (r, d) = drifting_sample(-100.0, 400.0);
        let e = export(&r, &d, "Service").unwrap();

        assert!(
            e.xml.contains("<timeMap>"),
            "the drifting clip must be retimed"
        );
        assert!(e
            .xml
            .contains(r#"<timept time="0s" value="0s" interp="linear"/>"#));
        // Exactly one clip is corrected: the camera, not the reference.
        assert_eq!(e.xml.matches("<timeMap>").count(), 1);
        assert_eq!(e.clips.iter().filter(|c| c.time_map.is_some()).count(), 1);
        let cam = e
            .clips
            .iter()
            .find(|c| c.file.ends_with("cam.mp4"))
            .unwrap();
        let tm = cam.time_map.expect("cam corrected");
        // The ratio is the stretch 1 + ppm·1e-6 = 0.9999, carried as an exact rational.
        assert_eq!(tm.source_end_ticks, 400 * i64::from(AUDIO_TIMEBASE));
        assert_eq!(tm.timeline_end_ticks, 19_198_080);
        let ratio = tm.timeline_end_ticks as f64 / tm.source_end_ticks as f64;
        assert!((ratio - (1.0 - 100e-6)).abs() < 1e-9, "ratio {ratio}");

        // A clip comfortably inside half a frame is never retimed.
        let (r2, d2) = drifting_sample(-10.0, 60.0); // 0.6 ms of drift
        let e2 = export(&r2, &d2, "Service").unwrap();
        assert!(!e2.xml.contains("<timeMap>"));
        assert!(e2.clips.iter().all(|c| c.time_map.is_none()));
    }

    #[test]
    fn the_toggle_off_reproduces_v1_output_with_no_timemap() {
        // correct_drift = false is the UI's off switch: even a wildly drifting clip exports
        // exactly as v1 — no `<timeMap>`, self-closing asset-clips, 1:1 duration.
        let (r, d) = drifting_sample(-500.0, 400.0); // 200 ms of drift, well past the gate
        let off = export_with_options(
            &r,
            &d,
            "Service",
            ExportOptions {
                correct_drift: false,
            },
        )
        .unwrap();
        assert!(!off.xml.contains("<timeMap>"));
        assert!(off.clips.iter().all(|c| c.time_map.is_none()));
        // And the camera's duration is the plain source length (1:1), not stretched.
        let cam = off
            .clips
            .iter()
            .find(|c| c.file.ends_with("cam.mp4"))
            .unwrap();
        assert_eq!(cam.duration_ticks, 400 * i64::from(25)); // 400 s × 25 fps × (1/25 den)

        // On the same input, correction on *does* retime it.
        let on = export(&r, &d, "Service").unwrap();
        assert!(on.xml.contains("<timeMap>"));
    }

    #[test]
    fn a_corrected_clips_end_lands_where_the_reference_puts_it() {
        // The property the whole stage exists for. `ppm` is d(offset)/d(position), so source
        // position p belongs at reference time offset_0 + (1+ppm·1e-6)·p. Reconstruct that
        // ideal end from the emitted geometry and confirm the retimed clip hits it, while a
        // 1:1 clip of the same source would be a full drift out.
        let ppm = -120.0_f64;
        let l = 400.0_f64;
        let (r, d) = drifting_sample(ppm, l);
        let e = export(&r, &d, "Service").unwrap();
        let cam = e
            .clips
            .iter()
            .find(|c| c.file.ends_with("cam.mp4"))
            .unwrap();
        let tm = cam.time_map.expect("corrected");

        let tb = f64::from(AUDIO_TIMEBASE);
        // The clip start on the timeline, in seconds (offset is in the 25-fps timebase).
        let start_s = cam.offset_ticks as f64 / 25.0;
        // Retimed end = start + timeline span from the timeMap.
        let corrected_end = start_s + tm.timeline_end_ticks as f64 / tb;
        // A 1:1 export of the same source from the same start.
        let uncorrected_end = start_s + tm.source_end_ticks as f64 / tb;
        // Reference-correct end: the clip's first sample sits at `start_s` (the correction
        // re-referenced it there), and the far end is (1+ppm·1e-6) further along.
        let ideal_end = start_s + (1.0 + ppm * 1e-6) * l;

        assert!(
            (corrected_end - ideal_end).abs() < 0.001,
            "corrected end {corrected_end} vs ideal {ideal_end}"
        );
        // The drift this removes is real and large: ~48 ms here.
        assert!(
            (uncorrected_end - ideal_end).abs() > 0.010,
            "uncorrected error only {} s",
            (uncorrected_end - ideal_end).abs()
        );
    }

    #[test]
    fn sub_frame_positions_are_snapped_and_the_residual_recorded() {
        // §6 snaps video to the frame grid and notes what the snap cost. At 25 fps a
        // frame is 40 ms, so an offset of 5.017 s is 0.425 frames past a boundary.
        let (mut r, d) = sample();
        r.placements[1].offset_seconds = 5.017;
        let e = export(&r, &d, "Service").unwrap();
        let clip = e
            .clips
            .iter()
            .find(|c| c.file.to_string_lossy().contains("cam a"))
            .unwrap();
        let residual = clip
            .residual
            .expect("a sub-frame offset must record a residual");
        assert!(
            residual.residual_ms.abs() <= 20.0,
            "residual {} ms exceeds half a frame",
            residual.residual_ms
        );
    }
}
