/**
 * Bilingual UI strings — docs/PLAN.md §9.
 *
 * Norwegian Bokmål is the default because these are Norwegian churches; English is there
 * so the app is usable by anyone else. Both dictionaries are the same shape, and the type
 * of `en` is derived from `nb`, so TypeScript fails the build if a key is added to one and
 * forgotten in the other. A half-translated UI is worse than an untranslated one.
 *
 * Everything user-visible lives here — including the progress-stage labels and the
 * engine-error texts that used to sit outside the dictionary in their own parallel
 * translation tables (D-030).
 */

export const nb = {
  appName: "SundaySync",

  // Empty state / drop zone (§9.1)
  dropTitle: "Slipp inn alt fra opptaket",
  dropHint: "video, lyd, hele mapper",
  dropAction: "Velg filer",
  dropFolder: "Velg mappe",
  dropMore: "Slipp inn mer, eller",
  emptyFlow1: "Slipp inn opptak",
  emptyFlow2: "Synkroniser",
  emptyFlow3: "Åpne i Resolve",
  emptyExplain:
    "SundaySync finner ut når hvert klipp ble tatt opp ved å lytte på lyden — ingen tidskode nødvendig. Resultatet blir en ferdig synkronisert tidslinje for DaVinci Resolve.",

  // Sources view (§9.2)
  sourcesTitle: "Kilder",
  removeRoot: "Fjern",
  clearAll: "Tøm alt",
  scanningInputs: "Leser inn kildene …",
  fileCount: (n: number) => (n === 1 ? "1 fil" : `${n} filer`),
  cameraCount: (n: number) => (n === 1 ? "1 kamera" : `${n} kameraer`),
  recorderCount: (n: number) => (n === 1 ? "1 lydopptaker" : `${n} lydopptakere`),
  problemCount: (n: number) => (n === 1 ? "1 problemfil" : `${n} problemfiler`),
  deviceLabel: (id: string, label: string) =>
    id.startsWith("folder-") ? `Mappe: ${label}` : label,
  moveToDevice: "Flytt til enhet",
  makeReference: "Bruk som referanse",
  isReference: "Referanse",
  autoReference: "Referanse velges automatisk (lengste opptak)",

  // Sync & progress (§9.3)
  syncButton: "Synkroniser",
  resyncButton: "Synkroniser på nytt",
  resyncHint: "bufret analyse gjenbrukes",
  syncing: "Synkroniserer",
  cancel: "Avbryt",
  cancelling: "Avbryter …",
  stageScanning: "Leser filer",
  stageProbing: "Undersøker media",
  stageExtracting: "Henter ut lyd",
  stageCorrelating: "Sammenligner lyd",
  stagePlacing: "Plasserer klipp",
  stageMeasuringDrift: "Måler drift",

  // Result view (§9.4)
  unsyncedTitle: "Ikke synkronisert",
  reference: "Referanse",
  staleResult: "Kildene er endret siden forrige synkronisering.",
  sequenceMeta: (fps: string, duration: string) => `${fps} bilder/sek · ${duration}`,
  offsetLabel: "Posisjon",
  confidence: "Sikkerhet",
  driftLabel: "Drift",
  psrLabel: "Signalstyrke",
  psrVsThreshold: (psr: string, min: string) => `${psr} (terskel ${min})`,
  viaChain: (name: string) => `Plassert via ${name}`,
  directMatch: "Plassert direkte mot referansen",
  projectedEndError: (ms: number) =>
    `Beregnet avvik ved klippslutt: ${Math.abs(ms).toFixed(0)} ms`,
  clipDetails: "Klippdetaljer",
  emptyLane: "Ingen klipp plassert",

  // Warnings (§5 Warning enum)
  drift: (ms: number) =>
    `Dette klippet driver ${Math.abs(ms).toFixed(0)} ms over lengden. Automatisk driftkorreksjon kommer i en senere versjon.`,
  metadataMismatch: "Tidsstempelet i fila stemmer ikke med lyden. Lyden er lagt til grunn.",
  mixedFps: "Klippene har ulik bildefrekvens.",
  frameSnap: "Plasseringen er rundet til nærmeste bilde.",

  // Unsynced reasons (§5 UnsyncedReason enum)
  reasonLowConfidence: "Fant ikke sikkert nok treff i lyden",
  reasonNoAudio: "Ingen lyd i fila",
  reasonDecodeError: "Kunne ikke leses",
  reasonDeviceOverlap: "Overlapper et annet klipp fra samme enhet",

  // Export (§9.5)
  exportButton: "Eksporter til DaVinci Resolve",
  exportHint: "Importer fila i Resolve med Fil → Importer → Tidslinje.",
  exported: (n: number) => (n === 1 ? "Eksporterte 1 klipp" : `Eksporterte ${n} klipp`),
  projectName: "Prosjektnavn",
  revealInFinder: "Vis i Finder",

  // Engine errors (D-030 — mapped from stable Display prefixes in errors.ts)
  errNoInput: "Ingen filer å synkronisere.",
  errSidecar:
    "Finner ikke ffmpeg. Installer det (f.eks. «brew install ffmpeg») og prøv igjen.",
  errIo: (path: string) => `Kunne ikke lese ${path}.`,
  errInvariant: (detail: string) =>
    `Intern feil — dette er en programfeil, ikke et problem med filene dine. (${detail})`,
  errUnknown: (raw: string) => `Noe gikk galt: ${raw}`,
  noticeCancelled: "Avbrutt. Ingenting er endret.",

  // Settings
  settings: "Innstillinger",
  language: "Språk",
  minPsr: "Terskel for treff",
  minPsrHint:
    "Lavere verdi gir flere treff, men øker risikoen for feil. Klipp under terskelen blir rapportert som ikke synkronisert i stedet for å bli plassert på slump. Tom = standard (15).",
  minPsrInvalid: "Må være et tall over 0, eller tomt for standard.",
  segmentCount: "Segmenter per klipp",
  segmentCountHint:
    "Hvor mange utsnitt av hvert klipp som sammenlignes med referansen. Flere segmenter gir sikrere driftmåling på lange klipp, men tar lengre tid.",
  segmentDefault: "5 (standard)",
  cacheDir: "Mappe for analyse-buffer",
  cacheHint:
    "Bufferen gjør ny synkronisering nesten øyeblikkelig. Den bruker ca. 170 MB per time lyd og tømmes ikke automatisk.",
  cachePick: "Velg mappe",
  cacheUsage: (entries: number, size: string) =>
    entries === 1 ? `1 oppføring · ${size}` : `${entries} oppføringer · ${size}`,
  cacheClear: "Tøm buffer",
  cacheClearConfirm: "Tømme bufferen? Neste synkronisering må analysere alt på nytt.",
  cacheCleared: (size: string) => `Frigjorde ${size}.`,
  showOnboarding: "Vis introduksjon igjen",
  diagnostics: "Eksporter diagnostikk",
  diagnosticsHint: "Inneholder logg og resultat — ingen mediefiler.",
  diagnosticsSaved: "Diagnostikk lagret.",
  close: "Lukk",

  // Onboarding
  obSkip: "Hopp over",
  obBack: "Tilbake",
  obNext: "Neste",
  obDone: "Kom i gang",
  obStep: (n: number, total: number) => `Steg ${n} av ${total}`,
  obTitle1: "Synkroniser flerkameraopptak på sekunder",
  obBody1:
    "Slipp inn alt fra opptaket — kameraer, lydopptaker, hele mapper. SundaySync lytter på lyden, finner ut når hvert klipp ble tatt opp, og lager en ferdig synkronisert tidslinje for DaVinci Resolve. Ingen tidskode nødvendig, og alt skjer lokalt på din maskin.",
  obTitle2: "Tips for best resultat",
  obBody2:
    "Ta med sporet fra mikser eller lydopptaker — det blir referansen alle kameraene festes til. Mapper du har organisert per kamera blir automatisk egne enheter. Klipp appen ikke er sikker på, blir ærlig rapportert i stedet for å bli plassert på slump.",
  obTitle3: "Én ting må være på plass",
  obBody3:
    "SundaySync bruker ffmpeg til å lese mediefiler. Det er gratis og installeres én gang.",
  obFfmpegOk: "ffmpeg er klart",
  obFfmpegMissing: "ffmpeg ble ikke funnet",
  obFfmpegHow: "Installer med Homebrew:",
  obCheckAgain: "Sjekk igjen",
};

