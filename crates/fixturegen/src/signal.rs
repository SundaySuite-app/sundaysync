//! Synthetic event audio and the per-device transforms applied to it — §8.1.
//!
//! # Why the source material looks like this
//!
//! GCC-PHAT locks onto broadband transients. A pure tone is nearly the worst possible
//! test signal: its autocorrelation is periodic, so every peak looks like every other
//! peak and the "right" answer is ambiguous by a whole period. Generating sine waves
//! would produce a suite that either fails constantly or, worse, passes for the wrong
//! reason.
//!
//! So the master event mixes two broadband things a church service actually contains:
//! speech-like noise bursts with hard onsets, and a music-like tonal bed with percussive
//! transients on top. The onsets are what the correlator finds.
//!
//! # Why the transforms exist
//!
//! §4.3's premise is that a mixer feed and a distant camera mic "sound completely
//! different (EQ, reverb, gain) but share phase structure". A fixture suite that fed
//! identical audio to every device would verify nothing about that claim — it would
//! test cross-correlation on copies. Each device therefore gets its own gain, spectral
//! tilt, reverb tail and noise floor, so a passing test means PHAT whitening is doing
//! the work it is there to do.

use crate::rng::Rng;
use std::f64::consts::TAU;

/// Sample rate of generated master audio. Realistic camera/recorder rate; the engine
/// downsamples to `ANALYSIS_RATE` itself, so generating here at 12 kHz would hide any
/// resampling problem in the extraction stage.
pub const MASTER_RATE: u32 = 48_000;

/// Builds the master event audio — the "real" sound in the room that every device is a
/// degraded view of.
#[must_use]
pub fn generate_master(rng: &mut Rng, seconds: f64, rate: u32) -> Vec<f32> {
    let n = (seconds * f64::from(rate)) as usize;
    let mut out = vec![0.0f32; n];

    tonal_bed(rng, &mut out, rate);
    speech_bursts(rng, &mut out, rate);
    percussive_transients(rng, &mut out, rate);

    normalise(&mut out, 0.7);
    out
}

/// A sustained, slowly-shifting harmonic bed — the "music" component.
fn tonal_bed(rng: &mut Rng, out: &mut [f32], rate: u32) {
    let rate_f = f64::from(rate);
    // A handful of detuned partials. Detuning matters: exact harmonics would make the
    // bed strictly periodic, reintroducing the correlation ambiguity we are avoiding.
    let voices: Vec<(f64, f64, f64)> = (0..5)
        .map(|i| {
            let base = rng.range(80.0, 260.0) * f64::from(i + 1);
            (base, rng.range(0.03, 0.10), rng.range(0.0, TAU))
        })
        .collect();

    for (i, s) in out.iter_mut().enumerate() {
        let t = i as f64 / rate_f;
        let mut v = 0.0;
        for (freq, amp, phase) in &voices {
            // Slow vibrato keeps the bed non-stationary, as real playing is.
            let f = freq * (1.0 + 0.002 * (t * 0.7).sin());
            v += amp * (TAU * f * t + phase).sin();
        }
        *s += v as f32;
    }
}

/// Band-limited noise bursts with speech-like envelopes and gaps.
fn speech_bursts(rng: &mut Rng, out: &mut [f32], rate: u32) {
    let rate_f = f64::from(rate);
    let n = out.len();
    let mut pos = 0usize;

    while pos < n {
        // Syllable-scale bursts and pauses.
        let burst = (rng.range(0.08, 0.30) * rate_f) as usize;
        let gap = (rng.range(0.04, 0.45) * rate_f) as usize;
        let end = (pos + burst).min(n);

        // One-pole bandpass state, re-randomised per burst so successive syllables
        // differ in colour the way real speech does.
        let lp_a = rng.range(0.05, 0.35);
        let hp_a = rng.range(0.002, 0.02);
        let (mut lp, mut hp) = (0.0f64, 0.0f64);
        let amp = rng.range(0.15, 0.45);
        let len = (end - pos).max(1) as f64;

        for (k, i) in (pos..end).enumerate() {
            let white = rng.normal();
            lp += lp_a * (white - lp);
            hp += hp_a * (lp - hp);
            let band = lp - hp;

            // Fast attack, slower decay — the asymmetry is what gives the correlator a
            // sharp, unambiguous onset to lock onto.
            let x = k as f64 / len;
            let env = if x < 0.05 {
                x / 0.05
            } else {
                ((1.0 - x) / 0.95).powf(0.6)
            };
            out[i] += (band * env * amp) as f32;
        }
        pos = end + gap;
    }
}

