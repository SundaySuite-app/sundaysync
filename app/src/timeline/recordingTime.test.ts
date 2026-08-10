import { describe, it, expect } from "vitest";
import { recordingTimes, PLAUSIBLE_SPREAD_MS } from "./recordingTime";
import type { FileEntry } from "../types";

// The recording-time ladder (V05-W3, D-067).
//
// Every fixture here is a shape that was MEASURED on the owner's 386-file wedding drop,
// because the whole decision rests on what those files actually carry. `TZ` is pinned to
// Europe/Oslo by `vitest.config.ts`: a container stamp is UTC and a BWF's date + clock is
// local wall time, and on a machine set to UTC those two are indistinguishable — the tests
// would pass while the app was two hours wrong for the people it is for.

const OSLO_SUMMER_OFFSET_MS = 2 * 60 * 60 * 1000;

function file(over: Partial<FileEntry> & { file: string }): FileEntry {
  return {
    device: "dev",
    duration_seconds: 60,
    format_name: "wav",
    audio: { codec: "pcm_s16le", sample_rate: 48000, channels: 2 },
    video: null,
    creation_time: null,
    date_tag: null,
    modified_time: null,
    ...over,
  };
}

function at(files: FileEntry[], path: string) {
  const found = recordingTimes(files).get(path);
  if (!found) throw new Error(`no entry for ${path}`);
  return found;
}

describe("the TZ this suite reasons in", () => {
  it("is a zone with a real offset, or every local-vs-UTC assertion below is vacuous", () => {
    // The guard on the guard. If someone drops `env.TZ` from vitest.config.ts, this fails
    // loudly instead of the local/UTC tests silently becoming tautologies.
    expect(new Date(Date.UTC(2026, 6, 25, 12, 0, 0)).getHours()).toBe(14);
  });
});

// ── Rung 1: the container ───────────────────────────────────────────────────────────────

describe("rung 1 — a full ISO datetime in the container", () => {
  it("reads a Fujifilm's UTC stamp as UTC", () => {
    const files = [file({ file: "/f/DSCF6408.MOV", creation_time: "2026-07-25T20:41:12Z" })];
    expect(at(files, "/f/DSCF6408.MOV")).toEqual({
      startMs: Date.UTC(2026, 6, 25, 20, 41, 12),
      source: "container",
    });
  });

  it("reads a zoneless container stamp as UTC too, not as the operator's local time", () => {
    // Some containers omit the `Z`. `Date.parse`'s own rule for a zoneless datetime is
    // LOCAL, which would silently shift such a file by the operator's offset.
    const files = [
      file({ file: "/a.MOV", creation_time: "2026-07-25T20:41:12" }),
      file({ file: "/b.MOV", creation_time: "2026-07-25T20:41:12Z" }),
    ];
    expect(at(files, "/a.MOV").startMs).toBe(at(files, "/b.MOV").startMs);
  });

  it("does NOT accept a bare time of day as a datetime", () => {
    // The Zoom F6's `creation_time` really is `16:12:29`. A guard written as "does
    // Date.parse like it?" would be one forgiving engine away from reading a time of day
    // as a date — so the date part is required explicitly.
    const files = [file({ file: "/z.WAV", creation_time: "16:12:29" })];
    expect(at(files, "/z.WAV").source).not.toBe("container");
  });

  it("treats an unparseable stamp as no stamp", () => {
    const files = [file({ file: "/a.MOV", creation_time: "not a date" })];
    expect(at(files, "/a.MOV")).toEqual({ startMs: null, source: "none" });
  });
});

// ── Rung 2: a BWF's date + clock ────────────────────────────────────────────────────────

