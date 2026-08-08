# Fuzzing

`cargo-fuzz` targets for the three parsers the engine feeds directly from untrusted,
attacker-influenceable input (E3 / docs/DECISIONS.md **D-032**):

| Target | Parser | Input source |
| --- | --- | --- |
| `probe_from_json` | `probe::from_json` (via the `fuzzing`-gated `probe::fuzz_from_json`) | ffprobe's JSON for a dropped file |
| `parse_iso8601_epoch` | `place::parse_iso8601_epoch` | a container's `creation_time` tag |
| `rational_parse` | `Rational::parse` | ffprobe's `r_frame_rate` |

The WAV-fixture reader the E3 brief mentions is **not** fuzzed: `crates/fixturegen/wav.rs`
is a *writer*, and the only bytes the engine reads back are its own cache's raw `f32le`
(written by ffmpeg, not parsed from an untrusted container), so there is no untrusted WAV
reader to target. Noted here so its absence is a decision, not an oversight.

## Layout

This is its own cargo workspace (the empty `[workspace]` in `Cargo.toml`), so the repo's
root `cargo build/clippy/test --workspace` gates never build it — the same isolation
`app/src-tauri` gets. Nothing here can break the root gates.

## Running under cargo-fuzz (nightly)

```sh
cargo install cargo-fuzz          # once
cd fuzz
cargo +nightly fuzz build --features libfuzzer
cargo +nightly fuzz run  --features libfuzzer probe_from_json -- -max_total_time=30
cargo +nightly fuzz run  --features libfuzzer parse_iso8601_epoch -- -max_total_time=30
cargo +nightly fuzz run  --features libfuzzer rational_parse -- -max_total_time=30
```

cargo-fuzz sets `--cfg fuzzing`; `--features libfuzzer` pulls in `libfuzzer-sys` and
switches each target from its smoke `main` to a `fuzz_target!` entry point.

## Smoke-checking on stable (no nightly, no cargo-fuzz)

With the `libfuzzer` feature off (the default) every target compiles as an ordinary binary
whose `main` runs a handful of adversarial seeds — enough to catch an immediate panic and
to prove the harness links:

```sh
cd fuzz
cargo run --bin probe_from_json
cargo run --bin parse_iso8601_epoch
cargo run --bin rational_parse
# or point one at a file / corpus entry:
cargo run --bin probe_from_json -- ../fixtures/hostile/malformed.bin
```
