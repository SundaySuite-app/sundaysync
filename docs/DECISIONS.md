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

## D-011 — Extraction returns cache handles, not audio; `AnalysisAudio` stays opaque

**Phase 2.** §7.7 requires a memory ceiling independent of shoot length and mentions
memory-mapping the analysis PCM. Two consequences for the API:

`Extractor::extract_all` populates the cache and returns [`CachedAudio`] *handles*;
samples are read on demand via `CachedAudio::load()`. Returning the audio itself would
blow the ceiling on its own — measured at 46.9 KB/s, a twenty-hour day is ~3.4 GB before
any FFT has allocated. §4.3 correlates one clip against the reference at a time, so that
is all that ever needs to be resident.

`AnalysisAudio` is opaque, exposing `samples() -> &[f32]`. It holds a `Vec<f32>` today.
**Memory-mapping is deliberately deferred to Phase 3**, when the FFT access pattern is
known and can say whether it is needed — and because `memmap2::Mmap::map` is `unsafe`,
which collides with the `unsafe_code = "forbid"` lint set in Phase 0. Adopting mmap means
relaxing that to `deny` plus a narrowly-scoped `#[allow]`. Making that trade now, before
there is a measured reason, would be premature. The opaque type means the switch is an
implementation detail rather than an API break.

## D-012 — Cancellation had to move into `sidecar::run`

**Phase 2.** §7.4 requires cancel to return within 2 s. Through Phase 1 that held for
free: probing takes ~30 ms, so a token checked between files was indistinguishable from
one checked continuously.

Extraction breaks that. Decoding a two-hour service takes far longer than two seconds, so
a token checked only at file boundaries would leave the Cancel button dead for the rest of
the decode. `sidecar::run` therefore takes a `&CancelToken` and kills the child mid-flight,
with a new `RunFailure::Cancelled`. Cancellation is checked *before* the deadline in the
poll loop, so a user who cancelled is told "cancelled" rather than "timed out" even if
both happened in the same instant.

Threaded through `probe` as `ProbeError::Cancelled`, which `scan` maps to
`Error::Cancelled` — deliberately **not** to `decode_error`, which would slander the
user's media for the crime of stopping the run.

## D-013 — Cache footprint: the per-second figure holds; the growth over time is unmanaged

**Phase 2, measured.** §4.2 estimates "~48 KB/s ≈ 1–2 % of source size" and tells the UI
to present this as a non-issue. Measured on 180 minutes of audio across 5 files:

| | |
| --- | --- |
| Cache rate | **46.9 KB per audio-second** — confirms the plan's ~48 KB/s |
| Cold extract | 7.1 s (peak concurrency 4, matching the §4.2 cap) |
| Warm extract | sub-millisecond, 0 ffmpeg processes |
| Cache for 3 h of audio | **518 MB** |

**The ratio claim is fine for real camera footage** — at 25–100 Mbit/s, 46.9 KB/s is
0.4–1.5 % of source, so a video-dominated shoot lands where the plan says. (An earlier
check against a synthetic `testsrc` clip suggested ~35 %, but that is meaningless:
`testsrc` compresses to roughly a hundredth of real sensor footage.)

**Two caveats the plan's framing misses, both about audio-only inputs:**

1. The ratio inverts for the recorder feed, which is usually the *longest* file and hence
   usually the reference (§4.4). Against a WAV feed the cache is ~16 % of source; against
   FLAC ~33 %; against a compressed `.m4a` feed it is **~290 %** — several times the
   source it came from.
2. **There is no eviction policy, and the plan does not mention one.** The cache grows by
   ~169 MB per audio-hour and nothing ever removes it. A church syncing a weekly service
   accumulates tens of GB over a year, silently.

Neither blocks Phase 2, and neither is a correctness problem. Both are **inputs to Phase
8** (advanced mode owns the cache directory setting) **and Phase 7's UI copy** — the
tooltip §4.2 asks for should not flatly call this negligible without showing the actual
number. Flagged rather than fixed here because sizing an eviction policy is a product
decision, not an engineering one.

## D-014 — ⚠️ The fixture reverb was lying, and it looked exactly like D-004

**Phase 3.** The first accuracy run showed every AAC clip measuring **−5.01 ms**,
consistently, across clips and seeds. That is precisely the signature D-004 predicted for
per-codec decoder delay: a constant per-codec bias that looks like a plausible result. It
would have been easy — and wrong — to write it up as confirmation and start compensating
for it in the engine.

FLAC also showed −1.24 ms. FLAC is lossless and has no decoder delay, which meant the
codec explanation could not be the whole story. Isolating each transform separately gave:

| transform | bias |
| --- | --- |
| none, gain, tilt, noise | 0.00 ms |
| reverb 0.20 | 0.00 ms |
| **reverb 0.55** | **−5.00 ms** |
| **reverb 0.80** | **−5.00 ms** |

The allpass delay in the fixture reverb is 5 ms, exactly. The reverb mixed
`dry * (1 - mix) + wet * mix`, where `wet` came from a comb bank that *included* the
direct sound and then through an allpass whose delayed term has unity gain against a
−0.7 direct term. Above `mix ≈ 0.5` the 5 ms-delayed copy became the strongest correlated
component in the signal. **The correlator was right; the fixture was wrong.**

Fixed by making the model physical: the direct arrival is always present at unity and is
always the loudest thing, with the tail (comb output *minus* the direct) summed on top.
Raising `mix` now makes the correlator's job harder — the point of the parameter —
without ever moving the true arrival. After the fix all transforms measure 0.00 ms bias,
and AAC's real error is **−0.01 ms**.

**The lesson is about method, not reverb.** A fixture suite is a measuring instrument, and
a plausible-looking result that matches a hypothesis you already hold is exactly when to
check the instrument. Had this shipped, the engine would have been "corrected" to
compensate for a bias that does not exist in real media, breaking it on every real shoot
to match a broken test.

D-004 itself remains open and unfalsified — it is simply not what this was. Real per-codec
delay, if any, is now measurably **≤ 0.01 ms** on AAC and MP4 through the ffmpeg decode
path, which is two orders of magnitude inside the §8.2 budget.

## D-015 — `MIN_PSR` calibrated to 15.0 (the plan's 5.0 was below the noise floor)

**Phase 3.** §4.3 requires calibration "against the synthetic suite to achieve zero false
positives while keeping false negatives < 5 %". Measured across five shoots (four `quick`
seeds plus one `full`), 16 syncable clips and 10 deliberately uncorrelated files, spanning
WAV, FLAC, AAC and MP4:

| | |
| --- | --- |
| Lowest PSR on a real match | **30.9** |
| Highest PSR on unrelated audio | **9.2** |
| Separation | 3.4x |
| Geometric midpoint | 16.9 |

**The plan's worked example of 5.0 sits below the noise floor** — unrelated audio scores
5.5–9.2 — and would have placed pure noise on the timeline. This was caught by the gate
that asserts uncorrelated fixtures are refused, which is exactly why §8.1 insists the
suite contain files with no correlation at all.

Set to **15.0**: 1.6x above the worst false positive, 2.1x below the weakest true
positive. Erring high is deliberate — §7.5 makes honest failure the core promise, so a
false negative (visible on the unsynced shelf) is much cheaper than a false positive
(a silently corrupted timeline).

**Must be re-validated against the real corpus in Phase 6.** Synthetic material cannot
prove a threshold for real rooms.

## D-016 — ✅ RESOLVED by D-042 (E6): drift is now corrected via a per-clip `<timeMap>`

**Resolution (E6, 2026-08-08).** Option 3 was taken — drift correction ships in v0.2 — but
without moving placement off the median. The exporter writes a per-clip `<timeMap>` retime
(the owner-signed-off, spike-proven mechanism, D-042) for any clip whose measured drift
exceeds half a frame, so short clips keep the median's balanced ±half-drift and long clips
are actively corrected end-to-end. The gate collision this note flagged no longer bites: a
90-minute 40 ppm camera now lands both ends on the reference instead of ±108 ms. The
analysis below is retained as the reasoning that led there.

**Phase 3, measured.** On the `full` suite the correlator is essentially exact on
non-drifting clips (**−0.01 ms**), and every residual error is accounted for, to the
millisecond, by injected clock drift:

| clip | drift | length | predicted (drift x length / 2) | measured |
| --- | --- | --- | --- | --- |
| cam-phone | 60 ppm | 300 s | 9.0 ms | **−9.51 ms** |
| cam-stage | 40 ppm | 400 s | 8.0 ms | **−8.01 ms** |
| cam-wide | −25 ppm | 280 s | 3.5 ms | **+3.34 ms** |

The half-drift relationship follows from §4.3 taking the *median* of segment offsets,
which estimates the offset at the clip's midpoint; error is therefore ±(total drift / 2),
zero in the middle and worst at both ends.

**This scales badly, and the plan's numbers collide.** §4.6 defers drift *correction* to
v2, but §8.2 requires ≥95 % of clips within ±10 ms. Median placement holds that only while
total drift stays under 20 ms — about **8 minutes** of clip at 40 ppm. A church camera
recording a 90-minute service continuously at 40 ppm accumulates 216 ms, giving a ±108 ms
error: outside ±10 ms, and outside the ±1 frame (40 ms) gate too.

So one of these must give, and it is not my call to make (§13.2):

1. **The gates assume short clips.** Fine if real cameras stop and restart often enough,
   which the Phase 6 corpus can settle — but it should be stated, not assumed.
2. **Place on the clip's start rather than the median.** Zero error at the start, full
   drift by the end. Arguably the better fit for FCPXML, which positions a clip *by* its
   start — but it contradicts §4.3's explicit "median offset is the estimate", so it is a
   plan change, not an implementation detail.
3. **Drift correction moves into v1**, contradicting §1.3 and §2.

Nothing is blocked today: the `quick` and `full` suites both pass as written, because
their clips are short enough. This is raised now because the Phase 6 corpus is where it
will bite, and because the drift data §4.6 already requires is exactly what any of the
three options needs.

## D-017 — Test builds are optimised; the fixture generator does not depend on the engine

**Phase 3.** Two small structural decisions:

`[profile.test] opt-level = 2`. The correlator is FFT-bound, and an unoptimised build made
§8.1's "quick suite in seconds" unreachable: the same accuracy run took **108 s** at cargo
defaults and **9.8 s** optimised. Debug assertions and overflow checks are retained, so
§7.3's invariants are still enforced during tests.

`sundaysync-fixturegen` deliberately does **not** depend on `sundaysync-core`; core
dev-depends on fixturegen instead. A measuring instrument that imports the thing it
measures can inherit its bugs — and after D-014, that is not a theoretical concern.

## D-018 — JSON round-trip is not bit-exact, and that is fine

**Phase 4, measured.** `serde_json` serialises an f64 correctly, but its parser is not
always correctly-rounded: over 200 000 values in the ±5000 s range, **9.7 %** come back
differing by exactly one ULP. Worst case is 4.5e-13 s — 0.45 picoseconds, eleven orders of
magnitude below a video frame.

Not worth fighting, and not a risk: the engine never round-trips through JSON in the
product path (the FCPXML exporter reads the in-memory struct), and §13.4's byte-equality
check compares two engine runs that both serialise from memory. The property test asserts
a 1 ns tolerance rather than bit equality, with the reason written down so nobody later
"fixes" it by adding `arbitrary_precision` and slowing every serialisation down.

Relevant if the v2 parking-lot item "project save/load of sync sessions" is ever built:
a reloaded session will differ from the original in the last bit of some offsets.

## D-019 — Drift precision needs lever arm; the ±5 ppm gate belongs to the full tier

**Phase 4.** §8.2 requires drift estimates within ±5 ppm. Drift is a *slope*, so its
precision depends on how much offset change the regression can see across a clip, against
roughly 1.5 samples of per-segment measurement noise:

| clip | span | offset change across segments | slope noise |
| --- | --- | --- | --- |
| `quick` cam-stage (60 s) | 40 s | 19 samples | ~8 % |
| `full` cam-stage (400 s) | 380 s | 182 samples | ~0.8 % |
| `full` cam-phone (300 s) | 280 s | 202 samples | ~0.7 % |

So the ±5 ppm gate is asserted on the **full** tier, where it passes comfortably —
injected −25/+40/+60 ppm measured as +24.75/−40.38/−58.69. The `quick` tier only checks
that drift is detected with a plausible magnitude, because a 60 s clip cannot support a
tighter claim honestly.

This is not a weakened gate (§13.2): it is the same gate, asserted where the measurement
is meaningful. A short clip's drift also matters less — 40 ppm over 60 s is 2.4 ms, well
inside a frame.

**Sign convention, recorded because v2 depends on it:** `drift_ppm` is
`d(offset)/d(position in clip)`. A clip recorded on a slow clock is physically *longer*
than reality, so matching content appears progressively earlier and the slope is
**negative** — the opposite sign to "stretched by N ppm". v2 corrects by resampling by
`1 / (1 + ppm * 1e-6)`; using `1 + ppm` would double the error instead of removing it.

## D-020 — ⚠️ The scan must skip the analysis cache

**Phase 4, found by the determinism test.** Two consecutive `sync()` runs over the same
folder produced different results. The cause was a real product bug, not a flaky test:
the cache directory sat inside the input folder, so the second run's scan walked it,
found the `.f32` entries, failed to probe them, and reported **the user's own cache back
to them as broken media**.

The default cache lives in the OS cache location, so this does not bite by default — but
§4.2 makes the directory user-settable and Phase 8 puts it in the UI, so a user pointing
it at their media folder would hit it immediately, and the symptom (a growing list of
mystery decode failures) gives no clue about the cause.

Fixed by passing the cache directory to the scan as an excluded path. This is not
extension filtering (§4.1 forbids that) — it is the engine declining to scan its own
working directory.

Worth noting what caught it: §13.4's byte-equality determinism check, on its first run
against the full pipeline. It was written in Phase 0 as a trivially-true placeholder.

## D-021 — FCPXML: hand-written, single format, no DTD

**Phase 5.** Three deviations from §6, all small and all deliberate:

**Written as a string, not through an XML library.** `quick-xml` was added and then
removed: §8.4 wants golden tests comparing bytes, and hand-writing fixes element order,
attribute order and indentation rather than leaving them to a library's formatting. The
escaping actually needed is five characters.

**One `<format>`, not one per geometry.** §6 asks for a format per unique
(width, height, fps). `SyncResult` does not carry per-file resolution — §5 has no field
for it — so adding this properly means threading probe geometry into the result, which is
a §5 schema change and therefore not something to do in passing. The `mixed_fps` warning
still fires. Resolve accepted the single-format document without complaint.

**No DTD validation.** §6 asks for validation against "the bundled FCPXML DTD". Apple does
not ship one with Resolve and none exists on a normal macOS install (checked). The tests
assert structure, well-formedness and matched tags instead — and, more usefully, the real
import in D-022 proves acceptance far better than a DTD would.

One thing worth stating: **every time in the document is a whole multiple of the frame
duration**, assets included. An earlier version left asset durations at exact seconds
(`8400000/30000s`, not a multiple of 1001). Non-frame-aligned times are a common reason
importers quietly round or reject a document.

## D-022 — ✅ Verified against real DaVinci Resolve, and how to talk to it

**Phase 5.** §11 lists manual Resolve verification as the acceptance criterion, and §13.6
says anything learned about the importer gets written down immediately. Both done —
this was verified for real, not deferred.

Against **DaVinci Resolve Studio 21.0.3.7**, importing a timeline generated from a real
three-file shoot (a 60 s recorder feed plus two cameras cut from it at 8 s and 20 s, each
with different EQ and gain):

| Clip | Resolve track | Read-back position | Truth |
| --- | --- | --- | --- |
| ZOOM0001.WAV (reference) | audio1 | 0.0 s | 0 s |
| C0001.MP4 | video2 + audio2 | **8.0 s** | 8 s |
| DSC_0042.MOV | video3 + audio3 | **20.0 s** | 20 s |

Everything §8.4's checklist asks about:

- **Import succeeds** — `ImportTimelineFromFile` returns a timeline object.
- **Track layout is right.** Lane *n* becomes video track *n+1*: the primary storyline
  (our full-length `<gap>`) occupies V1, so the first camera lands on V2. One track pair
  per device, exactly as §6 intends.
- **Offsets are exact** — frame-accurate on read-back.
- **Relinking works** — the percent-encoded `file://` URLs resolved; clips carry real
  names rather than showing offline.
- **Frame rate carries** — the sequence imported as 25.0 fps.

**Sub-frame audio remains untested** because nothing sub-frame is currently emitted;
everything is frame-aligned. §6 says to accept frame precision rather than fight the
importer, and that is where this sits.

### Talking to Resolve from a script (the part that wastes an hour)

The MCP server and the documented environment-variable route both failed with
"could not connect". The cause is not the app: `RESOLVE_SCRIPT_API` points at
`/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting`,
**which does not exist on a normal macOS install**. The library that does exist is:

```
/Applications/DaVinci Resolve Studio.app/Contents/Libraries/Fusion/fusionscript.so
```

Appending that directory to `sys.path` and `import fusionscript` connects immediately, with
Resolve simply running and no preference changed. The misleading part is that the failure
looks exactly like "external scripting is disabled", which sends you into Preferences
looking for a setting that was never the problem.

`scripts/resolve-verify.py` does this and is repeatable.

## D-023 — The Tauri shell is its own workspace, outside the CI gate

**Phase 7.** `app/src-tauri` is excluded from the root workspace and declares its own.
§8.4 builds bundles on tags, not on every push, and pulling `webkit2gtk` and the rest of
the Tauri tree into the per-push gate would cost minutes on every CI run for no coverage
gain — the engine it wraps is already fully exercised headlessly.

The shell is thin by design (§3): it moves work off the UI thread, throttles progress onto
Tauri's event bus, and hands results over as JSON. Nothing worth testing lives in it.

One detail worth keeping: **the 10 Hz progress throttle lives in the shell, not the
engine** (§10). The engine reports every event and does not second-guess its consumer, so
the CLI can still log all of them. The throttle also always lets a *stage change* through
regardless of timing — the stage name is what the user is actually reading, and dropping
the transition would leave the label stale until the next tick.

## D-024 — Device labels are localised in the UI, closing the loop on D-007

**Phase 7.** D-007 had the engine emit bare device labels (`"Balkong"`) rather than §4.5's
literal `"Mappe: Balkong"`, on the grounds that the engine must not hardcode Norwegian when
§9 requires a bilingual UI, and that the provenance is recoverable from the namespaced
device id.

The UI now does exactly that: `deviceLabel()` renders `folder-*` ids as "Mappe: Balkong" or
"Folder: Balkong" depending on the active language, and leaves model- and filename-derived
labels alone. The plan's intended wording is what a Norwegian user sees, with no language
baked into the wire contract.

The two dictionaries are type-linked (`en: Strings` where `Strings = typeof nb`), so adding
a key to one and forgetting the other fails the build. A half-translated UI is worse than
an untranslated one.

## D-025 — Verify locally against a PATH without ffmpeg

**Phase 7, learned the slow way.** The macOS and Windows CI jobs deliberately have no
ffmpeg (D-005). Three tests written in Phase 0 against the stub `sync()` still called it in
Phase 4, when `sync()` had become the real pipeline — so they passed locally, passed on
ubuntu, and failed on the two runners that matter for exactly this.

The tests themselves were redundant by then: schema shape, byte-identical output and
progress delivery are all asserted in `tests/accuracy.rs` against real media, which is a
much stronger claim than the same assertions against an empty stub result. They were
removed rather than guarded.

**The habit worth keeping** is checking both environments before pushing, since the local
machine always has ffmpeg:

```
SUNDAYSYNC_REQUIRE_FFMPEG=1 cargo test --workspace
env PATH="/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.cargo/bin" cargo test --workspace
```

The second line is what CI's macOS and Windows jobs actually run.

## D-026 — Dark-only UI on SundayRec's Brand Sheet v1.0 tokens

**UX round.** The app adopts SundayRec's design tokens verbatim (bg `#0c1020`, four
surface/border layers, four-level text hierarchy, gold `#EBB84B` accent, radius/shadow
scales) so the two desktop apps read as one suite. Dark-only — the light theme is gone,
and with it the two contrast bugs its `prefers-color-scheme: dark` block shipped:
`.banner--error` at ~1.9:1 and the gold primary button at ~1.6:1.

The system font stack replaces Playfair Display / Hanken Grotesk. Those were *named* in
the old CSS but never loaded — no `@font-face`, no vendored files — so every user already
saw the fallback. Dropping the names makes the CSS tell the truth, and SundayRec desktop
uses the system stack too.

Two contrast rules baked into the stylesheet: gold surfaces carry **dark** ink
(`#0c1020` on `#EBB84B` ≈ 10:1), and banners are tint-background + coloured border +
normal text — coloured text on a 10 % tint of the same colour is exactly how the old
1.9:1 happened.

## D-027 — "Re-sync single clips" (§9) is a full re-run with device overrides

A partial-pipeline API would break the §7.3 accounting invariant (every input in exactly
one bucket — a "previously placed, not re-examined" third bucket is a §5 schema change)
and §3 determinism (a result assembled from two runs is a function of run *history*).

The full re-run costs almost nothing warm: decode dominates (§10 "decode-bound") and the
content-keyed cache makes a re-sync correlation-only — the same §10 "<30 s warm" budget
already promised. The UI makes the cheapness legible: the re-sync button carries the
subtitle "bufret analyse gjenbrukes", and a result goes visibly stale the moment inputs,
overrides or the reference change. The user's *intent* — fix this one clip's grouping and
get it re-placed — is one click and seconds of work, which is what §9 was after.

## D-028 — `SyncRequest` gains `device_overrides` and `segment_count`; neither enters §5

The request type is not schema-frozen (`SCHEMA_VERSION` covers `SyncResult` only).
Semantics chosen for UI resilience: an override key matching no scanned file is
**ignored** — a stale entry left after the user removed an input must not abort a run —
and a target id the grouping never produced creates a fresh device (reachable from the
CLI/JSON side only; the UI offers existing ids). `segment_count` is clamped to
`SEGMENT_COUNT_RANGE` (2..=15) at the pipeline boundary, and is recorded in the
diagnostics bundle rather than the frozen §5 `Parameters` block.

Overrides are applied to the manifest *before* candidates are built, so a moved file
flows into placement — including the §4.4 same-device-overlap invariant, which is
exactly what lets a user resolve a `device_overlap` refusal (and honestly earn new ones).

## D-029 — Settings persist via one localStorage JSON key

The SundayRec pattern, not `tauri-plugin-store`: proven in the suite, zero new
dependencies, and these are UI-tier preferences. Per-field validation on load — one bad
field degrades to its default rather than discarding the rest. Every engine-related
field defaults to `null` = "use the engine's default", which is what keeps §9's promise
that advanced settings never change simple-mode behaviour.

## D-030 — Engine errors localise by stable Display-prefix matching

`app/src/errors.ts` maps the engine's thiserror Display strings (which are stable) onto
dictionary keys by prefix. `cancelled` maps to a **notice**, never an error banner — the
first build painted a red banner reading "cancelled" over the user's own deliberate
action, erasing §7.4's distinction between "you stopped this" and "this broke". Unknown
errors keep the raw text embedded: §7.5's honesty applies to failures too.

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

## D-031 — ⚠️ ffmpeg is bundled; resolution order is bundled → PATH → GUI-fallback dirs

**v0.2 stage E1.** The v0.1.0 test build told the owner "ffmpeg ble ikke funnet" on a
machine where ffmpeg was installed and worked perfectly from a terminal.

**The diagnosis.** macOS hands a GUI application a minimal environment. A double-clicked
`.app` gets `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — none of the directories a login shell's
profile would have added. Homebrew installs ffmpeg into `/opt/homebrew/bin` (Apple
Silicon) or `/usr/local/bin` (Intel), MacPorts into `/opt/local/bin`; a GUI app sees none
of them. The development build had never shown the bug because `tauri dev` is launched
from a terminal and inherits its `PATH`. **The lesson generalises to the whole suite: a
desktop app must never assume the environment its developer's shell has.**

**The fix has two halves.**

1. *Hotfix.* `Sidecar::from_path` now resolves each binary as bare name (the `PATH`
   lookup) first, then walks `fallback_candidates()` — `/opt/homebrew/bin`,
   `/usr/local/bin`, `/opt/local/bin`, unix-only, in that fixed order. Ten lines that
   unblock every current tester with an installed ffmpeg. Verified: with
   `PATH=/usr/bin:/bin:/usr/sbin:/sbin` the CLI now resolves `/opt/homebrew/bin/ffmpeg`
   and syncs, where before it aborted.
2. *Bundling.* `app/scripts/fetch-ffmpeg.mjs` (ported from SundayRec, same pins) fetches
   SHA-256-pinned static builds into `app/src-tauri/binaries/ffmpeg-<target-triple>`, and
   `tauri.conf.json`'s `bundle.externalBin` puts them next to the app executable. The
   shell resolves `current_exe()/../ffmpeg` first, verifies the pair, and only then falls
   back to the user's machine. Nothing to install by hand.

**Why the engine stays Tauri-free (D-023 upheld).** `crates/core` cannot ask where the
application bundle is — that is a shell question. So `SyncRequest` gained
`sidecar: Option<Sidecar>`: the shell resolves and verifies the bundled pair, and hands
the engine two absolute paths. `None` keeps the old behaviour (resolve from this machine),
which is what the CLI, the tests and `bench` use. `Sidecar` also gained a
`source: SidecarSource` field — `Bundled` or `System` — pure provenance, shown in
onboarding and the diagnostics bundle. Like `SyncRequest` itself, it is **not** part of
the frozen §5 schema; it never enters `SyncResult` (D-028's rule, applied again).

`check_sidecar` re-resolves on every call rather than reading the cached value, so
onboarding's "check again" button tells the truth for a user who installs ffmpeg while the
app is open. In `tauri dev` there are no binaries next to `target/debug/sundaysync-app`;
that case is silent by design (the absent-file check happens before any verification), and
only a *present but unusable* sidecar logs.

**Licensing: GPL, unchanged from SundayRec.** The macOS/Linux builds come from
[ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de) (release channel, signed and
notarized by the publisher) and the Windows build from
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/) "essentials" — the same two sources, the
same pinned 8.1.2, and the same obligations SundayRec already documents in its
`docs/DISTRIBUTION.md`: both are `--enable-gpl --enable-version3`, nothing is
`--enable-nonfree`, the GPL covers the redistributed binaries, and anyone handed an
installer is entitled to the corresponding source — point them at the publisher's build
page and ffmpeg's own 8.1.2 tarball. URLs are pinned to an exact build id, not "latest",
so a rebuild a year from now fetches the same bytes; both the archive and the unpacked
binary are SHA-256-pinned (`app/scripts/ffmpeg-checksums.json`), and a mismatch fails the
build rather than shipping.

**⚠️ The §10 installer budget is superseded.** §10 says "< 40 MB per platform *excluding*
ffmpeg", which was always a number that hid the real download. Measured on this machine
(aarch64-apple-darwin, 2026-08-08):

| | v0.1.0 | v0.1.2 |
| --- | --- | --- |
| DMG | **3.8 MB** | **60.3 MB** |
| `SundaySync.app` on disk | ~13 MB | **135 MB** |
| of which ffmpeg + ffprobe | 0 | 131 MB |

The app itself is 10 MB — comfortably inside the old budget. The other 125 MB is ffmpeg 8
static builds, which are simply large (SundayRec measured the same ~131 MB pair; there is
no small 8.x static build). **The honest number to quote from here on is ~60 MB
downloaded, ~135 MB installed**, and it is also what a future updater ships per release.
Deliberate trade: one 60 MB download beats a manual install step that half of testers get
wrong and the other half hit this bug on.

## D-032 — E3 security hardening: protocol whitelist, XML control-char stripping, diagnostics scrub

**E3, from the E2 threat model.** The engine was already unusually defensive (no shell, no
`unsafe`, symlinks not followed, device files skipped, cache delete scoped by suffix), so
this stage is focused, not sprawling. The judgment calls:

**S-1 — ffmpeg/ffprobe protocol whitelist (the one to fix first).** §4.1 rejects nothing
by extension — a dropped "media" file is the product's explicit input — so a file that is
really an HLS playlist or a `concat`/`ffconcat` script would make ffmpeg fetch remote URLs
(SSRF, incl. the `169.254.169.254` cloud-metadata address) or read `file:///…` during
probe/extract. Fix: `-protocol_whitelist file` before every `-i`, in both `probe.rs` and
`extract.rs`. Measured against ffmpeg 8.1.2: the flag propagates to the HLS demuxer's
nested-protocol layer, which then refuses `http` with *"Protocol 'http' not on whitelist
'file'"* — the `probe.rs` test `the_protocol_whitelist_reaches_the_nested_demuxer_protocol`
pins exactly that stderr. Modern ffmpeg already ships defensive defaults (concat `safe=1`,
HLS nested whitelist `file,crypto,data`), but those are version/build-dependent and broader
than we need; pinning `file` makes the guarantee explicit, minimal and stable across the
bundled 8.1.2 and whatever system ffmpeg a user has on PATH.

- **`-safe 1` is on `probe.rs` only, not `extract.rs`.** This is the non-obvious call.
  ffprobe accepts `-safe 1` on any input (verified harmless on wav/mp4/flac/aac), so it is
  added there to pin the concat demuxer's safe-mode on. **ffmpeg rejects it** as *"Option
  safe not found"* on non-concat input, which would break every normal extraction — so it
  is deliberately omitted from the extract vector. The concat demuxer's own `safe=1`
  default already blocks unsafe names there, and the whitelist blocks the protocol vector.
- **`extract.rs` needs `file` only, not `file,pipe`.** The decode writes to a temp *file*
  (`-f f32le -y <temp>`), not `pipe:`, so `file` is the minimal set that keeps extraction
  working — verified across containers.
- **S-2 folded in:** the probe path was a bare trailing positional, so a file named
  `-show_data_hex` parsed as a flag. It is now `-i`'s value in both stages.
- Committed hostile corpus in `fixtures/hostile/` (tiny — bytes, not media) drives the
  "attack is now blocked" tests through the real `probe`/`extract` code path.

**S-3 — FCPXML escaper strips XML-illegal control chars.** The five injection chars were
already escaped correctly (no breakout — kept), but C0 controls (`0x00–0x08`, `0x0B`,
`0x0C`, `0x0E–0x1F`) passed through raw, so one bell or NUL in a filename yielded a
non-well-formed document Resolve rejects wholesale (silent wrongness, §7.5). **Choice:
drop** the illegal controls (they are not representable even as a numeric character
reference in XML 1.0, so there is nothing to escape them *to*), and **normalise** the three
legal whitespace controls (tab/newline/CR) to a single space, matching how a parser
flattens them inside an attribute anyway.

