import type { Strings } from "../../i18n";
import { basename } from "../../types";
import type { Placement } from "../../types";
import { Dialog } from "../Dialog";
import { warningText } from "./warnings";

/**
 * Everything the engine knows about one placement, on demand — offset to the
 * millisecond, how sure it is and why (confidence, PSR against the threshold),
 * measured drift, the provenance chain that got it there, and the re-assign
 * escape hatch (D-027).
 *
 * Extracted verbatim from `ResultView.tsx` when the interactive timeline
 * replaced it (D-051): the dialog was never the problem with the old view, and
 * changing its content in the same stage that changed everything around it would
 * have made the diff impossible to read.
 */
export function ClipDetail({
  t,
  clip,
  minPsr,
  deviceIds,
  onOverride,
  onClose,
}: {
  t: Strings;
  clip: Placement;
  minPsr: number;
  deviceIds: string[];
  onOverride: (file: string, device: string) => void;
  onClose: () => void;
}) {
  const name = basename(clip.file);
  const provenance =
    clip.chain.length === 0
      ? t.directMatch
      : t.viaChain(clip.chain.map((c) => basename(c)).join(" → "));

  return (
    <Dialog titleId="clip-detail-title" onClose={onClose} closeLabel={t.close}>
      <h2 id="clip-detail-title">{name}</h2>
      <dl className="detail-grid">
        <dt>{t.offsetLabel}</dt>
        <dd>{clip.offset_seconds.toFixed(3)} s</dd>
        <dt>{t.confidence}</dt>
        <dd>{(clip.confidence * 100).toFixed(0)} %</dd>
        <dt>{t.psrLabel}</dt>
        <dd>
          {Number.isFinite(clip.psr)
            ? t.psrVsThreshold(clip.psr.toFixed(1), minPsr.toFixed(0))
            : "—"}
        </dd>
        {clip.drift_ppm !== null && (
          <>
            <dt>{t.driftLabel}</dt>
            <dd>{clip.drift_ppm.toFixed(1)} ppm</dd>
          </>
        )}
      </dl>
      <p className="subtle">{provenance}</p>
      {clip.projected_end_error_ms !== null && Math.abs(clip.projected_end_error_ms) >= 1 && (
        <p className="subtle">{t.projectedEndError(clip.projected_end_error_ms)}</p>
      )}
      {clip.warnings.map((w, i) => (
        <p key={i} className="muted">
          {warningText(t, w)}
        </p>
      ))}
      <hr className="sep" style={{ margin: "1rem 0" }} />
      <label className="field">
        <span>{t.moveToDevice}</span>
        <select
          value={clip.device}
          onChange={(e) => {
            onOverride(clip.file, e.target.value);
            onClose();
          }}
        >
          {deviceIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
    </Dialog>
  );
}
