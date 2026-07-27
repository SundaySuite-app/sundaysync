//! ffprobe integration — docs/PLAN.md §4.1.
//!
//! "Reject nothing by extension; reject only on probe failure." Extensions lie: church
//! volunteers rename files, cameras write `.MP4` containing formats nothing expects, and
//! a `.wav` may be anything. ffprobe is the only authority on what a file actually is,
//! so every input is handed to it and the answer is believed.

use crate::rational::Rational;
use crate::sidecar::{self, RunFailure, Sidecar, PROBE_TIMEOUT};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Everything §4.1 asks us to collect about one file.
#[derive(Debug, Clone, PartialEq)]
pub struct Probed {
    pub path: PathBuf,
    pub duration_seconds: f64,
    pub format_name: String,
    pub audio: Option<AudioStream>,
    pub video: Option<VideoStream>,
    /// Container-level tags, sorted — `creation_time`, camera make/model, `encoder`.
    /// A `BTreeMap` rather than a `HashMap` so any output derived from it is
    /// deterministic (§3).
    pub tags: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioStream {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoStream {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    /// `None` when ffprobe reports a degenerate rate (`0/0`), which it does for still
    /// images and some malformed containers.
    pub fps: Option<Rational>,
}

impl Probed {
    /// §4.1: a file with no audio stream cannot be correlated, so it is unsyncable.
    #[must_use]
    pub fn has_audio(&self) -> bool {
        self.audio.is_some()
    }

    /// ISO-8601 container creation time, when the camera bothered to write one.
    ///
    /// Used only as the §4.4 sanity check — never to place a clip. Cameras with an
    /// unset clock are common enough that trusting this would be worse than ignoring it.
    #[must_use]
    pub fn creation_time(&self) -> Option<&str> {
        self.tags.get("creation_time").map(String::as_str)
    }

    /// Best available human name for the recording device (§4.5 heuristic 2).
    ///
    /// Checks the QuickTime-namespaced keys Apple and several camera vendors write
    /// before the bare ones. Returns e.g. "Sony ILCE-7M4".
    #[must_use]
    pub fn device_model(&self) -> Option<String> {
        let get = |k: &str| self.tags.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
        let model = get("com.apple.quicktime.model")
            .or_else(|| get("model"))
            .or_else(|| get("com.android.model"));
        let make = get("com.apple.quicktime.make").or_else(|| get("make"));
        match (make, model) {
            // Avoid "Sony Sony A7" when the vendor writes the make into the model too.
            (Some(mk), Some(md)) if !md.to_lowercase().starts_with(&mk.to_lowercase()) => {
                Some(format!("{mk} {md}"))
            }
            (_, Some(md)) => Some(md.to_string()),
            (Some(mk), None) => Some(mk.to_string()),
            (None, None) => None,
        }
    }
}

/// Why a file could not be probed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeError {
    /// ffprobe ran but rejected the file, timed out, or could not be spawned.
    Unreadable(String),
    /// ffprobe succeeded but emitted JSON we could not understand — a version skew or a
    /// genuinely bizarre file. Treated as unreadable rather than fatal.
    Malformed(String),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable(m) | Self::Malformed(m) => write!(f, "{m}"),
        }
    }
}

/// Probes one file.
///
/// Never panics and never propagates a failure upward: an unreadable file is data, not
/// an error condition (§7.2). The caller turns a `ProbeError` into an `unsynced` entry.
pub fn probe(sidecar: &Sidecar, path: &Path) -> std::result::Result<Probed, ProbeError> {
    // `-v error` keeps the informational banner off stderr so what remains is a real
    // diagnostic worth showing the user.
    let args = [
        "-v".as_ref(),
        "error".as_ref(),
        "-print_format".as_ref(),
        "json".as_ref(),
        "-show_format".as_ref(),
        "-show_streams".as_ref(),
        path.as_os_str(),
    ];

    let output = sidecar::run(&sidecar.ffprobe, args, PROBE_TIMEOUT).map_err(|e| match e {
        RunFailure::TimedOut => {
            ProbeError::Unreadable(format!("ffprobe timed out after {PROBE_TIMEOUT:?}"))
        }
        other => ProbeError::Unreadable(other.to_string()),
    })?;

    from_json(path, &output.stdout)
}