**S-5 — export path validation.** IPC arguments are trust-boundary data; the OS save dialog
is a convention, not an enforced guard. `validate_export_path` rejects an existing-directory
target and (for `export_timeline`) a path not ending in `.fcpxml`, so a hostile `invoke`
cannot steer a raw `fs::write` onto an arbitrary writable file. Defense-in-depth behind the
S-4 CSP.

**S-6 — `export_diagnostics` is now actually media-free.** It claimed to be safe to send to
support while embedding the full `SyncResult` — absolute paths (→ the macOS username under
`/Users/…`), device/folder labels (often the church/service name) and every filename — plus
the absolute ffmpeg path. `scrub_result` collapses every path to its bare basename, drops
each device label to its neutral id (e.g. `folder-balkong`, the handle §4.5/D-028 already
use), and the report omits the ffmpeg path entirely, keeping only `bundled`/`system`. Test
asserts no `/Users/`, no surviving absolute path, and no raw label. Doc-comment corrected to
describe what the bundle actually contains.

**S-7 — `clear_cache` cache marker.** `dir` is caller-chosen (D-013), so `clear` could
delete a user's unrelated `.tmp`/`.f32` in any named folder. `ensure_dir` now stamps a
`.sundaysync-cache` marker (a dotfile — the scan's `is_hidden` skips it, `clear`'s suffix
filter spares it), and `clear` refuses a *non-default* directory that lacks the marker
(`Error::NotACacheDir`). The default dir stays frictionless (trusted unconditionally); a
missing directory is still a no-op, not a refusal.

**S-8 — scan width cap + cancel-in-loop.** `walk` had unbounded width and checked cancel
only per-directory. **Ceiling: `MAX_FILES = 100_000`** — orders of magnitude past any real
multi-camera service, so it can only fire on an obvious mis-drop (a home directory, a whole
disk); on breach it returns `Error::TooManyFiles { limit }`, a loud honest refusal rather
than a silent truncation that would violate §7.3. Cancel is now also checked *inside* the
entry loop, so one huge directory is interruptible (§7.4). A wedged network-mount
`read_dir`/`metadata` syscall remains uninterruptible — inherent to `std::fs`, documented in
the code, not fixed here.

**Fuzzing.** `cargo-fuzz` targets for `probe::from_json`, `place::parse_iso8601_epoch` and
`Rational::parse` live in `fuzz/` — its own workspace, excluded from the root gates like
`app/src-tauri`. The WAV *reader* the brief names does not exist (fixturegen only *writes*
WAV; the engine reads back its own raw `f32le` cache), so it is not fuzzed — noted, not
skipped by accident. `probe::from_json` is `pub(crate)`; a `fuzzing`-gated `fuzz_from_json`
door exposes it without widening the shipping API. The targets dual-build: under cargo-fuzz
(`--cfg fuzzing --features libfuzzer`, nightly) they are libFuzzer targets; on plain stable
`cargo build` they are ordinary smoke-runner binaries over a few adversarial seeds, so the
harness stays committed and verifiable here where cargo-fuzz/nightly are unavailable. Run
instructions in `fuzz/README.md`.

**New `Error` variants.** S-8 and S-7 needed fatal outcomes with no honest fit among the
existing variants (`Invariant` means *engine bug*, which a user mis-drop is not), so
`TooManyFiles { limit }` and `NotACacheDir { path }` were added to `error.rs` — additive
only.

**Stale docs fixed in passing (E2 explorer findings):** the `crates/core/src/lib.rs` module
docstring called the pipeline a "Phase 2" stub with correlation unimplemented — corrected to
describe the complete pipeline `sync` now runs. `extract.rs`'s memmap-deferral note cited
D-012 (which is about cancellation); it should be **D-011**, now fixed.

## D-033 — Strict local-only CSP, and the npm-audit gate scopes to shipped deps (E3)

**E3, conductor.** Two hardening decisions that sit outside the two builder agents'
file ownership.

**CSP (closes S-4).** `tauri.conf.json` `security.csp` went from `null` to a strict,
local-only policy: `default-src 'self'`, `script-src 'self'` (the production bundle has no
inline/eval scripts and no `dangerouslySetInnerHTML` anywhere in `app/src`), `style-src
'self' 'unsafe-inline'` (Vite injects a style tag and the app uses a few React inline
`style={{}}` attributes), `img-src 'self' asset: data:`, `connect-src 'self' ipc:
http://ipc.localhost` (Tauri 2 IPC), and `object-src/base-uri/frame-ancestors/form-action`
locked down. No remote origin is reachable — the app is 100 % local, so a future XSS
(a new dependency, an accidental `dangerouslySetInnerHTML`) can no longer reach the IPC
command surface (which includes arbitrary-dir cache deletion and file writes).

Verified the policy is **accepted by `tauri build` and embedded** both in the frontend
bundle and compiled into the app binary. The one thing not verifiable headlessly is that
the UI still *renders* under it — that is on the E11 owner smoke checklist (a blank window
would be the failure mode). The policy is the community-standard tight CSP for a
local-only Vite/React Tauri app, so the risk is low.

**npm-audit gate (part of S-9b).** The CI `npm-audit` job runs `npm audit --omit=dev
--audit-level=high` — it gates the **shipped** dependency tree, not the build/test tooling.
Every current advisory lives in the `vitest → vite → esbuild/nanoid` dev chain
(vitest-UI arbitrary-file-read, vite dev-server path traversal, nanoid loop); none reaches
the Tauri bundle a user runs, and `npm audit --omit=dev` reports **0**. Their only fix is a
semver-major vitest bump, tracked as a follow-up rather than blocking every push on tooling
that never ships. A `high`-or-worse advisory in an actual runtime dependency still fails the
job. A second, non-blocking `|| true` step runs the full dev audit so those advisories stay
visible in the log.

**Follow-up tracked:** bump `vitest` to v4 (breaking; re-verify the 27 vitest specs) to
clear the dev-tree advisories at source.

## D-034 — E4 memory strategy: single-alloc load(), the per-run anchor cache, and memmap stays deferred

**E4, stability.** §7.7's 4 GB RSS ceiling was untested and, on paper, breakable. Three
changes bring the engine under it and one non-change is reaffirmed.

`CachedAudio::load()` now allocates the `Vec<f32>` once at `file_len / 4` and streams the
cache file through a 64 KiB scratch buffer. The previous form read a whole `Vec<u8>` and
then `.collect()`ed a second full `Vec<f32>`, both resident at once — a transient ~8
bytes/sample peak. On a long reference this was the actual gate-breaker: at 46.9 KB/s
(D-004/D-013), a 20 h reference is ~3.38 GB of analysis audio, so the old load() spiked to
~6.8 GB while decoding it into memory, before any FFT had allocated. The streamed form
peaks at the samples vector plus one 64 KiB buffer.

`place()` pass 2 previously re-loaded each anchor's cache file on every (clip, anchor) pair
and linear-scanned `candidates` for durations inside the sort comparator and for each
anchor lookup — O(n²) I/O and O(n²) scans. It now builds a `by_path` index once (O(1)
lookups) and a lazily-filled per-run `anchor_cache` that reads each distinct anchor's cache
file at most once and reuses it across all unresolved clips. The reference is not stored in
the cache; it is reused in place from the single `ref_audio` load, so the dominant stream
is never duplicated.

Memory tension, resolved deliberately. Caching anchors resident raises pass-2 peak above
the old drop-after-each-use behaviour, so the worst case matters. Peak resident RSS is
`reference + anchors actually touched + one in-flight clip`. The largest-first order with
early-exit on a strong match usually touches only a few big anchors, so the realistic
church-service case (a ~2–3 h recorder reference ≈ 0.34–0.51 GB plus a handful of short
camera clips) stays well under 1 GB. The adversarial bound is the E4 20 h / 200-file day:
if nearly every clip is placed and one straggler forces a full-anchor pass 2, the touched
set approaches the whole shoot's analysis audio — ~3.38 GB (F10 cites ~3.46 GB at 48 KB/s)
— which is the same footprint §7.7 already contemplates. Adding the correlator's overlap-
save working set (2²⁰-sample f32 blocks, tens of MB; the reference FFT is still recomputed
per call until P-1 lands in E5) and program baseline (<0.2 GB) leaves peak ≈ 3.6 GB, under
4 GB with ~0.4 GB of headroom. This is analytical; the RSS bench built alongside E4
(fixturegen 20 h day + peak-RSS sampling, `crates/core/tests/memory_gate.rs`) is what
proves it. If that bench ever shows a realistic 20 h day over 4 GB, the documented next
step is a size-ceilinged, drop-after-last-use anchor cache — accepting bounded cache-file
re-reads for the rare many-anchor pass 2 — deferred now because it trades a guaranteed
bound for complexity the measured data has not yet justified.

The same F9 fix rides in this path: on Windows `rename` errors when the destination exists,
so two cold instances decoding one file made the loser emit a spurious `decode_error`. Same
cache key ⇒ byte-identical audio, so an existing destination is a cache hit — drop the temp,
no error. Unix atomic overwrite is unchanged.

memmap (D-011) stays deferred. With the transient 2× copy gone and the anchor cache
bounding pass 2, there is no acute pressure left for `memmap2::Mmap::map` to relieve. The
case against it is unchanged and now stronger: it is `unsafe`, colliding with the
`unsafe_code = "forbid"` lint (adopting it means relaxing to `deny` plus a scoped
`#[allow]`); the f32le → f32 conversion still needs a full pass over the bytes, so a mapping
buys no arithmetic; and a mapped cache file complicates the Windows cache-overwrite path
(a mapping holds the file open, and F9's whole point is that a second instance may replace
it). Revisit only if the E5 RSS bench shows the single-alloc + anchor-cache profile still
exceeds 4 GB on a realistic day — which the arithmetic above says it does not.

## D-035 — E4 robustness: lossless path hashing (F7) and a bounded runnable() (F11)

**E4, stability.** Two independent correctness fixes with no bearing on the §5 schema.

The cache key hashed `path.to_string_lossy()`, which maps every invalid byte to U+FFFD. Two
distinct non-UTF-8 paths differing only in their invalid bytes therefore hashed identically
and collided — the second file was served the first's cached analysis audio, a
silent-wrongness bug (§7.5) rather than an honest failure. The key now hashes the lossless
OS encoding: raw bytes on unix (`OsStrExt::as_bytes`), UTF-16 code units on Windows
(`encode_wide`), and the lossy form only on targets with no OS-string accessor (where paths
are UTF-8 anyway). Changing the encoding changes cache filenames, which costs one cold
re-decode and nothing else — no on-disk state or fixture pins a specific `{hash}.f32` name.

`runnable()` ran `<bin> -version` with a plain blocking `status()`, unlike `sidecar::run()`,
which has the D-010/D-012 bounded poll loop. A bundled ffmpeg wedged on `-version`
(quarantine limbo, a dead FUSE mount, a stalled network binary) would hang `check_sidecar`
and the onboarding probe forever and uncancellably. `runnable()` now delegates to `run()`
with a 10 s ceiling — generous for a `-version` that normally answers in ~30 ms — inheriting
both the bounded wait and the D-010 rule that a killed child is never joined on its reader
threads on the timeout path. A wedged binary is reported as not-runnable instead of
hanging. (The frontend invoke-timeout half of F11/F14 is a separate, shell-side change; see
D-036.)

## D-036 — Uniform AppState poison policy, an inputs fingerprint on export, and a client-side invoke timeout (E4)

**E4, shell+frontend.** Three stability fixes on the Tauri command surface (F1, F3, F6,
F11-frontend/F14), none of which touch the engine (D-023).

**Poison policy (F1).** The shell's `AppState` mutexes were handled inconsistently:
`cancel_sync` took `if let Ok(slot) = lock()` and silently did nothing when the lock was
poisoned — the one safety control disabled with no banner — while `export_*` surfaced an
error. Every command now acquires its lock through one helper, `lock_state(slot, OnPoison)`.
`OnPoison::Recover` recovers the guard via `PoisonError::into_inner` for the cancel-token
slot, the scan-cancel slot, and the sidecar cache: a lock poisoned there means only that a
prior thread panicked mid-update, and the `Option<_>` it holds is still safe to read or
replace — cancel must fire regardless. `OnPoison::Reject` returns a clean "internal state
was poisoned" error for the `LastRun` slot, where a half-written result must never be
exported as a finished run. `store_last` recovers, overwrites wholesale, then calls
`clear_poison()` so a healthy sync re-enables the Reject read path in export.

**Scan-cancel identity (F3).** `scan_inputs` cleared "only our own token" by checking
`is_cancelled()` outside the lock — a late-finishing scan could clear a newer scan's slot
and leave the newer run uncancellable. The scan-cancel slot now holds `Arc<CancelToken>`,
and the finishing scan clears the slot only when it still holds *its* Arc (`Arc::ptr_eq`
under the lock).

**Export inputs fingerprint (F6).** The frontend hides export behind `phase.stale`, but that
is a UI convention, not a guard. `LastRun` is now stamped with a cheap deterministic
`DefaultHasher` fingerprint of the sources that produced it — the source set (order/dup-
independent), device overrides, and chosen reference, mirroring the frontend's staleness
triggers. `export_timeline` recomputes it from the caller-supplied current sources and
refuses on mismatch. `DefaultHasher`'s cross-version instability is irrelevant: store and
compare happen in the same binary and session, never persisted.

**Invoke timeout (F11-frontend/F14).** No `invoke` had a timeout; a no-cancel command
(notably `check_sidecar`, spawning `ffmpeg -version`) could wedge the UI forever.
`invokeWithTimeout` races `invoke` against a bound (10 s for `check_sidecar`) and rejects
with a distinguishable, localised message mapped to a NOTICE — a timeout is recoverable, not
a crash. It bounds only how long the UI waits; the backend call is not aborted (Tauri
exposes no cancel token). `run_sync`/`scan_inputs` keep their real cancel path and get no
short timeout.

## D-037 — Process-global scratch nonce so two same-process Extractors never collide (E4)

**E4, conductor integration.** E4's two-instance concurrency test surfaced a real bug
distinct from F9. `Cache::temp_path` names a scratch file from `(cache key, process::id(),
nonce)`, but the nonce was a per-`Extractor` `AtomicU64` starting at 0. Two `Extractor`s
constructed in the *same* OS process (identical pid) therefore collided on the Nth file's
`<key>.<pid>-<nonce>.tmp` path: one worker's `fs::rename` moved the shared temp out from
under the other's still-running ffmpeg, which then failed its `fs::metadata` check with a
spurious `decode_error` on a perfectly good file. This reproduces on POSIX, so it is not
the Windows-rename issue F9 fixed. It is reachable in the real app: `sync_with_durations`
builds a fresh `Extractor` on every call, so two overlapping `sync()` runs (a re-sync fired
before the first finishes) hit it.

Fix: the nonce is now a single process-global `static SCRATCH_NONCE: AtomicU64`
(`crates/core/src/extract.rs`), unique across every `Extractor` in the process; the pid in
`temp_path` still carries cross-process uniqueness. The previously `#[ignore]`d
`two_extractors_in_one_process_*` test is un-ignored as a passing regression
(`crates/core/tests/concurrency.rs`).

## D-038 — E5/P-1: the reference transform is finally "computed once and cached" (bit-identical), plus deterministic segment parallelism

§4.3 promised the reference's forward-FFT block spectra are "computed once and cached", but
`Correlator` held only an `FftPlanner`, so `find()` re-ran the whole overlap-save loop over
the reference for every segment of every clip — ~48,000 2²⁰ FFTs on a 3 h/30-clip service,
the ~8 min of pass-1 correlation the E2 explorers measured.

`Correlator` now memoises the reference's PHAT-normalised block spectra, keyed by **(BLAKE3
content hash of the reference samples, segment length)**. Keying on a content hash rather
than a slice pointer is deliberate: a freed reference's address can be reused for different
content, which pointer-identity would serve stale spectra for — a §7.5 silent-wrongness bug.
The hash makes aliasing two distinct references cryptographically impossible, the same
guarantee the on-disk cache relies on (D-035). Segment length is in the key because two
segment lengths can share an FFT size `n` yet tile the reference differently. The cache is
single-entry and byte-budgeted at 1.75 GiB: a reference whose spectra would exceed the
budget (≈ a >4 h reference at the default 20 s segment) streams exactly as before, one block
resident at a time, so the cache never breaches §7.7's 4 GB ceiling (D-034). The memoisation
is pure — a miss recomputes identical values — so it is **bit-identical by construction** to
the retained exhaustive path (`match_clip_exhaustive`). Proven so field-for-field over the
real §8.1 fixtures and across positive/zero/negative/edge lags.

The independent per-segment correlations additionally fan out across
`extract::worker_count()` (§4.3(c)), sharing the spectra read-only and writing indexed slots
assembled in input order, so placements are identical regardless of thread scheduling
(§13.4). Peak memory is unchanged from the serial cached path — segment-level (not
cross-clip) parallelism was chosen precisely so per-thread caches never multiply the
reference spectra by the worker count. `MIN_PSR` is untouched: the arithmetic per segment is
identical, so the Phase-3/D-015 calibration still holds without re-validation.

Measured (12 min reference, 12×90 s clips, 4 workers): Tier-1 memoisation ~1.85×, segment
parallelism ~2.1×, combined ~3.7–4.1× (machine-dependent). Projected shipping correlation:
the §10 realistic 3 h/20-clip service **~57 s** (down from ~214 s; spectra 1.4 GB, cached);
the 8 h/100-file stress day ~23 min (spectra 3.6 GB exceeds the budget → streams, parallel
only — see D-039).

## D-039 — E5/P-1: the decimated coarse-search is deferred, not abandoned

Tier-1 caching + segment parallelism bring the §10 realistic 1.5–3 h church service
comfortably within budget (~57 s of correlation), but do **not** meet §10's literal 8 h/100-
file stress day in < 6 min (~23 min projected). That day is also the case where the
reference's spectra (~3.6 GB) exceed both the cache budget and, with the resident reference
audio, the 4 GB ceiling — so it must stream, and caching cannot help it. The remaining lever
is the plan's decimated coarse search (÷8 → ~1.5 kHz to localise each offset, then a
full-rate refine over a narrow window), which shrinks both the FFT size and the block count
and would simultaneously make the long-reference spectra small enough to cache again.

It is deferred rather than shipped because it is the one change that alters the arithmetic
(placements within ±1 sample, not bit-identical), and §13.2/§13.4 demand it be gated hard:
the coarse decimation factor and refine half-window must be chosen and **proven** so the
coarse localisation error can never exceed the refine window on adversarial offsets (clip
before the reference, near either end, negative lag), and PSR must be taken from the
full-rate refine window (or `MIN_PSR` re-calibrated per D-015) with D-014's caution that a
change which looks better is exactly when to suspect the instrument. That validation is a
task in its own right; shipping it under-proven risks the false placements §8.2/§7.5 make the
product's core promise against. The exhaustive path (`match_clip_exhaustive`) is retained
precisely as the oracle a future decimated path must diff against. Recommended for E10's
real-corpus loop, where the ±1-sample budget can be validated against real rooms rather than
only synthetic material.

## D-040 — Cache eviction closes D-013: 90-day mtime sweep by default, size cap off

E5, P-4. D-013 left cache growth (~169 MB/audio-hour) unmanaged pending a product call. The
engine now exposes `Cache::sweep_older_than(age)` and `Cache::enforce_size_cap(max_bytes)`,
both returning `Evicted { entries, bytes }`. The analysis cache is regenerable, so age
eviction is non-destructive to user data — a swept entry simply cold-decodes if that shoot is
re-synced. Conductor-approved defaults: a **90-day sweep on app start** (on — run off the
main thread in the shell's `setup()`, non-fatal), a **size cap in Settings (off by
default)**, and the manual "Tøm buffer" stays. Both reuse the S-7 marker guard `clear()` uses
(refuse an unmarked non-default dir), operate only on finished `.f32` entries — never an
in-flight `.tmp` a live extraction owns, never a foreign file, never the marker — and are
safe under a concurrent run (a vanished entry is success, not error). Age is from **mtime,
not atime** (atime is frozen/absent under `relatime`/`noatime`/network mounts; mtime is
written once at the write-then-rename commit, so "older than `age`" cleanly means "committed
more than `age` ago"). The cap evicts least-recently-modified first, tie-broken by path, so
the evicted set is a deterministic function of the inputs. Shell wiring: the `sweep_cache`
and `enforce_cache_cap` commands, the startup sweep, and a `cacheCapMb` setting (null = off)
driving `enforce_cache_cap` from the Settings panel.

## D-041 — Parallel probing must be byte-identical to the serial result

E5, P-2. Probing moved from a serial loop to the bounded extract worker pool
(`worker_count()`, `min(4, cores)`) — one 30 s-timeout file no longer stalls the scan with
idle cores. To keep the engine a deterministic function of its inputs (§3, §13.4),
`probe_candidates` writes each probe outcome into an **index-aligned slot** and the caller
folds them in candidate order, so `probed`, `unsynced`, and the manifest are identical
whatever the thread schedule. Guaranteed by a test that runs the scan with 1 worker (serial)
and 8 workers (parallel) over a mixed good/bad shoot and asserts the manifests are byte-equal
(serde) and the raw `Probed` vectors are equal. Cancellation is preserved: workers check the
token before taking work, an in-flight probe cancels via `probe`'s token path (§7.4), and a
set token returns `Error::Cancelled` before any slot is unwrapped. The D-005 skip-guard
behaviour is unchanged.

## D-042 — E6: `<timeMap>` drift correction, on by default past half a frame

**E6, drift correction — closes D-016; the v2 headline pulled into v0.2.** The engine has
always *measured* clock drift (`drift.rs`: signed `ppm` + `projected_end_error_ms`); v0.1
did not *correct* it, so a long camera on a fast/slow clock drifts out of sync by the clip's
end (D-016: a 90-minute 40 ppm camera ends ±108 ms out).

**Spike first (owner-gated).** Against real DaVinci Resolve Studio 21 the conductor proved
the importer **honours a per-clip `<timeMap>`** on an `<asset-clip>` and preserves the ratio
*exactly, sub-frame*: a +250 ppm map (source 60.000 s → timeline 60.015 s) round-tripped
through Resolve's own FCPXML export as `<timept time="12003/200s" value="60/1s"/>` — 60.015 s
kept as an exact rational, not snapped to a frame. `<conform-rate>` is **ignored** by
Resolve. The clip's timeline *boundary* is frame-quantised (cosmetic); the retime *ratio*
that drives the audio resample is exact. Live-verified again in the engine's full
gap/spine/lane layout: a 10 % timeMap read back as 66.0 s while the reference clip stayed at
60.0 s. **Owner sign-off (2026-08-08): mechanism = `<timeMap>`; on by default; correct only
clips whose drift exceeds half a frame; toggleable.**

**Mechanism.** For any clip whose measured drift exceeds half a frame (`Drift::exceeds_half_frame`),
the exporter emits a `<timeMap>` stretching the clip's timeline span to
`source_span · (1 + ppm·1e-6)` — the reciprocal of D-019's `1/(1+ppm·1e-6)` *resample*, i.e.
the timeline has to be *longer* by the drift for the far end to land where the reference
puts it. Because §4.3 places on the **median** (the offset estimate is at the clip midpoint),
a corrected clip's start is first re-referenced by half the projected end error
(`projected_end_error_ms/2000` s) so the stretch pivots on the reference-correct start; both
ends then land within the gate. Timepts are exact rationals over `AUDIO_TIMEBASE` (48000);
the asset-clip `duration`/`offset` stay frame-aligned as before. The reference clip is never
corrected (it defines the origin).

**Sign is the trap (D-014/D-019), so it is test-pinned.** Inverting the ratio moves the end
the wrong way and *doubles* the error. `drift::tests` and the full-tier accuracy gate assert,
for both signs of injected drift, a 40 ppm / 400 s clip: **uncorrected end ~16 ms → corrected
~0 ms; inverted → ~32 ms** — so the tolerance is never doing the work, and an inverted
correction fails loudly.

**Toggle.** `SyncRequest.correct_drift` (default `true`) governs whether correction is
applied at all; export carries it via `ExportOptions`/`export_fcpxml_with_options`. The shell
threads it from a Settings switch (`correctDrift`, on by default) through `run_sync` and
stores it on the run so a later export uses the same setting. With it off, output is v0.1
**byte-for-byte** (no `<timeMap>`); the no-drift golden is unchanged, and a new
`timeline_drift.fcpxml` golden locks the corrected form.

**Verification harness.** `scripts/resolve-verify.py` now reports each clip's **END**
alignment (start + duration), not only its start — that is where uncorrected drift shows.

## D-043 — E7: consent + anonymous telemetry client

**E7, mirror of SundayRec's telemetry client.** SundaySync ships an **opt-in, off-until-granted**
telemetry client (data controller: **SundaySuite**), versioned at **consent v1** — a scope bump
re-asks everyone, and a "no" at v1 never silently becomes a "yes" at v2. A random UUIDv4
install-id is minted **only on grant** (`NIL_INSTALL_ID` otherwise) and is deletable by id (local
clear + remote `DELETE /v1/install/:id`, issued even with consent off since it carries only a
retired random id).

**The payload is anonymous and bucketed by construction.** From a completed `SyncResult` the
projection reads only counts, closed enums, and coarse bands — never a filename, path, device or
folder label, project name, or recording timestamp. Fields: file/device counts, total-duration and
run-duration buckets, §5 unsynced-reason histogram, PSR distribution bands, drift-correction
flags (`enabled`/`clips`/`corrected`), a **file-format histogram** (extensions only, a closed set),
`mixedFps`. Crash messages are the sole free text — scrubbed (paths → `<path>`) and length-capped,
on both the Rust panic-hook ring and the frontend `window.onerror`/`unhandledrejection` path. A
load-bearing test builds a `SyncResult` full of church paths/labels and asserts none of those
strings appear anywhere in the serialized payload.

**Consent copy ↔ payload reconciled (owner, 2026-08-08).** The approved v1 copy enumerated
"buffertreff" (cache hit-rate), which v1 does **not** collect, and omitted the file-format histogram,
which it **does** send. Owner chose to make the copy exactly truthful: drop the cache-hit line, add
"hvilke filformater (kun filendelser, aldri filnavn)". The copy now names precisely what leaves the
machine — the SundayRec "consent covers what is sent" rule.

**Transport.** Rides the shared `sunday-telemetry` Worker `/v1/ingest` with a top-level
`app:"sundaysync"` marker. A ≤50 outbox drops-oldest and treats a non-2xx as logged-and-kept/dropped
(4xx permanent, 429/5xx backed-off) — **never silently discarded** (the ellipsis-bug lesson). State
persists to JSON under the app data dir. `reqwest` is pinned to `native-tls` so the license
allow-list (cargo-deny) stays satisfied.

**Worker dependency (E8).** The shared Worker does **not yet** accept sundaysync payloads until
E8's branch merges and deploys. *(Amended same day, owner-directed:)* the client now posts to the
app registry's **app-scoped door** — `POST /v1/apps/sundaysync/ingest` and
`DELETE /v1/apps/sundaysync/install/:id` with the `x-write-key` header (`WRITE_KEY_SUNDAYSYNC`
Worker-side) — matching the `audit/wire-seams` app-dimension foundation the owner chose as the
shared layer, rather than the frozen legacy `/v1/ingest` alias (which means "sundayrec" and would
400 this payload). That is by design (client built in E7, Worker taught in
E8); the client logs the 400 locally and sends nothing in production until a release ships against a
deployed Worker. **E8 status:** a Worker branch (`e8/sundaysync-app-dimension` in the sunday-telemetry
repo) is built and tested but **parked, not merged, not deployed** — it collides with concurrent
app-dimension work on that shared repo (`audit/wire-seams` has its own `src/apps.ts` + `0006`
migration), and its validator shape still needs reconciling field-for-field against this client. Both
are owner/cross-program coordination items.

## D-044 — E9: in-app updater + stable/beta ring

**E9.** SundaySync gets an in-app auto-updater via `tauri-plugin-updater`, polling the
shared Sunday Suite feed at the **app-scoped** route
`updates.sundaysuite.app/v1/update/sundaysync/{stable,beta}` (not SundayRec's frozen
`/v1/update/{channel}` alias — the Worker's `/v1/update/:app/:channel` is what the app-
dimension foundation serves). The ring is a per-machine `betaChannel` localStorage setting
(default off), passed to the backend on each check so it hits `/beta` vs `/stable` — no DB,
unlike SundayRec. Privacy URL shape mirrors SundayRec: **no version/target/arch in the
path** (a unit test asserts this). No GitHub fallback feed, so the Worker's `204`-as-pause
is an authoritative kill-switch. Updater artifacts are minisign-signed (pubkey in
`tauri.conf.json`, private key a GitHub Actions secret); NSIS-only Windows bundling on
`-beta.` tags because MSI cannot express a prerelease version. Opting into the beta ring
gently re-surfaces the E7 consent card for installs that haven't decided yet.

**⚠️ Security incident + resolution (2026-08-08).** The agent that built E9 generated a
signing keypair and printed the **private** key into its output — a credential leak. That
keypair is **burned**: it must never be set as `TAURI_SIGNING_PRIVATE_KEY` or used to sign a
release. Resolution: the conductor generated a **fresh** keypair (private key written only to
a local file, never printed) and swapped its public key into `tauri.conf.json`; the burned
public key no longer appears anywhere in the tree. **Owner action before any release:**
either set the two `TAURI_SIGNING_*` secrets from the fresh keypair, OR (recommended)
generate a brand-new keypair locally, hold the private key yourself, set the secrets, and
swap in that pubkey. Until a signing secret is set, `tauri-action` skips updater signing and
clients reject unsigned updates by design — so there is no unsigned-release risk in the
meantime. Lesson for the suite: signing-key generation must keep the private key out of all
agent/tool output.

## D-045 — E10 corpus: the credibility gate, a stricter single-segment floor, and the .lrv skip

**E10, the first real corpus (a 2026-04-05 multicam baptism: 70-min XH2 main camera +
XT4 + two iPhones + an Insta360 X + a produced stereo mix).** The §8.3 ritual surfaced a
release blocker and settled two open questions. Findings first, honestly:

**Three false placements, zero true ones admitted wrongly after the fix.**
1. The 70-min XH2 against the produced mix: placed at PSR 15.2 (MIN_PSR is 15),
   confidence 0.02, **drift −587,484 ppm**. The mix is *edited* — every segment's audio
   genuinely exists in it, at different offsets (cuts). The regression fitted a line
   through the scatter; v1-era code warned and placed anyway; E6 then "corrected" the
   clip by −59 %.
2. A 95-s iPhone clip against the raw XH2: PSR 15.4, **−1,937,858 ppm** — the same shape
   against an unedited reference, so this is not only an edited-mix problem.
3. A 14-s iPhone clip against the raw XH2: PSR 19.0, placed an hour from where its
   metadata puts it. Single whole-clip peak — no segments, so nothing for a consistency
   check to catch.

**The fix is two gates in `place::admissible`, both refusal-shaped (§7.5):**
- **Credibility** (`Drift::credible`): a match with ≥ 3 segments must survive the drift
  regression — `|ppm| ≤ 500` (`MAX_CREDIBLE_DRIFT_PPM`: consumer crystals are tens of
  ppm; 500 is a generous ceiling) AND residual MAD around the fitted line ≤ 15 ms
  (`RESIDUAL_LIMIT_MS`). Fitting the line *first* is what keeps D-016's legitimate case
  alive: a 90-min 40 ppm camera has offsets ON a line (raw MAD around the median would
  false-alarm — why `ClipMatch::consistent` was never a hard gate), while cuts and
  sidelobes scatter around any line.
- **No-evidence floor**: a match with < 3 segments (`MIN_SEGMENTS_FOR_DRIFT`) has PSR as
  its only evidence and must clear `min_psr × 5/3` (`NO_DRIFT_EVIDENCE_PSR_FACTOR`,
  effective 25 at the default). Provisional calibration from this corpus — observed false
  peaks 15.2–19.0, synthetic true matches ≫ 25 — and the full §8.1 accuracy suites pass
  unchanged, which is the standing guard against over-tightening. D-015 (MIN_PSR on real
  rooms) remains open; more corpus refines the factor.

Re-run after the fix: **all three false placements refused** (`low_confidence`), every
synthetic gate green, no legitimate placement lost. On this corpus that means zero
placements at all — also honest: the cameras were largely in different rooms/times (the
XT4's first clip *ends* ten minutes before the XH2 starts, by their own metadata), and
the one nominal 23-min overlap (XT4's second clip) refused at PSR < 15, which is what
different acoustic spaces look like. **Recall on real corpora is still unmeasured** — a
possible false negative there cannot be distinguished from a genuinely unrelated room
without ears on the material; more corpus, ideally with a known-good multicam pair in one
room, is the E10/E12 loop's job.

**Also settled: D-009's `.lrv` question, with real files.** The Insta360 writes an
`LRV_….lrv` low-res proxy beside every `VID_….insv` original — same audio twice in one
folder-device. The recursive walk now skips `.lrv` (case-insensitive), classified with
the dotfile skip: a deliberate, narrow exception to §4.1's no-extension-filtering rule,
because a proxy is a duplicate by construction, not doubtful media. An explicitly passed
`.lrv` file is still honoured.

**Guidance encoded in KNOWN_LIMITATIONS:** a produced/edited mix is not a valid sync
reference — the engine now *refuses* instead of mis-placing, and the UI's reference
override should point at a raw recorder file or the longest camera instead.

## D-046 — Cache maintenance and a running sync must not overlap (night review)

The eviction sweeps (D-040) spare in-flight `.tmp` scratch files, so they cannot disturb
an extraction mid-write — but they could evict a **committed** entry a running sync had
already checked, and `place`'s `load()?` then killed the whole run with an `Io` error
naming a `{hash}.f32` path, for media that is perfectly fine. Half of this was worse and
is fixed in the engine: the extraction stage used to read existence and length in two
separate stats and could mint a **zero-sample** handle when they disagreed
(`Cache::entry_len` now answers both in one stat, and an unusable entry falls through to
an honest re-decode). The rest is scheduling, enforced in the shell: an `AppState`
activity slot (RAII-guarded) makes `run_sync` and every maintenance pass (`clear_cache`,
`sweep_cache`, `enforce_cache_cap`, the startup sweep) mutually exclusive — the loser
gets an honest `busy:` error. Making `load()` failures per-file `decode_error`s was
rejected: it would report the user's media as broken when the fault is entirely ours.

## D-047 — The Worker is the wire's authority, and its 400 is silent data loss (night review)

The telemetry client treats a 4xx as permanent, so a client/server shape mismatch does
not fail loudly — it discards every report from every affected install, indefinitely.
Three such drifts shipped in E7 and were caught the same night: a scrubber whose
path-boundary set was narrower than the Worker's screen (`[C:\…` survived scrubbing and
tripped the Worker), an uncapped `appVersion`, and a non-finite float that serialises as
JSON `null`. **Rule:** the client's scrub must be a *superset* of the endpoint's screen,
and every cap, enum and key the Worker enforces is pinned in the shell's
`mod wire_contract` — transcribed from `schema-sync.ts` — so drift fails a test instead
of deleting a month of reports. Corollaries: `NIL_INSTALL_ID` is a preview id and never
enters a send path (a deletion retires the identity; continued consent mints a fresh
one); consent is re-checked immediately before each POST, not once per pump; outbox
entries are leased under the same lock that reads them; and atomic writes stage through a
per-writer temp name, because `open -n` relaunch makes two live instances a real state.

## D-048 — A gate must branch on what evidence exists, not on whether reading it succeeded (night review)

Two defects shared one shape. `place::admissible` selected D-045's ordinary bar or its
stricter no-evidence floor by matching on `drift::measure`'s `Option` — so a many-segment
match whose regression *declined* (degenerate fit, non-finite slope) was routed to the
branch meaning "too short to check" and admitted on PSR alone, inverting D-045. And
`fcpxml::correction_of` retimed on a `drift_ppm` it never examined, with a comment
explaining the upstream gate made checking unnecessary — the exact path that stretched
the E10 corpus's −587,484 ppm clip by −59 %. Both are the D-014 lesson at one remove:
a *reading whose absence was mistaken for a benign default*. **Rule:** branch on the
precondition (segment count, input length); treat a failed read of an available
instrument as a refusal; and where a value crosses a public API or serialised contract,
re-check it on the far side (`Drift::credible()` now guards the exporter too) even when
the near side guarantees it.

## D-049 — Evidence-graded admission: a credible clock lowers the PSR bar (owner-delegated)

The second corpus round (three real projects, 2013–2023) settled D-015's open question
with numbers: **true and false matches overlap in PSR** (true min-segment-PSR observed at
13.3–73.1; false at 15.2–19.0), so no PSR threshold alone can ever separate them. What
does separate them, in every observed case, is the drift regression: every false match
carried a physically impossible clock; every true one a physiological clock — agreeing
with PluralEyes' independent measurement of the same project to ±2 ppm. Meanwhile §4.3's
min-over-segments scoring meant one quiet stretch (banter between songs) dragged a true
23-minute clip to 13.9 and refused it: PSR 15 was costing recall without buying
precision.

Admission is therefore graded by the evidence that exists:
- **< 3 segments** (nothing to cross-check): PSR is the only judge — the D-045 floor
  stands, `min_psr × 5/3` (25 at default).
- **≥ 3 segments**: the credible-drift gate is mandatory (as since D-045), and PSR drops
  to corroboration at `min_psr × 2/3` (10 at default). Both factors scale with the §9
  knob, preserving its meaning.

Guards against over-loosening: the full tier's `unrelated.wav` (PSR 9.2) still refuses;
the residual-MAD limit still refuses scattered segments regardless of PSR; and the one
theoretical false mode left — strongly periodic material locking sidelobes onto a
zero-slope line — is why the floor is not lower. The E12 corpus loop watches that mode.
Measured effect on the 5-camera living-room corpus: a true 23-minute clip (13.9, −31 ppm)
and a true 5-minute clip (13.3, −91 ppm) go from refused to placed; nothing previously
refused for incredible drift is readmitted.

## D-050 — Sidecar family skip, and the multitrack-dump exemption (owner-delegated)

Two §4.4/§4.1 refinements confirmed by all three corpus projects:

**Sidecar family.** The walk's skip set (D-045's `.lrv`) grows to the closed set
`.lrv .thm .cpi .bdm .mpl .tdt .tid` — GoPro/DSLR thumbnails and the AVCHD index family
that litters every `PRIVATE/` card dump. They are descriptions of sibling media, not
media; on the 2013 corpus they produced nine spurious `decode_error`s that read as broken
footage. An explicitly passed file is still honoured, and `.bmp`/other generic formats
stay un-filtered (they are real formats and land honestly in `no_audio`/`decode_error`).

**Multitrack dump.** §4.4's same-device eviction rests on "one camera cannot record two
overlapping clips". A folder of per-channel recorder exports (Ch01…Ch16) breaks the
folder=device assumption the other way — and cost 9 of 16 board channels on the 2013
corpus. Detection is physical, not name-based: **three or more** same-device clips that
each cover ≥ 90 % of one another cannot come from one camera and are kept intact (each
channel on its own lane — what a music edit wants). A two-clip full overlap keeps the old
rule: that shape IS producible by one device family (the Insta360 dual-lens pair), where
eviction is correct.

## D-051 — The v0.3 interactive timeline is lifted math, and stays a viewer (S1)

**v0.3 program, S1.** The v0.3 program (stages S1–S7) replaces `ResultView`'s static
per-device lanes with an interactive timeline: zoomable, pannable, seekable, with
mute/solo per device. §9's founding principle is **retained, not revisited**: the result
view is informational, not an editor. Zoom/pan/seek/mute/solo are all read-mostly
operations over a result that already exists — none of them write back into `SyncResult`.
Clip dragging and manual offset correction remain out of scope, as they were in v1;
`ResultView`'s existing information design (the `ClipDetail` dialog, the red unsynced
shelf with its device-reassignment `<select>`, and the `stale` dimming while a re-sync is
in flight) all carry forward unchanged in shape, just rendered against the new geometry.

