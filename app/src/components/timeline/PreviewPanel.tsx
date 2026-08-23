import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Strings } from "../../i18n";
import { formatDuration } from "../../i18n";
import {
  cancelFramesExcept,
  fetchFrame,
  hasFrame,
  peekFrame,
} from "../../timeline/frameStore";
import type { RecordingTime } from "../../timeline/recordingTime";
import { basename } from "../../types";
import type { FileEntry, Placement } from "../../types";
import { warningText } from "./warnings";

/**
 * One panel: the marked clip's picture, the file it is, and — once a sync has placed it —
 * what the engine worked out about it (V05-W4b, D-070).
 *
 * It replaces the clip-detail **dialog**. A dialog was the right shape when a clip's detail
 * was the only thing there was to say and saying it meant leaving the timeline; it is the
 * wrong shape for a picture the operator wants beside the boxes while comparing them, and a
 * modal that has to be dismissed before the next clip can be clicked turns "look through
 * this card" into forty round trips.
 *
 * ## Always visible, and always the same height
 *
 * Both halves of that are load-bearing, and the alternatives are written down in D-070.
 * Appearing on selection would shove the timeline vertically at the exact instant the
 * operator clicked a narrow clip, so their next click lands somewhere else — on a timeline
 * whose clips are three pixels wide that is a broken interaction, not an annoyance. A
 * fixed height keeps W3's `max-height: 60vh` timeline stable instead of growing and
 * shrinking with the selection, and it is why the empty state is a sentence inside the same
 * frame rather than nothing at all.
 *
 * ## What it says, and when
 *
 * The file half is drawn from the scan manifest's `FileEntry`, which is already in hand —
 * no new IPC — so it is there in every phase, before any sync. The sync half only exists
 * when a `Placement` does, and is `ClipDetail`'s content verbatim: same strings, same
 * `dl.detail-grid`, same order. Those are spec-pinned (§9.4) and the owner knows them by
 * sight; this stage MOVES them and does not reword them.
 *
 * ## The picture
 *
 * One JPEG over binary IPC (D-069), memoised per file by `frameStore.ts`, drawn onto a
 * canvas the same way `WaveformCanvas` draws its bars. Three states the operator can meet,
 * and none of them is an error:
 *   - **loading** — a calm line. Over SMB a 4K frame takes ~4.4 s (measured), so this is a
 *     state that is genuinely on screen, not a theoretical one.
 *   - **a frame** — the canvas.
 *   - **no picture** — «ingen bilde», for the WAVs and the stills. Measured at ~32 of the
 *     owner's 386 files: a broken-image icon or a red banner there would be the app lying
 *     about its own state once every twelve files.
 */
export function PreviewPanel({
  t,
  file,
  entry,
  placement,
  minPsr,
  recorded,
  device,
  deviceIds,
  busy,
  onOverride,
}: {
  t: Strings;
  /** The marked clip's path — the selection's whole domain since D-070. Null means nothing
   *  is marked, which is a state this panel renders rather than a state it disappears in. */
  file: string | null;
  /** The scan's own record of that file. Null when the manifest has no entry for it (a
   *  placement for a file the current scan no longer lists) — the panel then says what it
   *  can and omits what it cannot. */
  entry: FileEntry | null;
  /** The engine's answer for this file, once there is one. */
  placement: Placement | null;
  /** `SyncResult.parameters.min_psr`, for the "PSR vs threshold" line. */
  minPsr: number | null;
  /** Which rung of the recording-time ladder produced this file's start (D-067), and the
   *  start itself. Null when there is no manifest to derive it from. */
  recorded: RecordingTime | null;
  /** The device this file belongs to *right now* — the override overlay on top of the
   *  engine's (or the scan's) answer. Resolved by the caller, which is the one place that
   *  can see all three layers; a panel that read only the placement would snap the
   *  `<select>` back to the old device the instant the operator changed it. */
  device: string;
  deviceIds: string[];
  /** A sync is running. Looking is still allowed in every phase (D-061) — the picture and
   *  the facts stay readable — but the reassign `<select>` is a DECISION, and mid-run there
   *  is nothing it could change about the run in flight. Same gate `SourcesPanel` puts on
   *  its own controls. */
  busy: boolean;
  onOverride: (file: string, device: string) => void;
}) {
  return (
    <section className="preview" aria-label={t.previewAria}>
      {file === null || entry === null ? (
        <p className="preview__empty subtle">{t.previewEmpty}</p>
      ) : (
        <>
          <PreviewFrame t={t} entry={entry} />
          <FileFacts
            t={t}
            entry={entry}
            recorded={recorded}
            device={device}
            deviceIds={deviceIds}
            busy={busy}
            onOverride={onOverride}
          />
          <div className="preview__sync">
            {placement !== null && <SyncDetail t={t} clip={placement} minPsr={minPsr ?? 0} />}
          </div>
        </>
      )}
    </section>
  );
}

