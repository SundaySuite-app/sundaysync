//! Fuzzes `rational::Rational::parse` — parses ffprobe's `r_frame_rate` ("30000/1001",
//! or a bare "25"), again attacker-influenced. Property: no input may panic it, and a
//! zero or overflowing denominator must fail cleanly rather than divide-by-zero later.
//!
//! Dual-build: see `probe_from_json.rs` and docs/DECISIONS.md D-032.
#![cfg_attr(all(fuzzing, feature = "libfuzzer"), no_main)]

#[inline]
fn run(data: &[u8]) {
    let s = String::from_utf8_lossy(data);
    if let Some(r) = sundaysync_core::Rational::parse(&s) {
        // A parsed rational must be evaluable without panicking (den != 0 is the invariant
        // `Rational::new` enforces; this exercises it end to end).
        let _ = r.as_f64();
    }
}

#[cfg(all(fuzzing, feature = "libfuzzer"))]
libfuzzer_sys::fuzz_target!(|data: &[u8]| run(data));

#[cfg(not(all(fuzzing, feature = "libfuzzer")))]
fn main() {
    let seeds: &[&[u8]] = &[
        b"",
        b"25",
        b"30000/1001",
        b"1/0",
        b"999999999999999999999/1",
        b"/",
        b"abc/def",
    ];
    smoke(run, seeds);
}

#[cfg(not(all(fuzzing, feature = "libfuzzer")))]
fn smoke(f: fn(&[u8]), seeds: &[&[u8]]) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        for s in seeds {
            f(s);
        }
        println!("smoke ok ({} seeds)", seeds.len());
    } else {
        for a in &args {
            match std::fs::read(a) {
                Ok(bytes) => f(&bytes),
                Err(e) => eprintln!("skip {a}: {e}"),
            }
        }
        println!("smoke ok ({} files)", args.len());
    }
}
