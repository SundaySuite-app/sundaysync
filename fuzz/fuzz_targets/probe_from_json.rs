//! Fuzzes `probe::from_json` — the ffprobe-JSON parser, fed entirely by an external
//! process's output for an attacker-influenced file. Property: no bytes may panic it.
//!
//! Dual-build (docs/DECISIONS.md D-032): under cargo-fuzz (`--cfg fuzzing --features
//! libfuzzer`) this is a libFuzzer target; on plain stable `cargo build` it is an ordinary
//! smoke-runner binary, so the harness stays committed and verifiable without nightly.
#![cfg_attr(all(fuzzing, feature = "libfuzzer"), no_main)]

#[inline]
fn run(data: &[u8]) {
    let _ = sundaysync_core::probe::fuzz_from_json(data);
}

#[cfg(all(fuzzing, feature = "libfuzzer"))]
libfuzzer_sys::fuzz_target!(|data: &[u8]| run(data));

#[cfg(not(all(fuzzing, feature = "libfuzzer")))]
fn main() {
    let seeds: &[&[u8]] = &[
        b"",
        b"{}",
        b"not json at all",
        br#"{"streams":[],"format":{"format_name":"x","duration":"1.0"}}"#,
        br#"{"streams":[{"codec_type":"video","r_frame_rate":"0/0"}],"format":{"duration":"N/A"}}"#,
    ];
    smoke(run, seeds);
}

/// Stable smoke runner shared shape: run each CLI file argument (or the built-in seeds)
/// through `f` once, proving the harness links and the parser survives the seeds.
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