/** The canvas the frame is drawn into, in CSS pixels. 16:9 at the inspector column's width
 *  (V06-R1, D-076): 268 px is the 300 px column less its 16 px padding on each side. The old
 *  140×79 was what fitted BESIDE two columns of text in a 180 px band under the timeline —
 *  a thumbnail. Mirrored in `styles.css`'s `.preview__frame`, which is the box this canvas
 *  sits in; the two are the same numbers on purpose. */
const FRAME_W = 268;
const FRAME_H = 151;

/**
 * The still, and the two calm states that stand in for it.
 *
 * The already-settled case is read SYNCHRONOUSLY (`hasFrame`/`peekFrame`) rather than
 * awaited: a promise cannot be read in a render, so re-selecting a clip whose frame is
 * already in the memo would otherwise flash «henter bilde …» for one microtask — reporting
 * work that is not happening, on the one interaction the operator repeats most.
 */
function PreviewFrame({ t, entry }: { t: Strings; entry: FileEntry }) {
  const file = entry.file;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The last frame this component fetched, tagged with the file it belongs to — so a
   *  bitmap that resolves after the selection moved on can never be drawn under the new
   *  clip's name. */
  const [loaded, setLoaded] = useState<{ file: string; bitmap: ImageBitmap | null } | null>(null);

  const settled = hasFrame(file) ? { file, bitmap: peekFrame(file) ?? null } : null;
  const shown = settled ?? (loaded !== null && loaded.file === file ? loaded : null);
  const bitmap = shown?.bitmap ?? null;

  useEffect(() => {
    // The selection moved on: whatever is still decoding for the clip we just left is work
    // nobody wants, and `invoke` has no cancellation of its own — it would hold a preview
    // permit and a running ffmpeg (seconds of it, over a share) in front of the frame the
    // operator is actually waiting for. Done on the way IN rather than in a cleanup, which
    // would cancel this very grab under `StrictMode`'s double mount — see
    // `cancelFramesExcept`.
    cancelFramesExcept(file);
    if (hasFrame(file)) return;
    let cancelled = false;
    void fetchFrame(file, entry.duration_seconds).then((bitmap) => {
      if (!cancelled) setLoaded({ file, bitmap });
    });
    return () => {
      cancelled = true;
    };
    // `duration_seconds` is deliberately not a dependency: it decides WHERE in the clip the
    // frame is taken, and a manifest that re-reports the same file with a different duration
    // is not a reason to re-decode a picture that is already on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // Layout, not effect: the canvas must carry its picture in the same commit the state that
  // chose it does, or a fast re-selection paints one frame of the previous clip's still.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap) return;
    const dpr = window.devicePixelRatio || 1;
    const deviceW = Math.max(1, Math.round(FRAME_W * dpr));
    const deviceH = Math.max(1, Math.round(FRAME_H * dpr));
    if (canvas.width !== deviceW) canvas.width = deviceW;
    if (canvas.height !== deviceH) canvas.height = deviceH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, deviceW, deviceH);
    // Letterboxed, never stretched: a 4:3 camera among 16:9 ones is a fact about the shoot,
    // and squashing it to fill the box would hide exactly the thing worth noticing.
    const scale = Math.min(deviceW / bitmap.width, deviceH / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (deviceW - w) / 2, (deviceH - h) / 2, w, h);
  }, [bitmap]);

  const state = shown === null ? "loading" : bitmap === null ? "none" : "image";

  return (
    <div className="preview__frame" data-frame={state}>
      {state === "image" ? (
        <canvas
          ref={canvasRef}
          className="preview__canvas"
          style={{ width: `${FRAME_W}px`, height: `${FRAME_H}px` }}
          role="img"
          aria-label={t.previewFrameAlt(basename(file))}
        />
      ) : (
        <span className="preview__nostill">
          {state === "loading" ? t.previewLoading : t.previewNoImage}
        </span>
      )}
    </div>
  );
}

