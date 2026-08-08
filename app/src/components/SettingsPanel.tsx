import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { Lang, Strings } from "../i18n";
import { formatBytes } from "../i18n";
import { getSettings, parseMinPsrInput, saveSettings } from "../settings";
import { describeSidecar } from "../sidecarStatus";
import {
  getTelemetryPreview,
  getTelemetryStatus,
  requestTelemetryDeletion,
  setTelemetryConsent,
  type TelemetryStatus,
} from "../telemetry";
import {
  checkForUpdate,
  downloadAndInstall,
  relaunchForUpdate,
  subscribeProgress,
  type UpdateStatus,
} from "../update";
import type { CacheStatus, SidecarStatus } from "../types";
import { Dialog } from "./Dialog";

/** Localised one-line status under the update controls. */
function updateStatusText(t: Strings, u: UpdateStatus): string {
  switch (u.phase) {
    case "idle":
      return t.updateIdle;
    case "checking":
      return t.updateChecking;
    case "upToDate":
      return t.updateUpToDate;
    case "available":
      return t.updateAvailable(u.version);
    case "downloading":
      return t.updateDownloading(u.percent);
    case "readyToInstall":
      return t.updateReady(u.version);
    case "error":
      return t.updateError(u.message);
  }
}

/**
 * §9 advanced mode as a settings dialog — every field persisted (D-029), every field
 * null-defaulted so an untouched installation behaves exactly like simple mode.
 *
 * The cache section is D-013's follow-through: the hint already told the user the
 * cache grows ~170 MB per audio-hour and is never cleared; now they can see the actual
 * number and act on it.
 */
