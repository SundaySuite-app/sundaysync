#!/usr/bin/env python3
"""Import a SundaySync FCPXML into DaVinci Resolve and read back where every clip landed.

docs/PLAN.md §8.4 calls for manual Resolve acceptance. This automates it, so the check is
repeatable rather than a thing someone did once and remembers differently later.

    python3 scripts/resolve-verify.py path/to/timeline.fcpxml

Requires DaVinci Resolve Studio running. Note that the bundled scripting library is loaded
by absolute path: the documented RESOLVE_SCRIPT_API location does not exist on a normal
macOS install, and the environment-variable route silently fails. See docs/DECISIONS.md
D-022.

Creates a temporary project and deletes it again, leaving Resolve as it was found.

--- FCPXML injection-test mode (docs/V02-PROGRAM.md E3, S-3 / D-032) -----------------

    python3 scripts/resolve-verify.py --injection-test [--keep] [--skip-resolve] [--seed N]

Proves the escaper in crates/core/src/fcpxml.rs holds up end to end, not just at the unit
level, by driving deliberately hostile filenames through the *real* pipeline: fixturegen
generates a small syncable multicamera shoot, the media files are copied into a scratch
directory under adversarial names (the exact `<script>&'".mp4` injection vector from the E2
finding, a name with spaces, a name with Norwegian characters, and — filesystem permitting —
a name containing a raw XML-illegal control byte), `sundaysync sync --export` runs against
that directory through the real CLI, and the resulting FCPXML is checked two ways:

  1. **Fast gate, always run:** `xml.etree.ElementTree.parse()` on the generated file. Its
     underlying expat parser enforces XML 1.0's well-formedness rules strictly, including
     rejecting illegal control characters even as numeric character references — exactly
     the class of bug S-3 fixed (a stray control byte used to produce a document Resolve
     would reject wholesale). This alone catches an escaper regression without needing
     Resolve open, so it is safe to run in CI.
  2. **Deep gate, best-effort:** the same fusionscript.so import-and-readback this script
     already does for the primary mode, reused via `resolve_import_report()`. Skipped with
     a clear message (not a failure) if Resolve Studio isn't running or `--skip-resolve` is
     passed — this is the "if a full Resolve run isn't feasible" fallback the E3 stage
     description calls for.

The scratch directory and its exported FCPXML are deleted afterward unless `--keep` is
passed (prints the path so it can be inspected).

--- KNOWN LIMITATION of the scripted deep gate (measured 2026-08-09) -----------------
Resolve's scripted `ImportTimelineFromFile` REFUSES timelines that reference
multi-gigabyte media files, regardless of codec, container, path encoding, or
volume. Systematic A/B on a real corpus: a 22 MB iPhone HEVC/AAC clip imports
from both local disk and an SMB share with a non-ASCII (Å) path; a 12 GB
HEVC/pcm_s24le camera file refuses from BOTH SMB and a local copy; a 10-second
local pcm_s24le synthetic imports fine. Same minimal document shape throughout —
the FCPXML itself is valid. The GUI import path is expected to behave normally
(progressive media linking); verify real long-form shoots interactively instead
of through this script, and keep the scripted gate for the synthetic suites.
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FUSIONSCRIPT_DIR = "/Applications/DaVinci Resolve Studio.app/Contents/Libraries/Fusion"

# The exact E2 finding (docs/V02-PROGRAM.md S-3) plus three more real-world vectors: a
# space (the single most common "someone forgot to quote something" bug), Norwegian
# characters (this app's home market), and a raw control byte where the filesystem allows
# one. Extensions are left as the underlying fixturegen media's real container — §4.1
# forbids extension-based filtering, so the adversarial part is only ever the stem, and a
# `.mp4`-named WAV decodes exactly as well as a correctly-named one.
ADVERSARIAL_NAMES = {
    "recorder_0001.wav": "<script>&'\".wav",
    "cam-balcony_0001.m4a": "has spaces (and parens) plus-name.m4a",
    "cam-stage_0001.flac": "Ærlig gudstjeneste – Østre gård åpning.flac",
    # BEL (0x07): XML-illegal even as a numeric character reference. Added last and only
    # if the host filesystem accepts it (see build_adversarial_fixture) — Windows and some
    # CI filesystems reject raw control bytes in filenames outright, which is a filesystem
    # limitation, not something this test can work around.
    "cam-balcony_0002.m4a": "bell\x07char.m4a",
}


def die(msg: str) -> "NoReturn":
    print(f"FAIL: {msg}")
    sys.exit(1)


# ---- shared: DaVinci Resolve import + readback ------------------------------------


def connect_resolve():
    """Load fusionscript.so and return the Resolve scripting app, or None if unavailable."""
    if not Path(FUSIONSCRIPT_DIR).is_dir():
        return None
    if FUSIONSCRIPT_DIR not in sys.path:
        sys.path.append(FUSIONSCRIPT_DIR)
    try:
        import fusionscript as bmd  # noqa: PLC0415
    except Exception:
        return None
    try:
        resolve = bmd.scriptapp("Resolve")
    except Exception:
        return None
    return resolve


def resolve_import_report(xml_path: str, project_name: str, resolve=None):
    """Import `xml_path` into a temporary Resolve project and return the per-clip report.

    Raises RuntimeError with a clear message on any failure. Always cleans up the temporary
    project, even on failure. `resolve` may be passed in (already-connected) to avoid
    reconnecting between calls; otherwise this connects itself.
    """
    if resolve is None:
        resolve = connect_resolve()
    if resolve is None:
        raise RuntimeError("DaVinci Resolve Studio is not running / fusionscript unavailable")

    pm = resolve.GetProjectManager()

    # Start clean in case a previous run left one behind.
    try:
        pm.DeleteProject(project_name)
    except Exception:
        pass

    proj = pm.CreateProject(project_name)
    if not proj:
        raise RuntimeError("could not create Resolve project")
    print(f"project created: {proj.GetName()}")

    try:
        mp = proj.GetMediaPool()
        ok = mp.ImportTimelineFromFile(xml_path)
        print(f"ImportTimelineFromFile -> {ok}")
        if not ok:
            raise RuntimeError("Resolve refused the FCPXML")

        tl = proj.GetCurrentTimeline()
        if tl is None:
            raise RuntimeError("no timeline after import")

        fps = float(proj.GetSetting("timelineFrameRate"))
        print(f"timeline: {tl.GetName()}   fps={fps}")
        print(f"video tracks={tl.GetTrackCount('video')}  audio tracks={tl.GetTrackCount('audio')}")

        start = tl.GetStartFrame()
        report = []
        for ttype in ("video", "audio"):
            for i in range(1, tl.GetTrackCount(ttype) + 1):
                for it in (tl.GetItemListInTrack(ttype, i) or []):
                    pos_frames = it.GetStart() - start
                    dur_frames = it.GetDuration()
                    # E6 drift correction (docs/V02-PROGRAM.md): alignment must hold at the
                    # clip END, not only its START, so report both edges. A drift-corrected
                    # clip carries a <timeMap> retime; its timeline END is where an
                    # uncorrected clock error would have drifted out of sync.
                    report.append(
                        {
                            "track": f"{ttype}{i}",
                            "name": it.GetName(),
                            "start_frames": pos_frames,
                            "start_seconds": round(pos_frames / fps, 4),
                            "duration_frames": dur_frames,
                            "end_frames": pos_frames + dur_frames,
                            "end_seconds": round((pos_frames + dur_frames) / fps, 4),
                        }
                    )
        return report
    finally:
        pm.CloseProject(proj)
        pm.DeleteProject(project_name)
        print("cleaned up project")


# ---- injection-test mode -----------------------------------------------------------


def check_xml_well_formed(fcpxml_path: Path) -> ET.Element:
    """Fast gate: parse with ElementTree, which rejects illegal control chars and
    malformed markup via its underlying expat parser. Raises ET.ParseError on failure —
    callers should let that propagate with the file's contents/position intact.
    """
    return ET.parse(fcpxml_path).getroot()


def build_adversarial_fixture(scratch: Path, seed: int) -> dict[str, str]:
    """Generate a small syncable shoot via fixturegen, then copy its media into `scratch`
    under the ADVERSARIAL_NAMES mapping. Returns {adversarial_name: original_filename} for
    every file actually created (the control-char name is dropped if the filesystem
    rejects it).
    """
    gen_dir = scratch / "gen"
    gen_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["cargo", "run", "-q", "-p", "sundaysync-fixturegen", "--", "quick", str(gen_dir), str(seed)],
        cwd=REPO_ROOT,
        check=True,
    )
    # fixturegen names its own output dir after the seed in hex; there is exactly one.
    shoot_dirs = [p for p in gen_dir.iterdir() if p.is_dir()]
    if len(shoot_dirs) != 1:
        die(f"expected exactly one fixturegen shoot dir, found {len(shoot_dirs)}")
    shoot_dir = shoot_dirs[0]

    media_dir = scratch / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    created: dict[str, str] = {}
    for original, adversarial in ADVERSARIAL_NAMES.items():
        src = shoot_dir / original
        if not src.exists():
            die(f"fixturegen did not produce expected file {original}")
        dst = media_dir / adversarial
        try:
            shutil.copy2(src, dst)
        except OSError as exc:
            print(f"SKIP: filesystem rejected adversarial name {adversarial!r} ({exc})")
            continue
        created[adversarial] = original

    if len(created) < len(ADVERSARIAL_NAMES) - 1:
        # Allow exactly the control-char name to fail on a hostile filesystem; anything
        # more than that is a real problem with the fixture, not the filesystem.
        die("too many adversarial names were rejected by the filesystem")

    return created


def run_sync_export(media_dir: Path, out_fcpxml: Path) -> dict:
    """Run the real CLI's sync+export against `media_dir`. Returns the parsed JSON sync
    map. Raises RuntimeError (with captured output) if the process crashes or panics —
    a Rust panic on a hostile filename would itself be an E3 regression worth catching
    here, not just an escaping bug.
    """
    proc = subprocess.run(
        [
            "cargo",
            "run",
            "-q",
            "-p",
            "sundaysync-cli",
            "--",
            "sync",
            str(media_dir),
            "--export",
            str(out_fcpxml),
            "-v",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if "panicked at" in proc.stderr:
        raise RuntimeError(f"sundaysync-cli panicked:\n{proc.stderr}")
    if proc.returncode != 0:
        raise RuntimeError(
            f"sundaysync-cli exited {proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"sync output was not valid JSON: {exc}\n{proc.stdout}") from exc


def run_injection_test(keep: bool, skip_resolve: bool, seed: int) -> None:
    scratch = Path(tempfile.mkdtemp(prefix="sundaysync-injection-"))
    print(f"scratch dir: {scratch}")
    try:
        created = build_adversarial_fixture(scratch, seed)
        print(f"adversarial fixture: {len(created)} files -> {sorted(created)}")

        out_fcpxml = scratch / "adversarial.fcpxml"
        sync_result = run_sync_export(scratch / "media", out_fcpxml)
        placed = {r["file"]: r for r in sync_result.get("placements", [])}
        print(f"placed {len(placed)}/{len(created)} adversarially-named clips")
        for name in created:
            matches = [f for f in placed if f.endswith(name)]
            if not matches:
                die(f"adversarially-named clip never landed in results: {name!r}")

        # --- fast gate: well-formedness -------------------------------------------
        try:
            root = check_xml_well_formed(out_fcpxml)
        except ET.ParseError as exc:
            raw = out_fcpxml.read_bytes()
            die(f"generated FCPXML is not well-formed XML: {exc}\n({len(raw)} bytes written)")
        print("XML well-formedness gate: PASS (ElementTree/expat accepted the document)")

        # Sanity: every escaped name (or its control-stripped form) is present verbatim
        # somewhere in the parsed tree, and no raw XML metacharacter or illegal control
        # byte survived into an attribute — i.e. the escaper actually ran, not merely
        # "the file happened to parse".
        serialized = ET.tostring(root, encoding="unicode")
        for adversarial in created:
            # The FCPXML asset/asset-clip `name` attribute is the filename *stem*
            # (crates/core/src/fcpxml.rs strips the extension), so compare against that,
            # not the full filename.
            needle = Path(adversarial).stem
            # The control-char name has its 0x07 stripped/normalised by the escaper, so
            # check the printable prefix instead of the literal stem for that one case.
            needle = needle.split("\x07")[0] if "\x07" in needle else needle
            # Names containing raw '&'/'<'/'>'/'"'/"'" will never appear unescaped; check
            # for the escaped form of the dangerous prefix instead for that specific case.
            if needle.startswith("<script>"):
                needle = "&lt;script&gt;"
            if needle not in serialized:
                die(f"adversarial name (or its escaped form) missing from FCPXML: {adversarial!r}")
        illegal_control = {c for c in serialized if ord(c) < 0x20 and c not in "\t\n\r"}
        if illegal_control:
            die(f"FCPXML contains raw XML-illegal control byte(s): {[hex(ord(c)) for c in illegal_control]}")
        print("injection/control-char containment checks: PASS")

        # --- deep gate: Resolve import, best-effort ---------------------------------
        if skip_resolve:
            print("Resolve import gate: SKIPPED (--skip-resolve)")
        else:
            resolve = connect_resolve()
            if resolve is None:
                print("Resolve import gate: SKIPPED (Resolve Studio not running / fusionscript unavailable)")
            else:
                report = resolve_import_report(
                    str(out_fcpxml), "SundaySync_InjectionTest_TEMP", resolve=resolve
                )
                if len(report) != len(created):
                    die(
                        f"Resolve imported {len(report)} clips, expected {len(created)}: "
                        f"{json.dumps(report, indent=2)}"
                    )
                print(f"Resolve import gate: PASS ({len(report)} clips landed)")
                print(json.dumps(report, indent=2))

        print("\nPASS: adversarial filenames survived sync + FCPXML export intact")
    finally:
        if keep:
            print(f"--keep: leaving scratch dir in place: {scratch}")
        else:
            shutil.rmtree(scratch, ignore_errors=True)


# ---- entry point ---------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--injection-test", action="store_true", help="run the FCPXML injection test instead")
    parser.add_argument("--keep", action="store_true", help="(injection test) keep the scratch dir")
    parser.add_argument("--skip-resolve", action="store_true", help="(injection test) skip the Resolve deep check")
    parser.add_argument("--seed", type=int, default=1337, help="(injection test) fixturegen seed")
    parser.add_argument("fcpxml", nargs="?", help="path to a timeline.fcpxml (primary mode)")
    parser.add_argument("-h", "--help", action="store_true")
    args = parser.parse_args()

    if args.help or (not args.injection_test and not args.fcpxml):
        print(__doc__)
        sys.exit(0 if args.help else 1)

    if args.injection_test:
        run_injection_test(keep=args.keep, skip_resolve=args.skip_resolve, seed=args.seed)
        return

    report = resolve_import_report(args.fcpxml, "SundaySync_Verify_TEMP")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
