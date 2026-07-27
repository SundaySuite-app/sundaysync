//! Exact frame rates as rationals.
//!
//! Frame rates must never round-trip through `f64`. NTSC-family rates are `30000/1001`,
//! `24000/1001`, `60000/1001` — none of which are representable exactly in binary
//! floating point. docs/PLAN.md §6 requires FCPXML frame durations to be emitted as
//! exact rationals (`1001/30000s`), and §5 serialises `sequence.fps` as the string
//! `"25/1"`. A `f64` fps would make both of those lossy, and the error compounds over a
//! two-hour service: at 29.97 fps, a rounded rate drifts by roughly a frame per hour —
//! which is precisely the failure this product exists to prevent.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// An exact, always-reduced, strictly-positive rational.
///
/// Serialises as the string `"num/den"` (docs/PLAN.md §5) rather than as an object, so
/// the JSON stays readable and matches the plan's worked example verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Rational {
    num: u32,
    den: u32,
}

impl Rational {
    /// 1/1. Usable in const context, and the natural total fallback for code that must
    /// not panic when a compile-time rate constant fails validation (§7.1).
    pub const ONE: Self = Self { num: 1, den: 1 };

    /// Builds a reduced rational, or `None` if the denominator or numerator is zero.
    ///
    /// Returns `Option` rather than panicking because frame rates arrive from ffprobe,
    /// i.e. from untrusted file metadata: a corrupt file reporting `r_frame_rate=0/0`
    /// is a routine occurrence (our own audio-only test file reports exactly that), not
    /// a programming error. docs/PLAN.md §7.1 forbids panicking on such input.
    #[must_use]
    pub fn new(num: u32, den: u32) -> Option<Self> {
        if num == 0 || den == 0 {
            return None;
        }
        let g = gcd(num, den);
        Some(Self {
            num: num / g,
            den: den / g,
        })
    }

    #[must_use]
    pub const fn num(self) -> u32 {
        self.num
    }

    #[must_use]
    pub const fn den(self) -> u32 {
        self.den
    }

    /// The reciprocal — a frame *duration* from a frame *rate*.
    ///
    /// Total because `new()` already rejects a zero numerator, so the flip can never
    /// produce a zero denominator.
    #[must_use]
    pub const fn recip(self) -> Self {
        Self {
            num: self.den,
            den: self.num,
        }
    }

    /// Decimal value. For display and tolerance comparisons only — never for timeline
    /// arithmetic, which must stay in the rational domain (see the module docs).
    #[must_use]
    pub fn as_f64(self) -> f64 {
        f64::from(self.num) / f64::from(self.den)
    }

    /// Parses `"30000/1001"`, and also bare `"25"` (which ffprobe emits for some
    /// containers).
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s.split_once('/') {
            Some((n, d)) => Self::new(n.trim().parse().ok()?, d.trim().parse().ok()?),
            None => Self::new(s.trim().parse().ok()?, 1),
        }
    }
}

impl fmt::Display for Rational {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.num, self.den)
    }
}

impl Serialize for Rational {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Rational {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::parse(&s).ok_or_else(|| serde::de::Error::custom(format!("invalid rational: {s}")))
    }
}

const fn gcd(mut a: u32, mut b: u32) -> u32 {
    while b != 0 {
        let t = b;
        b = a % b;
        a = t;
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduces_on_construction() {
        // Two spellings of 25 fps must compare equal, or deterministic output (§3)
        // would depend on which container the rate happened to come from.
        assert_eq!(Rational::new(50, 2), Rational::new(25, 1));
        assert_eq!(
            Rational::new(30000, 1001).unwrap().to_string(),
            "30000/1001"
        );
    }

    #[test]
    fn rejects_degenerate_rates() {
        // ffprobe reports `0/0` for the audio stream of a normal file — see the
        // kickoff validation in docs/DECISIONS.md. This must be `None`, not a panic.
        assert_eq!(Rational::new(0, 0), None);
        assert_eq!(Rational::new(25, 0), None);
        assert_eq!(Rational::parse("0/0"), None);
    }

    #[test]
    fn parses_both_spellings() {
        assert_eq!(Rational::parse("25/1"), Rational::new(25, 1));
        assert_eq!(Rational::parse("25"), Rational::new(25, 1));
        assert_eq!(Rational::parse("nonsense"), None);
    }

    #[test]
    fn ntsc_frame_duration_is_exact() {
        // The FCPXML frame duration for 29.97 fps is exactly 1001/30000s (§6).
        let fps = Rational::new(30000, 1001).unwrap();
        assert_eq!(fps.recip().to_string(), "1001/30000");
    }

    #[test]
    fn round_trips_through_json() {
        let fps = Rational::new(24000, 1001).unwrap();
        let json = serde_json::to_string(&fps).unwrap();
        assert_eq!(json, "\"24000/1001\"");
        assert_eq!(serde_json::from_str::<Rational>(&json).unwrap(), fps);
    }
}
