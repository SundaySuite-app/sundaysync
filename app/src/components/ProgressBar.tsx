import type { Strings } from "../i18n";
import { stageLabel } from "../i18n";
import type { ProgressEvent } from "../types";

/**
 * §9.3 — stage names, not a bare percentage.
 *
 * Labels come from the type-linked dictionary via `stageLabel` — the first build kept a
 * parallel translation table in this file and sniffed the language by comparing
 * `t.cancel === "Avbryt"`, both of which are exactly what the dictionary exists to
 * prevent.
 */
export function ProgressBar({ t, progress }: { t: Strings; progress: ProgressEvent | null }) {
  const label = progress ? stageLabel(t, progress.stage) : t.syncing;
  const determinate = progress !== null && progress.total > 0;
  const pct = determinate ? Math.round((progress.completed / progress.total) * 100) : null;

  return (
    <div className="progress">
      <div className="progress__label" aria-live="polite">
        <span>{label}</span>
        {determinate && (
          <span className="muted">
            {progress.completed}/{progress.total}
          </span>
        )}
      </div>
      <div
        className="progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={determinate ? progress.total : undefined}
        aria-valuenow={determinate ? progress.completed : undefined}
      >
        <div
          className={`progress__fill${pct === null ? " progress__fill--indeterminate" : ""}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
