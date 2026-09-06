#!/usr/bin/env python3
"""Summarise a SundaySync `sync` JSON dump for the calibration report (K, D-098).

Reads only; writes nothing. Not part of the shipped product — a reading aid kept
beside the raw dumps so the numbers in docs/CALIBRATION-2026-09.md can be re-derived.
"""
import json
import statistics
import sys
from collections import Counter
from pathlib import Path


def base(p):
    return Path(p).name


def summarise(path):
    d = json.loads(Path(path).read_text())
    ref = d.get("reference")
    print(f"### {path}")
    if isinstance(ref, dict):
        print(f"reference : {base(ref['file'])}   device={ref['device']}")
    else:
        print(f"reference : {ref}")
    devs = d.get("devices", [])
    print(f"devices   : {len(devs)}")
    for dev in devs:
        if isinstance(dev, dict):
            print("   ", json.dumps(dev, ensure_ascii=False)[:160])
    print(f"warnings  : {d.get('warnings')}")
    seq = d.get("sequence", {})
    print(f"sequence  : fps={seq.get('fps')} dur={seq.get('duration_seconds')}")

    pl = d.get("placements", [])
    def num(v, w=7, d=2):
        return f"{v:{w}.{d}f}" if isinstance(v, (int, float)) else str(v).rjust(w)

    print(f"\nplaced    : {len(pl)}")
    for p in sorted(pl, key=lambda p: p["offset_seconds"]):
        print(
            f"  {base(p['file'])[:46]:46s} off={num(p['offset_seconds'], 12, 3)}"
            f" psr={num(p['psr'])} conf={num(p['confidence'], 5, 3)}"
            f" ppm={num(p['drift_ppm'], 8, 1)}"
            f" endErr={num(p['projected_end_error_ms'], 8, 1)}"
            f" chain={len(p['chain'])} warn={p['warnings']}"
        )
    if pl:
        psrs = sorted(p["psr"] for p in pl if p["psr"] is not None)
        if psrs:
            print(
                f"  PSR  min={psrs[0]:.2f} median={statistics.median(psrs):.2f} max={psrs[-1]:.2f}"
            )
    if pl:
        ppms = sorted(p["drift_ppm"] for p in pl if p["drift_ppm"] is not None)
        if ppms:
            print(
                f"  ppm  min={ppms[0]:.1f} median={statistics.median(ppms):.1f} max={ppms[-1]:.1f}"
                f"  (n={len(ppms)} of {len(pl)}; {len(pl) - len(ppms)} without drift evidence)"
            )

    un = d.get("unsynced", [])
    print(f"\nunsynced  : {len(un)}  {dict(Counter(u['reason'] for u in un))}")
    for u in un:
        print(f"  {base(u['file'])[:60]:60s} {u['reason']}")
    sk = d.get("skipped", [])
    if sk:
        print(f"\nskipped   : {len(sk)}  {dict(Counter(s['reason'] for s in sk))}")
    print()


if __name__ == "__main__":
    for a in sys.argv[1:]:
        summarise(a)
