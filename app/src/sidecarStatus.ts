/**
 * Presentation mapping for `SidecarStatus` (§E1 bundled-ffmpeg) — pulled out of
 * `Onboarding.tsx` so the bundled/system-path wording is unit-testable without a DOM,
 * and reusable from `SettingsPanel.tsx`.
 */

import type { Strings } from "./i18n";
import type { SidecarStatus } from "./types";

export interface SidecarDescription {
  /** Status-chip / one-line label. */
  label: string;
  /** Filesystem path the engine was found at — only set when `source === "system"`. */
  path: string | null;
}

export function describeSidecar(status: SidecarStatus, t: Strings): SidecarDescription {
  if (status.source === "bundled") {
    return { label: t.obFfmpegBundled, path: null };
  }
  return { label: t.obFfmpegSystem, path: status.path };
}
