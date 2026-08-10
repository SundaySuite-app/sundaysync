/**
 * The Web Audio execution layer — V03-S5, docs/DECISIONS.md D-055.
 *
 * Everything decided elsewhere; this only *does* it. `schedulePlan.ts` produced a list of
 * (chunk, when, offset, duration, rate); this creates one `AudioBufferSourceNode` per
 * entry and starts it at `base + whenOffsetSec`, where `base` is a single `currentTime`
 * captured once per play. Two clips 4.2 s apart are 4.2 s apart because both numbers were
 * added to the same `base` and the audio hardware counted the samples — not because
 * anything was started "now" and hoped for.
 *
 * ```
 *   PcmStore ──Float32Array──▶ AudioBuffer ──▶ AudioBufferSourceNode(playbackRate=rate)
 *                                                        │
 *                                              per-device GainNode  (mute / solo)
 *                                                        │
 *                                                master GainNode    (volume)
 *                                                        │
 *                                                  destination
 * ```
 *
 * ## Rules that are easy to break and expensive to debug
 *
 * - **The AudioContext is created inside the play gesture**, never at module load.
 *   Autoplay policy suspends a context created without one, and a suspended context's
 *   `currentTime` does not advance — so the playhead would sit at zero and the audio
 *   would never start, with no error anywhere.
 * - **No `decodeAudioData`.** The samples are already PCM; decode is for containers.
 *   `createBuffer` + `copyToChannel` at 12 000 Hz hands the graph exactly the samples the
 *   correlator used, and the output device resamples.
 * - **AudioBuffers are not cached.** Each is used by exactly one source node, and caching
 *   them would silently double the 256 MB budget with a second copy of every chunk.
 * - **Every teardown bumps the generation.** A chunk fetch that resolves after a pause
 *   must not schedule anything; the generation it captured no longer matches.
 *
 * ## The test hook
 *
 * Playwright cannot hear. `window.__SUNDAYSYNC_AUDIO__` mirrors the schedule — the exact
 * numbers handed to `start()` — so the browser tier can assert relative timing, drift
 * rates, mute/solo gains and generation bumps. It is the honest boundary of what
 * automation can prove here: the schedule is testable, the acoustics are a manual smoke
 * test and the S7 listening protocol.
 */

import { PlaybackClock } from "./PlaybackClock";
import { PcmStore, type PlannedChunk } from "./pcmStore";
import { AHEAD_SEC, BEHIND_SEC, chunkKey, planChunks } from "./pcmPlan";
import {
  ANALYSIS_RATE,
  catchUp,
  chunkTimelineSpan,
  clipTransport,
  computeSchedule,
  timelineDurationSec,
  type PlacedClip,
  type ScheduledSource,
} from "./schedulePlan";
import { getSettings, saveSettings } from "../settings";

/** How far ahead of `currentTime` the first source is scheduled. */
const BASE_LEAD_SEC = 0.05;

/** Seconds of every audible clip that must be resident before play starts. */
const PREROLL_SEC = 5;

/** Top-up cadence: extend the prefetch and schedule whatever has landed. */
const TOPUP_MS = 1000;

/** A seek published while dragging should not rebuild the graph on every pointer move. */
const SEEK_SETTLE_MS = 120;

/** One entry of the Playwright-visible schedule mirror. */
export interface AudioHookEntry {
  file: string;
  device: string;
  chunkIndex: number;
  /** Absolute `AudioContext` time this source starts at. */
  when: number;
  /** The same instant relative to `baseCtxTime` — what `schedulePlan` computed. */
  whenOffset: number;
  offset: number;
  duration: number;
  rate: number;
  gain: number;
}

export interface AudioHook {
  generation: number;
  baseCtxTime: number;
  playStartSec: number;
  playing: boolean;
  buffering: boolean;
  scheduled: AudioHookEntry[];
  deviceGains: Record<string, number>;
  masterGain: number;
  deadFiles: string[];
}

declare global {
  interface Window {
    __SUNDAYSYNC_AUDIO__?: AudioHook;
  }
}

/** What the React components render from. Frozen snapshots; identity changes on mutation. */
export interface PlaybackSnapshot {
  playing: boolean;
  buffering: boolean;
  /** True once a sync outcome with playable clips is loaded. */
  ready: boolean;
  durationSec: number;
  volume: number;
  driftCorrected: boolean;
  muted: readonly string[];
  soloed: readonly string[];
  deadFiles: readonly string[];
}

