//! Adversarial *media* fixtures for E4's stability suite (docs/V02-PROGRAM.md).
//!
//! This is a different hostility from `fixtures/hostile/` (D-032): that corpus targets
//! the protocol-whitelist / SSRF surface (S-1) with deliberately malicious *scripts*
//! masquerading as media. This module targets the decode path itself with malformed but
//! non-malicious media — the kind a crashed recorder, an interrupted transfer, or a
//! renamed file actually produces. Every one of these must land in a defined §5 outcome
//! bucket (placed / unsynced-with-reason) — never a panic, never a hang past the
//! per-file timeout.

use crate::rng::Rng;
use crate::shoot::EmitError;
use crate::signal::{self, MASTER_RATE};
use crate::wav;
use std::path::Path;

/// A zero-length file — the simplest hostile input: nothing at all to demux.
pub fn write_empty(path: &Path) -> Result<(), EmitError> {
    std::fs::write(path, []).map_err(EmitError::Io)?;
    Ok(())
}

/// A WAV whose header declares `claimed_seconds` of audio but whose `data` chunk holds
/// only `actual_seconds`. The classic "recorder crashed, header never got fixed up"
/// failure — the header's RIFF/`data` sizes are internally consistent with the *claim*,
/// not with the real file length, which is what makes this different from simple
/// truncation.
pub fn write_wav_lying_header(
    path: &Path,
    seed: u64,
    actual_seconds: f64,
    claimed_seconds: f64,
    rate: u32,
) -> Result<(), EmitError> {
    let mut rng = Rng::new(seed);
    let audio = signal::generate_master(&mut rng, actual_seconds, rate);
    wav::write_mono_with_lying_header(path, &audio, rate, claimed_seconds)
        .map_err(EmitError::Io)?;
    Ok(())
}

/// Writes real WAV bytes at whatever `path` the caller names — including a path with a
/// `.mp4`/`.mov`/etc extension. §4.1 forbids filtering by extension, so a WAV mislabelled
/// as a video container (or vice versa, see [`write_mp4_at_any_extension`]) must still be
/// probed honestly rather than assumed-and-refused from the name alone.
pub fn write_wav_at_any_extension(
    path: &Path,
    seed: u64,
    seconds: f64,
    rate: u32,
) -> Result<(), EmitError> {
    let mut rng = Rng::new(seed);
    let audio = signal::generate_master(&mut rng, seconds, rate);
    wav::write_mono(path, &audio, rate).map_err(EmitError::Io)?;
    Ok(())
}

/// Writes an MP4 (via ffmpeg) at whatever `path` the caller names — including a `.wav`
/// extension, the mirror image of [`write_wav_at_any_extension`].
pub fn write_mp4_at_any_extension(
    path: &Path,
    seed: u64,
    seconds: f64,
    ffmpeg: &Path,
) -> Result<(), EmitError> {
    write_short_mp4(path, seed, seconds, ffmpeg)
}

/// Multi-channel WAV — mono is the default everywhere else in `fixturegen`; this covers
/// the exotic channel layouts (5.1, 7.1, …) E4 asks for. Every channel carries the same
/// broadband master content at a slightly different gain, so the file is genuinely
/// multi-channel audio rather than a mono stream duplicated blindly.
pub fn write_multichannel_wav(
    path: &Path,
    seed: u64,
    seconds: f64,
    rate: u32,
    channels: u16,
) -> Result<(), EmitError> {
    let mut rng = Rng::new(seed);
    let master = signal::generate_master(&mut rng, seconds, rate);
    let frames = master.len();
    wav::write_interleaved(path, frames, channels, rate, |c, i| {
        let gain = 1.0 - 0.05 * f32::from(c);
        master[i] * gain
    })
    .map_err(EmitError::Io)?;
    Ok(())
}

/// Muxes a short real MP4 via ffmpeg (same recipe as `shoot::write_clip`'s `Mp4` arm),
/// then truncates it partway through — a mid-atom cut, the way a crashed recorder or an
/// interrupted card-to-disk copy actually leaves a file. `keep_fraction` is clamped to
/// (0.05, 0.95) so the cut is always genuinely partial, neither near-empty nor
/// near-complete.
pub fn write_truncated_mp4(
    path: &Path,
    seed: u64,
    seconds: f64,
    keep_fraction: f64,
    ffmpeg: &Path,
) -> Result<(), EmitError> {
    write_short_mp4(path, seed, seconds, ffmpeg)?;

    let full_len = std::fs::metadata(path).map_err(EmitError::Io)?.len();
    let keep = ((full_len as f64) * keep_fraction.clamp(0.05, 0.95)) as usize;
    let bytes = std::fs::read(path).map_err(EmitError::Io)?;
    std::fs::write(path, &bytes[..keep]).map_err(EmitError::Io)?;
    Ok(())
}