/// Converts ffprobe's JSON into a [`Probed`].
///
/// Split out from [`probe`] so the tests can drive the interesting half — version skew,
/// odd containers, degenerate values — against the real code path, without needing a
/// child process or a fixture file for each case.
pub(crate) fn from_json(path: &Path, json: &[u8]) -> std::result::Result<Probed, ProbeError> {
    let raw: RawProbe = serde_json::from_slice(json)
        .map_err(|e| ProbeError::Malformed(format!("could not parse ffprobe JSON: {e}")))?;

    let format = raw
        .format
        .ok_or_else(|| ProbeError::Malformed("ffprobe reported no container format".into()))?;

    // A container without a duration is not necessarily broken — some streams are
    // open-ended — but it is useless to us: §4.4 picks the reference by duration and
    // §4.3 segments by it.
    let duration_seconds = format
        .duration
        .as_deref()
        .and_then(|d| d.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > 0.0)
        .ok_or_else(|| ProbeError::Unreadable("no usable duration".into()))?;

    let mut audio = None;
    let mut video = None;
    for stream in raw.streams {
        match stream.codec_type.as_deref() {
            // First stream of each kind wins, matching the `-map 0:a:0` the extraction
            // stage uses in §4.2 — the inventory must describe the stream we will
            // actually analyse, not a later one.
            Some("audio") if audio.is_none() => {
                audio = Some(AudioStream {
                    codec: stream.codec_name.unwrap_or_default(),
                    sample_rate: stream
                        .sample_rate
                        .as_deref()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0),
                    channels: stream.channels.unwrap_or(0),
                });
            }
            Some("video") if video.is_none() => {
                // Cover art in an MP3 is a video stream by ffprobe's reckoning. Treating
                // it as a camera would put a "device" in the UI that is really a JPEG.
                let is_cover_art = stream.disposition.is_some_and(|d| d.attached_pic == 1);
                if !is_cover_art {
                    video = Some(VideoStream {
                        codec: stream.codec_name.unwrap_or_default(),
                        width: stream.width.unwrap_or(0),
                        height: stream.height.unwrap_or(0),
                        fps: stream.r_frame_rate.as_deref().and_then(Rational::parse),
                    });
                }
            }
            _ => {}
        }
    }

    Ok(Probed {
        path: path.to_path_buf(),
        duration_seconds,
        format_name: format.format_name.unwrap_or_default(),
        audio,
        video,
        tags: format.tags.unwrap_or_default(),
    })
}

// ---- ffprobe's JSON, as loosely as it can safely be read -------------------------
//
// Every field is optional. ffprobe's schema varies by version, by container and by
// stream type, and a hard-required field would turn a routine odd file into a parse
// failure. Deserialising leniently and validating afterwards keeps the failure modes in
// our own code where the messages are useful.

#[derive(Debug, Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    format: Option<RawFormat>,
}

#[derive(Debug, Deserialize)]
struct RawStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u16>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    disposition: Option<RawDisposition>,
}

#[derive(Debug, Deserialize)]
struct RawDisposition {
    #[serde(default)]
    attached_pic: u8,
}

#[derive(Debug, Deserialize)]
struct RawFormat {
    format_name: Option<String>,
    duration: Option<String>,
    tags: Option<BTreeMap<String, String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> std::result::Result<Probed, ProbeError> {
        from_json(Path::new("/test"), json.as_bytes())
    }

    #[test]
    fn reads_a_normal_camera_file() {
        let p = parse(
            r#"{"streams":[
                 {"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"25/1"},
                 {"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}],
               "format":{"format_name":"mov,mp4","duration":"3600.5","tags":{"creation_time":"2026-07-27T10:00:00.000000Z"}}}"#,
        )
        .unwrap();
        assert!(p.has_audio());
        assert_eq!(p.duration_seconds, 3600.5);
        assert_eq!(p.creation_time(), Some("2026-07-27T10:00:00.000000Z"));
        assert_eq!(p.video.as_ref().unwrap().fps, Rational::new(25, 1));
    }

    #[test]
    fn a_video_only_file_has_no_audio() {
        // §4.1 sends these straight to unsynced with `no_audio`.
        let p = parse(
            r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":320,"height":240,"r_frame_rate":"25/1"}],
                "format":{"format_name":"mov,mp4","duration":"3.0"}}"#,
        )
        .unwrap();
        assert!(!p.has_audio());
    }

