# Security Policy

SundaySync is a Tauri 2 desktop app that syncs multicamera audio locally and
exports a timeline for DaVinci Resolve. This document explains how to report
a vulnerability, what's supported, and the threat model the app's controls
are designed against.

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue:

Use this repository's Security tab → "Report a vulnerability" (GitHub
private security advisories:
https://github.com/SundaySuite-app/sundaysync/security/advisories/new). That
opens a private discussion with the maintainer before anything is public,
and it is the only reporting channel — there is no security mailing address.
If you cannot use advisories, open a regular issue asking for contact
**without** describing the vulnerability, and the maintainer will follow up
privately.

Please include what you found, the affected version, and reproduction steps.
This is a small, single-maintainer project — expect an initial response
within a few days, not an SLA.

## Supported versions

Only the **latest release** is supported. There is no LTS branch and no
backporting of fixes to older versions. Please update before reporting an
issue that may already be fixed. (An auto-updater on a signed release
channel is planned — see `docs/V02-PROGRAM.md` E9 — but is not shipped yet;
until then, updating means downloading the latest release manually.)

## Threat model

SundaySync runs **entirely locally** — no cloud, no accounts, no telemetry
in v1 (anonymous, consent-gated telemetry is planned for v2, see
`docs/V02-PROGRAM.md` E7/E8, and will get its own privacy note when it
ships). The app's job is to take a folder of media from a multicamera
shoot — files whose names, containers and internal structure are entirely
outside its control — and turn them into a synchronized timeline. Trust
boundaries the app has to defend at:

- **Untrusted media files and their filenames.** Every input is a file the
  operator dropped in or pointed the scan at: camera clips, a mixer/recorder
  feed, whole folders. Filenames, container metadata and file content are
  all attacker-controllable in principle (a malicious file handed to someone
  running a sync, a booby-trapped download, a crafted USB card) even though
  the realistic threat is closer to "a weird file confuses the pipeline"
  than "someone is actively attacking a church volunteer's laptop.
- **The bundled ffmpeg/ffprobe sidecars.** The engine shells out to ffmpeg
  for every probe and every audio extraction (`crates/core/src/probe.rs`,
  `extract.rs`). These are real subprocess invocations against
  attacker-influenced arguments (the file path) and attacker-influenced
  *content* (ffprobe/ffmpeg parse the container and, for playlist/concat
  formats, can be induced to fetch or read other locations if not
  constrained) — this is the "passive input becomes an active attack
  surface" class of bug, and the one this app's explicit job (accept any
  media file) makes unavoidable to think about.
- **The FCPXML exporter.** The one artifact SundaySync writes back to disk
  is a timeline XML consumed by DaVinci Resolve. Every clip name in it
  originates from an untrusted filename, so the exporter is effectively a
  templating engine over attacker-controlled strings — the injection/
  well-formedness surface a filename like `<script>&'".mp4` is designed to
  probe.
- **The scan walk.** Recursing a directory tree the operator points at can
  encounter symlinks, device files, dead network mounts, and adversarially
  deep or wide trees.

**Non-goals:**

- Defending against a compromised OS or a compromised user account. If the
  machine itself is owned, SundaySync's own controls are not a second line
  of defense.
- Multi-tenant isolation. This is a single-operator desktop app; there is no
  concept of separating multiple untrusted users on the same install.
- Treating the media *content itself* (audio/video samples) as a codec-level
  attack surface beyond what ffmpeg/ffprobe already defend — SundaySync
  does not implement its own decoders.

## Controls that exist

So a future auditor doesn't have to re-derive these from scratch:

- **No shell for media processing.** Every ffmpeg/ffprobe invocation uses
  `Command::new(path).arg(...)` with an argv array — no shell interpolation,
  so untrusted filenames/paths can't inject shell syntax.
- **Protocol-whitelisted ffprobe/ffmpeg invocations.** Probe and extract both
  pass `-protocol_whitelist file` (plus `-safe 1` for the concat demuxer),
  so a media file that is really a crafted HLS playlist or `ffconcat` script
  cannot make ffmpeg/ffprobe fetch a remote URL (SSRF) or read an arbitrary
  local path (local-file disclosure) during what is supposed to be a passive
  probe. The input path is always passed as `-i`'s value, never a bare
  trailing positional, so a file named e.g. `-show_data_hex` cannot be
  parsed as a flag. Adversarial fixtures live in `fixtures/hostile/`.
- **Symlinks not followed, device/special files skipped** during the scan
  walk (`crates/core/src/scan.rs`).
- **FCPXML injection-safe.** The exporter escapes all five XML
  metacharacters in every attribute value derived from a filename, and
  strips XML-illegal control characters rather than passing them through
  raw, so a hostile filename cannot break out of its attribute or produce a
  non-well-formed document Resolve would reject wholesale. Verified against
  adversarial names via `scripts/resolve-verify.py`.
- **Strict CSP, no remote origins.** `tauri.conf.json`'s
  `app.security.csp` is a real local-only policy (`default-src 'self'`, no
  `unsafe-eval`, no remote script/connect origins beyond the Tauri IPC
  scheme) — not the permissive `null` a Tauri app gets by default.
- **`unsafe_code = "forbid"`** at the workspace level in both Cargo
  workspaces (root and `app/src-tauri`); the engine (`crates/core`) also
  denies `unwrap`/`expect` outside tests, so the DSP/parsing pipeline that
  handles untrusted files fails observably rather than panicking.
- **ffmpeg/ffprobe sidecar pinning.** The bundled binaries fetched at build
  time (`scripts/fetch-ffmpeg.mjs`) are SHA-256-pinned — a moved or altered
  download fails the build instead of shipping a tampered sidecar.
- **Blocking dependency audits in CI.** `cargo audit`, `cargo deny check`
  (licenses + duplicate deps + RustSec advisories, `deny.toml`) and
  `npm audit --audit-level=high` all run as required CI jobs
  (`.github/workflows/ci.yml`: `audit`, `deny`, `npm-audit`), not
  advisory-only.
- **GitHub Actions pinned to commit SHAs.** Every third-party Action used in
  `ci.yml`/`nightly.yml`/`release.yml` is pinned to a full commit SHA with a
  version comment, rather than a floating tag — relevant because
  `release.yml` runs with `contents: write` to publish releases.

## Known gaps / accepted risks

- **Unsigned, unnotarized test builds.** Releases published from
  `release.yml` are deliberately unsigned test builds (see the workflow's
  header comment) — macOS Gatekeeper and Windows SmartScreen both warn on
  first launch. Signing/notarization is a planned but not-yet-scheduled
  suite-level item (Apple team `784GN847G4`, tracked alongside SundayRec's
  equivalent gap).
- **No auto-updater yet.** Until `docs/V02-PROGRAM.md` E9 ships, there is no
  signed update channel — users must manually download new releases, and
  there is no way to push a security fix to installed copies.
- **Scan walk has no file-count ceiling yet.** An adversarial or simply huge
  directory tree can cost significant time/memory before any progress is
  reported; tracked as a stability item (`docs/V02-PROGRAM.md` E3 backlog,
  S-8), not a security boundary since it's local-only and bounded by the
  operator's own disk.
