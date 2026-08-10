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
> SmartScreen's "More info" → "Run anyway". **ffmpeg is bundled** — nothing
> to install alongside it (~60 MB download, ~135 MB installed; D-031), and
> onboarding self-tests it. Details in [`docs/STATUS.md`](docs/STATUS.md) and
> [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md).

## What it is for

Long church services, concerts and events: several cameras that start and stop
independently, one mixer or recorder feed for good audio, and no timecode anywhere. That
is the scenario this is tuned for.

The core promise is **honest failure over silent wrongness**. A clip the engine is not
confident about is reported as unsynced, with a plain-language reason — never placed
hopefully. A wrong sync costs an editor far more than an admitted one.

## Checking the result before you export

The result is an interactive **timeline**, not a report you have to take on trust. One
track per device against a real time axis: zoom from the whole day down to a single
millisecond, pan, scrub, and click any clip for the exact numbers behind its placement.
Every clip draws its own **waveform**, built from the analysis audio the sync already
cached — no second decode of your media, and a picture of the very signal the offsets were
computed from.

Then **press play**. Every clip sounds at once at the offsets the engine chose, with mute
and solo per device. Correctly aligned recordings of the same room sound *phasey* — a
hollow doubling; a distinct echo means something is wrong. That is a ten-second check
instead of an export and a round trip through Resolve. What you hear is the 12 kHz mono
analysis audio, deliberately — it proves alignment, it is not a mix (see
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md)).

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

Requires a stable Rust toolchain and `ffmpeg` + `ffprobe` reachable — on `PATH`, or in
`/opt/homebrew/bin`, `/usr/local/bin` or `/opt/local/bin` (D-031). The *shipped app*
bundles its own; `npm run ffmpeg` in `app/` fetches the pair a bundle needs.

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

Clock-drift **correction shipped in v0.2** (D-042), using exactly the drift data v1 already
recorded, and v0.3 added the interactive timeline, per-clip waveforms and playback. Premiere/
FCP7 export and AAF remain parked in PLAN.md §12 — deliberately out of scope until the
Resolve path is solid.