/// The shared "encode a short real MP4" step behind [`write_truncated_mp4`] and
/// [`write_mp4_at_any_extension`] — a tiny 128×72 long-GOP H.264 + AAC container, the
/// same recipe `shoot::write_clip`'s `Mp4` arm uses, duplicated here rather than shared
/// because that function is private to `shoot` and this module has no ground truth to
/// record alongside it.
fn write_short_mp4(path: &Path, seed: u64, seconds: f64, ffmpeg: &Path) -> Result<(), EmitError> {
    let mut rng = Rng::new(seed);
    let audio = signal::generate_master(&mut rng, seconds, MASTER_RATE);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("hostile");
    let temp_wav = dir.join(format!("{stem}.src.wav"));
    wav::write_mono(&temp_wav, &audio, MASTER_RATE).map_err(EmitError::Io)?;

    let args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-i".into(),
        temp_wav.to_string_lossy().into_owned(),
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
        "-y".into(),
        path.to_string_lossy().into_owned(),
    ];
    let out = std::process::Command::new(ffmpeg)
        .args(&args)
        .output()
        .map_err(|e| EmitError::Encode {
            file: path.display().to_string(),
            detail: e.to_string(),
        })?;
    let _ = std::fs::remove_file(&temp_wav);

    if !out.status.success() {
        return Err(EmitError::Encode {
            file: path.display().to_string(),
            detail: String::from_utf8_lossy(&out.stderr)
                .lines()
                .next()
                .unwrap_or("ffmpeg failed")
                .to_string(),
        });
    }
    Ok(())
}

/// Raw, non-media bytes at a media-looking extension — reused from the same pattern as
/// `fixtures/hostile/malformed.bin`, but generated rather than committed so callers can
/// vary the size and byte pattern per case.
pub fn write_garbage(path: &Path, seed: u64, len: usize) -> Result<(), EmitError> {
    let mut rng = Rng::new(seed);
    let bytes: Vec<u8> = (0..len).map(|_| (rng.next_u64() & 0xFF) as u8).collect();
    std::fs::write(path, bytes).map_err(EmitError::Io)?;
    Ok(())
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
    fn empty_file_is_truly_empty() {
        let dir = scratch("hostile-empty");
        let p = dir.join("zero.mp4");
        write_empty(&p).unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().len(), 0);
    }

    #[test]
    fn lying_header_writes_far_less_than_it_claims() {
        let dir = scratch("hostile-lying");
        let p = dir.join("lying.wav");
        write_wav_lying_header(&p, 1, 2.0, 8.0 * 3600.0, 48_000).unwrap();
        let real_len = std::fs::metadata(&p).unwrap().len();
        // 2 s of real 48 kHz mono 16-bit audio, not 8 hours of it.
        assert!(real_len < 1_000_000, "file suspiciously large: {real_len}");
    }

    #[test]
    fn wrong_extension_bytes_are_the_real_format_underneath() {
        let dir = scratch("hostile-wrongext");
        let wav_as_mp4 = dir.join("really-wav.mp4");
        write_wav_at_any_extension(&wav_as_mp4, 2, 0.5, 48_000).unwrap();
        let bytes = std::fs::read(&wav_as_mp4).unwrap();
        assert_eq!(
            &bytes[0..4],
            b"RIFF",
            "the bytes are WAV regardless of extension"
        );
    }

    #[test]
    fn multichannel_wav_reports_the_right_channel_count() {
        let dir = scratch("hostile-multichannel");
        let p = dir.join("surround.wav");
        write_multichannel_wav(&p, 3, 0.5, 48_000, 6).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        let channels = u16::from_le_bytes([bytes[22], bytes[23]]);
        assert_eq!(channels, 6);
    }

    #[test]
    fn garbage_is_deterministic_from_its_seed() {
        let dir = scratch("hostile-garbage");
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        write_garbage(&a, 42, 256).unwrap();
        write_garbage(&b, 42, 256).unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());
    }
}
