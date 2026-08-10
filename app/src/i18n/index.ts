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

  // Interactive timeline (v0.3, D-051) — the result view's own controls.
  timelineAria: "Tidslinje",
  trackAria: (name: string) => `Spor: ${name}`,
  subTrackAria: (n: number) => `Underspor ${n}`,
  rulerAria: "Tidslinjal — klikk eller dra for å flytte markøren",
  zoomIn: "Zoom inn",
  zoomOut: "Zoom ut",
  zoomFit: "Tilpass",
  zoomFitAria: "Tilpass tidslinjen til vinduet",
  scrollbarAria: "Bla i tidslinjen",
  // V03-S6 (finding 15): outcome-en har ingen varighet for dette klippet, så boksen
  // tegnes som en strek. Sies rett ut i stedet for å se ut som et null-langt opptak.
  clipDurationUnknown: "Ukjent lengde",

  // Per-clip waveforms (v0.3 S4, D-052)
  waveformRegenerate: "Bygg bølgeform på nytt",
  waveformRegenerating: "Bygger på nytt …",
  waveformUnavailable: "Bølgeform utilgjengelig",
  waveformBusy: "Opptatt — prøv igjen",

  // Avspilling (v0.3, D-055) — hør at synken stemmer før du eksporterer.
  transportAria: "Avspilling",
  play: "Spill av",
  pause: "Pause",
  stopPlayback: "Stopp og gå til start",
  buffering: "Laster lyd …",
  volumeAria: "Volum",
  // Sets the expectation before the first press: this is the 12 kHz mono audio the
  // correlator listened to, not a mix. It is meant to prove alignment, nothing else.
  playbackQualityNote: "Lyd for kontroll av synk (12 kHz analyselyd) — ikke eksportkvalitet",
  muteDevice: (name: string) => `Demp ${name}`,
  unmuteDevice: (name: string) => `Opphev demping av ${name}`,
  soloDevice: (name: string) => `Solo ${name}`,
  unsoloDevice: (name: string) => `Slå av solo for ${name}`,
  muteShort: "M",
  soloShort: "S",
  playbackUnavailable: (n: number) =>
    n === 1
      ? "1 klipp mangler bufret lyd og spilles ikke av."
      : `${n} klipp mangler bufret lyd og spilles ikke av.`,

  // Warnings (§5 Warning enum)
  // D-042 (E6): drift correction shipped — a per-clip <timeMap> retimes the export
  // automatically, on by default (toggle: Innstillinger → «Korriger klokkedrift").
  // The number here is what the export corrects, so the copy says so, not "later".
  drift: (ms: number) =>
    `Dette klippet driver ${Math.abs(ms).toFixed(0)} ms over lengden. Korrigeres automatisk ved eksport (kan slås av i Innstillinger).`,
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
  exportHint:
    "Dra mediefilene inn i Resolves mediemappe (Media Pool) FØRST. Bruk deretter Fil → Importer → Tidslinje for å hente fila — da matcher Resolve mot de allerede importerte klippene, noe som er nødvendig for store filer.",
  exported: (n: number) => (n === 1 ? "Eksporterte 1 klipp" : `Eksporterte ${n} klipp`),
  projectName: "Prosjektnavn",
  revealInFinder: "Vis i Finder",

  // Engine errors (D-030 — mapped from stable Display prefixes in errors.ts)
  errNoInput: "Ingen filer å synkronisere.",
  errSidecar:
    "Motoren (ffmpeg) svarer ikke. Prøv å starte appen på nytt; installer eventuelt ffmpeg manuelt («brew install ffmpeg») som nødløsning.",
  errIo: (path: string) => `Kunne ikke lese ${path}.`,
  errInvariant: (detail: string) =>
    `Intern feil — dette er en programfeil, ikke et problem med filene dine. (${detail})`,
  errUnknown: (raw: string) => `Noe gikk galt: ${raw}`,
  // V03-S4 (D-052): the analysis cache has no entry for this clip yet — not a failure,
  // the "Bygg bølgeform på nytt"-button one tap away is the actual answer.
  errCacheMissing: "Ingen bufret analyse for dette klippet ennå.",
  errStaleExport:
    "Kildene er endret siden denne synkroniseringen. Synkroniser på nytt før du eksporterer.",
  noticeCancelled: "Avbrutt. Ingenting er endret.",
  noticeTimeout: "Motoren svarte ikke i tide. Prøv igjen.",

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
  driftCorrect: "Korriger klokkedrift",
  driftCorrectHint:
    "Retter langsom klokkedrift så klipp holder synk helt til slutten. Skriver en skånsom retiming i FCPXML-en (rører ingen filer) kun for klipp som driver mer enn en halv frame. På som standard.",
  // V03-S6: S5 la til innstillingen, denne økta gir den en bryter. Egen fra eksport-
  // korreksjonen med vilje (D-055) — å høre forskjellen er hele poenget.
  playbackDriftCorrect: "Driftkorreksjon ved avspilling",
  playbackDriftCorrectHint:
    "Bruker samme driftkorreksjon på avspillingen som på eksporten. Skru av for å høre hvordan klippene ville ligget uten. Endringen gjelder umiddelbart, også midt i avspilling. På som standard.",
  cacheDir: "Mappe for analyse-buffer",
  cacheHint:
    "Bufferen gjør ny synkronisering nesten øyeblikkelig. Den bruker ca. 170 MB per time lyd. Oppføringer som ikke er brukt på 90 dager ryddes automatisk ved oppstart.",
  cachePick: "Velg mappe",
  cacheUsage: (entries: number, size: string) =>
    entries === 1 ? `1 oppføring · ${size}` : `${entries} oppføringer · ${size}`,
  cacheClear: "Tøm buffer",
  cacheClearConfirm: "Tømme bufferen? Neste synkronisering må analysere alt på nytt.",
  cacheCleared: (size: string) => `Frigjorde ${size}.`,
  cacheCap: "Størrelsestak (MB)",
  cacheCapOff: "Av",
  cacheCapHint:
    "Valgfritt. Når satt, fjernes de eldst brukte oppføringene så snart bufferen overstiger taket. La feltet stå tomt for å slå det av.",
  cacheCapError: "Skriv inn et positivt tall, eller la feltet stå tomt for å slå av.",
  cacheEvicted: (entries: number, size: string) =>
    entries === 1
      ? `Fjernet 1 oppføring · frigjorde ${size}.`
      : `Fjernet ${entries} oppføringer · frigjorde ${size}.`,
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
  obTitle3: "Motoren er innebygd",
  obBody3:
    "SundaySync har ffmpeg innebygd — det er motoren som leser mediefilene. Her er en rask selvtest.",
  obFfmpegBundled: "Alt innebygd — ingenting å installere",
  obFfmpegSystem: "Bruker ffmpeg fra maskinen",
  obFfmpegSystemPath: (path: string) => `Fant: ${path}`,
  obFfmpegMissing: "ffmpeg ble ikke funnet",
  obFfmpegHow: "Installer med Homebrew:",
  obCheckAgain: "Sjekk igjen",

  // Telemetry consent (E7 CONSENT-UX) — copy v1, owner-approved verbatim. Formatted into
  // paragraphs/bullets for readability; the meaning, the "aldri …" point and the
  // "Behandlingsansvarlig: SundaySuite" line must not change without re-approval.
  consentTitle: "Hjelpe oss å gjøre SundaySync bedre?",
  consentIntro: "Appen kan sende anonym bruks- og feilinformasjon.",
  consentNeverLabel:
    "Aldri filnavn, mapper, enhetsnavn eller noe fra innholdet ditt — bare tekniske tall:",
  consentPoints: [
    "App- og motorversjon",
    "Operativsystem",
    "Hvor mange filer og enheter, og total varighet (i grove intervaller)",
    "Om synkroniseringen lyktes",
    "PSR- og drift-fordeling",
    "Hvilke filformater (kun filendelser, aldri filnavn)",
    "Eventuelle feil eller krasj",
  ] as string[],
  consentFooter:
    "Hver installasjon får en tilfeldig ID uten kobling til deg eller menigheten. Du kan når som helst skru det av i Innstillinger eller be om at dataene slettes. Alt lagres i EU.",
  consentController: "Behandlingsansvarlig: SundaySuite.",
  consentAccept: "Ja, hjelp gjerne",
  consentDecline: "Nei takk",

  // Settings — telemetry section
  telemetryTitle: "Anonym bruksstatistikk",
  telemetryToggleLabel: "Del anonym bruksstatistikk",
  telemetryToggleHint:
    "Av til du slår det på. Du kan når som helst se nøyaktig hva som ville blitt sendt, eller be om at dataene slettes.",
  telemetryStatus: (granted: boolean, queued: number): string => {
    if (!granted) return "Av";
    if (queued <= 0) return "På";
    return queued === 1 ? "På · 1 i kø" : `På · ${queued} i kø`;
  },
  telemetryUnavailable: "Ikke tilgjengelig i denne versjonen.",
  telemetryShowPreview: "Vis hva vi sender",
  telemetryPreviewTitle: "Dette sender vi",
  telemetryPreviewLoading: "Henter …",
  telemetryPreviewEmpty: "Ingenting å vise ennå.",
  telemetryShowConsent: "Vis samtykketeksten igjen",
  telemetryDelete: "Slett mine data",
  telemetryDeleteConfirm: "Be om at all telemetridata for denne installasjonen slettes?",
  telemetryDeleted: "Forespørsel sendt — dataene slettes.",
  telemetryDeleteFailed: "Kunne ikke sende sletteforespørsel. Prøv igjen senere.",

  // Settings — System / oppdateringer (E9)
  systemTitle: "System",
  betaChannelLabel: "Få betaversjoner",
  betaChannelHint:
    "Av som standard. Slått på får du tidlige testversjoner før de slippes til alle. De kan være mindre stabile — skru av igjen når som helst for å gå tilbake til vanlige versjoner.",
  updateCheck: "Se etter oppdatering",
  updateDownload: (version: string) => `Last ned og installer ${version}`,
  updateRestart: "Start på nytt og installer",
  updateIdle: "Trykk «Se etter oppdatering» for å sjekke.",
  updateChecking: "Ser etter oppdatering …",
  updateUpToDate: "Du har den nyeste versjonen.",
  updateAvailable: (version: string) => `Ny versjon tilgjengelig: ${version}.`,
  updateDownloading: (percent: number) => `Laster ned … ${percent} %`,
  updateReady: (version: string) =>
    `${version} er klar. Start appen på nytt for å fullføre.`,
  updateError: (message: string) => `Kunne ikke oppdatere: ${message}`,
  updateBannerAvailable: (version: string) =>
    `Ny versjon ${version} er tilgjengelig. Åpne Innstillinger → System for å installere.`,
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

  timelineAria: "Timeline",
  trackAria: (name: string) => `Track: ${name}`,
  subTrackAria: (n: number) => `Sub-track ${n}`,
  rulerAria: "Time ruler — click or drag to move the playhead",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomFit: "Fit",
  zoomFitAria: "Fit the timeline to the window",
  scrollbarAria: "Scroll the timeline",
  // V03-S6 (finding 15) — see the nb comment above.
  clipDurationUnknown: "Length unknown",

  // Per-clip waveforms (v0.3 S4, D-052)
  waveformRegenerate: "Rebuild waveform",
  waveformRegenerating: "Rebuilding …",
  waveformUnavailable: "Waveform unavailable",
  waveformBusy: "Busy — try again",

  // Playback (v0.3, D-055) — see the nb comment above.
  transportAria: "Playback",
  play: "Play",
  pause: "Pause",
  stopPlayback: "Stop and return to the start",
  buffering: "Loading audio …",
  volumeAria: "Volume",
  playbackQualityNote: "Audio for checking sync (12 kHz analysis audio) — not export quality",
  muteDevice: (name: string) => `Mute ${name}`,
  unmuteDevice: (name: string) => `Unmute ${name}`,
  soloDevice: (name: string) => `Solo ${name}`,
  unsoloDevice: (name: string) => `Unsolo ${name}`,
  muteShort: "M",
  soloShort: "S",
  playbackUnavailable: (n: number) =>
    n === 1
      ? "1 clip has no cached audio and will not play."
      : `${n} clips have no cached audio and will not play.`,

  // D-042 (E6): drift correction shipped — see the nb comment above.
  drift: (ms: number) =>
    `This clip drifts ${Math.abs(ms).toFixed(0)} ms over its length. It is corrected automatically on export (toggle in Settings).`,
  metadataMismatch: "The file's timestamp disagrees with the audio. The audio was trusted.",
  mixedFps: "The clips have different frame rates.",
  frameSnap: "The placement was rounded to the nearest frame.",

  reasonLowConfidence: "No confident match found in the audio",
  reasonNoAudio: "No audio in the file",
  reasonDecodeError: "Could not be read",
  reasonDeviceOverlap: "Overlaps another clip from the same device",

  exportButton: "Export to DaVinci Resolve",
  exportHint:
    "Drag the media files into Resolve's Media Pool FIRST. Then use File → Import → Timeline to bring in the file — Resolve then matches against the already-imported clips, which is required for large files.",
  exported: (n: number) => (n === 1 ? "Exported 1 clip" : `Exported ${n} clips`),
  projectName: "Project name",
  revealInFinder: "Reveal in Finder",

  errNoInput: "No files to synchronize.",
  errSidecar:
    "The engine (ffmpeg) is not responding. Try restarting the app; as a last resort install ffmpeg manually (“brew install ffmpeg”).",
  errIo: (path: string) => `Could not read ${path}.`,
  errInvariant: (detail: string) =>
    `Internal error — this is a bug in the app, not a problem with your files. (${detail})`,
  errUnknown: (raw: string) => `Something went wrong: ${raw}`,
  // V03-S4 (D-052): the analysis cache has no entry for this clip yet — see the nb
  // comment above.
  errCacheMissing: "No cached analysis for this clip yet.",
  errStaleExport:
    "The sources have changed since this sync. Sync again before exporting.",
  noticeCancelled: "Cancelled. Nothing was changed.",
  noticeTimeout: "The engine did not answer in time. Try again.",

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
  driftCorrect: "Correct clock drift",
  driftCorrectHint:
    "Fixes slow clock drift so clips stay in sync all the way to the end. Writes a gentle retime into the FCPXML (touches no files), only for clips that drift more than half a frame. On by default.",
  // V03-S6 — see the nb comment above.
  playbackDriftCorrect: "Drift correction during playback",
  playbackDriftCorrectHint:
    "Applies the same drift correction to playback as to the export. Turn it off to hear how the clips would sit without it. The change takes effect immediately, even mid-playback. On by default.",
  cacheDir: "Analysis cache folder",
  cacheHint:
    "The cache makes re-syncing nearly instant. It uses about 170 MB per hour of audio. Entries untouched for 90 days are cleared automatically at startup.",
  cachePick: "Choose folder",
  cacheUsage: (entries: number, size: string) =>
    entries === 1 ? `1 entry · ${size}` : `${entries} entries · ${size}`,
  cacheClear: "Clear cache",
  cacheClearConfirm: "Clear the cache? The next sync will have to analyse everything again.",
  cacheCleared: (size: string) => `Freed ${size}.`,
  cacheCap: "Size cap (MB)",
  cacheCapOff: "Off",
  cacheCapHint:
    "Optional. When set, the least-recently-used entries are removed as soon as the cache exceeds the cap. Leave empty to turn it off.",
  cacheCapError: "Enter a positive number, or leave the field empty to turn it off.",
  cacheEvicted: (entries: number, size: string) =>
    entries === 1 ? `Removed 1 entry · freed ${size}.` : `Removed ${entries} entries · freed ${size}.`,
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
  obTitle3: "The engine is built in",
  obBody3:
    "SundaySync ships with ffmpeg built in — the engine that reads media files. Here is a quick self-test.",
  obFfmpegBundled: "Everything bundled — nothing to install",
  obFfmpegSystem: "Using ffmpeg from this machine",
  obFfmpegSystemPath: (path: string) => `Found: ${path}`,
  obFfmpegMissing: "ffmpeg was not found",
  obFfmpegHow: "Install with Homebrew:",
  obCheckAgain: "Check again",

  // Telemetry consent (E7 CONSENT-UX) — faithful English mirror of the approved nb copy.
  consentTitle: "Help us make SundaySync better?",
  consentIntro: "The app can send anonymous usage and error information.",
  consentNeverLabel:
    "Never filenames, folders, device names, or anything from your content — only technical numbers:",
  consentPoints: [
    "App and engine version",
    "Operating system",
    "How many files and devices, and total duration (in coarse buckets)",
    "Whether the sync succeeded",
    "PSR and drift distribution",
    "Which file formats (extensions only, never filenames)",
    "Any errors or crashes",
  ] as string[],
  consentFooter:
    "Each installation gets a random ID with no link to you or your congregation. You can turn it off in Settings at any time, or ask for the data to be deleted. Everything is stored in the EU.",
  consentController: "Data controller: SundaySuite.",
  consentAccept: "Yes, happy to help",
  consentDecline: "No thanks",

  // Settings — telemetry section
  telemetryTitle: "Anonymous usage statistics",
  telemetryToggleLabel: "Share anonymous usage statistics",
  telemetryToggleHint:
    "Off until you turn it on. You can see exactly what would be sent, or ask for the data to be deleted, at any time.",
  telemetryStatus: (granted: boolean, queued: number): string => {
    if (!granted) return "Off";
    if (queued <= 0) return "On";
    return queued === 1 ? "On · 1 queued" : `On · ${queued} queued`;
  },
  telemetryUnavailable: "Not available in this version.",
  telemetryShowPreview: "Show what we send",
  telemetryPreviewTitle: "This is what we send",
  telemetryPreviewLoading: "Loading …",
  telemetryPreviewEmpty: "Nothing to show yet.",
  telemetryShowConsent: "Show the consent text again",
  telemetryDelete: "Delete my data",
  telemetryDeleteConfirm: "Ask for all telemetry data for this installation to be deleted?",
  telemetryDeleted: "Request sent — the data will be deleted.",
  telemetryDeleteFailed: "Could not send the deletion request. Try again later.",

  // Settings — System / updates (E9)
  systemTitle: "System",
  betaChannelLabel: "Receive beta versions",
  betaChannelHint:
    "Off by default. When on, you get early test builds before they reach everyone. They may be less stable — turn it off again at any time to go back to regular releases.",
  updateCheck: "Check for updates",
  updateDownload: (version: string) => `Download and install ${version}`,
  updateRestart: "Restart and install",
  updateIdle: "Press “Check for updates” to check.",
  updateChecking: "Checking for updates …",
  updateUpToDate: "You are on the latest version.",
  updateAvailable: (version: string) => `New version available: ${version}.`,
  updateDownloading: (percent: number) => `Downloading … ${percent}%`,
  updateReady: (version: string) => `${version} is ready. Restart the app to finish.`,
  updateError: (message: string) => `Could not update: ${message}`,
  updateBannerAvailable: (version: string) =>
    `Version ${version} is available. Open Settings → System to install it.`,
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