describe("rung 2 — a BWF whose timestamp arrives in two halves", () => {
  it("combines `date` + `creation_time` as LOCAL wall time", () => {
    // Measured: `260725_001_Tr1.WAV` carries date=2026-07-25 and creation_time=16:12:29.
    // 16:12 was the time on the recorder's front panel, so in July in Norway that is
    // 14:12 UTC — two hours from what a naive `Date.parse(date + "T" + time + "Z")` gives.
    const files = [
      file({
        file: "/z/260725_001.TAKE/260725_001_Tr1.WAV",
        date_tag: "2026-07-25",
        creation_time: "16:12:29",
      }),
    ];
    const got = at(files, "/z/260725_001.TAKE/260725_001_Tr1.WAV");
    expect(got.source).toBe("bwf");
    expect(got.startMs).toBe(Date.UTC(2026, 6, 25, 16, 12, 29) - OSLO_SUMMER_OFFSET_MS);
  });

  it("finds the date in a folder name when there is no `date` tag", () => {
    const files = [
      file({ file: "/z/260725_003.TAKE/tr1.wav", creation_time: "16:12:29" }),
    ];
    const got = at(files, "/z/260725_003.TAKE/tr1.wav");
    expect(got.source).toBe("bwf");
    expect(new Date(got.startMs ?? 0).getFullYear()).toBe(2026);
    expect(new Date(got.startMs ?? 0).getDate()).toBe(25);
  });

  it("falls back to the day the timestamped files agree on", () => {
    const files = [
      file({ file: "/f/A.MOV", creation_time: "2026-07-25T12:00:00Z" }),
      file({ file: "/f/B.MOV", creation_time: "2026-07-25T13:00:00Z" }),
      // No date anywhere: not in a tag, not in the name, not in a folder.
      file({ file: "/z/tr1.wav", creation_time: "16:12:29" }),
    ];
    const got = at(files, "/z/tr1.wav");
    expect(got.source).toBe("bwf");
    expect(got.startMs).toBe(Date.UTC(2026, 6, 25, 16, 12, 29) - OSLO_SUMMER_OFFSET_MS);
  });

  it("gives up rather than inventing a day when there is nothing to borrow one from", () => {
    const files = [file({ file: "/z/tr1.wav", creation_time: "16:12:29" })];
    expect(at(files, "/z/tr1.wav")).toEqual({ startMs: null, source: "none" });
  });
});

// ── Rung 3: a timestamp spelled into the filename ───────────────────────────────────────

describe("rung 3 — a timestamp in the filename", () => {
  it("reads the mixer's `uirec-YYYYMMDD_HHMMSS` as local wall time", () => {
    const files = [file({ file: "/m/uirec-20260725_125533.wav" })];
    const got = at(files, "/m/uirec-20260725_125533.wav");
    expect(got.source).toBe("filename");
    expect(got.startMs).toBe(Date.UTC(2026, 6, 25, 12, 55, 33) - OSLO_SUMMER_OFFSET_MS);
  });

  it("reads a six-digit `YYMMDD_HHMMSS` too", () => {
    const files = [file({ file: "/m/260725_125533.wav" })];
    const got = at(files, "/m/260725_125533.wav");
    expect(got.source).toBe("filename");
    expect(new Date(got.startMs ?? 0).getFullYear()).toBe(2026);
  });

  it("does not slice a longer digit run into a false date", () => {
    // `/(\d{8})[_-](\d{6})/` would happily take the last eight digits of a nine-digit run.
    const files = [file({ file: "/m/123456789_012345.wav" })];
    expect(at(files, "/m/123456789_012345.wav").source).toBe("none");
  });

  it("refuses an impossible clock rather than wrapping it", () => {
    const files = [file({ file: "/m/20260725_996060.wav" })];
    expect(at(files, "/m/20260725_996060.wav").source).toBe("none");
  });
});

// ── Six-digit disambiguation, measured on this corpus ───────────────────────────────────

