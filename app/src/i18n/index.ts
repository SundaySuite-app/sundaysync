/**
 * Bilingual UI strings — docs/PLAN.md §9.
 *
 * Norwegian Bokmål is the default because these are Norwegian churches; English is there
 * so the app is usable by anyone else. Both dictionaries are the same shape, and the type
 * of `en` is derived from `nb`, so TypeScript fails the build if a key is added to one and
 * forgotten in the other. A half-translated UI is worse than an untranslated one.
 */

export const nb = {
  appName: "SundaySync",
  dropTitle: "Slipp inn alt fra opptaket",
  dropHint: "video, lyd, hele mapper",
  dropAction: "Velg filer",
  dropFolder: "Velg mappe",
  syncing: "Synkroniserer",
  syncButton: "Synkroniser",
  cancel: "Avbryt",
  cancelling: "Avbryter …",
  exportButton: "Eksporter til DaVinci Resolve",
  exportHint: "Importer fila i Resolve med Fil → Importer → Tidslinje.",
  exported: (n: number) => `Eksporterte ${n} klipp`,
  devices: "enheter",
  cameras: "kameraer",
  recorders: "lydopptakere",
  files: "filer",
  reference: "Referanse",
  unsyncedTitle: "Ikke synkronisert",
  advanced: "Avansert",
  simple: "Enkel",
  minPsr: "Terskel for treff",
  minPsrHint:
    "Lavere verdi gir flere treff, men øker risikoen for feil. Klipp under terskelen blir rapportert som ikke synkronisert i stedet for å bli plassert på slump.",
  cacheDir: "Mappe for analyse-buffer",
  cacheHint:
    "Bufferen gjør ny synkronisering nesten øyeblikkelig. Den bruker ca. 170 MB per time lyd og tømmes ikke automatisk.",
  referenceOverride: "Velg referanse selv",
  diagnostics: "Eksporter diagnostikk",
  diagnosticsHint: "Inneholder logg og resultat — ingen mediefiler.",
  drift: (ms: number) =>
    `Dette klippet driver ${Math.abs(ms).toFixed(0)} ms over lengden. Automatisk driftkorreksjon kommer i en senere versjon.`,
  metadataMismatch: "Tidsstempelet i fila stemmer ikke med lyden. Lyden er lagt til grunn.",
  mixedFps: "Klippene har ulik bildefrekvens.",
  frameSnap: "Plasseringen er rundet til nærmeste bilde.",
  reasonLowConfidence: "Fant ikke sikkert nok treff i lyden",
  reasonNoAudio: "Ingen lyd i fila",
  reasonDecodeError: "Kunne ikke leses",
  reasonDeviceOverlap: "Overlapper et annet klipp fra samme enhet",
  noFfmpeg: "Finner ikke ffmpeg. Installer det og start appen på nytt.",
  folderLabel: (name: string) => `Mappe: ${name}`,
  confidence: "Sikkerhet",
  language: "Språk",
};

export type Strings = typeof nb;

export const en: Strings = {
  appName: "SundaySync",
  dropTitle: "Drop in everything from the shoot",
  dropHint: "video, audio, whole folders",
  dropAction: "Choose files",
  dropFolder: "Choose folder",
  syncing: "Syncing",
  syncButton: "Sync",
  cancel: "Cancel",
  cancelling: "Cancelling …",
  exportButton: "Export to DaVinci Resolve",
  exportHint: "Import the file in Resolve with File → Import → Timeline.",
  exported: (n: number) => `Exported ${n} clips`,
  devices: "devices",
  cameras: "cameras",
  recorders: "audio recorders",
  files: "files",
  reference: "Reference",
  unsyncedTitle: "Not synced",
  advanced: "Advanced",
  simple: "Simple",
  minPsr: "Match threshold",
  minPsrHint:
    "A lower value accepts more matches but raises the risk of a wrong one. Clips below the threshold are reported as not synced rather than placed on a guess.",
  cacheDir: "Analysis cache folder",
  cacheHint:
    "The cache makes re-syncing nearly instant. It uses about 170 MB per hour of audio and is not cleared automatically.",
  referenceOverride: "Choose the reference yourself",
  diagnostics: "Export diagnostics",
  diagnosticsHint: "Contains the log and result — no media files.",
  drift: (ms: number) =>
    `This clip drifts ${Math.abs(ms).toFixed(0)} ms over its length. Automatic drift correction is coming in a later version.`,
  metadataMismatch: "The file's timestamp disagrees with the audio. The audio was trusted.",
  mixedFps: "The clips have different frame rates.",
  frameSnap: "The placement was rounded to the nearest frame.",
  reasonLowConfidence: "No confident match found in the audio",
  reasonNoAudio: "No audio in the file",
  reasonDecodeError: "Could not be read",
  reasonDeviceOverlap: "Overlaps another clip from the same device",
  noFfmpeg: "Cannot find ffmpeg. Install it and restart the app.",
  folderLabel: (name: string) => `Folder: ${name}`,
  confidence: "Confidence",
  language: "Language",
};

export const dictionaries = { nb, en };
export type Lang = keyof typeof dictionaries;

/** Norwegian unless the OS says otherwise — these are Norwegian churches. */
export function detectLang(): Lang {
  const nav = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  return nav.startsWith("en") ? "en" : "nb";
}
