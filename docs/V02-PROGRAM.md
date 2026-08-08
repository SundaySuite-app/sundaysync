# SundaySync v0.2 Program — "Solid in Use"

> Multi-week quality program taking SundaySync from a working v0.1 test build to a
> self-contained, self-updating, observable v0.2. Modelled on SundayRec's
> kvalitetsprogram (started 2026-08-06), reusing its infrastructure and its lessons.
> **Owner:** Richard. **Conductor:** Fable orchestrates every stage; Opus executes the
> heavy work (architecture, Rust, DSP, security), Sonnet the mechanical work (i18n,
> docs, schema boilerplate, test scaffolds). One stage = one session/night; the owner
> says **"kjør etappe N"**. Pace ~2–3 stages/week → **5–6 weeks**.

## Operating rules

1. Every stage ends with: full gates green (fmt, clippy `-D warnings`, `cargo test`
   under BOTH PATH variants per D-025, tsc, vitest, vite build) → PR → CI green →
   merge → stage report appended to this file → memory updated.
2. §13.2 stands: accuracy gates are never weakened to pass. New capabilities get new
   gates, asserted where the measurement is meaningful (the D-019 rule).
3. §5 `SyncResult` schema changes remain irreversible-class decisions; anything touching
   it goes to the owner first.
4. Max 2–3 parallel Opus agents; content-heavy agents write incrementally
   (SundaySchool lesson). Telemetry payload changes ALWAYS deploy Worker-side first
   with fields optional, client second (SundayRec schema-rollout rule) — and every
   free-text limit gets a test spanning both repos (the 08-08 ellipsis lesson).
5. Owner decisions are surfaced at the START of the stage that needs them, listed
   per stage below. Nothing blocks silently.

## Locked owner choices (2026-08-08)

- **Drift correction ships in v0.2** (own stage, E6) — resolves D-016 properly.
- **Telemetry:** shared `sunday-telemetry` Worker/D1, app dimension + own sundaysync
  schema. Fully anonymous (random install-id, deletion by id, never person/church
  linkage), consent at first launch + settings toggle, 90 d raw retention, EU (WEUR).
  Same privacy posture as SundayRec's locked choices.
- **Updater:** same `updates.sundaysuite.app` Worker, new app-scoped rings
  `/v1/update/sundaysync/{stable,beta}`. Kill-switch + promotion flow reused as-is.
- **Corpus:** owner supplies 1–3 real services during the program → corpus-gated
  stages (E10) sit late.

## Why v0.2 exists (what v0.1 taught us)

The v0.1.0 test build surfaced the exact problem this program opens with: **the release
app reports "ffmpeg ble ikke funnet" on a machine where ffmpeg IS installed.** macOS
gives GUI apps a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) without
`/opt/homebrew/bin`; the dev build worked only because `tauri dev` inherited the
terminal's PATH. Diagnosis first confirmed on the owner's own machine, 2026-08-08.
Bundling ffmpeg (E1) fixes the bug and removes the last manual installation step in one
move.

---

## Stages

### E1 — Self-contained install (bundled ffmpeg) 🔜 first

The user's top ask: download → open → works. Nothing to install by hand.

- **Hotfix first (`v0.1.2`, shippable same session):** `Sidecar::from_path` falls back
  to the common GUI-invisible locations (`/opt/homebrew/bin`, `/usr/local/bin`,
  `/opt/local/bin`) before giving up. Ten lines; unblocks current testers immediately.
- Port SundayRec's `scripts/fetch-ffmpeg.mjs` (SHA-256-pinned static ffmpeg+ffprobe
  from martin-riedl.de / gyan.dev, per-target-triple naming) → `app/src-tauri/binaries/`,
  `externalBin` in tauri.conf. GPL build → ship the license notices the same way
  SundayRec's DISTRIBUTION.md does.
- Engine: `Sidecar` gains an explicit resolution order — **bundled sidecar path
  (from the Tauri shell) → PATH → GUI-fallback dirs**. The shell resolves the bundled
  path via Tauri's resource API and passes it down; the engine stays Tauri-free
  (thin-shell rule D-023). CLI keeps PATH resolution.
