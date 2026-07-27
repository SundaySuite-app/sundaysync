import type { Strings } from "../i18n";
import { basename } from "../types";

/**
 * §9 advanced mode.
 *
 * Every control here is one the plan names, and none of them change what simple mode does
 * — a user who never opens this panel gets exactly the calibrated defaults.
 */
export function AdvancedPanel({
  t,
  minPsr,
  onMinPsr,
  cacheDir,
  onCacheDir,
  reference,
  onReference,
  candidates,
  onDiagnostics,
}: {
  t: Strings;
  minPsr: number | null;
  onMinPsr: (v: number | null) => void;
  cacheDir: string | null;
  onCacheDir: (v: string | null) => void;
  reference: string | null;
  onReference: (v: string | null) => void;
  candidates: string[];
  onDiagnostics: () => void;
}) {
  return (
    <section className="advanced">
      <label className="field">
        <span>{t.minPsr}</span>
        <input
          type="number"
          step="1"
          min="1"
          value={minPsr ?? 15}
          onChange={(e) => onMinPsr(Number(e.target.value) || null)}
        />
        <small className="muted">{t.minPsrHint}</small>
      </label>

      <label className="field">
        <span>{t.cacheDir}</span>
        <input
          type="text"
          value={cacheDir ?? ""}
          placeholder="—"
          onChange={(e) => onCacheDir(e.target.value || null)}
        />
        <small className="muted">{t.cacheHint}</small>
      </label>

      {candidates.length > 0 && (
        <label className="field">
          <span>{t.referenceOverride}</span>
          <select value={reference ?? ""} onChange={(e) => onReference(e.target.value || null)}>
            <option value="">—</option>
            {candidates.map((c) => (
              <option key={c} value={c}>
                {basename(c)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="field">
        <button type="button" className="secondary" onClick={onDiagnostics}>
          {t.diagnostics}
        </button>
        <small className="muted">{t.diagnosticsHint}</small>
      </div>
    </section>
  );
}
