import type { Strings } from "../i18n";
import { DropZone } from "./DropZone";

/**
 * What the app shows before any media has been dropped: the §9.1 drop zone plus one
 * sentence of what the app actually does and the three-step flow. Rich enough that a
 * user who skipped onboarding still knows what happens next.
 */
export function EmptyState({
  t,
  onFiles,
  onFolder,
  onDropPaths,
}: {
  t: Strings;
  onFiles: () => void;
  onFolder: () => void;
  onDropPaths: (paths: string[]) => void;
}) {
  return (
    <div>
      <DropZone t={t} onFiles={onFiles} onFolder={onFolder} onDropPaths={onDropPaths} />
      <div className="flow-hint" aria-hidden="true">
        <span className="step">1. {t.emptyFlow1}</span>
        <span className="arrow">→</span>
        <span className="step">2. {t.emptyFlow2}</span>
        <span className="arrow">→</span>
        <span className="step">3. {t.emptyFlow3}</span>
      </div>
      <p className="muted" style={{ textAlign: "center", marginTop: "1rem", maxWidth: "38rem", marginLeft: "auto", marginRight: "auto" }}>
        {t.emptyExplain}
      </p>
    </div>
  );
}