    #[test]
    fn a_degenerate_frame_rate_is_none_not_a_panic() {
        // ffprobe emits `0/0` for real files — verified against ffmpeg 8.1.2 at kickoff
        // (docs/DECISIONS.md D-004).
        let p = parse(
            r#"{"streams":[{"codec_type":"video","codec_name":"mjpeg","width":100,"height":100,"r_frame_rate":"0/0"}],
                "format":{"format_name":"mp3","duration":"3.0"}}"#,
        )
        .unwrap();
        assert_eq!(p.video.unwrap().fps, None);
    }

    #[test]
    fn cover_art_is_not_mistaken_for_a_camera() {
        // An MP3 with embedded artwork reports a video stream. Treating it as video
        // would invent a device in the UI that is really a JPEG.
        let p = parse(
            r#"{"streams":[
                 {"codec_type":"video","codec_name":"mjpeg","width":600,"height":600,"disposition":{"attached_pic":1}},
                 {"codec_type":"audio","codec_name":"mp3","sample_rate":"44100","channels":2}],
               "format":{"format_name":"mp3","duration":"180.0"}}"#,
        )
        .unwrap();
        assert!(p.video.is_none());
        assert!(p.has_audio());
    }

    #[test]
    fn missing_or_zero_duration_is_unreadable() {
        let no_dur = r#"{"streams":[],"format":{"format_name":"x"}}"#;
        let zero = r#"{"streams":[],"format":{"format_name":"x","duration":"0.0"}}"#;
        let nan = r#"{"streams":[],"format":{"format_name":"x","duration":"N/A"}}"#;
        for json in [no_dur, zero, nan] {
            assert!(
                matches!(parse(json), Err(ProbeError::Unreadable(_))),
                "{json}"
            );
        }
    }

    #[test]
    fn only_the_first_audio_stream_is_described() {
        // §4.2 extracts `-map 0:a:0`, so the inventory must describe stream 0, not a
        // later one, or the UI would report a channel count we never analyse.
        let p = parse(
            r#"{"streams":[
                 {"codec_type":"audio","codec_name":"pcm_s16le","sample_rate":"48000","channels":1},
                 {"codec_type":"audio","codec_name":"aac","sample_rate":"44100","channels":6}],
               "format":{"format_name":"mov","duration":"10.0"}}"#,
        )
        .unwrap();
        let a = p.audio.unwrap();
        assert_eq!(a.channels, 1);
        assert_eq!(a.sample_rate, 48_000);
    }

    #[test]
    fn device_model_combines_make_and_model_without_stuttering() {
        let with_both = parse(
            r#"{"streams":[],"format":{"format_name":"mov","duration":"1.0",
                "tags":{"com.apple.quicktime.make":"Sony","com.apple.quicktime.model":"ILCE-7M4"}}}"#,
        )
        .unwrap();
        assert_eq!(with_both.device_model().as_deref(), Some("Sony ILCE-7M4"));

        // Vendors that repeat the make inside the model must not yield "Apple Apple...".
        let stuttering = parse(
            r#"{"streams":[],"format":{"format_name":"mov","duration":"1.0",
                "tags":{"make":"Apple","model":"Apple iPhone 15 Pro"}}}"#,
        )
        .unwrap();
        assert_eq!(
            stuttering.device_model().as_deref(),
            Some("Apple iPhone 15 Pro")
        );

        let none =
            parse(r#"{"streams":[],"format":{"format_name":"wav","duration":"1.0"}}"#).unwrap();
        assert_eq!(none.device_model(), None);
    }

    #[test]
    fn garbage_json_is_malformed_not_a_panic() {
        assert!(matches!(
            parse("not json at all"),
            Err(ProbeError::Malformed(_))
        ));
        assert!(matches!(parse("{}"), Err(ProbeError::Malformed(_))));
    }
}