describe("six digits are a date twice over", () => {
  it("defaults to YYMMDD, which is what the corpus actually writes", () => {
    // `260725` sits beside the same recorder's own `date=2026-07-25` and beside the Fuji's
    // ISO `2026-07-25`. YYMMDD reproduces both; DDMMYY would read 2025-07-26 and matches
    // nothing in the drop.
    const files = [file({ file: "/m/260725_120000.wav" })];
    const got = at(files, "/m/260725_120000.wav");
    expect(new Date(got.startMs ?? 0).getFullYear()).toBe(2026);
    expect(new Date(got.startMs ?? 0).getMonth()).toBe(6);
    expect(new Date(got.startMs ?? 0).getDate()).toBe(25);
  });

  it("takes DDMMYY when YYMMDD is not a real date at all", () => {
    // `310745`: as YYMMDD that is 2031-07-45, and there is no 45th of July. As DDMMYY it is
    // the 31st of July 2045. Only one reading survives, so no evidence is needed.
    const files = [file({ file: "/m/310745_120000.wav" })];
    const got = at(files, "/m/310745_120000.wav");
    expect(got.source).toBe("filename");
    expect(new Date(got.startMs ?? 0).getFullYear()).toBe(2045);
    expect(new Date(got.startMs ?? 0).getDate()).toBe(31);
  });

  it("keeps the measured reading when both are real and nothing can decide", () => {
    // `311226` is 2031-12-26 as YYMMDD and 2026-12-31 as DDMMYY. With no timestamped files
    // in the drop there is nothing to compare against, and the corpus-measured default
    // stands rather than a coin being tossed.
    const files = [file({ file: "/m/311226_120000.wav" })];
    expect(new Date(at(files, "/m/311226_120000.wav").startMs ?? 0).getFullYear()).toBe(2031);
  });

  it("refuses a token that is not a date under either reading", () => {
    const files = [file({ file: "/m/999999_120000.wav" })];
    expect(at(files, "/m/999999_120000.wav").source).toBe("none");
  });

  it("lets the timestamped files decide when both readings are real days", () => {
    // `311226` is 2031-12-26 as YYMMDD and 2026-12-31 as DDMMYY. With the drop's own
    // container stamps sitting in December 2026, the second reading is the one nearer the
    // session, and the ambiguity is resolved by evidence rather than by the default.
    const files = [
      file({ file: "/f/A.MOV", creation_time: "2026-12-31T10:00:00Z" }),
      file({ file: "/f/B.MOV", creation_time: "2026-12-31T11:00:00Z" }),
      file({ file: "/m/311226_120000.wav" }),
    ];
    const got = at(files, "/m/311226_120000.wav");
    expect(got.source).toBe("filename");
    expect(new Date(got.startMs ?? 0).getFullYear()).toBe(2026);
    expect(new Date(got.startMs ?? 0).getMonth()).toBe(11);
    expect(new Date(got.startMs ?? 0).getDate()).toBe(31);
  });
});

// ── Rung 4: the mtime, which is the END of the write ────────────────────────────────────

describe("rung 4 — the mtime, minus the duration", () => {
  it("subtracts the duration, because the mtime is when the write FINISHED", () => {
    // Measured across the owner's 136 `.MTS` files and consistent to the second: `02106`
    // has mtime 14:12:08 for a 30.72 s clip, `02107` has 14:12:58 for an 11 s one.
    const files = [
      file({
        file: "/j/02106.MTS",
        modified_time: "2026-07-25T12:12:08Z",
        duration_seconds: 30.72,
      }),
    ];
    const got = at(files, "/j/02106.MTS");
    expect(got.source).toBe("modified");
    expect(got.startMs).toBe(Date.UTC(2026, 6, 25, 12, 12, 8) - 30_720);
  });

  it("is used only when no container tag says anything", () => {
    const files = [
      file({
        file: "/f/A.MOV",
        creation_time: "2026-07-25T12:00:00Z",
        modified_time: "2026-07-25T18:00:00Z",
      }),
    ];
    expect(at(files, "/f/A.MOV").source).toBe("container");
  });

  it("survives a file with no duration rather than producing NaN", () => {
    const files = [
      file({ file: "/j/x.MTS", modified_time: "2026-07-25T12:00:00Z", duration_seconds: 0 }),
    ];
    expect(at(files, "/j/x.MTS").startMs).toBe(Date.UTC(2026, 6, 25, 12, 0, 0));
  });
});

// ── The whole ladder, on a miniature of the real drop ───────────────────────────────────