const EMPTY: PlaybackSnapshot = {
  playing: false,
  buffering: false,
  ready: false,
  durationSec: 0,
  volume: 1,
  driftCorrected: true,
  muted: [],
  soloed: [],
  deadFiles: [],
};

export interface EngineOptions {
  store?: PcmStore;
  /** Injectable for tests; defaults to the platform `AudioContext`. */
  createContext?: () => AudioContext;
}

export class PlaybackEngine {
  private clips: PlacedClip[] = [];
  private fps: number | undefined;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly deviceGains = new Map<string, GainNode>();
  private readonly sources = new Map<string, AudioBufferSourceNode>();

  private readonly store: PcmStore;
  private readonly clock: PlaybackClock;
  private readonly createContext: () => AudioContext;

  private generation = 0;
  private base = 0;
  private playStartSec = 0;
  private topup: ReturnType<typeof setInterval> | null = null;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly muted = new Set<string>();
  private readonly soloed = new Set<string>();

  private snapshot: PlaybackSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  constructor(opts: EngineOptions = {}) {
    this.store = opts.store ?? new PcmStore({
      onDead: () => this.publish(),
      onArrived: () => this.scheduleResident(),
    });
    this.createContext = opts.createContext ?? (() => new AudioContext());
    this.clock = new PlaybackClock({ onEnded: () => this.pause() });
    const s = getSettings();
    this.snapshot = { ...EMPTY, volume: s.playbackVolume, driftCorrected: s.playbackDriftCorrected };
  }

  // ---- React binding -------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PlaybackSnapshot => this.snapshot;

  // ---- Source material -----------------------------------------------------------

  /**
   * Point playback at a sync outcome. A new result is a new set of files, so everything
   * resident is dropped: keeping it would risk playing the previous take's audio under
   * this take's timeline, which is the one wrong thing this app must never do.
   */
  setClips(clips: PlacedClip[], fps?: number): void {
    this.teardown();
    this.store.clear();
    this.clips = clips;
    this.fps = fps;
    this.clock.setDuration(timelineDurationSec(clips, this.scheduleOpts()));
    this.publish();
  }

  // ---- Transport -----------------------------------------------------------------

  async toggle(atSec: number): Promise<void> {
    if (this.snapshot.playing || this.snapshot.buffering) this.pause();
    else await this.play(atSec);
  }

  /**
   * Start playing at `fromSec`.
   *
   * Must be called from a user gesture: the AudioContext is constructed here, and a
   * context built outside one starts suspended.
   */
  async play(fromSec: number): Promise<void> {
    if (this.clips.length === 0) return;
    this.teardown();

    const generation = (this.generation += 1);
    this.playStartSec = Math.max(0, fromSec);
    this.snapshot = { ...this.snapshot, buffering: true, playing: false };
    this.publish();

    const ctx = this.ensureContext();
    // A context can be suspended by policy even when built in a gesture (a page that was
    // backgrounded at the moment of the click). Resuming is cheap and idempotent.
    if (ctx.state === "suspended") await ctx.resume();

    // Pre-roll: enough of every audible clip that the first seconds cannot dropout. The
    // transport says "buffering" for exactly this window — honest, on a NAS it is real.
    await this.store.ensure(this.plan(this.playStartSec, PREROLL_SEC, 0), this.playStartSec);
    if (generation !== this.generation) return; // paused or re-sought while fetching

    this.base = ctx.currentTime + BASE_LEAD_SEC;
    this.snapshot = { ...this.snapshot, buffering: false, playing: true };
    this.clock.attach(ctx);
    this.clock.start(this.playStartSec, this.base);
    this.publish();

    this.scheduleResident();
    this.topup = setInterval(() => this.topUp(), TOPUP_MS);
    void this.topUp();
  }

  pause(): void {
    const wasPlaying = this.snapshot.playing || this.snapshot.buffering;
    this.teardown();
    this.clock.pause();
    if (wasPlaying) this.publish();
  }

  /** Stop and return to the start of the timeline. */
  stop(): void {
    this.teardown();
    this.clock.stop();
    this.publish();
  }

