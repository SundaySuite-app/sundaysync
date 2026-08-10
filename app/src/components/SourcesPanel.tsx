import { useMemo } from "react";
import type { Strings } from "../i18n";
import { formatDuration } from "../i18n";
import { basename } from "../types";
import type { Device, FileEntry, ScanManifest, UnsyncedReason } from "../types";
import { CameraIcon, MicIcon, StarIcon } from "./icons";

/**
 * §9.2 — the sources panel: what the app understood from your drop, BEFORE any sync.
 *
 * The first build only showed the device summary after a full sync, which made the
 * chips a post-hoc restatement instead of the confirmation §9.2 places at step 2. The
 * probe-only `scan_inputs` command is what makes this instant.
 *
 * Device overrides are a view-layer overlay here: rows render under their overridden
 * device via `useMemo`, and the engine applies the same map for real at sync time
 * (D-027/D-028). That keeps the scan pure and the preview immediate.
 *
 * **v0.4 (D-061): this is a panel under the timeline, not the main view.** The timeline
 * above now answers "what did I drop and roughly when was it recorded?"; what is left
 * here is the per-file work the timeline cannot do — starring a reference, moving a file
 * to another device, and reading the badges. Two consequences:
 *
 *   - Unreadable files collapse into ONE `<details>` group, shut by default. They are a
 *     footnote on a good drop, and an open list of them was the loudest thing on the
 *     screen; the count stays visible in the summary and in the chip above, so nothing is
 *     hidden, only folded.
 *   - `busy` dims and freezes the panel while a sync runs. The panel stays mounted (the
 *     operator can still read it) but an override applied mid-run would silently belong to
 *     the NEXT run, not the one they are watching.
 */