export function SettingsPanel({
  t,
  onClose,
  onLangChange,
  onShowOnboarding,
  onShowConsent,
  onNotice,
}: {
  t: Strings;
  onClose: () => void;
  onLangChange: (lang: Lang | null) => void;
  onShowOnboarding: () => void;
  onShowConsent: () => void;
  onNotice: (kind: "ok" | "error", text: string) => void;
}) {
  const settings = getSettings();
  const [minPsrDraft, setMinPsrDraft] = useState(
    settings.minPsr === null ? "" : String(settings.minPsr),
  );
  const [minPsrError, setMinPsrError] = useState(false);
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [sidecar, setSidecar] = useState<SidecarStatus | null>(null);
  const [cacheCapDraft, setCacheCapDraft] = useState(
    settings.cacheCapMb === null ? "" : String(settings.cacheCapMb),
  );
  const [cacheCapError, setCacheCapError] = useState(false);
  const [correctDrift, setCorrectDrift] = useState(settings.correctDrift);
  const [telemetry, setTelemetry] = useState<TelemetryStatus | null>(null);
  const [telemetryBusy, setTelemetryBusy] = useState(false);
  const [telemetryPreview, setTelemetryPreview] = useState<string | null>(null);
  const [telemetryPreviewLoading, setTelemetryPreviewLoading] = useState(false);
  const [showTelemetryPreview, setShowTelemetryPreview] = useState(false);
  const [confirmTelemetryDelete, setConfirmTelemetryDelete] = useState(false);
  const [betaChannel, setBetaChannel] = useState(settings.betaChannel);
  const [update, setUpdate] = useState<UpdateStatus>({ phase: "idle" });
  const [updateBusy, setUpdateBusy] = useState(false);

  const refreshCache = () => {
    invoke<CacheStatus>("cache_status", { dir: getSettings().cacheDir })
      .then(setCache)
      .catch(() => setCache(null));
  };
  useEffect(refreshCache, []);
  useEffect(() => {
    invoke<SidecarStatus>("check_sidecar")
      .then(setSidecar)
      .catch(() => setSidecar(null));
  }, []);
  useEffect(() => {
    getTelemetryStatus().then(setTelemetry);
  }, []);

  // E9: live download percent while an update installs. Subscribe once; the backend emits
  // `update:progress` from its download closure.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    subscribeProgress((p) => {
      setUpdate({ phase: "downloading", version: p.version, percent: p.percent });
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // E9: opting into the beta ring is the natural moment to re-offer telemetry (a beta
  // tester is a good person to hear from). Gentle: only re-surfaces the consent card for an
  // install that hasn't answered yet (`consentVersion === null`), never re-nags someone who
  // already decided, and never blocks the toggle itself.
  //
  // `onClose()` before `onShowConsent()`, same as the "show the consent text again" button
  // below — App.tsx renders `SettingsPanel` and `ConsentCard` off two independent booleans
  // (`showSettings`/`showConsent`) with nothing making them mutually exclusive, so calling
  // `onShowConsent()` alone here stacked a second `role="dialog"` on top of the still-open
  // Settings one: two competing focus traps, two Escape handlers, both `aria-modal="true"`.
  const toggleBeta = (on: boolean) => {
    setBetaChannel(on);
    saveSettings({ betaChannel: on });
    if (on && telemetry && telemetry.consentVersion === null) {
      onClose();
      onShowConsent();
    }
  };

  const runUpdateCheck = async () => {
    setUpdateBusy(true);
    setUpdate({ phase: "checking" });
    const status = await checkForUpdate(getSettings().betaChannel);
    setUpdate(status);
    setUpdateBusy(false);
  };

  const runDownloadInstall = async () => {
    setUpdateBusy(true);
    setUpdate((s) =>
      s.phase === "available" ? { phase: "downloading", version: s.version, percent: 0 } : s,
    );
    const status = await downloadAndInstall(getSettings().betaChannel);
    setUpdate(status);
    setUpdateBusy(false);
  };

  const toggleTelemetry = async (granted: boolean) => {
    setTelemetryBusy(true);
    const status = await setTelemetryConsent(granted);
    setTelemetryBusy(false);
    if (status) {
      setTelemetry(status);
    } else {
      onNotice("error", t.telemetryUnavailable);
    }
  };

  const openTelemetryPreview = async () => {
    setShowTelemetryPreview(true);
    setTelemetryPreviewLoading(true);
    const text = await getTelemetryPreview();
    setTelemetryPreviewLoading(false);
    setTelemetryPreview(text);
  };

  const deleteTelemetryData = async () => {
    setConfirmTelemetryDelete(false);
    const ok = await requestTelemetryDeletion();
    onNotice(ok ? "ok" : "error", ok ? t.telemetryDeleted : t.telemetryDeleteFailed);
    if (ok) {
      const status = await getTelemetryStatus();
      if (status) setTelemetry(status);
    }
  };

  const commitMinPsr = () => {
    const parsed = parseMinPsrInput(minPsrDraft);
    if (!parsed.ok) {
      setMinPsrError(true);
      return;
    }
    setMinPsrError(false);
    saveSettings({ minPsr: parsed.value });
  };

  const pickCacheDir = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      saveSettings({ cacheDir: picked });
      refreshCache();
    }
  };

  const clearCache = async () => {
    setConfirmClear(false);
    try {
      const freed = await invoke<number>("clear_cache", { dir: getSettings().cacheDir });
      onNotice("ok", t.cacheCleared(formatBytes(freed)));
      refreshCache();
    } catch (e) {
      onNotice("error", String(e));
    }
  };

  // D-040: an optional size cap, off by default. Empty commits `null` (off); a positive
  // whole number of MB is enforced immediately (evicting least-recently-used entries)
  // and persisted so the shell can re-apply it after future syncs.
  const commitCacheCap = async () => {
    const trimmed = cacheCapDraft.trim();
    if (trimmed === "") {
      setCacheCapError(false);
      saveSettings({ cacheCapMb: null });
      return;
    }
    const mb = Number(trimmed);
    if (!Number.isFinite(mb) || mb <= 0) {
      setCacheCapError(true);
      return;
    }
    setCacheCapError(false);
    const rounded = Math.round(mb);
    saveSettings({ cacheCapMb: rounded });
    try {
      const ev = await invoke<{ entries: number; bytes: number }>("enforce_cache_cap", {
        dir: getSettings().cacheDir,
        maxBytes: rounded * 1024 * 1024,
      });
      if (ev.entries > 0) onNotice("ok", t.cacheEvicted(ev.entries, formatBytes(ev.bytes)));
      refreshCache();
    } catch (e) {
      onNotice("error", String(e));
    }
  };

  const exportDiagnostics = async () => {
    const path = await save({
      defaultPath: "sundaysync-diagnostics.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await invoke("export_diagnostics", { path });
      onNotice("ok", t.diagnosticsSaved);
    } catch (e) {
      onNotice("error", String(e));
    }
  };

  return (
    <>
      <Dialog titleId="settings-title" onClose={onClose} closeLabel={t.close}>
      <h2 id="settings-title">{t.settings}</h2>
      <div className="settings">
        <label className="field">
          <span>{t.language}</span>
          <select
            value={settings.lang ?? ""}
            onChange={(e) => {
              const lang = e.target.value === "" ? null : (e.target.value as Lang);
              saveSettings({ lang });
              onLangChange(lang);
            }}
          >
            <option value="">Auto</option>
            <option value="nb">Norsk</option>
            <option value="en">English</option>
          </select>
        </label>

        <label className="field">
          <span>{t.minPsr}</span>
          <input
            type="text"
            inputMode="decimal"
            value={minPsrDraft}
            placeholder="15"
            onChange={(e) => setMinPsrDraft(e.target.value)}
            onBlur={commitMinPsr}
            onKeyDown={(e) => e.key === "Enter" && commitMinPsr()}
            aria-invalid={minPsrError}
          />
          {minPsrError && <span className="field__error">{t.minPsrInvalid}</span>}
          <small>{t.minPsrHint}</small>
        </label>

        <label className="field">
          <span>{t.segmentCount}</span>
          <select
            value={settings.segmentCount ?? ""}
            onChange={(e) =>
              saveSettings({
                segmentCount: e.target.value === "" ? null : Number(e.target.value),
              })
            }
          >
            <option value="">{t.segmentDefault}</option>
            {[3, 7, 9].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <small>{t.segmentCountHint}</small>
        </label>

        <label className="field field--check">
          <span className="field__row">
            <input
              type="checkbox"
              checked={correctDrift}
              onChange={(e) => {
                setCorrectDrift(e.target.checked);
                saveSettings({ correctDrift: e.target.checked });
              }}
            />
            <span>{t.driftCorrect}</span>
          </span>
          <small>{t.driftCorrectHint}</small>
        </label>

        <div className="field">
          <span>{t.cacheDir}</span>
          <div className="field__row">
            <input type="text" readOnly value={settings.cacheDir ?? cache?.dir ?? ""} />
            <button type="button" className="secondary" onClick={pickCacheDir}>
              {t.cachePick}
            </button>
          </div>
          {cache && (
            <div className="cachebar">
              <strong>{t.cacheUsage(cache.entries, formatBytes(cache.bytes))}</strong>
              {confirmClear ? (
                <>
                  <span>{t.cacheClearConfirm}</span>
                  <button type="button" className="danger" onClick={clearCache}>
                    {t.cacheClear}
                  </button>
                  <button type="button" className="ghost" onClick={() => setConfirmClear(false)}>
                    {t.cancel}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setConfirmClear(true)}
                  disabled={cache.entries === 0}
                >
                  {t.cacheClear}
                </button>
              )}
            </div>
          )}
          <small>{t.cacheHint}</small>
          <label className="field field--inline">
            <span>{t.cacheCap}</span>
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              placeholder={t.cacheCapOff}
              value={cacheCapDraft}
              aria-invalid={cacheCapError}
              onChange={(e) => setCacheCapDraft(e.target.value)}
              onBlur={() => void commitCacheCap()}
            />
          </label>
          {cacheCapError && <small className="error">{t.cacheCapError}</small>}
          <small>{t.cacheCapHint}</small>
        </div>

        <hr className="sep" />

        <div className="field">
          <span>{t.telemetryTitle}</span>
          <label className="field field--check">
            <span className="field__row">
              <input
                type="checkbox"
                checked={telemetry?.granted ?? false}
                disabled={telemetryBusy || !telemetry}
                onChange={(e) => void toggleTelemetry(e.target.checked)}
              />
              <span>{t.telemetryToggleLabel}</span>
            </span>
            <small>{t.telemetryToggleHint}</small>
          </label>
          <small className="subtle">
            {telemetry ? t.telemetryStatus(telemetry.granted, telemetry.queued) : t.telemetryUnavailable}
          </small>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => void openTelemetryPreview()}>
              {t.telemetryShowPreview}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                onClose();
                onShowConsent();
              }}
            >
              {t.telemetryShowConsent}
            </button>
            {confirmTelemetryDelete ? (
              <>
                <span className="subtle">{t.telemetryDeleteConfirm}</span>
                <button type="button" className="danger" onClick={() => void deleteTelemetryData()}>
                  {t.telemetryDelete}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setConfirmTelemetryDelete(false)}
                >
                  {t.cancel}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirmTelemetryDelete(true)}
              >
                {t.telemetryDelete}
              </button>
            )}
          </div>
        </div>

        <hr className="sep" />

        <div className="field">
          <span>{t.systemTitle}</span>
          <label className="field field--check">
            <span className="field__row">
              <input
                type="checkbox"
                checked={betaChannel}
                onChange={(e) => toggleBeta(e.target.checked)}
              />
              <span>{t.betaChannelLabel}</span>
            </span>
            <small>{t.betaChannelHint}</small>
          </label>
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={updateBusy}
              onClick={() => void runUpdateCheck()}
            >
              {t.updateCheck}
            </button>
            {update.phase === "available" && (
              <button
                type="button"
                className="primary"
                disabled={updateBusy}
                onClick={() => void runDownloadInstall()}
              >
                {t.updateDownload(update.version)}
              </button>
            )}
            {update.phase === "readyToInstall" && (
              <button
                type="button"
                className="primary"
                onClick={() => void relaunchForUpdate()}
              >
                {t.updateRestart}
              </button>
            )}
          </div>
          <small className="subtle">{updateStatusText(t, update)}</small>
        </div>

        <hr className="sep" />

        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              onClose();
              onShowOnboarding();
            }}
          >
            {t.showOnboarding}
          </button>
          <button type="button" className="secondary" onClick={exportDiagnostics}>
            {t.diagnostics}
          </button>
        </div>
        <small className="subtle">{t.diagnosticsHint}</small>

        {sidecar && (
          <small className="subtle">
            {sidecar.source === "bundled"
              ? describeSidecar(sidecar, t).label
              : t.obFfmpegSystemPath(sidecar.path)}
          </small>
        )}
      </div>
      </Dialog>

      {showTelemetryPreview && (
        <Dialog
          titleId="telemetry-preview-title"
          onClose={() => setShowTelemetryPreview(false)}
          closeLabel={t.close}
        >
          <h2 id="telemetry-preview-title">{t.telemetryPreviewTitle}</h2>
          {telemetryPreviewLoading ? (
            <p>{t.telemetryPreviewLoading}</p>
          ) : (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: "0.8125rem",
                lineHeight: 1.5,
              }}
            >
              {telemetryPreview ?? t.telemetryPreviewEmpty}
            </pre>
          )}
        </Dialog>
      )}
    </>
  );
}
