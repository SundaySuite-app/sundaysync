import { useMemo } from "react";
import type { Strings } from "../i18n";
import { formatDuration } from "../i18n";
import { basename } from "../types";
import type { Device, FileEntry, ScanManifest, Unsynced, UnsyncedReason } from "../types";
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
 *
 * **v0.4 (D-062): every row can be taken out of the run.** Readable files, problem files
 * and (elsewhere) the result view's unsynced shelf all carry the same ✕, because the
 * operator does not sort the drop into "removable" and "not removable" — the lens-cap take
 * and the file that would not decode are the same wish. Removed paths leave every count,
 * every group and every timeline span, and land in a collapsed group at the bottom with
 * an undo each: a misclick must have a way back that is not "drop the whole folder again".
 *
 * The ✕ is deliberately NOT added to the root chips at the top — those already have their
 * own remove button, and a second `<button>` inside `.roots .root` would make "remove this
 * root" ambiguous both to a screen reader and to the browser tier that clicks it.
 */
export function SourcesPanel({
  t,
  manifest,
  inputs,
  overrides,
  reference,
  excluded,
  prewarmProgress,
  busy = false,
  onRemoveRoot,
  onClearAll,
  onOverride,
  onReference,
  onExclude,
  onRestore,
}: {
  t: Strings;
  manifest: ScanManifest;
  inputs: string[];
  overrides: Record<string, string>;
  reference: string | null;
  /** Files taken out of the run (D-062) — filtered out of every group and count below. */
  excluded: ReadonlySet<string>;
  /** The aggregate background-analysis tick, or null when no pass is running. */
  prewarmProgress: { completed: number; total: number } | null;
  /** A sync is running: read-only until it finishes. */
  busy?: boolean;
  onRemoveRoot: (path: string) => void;
  onClearAll: () => void;
  onOverride: (file: string, device: string) => void;
  onReference: (file: string | null) => void;
  onExclude: (file: string) => void;
  onRestore: (file: string) => void;
}) {
  // Apply overrides as an overlay: file rows grouped under their effective device.
  const grouped = useMemo(() => {
    const effectiveDevice = (f: FileEntry) => overrides[f.file] ?? f.device;
    const byId = new Map<string, { device: Device; files: FileEntry[] }>();
    for (const device of manifest.devices) {
      byId.set(device.id, { device, files: [] });
    }
    for (const entry of manifest.files) {
      if (excluded.has(entry.file)) continue;
      const id = effectiveDevice(entry);
      const group = byId.get(id);
      if (group) {
        group.files.push(entry);
      }
    }
    // Devices emptied by the overlay disappear, matching what the engine will do.
    return Array.from(byId.values()).filter((g) => g.files.length > 0);
  }, [manifest, overrides, excluded]);

  const cameras = grouped.filter((g) => g.files.some((f) => f.video !== null)).length;
  const recorders = grouped.length - cameras;
  // Counted after the filter, not before: a chip that keeps counting a file the operator
  // removed is the panel disagreeing with the run it is about to start.
  const fileCount = grouped.reduce((acc, g) => acc + g.files.length, 0);
  const problemFiles = manifest.unsynced.filter((u) => !excluded.has(u.file));
  const problems = problemFiles.length;

  /** Removed paths, in the order they were removed, with whatever the scan knows about
   *  each — a problem file's row has no `FileEntry`, so the name is all there is. */
  const removed = useMemo(() => {
    const known = new Map<string, FileEntry>();
    for (const entry of manifest.files) known.set(entry.file, entry);
    const problemsByFile = new Map<string, Unsynced>();
    for (const u of manifest.unsynced) problemsByFile.set(u.file, u);
    return Array.from(excluded).map((file) => ({
      file,
      entry: known.get(file) ?? null,
      problem: problemsByFile.get(file) ?? null,
    }));
  }, [manifest, excluded]);

  // D-066: files the walk never probed. A `.lrv`'s original sits right there in the list
  // above, so skipping it silently was defensible; a `.HEIC` has no sibling, so a silent
  // skip is just files disappearing. Counted here, listed one disclosure away.
  const skipped = manifest.skipped ?? [];
  const skippedSidecars = skipped.filter((s) => s.reason === "sidecar").length;
  const skippedStills = skipped.length - skippedSidecars;

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
        <span className="chip">{t.fileCount(fileCount)}</span>
        {problems > 0 && <span className="chip badge--problem">{t.problemCount(problems)}</span>}
      </div>

      {/* The background pre-analysis (D-059/D-062), as quietly as it deserves. Its OWN
          element and class — never `.progress__label` or the ProgressBar markup, which
          belong to the scan and the sync: those are things the operator is waiting for,
          this is work the app started on its own and will silently abandon the moment
          Sync is pressed. */}
      {prewarmProgress !== null && (
        <p className="prewarm" aria-live="off">
          {t.prewarmProgress(prewarmProgress.completed, prewarmProgress.total)}
        </p>
      )}

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
                onExclude={onExclude}
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
          {problemFiles.map((u) => (
            <div key={u.file} className="filerow filerow--problem">
              <span className="filerow__name" title={u.file}>
                {basename(u.file)}
              </span>
              <span className="badge badge--problem">{reasonText[u.reason]}</span>
              <span />
              <RemoveButton t={t} file={u.file} onExclude={onExclude} />
            </div>
          ))}
        </details>
      )}

      {removed.length > 0 && (
        // The way back. Collapsed like the problem group, and for the same reason — on a
        // normal run it is empty and on a tidied one it is a footnote — but it must exist:
        // a removal with no undo turns one misclick into re-dropping the whole card.
        <details className="device-group device-group--problems device-group--removed">
          <summary className="device-group__head">
            <span className="device-group__name">{t.removedTitle(removed.length)}</span>
          </summary>
          {removed.map(({ file, entry, problem }) => (
            <div key={file} className="filerow filerow--removed">
              <span className="filerow__name" title={file}>
                {basename(file)}
              </span>
              <span className="filerow__badges">
                {entry && <span className="badge">{formatDuration(entry.duration_seconds)}</span>}
                {problem && (
                  <span className="badge badge--problem">{reasonText[problem.reason]}</span>
                )}
              </span>
              <span />
              <button
                type="button"
                className="ghost"
                onClick={() => onRestore(file)}
                aria-label={`${t.restoreFile}: ${basename(file)}`}
              >
                {t.restoreFile}
              </button>
            </div>
          ))}
        </details>
      )}

      {skipped.length > 0 && (
        // One quiet line, with the files one click away. Deliberately NOT the unsynced
        // shelf — nothing here failed — and deliberately not the timeline note, which is
        // about time. The `<details>` is the same pattern as the two groups above, so the
        // operator learns one disclosure, not three.
        <details className="device-group device-group--problems device-group--skipped">
          <summary className="device-group__head">
            <span className="device-group__name">
              {t.skippedSummary(skippedSidecars, skippedStills)}
            </span>
          </summary>
          {skipped.map((s) => (
            <div key={s.file} className="filerow filerow--skipped">
              <span className="filerow__name" title={s.file}>
                {basename(s.file)}
              </span>
              <span className="filerow__badges">
                <span className="badge">{t.skippedReason(s.reason)}</span>
              </span>
              <span />
              <span />
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

/** The one ✕ every removable row uses, so a problem row and a readable row are removed by
 *  the same control with the same accessible name pattern. */
function RemoveButton({
  t,
  file,
  onExclude,
}: {
  t: Strings;
  file: string;
  onExclude: (file: string) => void;
}) {
  return (
    <button
      type="button"
      className="iconbtn removebtn"
      onClick={() => onExclude(file)}
      aria-label={`${t.removeFile}: ${basename(file)}`}
      title={t.removeFile}
    >
      ✕
    </button>
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
  onExclude,
}: {
  t: Strings;
  entry: FileEntry;
  devices: Device[];
  currentDevice: string;
  isReference: boolean;
  onOverride: (file: string, device: string) => void;
  onReference: (file: string | null) => void;
  onExclude: (file: string) => void;
}) {
  const name = basename(entry.file);
  return (
    <div className="filerow filerow--removable">
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
      <RemoveButton t={t} file={entry.file} onExclude={onExclude} />
    </div>
  );
}
