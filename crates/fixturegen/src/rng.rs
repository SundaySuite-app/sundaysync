//! Deterministic pseudo-randomness.
//!
//! Fixtures must be reproducible from a seed alone (docs/PLAN.md §8.1) — a suite that
//! generates different audio each run cannot support the accuracy gates in §8.2, because
//! a failure could never be reproduced or bisected.
//!
//! Hand-rolled rather than pulled from `rand` for two reasons: the engine's whole
//! premise is determinism, and `rand`'s generators are explicitly allowed to change
//! their output stream across major versions. A fixture suite whose ground truth shifts
//! on a dependency bump is worse than useless. This is xoshiro256** seeded through
//! splitmix64 — both public domain, both fully specified, and neither will ever change.

/// xoshiro256\*\* — fast, deterministic, and good enough for shaping test audio.
///
/// Not cryptographic, and nothing here needs it to be.
#[derive(Debug, Clone)]
pub struct Rng {
    s: [u64; 4],
}

impl Rng {
    #[must_use]
    pub fn new(seed: u64) -> Self {
        // splitmix64 expands one seed word into the four xoshiro needs. Seeding all
        // four from the raw seed would make nearby seeds produce correlated streams.
        let mut z = seed;
        let mut next = || {
            z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut x = z;
            x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            x ^ (x >> 31)
        };
        Self {
            s: [next(), next(), next(), next()],
        }
    }

    /// Derives an independent stream. Lets each device shape its own audio without its
    /// draws depending on how many the previous device happened to make.
    #[must_use]
    pub fn fork(&self, label: &str) -> Self {
        let mut h = 0xcbf2_9ce4_8422_2325_u64;
        for b in label.as_bytes() {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01B3);
        }
        Self::new(self.s[0] ^ h)
    }

    pub fn next_u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        // Top 53 bits: exactly the f64 mantissa, so every representable value in the
        // range is reachable and none is favoured.
        (self.next_u64() >> 11) as f64 * (1.0 / 9_007_199_254_740_992.0)
    }

    /// Uniform in [lo, hi).
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + self.unit() * (hi - lo)
    }

    /// Standard normal, via Box–Muller.
    ///
    /// Used for noise beds, where the Gaussian shape matters: real room and preamp noise
    /// is Gaussian, and uniform noise would give GCC-PHAT an easier problem than reality.
    pub fn normal(&mut self) -> f64 {
        // `unit()` can return exactly 0, whose log is -inf. Nudging into (0, 1] costs
        // nothing and removes the only way this can produce a non-finite sample.
        let u1 = self.unit().max(f64::MIN_POSITIVE);
        let u2 = self.unit();
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }

    pub fn bool_with(&mut self, p: f64) -> bool {
        self.unit() < p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_gives_the_same_stream() {
        let a: Vec<u64> = (0..64).map(|_| Rng::new(42).next_u64()).collect();
        let mut r = Rng::new(42);
        let b: Vec<u64> = (0..64).map(|_| r.next_u64()).collect();
        assert_eq!(a[0], b[0]);

        let mut x = Rng::new(7);
        let mut y = Rng::new(7);
        let xs: Vec<u64> = (0..1000).map(|_| x.next_u64()).collect();
        let ys: Vec<u64> = (0..1000).map(|_| y.next_u64()).collect();
        assert_eq!(xs, ys);
    }

    #[test]
    fn nearby_seeds_are_not_correlated() {
        // The reason for splitmix64 seeding: raw-seeding xoshiro makes seeds 1 and 2
        // produce near-identical opening streams.
        let mut a = Rng::new(1);
        let mut b = Rng::new(2);
        let first_a: Vec<u64> = (0..8).map(|_| a.next_u64()).collect();
        let first_b: Vec<u64> = (0..8).map(|_| b.next_u64()).collect();
        assert!(first_a.iter().zip(&first_b).all(|(x, y)| x != y));
    }

    #[test]
    fn forks_are_independent_and_reproducible() {
        let base = Rng::new(99);
        let mut cam_a = base.fork("cam-a");
        let mut cam_b = base.fork("cam-b");
        assert_ne!(cam_a.next_u64(), cam_b.next_u64());

        // Same label, same stream — regardless of what any other fork drew.
        let mut again = Rng::new(99).fork("cam-a");
        assert_eq!(Rng::new(99).fork("cam-a").next_u64(), again.next_u64());
    }

    #[test]
    fn unit_stays_in_range_and_normal_stays_finite() {
        let mut r = Rng::new(5);
        for _ in 0..100_000 {
            let u = r.unit();
            assert!((0.0..1.0).contains(&u), "{u}");
            assert!(r.normal().is_finite());
        }
    }

    #[test]
    fn normal_has_roughly_the_right_moments() {
        let mut r = Rng::new(11);
        let n = 200_000;
        let samples: Vec<f64> = (0..n).map(|_| r.normal()).collect();
        let mean = samples.iter().sum::<f64>() / n as f64;
        let var = samples.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n as f64;
        assert!(mean.abs() < 0.02, "mean {mean}");
        assert!((var - 1.0).abs() < 0.03, "variance {var}");
    }
}
