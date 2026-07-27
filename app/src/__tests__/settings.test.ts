import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULTS,
  parseMinPsrInput,
  reloadSettingsForTest,
  saveSettingsNow,
} from "../settings";

const KEY = "sundaysync.settings.v1";

describe("settings persistence (D-029)", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadSettingsForTest();
  });

  it("starts from defaults with empty storage", () => {
    expect(reloadSettingsForTest()).toEqual(DEFAULTS);
  });

  it("round-trips a patch", () => {
    saveSettingsNow({ minPsr: 20, lang: "en", onboardingDone: true });
    const loaded = reloadSettingsForTest();
    expect(loaded.minPsr).toBe(20);
    expect(loaded.lang).toBe("en");
    expect(loaded.onboardingDone).toBe(true);
    expect(loaded.segmentCount).toBeNull();
  });

  it("degrades corrupt JSON to defaults instead of crashing", () => {
    localStorage.setItem(KEY, "{not json");
    expect(reloadSettingsForTest()).toEqual(DEFAULTS);
  });

  it("validates field by field — one bad field does not discard the rest", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ lang: "de", minPsr: -3, segmentCount: 7, onboardingDone: true }),
    );
    const loaded = reloadSettingsForTest();
    expect(loaded.lang).toBeNull(); // "de" is not a Lang
    expect(loaded.minPsr).toBeNull(); // negative rejected
    expect(loaded.segmentCount).toBe(7); // valid field survives
    expect(loaded.onboardingDone).toBe(true);
  });
});

describe("parseMinPsrInput — the old `Number(v) || null` bug", () => {
  it("empty means engine default, and is VALID", () => {
    expect(parseMinPsrInput("")).toEqual({ ok: true, value: null });
    expect(parseMinPsrInput("   ")).toEqual({ ok: true, value: null });
  });

  it("zero and negatives are INVALID, not silently snapped to 15", () => {
    expect(parseMinPsrInput("0")).toEqual({ ok: false });
    expect(parseMinPsrInput("-5")).toEqual({ ok: false });
  });

  it("garbage is invalid", () => {
    expect(parseMinPsrInput("femten")).toEqual({ ok: false });
  });

  it("a real number commits", () => {
    expect(parseMinPsrInput("22.5")).toEqual({ ok: true, value: 22.5 });
  });
});