describe("the five rungs together", () => {
  const drop = (): FileEntry[] => [
    file({
      file: "/01_FILM/FUJI/DSCF6408.MOV",
      device: "fuji",
      creation_time: "2026-07-25T20:41:12Z",
    }),
    file({
      file: "/01_FILM/JOHNNY/02106.MTS",
      device: "johnny",
      modified_time: "2026-07-25T12:12:08Z",
      duration_seconds: 30.72,
    }),
    file({
      file: "/02_LYD/F6/260725_001.TAKE/260725_001_Tr1.WAV",
      device: "f6",
      date_tag: "2026-07-25",
      creation_time: "16:12:29",
    }),
    file({
      file: "/02_LYD/MIKSER/uirec-20260725_125533.wav",
      device: "mikser",
    }),
    file({
      file: "/02_LYD/F2/200101_001.WAV",
      device: "f2",
      date_tag: "2020-01-01",
      creation_time: "00:01:58",
    }),
    file({
      file: "/01_FILM/DRONE/DJI_0075.MP4",
      device: "drone",
      creation_time: "2023-06-13T20:43:05Z",
    }),
  ];

  it("places one file per rung and demotes the two that belong to other days", () => {
    const times = recordingTimes(drop());
    const source = (f: string) => times.get(f)?.source;
    expect(source("/01_FILM/FUJI/DSCF6408.MOV")).toBe("container");
    expect(source("/01_FILM/JOHNNY/02106.MTS")).toBe("modified");
    expect(source("/02_LYD/F6/260725_001.TAKE/260725_001_Tr1.WAV")).toBe("bwf");
    expect(source("/02_LYD/MIKSER/uirec-20260725_125533.wav")).toBe("filename");
    // The dead clock and the June drone folder: both timestamped, neither in this session.
    expect(source("/02_LYD/F2/200101_001.WAV")).toBe("none");
    expect(source("/01_FILM/DRONE/DJI_0075.MP4")).toBe("none");
  });

  it("keeps the rejected stamps so the UI can name the date they claim", () => {
    const times = recordingTimes(drop());
    const dead = times.get("/02_LYD/F2/200101_001.WAV");
    const drone = times.get("/01_FILM/DRONE/DJI_0075.MP4");
    expect(dead?.outsideWindowMs).toBeDefined();
    expect(new Date(dead?.outsideWindowMs ?? 0).getFullYear()).toBe(2020);
    expect(new Date(drone?.outsideWindowMs ?? 0).getFullYear()).toBe(2023);
    // …and a file that never had a stamp is NOT marked as outside anything.
    const nothing = recordingTimes([file({ file: "/x/quiet.wav" })]).get("/x/quiet.wav");
    expect(nothing).toEqual({ startMs: null, source: "none" });
  });

  it("puts the four placed files in the order the day actually ran", () => {
    const times = recordingTimes(drop());
    const ms = (f: string) => times.get(f)?.startMs ?? 0;
    // The mixer's `125533` is 12:55 on the wall, i.e. 10:55 UTC, so it is FIRST — earlier
    // than the AVCHD camera's 12:12 UTC mtime. The Zoom's 16:12 on the wall is 14:12 UTC,
    // and the Fuji's stamp is 20:41 UTC as written. This ordering is only correct if the
    // local and UTC doors are the ones the module says they are; a single-door version
    // puts the mixer and the Zoom two hours out and reorders the day.
    const ordered = [
      "/02_LYD/MIKSER/uirec-20260725_125533.wav",
      "/01_FILM/JOHNNY/02106.MTS",
      "/02_LYD/F6/260725_001.TAKE/260725_001_Tr1.WAV",
      "/01_FILM/FUJI/DSCF6408.MOV",
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(ms(ordered[i])).toBeGreaterThan(ms(ordered[i - 1]));
    }
  });
});

// ── The session gate, now over the ladder's output ──────────────────────────────────────