/// Sparse wideband clicks — cajón hits, key clacks, a closing door.
///
/// These dominate the correlation peak in practice: a single sample-accurate onset
/// carries more usable timing information than seconds of sustained tone.
fn percussive_transients(rng: &mut Rng, out: &mut [f32], rate: u32) {
    let rate_f = f64::from(rate);
    let n = out.len();
    let mut t = rng.range(0.2, 1.0);

    while (t * rate_f) < n as f64 {
        let start = (t * rate_f) as usize;
        let decay = rng.range(0.02, 0.12);
        let amp = rng.range(0.25, 0.6);
        let len = ((decay * 4.0) * rate_f) as usize;

        for k in 0..len {
            let i = start + k;
            if i >= n {
                break;
            }
            let tt = k as f64 / rate_f;
            let env = (-tt / decay).exp();
            out[i] += (rng.normal() * env * amp) as f32;
        }
        t += rng.range(0.35, 1.8);
    }
}

fn normalise(buf: &mut [f32], peak: f32) {
    let max = buf.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if max > 0.0 {
        let g = peak / max;
        for s in buf.iter_mut() {
            *s *= g;
        }
    }
}

/// How one device colours what it heard.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Colour {
    pub gain_db: f64,
    /// Positive tilts bright (a thin on-camera mic), negative tilts dark (a mic under a
    /// balcony). 0 leaves the spectrum alone.
    pub tilt: f64,
    /// Reverb send, 0.0–1.0. A camera 20 m back hears far more room than the desk feed.
    pub reverb: f64,
    /// Signal-to-noise ratio in dB. `None` adds no noise.
    pub snr_db: Option<f64>,
    /// Clock error in parts per million. §4.6's target; ±50 ppm covers consumer gear.
    pub drift_ppm: f64,
}

impl Default for Colour {
    fn default() -> Self {
        Self {
            gain_db: 0.0,
            tilt: 0.0,
            reverb: 0.0,
            snr_db: None,
            drift_ppm: 0.0,
        }
    }
}

/// Applies a device's colouring, in signal-chain order: room, then mic, then preamp.
#[must_use]
pub fn colour(input: &[f32], c: &Colour, rate: u32, rng: &mut Rng) -> Vec<f32> {
    let mut buf = input.to_vec();
    if c.reverb > 0.0 {
        buf = reverb(&buf, c.reverb, rate);
    }
    if c.tilt.abs() > f64::EPSILON {
        buf = tilt(&buf, c.tilt);
    }
    let g = 10f64.powf(c.gain_db / 20.0) as f32;
    for s in &mut buf {
        *s *= g;
    }
    if let Some(snr) = c.snr_db {
        add_noise(&mut buf, snr, rng);
    }
    if c.drift_ppm.abs() > f64::EPSILON {
        buf = resample(&buf, 1.0 + c.drift_ppm * 1e-6);
    }
    buf
}

/// Schroeder-style reverb: parallel combs into a series allpass, added to an untouched
/// dry path.
///
/// Not a convincing hall — it does not need to be. It needs to decorrelate the direct
/// sound enough that a naive cross-correlation struggles and PHAT whitening does not.
///
/// # The direct path is never attenuated, and that is load-bearing
///
/// An earlier version mixed `dry * (1 - mix) + wet * mix`, where `wet` came out of a comb
/// bank that *included* the direct sound and then through an allpass whose delayed term
/// had unity gain against a −0.7 direct term. Above `mix ≈ 0.5` the 5 ms-delayed copy
/// therefore became the strongest correlated component in the signal, and the correlator
/// — correctly — locked onto it. Every high-reverb fixture measured exactly 5.00 ms
/// early, which looked precisely like the per-codec decoder bias docs/DECISIONS.md D-004
/// warned about. It was not. It was the fixture lying. See D-014.
///
/// The model now matches physics: the direct arrival is always present at unity and is
/// always the loudest thing, with the tail summed on top. Raising `mix` makes the
/// correlator's job harder — which is the point — without ever moving the true arrival.
fn reverb(input: &[f32], mix: f64, rate: u32) -> Vec<f32> {
    let rate_f = f64::from(rate);
    // Mutually prime-ish delays avoid the metallic ring of related delay times.
    let combs = [0.0297, 0.0371, 0.0411, 0.0437];
    let feedback = [0.805, 0.827, 0.783, 0.764];

    // The tail only — each comb's output minus the direct sound that fed it.
    let mut tail = vec![0.0f32; input.len()];
    for (delay, fb) in combs.iter().zip(feedback.iter()) {
        let d = (delay * rate_f) as usize;
        if d == 0 || d >= input.len() {
            continue;
        }
        let mut buf = vec![0.0f32; input.len()];
        for i in 0..input.len() {
            let fed = if i >= d {
                buf[i - d] * (*fb as f32)
            } else {
                0.0
            };
            buf[i] = input[i] + fed;
        }
        for i in 0..input.len() {
            tail[i] += (buf[i] - input[i]) * 0.25;
        }
    }

    // One allpass to smear the tail without changing its magnitude spectrum. Applied to
    // the tail alone, so it can never compete with the direct arrival.
    let d = (0.005 * rate_f) as usize;
    if d > 0 && d < tail.len() {
        let g = 0.7f32;
        let mut ap = vec![0.0f32; tail.len()];
        for i in 0..tail.len() {
            let delayed = if i >= d { ap[i - d] } else { 0.0 };
            ap[i] = tail[i] + g * delayed;
            tail[i] = -g * ap[i] + delayed;
        }
    }

    let m = mix as f32;
    input
        .iter()
        .zip(tail.iter())
        .map(|(dry, t)| dry + t * m)
        .collect()
}

