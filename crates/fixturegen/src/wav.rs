//! Minimal 16-bit PCM WAV writer.
//!
//! Written by hand so fixture generation has no encoding dependency for the base format
//! — ffmpeg is only needed to transcode into the *other* codecs D-004 requires coverage
//! of. 16-bit puts quantisation noise around −96 dBFS, orders of magnitude below the
//! noise the fixtures add deliberately, so it cannot influence a timing measurement.

use std::io::{self, BufWriter, Write};
use std::path::Path;

/// Writes a 16-bit PCM WAV header for `total_samples` mono samples at `rate`, leaving the
/// writer positioned at the start of the data chunk.
fn write_mono_header(out: &mut impl Write, total_samples: usize, rate: u32) -> io::Result<()> {
    let data_len = (total_samples * 2) as u32;
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data_len).to_le_bytes())?;
    out.write_all(b"WAVE")?;
    out.write_all(b"fmt ")?;
    out.write_all(&16u32.to_le_bytes())?; // PCM chunk size
    out.write_all(&1u16.to_le_bytes())?; // format: PCM
    out.write_all(&1u16.to_le_bytes())?; // channels: mono
    out.write_all(&rate.to_le_bytes())?;
    out.write_all(&(rate * 2).to_le_bytes())?; // byte rate
    out.write_all(&2u16.to_le_bytes())?; // block align
    out.write_all(&16u16.to_le_bytes())?; // bits per sample
    out.write_all(b"data")?;
    out.write_all(&data_len.to_le_bytes())
}

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

/// Writes a mono 16-bit PCM WAV whose header's declared `data` length does not match how
/// much audio actually follows — the "8-hour WAV header, 2 s of samples" adversarial case
/// (docs/V02-PROGRAM.md E4). `claimed_seconds` sizes the RIFF/`data` chunk headers;
/// `samples` is what is actually written after them, which may be far shorter. A
/// permissive demuxer that trusts the header size over the real file length is exactly
/// the case this exists to catch — the engine must land the result in a defined §5
/// bucket, never hang or panic reading past the real end of the file.
pub fn write_mono_with_lying_header(
    path: &Path,
    samples: &[f32],
    rate: u32,
    claimed_seconds: f64,
) -> io::Result<()> {
    let claimed_samples = (claimed_seconds * f64::from(rate)) as usize;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    write_mono_header(&mut out, claimed_samples, rate)?;
    for s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        out.extend_from_slice(&((clamped * 32767.0) as i16).to_le_bytes());
    }
    std::fs::write(path, out)
}

/// Writes an interleaved multi-channel 16-bit PCM WAV — mono is covered by
/// [`write_mono`]; this is the exotic-channel-layout coverage (5.1, 7.1, …) E4's
/// adversarial suite asks for. `channel_of(c, i)` returns channel `c`'s sample at frame
/// `i`, so callers can derive every channel from one mono source without pre-building
/// `channels` full-length buffers.
pub fn write_interleaved(
    path: &Path,
    frames: usize,
    channels: u16,
    rate: u32,
    mut channel_of: impl FnMut(u16, usize) -> f32,
) -> io::Result<()> {
    let block_align = 2u16 * channels;
    let data_len = (frames * channels as usize * 2) as u32;

    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * u32::from(block_align)).to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());

    for i in 0..frames {
        for c in 0..channels {
            let clamped = channel_of(c, i).clamp(-1.0, 1.0);
            out.extend_from_slice(&((clamped * 32767.0) as i16).to_le_bytes());
        }
    }
    std::fs::write(path, out)
}

/// A mono 16-bit PCM WAV writer that streams samples straight to disk in bounded chunks,
/// rather than materialising the whole signal first.
///
/// Exists for the §7.7 memory-gate fixture (docs/V02-PROGRAM.md E4): a 20-hour reference
/// is billions of samples, and the point of that fixture is to measure the *engine's*
/// peak RSS — a generator that first built the same signal in one `Vec<f32>` would
/// confound the very measurement it exists to set up. The header is written up front from
/// the caller-supplied total, exactly as [`write_mono`] does, so `expected_samples` must
/// be exact: WAV has no trailer that could fix up a wrong count after the fact.
#[derive(Debug)]
pub struct StreamingWavWriter {
    out: BufWriter<std::fs::File>,
    written: usize,
    expected: usize,
    scratch: Vec<u8>,
}

