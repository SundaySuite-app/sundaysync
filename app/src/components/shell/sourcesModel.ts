import type {
  Device,
  FileEntry,
  ScanManifest,
  SkippedFile,
  Unsynced,
} from "../../types";

/**
 * What the app understood from the drop, as arithmetic (V06-R2a, D-077).
 *
 * Every one of these was a `useMemo` inside `SourcesPanel.tsx`. The panel is gone — its
 * fourteen affordances now live in four different places in the room (the strip's «Kilder»
 * popover, the problem popover, the bottom slot's chips, the inspector's action row) — and
 * a derivation that four components share cannot go on living inside one of them.
 *
 * They are PURE functions of the manifest and the two operator overlays, which is what the
 * panel's memos were already; pulling them out is what lets `sourcesModel.test.ts` state the
 * rules directly instead of inferring them from a rendered list. The rules themselves are
 * unchanged, including the two that are easy to get wrong:
 *
 *   - **counted after the exclusion filter, under the override overlay** (D-027/D-028/D-062).
 *     A count that still included a file the operator removed would be the app disagreeing
 *     with the run it is about to start.
 *   - **a device emptied by the overlay disappears**, matching what the engine will do.
 */

/** One device and the files that belong to it right now — after removals, under overrides. */
export interface DeviceGroup {
  device: Device;
  files: FileEntry[];
}

/** A file the operator took out of the run, with whatever the scan knows about it. A problem
 *  file has no `FileEntry`, so the name is all there is. */
export interface RemovedFile {
  file: string;
  entry: FileEntry | null;
  problem: Unsynced | null;
}

/** The strip's one sentence, as two numbers (D-081). */
export interface SourceCounts {
  files: number;
  devices: number;
}

/** The effective device for a file: the operator's override, else the scan's own grouping. */
function effectiveDevice(entry: FileEntry, overrides: Record<string, string>): string {
  return overrides[entry.file] ?? entry.device;
}

/**
 * File rows grouped under the device they belong to *right now*.
 *
 * Devices keep the manifest's own order (the `<option>` order, the track order), and a device
 * the overlay emptied is dropped rather than rendered as a heading with nothing under it.
 */
export function groupFiles(
  manifest: ScanManifest,
  overrides: Record<string, string>,
  excluded: ReadonlySet<string>,
): DeviceGroup[] {
  const byId = new Map<string, DeviceGroup>();
  for (const device of manifest.devices) byId.set(device.id, { device, files: [] });
  for (const entry of manifest.files) {
    if (excluded.has(entry.file)) continue;
    byId.get(effectiveDevice(entry, overrides))?.files.push(entry);
  }
  return Array.from(byId.values()).filter((g) => g.files.length > 0);
}

/**
 * «N filer · M enheter» — the same two numbers, counted the same way.
 *
 * Deliberately NOT `groupFiles(...).length`: the strip needs this on every keystroke of the
 * override overlay and in phases where no list is drawn at all, and it must not depend on
 * building the row arrays. The two agree by construction — both filter first, then map
 * through the overlay — and `sourcesModel.test.ts` asserts that they do.
 */
export function sourceCounts(
  manifest: ScanManifest,
  overrides: Record<string, string>,
  excluded: ReadonlySet<string>,
): SourceCounts {
  const devices = new Set<string>();
  let files = 0;
  for (const entry of manifest.files) {
    if (excluded.has(entry.file)) continue;
    files += 1;
    devices.add(effectiveDevice(entry, overrides));
  }
  return { files, devices: devices.size };
}

/** Files the scan could not use, minus the ones the operator has already taken out. */
export function problemFiles(
  manifest: ScanManifest,
  excluded: ReadonlySet<string>,
): Unsynced[] {
  return manifest.unsynced.filter((u) => !excluded.has(u.file));
}

/** Removed paths, in the order they were removed. */
export function removedFiles(
  manifest: ScanManifest,
  excluded: ReadonlySet<string>,
): RemovedFile[] {
  const known = new Map<string, FileEntry>();
  for (const entry of manifest.files) known.set(entry.file, entry);
  const problems = new Map<string, Unsynced>();
  for (const u of manifest.unsynced) problems.set(u.file, u);
  return Array.from(excluded).map((file) => ({
    file,
    entry: known.get(file) ?? null,
    problem: problems.get(file) ?? null,
  }));
}

/** D-066: files the walk never probed, split the way the one-sentence summary needs them. */
export function skippedFiles(manifest: ScanManifest): {
  files: SkippedFile[];
  sidecars: number;
  stills: number;
} {
  const files = manifest.skipped ?? [];
  const sidecars = files.filter((s) => s.reason === "sidecar").length;
  return { files, sidecars, stills: files.length - sidecars };
}

/** Total seconds in a group — the device head's second number. */
export function groupDuration(group: DeviceGroup): number {
  return group.files.reduce((acc, f) => acc + f.duration_seconds, 0);
}

/** A group is a camera if anything in it carries video; otherwise it is a recorder. */
export function isVideoGroup(group: DeviceGroup): boolean {
  return group.files.some((f) => f.video !== null);
}