  /**
   * Move the playhead. Publishes immediately (so scrubbing stays live) and — if playing —
   * rebuilds the graph once the gesture settles, rather than on every pointer move.
   */
  seekTo(seconds: number): void {
    const wasPlaying = this.snapshot.playing || this.snapshot.buffering;
    // The generation bumps NOW, so any fetch or top-up still in flight is stale and
    // cannot schedule against the position we just left.
    this.teardown();
    this.clock.seek(seconds);

    if (!wasPlaying) {
      this.publish();
      return;
    }
    this.snapshot = { ...this.snapshot, playing: false, buffering: true };
    this.publish();
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => {
      this.seekTimer = null;
      void this.play(seconds);
    }, SEEK_SETTLE_MS);
  }

  // ---- Mixer ---------------------------------------------------------------------

  toggleMute(device: string): void {
    if (this.muted.has(device)) this.muted.delete(device);
    else this.muted.add(device);
    this.applyGains();
    this.publish();
  }

  toggleSolo(device: string): void {
    if (this.soloed.has(device)) this.soloed.delete(device);
    else this.soloed.add(device);
    this.applyGains();
    this.publish();
  }

  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    saveSettings({ playbackVolume: v });
    this.snapshot = { ...this.snapshot, volume: v };
    this.applyGains();
    this.publish();
  }

  setDriftCorrected(on: boolean): void {
    saveSettings({ playbackDriftCorrected: on });
    this.snapshot = { ...this.snapshot, driftCorrected: on };
    this.clock.setDuration(timelineDurationSec(this.clips, this.scheduleOpts()));
    // The rates just changed, so everything scheduled is wrong. Rebuild from where the
    // playhead stands rather than pretending the change can wait.
    if (this.snapshot.playing || this.snapshot.buffering) this.seekTo(this.clock.currentTime);
    else this.publish();
  }

  /** The gain a device's bus should carry: mute wins, then solo, then unity. */
  gainFor(device: string): number {
    if (this.muted.has(device)) return 0;
    if (this.soloed.size > 0 && !this.soloed.has(device)) return 0;
    return 1;
  }

  dispose(): void {
    this.teardown();
    this.clock.dispose();
    this.store.clear();
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.master = null;
    this.deviceGains.clear();
  }

  // ---- Internals -----------------------------------------------------------------

  private scheduleOpts() {
    return {
      driftCorrected: this.snapshot.driftCorrected,
      fps: this.fps,
      horizonAheadSec: AHEAD_SEC,
    };
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = this.createContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.snapshot.volume;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private deviceBus(device: string): GainNode {
    const ctx = this.ensureContext();
    let bus = this.deviceGains.get(device);
    if (!bus) {
      bus = ctx.createGain();
      bus.gain.value = this.gainFor(device);
      bus.connect(this.master!);
      this.deviceGains.set(device, bus);
    }
    return bus;
  }

  private applyGains(): void {
    if (this.master) this.master.gain.value = this.snapshot.volume;
    for (const [device, bus] of this.deviceGains) bus.gain.value = this.gainFor(device);
    this.publishHook();
  }

  /** Chunks worth holding, annotated with where they sound (eviction needs that). */
  private plan(tSec: number, aheadSec: number, behindSec: number): PlannedChunk[] {
    const opts = { ...this.scheduleOpts(), aheadSec, behindSec };
    const byFile = new Map(this.clips.map((c) => [c.file, c]));
    return planChunks(this.clips, tSec, opts).map((ref) => {
      const clip = byFile.get(ref.file)!;
      const span = chunkTimelineSpan(clipTransport(clip, opts), ref.chunkIndex);
      return { ...ref, startSec: span.startSec, endSec: span.endSec };
    });
  }

  private topUp(): void {
    if (!this.snapshot.playing) return;
    const t = this.clock.currentTime;
    const generation = this.generation;
    void this.store.ensure(this.plan(t, AHEAD_SEC, BEHIND_SEC), t).then(() => {
      if (generation !== this.generation) return;
      this.scheduleResident();
    });
  }

  /**
   * Start every resident-but-not-yet-started source.
   *
   * Recomputed against `playStartSec` — the position `base` corresponds to — not against
   * the moving playhead, so an entry's absolute instant (`base + whenOffset`) is the same
   * number on every pass. That is what lets this run once a second without any risk of
   * the same chunk being scheduled twice at two different times.
   */
  private scheduleResident(): void {
    if (!this.snapshot.playing || !this.ctx) return;
    const ctx = this.ctx;
    const entries = computeSchedule(
      this.clips,
      this.playStartSec,
      this.store,
      this.scheduleOpts(),
    );

    for (const entry of entries) {
      const key = chunkKey(entry.file, entry.chunkIndex);
      if (this.sources.has(key)) continue;

      // A chunk that arrived after its moment: skip the elapsed part rather than play it
      // late (an echo) or drop it (a gap).
      const late = ctx.currentTime - (this.base + entry.whenOffsetSec);
      const aimed = catchUp(entry, late);
      if (!aimed) continue;

      const samples = this.store.get(entry.file, entry.chunkIndex);
      if (!samples || samples.length === 0) continue;

      const buffer = ctx.createBuffer(1, samples.length, ANALYSIS_RATE);
      buffer.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = aimed.rate;
      src.connect(this.deviceBus(entry.device));

      // The buffer may be shorter than the schedule believed (a short final chunk);
      // `start` throws nothing for that, it simply ends early — but clamping keeps the
      // hook honest about what was actually asked for.
      const available = samples.length / ANALYSIS_RATE - aimed.sourceOffsetSec;
      const duration = Math.min(aimed.sourceDurationSec, available);
      if (duration <= 0) continue;

      src.start(this.base + aimed.whenOffsetSec, aimed.sourceOffsetSec, duration);
      src.onended = () => {
        try {
          src.disconnect();
        } catch {
          // Already torn down.
        }
        this.sources.delete(key);
      };
      this.sources.set(key, src);
    }
    this.publishHook();
  }

  /** Stop and forget every source, and invalidate anything in flight. */
  private teardown(): void {
    this.generation += 1;
    if (this.topup) {
      clearInterval(this.topup);
      this.topup = null;
    }
    if (this.seekTimer) {
      clearTimeout(this.seekTimer);
      this.seekTimer = null;
    }
    for (const src of this.sources.values()) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // Never started, or already stopped.
      }
      try {
        src.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.sources.clear();
    this.snapshot = { ...this.snapshot, playing: false, buffering: false };
  }

  private publish(): void {
    this.snapshot = {
      ...this.snapshot,
      ready: this.clips.length > 0,
      durationSec: timelineDurationSec(this.clips, this.scheduleOpts()),
      muted: [...this.muted],
      soloed: [...this.soloed],
      deadFiles: this.store.deadFiles(),
    };
    for (const listener of this.listeners) listener();
    this.publishHook();
  }

  private publishHook(): void {
    if (typeof window === "undefined") return;
    const scheduled: AudioHookEntry[] = [];
    if (this.snapshot.playing) {
      for (const entry of computeSchedule(
        this.clips,
        this.playStartSec,
        this.store,
        this.scheduleOpts(),
      )) {
        if (!this.sources.has(chunkKey(entry.file, entry.chunkIndex))) continue;
        scheduled.push(hookEntry(entry, this.base, this.gainFor(entry.device)));
      }
    }
    window.__SUNDAYSYNC_AUDIO__ = {
      generation: this.generation,
      baseCtxTime: this.base,
      playStartSec: this.playStartSec,
      playing: this.snapshot.playing,
      buffering: this.snapshot.buffering,
      scheduled,
      deviceGains: Object.fromEntries(
        [...new Set([...this.deviceGains.keys(), ...this.clips.map((c) => c.device)])].map(
          (d) => [d, this.gainFor(d)],
        ),
      ),
      masterGain: this.snapshot.volume,
      deadFiles: this.store.deadFiles(),
    };
  }
}

function hookEntry(entry: ScheduledSource, base: number, gain: number): AudioHookEntry {
  return {
    file: entry.file,
    device: entry.device,
    chunkIndex: entry.chunkIndex,
    when: base + entry.whenOffsetSec,
    whenOffset: entry.whenOffsetSec,
    offset: entry.sourceOffsetSec,
    duration: entry.sourceDurationSec,
    rate: entry.rate,
    gain,
  };
}

let engine: PlaybackEngine | null = null;

/** The app's single playback engine — one AudioContext, one clock, one graph. */
export function getPlaybackEngine(): PlaybackEngine {
  if (!engine) engine = new PlaybackEngine();
  return engine;
}
