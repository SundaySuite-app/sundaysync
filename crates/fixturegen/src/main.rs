//! `fixturegen` — deterministic synthetic test-media generator (docs/PLAN.md §8.1).
//!
//! Builds a whole multicamera shoot from a seed + spec: base audio cut into clips at
//! known ground-truth offsets, then per device gain, EQ colouration, synthetic reverb,
//! crowd noise at a set SNR, and clock drift. Emits tiny real media plus a `truth.json`.
//! This is the backbone of CI — the accuracy gates in §8.2 are measured against it.
//!
//! **Phase 0.** Not implemented. Built first in Phase 3, before the GCC-PHAT engine it
//! exists to validate.
//!
//! # Codec coverage is not optional
//!
//! A 3.000 s AAC/MP4 file decodes to 3.008 s — an 8 ms overshoot from AAC encoder
//! priming, measured on ffmpeg 8.1.2 during project kickoff (docs/DECISIONS.md, D-004).
//! The §8.2 accuracy gate is ±10 ms, so a systematic per-codec decoder delay would
//! consume most of the error budget on its own, and would present as a plausible
//! constant per-device offset rather than an obvious bug.
//!
//! Fixtures must therefore span **several codecs** — at minimum PCM/wav, AAC, and one
//! long-GOP camera codec — not wav alone. A wav-only suite would pass CI green while
//! the product mis-syncs every real camera.

fn main() {
    eprintln!(
        "fixturegen is not implemented yet — it is built in Phase 3.\n\
         See docs/PLAN.md §8.1 and docs/STATUS.md."
    );
}