The spatial math (time↔pixel mapping, zoom-around-anchor, ruler ticks, virtualization) and
the multi-row overlap layout are not new problems — SundayEdit solved the same problems
for its NLE timeline, unit-tested, in `src/features/timeline/`. S1 lifts `geometry.ts` and
`laneLayout.ts`'s packing algorithm (adapted to `ClipSpan { file, startMs, endMs }`,
matching this app's `Placement`/`durations` shape rather than SundayEdit's `TimelineItem`)
and `playhead.ts` near-verbatim into `app/src/timeline/`, tests included, with a header
attributing the source file on each. `formatTimecode` is the one behavioural adaptation:
HH:MM:SS.mmm (milliseconds), not SundayEdit's frame-based HH:MM:SS:FF — GCC-PHAT offsets
are sub-frame (§4.3), and this viewer has no single reliable fps to count frames against
on a mixed-fps shoot (a warning case §9 already surfaces). `snap`/`snapToFrame` and the
J/K/L `shuttleRate` state machine are dropped: frame-snapping assumes an editor with
draggable edges, and transport shuttle is deferred along with playback controls generally.

This is copy-with-attribution, not a shared package. Both repos are the same owner, so the
duplication is honest about it rather than silent. A real `@sunday/timeline-core` package
was considered and rejected for now: the npm org (`@sunday`) is still locked behind the
unresolved owner task tracked in the fundament/growth project, and even once unlocked, a
shared package would couple SundayEdit's and SundaySync's release trains together for code
that, post-adaptation, is already diverging (`ClipSpan` vs `TimelineItem`, ms-timecode vs
frame-timecode). Revisit the extraction once a third consumer needs this math, or once the
two copies drift enough that keeping them in sync by hand becomes the actual cost.

## D-052 — The waveform pyramid: 10 ms base bins, u8 linear, memory-only, and cache-miss as a state

**V03-S2.** The interactive timeline needs a waveform per clip at every zoom. Three
questions had to be answered before a line of it was worth writing.

### Where the samples come from: the analysis cache, never a fresh decode

`extract` already writes every input to `<cache>/<key>.f32` — mono `f32le` at 12 kHz, the
exact signal the offsets were computed from (§4.2). The pyramid streams *that*, in 64 KiB
frame-aligned chunks, copying `CachedAudio::load`'s shape (D-034: never a whole-file read).

**Zero ffmpeg spawns for waveforms.** The alternative — what Clypra does, and what most
editors do — is `ffmpeg` per clip per zoom level. On a 40 GB card dump that is minutes of
decode for a picture, repeated every time the user scrolls. Reading a cache we already
wrote is one sequential pass over a file that is ~1–2 % of the media size.

### The ladder

