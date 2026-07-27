//! Minimal 16-bit PCM WAV writer.
//!
//! Written by hand so fixture generation has no encoding dependency for the base format
//! — ffmpeg is only needed to transcode into the *other* codecs D-004 requires coverage
//! of. 16-bit puts quantisation noise around −96 dBFS, orders of magnitude below the
//! noise the fixtures add deliberately, so it cannot influence a timing measurement.

use std::io;
use std::path::Path;

/// Writes mono `samples` (nominally −1.0..=1.0) as a 16-bit PCM WAV.
pub fn write_mono(path: &Path, samples: &[f32], rate: u32) -> io::Result<()> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);

    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // format: PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // channels: mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample

    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        // Clamp before scaling: a colouring stage can push past full scale, and letting
        // that wrap would inject a broadband click exactly where the correlator looks.
        let clamped = s.clamp(-1.0, 1.0);
        out.extend_from_slice(&((clamped * 32767.0) as i16).to_le_bytes());
    }

    std::fs::write(path, out)
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
    fn header_and_payload_are_the_right_size() {
        let dir = scratch("wav-size");
        let p = dir.join("a.wav");
        let samples = vec![0.0f32; 1000];
        write_mono(&p, &samples, 48_000).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        assert_eq!(bytes.len(), 44 + 2000);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(&bytes[36..40], b"data");
    }

    #[test]
    fn out_of_range_samples_clamp_instead_of_wrapping() {
        // Wrapping would turn an overshoot into a full-scale discontinuity — a click
        // right where the correlator is looking, and a fixture that lies.
        let dir = scratch("wav-clamp");
        let p = dir.join("a.wav");
        write_mono(&p, &[2.0, -2.0, 0.0], 48_000).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        let s0 = i16::from_le_bytes([bytes[44], bytes[45]]);
        let s1 = i16::from_le_bytes([bytes[46], bytes[47]]);
        assert_eq!(s0, 32767);
        assert_eq!(s1, -32767);
    }
}
