# Decisions

Deviations from [`PLAN.md`](PLAN.md), new dependencies (§13.3), and anything learned about
Resolve's importer (§13.6). Newest last. The plan stays authoritative; this file records
where reality differed and why.

---

## D-001 — Crate packages are `sundaysync-*`, not bare `cli` / `core`

**Phase 0.** PLAN §3 names the directories `crates/core`, `crates/cli`, `crates/fixturegen`,
and §11 writes the Phase 0 acceptance command as `cargo run -p cli -- sync --help`.

The directories are as specified, but the cargo *packages* are `sundaysync-core`,
`sundaysync-cli` and `sundaysync-fixturegen`, matching SundayRec's `sundayrec-core`
precedent and avoiding a package literally named `cli`. The acceptance command is
therefore:

```
cargo run -p sundaysync-cli -- sync --help
```

The **binary** is still `sundaysync`, so the user-facing command surface is unchanged.
Not treated as an irreversible decision under §0 (it is not a file format, result schema,
or public CLI flag).

## D-002 — `unwrap`/`expect` lints are crate-scoped, and the workspace lint block is duplicated

**Phase 0.** §7.1 forbids `unwrap`/`expect` in `core` outside tests. Implemented as
`unwrap_used = "deny"` / `expect_used = "deny"` in `crates/core/Cargo.toml`, with the
in-test carve-out (`allow-unwrap-in-tests`, `allow-expect-in-tests`) in the workspace-root
`clippy.toml` — that file has no per-crate form, so it must live at the root even though
the lints do not.

The lints are deliberately **not** applied to `cli` or `fixturegen`: the stability promise
in §7 is about the engine, and a panic in a dev tool that is about to exit is not the
failure mode the plan is defending against.

Cargo rejects a crate that both inherits `lints.workspace = true` and adds its own
entries, so `crates/core/Cargo.toml` restates the two `rust` lints and `clippy::all`
verbatim. **These must be kept in sync manually with the root `Cargo.toml`.**

Verified by injecting an `unwrap()` into `crates/core/src/request.rs` and confirming
`cargo clippy -- -D warnings` fails, while the existing tests (which use `unwrap` freely)
stay green. A lint that is configured but does not fire is worse than none.

## D-003 — Frame rates are an exact `Rational`, never `f64`

**Phase 0.** §5 serialises `sequence.fps` as the string `"25/1"` and §6 requires FCPXML
frame durations as exact rationals. `crates/core/src/rational.rs` implements a reduced,
strictly-positive rational that serialises to/from that string form.

`Rational::new()` returns `Option`, not a panicking constructor, because frame rates come
from ffprobe — i.e. from untrusted file metadata. `0/0` is not hypothetical: ffprobe
reports exactly that for the audio stream of an ordinary MP4 (observed during the kickoff
validation below).

## D-004 — ⚠️ Codec decoder delay is a live threat to the ±10 ms accuracy gate

**Phase 0, found during environment validation — carry this into Phase 3.**

ffmpeg/ffprobe 8.1.2 were installed via Homebrew (they were absent from the machine
entirely). Both command lines in the plan were validated live:

- §4.1 `ffprobe -v error -print_format json -show_format -show_streams` returns everything
  the probe stage needs, including `r_frame_rate` as a rational (`25/1`) and the
  `format.tags.creation_time` path. The **audio** stream of a normal MP4 reports
  `r_frame_rate = 0/0` — hence D-003's `Option`-returning constructor.
- §4.2 `ffmpeg -map 0:a:0 -ac 1 -ar 12000 -f f32le` works, and costs **46.9 KB/s**,
  confirming the plan's ~48 KB/s cache-footprint estimate.

**The finding:** a **3.000 s** AAC/MP4 test file decoded to **36 096 samples = 3.008 s** —
an 8 ms overshoot attributable to AAC encoder priming/padding.

The §8.2 gate is **±10 ms**. A systematic per-codec decoder delay would consume most of
that budget by itself, and — because it is *constant per device* — would present as a
plausible sync result rather than an obvious bug. Cameras in one shoot routinely use
different codecs, so this is the target scenario, not an edge case.

**Consequences for Phase 3:**
1. `fixturegen` (§8.1) must emit fixtures spanning **multiple codecs** — at minimum
   PCM/wav, AAC, and one long-GOP camera codec. A wav-only suite would pass CI green
   while the product mis-syncs every real camera.
2. Decode alignment must be verified against known truth **per codec** before `MIN_PSR`
   is calibrated, so calibration is not fitted to a codec-specific bias.
3. If a per-codec constant offset is confirmed, decide explicitly whether to compensate
   in the extraction stage or to document it — and record that here.

## D-005 — Dependencies added in Phase 0

Per §13.3, one line each:

| Crate | Why |
| --- | --- |
| `serde` + `serde_json` | The `SyncResult` contract (§5) is JSON; the CLI and the diagnostics zip both emit it. |
| `thiserror` | §7.1 requires typed errors on all fallible paths. |
| `clap` (derive) | CLI argument parsing; `derive` keeps `--help` and the parsed struct from drifting apart. |

No FFT, XML or hashing dependency yet — `rustfft`, `quick-xml` and `blake3` arrive with
the phases that need them (3, 5 and 2 respectively).