impl StreamingWavWriter {
    /// Creates `path` and writes the header for `expected_samples` mono samples at `rate`.
    pub fn create(path: &Path, expected_samples: usize, rate: u32) -> io::Result<Self> {
        let file = std::fs::File::create(path)?;
        let mut out = BufWriter::with_capacity(1 << 20, file);
        write_mono_header(&mut out, expected_samples, rate)?;
        Ok(Self {
            out,
            written: 0,
            expected: expected_samples,
            scratch: Vec::new(),
        })
    }

    /// Appends one chunk of samples. May be called any number of times; the sum of every
    /// chunk's length must equal `expected_samples` by the time [`Self::finish`] runs.
    pub fn write_chunk(&mut self, samples: &[f32]) -> io::Result<()> {
        self.scratch.clear();
        self.scratch.reserve(samples.len() * 2);
        for s in samples {
            let clamped = s.clamp(-1.0, 1.0);
            self.scratch
                .extend_from_slice(&((clamped * 32767.0) as i16).to_le_bytes());
        }
        self.out.write_all(&self.scratch)?;
        self.written += samples.len();
        Ok(())
    }

    /// Flushes to disk. Returns an error if the total written does not match the header's
    /// declared length — the one invariant a streaming writer must enforce itself, since
    /// nothing downstream can catch a short WAV the way a panic would catch a bad slice.
    pub fn finish(mut self) -> io::Result<()> {
        self.out.flush()?;
        if self.written != self.expected {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "StreamingWavWriter: wrote {} samples, header declared {}",
                    self.written, self.expected
                ),
            ));
        }
        Ok(())
    }
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

    #[test]
    fn streaming_writer_matches_a_one_shot_write() {
        // The whole point of the streaming writer is that it must be indistinguishable
        // from `write_mono` on the wire, chunk boundaries included.
        let dir = scratch("wav-streaming");
        let samples: Vec<f32> = (0..10_000)
            .map(|i| ((i as f32) * 0.001).sin() * 0.5)
            .collect();

        let one_shot = dir.join("one-shot.wav");
        write_mono(&one_shot, &samples, 12_000).unwrap();

        let streamed = dir.join("streamed.wav");
        let mut w = StreamingWavWriter::create(&streamed, samples.len(), 12_000).unwrap();
        for chunk in samples.chunks(777) {
            w.write_chunk(chunk).unwrap();
        }
        w.finish().unwrap();

        assert_eq!(
            std::fs::read(&one_shot).unwrap(),
            std::fs::read(&streamed).unwrap(),
            "streamed output must be byte-identical to the one-shot writer"
        );
    }

    #[test]
    fn streaming_writer_refuses_a_short_count() {
        let dir = scratch("wav-streaming-short");
        let p = dir.join("short.wav");
        let mut w = StreamingWavWriter::create(&p, 100, 12_000).unwrap();
        w.write_chunk(&[0.0f32; 40]).unwrap();
        let err = w.finish().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn lying_header_declares_more_than_it_writes() {
        let dir = scratch("wav-lying-header");
        let p = dir.join("lying.wav");
        // 2 s of real audio, header claims 8 hours (28800 s).
        let samples = vec![0.1f32; 2 * 48_000];
        write_mono_with_lying_header(&p, &samples, 48_000, 8.0 * 3600.0).unwrap();

        let bytes = std::fs::read(&p).unwrap();
        // The file on disk is small — only the real samples were written.
        assert_eq!(bytes.len(), 44 + samples.len() * 2);
        // But the header claims the full 8 hours.
        let declared_data_len = u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]);
        let claimed_samples = (8.0 * 3600.0 * 48_000.0) as u32;
        assert_eq!(declared_data_len, claimed_samples * 2);
        assert!(
            u64::from(declared_data_len) > (bytes.len() as u64),
            "the header must claim more data than the file actually holds"
        );
    }

    #[test]
    fn interleaved_writer_produces_the_right_frame_count() {
        let dir = scratch("wav-interleaved");
        let p = dir.join("surround.wav");
        let frames = 1000;
        let channels = 6u16; // 5.1
        write_interleaved(&p, frames, channels, 48_000, |c, i| {
            (i as f32 * 0.01 + f32::from(c)).sin() * 0.2
        })
        .unwrap();

        let bytes = std::fs::read(&p).unwrap();
        let expected_data_len = frames * channels as usize * 2;
        assert_eq!(bytes.len(), 44 + expected_data_len);
        let ch = u16::from_le_bytes([bytes[22], bytes[23]]);
        assert_eq!(ch, channels);
    }
}
