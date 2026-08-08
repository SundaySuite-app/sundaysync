//! ffprobe integration — docs/PLAN.md §4.1.
//!
//! "Reject nothing by extension; reject only on probe failure." Extensions lie: church
//! volunteers rename files, cameras write `.MP4` containing formats nothing expects, and
//! a `.wav` may be anything. ffprobe is the only authority on what a file actually is,
//! so every input is handed to it and the answer is believed.

use crate::progress::CancelToken;
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
    /// The user cancelled while this file was being probed.
    Cancelled,
    /// ffprobe succeeded but emitted JSON we could not understand — a version skew or a
    /// genuinely bizarre file. Treated as unreadable rather than fatal.
    Malformed(String),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable(m) | Self::Malformed(m) => write!(f, "{m}"),
            Self::Cancelled => write!(f, "cancelled"),
        }
    }
}

/// Probes one file.
///
/// Never panics and never propagates a failure upward: an unreadable file is data, not
/// an error condition (§7.2). The caller turns a `ProbeError` into an `unsynced` entry.
pub fn probe(
    sidecar: &Sidecar,
    path: &Path,
    cancel: &CancelToken,
) -> std::result::Result<Probed, ProbeError> {
    // `-v error` keeps the informational banner off stderr so what remains is a real
    // diagnostic worth showing the user.
    //
    // The three security flags before `-i` close the passive-input attack surface the E2
    // threat model flagged (S-1/S-2, docs/DECISIONS.md D-032). §4.1 deliberately does not
    // reject by extension, so a dropped "media" file may really be an HLS playlist or a
    // `concat`/`ffconcat` script — and ffprobe, left to its defaults, would follow it:
    //
    //   * `-protocol_whitelist file` restricts every demuxer this probe engages to the
    //     local `file` protocol only, so a nested `http(s)://` segment reference cannot
    //     turn a passive probe into an outbound request (SSRF). This propagates to the
    //     HLS demuxer's nested-protocol whitelist, verified to refuse `http` with
    //     "Protocol 'http' not on whitelist 'file'".
    //   * `-safe 1` pins the concat demuxer's safe mode on (it already defaults on, but a
    //     future or system ffprobe with a looser default must not reopen the hole),
    //     rejecting absolute and `file:`-protocol paths a concat script would otherwise
    //     read — local-file disclosure. Verified harmless on ffprobe for wav/mp4/flac/aac.
    //   * `-i` makes the path a flag *value* rather than a bare trailing positional, so a
    //     file literally named `-show_data_hex` can no longer be parsed as an ffprobe
    //     option (argument injection).
    //
    // The whitelist must precede `-i`, as it governs the input demuxer.
    let args = [
        "-v".as_ref(),
        "error".as_ref(),
        "-print_format".as_ref(),
        "json".as_ref(),
        "-show_format".as_ref(),
        "-show_streams".as_ref(),
        "-protocol_whitelist".as_ref(),
        "file".as_ref(),
        "-safe".as_ref(),
        "1".as_ref(),
        "-i".as_ref(),
        path.as_os_str(),
    ];

    let output =
        sidecar::run(&sidecar.ffprobe, args, PROBE_TIMEOUT, cancel).map_err(|e| match e {
            RunFailure::TimedOut => {
                ProbeError::Unreadable(format!("ffprobe timed out after {PROBE_TIMEOUT:?}"))
            }
            RunFailure::Cancelled => ProbeError::Cancelled,
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

/// Fuzzing door onto [`from_json`] (the `fuzzing` feature only; docs/DECISIONS.md D-032).
///
/// `from_json` is `pub(crate)`, so the out-of-tree fuzz crate cannot see it. This gives it
/// a public entry without widening the shipping API — the whole item is compiled out unless
/// the `fuzzing` feature is on, which no shipping build enables. The property under test:
/// no byte sequence may make the parser panic; it must only ever return `Some`/`None`.
#[cfg(feature = "fuzzing")]
#[must_use]
pub fn fuzz_from_json(data: &[u8]) -> Option<Probed> {
    from_json(Path::new("/fuzz"), data).ok()
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

    // ---- S-1/S-2 security regression: the passive-input attack surface -------------
    //
    // These exercise the real `probe()` child process, so they need a working ffprobe.
    // On the ubuntu gate `SUNDAYSYNC_REQUIRE_FFMPEG=1` turns a skip into a failure, so
    // the guard can never silently rot (D-005 pattern).

    use crate::sidecar::Sidecar;

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

    /// The committed adversarial corpus, `fixtures/hostile/` (D-032). Resolved from the
    /// crate manifest so it is found regardless of the test's working directory.
    fn hostile(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/hostile")
            .join(name)
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("sundaysync-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_concat_script_cannot_disclose_a_local_file() {
        // S-1: a dropped `.ffconcat` that references /etc/passwd must be refused, not
        // followed. With the whitelist + safe mode, probing it fails cleanly; the
        // sensitive file's contents never reach ffprobe's output.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let r = probe(
            &sidecar,
            &hostile("local-file-disclosure.ffconcat"),
            &CancelToken::new(),
        );
        assert!(
            matches!(r, Err(ProbeError::Unreadable(_) | ProbeError::Malformed(_))),
            "hostile concat script must be refused, got {r:?}"
        );
    }

    #[test]
    fn an_hls_playlist_cannot_trigger_an_outbound_request() {
        // S-1 (SSRF): a dropped `.m3u8` whose segments are remote URLs must not make
        // ffprobe reach out. The `-protocol_whitelist file` flag confines every demuxer
        // to the local file protocol, so the probe fails instead of fetching.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let r = probe(&sidecar, &hostile("ssrf.m3u8"), &CancelToken::new());
        assert!(
            matches!(r, Err(ProbeError::Unreadable(_) | ProbeError::Malformed(_))),
            "hostile HLS playlist must be refused, got {r:?}"
        );
    }

    #[test]
    fn the_protocol_whitelist_reaches_the_nested_demuxer_protocol() {
        // Mechanism-level proof that `-protocol_whitelist file` is what closes the SSRF
        // vector: forcing the HLS demuxer on the hostile playlist, ffprobe's own stderr
        // must report that `http` is refused *because it is not on the whitelist we set*.
        // This is white-box (it forces `-f hls`, which the production probe does not), but
        // it pins the flag's effect so a future arg-vector edit that drops it is caught.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let out = crate::sidecar::run(
            &sidecar.ffprobe,
            [
                "-v".as_ref(),
                "error".as_ref(),
                "-f".as_ref(),
                "hls".as_ref(),
                "-protocol_whitelist".as_ref(),
                "file".as_ref(),
                "-i".as_ref(),
                hostile("ssrf.m3u8").as_os_str(),
            ],
            PROBE_TIMEOUT,
            &CancelToken::new(),
        );
        let stderr = match out {
            Ok(o) => o.stderr,
            Err(crate::sidecar::RunFailure::Failed { stderr, .. }) => stderr,
            other => panic!("expected a demuxer error carrying stderr, got {other:?}"),
        };
        assert!(
            stderr.contains("not on whitelist") && stderr.contains("http"),
            "expected the whitelist to refuse http, stderr was: {stderr}"
        );
    }

    #[test]
    fn a_leading_dash_filename_is_not_parsed_as_a_flag() {
        // S-2: a file literally named `-show_data_hex` used to be taken as an ffprobe
        // flag (bare trailing positional). Now it is `-i`'s value, so it is treated as a
        // path — which, being absent/undecodable, fails as an ordinary unreadable file
        // rather than smuggling an option into the command.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("probe-dashname");
        let sneaky = dir.join("-show_data_hex");
        std::fs::write(&sneaky, vec![0xABu8; 512]).unwrap();
        let r = probe(&sidecar, &sneaky, &CancelToken::new());
        assert!(
            matches!(r, Err(ProbeError::Unreadable(_) | ProbeError::Malformed(_))),
            "a dash-led filename must be handled as a path, got {r:?}"
        );
    }

    #[test]
    fn normal_media_still_probes_after_the_security_flags() {
        // The critical regression check: the whitelist/safe/`-i` changes must not break a
        // legitimate file. Encodes a real WAV with ffmpeg, then probes it.
        let Some(sidecar) = require_ffprobe() else {
            return;
        };
        let dir = scratch("probe-normal");
        let wav = dir.join("tone.wav");
        let made = crate::sidecar::run(
            &sidecar.ffmpeg,
            [
                "-v".as_ref(),
                "error".as_ref(),
                "-f".as_ref(),
                "lavfi".as_ref(),
                "-i".as_ref(),
                "sine=frequency=440:duration=1".as_ref(),
                "-ar".as_ref(),
                "8000".as_ref(),
                "-y".as_ref(),
                wav.as_os_str(),
            ],
            std::time::Duration::from_secs(60),
            &CancelToken::new(),
        )
        .is_ok();
        if !made {
            eprintln!("SKIP: could not synthesise a WAV fixture");
            return;
        }
        let p = probe(&sidecar, &wav, &CancelToken::new()).expect("normal wav must probe");
        assert!(p.has_audio());
        assert!(p.duration_seconds > 0.0);
    }
}
