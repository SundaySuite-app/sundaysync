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

## D-005 — CI runs the full gate on ubuntu, plus a build/test pass on macOS and Windows

**Phase 0.** §11's Phase 0 criterion reads "CI green on all three platforms' checks",
while §8.4 specifies the per-push gate as an ubuntu runner with Win/mac bundles only on
tags. Resolved in favour of the stricter reading, since the repo is public and Actions
minutes are therefore free:

- **ubuntu** — the full gate: `fmt`, `clippy -D warnings`, `cargo test`, and the §11
  acceptance command, plus a separate `cargo audit` job.
- **macOS + Windows** — `cargo test --workspace` only. Enough to catch platform-specific
  breakage (path handling, child-process spawning, line endings) on the commit that
  introduced it rather than at the Phase 9 release build.

**Resolved in Phase 1** — the skip-path option, with a guard against the obvious failure
mode. Tests needing ffprobe call a helper that skips (printing `SKIP: …`) when the binary
is absent, *unless* `SUNDAYSYNC_REQUIRE_FFMPEG` is set, in which case the skip becomes an
assertion failure. The ubuntu job sets it. So the probe suite runs for real on the
platform with the full gate, a broken ffmpeg install there fails loudly instead of
quietly skipping, macOS/Windows stay ~30 s instead of several minutes of brew/choco, and
a contributor without ffmpeg can still run `cargo test`. Revisit if a platform-specific
decode bug ever slips through.

## D-006 — Dependencies added in Phase 0

Per §13.3, one line each:

| Crate | Why |
| --- | --- |
| `serde` + `serde_json` | The `SyncResult` contract (§5) is JSON; the CLI and the diagnostics zip both emit it. |
| `thiserror` | §7.1 requires typed errors on all fallible paths. |
| `clap` (derive) | CLI argument parsing; `derive` keeps `--help` and the parsed struct from drifting apart. |

No FFT, XML or hashing dependency yet — `rustfft`, `quick-xml` and `blake3` arrive with
the phases that need them (3, 5 and 2 respectively).

## D-007 — Device labels are bare values; the UI supplies the localised prefix

**Phase 1.** §4.5 gives example labels "Sony A7 IV", **"Mappe: Balkong"**, "Zoom H6". The
middle one is Norwegian, and §9 requires a bilingual (nb + en) UI — so emitting it from
the engine would hardcode one language into the wire contract and leave the English UI
showing Norwegian.

`Device.label` therefore carries the bare value (`"Balkong"`), and the provenance is
recoverable from `Device.id`, which is namespaced by the heuristic that produced it
(`folder-balkong`, `model-sony-ilce-7m4`, `name-zoom`, `sig-h264-1920x1080-25-1`). The UI
renders "Mappe: Balkong" or "Folder: Balkong" from the `folder-` prefix. No §5 schema
change was needed.

## D-008 — §4.5 heuristics are applied per file, not per shoot

**Phase 1.** §4.5 lists four heuristics "in priority order" without saying whether the
order picks one strategy for the whole input set or is a per-file fallback chain.
Implemented as **per file**.

A real shoot is mixed: three cameras that write a `model` tag plus a Zoom recorder that
writes none is the typical case. A set-wide choice would observe "not every file has
metadata", fall back to filenames for everything, and discard camera identities it
already had. Keys are namespaced by heuristic so two files can never collide across
strategies. Covered by `a_mixed_shoot_keeps_camera_identity_and_still_groups_the_recorder`.

Two sub-decisions inside heuristic 1 (folders), both driven by realistic layouts:

- The key is the first subdirectory **below** a dropped folder, not the dropped folder
  itself. Dropping one `Opptak/` containing `Balkong/`, `Scene/`, `Zoom/` is how people
  actually organise card dumps; keying on the drop root would collapse all three into
  one device.
- Files sitting *directly* in a single dropped folder do not group by it — the key would
  be constant and carry no information — so they fall through to the filename heuristic.

`device::group` is a pure function and does not touch the filesystem. The caller passes
the directory subset it already established while walking. An earlier version re-derived
it with `is_dir()`, which made grouping depend on disk state that can change mid-run and
made the logic untestable without creating real directories per case.

## D-010 — ⚠️ A killed child does not close its pipes; never join readers on the timeout path

**Phase 1, found by CI.** The first version of `sidecar::run` polled `try_wait`, killed
the child on timeout, then joined the stdout/stderr reader threads before returning. That
is wrong, and wrong in a way that silently defeats the timeout.

**Killing a process does not close pipes its own children inherited.** `sh -c "sleep 30"`
under Ubuntu's dash forks `sleep`, which inherits the write end of our stdout pipe.
Killing the shell leaves `sleep` holding it, so `read_to_end` — and therefore `join()` —
blocks until the *grandchild* exits. A 150 ms timeout returned after **30.002 s**.

The fix: on the timeout path, return immediately without joining, and discard the output
(a timed-out probe has nothing trustworthy to say anyway). The detached threads are
harmless — each is blocked on a read that ends when the pipe finally closes.

**Two things worth remembering from this:**

1. **It was invisible on the development machine.** macOS's `sh` *execs* `sleep` rather
   than forking, so killing the child did close the pipe and the test passed locally. It
   only failed on the ubuntu runner. This is the concrete justification for the
   cross-platform CI jobs added in D-005 — they earned their keep on the very next phase.
2. **The consequence was not limited to tests.** An unbounded wait here would have broken
   §7.2 (a bad file cannot stall the run) and §7.4 (cancel returns within 2 s), because
   both ultimately depend on `run()` actually returning when it says it will.

Regression test: `a_grandchild_holding_the_pipe_cannot_extend_the_timeout`, which uses
`sleep 300 & wait` to force the fork on *every* shell rather than relying on dash's
behaviour. Verified to fail against the old code — it hangs past 45 s — and to pass in
0.6 s against the fix.

## D-009 — Dotfiles are skipped during the scan walk

**Phase 1.** §4.1 says "reject nothing by extension", and that is honoured — no
extension is ever consulted. But hidden files are skipped: `.DS_Store` and the
AppleDouble `._C0001.MP4` companions macOS scatters across every camera card. These are
filesystem metadata, not media, and probing them would fill the unsynced list with
entries that look like real failures and bury the ones that are.

**Known gap, deliberately not addressed in v1:** GoPro `.LRV` low-resolution proxies are
genuine media with audio and would appear as a phantom extra device. Filtering them would
mean rejecting by extension, which §4.1 forbids. Left for the Phase 6 corpus to judge on
real footage rather than guessed at now.
