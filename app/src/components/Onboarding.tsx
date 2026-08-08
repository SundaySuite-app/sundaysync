import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Strings } from "../i18n";
import { saveSettingsNow } from "../settings";
import { describeSidecar } from "../sidecarStatus";
import type { SidecarStatus } from "../types";
import { Dialog } from "./Dialog";
import { SyncArt } from "./icons";

const TOTAL_STEPS = 3;

/** `null` = checking, `"missing"` = the reject path (degraded install), otherwise the
 *  resolved bundled/system status. */
type SidecarState = SidecarStatus | null | "missing";

/**
 * First-run onboarding — three steps, skippable, re-openable from settings.
 * SundayRec's pattern translated to React: `onboardingDone` is saved immediately on
 * finish/skip (not debounced), so quitting right after cannot lose it.
 *
 * Step 3 is a self-test of the bundled engine, not an install prerequisite (E1): ffmpeg
 * ships inside the app now, so the happy paths are "bundled" and "using the system's
 * copy" — both green. A rejection (damaged install) falls back to the old missing-flow
 * with a re-check button and the Homebrew hint as a manual last resort.
 */
export function Onboarding({ t, onDone }: { t: Strings; onDone: () => void }) {
  const [step, setStep] = useState(1);
  const [sidecar, setSidecar] = useState<SidecarState>(null);

  const checkSidecar = useCallback(() => {
    setSidecar(null);
    invoke<SidecarStatus>("check_sidecar")
      .then(setSidecar)
      .catch(() => setSidecar("missing"));
  }, []);

  useEffect(() => {
    if (step === 3) checkSidecar();
  }, [step, checkSidecar]);

  const sidecarDescription =
    sidecar && sidecar !== "missing" ? describeSidecar(sidecar, t) : null;

  const finish = () => {
    saveSettingsNow({ onboardingDone: true });
    onDone();
  };

  return (
    <Dialog titleId="onboarding-title" onClose={finish} closeLabel={t.obSkip}>
      <div className="onboarding">
        <SyncArt />

        {step === 1 && (
          <>
            <h2 id="onboarding-title">{t.obTitle1}</h2>
            <p>{t.obBody1}</p>
          </>
        )}
        {step === 2 && (
          <>
            <h2 id="onboarding-title">{t.obTitle2}</h2>
            <p>{t.obBody2}</p>
          </>
        )}
        {step === 3 && (
          <>
            <h2 id="onboarding-title">{t.obTitle3}</h2>
            <p>{t.obBody3}</p>
            {sidecarDescription && (
              <>
                <p className="onboarding__status onboarding__status--ok">
                  ✓ {sidecarDescription.label}
                </p>
                {sidecarDescription.path && (
                  <p className="onboarding__path">
                    <code>{sidecarDescription.path}</code>
                  </p>
                )}
              </>
            )}
            {sidecar === "missing" && (
              <>
                <p className="onboarding__status onboarding__status--missing">
                  {t.obFfmpegMissing}
                </p>
                <p>
                  {t.obFfmpegHow} <code>brew install ffmpeg</code>
                </p>
                <button type="button" className="secondary" onClick={checkSidecar}>
                  {t.obCheckAgain}
                </button>
              </>
            )}
          </>
        )}

        <div className="onboarding__dots" aria-label={t.obStep(step, TOTAL_STEPS)}>
          {[1, 2, 3].map((n) => (
            <span
              key={n}
              className={`onboarding__dot${n === step ? " onboarding__dot--active" : ""}`}
              aria-current={n === step ? "step" : undefined}
            />
          ))}
        </div>

        <div className="onboarding__nav">
          <button type="button" className="ghost" onClick={finish}>
            {t.obSkip}
          </button>
          <div className="actions">
            {step > 1 && (
              <button type="button" className="secondary" onClick={() => setStep(step - 1)}>
                {t.obBack}
              </button>
            )}
            {step < TOTAL_STEPS ? (
              <button type="button" className="primary" onClick={() => setStep(step + 1)}>
                {t.obNext}
              </button>
            ) : (
              <button type="button" className="primary" onClick={finish}>
                {t.obDone}
              </button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
