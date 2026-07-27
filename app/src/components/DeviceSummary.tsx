import type { Strings } from "../i18n";
import type { SyncResult } from "../types";

/** §9.2 — "3 kameraer · 1 lydopptaker · 42 filer". */
export function DeviceSummary({ t, result }: { t: Strings; result: SyncResult }) {
  const cameras = result.devices.filter((d) => d.kind === "video").length;
  const recorders = result.devices.filter((d) => d.kind === "audio").length;
  const files = result.placements.length + result.unsynced.length;

  const parts: string[] = [];
  if (cameras > 0) parts.push(`${cameras} ${t.cameras}`);
  if (recorders > 0) parts.push(`${recorders} ${t.recorders}`);
  parts.push(`${files} ${t.files}`);

  return <p className="chips">{parts.join(" · ")}</p>;
}
