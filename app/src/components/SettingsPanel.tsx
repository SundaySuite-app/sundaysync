import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Lang, Strings } from "../i18n";
import { formatBytes } from "../i18n";
import { getSettings, parseMinPsrInput, saveSettings } from "../settings";
import type { CacheStatus } from "../types";
import { Dialog } from "./Dialog";

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
  onNotice,
}: {
  t: Strings;
  onClose: () => void;
  onLangChange: (lang: Lang | null) => void;
  onShowOnboarding: () => void;
  onNotice: (kind: "ok" | "error", text: string) => void;
}) {
  const settings = getSettings();
  const [minPsrDraft, setMinPsrDraft] = useState(
    settings.minPsr === null ? "" : String(settings.minPsr),
  );
  const [minPsrError, setMinPsrError] = useState(false);
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refreshCache = () => {
    invoke<CacheStatus>("cache_status", { dir: getSettings().cacheDir })
      .then(setCache)
      .catch(() => setCache(null));
  };
  useEffect(refreshCache, []);

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
      </div>
    </Dialog>
  );
}
