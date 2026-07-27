import { useState } from "react";
import type { Strings } from "../i18n";
import { basename, type Placement, type SyncResult, type Warning } from "../types";

/**
 * §9.4 — lanes per device, green/yellow clips, and a red shelf for refusals.
 *
 * Informational, not an editor: §9 is explicit that clips are not draggable in v1. The
 * colouring is PluralEyes' one genuinely loved feature, kept.
 */
export function ResultView({ t, result }: { t: Strings; result: SyncResult }) {
  const [selected, setSelected] = useState<Placement | null>(null);

  const span = Math.max(result.sequence.duration_seconds, 1);
  const origin = Math.min(...result.placements.map((p) => p.offset_seconds), 0);

  const reasonText: Record<string, string> = {
    low_confidence: t.reasonLowConfidence,
    no_audio: t.reasonNoAudio,
    decode_error: t.reasonDecodeError,
    device_overlap: t.reasonDeviceOverlap,
  };

  return (
    <section className="result">
      {result.warnings.map((w, i) => (
        <p key={i} className="banner banner--warn">
          {warningText(t, w)}
        </p>
      ))}

      <div className="lanes">
        {result.devices.map((device) => {
          const clips = result.placements.filter((p) => p.device === device.id);
          if (clips.length === 0) return null;
          const isReference = result.reference?.device === device.id;
          return (
            <div key={device.id} className="lane">
              <div className="lane__label">
                <span className="lane__name">{deviceLabel(t, device.id, device.label)}</span>
                {isReference && <span className="badge">{t.reference}</span>}
              </div>
              <div className="lane__track">
                {clips.map((clip) => {
                  const left = ((clip.offset_seconds - origin) / span) * 100;
                  const width = Math.max(estimateWidth(clip, result, span), 1.5);
                  const hasWarnings = clip.warnings.length > 0;
                  return (
                    <button
                      key={clip.file}
                      type="button"
                      className={`clip${hasWarnings ? " clip--warn" : " clip--ok"}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      onClick={() => setSelected(clip)}
                      title={basename(clip.file)}
                    >
                      <span className="clip__name">{basename(clip.file)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {result.unsynced.length > 0 && (
        <div className="shelf">
          <h2 className="shelf__title">{t.unsyncedTitle}</h2>
          <ul>
            {result.unsynced.map((u) => (
              <li key={u.file}>
                <span className="shelf__file">{basename(u.file)}</span>
                <span className="muted"> — {reasonText[u.reason] ?? u.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selected && (
        <div className="details">
          <h3>{basename(selected.file)}</h3>
          <dl>
            <dt>Offset</dt>
            <dd>{selected.offset_seconds.toFixed(3)} s</dd>
            <dt>{t.confidence}</dt>
            <dd>{(selected.confidence * 100).toFixed(0)} %</dd>
            {selected.drift_ppm !== null && (
              <>
                <dt>Drift</dt>
                <dd>{selected.drift_ppm.toFixed(1)} ppm</dd>
              </>
            )}
          </dl>
          {selected.warnings.map((w, i) => (
            <p key={i} className="muted">
              {warningText(t, w)}
            </p>
          ))}
          <button type="button" className="linklike" onClick={() => setSelected(null)}>
            ✕
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * §4.5 labels are emitted bare so the engine never hardcodes one language (D-007). The
 * provenance is in the device id, so the localised prefix belongs here.
 */
function deviceLabel(t: Strings, id: string, label: string): string {
  return id.startsWith("folder-") ? t.folderLabel(label) : label;
}

function warningText(t: Strings, w: Warning): string {
  switch (w.code) {
    case "drift":
      return t.drift(w.projected_end_error_ms);
    case "metadata_mismatch":
      return t.metadataMismatch;
    case "mixed_fps":
      return t.mixedFps;
    case "frame_snap_residual":
      return t.frameSnap;
    default:
      return "";
  }
}

/**
 * Clip widths are approximated from the gap to the next clip, because `SyncResult` does
 * not carry per-file durations (§5 has no field for it, and adding one is a schema
 * change). Good enough for a proportional overview, which is all §9.4 asks of it.
 */
function estimateWidth(clip: Placement, result: SyncResult, span: number): number {
  const sameDevice = result.placements
    .filter((p) => p.device === clip.device)
    .map((p) => p.offset_seconds)
    .sort((a, b) => a - b);
  const next = sameDevice.find((o) => o > clip.offset_seconds);
  const length = next ? next - clip.offset_seconds : span / 4;
  return (length / span) * 100;
}
