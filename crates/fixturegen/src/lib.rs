//! Deterministic synthetic test-media generator — docs/PLAN.md §8.1.
//!
//! Builds a whole multicamera shoot from a seed plus a spec: base audio cut into clips
//! at known ground-truth offsets, then per device gain, spectral tilt, synthetic reverb,
//! crowd noise at a set SNR, and clock drift. Emits real media plus a `truth.json`.
//!
//! This is the backbone of CI: the accuracy gates in §8.2 are measured against it, so a
//! flaw here is invisible and expensive. Everything is reproducible from the seed alone.

pub mod day;
pub mod hostile;
pub mod rng;
pub mod shoot;
pub mod signal;
pub mod wav;

pub use day::DaySpec;
pub use rng::Rng;
pub use shoot::{ClipSpec, Codec, DeviceSpec, ShootSpec, Truth, TruthClip};
pub use signal::{Colour, MASTER_RATE};