describe("the session gate", () => {
  it("admits an mtime that lands BEFORE the earliest container stamp", () => {
    // The reason the gate grows a window rather than testing against a hull: on the owner's
    // drop the AVCHD camera's first clip starts an hour before the first Fuji clip, and a
    // hull test would have thrown away 136 correctly-timed files.
    const files = [
      file({ file: "/f/A.MOV", creation_time: "2026-07-25T13:00:00Z" }),
      file({ file: "/f/B.MOV", creation_time: "2026-07-25T22:00:00Z" }),
      file({ file: "/j/1.MTS", modified_time: "2026-07-25T12:00:00Z", duration_seconds: 60 }),
    ];
    expect(at(files, "/j/1.MTS").source).toBe("modified");
  });

  it("demotes a stamp that would stretch the drop past a day", () => {
    const files = [
      file({ file: "/f/A.MOV", creation_time: "2026-07-25T13:00:00Z" }),
      file({ file: "/f/B.MOV", creation_time: "2026-07-25T22:00:00Z" }),
      file({ file: "/m/uirec-20260724_141546.wav" }),
    ];
    const got = at(files, "/m/uirec-20260724_141546.wav");
    expect(got.source).toBe("none");
    expect(got.outsideWindowMs).toBeDefined();
  });

  it("takes its reference from the highest tier that produced two stamps", () => {
    // No container stamps at all: the BWF pair is the most trustworthy corroboration there
    // is, and the mtime that disagrees with them by a year is the one that loses.
    const files = [
      file({ file: "/z/a.wav", date_tag: "2026-07-25", creation_time: "16:00:00" }),
      file({ file: "/z/b.wav", date_tag: "2026-07-25", creation_time: "17:00:00" }),
      file({ file: "/j/1.MTS", modified_time: "2025-01-01T00:00:00Z" }),
    ];
    expect(at(files, "/z/a.wav").source).toBe("bwf");
    expect(at(files, "/j/1.MTS").source).toBe("none");
  });

  it("leaves a single stamped file alone — one clock cannot contradict itself", () => {
    const files = [file({ file: "/f/A.MOV", creation_time: "1970-01-01T00:00:00Z" })];
    expect(at(files, "/f/A.MOV").source).toBe("container");
  });

  it("keeps a whole session together, however long the session is", () => {
    const files = [
      file({ file: "/f/A.MOV", creation_time: "2026-08-09T08:00:00Z" }),
      file({ file: "/f/B.MOV", creation_time: "2026-08-09T14:00:00Z" }),
    ];
    expect(at(files, "/f/A.MOV").source).toBe("container");
    expect(at(files, "/f/B.MOV").source).toBe("container");
  });

  it("keeps the LATER of two equally-sized clusters — a broken clock reads early", () => {
    const files = [
      file({ file: "/f/A.MOV", creation_time: "2020-01-01T00:00:00Z" }),
      file({ file: "/f/B.MOV", creation_time: "2026-08-09T10:00:00Z" }),
    ];
    expect(at(files, "/f/A.MOV").source).toBe("none");
    expect(at(files, "/f/B.MOV").source).toBe("container");
  });

  it("admits everything inside exactly one spread and nothing past it", () => {
    const base = Date.UTC(2026, 6, 25, 12, 0, 0);
    const iso = (offset: number) => new Date(base + offset).toISOString();
    const files = [
      file({ file: "/f/A.MOV", creation_time: iso(0) }),
      file({ file: "/f/B.MOV", creation_time: iso(1000) }),
      file({ file: "/f/edge.MOV", creation_time: iso(PLAUSIBLE_SPREAD_MS) }),
      file({ file: "/f/past.MOV", creation_time: iso(PLAUSIBLE_SPREAD_MS + 2000) }),
    ];
    expect(at(files, "/f/edge.MOV").source).toBe("container");
    expect(at(files, "/f/past.MOV").source).toBe("none");
  });

  it("names two session days apart rather than silently merging them", () => {
    // Two shoots in one drop: the smaller day is demoted and keeps its stamp, so the UI
    // can say which date it belongs to. No file is deleted and no origin is invented.
    const files = [
      file({ file: "/f/A.MOV", creation_time: "2026-07-25T12:00:00Z" }),
      file({ file: "/f/B.MOV", creation_time: "2026-07-25T13:00:00Z" }),
      file({ file: "/f/C.MOV", creation_time: "2026-07-25T14:00:00Z" }),
      file({ file: "/g/D.MOV", creation_time: "2026-06-13T20:43:05Z" }),
    ];
    const stray = at(files, "/g/D.MOV");
    expect(stray.source).toBe("none");
    expect(new Date(stray.outsideWindowMs ?? 0).getUTCMonth()).toBe(5);
    expect(at(files, "/f/A.MOV").source).toBe("container");
  });

  it("is deterministic whatever order the manifest was walked in", () => {
    const files = [
      file({ file: "/f/A.MOV", creation_time: "2026-07-25T12:00:00Z" }),
      file({ file: "/f/B.MOV", creation_time: "2026-07-25T13:00:00Z" }),
      file({ file: "/g/D.MOV", creation_time: "2023-06-13T20:43:05Z" }),
    ];
    const forward = [...recordingTimes(files)].map(([f, t]) => `${f}:${t.source}`).sort();
    const backward = [...recordingTimes([...files].reverse())]
      .map(([f, t]) => `${f}:${t.source}`)
      .sort();
    expect(backward).toEqual(forward);
  });
});

