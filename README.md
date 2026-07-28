# SundaySync

Drop in everything from a multicamera shoot — cameras, a recorder feed, whole folders —
press Sync, and get a synchronized timeline out as FCPXML for **DaVinci Resolve**.

No timecode required. No cloud, no accounts, no telemetry: everything runs locally, and
it is free, like the rest of the Sunday suite.

> **Status: engine complete and Resolve-verified; desktop app in test.**
> Download a test build from the
> [releases page](https://github.com/SundaySuite-app/sundaysync/releases) —
> unsigned for now, so macOS needs right-click → Open the first time
> (or `xattr -cr /Applications/SundaySync.app`), and Windows needs
> SmartScreen's "More info" → "Run anyway". **Requires ffmpeg on PATH**
> (`brew install ffmpeg` / `winget install ffmpeg`); the app's onboarding
> checks and tells you. Details in [`docs/STATUS.md`](docs/STATUS.md) and
> [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md).

## What it is for

Long church services, concerts and events: several cameras that start and stop
independently, one mixer or recorder feed for good audio, and no timecode anywhere. That
is the scenario this is tuned for.

The core promise is **honest failure over silent wrongness**. A clip the engine is not
confident about is reported as unsynced, with a plain-language reason — never placed
hopefully. A wrong sync costs an editor far more than an admitted one.

## Layout

```
crates/core/        the entire engine — no GUI, no Tauri. All DSP lives here.
crates/cli/         `sundaysync` binary. Used by CI, benchmarks, and power users.
crates/fixturegen/  deterministic synthetic test-media generator (Phase 3).
app/                Tauri 2 + React shell (Phase 7).
fixtures/           tiny generated fixtures committed for CI.
corpus/             real footage benchmarks — gitignored, lives on Richard's machine.
docs/               PLAN.md (source of truth), DECISIONS.md, STATUS.md.
```

## Development

Requires a stable Rust toolchain and `ffmpeg` + `ffprobe` on `PATH`.

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p sundaysync-cli -- sync --help
```

`crates/core` is deliberately GUI-free and never reads the wall clock, so the whole
pipeline is exercisable headlessly — which is what makes the accuracy gates in
[`docs/PLAN.md`](docs/PLAN.md) §8.2 testable at all.

## Documentation

- [`docs/PLAN.md`](docs/PLAN.md) — the v1 specification. Source of truth.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — deviations, new dependencies, Resolve findings.
- [`docs/STATUS.md`](docs/STATUS.md) — what is actually built.

## Roadmap

v1 measures and reports audio drift; **correction ships in v2** using exactly the drift
data v1 already records. Premiere/FCP7 export, AAF, and drift correction are all parked
in PLAN.md §12 — deliberately out of scope until v1 is solid.