- Onboarding step 3 becomes a green confirmation ("alt innebygd — ingenting å
  installere") with the check retained as a self-test; the brew instruction survives
  only as the fallback text if the bundled binary is somehow missing/damaged.
- CI: release.yml fetches sidecars per platform; the D-005 skip-guard logic in tests
  must now also cover "bundled but PATH empty".
- **Gates:** installer size budget re-checked (§10 says < 40 MB *excluding* ffmpeg —
  document the new with-ffmpeg number honestly); fresh-VM-style launch test: rename
  /opt/homebrew/bin/ffmpeg away and verify the app still syncs.

### E2 — Mapping (the "full gjennomgang" baseline)

Three Explore agents in parallel, exactly like SundayRec's kartlegging:

1. **Security top-10** — threat-model the real surfaces: arbitrary-tree scan walk
   (symlinks, device files, network mounts), ffprobe/ffmpeg argument injection via
   filenames, FCPXML output escaping (verify the 5-char escaper against adversarial
   names), `tauri.conf.json` `"csp": null` (a real finding already), capability
   over-grant, `scan_inputs`/`run_sync` invoked with hostile paths, dependency tree.
2. **Stability/QA top-10** — panic surface outside core, error-path coverage, races
   (scan superseding sync? double cancel? two app instances sharing one cache dir),
   what happens at 0 files/1 file/10 000 files, unicode/long paths, disk-full during
   cache write and export.
3. **Backend/perf top-10** — profile a synthetic 3 h reference (the known ~160
   blocks/segment correlation scaling), probe serialisation, memory ceiling reality
   vs §7.7's 4 GB promise, cache growth (D-013), progress gaps (Placing/MeasuringDrift
   never tick, pass 2 silent).

Output: prioritised backlog written into this file under E3–E5; anything
severity-critical gets pulled into its stage as the first item.

### E3 — Security hardening

From E2's list plus the already-known:

- Real CSP in tauri.conf (no `null`), capability re-audit (drop anything unused).
- Path handling: symlink policy made explicit and tested; refuse to walk into
  device/special files; scan depth/width limits documented as limits.
- Fuzzing: `cargo-fuzz` targets for `probe::from_json`, `parse_iso8601_epoch`,
  `Rational::parse` and the WAV-fixture reader — parsers fed by untrusted files are
  exactly where fuzzing pays. Corpus of mangled media checked into `fixtures/hostile/`
  (tiny, committed).
- FCPXML injection test: filenames like `"/x/<script>&' .mp4` must produce valid,
  correctly-escaped XML that Resolve still imports (extend `resolve-verify.py`).
- `cargo audit` in CI already; add `cargo deny` (licenses + duplicate deps + advisories)
  and pin the GitHub Actions by SHA.
- `SECURITY.md` via GitHub advisories (no published e-mail — SundayRec E1 pattern).
- **Owner decision in this stage:** none expected.

### E4 — Engine stability

- Adversarial media suite: truncated mid-atom MP4s, zero-length streams, 8-hour WAV
  headers with 2 s of data, wrong-extension files, exotic sample rates (8 k/96 k/192 k),
  mono/5.1/7.1 channel layouts. Every one must land in a §5 bucket, never panic, never
  hang past its timeout.
- §7.7 proven, not promised: a 20 h / 200-file synthetic day generated by fixturegen,
  run under RSS measurement; gate at < 4 GB. (Generation is cheap: fixturegen writes
  WAV fast; use mostly-WAV for the bulk.)
- Cancellation storm test: cancel fired at random points ×100 runs — no leaks, no
  cache corruption (tmp-file census after each), §7.4's 2 s bound asserted.
- Two-instance concurrency: two engines sharing one cache dir simultaneously — the
  write-then-rename design should make this safe; prove it.
- proptest expansion: device-override maps as a generated input against the §7.3
  invariant; hostile path strings through the scan collect/dedup logic.

### E5 — Performance at real scale

- **Correlation scaling** (the known §10 risk): decimated coarse search (e.g. 1.5 kHz)
  over the full reference → narrow full-rate refine window. Gate: synthetic 3 h
  reference, 20 clips, correlation phase under a measured budget on this machine —
  AND bit-identical placements vs. the exhaustive path on the whole accuracy suite
  (determinism §13.4 makes this checkable). If exact equality proves impossible,
  equal-within-±1-sample plus D-entry; never silently different.
