import { useMemo, useState } from "react";
import type { Strings } from "../i18n";
import { formatDuration } from "../i18n";
import { basename } from "../types";
import type { Placement, SyncOutcome, UnsyncedReason, Warning } from "../types";
import { CameraIcon, MicIcon } from "./icons";
import { Dialog } from "./Dialog";

/**
 * §9.4 — lanes per device, green/yellow clips, and a red shelf for refusals.
 *
 * Informational, not an editor: §9 is explicit that clips are not draggable in v1.
 * Clip widths are REAL — `SyncOutcome.durations` is forwarded from the shell now, so
 * the gap-to-next-clip estimate (and its apology comment) is gone.
 *
 * Every device renders, including ones with zero placed clips: a camera that synced
 * nothing is exactly what §7.5 wants visible, not vanished.
 */
export function ResultView({
  t,
  outcome,
  stale,
  deviceIds,
  onOverride,
}: {
  t: Strings;
  outcome: SyncOutcome;
  stale: boolean;
  deviceIds: string[];
  onOverride: (file: string, device: string) => void;
}) {
  const [selected, setSelected] = useState<Placement | null>(null);
  const { result, durations } = outcome;

  const { origin, span } = useMemo(() => {
    if (result.placements.length === 0) return { origin: 0, span: 1 };
    let min = Infinity;
    let max = -Infinity;
    for (const p of result.placements) {
      min = Math.min(min, p.offset_seconds);
      max = Math.max(max, p.offset_seconds + (durations[p.file] ?? 0));
    }
    return { origin: min, span: Math.max(max - min, 1) };
  }, [result, durations]);

  const reasonText: Record<UnsyncedReason, string> = {
    low_confidence: t.reasonLowConfidence,
    no_audio: t.reasonNoAudio,
    decode_error: t.reasonDecodeError,
    device_overlap: t.reasonDeviceOverlap,
  };

  return (
    <section className={`result${stale ? " result--stale" : ""}`}>
      <div className="result__meta">
        <span>{t.sequenceMeta(result.sequence.fps, formatDuration(result.sequence.duration_seconds))}</span>
      </div>

      {result.warnings.map((w, i) => (
        <p key={i} className="banner banner--warn">
          <span>{warningText(t, w)}</span>
        </p>
      ))}

      <div className="lanes">
        {result.devices.map((device) => {
          const clips = result.placements.filter((p) => p.device === device.id);
          const isReference = result.reference?.device === device.id;
          return (
            <div key={device.id} className="lane">
              <div className="lane__label">
                {device.kind === "video" ? <CameraIcon /> : <MicIcon />}
                <span className="lane__name">{t.deviceLabel(device.id, device.label)}</span>
                {isReference && <span className="badge badge--ref">{t.reference}</span>}
              </div>
              <div className="lane__track">
                {clips.length === 0 && <span className="lane__empty">{t.emptyLane}</span>}
                {clips.map((clip) => {
                  const left = ((clip.offset_seconds - origin) / span) * 100;
                  const width = ((durations[clip.file] ?? 0) / span) * 100;
                  const name = basename(clip.file);
                  const hasWarnings = clip.warnings.length > 0;
                  return (
                    <button
                      key={clip.file}
                      type="button"
                      className={`clip${hasWarnings ? " clip--warn" : ""}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      onClick={() => setSelected(clip)}
                      aria-label={`${name}, ${t.offsetLabel} ${clip.offset_seconds.toFixed(1)} s`}
                      title={name}
                    >
                      <span className="clip__name">{name}</span>
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
          {result.unsynced.map((u) => (
            <div key={u.file} className="shelf__row">
              <span>{basename(u.file)}</span>
              <span className="shelf__reason">— {reasonText[u.reason]}</span>
              {/* The device_overlap fix path: move the clip and re-sync (D-027). */}
              <label>
                <span className="visually-hidden">
                  {t.moveToDevice}: {basename(u.file)}
                </span>
                <select value="" onChange={(e) => e.target.value && onOverride(u.file, e.target.value)}>
                  <option value="">{t.moveToDevice}</option>
                  {deviceIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <ClipDetail
          t={t}
          clip={selected}
          minPsr={result.parameters.min_psr}
          deviceIds={deviceIds}
          onOverride={onOverride}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function ClipDetail({
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
  }
}
