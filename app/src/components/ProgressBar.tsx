import type { Strings } from "../i18n";
import type { ProgressEvent } from "../types";

/**
 * §9.3 — stage names, not a bare percentage.
 *
 * The engine reports its stage; showing it is what tells a user whether a long wait is
 * decoding (expected, slow) or correlating (also slow, but nearly done).
 */
const STAGE_LABELS: Record<string, { nb: string; en: string }> = {
  Scanning: { nb: "Leser filer", en: "Reading files" },
  Probing: { nb: "Undersøker media", en: "Inspecting media" },
  Extracting: { nb: "Henter ut lyd", en: "Extracting audio" },
  Correlating: { nb: "Sammenligner lyd", en: "Comparing audio" },
  Placing: { nb: "Plasserer klipp", en: "Placing clips" },
  MeasuringDrift: { nb: "Måler drift", en: "Measuring drift" },
};

export function ProgressBar({ t, progress }: { t: Strings; progress: ProgressEvent | null }) {
  const isNorwegian = t.cancel === "Avbryt";
  const label = progress
    ? (STAGE_LABELS[progress.stage]?.[isNorwegian ? "nb" : "en"] ?? progress.stage)
    : t.syncing;
  const pct =
    progress && progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : null;

  return (
    <div className="progress">
      <div className="progress__label">
        <span>{label}</span>
        {progress && progress.total > 0 && (
          <span className="muted">
            {progress.completed}/{progress.total}
          </span>
        )}
      </div>
      <div className="progress__track">
        <div
          className={`progress__fill${pct === null ? " progress__fill--indeterminate" : ""}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