- Parallel probing on the extract worker pool (Phase 1 leftover).
- Progress completeness: `Placing` ticks per candidate, pass-2 `Correlating` ticks,
  `MeasuringDrift` actually emitted; scan walk emits per-directory. The CLI's verbose
  output and the UI both benefit; `Progress` is not §5-frozen.
- **Cache eviction (D-013 closes here).** Proposal to owner at stage start:
  age-based sweep (delete entries untouched > 90 days) on app start + a size cap
  setting (default off) in Settings; "Tøm buffer" stays. Numbers shown honestly.
- Re-run §10 gates and publish the measured table in STATUS.

### E6 — Drift correction (the v2 headline, pulled into v0.2)

Resolves D-016. Design question first, implementation second — Opus runs a
spike against real DaVinci Resolve before any engine code:

- **Spike:** can Resolve's FCPXML importer honour a per-clip rate conform/timeMap
  such that a drifting clip stays aligned end-to-end? Extend `scripts/resolve-verify.py`
  to measure alignment at clip START and END (import → read both edges). Three
  candidate mechanisms, in preference order:
  1. FCPXML `conform-rate`/timeMap on the asset-clip (no media touched — best fit for
     the product's "never render" stance),
  2. start-aligned placement + documented residual (fallback; a §4.3 plan change),
  3. optional rendered corrected-audio sidecar per clip (§12's PluralEyes model —
     only if 1 fails; breaks "no rendered media" so needs explicit owner sign-off).
- Implementation per spike outcome; **toggleable** (§12: "toggleable like
  PluralEyes 4.1"), default ON when drift > half a frame is measured.
- Gates: the full-tier drift suite gains END-of-clip assertions — a 40 ppm / 400 s
  clip must land within ±10 ms at BOTH ends, which v0.1 mathematically cannot do.
  Sign convention D-019 (resample by `1/(1+ppm·1e-6)`) pinned by a test.
- D-016 gets its closing entry; KNOWN_LIMITATIONS drops its biggest caveat.
- **Owner decision in this stage:** mechanism sign-off after the spike report
  (especially if outcome 3 is the only one that works).

### E7 — Consent + telemetry client

Mirror of SundayRec E3, adapted:

- Consent card at first launch (new onboarding step 4) + Settings toggle; consent is
  `Option<ConsentRecord>` with a **versioned** consent text from day one (SundayRec's
  v2 lesson: bumping the version re-asks everyone; "no" on v1 can never become "yes"
  on v2 silently).
- Anonymous random install-id; deletion by id; NEVER filenames, paths, device labels
  or anything derived from media content in any payload.
- Crash capture: Rust panic-hook writing a scrubbed ring (à la SundayRec's 20-crash
  ring, paths scrubbed), plus frontend `window.onerror`/unhandledrejection capture
  into the same outbox. Free-text limits get the both-repos truncation test.
- Quality/usage payload (all classified, all anonymous): app+engine version, OS/arch,
  synced-shoot shape (file count, device count, total duration BUCKETED, codec set),
  outcome (placed/unsynced histogram by reason), PSR distribution buckets, cache
  hit-rate, run duration buckets, drift-correction engaged y/n, error/crash class.
- Outbox: 50 entries, drop-oldest, send on launch + post-sync; a 400 response is
  logged locally with reason (not silently dropped — learn from the ellipsis bug).
- **Owner decision in this stage:** consent text approval (written so later
  aggregates are already covered — SundayRec rule) + behandlingsansvarlig line.

### E8 — Telemetry Worker side (sunday-telemetry repo)

- App dimension in the Worker: sundaysync validator + D1 tables (columns, not JSON —
  the SundayRec E4 choice), shared purge job extended, deletion-by-id covers both apps.
- **Deploy order enforced:** Worker accepts the new app/fields as OPTIONAL first,
  deployed and live-verified; only then does the E7 client release reference it.
- Cross-repo test suite: sundaysync payload fixtures validated against the real
  Worker validator in `sunday-telemetry/test/` (the boundary-crossing tests that were
  missing when the ellipsis bug shipped).
- Admin queries (`queries.sql`) extended with sundaysync views.

### E9 — Updater + beta ring

- `tauri-plugin-updater` in the app; updater signing keypair generated
  (`tauri signer generate`), private key → `gh secret set` on the repo, pubkey into
  tauri.conf. (Independent of Apple signing — works today; Apple
  notarization remains a separate owner item as on SundayRec.)
- Endpoints: `plugins.updater.endpoints = ["https://updates.sundaysuite.app/v1/update/sundaysync/stable"]`;
  beta toggle in Settings → System swaps to `/beta` (and is the natural place the
  E7 consent-ask can be re-surfaced, mirroring SundayRec).
- Worker: app-scoped ring tables + migration in sunday-telemetry repo; 204=paused,
  404=unknown ring, no GitHub fallback (kill-switch stays meaningful). Promotion
  flow reused.
- release.yml: `createUpdaterArtifacts`, **`uploadUpdaterJson`** (the input
  tauri-action actually has), **NSIS-only bundling on `-beta.` tags** (MSI cannot
  express prerelease versions — learned 08-08 the hard way), updater env secrets.
- **Kill-switch drill** against the real published manifest before the stage closes
  (SundayRec's 08-07 exercise, repeated for the new app id): promote → byte-identical
  200, pause → 204 within 60 s, resume → same bytes, other app's rings untouched.
- No version/OS leakage on update checks (no `{{current_version}}` in the URL —
  SundayRec's privacy stance).

### E10 — QA foundation + real corpus

- Playwright harness on SundayRec's E5 pattern (`__TAURI_INTERNALS__` shim; ~20–30
  specs): onboarding flow, drop→scan→sources, override + stale marking, sync
  progress + cancel-as-notice, export flow, settings persistence, consent toggle.
- Visual click-through with computer-use if the owner has granted screen recording
  by then; otherwise the Playwright layer carries it.
- **Corpus onboarding** (owner delivers 1–3 services): freeze truth via
  `resolve-verify.py`-assisted manual check (§8.3 ritual), run `sundaysync bench`,
  then: MIN_PSR re-validation on real rooms (D-015's open caveat), performance
  numbers on a real 1.5–3 h reference (validates E5), drift correction on real
  camera clocks (validates E6), GoPro `.LRV` decision with real files (D-009).
- Gates: §8.2 on the corpus with zero false placements — release blocker per §8.3.

### E11 — v0.2.0-beta.1 → stable

- Version bump (three files), CHANGELOG, `v0.2.0-beta.1` tag → prerelease → promote
  to the sundaysync **beta** ring; owner runs it for real on his machine (the ring's
  only member initially, like SundayRec).
- Owner test checklist (written in the stage): fresh-download install with NO
  ffmpeg present, full sync of a real shoot, drift-corrected export into Resolve,
  updater self-update beta→beta, consent flows, cache clear.
- Findings → patch releases on the beta ring until clean → promote `v0.2.0` to
  stable ring. STATUS/KNOWN_LIMITATIONS rewritten to match reality.

### E12 — Continuous operations

Joins SundayRec's E11 monthly cadence (one shared session covers both apps):
dependency + advisory review, telemetry/crash triage → backlog, ring health,
cache/telemetry retention verification, UNVERIFIED-list burn-down.

---

## Stage status

- [x] Program planned, owner choices locked — 2026-08-08
- [ ] E1 Self-contained install (+ v0.1.2 PATH hotfix)
- [ ] E2 Mapping (3 explorers)
- [ ] E3 Security hardening
- [ ] E4 Engine stability
- [ ] E5 Performance at scale (+ D-013 eviction decision)
- [ ] E6 Drift correction (+ D-016 closure; owner sign-off on mechanism)
- [ ] E7 Consent + telemetry client (+ owner: consent text)
- [ ] E8 Telemetry Worker side
- [ ] E9 Updater + beta ring (+ kill-switch drill)
- [ ] E10 QA foundation + real corpus (owner delivers footage)
- [ ] E11 v0.2.0-beta.1 → stable (owner test checklist)
- [ ] E12 Continuous operations (recurring)

## Standing owner items (asked at the marked stages, never silently)

E5: cache-eviction shape · E6: correction mechanism after spike · E7: consent text +
behandlingsansvarlig · E10: corpus delivery + truth sign-off · E11: beta validation
on real hardware. Apple signing/notarization stays a separate suite-level item
(team 784GN847G4) — v0.2 ships with the same right-click-to-open caveat unless that
lands in the meantime.
