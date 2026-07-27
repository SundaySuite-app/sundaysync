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
"""
import sys, os, json
sys.path.append("/Applications/DaVinci Resolve Studio.app/Contents/Libraries/Fusion")
import fusionscript as bmd

xml = sys.argv[1]
resolve = bmd.scriptapp("Resolve")
pm = resolve.GetProjectManager()

PROJ = "SundaySync_Verify_TEMP"
# Start clean in case a previous run left one behind.
try: pm.DeleteProject(PROJ)
except Exception: pass

proj = pm.CreateProject(PROJ)
if not proj:
    print("FAIL: could not create project"); sys.exit(1)
print(f"project created: {proj.GetName()}")

mp = proj.GetMediaPool()
ok = mp.ImportTimelineFromFile(xml)
print(f"ImportTimelineFromFile -> {ok}")
if not ok:
    print("FAIL: Resolve refused the FCPXML")
    pm.CloseProject(proj); pm.DeleteProject(PROJ); sys.exit(1)

tl = proj.GetCurrentTimeline()
if tl is None:
    print("FAIL: no timeline after import"); sys.exit(1)

fps = float(proj.GetSetting("timelineFrameRate"))
print(f"timeline: {tl.GetName()}   fps={fps}")
print(f"video tracks={tl.GetTrackCount('video')}  audio tracks={tl.GetTrackCount('audio')}")

start = tl.GetStartFrame()
report = []
for ttype in ("video", "audio"):
    for i in range(1, tl.GetTrackCount(ttype) + 1):
        for it in (tl.GetItemListInTrack(ttype, i) or []):
            pos_frames = it.GetStart() - start
            report.append({
                "track": f"{ttype}{i}",
                "name": it.GetName(),
                "start_frames": pos_frames,
                "start_seconds": round(pos_frames / fps, 4),
                "duration_frames": it.GetDuration(),
            })
print(json.dumps(report, indent=2))

pm.CloseProject(proj)
pm.DeleteProject(PROJ)
print("cleaned up project")