Level 0 bins **120 samples = 10 ms**, chosen against the display rather than the signal:
at the tightest useful zoom a clip is about one pixel per 10 ms, so finer bins would be
bytes nobody can see. It also divides 12 kHz exactly, keeping bin edges on whole
milliseconds. Each level merges pairs — peak = max of the children, RMS = √(mean of the
children's mean-squares) — until a bin reaches ~2.5 s. That is **9 levels, 10 ms → 2.56 s**:
every zoom from a syllable to a whole service on one screen. *(Superseded by D-056: the
bound is the renderer's, not a musical one, and 2.5 s did not reach the timeline's zoom
floor. The ladder now runs to 40.96 s — 13 levels — and the merge is sample-weighted.)* The ladder length does not
depend on clip duration, so a level index means the same zoom for every clip.

Two numbers per bin, not one. Peak keeps transients alive through downsampling (the drum
hit a human aligns by eye); RMS is what loudness looks like. Drawing peak as outline and
RMS as filled body is what makes a waveform readable rather than a solid block.

### Quantization: `u8`, linear, applied exactly once

Merging is done in **f32 accumulators all the way up**, and quantized only at the end. The
chain is nine levels deep; quantizing per level and merging the bytes would compound the
rounding nine times, turning a 1/255 error at the base into a visible step at the top.
Quantizing once bounds the error at half a quantum at every level.

Linear rather than logarithmic: at 1/255 a dB curve spends most of its range on noise
nobody looks at, and a frontend can apply any display curve it likes to a linear number
but cannot recover linearity from a lossy log one. **Open for S4 review:** if the drawn
result reads as too quiet, switching *RMS only* to a perceptual curve is a one-function
change in `peaks.rs` — peak must stay linear, since it is the thing being compared across
clips.

Values above 1.0 (inter-sample overs, clipped sources) pin at 255 rather than wrapping; a
non-finite sample — impossible from a completed ffmpeg write, possible from a torn one —
reads as silence at the point it enters the fold rather than poisoning the bin through
`f32::max`.

### Residency: an in-memory LRU of 64, and nothing on disk

Pyramids live in `AppState.pyramids`, a hand-rolled 64-entry LRU keyed on the **cache-key
hex** — content identity, so re-recording to the same filename invalidates for free (the
key already folds in size and mtime). ~1 MB per audio-hour means 64 clips is single-digit
megabytes, irrelevant against §7.7's 4 GB ceiling.

Deliberately **not** sidecar `.peaks` files on disk. A second on-disk artefact would need
its own eviction policy, its own staleness rules, and its own place in the cache-size
number the settings screen shows — three new ways to be subtly wrong, to avoid a
recompute that is one streaming read of a local file.

### A missing cache entry is a state, not a failure

The cache is evictable by design: the 90-day sweep, the size cap and the user's Clear
button all delete committed entries (D-040). So "there is no waveform for this clip" is
**normal**, and it has an answer — `regenerate_analysis` re-runs the extractor for that one
file. `Error::is_not_found()` (a helper on the existing `Io` variant, not a new variant, so
the §5 contract is untouched) lets the shell classify it; the shell reports it as
`cache_missing:<path>`, which `errors.ts` maps to its own `MappedError` kind. The
alternative — matching on a Display string — is precisely the seam a reword slips through.

### D-046: the read commands do NOT claim the activity slot

`waveform_meta` and `waveform_level` are read-only and stay exempt from the
sync⟂maintenance mutual exclusion. If they claimed it, every waveform on screen would
blank the moment the user pressed Sync. `regenerate_analysis` **does** claim it as
`Maintaining` — it spawns ffmpeg and writes the cache, which is exactly the work D-046
exists to serialise. The price of the exemption is that a sweep can delete an entry
mid-read; that surfaces as `cache_missing:` (a button), never a panic or a generic IO
error, and a pyramid already resident keeps drawing.

### The binary-IPC gate — VERIFIED, no base64 fallback needed

The level data is shipped as **raw bytes**, not JSON. An hour of level-0 bins is 720 000
numbers; as JSON that is megabytes of text to serialise, parse and collect on every zoom,
as bytes it is one 720 KB buffer the canvas reads directly.

This rested on an assumption that was checked before anything was built, on this repo's
pinned versions (`tauri` **2.11.5**, `@tauri-apps/api` **2.11.1**):

1. `tauri::ipc::Response` → `InvokeResponseBody::Raw` — **verified at runtime**, not by
   reading code: `waveform_level_answers_with_raw_bytes_not_json` drives the real
   `generate_handler!` dispatch through `tauri::test`'s headless MockRuntime and asserts
   the `Raw` variant. It is a permanent regression test, and needs no display and no
   ffmpeg, so it runs on the D-005 runners too.
2. `Raw` → `Content-Type: application/octet-stream` — `tauri-2.11.5/src/ipc/protocol.rs`.
3. octet-stream → `response.arrayBuffer()` — `tauri-2.11.5/scripts/ipc-protocol.js`, the
   `default:` branch of the response-content-type switch.
4. The custom-protocol path (not the `postMessage` fallback, which *would* degrade a
   `Vec<u8>` to a JSON number array on macOS) is the one in use: `tauri.conf.json`'s CSP
   explicitly allows `connect-src … ipc: http://ipc.localhost`.

So `invoke("waveform_level", …)` resolves to an **`ArrayBuffer`** in the webview. The
fallback — base64 in a JSON field, +33 % bytes plus a decode on every zoom — is **not
needed** and was not implemented.

## D-053 — Adopting from Clypra: what was taken, and what was deliberately refused

**V03-S2.** Clypra (MIT, https://github.com/AIEraDev/Clypra) is a Tauri video editor
solving a neighbouring problem. Reading it was worth the hour. Taking all of it would not
have been.

**Adapted.** The per-bucket statistic in `compute_waveform_buckets` — absolute peak paired
with RMS, carried *together* rather than either alone — is the right primitive and is
adapted in `crates/core/src/peaks.rs`, with an attribution comment at the site.

**Lifted (lands S5).** Their `PlaybackClock` — a monotonic clock the UI reads, rather than
polling the media element for `currentTime`.

**Planned (S4).** Their canvas draw loop's structure: one pass, peak outline with RMS body.

**Refused, and why each refusal matters here:**

- **Their transport: `HTMLAudioElement` with a 0.5–2.0 s drift tolerance.** This is the
  one that decides the others. SundaySync exists to prove clips are aligned to the
  *sample*; a preview whose own playback is allowed to wander by up to two seconds would
  make a correct sync look broken and a broken one look fine. It is precisely the failure
  mode this feature is built to disprove, adopted as a design tolerance.
- **ffmpeg-per-zoom waveform extraction.** Re-decoding the source for every zoom step.
  D-052 reads the analysis cache instead: one pass, no process, and the picture is of the
  signal the offsets were actually computed from.
- **An unvirtualized timeline.** Fine for a handful of clips; a multicam service is
  hundreds. Virtualization is S1's problem and is being solved as one.

`THIRD-PARTY-NOTICES` at the repo root carries Clypra's MIT text in full and names the
adapted file, as the licence requires.

## D-054 — Drawing the waveform: level selection, symmetric bars, and the D-052 linear-RMS review

**V03-S4.** Closes the "open for S4 review" note D-052 left on RMS quantization, and
records the three choices that turned S2's bytes into pixels.

### Level selection: finest level with bins/px ≤ 2, no ANALYSIS_RATE plumbing through props

`waveformDraw.ts`'s `pickLevel(levels, pxPerMs)` scans from level 0 (finest) upward and
returns the first level whose bins/px does not exceed 2 — enough bins to represent the
signal without more per-pixel overdraw than the eye can use, falling back to the coarsest
level at an extreme zoom-out and to level 0 (the best available, not a failure) at an
extreme zoom-in. It needs only the level ladder and the current `pxPerMs` because bin
duration is a fixed function of level index (`ANALYSIS_RATE` is one constant for the whole
pipeline, mirrored as `waveformDraw.ts`'s own `ANALYSIS_RATE_HZ`) — no need to thread
`SyncResult.parameters.analysis_rate` down through `Clip`'s props for this.

~~The bin→pixel mapping used for actually drawing (`barGeometry`) deliberately does NOT use
that constant: it derives a bin's on-screen position from `totalSamples` and the clip's own
drawn width (`span.endMs - span.startMs`) instead, so the waveform always exactly fills the
box `Clip.tsx` already drew — immune to the few-millisecond disagreements ffprobe's
duration and the analysis cache's sample count can have.~~

**Reversed by D-056.** The two figures are not one quantity measured twice; dividing by
their ratio time-warps the whole waveform (up to 400 ms mid-clip on a one-hour file, by a
different amount per camera) rather than absorbing a rounding difference. `barGeometry`
now positions every bin from `ANALYSIS_RATE_HZ` alone, and `pickLevel` is fed DEVICE pixels
per ms rather than CSS pixels. See D-056.

### Symmetric peak+RMS, not Clypra's single-direction bars

Clypra's bars grow from a baseline. SundaySync's are drawn symmetric around the clip's
vertical centre — peak as a low-alpha (0.32) outline, RMS as a solid (0.85) body on top,
both reaching equally up and down — because that is the convention every timeline in a
real NLE uses, and it reads a silence-to-loud transition as a shape rather than a height.

### The D-052 review: RMS stays linear, pending an owner listen

D-052 flagged switching *RMS only* to a perceptual (e.g. log) curve as a one-function
change in `peaks.rs` if the drawn result read as too quiet. S4 did not have a real service
recording to judge that against (the e2e corpus is synthetic, deterministic bytes) — so
this stays a reasoned default rather than a verified one: the two-layer peak/RMS composite
should already give the eye separation between "silence" and "someone is talking" without a
curve, and a curve costs the frontend the "linear number, apply any display curve you
like" property D-052 built the quantization on into the bargain. Left as `u8`-linear;
👤 an owner listen against a real recording is the actual close on this review, not this
paragraph.

### Colour without a `warn` prop

`WaveformCanvas` does not take a colour or warn/ok prop. It reads
`getComputedStyle(canvas).color` at draw time — `Clip.tsx`'s `.clip`/`.clip--warn` classes
already set that (the near-black ink the clip's own label is drawn in), and `color` is
CSS-inherited down to the canvas by default. The waveform tracks the §9.4 green/orange
state for free, and cannot drift out of sync with it the way a duplicated colour prop
eventually would.

### The regenerate control could not be a nested `<button>`

`Clip.tsx`'s own clickable box has to stay a real `<button>` (S5's `TimelineView.
onPointerDown` tells a clip click from a background-pan gesture via `target.closest
("button, select, label, .timeline__ruler")`, so anything else silently turns every clip
click into a pan-start instead of a select). The HTML parser un-nests a `<button>` placed
inside a `<button>` (a dedicated rule in the "in body" insertion mode, not just a validator
nit), which would have quietly broken `Clip`'s own DOM. The D-052 regenerate/busy control
is a `role="button"` `<span>` instead, with `stopPropagation` and hand-rolled Enter/Space
handling doing the rest of what a real nested button would have needed anyway.

## D-055 — V03-S5: sample-accurate playback via PCM-over-IPC and scheduled Web Audio

**The crown jewel of v0.3, and the one feature that changes what the app is for.** Until
now SundaySync *asserted* alignment — a number in a dialog, a box on a timeline. The
operator's only way to check it was to export, open Resolve, and listen there. Playback
closes that loop: press play and hear whether two recordings of the same room line up,
before committing to an export.

### Architecture

**PCM over IPC, scheduled through Web Audio. No CSP change, no asset protocol, no
`HTMLAudioElement`.**

The analysis cache already holds every synced file as mono `f32le` at `ANALYSIS_RATE`
(12 kHz) — the exact samples the correlator listened to when it decided where the clip
belongs. One new read-only shell command, `read_audio_window(file, start_sample,
len_samples)`, hands the renderer a window of those samples as raw bytes (the binary-IPC
path D-052 proved; pinned again for this command). The renderer decides *when* each window
sounds and lets the audio hardware do the rest.

```
analysis cache (.f32)
   └─ read_audio_window ──ArrayBuffer──▶ pcmStore ──Float32Array──▶ AudioBuffer
                                                                        │
                    schedulePlan.computeSchedule ──▶ AudioBufferSourceNode(playbackRate)
                                                                        │
                                              per-device GainNode (mute/solo)
                                                                        │
                                                    master GainNode ──▶ destination
```

**Sample-accurate by construction.** Every source is started at `base + whenOffset`, where
`base` is one `AudioContext.currentTime` captured once per play. Two clips 4.2 s apart are
4.2 s apart because both numbers were added to the same `base` and the hardware counted
samples between them — not because anything was started "now". Nothing is ever scheduled
relative to another source, so nothing accumulates. The alternative we refused (D-053) was
Clypra's `HTMLAudioElement` transport with a 0.5–2.0 s drift tolerance: a preview allowed
to wander by up to two seconds would make a correct sync sound broken and a broken one
sound fine, which is the exact failure this feature exists to disprove.

**No `decodeAudioData`.** The bytes are already PCM; `createBuffer` + `copyToChannel` at
12 000 Hz hands the graph the samples unaltered and lets the output device resample.
AudioBuffers are deliberately **not** cached — each backs exactly one source node, and
caching them would silently double the memory budget with a second copy of every chunk.

### The numbers

| Quantity | Value | Why |
| --- | --- | --- |
| Chunk | 15 s = 180 000 samples = **720 KB** | Small enough that one fetch is not a visible stall over a NAS; large enough that a two-hour service is 480 round trips, not tens of thousands. Enforced shell-side as `MAX_WINDOW_SAMPLES` — a size argument from the renderer is trust-boundary data (D-032), and "give me three hours in one call" must be a sentence, not an out-of-memory kill. |
| Horizon | **30 s ahead / 15 s behind** | Ahead is prefetch. Behind is not: nudging the playhead back a few seconds is *the* gesture for "wait, was that in sync?", and it should be instant. |
| Budget | **256 MB** ≈ 372 chunks | An eight-camera three-hour shoot is 4.2 GB of analysis audio. A renderer that keeps all of it is a renderer that gets killed mid-service. |
| Eviction | **farthest-from-playhead first**, LRU as tie-break | Playback is a sweep, not random access. Under pure LRU the chunk evicted to make room can easily be the one four seconds behind the playhead — precisely what a nudge backwards wants — while a chunk from a clip abandoned ten minutes ago survives on recency. Recency decides only between chunks at equal distance, where it is exactly right. |
| Pre-roll | first **5 s** of every audible clip | The transport says «Laster lyd …» meanwhile. Honest: on a NAS this window is real. |

### Drift — the sign, derived rather than guessed

`crates/core/src/drift.rs` defines `ppm` as `d(offset)/d(position in clip)`: positive means
the clip needs a progressively later offset, i.e. its own clock ran fast. `fcpxml.rs`'s
`<timeMap>` (D-042) follows from that — a source position `p` belongs at reference time
`offset₀ + (1 + k)·p` where `k = ppm·1e-6`, so a source span `L` must occupy `L·(1 + k)` of
timeline. Inverting:

```
timeline_time = offset₀ + (1 + k)·source_pos
source_pos    = (timeline_time − offset₀) / (1 + k)
playbackRate  = d(source_pos)/d(timeline_time) = 1 / (1 + ppm·1e-6)
```

**So the playback rate is the reciprocal `1/(1 + k)`, not the naive `1 + k`** — which is
D-019's resample factor written from the other side. The exact reciprocal is used, not the
first-order approximation `1 − k`; at 500 ppm they differ by 0.25 ppm, which is free to get
right. Inverting this does not sound like nothing: it moves the end the wrong way and
**doubles** the error.

`schedulePlan.test.ts` pins it, mirroring `drift.rs`'s own
`correction_cancels_the_end_error_and_inversion_doubles_it`: for both signs and for the two
real full-tier measurements, a corrected clip's end lands on the reference-correct instant
(< 1 µs), the uncorrected end is one full drift out, the inverted rate is > 1.8 drifts out,
and — beyond the endpoint — every chunk boundary satisfies `offset₀ + (1 + k)·p`.

Two further behaviours are inherited from the exporter so that **what you hear is what you
will get**: the start is re-referenced by `projected_end_error_ms / 2000` s (§4.3 places on
the *median*, i.e. the offset at the clip midpoint — skipping this leaves both ends half a
drift out, 250 ms for a 500 ppm 1000 s clip, which is an audible echo), and D-045's
credibility bound plus the half-frame gate are re-applied, so playback corrects exactly the
clips the export will. `playbackDriftCorrected` (Settings, default on) turns it off; it is
deliberately separate from `correctDrift`, because comparing the two by ear is a legitimate
thing to want.

### Buffering, and what a missing clip does

Three states, kept distinct: **absent** (not fetched — simply not scheduled, the 1 Hz
top-up retries), **ended** (an empty window: the cache entry is shorter than the probed
duration, which is normal and silent), and **dead** (`cache_missing:` — the entry is gone;
the clip is written off for the session, named in the transport, and never retried, because
a retry per chunk per second forever is how one missing entry hangs an app). A chunk that
arrives *after* its moment is not played late (an echo) and not dropped (a gap): `catchUp`
skips exactly the elapsed part and starts the remainder at its correct sample.

### 12 kHz is the feature, and the copy says so

This is the audio the correlator heard, which is the whole point — but it is dull and
lo-fi, and someone expecting a mix concludes the app is broken. The transport therefore
carries «Lyd for kontroll av synk (12 kHz analyselyd) — ikke eksportkvalitet». **Comb
filtering is the pass condition**: two copies of the same sound a few samples apart cancel
and reinforce across the spectrum, which is that hollow, phasey doubling. A distinct echo
is a bug.

### The honest limit of automation

**Playwright cannot hear.** The engine mirrors its schedule — the exact numbers handed to
`start()` — onto `window.__SUNDAYSYNC_AUDIO__` on every mutation, and `playback.spec.ts`
asserts against that: offset deltas, drift rates and sign, generation bumps across a seek,
mute/solo gains, the buffering state, dead-file handling. One spec goes further and renders
the real `computeSchedule` output through an `OfflineAudioContext`, measuring where impulse
trains actually land — sample-exact at the start, across a chunk seam, and at the end. That
is as close to listening as a headless run gets. **Acoustics remain a manual smoke test**
(two real files, one delayed; correct = phasey doubling, wrong = echo) **and the S7
listening protocol.**

## D-056 — V03-R2: the waveform is anchored to real time, and level selection is per DEVICE pixel

**Review round 2 on the v0.3 timeline work.** Two of the fixes overturn intent that D-052
and D-054 wrote down deliberately, so they need a record of their own rather than a quiet
edit to those entries.

### The waveform is anchored to real time; the box may legitimately disagree at the tail

D-054 had `barGeometry` derive its sample→pixel mapping from `meta.totalSamples` and the
clip's own drawn width, and said so approvingly: the waveform then "always exactly fills
the box `Clip.tsx` already drew — immune to the few-millisecond disagreements ffprobe's
duration and the analysis cache's sample count can have."

That is backwards. The two numbers are not two measurements of one quantity with a small
error between them; they measure different things. `span.endMs - span.startMs` is ffprobe's
**container** duration (`probe.rs` → `SyncOutcome.durations`); `totalSamples` is the decoded
length of the **first audio stream** in the `.f32` cache (`extract.rs` — no `-t`, no
padding). AAC encoder priming, edit lists, frame-rounded container durations and audio that
simply stops before the video all separate them, routinely by hundreds of milliseconds on a
service-length clip. Dividing one by the other does not absorb the disagreement; it
**time-warps the whole waveform** to close it. A 60-minute clip whose container says
3600.0 s and whose audio decodes to 3599.2 s drew its last bin 799.5 ms out of place and
its middle 400 ms out. Even an 80 ms discrepancy skews mid-clip content by ~40 ms.

And the warp factor is per-file, so each camera warps by a different amount. On a view
whose entire purpose is judging alignment by eye, correctly-synced clips could be made to
*look* misaligned by the drawing code. That is the worst failure mode this view has: it
does not look like a bug, it looks like a sync error.

So the invariant is inverted. Bin `i` of level `L` covers samples `[i·binSamples,
(i+1)·binSamples)`, i.e. clip-relative time `i · binSamples / ANALYSIS_RATE`, and is drawn
at `span.startMs +` that. `totalSamples` no longer takes part in positioning at all.
`ANALYSIS_RATE_HZ` is now the single authority for bin↔time, for selection *and* for
drawing. The existing `Math.min(lvl.bins, …)` clamps do the rest honestly: an analysis
shorter than the container leaves the clip's tail **unpainted**, and one longer than it is
clipped at the box's edge. Both are true statements about what was decoded. A waveform that
stops a few pixels short of a clip's right edge is information; a waveform stretched to
hide that is a lie that costs the view its whole purpose.

### `MAX_BINS_PER_PX` counts DEVICE pixels

`pickLevel` was fed `view.pxPerMs` — CSS pixels. Two consequences, one visible and one
silent.

The visible one: `barWidthPx` was floored at 1 device pixel while the `xs` spacing was not
floored at all, so any level whose bins were under one device pixel wide had every bar
overpainting its neighbour — measured at dpr 1, 0.0125 px/ms: spacing 0.5, width 1.0, a
100 % overlap. Retina hid it (dpr 2 doubles the bin width); an external 1× monitor did not.
The existing DPR test passed only because its single fixture zoom never engaged the floor.

The silent one: the ceiling is a claim about what the *display* can resolve, and a retina
panel genuinely resolves twice the detail at the same zoom. Selecting against CSS pixels
threw that away.

`pickLevel` now takes `view.pxPerMs * devicePixelRatio`. That guarantees the chosen level's
bins are at least `1 / MAX_BINS_PER_PX` device pixels wide, which makes the width floor
unreachable by construction — it is kept, at exactly that value, as a defensive floor that
can never exceed its own spacing.

### The ladder reaches the zoom floor, and the renderer strides anyway

D-052 stopped the pyramid at `MAX_BIN_SECONDS = 2.5`, chosen against what a bin *means* ("a
two-and-a-half-second bin already renders as a near-solid bar"). But the number that
matters is the renderer's: with 2 bins/px as the ceiling and `MIN_PX_PER_MS = 0.00002`, a
bin has to last 25 s before one bar covers half a pixel. A 3-hour clip fully zoomed out was
drawing **19.5 bins per pixel** — a 4219-element `xs` array, per clip, per rAF, to paint
216 px — and ~4.7 bins/px even at the default fit view of a normal service.

The ladder now runs to 40.96 s (13 levels). Each level is half the size of the one below,
so the four added levels cost ~0.4 % of the pyramid; D-052's memory figures are restated
honestly with them (the ladder converges to just under **2×** the base level — ~1.44 MB per
audio-hour, ~11.5 MB for an eight-hour shoot — not the "under 1.5×" D-052 claimed, which
was already wrong for nine levels).

`barGeometry` additionally strides — one bar summarising `ceil(1 / (2 · binWidthDevicePx))`
bins, max of the group — whenever the coarsest available level is still finer than the
display. That is belt and braces, not the fix: it bounds `xs.length` at ~2 per device pixel
regardless of what ladder the engine hands over, including an older cache built before this
change.

### Smaller corrections in the same round

- **RMS merged with sample weights.** `merge_pairs` averaged children's mean-squares as
  equals, but the last bin of every level is short whenever the clip does not divide evenly
  (`base_level` correctly divides it by what it actually holds). 120 silent samples then 30
  at full scale has a true RMS of √(30/150) = 0.447; the unweighted mean gave 0.707, 58 %
  high — one bin per level, always at the clip's end, which is exactly where someone is
  checking whether a camera stopped early. `FloatLevel` now carries a per-bin sample weight
  and merges `Σ(wᵢ·msᵢ) / Σwᵢ`.
- **The scrollbar thumb no longer freezes before the end.** `offsetFrac` was a fraction of
  the *content* clamped to `1 - thumbFrac`; once the 2 % minimum thumb width inflated the
  thumb — i.e. at deep zoom, exactly when it matters — the clamp pinned it. Measured: 3
  hours at maximum zoom sat at 0.9800 for both 99 % and 100 % of maximum scroll, stationary
  across the last ~4 minutes. It is now a fraction of the thumb's own **travel**, exact at
  both ends by construction and needing no clamp.
- **An unexpected waveform error is no longer permanent.** The draw effect is gated on
  `!error` and only `loadMeta` cleared it, so one transient level-fetch failure killed that
  clip's waveform for the session. Recovery is now automatic on a material zoom change
  (quantized to powers of two — ~17 buckets across the whole range, and gated on *leaving*
  the bucket the error was raised at, so a reproducible failure settles rather than
  looping). Deliberately **not** a click target: `.clip__waveform` is centred over the
  whole clip, so a control there would sit where the user aims to click the clip itself and
  would swallow that click. The cache-miss and busy states earn that cost because clicking
  them is the only way back; this one does not.
- **The busy refusal speaks the user's language.** `classifyWaveformError` routed the D-046
  `busy:` prefix through `mapEngineError`, which has no busy branch — so it fell to
  `errUnknown` and a Norwegian UI read «Noe gikk galt: busy: sync in progress»: English
  engine text, crash-shaped wording for an expected self-clearing condition, in a ~28 px
  slot that cannot wrap. There is a `waveformBusy` string now; the raw detail moves to the
  control's `title` rather than being dropped.
- **A short level buffer can no longer draw `NaN`.** `metaCache` and `levelCache` are
  filled by two independent `invoke`s and the pyramid on disk can be rebuilt between them.
  Indexing past the end gave `undefined / 255` = `NaN`, and `NaN <= 0` is *false*, so the
  guard let every one through to `fillRect(x, NaN, w, NaN)` — 1800 of 1800 bins in the
  reproduction. Canvas ignores non-finite arguments, so it degraded silently: luck, not
  design. The read is now a bounds-checked pure function (`barAmplitudes`) and the guards
  are `!(h > 0)`.

## D-057 — V03-S6: the deferred review findings, and what the timeline owes a keyboard

The other half of the v0.3 review (D-056 took the eight that were fixed on the spot), plus
the stage's own polish. Most of it is small; three entries are decisions rather than fixes.

### `waveform_meta` no longer builds the ladder it is describing (finding 12)

`pyramid_for` streams the whole `.f32` and folds thirteen levels. `waveform_meta` needs
none of that: it reports how many bins each level holds, which is a pure function of the
sample count. Every mounted `WaveformCanvas` fires `waveform_meta` on mount — including the
ones the timeline's virtualization holds just off-screen in its overscan — so on an
eight-device one-hour shoot the first frame of results kicked off ~1.3 GB of
near-simultaneous disk reads (~169 MB per audio-hour, per clip) to answer a few dozen
integers.

The sample count is the cache entry's byte length over four, which `Cache::entry_len`
already returns from one `metadata` call, and the ladder from there is `div_ceil` twice
over: `bins[0] = ceil(samples / BASE_BIN_SAMPLES)`, `bins[i] = ceil(bins[i-1] / 2)`, exactly
mirroring `base_level`'s trailing-partial-bin rule and `merge_pairs`'s childless-parent
rule. That is `peaks::meta_from_sample_count`, and
`the_arithmetic_meta_matches_the_folded_ladder_exactly` holds it to the fold **bin for
bin** across empty, one-sample, partial-bin, odd-tail and multi-level inputs — the fold is
the definition, and if the two ever disagree the arithmetic is what is wrong.

The alternative considered was deferring the mount fetch behind an `IntersectionObserver`.
Rejected: it makes the off-screen case cheaper without making the on-screen case correct,
and eight visible clips still cost 1.3 GB. Arithmetic makes the question free for everyone.

Two deliberate differences from the fold, both documented on the command:

- A **resident** pyramid still answers from memory, which keeps a clip describable after a
  maintenance sweep has deleted the entry underneath it.
- A **zero-length** entry reports as `cache_missing:` rather than as an empty ladder.
  `Cache::entry_len` already refuses to serve one (it cannot come from a completed
  write-then-rename), and "rebuild this one" is the honest affordance for it.

### The regenerate LRU eviction had its causality backwards (finding 4)

`regenerate_analysis` evicted the memoized pyramid *before* deleting the cache file, with a
comment claiming this prevented a concurrent read from repopulating it. It achieves the
opposite. `waveform_meta`/`waveform_level` deliberately do not take the D-046 activity slot
and are `async`, so one can land between the eviction and the `remove_file`, miss the
now-empty LRU, read the **old file still on disk**, and `put()` the stale pyramid straight
back — under the same key, because the key is path+size+mtime of the *source media*, which
regeneration does not touch. The file is then replaced and nothing consults the LRU for
that key again: the stale waveform is served for the rest of the session, in exactly the
present-but-corrupt case the button exists for.

The fix is a second eviction after the re-extract returns. To make the *order* testable
rather than merely asserted, the bookkeeping moved into `regenerate_with`, which takes the
extraction as a closure; the test passes a closure that plays the concurrent reader at the
one moment it can do damage, so the assertion is about the outcome of the race and not
about timing. It fails on the pre-fix code.

Recorded rather than changed: because the entry is deleted first, a **failed** re-extract
turns a present-but-corrupt entry into a missing one. That is the right trade (a corrupt
entry is not worth preserving and the error names the real problem), but it is now stated
in the command's doc comment instead of being a surprise.

### A grabbed scrollbar thumb stays under the finger (finding 5)

`scrollbarMetrics.offsetFrac` is the thumb's **left edge** (R2 reshaped it to a fraction of
the thumb's travel), but `pointerdown` anywhere on the bar ran one handler that treated the
pressed point as the **centre** of the wanted window. Pressing the thumb's left edge threw
the view half a visible window backwards before the drag had moved a pixel; the right edge,
half a window forwards.

`thumbOffsetFracToScrollMs` is now the exact inverse of `scrollbarMetrics` — through the
thumb's travel, which is what keeps the round trip exact at deep zoom where `MIN_THUMB_FRAC`
has inflated the thumb past its natural width. A press on the thumb records where inside it
the pointer landed and maps from `frac − grabΔ`; a press on empty trough keeps the
centre-seeking jump (that is what makes click-to-jump land where the eye expects) and then
continues as if the thumb had been grabbed by its middle, which is where it now is.

### The wheel only claims the gestures it handles (finding 13)

The native `wheel` binding (`passive: false`, which is load-bearing — React's synthetic
wheel is passive and cannot `preventDefault`) called `preventDefault()` before looking at
anything, then panned on `deltaX || deltaY`. So a plain downward wheel over the timeline
did not scroll the page — it silently panned the timeline sideways instead — and the export
bar and unsynced shelf below could not be reached by scrolling over the thing that fills
the screen. Now: ctrl/meta zooms (prevented), a real `deltaX` or a held shift pans
(prevented), and a plain vertical wheel is left alone to bubble.

### Keyboard and the scrollbar's ARIA (finding 14 + stage scope)

`role="scrollbar"` with no tab stop and no key handling is a control that announces itself
to a screen reader and then cannot be reached or used by one; `aria-valuenow` reported the
thumb's offset as a fraction of the whole **trough**, so it maxed out at
`(1 − thumbFrac)·100` — 75 on a quarter-width thumb — and 100 was unreachable. It is now
focusable, handles arrows/PageUp/PageDown/Home/End through the same `clampScroll` a pointer
goes through, reports position within the thumb's travel, and `stopPropagation`s the keys it
handles so they do not also drive the playhead.

The section's own keys gained `←`/`→` playhead nudge (±1 s, ±10 s with shift), `Home`/`End`,
and `F` alongside `0` for fit. All of them stay behind the existing
`INPUT`/`SELECT`/`TEXTAREA` guard — the volume slider lives inside the timeline section, so
without it adjusting the volume with the arrow keys would drag the playhead too.

`usePlayheadInsideSpan` finally has the caller it was written for: the clip the playhead
stands in carries `aria-current="time"`, the one value in the enumeration that means a
temporal position. Subscribing to the derived boolean rather than the raw milliseconds is
what keeps that from re-rendering every visible clip sixty times a second.

### Judgement calls (finding 15)

- **`trackAtY` deleted.** Exported and tested, never called: S3 gives every clip a real DOM
  node so hit-testing is the browser's job, and S5's playback addresses clips by file. Dead
  code with tests reads as load-bearing to the next person.
- **A missing `durations` entry is now a visible state.** `durations[p.file] ?? 0` drew a
  3 px sliver that is indistinguishable from a camera that recorded a fraction of a second.
  The clip now carries `clip--nodur` (hollow, dashed), and says "length unknown" in its
  accessible name and tooltip. The **width is deliberately not invented** — drawing a
  duration the app does not have is the failure this is fixing.
- **DPR is read once.** `WaveformCanvas` read `devicePixelRatio` for `barGeometry` and again
  inside `drawWaveform`, with a level fetch resolving in between; it is a parameter now.

### The nested-control trade-off is documented, not silently ignored

The regenerate affordance inside a clip is a `role="button"` span inside a real `<button>`
(D-054/D-055: `Clip.tsx`'s root has to stay a `<button>` for the pan-vs-click test, and the
HTML parser un-nests a real nested `<button>`). axe's `nested-interactive` rule flags it,
correctly, and the trade is deliberate — so it is now written down in
KNOWN_LIMITATIONS.md's UI section rather than living only in a source comment.

## D-058 — V04-U1: the native title bar goes quiet, and the icon joins the family

Two pieces of owner design feedback from the v0.3-beta round, both about the app saying the
same thing twice.

### `hiddenTitle`, not a transparent title bar

The macOS window drew **SundaySync** in its title bar, directly above the in-app wordmark
that says the same word in the app's own type. One of them had to go, and it was not going
to be the one the app controls.

`app.windows[0]` gains `"hiddenTitle": true` and nothing else. Specifically **not**
`titleBarStyle: "Transparent"` (or `"Overlay"`): that would pull the traffic lights down
into the content and hand the app a header-inset problem — every top-level view would owe
the window buttons a ~78 px keep-out region on the left, at two different heights depending
on whether the window is full-screen, and the app has a horizontally scrolling timeline
directly under that band. `hiddenTitle` suppresses *only the text*. The bar keeps its
height, its material and its buttons; nothing in `app/src` moves, and the in-app `<h1>`
wordmark is left exactly as it was.

`"title": "SundaySync"` **stays**. It is not redundant — it is what Mission Control, the
Dock's window menu, ⌘-tab and the Window menu read. Deleting it would trade one visible
duplicate for four places that say "Untitled".

The flag is macOS-only in effect; on Windows and Linux it is inert, and the title keeps
being drawn there, which is the platform convention on both.

### The icon: SundayRec's cross, verbatim

The two marks are meant to read as siblings — SundayRec is `(( ✝ ))`, sound *around* the
cross; SundaySync is `≈≈ ✝ ≈≈`, two waveforms brought into phase either side of it. They did
not look like siblings, because the crosses were different objects: Rec's is a sharp,
architectural cross (`rx="6.2"`), Sync's was a pair of pill-ended bars (`rx="33"`) that read
as a soft plus sign.

Sync's cross is now Rec's geometry, copied number for number rather than approximated:

    upright   x=479.5  y=320.0  w=65.0  h=425.8  rx=6.2
    crossbar  x=376.8  y=437.6  w=270.4 h=65.0   rx=6.2

The gold gradient is aligned to Rec's two stops (`#F2D58A → #EBB84B`); the third, darker
stop (`#D89B2E`) that Sync had at the bottom is dropped, because it made the lower half of
Sync's cross visibly heavier than Rec's at the same size. The purple radial background and
the inner white hairline ring are deliberately unchanged — the *colour* is what tells the
two apps apart, the *shape* is what says they ship together.

**Wave weight is 20, against Rec's 15 — on purpose.** Rec's four arcs are closed, concentric
curves that enclose area; the eye reads them as heavier than their stroke width. Sync's waves
are open serpentine strokes with nothing enclosed, which read optically *thinner* at equal
weight. Rendered side by side, 20 is what matches; 15 would have made Sync's mark look
like a lighter-weight variant rather than the same family. Previously 46, which read as a
different logo altogether next to Rec.

**Wave position was judged from the render, not calculated.** Rec's cross has its mass
centred near y 533 (upright 320 → 745.8), noticeably lower than the old pill cross, so the
waves had to come down with it. Both candidates were rasterised and looked at: the arithmetic
+15 px shift (pair y-centres 467 / 599) left a band of background between the two strokes of
each pair roughly as wide as the wave amplitude, and each pair fell apart into two unrelated
squiggles. Tightening to **475 / 591** nests them back into one `≈≈` unit while keeping the
pair centred on the crossbar. That is what shipped.

At 32 px the cross is fully legible and the waves reduce to faint hints — the intended
degradation, verified on the generated raster rather than assumed.

### The regeneration commands are written down now

They never were, which is why the set had drifted from its source. They live in a header
comment in `app/src-tauri/icons/src/sundaysync-icon.svg`, run from `app/`:

    rsvg-convert -w 1024 -h 1024 src-tauri/icons/src/sundaysync-icon.svg \
      -o src-tauri/icons/src/sundaysync-icon-1024.png
    npx tauri icon src-tauri/icons/src/sundaysync-icon-1024.png -o src-tauri/icons

The 1024 intermediate is a build artifact and is `.gitignore`d; the SVG is the source of
truth and the rasters one level up are the committed output.

**Renderer trap, now confirmed twice.** The known one is that `<line>` elements are silently
dropped by this pipeline (see the SundaySync logo work in the v0.2 round) — everything in the
file has to be a filled shape or a stroked `<path>`. The new one, found while looking for an
`rsvg-convert` substitute: **ImageMagick is not one.** `magick icon.svg -resize 1024x1024`
on this exact file produces a black squircle — background only, every gradient, path and
`clipPath`-clipped child gone — and exits 0. The documented macOS fallback is Quick Look:

    qlmanage -t -s 1024 -o src-tauri/icons/src src-tauri/icons/src/sundaysync-icon.svg
    mv src-tauri/icons/src/sundaysync-icon.svg.png \
       src-tauri/icons/src/sundaysync-icon-1024.png

which renders the file correctly and is what this set was generated from. The general lesson
is the one that keeps recurring in this repo: a rasteriser that drops what it does not
understand, silently and with a zero exit code, is indistinguishable from one that worked —
so the output gets *looked at*, at 1024, 128 and 32 px, every time.

## D-059 — V04-U2: background pre-analysis is an activity, and only a sync may take the slot from it

**V04-U2, backend half.** The scan is probe-only: it learns what the files are without
decoding a sample. So on a fresh shoot every second of the extraction stage is paid *after*
the user presses Sync, and every waveform on the timeline is blank until then — while the
machine sat idle through however long the user spent looking at the sources list.

Prewarming spends that idle time: `prewarm_analysis` runs the same
`Extractor::extract_all` the pipeline runs, over the scanned files, into the same cache the
pipeline reads. Nothing about the sync changes — it simply finds cache hits where it would
have decoded. That is the whole reason this is safe to add to an app whose promise is
"honest failure over silent wrongness": prewarming cannot make a run *different*, only
faster, because the cache is keyed on content identity (§4.2) and a stale entry is
impossible by construction.

### It takes the D-046 activity slot, like every other cache writer

A background pass that spawns ffmpeg and writes the cache is exactly the class of work
D-046 serialises against a run: the sweep-versus-sync bug that decision exists for
(a committed entry evicted out from under a running `place`) does not care whether the
other writer was a user action or a guess. So `Prewarming` is a real `Activity`, claimed
through the same `ActivityGuard`, and `regenerate_analysis`, `clear_cache`, `sweep_cache`
and `enforce_cache_cap` all lose to it with the ordinary refusal.

The refusal string is `busy: analysis in progress`. The `busy:` prefix is load-bearing:
`waveformStore.ts` classifies on the prefix, not the whole string, so a new activity gets
the right UI — an inline, retryable "already busy" control rather than a red banner —
without a single frontend change. Pinned by a test rather than left to convention.

### …but it is the one activity that can be taken away

`run_sync` claims through `ActivityGuard::begin_preempting_prewarm`, which cancels the
prewarm's token and waits for the slot. Nobody else does. The asymmetry is the decision:

- **A sync preempts** because it is what the user actually asked for. Making them wait out
  speculative work the app started on its own guess would be the feature actively making
  the product worse.
- **Maintenance does not preempt** because it is not a headline action, and because a
  prewarm it interrupted would simply be restarted moments later. It gets the honest
  refusal instead.

Three details make the wait defensible rather than a hang:

1. **It is bounded** — `PREWARM_PREEMPT_WAIT`, five seconds, polled every 50 ms. §7.4 puts
   cancellation at ≤2 s (the engine kills in-flight ffmpeg children), so five is generous,
   not tight.
2. **The timeout is honest.** On expiry the caller gets the same `busy: …` string any other
   loser would have got, naming whatever actually holds the slot. There is no special
   "preemption failed" state for the UI to fail to map.
3. **The dead-NAS caveat is real and accepted.** A prewarm wedged in an unkillable read on
   a vanished network volume can outlast any budget. The user then sees a busy refusal on
   the Sync button. That is worse than preemption and better than a button that hangs
   forever, and it is the same class of outcome the app already has for a dead volume
   anywhere else in the pipeline.

Locks are never nested: the activity mutex is released before the prewarm-cancel slot is
touched, and nothing sleeps while holding either.

### Its own channels, and its own cancel slot

Events go on `prewarm:progress` (aggregate) and `prewarm:file` (`{ file, ok }` per
completion). Never `sync:progress` — the results view is bound to it and must not flicker
because of a job the user never started — and never `analysis:progress`, which would make a
rebuilding waveform and a prewarm indistinguishable.

`prewarm:file` is why `Extractor::extract_all_notify` exists. The aggregate `ProgressSink`
can say "4 of 11" but cannot name a file, and naming the file is the entire point: a
waveform can appear the moment *its own* cache entry lands rather than when the slowest clip
in the pass finishes. `extract_all` is now a thin wrapper passing a no-op closure, so the
notifying path and the path the pipeline runs cannot drift. A cache hit notifies too — "this
clip has analysis audio now" is the same fact however it got there — and a file that will not
decode notifies with `ok: false` rather than being omitted, so a clip that will never draw
can say so instead of waiting forever.

The cancel token lives in its own `AppState` slot, on the `scan_cancel` pattern including
the `Arc::ptr_eq` identity guard (F3). That guard matters more here than it does for scans:
a prewarm whose token was cleared by an older pass is one `run_sync` can no longer cancel,
so the Sync button would sit through the whole preempt budget and then refuse.

### What is deliberately not here

The command is registered and inert. Nothing in the frontend calls it yet (V04-U4 wires it),
which is why every existing spec passes unchanged — and is the check that the backend really
is additive rather than quietly rerouting something.

## D-060 — V04-U2: per-file exclusion is request-side, enforced in the engine, and folded into the F6 fingerprint

**V04-U2.** "Leave this clip out of the run" — the second camera that recorded ten seconds
of lens cap, the board dump that duplicates a device, the file that decodes but is not part
of this service.

### Why the request, not the result

§0 freezes the §5 `SyncResult` schema; `SCHEMA_VERSION` covers the *result* only, and
`SyncRequest` says so in its own doc comment (D-028): it is deliberately outside the freeze
so it can grow as the UI needs it to. `exclude_files: Vec<PathBuf>` is a request-side
addition, default empty, and every existing caller constructs through
`SyncRequest::new(..)` or `..SyncRequest::new(..)`. The result contract is untouched: an
excluded file simply is not in the run, so there is nothing new to report about it.

Matching is the same contract as `device_overrides`, deliberately: the **exact path the
scan reported**, no canonicalisation (the UI echoes scan output straight back), and a path
matching nothing is **ignored** rather than an error — a stale exclusion left after the user
removed an input must not abort a run.

### Why the engine enforces it, not the shell

The obvious implementation is to filter the shell's `inputs` list. It does not work:
`sync` re-walks every folder it is given, so the walk would put the excluded file straight
back. `scan::apply_exclusions` therefore runs inside `sync_with_durations`, immediately
after `scan_detailed` and **before** `apply_device_overrides`. That is the only honest
enforcement point — an excluded file is never probed into a candidate, never decoded, never
placed.

It clears **both** buckets, `files` and `unsynced`. Excluding is "this is not part of the
run", not "this failed": leaving the file on the red unsynced shelf would report a problem
about material the run no longer contains. Devices left with no files are dropped, so an
emptied camera stops occupying a lane. The §7.3 accounting invariant is computed after this
runs, over the reduced manifest, so an excluded file is not "lost" — it was never an input.

Ordering has a consequence worth naming: an override that names an excluded file is
thereafter a stale key, and ignored. That is the honest outcome — the file is not in the run
to move.

### The F6 fingerprint is the risky half

`inputs_fingerprint` gains the sorted, deduplicated exclusion list as a fourth component.
Without it, changing which clips are excluded would leave the fingerprint identical, and
`export_timeline` would keep serving the *previous* run's stored timeline — the one that
still contains the file the user just removed. An FCPXML containing a clip the user
excluded, written without a word of complaint, is precisely the silent wrongness F6 exists
to refuse.

`export_timeline` therefore takes `excludeFiles` for parity with `run_sync`, and both turn
a missing argument into an empty list, so a caller that omits the field is byte-identical to
one that passes `[]`. Sorted and deduplicated for the same reason `inputs` is: the frontend
keeps a `Set` and promises no order, so a mere reshuffle must never read as "the sources
changed".

## D-061 — V04-U3: the timeline is the main view, and it never unmounts

**Decision.** The timeline stops being the result screen and becomes the app's main view.
It appears the moment a scan says what was dropped, stays mounted through `sources →
syncing → result`, and the file list becomes a compact panel underneath it.

### Why a pre-sync timeline at all

The old shape answered the user's first question ("did it read my card properly?") with a
list of filenames and badges, and kept the picture — the thing every NLE operator actually
reads — behind a sync they had not run yet. Worse, the two screens were different
components: dropping files showed a list, syncing replaced it with a progress bar on an
empty screen, and a result appeared out of nothing. Three unrelated pictures of one
session.

Now the drop draws clips. There is only one clock available before listening to anything —
the container's `creation_time` (ISO-8601 UTC on MP4/MOV, absent on WAV/BWF) — so that is
what positions them, and the UI is explicit that this is a guess: the boxes are
`clip--pre` (a muted slate, deliberately NOT the §9.4 placed-green), they are `disabled`
(there is no placement to open a detail for), and the meta line above reads "provisional
positions from the files' own timestamps".

### What is deliberately NOT invented

A file with no parseable `creation_time` is placed at zero and its file goes into
`unknownStart`, which the view turns into one line: "N files have no recording time and are
shown from the start." Laying those out end to end instead would have drawn an *order* the
app does not know, and a field recorder's WAV genuinely says nothing about when it started.
The pile at t=0 is the honest picture; the sentence is what stops it reading as "the app
thinks these all began together".

`sourceSpans` (`app/src/timeline/sourceLayout.ts`) is pure and unit-tested for exactly the
cases that are easy to get quietly wrong: which stamp becomes the origin (the earliest
*parsed* one — an unstamped file must not drag the origin), a malformed stamp behaving
identically to a missing one, and the device-override overlay regrouping the timeline the
same way it regroups the panel. The panel and the timeline are two views of one decision
(D-027/D-028); they must never disagree in front of the user.

### Mounted through the sync — the structural half of a later feature

During `syncing` the timeline stays exactly where it is, with `timeline--busy` (dimmed,
`pointer-events: none`), and the progress bar + cancel render **above** it in the markup
that D-030's specs pin. Nothing about the run moves the material the operator is looking
at.

That continuity is not decoration. The stage after this one animates each clip *hopping*
from its metadata guess to the placement the audio proved, and an animation needs the same
DOM node on both sides of the transition. Two consequences are load-bearing and easy to
undo by accident:

1. `Clip` stays a `<button>` in every phase (pre-sync it is `disabled`) rather than
   becoming a `<div>`. React reconciles on element type: a swapped tag tears down the whole
   subtree — waveform state included — at precisely the moment the app is supposed to be
   showing that nothing changed but the position.
2. Every clip carries `data-file`, which is the identity the hop will address it by. It is
   also what the browser tier now uses to point at a specific clip, instead of matching on
   label text.

`presync-timeline.spec.ts` guards both by tagging the live DOM nodes (`dataset`) in the
sources phase and asserting the tags are still on the same section and the same clip after
the result lands.

### What stayed result-only, and why

Ruler, zoom, pan, scrollbar and virtualization work in every phase — they are all about
*looking*. The transport, the playhead line, the per-device mute/solo, the sequence meta,
the unsynced shelf, the clip-detail dialog and the export bar are result-only, because each
of them describes something that does not exist yet: there is no schedule to play, no
offset to detail, nothing to export. A control that answers a click by doing nothing is
worse than no control (the same rule that hides solo on a single-device result).

### The problem group is folded, not hidden

Unreadable files became one `<details>`, shut by default, with the count on its summary and
still on its own chip above. On a good drop they are a footnote that used to be the loudest
block on the screen. `<details>` rather than a hand-rolled toggle: the role, the keyboard
behaviour and the announcement are already correct, and the summary keeps the count visible
while collapsed. Nothing is hidden — one click is the whole cost.

### Spec migration

The browser tier's "have we reached the result?" gate was `.timeline__body` (or a `.clip`)
becoming visible, which is now true from the sources phase on — i.e. it silently stopped
meaning anything. Every such gate moved to `waitForResult()` (harness), which waits for the
result-only export bar. `waveform.spec.ts`'s stateful fixtures were re-keyed **per file**
for the same reason: the timeline now mounts a waveform for every dropped file, so a global
"first call fails" counter would hand that first call to whichever clip mounted first.
`timeline-scale.spec.ts`'s 302-file scenario gained real `creation_time` stamps — a card
dump reporting none would pile all 302 clips at t=0 before the sync, which is correct
behaviour but not the virtualization case that file exists to prove.


## D-062 — V04-U4: removal is a frontend set the engine enforces, and the prewarm is fire-and-forget

**V04-U4.** U2 built the two backend capabilities and nothing called them; U3 made the
timeline the main view. This stage joins them up. Two owner asks, verbatim:

> «det må være mulig å fjerne filer som er lagt til på en enkel måte, om de kan leses
> eller ikke»

> «programmet kan også begynne å analysere audio med en gang filene blir lagt inn slik at
> det ikke tar så lang tid i selve syncen»

U5 takes D-063.

### Removal: one set in the reducer, enforced in the engine

`AppState.excluded` is a plain `string[]` of paths, and it is the *only* place a removal
lives. Everything else derives from it: the timeline's spans (both phases), the panel's
device groups, the summary chips, the problem group, the unsynced shelf — and the
`excludeFiles` argument on `run_sync` and `export_timeline`.

That last part is the whole point, and it is why this could not be done by filtering
`inputs`: `sync` re-walks every folder it is handed (D-060), so a shell that trimmed the
input list would hand the engine a folder and then be surprised when the engine found the
file in it. The filter has to travel with the request, and it is folded into the F6
fingerprint on the way, so an exclusion change makes a stored run stale exactly as an
override or a new reference does. Null is sent when nothing is excluded — `#[serde(default)]`
makes that identical to an empty list, so a frontend that never sends the field behaves
precisely as it did before D-060.

Excluding a file takes three things with it, each of which would be a lie if it stayed:

- **its override**, which would otherwise name a device for a file nobody is syncing — and
  would silently reappear the moment the file was restored;
- **the reference star**, if it pointed there. A run naming a reference the engine was told
  to skip would have the engine quietly pick its own instead — a decision the operator
  never saw being taken;
- **the freshness of a shown result**, via `markStale`, in both directions: restoring a
  file changes the set of sources just as removing one does.

`scan/done` prunes `excluded` the same way it has always pruned `overrides` and
`reference`, but against a **wider** set — `manifest.files ∪ manifest.unsynced` — because a
problem file is removable too and its path is only ever in the second list.

### The ✕ is everywhere a file is listed, and there is a way back

Readable rows, problem rows and the result view's unsynced shelf all carry the same
control with the same accessible-name pattern. The operator does not sort a drop into
removable and non-removable: the lens-cap take and the file that would not decode are one
wish («om de kan leses eller ikke»). The one place it is deliberately absent is the root
chips at the top, which already have their own remove button — a second `<button>` inside
`.roots .root` would make "remove this root" ambiguous to a screen reader and to the
browser tier that clicks it.

A collapsed **«Fjernet (N)»** group at the foot of the panel lists what was removed, each
row with an «Angre». Removal is cheap and reversible or it is not a simple way to do
anything: without the undo, one misclick costs re-dropping the whole card.

### Prewarm wiring: started by a scan, abandoned without a word

`scan/done` hands `manifest.files` (minus exclusions) to `prewarm_analysis` exactly once
per scan sequence. Every rejection is swallowed: a `busy:` refusal (D-046) is the expected
answer when a sweep or a sync already holds the slot, and `cancelled` is what a `run_sync`
that preempted the pass produces (D-059) — both are the system working. Prewarming is an
optimisation; the sync does the same extraction itself, so there is nothing to report and
nothing to apologise for.

Deliberately **not** re-invoked when the exclusion set changes. The extra files an in-flight
pass decodes are harmless cache entries, whereas restarting on every ✕ would throw away
the work in progress each time. A new scan does re-invoke — that is a genuinely different
set of files. `inputs/clear` (and any other route back to the empty phase) calls
`cancel_prewarm`: speculative work on a drop that no longer exists.

The aggregate `prewarm:progress` tick gets its **own** element and class (`.prewarm`),
never `.progress__label` or the `ProgressBar`. Those belong to the scan and the sync, which
are things the operator is waiting for; this is work the app started on its own and will
drop the moment Sync is pressed. Dressing it as progress would say the app is busy when it
is not — and it would collide with the specs that pin those selectors.

### Progressive waveforms, and why `pending` hides the rebuild button

`prewarm:file` does two things per event, in this order: `waveformStore.invalidate(file)`,
then a state update. The order is load-bearing — the memo has to be gone before the clip
re-renders, or the re-read replays the `cache_missing` rejection cached from before the
pass got there.

`PrewarmStatus` is per file, threaded down as **one file's status**, not the map: `Clip` is
`memo`ised, and a map prop would hand every clip a fresh value on every single decoded
file, re-rendering the whole timeline once per event.

While a file is `pending`, its waveform slot shows «Analyserer …» **instead of** the
D-052 rebuild control. That is not cosmetic: `regenerate_analysis` does not preempt a
prewarm, so pressing the button could only earn a busy refusal — and the bytes it would
rebuild are being written at that moment. `failed` (a file that would not decode, §7.2, or
a pass that ended before reaching it) hands the ordinary affordance straight back, because
then a rebuild *is* the right offer.

Only the `pending → ready` transition triggers a re-read. `pending → failed` wrote nothing,
so re-reading could only produce the same rejection.

`prewarm/settled` rewrites the still-`pending` entries to `failed` rather than clearing the
map. React batches updates within one task, and the last file's `prewarm:file` can land in
the same batch as the promise resolving; a wholesale clear would erase that file's `ready`
before any component saw it, and the waveform it had just written would never be read. The
rewrite is order-insensitive, which is the property that matters.

### Spec notes

`prewarm_analysis`/`cancel_prewarm` are answered in `BOOT_FIXTURES` so that every spec
that is not about pre-analysis sees the pass end immediately and the waveform affordances
behave exactly as they did before this stage. `removal.spec.ts` asserts the recorded
`run_sync`/`export_timeline` args rather than the screen — the screen cannot show whether
the engine was told. `prewarm.spec.ts` covers the frontend half of D-059's preemption:
`run_sync` is in flight while the prewarm's promise is still open, i.e. the UI never waits
for the pass to let go.

## D-063 — V04-U5: the clips hop into place, and the view is frozen while they do

**The ask, verbatim:** «Når man klikker sync, så *hopper* filene på plass når de får en
match. Det skal være veldig smooth.»

The structural half of that shipped in U3: the timeline is mode-carrying, mounted from the
first drop and never torn down, with every clip keyed on its `data-file`. What was missing
was the movement itself — the result simply replaced the guess between two frames, and the
one moment where the app has something to *show* the operator (this is where your camera's
clock said it was; this is where its own audio says it was) went by as a cut.

### Freeze → hop → fit, in that order

The commit that first carries an outcome renders the solved placements **under the pre-sync
view** — same zoom, same pan. `TimelineView`'s fit-on-new-content path is held off by a
`frozen` ref while this runs, and so is its scroll clamp: a result span is usually shorter
than the pre-sync one, so clamping alone would have yanked the scroll to a new maximum in
the very frame the clips start moving, and every delta they had just been given would have
been measured from somewhere they no longer were.

The freeze is what makes the movement mean anything. Re-fitting in the same frame would mix
two motions the eye cannot separate — "how far the audio says this clip really was from
where its clock claimed" and "how far the app just zoomed" — and the result reads as a
shuffle rather than as an answer. So the clips travel first, on a stationary canvas, and
only then does the view make one interpolated ~300 ms move to the result's own fit
(geometrically in zoom, because zoom is a ratio and a linear ramp between two px/ms values
crawls at one end and lurches at the other).

`useHop` is declared **before** the measure effect in `TimelineView` on purpose: React runs
one component's layout effects in declaration order, and `frozen` has to be set on the
outcome's own commit before the fit reads it.

### FLIP by transform, and by arithmetic

`transform`, not `left`. A clip's `left`/`width` are inline and rewritten on every pan and
zoom frame; animating `left` would put two writers on one property, taking turns, at exactly
the moment the operator is most likely to grab the timeline.

And the "First" half of FLIP is computed, not measured (`app/src/timeline/hop.ts`). This is
not an optimisation — a DOM read is not *available*. By the time anything can react to the
outcome, React has already committed the new positions, so `getBoundingClientRect` returns
the layout we are trying to animate *from nowhere*. The old layout exists only as the
previous render's data, which is what `hopDeltas` takes:

- **x** is `msToX(span.startMs, view)` — the very expression `Clip.tsx` writes into `left`,
  so the two agree by construction rather than by luck.
- **y** is a sum of track heights above the clip plus its row inside its own track, from the
  same `LANE_HEIGHT_PX` the component hands `Track`. A file's device rarely changes across a
  sync, but the *stack* does: a device that gains a sub-track pushes every track below it
  down, and an empty track (§7.5 keeps those) appears where none was.

`hop.ts` therefore owns a clip box's pixel geometry outright — `LANE_HEIGHT_PX`,
`MIN_CLIP_WIDTH_PX`, `CLIP_HEIGHT_PX` — and `TimelineView` and `Clip` import them rather
than keeping their own copies. The fade ghosts are drawn from those same numbers next to
real clips positioned by the CSS, which is what keeps the duplication in `styles.css`
honest.

### Departures fade; arrivals do not

A clip the run could not place, or one the operator removed, has no node left to animate:
React removed it with the rest of the old layout. What fades is a **ghost** — a plain
`aria-hidden` box drawn at the box the clip used to occupy (`hopExits`) into a dedicated
layer offset by the ruler and the gutter, so it shares the lane column's origin. It is gone
before the timeline comes to rest, and the file itself reappears where a file that would not
sync belongs: the shelf.

Arriving clips get nothing. A clip with no "before" has no journey to show, and inventing
one (a fade-in, a rise) would be decoration on a screen whose whole job is to say what the
engine found.

### Reduced motion skips the work, not just the animation

`styles.css` kills every transition under `prefers-reduced-motion: reduce`. A hop gated on
CSS alone would therefore set a transform, get no transition to carry it away, and leave the
clip sitting on its old position waiting for a `transitionend` that never comes — the
accessibility setting turning correct output into wrong output. The gate is at the top of
the sequence in JS: no transforms, no ghosts, no interpolated fit. The layout lands final
and correct, which it already was.

For the same reason "unknown counts as reduce": if `matchMedia` is missing there is no way
to ask, and the safe answer to "may I animate?" without an answer is no.

### The user always wins

Any pan, zoom, fit or scrollbar gesture cancels the whole sequence on the spot — inline
transforms dropped, clips on their true positions, ghosts removed, and the view left exactly
where the operator put it (`fittedSpan` is marked done so nothing snaps it back). A hop
describes a journey between two positions on a stationary canvas; the moment the canvas
moves it has stopped describing anything.

Nothing may outlive its run: every timer and rAF handle is cancelled on unmount, and a
second sync cancels whatever the first left in flight before it starts.

### `data-hop`, and why an animation test never samples a tween

The section carries `data-hop` for the whole sequence — freeze through hop through fit. It
is real state ("is this timeline showing its final layout?", which for ~750 ms after a sync
is no), and it is what lets `waitForResult` mean *and has stopped moving*.

The browser tier splits accordingly. **Where it lands** is asserted under
`reducedMotion: "reduce"`, where there is no animation at all: clips at their solved
positions, no lingering class, no inline transform. **That it moves** is asserted with a
`MutationObserver` installed before the outcome arrives, recording discrete, timing-free
facts — a class was applied, a non-identity translate was set *and then removed*
(`attributeOldValue` is the only place that value still exists), a ghost was inserted. No
screenshot of a tween, and no pixel sampled mid-flight: an animation frame is a
time-dependent value, and a test that asserts one fails on a slow runner for no reason.

### What the QA sweep found (V04-U5, Task B)

Four defects across U1–U4, each fixed with a test that fails on the code before it.

1. **A dead camera clock destroyed the pre-sync picture.** `sourceLayout.ts` gated stamps on
   `Date.parse` alone, so a camera that came back from a flat battery reading 1970-01-01 —
   and wrote that as confidently as any other date — set the drop's origin fifty-six years
   early. `contentBounds` returned a span of ~1.8 × 10¹² ms, `fitPxPerMs` clamped to
   `MIN_PX_PER_MS`, and the operator got twelve hours of empty grid with the dud clip at the
   far left and every real file off the right edge, with nothing on screen saying why — which
   reads as "the app did not read my card". Stamps are now kept only if they fall in the
   drop's plausible session window (`PLAUSIBLE_SPREAD_MS`, one day: SundaySync exists to line
   up sources that were recording *at the same time*, so anything the correlator could ever
   match is inside one session). The largest run of stamps inside that window wins; ties go
   to the **later** one, because a clock that is wrong is wrong *early* — an epoch, a factory
   date, a battery-pull default — never late. Rejected stamps join the no-stamp files at zero
   and are counted in the note, so the operator is told.
2. **The meta line claimed positions nobody had computed.** "Provisional positions from the
   files' own timestamps" sat above the timeline even when not one file in the drop carried a
   usable one — a folder of field-recorder WAVs, the commonest audio drop there is. Then
   nothing was positioned by a timestamp at all; everything was piled at zero, and the line
   invited the operator to read that pile as a claim about when they recorded.
   `presyncMetaNoClock` says what is actually true.
3. **A superseded pre-analysis pass spoke for the drop that replaced it.** A seam, in the
   shape of two layers each correct alone. `prewarm_analysis` claims the D-046 activity slot
   with the ordinary guard, so only a `run_sync` may take it (D-059); the App fires exactly
   one pass per scan sequence and swallows every rejection, by design. Drop a second folder
   mid-pass and the second `prewarm_analysis` was therefore refused `busy: analysis in
   progress` **in silence**: the new drop got no background analysis at all, while the
   abandoned pass kept reading the old folder off the NAS and kept ticking `prewarm:progress`
   against a file list that was no longer on screen. Three fixes, one per hole: `App.tsx`
   cancels the running pass the moment a new scan starts (the same sentence the empty case
   already said — speculative work on a drop that no longer exists — and early enough that
   the slot is free before the much slower probe finishes and asks for it); `prewarm/progress`
   is ignored outside the `sources` phase, since that channel carries no sequence of its own;
   and `prewarm/settled` now travels with the sequence that launched it, so a late settlement
   can no longer declare the *new* drop's files `failed` on the strength of the old drop's
   promise resolving.
4. **The syncing phase was the one phase the timeline could not be looked at.**
   `.timeline--busy` carried `pointer-events: none` as well as its dim, so a mouse could not
   pan or zoom while the engine ran — while the keyboard's `+`/`−`/`0` and arrows, which go
   through the section's own handler, always could. Two halves of one view disagreeing, and
   both against D-061's stated rule that *looking* works in every phase. There was nothing
   for the blanket to protect: pre-sync clips are `disabled`, and the shelf, the transport
   and the clip dialog are result-only, while the sources panel below has its own `busy` prop
   for the controls that genuinely are decisions. The dim stays; the inertness is gone.

Verified and deliberately **not** changed:

- **The exclusion × override × reference matrix** holds. Removing the reference clears the
  star (so the run cannot name a file the engine was told to skip); removing a file takes its
  override with it and does not hand it back on restore (an override silently returning under
  a restored file is worse than re-picking); removing a device's last file removes the
  device's track from the timeline and its group from the panel, by the same rule an override
  that empties a device already followed; and the F6 refusal's localized copy is already
  proven end to end in `export.spec.ts`.
- **A result keeps the reference badge of the run that produced it**, even after the operator
  removes that file. The result is a historical record, and it is marked stale by the same
  action — rewriting its badge would be editing the record of a run that did happen.
- **`prewarm_analysis` still refuses a second pass rather than superseding it.** The frontend
  cancel above closes the case that actually occurs. Teaching the backend guard to preempt a
  prewarm with another prewarm would widen D-059's "only a sync may take the slot" for a race
  the frontend no longer creates, and the failure mode if the cancel loses the race is
  unchanged from today: one drop without background analysis, which the sync then does itself.

## D-064 — V05-W1: a cancelled pre-analysis is not a failed one, and a sync IS the analysis

**The report, verbatim:** a 386-file wedding, mid-sync. Every clip on the timeline showed
its filename *and* a «Bygg bølgeform på nytt» button, drawn on top of each other inside a
three-pixel box. And when the sync finished, no waveforms appeared at all.

Two defects, one cause each, and this decision is the first: 386 clips offering to rebuild
an analysis that the sync in front of them was rebuilding at that very moment. D-065 is the
second half — why the box was illegible — and neither fix is sufficient alone.

### The chain

Every link was correct on its own, and the suite covered all of them.

1. `scan/done` seeds every scanned file `pending` (D-062) and `App.tsx` fires
   `prewarm_analysis`.
2. The operator presses Sync. `run_sync` **preempts** the running prewarm — D-059's whole
   point, working exactly as designed — so `prewarm_analysis` returns `cancelled` and the
   JS promise rejects.
3. `App.tsx` swallowed that rejection with `.catch(() => {})` and then dispatched
   `prewarm/settled` from a `.then(…)` regardless. The one piece of information the reducer
   needed was thrown away one line before it was asked for.
4. `prewarm/settled` rewrote **every remaining `pending` entry to `failed`** — the right
   answer for a pass that finished, applied to a pass that had been shoved aside.
5. `failed` is not `pending`, so `WaveformCanvas`'s «Analyserer …» gate stopped matching and
   the file fell through to the cache-missing branch: a rebuild control, on all 386 clips,
   for an action that could only have earned the D-046 busy refusal.

### A cancelled pass has no verdict to hand down

`prewarm/settled` now carries a **reason**.

- **`done`** — the pass ran to its own end, or broke. Nothing more is coming for the files
  it never wrote, and `pending → failed` is right: the regenerate control is the correct
  offer.
- **`cancelled`** — preempted by a sync, superseded by a newer drop, or refused the activity
  slot (`busy:`). Those entries are **deleted**, not failed. The pass never formed an
  opinion about the files it had not reached, and neither has the app; an absent entry means
  "no opinion", which is the only true thing to say. Inventing `failed` is exactly what
  §7.5 forbids, and this is what an invention costs.

The reason is classified through the prefixes the app already depends on — `errors.ts`'s
`cancelled → notice` mapping (D-030) and `waveformStore.ts`'s `BUSY_PREFIX` (D-046) — never
a fresh string match. The rejection is still never shown to anyone: a prewarm is an
optimisation and none of the ways it can end is worth a word on screen. It is now *read*
before it is discarded.

### A sync IS the analysis, so the clips may say so

`sync/start` marks **every non-`ready` file `pending`**.

This is not a guard bolted on to make the storm unreachable. It is a fact the app was
failing to state: `run_sync` extracts the analysis audio for every file in the run, so
during `syncing` an unanalysed file genuinely is being analysed. The existing `pending`
branch then shows «Analyserer …» — a status, not a button — which is both true and the
thing the operator wanted to see. That the storm becomes impossible by construction is a
consequence of saying something true, not the reason for saying it.

Built from the manifest rather than from the old map, because by then the map may be empty:
the cancelled pass that this very Sync press preempted deleted its own pending entries.
`ready` is the one status that survives — that file's analysis is already written and the
run will find it there.

`waveform_meta` is deliberately **not** guarded against a running sync. It is a read, and
D-046 exempts reads so the timeline and playback keep working while the engine runs; a
guard there would have "fixed" the storm by making every clip unreadable instead.

### The tail: nothing ever looked again

The missing waveforms were the same bug's other end. The `failed` map was never cleared —
`sync/done` and `sync/failed` left it standing — and `WaveformCanvas`'s re-read effect was
narrowed to `pending → ready`. So after the run there was no trigger at all: every clip
replayed the `cache_missing` rejection it had cached *before* the run, for entries the run
had just written.

`sync/done` and `sync/failed` now clear the map to `{}`, and `App.tsx` calls a new
`waveformStore.invalidateAll()` on the same event. The map going empty says "the app is not
claiming anything about these files"; the invalidation drops every memo. Every canvas then
re-reads once and shows what is true — a waveform where the cache has one, the rebuild
control where it does not — and a second sync starts from a clean map.

### The epoch, and why it is a class of bug rather than an instance

Dropping a memo and making a mounted component go back and look are two halves of one job,
and only the first half had a wire. `waveformStore` gains an **epoch**: `invalidateAll()`
bumps a module counter published through `subscribe`/`getSnapshot`, `WaveformCanvas` reads
it with `useSyncExternalStore` (the shape `timeline/playhead.ts` already establishes) and
includes it in its read's dependencies. One render per mounted clip per invalidation, none
anywhere else.

This kills "a component holds a stale rejection forever" generally, not just here. It is the
same seam D-062's `pending → ready` re-read addressed for one specific transition, and the
same one `waveform.spec.ts`'s zoom-bucket recovery (finding 7) addressed for another: three
narrow triggers, each added after a bug, each covering one route back to a read. The epoch
is the route that does not need to be anticipated.

### The tests, and the two that had to change

`state.test.ts`'s prewarm cases were **updated, not bent**: the action's semantics genuinely
changed, the old expectation ("settling fails everything still pending") is now correct only
for `reason: "done"`, and the new cases assert the cancelled deletion, the `sync/start`
re-pend from an empty map, and the `sync/done`/`sync/failed` clear.

`prewarm.spec.ts`'s "pressing Sync mid-pass is silent" test **existed and passed** while the
owner's screen was covered in rebuild buttons: it only ever checked that no banner appeared.
It now asserts what the clips actually show — zero `.waveform__regenerate` anywhere, and the
analysing status on the clips — and a new test proves the waveforms the run built appear
without a reload. Both fail on the code this decision replaces.

Two e2e fixtures were migrated with the same reasoning: `waveform_meta` fixtures that
rejected "the first call per file" were standing in for a *cause* with a *count*, and the
post-sync re-read is now a second legitimate reason to read — which silently consumed the
rejection a test about the rebuild button needed to see. They are keyed on the cause now
(the file has been rebuilt; the IO blip has passed), which is both stable and truer.

## D-065 — V05-W1: a clip shows what fits, and the layout makes overlap impossible

The other half of the owner's screenshot. Two independent mistakes stacked, and fixing
either alone still leaves an unreadable clip.

### (a) Two children, one box, no relationship

`.clip__waveform` was `position: absolute; inset: 0` with its contents flex-centred, and
`.clip__name` was a normal-flow sibling carrying an inline `transform: translateX(…)`. They
were positioned independently over the same box and therefore drawn on top of each other at
*every* width — the status children even carried `z-index: 1` while the name carried none,
so the filename lost every time. That is not a small-clip bug that a threshold could have
prevented; it is a missing relationship.

The clip is now two layers:

- `.clip__waveform` — the canvas's containing block, under everything. The canvas places
  itself in absolute pixels from `barGeometry`, so it cannot be a flex item; keeping the
  slot as its offsetParent leaves `leftCssPx` meaning exactly what it meant before.
- `.clip__chrome` — one flex row over it: the name (`flex: 1 1 auto; min-width: 0;
  text-overflow: ellipsis`) and the status (`flex: 0 0 auto`), with a 4 px gap. A row cannot
  overlap itself.

The row is `pointer-events: none`, so the clip's own click target is never eaten; only a
child that is genuinely a control takes its pointer events back. The label-slide that used
to be a `translateX` on the name is `padding-left` on the row — it shrinks the row from the
left, where a transform slid one child *across* its sibling. And the per-child `z-index`
arguments are gone: stacking is a property of the two layers now, not something each child
has to win separately.

`WaveformCanvas` keeps its identity and its position in the tree through all of this — the
pre-sync → syncing → result continuity D-061 promises, and `presync-timeline.spec.ts`'s
mount-tag test, both hold. What moved is where the status is *rendered*: it is described by
the waveform's own state and laid out by `Clip`, because the name and the status compete for
the same pixels and neither can be sized by a component that can only see one of them.

### (b) A width rule, in its own pure module

`timeline/clipChrome.ts`, in the style of `geometry.ts`/`hop.ts`:

```
clipChrome(widthPx, "none" | "control" | "info")
  → { name: "none" | "ellipsis"; status: "none" | "icon" | "text" }
```

with `NAME_MIN_PX = 30`, `STATUS_ICON_MIN_PX = 22`, `STATUS_TEXT_MIN_PX = 150`,
`NAME_PLUS_STATUS_GAP_PX = 8`, and the two composites they add up to —
`NAME_AND_ICON_MIN_PX = 60` and `NAME_AND_TEXT_MIN_PX = 188` — named rather than written
out as constants, so the arithmetic is checkable instead of magic.

- **control** (rebuild / busy-retry): the operator has to be able to act, so it is the last
  thing to go. Icon from 22 px, the name joins it at 60 px, the full sentence at 188 px.
  Between 22 and 60 the name would technically fit on its own — a button nobody can press is
  worth less than a name nobody asked for.
- **info** (analysing / unavailable): nothing to press, so nothing to insist on. The
  sentence at 188 px and otherwise nothing at all; the name keeps its own 30 px floor
  untouched. **An informational string must never cost the filename** — a row of clips is
  scanned for names.
- **none**: the name from 30 px, nothing below it.

Below the box's ability to say it, the sentence moves to the slot's `title`, beside the
filename, so a hover still tells the truth. `MIN_CLIP_WIDTH_PX` (3 px, `hop.ts`) is
untouched: a sliver stays a coloured tick, which is a true and useful thing for a clip to
be. It simply carries no text, because three pixels of text is not text.

### Only pixels are rationed

The icon form keeps `role="button"`, its `tabIndex`, the **whole localized string** as its
`aria-label` and the engine's own detail in its `title`. A screen reader hears no difference
between a 22 px clip and a 400 px one; the clip's own `aria-label` still names the file and
its offset either way. `CLIP_HEIGHT_PX` (27 px) remains the vertical budget and the row
never wraps to a second line.

The thresholds are unit-tested from **both** sides — a width rule whose boundaries are only
tested from the roomy side has never been asked the question it exists for, and the question
that mattered was asked at three pixels. One e2e assertion holds the layout itself: the
name's box and the control's box are disjoint, in order, and inside the clip.

One spec was migrated: `timeline.spec.ts`'s unknown-duration test addressed its 3 px sliver
by its text, which a 3 px sliver no longer has. It addresses it by `data-file` now and goes
on asserting what that clip says — in `aria-label` and `title`, which is where it always
said it.

## D-066 — V05-W2: DJI proxies and photographs are skipped before the probe, and counted out loud

**V05-W2.** Measured on the owner's real 386-file wedding, read-only. Two things the scanner
was doing wrong, and one thing it had been getting away with.

### (a) `.lrf` is `.lrv` under DJI's spelling

`01_FILM/DRONE/` holds **8 `.LRF` files**. Five sit 1:1 beside their originals —
`DJI_0075.LRF` at 123 MB next to `DJI_0075.MP4` at 817 MB — and three (`DJI_0080–0082.LRF`)
are orphans whose MP4s are not in the folder at all. `.LRF` is DJI's low-resolution proxy:
the same object as the `.LRV` that D-045 already skips, carrying the same audio as its
original. `lrv` was in `SIDECAR_EXTENSIONS`; `lrf` was not, so all eight were ingested as
real footage and handed to §4.4's device-overlap eviction — a fight nobody started, exactly
D-045's and D-009's failure, in a new spelling. The constant is now eight members.

The orphans are the worse half. A paired proxy at least loses the eviction to its original;
an orphan has no original to lose to, so it can win a lane and put a 123 MB preview on the
timeline where the operator expects the real clip.

Behaviour otherwise unchanged, and deliberately so: an **explicitly passed** `.LRF` is still
honoured, exactly as for every other sidecar since D-045. Only the recursive walk classifies
— the walk guesses, the operator does not.

### (b) Stills are a separate constant, because the argument is a different argument

`STILL_IMAGE_EXTENSIONS` is its own list with its own doc comment rather than eighteen more
members of `SIDECAR_EXTENSIONS`, and the split is the point. A sidecar is a **duplicate by
construction**: its content is already in the run under another name, which is what makes
dropping it safe. A still is not a duplicate of anything, and nothing is wrong with it — it
is simply **not correlatable media**. There is no audio to match on, so no future engine
improvement will ever place it. Merged into one list, the next person to extend it would
extend it on whichever argument they happened to read, and the two do not generalise to each
other.

`01_FILM/STEINAR/IMG_4164.HEIC` is what made it concrete: it was probed, came back with no
audio stream, and landed on the red unsynced shelf — which reads to an operator as *an error
about a photograph*. The skip is therefore made on the name, **before the probe**: on a card
of raws, probing to learn what the extension already said costs one ffprobe per file to
produce a shelf full of `decode_error`, which is noise dressed as an error. Same
explicit-pass exemption as the sidecars.

Members: `heic heif jpg jpeg png dng cr2 cr3 nef arw raf orf rw2 tif tiff webp bmp gif` — the
still formats that actually turn up beside video on a card, including the raw formats of the
manufacturers whose cameras shot the video in the same folder. Both lists match
case-insensitively: the drone writes `.LRF`, macOS writes `.heic`.

### (c) The honesty counter, which is the part that matters

Sidecar skips have been invisible since D-045, and that was defensible for exactly one
reason: a `.lrv`'s original is sitting right there in the list, so nothing appears to have
gone missing. **A `.HEIC` has no sibling.** Skipping it silently means files the operator can
see on the card do not appear in the app, and there is nothing on screen that says why —
which is the same class of failure as the silent truncation §7.3 exists to forbid.

So `ScanManifest` gained `skipped: Vec<SkippedFile>`, with `SkippedFile { file, reason }` and
`SkipReason::{Sidecar, StillImage}` (`"sidecar"` | `"still_image"`), and the sources panel
renders **one quiet line** — nb «11 følgefiler og 1 stillbilde ble hoppet over» — with a
`<details>` listing the files, the same disclosure the problem group and the removed group
already use.

Deliberately **not** the red unsynced shelf: nothing here failed, and a skipped file on the
shelf is the app inventing a problem. Deliberately **not** the timeline note either: that
one is about time. And deliberately absent when the list is empty — a permanent "0 files were
skipped" is a line the operator must read past on every clean drop.

Hidden dotfiles are *not* counted. `.DS_Store` and the AppleDouble `._*` companions are not
the operator's files; listing them would be noise wearing honesty's clothes.

### `SCHEMA_VERSION` does **not** move, and here is why

`skipped` is `#[serde(default)]`, which makes it **additive in both directions**:

- **Old manifest, new reader:** JSON written before D-066 has no `skipped` key and
  deserialises to an empty list rather than failing. Pinned by
  `a_manifest_written_before_the_skip_list_existed_still_deserialises`.
- **New manifest, old reader:** serde ignores unknown fields by default (nothing here uses
  `deny_unknown_fields`), so an older consumer of the `scan` JSON reads the manifest exactly
  as it did before and simply does not see the new list.

Neither direction breaks, so nothing that reads schema v1 is invalidated — which is the only
thing `SCHEMA_VERSION` is for. It is also worth being precise about *which* contract this
is: `SCHEMA_VERSION` lives in `result.rs` and §5 defines it over `SyncResult`. `ScanManifest`
borrows the number so the two outputs agree, but nothing in §5's frozen shapes changed here.
A skipped file was never in the run: it has no placement, no device and no §7.3 accounting,
which is precisely why the list hangs off the *scan* manifest and not off `SyncResult`.

The bump would come the day the field stops being additive — if `skipped` ever became
required, or a reason were renamed, or a skipped file started appearing in `unsynced` too.
The two serde tests (`skip_reasons_serialise_as_the_ui_spells_them`, and the older-manifest
test above) are what make that day loud rather than silent.

### One consequence worth naming

The S-8 file ceiling now counts skipped entries as well as candidates. It exists to bound
memory, and a skipped file costs the same `PathBuf` a candidate does; a card that is 99 %
proxies is still a card the walk must not enumerate unboundedly. A *directory* whose name
happens to end in a skipped extension is passed over unreported and undescended, exactly as
before — the classes are about files, and a folder called `PHOTOS.HEIC` is not a photograph
anyone lost.

## D-069 — V05-W4a: the preview is one JPEG over binary IPC, and its seek shape is measured

**The ask:** the owner wants to *see* the clip he is about to mark, not only its waveform.

The whole question was how to get a picture of arbitrary media into a webview whose CSP
forbids essentially everything. The shape chosen has a **zero security delta**: no CSP edit,
no `assetProtocol`, no new capability, no temporary files. ffmpeg decodes one frame to a
JPEG on stdout, and that JPEG travels the same binary-IPC path this repo has already proved
twice — `waveform_level` (D-052) and `read_audio_window` (D-055). The renderer receives an
`ArrayBuffer`, makes a blob URL, and revokes it.

```rust
#[tauri::command(async)]
fn video_frame(state: State<'_, AppState>, file: PathBuf, at_seconds: f64, height: u32)
    -> Result<tauri::ipc::Response, String>
```

### What the alternatives would have cost

- **`asset://` / `convertFileSrc`** — the obvious answer, and the expensive one. It needs
  `assetProtocol` enabled with a scope, a `csp` allowance for the protocol, and a capability
  granting it. That is three edits to the security posture S-4/S-5 were written to hold, in
  exchange for handing the webview a *file-reading protocol* pointed at whatever directory
  the operator dropped. It also cannot answer "the frame at 4:07" — it serves whole files, so
  the browser would demux multi-gigabyte AVCHD over SMB to show one thumbnail.
- **A JPEG written to a temp directory, then served** — needs the same protocol work *plus*
  a lifetime, an eviction story and a place in the cache-size number the settings screen
  shows. D-052 refused sidecar `.peaks` files for exactly these reasons; this is the same
  refusal.
- **Base64 in a JSON field** — no security delta either, but +33 % on every frame and a
  second encoding to keep honest. D-052 already measured this as the fallback it would take
  only if raw IPC stopped working; it has not.

The one runtime assumption — that `tauri::ipc::Response` produces an
`InvokeResponseBody::Raw` rather than JSON — is pinned by a test through the real
`generate_handler!` dispatch, the same way `waveform_level_answers_with_raw_bytes_not_json`
pins it for the waveform.

### The seek shape is MEASURED, and is not a candidate for tidying

Timed against the owner's real corpus, over SMB:

| argv | AVCHD `.MTS` | 4K DJI MP4, 816 MB | exit |
|---|---|---|---|
| `-ss T -i F` (input seek only) | 0.83 s, valid JPEG | — | **69** |
| `-i F -ss T` (output seek only) | 8.7 s | 8.9 s | 0 |
| **hybrid** `-ss (T−2) -i F -ss 2` | **0.69 s** | **4.4 s** | **0** |

**Input-only seek is a trap, and it is the trap the next person will fall into.** It is the
fastest and the most obvious, and on AVCHD it exits **69 while having written a perfectly
good JPEG to stdout**. `sidecar::run` reports a non-zero exit as `Err` and *drops* the
output, so that shape fails on all **136** of the owner's `.MTS` files — while working
flawlessly on whatever MP4 it was first tried with. Output-only seek decodes from the head
of the file and is unusable over a share.

The hybrid takes both halves: the input-side `-ss` skips cheaply through the container to
two seconds before the target, and the output-side `-ss` decodes that short run to land on
the exact frame. **Their positions relative to `-i` are the entire mechanism.** The argv is
built by a pure function, `frame_args`, whose unit test asserts the ordering verbatim with
these numbers in its comment, because "why are there two `-ss` flags?" is a question a
future reader will answer wrongly.

Shipped verbatim:

```
-v error
-protocol_whitelist file          # D-032, input side. Verified NOT to block pipe:1 output.
-ss <max(0, at_seconds - 2)>      # fast seek
-i <file>
-ss <at_seconds - that>           # accurate seek; equals min(2, at_seconds)
-frames:v 1
-vf scale=-2:<height>
-f image2 -vcodec mjpeg -y pipe:1
```

`-protocol_whitelist file` is the same S-1 guard the probe and extract stages carry, for the
same reason: §4.1 does not reject by extension, so a dropped "video" may really be an HLS
playlist or a concat script. It governs the input demuxer only — `pipe:1` on the output side
was verified to still work, and the argv test asserts both facts separately. `-i` rather than
a bare positional keeps a file named `-frames:v` from being parsed as an option. The accurate
seek is written as `at_seconds - coarse` rather than `min(2, at_seconds)` so the two provably
sum to the requested time instead of doing so by coincidence.

### An empty answer means "no picture", and it is a success

Also measured: `.WAV` and `.HEIC` exit **234 having written zero bytes** — and **32 of the
owner's 386 files** are in that class. That is a normal case, not a failure (§7.2: a file
that will not decode is a value), so it comes back as an **empty** `Response`, which the
panel distinguishes by `byteLength === 0` without parsing a string. A red banner on eight
percent of a perfectly good card would be a lie about the app's state. The ffmpeg stderr
still goes to the log, so a genuinely surprising exit remains diagnosable.

Everything that actually went wrong still errors loudly: a timeout, an unresolvable ffmpeg,
a blown byte ceiling, and a supersession (as the shared `cancelled` word `scan_inputs` and
`prewarm_analysis` already return, so the frontend's existing handling covers it).

### It does NOT claim the D-046 activity slot

The preview writes nothing, so it has no business in the mutual exclusion D-046 exists for —
which is cache *writers* versus a running sync. Claiming the slot would be actively wrong
twice over: it would blank every preview the instant Sync is pressed, and on a fresh drop it
would collide with `prewarm_analysis`, which holds the slot for **minutes**. Same posture,
same reasoning as `waveform_meta`, `waveform_level` and `read_audio_window`.

"Needs no mutual exclusion" is not "may spawn freely", though, so it gets three bounds of
its own:

- **A spawn semaphore, 2 permits** (`FramePermits`). `extract.rs` caps analysis decodes at 4
  explicitly because "more concurrent ffmpeg processes mostly contend for the same disk"; a
  preview that spawned without limit would sit on that same disk and starve a running sync's
  decoders — over SMB, spectacularly. **A held permit is a wait, not a refusal**: the command
  is `async`, so it is already off the UI thread, and a preview arriving 200 ms later is
  right where one that errored "too busy" would have been wrong. Two rather than one because
  at any moment there may be a grab the user just asked for plus a superseded one still
  unwinding, and queueing the new one behind the dying one would show its picture late for
  no reason.
- **`THUMB_TIMEOUT = 30 s`**, sized like `PROBE_TIMEOUT`. `EXTRACT_TIMEOUT`'s thirty minutes
  is a whole-file budget for a three-hour service and absurd for one frame; the slowest shape
  measured was 4.4 s, so thirty seconds bounds a wedged ffmpeg without ever firing on real
  media.
- **`MAX_FRAME_BYTES = 2 MiB`**, enforced by a new `sidecar::run_capped`. Measured frames at
  `height = 160` are **6–11 KB**, so this is three orders of magnitude of headroom and still
  a real bound. What it stops is an ffmpeg that ignored `-frames:v 1`: `sidecar::drain` is an
  uncapped `read_to_end`, and the failure without a ceiling is an OOM kill rather than an
  error. It fails **loudly** — a truncated half-JPEG that decoded to a grey smear is the
  silent wrongness §7.5 forbids. Same refuse-on-a-size-argument posture `MAX_WINDOW_SAMPLES`
  already applies at this boundary.

`height` is validated to `1..=480` and `at_seconds` clamped to `>= 0` (a playhead a hair
before zero is the timeline's own rounding, not a caller error); NaN and the infinities are
refused rather than formatted into an ffmpeg argument. Nothing else can be checked here —
this command does not know the file's duration, and asking ffprobe for it would double the
cost of the thing being made fast.

### `run_capped` is additive; the existing callers keep the uncapped path

`sidecar::run` and `run_capped` share one body with the cap as an `Option`, so the uncapped
path is byte-identical to what it was. The two existing callers deliberately keep it: the
extractor writes its audio to a *file* and produces almost nothing on stdout, and ffprobe's
JSON is bounded by the number of streams in a container. Capping them would be a behaviour
change with its own error-mapping work (`ProbeError` has no variant for it) in exchange for
bounding two things that are already bounded.

Over-ceiling output is drained into a sink rather than merely left unread. Stopping the read
would let the pipe fill and block the child forever, so `try_wait` would never see it exit
and only the timeout could end the call — turning a 5 ms "too big" into a 30 s stall. That is
the same class of mistake D-010 records, arrived at from the other direction.

### Cancellation, because `invoke` has none

`app/src/invoke.ts` has no cancellation: a grab whose answer nobody wants any more — the
playhead moved on, the panel closed — keeps a permit and a running ffmpeg until it finishes
by itself. So the preview gets its own token slot in `AppState` and a `cancel_thumbnail`
command, shaped exactly like `cancel_prewarm`: a new grab supersedes and cancels the previous
one, and the finishing grab clears the slot **only if `Arc::ptr_eq` says it still holds its
own token** (F3). Without that identity guard a late-finishing grab clears a newer grab's
token and leaves the newer one uncancellable — which is to say, holding a permit and a child
nobody can stop. Its own slot rather than a shared one, for the reason the scan and prewarm
slots are separate: firing it must be incapable of reaching a sync the user is waiting on.
The token is installed *before* the permit is waited on, since the queue is exactly where a
superseded grab is most likely to be sitting.

### What this stage deliberately does not do

`video_frame` and `cancel_thumbnail` are **registered and uncalled**. The panel that consumes
them is W4b. That is the intended end state: the engine half lands, proven by its own tests
and by a real-ffmpeg pass over a generated clip, without moving a pixel — which is why every
existing frontend spec passes untouched.

**`.LRF` as a faster preview source is deferred, not rejected.** DJI writes a low-resolution
proxy next to each clip, and grabbing the frame from it measured **0.5 s against the 4.4 s**
of the 816 MB original. It is tempting and it is a separate decision: `.lrv`/`.LRF` proxies
are currently *skipped by the scanner* (D-009), so using one as a preview source means
teaching the shell a source→proxy mapping, deciding what happens when the proxy is stale or
absent, and accepting that the picture shown is not the picture that will be cut. None of
that belongs in the stage that establishes the mechanism.

## D-067 — V05-W3: recording time is a ladder with provenance, not a boolean

**V05-W3.** Measured on the owner's real wedding drop,
`/Volumes/Delt Fossland/LINNEA&SIGURD/`, read-only.

The pre-sync timeline (D-061) positioned clips by one field — the container's
`creation_time` — and put everything else at zero. On that drop, **174 of 386 files** landed
at position zero in one indistinguishable pile, under one sentence: "N files have no
recording time". That sentence was true and it was useless, because it described five
different situations as if they were one.

What ffprobe actually reports, per device:

| Device | Files | What it carries |
|---|---|---|
| Fujifilm X-H2 | 246 `.MOV` | `creation_time=2026-07-25T20:41:12Z` |
| AVCHD camera | 136 `.MTS` | **no container tags at all**; mtime `2026-07-25T14:12:08` |
| Zoom F6 | 16 `.WAV` | `date=2026-07-25` **and** `creation_time=16:12:29` |
| Mixer | 11 `.wav` | **no tags whatsoever**; the name `uirec-20260725_125533.wav` |
| Zoom F2 | 5 `.WAV` | `date=2020-01-01`, and another reads `2023-03-26` |
| DJI drone | 5 `.MP4` | `2023-06-13T20:43:05Z`, in a folder called `SÆVIK DRONE JUNI23` |

Four of those six are placeable, and only one of the four was being placed.

### The ladder

`app/src/timeline/recordingTime.ts` — pure, React-free, and the one place in the app that
decides what a date string means. Five rungs, tried in order:

1. **`container`** — `creation_time` parses as a full ISO datetime. Guarded by requiring a
   date part explicitly, not by asking whether `Date.parse` liked it: the F6's
   `creation_time` really is `16:12:29`, and a "does it parse?" guard is one forgiving
   engine away from reading a time of day as a datetime.
2. **`bwf`** — `creation_time` matches `^\d{2}:\d{2}:\d{2}$`. The date is sought in the
   `date` tag, then in a date token in the basename or any parent folder segment
   (`260725_001.TAKE/`), then in the day the tier-1 stamps agree on. Each fallback is
   weaker than the one before, and if all three fail the file gets **no** time rather than
   an invented one.
3. **`filename`** — `YYYYMMDD[_-]HHMMSS` or `YYMMDD[_-]HHMMSS` in the basename. Found by
   walking adjacent *digit runs* rather than by a regex over the whole name, so a nine-digit
   run cannot be sliced into a false eight-digit date.
4. **`modified`** — `modified_time − duration_seconds`. Measured, not assumed: on the AVCHD
   series the mtime is the **end** of the write, consistent to the second (`02106` at
   14:12:08 for a 30.7 s clip, `02107` at 14:12:58 for an 11 s one, `02109` at 14:41:58 for
   692 s). **Birth time is deliberately not used**: on those same files it is the date they
   were copied off the card (2026-07-27) — a confident wrong answer, which is worse here
   than no answer.
5. **`none`** — nothing usable. D-068's sequential layout is the answer to that.

The result is 407 of 423 media files placed on the real drop, against 244 before.

### Local wall time versus UTC, said out loud

A container `creation_time` is **UTC**. A BWF's `date` + `creation_time` and a timestamp in
a filename are **LOCAL wall time**. `16:12:29` on a Zoom is what the front panel said;
`2026-07-25T20:41:12Z` on the Fuji is not. Combining them naively puts the F6 two hours from
the camera pointed at the same bride, and the difference between the two readings in
JavaScript is a single trailing letter — `Date.parse("…T16:12:29")` means local,
`Date.parse("…T16:12:29Z")` means UTC.

So the two families go through deliberately different doors, each at its own commented call
site: `Date.UTC`-based parsing for the absolute ones, the `new Date(y, m, d, …)` local
constructor for the wall-clock ones. A zoneless container stamp is read as UTC rather than
as local, because ffprobe writes container times in UTC and merely omits the `Z` on some
containers.

`vitest.config.ts` pins `TZ: Europe/Oslo` and `playwright.config.ts` pins
`timezoneId: "Europe/Oslo"`, with a guard test that fails loudly if either is dropped: on a
CI box set to UTC the two doors are indistinguishable and every one of these tests would
pass while the app was two hours wrong for the people it is for.

### Six digits are a date twice over — decided by measurement, then by evidence

`260725` is 2026-07-25 read `YYMMDD` and 2025-07-26 read `DDMMYY`. On this corpus the F6's
folder token `260725` sits beside that same recorder's own `date=2026-07-25` and beside the
Fuji's ISO `2026-07-25`: **`YYMMDD` reproduces both, `DDMMYY` matches nothing in the drop.**

That is the default, not a hardcoding. Both readings are computed, invalid dates are
discarded, and when both survive the one nearer the median day of the tier-1 stamps wins.
Only with no tier-1 stamps at all does the measured default stand unchallenged. Both
readings are tested.

### Midnight rollover

Rungs 2 and 3 are a *date* and a *time of day* that were written down separately, so a
recorder that starts a take at 23:50 and the next at 00:10 may keep writing yesterday's date
into the folder name. Within one device, in natural filename order, a backwards jump of more
than twelve hours is that — and the correction is cumulative: everything from the crossing
onward is a day later. Container stamps and mtimes are left alone, because both carry their
own date and a backwards jump there is a genuine disagreement for the gate to judge.

The device is the file's **own** `FileEntry.device`, not its UI override: whose clock stood
still is a fact about the machine that wrote the files, and regrouping them on screen does
not change it.

### The gate runs over the ladder's output, and grows rather than clamps

V04-U5's plausible-session window used to sit over `creation_time` alone. It now sits over
the whole ladder, which is what lets the lower rungs be aggressive without being reckless.

The **reference tier** is the highest-confidence tier that produced at least two stamps —
two being the least that can corroborate anything; with no tier at two, the single most
trustworthy stamp anchors instead, since one clock cannot contradict itself. That tier's own
24-hour sliding window (ties to the later window, because a broken clock reads *early*) is
the seed. Every other stamp is then offered in order of distance from the seed's centre and
admitted only if the whole admitted set still fits inside 24 hours.

**Growing rather than testing against a fixed hull is load-bearing.** On the real drop the
AVCHD camera's first clip starts an hour *before* the earliest container stamp; a hull test
would have thrown away 136 correctly-timed files. The same mechanism still refuses the
2020 F2 clock, the June drone folder and the mixer's day-before file, because admitting any
of them would stretch the set past a day.

A file the gate rejects is **not** retried on a lower rung. Its evidence was read and it
said somewhere else; asking a weaker source for a different answer is how an app talks
itself into one.

### `SCHEMA_VERSION` does **not** move — D-066's test, applied

`FileEntry` gains `date_tag: Option<String>` and `modified_time: Option<String>`, both
`#[serde(default)]`, and both are **additive in both directions** exactly as D-066's
`skipped` is:

- **Old manifest, new reader:** JSON written before D-067 has neither key and deserialises
  with both `None` (`a_file_entry_written_before_the_time_ladder_existed_still_deserialises`).
- **New manifest, old reader:** nothing here uses `deny_unknown_fields`, so an older
  consumer reads the manifest exactly as it did
  (`a_new_manifest_still_reads_under_a_reader_that_ignores_the_new_fields`).

Neither direction breaks, so nothing that reads schema v1 is invalidated — which is the only
thing `SCHEMA_VERSION` is for. §5's frozen `SyncResult` shapes are untouched.

### The mtime costs a `stat`, not a spawn

`modified_time` is read in `scan.rs` with `std::fs::metadata`, at the point where the path is
already in hand and the filesystem is already being touched. No ffprobe call, no extra
process — which matters, because the whole reason this rung exists is that it is cheap on
files where every container tag is missing. The helper takes a `&Path` and nothing else;
there is no `Sidecar` to hand it, and that signature is the assertion.

ISO-8601 UTC is formatted by a hand-rolled `civil_from_days` rather than by adding a date
crate: `core` has five dependencies and each one is a licence, a build and a supply chain to
justify. It is pinned at the epoch, a leap day, 1900 (not a leap year), 2000 (one) and a
pre-1970 time.

### What the UI says

`SourceLayout` carries `timeSource: Map<string, TimeSource>`. A non-`container` source marks
the clip `clip--est` — a dashed top edge, reusing the vocabulary `clip--nodur` already taught
the eye — and **appends the source in words** to the accessible name: «starter 12:34.000 —
anslått: anslått fra filens endringstidspunkt». A screen reader that heard only "12:34" would
have been told a measurement.

The note above the timeline is now a legend built from counts, replacing the bare
`presyncUnknownStart`: «**204 plassert fra tidsstempel · 163 anslått · 5 bare rekkefølge · 14
utenfor økta.**» Four counts, four different claims, summing to every clip on screen — §7.3's
accounting rule applied to the sentence the operator reads. Zero-valued parts are omitted, so
an ordinary drop still reads as one short line.

## D-068 — V05-W3: files without a usable time are laid out in order, not in a pile

**The owner's choice, and it is the right one**: the app knows something about an untimed
file even when it does not know when it started. The camera *numbered* it. Order is a claim
the app can actually make, and drawing fourteen Zoom takes on top of each other at position
zero was a claim nobody made about any of them.

So a file the ladder could not time (or whose stamp the gate refused, D-071) is laid out
**end to end, zero gap, on its own device's row**, starting at that device's last *placed*
`endMs` — or at timeline 0 when it has nothing placed. Zero gap because a gap would be a
duration nobody measured; the device's own row because a card that is half timed and half not
should read as one continuous strip rather than as a pile sitting on top of its own placed
clips.

Order comes from a new pure `app/src/timeline/naturalSort.ts`: digit runs compare as numbers
(`DSCF640 < DSCF6408 < DSCF10000`, `02106 < 02118`), directory segments compare before the
basename (so the F6's `260725_001.TAKE/` … `_007.TAKE/` come out in take order), and it is
locale-free. `Intl.Collator(…, { numeric: true })` gets the digits right and brings a locale
with it — a layout that changes with the operator's system language is not a layout anyone
can reason about. Digit runs are compared by length-then-lexicographically after stripping
leading zeros rather than via `Number()`, so a run past 2⁵³ cannot collapse into a float that
equals its neighbour and hand two files' order to the sort's stability.

**The fourteen lanes disappear as arithmetic, not as a special case.** End-to-end clips do
not overlap, so `stackClips` returns one row for them — with no branch anywhere saying
"untimed files get one lane". The genuinely-overlapping case (§4.4's multitrack exemption)
still stacks into two, and `timeline.spec.ts:145-147` still asserts it.

### R2, measured rather than assumed

The risk named in the plan: a device with everything unplaced stretches `contentBounds` and
makes every clip narrower, fighting W1's legibility work.

**Measured on the real 423-file drop** by running the shipped layout over the corpus's own
ffprobe output and mtimes:

| | span |
|---|---|
| Session (placed clips only) | **15.43 h** |
| Shipped layout (per-device, from each device's placed end) | **15.54 h** |
| Fallback layout (every strip from timeline 0) | 15.43 h |

**+0.7 %, a factor of 1.008.** It does not bite, and the shipped layout is the per-device
one. The reason it is so small on this drop is worth writing down: the F2's five files total
**12.4 hours** — nearly the whole session on their own — but that device has *nothing*
placed, so its strip starts at zero and lies entirely inside a session that is longer. The
fallback (all strips from 0) stays available and is four lines away if a future drop puts a
long unplaced strip on a device whose placed clips already run to the end.

`contentBounds` still grows to hold whatever the strips need, because a clip drawn outside
the bounds is a clip nobody can scroll to.

### The vertical safety net, which is independent of all of the above

`.timeline__frame` had `overflow: hidden` and no height, so twelve devices at two lanes each
grew the **body** and pushed the sources panel and the sync button off a laptop screen. The
tracks now scroll inside `.timeline__scroll` (`max-height: 60vh; overflow-y: auto`), with the
ruler row `position: sticky; top: 0` inside it — the ruler is the only thing on screen that
says what the horizontal axis means — and the horizontal scrollbar row left outside as the
sibling it already was.

**R5 was real and the test caught it.** Wrapping the tracks in a scrolling element changes
the containing block for every absolutely-positioned overlay in the timeline, the D-063 fade
ghosts included; a ghost placed without accounting for the scroll offset is drawn
`scrollTop` pixels from the clip it stands in for, and **every existing hop assertion would
still pass, because they all run at scroll 0.** `hop.spec.ts` now scrolls the container
before the outcome lands and asserts the ghost's position against the track column's own
origin. (The layout as shipped is correct — the ghost layer lives inside `.timeline__body`
and scrolls with it — but "correct" and "asserted" are different states.)

## D-071 — V05-W3: files stamped outside the session are named, not removed

A stamp the gate refuses is not the same thing as no stamp, and the app now stops calling
them the same thing. `outsideWindow` splits out of `unknownStart` and gets three surfaces:

- **A clip badge**, `clip--offsession` — dashed amber, aria «tidsstemplet utenfor økta».
  Amber rather than the neutral slate of the other pre-sync marks because, unlike them, this
  one is usually a folder that should not have been dropped.
- **A legend line that names the actual date**: «14 filer er tidsstemplet 13.06.2023, utenfor
  denne økta, og er ikke plassert etter klokka.» Naming the date is what makes the line
  actionable — the owner recognises the June drone folder instantly and would recognise
  nothing at all in "14 filer". More than one outlier day is normal (the real drop has
  seven), so the line lists two and counts the rest rather than picking one and lying by
  omission.
- **Nothing auto-removed.** D-062's per-file removal already exists and it is the operator's.
  An app that quietly drops files the operator can see on the card is the silent truncation
  §7.3 forbids, whatever its reason.

Two session days in one drop falls out of the same mechanism rather than needing its own: the
smaller day is demoted by the window gate, counted, and named. No silent merge, and no
invented origin.

## D-070 — V05-W4b: one panel — the frame, the file, and the sync detail

W4a (D-069) landed `video_frame` and nothing called it. This is the half that shows it: a
single panel under the timeline carrying the marked clip's **still frame**, **what the file
is**, and — once there is a placement — **what the engine worked out about it**. The
clip-detail dialog is deleted; `ClipDetail.tsx` is gone and its content moved into the
panel verbatim.

### Why a fixed-height panel that is always on screen

Two alternatives were considered, and both were rejected for reasons that are about this
timeline in particular, not about panels in general.

- **Appear on selection.** It would shove the timeline vertically at the exact instant the
  operator clicked a clip — so their *next* click lands somewhere else. On a 386-file
  wedding the clips are around three pixels wide, and a layout that moves between two
  clicks is not a nuisance there, it is a broken interaction. The same argument kills
  "grow to fit the content": a placement with two warnings would be taller than one with
  none, so the panel would jump as the operator worked through a card.
- **A right rail.** It takes horizontal pixels from the one axis the timeline needs. `.app`
  is a `max-width: 68rem` column (`styles.css`), and D-051's whole point is that TIME gets
  the width — a four-second offset inside a ninety-minute service is only visible if there
  are pixels to spend on it. Trading them for a sidebar undoes the stage that made the
  offsets visible in the first place.

Fixed height also keeps W3's `max-height: 60vh` timeline stable rather than letting it
resize with the selection, which is the same property stated from the other side. The
empty state — «Velg et klipp for å se det.» — therefore renders inside the same box, and
`preview.spec.ts` asserts in pixels that neither the panel nor the timeline above it moves
when a clip is marked.

The panel sits below the timeline and above the export bar. The export bar is result-only;
the panel is not — the picture and the file facts exist from the moment a folder is
dropped, and only the sync half waits for the engine.

### The selection changes domain: a placement becomes a file

`TimelineView`'s `useState<Placement | null>` is now `useState<string | null>`, holding the
file path, and the placement is derived from `result.placements` when there is one. The old
domain was "things the engine has placed", which made a pre-sync selection literally
unrepresentable — which is *why* `Clip.tsx` set `disabled` on a clip with no placement.
The panel is about the file: its picture, its streams, its reconstructed start. A file
exists in every phase.

D-061's real invariant survives untouched: the clip stays a `<button>` and the tag never
swaps at the sources→result boundary, which is what that component's own comment argues
for — the element type is what React reconciles on. Only `disabled` went.

Two consequences, both stated rather than discovered later:

1. **`presync-timeline.spec.ts`'s `toBeDisabled()` became `toBeEnabled()`**, plus an
   assertion that clicking a pre-sync clip fills the panel with the file's facts and shows
   **no** sync detail. That is a better test of the same intent: the old one could not have
   caught a panel that invented an offset for an unplaced clip, and this one does.
2. **A press on a pre-sync clip no longer starts a pan.** `TimelineView.onPointerDown`
   ignores presses that land on `button, select, label, .timeline__ruler`; a *disabled*
   button receives no pointer events at all, so the press used to fall through to the lane
   behind it and pan. Now every clip is enabled, so it does not. That is correct — the clip
   is a control in both phases — and it is a real behaviour change on a dense timeline,
   where clips cover most of the lane. **If it turns out to hurt, the answer is a drag
   threshold on the clip** (press-and-move more than a few pixels pans, a clean click
   selects), not making the clip inert again. Measured in this round: the existing pan
   coverage is wheel-driven and unaffected, and the suite is green.

The reassign `<select>` moved into the panel with the rest of the detail, and reads through
the override overlay (`overrides[file] ?? placement.device ?? entry.device`) rather than
off the placement alone — post-sync an override deliberately does not rewrite the
placement (that is what marks the result stale), so a `<select>` reading only the placement
would snap back the instant it was used. It takes the same `busy` gate `SourcesPanel`'s
controls take: looking works in every phase (D-061), but mid-run there is nothing a
reassignment could change about the run in flight.

### `frameStore.ts` — lifted from SundayEdit, with a different tail

The structure is `sundayedit/src/features/media/thumbnails.ts`: a promise-memo keyed on the
file, at most one grab per file per session, and the frame-time heuristic — **10 % into the
clip, capped at 5 s** — that dodges black lead-ins. What is not lifted is its tail:
SundayEdit writes a JPEG to its cache dir and returns a `convertFileSrc()` URL, and D-069
chose the shape that needs neither an asset protocol nor a temp-file lifetime. The bytes
come back over binary IPC, become an `ImageBitmap`, and are drawn onto a canvas. The
filmstrip and `MediaPlayer.tsx` are not lifted at all.

**Three answers, not two**, and the third is the one that is easy to get wrong:

- a bitmap;
- `null`, **remembered** — there is no picture in this file. Measured (D-069): `.WAV` and
  `.HEIC` exit 234 with zero bytes, and 32 of the owner's 386 files are in that class. It
  is memoised exactly like a success, because a card of WAVs must not re-spawn ffmpeg once
  per click;
- `null`, **forgotten** — the grab was superseded. This is the only answer that says
  nothing about the file, and caching it would mean a clip the operator clicked past once
  shows «ingen bilde» for the rest of the session. That is precisely the shape of the bug
  D-064 was written for.

**Cancellation is phrased as `cancelFramesExcept(file)`, and that phrasing is the fix for a
bug the e2e caught.** The obvious shape — the panel's effect cancelling its own grab in its
cleanup — cancels the grab it just started: `main.tsx` renders under `React.StrictMode`,
which mounts, unmounts and remounts every effect, so the cleanup fires for the file that is
still selected, the token is thrown, and the remount awaits the memoised promise straight
into a `cancelled` rejection. Asking for the *other* files makes the operation idempotent
and says what is actually meant. One call is enough however many entries there are: the
shell holds a single cancel token (`install_thumbnail_cancel`).

### The e2e migration

Five existing assertions moved, none deleted. Each one is re-expressed with its intent
intact, and in three cases the new form is strictly stronger than the old:

| was | now | intent |
|---|---|---|
| `waveform.spec.ts` "regenerate does not open the dialog" | the panel **does not change** across the click (still the empty state, still no frame), plus the rebuild really fired | `stopPropagation` on the rebuild control |
| `waveform.spec.ts` "an unreadable clip can still be selected" | the panel names that file | the status line is not a click target |
| `timeline.spec.ts` "still a clip: clicking opens its details" (3 px sliver) | the panel names that file | a sliver is still selectable |
| `timeline.spec.ts` "the offset to the millisecond" | the same two strings, in the panel | §9.4's numbers, unchanged |
| `override-stale.spec.ts` reassign-from-dialog | `.preview` `getByLabel(moveToDevice)`, no dialog to close | a post-sync reassign marks the result stale |

`timeline.spec.ts`'s shelf `<select>` is a different control and is untouched.
`presync-timeline.spec.ts`'s `data-e2e-mount-tag` continuity assertions still hold — the
panel is a sibling of the timeline frame, not a restructuring of its subtree.

New coverage: pre-sync selection shows frame + facts and no sync detail; post-sync shows
both; a zero-byte answer shows the calm "no picture"; a `controlled("video_frame")` fixture
shows the loading state; changing the selection mid-load invokes `cancel_thumbnail`; a
re-selected file costs no second spawn; and the panel's box does not move between the empty
and the filled state. The `video_frame` fixture's JPEG is produced by the browser's own
encoder (`canvas.toDataURL`) rather than pasted in as base64 — the renderer really decodes
it through `createImageBitmap`, and a subtly malformed literal would fail there and be
indistinguishable on screen from the "no picture" state these specs exist to tell apart.

## D-073 — the preview is the first thing to spend an ffmpeg spawn, and STATUS says so

`STATUS.md` has said, since v0.3, that everything the timeline draws "runs against the cache
the sync already wrote: **no extra ffmpeg spawns, no second decode, no copy of the media**."
That was true of the waveforms (D-052) and of playback (D-055), and it is the kind of claim
that quietly stops being true. The preview breaks the first two clauses: a frame is a real
ffmpeg spawn and a real decode, on demand, of media the analysis cache does not contain.
The line is amended rather than deleted, in the same style as the D-052/D-055 amendments in
`PLAN.md` §9 — the promise is narrowed to what is still promised, and what changed is named.

**§9's read-mostly rule (`PLAN.md` §9, retained by D-051) is satisfied: the preview reads
one frame, writes nothing, makes no copy of the media, and the third clause stands.**
Nothing is written to disk, nothing is written back into `SyncResult`, and clips still do
not drag. The spawn is bounded on both sides by W4a: two permits so a preview can never
starve a running sync's decoders, and no claim on the D-046 activity slot, so a sync never
blanks the picture either.

## D-072 — V05-W5: the waveform reads are queued, capped, and not taken at all below 24 px

**The report:** the owner's 386-file wedding, again, and the same commit that produced
D-064's rebuild-button storm. Every clip on the timeline mounts a `WaveformCanvas`, and its
mount effect called `fetchWaveformMeta` for its own file. The store dedupes **per file**, and
386 clips are 386 distinct files — so the memo matched nothing and **~386 `waveform_meta`
`invoke`s crossed the IPC boundary in one commit**. No queue, no cap, no deferral. Before a
sync has run, every one of them rejects `cache_missing`.

Three separate things were wrong, and only the first is the one that was reported.

### 1. The queue: a cap of six, drained from an idle callback

`fetchWaveformMeta` no longer calls `invoke`. It puts the request in a queue and asks for an
idle callback; `drainMetaQueue` issues at most `META_CONCURRENCY = 6` at a time and refills
as each one settles. Three properties, each there for its own reason:

- **the cap** bounds what is outstanding regardless of how many clips are on screen, so the
  shell sees a trickle instead of a flood;
- **the idle scheduling** puts the first batch behind the commit that mounted the clips —
  the boxes, the ruler and the panel paint first. A drop's first frame is not owed a
  waveform. `requestIdleCallback` is given a 150 ms timeout, because a freshly-dropped card
  dump is exactly the busy main thread that starves an untimed idle callback, and a waveform
  that never arrives is worse than one that arrives a frame late;
- **the drop**: `releaseWaveformMeta(file)` decrements a waiter count, and a request whose
  last consumer went away **before it was issued is removed from the queue and never sent**.
  A pan across a card dump mounts and unmounts hundreds of canvases a second, and a queue
  that faithfully issues everything it was ever handed is a slower storm, not a smaller one.
  A request already in flight is left alone: `invoke` has no cancellation, so there is
  nothing to stop, and its answer is worth memoising for whoever pans back.

The dedup is unchanged and still sits in front of all of it — a queued entry **is** its
file's `metaCache` entry, which is what keeps "one read per file" and "one queue slot per
file" from becoming two bookkeeping systems that can disagree.

`invalidate(file)` deliberately does not touch the queue. It is called one line before
`loadMeta()` in the regenerate path, and `loadMeta` cancels-then-releases; rejecting the
entry from inside `invalidate` would raise an error on a clip whose only crime was to be
mid-read when its own rebuild landed.

### 2. No read at all below `MIN_WAVEFORM_PX = 24`

The cap alone would still have asked 386 times, just six at a time. The deeper answer is
that **at the fitted zoom of a 386-file drop there is nothing to draw**. Measured on the real
corpus (`/Volumes/Delt Fossland/LINNEA&SIGURD/`, read-only): 386 files, a content span of
15.5 hours, and at fit zoom the clip widths are **min 3 px, median 3 px, 90th percentile
10.6 px, max 225 px — 24 of 386 clips are 24 px or wider**. `barGeometry` draws one bar per
device pixel, so a 3 px box is three bars: a smudge that carries no information about the
audio. The IPC, the `<canvas>` element, its backing store and its per-pan draw are all waste,
and they are the *expensive* kind.

So `useClipWaveform` is gated on the clip's drawn width, and the gate covers all four costs —
the fetch, the `<canvas>`, the draw, and the standing error a narrow clip would otherwise
still be showing a rebuild control for.

**Measured, e2e, on a 400-clip fixture at fit zoom: `waveform_meta` is called 0 times.**
With the threshold disabled the same fixture reaches 312 calls within 1.5 s and climbs to
400. Panning across the whole timeline adds no more.

The gate is a **derived boolean** in the effect's dependency list, not the width and not the
zoom bucket. A boolean only changes when the threshold is *crossed*, so the effect re-runs
exactly once per crossing and never on the hundreds of `view` updates a pan produces. The
zoom bucket that drives the `other`-error recovery is too coarse for this: 24 px can be
crossed well inside one power-of-two bucket, and a clip that widened past the threshold
without changing bucket would sit there empty.

24 rather than 30 (`NAME_MIN_PX`) is deliberate and the composition is asserted rather than
described (`clipChrome.test.ts`): anything wide enough for a filename is wide enough for a
waveform, and there is a band between 24 and 30 where a clip draws bars and no name. The two
rules answer different questions — a name needs room for glyphs, a waveform needs enough bars
to have a shape — and pinning them to each other would make one of the two a coincidence. It
also sits *above* `STATUS_ICON_MIN_PX` (22): the rebuild control is the last thing to go
(D-065) and the waveform is not, so a 23 px clip can still be pressed and has no picture
behind it.

### 3. The `Clip` memo is not the lever — measured, and stated so nobody re-derives it

The obvious next move is to blame `memo(Clip)` for the cost of a pan. **It was measured and
the argument does not hold.**

- A pan changes `view.scrollMs`, and `left` is `msToX(span.startMs, view)`. On a 400-clip
  drop, across one wheel notch, **0 of the mounted clips kept their previous `left`** — every
  single one had genuinely new props, so the memo can skip none of them.
- `Track` renders only `visibleClips(row, visStart, visEnd)`, so a clip outside the window is
  not mounted at all. There is no second population for the memo to help either.

The assertion is in `e2e/timeline-scale.spec.ts` («a pan moves EVERY mounted clip») and the
conclusion is written on the component. The `memo` **stays**, because it is still right for
the props that do *not* move — a `prewarm:file` event for one file, a `t` that never changes
— which is exactly why `analysisStatus` and `timeSource` are passed as scalars rather than as
the maps they come from. What it is not is a fix for the cost of a pan. That cost is the
number of mounted clips, and the levers for it are the virtualization window and the width
threshold above.

### Deferred on purpose: `.LRF` as a faster preview source

W4a measured a DJI `.LRF` proxy decoding a preview frame in **0.5 s against 4.4 s** for its
816 MB 4K original, and W2 already knows which `.LRF` belongs to which clip (that pairing is
how `sidecar` skipping works, D-066). Using the proxy for the *picture* is therefore a real,
nearly-free 9× on the slowest preview in the drop.

It is **not built**, and the reason is that it is a correctness question wearing a performance
costume: a proxy is a different file, at a different resolution, and — on some DJI firmware —
with a different frame timebase, so "the frame 10 % into the proxy" is not provably the frame
10 % into the original. A preview that is silently of a *different moment* is worse than a
slow one, and answering that needs a measurement against real DJI files that this stage has
no budget for. Recorded here so the next round starts from the measurement rather than
rediscovering it.

### What the e2e actually holds

A 400-clip drop, at the zoom the operator lands on: a bounded call count in the first commit
(0, asserted `<= 12`), a bounded peak concurrency (`<= 6`), no second storm across 120 wheel
events of panning, zero canvases and zero rebuild controls. Zoomed in far enough for
waveforms to mean something: reads **do** happen — the threshold defers work, it does not
refuse it forever — and the peak is still capped at six.

## D-080 — V06-R0: blue is a semantic pair, and "analysed" is one class

**The question the operator actually asks a card dump is "how far has this got?", and until
now the app answered it in a place they were not looking.** The background pre-analysis
(D-059/D-062) already reports per file, and a clip already changed when its file landed — its
waveform appeared. But a waveform is only visible to someone who is zoomed in far enough for
bars to mean anything, on the one clip they happen to be looking at. At the zoom a
wedding-sized drop is actually read at, a clip is three pixels wide: no waveform, no room for
a word, and no way to see the progress of the pass across four hundred files at once.

So the state moves into the one channel that survives three pixels: colour. **Grey = waiting,
blue = its own analysis is ready, green = the engine has placed it.**

### The token is a PAIR, like the other three

`--blue: #4f8ef7` and `--blue-bg: rgba(79, 142, 247, 0.1)` join `--green`/`--orange`/`--red`
in the `:root` block, in the same shape they have. The wash is unused today; it exists because
the next thing that has to say "analysed" quietly — a legend swatch, a row tint — must not
invent a second blue, which is exactly how a palette stops being one.

The hex is ≈ `oklch(0.64 0.17 262)` and is chosen against the three colours it has to live
beside, not picked for being blue:

- against `--surface3` (`#1e2a42`), the neutral pre-sync slate it replaces: far apart in
  **lightness**, which is the channel a 3 px box still carries;
- against `--green` (`#22c55e`), which is the claim it must never be mistaken for: far apart
  in **hue**, and deliberately not a paler or bluer green — "on the way to placed" must not
  look like a weak version of "placed";
- against the Sunday gold (`--accent`, hue ≈ 85): near its complement, so a timeline full of
  blue clips sits *beside* the accent rather than competing with it for attention.

### One class, and it is only ever pre-sync

`clip--analysed` is added when `placement === null && analysisStatus === "ready"`. The
`placement === null` half is not redundant with `state.ts` emptying the `prewarm` map on
`sync/done` — it makes the two claims mutually exclusive **by construction** rather than by
agreement between two files. After a sync every drawn clip has been analysed, and a colour
every box wears is not a colour.

### Who owns which part of the box

A clip can wear a provenance mark at the same time: `clip--est` (the start is an estimate,
D-067), `clip--seq` (there is no start at all, D-068), `clip--offsession` (there is one and it
belongs to another day, D-071). Those answer a different question — *where the position came
from* — so the two vocabularies divide the box rather than overwrite each other:

- **the edge is the provenance's.** `.clip--analysed`'s `border-color` is left at one class of
  weight and stated *before* all three, so each of them wins it on source order. An
  off-session clip whose audio is analysed is a blue box with the amber dashed edge it had
  before; both claims are still on screen.
- **the fill and the ink are the analysis's**, and that needed `.clip--pre.clip--analysed`
  rather than source order. `.clip--seq` sets a fainter `background` **and** `color` of its
  own, so ordering alone left a clockless clip grey however far its analysis had got —
  silently excluding exactly the drops D-068 exists for, a card whose files carry no recording
  time at all, which is where "how far has this got?" is asked hardest. The compound selector
  is a statement of fact (the class only ever appears alongside `clip--pre`), not a
  specificity trick. It is asserted in `e2e/prewarm.spec.ts`, because a rule that lost to a
  later one is invisible to every test that only looks at class names.

The ink is not decoration. `drawWaveform` reads the canvas's computed `color` at draw time
(D-053), so it is what the waveform's bars are painted in: `--text3` on the blue wash measures
about 1.3:1 — a grey smear on blue, with a filename to match.

### It is said in words too

`presyncAnalysed` («lyd analysert» / "audio analysed") is appended to the clip's accessible
name in that state. A claim the app makes only in colour is a claim half the room cannot hear,
and §9.4's rule about the clip's name has held since the first outcome dialog. It is appended
rather than replacing anything: where the start came from, and whether the file is
off-session, are still the more important half of the sentence.

### No flash on the way to green

`sync/done` empties `prewarm` **and** enters the result phase in one dispatch, so a clip's
classes go `clip clip--pre clip--analysed` → `clip` in a single commit; there is no render in
between where a box could be blue and placed at once, and the hop (D-063) starts from the
already-green box. The one place a departing clip's blue is not carried across is the fade
ghost `useHop.ts` draws for a file the outcome did **not** place: it is built as
`clip clip--pre` and therefore fades from slate. Left alone deliberately — it is a decorative,
`aria-hidden` copy of a box that is leaving, and 260 ms of the wrong slate is a smaller lie
than a blue ghost implying the file is still in the run.

### The ink follows the class — measured, not assumed

The risk worth checking was a cached canvas: bars drawn in slate before the event, still slate
on a blue box after it. It does not happen, and the reason is a seam that already existed.
`App.tsx` drops the store's memo for the file (`invalidateWaveform`) **before** dispatching
`prewarm/file`, so the clip's `pending → ready` re-read returns a fresh `WaveformMeta`
identity, the draw effect re-runs, and `getComputedStyle` is read after React has committed
the new class. Measured on the hardest path — analysis already on disk, so the canvas was
already painted while the pass still reported `pending`: the brightest painted pixel went from
`rgb(73, 87, 120)` to `rgb(220, 234, 255)`. No extra dependency was added to the draw effect;
adding one would have hidden the fact that the invalidation is what makes this work.

### What "distinguishable at 3 px" was checked against

The 402-clip, six-device fixture at «Tilpass» zoom (3 px clips, 838 px of viewport across
9.5 hours), with a progressive front: the first 45 % of each device's clips reported. Grey,
blue and green are separable at that width by lightness alone; the proof image is on the PR.

## D-074 — V06-R1: the app is ONE ROOM, and the room is the window

The v0.6 redesign starts from one sentence of the owner's: the app should stop feeling like a
sequence of pages. Five phases — empty, scanning, sources, syncing, result — used to be five
different vertical stacks in one scrolling column, each with its own height, and moving between
them moved everything. Drop a folder and the drop zone shrank; press Sync and a progress row
appeared where the button had been; the result landed and an export bar arrived under a
timeline that had just changed height. Every one of those is the app answering a question, and
every one of them moved the material the operator was looking at while they were looking at it.

**The shell is a fixed CSS grid the size of the window**, and every phase happens inside it:

```
grid-template-columns: minmax(0, 1fr) 300px;
grid-template-rows:    44px  auto  minmax(0, 1fr)  38px;
grid-template-areas:   "strip strip" "band inspector" "stage inspector" "slot inspector";
```

`html, body { overflow: hidden }`. The document does not scroll at all any more; everything
that scrolls says so for itself — the tracks inside the timeline frame, the inspector column,
and (for as long as it is there) the bridge panel. `tauri.conf.json`'s window follows: 1280×800
by default, never smaller than 1024×600, which is the size the layout is asserted at.

### What this buys, beyond the feel

`.timeline__scroll`'s `max-height: 60vh` (V05-W3) is gone, and what replaced it is stronger
rather than looser. 60vh was a guess at how much of the window the tracks may take, made by an
element that could not see what was below it — it was measured against the VIEWPORT while the
things it was protecting (the sync button, the sources panel) sat somewhere else on a page that
scrolled, so the number had to be conservative and was still only approximately right. In the
room the frame is given a definite height by the grid, and the tracks take what is inside it.
The tracks can no longer push anything off screen because there is nothing below them on a page
to push.

### Refused: `position: fixed` chrome over a scrolling body

The cheaper version of this is to pin the header and a footer with `position: fixed` and leave
the body scrolling underneath. It was refused because it does not actually make the room fixed:
the timeline would still be laid out against a document of unbounded height, `.timeline__scroll`
would still need a `vh` guess, and every `boundingBox` in the e2e would still be a function of
`window.scrollY`. The grid makes "nothing moves" a property of the layout rather than a habit
the code has to keep.

### Asserted, not asserted-about

`app/e2e/ett-rom.spec.ts` measures the strip, the slot, the inspector column, the stage and the
timeline's gutter in pixels, at 1280×800 **and** at 1024×600, across `sources → syncing →
result`, on selection, and while an error banner is up. Two window sizes because a fixed-pixel
layout measured only at its design size proves the numbers were typed in twice, not that the
grid works.

## D-075 — V06-R1: the selection lifts to App, and the transport is portalled into the slot

Two things `TimelineView` owned had to end up somewhere else on screen, and each of them
answers a different question about ownership.

**The selection is now App's `useState`.** It used to live in `TimelineView` because the panel
that read it hung directly underneath the timeline. The inspector is a column of the room now —
a sibling of the stage, not a child of the timeline — and two siblings can only share a fact
through their parent. What did NOT move is the rule the selection has to obey: only the timeline
knows which files are actually drawn (virtualization, exclusion, a re-scan, a pulled outcome —
D-070's four ways a path goes stale), so it keeps the pruning effect and reports a selection
that has stopped naming a drawn clip back up through `onSelect(null)`.

**The transport is rendered by `TimelineView` and drawn in the slot, via `createPortal`.** The
tempting move is to lift it to App the way the selection was lifted. It was refused: `Transport`
is fed by `audioClips`, the memo that also drives `engine.setClips`, and a second component able
to rebuild the audio schedule is a second place a playing timeline can be yanked out from under
the operator (the exact class of bug D-055's single-writer design exists to prevent). A portal
moves the pixels without moving the ownership — the component stays where its data is.

App renders `.slot` in every phase and hands the portal target down as a callback ref in state,
so the commit that mounts the node re-renders the tree that portals into it.

## D-076 — V06-R1: the preview is a column, and the still frame is twice the size

D-070's panel was a 180 px band under the timeline: a 140×79 px still with the file facts and
the sync detail beside it in two independently scrolling columns. That shape was forced by
where it sat — a block in a vertical stack has width to spare and no height to spare, which is
the opposite of what a picture and two tables of facts need.

In the 300 px inspector column the same content stacks: frame → name → file facts → device
select → sync detail. The still is **268×151** (the column's inner width at 16:9), and
`frameStore.FRAME_HEIGHT_PX` doubles from 160 to 320 to match — still 2× the drawn height for a
retina screen, and still inside `lib.rs`'s `MAX_FRAME_HEIGHT` of 480. `frameStore.test.ts` now
pins that number as a number: the existing assertion compared the constant with itself and would
have survived a value the shell refuses outright.

**D-070's rule survives the move and gets cheaper.** The old rule was "the panel is exactly
180 px tall, always", because a fixed height was the only way a box in the vertical stack could
promise not to shove the timeline when a clip was clicked. A column cannot shove the timeline at
all: it is 300 px wide in every phase whether or not a clip is marked, and its content grows
downwards inside its own scroller. So the panel's own height is free now, and what the e2e
asserts is what the rule was always about — the timeline's box, the gutter's x, and the
inspector's width, none of which move when a three-pixel clip is clicked.

The device `<select>` keeps its visible label and gains `aria-label="{moveToDevice}: {name}"`,
matching the unsynced shelf's own selector: in a column that can only ever describe one clip,
naming the subject is the difference between a label and a label with a sentence.

## D-081 — V06-R1: one primary action, and it is always in the same place

The strip carries, in this order: the wordmark, «Legg til», one line of summary, the phase's
single primary action, and the gear. What that costs is written down here, because two things
left the body of the app to make room.

- **The export bar.** The project-name field, «Eksporter til DaVinci Resolve» and «Vis i
  Finder» were a row of their own under the timeline. They are the result phase's primary
  action and the shell has exactly one place for a primary action. Nothing about the controls
  changed — same names, same `disabled={phase.stale}` gate, same order.
- **The `resyncHint`.** «bufret analyse gjenbrukes» was a `<small>` under the button label,
  which is a second line the strip does not have. It is the button's `title` now: same promise,
  same words, on the same control. `override-stale.spec.ts` asks the button for it rather than
  the page.

The summary is «N filer · M enheter», plus `fps · duration` once there is a result. It is
counted exactly the way the sources panel counts its chips — after the exclusion filter, under
the override overlay — because a strip that disagreed with the panel about how many files are in
the run would be the loudest possible bug in a 44 px line.

**The language ghost toggle is gone.** It was a text button in the header that flipped nb↔en,
duplicating the language field Settings already has. No spec ever clicked it; nothing else in
the suite offers a second way to change a setting.

## D-082 — V06-R1: the band takes space, the banners do not, and the band waits for the hop

Two kinds of thing used to occupy a row between the header and the timeline, and they are not
the same kind of thing at all.

**Progress is something the app is DOING**, and it is honest for it to take space for as long
as it is true. So the scan's and the sync's progress bar is a 34 px grid row (`.band`) that
pushes the timeline down by exactly its own height. The gutter column, the inspector column and
the bottom slot are laid out by the grid and never learn it was there.

**A banner is something the app has to SAY**, and there is no reason for everything below a
sentence to move because of it. Banners are a `.toasts` layer over the stage now —
`pointer-events: none` on the layer, back on for each banner, so the rectangle over the top of
the timeline cannot eat a click. Classes, roles and copy are unchanged. The stale notice moves
to the bottom slot as one quiet amber line: it is a fact about the result, not an alarm about
it, and it needs no border to say so.

### The band is held through the hop

`syncing` → `result` removes the band in the same frame `useHop` starts the clips travelling to
their solved positions (D-063). Two movements at once, one of them the moment the whole app is
built around — and a timeline that ALSO jumps 34 px upwards in that frame makes the hop
unreadable, because the eye cannot separate a clip that moved from a clip the room moved under.
So the band stays, showing the finished run at 100 %, until `useHop` reports that the sequence
has come to rest: a new optional `onSettled`, fired from BOTH endings a hop has (its own finish,
and any gesture that cancels it — a cancelled hop answers "is it still moving?" exactly as much
as a finished one). A `HOP_SAFETY_MS + 100` timer is the promise that there is an ending.
Reduced motion skips the hold entirely: there is no hop to wait for, and a hold there would be
750 ms of a bar that has already finished.

**The hold is a LAYOUT effect, and that detail is the whole of it.** `useEffect` runs after the
browser has painted, while `useHop`'s layout effect sets `data-hop` during the commit — so an
ordinary effect paints one frame with the band gone and the hop running, then puts the band
back. That is a flicker, which is worse than no hold at all, and it is not theoretical:
`ett-rom.spec.ts` samples every frame of the hop and caught it (one dropped frame at 1280×800,
ten at 1024×600). Setting the state during render was tried and rejected for a subtler reason —
React drops a render-phase update when the same commit is re-rendered for another cause, which
here it is, and the band came back false. A layout effect's update is flushed synchronously
before paint, and the band never leaves the screen.

## D-086 — V06-R1: «Legg til» is a strip control, and there is only ever one drop zone

The compact `DropZone` becomes the strip's own control: the word «Legg til» and two icon
buttons whose `aria-label`s are still «Velg mappe» and «Velg filer». Same component, same
`dropzone--compact` and `dropzone--over` classes, same window-wide drag listener; what goes is
the dashed card, which inside a 44 px line reads as a second toolbar.

**In the empty phase the strip carries no add control at all**, and that is forced rather than
chosen. `DropZone`'s drag-drop listener is webview-global — the component's own doc comment
says exactly one instance may be mounted at a time — so a compact zone in the strip beside the
full-size one in the empty state would take every OS drop twice and would put two controls
called «Velg mappe» on the page. The empty phase's whole stage IS the invitation, centred, so
there is nothing the strip could usefully add. From `scanning` onwards the strip's copy is the
only one, and `getByRole("button", { name: dropFolder })` resolves in every phase.

## D-087 — V06-R1 is a BRIDGE, and nothing in it ships alone

R1 builds the shell and moves the timeline, the inspector, the transport and the export
controls into it. It does **not** remove `SourcesPanel`: the panel stays mounted, unchanged,
under the timeline inside `.stage__legacy` — its own scroller, capped at 40 % of the stage.

That is a deliberate, temporary duplication. The sources panel is what 150 existing Playwright
tests drive: `region(sourcesTitle)`, the device groups, the reference star, the per-row remove
and its undo, the prewarm tick. Rebuilding the room and rewriting all of that in one stage would
mean a change where every failure has two possible causes, and no way to tell a layout mistake
from a rewritten journey. With the bridge in place the shell is asserted against a suite that
did not move: 150 existing specs pass with **four** targeted edits, each of which re-expresses a
rule the shell genuinely changed rather than deleting it (D-085) —

- `preview.spec.ts` — the panel's fixed 180 px height was the mechanism, not the rule. Now the
  timeline's box, the gutter and the column's width are asserted instead.
- `presync-timeline.spec.ts` — `max-height ≤ 60vh` was a guess the shell replaced with a
  definite height. Now: at a cruel 400 px the tracks overflow, scroll, and end above the slot.
- `timeline.spec.ts` — finding 13's «the page scrolled» is unobservable in a room that does not
  scroll. What finding 13 was about (`defaultPrevented === false`, and the timeline does not
  pan) is asserted directly.
- `override-stale.spec.ts` — the `resyncHint` is the button's `title` (D-081), so the button is
  asked for it.

R2a is what takes the panel out; R2b relocates the zoom controls and the pre-sync legend, which
still sit above the frame in R1. **Nothing from R1 ships on its own** — the room is right and
the room still contains a list nobody needs twice.

**Closed by V06-R2a.** `SourcesPanel.tsx` and `.stage__legacy` are gone; the fourteen
affordances are redistributed (D-077), the four popovers are the disclosure (D-078), the shelf
moved with them (D-079). The bridge did its job: the two specs that drove the panel end to end
(`sources.spec.ts`, `removal.spec.ts`) were rewritten as `kilder.spec.ts` and
`inspector-actions.spec.ts` re-expressing every claim they made, seven more took one targeted
edit each, and everything else in the suite stayed green untouched — which is exactly the
"one failure, one cause" the duplication was bought for.

## D-077 — V06-R2a: the sources panel is not moved, it is REDISTRIBUTED

R1 built the room and left a list in it (D-087). R2a takes the list out, and the way it does
that is the decision: `SourcesPanel.tsx` is deleted rather than relocated, and each of its
fourteen affordances is placed where the question it answers is actually asked.

The panel was one block that answered five unrelated questions at once — *what did I drop?
what is wrong with it? what did I take out? what was never looked at? what do I want to change
about this one file?* — and it answered all five at all times, at 40 % of the stage. A room
where nothing moves cannot afford a permanent block whose height is a function of how many
files were dropped. So:

| # | Affordance | New home |
|---|---|---|
| 1 | root chips + ✕ (`inputs/removeRoot`) | «Kilder» popover on the strip |
| 2 | «Tøm alt» (`inputs/clear`) | «Kilder» popover |
| 3 | camera/recorder chips | **dropped** — see below |
| 4 | file count | the strip's summary line, which IS the popover's `<summary>` |
| 5 | problem chip | the strip's problem chip, which IS its popover's `<summary>` |
| 6 | prewarm tick | the strip, beside the chip |
| 7 | `autoReference` line | the bottom slot |
| 8 | per-device groups + file rows | «Kilder» popover — rows are **buttons** that mark the clip |
| 9 | ★ reference (`reference/set`) | the inspector's action row |
| 10 | device `<select>` (`override/set`) | the inspector's action row |
| 11 | ✕ remove (`files/exclude`) | the inspector's action row |
| 12 | problem list + the result's unsynced shelf | the problem popover (D-079) |
| 13 | removed list + «Angre» (`files/restore`) | the slot's «Fjernet (N)» chip |
| 14 | skipped list | the slot's skipped chip |

**Not one reducer action changed.** Every row of that table is the same dispatch from a
different place on screen, which is what made this stage a redistribution rather than a
rewrite — and what let the fourteen journeys be re-expressed (D-085) rather than re-invented.

### The three that are more than a move

**#8 — the file list survives, and it is the only thing here that had to be argued for.** The
obvious reading of «Ett rom» is that the timeline already draws every file, so a list of the
same files is duplication. It is not, for one measured reason: on the owner's 386-clip drop a
clip is three pixels wide, and *finding one file by name* — the take somebody mentioned, the
card that looks wrong — is something a row of 3 px boxes cannot do at all. The list is the
app's only alphabetical index of what was dropped. What it gains is a purpose: a row is a
`<button>` that marks the clip and closes the panel, so «find it by name» and «look at it» are
one gesture instead of two lists that do not know about each other.

**#9/#10/#11 — one of each control instead of one per row.** The star, the `<select>` and the
✕ were on every row: 386 stars, 386 selects, 386 ✕s for a wedding. They are decisions about a
*particular clip*, so they belong beside the clip the operator is looking at. The controls
themselves are untouched — same classes, same accessible names, same `aria-pressed` on a star
that toggles off, and the `<select>` keeps both its visible label and the `aria-label` that
names the file (D-076). The consequence worth writing down: the ✕ now needs a marked clip, so
a problem file — which has no clip to mark — keeps its own ✕ on its own row inside the problem
popover. "Om de kan leses eller ikke" is still one wish.

**#3 — «1 kamera · 1 lydopptaker» is gone, and nothing replaced it.** A 44 px line has room
for one claim, and the one worth making is «N filer · M enheter». The split between a camera
and a recorder is not lost: it is the icon in front of every device group in the «Kilder»
panel and the icon in the timeline's own gutter, both of which are where the operator is
already looking when the distinction matters. The i18n keys stay until R3 prunes them — a
string that might be wanted again is cheaper than one that has to be written twice.

### `sourcesModel.ts`

The panel's four `useMemo`s became pure functions, because four different components now ask
the same questions and a derivation that four components share cannot live inside one of them.
The rules are verbatim (count after the exclusion filter, group under the override overlay,
drop a device the overlay emptied) and they are finally *stated*: `sourcesModel.test.ts` pins
the one that matters most and was asserted nowhere before — that `sourceCounts` and
`groupFiles` agree, so the strip and the list it opens cannot disagree about how many files
are in the run.

### Busy

The panel dimmed itself as a block while a sync ran (D-061). The strip's sources cluster does
the same (`aria-busy`, `.strip__sources--busy`), and the inspector's three controls are
`disabled` individually instead — the inspector is a picture, a table of facts and three
controls stacked in one column, and greying the whole column would say the picture had become
unavailable too, which it has not.

### The one affordance that got narrower

Post-sync, the ✕ needs a clip on the timeline or a row in the problem popover. A manifest file
that the run neither placed nor shelved therefore has no control — it can be found in «Kilder»
but not removed until the next scan. In practice the engine's answer covers every input file
(placed or unsynced), so this is a shape the fixtures can build and the backend does not; it is
written down here rather than guarded against, because the guard would be a fourth list.

## D-078 — V06-R2a: the popovers are `<details>`, and they overlay the room

Four disclosures, one shape:

```html
<details class="popover [popover--up] [popover--right]">
  <summary class="…">…</summary>
  <div class="popover__panel" role="group" aria-label="…">…</div>
</details>
```

**`<details>` rather than a hand-rolled menu**, and the reason is arithmetic: four popovers,
and not one of them re-implements keyboard behaviour. The summary is a tab stop, Enter and
Space open it, the open state is announced, and the browser owns all of it. `usePopoverDismiss`
adds exactly the two behaviours the element has no opinion about — Escape, and a pointer press
outside — in about thirty lines, once.

**The summary is always a control the strip or the slot wanted anyway.** The summary line, the
problem chip, «Fjernet (N)», the skipped line: each of those was already on screen saying its
own count, and making it the disclosure is what buys the whole list for zero extra pixels.

**The panel is a LAYER, and that is the point.** The room is fixed (D-074); a list that took
space when it opened would move the material the operator is reading, which is precisely what
the bridge panel did for the whole of R1. `ett-rom.spec.ts` opens all four in turn, at both
window sizes, and asserts that the strip, the slot, the inspector, the stage, the gutter and
the timeline's frame are unmoved to the pixel.

### `composedPath()`, not `contains()`

The dismissal listener uses `event.composedPath().includes(el)`, and the difference is not
academic. A native `<select>` — the shelf's device selector, inside the problem panel — draws
its options in the browser's own popup layer rather than as descendants of the element, so a
press on an option resolves as "outside" under `el.contains(event.target)` and the panel closes
under the operator's hand, mid-choice, in the one interaction that panel exists to support.
`composedPath()` is the event's real journey and includes the host. Pinned by a spec that
opens the shelf's selector and chooses from it.

`pointerdown` rather than `click`, and in the capture phase: the press is what the operator
experiences as dismissing, and a `click` listener fires after `mouseup` — late enough that a
press inside the panel that drifted outside before release would read as a dismissal of a
gesture that never left.

### Stacking

`.app__header` and `.slot` are `position: relative; z-index: 40`. Without it the panels are
painted *and hit-tested* behind the timeline: `.stage` is itself positioned, and a panel inside
a static row loses the paint order to it no matter what `z-index` the panel carries. Found by a
spec, not by eye — the «Angre» button was visible and unclickable, with the scrollbar thumb
taking the press.

## D-079 — V06-R2a: the unsynced shelf hangs off the problem chip, and the numbered clips wait

`UnsyncedShelf` keeps its markup — `.shelf`, `.shelf__row`, the device `<select>`, the ✕ — and
is rendered inside the strip's problem popover in the result phase. `TimelineView` no longer
renders it, and gives up `deviceIds`/`onOverride`/`onExclude` with it: an unplaced clip has no
position, so it never had any business being the timeline's to draw, and a room whose timeline
fills the stage has no row under the timeline to put a red box in.

**One chip counts both lists.** `ScanManifest.unsynced` (the scan could not read it) and
`SyncResult.unsynced` (the engine would not place it) are different claims, but from where the
operator stands they are one question — *is anything wrong?* — and a chip that answered it only
for the pre-sync half would go quiet at the exact moment a run produced something to say. The
popover names the list once, at the top; the shelf's own `<h2>` is suppressed there (`heading`)
rather than saying «Ikke synkronisert» twice about one list.

### What is deferred, and why it is named here

The version of this the room actually wants is the unplaced clip **in its own device row**, at
the timeline's left edge, numbered — so "which of my six cameras is the problem" is answered by
looking at the row rather than by reading a list of filenames. That is a real piece of timeline
work (a lane that is not a time axis, hit-testing, the hop's arithmetic) and it is priced as
**R2c**. Until then the shelf is one click behind a chip that carries its own count, which is
the same standing the problem list has had since D-061 — folded, never hidden.

## D-083 — V06-R2b: the gutter is the device's HOME, and the frame starts at the top of the room

R1 built the room and R2a emptied the panel into it. What was left standing was a small stack
of lines **above the timeline's frame** that nothing had claimed yet: the zoom buttons, the
pre-sync legend, the off-session line, the meta sentence, and one amber banner per result
warning. Five different things, one on top of another, in a room whose whole promise (D-074)
is that nothing moves — and every one of them appeared or vanished with the phase, so the
frame's top edge was a few pixels lower before a sync than after it. `ett-rom.spec` said so
out loud in R1, as an honest deviation with a note that R2b would end it. This is that stage.

After it, `.timeline` contains exactly one child, `.timeline__frame`, and the frame starts at
the top of the stage in every phase. The spec no longer records a deviation; it asserts the
frame's box is the SAME box in `sources` and in `result`.

### Lanes are 40 px, and the row pitch is one number

`LANE_HEIGHT_PX` in `src/timeline/hop.ts` goes 34 → 40. Everything vertical follows from it:
`Track.tsx` writes it into the track's height and each lane's height, `clipBoxes` sums it,
`CLIP_HEIGHT_PX` derives from it and `useHop`'s ghosts are drawn at that size. The stylesheet
mirrors it in exactly one cosmetic place (`.lane__empty`'s `line-height`) and nowhere
load-bearing.

**No `min-height`, anywhere on that chain.** This is the one way the stage could have failed
silently. A two-line gutter is the obvious candidate for "just let it grow", and a lane the
browser grew to fit it would still be summed here at 40 — so the DOM's pitch and the hop's
pitch would disagree by a few pixels per track, and every clip below the first device would
fly, smoothly and confidently, to a row it is not in. Green tests, correct-looking
screenshot, wrong app: an R5-class seam. What holds instead is arithmetic on both sides, and
two new cases in `hop.test.ts` assert the arithmetic is the constant and nothing but the
constant — consecutive rows exactly `LANE_HEIGHT_PX` apart, and a two-lane track's second row
at exactly `trackTop + LANE_HEIGHT_PX`. Two lines at 13 px and 11 px measure ~36 px inside a
40 px lane, so nothing needs to grow.

`--tl-gutter` goes 12.5rem → 14rem and `--tl-ruler-h` 22 → 26 px, and both move from
`.timeline` up to `.app`. The gutter is a column of the ROOM now, not an implementation
detail of one component: anything that ever needs to align to it (the band, the slot) has to
be able to read its width without reaching into a descendant.

### Two lines: who, and where it stands

Line one is identity — icon, name, `badge--ref`, the mute/solo pair. Line two is
`t.fileCount(n)` · the summed length of the device's drawn spans · one dot.

Both are computed **inside `Track`**, from props it already had (`rows` for the count and the
lengths, `prewarm` and `placements` for the dot). No new props from App. A count App derived
and Track drew would be a second derivation of the same manifest, free to disagree with the
lane six pixels to its right.

The dot's three states are the clip vocabulary of D-080 one level up: **grey** while any file
on the row is not `ready`, **blue** once every file is, **green** once the sync has placed
them. `failed` counts as not-ready — the row is not analysed, and the file that failed says so
on its own clip. A row with nothing drawn on it gets **no dot at all**: §7.5 keeps a device
that placed nothing visible, its lane already says «Ingen klipp plassert», and a green
«plassert av synken» ten pixels away would be the app contradicting itself in one glance. An
absent dot is not a fourth state; it is the row having nothing to be in a state about.

The dot exists because the operator's question — *how far has this got?* — is a question about
a ROW, and at the owner's four-hundred-file wedding a clip is three pixels wide. The row is
the only object on screen with enough area to answer it from the other side of the room. It
carries `aria-label`/`title` (`trackAnalysing`/`trackAnalysed`/`trackPlaced`) so the claim is
never colour-only.

**Blue, not gold — a deliberate deviation from the canvas.** The design drew this dot gold.
Gold is `--accent`, and `badge--ref` is gold, and the badge sits on the line directly above
the dot, ten pixels away: one colour making two different claims about one device. The owner's
clip vocabulary is already grey → blue → green, and the dot is that vocabulary at row scale,
so blue is the colour that means what the dot means. **If this is vetoed it is a one-token
change**: `.track__dot--ready { background: var(--blue) }` → `var(--gold)` in `styles.css`,
and nothing else moves.

### The zoom moves into the ruler row's gutter cell

The `−` `+` `Fit` buttons were on the line above the frame. They are now in the ruler track's
gutter cell — the one cell in the whole frame that was empty, sitting directly above the
column they act on, on the row that already says what the horizontal axis means.
Right-aligned, 22 px, against the lane column's left edge, which is where the eye already is.
Same three accessible names, deliberately: the specs click them by name and so does the
operator's hand.

### The words go to the bottom slot, the warnings to the strip

`TimelineView` portals its own words into the slot through the same target `Transport` has
used since D-075, for the same reason: every one of them is built from a memo of this
component's, so lifting any of them to App would be a second place deriving the same thing.
The slot reads left → right: the transport (result) or the legend (pre-sync), the meta
sentence, then R2a's chips.

**The legend keeps its counts and folds its words.** «204 plassert · 163 anslått · 5
rekkefølge · 14 utenfor økta» is drawn; the full sentence is the element's `title`. The four
numbers ARE the claim (§7.3: they sum to the whole drop), and 38 px does not hold four clauses
beside a transport. The off-session line is the one note that keeps its whole sentence, because
what makes it actionable is the DATE it names (D-071) — it ellipsises rather than shortening.
The legend is `flex: 0 0 auto` and the meta sentence absorbs the squeeze instead: measured at
1024, a shrinkable legend was handed 40 px of the 62 it needs, and a legend clipped mid-number
has lost the only thing it was for. The meta can afford it — it carries its own `title`.

**The result's warnings become one chip on the strip**, `«N advarsler»`, opening R2a's popover
(D-078) with the sentences in full. They were one `banner--warn` per warning stacked above the
frame — the exact shape D-082 removed from the room everywhere else, still present here only
because nothing had yet moved the timeline's own header. A two-warning run pushed the frame
down by two lines in the same instant the clips hopped. The chip sits beside the problem chip,
because «er noe galt?» is one question and it should be asked in one place, and it is absent
when there are none: a permanent «0 advarsler» is a line read past on every clean run. App
renders a second portal target (`.strip__status`) for it, on the same terms as `slotEl`.

### What the playback quality note cost, and why the trade was taken

`t.playbackQualityNote` — "audio for checking sync (12 kHz analysis audio), not export
quality" — was a visible caption on the transport. It is the transport's `title` now.

This was measured, not guessed. With the meta sentence in the slot's middle, at **1280×800**
the slot is exactly full (980 px of content in 980 px) and the note was already being clipped
from 413 px of text into a 374 px box; at **1024×600** the slot overflowed its own 724 px by
38. A sentence cut off mid-word is not a sentence anybody reads, and a slot that overflows is
the room breaking its one promise. With the note on the `title`, the result slot measures 724
of 724 at 1024 with the transport, the meta and the chips all at their natural widths.

The loss is real and worth naming: the sentence is expectation-setting, and expectation-setting
only works if it is read *before* the operator presses play. On the bar's `title` it is one
hover away, over the very control that raises the question — which is the best available
placement in 38 px, not an equal substitute. If the room ever gains a line for it, it should
come back. `playback.spec` asserts the attribute now instead of the visible text.

### Specs

Re-expressed, never deleted (D-085). `ett-rom.spec` gains the two gutter lines, the dot's
grey → blue → green transition driven by per-file `prewarm:file` events, the zoom buttons'
boxes inside the ruler's gutter column, the warnings chip, and the frame-y identity that
replaces R1's noted deviation. `presync-timeline.spec` asserts the legend's counts AND its
`title` — the parent claim survives in full, one attribute away — and the meta sentence by its
`title`, which is the reading a window width cannot defeat. `hop.test.ts` gains the two pitch
cases above.

## D-084 — V06-R3: the zoom floor halves, because «Tilpass» could not fit the owner's own wedding

`MIN_PX_PER_MS` in `src/timeline/geometry.ts` goes **2e-5 → 1e-5**, and everything else in this
entry is why that number and not another.

### What the old floor could not show

At 1280×800 the lane the timeline actually has is the window less the 300 px inspector, the
224 px gutter and the frame's own chrome — **736 px**, measured off the boxes the browser draws,
not derived. At 2e-5 that is 10.2 hours. The owner's real wedding runs **15.5 hours**, from the
hairdresser in the morning to the last dance after midnight, and v0.5 measured the consequence
exactly: at Fit, **40 of 386 clips** (25 Fuji, 15 AVCHD) sat past the right edge, and pressing Fit
again changed nothing because Fit was already at the floor. Nothing was lost — the scrollbar and
panning reach them — but the one gesture whose entire job is «vis meg alt» silently stopped
meaning it, with nothing on screen saying so. It was v0.5's highest-value open item.

1e-5 across the same 736 px is 20.4 h, and `fitPxPerMs` leaves `FIT_PADDING_PX` to spare, so
«Tilpass» reaches **~19.8 h**. A wedding fits with a night's margin.

### What halving it costs, measured rather than assumed

Two things could have been damaged, and both were checked at the floor rather than reasoned about.

**The waveform ladder.** `peaks.rs` runs 13 levels to a coarsest bin of 40.96 s. At 2e-5 that bin
was 0.82 px wide — 1.22 bins per pixel, comfortably under `MAX_BINS_PER_PX`. At 1e-5 it is 0.41 px:
**2.44 bins per pixel**, just over the ceiling instead of just under it. So the coarsest rung is
still the one chosen (there is nothing coarser), and `barGeometry`'s stride cap — which exists for
exactly this, and was written for finding 11 — groups **2 bins into one bar** at dpr 1 and none at
all at dpr 2, where the panel really can resolve the extra detail. `xs` stays bounded at a couple
of entries per device pixel; the thing finding 11 was about (a 4000-element array per clip per
frame, ~19.5 bins per pixel) is still two orders of magnitude away.

`waveformDraw.test.ts`'s floor case is **re-expressed, not deleted** (D-085): it asserted
`1 / pxPerBin <= MAX_BINS_PER_PX`, which was the mechanism; what it was *about* is the size of the
number, so it now pins the coarsest level being chosen and the ratio staying under 4. A new case
runs `barGeometry` at exactly `MIN_PX_PER_MS` over the shipped ladder and pins the stride at 2 (dpr
1) and 1 (dpr 2), with the bars still abutting — the property a naive stride breaks first.

**In practice almost nothing draws a waveform down there anyway.** `MIN_WAVEFORM_PX` is 24 px
(D-072), which at 1e-5 is a clip of **40 minutes**. On the owner's corpus that is the mixer's three
files and nothing else.

### Asserted where it will actually be read

- `viewport.test.ts` — a 16-hour span in a 736 px lane fits **without clamping**, and the floor's
  reach is stated in the unit the decision was made in (hours). It fails at 2e-5.
- `timeline-scale.spec.ts` — a **16-hour, 18-clip, 3-device result at the real 1280×800 window**,
  Fit pressed by its own button, by name. Every clip mounted (18 of 18), the rightmost clip's right
  edge inside the lane, and the zoom that produced it off the floor — all read off the boxes the
  browser drew, never off component state. Before the change it failed with the last clip's right
  edge at 1390 px in a lane ending at 967.

### The one thing that still clamps, written down rather than left implicit

`PLAUSIBLE_SPREAD_MS` (`recordingTime.ts`) admits **24 hours** as one session, and the floor reaches
~20. A genuine dusk-to-dusk drop is therefore laid out correctly and cannot be seen all at once, and
a narrower window reaches less (~13 h at 1024×600). Halving the floor again to close that gap would
put every clip under half a pyramid bin and buy an hour of material nobody has yet dropped;
KNOWN_LIMITATIONS.md carries the shape instead.

## D-085 — the spec-migration rule, as applied across V06-R1 → R3

The v0.6 redesign moved almost every control in the app and deleted one whole component, against a
Playwright suite of ~180 journeys that were written about the old shape. The rule that governed
every one of those edits, stated once here because it is the thing that made the redesign
reviewable:

> **A spec is re-expressed, never deleted.** When the shell changes, find the RULE the assertion
> was making, and assert it against the new mechanism. If the rule genuinely no longer exists, say
> so in a decision — do not quietly drop the test.

The distinction it turns on is **rule versus mechanism**. `max-height ≤ 60vh` was never the rule;
"the tracks cannot push the sync button off the screen" was, and the shell replaced a `vh` guess
with a definite height, so the assertion became "at a cruel 400 px the tracks overflow, scroll, and
end above the slot". A test that pins the mechanism is a test that has to be rewritten every time
the mechanism improves — which is exactly the moment a suite starts being deleted instead.

### What it cost, stage by stage

| Stage | Specs touched | What changed in them |
|---|---|---|
| **R1** (the shell) | 4 edits, 150 specs untouched | `preview.spec` (the panel's 180 px was the mechanism; the timeline's box, the gutter and the column's width are the rule) · `presync-timeline.spec` (60vh → a definite height) · `timeline.spec` (finding 13's "the page scrolled" is unobservable in a room that does not scroll; `defaultPrevented === false` and "the timeline does not pan" are asserted directly) · `override-stale.spec` (the `resyncHint` is the button's `title`) |
| **R2a** (the panel is redistributed) | 2 rewritten, 7 edited | `sources.spec` → `kilder.spec`, `removal.spec` → `inspector-actions.spec` — every claim the two made re-expressed against the popover and the inspector's action row, none dropped |
| **R2b** (the gutter is the device's home) | `ett-rom`, `presync-timeline`, `playback`, `hop.test` | the two gutter lines, the dot's grey → blue → green, the zoom buttons' boxes in the ruler's gutter cell, the warnings chip, and the frame-y identity that replaced R1's noted deviation; the legend asserted by its counts AND its `title`; `playbackQualityNote` asserted as an attribute |
| **R3** (finpuss) | `waveformDraw.test`, `timeline.spec` | the zoom floor's bins/px bound (mechanism → the size of the number, D-084) · the ruler's `HH:MM:SS.mmm` shape (mechanism → "a tick reads as a timecode, at the precision its spacing can resolve") |

**Nothing in that table is a deletion.** The two rewritten files are the only places where the
*subject* of a spec stopped existing, and both were rewritten claim for claim rather than replaced.

### The locator table, final state

Where the fourteen affordances of the old `SourcesPanel` are asserted from, after R3. The handles in
the left column are what the specs and the operator's muscle memory both reach for, and they did not
change even though everything behind them did — which is the point.

| Handle | Resolves to | Asserted in |
|---|---|---|
| `region(sourcesTitle)` | the strip's sources cluster | `kilder.spec`, `ett-rom.spec`, `timeline-scale.spec` |
| `.popover--sources > summary` | the summary line, which IS the «Kilder» disclosure | `kilder.spec`, `ett-rom.spec` |
| `.popover--problems > summary` | the problem chip (scan + engine, one count) | `kilder.spec`, `ett-rom.spec`, `timeline-scale.spec` |
| `.popover--warnings > summary` | the result's «N advarsler», portalled into `.strip__status` | `ett-rom.spec` |
| `.slot__removed` / `.slot__skipped` | «Fjernet (N)» / the skipped chip | `ett-rom.spec`, `inspector-actions.spec` |
| `.slot__auto` | «Referanse velges automatisk …» | `presync-timeline.spec` |
| `.inspector__actions .refbtn` | ★ reference, one per marked clip | `inspector-actions.spec` |
| `.inspector__actions select` | device override, one per marked clip | `inspector-actions.spec`, `override-stale.spec` |
| `.inspector__actions .removebtn` | ✕ remove, one per marked clip | `inspector-actions.spec` |
| `.shelf__row` | one unplaced file, inside the problem popover | `timeline-scale.spec`, `kilder.spec` |
| `.preview__name` / `.preview__frame` | the inspector's name and 268×151 still | `preview.spec`, `ett-rom.spec` |
| `.slot__transport` | the transport (result) or the legend (pre-sync) | `playback.spec`, `presync-timeline.spec` |
| `.timeline__note` | the legend's counts; the whole sentence on its `title` | `presync-timeline.spec` |
| `.track__gutter` / `.track__dot` | the device's home, and how far its row has got | `ett-rom.spec` |
| `.band` | the one permitted motion, 34 px | `ett-rom.spec` |
| `.timeline__zoom` | − + Tilpass, in the ruler row's gutter cell | `ett-rom.spec`, `timeline-scale.spec` |

## D-088 — V06-R3: what a row gives up first, and a banner that floats must be opaque and inert

The pixel pass rendered the real app in Playwright at 1280×800 and 1024×600 in each of the five
states and compared them with the owner-approved canvas. Most of what it found was one bug wearing
four hats, and the rest was the export receipt.

### A flex row that runs out of room must state its PRIORITY, not an absolute

The strip and the slot are each one line of flex carrying more than they have room for at 1024. Both
had the same shape of failure, and it is a shape worth naming because it is invisible until the
window is narrow and then it is the ugliest thing on screen: **a rigid item inside a container that
is not rigid overflows it and is painted across whatever is next to it.**

- the strip's problem and warnings chips were `flex: 0 0 auto` inside a cluster that shrinks — at
  1024 in the exported phase (which is precisely when the strip has the most to carry, because «Vis
  i Finder» is on it too) they were drawn under the project-name field;
- the slot's footnote chips were the same, and «1 stillbilde ble hoppet over» covered the first four
  words of «Kildene er endret siden forrige synkronisering»;
- the transport was the mirror image — `flex-shrink: 1` on a box whose children cannot shrink, so at
  1024 with a stale notice in the row the meta sentence was drawn across the volume slider;
- and `.slot__chips` and `.slot__stale` both carried `margin-left: auto`, which does not stack two
  items at the end of a row: it **splits the free space between them**, so the chips floated in the
  middle and the notice sat between them and the edge.

`flex: 0 0 auto` was an attempt to say "this matters more than the sentence beside it", and it is
the right priority stated in a way that has no answer for the case where there is not enough room
for anybody. The priority is stated as a **shrink factor** instead: `flex: 0 200 auto` on the
summary line against `1` on the chips distributes a deficit in proportion to `factor × basis`, so
the sentence gives up essentially all of it — down to nothing if it has to — before either chip
loses a character, *and* the chips still shrink rather than overflow once the sentence has nothing
left. Floors of `2rem` on the chips, because `.chip`'s own padding means a `<summary>` cannot draw
itself narrower than 26 px however hard its `<details>` is squeezed.

Two details that cost real time and are worth writing down:

- **The warnings chip is portalled into `.strip__status` (D-083), so the SPAN is the flex item the
  strip sizes, not the chip.** Styling `.popover--warnings` did nothing until the span was styled
  too. A portal moves the pixels and leaves the box model behind.
- **A bare text node inside an `inline-flex` is an anonymous flex item and cannot carry
  `text-overflow`.** A squeezed chip therefore *wrapped to two lines* — in a 44 px strip, a chip
  taller than the row it sits in. Forcing `display: block` fixed the wrap and introduced a subtler
  one: `clientWidth` rounds a 107.3 px box down to 107, so a chip that fitted exactly got an
  ellipsis. The answer is a real element: every chip's words live in a `.chip__text` span, which is
  a proper flex item, shrinks to the sub-pixel, and ellipsises only when it is actually short.

Everything that can ellipsise now carries its whole self as a `title` — the chips, the summary line,
the stale notice — which is D-083's rule for the legend applied to every other claim in the two
rows. And the invariant is asserted rather than eyeballed: `ett-rom.spec` walks the children of the
strip, the sources cluster and the slot in the busiest state the app can reach (a stale, exported
result with problems, warnings and a skipped file) at **both** window sizes, and requires each
child's left edge to be at or past the previous child's right edge. It fails at 1024 against the
old CSS.

### A banner that floats over the room must be opaque, and must not eat it

D-082 moved banners into a `.toasts` layer over the stage and turned pointer events off **on the
layer** so a transparent rectangle could not eat a click. Both halves of that were half right.

- `--green-bg` and its siblings are **10 %-alpha washes**. Correct for a banner in a page's flow;
  unreadable over a timeline, because what is behind a toast is not the page background but a row of
  clips showing straight through the sentence. The export receipt — the longest thing this app ever
  says, three lines across the top two device rows — is where it shows first. The tint is now
  painted as a background *image* over an opaque `--surface2`, so each class still chooses its own
  colour and only the ground beneath it changed.
- The banner itself kept `pointer-events: auto`, and a three-line rectangle over two device rows
  **swallowed every press on the clips underneath** until it was dismissed. Found by a spec that
  tried to click a clip after an export and was told, fifty-five times, that a `<span>` was in the
  way. The banner is inert now; its ✕ turns pointer events back on for itself.
- It also stopped stretching to the width of the room (`max-width: 44rem`): a paragraph across a
  956 px stage reads as a page, not as a remark.

### The primary action is the LAST control before the gear

D-081 promised one primary action always in the same place. It was not: «Vis i Finder» appeared to
the *right* of the gold button the instant an export succeeded, and slid it 110 px to the left in
that same instant — the one control the operator's hand has learned, moving under it exactly when
they were about to reach for it again. The approved canvas draws the secondaries first and the gold
one last before the gear, which is also the only order in which the promise holds: pinned by the
strip's own padding, with a label that never changes, nothing appearing to its left can move it.

### The ruler stops saying `.000`, and stops being cut off

At the zoom a whole shoot is read at, `tickIntervalMs` picks one tick per hour and every label ended
in the same `.000` — four characters of nothing repeated across the ruler, on the one row where a
label's width decides whether the rightmost one can be drawn at all. `tickLabel(ms, intervalMs)`
drops the milliseconds exactly when a tick is a whole second or more apart, because that is when no
two ticks could differ in them. And a label that would not fit inside the lane is dropped while its
LINE is kept — a ruler is its lines; «6:00:0» is not a number.

### Two things the sweep found that were not pixels

- **Two popovers could be open at once.** The pointer case was covered by construction (pressing a
  second summary is a press outside the first), the keyboard case was not — and the four summaries
  are tab stops precisely so they can be used that way, which is D-078's whole argument for
  `<details>`. `usePopoverDismiss` gains a capture-phase `toggle` listener: another `.popover`
  opening closes this one. It reacts to the element's own state rather than to what opened it, so it
  covers every way a `<details>` can be opened, including ones nobody has thought of yet.
- **The gutter's dot went on saying «Analyserer lyden» about a row whose pass had ended.** D-083
  folded `failed` into `pending`, which is right about the COLOUR — the vocabulary is grey → blue →
  green and a fourth would make it four — and wrong about the WORDS: a card the analysis finished
  with and could not read will never turn blue, and a dot claiming to still be working on it is the
  app waiting for something that already happened. A row where nothing is still pending and
  something failed keeps the same grey and says **«Lyden er ikke analysert»** instead — the register
  the clip itself already uses for that state («Bølgeform utilgjengelig»): a statement about what
  the app has, not a verdict on the card.

### What was NOT changed, and why

Everything here was a deviation from the approved canvas; these are the ones left standing, each
with the reason, because "we compared them and fixed what was off" is worth nothing without the list
of what was off and stayed off.

| Canvas | The app | Why it stayed |
|---|---|---|
| wordmark at 20 px | 16 px | 24 px of the one part of the strip that is already crushed at 1024. Cosmetic, and the cheaper half of a trade the strip cannot currently afford. |
| gold primary ~43 px tall in a 44 px strip | 30 px | 43 px leaves no ground above or below it; the conductor's brief specifies 30 and the strip reads as a strip at 30. |
| 200 px gutter | 224 px | D-083 widened it deliberately for the second line's «3 filer · 1 t 42 min ●». |
| section labels «ENHETER» / «INSPEKTØR» | absent | new markup, not CSS. Named for a follow-up. |
| an empty 276×155 frame placeholder in the inspector | «Velg et klipp for å se det.» centred | same: new markup. The brief's own description of the approved design is the sentence. |
| a full-bleed dashed drop panel filling the stage | a centred card, with the flow hint and explainer below it | `EmptyState` is three stacked things, not one; making the zone fill the stage is a restructure of the component, not a spacing change. |
| device lanes filling the stage (~90 px each) | 40 px lanes, leaving the lower half of the stage empty on a seven-device drop | `LANE_HEIGHT_PX` is load-bearing arithmetic shared with the hop (D-083's "no `min-height`, anywhere on that chain"). Changing the row pitch at a polish gate is exactly the R5-class seam that note exists to prevent. |
| the export hint as one quiet line in the strip | a three-line paragraph in a toast | the words are the owner's instruction copy in two languages and a spec asserts them; shortening them is a content decision, not a pixel one. The toast is legible now — that was the actual defect. |

**What could not be observed.** Playwright at the window size is the instrument here, and it is not
the app. The native window was never driven: no WKWebView rendering, no real macOS font
rasterisation, no titlebar, no display scaling other than dpr 1, and no live drag, hover or focus
ring under a real hand. Everything above is true of the DOM at 1280×800 and 1024×600 in Chromium.
The owner's sign-off on the six screenshots is what closes that gap, and the rig test after it.