// ── Midnight ────────────────────────────────────────────────────────────────────────────

describe("a date token that stood still while the recorder crossed midnight", () => {
  it("carries the day forward from the file that jumped backwards", () => {
    const files = [
      file({ file: "/z/260725_001.TAKE/a.wav", device: "f6", creation_time: "23:50:00" }),
      file({ file: "/z/260725_002.TAKE/a.wav", device: "f6", creation_time: "00:10:00" }),
      file({ file: "/z/260725_003.TAKE/a.wav", device: "f6", creation_time: "00:30:00" }),
    ];
    const times = recordingTimes(files);
    const day = (f: string) => new Date(times.get(f)?.startMs ?? 0).getDate();
    expect(day("/z/260725_001.TAKE/a.wav")).toBe(25);
    // …and the correction is cumulative: everything after the crossing is a day later too.
    expect(day("/z/260725_002.TAKE/a.wav")).toBe(26);
    expect(day("/z/260725_003.TAKE/a.wav")).toBe(26);
  });

  it("does not fire on a small backwards step inside one date", () => {
    // Two recorders' files interleaved on one device, a few minutes out of order, is not a
    // midnight crossing — and adding a day to them would be inventing one.
    const files = [
      file({ file: "/z/260725_001.TAKE/a.wav", device: "f6", creation_time: "12:30:00" }),
      file({ file: "/z/260725_002.TAKE/a.wav", device: "f6", creation_time: "12:10:00" }),
    ];
    const times = recordingTimes(files);
    expect(new Date(times.get("/z/260725_002.TAKE/a.wav")?.startMs ?? 0).getDate()).toBe(25);
  });

  it("is per device — one recorder's midnight is not another's", () => {
    const files = [
      file({ file: "/z/260725_001.TAKE/a.wav", device: "f6", creation_time: "23:50:00" }),
      file({ file: "/z/260725_002.TAKE/a.wav", device: "f6", creation_time: "00:10:00" }),
      file({ file: "/y/260725_001.TAKE/a.wav", device: "other", creation_time: "23:55:00" }),
    ];
    const times = recordingTimes(files);
    expect(new Date(times.get("/y/260725_001.TAKE/a.wav")?.startMs ?? 0).getDate()).toBe(25);
  });

  it("leaves container stamps and mtimes alone — those carry their own date", () => {
    const files = [
      file({ file: "/f/A.MOV", device: "f", creation_time: "2026-07-25T23:50:00Z" }),
      file({ file: "/f/B.MOV", device: "f", creation_time: "2026-07-25T00:10:00Z" }),
      file({ file: "/f/C.MOV", device: "f", creation_time: "2026-07-25T00:20:00Z" }),
    ];
    const times = recordingTimes(files);
    // B genuinely reads earlier than A; that is a disagreement for the gate to judge, not
    // a rollover to paper over. Both are inside one day, so both stand as written.
    expect(times.get("/f/B.MOV")?.startMs).toBe(Date.UTC(2026, 6, 25, 0, 10, 0));
  });
});

describe("recordingTimes accounts for every file it is given", () => {
  it("answers for a file even when nothing at all can be said about it", () => {
    const files = [file({ file: "/x/quiet.wav" }), file({ file: "/x/also.wav" })];
    const times = recordingTimes(files);
    expect(times.size).toBe(2);
    expect(times.get("/x/also.wav")).toEqual({ startMs: null, source: "none" });
  });

  it("answers an empty drop with an empty map", () => {
    expect(recordingTimes([]).size).toBe(0);
  });
});
