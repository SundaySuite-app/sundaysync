/**
 * Adapted from Clypra (MIT) — `src/core/playback/PlaybackClock.ts`.
 * Copyright (c) 2026 Clypra Contributors. Full licence text in THIRD-PARTY-NOTICES.
 *
 * The master playback clock: a continuous time *signal*, not React state.
 *
 * Three things are lifted from Clypra's version and are the reason this file exists at
 * all rather than being a `setInterval` someone wrote in an afternoon:
 *
 *   1. **The master clock is `AudioContext.currentTime`, never `performance.now()`.**
 *      The audio hardware's clock is the one the scheduled sources actually play against;
 *      any other clock drifts away from them, and the playhead slowly stops meaning what
 *      the ears hear. `time` is *computed* from it on every read, so it stays right even
 *      when requestAnimationFrame is throttled (a backgrounded window) instead of
 *      freezing at the last tick.
 *   2. **Generation counters on the RAF loop.** A seek is a pause→play cycle, and the
 *      already-queued RAF callback from *before* the seek will still fire afterwards. If
 *      it is allowed to run it publishes the old position, which reads on screen as the
 *      playhead snapping back for one frame. Every tick carries the generation it was
 *      scheduled under and returns if it no longer matches.
 *   3. **Stall compensation.** A synchronous block (decoding a pile of chunks into
 *      AudioBuffers, a GPU hiccup) consumes wall-clock time the audio clock keeps
 *      counting. Without `recordStallStart`/`compensateStall` the playhead jumps forward
 *      by the length of the stall and then has to be dragged back.
 *
 * Deliberately *not* lifted:
 *   - **Frame snapping.** Clypra is an editor and snaps its playhead to frame
 *     boundaries. SundaySync's whole claim is sub-frame accuracy (D-051's ruler goes to
 *     milliseconds), so quantising the clock to 1/25 s would hide exactly the error the
 *     operator opened the app to look for. Time here is milliseconds, unrounded.
 *   - **Playback speed.** There is no half-speed here: the point is to hear whether two
 *     recordings line up, and a rate change is one more thing that could be blamed.
 *   - **Owning the AudioContext.** Clypra's clock constructs its own. Here the scheduler
 *     owns it (it must be created inside the play gesture, and the sources have to be on
 *     the same one), and hands it in with [`PlaybackClock.attach`].
 */

import { publishPlayheadMs } from "../timeline/playhead";

export type PlaybackState = "playing" | "paused" | "stopped";

/** Where the clock publishes its position. Injectable so tests need no DOM. */
export type PublishFn = (ms: number) => void;

export class PlaybackClock {
  private time = 0;
  private state: PlaybackState = "stopped";
  private duration = 0;

  private ctx: AudioContext | null = null;
  private rafId: number | null = null;
  private playStartCtxTime = 0;
  private playStartClockTime = 0;

  /** Invalidates RAF ticks queued before the last play/pause/seek. */
  private generation = 0;
  private stallStartCtxTime: number | null = null;

  private readonly publish: PublishFn;
  private readonly onEnded: () => void;

  constructor(opts: { publish?: PublishFn; onEnded?: () => void } = {}) {
    this.publish = opts.publish ?? publishPlayheadMs;
    this.onEnded = opts.onEnded ?? (() => {});
  }

  /** The AudioContext whose `currentTime` is the master clock. */
  attach(ctx: AudioContext): void {
    this.ctx = ctx;
  }

  /** Timeline length in seconds; playback stops here. */
  setDuration(seconds: number): void {
    this.duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  }

  /**
   * The live position, seconds — computed from the audio clock rather than read from a
   * field, so it is correct between RAF ticks and while they are throttled.
   */
  get currentTime(): number {
    if (this.state === "playing" && this.ctx && this.ctx.state === "running") {
      const elapsed = this.ctx.currentTime - this.playStartCtxTime;
      return Math.min(this.playStartClockTime + elapsed, this.duration);
    }
    return this.time;
  }

  get playbackState(): PlaybackState {
    return this.state;
  }

  /**
   * Start running from `fromSeconds`, anchored to `baseCtxTime` — the *same* instant the
   * scheduler used as the origin for every `AudioBufferSourceNode.start()`. Passing it in
   * rather than reading `ctx.currentTime` here is what keeps the playhead and the audio
   * on one timeline: they are two readings of one number, not two clocks that agree at
   * first.
   */
  start(fromSeconds: number, baseCtxTime: number): void {
    if (!this.ctx) return;
    this.playStartCtxTime = baseCtxTime;
    this.playStartClockTime = fromSeconds;
    this.time = fromSeconds;
    this.state = "playing";

    this.generation += 1;
    const generation = this.generation;
    this.publish(fromSeconds * 1000);
    this.rafId = requestAnimationFrame(() => this.tick(generation));
  }

  /** Freeze at the live position (not the last tick's — that is up to 16 ms stale). */
  pause(): void {
    if (this.state === "playing") this.time = this.currentTime;
    this.state = "paused";
    this.generation += 1;
    this.cancelRaf();
    this.publish(this.time * 1000);
  }

  /** Pause and return to the start of the timeline. */
  stop(): void {
    this.state = "stopped";
    this.time = 0;
    this.generation += 1;
    this.cancelRaf();
    this.publish(0);
  }

  /**
   * Move the clock without starting it. The scheduler restarts playback itself if it was
   * playing, so this never does the pause→play dance Clypra's `seek` does — it just
   * parks a position, which removes the whole class of races that dance exists to guard.
   */
  seek(seconds: number): void {
    const valid = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    this.time = this.duration > 0 ? Math.min(valid, this.duration) : valid;
    this.state = this.state === "playing" ? "paused" : this.state;
    this.generation += 1;
    this.cancelRaf();
    this.publish(this.time * 1000);
  }

  /** Mark the start of a synchronous block that will eat wall-clock time. */
  recordStallStart(): void {
    if (this.state !== "playing" || !this.ctx) return;
    this.stallStartCtxTime = this.ctx.currentTime;
  }

  /**
   * Discount the wall-clock time a recorded stall consumed, so the playhead does not
   * jump. No-op when `recordStallStart` was never called.
   */
  compensateStall(): void {
    if (this.stallStartCtxTime === null || !this.ctx) {
      this.stallStartCtxTime = null;
      return;
    }
    const stalled = this.ctx.currentTime - this.stallStartCtxTime;
    if (stalled > 0 && this.state === "playing") this.playStartCtxTime += stalled;
    this.stallStartCtxTime = null;
  }

  dispose(): void {
    this.generation += 1;
    this.cancelRaf();
    this.state = "stopped";
    this.time = 0;
    this.ctx = null;
  }

  private cancelRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private tick(generation: number): void {
    // A tick queued before the last state change: publishing its position would show the
    // playhead jumping back to where it was before the seek for exactly one frame.
    if (generation !== this.generation) return;
    if (this.state !== "playing") return;

    const now = this.currentTime;
    this.time = now;
    this.publish(now * 1000);

    if (this.duration > 0 && now >= this.duration) {
      this.state = "paused";
      this.rafId = null;
      this.onEnded();
      return;
    }
    this.rafId = requestAnimationFrame(() => this.tick(generation));
  }
}
