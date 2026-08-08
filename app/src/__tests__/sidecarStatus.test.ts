import { describe, expect, it } from "vitest";
import { en, nb } from "../i18n";
import { describeSidecar } from "../sidecarStatus";

describe("describeSidecar (E1 bundled-ffmpeg)", () => {
  for (const [lang, t] of [
    ["nb", nb],
    ["en", en],
  ] as const) {
    it(`${lang}: bundled — label only, no path`, () => {
      const d = describeSidecar({ source: "bundled", path: "/Applications/SundaySync.app/.../ffmpeg" }, t);
      expect(d.label).toBe(t.obFfmpegBundled);
      expect(d.path).toBeNull();
    });

    it(`${lang}: system — label plus the reported path`, () => {
      const d = describeSidecar({ source: "system", path: "/opt/homebrew/bin/ffmpeg" }, t);
      expect(d.label).toBe(t.obFfmpegSystem);
      expect(d.path).toBe("/opt/homebrew/bin/ffmpeg");
      expect(t.obFfmpegSystemPath(d.path!)).toContain("/opt/homebrew/bin/ffmpeg");
    });
  }
});
