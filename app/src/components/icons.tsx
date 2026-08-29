/** Inline SVG icons — theme-token coloured via currentColor, no icon font to load. */

import type { ReactNode } from "react";

export function CameraIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M16 10.5 22 7v10l-6-3.5" />
    </svg>
  );
}

export function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
    </svg>
  );
}

export function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1L12 2z" />
    </svg>
  );
}

/**
 * The two primary verbs, drawn (V06-G3, D-092).
 *
 * 16 px, 1.75 stroke, `currentColor`, `round` caps — the same hand as `GearIcon` above, one
 * step lighter because these sit inside a filled gold button and a 2 px stroke on 16 px reads
 * as a smudge at that contrast. They mark the two controls the whole app exists for, and they
 * are the only two buttons on the strip that get one: an icon on every control is decoration,
 * an icon on the one you are heading for is a landmark.
 */
function verbIcon(children: ReactNode) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="btnicon"
    >
      {children}
    </svg>
  );
}

/** Synkroniser / «Synk på nytt» — two arrows chasing each other round a circle. Deliberately
 *  the SAME glyph for both: re-syncing is the same act, done again. */
export function SyncIcon() {
  return verbIcon(
    <>
      <path d="M20.5 9A8.5 8.5 0 0 0 5.4 6.1L3.5 8" />
      <path d="M3.5 15A8.5 8.5 0 0 0 18.6 17.9l1.9-1.9" />
      <path d="M3.5 3.5V8H8" />
      <path d="M20.5 20.5V16H16" />
    </>,
  );
}

/** Eksporter — an arrow rising out of a tray. Up and OUT of the app, which is what an export
 *  is; a download's arrow points the other way and would say the opposite. */
export function ExportIcon() {
  return verbIcon(
    <>
      <path d="M12 15V3.5" />
      <path d="M8 7.5 12 3.5l4 4" />
      <path d="M4 14v4.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V14" />
    </>,
  );
}

/**
 * The footnote marker (V06-G3, D-092, slot demotions). A claim that is true, worth keeping and
 * not worth a sentence: the glyph says "there is more here", the two words beside it say which
 * more, and the `title` on the element carries the whole of it.
 */
export function InfoIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      className="glyph"
    >
      <circle cx="12" cy="12" r="9.25" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </svg>
  );
}

/** The export receipt's tick (D-092 ⑤). Green by the class it is given, not by its own fill. */
export function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="glyph"
    >
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

/** The onboarding hero: two offset waveforms converging — the product in one image. */
export function SyncArt() {
  return (
    <svg width="180" height="72" viewBox="0 0 180 72" fill="none" aria-hidden="true" className="onboarding__art">
      <path
        d="M8 22 Q 26 6, 44 22 T 80 22 T 116 22 T 152 22 T 172 22"
        stroke="currentColor"
        strokeOpacity="0.4"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M8 50 Q 26 34, 44 50 T 80 50 T 116 50 T 152 50 T 172 50"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path d="M90 30v12M90 42l-4-4M90 42l4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