export function SourcesPanel({
  t,
  manifest,
  inputs,
  overrides,
  reference,
  busy = false,
  onRemoveRoot,
  onClearAll,
  onOverride,
  onReference,
}: {
  t: Strings;
  manifest: ScanManifest;
  inputs: string[];
  overrides: Record<string, string>;
  reference: string | null;
  /** A sync is running: read-only until it finishes. */
  busy?: boolean;
  onRemoveRoot: (path: string) => void;
  onClearAll: () => void;
  onOverride: (file: string, device: string) => void;
  onReference: (file: string | null) => void;
}) {
  // Apply overrides as an overlay: file rows grouped under their effective device.
  const grouped = useMemo(() => {
    const effectiveDevice = (f: FileEntry) => overrides[f.file] ?? f.device;
    const byId = new Map<string, { device: Device; files: FileEntry[] }>();
    for (const device of manifest.devices) {
      byId.set(device.id, { device, files: [] });
    }
    for (const entry of manifest.files) {
      const id = effectiveDevice(entry);
      const group = byId.get(id);
      if (group) {
        group.files.push(entry);
      }
    }
    // Devices emptied by the overlay disappear, matching what the engine will do.
    return Array.from(byId.values()).filter((g) => g.files.length > 0);
  }, [manifest, overrides]);

  const cameras = grouped.filter((g) => g.files.some((f) => f.video !== null)).length;
  const recorders = grouped.length - cameras;
  const problems = manifest.unsynced.length;

  const reasonText: Record<UnsyncedReason, string> = {
    low_confidence: t.reasonLowConfidence,
    no_audio: t.reasonNoAudio,
    decode_error: t.reasonDecodeError,
    device_overlap: t.reasonDeviceOverlap,
  };

  return (
    <section
      className={`sources sources--panel${busy ? " sources--busy" : ""}`}
      aria-label={t.sourcesTitle}
      // Inert rather than disabled per control: the whole panel is one thing that is
      // unavailable for the duration of the run, and 40 individually greyed selects say
      // that far less clearly than one dimmed block does.
      aria-busy={busy || undefined}
    >
      <div className="roots">
        {inputs.map((root) => (
          <span key={root} className="root" title={root}>
            <span className="root__path">{basename(root)}</span>
            <button
              type="button"
              className="iconbtn"
              onClick={() => onRemoveRoot(root)}
              aria-label={`${t.removeRoot}: ${basename(root)}`}
            >
              ✕
            </button>
          </span>
        ))}
        {inputs.length > 1 && (
          <button type="button" className="ghost" onClick={onClearAll}>
            {t.clearAll}
          </button>
        )}
      </div>

      <div className="chips">
        {cameras > 0 && (
          <span className="chip">
            <CameraIcon />
            {t.cameraCount(cameras)}
          </span>
        )}
        {recorders > 0 && (
          <span className="chip">
            <MicIcon />
            {t.recorderCount(recorders)}
          </span>
        )}
        <span className="chip">{t.fileCount(manifest.files.length)}</span>
        {problems > 0 && <span className="chip badge--problem">{t.problemCount(problems)}</span>}
      </div>

      {reference === null && <p className="subtle">{t.autoReference}</p>}

      {grouped.map(({ device, files }) => {
        const isVideo = files.some((f) => f.video !== null);
        const total = files.reduce((acc, f) => acc + f.duration_seconds, 0);
        return (
          <div key={device.id} className="device-group">
            <div className="device-group__head">
              {isVideo ? <CameraIcon /> : <MicIcon />}
              <span className="device-group__name">{t.deviceLabel(device.id, device.label)}</span>
              <span className="device-group__meta">
                {t.fileCount(files.length)} · {formatDuration(total)}
              </span>
            </div>
            {files.map((entry) => (
              <FileRow
                key={entry.file}
                t={t}
                entry={entry}
                devices={manifest.devices}
                currentDevice={device.id}
                isReference={reference === entry.file}
                onOverride={onOverride}
                onReference={onReference}
              />
            ))}
          </div>
        );
      })}

      {problems > 0 && (
        // Shut by default (D-061). `<details>` rather than a hand-rolled toggle: the
        // browser already gives it the right role, the right keyboard behaviour and the
        // right announcement, and the summary keeps the count visible while collapsed.
        <details className="device-group device-group--problems">
          <summary className="device-group__head">
            <span className="device-group__name">{t.unsyncedTitle}</span>
            <span className="device-group__meta">{t.problemCount(problems)}</span>
          </summary>
          {manifest.unsynced.map((u) => (
            <div key={u.file} className="filerow filerow--problem">
              <span className="filerow__name" title={u.file}>
                {basename(u.file)}
              </span>
              <span className="badge badge--problem">{reasonText[u.reason]}</span>
              <span />
              <span />
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

function FileRow({
  t,
  entry,
  devices,
  currentDevice,
  isReference,
  onOverride,
  onReference,
}: {
  t: Strings;
  entry: FileEntry;
  devices: Device[];
  currentDevice: string;
  isReference: boolean;
  onOverride: (file: string, device: string) => void;
  onReference: (file: string | null) => void;
}) {
  const name = basename(entry.file);
  return (
    <div className="filerow">
      <span className="filerow__name" title={entry.file}>
        {name}
      </span>
      <span className="filerow__badges">
        <span className="badge">{formatDuration(entry.duration_seconds)}</span>
        {entry.video && (
          <span className="badge">
            {entry.video.width}×{entry.video.height}
          </span>
        )}
        {entry.audio && <span className="badge">{entry.audio.codec}</span>}
      </span>
      <button
        type="button"
        className={`ghost refbtn${isReference ? " refbtn--active" : ""}`}
        onClick={() => onReference(isReference ? null : entry.file)}
        aria-pressed={isReference}
        aria-label={`${t.makeReference}: ${name}`}
        title={t.makeReference}
      >
        <StarIcon filled={isReference} />
      </button>
      <label>
        <span className="visually-hidden">
          {t.moveToDevice}: {name}
        </span>
        <select
          value={currentDevice}
          onChange={(e) => onOverride(entry.file, e.target.value)}
        >
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {t.deviceLabel(d.id, d.label)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
