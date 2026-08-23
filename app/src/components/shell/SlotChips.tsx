import { useRef } from "react";
import type { Strings } from "../../i18n";
import { formatDuration } from "../../i18n";
import { basename } from "../../types";
import type { ScanManifest, UnsyncedReason } from "../../types";
import { removedFiles, skippedFiles } from "./sourcesModel";
import { usePopoverDismiss } from "./usePopoverDismiss";

/**
 * The bottom slot's two footnotes and one promise (V06-R2a, D-077 #7/#13/#14).
 *
 * All three are things the app owes the operator that nobody is waiting for: what was taken
 * out and how to put it back, what the walk never looked at, and who the reference will be if
 * nobody says. In the panel they were three `<details>` at the bottom of a scrolling list —
 * which is the right *rank* for them and the wrong *place*, because the bottom of a list that
 * is 40 % of the stage is still 40 % of the stage.
 *
 * They are chips on the 38 px slot now, opening **upwards** (`popover--up`), and each one is
 * absent when it has nothing to say. That absence is the whole design: a permanent "0 files
 * were skipped" is a line the operator reads past on every clean run.
 */
export function SlotChips({
  t,
  manifest,
  excluded,
  reference,
  /** Pre-sync: the run has not chosen a reference yet, so the promise is still a promise. */
  showAutoReference,
  onRestore,
}: {
  t: Strings;
  manifest: ScanManifest;
  excluded: ReadonlySet<string>;
  reference: string | null;
  showAutoReference: boolean;
  onRestore: (file: string) => void;
}) {
  const removed = removedFiles(manifest, excluded);
  const skipped = skippedFiles(manifest);

  return (
    <div className="slot__chips">
      {removed.length > 0 && (
        <RemovedChip t={t} removed={removed} onRestore={onRestore} />
      )}
      {skipped.files.length > 0 && <SkippedChip t={t} skipped={skipped} />}
      {showAutoReference && reference === null && (
        <span className="slot__auto subtle">{t.autoReference}</span>
      )}
    </div>
  );
}

/** The way back. A removal with no undo turns one misclick into re-dropping the whole card. */
function RemovedChip({
  t,
  removed,
  onRestore,
}: {
  t: Strings;
  removed: ReturnType<typeof removedFiles>;
  onRestore: (file: string) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  usePopoverDismiss(ref);

  const reasonText: Record<UnsyncedReason, string> = {
    low_confidence: t.reasonLowConfidence,
    no_audio: t.reasonNoAudio,
    decode_error: t.reasonDecodeError,
    device_overlap: t.reasonDeviceOverlap,
  };

  return (
    <details className="popover popover--up slot__removed" ref={ref}>
      <summary className="chip" title={t.removedTitle(removed.length)}>
        <span className="chip__text">{t.removedTitle(removed.length)}</span>
      </summary>
      <div className="popover__panel" role="group" aria-label={t.removedTitle(removed.length)}>
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
      </div>
    </details>
  );
}

/** D-066: files the walk never probed. Nothing failed, so this is deliberately not red. */
function SkippedChip({
  t,
  skipped,
}: {
  t: Strings;
  skipped: ReturnType<typeof skippedFiles>;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  usePopoverDismiss(ref);
  const summary = t.skippedSummary(skipped.sidecars, skipped.stills);

  return (
    <details className="popover popover--up slot__skipped" ref={ref}>
      <summary className="chip" title={summary}>
        <span className="chip__text">{summary}</span>
      </summary>
      <div className="popover__panel" role="group" aria-label={summary}>
        {skipped.files.map((s) => (
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
      </div>
    </details>
  );
}