/// Spectral tilt via a one-pole shelf. Positive brightens, negative darkens.
fn tilt(input: &[f32], amount: f64) -> Vec<f32> {
    let a = 0.15f32;
    let mut lp = 0.0f32;
    let k = amount as f32;
    input
        .iter()
        .map(|x| {
            lp += a * (x - lp);
            let high = x - lp;
            // Bright: boost the high part. Dark: lean on the low-passed part.
            if k > 0.0 {
                lp + high * (1.0 + k * 3.0)
            } else {
                lp * (1.0 - k) + high * (1.0 + k).max(0.05)
            }
        })
        .collect()
}

fn add_noise(buf: &mut [f32], snr_db: f64, rng: &mut Rng) {
    let power: f64 = buf.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
    let rms = (power / buf.len().max(1) as f64).sqrt();
    if rms <= 0.0 {
        return;
    }
    let noise_rms = rms / 10f64.powf(snr_db / 20.0);
    for s in buf.iter_mut() {
        *s += (rng.normal() * noise_rms) as f32;
    }
}

/// Linear-interpolation resampler. `ratio` > 1 stretches (a slow clock), < 1 compresses.
///
/// Linear interpolation is not hi-fi, but drift factors here are within a few parts per
/// million of unity, so the interpolation error is far below the noise floor we add on
/// purpose — and using anything fancier would risk the resampler, not the engine, being
/// what the drift test measures.
#[must_use]
pub fn resample(input: &[f32], ratio: f64) -> Vec<f32> {
    if input.is_empty() || ratio <= 0.0 {
        return Vec::new();
    }
    let out_len = ((input.len() as f64) * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let i0 = src.floor() as usize;
        let frac = (src - src.floor()) as f32;
        let a = input.get(i0).copied().unwrap_or(0.0);
        let b = input.get(i0 + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(buf: &[f32]) -> f64 {
        (buf.iter()
            .map(|s| f64::from(*s) * f64::from(*s))
            .sum::<f64>()
            / buf.len() as f64)
            .sqrt()
    }

    #[test]
    fn the_master_is_deterministic_and_bounded() {
        let a = generate_master(&mut Rng::new(1), 2.0, MASTER_RATE);
        let b = generate_master(&mut Rng::new(1), 2.0, MASTER_RATE);
        assert_eq!(a, b, "same seed must give identical audio");
        assert_eq!(a.len(), 2 * MASTER_RATE as usize);
        assert!(a.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
        assert!(rms(&a) > 0.01, "must not be near-silent");
    }

    #[test]
    fn different_seeds_give_different_audio() {
        let a = generate_master(&mut Rng::new(1), 1.0, MASTER_RATE);
        let b = generate_master(&mut Rng::new(2), 1.0, MASTER_RATE);
        assert_ne!(a, b);
    }

    #[test]
    fn the_master_is_broadband_not_tonal() {
        // The property the suite depends on: strongly periodic audio would make the
        // correlation peak ambiguous by a whole period, and the accuracy gates
        // meaningless.
        //
        // Measured at 30 s because the ratio is length-dependent — the sustained tonal
        // bed dominates a short excerpt but is diluted over a realistic clip. Surveyed
        // across six seeds: 0.68 at 1 s, 0.59 at 3 s, 0.54 at 10 s, 0.34 at 30 s, 0.18
        // at 90 s. §4.3 correlates 20 s segments or whole short clips, so 30 s is the
        // representative end of that range.
        //
        // This is raw autocorrelation, which is a deliberately *pessimistic* proxy:
        // PHAT whitening flattens the magnitude spectrum before correlating, removing
        // precisely the energy dominance that produces these side lobes. The real
        // guarantee is the accuracy measurement in crates/core; this only catches a
        // fixture generator that has degenerated into producing tones.
        let x = generate_master(&mut Rng::new(3), 30.0, MASTER_RATE);
        let energy: f64 = x.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
        let mut worst: f64 = 0.0;
        // Skip very short lags, where any smooth signal correlates with itself.
        for lag in (500..40_000).step_by(997) {
            let c: f64 = x[lag..]
                .iter()
                .zip(x.iter())
                .map(|(a, b)| f64::from(*a) * f64::from(*b))
                .sum();
            worst = worst.max((c / energy).abs());
        }
        assert!(worst < 0.45, "too periodic: peak side-lobe ratio {worst}");
    }

    #[test]
    fn gain_scales_amplitude_predictably() {
        let x = generate_master(&mut Rng::new(4), 0.5, MASTER_RATE);
        let c = Colour {
            gain_db: -6.0,
            ..Colour::default()
        };
        let y = colour(&x, &c, MASTER_RATE, &mut Rng::new(0));
        let ratio = rms(&y) / rms(&x);
        assert!((ratio - 0.501).abs() < 0.02, "ratio {ratio}");
    }

    #[test]
    fn noise_lands_at_the_requested_snr() {
        let x = generate_master(&mut Rng::new(5), 1.0, MASTER_RATE);
        for target in [20.0, 10.0, 0.0] {
            let c = Colour {
                snr_db: Some(target),
                ..Colour::default()
            };
            let y = colour(&x, &c, MASTER_RATE, &mut Rng::new(1));
            let noise: Vec<f32> = y.iter().zip(x.iter()).map(|(a, b)| a - b).collect();
            let measured = 20.0 * (rms(&x) / rms(&noise)).log10();
            assert!(
                (measured - target).abs() < 1.0,
                "asked for {target} dB, measured {measured} dB"
            );
        }
    }

    #[test]
    fn colouring_changes_the_signal_without_destroying_it() {
        // Reverb + tilt must leave something a correlator can still work with.
        let x = generate_master(&mut Rng::new(6), 1.0, MASTER_RATE);
        let c = Colour {
            gain_db: -3.0,
            tilt: -0.6,
            reverb: 0.5,
            snr_db: Some(15.0),
            ..Colour::default()
        };
        let y = colour(&x, &c, MASTER_RATE, &mut Rng::new(2));
        assert_eq!(y.len(), x.len());
        assert!(y.iter().all(|s| s.is_finite()));
        assert!(rms(&y) > 0.005, "colouring must not silence the signal");
        assert_ne!(y, x);
    }

    #[test]
    fn drift_stretches_by_the_requested_amount() {
        // §8.2 wants drift estimated within ±5 ppm, so the injected drift must itself
        // be accurate. 1000 ppm over 10 s is 10 ms — checked to the sample.
        let x = generate_master(&mut Rng::new(7), 10.0, MASTER_RATE);
        let c = Colour {
            drift_ppm: 1000.0,
            ..Colour::default()
        };
        let y = colour(&x, &c, MASTER_RATE, &mut Rng::new(3));
        let expected = (x.len() as f64 * 1.001) as usize;
        assert!(
            (y.len() as i64 - expected as i64).abs() <= 1,
            "got {} samples, expected {expected}",
            y.len()
        );
    }

    #[test]
    fn resampling_by_unity_is_a_near_identity() {
        let x = generate_master(&mut Rng::new(8), 0.5, MASTER_RATE);
        let y = resample(&x, 1.0);
        assert_eq!(y.len(), x.len());
        assert_eq!(y, x, "unity resampling must not perturb samples");
    }

    #[test]
    fn resample_handles_degenerate_input() {
        assert!(resample(&[], 1.5).is_empty());
        assert!(resample(&[1.0, 2.0], 0.0).is_empty());
        assert!(resample(&[1.0, 2.0], -1.0).is_empty());
    }
}
