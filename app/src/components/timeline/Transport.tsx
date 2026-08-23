import { useEffect, useSyncExternalStore } from "react";
import { getPlaybackEngine } from "../../audio/scheduler";
import type { PlacedClip } from "../../audio/schedulePlan";
import type { Strings } from "../../i18n";
import { formatTimecode } from "../../timeline/geometry";
import { getPlayheadMs, usePlayheadMs } from "../../timeline/playhead";

/**
 * The transport bar — v0.3's answer to "is it actually in sync?" (D-055).
 *
 * Small on purpose. Play, stop, where the playhead is, how loud — and, as the bar's `title`,
 * one sentence saying what the audio *is*: the 12 kHz mono analysis audio the correlator
 * listened to. That sentence is load-bearing. Someone who presses play expecting a mix hears
 * something dull and lo-fi and concludes the app is broken; someone told what they are
 * listening to hears exactly what they need — whether two recordings of the same room line
 * up. It was a visible caption until V06-R2b (D-083), when the slot ran out of room for it
 * and a clipped sentence stopped being one.
 *
 * Comb filtering is the *pass* condition, not a fault: two copies of the same sound a few
 * samples apart cancel and reinforce across the spectrum, which is that hollow, phasey
 * doubling. A distinct echo means the schedule is wrong.
 *
 * All state comes from the engine's external store rather than React state, for the same
 * reason `playhead.ts` exists: the playhead moves 60×/s, and re-rendering the timeline at
 * that rate to move a number would be the most expensive text in the app.
 */
export function Transport({ t, clips, fps }: { t: Strings; clips: PlacedClip[]; fps?: number }) {
  const engine = getPlaybackEngine();
  const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const playheadMs = usePlayheadMs();

  useEffect(() => {
    engine.setClips(clips, fps);
  }, [engine, clips, fps]);

  // Nothing playable (a result whose clips are all unsynced): no transport, rather than a
  // dead button that does nothing when pressed.
  if (!state.ready) return null;

  const busy = state.buffering;
  const playing = state.playing;

  return (
    // The quality sentence is the bar's own `title` since V06-R2b (D-083) — measured, not
    // guessed: the slot's middle carries the meta sentence now, and at 1280 the note was
    // already being clipped from 413 px of text into 374 px of box, while at 1024 the whole
    // slot overflowed its 724 px by 38. A sentence that is cut off mid-word is not a sentence
    // the operator reads; on the transport itself it is one hover away, over the very control
    // that raises the question. See D-083 for what is lost and why the trade was taken.
    <div
      className="transport"
      role="group"
      aria-label={t.transportAria}
      title={t.playbackQualityNote}
    >
      <button
        type="button"
        className="transport__play"
        aria-label={playing || busy ? t.pause : t.play}
        aria-pressed={playing}
        onClick={() => void engine.toggle(getPlayheadMs() / 1000)}
      >
        {playing || busy ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button
        type="button"
        className="iconbtn"
        aria-label={t.stopPlayback}
        onClick={() => engine.stop()}
      >
        <StopIcon />
      </button>

      <span className="transport__time" data-testid="transport-time">
        {formatTimecode(playheadMs)}
      </span>

      {busy && (
        <span className="transport__buffering" role="status">
          {t.buffering}
        </span>
      )}

      <label className="transport__volume">
        <VolumeIcon />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={state.volume}
          aria-label={t.volumeAria}
          onChange={(e) => engine.setVolume(Number(e.currentTarget.value))}
        />
      </label>

      {state.deadFiles.length > 0 && (
        <span className="transport__dead" role="status">
          {t.playbackUnavailable(state.deadFiles.length)}
        </span>
      )}
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M3 1.5 12 7l-9 5.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M3 2h3v10H3zM8 2h3v10H8z" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M3 3h8v8H3z" fill="currentColor" />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M2 5.5h2.5L7.5 3v8L4.5 8.5H2z" fill="currentColor" />
      <path
        d="M9.5 5a3 3 0 0 1 0 4"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