/**
 * What the file IS — every line of it already in the manifest, so this costs no IPC and is
 * there in every phase.
 *
 * The reassign `<select>` lives here now (D-027's escape hatch, moved out of the dialog with
 * everything else). It is the only control in the panel: the panel is for looking, and §9's
 * one thing the operator may change about a clip is which device it belongs to.
 */
function FileFacts({
  t,
  entry,
  recorded,
  device,
  deviceIds,
  busy,
  onOverride,
}: {
  t: Strings;
  entry: FileEntry;
  recorded: RecordingTime | null;
  device: string;
  deviceIds: string[];
  busy: boolean;
  onOverride: (file: string, device: string) => void;
}) {
  const name = basename(entry.file);
  return (
    <div className="preview__info">
      <h3 className="preview__name" title={entry.file}>
        {name}
      </h3>
      <dl className="detail-grid">
        <dt>{t.previewDuration}</dt>
        <dd>{formatDuration(entry.duration_seconds)}</dd>
        <dt>{t.previewVideo}</dt>
        <dd>
          {/* Note the NESTED shape: `VideoStream` carries `width`/`height`, and there is no
              flat `resolution` field to reach for. */}
          {entry.video === null
            ? t.previewNone
            : t.previewVideoStream(
                entry.video.codec,
                entry.video.width,
                entry.video.height,
                entry.video.fps,
              )}
        </dd>
        <dt>{t.previewAudio}</dt>
        <dd>
          {entry.audio === null
            ? t.previewNone
            : t.previewAudioStream(
                entry.audio.codec,
                entry.audio.sample_rate,
                entry.audio.channels,
              )}
        </dd>
        <dt>{t.previewRecorded}</dt>
        <dd>{recordedWords(t, recorded)}</dd>
      </dl>
      <label className="field field--inline">
        <span>{t.moveToDevice}</span>
        <select
          value={device}
          disabled={busy}
          // The visible `<span>` names the control; the `aria-label` names it AND says which
          // clip it is about (V06-R1, D-076). The shelf's own selector has carried that
          // longer form since v0.4, and in a column that can show only one clip at a time the
          // sentence «Flytt til enhet: C0001.MP4» is the whole difference between a label and
          // a label with a subject. `aria-label` wins over the span for the accessible name,
          // and a substring lookup for the short form still resolves it.
          aria-label={`${t.moveToDevice}: ${name}`}
          onChange={(e) => onOverride(entry.file, e.target.value)}
        >
          {deviceIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * The reconstructed start, and which rung of the ladder produced it — in the words W3
 * already chose (D-067). Deliberately not new wording: «anslått fra filens
 * endringstidspunkt» is what the clip's own spoken description says, and one claim said two
 * ways is one claim too many.
 */
function recordedWords(t: Strings, recorded: RecordingTime | null): string {
  if (recorded === null) return t.previewNone;
  if (recorded.startMs === null) {
    // A stamp the session gate refused still HAS a stamp, and naming the date it claims is
    // the whole point of D-071 — «13.06.2023, tidsstemplet utenfor økta».
    return recorded.outsideWindowMs !== undefined
      ? `${t.previewClock(recorded.outsideWindowMs)} — ${t.presyncOffSessionClip}`
      : t.presyncSourceNone;
  }
  const clock = t.previewClock(recorded.startMs);
  switch (recorded.source) {
    // The top rung is a measurement, and is not dressed as an estimate.
    case "container":
      return clock;
    case "bwf":
      return `${clock} — ${t.presyncSourceBwf}`;
    case "filename":
      return `${clock} — ${t.presyncSourceFilename}`;
    case "modified":
      return `${clock} — ${t.presyncSourceModified}`;
    default:
      return clock;
  }
}

/**
 * The engine's answer — **verbatim from `ClipDetail.tsx`**, which this replaced.
 *
 * Offset to the millisecond, how sure it is and why (confidence, PSR against the threshold),
 * measured drift, the provenance chain that got it there, the projected end error and any
 * warnings. Same strings, same markup, same order: these are §9.4's, the owner reads them
 * every run, and a move is not a licence to reword.
 */
function SyncDetail({ t, clip, minPsr }: { t: Strings; clip: Placement; minPsr: number }) {
  const provenance =
    clip.chain.length === 0
      ? t.directMatch
      : t.viaChain(clip.chain.map((c) => basename(c)).join(" → "));

  return (
    <>
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
    </>
  );
}
