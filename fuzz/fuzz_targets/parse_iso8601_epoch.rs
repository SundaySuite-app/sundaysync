//! Fuzzes `place::parse_iso8601_epoch` — the hand-rolled date parser fed a container's
//! `creation_time` tag, which comes straight from an attacker-influenced file. Property:
//! no input (any bytes, lossily read as text) may panic it; it returns `Some`/`None`.
//!
//! Dual-build: see `probe_from_json.rs` and docs/DECISIONS.md D-032.
#![cfg_attr(all(fuzzing, feature = "libfuzzer"), no_main)]

#[inline]
fn run(data: &[u8]) {
    let s = String::from_utf8_lossy(data);
    let _ = sundaysync_core::place::parse_iso8601_epoch(&s);
}

#[cfg(all(fuzzing, feature = "libfuzzer"))]
libfuzzer_sys::fuzz_target!(|data: &[u8]| run(data));

#[cfg(not(all(fuzzing, feature = "libfuzzer")))]
fn main() {
    let seeds: &[&[u8]] = &[
        b"",
        b"1970-01-01T00:00:00Z",
        b"2026-13-40T99:99:99Z",
        b"2024-02-29T12:00:00.500000Z",
        b"\xff\xfe not a date",
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