export type Strings = typeof nb;

export const en: Strings = {
  appName: "SundaySync",

  dropTitle: "Drop in everything from the shoot",
  dropHint: "video, audio, whole folders",
  dropAction: "Choose files",
  dropFolder: "Choose folder",
  dropMore: "Drop in more, or",
  emptyFlow1: "Drop in the shoot",
  emptyFlow2: "Sync",
  emptyFlow3: "Open in Resolve",
  emptyExplain:
    "SundaySync works out when every clip was recorded by listening to the audio — no timecode required. The result is a ready-synchronized timeline for DaVinci Resolve.",

  sourcesTitle: "Sources",
  removeRoot: "Remove",
  clearAll: "Clear all",
  scanningInputs: "Reading the sources …",
  fileCount: (n: number) => (n === 1 ? "1 file" : `${n} files`),
  cameraCount: (n: number) => (n === 1 ? "1 camera" : `${n} cameras`),
  recorderCount: (n: number) => (n === 1 ? "1 audio recorder" : `${n} audio recorders`),
  problemCount: (n: number) => (n === 1 ? "1 problem file" : `${n} problem files`),
  deviceLabel: (id: string, label: string) =>
    id.startsWith("folder-") ? `Folder: ${label}` : label,
  moveToDevice: "Move to device",
  makeReference: "Use as reference",
  isReference: "Reference",
  autoReference: "Reference is chosen automatically (longest recording)",

  syncButton: "Sync",
  resyncButton: "Sync again",
  resyncHint: "cached analysis is reused",
  syncing: "Syncing",
  cancel: "Cancel",
  cancelling: "Cancelling …",
  stageScanning: "Reading files",
  stageProbing: "Inspecting media",
  stageExtracting: "Extracting audio",
  stageCorrelating: "Comparing audio",
  stagePlacing: "Placing clips",
  stageMeasuringDrift: "Measuring drift",

  unsyncedTitle: "Not synced",
  reference: "Reference",
  staleResult: "The sources have changed since the last sync.",
  sequenceMeta: (fps: string, duration: string) => `${fps} fps · ${duration}`,
  offsetLabel: "Position",
  confidence: "Confidence",
  driftLabel: "Drift",
  psrLabel: "Signal strength",
  psrVsThreshold: (psr: string, min: string) => `${psr} (threshold ${min})`,
  viaChain: (name: string) => `Placed via ${name}`,
  directMatch: "Placed directly against the reference",
  projectedEndError: (ms: number) =>
    `Projected error at clip end: ${Math.abs(ms).toFixed(0)} ms`,
  clipDetails: "Clip details",
  emptyLane: "No clips placed",

  drift: (ms: number) =>
    `This clip drifts ${Math.abs(ms).toFixed(0)} ms over its length. Automatic drift correction is coming in a later version.`,
  metadataMismatch: "The file's timestamp disagrees with the audio. The audio was trusted.",
  mixedFps: "The clips have different frame rates.",
  frameSnap: "The placement was rounded to the nearest frame.",

  reasonLowConfidence: "No confident match found in the audio",
  reasonNoAudio: "No audio in the file",
  reasonDecodeError: "Could not be read",
  reasonDeviceOverlap: "Overlaps another clip from the same device",

  exportButton: "Export to DaVinci Resolve",
  exportHint: "Import the file in Resolve with File → Import → Timeline.",
  exported: (n: number) => (n === 1 ? "Exported 1 clip" : `Exported ${n} clips`),
  projectName: "Project name",
  revealInFinder: "Reveal in Finder",

  errNoInput: "No files to synchronize.",
  errSidecar:
    "Cannot find ffmpeg. Install it (e.g. “brew install ffmpeg”) and try again.",
  errIo: (path: string) => `Could not read ${path}.`,
  errInvariant: (detail: string) =>
    `Internal error — this is a bug in the app, not a problem with your files. (${detail})`,
  errUnknown: (raw: string) => `Something went wrong: ${raw}`,
  noticeCancelled: "Cancelled. Nothing was changed.",

  settings: "Settings",
  language: "Language",
  minPsr: "Match threshold",
  minPsrHint:
    "A lower value accepts more matches but raises the risk of a wrong one. Clips below the threshold are reported as not synced rather than placed on a guess. Empty = default (15).",
  minPsrInvalid: "Must be a number above 0, or empty for the default.",
  segmentCount: "Segments per clip",
  segmentCountHint:
    "How many excerpts of each clip are compared against the reference. More segments give a more reliable drift measurement on long clips, but take longer.",
  segmentDefault: "5 (default)",
  cacheDir: "Analysis cache folder",
  cacheHint:
    "The cache makes re-syncing nearly instant. It uses about 170 MB per hour of audio and is not cleared automatically.",
  cachePick: "Choose folder",
  cacheUsage: (entries: number, size: string) =>
    entries === 1 ? `1 entry · ${size}` : `${entries} entries · ${size}`,
  cacheClear: "Clear cache",
  cacheClearConfirm: "Clear the cache? The next sync will have to analyse everything again.",
  cacheCleared: (size: string) => `Freed ${size}.`,
  showOnboarding: "Show the introduction again",
  diagnostics: "Export diagnostics",
  diagnosticsHint: "Contains the log and result — no media files.",
  diagnosticsSaved: "Diagnostics saved.",
  close: "Close",

  obSkip: "Skip",
  obBack: "Back",
  obNext: "Next",
  obDone: "Get started",
  obStep: (n: number, total: number) => `Step ${n} of ${total}`,
  obTitle1: "Sync multicamera shoots in seconds",
  obBody1:
    "Drop in everything from the shoot — cameras, an audio recorder, whole folders. SundaySync listens to the audio, works out when every clip was recorded, and builds a ready-synchronized timeline for DaVinci Resolve. No timecode required, and everything runs locally on your machine.",
  obTitle2: "Tips for the best result",
  obBody2:
    "Include the mixer or recorder track — it becomes the reference every camera is anchored to. Folders you have organised per camera automatically become their own devices. Clips the app is not sure about are reported honestly instead of being placed on a guess.",
  obTitle3: "One thing needs to be in place",
  obBody3: "SundaySync uses ffmpeg to read media files. It is free and installed once.",
  obFfmpegOk: "ffmpeg is ready",
  obFfmpegMissing: "ffmpeg was not found",
  obFfmpegHow: "Install with Homebrew:",
  obCheckAgain: "Check again",
};

export const dictionaries = { nb, en };
export type Lang = keyof typeof dictionaries;

/** Norwegian unless the OS says otherwise — these are Norwegian churches. */
export function detectLang(): Lang {
  const nav = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  return nav.startsWith("en") ? "en" : "nb";
}

/** Localised progress-stage label, keyed on the Rust `Stage` debug name. */
export function stageLabel(t: Strings, stage: string): string {
  switch (stage) {
    case "Scanning":
      return t.stageScanning;
    case "Probing":
      return t.stageProbing;
    case "Extracting":
      return t.stageExtracting;
    case "Correlating":
      return t.stageCorrelating;
    case "Placing":
      return t.stagePlacing;
    case "MeasuringDrift":
      return t.stageMeasuringDrift;
    default:
      return stage;
  }
}

/** "1 t 42 min", "12 min", "42 s" — durations shown to the user. Unit words are the
 *  same in nb and en at this brevity, so this stays language-free. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 > 0 ? ` ${s % 60} s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h} t${m % 60 > 0 ? ` ${m % 60} min` : ""}`;
}

/** "4.2 GB", "170 MB", "12 kB" — cache sizes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "–";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}
